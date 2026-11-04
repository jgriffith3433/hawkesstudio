// Build failures are visible and diagnosable (buildfail.ts; J, 2026-11-03: "if it's failing, why be in I know it's
// failing? ... why did we have to dig so hard to find this problem"). Classified (infrastructure vs code), the log Gen kept
// is stored on the build, J is told once (Inbox item + one push), Go live shows the attempts for the commit, and a later
// success clears the failure. No Gen, no GitHub: stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildfail-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
// Phone notifications on, to a stand-in server that counts them (never ntfy.sh).
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: true, server: 'http://notify.test', topic: 'hawkes-test' }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'bfgame', name: 'Build Fail Game', framing: 'test', engine: 'web', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/', github: 'acme/bfgame',
  local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  builds: [{ id: 'web', tool: 'unity', target: 'web' }],
}, {
  // A project whose build ids changed: "package" was removed, "release" is its only build now (Hawkes Net, 2026-11-03).
  id: 'bfrenamed', name: 'Build Renamed Game', framing: 'test', engine: 'web', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/', github: 'acme/bfrenamed',
  local: { serve: 'static', dir: 'site', port: 8798, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  builds: [{ id: 'release', tool: 'unity', target: 'web' }],
}] }));

const pushes: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).startsWith('http://notify.test')) { pushes.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
  return realFetch(url, init);
}) as any;

const { db } = await import('../src/db.ts');
const B = await import('../src/builds.ts');
const F = await import('../src/buildfail.ts');
const ib = await import('../src/inbox.ts');

let n = 0;
const row = (o: Record<string, unknown> = {}) => {
  const r = { id: `b_${(++n).toString(16).padStart(12, '0')}`, product: 'bfgame', build: 'web', version: n, status: 'building', sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', ref: 'beta', runner: 'gen', target: 'web', started: Date.now() - 20 * 60_000 + n, ...o };
  db.prepare(`INSERT INTO builds (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as any[]);
  return r.id as string;
};

test('failures are classified: infrastructure or code, in plain words', () => {
  const tok = F.classify('the Unity build failed: The GitHub token for this build is gone (Gen restarted, or it expired)', { tries: 4 });
  assert.equal(tok.class, 'token');
  assert.equal(tok.kind, 'infrastructure');
  assert.match(tok.plain, /infrastructure, not the code/i);
  assert.match(tok.plain, /tried 4 times/);
  const cs = F.classify('the Unity build failed: [GameDeploy] DEPLOY FAILED', { log: 'Assets/Foo.cs(12,5): error CS1002: ; expected\nBuild failed' });
  assert.equal(cs.class, 'compile');
  assert.equal(cs.kind, 'code');
  assert.match(cs.plain, /error CS1002/, 'the first compiler error is in the message');
  // sick-of-it-unity v13 (2026-11-03): Gen's source fetch failed and the Unity log's tail came after it; not the code.
  const fetch = F.classify("the Unity build failed: couldn't fetch jgriffith3433/sickofitgame-unity at bc65eafd322b (is the commit pushed, and can the GitHub token read the repo?): ##utp:{\"type\":\"MemoryLeaks\"}", { log: '[GameDeploy] CLOUD BUILD COMPLETE\nUnity exited with code 0' });
  assert.equal(fetch.class, 'token');
  assert.equal(fetch.kind, 'infrastructure');
  assert.equal(F.classify('Hawkes Gen finished job j_1, but Studio stopped before publishing it (its run interrupted); build again').class, 'restart');
  assert.equal(F.classify('timed out after 4 h in Hawkes Gen (job j_1 was still running); cancelled it').class, 'timeout');
  assert.equal(F.classify('the Unity build failed: Killed, out of memory').class, 'memory');
  assert.equal(F.classify('boom', { stage: 'publish' }).class, 'publish');
  // A bare "DEPLOY FAILED" with no compile error is not called a code problem or an infrastructure one: it says to read the log.
  const bare = F.classify('the Unity build failed: [GameDeploy] DEPLOY FAILED');
  assert.equal(bare.kind, 'unknown');
  assert.match(bare.plain, /log/i);
});

test('the log is the last ~200 lines of what Gen kept, with the compiler errors first', () => {
  const log = F.extractLog({ error: 'x', result: { errors: ['Foo.cs(1,1): error CS0103'], logTail: Array.from({ length: 500 }, (_, i) => `unity line ${i}`) }, log: Array.from({ length: 300 }, (_, i) => ({ text: `gen ${i}` })) });
  assert.match(log, /error CS0103/);
  assert.match(log, /unity line 499/);
  assert.doesNotMatch(log, /unity line 299\n/, 'only the tail');
  assert.match(log, /gen 299/);
  assert.equal(F.extractLog(null), '');
});

test('a failed build keeps class, kind, step, log and every Gen job; the push is sent ONCE', async () => {
  pushes.length = 0;
  const id = row();
  const jobs = [{ id: 'j_one', error: 'token is gone' }, { id: 'j_two', error: 'token is gone' }];
  F.recordFailure(id, new F.BuildFailure('the Unity build failed: The GitHub token for this build is gone', { jobs, log: '--- Hawkes Gen job log ---\nlast line' }), { stage: 'build' });
  const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as any;
  assert.equal(r.status, 'failed');
  assert.equal(r.fail_class, 'token');
  assert.equal(r.fail_kind, 'infrastructure');
  assert.equal(r.fail_step, 'build');
  assert.match(r.fail_log, /last line/);
  assert.equal(JSON.parse(r.gen_jobs).length, 2);
  assert.equal(await F.announce(id), true);
  assert.equal(await F.announce(id), false, 'told once per failure, not per look');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /Build Fail Game: build web \d+ failed/);
  assert.match(pushes[0].message, /Infrastructure/);
  const why = F.whyFailed(id)!;
  assert.match(why.log, /last line/);
  assert.equal(why.jobs[1].id, 'j_two');
  assert.equal(why.genJob, 'j_two');
  assert.equal(why.stepWords, 'building');
  assert.ok(why.seconds! > 0);
});

test('an agent change preview failing stays quiet; the project card and Inbox show the failure, a later success clears it', async () => {
  pushes.length = 0;
  const quiet = row({ change: 'c_preview' });
  F.recordFailure(quiet, 'boom', { stage: 'build' });
  assert.equal(await F.announce(quiet), false);
  assert.equal(pushes.length, 0);
  assert.ok(F.failingBuilds('bfgame').every((f) => f.id !== quiet), 'a preview is not the project\'s build');

  const failing = F.failingBuilds('bfgame');
  assert.equal(failing.length, 1, 'the newest attempt of web failed');
  const f = failing[0];
  assert.equal(f.kind, 'infrastructure');
  const items = (await ib.inbox()).filter((x) => x.kind === 'build');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `build:${f.id}`);
  assert.match(items[0].title, /build web \d+ failed/);
  assert.deepEqual(items[0].options, ['Build again', 'Dismiss']);

  // Dismiss hides the card; the failure stays on the project.
  await ib.answerInbox(items[0].id, 'Dismiss', 'J');
  assert.equal((await ib.inbox()).filter((x) => x.kind === 'build').length, 0);
  assert.equal(F.failingBuilds('bfgame').length, 1);

  // A newer build that works clears the badge, and a newer failure is a new card.
  const ok = row({ status: 'ready', finished: Date.now() });
  assert.ok(ok);
  assert.equal(F.failingBuilds('bfgame').length, 0);
  const again = row();
  F.recordFailure(again, 'the Unity build failed: error CS0246: type not found', { stage: 'build' });
  assert.equal(F.failingBuilds('bfgame')[0].kind, 'code');
  assert.equal((await ib.inbox()).filter((x) => x.kind === 'build').length, 1);
});

test('Go live gets the attempts at the commit, not just "build first"', () => {
  const sha = 'f'.repeat(40);
  assert.match(F.attemptsLine(F.attemptsAt('bfgame', sha)), /never built/);
  const a = row({ sha });
  F.recordFailure(a, 'the Unity build failed: The GitHub token for this build is gone', { stage: 'build' });
  const b = row({ sha });
  F.recordFailure(b, 'the Unity build failed: error CS0246', { stage: 'build' });
  const list = F.attemptsAt('bfgame', sha);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b, 'newest first');
  const line = F.attemptsLine(list);
  assert.match(line, /tried 2 times and failed \(the code\)/);
  assert.match(line, /error CS0246/);
  const live = row({ sha: 'e'.repeat(40) });
  assert.match(F.attemptsLine(F.attemptsAt('bfgame', 'e'.repeat(40))), /being built right now/);
  assert.ok(live);
});

test('a build Gen lost, settled later (reconcile), keeps the reason and its log, and tells J once', async () => {
  pushes.length = 0;
  const run = 'r_bf0000000001';
  db.prepare("INSERT INTO runs (id, kind, status, started) VALUES (?, 'build', 'stopped', ?)").run(run, Date.now());
  const id = row({ run, gen_job: 'j_lost' });
  const out = await B.reconcileBuilds({ product: 'bfgame', job: async () => ({ id: 'j_lost', status: 'failed', error: 'worker preempted', log: ['one', 'two', 'last gen line'] }) });
  assert.ok(out.some((x) => x.job === 'j_lost'));
  await new Promise((r) => setTimeout(r, 50));
  const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as any;
  assert.equal(r.status, 'failed');
  assert.match(r.fail_log, /last gen line/);
  assert.equal(r.fail_kind, 'infrastructure');
  assert.equal(JSON.parse(r.gen_jobs)[0].id, 'j_lost');
  // The earlier test's unfinished row was settled by the same look, so two failures, two pushes: one each.
  assert.equal(pushes.length, out.length);
});

test('a build id the project no longer has is not a failure any more; Build again never names it', async () => {
  pushes.length = 0;
  const gone = row({ product: 'bfrenamed', build: 'package', started: Date.now() - 3 * 24 * 3600_000, status: 'failed', finished: Date.now() - 3 * 24 * 3600_000 });
  F.recordFailure(gone, 'the Unity build failed: Hawkes Net has no hosted site here', { stage: 'build' });
  assert.equal(F.failingBuilds('bfrenamed').length, 0, 'package is not in the builds list any more');
  assert.equal((await ib.inbox()).filter((x) => x.kind === 'build' && x.product === 'bfrenamed').length, 0, 'its Inbox card is gone too');
  // The configured build's own failure still shows, with a Build again that names a build that exists.
  const rel = row({ product: 'bfrenamed', build: 'release', started: Date.now() - 60_000, status: 'failed', finished: Date.now() - 60_000 });
  F.recordFailure(rel, 'the Unity build failed: error CS0246: type not found', { stage: 'build' });
  const shown = F.failingBuilds('bfrenamed');
  assert.deepEqual(shown.map((f) => f.build), ['release']);
  assert.equal(F.configuredBuilds('bfrenamed')!.has(shown[0].build), true);
  // A product this Studio doesn't know keeps its failures (nothing to compare with).
  assert.equal(F.configuredBuilds('no-such-product'), null);
  assert.ok(gone);
});

test('a later success of the same build clears its earlier failure, and a success of another build does not', async () => {
  const t = Date.now() - 5 * 3600_000;
  // "web" fails, then "web" builds fine later on beta: the failure is superseded.
  const oldFail = row({ product: 'bfgame', build: 'web', started: t, status: 'failed', finished: t + 1000 });
  F.recordFailure(oldFail, 'the Unity build failed: error CS0246: type not found', { stage: 'build' });
  const fixed = row({ product: 'bfgame', build: 'web', started: t + 60_000, status: 'ready', finished: t + 120_000, ref: 'beta' });
  assert.ok(fixed);
  assert.ok(F.failingBuilds('bfgame').every((f) => f.id !== oldFail), 'superseded by the later success');
  // A different build of the same project working does not clear a failing one.
  const other = row({ product: 'bfrenamed', build: 'release', started: t, status: 'failed', finished: t + 1000 });
  F.recordFailure(other, 'the Unity build failed: error CS0246: type not found', { stage: 'build' });
  const ok = row({ product: 'bfrenamed', build: 'release', started: t + 60_000, status: 'ready', finished: t + 120_000 });
  assert.ok(ok);
  assert.ok(F.failingBuilds('bfrenamed').every((f) => f.id !== other), 'superseded by the later success of the same build');
});


test('a failed npm build keeps the real error and its step, not Vite\'s chunk-size warnings (Dose of Destruction v7-v11)', () => {
  const log = [
    '> dod@1.0.0 build', '> vite build', 'vite v6 building for production...',
    '(!) Some chunks are larger than 500 kB after minification. Consider:',
    '- Using dynamic import() to code-split the application',
    '- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks',
    '- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.',
    "cp: cannot create hard link 'dist/releases.json' to 'releases.json': File exists",
  ].join('\n');
  const d = F.digestLog(log, 'npm run build && cp -al releases.json dist/');
  assert.match(d.errors[0], /cannot create hard link 'dist\/releases.json'/);
  assert.equal(d.errors.some((e) => /manualChunks/.test(e)), false);
  assert.equal(d.step, 'cp');
  const msg = `npm run build && cp -al releases.json dist/ failed (exit 1), at cp: ${d.errors[0]}`;
  const c = F.classify(msg);
  assert.equal(c.class, 'script');
  assert.equal(c.kind, 'code');
  assert.match(c.plain, /hard link/);
  // The whole log stays on the row for "Why did this fail?".
  const id = row({ product: 'bfgame', build: 'web', started: Date.now() + 5000 });
  F.recordFailure(id, new F.BuildFailure(msg, { jobs: [], log }), { stage: 'build' });
  const why = F.whyFailed(id)!;
  assert.equal(why.hasLog, true);
  assert.match(why.log, /manualChunks/);
  assert.equal(why.class, 'script');
});

// Gen's job log says "[Hawkes] Unity exited with code 0" on a build that went fine (J, 2026-11-04): that is no compile
// failure, and Gen's "couldn't fetch <repo> at <commit>" is the source never arriving (infrastructure: build again).
test('"Unity exited with code 0" in the log is not a compile failure; a non-zero exit is', () => {
  const ok = F.classify('the Unity build failed: [GameDeploy] DEPLOY FAILED', { log: '[Hawkes] Unity exited with code 0\n[GameDeploy] DEPLOY FAILED' });
  assert.notEqual(ok.class, 'compile', 'exit 0 is not a compile error');
  assert.equal(ok.kind, 'unknown', 'a bare DEPLOY FAILED says read the log, not "the code"');
  const bad = F.classify('the Unity build failed: Unity exited with code 1', { log: '[Hawkes] Unity exited with code 1' });
  assert.equal(bad.class, 'compile');
  assert.equal(bad.kind, 'code');
  assert.equal(F.classify('the Unity build failed: Unity exited with code 10').class, 'compile', 'two-digit codes are failures too');
  assert.equal(B.infraLost('Hawkes Gen finished job j_9 with status failed'), false);
  assert.equal(B.infraLost('Unity exited with code 0'), false);
  assert.equal(B.infraLost('Unity exited with code 1'), false, 'a Unity exit is the project, never infrastructure');
  assert.equal(B.tokenLost('Unity exited with code 0'), false);
});

test("a Gen fetch failure without the token wording is infrastructure, and says a re-run is the fix", () => {
  const f = F.classify("the Unity build failed: couldn't fetch acme/bfgame at a1b2c3d4e5f6 (is the commit pushed?)", { log: '[Hawkes] Unity exited with code 0' });
  assert.equal(f.class, 'token');
  assert.equal(f.kind, 'infrastructure');
  assert.match(f.plain, /re-running the build is the fix/);
  assert.doesNotMatch(f.plain, /someone has to fix the code/i);
  assert.ok(B.tokenLost("couldn't fetch acme/bfgame at a1b2c3d4e5f6 (is the commit pushed?)"));
  // A real compile error is not a token problem.
  assert.equal(B.tokenLost('Assets/Foo.cs(3,1): error CS1002: ; expected'), false);
});
