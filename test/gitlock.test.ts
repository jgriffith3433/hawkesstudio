// Fetches of one repo take turns (gitlock.ts), and a fetch that hits "cannot lock ref" drops the stale remote-tracking
// ref and tries again with --prune (up to 3 more times). Studio's own repo sync (repos.ts syncRepo, a beta run's repo
// step) uses the same lock, and a ref lock that outlasts the retries doesn't fail it (Sick Of It's beta runs failed at
// "repo" three times on 2026-10-18 while two agents fetched). Throwaway repos in a temp folder with a bare origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gitlock-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [], repos: { site: 'test/site' } }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const run = (cwd: string) => (args: string[]) => new Promise<{ ok: boolean; out: string; err: string }>((ok) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  ok({ ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() });
});
const origin = path.join(tmp, 'origin.git');
const dir = path.join(process.env.STUDIO_PROJECTS, 'site');
const other = path.join(tmp, 'other');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, other);
const push = (text: string) => {
  fs.writeFileSync(path.join(other, 'index.html'), text);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', text);
  git(other, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:beta');
  return git(other, 'rev-parse', 'HEAD');
};
push('v1');
git(tmp, 'clone', '--quiet', '-b', 'beta', origin, dir);

const lock = await import('../src/gitlock.ts');
lock.fetchBackoff.ms = 20;
const { syncRepo } = await import('../src/repos.ts');

test('fetches of a checkout and its worktree take turns', async () => {
  const wt = path.join(tmp, 'wt');
  git(dir, 'worktree', 'add', '--quiet', '--detach', wt);
  assert.equal(lock.repoKey(wt), lock.repoKey(dir));
  const seen: string[] = [];
  const slow = (name: string) => async () => {
    seen.push(`${name} start`);
    await new Promise((ok) => setTimeout(ok, 30));
    seen.push(`${name} end`);
    return { ok: true, out: '', err: '' };
  };
  await Promise.all([lock.fetchLocked(dir, ['fetch'], slow('a')), lock.fetchLocked(wt, ['fetch'], slow('b'))]);
  assert.deepEqual(seen, ['a start', 'a end', 'b start', 'b end']);
  git(dir, 'worktree', 'remove', '--force', wt);
});

test('a ref lock drops the stale remote ref and tries again with --prune', async () => {
  const want = push('v2');
  const tries: string[][] = [];
  const logs: string[] = [];
  const r = await lock.fetchLocked(dir, ['fetch', '--quiet', 'origin'], async (args) => {
    tries.push(args);
    if (tries.length === 1) return { ok: false, out: '', err: "error: cannot lock ref 'refs/remotes/origin/beta': is at 1111 but expected 2222\n ! abc..def  beta -> origin/beta  (unable to update local ref)" };
    // The stale ref is gone before the next try (the fetch writes it again); local branches are untouched.
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/beta'], { cwd: dir }).status, 1);
    assert.ok(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/beta'], { cwd: dir }).status === 0);
    return run(dir)(args);
  }, (l) => logs.push(l));
  assert.ok(r.ok, r.err);
  assert.deepEqual(tries, [['fetch', '--quiet', 'origin'], ['fetch', '--prune', '--quiet', 'origin']]);
  assert.equal(git(dir, 'rev-parse', 'origin/beta'), want);
  assert.match(logs.join('\n'), /try 1 of 4.*dropped refs\/remotes\/origin\/beta/);
});

test('retries stop after 3 more tries; other errors are not retried; only remote refs are named', async () => {
  let n = 0;
  const locked = await lock.fetchLocked(dir, ['fetch', 'origin'], async () => { n++; return { ok: false, out: '', err: "cannot lock ref 'refs/remotes/origin/nope': is at 1 but expected 2" }; });
  assert.equal(locked.ok, false);
  assert.equal(n, lock.FETCH_TRIES);
  assert.equal(lock.FETCH_TRIES, 4);
  n = 0;
  await lock.fetchLocked(dir, ['fetch', 'origin'], async () => { n++; return { ok: false, out: '', err: 'fatal: could not read from remote repository' }; });
  assert.equal(n, 1);
  assert.deepEqual(lock.staleRefs("cannot lock ref 'refs/heads/beta': x\ncannot lock ref 'refs/remotes/origin/beta': y\nunable to update local ref 'refs/remotes/origin/main'"), ['refs/remotes/origin/beta', 'refs/remotes/origin/main']);
});

test('a read-only fetch skips a fresh fetch and never waits behind a busy repo', async () => {
  const beta = await import('../src/beta.ts');
  const at = () => git(dir, 'rev-parse', 'origin/beta');
  const v2 = push('read v2');
  assert.equal(await beta.fetchForRead(dir), null);
  assert.equal(at(), v2, 'the first read fetches');
  const v3 = push('read v3');
  assert.equal(await beta.fetchForRead(dir), null);
  assert.equal(at(), v2, 'fetched under a minute ago: read as of that fetch');
  // A push of this repo that goes on (Sick Of It's go live, a 1.2 GB build): the reader doesn't wait for it.
  let release!: () => void;
  const gate = new Promise<void>((ok) => { release = ok; });
  const held = lock.withRepoLock(lock.repoKey(dir), () => gate);
  const t0 = Date.now();
  const why = await beta.fetchForRead(dir, 0);
  assert.ok(Date.now() - t0 < 1000, 'answers at once');
  assert.match(String(why), /busy/);
  assert.equal(at(), v2);
  release();
  await held;
  await new Promise((ok) => setTimeout(ok, 0)); // the lock lets go on the next tick
  assert.equal(await beta.fetchForRead(dir, 0), null);
  assert.equal(at(), v3, 'free again: it fetches');
});

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  } catch { /* Windows can still hold git's files; the temp folder is left behind */ }
});
