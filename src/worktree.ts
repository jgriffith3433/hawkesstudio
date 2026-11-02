// Making a git worktree that doesn't fail with a bare "worktree: " (scouts and agent runs, 2026-11-02): before adding,
// stale worktree records are pruned, a leftover folder at the target is removed (only when the caller says it is a
// scratch path of its own) and lock files older than 10 minutes (a git killed by a restart) are cleared; a failure is
// cleaned up the same way and tried once more; the error always carries git's own words, or how git ended.
import fs from 'node:fs';
import path from 'node:path';

export type GitResult = { ok: boolean; out: string; err: string };
export type GitRun = (cwd: string, args: string[]) => GitResult | Promise<GitResult>;

const STALE_LOCK_MS = 10 * 60_000;
const LOCK_NAMES = new Set(['index.lock', 'HEAD.lock', 'shallow.lock', 'config.lock', 'locked']);

/** A failed git's message: stderr (or stdout), else "git ended without a message" so it is never empty. */
export function gitWhy(r: Pick<GitResult, 'out' | 'err'>): string {
  return (r.err.trim() || r.out.trim() || 'git ended without a message (killed, or out of disk space?)').slice(0, 1500);
}

/** Lock files left by a git that died, older than `maxAgeMs`, in the repo's git dir and its worktrees' records. Returns what it removed. */
export function clearStaleLocks(repoDir: string, maxAgeMs = STALE_LOCK_MS, now = Date.now()): string[] {
  const gitDir = path.join(repoDir, '.git');
  const dirs = [gitDir];
  const wts = path.join(gitDir, 'worktrees');
  try { for (const d of fs.readdirSync(wts)) dirs.push(path.join(wts, d)); } catch { /* none */ }
  const removed: string[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      // `locked` in a worktree record is a deliberate `git worktree lock`; leave it unless this is a plain *.lock.
      if (!LOCK_NAMES.has(n) || n === 'locked') continue;
      const f = path.join(dir, n);
      const st = fs.statSync(f, { throwIfNoEntry: false });
      if (!st || now - st.mtimeMs < maxAgeMs) continue;
      try { fs.rmSync(f, { force: true }); removed.push(f); } catch { /* the retry says what's wrong */ }
    }
  }
  return removed;
}

/**
 * `git worktree add <args>` with cleanup first and one retry. `target` is the folder being made; with
 * `removeLeftover` a folder already there (an earlier run's) is deleted, since the caller owns that scratch path.
 */
export async function addWorktree(
  repoDir: string, target: string, args: string[], run: GitRun,
  opts: { removeLeftover?: boolean; log?: (s: string) => void } = {},
): Promise<GitResult> {
  const log = opts.log ?? (() => {});
  const clean = async () => {
    await run(repoDir, ['worktree', 'prune']);
    const locks = clearStaleLocks(repoDir);
    if (locks.length) log(`removed ${locks.length} stale git lock file(s): ${locks.map((l) => path.basename(l)).join(', ')}`);
    if (opts.removeLeftover && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      await run(repoDir, ['worktree', 'prune']);
      log(`removed a leftover folder at ${target}`);
    }
  };
  await clean();
  let r = await run(repoDir, ['worktree', 'add', ...args]);
  if (!r.ok) {
    log(`worktree add failed (${gitWhy(r).split('\n')[0]}); cleaning up and trying once more`);
    await clean();
    r = await run(repoDir, ['worktree', 'add', ...args]);
  }
  return r.ok ? r : { ...r, err: `worktree add ${path.basename(target)} failed: ${gitWhy(r)}` };
}
