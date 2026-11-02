// Big repos are routed, never refused (repos.ts bigRepo, bigProduct): on Cloud Run a Unity project's repo or one over
// STUDIO_CLONE_MAX_MB is cloned light on the Studio service (partial, no LFS files, no npm ci) and the agent's Cloud Run
// job makes the full checkout (cloudjob-run.ts prepare: partial, LFS skipped unless the spec asks). A full clone of a
// 3 GB Unity repo filled the customer cell's memory disk and every restart resumed it (2026-10-31, 2026-11-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-big-repo-'));
const R = await import('../src/repos.ts');
const J = await import('../src/cloudjob-run.ts');

/** GitHub's repo answer by slug (size in KB), counting the calls. */
function github(kb: Record<string, number>) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    const slug = String(url).replace(/^.*\/repos\//, '');
    calls.push(slug);
    return slug in kb ? new Response(JSON.stringify({ size: kb[slug] }), { status: 200 }) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const web = { id: 'tiny', engine: 'web' as const, repo: 'tiny', site: 'tiny', github: 'cust/tiny' };
const unityBuilds = { id: 'yooba', engine: 'web' as const, repo: 'yooba', site: 'yooba', github: 'cust/yooba', builds: [{ id: 'webgl', tool: 'unity' }] as any };
const bigWeb = { id: 'huge', engine: 'web' as const, repo: 'huge', site: 'huge', github: 'cust/huge', repos: [{ repo: 'cust/huge-assets' }] };

async function onCloudRun<T>(fn: () => Promise<T> | T) {
  process.env.K_SERVICE = 'studio-test';
  try { return await fn(); } finally { delete process.env.K_SERVICE; }
}

test('off Cloud Run nothing is big and GitHub is never asked', async () => {
  R.forgetRepoSizes();
  const g = github({ 'cust/huge-assets': 5_000_000 });
  assert.equal(await R.bigProduct(unityBuilds, g.fetcher), null);
  assert.equal(await R.bigProduct(bigWeb, g.fetcher), null);
  assert.equal(R.builtFromGitHub(unityBuilds), null);
  assert.deepEqual(g.calls, []);
});

test('on Cloud Run a Unity project and a repo over the limit are big (routing), and a small one is not', async () => {
  R.forgetRepoSizes();
  const g = github({ 'cust/huge': 100, 'cust/huge-assets': 3_000_000, 'cust/tiny': 200 * 1024 });
  assert.match((await onCloudRun(() => R.bigProduct(unityBuilds, g.fetcher)))!, /yooba is a Unity project/);
  assert.match((await onCloudRun(() => R.bigProduct(bigWeb, g.fetcher)))!, /cust\/huge-assets is about 2930 MB/);
  assert.equal(await onCloudRun(() => R.bigProduct(web, g.fetcher)), null);
  // Only a Unity project's checkout is left out of runs (built from GitHub); a big web repo is synced, light.
  assert.match((await onCloudRun(() => R.builtFromGitHub(unityBuilds)))!, /built from GitHub/);
  assert.equal(await onCloudRun(() => R.builtFromGitHub(bigWeb)), null);
  // The limit is STUDIO_CLONE_MAX_MB; GitHub not answering is "not big" and isn't remembered.
  process.env.STUDIO_CLONE_MAX_MB = '100';
  try { assert.match((await onCloudRun(() => R.bigRepo('cust/tiny', g.fetcher)))!, /about 200 MB/); }
  finally { delete process.env.STUDIO_CLONE_MAX_MB; }
  const none = github({});
  assert.equal(await onCloudRun(() => R.bigRepo('cust/gone', none.fetcher)), null);
  await onCloudRun(() => R.bigRepo('cust/gone', none.fetcher));
  assert.equal(none.calls.length, 2);
});

test("the service's light clone is partial and skips LFS files", () => {
  assert.deepEqual(R.cloneArgs('o/n', 'n', false), ['clone', '--quiet', '--no-checkout', 'https://github.com/o/n.git', 'n']);
  assert.ok(R.cloneArgs('o/n', 'n', true).includes('--filter=blob:none'));
  const cfg = Object.fromEntries(R.LIGHT_CONFIG);
  assert.equal(cfg['hawkes.light'], 'true');
  assert.match(cfg['filter.lfs.smudge'], /--skip/);
});

test("the job's clone is partial with LFS skipped by default; a spec can ask for a full clone and LFS files", () => {
  const args = J.jobCloneArgs({ remote: 'https://github.com/o/n.git' }, '/w/n');
  assert.ok(args.includes('--filter=blob:none'));
  assert.ok(args.includes('--no-checkout'));
  assert.ok(!args.some((a) => a.startsWith('--depth')), 'no depth: bundles of unpushed commits still apply');
  assert.ok(!J.jobCloneArgs({ remote: 'r', partial: false }, '/w').includes('--filter=blob:none'));
  assert.deepEqual(J.jobGitEnv({}), { GIT_LFS_SKIP_SMUDGE: '1' });
  assert.deepEqual(J.jobGitEnv({ lfs: true }), {});
});

test("prepare makes a partial workspace clone that skips LFS, at the head asked for", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-job-prepare-'));
  const src = path.join(root, 'src');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(src);
  g(src, 'init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(src, 'a.txt'), 'one\n');
  g(src, 'add', '.');
  g(src, 'commit', '--quiet', '-m', 'one');
  fs.writeFileSync(path.join(src, 'a.txt'), 'two\n');
  g(src, 'commit', '--quiet', '-am', 'two');
  g(src, 'config', 'uploadpack.allowFilter', 'true');
  const head = g(src, 'rev-parse', 'HEAD');
  const cwd = path.join(root, 'work', 'n');
  const store = { get: async () => null, put: async () => {}, list: async () => [], remove: async () => {} } as any;
  const start = await J.prepare('u1', { file: 'x', args: [], cwd, env: {}, sessions: path.join(root, 's'), git: { head, branch: 'agent/x', remote: `file://${src}`, bundle: false, token: null } }, store, () => {});
  assert.equal(start, head);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(g(cwd, 'config', '--get', 'remote.origin.promisor'), 'true', 'a partial clone');
  assert.match(g(cwd, 'config', '--get', 'filter.lfs.smudge'), /--skip/);
});

test("a big repo's light checkout is sparse: root files only, clean status, no whole-tree blob fetch", async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  g(d, 'init', '-q', '-b', 'beta', 'src');
  fs.mkdirSync(path.join(d, 'src/Assets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src/root.txt'), 'r'); fs.writeFileSync(path.join(d, 'src/Assets/big.bin'), 'x');
  g(path.join(d, 'src'), 'add', '-A'); g(path.join(d, 'src'), 'commit', '-qm', 'i');
  g(d, 'clone', '-q', '--no-checkout', 'src', 'dst');
  g(path.join(d, 'dst'), 'sparse-checkout', 'set', '--cone'); g(path.join(d, 'dst'), 'checkout', '-q', 'beta');
  assert.deepEqual(fs.readdirSync(path.join(d, 'dst')).filter((f) => f !== '.git'), ['root.txt']);
  assert.equal(g(path.join(d, 'dst'), 'status', '--porcelain').trim(), '');
  fs.rmSync(d, { recursive: true, force: true });
});
