// J, 2026-11-08: Sick of It's milestone check played a stale build and still counted.
// 1. a beta run of a Unity project Studio builds builds beta's head first (or waits for the build running), then plays;
// 2. a task's build is ok only for a run that built a commit including its merge;
// 3. the report names the commit the played build was made from;
// 4. a run whose milestone scenarios were skipped as "no scenario" is not a milestone check.
// A scratch database and a fixture product; no GitHub, Gen or browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-betaunity-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { sou: 'x/sou' },
  products: [{
    id: 'sou', name: 'Sick of It (Unity)', framing: 'test', engine: 'unity', repo: 'sou', site: 'sou', github: 'x/sou', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'sou', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
    builds: [{ id: 'web', tool: 'unity', target: 'web' }],
  }, {
    id: 'plain', name: 'Plain', framing: 'test', engine: 'static', repo: 'sou', site: 'sou', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'sou', port: 8797, path: '/' }, playtests: [], story: [], about: 'A fixture.',
  }],
  infra: [],
}));

const { db, J, newId } = await import('../src/db.ts');
await import('../src/builds.ts'); // the builds table
const BB = await import('../src/betabuild.ts');
const pm = await import('../src/pm.ts');
const { getProduct } = await import('../src/config.ts');
const { buildReport } = await import('../src/report.ts').catch(() => ({ buildReport: null as any }));

const HEAD = 'c'.repeat(40), OLD = 'a'.repeat(40);
const run = (status = 'done', kind = 'beta') => { const id = newId('r'); db.prepare('INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, status, 'x', J(['sou']), Date.now(), Date.now()); return id; };
const row = (o: { sha: string; status: string; run?: string | null; version: number; detail?: string; started?: number }) => {
  const id = newId('b');
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, started, detail) VALUES (?, 'sou', 'web', ?, ?, ?, 'beta', 'gen', 'web', ?, ?, ?)").run(id, o.version, o.status, o.sha, o.run ?? null, o.started ?? Date.now(), o.detail ?? null);
  return id;
};
const step = (r: string, kind: string, name: string, status: string, data: unknown = null, detail = '') => {
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(newId('s'), r, 'sou', kind, name, status, detail, data ? J(data) : null, Date.now());
};

test('a Unity project Studio builds is told apart from one with its own build batch or none', () => {
  assert.equal(BB.unityBuildOf(getProduct('sou'))?.id, 'web');
  assert.equal(BB.unityBuildOf(getProduct('plain')), null);
  assert.equal(BB.unityBuildOf({ build: { project: 'x' }, github: 'x/y', builds: [{ id: 'w', tool: 'unity' }] }), null, 'products.json `build` keeps its own path');
});

test('1. beta already published: nothing is built', async () => {
  row({ sha: HEAD, status: 'ready', version: 1 });
  let started = 0;
  const r = await BB.ensureBetaBuild('sou', 'web', { head: async () => HEAD, start: async () => { started++; return null; } });
  assert.equal(r.ok, true);
  assert.equal(r.how, 'already built');
  assert.equal(started, 0);
  db.prepare('DELETE FROM builds').run();
});

test('1. an older published build starts the build of beta\'s head and plays only after it is published', async () => {
  row({ sha: OLD, status: 'ready', version: 1 });
  assert.equal(BB.publishedBuild('sou', 'web')?.sha, OLD);
  const order: string[] = [];
  const listeners = new Set<(t: string) => void>();
  const r = await BB.ensureBetaBuild('sou', 'web', {
    head: async () => HEAD,
    on: (fn) => { listeners.add(fn); return () => void listeners.delete(fn); },
    start: async (sha) => {
      order.push(`start ${sha.slice(0, 1)}`);
      // The Unity build "runs", then publishes its row, which is what the waiting run hears.
      setTimeout(() => { order.push('published'); row({ sha, status: 'ready', version: 2 }); for (const f of listeners) f('builds'); }, 20);
      return { id: 'r_build', done: new Promise(() => {}) };
    },
  });
  assert.deepEqual(order, ['start c', 'published']);
  assert.equal(r.ok, true);
  assert.equal(r.how, 'built');
  assert.equal(r.sha, HEAD);
  assert.equal(r.version, 2);
  db.prepare('DELETE FROM builds').run();
});

test('1. a build already running for beta\'s head is waited for, not started twice', async () => {
  const live = run('running', 'build');
  const id = row({ sha: HEAD, status: 'building', version: 3, run: live });
  const listeners = new Set<(t: string) => void>();
  let started = 0;
  const p = BB.ensureBetaBuild('sou', 'web', { head: async () => HEAD, start: async () => { started++; return null; }, on: (fn) => { listeners.add(fn); return () => void listeners.delete(fn); } });
  setTimeout(() => { db.prepare("UPDATE builds SET status = 'ready' WHERE id = ?").run(id); for (const f of listeners) f('builds'); }, 20);
  const r = await p;
  assert.equal(started, 0);
  assert.equal(r.ok, true);
  assert.equal(r.how, 'waited for a build');
  assert.equal(r.version, 3);
  db.prepare('DELETE FROM builds').run();
});

test('1. a failed build, or one that was never recorded, fails the run\'s build step: nothing is played', async () => {
  const listeners = new Set<(t: string) => void>();
  const bad = await BB.ensureBetaBuild('sou', 'web', {
    head: async () => HEAD,
    on: (fn) => { listeners.add(fn); return () => void listeners.delete(fn); },
    start: async (sha) => { setTimeout(() => { row({ sha, status: 'failed', version: 4, detail: 'Unity exited with code 1', started: Date.now() + 5 }); for (const f of listeners) f('builds'); }, 20); return { id: 'r_b', done: new Promise(() => {}) }; },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /failed.*Unity exited with code 1/);
  db.prepare('DELETE FROM builds').run();
  const none = await BB.ensureBetaBuild('sou', 'web', { head: async () => HEAD, start: async () => ({ id: 'r_c', done: Promise.resolve() }) });
  assert.equal(none.ok, false);
  assert.match(none.detail, /didn't happen/);
  const noHead = await BB.ensureBetaBuild('sou', 'web', { head: async () => null, start: async () => null });
  assert.equal(noHead.ok, false);
  const late = await BB.ensureBetaBuild('sou', 'web', { head: async () => HEAD, start: async () => ({ id: 'r_d', done: new Promise(() => {}) }), maxMs: 30 });
  assert.equal(late.ok, false);
  assert.match(late.detail, /still not built/);
});

test('2. a task\'s build is ok only when the run built a commit that includes its merge', async () => {
  assert.deepEqual(BB.buildProof({ unity: false, built: null, includes: null }), { ok: true, why: null }, 'other products are as before');
  assert.equal(BB.buildProof({ unity: true, built: null, includes: null }).ok, false, 'no build step: built nothing');
  assert.match(BB.buildProof({ unity: true, built: null, includes: null }).why!, /built nothing/);
  assert.equal(BB.buildProof({ unity: true, built: { sha: OLD }, includes: false }).ok, false);
  assert.match(BB.buildProof({ unity: true, built: { sha: OLD }, includes: false }).why!, /aaaaaaa.*doesn't include/);
  assert.equal(BB.buildProof({ unity: true, built: { sha: OLD }, includes: null }).ok, false, 'unconfirmed is not ok');
  assert.equal(BB.buildProof({ unity: true, built: { sha: HEAD }, includes: true }).ok, true);
  assert.equal(BB.containsMerge('ahead'), true);
  assert.equal(BB.containsMerge('identical'), true);
  assert.equal(BB.containsMerge('behind'), false);
  assert.equal(BB.containsMerge('diverged'), false);
  const gh = (status: string) => async () => new Response(JSON.stringify({ status }), { status: 200 });
  assert.equal(await BB.includesMerge('x/sou', 'm', 'b', gh('ahead') as any), true);
  assert.equal(await BB.includesMerge('x/sou', 'm', 'b', gh('behind') as any), false);
  assert.equal(await BB.includesMerge('x/sou', 'm', 'b', async () => new Response('no', { status: 500 })), null);
  assert.equal(await BB.includesMerge('x/sou', 'same', 'same', async () => { throw new Error('not asked'); }), true);

  // The run of the case: a beta run with no build step. Its build is not ok, and says why, and isn't the task's failure.
  const r = run();
  step(r, 'playtest', 'smoke@local', 'done');
  const t: any = { id: 'tk', product: 'sou', change: null };
  const proof = await pm.proofFor('sou', t, r, { merge: async () => ({ slug: 'x/sou', sha: 'm' }) });
  const b = pm.buildOf('sou', { id: r, status: 'done', finished: Date.now() }, proof);
  assert.equal(b.ok, false);
  assert.equal(b.unproven, true);
  assert.equal(b.unity, true);
  assert.match(b.detail, /built nothing/);

  // A run that built the head: ok only when that commit includes the merge.
  const r2 = run();
  step(r2, 'build', 'web', 'done', { built: { sha: HEAD, version: 5, run: 'r_x', how: 'built' } });
  const yes = pm.buildOf('sou', { id: r2, status: 'done', finished: Date.now() }, await pm.proofFor('sou', t, r2, { merge: async () => ({ slug: 'x/sou', sha: 'm' }), includes: async () => true }));
  assert.equal(yes.ok, true);
  const no = pm.buildOf('sou', { id: r2, status: 'done', finished: Date.now() }, await pm.proofFor('sou', t, r2, { merge: async () => ({ slug: 'x/sou', sha: 'm' }), includes: async () => false }));
  assert.equal(no.ok, false);
  assert.match(no.detail, /doesn't include/);
  // A kept build (the step skipped as "already built") counts the same way.
  const r3 = run();
  step(r3, 'build', 'web', 'skipped', { built: { sha: HEAD, version: 5, how: 'already built' } });
  assert.deepEqual(BB.builtBy(r3, 'sou'), { sha: HEAD, version: 5 });
  // Other projects: no proof asked.
  assert.equal(await pm.proofFor('plain', t, r), undefined);
});

test('2b. a build that broke is a failed build sent back to an agent, never "built nothing" (r_95635a34fb83)', async () => {
  // Yooba Land, 2026-11-11: the build step failed its size guard; the run was read as having no build step, nobody was
  // told, and the PM built the same commit again and again while 13 merged tasks waited.
  const r = run('failed');
  step(r, 'build', 'web', 'failed', null, 'the build of beta a36c67b failed (web 95): size guard: the lazy region downloads 110.8 MB, over the 90.0 MB guard');
  const t: any = { id: 'tk2', product: 'sou', change: null };
  assert.equal(BB.buildFailedIn(r, 'sou'), true);
  const proof = await pm.proofFor('sou', t, r, { merge: async () => ({ slug: 'x/sou', sha: 'm' }) });
  assert.equal(proof, undefined, 'no "built nothing" proof for a build that broke');
  const b = pm.buildOf('sou', { id: r, status: 'failed', finished: Date.now() }, proof);
  assert.equal(b.ok, false);
  assert.notEqual(b.unproven, true, 'a broken build is the task\'s failure to fix, not unproven');
  assert.match(b.detail, /beta's build failed.*size guard/);
  // A verdict read before the fix ("built nothing" for that same run) is read again; a right one is left alone.
  assert.equal(pm.buildToRead({ ok: false, unproven: true, run: r, at: 1, detail: 'not built by beta run: built nothing' } as any, r, 'sou'), true);
  assert.equal(pm.buildToRead(b, r, 'sou'), false);
  assert.equal(pm.buildToRead(b, 'r_newer', 'sou'), true);
  // A run that really had no build step is still "built nothing".
  const none = run();
  step(none, 'playtest', 'smoke@local', 'done');
  assert.equal(BB.buildFailedIn(none, 'sou'), false);
  const nb = pm.buildOf('sou', { id: none, status: 'done', finished: Date.now() }, await pm.proofFor('sou', t, none, { merge: async () => ({ slug: 'x/sou', sha: 'm' }) }));
  assert.match(nb.detail, /built nothing/);
  assert.equal(pm.buildToRead(nb, none, 'sou'), false, 'and not read again and again');
  // A cancelled build is neither (cancel.ts settles it): not a failure.
  const c = run();
  step(c, 'build', 'web', 'cancelled');
  assert.equal(BB.buildFailedIn(c, 'sou'), false);
});

test('3. a played build is named by the commit it was made from, in the report', () => {
  row({ sha: OLD, status: 'ready', version: 1 });
  row({ sha: HEAD, status: 'ready', version: 2, started: Date.now() + 10 });
  const pub = BB.publishedBuild('sou', 'web')!;
  assert.equal(pub.sha, HEAD);
  assert.equal(pub.version, 2);
  const src = fs.readFileSync(new URL('../src/report.ts', import.meta.url), 'utf8');
  assert.match(src, /pl\.madeFrom \? 'a build made from'/);
  const beta = fs.readFileSync(new URL('../src/beta.ts', import.meta.url), 'utf8');
  assert.match(beta, /madeFrom\?: boolean/);
  void buildReport;
});

test('4. a run whose scenarios were skipped as "no scenario" is not a milestone check', () => {
  const r = run();
  step(r, 'playtest', 'net-outage@local', 'skipped', { missingScenario: 'net-outage', has: ['smoke'] }, 'skipped: beta has no scenario "net-outage"');
  step(r, 'playtest', 'smoke@local', 'done', { outcome: 'pass' });
  assert.deepEqual(BB.missingScenarioSkips(r, 'sou'), [{ name: 'net-outage@local', scenario: 'net-outage' }]);
  const ok = run();
  step(ok, 'playtest', 'smoke@local', 'done', { outcome: 'pass' });
  assert.deepEqual(BB.missingScenarioSkips(ok), []);
  // The PM's own view of a broken check agrees (it is played again), and a Unity run with no build is broken too.
  assert.match(pm.brokenCheck(r, 'sou') ?? '', /net-outage|skipped/);
  assert.match(pm.brokenCheck(ok, 'sou') ?? '', /built nothing/);
  const built = run();
  step(built, 'build', 'web', 'done', { built: { sha: HEAD, version: 2 } });
  step(built, 'playtest', 'smoke@local', 'done', { outcome: 'pass' });
  assert.equal(pm.brokenCheck(built, 'sou'), null);
});
