// One build of each kind per project at a time, and one waiting (src/buildline.ts; J, 2026-11-11: "we aren't building
// after every single run are we? ... let's not have so many builds of the same product in a queue"). On Nov 10-11 about
// 20 Unity builds were queued at once (a change's verify, every push to beta, every beta run after a merge) and used up
// the region's CPU quota. Reproduced here:
// 1. N merges in a row on one project: at most one build running and one waiting, the newest commit; the others end
//    "superseded by the build of <sha>" at once (nothing waits for ever);
// 2. a start of the same commit joins the build already going or waiting;
// 3. a build that hasn't really started in Gen gives way to a newer commit; Gen never holds two queued builds of one
//    project's build (replaceQueuedGen);
// 4. an agent's verify of a Unity project starts no Unity build (in the cloud or on a build server), and a change that
//    merges by itself builds no preview of its own.
// A scratch database and fixture projects; no GitHub, Gen or browser (every outside call is refused and counted).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildline-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_TASK_BAR = 'off'; // these tests start tasks written in a line (the task bar has its own: taskbar.test.ts)
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'K_SERVICE', 'GITHUB_TOKEN']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const base = { framing: 'test', live: 'http://127.0.0.1:9/', playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' };
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { sou: 'x/sou', web: 'x/web', leg: 'x/leg' },
  products: [
    { ...base, id: 'sou', name: 'Sick of It (Unity)', engine: 'unity', repo: 'sou', site: 'sou', github: 'x/sou', local: { serve: 'static', dir: 'sou', port: 8796, path: '/' }, builds: [{ id: 'web', tool: 'unity', target: 'web' }] },
    { ...base, id: 'webby', name: 'Webby', engine: 'web', repo: 'web', site: 'web', github: 'x/web', local: { serve: 'static', dir: 'web', port: 8797, path: '/' }, builds: [{ id: 'site', tool: 'npm' }] },
    // A Unity game built on a build server of its own (products.json "build"): its changes used to be built one by one.
    { ...base, id: 'leg', name: 'Legacy Unity', engine: 'unity', repo: 'leg', site: 'legsite', local: { serve: 'static', dir: 'legsite', port: 8798, path: '/' }, build: { project: 'leg/Game', site: 'legsite', method: 'Leg.Build' } },
  ],
  infra: [],
}));

const outside: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => { outside.push(String(input instanceof Request ? input.url : input)); return new Response('refused in the test', { status: 500 }); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const { db, newId } = await import('../src/db.ts');
const L = await import('../src/buildline.ts');
const A = await import('../src/agents.ts');
const B = await import('../src/builds.ts');
const BB = await import('../src/betabuild.ts');
const { startStep, updateStep, getRun } = await import('../src/pipeline.ts');
const { cancelRun } = await import('../src/cancel.ts');
const { getProduct } = await import('../src/config.ts');

const sha = (c: string) => c.repeat(40);
const tick = () => new Promise((r) => setTimeout(r, 2));
const stepOf = (run: string) => db.prepare("SELECT status, detail, data FROM steps WHERE run = ? AND kind = 'build'").get(run) as { status: string; detail: string; data: string | null };
beforeEach(() => { L.resetLines(); });

test('1. N merges in a row on one project: one build running, one waiting (the newest), the rest superseded at once', async () => {
  const key = L.lineKey('webby', 'site', 'beta');
  const first = L.enterLine(key, sha('1'));
  assert.equal(first.how, 'go');
  const asked: { sha: string; e: ReturnType<typeof L.enterLine> }[] = [];
  for (const c of ['2', '3', '4', '5', '6']) {
    asked.push({ sha: sha(c), e: L.enterLine(key, sha(c)) });
    // Never more than one waiting behind the one building, after every merge.
    assert.deepEqual(L.lineState(key), { building: sha('1'), waiting: sha(c) });
  }
  const turns = await Promise.all(asked.slice(0, -1).map((x) => (x.e as any).turn));
  turns.forEach((t, i) => assert.equal(t.superseded, asked[i + 1].sha, 'an older waiting start ends at once, naming the commit that replaced it'));
  // The one building ends: the newest commit builds next, and that is all. Two builds for six merges.
  let started = 1;
  const last = asked.at(-1)!.e;
  assert.equal(last.how, 'queued');
  (first as any).turn.end();
  const t = await (last as any).turn;
  assert.ok(!('superseded' in t));
  started++;
  assert.deepEqual(L.lineState(key), { building: sha('6'), waiting: null });
  t.end();
  assert.deepEqual(L.lineState(key), { building: null, waiting: null });
  assert.equal(started, 2);
});

test('2. the same commit joins the build already going, or the one already waiting', async () => {
  const key = L.lineKey('webby', 'site', 'beta');
  const go = L.enterLine(key, sha('a')) as any;
  const joinRunning = L.enterLine(key, sha('a'));
  assert.equal(joinRunning.how, 'joined');
  assert.equal((joinRunning as any).building, true);
  const waiting = L.enterLine(key, sha('b')) as any;
  const joinWaiting = L.enterLine(key, sha('b')) as any;
  assert.equal(joinWaiting.how, 'joined');
  assert.equal(joinWaiting.building, false);
  go.turn.end();
  assert.deepEqual(await (joinRunning as any).done, {});
  const t = await waiting.turn;
  t.end();
  assert.deepEqual(await joinWaiting.done, {}, 'ends with the build it joined');
  // A joiner of a waiting start that a newer commit replaced ends superseded too.
  const g2 = L.enterLine(key, sha('c')) as any;
  L.enterLine(key, sha('d'));
  const j = L.enterLine(key, sha('d')) as any;
  const newer = L.enterLine(key, sha('e')) as any;
  assert.deepEqual(await j.done, { superseded: sha('e') });
  g2.turn.end();
  (await newer.turn).end();
});

test('3. the build going hears of a newer commit (so one not started in Gen can give way); lanes are separate', async () => {
  const key = L.lineKey('sou', 'web', 'beta');
  const go = L.enterLine(key, sha('1')) as any;
  const heard: string[] = [];
  go.turn.onNewer((s: string) => heard.push(s));
  L.enterLine(key, sha('2'));
  L.enterLine(key, sha('3'));
  assert.deepEqual(heard, [sha('2'), sha('3')]);
  assert.equal(go.turn.newer(), sha('3'));
  // Another lane (main for a release, a change's own preview) is its own line.
  assert.equal(B.lineOf('sou', 'web', { ref: 'main' }), 'sou|web|main');
  assert.equal(B.lineOf('sou', 'web', { change: 'c_1', ref: 'task/x' }), 'sou|web|c/c_1');
  assert.equal(B.lineOf('sou', 'web', {}), 'sou|web|beta');
  assert.equal(L.enterLine(B.lineOf('sou', 'web', { ref: 'main' }), sha('9')).how, 'go');
  // A restart carrying on its Gen job takes the line at once.
  assert.equal(L.enterLine(L.lineKey('sou', 'web', 'tag'), sha('7'), { now: true }).how, 'go');
});

test('4. through startBuild: merges in a row make one waiting build; superseded and joined starts say so on their runs', async () => {
  const key = B.lineOf('webby', 'site', { ref: 'beta' });
  // A build of commit 1 is going (its turn taken as buildOne takes it).
  const going = L.enterLine(key, sha('1')) as any;
  const runs: string[] = [];
  for (const c of ['2', '3', '4']) {
    const r = await B.startBuild('webby', { trigger: 'beta', sha: sha(c) });
    assert.ok(r);
    runs.push(r!.id);
    await tick(); await tick();
  }
  // The same commit as the waiting one: joins it.
  const joined = await B.startBuild('webby', { trigger: 'beta', sha: sha('4') });
  runs.push(joined!.id);
  for (let i = 0; i < 20 && L.lineState(key).waiting !== sha('4'); i++) await tick();
  assert.deepEqual(L.lineState(key), { building: sha('1'), waiting: sha('4') });
  for (let i = 0; i < 20 && stepOf(runs[1])?.status !== 'cancelled'; i++) await tick();
  runs.slice(0, 2).forEach((r, i) => {
    const s = stepOf(r);
    const by = sha(String(i + 3));
    assert.equal(s.status, 'cancelled');
    assert.match(s.detail, new RegExp(`^superseded by the build of ${by.slice(0, 7)}`));
    assert.equal(JSON.parse(s.data!).superseded.by, by);
  });
  for (let i = 0; i < 200 && !stepOf(runs[3])?.detail; i++) await tick();
  assert.match(stepOf(runs[3]).detail, /already waiting to build/);
  // The waiting build's run is cancelled while it waits: when its turn comes it builds nothing.
  await cancelRun(runs[2], 'J', 'test');
  going.turn.end();
  for (let i = 0; i < 50 && getRun(runs[3])?.status === 'running'; i++) await tick();
  assert.equal(stepOf(runs[2]).status, 'cancelled');
  assert.equal(stepOf(runs[3]).status, 'cancelled', 'the start that joined it ends with it');
  assert.equal(L.lineState(key).building, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM builds WHERE product = 'webby'").get() as any).n, 0, 'nothing reached a build');
  assert.ok(!outside.some((u) => /github|gen/.test(u)), `nothing reached GitHub or Gen: ${outside.join(', ')}`);
});

test("a beta run waiting for a build that a newer commit's build replaced ends superseded, not after hours", async () => {
  const run = newId('r');
  db.prepare("INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, 'build', 'running', 'x', '[\"sou\"]', '{}', ?)").run(run, Date.now());
  const r = await BB.ensureBetaBuild('sou', 'web', {
    head: async () => sha('5'),
    start: async () => {
      const step = startStep(run, 'sou', 'build', 'web');
      const done = (async () => { await tick(); updateStep(step, { status: 'cancelled', detail: B.supersededWords(sha('6')), data: { superseded: { by: sha('6') }, cancelled: true }, finished: true }); })();
      return { id: run, done };
    },
    maxMs: 60_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.how, 'superseded');
  assert.match(r.detail, /superseded by the build of 6666666/);
});

test('Gen holds one queued build of a project: a queued duplicate is replaced; compile checks, started jobs and other branches stay', async () => {
  const gh = (o: any) => ({ repo: 'x/sou', ref: 'beta', commit: 'x', ...o });
  const jobs = [
    { id: 'j_dup', tool: 'unity.build', status: 'queued', project: 'sou', params: { github: gh({}), target: 'web' } },
    { id: 'j_check', tool: 'unity.build', status: 'queued', project: 'sou', params: { github: gh({}), check: true } },
    { id: 'j_started', tool: 'unity.build', status: 'queued', project: 'sou', started: 123, params: { github: gh({}) } },
    { id: 'j_main', tool: 'unity.build', status: 'queued', project: 'sou', params: { github: gh({ ref: 'main' }) } },
    { id: 'j_other', tool: 'unity.build', status: 'queued', project: 'other', params: { github: gh({ repo: 'x/other' }) } },
    { id: 'j_noparams', tool: 'unity.build', status: 'queued', project: 'sou' },
  ];
  const full: Record<string, any> = { j_noparams: { id: 'j_noparams', status: 'queued', params: { github: gh({}) } } };
  const cancelled: { id: string; why: string }[] = [];
  const ids = await B.replaceQueuedGen({ project: 'sou', slug: 'x/sou', ref: 'beta', path: null, sha: sha('f'), row: null },
    { jobs: async () => jobs, job: async (id) => full[id] }, async (id, why) => { cancelled.push({ id, why }); });
  assert.deepEqual(ids.sort(), ['j_dup', 'j_noparams']);
  assert.match(cancelled[0].why, /^replaced by the build of fffffff/);
});

test('5. an agent verify of a Unity project starts no Unity build, in the cloud or on a build server', async () => {
  for (const id of ['sou', 'leg']) {
    const p = getProduct(id);
    const cid = newId('c');
    db.prepare('INSERT INTO changes (id, product, findings, status, created) VALUES (?, ?, ?, ?, ?)').run(cid, id, '[]', 'verifying', Date.now());
    const c: any = { id: cid, repo: p.repo, worktree: path.join(tmp, 'wt', cid), branch: `task/${cid}`, base: 'beta', request: '', criteria: [], findings: [] };
    const v: any = await A.verifyChange(c, p, []);
    assert.equal(v.outcome, 'not played', id);
    assert.equal(v.held, true, id);
    assert.equal(v.build, null, `${id}: no build of the branch`);
    assert.match(v.error, /held: Unity builds run once the milestone is complete/);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM builds WHERE product IN ('sou', 'leg')").get() as any).n, 0);
  assert.ok(!outside.some((u) => /gen/.test(u)), 'nothing reached Gen');
});

test('6. a build output cut short (b_86e7f3a869dc) is infrastructure, built once more on the same commit through its line', async () => {
  const BF = await import('../src/buildfail.ts');
  const BA = await import('../src/buildaccess.ts');
  const err = 'the Unity build failed: unpacking the build: gzip: stdin: unexpected end of file\ntar: Unexpected EOF in archive';
  const c = BF.classify(err, { stage: 'build' });
  assert.equal(c.kind, 'infrastructure');
  assert.doesNotMatch(c.plain, /Not recognised/);
  assert.equal(BA.failType(err, { stage: 'build', kind: c.kind }), 'transient');
  assert.equal(B.downloadTransient(new Error('unpacking the build: tar: Unexpected EOF')), true, 'the download is tried again first');
  // The retry: once, on the same commit and branch, as a retry (so it goes through buildOne's line like any start).
  const started: any[] = [];
  const saved = BA.hooks.start;
  BA.hooks.start = async (product, o) => { started.push({ product, ...o }); return null; };
  try {
    const first = await BA.handleFailure('b_trunc1', { product: 'sou', build: 'web', slug: 'x/sou', error: err, stage: 'build', kind: c.kind, attempt: 1, ref: 'beta', sha: sha('0') });
    assert.equal(first.handled, true);
    assert.equal(first.retry?.attempt, 2);
    await BA.fireRetry('sou', 'web');
    assert.deepEqual(started, [{ product: 'sou', build: 'web', ref: 'beta', sha: sha('0'), retry: 2 }]);
    // Cut short again: no third build, it is told.
    const second = await BA.handleFailure('b_trunc2', { product: 'sou', build: 'web', slug: 'x/sou', error: err, stage: 'build', kind: c.kind, attempt: 2, ref: 'beta', sha: sha('0') });
    assert.equal(second.handled, false);
    assert.equal(BA.retryState('sou', 'web'), undefined);
  } finally { BA.hooks.start = saved; BA.clearRetry('sou', 'web'); }
  // In the line: the retry of a commit already building joins it; one behind a newer waiting start never pushes it out.
  const key = B.lineOf('sou', 'web', { ref: 'beta' });
  const going = L.enterLine(key, sha('0')) as any;
  assert.equal(L.enterLine(key, sha('0'), { retry: true }).how, 'joined');
  L.enterLine(key, sha('8'));
  const retryOld = L.enterLine(key, sha('7'), { retry: true }) as any;
  assert.deepEqual(await retryOld.turn, { superseded: sha('8') });
  assert.deepEqual(L.lineState(key), { building: sha('0'), waiting: sha('8') });
  going.turn.end();
});
