// Build failures that handle themselves (buildaccess.ts): the classifier, the retry with backoff (quiet until the last
// try fails), the ONE access card per project (de-duplicated, resolved and rebuilt when access is back) and the preflight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildaccess-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
const A = await import('../src/buildaccess.ts');
const F = await import('../src/buildfail.ts');
const { db } = await import('../src/db.ts');
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)');

const DISPATCH = `GitHub wouldn't start firebase.yml in jgriffith3433/hawkesgenwebsite: 403 {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/actions/workflows#create-a-workflow-dispatch-event"}`;

test('failType: transient, access and code', () => {
  assert.equal(A.failType(DISPATCH), 'access');
  assert.equal(A.failType('GitHub 404 Not Found: Studio has no GitHub access to a/b'), 'access');
  assert.equal(A.failType('a/b isn\'t installed'), 'access');
  assert.equal(A.failType('fetch failed: ECONNRESET'), 'transient');
  assert.equal(A.failType('GitHub answered 502 Bad Gateway'), 'transient');
  assert.equal(A.failType('GitHub 403 API rate limit exceeded for installation'), 'transient');
  assert.equal(A.failType('secondary rate limit', {}), 'transient');
  assert.equal(A.failType('something odd', { stage: 'checkout' }), 'transient');
  assert.equal(A.failType('a/b has no beta or main branch on GitHub', { stage: 'checkout' }), 'other');
  assert.equal(A.failType('error CS0102 duplicate', { kind: 'code' }), 'code');
  assert.equal(A.failType('Not recognised: ?'), 'other');
});

test('access cause names the permission and the fix, not "access or install"', () => {
  const c = A.accessCause(DISPATCH)!;
  assert.equal(c.permission, 'Actions: write');
  assert.equal(c.workflow, 'firebase.yml');
  const plain = F.classify(DISPATCH, { stage: 'checkout', slug: 'jgriffith3433/hawkesgenwebsite' });
  assert.equal(plain.class, 'access');
  assert.match(plain.plain, /Actions: write/);
  assert.match(plain.plain, /firebase\.yml/);
  assert.doesNotMatch(plain.plain, /access or install/);
  assert.match(A.accessFix(A.accessCause('x isn\'t installed')!, 'a/b'), /installed on a\/b/);
});

let started: any[] = [];
let told: string[] = [];
A.hooks.start = async (product, o) => { started.push({ product, ...o }); };
A.hooks.notify = async (title) => { told.push(title); };
let ver = 0;
const row = (id: string, product = 'p1', build = 'web') => db.prepare("INSERT INTO builds (id, product, build, version, status, runner, target, started) VALUES (?, ?, ?, ?, 'failed', 'studio', 'web', ?)").run(id, product, build, ++ver, Date.now());

test('transient: retried twice with backoff, quiet until the last try fails', async () => {
  row('b_aa01');
  const first = await A.handleFailure('b_aa01', { product: 'p1', build: 'web', slug: 'a/b', error: 'fetch failed', attempt: 1 });
  assert.equal(first.handled, true);
  assert.equal(first.retry?.attempt, 2);
  assert.ok(first.retry!.inMs >= 60_000 && first.retry!.inMs <= 5 * 60_000);
  assert.equal(A.retryPending('b_aa01'), true); // the row isn't a failure yet: no card, no push
  assert.equal(F.failingBuilds('p1').length, 0);
  await A.fireRetry('p1', 'web');
  assert.deepEqual(started.map((s) => s.retry), [2]);
  row('b_aa02');
  const second = await A.handleFailure('b_aa02', { product: 'p1', build: 'web', slug: 'a/b', error: 'fetch failed', attempt: 2 });
  assert.equal(second.retry?.attempt, 3);
  assert.ok(second.retry!.inMs + first.retry!.inMs <= 12 * 60_000); // about ten minutes in all
  const last = await A.handleFailure('b_aa03', { product: 'p1', build: 'web', slug: 'a/b', error: 'fetch failed', attempt: 3 });
  assert.equal(last.handled, false); // all three failed: now it is told
  assert.equal(A.retryState('p1', 'web'), undefined);
  assert.equal(told.length, 0);
});

test('code failures are not handled here; the setting turns it all off', async () => {
  assert.equal((await A.handleFailure('b_x', { product: 'p1', build: 'web', slug: 'a/b', error: 'error CS0102', kind: 'code' })).handled, false);
  db.prepare("INSERT INTO settings (key, value, updated) VALUES ('builds', ?, ?)").run(JSON.stringify({ handleFailures: false }), Date.now());
  assert.equal((await A.handleFailure('b_x', { product: 'p1', build: 'web', slug: 'a/b', error: 'fetch failed' })).handled, false);
  db.prepare("DELETE FROM settings WHERE key = 'builds'").run();
  assert.equal(A.selfHandling(), true);
});

test('access: never retried, ONE card per project, resolved and rebuilt when access is back', async () => {
  started = [];
  let perms: Record<string, string> = { contents: 'write', actions: 'read' };
  A.probeHook.run = async () => ({ ok: true, permissions: perms, installId: 7, account: 'jgriffith3433', type: 'User', known: true });
  const h1 = await A.handleFailure('b_a1', { product: 'p2', build: 'firebase', slug: 'jgriffith3433/hawkesgenwebsite', error: DISPATCH });
  assert.equal(h1.handled, true);
  assert.equal(h1.type, 'access');
  assert.equal(A.retryState('p2', 'firebase'), undefined);
  await new Promise((r) => setImmediate(r));
  // The same project failing again (another build, the same build again): the same card, no second push.
  await A.handleFailure('b_a2', { product: 'p2', build: 'firebase', slug: 'jgriffith3433/hawkesgenwebsite', error: DISPATCH });
  await A.handleFailure('b_a3', { product: 'p2', build: 'web', slug: 'jgriffith3433/hawkesgenwebsite', error: DISPATCH });
  await new Promise((r) => setImmediate(r));
  const open = A.openAccess('p2');
  assert.equal(open.length, 1);
  assert.deepEqual(open[0].builds.sort(), ['firebase', 'web']);
  assert.equal(told.length, 1);
  assert.match(open[0].detail!, /Actions: write/);
  const links = await A.accessLinks(open[0]);
  assert.ok(Array.isArray(links));
  // Still missing: nothing happens.
  assert.equal((await A.recheckAccess({ product: 'p2', force: true }))[0].back, false);
  assert.equal(A.openAccess('p2').length, 1);
  assert.equal(started.length, 0);
  // The owner accepts the permission: the next look rebuilds by itself and resolves the card.
  perms = { contents: 'write', actions: 'write' };
  assert.equal((await A.recheckAccess({ product: 'p2', force: true }))[0].back, true);
  assert.equal(A.openAccess('p2').length, 0);
  assert.deepEqual(started.map((s) => s.build).sort(), ['firebase', 'web']);
});

test('preflight: shows the card before a build is started, and is quiet when the app can dispatch', async () => {
  told = [];
  A.probeHook.run = async () => ({ ok: true, permissions: { actions: 'read' }, installId: 7, account: 'o', type: 'Organization', known: true });
  const bad = await A.preflight('p3', 'firebase', 'o/r', 'firebase.yml');
  assert.equal(bad.ok, false);
  assert.match((bad as any).message, /Actions: write/);
  assert.equal(A.openAccess('p3').length, 1);
  await A.preflight('p3', 'firebase', 'o/r', 'firebase.yml'); // again: still one card
  assert.equal(A.openAccess('p3').length, 1);
  A.probeHook.run = async () => ({ ok: true, permissions: { actions: 'write' }, installId: 7, account: 'o', type: 'Organization', known: true });
  assert.equal((await A.preflight('p3', 'firebase', 'o/r', 'firebase.yml')).ok, true);
  assert.equal(A.openAccess('p3').length, 0); // the card from before is closed by the build that is starting
  A.probeHook.run = async () => ({ ok: false, permissions: null, installId: null, account: null, type: null, known: true });
  assert.equal((await A.preflight('p4', 'b', 'o/r', 'b.yml')).ok, false);
  assert.equal(A.openAccess('p4')[0].what, 'install');
  A.probeHook.run = async () => ({ ok: true, permissions: null, installId: null, account: null, type: null, known: false });
  assert.equal((await A.preflight('p5', 'b', 'o/r', 'b.yml')).ok, true); // can't tell: the build itself will say
});

// hawkes-games build 113 (2026-11-10): one function couldn't deploy because the region's CPU quota was used up (Studio's
// own agent jobs share it). It was called "the code" and a fix agent was started; it is capacity, and retried.
test('a Google Cloud quota error is infrastructure and retried, not a code fix', () => {
  const log = [
    'i  functions: updating Node.js 24 (2nd Gen) function portal:syncStarter(us-east4)...',
    'Could not create or update Cloud Run service syncstarter, Container Healthcheck failed. Quota exceeded for total allowable CPU per project per region.',
    '✔  functions[portal:api(us-east4)] Successful update operation.',
    '⚠  functions: Deploys failed. Skipping deletes.',
    'Error: There was an error deploying functions',
  ].join('\n');
  const d = F.digestLog(log, 'firebase deploy');
  assert.match(d.errors[0], /Quota exceeded/);
  const why = `firebase deploy to hawkes-staging failed (exit 2): ${d.errors.slice(0, 3).join(' | ')}`;
  const c = F.classify(why, { stage: 'build', log });
  assert.equal(c.kind, 'infrastructure');
  assert.match(c.plain, /not the code/);
  assert.equal(A.failType(why, { stage: 'build', kind: c.kind }), 'transient');
  // Without the quota line it is still the project's own failure.
  assert.equal(F.classify('firebase deploy to hawkes-staging failed (exit 2): Error: There was an error deploying functions', { stage: 'build' }).kind, 'code');
});
