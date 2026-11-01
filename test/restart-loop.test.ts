// A change whose step keeps ending Studio (a clone too big for Cloud Run's memory disk crashed the customer Studio on
// every restart, 2026-10-31) stops being resumed after RESTART_LOOP quick restarts in a row; restarts far apart (deploys
// during a long agent pass) don't count. Runs do the same at their running step (pipeline.ts resumeRuns, runRestarts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-restart-loop-'));
const { resumeChanges, getChange, RESTART_LOOP, autoFixBlock } = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');
const { resumeRuns, runRestarts } = await import('../src/pipeline.ts');
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
