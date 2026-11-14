// Cancelled is its own outcome (J, 2026-10-26: Talk cancelled a queued Unity build in Gen, the beta run recorded "failed:
// cancelled before it started", the PM read that as a broken build and sent a task back to an agent on Opus to "fix the
// compile errors"). The status mapping of a run, the PM ignoring a cancelled build or playtest, the repair of what that
// day left, the cancel routes' guards, and an agent cancel that is not a try. Scratch database; no Gen, agents or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cancel-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { gw: 'x/gw' },
  products: [{
    id: 'gw', name: 'gw', framing: 'test', engine: 'static', repo: 'gw', site: 'gw', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'gw', port: 8794, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }],
  infra: [],
}));

const C = await import('../src/cancel.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const agents = await import('../src/agents.ts');
const { guardRoute } = await import('../src/guards.ts');
const { db, J } = await import('../src/db.ts');

let n = 0;
function run(status: string, kind = 'beta') {
  const id = `r_c0${String(++n).padStart(10, '0')}`;
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, status, 'x', J(['gw']), Date.now() - 60_000, Date.now());
  return id;
}
function step(runId: string, kind: string, name: string, status: string, detail = '') {
  const id = `s_c0${String(++n).padStart(10, '0')}`;
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, runId, 'gw', kind, name, status, detail, Date.now() - 50_000, Date.now());
  return id;
}

test('a run ends failed, cancelled, partial or done from its steps', () => {
  assert.equal(C.endStatus({ failed: 0, cancelled: 0, done: 3 }), 'done');
  assert.equal(C.endStatus({ failed: 1, cancelled: 1, done: 3 }), 'failed', 'a real failure still fails the run');
  assert.equal(C.endStatus({ failed: 0, cancelled: 1, done: 0 }), 'cancelled');
  assert.equal(C.endStatus({ failed: 0, cancelled: 1, done: 2 }), 'partial', 'other steps finished');
  assert.equal(C.endStatus({ failed: 0, cancelled: 0, done: 0 }, true), 'cancelled', 'a cancelled run with nothing run');
  assert.equal(C.endStatus({ failed: 0, cancelled: 0, done: 2 }, true), 'partial');
});

test('who cancelled and why is kept, and read back as words', () => {
  C.noteCancel('job:j_x', 'Talk', 'hold builds for an art pass');
  C.noteCancel('job:j_x', 'J', 'ignored: the first record stands');
  assert.equal(C.cancelNote('job:j_x')!.by, 'Talk');
  assert.equal(C.jobCancelDetail({ id: 'j_x' }), 'cancelled by Talk (hold builds for an art pass)');
  assert.match(C.jobCancelDetail({ id: 'j_unknown', error: 'cancelled before it started' }), /^cancelled in Hawkes Gen: cancelled before it started/);
});

test('the PM reads a cancelled build or playtest as nothing: not a broken build, not a missed criterion', () => {
  const r = run('cancelled');
  step(r, 'build', 'unity', 'cancelled', 'cancelled by Talk; not built');
  assert.match(pm.brokenCheck(r, 'gw') ?? '', /cancelled/, 'the run says nothing about beta');
  assert.equal(C.buildCancelled(r, 'gw'), true);
  const failedBuild = run('failed');
  step(failedBuild, 'build', 'unity', 'failed', 'failed: error CS0103');
  assert.equal(C.buildCancelled(failedBuild, 'gw'), false, 'a really failed build is still failed');
  const p = run('partial');
  step(p, 'build', 'unity', 'done', 'built');
  step(p, 'playtest', 'smoke@local', 'cancelled', 'cancelled by J');
  assert.match(pm.brokenCheck(p, 'gw') ?? '', /playtest smoke@local cancelled/);
});

test('followBuilds does not blame a task for a cancelled build', async () => {
  // Only this test's runs: the earlier tests' runs (one with a really failed build) would be blamed, rightly.
  db.exec('DELETE FROM steps; DELETE FROM runs');
  const it = rm.addItem({ product: 'gw', title: 'Art pass', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Art' });
  const cancelled = run('failed');
  step(cancelled, 'build', 'unity', 'failed', 'failed: cancelled before it started');
  rm.setTask(t.id, { status: 'merged', merged_at: Date.now() - 120_000, build: { ok: false, run: cancelled, at: Date.now(), unity: true, detail: `beta's build failed (run ${cancelled}): build unity: failed: cancelled before it started` } });
  await pm.followBuilds();
  const run1 = db.prepare('SELECT status FROM runs WHERE id = ?').get(cancelled) as any;
  assert.equal(run1.status, 'cancelled', "r_f75a40eec26e's case: the run reads cancelled");
  assert.equal((db.prepare('SELECT status FROM steps WHERE run = ?').get(cancelled) as any).status, 'cancelled');
  const after = rm.getTask(t.id)!;
  assert.equal(after.status, 'merged');
  assert.equal(after.build, null, 'the build is not counted against the task');
  assert.equal(rm.listDecisions({ action: 'build-failed' }).filter((d) => d.subject === cancelled).length, 0, 'no build-failed decision');
  assert.equal(rm.listDecisions({ action: 'build-sendback' }).filter((d) => d.subject === t.id).length, 0, 'nothing sent back');
});

test('an agent change sent back for a cancelled build is cancelled by the PM, and the task goes back to waiting', async () => {
  const it = rm.addItem({ product: 'gw', title: 'Sent back', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'x' });
  const r = run('cancelled');
  step(r, 'build', 'unity', 'cancelled', 'cancelled by Talk; not built');
  const merged = 'c_c00000000001';
  const back = 'c_c00000000002';
  const row = (id: string, status: string, request: string | null) => db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, request)
    VALUES (?, 'gw', '[]', ?, 'gw', 'x/gw', ?, 'beta', ?, 'T', '[]', '[]', ?, ?, ?, ?)`).run(id, status, `task/${id}`, path.join(tmp, 'none'), Date.now() - (id === merged ? 100_000 : 1000), Date.now(), t.id, request);
  row(merged, 'merged', null);
  db.prepare('UPDATE changes SET merged_at = ? WHERE id = ?').run(Date.now() - 90_000, merged);
  row(back, 'working', `Beta's build failed after your change ${merged} merged into beta: beta's build failed (run ${r}): build unity: failed: cancelled. Make beta build again (for Unity: fix the compile errors)`);
  rm.setTask(t.id, { status: 'working', change: back, changes: [merged, back], merged_at: null, build: null });
  await pm.followBuilds();
  assert.equal(agents.getChange(back)!.status, 'cancelled');
  assert.equal(C.cancelNote(`change:${back}`)!.by, 'the PM');
  assert.match(C.cancelNote(`change:${back}`)!.reason ?? '', /cancelled, not failed/);
  const task = rm.getTask(t.id)!;
  assert.equal(task.status, 'merged');
  assert.equal(task.change, merged);
  assert.ok((task.merged_at ?? 0) > 0);
});

test('cancelling an agent change keeps its branch, is not a try, and the PM does not start it again', async () => {
  const it = rm.addItem({ product: 'gw', title: 'Cancel me', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'x' });
  const id = 'c_c00000000010';
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, phase)
    VALUES (?, 'gw', '[]', 'working', 'gw', 'x/gw', 'task/c10', 'beta', ?, 'T', '[]', '[]', ?, ?, ?, ?)`).run(id, path.join(tmp, 'none'), Date.now(), Date.now(), t.id, J({ step: 'agent', since: Date.now() }));
  rm.setTask(t.id, { status: 'working', change: id, changes: [id] });
  await assert.rejects(agents.cancelChange('c_c0ffffffffff'), /No such change/);
  const c = await agents.cancelChange(id, 'J', 'holding for the art pass');
  assert.equal(c!.status, 'cancelled');
  assert.match(c!.detail ?? '', /cancelled by J \(holding for the art pass\)/);
  assert.equal(C.cancelNote(`change:${id}`)!.by, 'J');
  await assert.rejects(agents.cancelChange(id), /nothing to cancel/);
  // A pass still winding down can't turn it failed or ready.
  const logged = db.prepare('SELECT status FROM changes WHERE id = ?').get(id) as any;
  assert.equal(logged.status, 'cancelled');
  // Not a failed or closed attempt: it is not in the next agent's brief as "failed", and not a try.
  const next = { id: 'c_c00000000011', task: t.id, findings: [] as string[] };
  assert.equal(agents.earlierAttempts(next, 10).length, 0, 'earlier attempts are failed or closed ones only');
  await pm.syncTasks();
  const task = rm.getTask(t.id)!;
  assert.equal(task.status, 'working', 'the task is paused, not failed');
  assert.match(task.note ?? '', /was cancelled by J/);
  assert.equal(task.tries, 0);
  assert.equal(rm.startableTasks().some((x: any) => x.id === t.id), false, 'the PM does not start it again');
  assert.throws(() => agents.resumeChange('c_c00000000011'), /No such change/);
});

test('the cancel routes: members are refused (auth.test.ts), the sandbox only with a Talk conversation', () => {
  for (const route of ['/api/runs/r_0123456789ab/cancel', '/api/jobs/j_0123456789ab/cancel', '/api/changes/c_0123456789ab/cancel', '/api/changes/c_0123456789ab/resume']) {
    assert.match(String(guardRoute(route, 'POST', null)), /never an agent/, `${route} from an agent alone`);
    assert.equal(guardRoute(route, 'POST', 'talk_1'), null, `${route} from Talk`);
  }
  assert.equal(guardRoute('/api/runs/r_0123456789ab/cancel', 'GET', null), null);
});

test('repairing what a Gen-side cancel left as failed is idempotent', () => {
  const r = run('failed');
  step(r, 'build', 'unity', 'failed', 'failed: cancelled before it started');
  step(r, 'playtest', 'smoke@local', 'skipped', 'not played');
  assert.deepEqual(C.repairCancelled(), [r]);
  assert.deepEqual(C.repairCancelled(), []);
  assert.equal((db.prepare('SELECT status FROM runs WHERE id = ?').get(r) as any).status, 'cancelled');
});

test('a cancelled change whose worktree is gone resumes: queued at the agent step, its worktree made again from the saved branch by the pass', () => {
  const it = rm.addItem({ product: 'gw', title: 'Resume without a tree', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'x' });
  const id = 'c_c00000000020';
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, phase)
    VALUES (?, 'gw', '[]', 'cancelled', 'gw', 'x/gw', 'task/c20', 'beta', ?, 'T', '[]', '[]', ?, ?, ?, ?)`).run(id, path.join(tmp, 'gone-tree'), Date.now(), Date.now(), t.id, J({ step: 'agent', since: Date.now() }));
  const c = agents.resumeChange(id, 'J');
  assert.equal(c!.status, 'queued', 'no "has no worktree any more" refusal');
  const ph = agents.phaseOf(id)!;
  assert.equal(ph.step, 'agent');
  assert.equal(ph.harness?.kind, 'revive', 'the pass that carries on makes the worktree again first (worktreeForAgentStep)');
  assert.equal(ph.before, undefined, 'its starting commit is read once the tree is back');
});

test('closing a change sends its working task back to planned by itself, unless J closed it or another change is on its way', () => {
  const mk = (cid: string, status = 'working') => {
    const it = rm.addItem({ product: 'gw', title: `Closed ${cid}`, status: 'planned' });
    const t = rm.addTask({ item: it.id, request: 'x' });
    db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task)
      VALUES (?, 'gw', '[]', 'closed', 'gw', 'x/gw', ?, 'beta', ?, 'T', '[]', '[]', ?, ?, ?)`).run(cid, `task/${cid}`, path.join(tmp, 'none'), Date.now(), Date.now(), t.id);
    rm.setTask(t.id, { status, change: cid, changes: [cid] });
    return t.id;
  };
  const a = mk('c_c00000000030');
  assert.equal(agents.freeTaskOfClosed({ id: 'c_c00000000030', task: a }, 'the health watch'), true);
  assert.equal(rm.getTask(a)!.status, 'planned');
  const b = mk('c_c00000000031');
  assert.equal(agents.freeTaskOfClosed({ id: 'c_c00000000031', task: b }, 'J'), false, 'J closing it is the PM\'s question');
  assert.equal(rm.getTask(b)!.status, 'working');
  const d = mk('c_c00000000032', 'merged');
  assert.equal(agents.freeTaskOfClosed({ id: 'c_c00000000032', task: d }, 'the PM'), false, 'a merged task stays merged');
  const e = mk('c_c00000000033');
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task)
    VALUES ('c_c00000000034', 'gw', '[]', 'working', 'gw', 'x/gw', 'task/x34', 'beta', ?, 'T', '[]', '[]', ?, ?, ?)`).run(path.join(tmp, 'none'), Date.now(), Date.now(), e);
  assert.equal(agents.freeTaskOfClosed({ id: 'c_c00000000033', task: e }, 'the PM'), false, 'another change is on its way');
});

test('a compile parked on a Gen job Gen no longer knows goes on at once when the waits are looked at (the stream opening, Studio start)', async () => {
  const id = 'c_c00000000040';
  const since = Date.now();
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, phase)
    VALUES (?, 'gw', '[]', 'waiting on Gen', 'gw', 'x/gw', 'task/c40', 'beta', ?, 'T', '[]', '[]', ?, ?, ?)`).run(id, path.join(tmp, 'none'), since, since, J({ step: 'compile-wait', since, compileWait: { since, sha: 'a'.repeat(40), job: 'j_lost' } }));
  // Gen having it (or not answering) leaves the wait alone.
  assert.deepEqual(await agents.checkCompileJobs({ job: async () => ({ status: 'running' }) }), []);
  assert.deepEqual(await agents.checkCompileJobs({ job: async () => { throw Object.assign(new Error('offline'), { kind: 'offline' }); } }), []);
  assert.equal(agents.getChange(id)!.status, 'waiting on Gen');
  assert.deepEqual(await agents.checkCompileJobs({ job: async () => { throw Object.assign(new Error('No such job'), { status: 404 }); } }), [id]);
  const after = agents.getChange(id)!;
  assert.equal(after.status, 'queued');
  assert.equal(agents.phaseOf(id)!.step, 'compile');
  assert.equal(agents.phaseOf(id)!.compile?.outcome, 'unavailable');
  assert.equal(agents.phaseOf(id)!.compile?.ok, true, 'never a block');
});
