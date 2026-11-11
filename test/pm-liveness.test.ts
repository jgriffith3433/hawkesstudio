// Roadmap liveness (J, 2026-11-03: "work that's in the roadmap is ALWAYS being worked on"): an item with no tasks gets
// them, a failed or idea dependency is planned again twice before J is asked, Studio's own failures are not tries and are
// retried, the watchdog repairs and logs, and no item reads as a bare "planned". Scratch database, no agents.
// (Template: roadmap-stuck.test.ts: The roadmap and backlog run to done with nothing but J adding items and bugs (J, 2026-10-19: "It should function
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
process.env.STUDIO_TASK_BAR = 'off'; // these tests start tasks written in a line (the task bar has its own: taskbar.test.ts)
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.TALK_CLAUDE = 'no-such-claude-here';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
const ids = ['lvempty', 'lvchain', 'lvinfra', 'lvdog'];
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
/** pm.tick() once the loop's own pass (1 s after startPm) is done: a tick meanwhile does nothing, and a slow CI machine got there. */
const tick = async () => { while (pm.pmTicking()) await new Promise((r) => setTimeout(r, 20)); await pm.tick(); };
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


const decisions = (action: string, subject: string) => rm.listDecisions({ action, limit: 50 }).filter((d) => d.subject === subject);

test('an item with no tasks gets a task from its goal and criteria (and a visible next step meanwhile)', () => {
  const it = rm.addItem({ product: 'lvempty', title: 'Roll the boulder', goal: 'A boulder rolls down the ramp.', criteria: ['The boulder rolls', 'It stops at the wall'], status: 'planned' });
  assert.match(view('lvempty', it.id).next!, /planned from the goal and criteria \(Studio acts/);
  assert.notEqual(view('lvempty', it.id).next, 'planned');
  assert.deepEqual(pm.planEmptyItems(Date.now()), [], 'just made: Talk may be adding its tasks');
  assert.deepEqual(pm.planEmptyItems(Date.now() + 120_000), [it.id]);
  const tasks = rm.tasksOf(it.id);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].criteria, ['The boulder rolls', 'It stops at the wall']);
  assert.match(tasks[0].request, /A boulder rolls down the ramp/);
  assert.equal(decisions('plan', tasks[0].id).length, 1);
  assert.deepEqual(pm.planEmptyItems(Date.now() + 240_000), [], 'not again');
});

test('merged changes that name an item are evidence in its task', () => {
  const it = rm.addItem({ product: 'lvempty', title: 'Already built', goal: 'Thing', criteria: ['Works'], status: 'planned' });
  const c = change('lvempty', { status: 'merged' });
  db.prepare(`UPDATE changes SET request = ?, title = 'Built it' WHERE id = ?`).run(`Do ${it.id}`, c);
  pm.planEmptyItems(Date.now() + 120_000);
  assert.match(rm.tasksOf(it.id)[0].request, new RegExp(`Evidence: ${c}`));
});

test('a failed dependency is planned again twice (one tier up), then J is asked; an idea dependency is planned', async () => {
  const it = rm.addItem({ product: 'lvchain', title: 'Chain', status: 'planned' });
  const a = rm.addTask({ item: it.id, request: 'First' });
  const b = rm.addTask({ item: it.id, request: 'Second', depends: [a.id] });
  const c = rm.addTask({ item: it.id, request: 'Third', depends: [b.id] });
  const max = pm.pmSettings().maxTries;
  rm.setTask(a.id, { status: 'failed', tries: max, note: 'tests kept failing' });
  assert.match(view('lvchain', it.id).next!, /Studio planning it again.*\(Studio acts\)/);
  assert.deepEqual(pm.unblockDependencies(), [a.id]);
  assert.equal(rm.getTask(a.id)!.status, 'planned');
  assert.equal(rm.getTask(a.id)!.tries, max - 1, 'one more try, on the route the next attempt number gives');
  assert.equal(decisions('replan', a.id).length, 1);
  rm.setTask(a.id, { status: 'failed', tries: max });
  assert.deepEqual(pm.unblockDependencies(), [a.id]);
  rm.setTask(a.id, { status: 'failed', tries: max });
  assert.deepEqual(pm.unblockDependencies(), [], 'two automatic re-plans used');
  assert.equal(rm.getTask(a.id)!.status, 'failed');
  assert.ok((await pm.sweepFailed()).includes(a.id), 'only now the old path: a rescue scout (walk-away) or a question for J');
  assert.equal(decisions('replan', a.id).length, 2);
  assert.equal(rm.getTask(a.id)!.status, 'failed');
  // The idea at the end of the chain: b is an idea, c waits on it.
  rm.setTask(a.id, { status: 'merged' });
  rm.setTask(b.id, { status: 'idea', note: 'nobody planned this' });
  assert.deepEqual(pm.unblockDependencies(), [b.id]);
  assert.equal(rm.getTask(b.id)!.status, 'planned');
  assert.equal(rm.getTask(c.id)!.status, 'planned');
});

test('Studio-side failures are not tries and are retried after a back-off, without a dependent', () => {
  const it = rm.addItem({ product: 'lvinfra', title: 'Infra', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Unity thing' });
  const at = Date.now() - 3600_000;
  const c = change('lvinfra', { task: t.id, status: 'failed', detail: 'the agent made no commit', created: at });
  db.prepare(`UPDATE changes SET phase = ? WHERE id = ?`).run('{"failed":true}', c);
  rm.setTask(t.id, { status: 'failed', tries: 3, note: 'Studio failed' });
  const cur = rm.getTask(t.id)!;
  assert.equal(pm.retryStudioFailure(cur, Date.now() - 3600_000 + 60_000 + 0), false, 'inside the back-off');
  assert.equal(pm.retryStudioFailure(rm.getTask(t.id)!, Date.now()), true);
  const after = rm.getTask(t.id)!;
  assert.equal(after.status, 'planned');
  assert.equal(after.tries, 0, 'Studio failures are not tries');
  assert.equal(decisions('replan', t.id).length, 1);
});

test('the watchdog plans empty items, repairs and logs what sat for 30 minutes, and leaves waits on J alone', () => {
  const empty = rm.addItem({ product: 'lvdog', title: 'Empty', goal: 'g', status: 'planned' });
  const it = rm.addItem({ product: 'lvdog', title: 'Stuck', status: 'planned' });
  const dep = rm.addTask({ item: it.id, request: 'Dep' });
  const t = rm.addTask({ item: it.id, request: 'After', depends: [dep.id] });
  rm.setTask(dep.id, { status: 'failed', tries: 3, note: 'broke' });
  db.prepare('UPDATE tasks SET updated = ?, created = ? WHERE item = ?').run(Date.now() - 3 * 3600_000, Date.now() - 3 * 3600_000, it.id);
  const now = Date.now() + 120_000;
  const did = pm.livenessWatch(now);
  assert.ok(did.some((m) => m.includes(empty.id)), did.join('|'));
  assert.equal(rm.tasksOf(empty.id).length, 1);
  assert.equal(rm.getTask(dep.id)!.status, 'planned', 'the failed dependency was planned again');
  assert.ok(rm.listDecisions({ action: 'liveness', limit: 20 }).length >= 1);
  assert.equal(rm.getTask(t.id)!.status, 'planned');
  // The remaining wait is on a dependency that moves: said plainly.
  assert.match(view('lvdog', it.id).next!, /^waiting on|^working/);
});
