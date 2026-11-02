// A Cloud Run job that ends after Studio's instance was replaced (2026-11-02: c_371cfae56062 and nine more changes lost
// their commits). The worktree and the repo clone lived on the old instance's disk, so they are gone when the job ends:
// cloudjob.ts finish() makes the workspace again (the restorer agents.ts registers), brings in the workspace's earlier
// commits (in.bundle) and the job's (out.bundle), and only then clears the job's folder in the bucket. When it can't make
// the workspace, the folder stays and the pass fails saying where the work is. saveWork says "worktree missing after
// restart" instead of git's "spawn git ENOENT".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lost-wt-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_JOB_POLL_MS = '50';
process.env.STUDIO_STATE_BUCKET = 'test-bucket';
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

const { setJobRunner, setWorkspaceRestorer } = await import('../src/cloudjob.ts');
const { runUnit } = await import('../src/cloudjob-run.ts');
const { startDetached, DetachedChild } = await import('../src/detach.ts');
const { saveWork } = await import('../src/savework.ts');

/**
 * GitHub (a bare repo with main), Studio's clone and a change's worktree on task/<name> with a commit GitHub lacks.
 * The job starts, then the "instance is replaced": the clone and the worktree are deleted before the job runs.
 */
async function lostWorktreeRun(name: string, restore: (o: { origin: string; repo: string; worktree: string; branch: string }) => Promise<boolean>) {
  const base = path.join(TMP, name);
  const origin = path.join(base, 'origin.git');
  fs.mkdirSync(base, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = path.join(base, 'projects', 'game');
  git(base, 'clone', '-q', origin, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  const branch = `task/${name}`;
  const worktree = path.join(base, 'projects', '.work', `c_${name}`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'origin/main');
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'earlier pass\n');
  git(worktree, 'commit', '-qam', 'earlier pass (never pushed)');

  const root = path.join(base, 'job-machine');
  const at = (p: string) => path.join(root, p.replace(/^[A-Za-z]:/, ''));
  const bucket = new Map<string, Buffer>();
  const store = {
    put: async (k: string, d: Buffer | string) => { bucket.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)); },
    get: async (k: string) => bucket.get(k) ?? null,
    list: async (p: string) => [...bucket.keys()].filter((k) => k.startsWith(p)),
    remove: async (k: string) => { bucket.delete(k); },
  };
  let finished = false;
  let startJob: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { startJob = resolve; });
  let unitStarted = '';
  setJobRunner(() => ({
    ...store,
    start: async (unit) => { unitStarted = unit; startJob!(); return 'projects/p/locations/r/jobs/studio-agent/executions/e1'; },
    state: async () => ({ done: finished, message: '' }),
    cancel: async () => {},
  }));
  setWorkspaceRestorer((cwd) => (cwd === worktree ? restore({ origin, repo, worktree, branch }) : Promise.resolve(false)));

  const script = path.join(base, 'fake-pass.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
fs.writeFileSync('a.txt', 'from the job\\n'); g('commit', '-qam', 'job commit');
fs.mkdirSync('.hawkes', { recursive: true }); fs.writeFileSync('.hawkes/summary.md', 'Fixed it.\\n');
`);
  const rec = startDetached(`agent-c_${name}`, { file: process.execPath, args: [script], cwd: worktree, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, 'claude') } }, 'cloudrun');
  await started;
  // The instance is replaced while the job runs: its disk, with the clone and the worktree, is gone.
  fs.rmSync(path.join(base, 'projects'), { recursive: true, force: true });
  void runUnit(unitStarted, store, { every: 50, at }).then(() => { finished = true; });
  const child = new DetachedChild(rec);
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  setJobRunner(null);
  setWorkspaceRestorer(null);
  await new Promise((r) => setTimeout(r, 200));
  const exit = JSON.parse(fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'detached', `${rec.unit}.exit`), 'utf8'));
  return { code, err, exit, bucket, unit: rec.unit, worktree, branch, repo, origin };
}

test('the worktree went with the instance: it is made again and the job\'s commits land on the task branch', async () => {
  let remade = false;
  const r = await lostWorktreeRun('c1', async ({ origin, repo, worktree, branch }) => {
    // What agents.ts remakeWorktree does: clone again, a new branch from origin/<base> (nothing saved on GitHub).
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    git(path.dirname(repo), 'clone', '-q', origin, repo);
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'origin/main');
    remade = true;
    return true;
  });
  const unit = r.unit;
  assert.equal(r.code, 0, r.err);
  assert.equal(r.exit.error, undefined);
  assert.equal(remade, true, 'the restorer ran');
  // Both the earlier pass's commit (in.bundle) and the job's (out.bundle) are on the task branch.
  assert.deepEqual(git(r.repo, 'log', '--format=%s', r.branch).split('\n'), ['job commit', 'earlier pass (never pushed)', 'base']);
  assert.equal(git(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), r.branch);
  assert.equal(fs.readFileSync(path.join(r.worktree, 'a.txt'), 'utf8'), 'from the job\n');
  assert.equal(fs.readFileSync(path.join(r.worktree, '.hawkes', 'summary.md'), 'utf8'), 'Fixed it.\n');
  assert.match(r.err, /was gone \(Studio restarted\): made again/);
  // Applied: only now is the job's folder cleared.
  assert.deepEqual([...r.bucket.keys()].filter((k) => k.startsWith(`jobs/${unit}/`)), []);
});

test('a worktree that can\'t be made again: the job\'s folder (its out.bundle) stays and the pass fails saying where', async () => {
  const r = await lostWorktreeRun('c2', async () => false);
  assert.equal(r.code, 1);
  assert.match(r.exit.error, /worktree missing after restart/);
  assert.match(r.exit.error, new RegExp(`gs://test-bucket/jobs/${r.unit}/`));
  assert.ok(r.bucket.has(`jobs/${r.unit}/out/out.bundle`), 'the job\'s commits are still in the bucket');
  assert.ok(r.bucket.has(`jobs/${r.unit}/out/exit.json`));
  assert.ok(r.bucket.has(`jobs/${r.unit}/in.bundle`), 'and the earlier commits they build on');
  // The commits are really in it: a bundle git can read.
  const file = path.join(TMP, 'kept.bundle');
  fs.writeFileSync(file, r.bucket.get(`jobs/${r.unit}/out/out.bundle`)!);
  assert.match(git(TMP, 'bundle', 'list-heads', file), /HEAD/);
});

test('saveWork in a worktree that is gone says so (not "spawn git ENOENT")', async () => {
  const s = await saveWork(path.join(TMP, 'nowhere'), 'task/x', 'beta');
  assert.ok('error' in s);
  assert.match((s as { error: string }).error, /worktree missing after restart/);
});
