// J, 2026-11-11: "I don't know why we have so many unity builds ... Unity builds should really just be for the milestone
// end but only if there's not more work to be done." That day ~20 Unity builds were queued at once (one per change's
// verify, one per beta push, one per beta run after a merge) and used up the region's CPU quota.
// 1. the waste, reproduced: several changes of a Unity project each asking for a build, and a push to beta, are held,
//    with the plain words, and nothing reaches Hawkes Gen;
// 2. a milestone complete in code with nothing else queued starts exactly one build of beta's head (the milestone's
//    check), and waits while work is still queued;
// 3. a person's ask still builds.
// A scratch database and a fixture project; no GitHub, Gen or browser (every outside call is refused).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unitypolicy-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'K_SERVICE']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const base = { framing: 'test', site: 'sou', live: 'http://127.0.0.1:9/', playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' };
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { sou: 'x/sou', web: 'x/web' },
  products: [
    { ...base, id: 'sou', name: 'Sick of It (Unity)', engine: 'unity', repo: 'sou', github: 'x/sou', local: { serve: 'static', dir: 'sou', port: 8796, path: '/' }, builds: [{ id: 'web', tool: 'unity', target: 'web' }] },
    { ...base, id: 'webby', name: 'Webby', engine: 'web', repo: 'web', site: 'web', github: 'x/web', local: { serve: 'static', dir: 'web', port: 8797, path: '/' }, builds: [{ id: 'site', tool: 'npm' }] },
  ],
  infra: [],
}));

// Nothing outside: a call to GitHub or Gen is a test failure waiting to happen, so it is counted and refused.
const outside: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => { outside.push(String(input instanceof Request ? input.url : input)); return new Response('refused in the test', { status: 500 }); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const { db, J, newId } = await import('../src/db.ts');
const A = await import('../src/agents.ts'); // the changes table, verifyChange
const B = await import('../src/builds.ts');
const BB = await import('../src/betabuild.ts');
const P = await import('../src/unitybuild-policy.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const { getProduct } = await import('../src/config.ts');

const HEAD = 'c'.repeat(40);
const HELD = /^held: Unity builds run once the milestone is complete and nothing else is queued for Sick of It \(Unity\)/;
const unityRuns = () => (db.prepare(`SELECT id, kind, options FROM runs WHERE products LIKE '%"sou"%'`).all() as any[]);
const change = (status: string) => {
  const id = newId('c');
  db.prepare('INSERT INTO changes (id, product, findings, status, created) VALUES (?, ?, ?, ?, ?)').run(id, 'sou', '[]', status, Date.now());
  return id;
};
const clearWork = () => {
  db.prepare("DELETE FROM changes WHERE product = 'sou'").run();
  db.prepare("DELETE FROM tasks WHERE product = 'sou'").run();
  db.prepare("DELETE FROM items WHERE product = 'sou'").run();
  db.prepare('DELETE FROM milestones').run();
};

test('the rule: asked builds always build; anything else waits for a complete milestone with nothing queued', () => {
  const idle = { name: 'Sick of It (Unity)', milestone: { id: 'n_1', title: 'Controls done' }, changes: [], tasks: [] };
  const busy = { ...idle, changes: ['c_1', 'c_2'], tasks: ['k_1'] };
  const none = { ...idle, milestone: null };
  for (const cause of ['person', 'tag', 'release', 'retry'] as const) assert.equal(P.unityBuildVerdict(cause, none).go, true, cause);
  assert.equal(P.unityBuildVerdict('auto', idle).go, true);
  const held = P.unityBuildVerdict('auto', busy);
  assert.equal(held.go, false);
  assert.match(held.why, HELD);
  assert.match(held.why, /still queued: 2 agent changes, 1 roadmap task/);
  assert.match(P.unityBuildVerdict('auto', none).why, /no milestone of it is complete yet/);
  // The milestone's own check asked the rule when it started: work queued since doesn't take its one build away.
  assert.equal(P.unityBuildVerdict('milestone', busy).go, true);
  assert.equal(P.unityBuildVerdict('milestone', none).go, false);
  assert.equal(P.causeOf({ trigger: 'beta' }), 'auto');
  assert.equal(P.causeOf({ change: 'c_1' }), 'auto');
  assert.equal(P.causeOf({ trigger: 'tag' }), 'tag');
  assert.equal(P.causeOf({}), 'person', 'no trigger and no change: asked (the API, the dashboard, Talk)');
});

test('1. the waste: every change of a Unity project asking for a build, and a push to beta, are held', async () => {
  clearWork();
  const changes = [change('verifying'), change('working'), change('queued')];
  // Each change's verify used to build its branch in the cloud (agents.ts buildChangeInCloud): now none does.
  const p = getProduct('sou');
  for (const id of changes) {
    const c: any = { id, repo: 'sou', worktree: path.join(tmp, 'wt', id), branch: `task/${id}`, base: 'beta', request: '', criteria: [], findings: [] };
    const v: any = await A.verifyChange(c, p, []);
    assert.equal(v.outcome, 'not played', 'a held build never fails a change');
    assert.equal(v.held, true);
    assert.equal(v.build, null);
    assert.match(v.error, HELD);
    assert.match(v.error, /compile check/);
    assert.match(A.readyDetail(v), /not played: held: Unity builds run once/);
  }
  // And each start of a build for a change, or for beta, by anything but a person.
  const said: string[] = [];
  for (const id of changes) assert.equal(await B.startBuild('sou', { build: 'web', change: id, ref: `task/${id}`, onHeld: (why) => said.push(why) }), null);
  assert.equal(await B.startBuild('sou', { trigger: 'beta', onHeld: (why) => said.push(why) }), null);
  // The rebuild after a build fixer's change merged (buildfix.ts), and a beta site rebuild after a sync.
  assert.equal(await B.startBuild('sou', { build: 'web', cause: 'auto', onHeld: (why) => said.push(why) }), null);
  assert.equal(said.length, 5);
  for (const w of said) assert.match(w, HELD);
  // A push to beta (the repo's hook): held, said in the answer, no run.
  const hook: any = await B.onRepoHook({ repository: 'x/sou', ref: 'refs/heads/beta', sha: HEAD }, {});
  assert.match(hook.held.sou, HELD);
  assert.equal(hook.runs.sou, undefined);
  assert.equal(unityRuns().filter((r) => r.kind === 'build').length, 0, 'no build run');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM builds WHERE product = 'sou'").get() as any).n, 0, 'no build row');
  assert.ok(!outside.some((u) => /gen|github/.test(u)), `nothing reached Gen or GitHub: ${outside.join(', ')}`);
});

test('a project without a Unity build is not held', async () => {
  // An npm build of a push to beta builds as before (its own run), the rule is Unity's only.
  let held = '';
  const r = await B.startBuild('webby', { trigger: 'beta', onHeld: (why) => { held = why; } });
  assert.ok(r, 'the npm build started');
  assert.equal(held, '');
  await r!.done;
});

test('2. a milestone complete in code waits while work is queued, then its check starts exactly one build', async () => {
  clearWork();
  const a = rm.addItem({ product: 'sou', title: 'Jump', status: 'planned' });
  const b = rm.addItem({ product: 'sou', title: 'Dash', status: 'planned' });
  const ms = rm.addMilestone({ product: 'sou', title: 'Controls done', items: [a.id, b.id] });
  const ta = rm.addTask({ item: a.id, request: 'Jump' });
  const tb = rm.addTask({ item: b.id, request: 'Dash' });
  const later = rm.addItem({ product: 'sou', title: 'Menus', status: 'planned' });
  const tl = rm.addTask({ item: later.id, request: 'Menus' });
  // Merged into beta, never built (builds are held): complete in code, which is what the milestone needs now.
  rm.setTask(ta.id, { status: 'merged', merged_at: Date.now() - 1000 });
  assert.equal(P.unityWork('sou').milestone, null, 'one item still to merge');
  rm.setTask(tb.id, { status: 'merged', merged_at: Date.now() - 1000 });
  assert.equal(rm.milestoneProgress(ms.id).done, 0, 'not on beta: nothing built them');
  assert.equal(rm.milestoneProgress(ms.id).coded, 2);
  assert.ok(rm.milestonesToReach().some((m) => m.id === ms.id), 'no circle: complete in code is enough for a Unity project Studio builds');
  assert.equal(P.unityWork('sou').milestone?.id, ms.id);
  // Another task planned for the project, and a change on it: more work, so nothing builds yet.
  const c1 = change('working');
  const busy = P.unityBuildGate('sou', 'auto');
  assert.equal(busy.go, false);
  assert.match(busy.why, /milestone "Controls done" is complete in code, but still queued: 1 agent change, 1 roadmap task/);
  await pm.milestoneCheck(ms.id);
  assert.equal(unityRuns().filter((r) => r.kind === 'beta').length, 0, 'the check waits: no beta run');
  assert.match(String(rm.listDecisions({ action: 'milestone-wait' })[0].detail), /its build of Sick of It \(Unity\) waits: held/);
  await pm.milestoneCheck(ms.id);
  assert.equal(rm.listDecisions({ action: 'milestone-wait' }).length, 1, 'said once while the reason is the same');
  // The queue empties: the change merged, the last task is dropped.
  db.prepare("UPDATE changes SET status = 'merged' WHERE id = ?").run(c1);
  rm.setTask(tl.id, { status: 'dropped' });
  assert.equal(P.unityBuildGate('sou', 'auto').go, true);
  await pm.milestoneCheck(ms.id);
  await pm.milestoneCheck(ms.id); // a second pass of the PM: nothing more
  const betas = unityRuns().filter((r) => r.kind === 'beta');
  assert.equal(betas.length, 1, 'one beta run for the milestone');
  assert.equal(JSON.parse(betas[0].options).cause, 'milestone', 'it builds as the milestone\'s check');
  assert.match(String(rm.listDecisions({ action: 'milestone-check' })[0].detail), /beta's head is built once now/);

  // That run and the beta run after the last merge both ask for beta's head: ONE Unity build starts, the other waits for it.
  let starts = 0;
  const listeners = new Set<(t: string) => void>();
  const on = (fn: (t: string) => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
  const deps = (cause: 'milestone' | 'auto') => ({
    head: async () => HEAD, on, maxMs: 5_000,
    hold: () => { const v = P.unityBuildGate('sou', cause); return v.go ? null : v.why; },
    start: async (sha: string) => {
      starts++;
      const run = newId('r');
      db.prepare('INSERT INTO runs (id, kind, status, detail, products, started) VALUES (?, ?, ?, ?, ?, ?)').run(run, 'build', 'running', 'x', J(['sou']), Date.now());
      db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, started) VALUES (?, 'sou', 'web', 1, 'building', ?, 'beta', 'gen', 'web', ?, ?)").run(newId('b'), sha, run, Date.now());
      setTimeout(() => { db.prepare("UPDATE builds SET status = 'ready' WHERE product = 'sou' AND sha = ?").run(sha); for (const f of listeners) f('builds'); }, 30);
      return { id: run, done: new Promise(() => {}) };
    },
  });
  const first = BB.ensureBetaBuild('sou', 'web', deps('milestone'));
  const second = BB.ensureBetaBuild('sou', 'web', deps('auto'));
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(starts, 1, 'exactly one Unity build');
  assert.deepEqual([r1.ok, r2.ok], [true, true]);
  assert.equal(r2.how, 'waited for a build');
});

test('a beta run of a busy Unity project holds its build and plays nothing old in its place', async () => {
  clearWork();
  db.prepare('DELETE FROM builds').run();
  change('queued');
  let starts = 0;
  const r = await BB.ensureBetaBuild('sou', 'web', {
    head: async () => HEAD,
    hold: () => { const v = P.unityBuildGate('sou', 'auto'); return v.go ? null : v.why; },
    start: async () => { starts++; return null; },
  });
  assert.equal(starts, 0);
  assert.equal(r.ok, false);
  assert.equal(r.how, 'held');
  assert.match(r.detail, HELD);
  // The PM reads such a run as one that built and checked nothing (never a failed build, never blamed on a task).
  const run = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?)').run(run, 'beta', 'done', 'x', J(['sou']), Date.now(), Date.now());
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(newId('s'), run, 'sou', 'build', 'web', 'skipped', r.detail, J({ held: r.detail }), Date.now());
  assert.match(P.heldBuildRun(run, 'sou') ?? '', HELD);
  assert.match(pm.brokenCheck(run, 'sou') ?? '', /Unity build was held/);
});

test('3. a person\'s ask still builds, with work queued and no milestone', async () => {
  clearWork();
  change('working');
  for (const cause of ['person', 'tag', 'release', 'retry'] as const) assert.equal(P.unityBuildGate('sou', cause).go, true, cause);
  // The builds route, the Inbox's Build again, Talk's build tool: a run of the Unity build (it then fails here: no GitHub).
  let held = '';
  const r = await B.startBuild('sou', { build: 'web', cause: 'person', onHeld: (why) => { held = why; } });
  assert.ok(r, 'a build run started');
  assert.deepEqual(r!.builds, ['web']);
  assert.equal(held, '');
  await r!.done;
  // A playtest of a change that a person asked for still builds its branch (agents.ts buildChangeInCloud).
  assert.equal(A.changeBuildPlan(getProduct('sou')).how, 'cloud');
});

test('a person asking to go live gets beta\'s head built, past an earlier play whose build was held', async () => {
  const G = await import('../src/golive-policy.ts');
  const short = HEAD.slice(0, 7);
  // Studio's own play before going live, held: it built and played nothing.
  const held = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(held, 'beta', 'done', 'x', J(['sou']), J({ focus: `${G.BEFORE_GO_LIVE} ${short} once` }), Date.now(), Date.now());
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(newId('s'), held, 'sou', 'build', 'web', 'skipped', 'held: x', J({ held: 'held: x' }), Date.now());
  const asked: Record<string, unknown>[] = [];
  const start = (_p: string, o: Record<string, unknown>) => { asked.push(o); return { id: 'r_new' }; };
  assert.ok((await G.playBeforeGoLive('sou', short, 'Studio', start)).held, 'Studio\'s own go live waits for the milestone\'s build and play');
  assert.equal(asked.length, 0);
  assert.deepEqual(await G.playBeforeGoLive('sou', short, 'J asked', start, 'person'), { started: 'r_new' });
  assert.equal(asked[0].cause, 'person', 'its Unity build runs: shipping needs it');
});
