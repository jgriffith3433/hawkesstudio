// The roadmap and the PM loop's own logic on a scratch database: items and tasks, statuses following tasks, what can
// start (order, dependencies), the merge gate and "verified", comments and questions, triage with undo, the ready
// report. No agents, GitHub or Claude are involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pm-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'pmtest', name: 'PM test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const rm = await import('../src/roadmap.ts');
const { gate, allMet } = await import('../src/acceptance.ts');
const pm = await import('../src/pm.ts');
const { db } = await import('../src/db.ts');

test('items, tasks, order and dependencies', () => {
  const it = rm.addItem({ product: 'PM test', title: 'Checkout', goal: 'Players can buy a shot', criteria: '- a buy button\n- the cart shows the price', size: 'M', status: 'planned' });
  assert.equal(it.product, 'pmtest');
  assert.deepEqual(it.criteria, ['a buy button', 'the cart shows the price']);
  const a = rm.addTask({ item: it.id, request: 'Add the cart', criteria: ['the cart opens'] });
  const b = rm.addTask({ item: it.id, request: 'Add the buy button', depends: [a.id] });
  assert.deepEqual(rm.startableTasks().map((t) => t.id), [a.id], 'b waits for a');
  rm.setTask(a.id, { status: 'working', change: 'c_000000000001' });
  assert.equal(rm.getItem(it.id)!.status, 'in progress');
  rm.setTask(a.id, { status: 'merged', merged_at: Date.now() });
  assert.deepEqual(rm.startableTasks().map((t) => t.id), [b.id], 'b can start once a is merged');
  rm.setTask(a.id, { status: 'verified' });
  rm.setTask(b.id, { status: 'verified' });
  assert.equal(rm.getItem(it.id)!.status, 'on beta');
  rm.setTask(a.id, { status: 'live' });
  rm.setTask(b.id, { status: 'live' });
  assert.equal(rm.getItem(it.id)!.status, 'live');
  assert.throws(() => rm.addItem({ product: 'nope', title: 'x' }), /No product/);
  assert.throws(() => rm.updateItem(it.id, { status: 'shipped' }), /by hand/);
  assert.throws(() => rm.updateTask(a.id, { status: 'verified' }), /by hand/, 'verified comes from the checks');
  // A parked item's tasks don't start; dropping drops what hadn't started.
  const idea = rm.addItem({ product: 'pmtest', title: 'Later', status: 'idea' });
  const t = rm.addTask({ item: idea.id, request: 'Something later' });
  assert.ok(!rm.startableTasks().some((x) => x.id === t.id));
  rm.updateItem(idea.id, { status: 'dropped' });
  assert.equal(rm.getTask(t.id)!.status, 'dropped');
});

test('the merge gate and verified', () => {
  const crit = ['a', 'b'];
  assert.equal(gate(null, crit).pass, false);
  assert.equal(gate({ outcome: 'passed', verdict: 'ship', criteria: [{ criterion: 'a', met: 'yes' }, { criterion: 'b', met: 'unclear' }] }, crit).pass, true, 'unclear is judged again on beta');
  const no = gate({ outcome: 'passed', verdict: 'ship', criteria: [{ criterion: 'a', met: 'yes' }, { criterion: 'b', met: 'no', evidence: 'missing' }] }, crit);
  assert.equal(no.pass, false);
  assert.match(no.why.join(' '), /not met: b/);
  assert.equal(gate({ outcome: 'passed', verdict: 'broken', criteria: [] }, []).pass, false);
  assert.equal(gate({ outcome: 'passed', verdict: 'ship' }, crit).pass, false, 'criteria must be judged');
  assert.equal(gate({ outcome: 'passed', verdict: 'ship', changeWorked: 'partly' }, []).pass, false, 'a fix the review says only partly worked');
  assert.equal(gate({ outcome: 'timeout', verdict: 'ship' }, []).pass, false);
  assert.equal(allMet([{ criterion: 'a', met: 'yes' }, { criterion: 'b', met: 'yes' }], crit), true);
  assert.equal(allMet([{ criterion: 'a', met: 'yes' }, { criterion: 'b', met: 'unclear' }], crit), false);
});

test('comments, questions and the thread an agent reads', () => {
  const it = rm.addItem({ product: 'pmtest', title: 'Shop' });
  const t = rm.addTask({ item: it.id, request: 'Make a shop' });
  rm.addComment(it.id, 'Keep it one screen', 'J');
  rm.addComment(t.id, 'Use the green palette', 'Talk');
  const thread = rm.threadFor({ id: 'c_00000000abcd', task: t.id, findings: [] });
  assert.deepEqual(thread.map((m) => m.text), ['Keep it one screen', 'Use the green palette']);
  const q1 = rm.addQuestion({ kind: 'agent', subject: 'c_00000000abcd', product: 'pmtest', text: 'Coins or gems?' });
  const q2 = rm.addQuestion({ kind: 'agent', subject: 'c_00000000abcd', product: 'pmtest', text: 'Coins or gems?' });
  assert.equal(q1.id, q2.id, 'the same open question is not asked twice');
  assert.equal(rm.listQuestions().length, 1);
  assert.throws(() => rm.addComment('x_1', 'hi'), /subject/);
});

test('triage is logged and can be undone', async () => {
  const now = Date.now();
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen) VALUES ('f_aaaaaaaaaaaa', 'pmtest', 'k1', 'Button misaligned', 'polish', 'open', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen) VALUES ('f_bbbbbbbbbbbb', 'pmtest', 'k2', 'Button is misaligned', 'polish', 'open', ?, ?)`).run(now, now);
  assert.throws(() => pm.triageFinding('f_aaaaaaaaaaaa', 'wontfix'), /needs a note/);
  pm.triageFinding('f_aaaaaaaaaaaa', 'wontfix', { note: 'below the bar: a 2px offset' });
  pm.triageFinding('f_bbbbbbbbbbbb', 'duplicate', { of: 'f_aaaaaaaaaaaa' });
  const log = rm.listDecisions({ limit: 5 });
  assert.equal(log[0].action, 'duplicate');
  assert.equal(log[1].action, 'wontfix');
  await pm.undoDecision(log[1].id);
  assert.equal((db.prepare(`SELECT status FROM findings WHERE id = 'f_aaaaaaaaaaaa'`).get() as any).status, 'open');
  await assert.rejects(pm.undoDecision(log[1].id), /already undone/);
  assert.equal(rm.countToday('wontfix'), 0, 'an undone decision does not count');
});

test('settings are checked and logged', () => {
  assert.equal(pm.pmSettings().delegatedMerges, true, 'J chose delegated merges: on by default');
  pm.savePmSettings({ maxStartsPerDay: 5 });
  assert.equal(pm.pmSettings().maxStartsPerDay, 5);
  assert.throws(() => pm.savePmSettings({ maxTries: 'many' as any }), /must be a number/);
  assert.equal(rm.listDecisions({ action: 'settings' }).length, 1);
});

test('a milestone is reached when all its items are on beta', () => {
  const a = rm.addItem({ product: 'pmtest', title: 'Jump', status: 'planned' });
  const b = rm.addItem({ product: 'pmtest', title: 'Dash', status: 'planned' });
  const ms = rm.addMilestone({ product: 'pmtest', title: 'Controls done', test: 'Play level 1 with a pad', items: [a.id] });
  rm.updateItem(b.id, { milestone: ms.id });
  assert.equal(rm.milestoneProgress(ms.id).total, 2);
  const ta = rm.addTask({ item: a.id, request: 'Jump' });
  const tb = rm.addTask({ item: b.id, request: 'Dash' });
  rm.setTask(ta.id, { status: 'verified' });
  assert.equal(rm.milestoneProgress(ms.id).done, 1);
  assert.ok(!rm.milestonesToReach().some((m) => m.id === ms.id), 'one item still in progress');
  rm.setTask(tb.id, { status: 'verified' });
  assert.ok(rm.milestonesToReach().some((m) => m.id === ms.id));
  rm.markReached(ms.id);
  assert.equal(rm.getMilestone(ms.id)!.status, 'reached');
  assert.throws(() => rm.updateMilestone(ms.id, { status: 'reached' }), /by hand/);
  assert.equal(pm.readyReport({ milestone: ms.id }).length, 2);
  assert.equal(rm.listMilestones({ product: 'pmtest' })[0].done, 2);
});

test('the ready report shows verified criteria and known bugs', () => {
  const it = rm.addItem({ product: 'pmtest', title: 'Leaderboard', goal: 'See the best runs', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Add a leaderboard', criteria: ['the top 10 show'] });
  rm.setTask(t.id, { status: 'merged', merged_at: Date.now() - 1000, try: '1. Open the menu\n2. Press Leaderboard' });
  rm.setTask(t.id, { status: 'verified', checks: { where: 'beta', at: Date.now(), run: 'r_1', video: 'a_video', verdict: 'ship', results: [{ criterion: 'the top 10 show', met: 'yes', evidence: 'ten rows at 12 s' }] } });
  const now = Date.now();
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen, item) VALUES ('f_cccccccccccc', 'pmtest', 'k3', 'Names overflow', 'bug', 'open', ?, ?, ?)`).run(now, now, it.id);
  const r = pm.readyReport({ item: it.id })[0];
  assert.equal(r.status, 'on beta');
  assert.equal(r.criteria[0].met, 'yes');
  assert.equal(r.criteria[0].video, 'a_video');
  assert.deepEqual(r.bugs.map((b) => b.id), ['f_cccccccccccc']);
  const md = pm.readyMarkdown(r);
  assert.match(md, /✅ the top 10 show/);
  assert.match(md, /Press Leaderboard/);
  assert.match(md, /Names overflow/);
});

test('a content task that spends GPU money waits for J\'s budget', async () => {
  const it = rm.addItem({ product: 'pmtest', title: 'New stage', goal: 'A stage from a concept', criteria: ['the stage plays'], size: 'M', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Make the stage', gpu: [{ tool: 'image.edit', count: 20, label: 'paint' }] });
  assert.equal(t.gpu?.items?.length, 1);
  assert.ok(!rm.startableTasks().some((x) => x.id === t.id), 'not priced yet: waits');
  // Priced (as estimateTask would store it): still waits for J.
  db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(JSON.stringify({ ...t.gpu, estimate: { gpuHours: 0.4, cost: 0.75, withIdleTail: 1.4, servers: 1, wallMinutes: 30, at: Date.now() } }), t.id);
  assert.equal(rm.tasksAwaitingGpu().some((x) => x.id === t.id), true);
  assert.ok(!rm.startableTasks().some((x) => x.id === t.id));
  rm.approveGpu(t.id, 0.5, 'J');
  assert.ok(!rm.startableTasks().some((x) => x.id === t.id), 'a budget under the estimate does not cover it');
  rm.approveGpu(t.id, 1, 'J');
  assert.ok(rm.startableTasks().some((x) => x.id === t.id), 'approved: it can start');
  assert.equal(rm.tasksAwaitingGpu().some((x) => x.id === t.id), false);
  // A task with no GPU work never waits.
  const plain = rm.addTask({ item: it.id, request: 'Write the blurb' });
  assert.equal(rm.gpuCleared(plain), true);
  assert.throws(() => rm.addTask({ item: it.id, request: 'x', gpu: [{ count: 2 }] }), /tool \| preset/);
  rm.updateItem(it.id, { status: 'dropped' });
});
