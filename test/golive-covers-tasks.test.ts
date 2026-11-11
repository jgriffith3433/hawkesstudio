// The play before going live judges the merged tasks it can (2026-11-10: of 347 tasks merged, verified or live, 22 had
// every criterion judged), and a change's own passing playtest verifies its task once beta built it. No playtest added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-covers-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const product = (id: string) => ({
  id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: id, port: 8790, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
});
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: ['gcover', 'gshow', 'gunclear'].map(product), repos: {} }));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const P = await import('../src/golive-policy.ts');
await import('../src/agents.ts');
const { db, J, newId } = await import('../src/db.ts');
pm.savePmSettings({ walkAway: false });

function mergedTask(productId: string, criteria: string[], { landed = true, verify = null as any, scenario = null as string | null } = {}) {
  const it = rm.addItem({ product: productId, title: 'Item', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Task', criteria });
  const change = newId('c');
  const at = Date.now() - 10 * 60_000;
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, merged_at, verify)
    VALUES (?, ?, '[]', 'merged', 'merged', ?, ?, 'task/x', 'beta', ?, 'Task', '[]', '[]', ?, ?, ?, ?, ?)`).run(change, productId, productId, `x/${productId}`, path.join(tmp, 'none', change), at, at, t.id, at, verify || scenario ? J({ ...(verify ?? {}), ...(scenario ? { scenario } : {}) }) : null);
  rm.setTask(t.id, { status: 'merged', change, changes: [change], merged_at: at, build: landed ? { ok: true, run: 'r_built', at: at + 60_000, detail: 'built OK' } : null });
  return { task: rm.getTask(t.id)!, change, at };
}
const yes = (criterion: string) => ({ criterion, met: 'yes', evidence: 'seen' });

test("the go-live play carries the criteria of the merged tasks beta's commit contains, and no scenario beyond the default", async () => {
  const inside = mergedTask('gcover', ['The shop opens']).task;
  const later = mergedTask('gcover', ['The score shows']).task; // merged after the played commit
  const own = mergedTask('gcover', ['The boss appears'], { scenario: 'boss-fight' }).task; // needs a scenario of its own
  const merge = async (t: any) => ({ slug: 'o/r', sha: `m-${t.id}` });
  const includes = async (_s: string, m: string) => m !== `m-${later.id}`;
  const covered = await pm.coveredByBetaPlay('gcover', 'beta1234', { merge, includes: includes as any, tasks: [inside, later, own] });
  assert.deepEqual(covered, { criteria: ['The shop opens'], tasks: [inside.id] });

  // The play starts with exactly that: its options carry the criteria and no plays or scenario.
  const starts: any[] = [];
  const start = (p: string, o: any) => { starts.push(o); return { id: 'r_cov0' }; };
  const r = await P.playBeforeGoLive('gcover', 'beta123', 'test', start, undefined, async () => covered);
  assert.equal(r.started, 'r_cov0');
  assert.deepEqual(starts[0].sweep, covered);
  assert.equal(starts[0].plays, undefined);
  assert.equal(starts[0].scenario, undefined);
  assert.equal(starts[0].playtest, true);
});

test("a task merged after the played commit isn't judged by that play", async () => {
  const later = mergedTask('gcover', ['Merged late']).task;
  const none = await pm.coveredByBetaPlay('gcover', 'beta1234', { merge: async () => ({ slug: 'o/r', sha: 'late' }), includes: (async () => false) as any, tasks: [later] });
  assert.deepEqual(none, { criteria: [], tasks: [] });
  // Even a review that judged its criteria in passing for other tasks doesn't count for it.
  const run = newId('r');
  const at = Date.now() - 30_000;
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?)').run(run, 'beta', 'done', 'beta', J(['gcover']), at - 60_000, Date.now());
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, 'gcover', 'playtest', 'smoke@local', 'done', ?, ?)`).run(newId('s'), run, J({ outcome: 'passed' }), at - 1000);
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, 'gcover', 'review', 'smoke@local', 'done', ?, ?)`).run(newId('s'), run, J({ verdict: 'ship', criteria: [yes('Merged late')], sweep: ['someone-else'] }), at);
  await pm.syncTasks();
  assert.equal(rm.getTask(later.id)!.status, 'merged');
});

test("'unclear' from the go-live play leaves the task merged and starts no revision", async () => {
  const { task } = mergedTask('gunclear', ['The shop opens', 'The score shows']);
  const run = newId('r');
  const at = Date.now() - 30_000;
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(run, 'beta', 'done', 'beta', J(['gunclear']), J({ focus: `${P.BEFORE_GO_LIVE} abc1234 once` }), at - 60_000, Date.now());
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, 'gunclear', 'playtest', 'smoke@local', 'done', ?, ?)`).run(newId('s'), run, J({ outcome: 'passed' }), at - 1000);
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, 'gunclear', 'review', 'smoke@local', 'done', ?, ?)`).run(newId('s'), run, J({ verdict: 'ship', criteria: [yes('The shop opens'), { criterion: 'The score shows', met: 'unclear', evidence: 'never reached' }], sweep: [task.id] }), at);
  const before = (db.prepare('SELECT COUNT(*) AS n FROM changes WHERE task = ?').get(task.id) as any).n;
  await pm.syncTasks();
  const t = rm.getTask(task.id)!;
  assert.equal(t.status, 'merged');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM changes WHERE task = ?').get(task.id) as any).n, before, 'no revision started');
});

test("a showcase pass with every criterion yes, then a good beta build, verifies the task: no beta run is started", async () => {
  const crit = ['The shop opens'];
  const passed = { outcome: 'passed', playtest: 'j_1', verdict: 'ship', changeWorked: 'yes', criteria: crit.map(yes), played: 'tipT' };
  const { task, change, at } = mergedTask('gshow', crit, { landed: false, verify: passed });
  rm.setTask(task.id, { checks: { where: 'change', at, change, sha: 'tipT', results: crit.map(yes) } });
  // Beta's build of a commit with the merge: one finished beta run after the merge.
  const run = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?)').run(run, 'beta', 'done', 'beta', J(['gshow']), at + 1000, Date.now());
  const betaRuns = () => (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE kind = 'beta'`).get() as any).n;
  const before = betaRuns();
  // T is part of beta's merge commit.
  const deps = { merge: async () => 'mergeM', fork: async () => null, files: async () => null, isAncestor: async (a: string, b: string) => a === 'tipT' && b === 'mergeM' };
  await pm.followBuilds(deps);
  const t = rm.getTask(task.id)!;
  assert.equal(t.build?.ok, true);
  assert.equal(t.status, 'verified');
  assert.equal(t.checks?.where, 'change');
  assert.equal(t.checks?.sha, 'tipT');
  assert.match(t.checks?.carried ?? '', /part of beta's merge/);
  assert.equal(betaRuns(), before, 'no beta run started');
});

test('a showcase pass whose commit is not part of the merge, or a failed beta build, leaves the task merged', async () => {
  const crit = ['The shop opens'];
  const passed = { outcome: 'passed', playtest: 'j_1', verdict: 'ship', changeWorked: 'yes', criteria: crit.map(yes), played: 'tipT' };
  const { task, change, at } = mergedTask('gshow', crit, { landed: false, verify: passed });
  rm.setTask(task.id, { checks: { where: 'change', at, change, sha: 'tipT', results: crit.map(yes) } });
  // Build not ok: carry refuses (nothing was built).
  const deps = { merge: async () => 'mergeM', fork: async () => null, files: async () => null, isAncestor: async () => true };
  assert.equal(await pm.carryChangeVerdict(rm.getTask(task.id)!, deps), false);
  rm.setTask(task.id, { build: { ok: false, run: 'r_x', at: Date.now(), detail: 'beta build failed' } });
  assert.equal(await pm.carryChangeVerdict(rm.getTask(task.id)!, deps), false);
  assert.equal(rm.getTask(task.id)!.status, 'merged');
});
