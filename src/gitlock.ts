// Fetches take turns per repository: a checkout and its worktrees share refs, so two fetches at once (two agents,
// betawatch, a beta run's repo step, a conflict pass, a warm start) fail with "cannot lock ref
// 'refs/remotes/origin/beta': is at <sha> but expected <sha>". Every Studio fetch goes through here (beta.ts gitAsync,
// repos.ts syncRepo, dev.ts); a fetch that still hits a ref lock (git outside Studio) drops the stale remote-tracking
// ref and is tried again with --prune. No imports from Studio's modules, so beta.ts and repos.ts can both use it.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type GitResult = { ok: boolean; out: string; err: string };

export const REF_LOCK = /cannot lock ref|unable to update local ref|Unable to create '[^']*\.lock'/i;
/** The first try and up to 3 more. */
export const FETCH_TRIES = 4;
/** The wait before a fetch's next try, times the try (tests shorten it). */
export const fetchBackoff = { ms: 2000 };

const repoKeys = new Map<string, string>();
/** The repository a folder belongs to (its common git dir: a worktree and its main checkout are one), else the folder. */
export function repoKey(cwd: string) {
  const known = repoKeys.get(cwd);
  if (known) return known;
  // Read from the .git files themselves (2026-11-10: a git rev-parse per new worktree ran synchronously on Studio's main
  // thread, part of its event-loop freezes with 12 agents); git only when the layout isn't the usual one.
  const read = commonDirOf(cwd);
  if (read) {
    repoKeys.set(cwd, read);
    return read;
  }
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const key = r.status === 0 && r.stdout.trim() ? path.resolve(cwd, r.stdout.trim()) : path.resolve(cwd);
  if (r.status === 0) repoKeys.set(cwd, key);
  return key;
}

/** The common git dir of a folder from its .git (a directory: a checkout; a "gitdir:" file: a worktree, whose own git
 *  dir names the common one in "commondir"), looking up from cwd like git does; null when it can't tell. */
export function commonDirOf(cwd: string): string | null {
  try {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const dotgit = path.join(dir, '.git');
      const st = fs.statSync(dotgit, { throwIfNoEntry: false });
      if (st?.isDirectory()) return dotgit;
      if (st?.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
        if (!m) return null;
        const gitdir = path.resolve(dir, m[1].trim());
        const common = fs.readFileSync(path.join(gitdir, 'commondir'), { encoding: 'utf8', flag: 'r' }).trim();
        return path.resolve(gitdir, common);
      }
      if (path.dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

const repoLocks = new Map<string, Promise<unknown>>();
/** Runs fn after every earlier one on the same key has finished (a failure doesn't hold up the next). */
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  repoLocks.set(key, tail);
  void tail.then(() => { if (repoLocks.get(key) === tail) repoLocks.delete(key); });
  return run;
}

/** Whether a fetch or push of this repository is running or waiting (a read can use the last fetch instead). */
export const repoBusy = (key: string) => repoLocks.has(key);

/** The remote-tracking refs a failed fetch names as stuck ("cannot lock ref 'refs/remotes/origin/beta'"). Never local branches. */
export function staleRefs(err: string) {
  const refs = new Set<string>();
  for (const m of err.matchAll(/(?:cannot lock ref|unable to update local ref) '(refs\/remotes\/[^']+)'/gi)) refs.add(m[1]);
  return [...refs];
}

/**
 * A fetch (args[0] === 'fetch') in cwd, under the repo's lock. On a ref lock: the stale remote-tracking refs it names
 * are deleted (the fetch writes them again), and it is tried again with --prune after a short wait, up to FETCH_TRIES
 * in all. `log` hears each retry.
 */
export function fetchLocked(cwd: string, args: string[], run: (args: string[]) => Promise<GitResult>, log: (line: string) => void = () => {}): Promise<GitResult> {
  return withRepoLock(repoKey(cwd), async () => {
    let a = args;
    for (let attempt = 1; ; attempt++) {
      const r = await run(a);
      if (r.ok || !REF_LOCK.test(r.err) || attempt >= FETCH_TRIES) return r;
      const refs = staleRefs(r.err).filter((ref) => spawnSync('git', ['update-ref', '-d', ref], { cwd, windowsHide: true, timeout: 10_000 }).status === 0);
      if (!a.includes('--prune')) a = ['fetch', '--prune', ...a.slice(1)];
      log(`fetch in ${path.basename(cwd)} hit a ref lock (try ${attempt} of ${FETCH_TRIES})${refs.length ? `, dropped ${refs.join(', ')}` : ''}, trying again`);
      await new Promise((ok) => setTimeout(ok, fetchBackoff.ms * attempt));
    }
  });
}
