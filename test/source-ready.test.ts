// Agents and scouts on the big Unity repos must really have the game's source (J, 2026-11-02: only the top-level files
// came through, every task ended "the agent made no commit"). Real git, a local "remote": no network, no GitHub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as O from '../src/outcomes.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-source-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ repos: {}, products: [], infra: [{ id: 'hawkesstudio', name: 'Hawkes Studio', repo: 'hawkesstudio', slug: 'x/hawkesstudio' }] }));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const S = await import('../src/source-ready.ts');
const I = await import('../src/infra-failure.ts');
const A = await import('../src/agents.ts');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const run = async (cwd: string, args: string[]) => {
  const r = spawnSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const put = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

// A Unity-shaped repo: root files, code, settings, and art.
const origin = path.join(tmp, 'origin');
fs.mkdirSync(origin);
git(origin, 'init', '-q', '-b', 'beta');
put(origin, 'AGENTS.md', '# agents\n');
put(origin, 'hawkes.assets.json', '{}');
put(origin, 'Game/Assets/ignored.txt', 'x');
put(origin, 'Assets/Scripts/Player.cs', 'public class Player {}\n');
put(origin, 'Assets/Scripts/Enemy.cs', 'public class Enemy {}\n');
put(origin, 'Assets/GameConfig/levels.json', '{"levels":[]}');
put(origin, 'Assets/Art/hero.png', 'PNGDATA'.repeat(100));
put(origin, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0\n');
git(origin, 'add', '-A');
git(origin, 'commit', '-q', '-m', 'init');
git(origin, 'config', 'uploadpack.allowFilter', 'true');
git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

/** Studio's light clone (repos.ts syncGit): partial, root files only; then a worktree for the agent. */
function lightWorktree(name: string) {
  const clone = path.join(tmp, `clone-${name}`);
  git(tmp, 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${origin}`, clone);
  git(clone, 'config', 'hawkes.light', 'true');
  git(clone, 'sparse-checkout', 'set', '--cone');
  git(clone, 'checkout', '-q', 'beta');
  const wt = path.join(tmp, `wt-${name}`);
  git(clone, 'worktree', 'add', '-q', '-b', `task/${name}`, wt, 'origin/beta');
  return { clone, wt };
}

test('a light worktree has only the root files, and the probe says so with the exact finding', () => {
  const { wt } = lightWorktree('a');
  assert.ok(fs.existsSync(path.join(wt, 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(wt, 'Assets', 'Scripts', 'Player.cs')), 'the bug: no source in the worktree');
  const p = S.probeSource(wt);
  assert.equal(p.ok, false);
  assert.match(p.reason!, /^source missing: \d+ tracked files, but Assets\/Scripts\/(Enemy|Player)\.cs/);
  assert.match(p.reason!, /sparse checkout that never got the source/);
  assert.ok(I.isInfraText(S.sourceError('the worktree', p)), 'and that is Studio\'s failure, not the agent\'s');
});

test('populateSource checks the source out through Studio\'s git: code, config and settings in, art out', async () => {
  const { wt } = lightWorktree('b');
  const lines: string[] = [];
  const p = await S.populateSource(wt, run, { unity: true, log: (m) => lines.push(m) });
  assert.equal(p.ok, true, p.reason);
  assert.equal(fs.readFileSync(path.join(wt, 'Assets', 'Scripts', 'Player.cs'), 'utf8'), 'public class Player {}\n');
  assert.ok(fs.existsSync(path.join(wt, 'Assets', 'GameConfig', 'levels.json')));
  assert.ok(fs.existsSync(path.join(wt, 'ProjectSettings', 'ProjectVersion.txt')));
  assert.ok(!fs.existsSync(path.join(wt, 'Assets', 'Art', 'hero.png')), 'big binaries stay out (memory)');
  assert.ok(fs.existsSync(path.join(wt, 'AGENTS.md')));
  assert.match(lines.join('\n'), /source is checked out in the worktree/);
  // Already populated: nothing to do, no git call.
  let calls = 0;
  const again = await S.populateSource(wt, async (...a) => { calls++; return run(...a); }, { unity: true });
  assert.ok(again.ok);
  assert.equal(calls, 0);
  // The agent can commit there: `git add -A` sees its edit, and the art is not reported as deleted.
  put(wt, 'Assets/Scripts/Player.cs', 'public class Player { int hp; }\n');
  git(wt, 'add', '-A');
  assert.match(git(wt, 'diff', '--cached', '--name-status'), /^M\s+Assets\/Scripts\/Player\.cs$/);
});

test('a populate that fails says why, and the preflight refuses to start the agent', async () => {
  const { wt } = lightWorktree('c');
  const p = await S.populateSource(wt, async () => ({ ok: false, out: '', err: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }), { unity: true });
  assert.equal(p.ok, false);
  assert.match(p.reason!, /^source unreadable: sparse-checkout of the source failed: fatal: could not read Username/);
  const c = { worktree: wt, product: 'nope', infra: false } as any;
  // The real preflight (beta.ts gitAsync) on a light worktree populates it and passes.
  const { wt: wt2 } = lightWorktree('c2');
  await A.ensureSourceReady('c_none', { worktree: wt2, product: 'nope', infra: false } as any, () => {});
  assert.ok(fs.existsSync(path.join(wt2, 'Assets', 'Scripts', 'Player.cs')));
});

test('the probe: empty checkout, not a worktree, a Unity tree with no code, LFS pointers', () => {
  assert.match(S.probeSource(path.join(tmp, 'nowhere')).reason!, /source unreadable: .* is not a git worktree/);
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty); git(empty, 'init', '-q');
  assert.match(S.probeSource(empty).reason!, /source missing: git ls-files lists 0 files/);
  const noCode = path.join(tmp, 'nocode'); fs.mkdirSync(noCode); git(noCode, 'init', '-q');
  put(noCode, 'Assets/a.png', 'x'); put(noCode, 'README.md', 'x'); git(noCode, 'add', '-A');
  assert.match(S.probeSource(noCode).reason!, /no \.cs file among them/);
  const lfs = path.join(tmp, 'lfs'); fs.mkdirSync(lfs); git(lfs, 'init', '-q');
  put(lfs, 'Assets/A.cs', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n'); git(lfs, 'add', '-A');
  assert.equal(S.probeSource(lfs).ok, false, 'a pointer is not source');
  const docs = path.join(tmp, 'docs'); fs.mkdirSync(docs); git(docs, 'init', '-q'); put(docs, 'README.md', 'hi'); git(docs, 'add', '-A');
  assert.equal(S.probeSource(docs).ok, true, 'a repo with no source files at all passes on its root files');
});

test('no commit + the source unreadable or missing is Studio\'s failure, not the agent\'s try', () => {
  const { wt } = lightWorktree('d');
  const c = { worktree: wt, product: 'nope', infra: false } as any;
  const lost = A.sourceLost(c, 'I made no changes.')!;
  assert.match(lost, /^source missing: .*\(the agent made no commit; not counted as a try\)$/);
  assert.ok(I.infraFailed({ status: 'failed', detail: lost }), 'classified as infra');
  assert.ok(I.INFRA_PHRASES.includes('source missing'));
  // The worktree is fine but the agent says it couldn't read the repo.
  put(wt, 'Assets/Scripts/Player.cs', 'class P {}');
  git(wt, 'sparse-checkout', 'set', '--no-cone', ...S.UNITY_SOURCE_PATTERNS);
  const said = A.sourceLost({ ...c }, "git show origin/beta:Assets/X.cs failed: fatal: could not read Username for 'https://github.com'")!;
  assert.match(said, /^source unreadable: the agent made no commit and said it could not read the repo/);
  assert.ok(I.isInfraText(said));
  // The worktree is fine and the agent just did nothing: the agent's own failure (a real try; the owner may be asked).
  assert.equal(A.sourceLost(c, 'The change is already done.'), null);
  assert.equal(A.sourceLost({ ...c, infra: true }, 'could not read Username'), null, 'Studio/Gen changes are not Unity repos');
  assert.ok(!I.isInfraText('the agent made no commit'));
});

test('a Cloud Run pass with a sparse server-side worktree and an agent saying "already done" ends already done, not source missing', () => {
  const { wt } = lightWorktree('job');
  const c = { worktree: wt, product: 'nope', infra: false } as any;
  const said = 'The task is already done: the change is on beta, nothing to do.';
  // Studio's remade worktree fails the probe, but the pass never worked in it.
  assert.ok(A.sourceLost(c, 'I made no changes.'), 'a pass in Studio\'s own worktree still reads the probe');
  assert.equal(A.sourceLost(c, said, true), null);
  assert.equal(O.noCommitOutcome({ ranInJob: true, worktreeProbeOk: false, saidUnreadable: false, saidAlreadyDone: A.alreadyDone(said) }), 'already-done');
  assert.ok(A.ranInCloudJob('[job] timing job_started=1\n[job] workspace x at abc1234 (beta)'));
  assert.ok(!A.ranInCloudJob('', undefined));
  // A job's agent that says it couldn't read the repo is still unreadable.
  assert.match(A.sourceLost(c, "could not read Username for 'https://github.com'", true)!, /^source unreadable/);
  for (const o of O.NO_COMMIT_OUTCOMES) assert.ok(o);
});

// ------------------------------------------------------------ a Unity project nested below the repo root (yoobaland)
// J, 2026-11-03: the repo root is YoobaLand/ and the project is YoobaLand/YoobaLand/ (Assets/, ProjectSettings/, Packages/).
const nestedOrigin = path.join(tmp, 'origin-nested');
fs.mkdirSync(nestedOrigin);
git(nestedOrigin, 'init', '-q', '-b', 'beta');
put(nestedOrigin, 'AGENTS.md', '# yooba\n');
put(nestedOrigin, 'YoobaLand/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0\n');
put(nestedOrigin, 'YoobaLand/Packages/manifest.json', '{"dependencies":{}}');
for (const n of ['YoobaThirdPersonCamera', 'YoobaSceneVoice', 'YoobaCutscene']) put(nestedOrigin, `YoobaLand/Assets/Game/Scripts/${n}.cs`, `public class ${n} {}\n`);
put(nestedOrigin, 'YoobaLand/Assets/Game/Data/lines.json', '{}');
put(nestedOrigin, 'YoobaLand/Assets/Art/yooba.png', 'PNGDATA'.repeat(100));
put(nestedOrigin, 'YoobaLand/Assets/Audio/theme.wav', 'WAVDATA'.repeat(100));
put(nestedOrigin, 'Tools/other/readme.txt', 'x');
git(nestedOrigin, 'add', '-A');
git(nestedOrigin, 'commit', '-q', '-m', 'init');
git(nestedOrigin, 'config', 'uploadpack.allowFilter', 'true');
git(nestedOrigin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
function nestedWorktree(name: string) {
  const clone = path.join(tmp, `nclone-${name}`);
  git(tmp, 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${nestedOrigin}`, clone);
  git(clone, 'config', 'hawkes.light', 'true');
  git(clone, 'sparse-checkout', 'set', '--cone');
  git(clone, 'checkout', '-q', 'beta');
  const wt = path.join(tmp, `nwt-${name}`);
  git(clone, 'worktree', 'add', '-q', '-b', `task/${name}`, wt, 'origin/beta');
  return { clone, wt };
}

test('unityRoots finds the project at the root or up to three folders down, and no deeper', () => {
  assert.deepEqual(S.unityRoots(['ProjectSettings/ProjectVersion.txt', 'a.txt']), ['']);
  assert.deepEqual(S.unityRoots(['YoobaLand/ProjectSettings/ProjectVersion.txt']), ['YoobaLand/']);
  assert.deepEqual(S.unityRoots(['a/b/c/ProjectSettings/ProjectVersion.txt']), ['a/b/c/']);
  assert.deepEqual(S.unityRoots(['a/b/c/d/ProjectSettings/ProjectVersion.txt']), [], 'four folders down is not looked for');
  assert.deepEqual(S.unityRoots(['x/ProjectSettings/ProjectVersion.txt', 'ProjectSettings/ProjectVersion.txt']), ['', 'x/'], 'the root first');
  assert.deepEqual(S.unityRoots(['YoobaLand/Assets/A.cs']), []);
});

test('a nested Unity project: the worktree starts with no source, populateSource fills in scripts and settings, art stays out', async () => {
  const { wt } = nestedWorktree('n1');
  const rel = 'YoobaLand/Assets/Game/Scripts';
  assert.ok(!fs.existsSync(path.join(wt, rel, 'YoobaCutscene.cs')), 'the bug: nothing below the root');
  const bad = S.probeSource(wt);
  assert.equal(bad.ok, false, 'the probe sees tracked C# that is not on disk, in a nested project too');
  assert.match(bad.reason!, /^source missing: \d+ tracked files, but YoobaLand\/Assets\//);
  const patterns = S.unitySourcePatterns(wt);
  assert.ok(patterns.includes('/YoobaLand/Assets/**/*.cs') && patterns.includes('/YoobaLand/ProjectSettings/'), patterns.join(' '));
  const p = await S.populateSource(wt, run, { unity: true });
  assert.equal(p.ok, true, p.reason);
  for (const n of ['YoobaThirdPersonCamera', 'YoobaSceneVoice', 'YoobaCutscene']) {
    assert.equal(fs.readFileSync(path.join(wt, rel, `${n}.cs`), 'utf8'), `public class ${n} {}\n`);
  }
  assert.ok(fs.existsSync(path.join(wt, 'YoobaLand/Assets/Game/Data/lines.json')));
  assert.ok(fs.existsSync(path.join(wt, 'YoobaLand/ProjectSettings/ProjectVersion.txt')));
  assert.ok(fs.existsSync(path.join(wt, 'YoobaLand/Packages/manifest.json')));
  assert.ok(fs.existsSync(path.join(wt, 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(wt, 'YoobaLand/Assets/Art/yooba.png')), 'art stays out');
  assert.ok(!fs.existsSync(path.join(wt, 'YoobaLand/Assets/Audio/theme.wav')), 'audio stays out');
});

test('the agents\' preflight and the job\'s patterns follow a nested project too', async () => {
  const { wt } = nestedWorktree('n2');
  await A.ensureSourceReady('c_none', { worktree: wt, product: 'nope', infra: false } as any, () => {});
  assert.ok(fs.existsSync(path.join(wt, 'YoobaLand/Assets/Game/Scripts/YoobaSceneVoice.cs')));
  const { jobSparsePatterns } = await import('../src/cloudjob.ts');
  assert.ok((await jobSparsePatterns(wt)).includes('/YoobaLand/Assets/**/*.cs'), 'the job checks out the nested project, not just a root Assets/');
});

test('a Unity product whose source cannot be fetched fails with source unreadable, never a quiet success', async () => {
  const { wt } = nestedWorktree('n3');
  const p = await S.populateSource(wt, async () => ({ ok: false, out: '', err: "fatal: could not read Username for 'https://github.com'" }), { unity: true });
  assert.equal(p.ok, false);
  assert.ok(I.isInfraText(S.sourceError('the scout\'s worktree', p)), 'Studio\'s failure: not a try, not one of the day\'s starts');
});

test('missing tracked files are repaired before the run fails (the 1467-files case)', async () => {
  const { wt } = nestedWorktree('n4');
  await A.ensureSourceReady('c_none', { worktree: wt, product: 'nope', infra: false } as any, () => {});
  // The source goes missing behind git's back while the index still lists it.
  const scripts = path.join(wt, 'YoobaLand/Assets/Game/Scripts');
  fs.rmSync(scripts, { recursive: true, force: true });
  const logs: string[] = [];
  await A.ensureSourceReady('c_none', { worktree: wt, product: 'nope', infra: false } as any, (m) => logs.push(m), { sleep: async () => {} });
  assert.ok(fs.existsSync(path.join(scripts, 'YoobaSceneVoice.cs')), 'checked out again');
  assert.ok(logs.some((l) => /repairing|checked out in the worktree/.test(l)), logs.join('\n'));
});

test('checkoutSlot runs one at a time for a while after a checkout was killed', () => {
  const was = process.env.STUDIO_CHECKOUTS;
  process.env.STUDIO_CHECKOUTS = '3';
  assert.equal(A.checkoutLimit(), 3);
  A.lowerCheckouts();
  assert.equal(A.checkoutLimit(), 1);
  assert.equal(A.checkoutLimit(Date.now() + 11 * 60_000), 3);
  if (was === undefined) delete process.env.STUDIO_CHECKOUTS; else process.env.STUDIO_CHECKOUTS = was;
});
