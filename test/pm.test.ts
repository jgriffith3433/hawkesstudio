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
}, {
  id: 'pmother', name: 'PM other', framing: 'test', engine: 'static', repo: 'other', site: 'other', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'other', port: 8798, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}, ...['pmthird', 'pmfourth', 'pmfifth', 'pmsixth'].map((id) => ({
  id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: id, port: 8799, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}))], repos: { other: 'x/other', pmthird: 'x/pmthird', pmfourth: 'x/pmfourth', pmfifth: 'x/pmfifth', pmsixth: 'x/pmsixth' }, infra: [{ id: 'pminfra', name: 'PM infra', repo: 'pminfra', slug: 'x/pminfra' }] }));

const rm = await import('../src/roadmap.ts');
const { gate, allMet } = await import('../src/acceptance.ts');
const pm = await import('../src/pm.ts');
const { db, J } = await import('../src/db.ts');

test('items, tasks, order and dependencies', () => {
  const it = rm.addItem({ product: 'PM test', title: 'Checkout', goal: 'Players can buy a shot', criteria: '- a buy button\n- the cart shows the price', size: 'M', status: 'planned' });
  assert.equal(it.product, 'pmtest');
  assert.deepEqual(it.criteria, ['a buy button', 'the cart shows the price']);
  const a = rm.addTask({ item: it.id, request: 'Add the cart', criteria: ['the cart opens'] });
  // J (2026-10-17): an item is consumed (done) as soon as it has tasks; its tasks still start and run.
  assert.equal(rm.getItem(it.id)!.status, 'done');
  assert.ok(rm.getItem(it.id)!.consumed);
  assert.match(rm.getItem(it.id)!.note ?? '', /tasks created/);
  const b = rm.addTask({ item: it.id, request: 'Add the buy button', depends: [a.id] });
  assert.deepEqual(rm.startableTasks().map((t) => t.id), [a.id], 'b waits for a');
  rm.setTask(a.id, { status: 'working', change: 'c_000000000001' });
  assert.equal(rm.getItem(it.id)!.status, 'done', 'stays done while its tasks run');
  rm.setTask(a.id, { status: 'merged', merged_at: Date.now() });
  assert.deepEqual(rm.startableTasks().map((t) => t.id), [b.id], 'b can start once a is merged');
  rm.setTask(a.id, { status: 'verified' });
  rm.setTask(b.id, { status: 'verified' });
  assert.equal(rm.getItem(it.id)!.status, 'done');
  // An item from before (in progress) still follows its tasks.
  const old = rm.addItem({ product: 'pmtest', title: 'Old', status: 'idea' });
  const ot = rm.addTask({ item: old.id, request: 'Old work' });
  db.prepare(`UPDATE items SET status = 'in progress' WHERE id = ?`).run(old.id);
  rm.setTask(ot.id, { status: 'verified' });
  assert.equal(rm.getItem(old.id)!.status, 'on beta');
  rm.setTask(ot.id, { status: 'live' });
  assert.equal(rm.getItem(old.id)!.status, 'live');
  // Done by hand (not consumed): its planned tasks don't start.
  const hand = rm.addItem({ product: 'pmtest', title: 'By hand', status: 'idea' });
  const ht = rm.addTask({ item: hand.id, request: 'Not this' });
  rm.updateItem(hand.id, { status: 'done' });
  assert.ok(!rm.startableTasks().some((x) => x.id === ht.id));
  // Parked, then planned: consumed then.
  const later = rm.addItem({ product: 'pmtest', title: 'Parked', status: 'idea' });
  const lt = rm.addTask({ item: later.id, request: 'Parked work' });
  assert.equal(rm.getItem(later.id)!.status, 'idea');
  rm.updateItem(later.id, { status: 'planned' });
  assert.equal(rm.getItem(later.id)!.status, 'done');
  assert.ok(rm.startableTasks().some((x) => x.id === lt.id));
  rm.updateItem(later.id, { status: 'dropped' });
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
  // Not playtested (J's call, 2026-10-16: a playtest is on request, not a gate): ready on the agent's checks passes.
  assert.equal(gate(null, crit).pass, true);
  const unplayed = gate({ sha: 'abc', preview: null, scenario: 'checkout' }, crit);
  assert.deepEqual([unplayed.pass, unplayed.played, unplayed.why], [true, false, []]);
  assert.equal(gate({ sha: 'abc', outcome: 'not played', error: "the playtest couldn't run: no page server" }, crit).pass, true, "a playtest that couldn't run is no reason");
  assert.equal(gate({ sha: 'abc', canon: { ok: false, summary: 'x', conflicts: [{ entry: 'm_1', why: 'contradicts' }] } }, []).pass, false, 'a canon conflict still stops it');
  assert.equal(gate({ outcome: 'passed', verdict: 'ship', criteria: [{ criterion: 'a', met: 'yes' }, { criterion: 'b', met: 'unclear' }] }, crit).pass, true, 'unclear is judged again on beta');
  const no = gate({ outcome: 'passed', verdict: 'ship', criteria: [{ criterion: 'a', met: 'yes' }, { criterion: 'b', met: 'no', evidence: 'missing' }] }, crit);
  assert.equal(no.pass, false);
  assert.match(no.why.join(' '), /not met: b/);
  assert.equal(gate({ outcome: 'passed', verdict: 'broken', criteria: [] }, []).pass, false);
  assert.equal(gate({ outcome: 'passed', verdict: 'ship' }, crit).pass, true, 'criteria are judged on beta');
  assert.equal(gate({ outcome: 'passed', verdict: 'ship', playtest: 'j_1' }, crit).played, true);
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
  assert.equal(rm.milestoneProgress(ms.id).done, 0, 'consumed items count once their tasks are on beta');
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

test('the ready report shows verified criteria and known bugs', async () => {
  await import('../src/agents.ts'); // the changes table (a product's list reads its changes' summaries)
  const it = rm.addItem({ product: 'pmtest', title: 'Leaderboard', goal: 'See the best runs', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Add a leaderboard', criteria: ['the top 10 show'] });
  rm.setTask(t.id, { status: 'merged', merged_at: Date.now() - 1000, try: '1. Open the menu\n2. Press Leaderboard' });
  rm.setTask(t.id, { status: 'verified', checks: { where: 'beta', at: Date.now(), run: 'r_1', video: 'a_video', verdict: 'ship', results: [{ criterion: 'the top 10 show', met: 'yes', evidence: 'ten rows at 12 s' }] } });
  const now = Date.now();
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen, item) VALUES ('f_cccccccccccc', 'pmtest', 'k3', 'Names overflow', 'bug', 'open', ?, ?, ?)`).run(now, now, it.id);
  const r = pm.readyReport({ item: it.id })[0];
  assert.equal(r.status, 'done');
  assert.equal(r.partly, false);
  assert.ok(pm.readyReport({ product: 'pmtest' }).some((x) => x.item === it.id), 'a consumed item shows in Ready to test');
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

test('an escalated change is asked about once: answered, the loop leaves it; "close" closes it', async () => {
  process.env.STUDIO_PM_TALK = 'off';
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'notify.json'), JSON.stringify({ enabled: false, server: 'http://127.0.0.1:9', topic: 'test' }));
  const { getChange } = await import('../src/agents.ts'); // the changes table
  pm.startPm();
  const it = rm.addItem({ product: 'pmtest', title: 'Leaderboard', criteria: ['names fit'], size: 'S', status: 'planned' });
  // A task on its last try whose ready change fails its gate, 20 minutes old (past the grace).
  const readyChange = (id: string) => {
    const t = rm.addTask({ item: it.id, request: `Fix the names (${id})`, criteria: ['names fit'] });
    const verify = { outcome: 'completed', verdict: 'ok', criteria: [{ criterion: 'names fit', met: 'no', evidence: 'they overflow' }] };
    db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, verify, notes, log, created, updated, task, criteria)
      VALUES (?, 'pmtest', '[]', 'ready', 'ready', 'site', 'x/site', ?, 'beta', ?, 'Fix the names', ?, '[]', '[]', ?, ?, ?, ?)`)
      .run(id, `task/${id}`, path.join(tmp, 'none', id), JSON.stringify(verify), Date.now(), Date.now() - 20 * 60_000, t.id, JSON.stringify(['names fit']));
    rm.setTask(t.id, { status: 'review', change: id, changes: [id], tries: 3 });
    return t;
  };
  const escalations = () => (db.prepare(`SELECT COUNT(*) AS n FROM pm_log WHERE action = 'escalate'`).get() as any).n as number;
  const questions = () => (db.prepare('SELECT COUNT(*) AS n FROM questions').get() as any).n as number;

  const t = readyChange('c_esc000000001');
  const e0 = escalations();
  await pm.tick();
  assert.equal(escalations(), e0 + 1, 'the last try failing asks J');
  const q = rm.listQuestions().find((x) => x.subject === t.id)!;
  assert.ok(q, 'his question is in the Inbox');
  await pm.answerQuestion(q.id, 'try again', 'J');
  const [e1, q1] = [escalations(), questions()];
  for (let i = 0; i < 5; i++) await pm.tick();
  assert.equal(escalations(), e1, 'no new escalations after J answered');
  assert.equal(questions(), q1, 'no new questions after J answered');
  // Revising it by hand doesn't ask again either.
  assert.deepEqual(await pm.pmRevise('c_esc000000001', 'once more'), { escalated: true, already: true });
  assert.equal(escalations(), e1);

  // "Close it" closes the change and drops the task, without a PM turn; a change that isn't ready can't be revised.
  const t2 = readyChange('c_esc000000002');
  await pm.tick();
  const q2 = rm.listQuestions().find((x) => x.subject === t2.id)!;
  await pm.answerQuestion(q2.id, 'Close it', 'J');
  assert.equal(getChange('c_esc000000002')!.status, 'closed');
  assert.equal(rm.getTask(t2.id)!.status, 'dropped');
  await assert.rejects(pm.pmRevise('c_esc000000002', 'again'), /closed, not ready/);
  for (let i = 0; i < 3; i++) await pm.tick();
  assert.equal(rm.listQuestions().filter((x) => x.subject === t2.id).length, 0, 'nothing more asked about it');
});

test('a merged Studio/Gen task is verified without a beta run', async () => {
  const it = rm.addItem({ product: 'pminfra', title: 'A Studio button', criteria: ['the button shows'], size: 'S', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Add the button', criteria: ['the button shows'] });
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, updated, task)
    VALUES ('c_infra0000001', 'pminfra', '[]', 'merged', 'merged into main', 'pminfra', 'x/pminfra', 'task/x', 'main', ?, 'Add the button', '[]', '[]', ?, ?, ?)`)
    .run(path.join(tmp, 'none', 'infra'), Date.now(), Date.now(), t.id);
  // Merged an hour ago: a product's task would start a beta run now (startBeta throws for Studio and Gen).
  rm.setTask(t.id, { status: 'merged', change: 'c_infra0000001', changes: ['c_infra0000001'], tries: 1, merged_at: Date.now() - 3600_000 });
  const runs = () => (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE kind = 'beta'`).get() as any).n as number;
  const r0 = runs();
  await pm.syncTasks();
  assert.equal(rm.getTask(t.id)!.status, 'verified');
  assert.equal(runs(), r0, 'no beta run');
  assert.ok(rm.listDecisions({ action: 'verified' }).some((d) => d.subject === t.id), 'logged');
});

test('the Roadmap tab loads Studio/Gen items: no "No product" error, their own names', async () => {
  // What the tab asks for (GET /api/roadmap, /api/ready, /api/pm) with a Studio item, filtered to it or not.
  const it = rm.addItem({ product: 'PM infra', title: 'A Studio panel', criteria: ['the panel shows'], size: 'S', status: 'planned' });
  assert.equal(it.product, 'pminfra', 'found by its name too');
  const t = rm.addTask({ item: it.id, request: 'Add the panel', criteria: ['the panel shows'] });
  rm.setTask(t.id, { status: 'verified', merged_at: Date.now() });
  const ms = rm.addMilestone({ title: 'Studio polish', product: 'pminfra' });
  assert.ok(rm.listItems({ product: 'pminfra' }).some((x) => x.id === it.id));
  assert.ok(rm.listMilestones({ product: 'pminfra' }).some((x) => x.id === ms.id));
  const products = rm.roadmapProducts();
  assert.deepEqual(products.find((p) => p.id === 'pminfra'), { id: 'pminfra', name: 'PM infra', infra: true }, 'the filter offers Studio/Gen');
  assert.equal(products.find((p) => p.id === 'pmtest')?.infra, false);
  const ready = pm.readyReport({ product: 'pminfra' }).find((r) => r.item === it.id);
  assert.equal(ready?.productName, 'PM infra', 'its name, not its id');
  const status = await pm.pmStatus();
  assert.doesNotMatch(String(status.lastError ?? ''), /No product/);
});

test('a task that throws in a tick does not stop other planned tasks from starting', async () => {
  process.env.STUDIO_PM_TALK = 'off';
  // Agents never actually run here: queued changes stay queued (no agent slots).
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test';
  pm.startPm();
  try {
    const bad = rm.addItem({ product: 'pmtest', title: 'Broken task', size: 'S', status: 'planned' });
    const tb = rm.addTask({ item: bad.id, request: 'Something' });
    db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, updated, task)
      VALUES ('c_boom00000001', 'pmtest', '[]', 'ready', 'ready', 'site', 'x/site', 'task/y', 'beta', ?, 'Something', '[]', '[]', ?, ?, ?)`)
      .run(path.join(tmp, 'none', 'boom'), Date.now(), Date.now(), tb.id);
    rm.setTask(tb.id, { status: 'working', change: 'c_boom00000001', changes: ['c_boom00000001'], tries: 1 });
    // Following this task up throws (its status can't change).
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON tasks WHEN NEW.id = '${tb.id}' AND NEW.status != OLD.status BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const good = rm.addItem({ product: 'pmother', title: 'Next thing', size: 'S', status: 'planned', ord: -100 });
    const tg = rm.addTask({ item: good.id, request: 'Do the next thing' });
    await pm.tick();
    assert.equal(rm.getTask(tg.id)!.status, 'working', 'the planned task started');
    assert.ok(rm.getTask(tg.id)!.change);
    assert.match(rm.getTask(tb.id)!.note ?? '', /boom/, 'the failing task says why');
    db.exec('DROP TRIGGER boom');
  } finally {
    if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
  }
});

test('priorities: old rows are normal, a task takes its item\'s unless it has its own', () => {
  // Rows written before priorities existed (no priority given): items normal, tasks inherit.
  db.prepare(`INSERT INTO items (id, product, title, status, ord, created) VALUES ('i_01d000000001', 'pmthird', 'Old item', 'idea', 0, ?)`).run(Date.now());
  db.prepare(`INSERT INTO tasks (id, item, product, title, request, created) VALUES ('k_01d000000001', 'i_01d000000001', 'pmthird', 'Old task', 'x', ?)`).run(Date.now());
  assert.equal(rm.getItem('i_01d000000001')!.priority, 'normal');
  assert.equal(rm.getTask('k_01d000000001')!.priority, null);
  assert.equal(rm.getTask('k_01d000000001')!.effective_priority, 'normal');
  rm.updateItem('i_01d000000001', { priority: 'low' });
  assert.equal(rm.getTask('k_01d000000001')!.effective_priority, 'low', "its item's");
  rm.updateTask('k_01d000000001', { priority: 'high' });
  assert.equal(rm.getTask('k_01d000000001')!.effective_priority, 'high', 'its own wins');
  rm.updateTask('k_01d000000001', { priority: '' });
  assert.equal(rm.getTask('k_01d000000001')!.effective_priority, 'low', "cleared: its item's again");
  assert.throws(() => rm.updateItem('i_01d000000001', { priority: 'urgent' }), /priority/);
  assert.throws(() => rm.updateItem('i_01d000000001', { priority: '' }), /priority/, "an item's can't be cleared");
  rm.updateItem('i_01d000000001', { status: 'dropped' });
});

test('priorities: the highest effective priority starts first, then roadmap order', () => {
  const lo = rm.addItem({ product: 'pmthird', title: 'Low', status: 'planned', priority: 'low', ord: -300 });
  const no = rm.addItem({ product: 'pmthird', title: 'Normal', status: 'planned', ord: -299 });
  const hi = rm.addItem({ product: 'pmfourth', title: 'High', status: 'planned', priority: 'high', ord: -298 });
  const tl = rm.addTask({ item: lo.id, request: 'Low thing' });
  const tn = rm.addTask({ item: no.id, request: 'Normal thing' });
  const tnh = rm.addTask({ item: no.id, request: 'Urgent thing in a normal item', priority: 'high' });
  const th = rm.addTask({ item: hi.id, request: 'High thing' });
  const mine = new Set([tl.id, tn.id, tnh.id, th.id]);
  assert.deepEqual(rm.startableTasks().filter((t) => mine.has(t.id)).map((t) => t.id), [tnh.id, th.id, tn.id, tl.id]);
  for (const it of [lo, no, hi]) rm.updateItem(it.id, { status: 'dropped' });
});

test('priorities: a blocked high-priority task waits for an unblocked normal one, and starts once its blocker merges', async () => {
  process.env.STUDIO_PM_TALK = 'off';
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test';
  const before = pm.pmSettings();
  try {
    const blocker = rm.addItem({ product: 'pmthird', title: 'Blocker', status: 'planned', ord: 500 });
    const tb = rm.addTask({ item: blocker.id, request: 'The groundwork' });
    const hi = rm.addItem({ product: 'pmfourth', title: 'Big thing', status: 'planned', priority: 'high', ord: -400 });
    const thb = rm.addTask({ item: hi.id, request: 'Build on the groundwork', depends: [tb.id] });
    const no = rm.addItem({ product: 'pmfourth', title: 'Small thing', status: 'planned', ord: -399 });
    const tnu = rm.addTask({ item: no.id, request: 'Something independent' });
    assert.ok(!rm.startableTasks().some((t) => t.id === thb.id), 'blocked: not startable');
    const listed = rm.listItems({ product: 'pmfourth' }).flatMap((i) => i.tasks).find((t) => t.id === thb.id)!;
    assert.deepEqual(listed.blocked_by.map((d) => d.title), ['The groundwork']);
    // One free agent slot: the unblocked normal task takes it.
    pm.savePmSettings({ maxConcurrent: pm.capacity().active + 1, maxStartsPerDay: 1000 });
    await pm.startWork();
    assert.equal(rm.getTask(tnu.id)!.status, 'working');
    assert.equal(rm.getTask(thb.id)!.status, 'planned');
    assert.match(rm.listDecisions({ action: 'start' }).find((d) => d.subject === tnu.id)!.detail!, /priority normal.*not blocked/);
    // The blocker merges and the normal task's agent finishes: the high one starts.
    rm.setTask(tb.id, { status: 'merged', merged_at: Date.now() });
    db.prepare(`UPDATE changes SET status = 'merged' WHERE id = ?`).run(rm.getTask(tnu.id)!.change);
    assert.deepEqual(rm.listItems({ product: 'pmfourth' }).flatMap((i) => i.tasks).find((t) => t.id === thb.id)!.blocked_by, []);
    await pm.startWork();
    assert.equal(rm.getTask(thb.id)!.status, 'working');
    assert.match(rm.listDecisions({ action: 'start' }).find((d) => d.subject === thb.id)!.detail!, /priority high.*not blocked/);
  } finally {
    pm.savePmSettings({ maxConcurrent: before.maxConcurrent, maxStartsPerDay: before.maxStartsPerDay });
    if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
  }
});

test('a finding is fixed as soon as an agent takes it; the PM leaves it; a review doesn\'t reopen it while unmerged', async () => {
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
  const { startFix, close, getChange } = await import('../src/agents.ts');
  const { absorb, getFinding } = await import('../src/backlog.ts');
  const now = Date.now();
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen) VALUES ('f_dddddddddddd', 'pmother', 'k4', 'Pause menu freezes the timer', 'bug', 'open', ?, ?)`).run(now, now);
  const id = startFix('pmother', ['f_dddddddddddd']);
  assert.equal(getFinding('f_dddddddddddd')!.status, 'fixed');
  assert.equal(getFinding('f_dddddddddddd')!.note, `agent change ${id}`);
  // The PM's bug pass only takes open findings.
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test';
  try {
    db.prepare(`UPDATE changes SET status = 'ready' WHERE id = ?`).run(id); // not busy: the PM could start another fix
    await pm.startWork();
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE findings LIKE '%"f_dddddddddddd"%'`).get() as any).n, 1, 'no second fix');
  } finally {
    if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
  }
  // Reported again while its change is unmerged: seen again, still fixed.
  absorb('pmother', 'r_again', 'smoke@local', [{ severity: 'bug', title: 'Pause menu freezes the timer' }]);
  assert.equal(getFinding('f_dddddddddddd')!.status, 'fixed');
  assert.equal(getFinding('f_dddddddddddd')!.seen, 2);
  // Closed without merging: open again.
  await close(id, 'test');
  assert.equal(getChange(id)!.status, 'closed');
  assert.equal(getFinding('f_dddddddddddd')!.status, 'open');
  // Merged, then reported again: it came back.
  db.prepare(`UPDATE findings SET status = 'fixed', note = 'merged' WHERE id = 'f_dddddddddddd'`).run();
  absorb('pmother', 'r_back', 'smoke@local', [{ severity: 'bug', title: 'Pause menu freezes the timer' }]);
  assert.equal(getFinding('f_dddddddddddd')!.status, 'open');
});

test('a task is started once: a failed try is retried, the retry merges, and nothing starts a third (k_da696e030f80)', async () => {
  process.env.STUDIO_PM_TALK = 'off';
  const agents = path.join(process.env.STUDIO_DATA!, 'agents.json');
  // Beta playtests on: the PM's check of a merged task runs (it started the duplicate on 2026-10-17).
  fs.writeFileSync(agents, JSON.stringify({ maxConcurrent: 0, betaPlaytests: true }));
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test';
  const before = pm.pmSettings();
  pm.startPm();
  const changesOf = (task: string) => db.prepare(`SELECT id, status FROM changes WHERE task = ? ORDER BY created`).all(task) as any[];
  const old = Date.now() - 3600_000;
  try {
    pm.savePmSettings({ maxConcurrent: pm.capacity().active + 5, maxStartsPerDay: 1000 });
    const it = rm.addItem({ product: 'pmfifth', title: 'Powered by', status: 'planned', ord: -900 });
    const crit = ['Landing page shows Powered by HAWKES GEN', 'Landing page links to the parent'];
    const t = rm.addTask({ item: it.id, request: 'Add the footer', criteria: crit });
    // Two starts in the same moment (two ticks, a tick and a PM turn): one change.
    await Promise.all([pm.startWork(), pm.startWork()]);
    assert.equal(changesOf(t.id).length, 1, 'started once');
    const [c1] = changesOf(t.id);
    // Try 1 fails; past the grace period the default retries it.
    db.prepare(`UPDATE changes SET status = 'failed', detail = 'the agent made no commit', updated = ? WHERE id = ?`).run(old, c1.id);
    await pm.tick();
    assert.equal(changesOf(t.id).length, 2, 'the failed try is retried');
    const c2 = changesOf(t.id)[1];
    assert.equal(rm.getTask(t.id)!.change, c2.id);
    // Ticks while the retry works start nothing more.
    await pm.tick();
    await pm.startWork();
    assert.equal(changesOf(t.id).length, 2, 'one attempt at a time');
    // The retry merges.
    db.prepare(`UPDATE changes SET status = 'merged', updated = ? WHERE id = ?`).run(Date.now(), c2.id);
    await pm.tick();
    assert.equal(rm.getTask(t.id)!.status, 'merged');
    rm.setTask(t.id, { merged_at: old });
    // Beta's run judged one criterion unclear (it never reached the page), and another task's criteria: no restart.
    db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES ('r_dup000000001', 'beta', 'passed', 'beta pmfifth', '["pmfifth"]', ?, ?)`).run(Date.now() - 60_000, Date.now());
    const step = (id: string, at: number, criteria: any[], run = 'r_dup000000001') => db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, 'pmfifth', 'review', 'smoke', 'done', ?, ?)`).run(id, run, J({ verdict: 'ship', criteria }), at);
    step('s_dup000000001', Date.now() - 50_000, [{ criterion: crit[0], met: 'unclear', evidence: 'only one page checked' }, { criterion: crit[1], met: 'yes', evidence: 'linked' }]);
    step('s_dup000000002', Date.now() - 40_000, [{ criterion: 'Fixed: something else', met: 'no', evidence: 'another task' }]);
    await pm.tick();
    await pm.tick();
    await pm.startWork();
    assert.equal(changesOf(t.id).length, 2, 'no third change for a merged task');
    assert.equal(rm.getTask(t.id)!.status, 'merged', 'still merged');
    assert.equal(rm.getTask(t.id)!.checks?.run, 'r_dup000000001', "judged by the review of its own criteria");
    assert.equal(rm.listDecisions({ action: 'start' }).filter((d) => d.subject === t.id).length, 2);
    // Nothing else may start it either (the PM turn's tools, a retry of the old failed try).
    assert.match(pm.startBlocked(t.id) ?? '', /already merged/);
    // A real miss on beta asks J instead of starting; his "try again" (back to planned) starts it fresh.
    db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES ('r_dup000000002', 'beta', 'passed', 'beta pmfifth', '["pmfifth"]', ?, ?)`).run(Date.now() - 35_000, Date.now());
    step('s_dup000000003', Date.now() - 30_000, [{ criterion: crit[0], met: 'no', evidence: 'no footer' }, { criterion: crit[1], met: 'yes', evidence: 'linked' }], 'r_dup000000002');
    await pm.tick();
    assert.equal(rm.getTask(t.id)!.status, 'failed');
    assert.equal(changesOf(t.id).length, 2, 'asked, not restarted');
    rm.updateTask(t.id, { status: 'planned' });
    assert.equal(pm.startBlocked(t.id), null, 'planned by hand may start again');
    await pm.startWork();
    assert.equal(changesOf(t.id).length, 3);
    assert.equal(rm.getTask(t.id)!.status, 'working');
  } finally {
    pm.savePmSettings({ maxConcurrent: before.maxConcurrent, maxStartsPerDay: before.maxStartsPerDay });
    fs.writeFileSync(agents, JSON.stringify({ maxConcurrent: 0 }));
    if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
  }
});

test('a failed try is not retried while another try of the task is going or merged', async () => {
  process.env.STUDIO_PM_TALK = 'off';
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test';
  pm.startPm();
  try {
    const it = rm.addItem({ product: 'pmsixth', title: 'Two tries', status: 'in progress', ord: -800 });
    const t = rm.addTask({ item: it.id, request: 'Something' });
    const old = Date.now() - 3600_000;
    const add = (id: string, status: string, at: number) => db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, updated, task)
      VALUES (?, 'pmsixth', '[]', ?, ?, 'pmsixth', 'x/pmsixth', 'task/z', 'beta', ?, 'Something', '[]', '[]', ?, ?, ?)`).run(id, status, status, path.join(tmp, 'none', id), at, at, t.id);
    // The other try is fresh (an old ready one would get the default review, which merges through GitHub).
    add('c_two00000001', 'ready', Date.now());
    add('c_two00000002', 'failed', old);
    // The task row still points at the failed one (a stale row): the ready one is the task now.
    rm.setTask(t.id, { status: 'working', change: 'c_two00000002', changes: ['c_two00000001', 'c_two00000002'], tries: 2 });
    for (const status of ['ready', 'needs answer', 'merged']) {
      db.prepare(`UPDATE changes SET status = ? WHERE id = 'c_two00000001'`).run(status);
      await pm.tick();
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE task = ?`).get(t.id) as any).n, 2, `no retry while the other try is ${status}`);
    }
  } finally {
    if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
  }
});

test('a bug is consumed when an agent takes it, and opens again if that attempt fails (so it does get done)', async () => {
  const { startFix, reopenTaken } = await import('../src/agents.ts');
  const { getFinding } = await import('../src/backlog.ts');
  const now = Date.now();
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen) VALUES ('f_c0a5e0000f01', 'pmthird', 'k4', 'Score never resets', 'bug', 'open', ?, ?)`).run(now, now);
  const id = startFix('pmthird', ['f_c0a5e0000f01']);
  // Consumed at once: fixed, with the change that took it.
  assert.equal(getFinding('f_c0a5e0000f01')!.status, 'fixed');
  assert.equal(getFinding('f_c0a5e0000f01')!.note, `agent change ${id}`);
  // The attempt fails (any way: a crash, a push refused, no commit): the bug goes back to open for another attempt.
  reopenTaken(id, ['f_c0a5e0000f01'], 'push failed');
  assert.equal(getFinding('f_c0a5e0000f01')!.status, 'open');
  assert.match(getFinding('f_c0a5e0000f01')!.note ?? '', /failed \(push failed\); open again/);
  // A bug some other change took is left alone.
  reopenTaken('c_000000000000', ['f_c0a5e0000f01'], 'x');
  assert.equal(getFinding('f_c0a5e0000f01')!.status, 'open');
});

test('a product with a change running queues the next one behind it; the queue starts one per product, oldest first', async () => {
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
  const { startTask, startFix, getChange, pickQueued } = await import('../src/agents.ts');
  const now = Date.now();
  db.prepare(`INSERT INTO changes (id, product, findings, status, title, created) VALUES ('c_0000000000q1', 'pmother', '[]', 'working', 'Running', ?)`).run(now);
  try {
    // J's request and a fix are never refused: queued, behind the running one.
    const t = startTask('pmother', 'Make the pause menu blue');
    assert.equal(getChange(t)!.status, 'queued');
    assert.match(getChange(t)!.detail!, /queued \(J asked\) behind c_0000000000q1/);
    db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen) VALUES ('f_0000000000q2', 'pmother', 'kq', 'The timer drifts', 'bug', 'open', ?, ?)`).run(now, now);
    const f = startFix('pmother', ['f_0000000000q2']);
    assert.equal(getChange(f)!.status, 'queued');
    assert.match(getChange(f)!.detail!, /^queued behind c_/);
  } finally {
    db.prepare(`UPDATE changes SET status = 'closed' WHERE product = 'pmother' AND status IN ('working', 'queued')`).run();
  }
  // The pick: a busy product waits, one per product per pass, oldest first, within the free slots.
  const q = [{ id: 'c_1', product: 'a' }, { id: 'c_2', product: 'a' }, { id: 'c_3', product: 'b' }, { id: 'c_4', product: 'c' }];
  assert.deepEqual(pickQueued(q, [], 5), ['c_1', 'c_3', 'c_4']);
  assert.deepEqual(pickQueued(q, ['a'], 5), ['c_3', 'c_4']);
  assert.deepEqual(pickQueued(q, ['b'], 2), ['c_1', 'c_4']);
  assert.deepEqual(pickQueued(q, [], 0), []);
  assert.deepEqual(pickQueued(q, [], -1), []);
});
