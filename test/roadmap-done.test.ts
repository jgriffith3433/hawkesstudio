// The roadmap runs itself to done, honestly reported (J, 2026-10-18: "road map says it's done even though it's still
// being worked on", "I have no idea if it even worked"). What J sees for an item comes from its tasks, never the stored
// "done" of a consumed item; a merged task records beta's build of it (a failed build goes back to an agent, the first
// time without a try); a milestone is reached only when every task is merged and built, after ONE beta playtest of its
// tasks' scenarios judged their criteria; a product with a change ready but not merged starts no new task. Scratch
// database, no agents, GitHub or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rmdone-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
const ids = ['rdslot', 'rdstatus', 'rdbuild', 'rdmile', 'rdunclear', 'rdbroken'];
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: Object.fromEntries(ids.map((id) => [id, `x/${id}`])),
  products: ids.map((id) => ({
    id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: id, port: 8794, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  })),
  infra: [],
}));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const { db, J } = await import('../src/db.ts');
await import('../src/agents.ts'); // the changes table

let n = 0;
const change = (product: string, task: string | null, status: string, extra: Record<string, any> = {}) => {
  const id = `c_d0e${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, verify, merged_at)
    VALUES (?, ?, '[]', ?, ?, ?, 'task/x', 'beta', ?, 'A change', '[]', '[]', ?, ?, ?, ?, ?)`)
    .run(id, product, status, product, `x/${product}`, path.join(tmp, 'none', id), Date.now(), Date.now(), task, J(extra.verify ?? {}), extra.merged_at ?? null);
  return id;
};
const run = (product: string, status: string, started: number, failedBuild?: string) => {
  const id = `r_d0e${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, 'beta', ?, ?, ?, ?, ?)`).run(id, status, `beta ${product}`, J([product]), started, started + 1000);
  if (failedBuild) db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, started) VALUES (?, ?, ?, 'build', 'unity', 'failed', ?, ?)`).run(`s_${id.slice(2)}`, id, product, failedBuild, started);
  return id;
};

test("an item's status comes from its tasks: never \"done\" while they're worked on", () => {
  const it = rm.addItem({ product: 'rdstatus', title: 'Into Hell', status: 'planned' });
  const a = rm.addTask({ item: it.id, request: 'Lava floor' });
  const b = rm.addTask({ item: it.id, request: 'Demon boss' });
  // Stored: consumed (done) for scheduling; shown: planned.
  assert.equal(rm.getItem(it.id)!.status, 'done');
  const view = () => rm.listItems({ product: 'rdstatus' }).find((x) => x.id === it.id)!.progress;
  assert.equal(view().label, 'planned');
  rm.setTask(a.id, { status: 'working', change: 'c_000000000a01' });
  assert.equal(view().label, 'working (0 of 2 merged)');
  rm.setTask(a.id, { status: 'merged', merged_at: Date.now() });
  assert.equal(view().label, 'working (1 of 2 merged)');
  assert.equal(view().tasks.find((t) => t.id === a.id)!.waits, "beta's build");
  assert.match(view().tasks.find((t) => t.id === b.id)!.waits!, /a free agent/);
  rm.setTask(a.id, { build: { ok: true, run: 'r_1', at: Date.now(), detail: 'built OK' } });
  rm.setTask(b.id, { status: 'merged', merged_at: Date.now() });
  assert.equal(view().label, 'working (2 of 2 merged)', 'merged but not built yet');
  rm.setTask(b.id, { build: { ok: true, run: 'r_1', at: Date.now(), detail: 'built OK' } });
  assert.equal(view().label, 'on beta');
  assert.deepEqual([view().total, view().merged, view().built], [2, 2, 2]);
  rm.setTask(a.id, { status: 'verified' });
  rm.setTask(b.id, { status: 'verified' });
  assert.equal(view().label, 'verified');
  rm.setTask(a.id, { status: 'live' });
  rm.setTask(b.id, { status: 'live' });
  assert.equal(view().label, 'live');
  // A task that failed after its tries, or a question waiting on J: needs you.
  const it2 = rm.addItem({ product: 'rdstatus', title: 'Second', status: 'planned' });
  const c = rm.addTask({ item: it2.id, request: 'Something' });
  rm.setTask(c.id, { status: 'failed' });
  assert.equal(rm.getItemView(it2.id)!.progress.label, 'needs you');
  rm.setTask(c.id, { status: 'working' });
  assert.match(rm.getItemView(it2.id)!.progress.label, /^working/);
  rm.addQuestion({ kind: 'decision', subject: c.id, text: 'Which boss?' });
  rm.setQuestion(rm.listQuestions().find((q) => q.subject === c.id)!.id, { status: 'asked J' });
  assert.equal(rm.getItemView(it2.id)!.progress.label, 'needs you');
  // A task waiting for a GPU budget.
  const it3 = rm.addItem({ product: 'rdstatus', title: 'Art', status: 'planned' });
  const g = rm.addTask({ item: it3.id, request: 'Paint the sky', gpu: [{ tool: 'image', count: 4 }] });
  db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(J({ items: [{ tool: 'image', count: 4 }], estimate: { gpuHours: 1, cost: 2, withIdleTail: 3, servers: 1, wallMinutes: 30, at: Date.now() } }), g.id);
  assert.equal(rm.getItemView(it3.id)!.progress.label, 'waiting for your GPU budget');
  assert.equal(rm.getItemView(it3.id)!.progress.tasks[0].waits, 'your GPU budget');
  // An item J marked done himself (not consumed) stays done.
  const it4 = rm.addItem({ product: 'rdstatus', title: 'By hand', status: 'idea' });
  rm.updateItem(it4.id, { status: 'done' });
  assert.equal(rm.getItemView(it4.id)!.progress.label, 'done');
});

test('a milestone counts an item only once every task is merged and beta built it', () => {
  const it = rm.addItem({ product: 'rdstatus', title: 'Pit', status: 'planned' });
  const ms = rm.addMilestone({ product: 'rdstatus', title: 'Hell done', items: [it.id] });
  const t = rm.addTask({ item: it.id, request: 'Pit' });
  rm.setTask(t.id, { status: 'merged', merged_at: Date.now() });
  assert.equal(rm.milestoneProgress(ms.id).done, 0, 'merged, not built');
  assert.equal(rm.milestoneProgress(ms.id).items[0].display, 'working (1 of 1 merged)');
  assert.ok(!rm.milestonesToReach().some((m) => m.id === ms.id));
  rm.setTask(t.id, { build: { ok: false, run: 'r_2', at: Date.now(), detail: "beta's build failed" } });
  assert.equal(rm.milestoneProgress(ms.id).done, 0, 'a failed build is not on beta');
  rm.setTask(t.id, { build: { ok: true, run: 'r_3', at: Date.now(), detail: 'built OK' } });
  assert.equal(rm.milestoneProgress(ms.id).done, 1);
  assert.deepEqual(rm.milestoneProgress(ms.id).tasks, { total: 1, merged: 1, built: 1, working: 0, waiting: 0 });
  assert.ok(rm.milestonesToReach().some((m) => m.id === ms.id));
  rm.updateMilestone(ms.id, { status: 'dropped' });
});

test("beta's build after a merge is recorded on the task; a failed one sends it back, the first time not as a try", async () => {
  const s = pm.pmSettings();
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test';
  try {
    const it = rm.addItem({ product: 'rdbuild', title: 'Shop', status: 'planned' });
    const t = rm.addTask({ item: it.id, request: 'Add the shop' });
    const merged = Date.now() - 60_000;
    const c1 = change('rdbuild', t.id, 'merged', { merged_at: merged });
    rm.setTask(t.id, { status: 'merged', change: c1, changes: [c1], tries: 1, merged_at: merged + 2000 });
    // A beta run from before the merge doesn't count; one after it that built is the task's.
    run('rdbuild', 'done', merged - 10_000);
    const ok = run('rdbuild', 'done', merged + 1000);
    await pm.followBuilds();
    assert.equal(rm.getTask(t.id)!.build?.ok, true);
    assert.equal(rm.getTask(t.id)!.build?.run, ok);
    assert.match(rm.getTask(t.id)!.build!.detail, /built OK/);
    assert.equal(rm.getItemView(it.id)!.progress.label, 'on beta');
    // A newer beta run's build fails: the task goes back to an agent with the log, its try given.
    const bad = run('rdbuild', 'failed', merged + 5000, 'Assets/Shop.cs(12,5): error CS1002: ; expected');
    await pm.followBuilds();
    const after = rm.getTask(t.id)!;
    assert.equal(after.status, 'working', 'sent back');
    assert.equal(after.tries, 1, 'the first build failure is not a try');
    assert.notEqual(after.change, c1);
    const req = (db.prepare('SELECT request FROM changes WHERE id = ?').get(after.change) as any).request as string;
    assert.match(req, /Beta's build failed after your change/);
    assert.match(req, /error CS1002/);
    assert.ok(rm.listDecisions({ action: 'build-failed' }).some((d) => d.subject === bad));
    // The same failed run isn't acted on twice.
    await pm.followBuilds();
    assert.equal(rm.listDecisions({ action: 'build-sendback' }).filter((d) => d.subject === t.id).length, 1);
    // That fix merges and breaks the build again: this time it's a try.
    const merged2 = Date.now();
    db.prepare(`UPDATE changes SET status = 'merged', merged_at = ? WHERE id = ?`).run(merged2, after.change);
    rm.setTask(t.id, { status: 'merged', merged_at: merged2 });
    run('rdbuild', 'failed', merged2 + 1000, 'still broken');
    await pm.followBuilds();
    assert.equal(rm.getTask(t.id)!.tries, 2, 'a second build failure counts');
  } finally {
    if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
    pm.savePmSettings({ enabled: s.enabled });
  }
});

test("a product's slot is held by a change that is ready but not merged: no new task starts there", async () => {
  const token = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test';
  pm.startPm();
  const before = pm.pmSettings();
  try {
    pm.savePmSettings({ maxConcurrent: pm.capacity().active + 5, maxStartsPerDay: 1000 });
    const it = rm.addItem({ product: 'rdslot', title: 'Slots', status: 'planned', ord: -1000 });
    const a = rm.addTask({ item: it.id, request: 'First' });
    const b = rm.addTask({ item: it.id, request: 'Second' });
    const ca = change('rdslot', a.id, 'ready');
    rm.setTask(a.id, { status: 'review', change: ca, changes: [ca], tries: 1 });
    assert.ok(await pm.slotHeld('rdslot'));
    await pm.startWork();
    assert.equal(rm.getTask(b.id)!.status, 'planned', 'waits while the first is ready but unmerged');
    // Being revised (a revision or a conflict pass) holds it too.
    db.prepare(`UPDATE changes SET status = 'revising' WHERE id = ?`).run(ca);
    await pm.startWork();
    assert.equal(rm.getTask(b.id)!.status, 'planned', 'waits while the first is revised');
    db.prepare(`UPDATE changes SET status = 'merged' WHERE id = ?`).run(ca);
    assert.ok(!(await pm.slotHeld('rdslot')));
    await pm.startWork();
    assert.equal(rm.getTask(b.id)!.status, 'working', 'starts once it merged');
  } finally {
    pm.savePmSettings({ maxConcurrent: before.maxConcurrent, maxStartsPerDay: before.maxStartsPerDay });
    db.prepare(`UPDATE changes SET status = 'closed' WHERE product = 'rdslot' AND status != 'merged'`).run();
    if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
  }
});

test("a milestone with every task merged and built gets ONE beta playtest of its tasks' scenarios; reached once it judged them", async () => {
  const it = rm.addItem({ product: 'rdmile', title: 'Ring one', status: 'planned' });
  const it2 = rm.addItem({ product: 'rdmile', title: 'Ring two', status: 'planned' });
  const ms = rm.addMilestone({ product: 'rdmile', title: 'Into Hell', items: [it.id, it2.id] });
  const merged = Date.now() - 60_000;
  const tasks = [
    { item: it.id, crit: ['the lava glows'], scenario: 'lava' },
    { item: it2.id, crit: ['the boss roars'], scenario: 'boss' },
    { item: it2.id, crit: ['the gate opens'], scenario: 'boss' },
  ].map((x) => {
    const t = rm.addTask({ item: x.item, request: x.crit[0], criteria: x.crit });
    const c = change('rdmile', t.id, 'merged', { merged_at: merged, verify: { scenario: x.scenario } });
    rm.setTask(t.id, { status: 'merged', change: c, changes: [c], tries: 1, merged_at: merged, build: { ok: true, run: 'r_x', at: Date.now(), detail: 'built OK' } });
    return t;
  });
  assert.ok(rm.milestonesToReach().some((m) => m.id === ms.id));
  await pm.milestoneCheck(ms.id);
  const checks = JSON.parse(rm.getMilestone(ms.id)!.checks!);
  assert.equal(checks.length, 1, 'one beta run for the product');
  const opts = JSON.parse((db.prepare('SELECT options FROM runs WHERE id = ?').get(checks[0]) as any).options);
  assert.equal(opts.playtest, true);
  assert.deepEqual(opts.plays.map((p: any) => [p.scenario, p.criteria]), [['lava', ['the lava glows']], ['boss', ['the boss roars', 'the gate opens']]], 'one play per scenario, with its tasks\' criteria');
  assert.equal(rm.getMilestone(ms.id)!.status, 'open', 'not reached while it plays');
  // Another pass while it plays starts nothing more.
  db.prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(checks[0]);
  await pm.milestoneCheck(ms.id);
  assert.equal(JSON.parse(rm.getMilestone(ms.id)!.checks!).length, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE products LIKE '%"rdmile"%'`).get() as any).n, 1);
  // Its reviews judged the criteria; the run is over.
  const review = (id: string, results: any[]) => db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, 'rdmile', 'review', ?, 'done', ?, ?)`).run(id, checks[0], id, J({ verdict: 'ship', criteria: results }), Date.now());
  review('s_rdmile000001', [{ criterion: 'the lava glows', met: 'yes', evidence: 'orange floor at 4 s' }]);
  review('s_rdmile000002', [{ criterion: 'the boss roars', met: 'yes', evidence: 'roar at 9 s' }, { criterion: 'the gate opens', met: 'yes', evidence: 'gate at 20 s' }]);
  db.prepare(`UPDATE runs SET status = 'done', finished = ? WHERE id = ?`).run(Date.now(), checks[0]);
  await pm.milestoneCheck(ms.id);
  assert.equal(rm.getMilestone(ms.id)!.status, 'reached');
  for (const t of tasks) assert.equal(rm.getTask(t.id)!.status, 'verified', `${t.title} judged on beta`);
  const ready = pm.readyReport({ milestone: ms.id });
  assert.deepEqual(ready.flatMap((r) => r.criteria.map((c) => c.met)), ['yes', 'yes', 'yes']);
  assert.ok(rm.listDecisions({ action: 'milestone' }).some((d) => d.subject === ms.id), 'J was told');
  const { inbox } = await import('../src/inbox.ts');
  const card = (await inbox()).find((x) => x.id === `milestone:${ms.id}`);
  assert.ok(card, 'every criterion met: the card is in his Inbox');
  assert.match(card!.title, /^Milestone reached/);
});

/** A milestone of one product with one merged, built task per criteria list, its check started; returns the check run. */
async function checkedMilestone(product: string, crits: string[][]) {
  const it = rm.addItem({ product, title: `${product} ring`, status: 'planned' });
  const ms = rm.addMilestone({ product, title: `${product} milestone`, items: [it.id] });
  const merged = Date.now() - 60_000;
  const tasks = crits.map((crit) => {
    const t = rm.addTask({ item: it.id, request: crit[0], criteria: crit });
    const c = change(product, t.id, 'merged', { merged_at: merged, verify: { scenario: 'smoke' } });
    rm.setTask(t.id, { status: 'merged', change: c, changes: [c], tries: 1, merged_at: merged, build: { ok: true, run: 'r_x', at: Date.now(), detail: 'built OK' } });
    return t;
  });
  await pm.milestoneCheck(ms.id);
  const checks = JSON.parse(rm.getMilestone(ms.id)!.checks!);
  assert.equal(checks.length, 1);
  return { ms, tasks, run: checks[0] as string };
}
const step = (run: string, product: string, kind: string, status: string, data: any = {}, detail: string | null = null) =>
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`s_d0e${String(++n).padStart(9, '0')}`, run, product, kind, kind, status, detail, J(data), Date.now());
const finish = (run: string) => db.prepare(`UPDATE runs SET status = 'done', finished = ? WHERE id = ?`).run(Date.now(), run);
const milestoneCard = async (id: string) => (await (await import('../src/inbox.ts')).inbox()).find((x) => x.id === `milestone:${id}`);

test("a milestone check with criteria unclear tells J nothing: it's checked again after beta's next build, and only after its tries is there one card saying what's left", async () => {
  const before = pm.pmSettings();
  try {
    const { ms, tasks, run: r1 } = await checkedMilestone('rdunclear', [['the gate opens'], ['the boss roars']]);
    step(r1, 'rdunclear', 'playtest', 'done', {}, 'passed in 60 s · 0 problems');
    step(r1, 'rdunclear', 'review', 'done', { verdict: 'ship', criteria: [{ criterion: 'the gate opens', met: 'yes', evidence: 'at 4 s' }, { criterion: 'the boss roars', met: 'unclear', evidence: 'never reached the boss' }] });
    finish(r1);
    await pm.milestoneCheck(ms.id);
    assert.equal(rm.getMilestone(ms.id)!.status, 'open', 'not reached with a criterion unclear');
    assert.ok(!rm.listDecisions({ action: 'milestone' }).some((d) => d.subject === ms.id), 'J was not told');
    assert.equal(await milestoneCard(ms.id), undefined, 'no card in his Inbox');
    assert.equal(rm.getTask(tasks[0].id)!.status, 'verified');
    assert.equal(rm.getTask(tasks[1].id)!.status, 'merged', 'unclear: not restarted (a merged task is never redone for an unclear)');
    assert.ok(rm.listDecisions({ action: 'milestone-recheck' }).some((d) => d.subject === ms.id), 'a re-check is queued');
    // It waits for beta's next build of the product.
    await pm.milestoneCheck(ms.id);
    assert.deepEqual(JSON.parse(rm.getMilestone(ms.id)!.checks!), [], 'nothing played before beta built again');
    run('rdunclear', 'done', Date.now() + 1);
    await pm.milestoneCheck(ms.id);
    const r2 = JSON.parse(rm.getMilestone(ms.id)!.checks!)[0];
    assert.ok(r2 && r2 !== r1, 'checked again after the build');
    const opts = JSON.parse((db.prepare('SELECT options FROM runs WHERE id = ?').get(r2) as any).options);
    assert.deepEqual(opts.plays.flatMap((p: any) => p.criteria), ['the boss roars'], 'only what is still unverified is played');
    // Still unclear, and out of tries: ONE card saying what's left.
    pm.savePmSettings({ maxTries: 1 });
    step(r2, 'rdunclear', 'playtest', 'done', {}, 'passed in 60 s · 0 problems');
    step(r2, 'rdunclear', 'review', 'done', { verdict: 'ship', criteria: [{ criterion: 'the boss roars', met: 'unclear', evidence: 'still never reached' }] });
    finish(r2);
    await pm.milestoneCheck(ms.id);
    assert.equal(rm.getMilestone(ms.id)!.status, 'reached');
    const told = rm.listDecisions({ action: 'milestone' }).find((d) => d.subject === ms.id)!;
    assert.match(told.detail!, /misses left after its tries.*the boss roars/);
    const card = await milestoneCard(ms.id);
    assert.match(card!.title, /1 criteria still not met on beta after its tries/);
    assert.match(card!.text!, /the boss roars \(unclear: still never reached\)/);
  } finally {
    pm.savePmSettings({ maxTries: before.maxTries });
  }
});

test('a milestone check that broke (a missing scenario, stuck, beta not built) is played again, never counted as missed', async () => {
  const { ms, tasks, run: r1 } = await checkedMilestone('rdbroken', [['the lava glows']]);
  step(r1, 'rdbroken', 'playtest', 'skipped', { missingScenario: 'lava' }, 'skipped: beta abc1234 has no scenario "lava". It has: smoke');
  // A review from a broken run judges nothing either.
  step(r1, 'rdbroken', 'review', 'done', { verdict: 'broken', criteria: [{ criterion: 'the lava glows', met: 'no', evidence: 'never got there' }] });
  finish(r1);
  assert.match(pm.brokenCheck(r1)!, /no scenario "lava"/);
  await pm.milestoneCheck(ms.id);
  assert.equal(rm.getMilestone(ms.id)!.status, 'open');
  assert.equal(rm.getTask(tasks[0].id)!.status, 'merged', 'not judged from the broken run');
  assert.ok(rm.listDecisions({ action: 'milestone-rerun' }).some((d) => d.subject === ms.id));
  // Played again at once (no wait for a build).
  await pm.milestoneCheck(ms.id);
  const r2 = JSON.parse(rm.getMilestone(ms.id)!.checks!)[0];
  assert.ok(r2 && r2 !== r1, 're-run');
  // A playtest stuck at one spot is broken too; so is a run still going.
  step(r2, 'rdbroken', 'playtest', 'failed', {}, 'failed: the bot is stuck at one spot');
  assert.match(pm.brokenCheck(r2)!, /still running|stuck/);
  finish(r2);
  assert.match(pm.brokenCheck(r2)!, /stuck at one spot/);
  assert.equal(await milestoneCard(ms.id), undefined);
});
