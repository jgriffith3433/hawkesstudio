// The roadmap and backlog run to done with nothing but J adding items and bugs (J, 2026-10-19: "It should function
// just by me adding items to roadmap and bugs as well"). No item shows a wrong state or waits for ever: tasks found
// already done are done (on beta), a dropped dependency never blocks, a task whose every try said "already done" is
// done, an idea held until other work is on beta is released then, and a bug's next attempt waits for the one in
// flight (Studio's own failures aren't tries). Scratch database, no agents, GitHub or Claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stuck-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.TALK_CLAUDE = 'no-such-claude-here';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
const ids = ['skdone', 'skdeps', 'sktries', 'skheld', 'skbug'];
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: Object.fromEntries(ids.map((id) => [id, `x/${id}`])),
  products: ids.map((id) => ({
    id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: id, port: 8795, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  })),
  infra: [],
}));
const token = process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN = 'test';
after(() => { if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token; });

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const { db, J } = await import('../src/db.ts');
const ag = await import('../src/agents.ts');
pm.savePmSettings({ maxConcurrent: 50, maxStartsPerDay: 1000 });

const old = Date.now() - 3 * 3600_000;
let n = 0;
/** A change row as the agents leave it. */
const change = (product: string, o: { task?: string | null; findings?: string[]; status: string; detail?: string; summary?: string; phase?: any; created?: number }) => {
  const id = `c_5c0${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, summary, repo, slug, branch, base, worktree, title, notes, log, commits, phase, created, updated, task)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'task/x', 'beta', ?, 'A change', '[]', '[]', '[]', ?, ?, ?, ?)`)
    .run(id, product, J(o.findings ?? []), o.status, o.detail ?? o.status, o.summary ?? '', product, `x/${product}`, path.join(tmp, 'none', id), o.phase ? J(o.phase) : null, o.created ?? old, o.created ?? old, o.task ?? null);
  return id;
};
const built = { ok: true, run: 'r_1', at: Date.now(), detail: 'built OK' };
const view = (product: string, id: string) => rm.listItems({ product }).find((x) => x.id === id)!.progress;

test('tasks dropped as "already done" are done: the item shows on beta, and its milestone counts it', () => {
  const ms = rm.addMilestone({ title: 'Into Hell' });
  const shaft = rm.addItem({ product: 'skdone', title: 'The Shaft', status: 'planned', milestone: ms.id });
  const a = rm.addTask({ item: shaft.id, request: 'Dig the shaft' });
  const b = rm.addTask({ item: shaft.id, request: 'Light the shaft' });
  // How the PM left them today: dropped, with the note saying the work was already on beta.
  rm.setTask(a.id, { status: 'dropped', note: 'Expired: already done on beta (PR #31 did it)' });
  rm.setTask(b.id, { status: 'dropped', note: 'Superseded by k_000000000000, which merged it' });
  assert.equal(view('skdone', shaft.id).state, 'dropped', 'before: every task dropped reads as nothing to do, never planned');
  const king = rm.addItem({ product: 'skdone', title: 'The Magma King', status: 'planned', milestone: ms.id });
  const k = rm.addTask({ item: king.id, request: 'The boss' });
  rm.setTask(k.id, { status: 'merged', merged_at: Date.now(), build: built });
  // An item whose tasks were all really dropped (not done): nothing to do, and out of the milestone's count.
  const gone = rm.addItem({ product: 'skdone', title: 'Cut idea', status: 'planned', milestone: ms.id });
  const g = rm.addTask({ item: gone.id, request: 'Something J cut' });
  rm.setTask(g.id, { status: 'dropped', note: 'dropped on J\'s answer to q_1' });

  assert.deepEqual(rm.adoptDoneDrops().sort(), [a.id, b.id].sort());
  assert.equal(rm.getTask(a.id)!.status, 'done');
  assert.equal(view('skdone', shaft.id).state, 'on beta');
  assert.equal(view('skdone', shaft.id).merged, 2);
  assert.equal(view('skdone', gone.id).state, 'dropped');
  assert.equal(view('skdone', gone.id).label, 'dropped (nothing to do)');
  const p = rm.milestoneProgress(ms.id);
  assert.deepEqual([p.done, p.total], [2, 2], 'both real items on beta; the all-dropped one no longer counts');
  assert.ok(rm.milestonesToReach().some((m) => m.id === ms.id));
  assert.ok(rm.listDecisions({ action: 'already-done' }).some((d) => d.subject === a.id));
  assert.deepEqual(rm.adoptDoneDrops(), [], 'once');
  // By hand (Talk or the PM): done is allowed, and a task that depends on it can start.
  const later = rm.addTask({ item: king.id, request: 'After the shaft', depends: [a.id] });
  assert.deepEqual(rm.blockedBy(later), []);
  const c = rm.addTask({ item: king.id, request: 'Already there' });
  assert.equal(rm.updateTask(c.id, { status: 'done', note: 'c_123 did it' }).status, 'done');
  assert.throws(() => rm.updateTask(c.id, { status: 'merged' }), /by hand it can be idea, planned/);
});

test('a dropped dependency never blocks: the PM starts the task after it', async () => {
  const it = rm.addItem({ product: 'skdeps', title: 'Hell', status: 'planned' });
  const first = rm.addTask({ item: it.id, request: 'The groundwork' });
  const next = rm.addTask({ item: it.id, request: 'Build on it', depends: [first.id] });
  assert.equal(rm.blockedBy(next).length, 1);
  rm.updateTask(first.id, { status: 'dropped' });
  assert.deepEqual(rm.blockedBy(rm.getTask(next.id)!), []);
  assert.ok(rm.startableTasks().some((t) => t.id === next.id));
  assert.ok(!pm.stallReasons().some((r) => r.task === next.id && r.why.startsWith('blocked')));
  await pm.startWork();
  assert.equal(rm.getTask(next.id)!.status, 'working');
});

test('a task failed after its tries, every one saying "already done": done, not failed', async () => {
  const it = rm.addItem({ product: 'sktries', title: 'Talk shows the prices', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Show the prices' });
  const cs = [1, 2, 3].map((i) => change('sktries', { task: t.id, status: 'failed', detail: `${ag.ALREADY} (the agent made no commit)`, summary: 'PR #57 already did this; nothing left to do.', created: old + i }));
  rm.setTask(t.id, { status: 'failed', tries: 3, change: cs[2], changes: cs, note: 'failed 3 times' });
  pm.askJ('"Show the prices" failed 3 times. Try again?', { subject: t.id, product: 'sktries', options: ['try again', 'drop it'] });
  await pm.sweepFailed();
  assert.equal(rm.getTask(t.id)!.status, 'done');
  assert.equal(view('sktries', it.id).state, 'on beta');
  assert.ok(rm.listDecisions({ action: 'already-done' }).some((d) => d.subject === t.id));
  // Its question no longer waits on J.
  await (await import('../src/inbox.ts')).inbox();
  assert.ok(!rm.listQuestions().some((q) => q.subject === t.id), 'settled in the Inbox');
  // One attempt that said so, and another that really failed: still failed (J or a rescue decides).
  const t2 = rm.addTask({ item: it.id, request: 'Show the taxes' });
  const c1 = change('sktries', { task: t2.id, status: 'failed', detail: ag.ALREADY, summary: 'already done' });
  const c2 = change('sktries', { task: t2.id, status: 'failed', detail: 'the checks failed', summary: 'tests broke' });
  rm.setTask(t2.id, { status: 'failed', tries: 3, change: c2, changes: [c1, c2] });
  await pm.sweepFailed();
  assert.equal(rm.getTask(t2.id)!.status, 'failed');
});

test('an idea held until another item is on beta is released (planned) once that item is on beta', () => {
  const lava = rm.addItem({ product: 'skheld', title: 'Lava floor', status: 'planned' });
  const floor = rm.addTask({ item: lava.id, request: 'Make the floor' });
  const boss = rm.addItem({ product: 'skheld', title: 'Boss', status: 'planned' });
  rm.addTask({ item: boss.id, request: 'The fight' });
  const held = rm.addTask({ item: boss.id, request: 'The fight on the lava', status: 'idea' });
  rm.setTask(held.id, { note: `held until ${lava.id} ("Lava floor") is on beta` });
  const byTitle = rm.addTask({ item: boss.id, request: 'The lava roar', status: 'idea' });
  rm.setTask(byTitle.id, { note: 'Parked: waits for "Lava floor" to land on beta' });
  assert.deepEqual(pm.releaseHeldIdeas(), []);
  rm.setTask(floor.id, { status: 'merged', merged_at: Date.now() });
  assert.deepEqual(pm.releaseHeldIdeas(), [], 'merged but beta has not built it yet');
  rm.setTask(floor.id, { build: built });
  assert.deepEqual(pm.releaseHeldIdeas().sort(), [held.id, byTitle.id].sort());
  assert.equal(rm.getTask(held.id)!.status, 'planned');
  assert.ok(rm.listDecisions({ action: 'release' }).some((d) => d.subject === held.id));
  assert.ok(rm.startableTasks().some((t) => t.id === held.id));
});

test("a bug's retry waits for its previous try; Studio's own failures aren't tries", async () => {
  const now = Date.now();
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen) VALUES ('f_5c0000000001', 'skbug', 'nre', 'NullReferenceException in the shop', 'bug', 'open', ?, ?)`).run(now, now);
  const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE findings LIKE '%"f_5c0000000001"%'`).get() as any).n as number;
  // An attempt still in flight (waiting on J's answer, which holds no product slot): no second one.
  const asking = change('skbug', { findings: ['f_5c0000000001'], status: 'needs answer', created: now - 5 * 60_000 });
  await pm.startWork();
  assert.equal(count(), 1, 'not started beside the one in flight');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(asking);
  // Three attempts Studio failed to run (the worktree), a minute apart: none is a try, and the next waits a while.
  for (let i = 0; i < 3; i++) change('skbug', { findings: ['f_5c0000000001'], status: 'failed', detail: 'worktree failed: fatal: could not lock', phase: { step: 'prepare', failed: true }, created: now - (3 - i) * 60_000 });
  assert.ok(ag.studioFailed({ status: 'failed', phase: J({ step: 'prepare', failed: true }) }));
  await pm.startWork();
  assert.equal(count(), 4, 'the last Studio failure was a minute ago: it waits');
  db.prepare(`UPDATE changes SET updated = ?, created = created - ? WHERE findings LIKE '%"f_5c0000000001"%'`).run(now - pm.INFRA_WAIT_MS - 60_000, pm.INFRA_WAIT_MS);
  await pm.startWork();
  assert.equal(count(), 5, 'a fresh attempt: the Studio failures used none of its 3 tries (the closed one is the only try)');
  assert.ok(!rm.listQuestions().some((q) => q.subject === 'f_5c0000000001'), 'nobody asked J');
  // INFRA_LIMIT Studio failures in a row: J hears once, instead of a loop.
  const fresh = db.prepare(`SELECT id FROM changes WHERE findings LIKE '%"f_5c0000000001"%' ORDER BY created DESC, rowid DESC LIMIT 1`).get() as any;
  db.prepare(`UPDATE changes SET status = 'failed', phase = ?, updated = ? WHERE id = ?`).run(J({ step: 'agent', failed: true }), now - pm.INFRA_WAIT_MS - 60_000, fresh.id);
  db.prepare(`UPDATE findings SET status = 'open' WHERE id = 'f_5c0000000001'`).run();
  await pm.startWork();
  assert.equal(count(), 5, 'no fifth attempt');
  assert.equal(rm.listQuestions().filter((q) => q.subject === 'f_5c0000000001').length, 1);
});

test("a task's change Studio failed to run: not a try, planned again and started", async () => {
  pm.startPm();
  await new Promise((r) => setTimeout(r, 1800)); // the first pass after a start
  const it = rm.addItem({ product: 'skbug', title: 'Shop', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Restock the shop' });
  const c = change('skbug', { task: t.id, status: 'failed', detail: 'push failed: could not read Username', phase: { step: 'publish', failed: true } });
  rm.setTask(t.id, { status: 'working', change: c, changes: [c], tries: 1 });
  db.prepare(`UPDATE changes SET status = 'closed' WHERE product = 'skbug' AND task IS NULL`).run(); // the bug's, above: out of the way
  await pm.tick();
  assert.ok(rm.listDecisions({ action: 'retry' }).some((d) => d.subject === t.id && /not counted as a try/.test(d.detail ?? '')));
  const now = rm.getTask(t.id)!;
  assert.equal(now.status, 'working', 'started again in the same pass');
  assert.equal(now.tries, 1, 'the failed one was given back; the new one is the first real try');
});
