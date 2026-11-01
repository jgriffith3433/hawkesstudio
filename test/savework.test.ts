// An agent's commits survive a lost worktree (savework.ts), a failed bundle fails the pass with git's reason
// (cloudjob-run.ts collect), and clone failures say how git ended (repos.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-savework-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });

const { saveWork, restoreBranch, catchUpWorktree } = await import('../src/savework.ts');
const { collect } = await import('../src/cloudjob-run.ts');
const { lastLines } = await import('../src/repos.ts');

const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
const run = async (cwd: string, args: string[]) => {
  try { return { ok: true, out: sh(cwd, ...args), err: '' }; } catch (e: any) { return { ok: false, out: '', err: String(e.stderr ?? e.message).trim() }; }
};

function setup() {
  const dir = fs.mkdtempSync(path.join(TMP, 'r-'));
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  sh(dir, 'init', '--bare', '-b', 'beta', origin);
  sh(dir, 'clone', '--quiet', origin, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'base');
  sh(repo, 'push', '--quiet', 'origin', 'HEAD:beta');
  sh(repo, 'fetch', '--quiet');
  return { dir, origin, repo };
}

test('saveWork pushes the branch after a pass, and does nothing when there is nothing to save', async () => {
  const { repo, origin } = setup();
  sh(repo, 'worktree', 'add', '-b', 'task/x', path.join(repo, '..', 'wt'), 'origin/beta');
  const wt = path.join(repo, '..', 'wt');
  assert.deepEqual(await saveWork(wt, 'task/x', 'beta', run), { skipped: 'no commits beyond beta' });
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
  sh(wt, 'add', '.'); sh(wt, 'commit', '-m', 'work');
  const head = sh(wt, 'rev-parse', 'HEAD');
  assert.deepEqual(await saveWork(wt, 'task/x', 'beta', run), { pushed: head });
  assert.equal(sh(origin, 'rev-parse', 'task/x'), head);
  assert.deepEqual(await saveWork(wt, 'task/x', 'beta', run), { skipped: 'already on GitHub' });
});

test('saveWork never throws: a failing push comes back as an error', async () => {
  const { repo } = setup();
  fs.writeFileSync(path.join(repo, 'c.txt'), 'c');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'work');
  const boom = async (cwd: string, args: string[]) => (args[0] === 'push' ? { ok: false, out: '', err: 'remote: denied\nfatal: unable to access' } : run(cwd, args));
  const r = await saveWork(repo, 'task/y', 'beta', boom) as { error: string };
  assert.match(r.error, /push of task\/y failed: remote: denied \| fatal: unable to access/);
  const thrower = async () => { throw new Error('spawn exploded'); };
  assert.deepEqual(await saveWork(repo, 'task/y', 'beta', thrower as any), { error: 'spawn exploded' });
});

test('a lost worktree restarts from the branch on GitHub, not from beta', async () => {
  const { repo } = setup();
  const wt = path.join(repo, '..', 'wt');
  sh(repo, 'worktree', 'add', '-b', 'task/z', wt, 'origin/beta');
  fs.writeFileSync(path.join(wt, 'saved.txt'), 's');
  sh(wt, 'add', '.'); sh(wt, 'commit', '-m', 'saved');
  const saved = sh(wt, 'rev-parse', 'HEAD');
  await saveWork(wt, 'task/z', 'beta', run);
  // The restart: the worktree is gone and the local branch was put back on beta.
  fs.rmSync(wt, { recursive: true, force: true });
  sh(repo, 'worktree', 'prune');
  sh(repo, 'branch', '-f', 'task/z', 'origin/beta');
  const msg = await restoreBranch(repo, 'task/z', run);
  assert.match(msg ?? '', /restored from GitHub/);
  assert.equal(sh(repo, 'rev-parse', 'task/z'), saved);
  // A branch with commits only here is never overwritten.
  fs.writeFileSync(path.join(repo, 'local.txt'), 'l');
  sh(repo, 'checkout', '--quiet', 'task/z');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'local only');
  assert.equal(await restoreBranch(repo, 'task/z', run), null);
  // No branch on GitHub: nothing to restore.
  assert.equal(await restoreBranch(repo, 'task/none', run), null);
});

test('a worktree reset to beta catches up to the saved work (clean tree only)', async () => {
  const { repo } = setup();
  const wt = path.join(repo, '..', 'wt');
  sh(repo, 'worktree', 'add', '-b', 'task/w', wt, 'origin/beta');
  fs.writeFileSync(path.join(wt, 'saved.txt'), 's');
  sh(wt, 'add', '.'); sh(wt, 'commit', '-m', 'saved');
  const saved = sh(wt, 'rev-parse', 'HEAD');
  await saveWork(wt, 'task/w', 'beta', run);
  sh(wt, 'reset', '--hard', 'origin/beta');
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'd');
  assert.equal(await catchUpWorktree(wt, 'task/w', run), null, 'a dirty tree is left alone');
  fs.rmSync(path.join(wt, 'dirty.txt'));
  assert.match((await catchUpWorktree(wt, 'task/w', run)) ?? '', /moved to/);
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), saved);
});

test('collect reports why the commits could not be bundled, instead of dropping them silently', () => {
  const { repo } = setup();
  const start = sh(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'n.txt'), 'n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-m', 'job commit');
  const spec = { cwd: repo, sessions: path.join(TMP, 'sessions'), git: { head: start, branch: 'beta', remote: '', bundle: false, token: null } } as any;
  const ok = collect(spec, start, fs.mkdtempSync(path.join(TMP, 't-')));
  assert.ok(ok.bundle && !ok.bundleError);
  // The start commit is unknown to the repo: git refuses to bundle against it.
  const bad = collect(spec, '1'.repeat(40), fs.mkdtempSync(path.join(TMP, 't-')));
  assert.equal(bad.bundle, null);
  assert.match(bad.bundleError ?? '', /couldn't bundle the pass's commits/);
  assert.ok((bad.bundleError ?? '').length > 60, 'carries git\'s own words');
});

test('clone failures name git\'s last lines, never an empty message', () => {
  assert.equal(lastLines('Cloning...\nfatal: early EOF\nfatal: index-pack failed\ngit exited with code 128'), 'fatal: early EOF | fatal: index-pack failed | git exited with code 128');
  assert.match(lastLines(''), /without saying why/);
});
