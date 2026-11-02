// addWorktree (worktree.ts): prunes stale records, removes a leftover folder and stale locks, retries once, and its error
// always carries git's own words (scouts failed with a bare "worktree: ", 2026-11-02). Throwaway repos in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addWorktree, clearStaleLocks, gitWhy, type GitRun } from '../src/worktree.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-worktree-'));
const repo = path.join(tmp, 'repo');
const sh = (cwd: string, args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
fs.mkdirSync(repo);
sh(repo, ['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
sh(repo, ['add', '.']);
sh(repo, ['commit', '-q', '-m', 'one']);
const real: GitRun = (cwd, args) => sh(cwd, args);

test('a leftover folder and a stale worktree record do not stop it', async () => {
  const wt = path.join(tmp, 'scout-1');
  assert.ok((await addWorktree(repo, wt, ['--detach', wt, 'main'], real)).ok);
  // The folder is deleted behind git's back (stale record), then something else sits at the same path.
  fs.rmSync(wt, { recursive: true, force: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'junk'), 'x');
  const logs: string[] = [];
  const r = await addWorktree(repo, wt, ['--detach', wt, 'main'], real, { removeLeftover: true, log: (s) => logs.push(s) });
  assert.ok(r.ok, r.err);
  assert.ok(fs.existsSync(path.join(wt, 'a.txt')));
  assert.ok(logs.some((l) => /leftover folder/.test(l)));
});

test('without removeLeftover a leftover folder is kept and the error says so in git\'s words', async () => {
  const wt = path.join(tmp, 'keep');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'junk'), 'x');
  const r = await addWorktree(repo, wt, ['--detach', wt, 'main'], real);
  assert.equal(r.ok, false);
  assert.match(r.err, /^worktree add keep failed: .*already exists/s);
  assert.ok(fs.existsSync(path.join(wt, 'junk')));
});

test('stale locks are cleared, fresh ones are left', () => {
  const old = path.join(repo, '.git', 'HEAD.lock');
  const fresh = path.join(repo, '.git', 'shallow.lock');
  fs.writeFileSync(old, '');
  fs.writeFileSync(fresh, '');
  const t = new Date(Date.now() - 3600_000);
  fs.utimesSync(old, t, t);
  const gone = clearStaleLocks(repo);
  assert.deepEqual(gone, [old]);
  assert.ok(fs.existsSync(fresh));
  fs.rmSync(fresh);
});

test('one failure is retried, and an empty stderr still gives a message', async () => {
  let n = 0;
  const flaky: GitRun = (cwd, args) => (args[1] === 'add' && n++ === 0 ? { ok: false, out: '', err: 'fatal: cannot lock ref' } : sh(cwd, args));
  const wt = path.join(tmp, 'retry');
  assert.ok((await addWorktree(repo, wt, ['--detach', wt, 'main'], flaky)).ok);
  assert.equal(n, 2);
  const silent: GitRun = (cwd, args) => (args[1] === 'add' ? { ok: false, out: '', err: '' } : sh(cwd, args));
  const r = await addWorktree(repo, path.join(tmp, 'silent'), ['--detach', 'x', 'main'], silent);
  assert.equal(r.ok, false);
  assert.match(r.err, /worktree add silent failed: git ended without a message/);
  assert.notEqual(gitWhy({ out: '', err: '' }), '');
});
