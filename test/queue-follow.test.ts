// A queued agent change follows its roadmap task (2026-11-10: a roadmap prune dropped or rewrote about 160 tasks and left
// about 20 queued changes holding the old text, cancelled by hand). A task dropped while its change is still queued
// cancels that change at once; a task rewritten while its change is queued gives the change the new request and criteria
// as it starts; a change an agent has started on is never touched. Scratch database; no Gen, agents or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-queue-follow-'));
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
    local: { serve: 'static', dir: 'gw', port: 8795, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }],
  infra: [],
}));

const rm = await import('../src/roadmap.ts');
const agents = await import('../src/agents.ts');
const C = await import('../src/cancel.ts');
const QF = await import('../src/queue-follow.ts');
const { db, J } = await import('../src/db.ts');

let n = 0;
/** A task with a change the PM queued for it (as pm.ts startTaskChange does), in `status`. */
function queuedFor(request: string, criteria: string[], status = 'queued', extra: { phase?: unknown; session?: string } = {}) {
  const it = rm.addItem({ product: 'gw', title: `Item ${++n}`, status: 'planned' });
  const t = rm.addTask({ item: it.id, request, criteria });
  const id = `c_af${String(n).padStart(10, '0')}`;
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, request, criteria, notes, log, created, updated, task, phase, session)
    VALUES (?, 'gw', '[]', ?, 'gw', 'x/gw', ?, 'beta', ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)`)
    .run(id, status, `task/${id}`, path.join(tmp, 'none', id), t.title, request, J(criteria), Date.now(), Date.now(), t.id, extra.phase ? J(extra.phase) : null, extra.session ?? null);
  rm.setTask(t.id, { status: 'working', change: id, changes: [id] });
  return { t, id };
}

test('a queued change whose task is rewritten starts with the new request and criteria', () => {
  const { t, id } = queuedFor('Make the jump higher', ['jump reaches 3 m']);
  rm.updateTask(t.id, { request: 'Make the jump feel floaty', criteria: ['hang time is 0.8 s', 'no double jump'] });
  assert.equal(QF.refreshFromTask(agents.getChange(id)!), true, 'it still starts');
  const c = agents.getChange(id)!;
  assert.equal(c.status, 'queued');
  assert.equal(c.request, 'Make the jump feel floaty');
  assert.deepEqual(c.criteria, ['hang time is 0.8 s', 'no double jump']);
  assert.match(c.log.at(-1) ?? '', new RegExp(`its task ${t.id} was rewritten while it was queued: it starts with the task's new request and criteria`));
  // Nothing changed since: nothing more is written.
  const logs = c.log.length;
  assert.equal(QF.refreshFromTask(id), true);
  assert.equal(agents.getChange(id)!.log.length, logs);
});

test("the PM's note for another attempt stays on a refreshed request", () => {
  const { t, id } = queuedFor('Old ask', ['a']);
  db.prepare('UPDATE changes SET request = ? WHERE id = ?').run('Old ask\n\nFrom the PM (an earlier attempt): the menu overlapped', id);
  rm.updateTask(t.id, { request: 'New ask' });
  assert.equal(QF.refreshFromTask(id), true);
  assert.equal(agents.getChange(id)!.request, 'New ask\n\nFrom the PM (an earlier attempt): the menu overlapped');
  // Only the criteria changed: the request (with its note) stays.
  rm.updateTask(t.id, { criteria: ['b'] });
  QF.refreshFromTask(id);
  assert.equal(agents.getChange(id)!.request, 'New ask\n\nFrom the PM (an earlier attempt): the menu overlapped');
  assert.deepEqual(agents.getChange(id)!.criteria, ['b']);
});

test('a queued change whose task is dropped is cancelled at once and never starts', async () => {
  const { t, id } = queuedFor('Add a shop', ['shop opens']);
  rm.updateTask(t.id, { status: 'dropped' });
  await QF.followSettled();
  const c = agents.getChange(id)!;
  assert.equal(c.status, 'cancelled');
  assert.equal(C.cancelNote(`change:${id}`)!.by, 'Studio');
  assert.equal(C.cancelNote(`change:${id}`)!.reason, 'task dropped before start');
  assert.match(c.detail ?? '', /cancelled by Studio \(task dropped before start\)/);
  assert.ok(rm.listDecisions({ action: 'cancelled' }).some((d) => d.subject === t.id && String(d.detail).includes(id)), 'in the decision log');
});

test('a task put back to idea or marked done cancels its queued change too', async () => {
  for (const status of ['idea', 'done']) {
    const { t, id } = queuedFor(`Thing ${status}`, []);
    rm.updateTask(t.id, { status });
    await QF.followSettled();
    assert.equal(agents.getChange(id)!.status, 'cancelled', status);
    assert.match(C.cancelNote(`change:${id}`)!.reason ?? '', /^task dropped before start/);
  }
});

test('at start, a change whose task went away by any route is cancelled instead of starting', async () => {
  const { t, id } = queuedFor('Old work', []);
  // Dropped without updateTask (an item drop, a bulk prune): the start-time check still catches it.
  db.prepare(`UPDATE tasks SET status = 'dropped' WHERE id = ?`).run(t.id);
  assert.equal(QF.refreshFromTask(id), false, 'it does not start');
  assert.equal(QF.refreshFromTask(id), false, 'a second pass while the cancel lands does not start it either');
  await QF.followSettled();
  assert.equal(agents.getChange(id)!.status, 'cancelled');
  // A task that no longer exists at all.
  const gone = queuedFor('Deleted task', []);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(gone.t.id);
  assert.equal(QF.refreshFromTask(gone.id), false);
  await QF.followSettled();
  assert.equal(agents.getChange(gone.id)!.status, 'cancelled');
});

test('a working change, or one an agent already started, is never touched', async () => {
  const working = queuedFor('Working on it', ['x'], 'working', { phase: { step: 'agent', since: Date.now() } });
  const answered = queuedFor('Asked a question', ['x'], 'queued', { session: 'sess-1', phase: { step: 'agent', since: Date.now() } });
  for (const { t } of [working, answered]) rm.updateTask(t.id, { request: 'Rewritten', criteria: ['y'] });
  for (const { id } of [working, answered]) assert.equal(QF.refreshFromTask(id), true);
  for (const { t } of [working, answered]) rm.updateTask(t.id, { status: 'dropped' });
  await QF.followSettled();
  assert.deepEqual(await QF.cancelDropped(working.t.id), []);
  for (const { id } of [working, answered]) {
    const c = agents.getChange(id)!;
    assert.notEqual(c.status, 'cancelled', id);
    assert.equal(c.request, id === working.id ? 'Working on it' : 'Asked a question', 'its request is as it was');
    assert.deepEqual(c.criteria, ['x']);
    assert.equal(C.cancelNote(`change:${id}`), null);
  }
  assert.equal(agents.getChange(working.id)!.status, 'working');
});

test('a change with no task starts as it is', () => {
  const id = 'c_af0000000999';
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, request, notes, log, created) VALUES (?, 'gw', '[]', 'queued', 'gw', 'x/gw', 'b', 'beta', ?, 'T', 'J asked', '[]', '[]', ?)`).run(id, path.join(tmp, 'none'), Date.now());
  assert.equal(QF.refreshFromTask(id), true);
  assert.equal(agents.getChange(id)!.request, 'J asked');
});
