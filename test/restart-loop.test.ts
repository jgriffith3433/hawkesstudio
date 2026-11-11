// A change whose step keeps ending Studio (a clone too big for Cloud Run's memory disk crashed the customer Studio on
// every restart, 2026-10-31) stops being resumed after RESTART_LOOP quick restarts in a row; restarts far apart (deploys
// during a long agent pass) don't count. Runs do the same at their running step (pipeline.ts resumeRuns, runRestarts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-restart-loop-'));
const { resumeChanges, getChange, RESTART_LOOP, autoFixBlock, restartCount, passInternals } = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');
const { resumeRuns, runRestarts, rolledOut } = await import('../src/pipeline.ts');
await import('../src/builds.ts'); // its table, which a stopped run's builds are failed in

function seed(id: string, phase: Record<string, unknown>) {
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, log, created, phase) VALUES (?, 'nope', '[]', 'working', 'preparing the worktree', '[]', ?, ?)`)
    .run(id, Date.now(), JSON.stringify(phase));
}

test('quick restarts at one step stop the change; far-apart ones start counting again', () => {
  seed('c_loop', { step: 'prepare', since: 1, restarts: { step: 'prepare', n: RESTART_LOOP, at: Date.now() - 60_000 } });
  seed('c_apart', { step: 'agent', since: 1, restarts: { step: 'agent', n: RESTART_LOOP, at: Date.now() - 60 * 60_000 } });
  const resumed = resumeChanges();
  const loop = getChange('c_loop')!;
  assert.equal(loop.status, 'failed');
  assert.match(loop.detail!, /restarted 3 times in a row during its prepare step/);
  assert.ok(!resumed.includes('c_loop'));
  assert.ok(resumed.includes('c_apart'));
  const row = db.prepare(`SELECT phase FROM changes WHERE id = 'c_apart'`).get() as { phase: string };
  assert.equal(JSON.parse(row.phase).restarts.n, 1);
});

test('a change with its work committed and its pull request open, cut off in its finish step, becomes ready, not failed', () => {
  const at = Date.now() - 60_000;
  seed('c_finish', { step: 'finish', since: 1, tip: 'abc1234def', restarts: { step: 'finish', n: RESTART_LOOP, at } });
  db.prepare(`UPDATE changes SET pr = 36 WHERE id = 'c_finish'`).run();
  seed('c_nopr', { step: 'finish', since: 1, tip: 'abc1234def', restarts: { step: 'finish', n: RESTART_LOOP, at } });
  seed('c_agentloop', { step: 'agent', since: 1, restarts: { step: 'agent', n: RESTART_LOOP, at } });
  db.prepare(`UPDATE changes SET pr = 37 WHERE id = 'c_agentloop'`).run();
  const resumed = resumeChanges();
  const done = getChange('c_finish')!;
  assert.equal(done.status, 'ready');
  assert.equal(done.verify.sha, 'abc1234def');
  assert.ok(!resumed.includes('c_finish'));
  // Without a pull request, or stuck before the finish, the loop still stops it.
  assert.equal(getChange('c_nopr')!.status, 'failed');
  assert.equal(getChange('c_agentloop')!.status, 'failed');
});

test('auto-fix skips a finding with an open pull request or two failures today, and starts others', () => {
  const add = (id: string, finding: string, status: string, pr: number | null, created = Date.now()) =>
    db.prepare(`INSERT INTO changes (id, product, findings, status, detail, log, created, pr) VALUES (?, 'nope', ?, ?, 'x', '[]', ?, ?)`).run(id, JSON.stringify([finding]), status, created, pr);
  assert.equal(autoFixBlock('f_fresh'), null);
  add('c_o1', 'f_openpr', 'ready', 40);
  assert.match(autoFixBlock('f_openpr')!, /c_o1 already has pull request #40 open/);
  add('c_m1', 'f_merged', 'merged', 41);
  assert.equal(autoFixBlock('f_merged'), null);
  add('c_x1', 'f_twice', 'failed', null);
  assert.equal(autoFixBlock('f_twice'), null);
  add('c_x2', 'f_twice', 'failed', null);
  assert.match(autoFixBlock('f_twice')!, /failed 2 times today/);
  // Failures from an earlier day don't count.
  add('c_y1', 'f_old', 'failed', null, Date.now() - 3 * 86_400_000);
  add('c_y2', 'f_old', 'failed', null, Date.now() - 3 * 86_400_000);
  assert.equal(autoFixBlock('f_old'), null);
});

test("a resumed change whose project is gone fails plainly instead of an unhandled rejection", async () => {
  const end = Date.now() + 5000;
  while (getChange('c_apart')!.status !== 'failed' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.match(getChange('c_apart')!.detail!, /couldn't carry on after the restart: No product "nope"/);
});

test('a run counts quick restarts at the same step; another step or a slow restart starts again', () => {
  const now = Date.now();
  assert.equal(runRestarts(undefined, 'p/repo/x', now).n, 1);
  assert.equal(runRestarts({ step: 'p/repo/x', n: 2, at: now - 60_000 }, 'p/repo/x', now).n, 3);
  assert.equal(runRestarts({ step: 'p/repo/x', n: 2, at: now - 60 * 60_000 }, 'p/repo/x', now).n, 1);
  assert.equal(runRestarts({ step: 'p/build/y', n: 2, at: now - 60_000 }, 'p/repo/x', now).n, 1);
});

test('a run restarted RESTART_LOOP times in a row at one step fails that step instead of resuming it', () => {
  const at = Date.now() - 60_000;
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES ('r_loop', 'beta', 'running', 'x', '["nope"]', ?, ?)`)
    .run(JSON.stringify({ restarts: { step: 'nope/repo/huge', n: RESTART_LOOP, at } }), at);
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, started) VALUES ('s_loop', 'r_loop', 'nope', 'repo', 'huge', 'running', 'cloning', ?)`).run(at);
  const resumed = resumeRuns();
  assert.ok(!resumed.includes('r_loop'));
  const run = db.prepare(`SELECT status, detail FROM runs WHERE id = 'r_loop'`).get() as { status: string; detail: string };
  assert.equal(run.status, 'failed');
  assert.match(run.detail, /restarted 3 times in a row during this run's repo step \(huge\)/);
  const step = db.prepare(`SELECT status, detail FROM steps WHERE id = 's_loop'`).get() as { status: string; detail: string };
  assert.equal(step.status, 'failed');
  assert.match(step.detail, /isn't resumed again/);
});

// The resumed pass of these fake changes ends by itself (no such product); a restart comes after it has let go.
async function settled(id: string) {
  const end = Date.now() + 5000;
  while (passInternals.isRunning(id) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

// A Cloud Run agent job outlives Studio: its output moving between restarts means progress, so the restart isn't counted.
const cloudProc = (offset: number) => ({ rec: { unit: 'hawkes-agent-x', mode: 'cloudrun' as const, started: 1 }, offset });
const cloudPhase = (offset: number, restarts?: Record<string, unknown>) => ({ step: 'agent' as const, since: 1, proc: cloudProc(offset), ...(restarts ? { restarts } : {}) });

const restartsOf = (id: string) => JSON.parse((db.prepare(`SELECT phase FROM changes WHERE id = ?`).get(id) as { phase: string }).phase).restarts;
/** Studio restarts: the change is as the last restart left it (the same counter), its job's output at `offset`. */
async function restartAt(id: string, offset: number, restarts: unknown) {
  await settled(id);
  db.prepare(`UPDATE changes SET phase = ?, status = 'working' WHERE id = ?`).run(JSON.stringify(cloudPhase(offset, restarts as any)), id);
  return resumeChanges();
}

test('a Cloud Run agent reattached after 4 restarts with its output advancing each time keeps running', async () => {
  seed('c_cr', cloudPhase(100));
  let restarts: any;
  for (let i = 1; i <= 4; i++) {
    assert.ok((await restartAt('c_cr', 100 * (i + 1), restarts)).includes('c_cr'), `restart ${i} resumed`);
    restarts = restartsOf('c_cr');
    assert.equal(restarts.n, 1);
    assert.equal(restarts.offset, 100 * (i + 1));
    assert.notEqual(getChange('c_cr')!.status, 'failed');
  }
  assert.ok(getChange('c_cr')!.log.some((l: any) => /progress since last restart: not counted/.test(JSON.stringify(l))));
});

test('a Cloud Run agent whose output does not move across restarts is stopped with the usual message', async () => {
  seed('c_still', cloudPhase(500));
  let restarts: any;
  const lines: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const resumed = await restartAt('c_still', 500, restarts);
    if (i <= 3) {
      assert.ok(resumed.includes('c_still'), `restart ${i} resumed`);
      restarts = restartsOf('c_still');
      lines.push(JSON.stringify(getChange('c_still')!.log.at(-1)));
    }
  }
  const c = getChange('c_still')!;
  assert.equal(c.status, 'failed');
  assert.match(c.detail!, /restarted 3 times in a row during its agent step/);
  assert.match(lines[1], /no progress: 2 of 3/);
});

test('restartCount: local agents never get the progress exemption; slow restarts start again', () => {
  const now = Date.now();
  const local = { step: 'agent' as const, proc: { rec: { unit: 'u', mode: 'systemd' as const, started: 1 }, offset: 900 } };
  assert.equal(restartCount({ step: 'agent', n: 2, at: now - 1000, offset: 10 }, local, now).n, 3);
  assert.equal(restartCount({ step: 'agent', n: 2, at: now - 1000, offset: 10 }, cloudPhase(900), now).n, 1);
  assert.equal(restartCount({ step: 'agent', n: 2, at: now - 1000, offset: 900 }, cloudPhase(900), now).n, 3);
  assert.equal(restartCount({ step: 'agent', n: 2, at: now - 3 * 3600_000, offset: 10 }, cloudPhase(900), now).n, 1);
});

// 2026-11-11: Studio went live every ~9 minutes, and each go live restarted it onto a new revision; runs were stopped after
// 4 such restarts as "what crashed it". A restart onto a new revision (a deploy) isn't a crash and isn't counted.
test('a run whose restarts were deploys onto new revisions keeps resuming; the same revision still counts', () => {
  const was = process.env.K_REVISION;
  try {
    const now = Date.now();
    const seed = (id: string, rev: string) => {
      db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, 'live', 'running', 'x', '["nope"]', ?, ?)`)
        .run(id, JSON.stringify({ rev, resumes: [now - 20 * 60_000, now - 12 * 60_000, now - 4 * 60_000], restarts: { step: 'nope/build/web', n: RESTART_LOOP, at: now - 4 * 60_000 } }), now - 25 * 60_000);
      db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, started) VALUES (?, ?, 'nope', 'build', 'web', 'running', 'building', ?)`).run(`s_${id}`, id, now - 5 * 60_000);
    };
    process.env.K_REVISION = 'studio-00181-hx5';
    seed('r_deployed', 'studio-00180-bsg');
    seed('r_crashed', 'studio-00181-hx5');
    // A go live run with no commit has no body to resume: it ends 'interrupted', which shows it got past the restart limits.
    resumeRuns();
    const deployed = db.prepare(`SELECT status, detail FROM runs WHERE id = 'r_deployed'`).get() as { status: string; detail: string };
    assert.equal(deployed.status, 'interrupted', `got past the restart limits (${deployed.detail})`);
    const opts = JSON.parse((db.prepare(`SELECT options FROM runs WHERE id = 'r_deployed'`).get() as { options: string }).options);
    assert.equal(opts.rev, 'studio-00181-hx5', 'now on the new revision');
    assert.equal(opts.resumes.length, 3, 'the deploy restart is not counted');
    const crashed = db.prepare(`SELECT status, detail FROM runs WHERE id = 'r_crashed'`).get() as { status: string; detail: string };
    assert.equal(crashed.status, 'failed');
    assert.match(crashed.detail, /restarted 4 times in 30 minutes/);
  } finally {
    if (was === undefined) delete process.env.K_REVISION; else process.env.K_REVISION = was;
  }
});

test('rolledOut: only a known, different revision is a deploy', () => {
  assert.equal(rolledOut('a', 'b'), true);
  assert.equal(rolledOut('a', 'a'), false);
  assert.equal(rolledOut(undefined, 'b'), false);
  assert.equal(rolledOut('a', undefined), false);
});
