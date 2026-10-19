// The PM loop keeps the roadmap moving until it's done (J, 2026-10-19: "so it keeps working on items that are in the
// road map until it's done"). Tonight's stalls, each one here: a build blocker in another repo (the PM files that
// change, the blocked tasks wait on it, beta builds again after it merges), tasks failed after their tries (walk-away:
// a scout's diagnosis, then a fresh round; then J, always in his Inbox), stale task statuses (reconciled from their
// changes, also right after a restart), "already done" loops (checked, merged, no try), and the stall watch (why per
// task, one "stall" decision, broken builds nobody is fixing sent back). Scratch database, no GitHub, agents or Claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-moving-'));
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
const ids = ['mvyooba', 'mvsick', 'mvmisc', 'mvstall'];
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: Object.fromEntries(ids.map((id) => [id, `x/${id}`])),
  products: ids.map((id) => ({
    id, name: id === 'mvyooba' ? 'Yooba Test' : id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: id, port: 8793, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  })),
  infra: [{ id: 'hawkesgen', name: 'Hawkes Gen', repo: 'hawkesgen', slug: 'x/hawkesgen' }, { id: 'hawkesstudio', name: 'Hawkes Studio', repo: 'hawkesstudio', slug: 'x/hawkesstudio' }],
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
pm.startPm();
// The first pass after a start runs a second in: let it pass, so each test's tick isn't skipped by one running.
await new Promise((r) => setTimeout(r, 1800));

const old = Date.now() - 3 * 3600_000;
/** A change row as the agents leave it. */
const add = (id: string, product: string, task: string | null, status: string, o: { detail?: string; summary?: string; created?: number; request?: string; commits?: string[]; merged_at?: number | null; base?: string } = {}) =>
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, summary, repo, slug, branch, base, worktree, title, request, notes, log, commits, created, updated, task, merged_at)
    VALUES (?, ?, '[]', ?, ?, ?, ?, ?, 'task/z', ?, ?, 'Something', ?, '[]', '[]', ?, ?, ?, ?, ?)`)
    .run(id, product, status, o.detail ?? status, o.summary ?? '', product, `x/${product}`, o.base ?? 'beta', path.join(tmp, 'none', id), o.request ?? 'Something', J(o.commits ?? []), o.created ?? old, o.created ?? old, task, o.merged_at ?? null);
const changesOf = (task: string) => db.prepare(`SELECT id, status, request FROM changes WHERE task = ? ORDER BY created, rowid`).all(task) as any[];
const decisions = (action: string, subject: string) => rm.listDecisions({ action, limit: 10_000 }).filter((d) => d.subject === subject);
const questionsOn = (subject: string) => db.prepare(`SELECT * FROM questions WHERE subject = ?`).all(subject) as any[];

const GEN_WORDS = "The build fails in Hawkes Gen's package clients/unity/com.hawkes.analytics (CS0246 in HawkesAnalytics.cs), not in Yooba Land. The broken file is in Hawkes Gen; PM: please start a Gen change. I made no commit.";

test('an agent naming a fix in another repo: the words are read', () => {
  assert.equal(pm.crossRepoFix(GEN_WORDS, 'mvyooba'), 'hawkesgen');
  assert.equal(pm.crossRepoFix('This needs a Hawkes Studio change: the brief drops the scenario.', 'mvsick'), 'hawkesstudio');
  assert.equal(pm.crossRepoFix(GEN_WORDS, 'hawkesgen'), null, 'its own repo is not another');
  assert.equal(pm.crossRepoFix('Fixed the null check in Assets/Scripts/Shop.cs and ran the validators.', 'mvyooba'), null);
  assert.equal(pm.crossRepoFix('', 'mvyooba'), null);
});

test('a build blocker in another repo: the PM starts that change, the blocked tasks wait on it, beta builds again after it merges', async () => {
  const it = rm.addItem({ product: 'mvyooba', title: 'Analytics', status: 'planned' });
  const failedBuild = { ok: false, run: 'r_mv0000000001', at: old, detail: "beta's build failed (run r_mv0000000001): build Unity: CS0246" };
  const a = rm.addTask({ item: it.id, request: 'Send events', title: 'Send events' });
  const b = rm.addTask({ item: it.id, request: 'Show the level', title: 'Show the level' });
  add('c_b10c00000001', 'mvyooba', a.id, 'merged', { merged_at: old - 3600_000, created: old - 7200_000 });
  add('c_b10c00000002', 'mvyooba', b.id, 'merged', { merged_at: old - 3600_000, created: old - 7200_000 });
  // The send-back for beta's build: its agent found the cause in Gen and made no commit.
  add('c_b10c00000003', 'mvyooba', a.id, 'failed', { detail: 'the agent made no commit', summary: GEN_WORDS, request: "Send events\n\nFrom the PM (an earlier attempt): Beta's build failed after your change c_b10c00000001 merged into beta: CS0246" });
  rm.setTask(a.id, { status: 'working', change: 'c_b10c00000003', changes: ['c_b10c00000001', 'c_b10c00000003'], tries: 2 });
  rm.setTask(b.id, { status: 'merged', change: 'c_b10c00000002', changes: ['c_b10c00000002'], tries: 1, merged_at: old, build: failedBuild });
  await tick();
  const blockers = (await pm.pmStatus()).blockers;
  const [fix, bl] = Object.entries(blockers).find(([, x]) => x.product === 'mvyooba')!;
  const k = rm.getTask(fix)!;
  assert.equal(k.product, 'hawkesgen', 'the change is filed in Gen');
  assert.equal(k.effective_priority, 'high');
  assert.match(k.request, /com\.hawkes\.analytics/, "with the agent's words");
  assert.equal(bl.target, 'hawkesgen');
  const ta = rm.getTask(a.id)!;
  assert.equal(ta.status, 'merged', 'its work is on beta: merged, waiting for the fix');
  assert.ok(ta.depends.includes(fix), 'it waits on the fix');
  assert.equal(ta.tries, 1, 'not counted as a try');
  assert.ok(rm.getTask(b.id)!.depends.includes(fix), 'the other task waiting for the build waits on it too');
  assert.ok(decisions('blocker', fix).length, 'logged');
  // Not "nothing more sent back" with nobody on it: the stall reasons name the fix under way.
  assert.ok(pm.stallReasons().some((r) => r.task === b.id && /broken build.*Hawkes Gen/.test(r.why)));
  // The fix starts in the next pass (high priority, Gen has its own slot).
  assert.ok(changesOf(fix).length >= 1, 'the Gen change is started');
  // It merges into main: Yooba Test's beta is built again, once.
  db.prepare(`UPDATE changes SET status = 'merged', merged_at = ? WHERE task = ?`).run(Date.now(), fix);
  rm.setTask(fix, { status: 'merged', merged_at: Date.now() });
  await tick();
  assert.ok(!(await pm.pmStatus()).blockers[fix], 'released');
  const built = decisions('beta-build', fix);
  assert.equal(built.length, 1, 'beta built again');
  assert.ok(db.prepare(`SELECT 1 FROM runs WHERE kind = 'beta' AND products LIKE '%"mvyooba"%' AND options LIKE '%Hawkes Gen%'`).get());
  await tick();
  assert.equal(decisions('beta-build', fix).length, 1, 'once');
});

test('failed after its tries (walk-away): a scout investigates, a fresh round with its diagnosis, then J in his Inbox', async () => {
  const scouted: string[] = [];
  pm.rescueDeps.scout = async (_p, _q, brief) => { scouted.push(brief); return 'x_5c0070000001'; };
  pm.rescueDeps.report = async () => ({ status: 'done', report: 'Level 3 never loads its spawn table: Levels/level3.json is missing from the index. Add it there.', detail: 'reported' }) as any;
  const it = rm.addItem({ product: 'mvsick', title: 'Level 3', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Make level 3 spawn enemies', title: 'Level 3 spawns', criteria: ['Enemies spawn in level 3'] });
  add('c_5c0070000001', 'mvsick', t.id, 'failed', { detail: 'the agent made no commit', summary: 'I could not find where spawns are read.' });
  rm.setTask(t.id, { status: 'working', change: 'c_5c0070000001', changes: ['c_5c0070000001'], tries: pm.pmSettings().maxTries });
  await tick();
  assert.equal(rm.getTask(t.id)!.status, 'failed');
  assert.ok(decisions('rescue', t.id).length, 'an investigation, decided by the PM');
  assert.equal(questionsOn(t.id).length, 0, 'J is not asked yet');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(scouted[0] ?? '', /c_5c0070000001[\s\S]*could not find where spawns are read/, 'the scout reads the attempts');
  // The scout reported: a fresh round of tries, its diagnosis in the brief.
  await tick();
  assert.ok(decisions('rescue-retry', t.id).length);
  const fresh = changesOf(t.id).at(-1);
  assert.notEqual(fresh.id, 'c_5c0070000001', 'a fresh attempt started');
  assert.match(fresh.request, /spawn table/, "with the scout's diagnosis");
  assert.equal(rm.getTask(t.id)!.tries, 1, 'a new round of tries');
  // That round fails too: now J, in his Inbox (asked J), not a silent "needs you".
  db.prepare(`UPDATE changes SET status = 'failed', detail = 'the agent made no commit', updated = ?, created = ? WHERE id = ?`).run(old, old + 1000, fresh.id);
  rm.setTask(t.id, { tries: pm.pmSettings().maxTries });
  await tick();
  assert.equal(rm.getTask(t.id)!.status, 'failed');
  assert.ok(questionsOn(t.id).some((q) => q.status === 'asked J'), 'filed in his Inbox');
  assert.equal(decisions('rescue', t.id).length, 1, 'one rescue per task');
});

test('a task whose change the PM closed is tried again, not left failed; a failed task nobody was asked about is asked', async () => {
  const it = rm.addItem({ product: 'mvmisc', title: 'Closed', status: 'planned' });
  const u = rm.addTask({ item: it.id, request: 'Add the credits page', title: 'Credits' });
  add('c_c105ed000001', 'mvmisc', u.id, 'closed', { detail: 'closed by Talk (PM)' });
  rm.setTask(u.id, { status: 'working', change: 'c_c105ed000001', changes: ['c_c105ed000001'], tries: 1 });
  await tick();
  assert.ok(decisions('retry', u.id).length, 'planned again');
  assert.notEqual(rm.getTask(u.id)!.status, 'failed');
  // Walk-away off: a failed task with no question gets one (never a silent "failed, needs you").
  const before = pm.pmSettings().walkAway;
  pm.savePmSettings({ walkAway: false });
  try {
    const v = rm.addTask({ item: it.id, request: 'Add the about page', title: 'About' });
    add('c_c105ed000002', 'mvmisc', v.id, 'failed', { detail: 'push refused' });
    rm.setTask(v.id, { status: 'failed', change: 'c_c105ed000002', changes: ['c_c105ed000002'], tries: 3, note: 'push refused' });
    await pm.sweepFailed();
    assert.ok(questionsOn(v.id).some((q) => q.status === 'asked J'));
    // He answers "try again" and nothing acts on it: planned again from scratch.
    const q = questionsOn(v.id)[0];
    rm.setQuestion(q.id, { status: 'answered', answer: 'try again', answered_by: 'J' });
    db.prepare('UPDATE questions SET answered_at = ? WHERE id = ?').run(Date.now() - 3600_000, q.id);
    await pm.sweepFailed();
    assert.equal(rm.getTask(v.id)!.status, 'planned');
    assert.equal(rm.getTask(v.id)!.tries, 0);
  } finally {
    pm.savePmSettings({ walkAway: before });
  }
});

test('stale statuses: the latest merged change wins, "working" with nothing running is retried, never started is planned', async () => {
  const it = rm.addItem({ product: 'mvmisc', title: 'Stale', status: 'planned' });
  // Failed, though a later change merged (k_4ebfdc669a1a).
  const w = rm.addTask({ item: it.id, request: 'Footer', title: 'Footer' });
  add('c_57a1e0000001', 'mvmisc', w.id, 'failed', { created: old - 7200_000 });
  add('c_57a1e0000002', 'mvmisc', w.id, 'merged', { merged_at: old, created: old - 3600_000 });
  rm.setTask(w.id, { status: 'failed', change: 'c_57a1e0000001', changes: ['c_57a1e0000001'], tries: 3, note: 'failed 3 times' });
  // "working" with its last change ended "no commit", behind an earlier merged one (k_ce4f50a97ff8).
  const x = rm.addTask({ item: it.id, request: 'Header', title: 'Header' });
  add('c_57a1e0000003', 'mvmisc', x.id, 'merged', { merged_at: old - 3600_000, created: old - 7200_000 });
  add('c_57a1e0000004', 'mvmisc', x.id, 'failed', { detail: 'the agent made no commit', summary: 'I ran out of time.' });
  rm.setTask(x.id, { status: 'working', change: 'c_57a1e0000003', changes: ['c_57a1e0000003', 'c_57a1e0000004'], tries: 1 });
  // "working" with no change at all.
  const y = rm.addTask({ item: it.id, request: 'Sidebar', title: 'Sidebar' });
  rm.setTask(y.id, { status: 'working' });
  const done = pm.reconcileTasks();
  assert.ok(done.includes(w.id) && done.includes(y.id));
  assert.equal(rm.getTask(w.id)!.status, 'merged', 'the merged change wins');
  assert.equal(rm.getTask(w.id)!.change, 'c_57a1e0000002');
  assert.ok(decisions('reconcile', w.id).length);
  assert.equal(rm.getTask(y.id)!.status, 'planned');
  assert.equal(rm.getTask(x.id)!.change, 'c_57a1e0000004', 'it follows its newest change');
  await tick();
  assert.equal(changesOf(x.id).length, 3, 'the failed one is retried (not held by the older merge)');
  assert.equal(rm.getTask(x.id)!.status, 'working');
  assert.match(changesOf(x.id).at(-1).request, /ran out of time/);
});

test('after a restart the PM reconciles at once', () => {
  const it = rm.addItem({ product: 'mvmisc', title: 'Restart', status: 'planned' });
  const z = rm.addTask({ item: it.id, request: 'Banner', title: 'Banner' });
  add('c_7e57a7000001', 'mvmisc', z.id, 'merged', { merged_at: old });
  rm.setTask(z.id, { status: 'failed', change: null, tries: 3, note: 'stale' });
  // A new Studio process starting the loop: reconciled before its first pass (it exits before that pass would run).
  const code = `const pm = await import(${JSON.stringify(path.resolve('src/pm.ts'))}); pm.startPm(); setTimeout(() => process.exit(0), 200);`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rm.getTask(z.id)!.status, 'merged');
  assert.ok(rm.listDecisions({ action: 'reconcile', limit: 500 }).some((d) => !d.subject && /Studio started: \d+ task/.test(d.detail ?? '')));
});

test('"already done": checked and merged (no try), what needs J is one Inbox question; an unproven claim is a normal retry', async () => {
  assert.ok(ag.alreadyDone('Nothing to do: the work is already merged (c_a1ead0000001).'));
  assert.ok(ag.alreadyDone('The Caddy block is already in place on main.'));
  assert.ok(!ag.alreadyDone('Fixed the spawn table.'));
  const it = rm.addItem({ product: 'mvmisc', title: 'Done', status: 'planned' });
  const y = rm.addTask({ item: it.id, request: 'Serve /dev/', title: 'Dev front door' });
  add('c_a1ead0000001', 'mvmisc', y.id, 'merged', { merged_at: old - 3600_000, created: old - 7200_000 });
  add('c_a1ead0000002', 'mvmisc', y.id, 'failed', { detail: `${ag.ALREADY} (the agent made no commit)`, summary: "The work is already merged (c_a1ead0000001). What's left needs J: he must run node deploy/deploy.mjs --caddy-only on his PC." });
  rm.setTask(y.id, { status: 'working', change: 'c_a1ead0000002', changes: ['c_a1ead0000001', 'c_a1ead0000002'], tries: 2 });
  await tick();
  assert.equal(rm.getTask(y.id)!.status, 'merged');
  assert.equal(rm.getTask(y.id)!.tries, 1, 'not a try');
  assert.equal(changesOf(y.id).length, 2, 'no third agent');
  assert.ok(decisions('already-done', y.id).length);
  const qs = questionsOn(y.id);
  assert.equal(qs.length, 1, 'one question for what needs J');
  assert.equal(qs[0].status, 'asked J');
  assert.match(qs[0].text, /caddy-only/);
  // Claimed but nothing merged to show it: retried, told so.
  const z = rm.addTask({ item: it.id, request: 'Add the sitemap', title: 'Sitemap' });
  add('c_a1ead0000003', 'mvmisc', z.id, 'failed', { detail: `${ag.ALREADY} (the agent made no commit)`, summary: 'The sitemap is already there.' });
  rm.setTask(z.id, { status: 'working', change: 'c_a1ead0000003', changes: ['c_a1ead0000003'], tries: 1 });
  await tick();
  assert.equal(changesOf(z.id).length, 2);
  assert.match(changesOf(z.id).at(-1).request, /found no merged change or pull request/);
});

test('the stall watch: why per task, one "stall" decision, a broken build nobody is fixing goes back to an agent', async () => {
  const it = rm.addItem({ product: 'mvstall', title: 'Stalled', status: 'planned' });
  const first = rm.addTask({ item: it.id, request: 'Base', title: 'Base' });
  const second = rm.addTask({ item: it.id, request: 'On top', title: 'On top', depends: [first.id] });
  add('c_57a110000001', 'mvstall', first.id, 'merged', { merged_at: old });
  rm.setTask(first.id, { status: 'merged', change: 'c_57a110000001', changes: ['c_57a110000001'], tries: 1, merged_at: old, build: { ok: false, run: 'r_57a110000001', at: old, detail: "beta's build failed: CS1002" } });
  // A dependency on a task not merged: it waits (the stall reason says so).
  const third = rm.addTask({ item: it.id, request: 'Later', title: 'Later', depends: [second.id] });
  // Nothing started or finished for an hour, anywhere.
  db.prepare('UPDATE changes SET created = MIN(created, ?), updated = MIN(COALESCE(updated, created), ?)').run(old, old);
  db.prepare(`UPDATE pm_log SET at = MIN(at, ?) WHERE action = 'start'`).run(old);
  db.prepare(`UPDATE tasks SET status = 'dropped' WHERE product != 'mvstall' AND status = 'planned'`).run();
  const r = await pm.stallWatch();
  assert.equal(r.stalled, true);
  const why = new Map(r.reasons.map((x) => [x.task, x.why]));
  assert.match(why.get(first.id) ?? '', /broken build/);
  assert.match(why.get(third.id) ?? '', /blocked by/);
  assert.equal(rm.getTask(first.id)!.status, 'working', 'the broken build went back to an agent');
  const stalls = rm.listDecisions({ action: 'stall', limit: 100 });
  assert.equal(stalls.length, 1);
  assert.match(stalls[0].detail ?? '', /sent back for beta's build/);
  await pm.stallWatch();
  assert.equal(rm.listDecisions({ action: 'stall', limit: 100 }).length, 1, 'one per stall');
  const st = await pm.pmStatus();
  assert.ok(st.stall.reasons.some((x) => x.task === third.id), 'shown in studio_pm status');
});
