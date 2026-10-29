// Tag builds (tagbuild.ts): a build-* tag pushed in a Unity source repo starts a beta run that asks Hawkes Gen for
// unity.build in GitHub mode (that commit, pushed to the website's beta, never main), then the beta website copy moves
// onto the pushed commit. A scratch database, a stand-in for Gen's build job and for GitHub's contents API; no real
// repo, Gen or GitHub is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tagbuild-'));
process.env.STUDIO_DATA = tmp;

const { db, newId, J } = await import('../src/db.ts');
const tb = await import('../src/tagbuild.ts');
const { waitingBetaRun, newerBetaRun } = await import('../src/betaqueue.ts');
const { buildsOnWindowsBox } = await import('../src/buildpkgs.ts');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const repos = { YoobaLand: 'jgriffith3433/YoobaLand', YoobaLandGame: 'jgriffith3433/YoobaLandGame', breakingthrough: 'jgriffith3433/breakingthrough', theplacedepartmentwebsite: 'jgriffith3433/theplacedepartmentwebsite' };
const yooba: any = { id: 'yoobaland', name: 'Yooba Land', repo: 'YoobaLand/YoobaLand', site: 'YoobaLandGame', build: { project: 'YoobaLand/YoobaLand', site: 'YoobaLandGame', method: 'YoobaWebBuild.FullDeploy', versionEnv: 'BUILD_VERSION' } };
const place: any = { id: 'theplacedepartment', name: 'The Place Department', repo: 'breakingthrough', site: 'theplacedepartmentwebsite', build: { project: 'breakingthrough', site: 'theplacedepartmentwebsite', method: 'WebGlBuild.FullDeploy' } };
const web: any = { id: 'phorigins', name: 'PH Origins', repo: 'phoriginswebsite', site: 'phoriginswebsite' };

test('only refs/tags/build-* start a build', () => {
  assert.equal(tb.buildTagOf('refs/tags/build-2026-10-28'), 'build-2026-10-28');
  assert.equal(tb.buildTagOf('refs/tags/build-v1.2_rc'), 'build-v1.2_rc');
  for (const ref of ['refs/heads/build-x', 'refs/tags/v1.0', 'refs/tags/build-', 'refs/tags/build-a b', 'refs/tags/rebuild-x', 'refs/tags/build-$(x)']) assert.equal(tb.buildTagOf(ref), null, ref);
});

test('the build params are GitHub mode: that commit, the website repo, beta', () => {
  const p = tb.tagBuildParams(yooba, { name: 'build-x', sha: SHA }, { repos, version: 9 });
  assert.deepEqual(p, {
    project: 'YoobaLand/YoobaLand', site: 'YoobaLandGame', method: 'YoobaWebBuild.FullDeploy', env: { BUILD_VERSION: '9' },
    github: { repo: 'jgriffith3433/YoobaLand', commit: SHA, ref: 'build-x', siteRepo: 'jgriffith3433/YoobaLandGame', branch: 'beta' },
  });
  // No versionEnv: the deploy method counts up from the website's beta, so no env.
  assert.equal('env' in tb.tagBuildParams(place, { name: 'build-x', sha: SHA }, { repos, version: 4 }), false);
  assert.throws(() => tb.tagBuildParams(place, { name: 'build-x', sha: 'abc' }, { repos }), /no commit sha/);
  assert.throws(() => tb.tagBuildParams(place, { name: 'build-x', sha: SHA }, { repos: {} }), /no GitHub repo/);
});

test('the version is past everything built and everything on the website', async () => {
  assert.equal(tb.nextVersion(0, []), 1);
  assert.equal(tb.nextVersion(12, [3, 7]), 13);
  assert.equal(tb.nextVersion(2, [3, 7]), 8);
  const asked: string[] = [];
  const fake = (async (url: string, init: any) => {
    asked.push(`${url} ${init.headers.Authorization ?? ''}`);
    return new Response(JSON.stringify([{ name: 'v7', type: 'dir' }, { name: 'v0000000', type: 'dir' }, { name: 'v8', type: 'file' }, { name: 'v12', type: 'dir' }]));
  }) as unknown as typeof fetch;
  assert.deepEqual(await tb.siteVersions('o/site', 'beta', fake, 'tok'), [7, 12]);
  assert.equal(asked[0], 'https://api.github.com/repos/o/site/contents/Game?ref=beta Bearer tok');
  assert.deepEqual(await tb.siteVersions('o/site', 'beta', (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch), []);
});

/** Stand-ins for the pipeline's steps, Gen's build job and the beta copy. */
function deps(job: any, over: Partial<import('../src/tagbuild.ts').TagBuildDeps> = {}) {
  const steps = new Map<string, any>();
  const builds: any[] = [];
  const settled: any[] = [];
  const d: import('../src/tagbuild.ts').TagBuildDeps = {
    startStep: (run, product, kind, name, detail = '') => { const id = newId('s'); steps.set(id, { run, product, kind, name, detail, status: 'running' }); return id; },
    updateStep: (id, patch) => { steps.set(id, { ...steps.get(id), ...patch }); },
    resumedStep: () => null,
    unityBuild: async (project, params, onUpdate, opts) => { builds.push({ project, params }); opts?.onSubmit?.('job-1'); onUpdate?.({ id: 'job-1', detail: 'building' }); return job; },
    builtMax: () => 5,
    versionsOn: async (_slug, ref) => (ref === 'beta' ? [6] : [4]),
    settle: async (_p, b) => { settled.push(b); },
    repos,
    ...over,
  };
  return { d, steps, builds, settled };
}

test('a tag build: Gen builds the commit, the copy settles on the pushed beta commit, the step says so', async () => {
  const pushed = { repo: 'jgriffith3433/YoobaLandGame', branch: 'beta', commit: 'f'.repeat(40), before: 'e'.repeat(40) };
  const f = deps({ id: 'job-1', status: 'done', cost: 0.18, result: { ok: true, version: '7', seconds: 600, github: { repo: 'jgriffith3433/YoobaLand' }, pushed } });
  const r = await tb.buildTag('r_1', yooba, { name: 'build-x', sha: SHA }, f.d);
  assert.equal(r.status, 'done');
  assert.equal(f.builds.length, 1);
  assert.equal(f.builds[0].params.github.branch, 'beta');
  assert.equal(f.builds[0].params.github.commit, SHA);
  assert.deepEqual(f.builds[0].params.env, { BUILD_VERSION: '7' }, 'past built v5, beta v6 and main v4');
  assert.deepEqual(f.settled, [{ sha: SHA, base: pushed.commit, job: 'job-1', version: '7', cost: 0.18, minutes: 10, tag: 'build-x' }]);
  const step = [...f.steps.values()][0];
  assert.equal(step.status, 'done');
  assert.match(step.detail, /built build-x \(0123456\) Game\/v7 in 10 min \(\$0\.18\), pushed to jgriffith3433\/YoobaLandGame beta fffffff/);
  assert.deepEqual(step.data.served, { sha: SHA, version: '7' });
  assert.equal(step.data.fingerprint, null, 'a tag build never stands in for beta\'s own build');
});

test('a tag build fails loudly: a failed job, an old Gen without GitHub mode, a push anywhere but beta', async () => {
  const failed = deps({ id: 'job-1', status: 'failed', error: 'Unity exited with code 1', result: { ok: false } });
  assert.equal((await tb.buildTag('r_2', place, { name: 'build-y', sha: SHA }, failed.d)).status, 'failed');
  assert.match([...failed.steps.values()][0].detail, /failed: Unity exited with code 1/);
  assert.equal(failed.settled.length, 0);
  assert.equal('env' in failed.builds[0].params, false);

  const old = deps({ id: 'job-1', status: 'done', result: { ok: true, version: '3' } });
  assert.equal((await tb.buildTag('r_3', place, { name: 'build-y', sha: SHA }, old.d)).status, 'failed');
  assert.match([...old.steps.values()][0].detail, /without GitHub mode/);
  assert.equal(old.settled.length, 0);

  const main = deps({ id: 'job-1', status: 'done', result: { ok: true, github: {}, pushed: { repo: 'o/s', branch: 'main', commit: 'a'.repeat(40) } } });
  assert.equal((await tb.buildTag('r_4', place, { name: 'build-y', sha: SHA }, main.d)).status, 'failed');
  assert.match([...main.steps.values()][0].detail, /pushed to main, not beta/);
  assert.equal(main.settled.length, 0);
});

test('a copy that will not move still leaves the build done, and says why', async () => {
  const f = deps({ id: 'job-1', status: 'done', result: { ok: true, github: {}, pushed: { repo: 'o/s', branch: 'beta', commit: 'b'.repeat(40) } } }, { settle: async () => { throw new Error('clone failed'); } });
  await tb.buildTag('r_5', place, { name: 'build-z', sha: SHA }, f.d);
  const step = [...f.steps.values()][0];
  assert.equal(step.status, 'done');
  assert.match(step.detail, /the beta website copy didn't move: clone failed/);
  assert.equal(step.data.served, undefined);
});

test('the hook: one beta run per Unity product in the repo, none for web repos, not twice for the same commit', async () => {
  const started: any[] = [];
  const start = (id: string, o: any) => {
    started.push({ id, ...o });
    const run = newId('r');
    db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(run, 'beta', 'running', `beta ${id}`, J([id]), J({ tag: o.tag, playtest: o.playtest }), Date.now());
    return { id: run };
  };
  const products = [yooba, place, web];
  const r = await tb.onBuildTag('breakingthrough', 'build-1', SHA, { start, products });
  assert.equal(r.ok, true);
  assert.deepEqual(started.map((s) => [s.id, s.tag, s.playtest, s.quiet]), [['theplacedepartment', { name: 'build-1', sha: SHA }, true, 0]]);
  const again = await tb.onBuildTag('breakingthrough', 'build-1', SHA, { start, products });
  assert.equal(started.length, 1, 'the same commit is not built twice while its run goes');
  assert.deepEqual(again.ok && again.runs, r.ok && r.runs);
  const none = await tb.onBuildTag('phoriginswebsite', 'build-1', SHA, { start, products });
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.ignored : '', /no Unity product/);
});

test('a tag run neither waits in nor supersedes the beta queue', () => {
  const ins = (options: Record<string, unknown>) => {
    const id = newId('r');
    db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'beta', 'running', 'beta q', J(['queueprod']), J(options), Date.now());
    return id;
  };
  const push = ins({ quiet: 1000 });
  const tag = ins({ tag: { name: 'build-q', sha: SHA }, playtest: true });
  assert.equal(waitingBetaRun('queueprod'), push, 'a push still finds the waiting push run, never the tag run');
  assert.equal(newerBetaRun(push, 'queueprod'), null, 'the newer tag run does not supersede the push run');
  void tag;
});

test('GitHub-mode builds never sync the Windows build server', async () => {
  let asked = false;
  assert.equal(await buildsOnWindowsBox({ project: 'breakingthrough', github: { repo: 'o/x' } }, () => {}, async () => { asked = true; return { backend: 'builder', projects: {} }; }), false);
  assert.equal(asked, false);
});

test('going live sees a tag build that is already committed on the website copy', async () => {
  const { spawnSync } = await import('node:child_process');
  const { unpublished } = await import('../src/golive.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unpub-'));
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'index.html'), 'live');
  g('add', '-A'); g('commit', '-qm', 'live');
  const main = g('rev-parse', 'HEAD');
  assert.equal(await unpublished(dir, main), false);
  fs.mkdirSync(path.join(dir, 'Game', 'v2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game', 'v2', 'x.js'), 'build');
  g('add', '-A'); g('commit', '-qm', 'Unity build');
  assert.equal(await unpublished(dir, main), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
