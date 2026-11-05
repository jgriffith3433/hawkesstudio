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

/** Git (or the kernel) killed the process: out of memory, signal 9. The retry runs with fewer checkouts at once. */
export const KILLED_RE = /sigkill|signal 9|killed|out of memory|cannot allocate memory|git ended without a message/i;

// A half-made worktree (a restart or a kill cut `worktree add` off) is never reused: a marker in the repo's git dir says a
// worktree is being made at a path, and is removed only when git finished and the checkout was verified. A marker still
// there after a restart means the folder is half a checkout: it is discarded and made again. (A worktree made before
// markers existed has none and is kept.)
const markerDir = (repoDir: string) => path.join(repoDir, '.git', 'hawkes-making');
const markerFile = (repoDir: string, target: string) => path.join(markerDir(repoDir), Buffer.from(path.resolve(target)).toString('hex').slice(-120));
export function beginMaking(repoDir: string, target: string) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) return;
  try { fs.mkdirSync(markerDir(repoDir), { recursive: true }); fs.writeFileSync(markerFile(repoDir, target), `${path.resolve(target)}\n${Date.now()}\n`); } catch { /* no marker, no protection */ }
}
export function finishMaking(repoDir: string, target: string) { fs.rmSync(markerFile(repoDir, target), { force: true }); }
export const isHalfMade = (repoDir: string, target: string) => fs.existsSync(markerFile(repoDir, target));
/** Discards a half-made worktree at `target` (folder and record). True when there was one. */
export async function discardIfHalfMade(repoDir: string, target: string, run: GitRun, log: (s: string) => void = () => {}): Promise<boolean> {
  if (!isHalfMade(repoDir, target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  await run(repoDir, ['worktree', 'prune']);
  finishMaking(repoDir, target);
  log(`discarded a half-made worktree at ${target} (a restart or a kill cut its checkout off); it is made again`);
  return true;
}

/** A made worktree is a real one: its .git link is there and git can read its HEAD. */
async function verified(repoDir: string, target: string, run: GitRun): Promise<GitResult> {
  if (!fs.existsSync(path.join(target, '.git'))) return { ok: false, out: '', err: `${target} has no .git after the checkout` };
  const head = await run(target, ['rev-parse', '--verify', 'HEAD']);
  return head.ok ? head : { ok: false, out: '', err: `the new worktree has no readable HEAD: ${gitWhy(head)}` };
}

/**
 * `git worktree add <args>` with cleanup first and retries (3 tries, 5 s then 20 s apart). `target` is the folder being
 * made; with `removeLeftover` a folder already there (an earlier run's) is deleted, since the caller owns that scratch
 * path. A try killed for memory (signal 9) calls `onKilled` (agents.ts lowers the checkouts running at once) before the
 * next. The result is checked (.git, a readable HEAD) before it is handed back, and a half-made marker covers the time
 * between: a worktree cut off mid-checkout is never reused.
 */
export async function addWorktree(
  repoDir: string, target: string, args: string[], run: GitRun,
  opts: { removeLeftover?: boolean; log?: (s: string) => void; onKilled?: () => void; tries?: number; backoffMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<GitResult> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = opts.backoffMs ?? [5_000, 20_000];
  const tries = Math.max(1, opts.tries ?? 3);
  // A folder that was there before we began isn't ours to delete (unless the caller said so); one a failed try made is.
  const ours = !fs.existsSync(target);
  const clean = async (force: boolean) => {
    await run(repoDir, ['worktree', 'prune']);
    const locks = clearStaleLocks(repoDir);
    if (locks.length) log(`removed ${locks.length} stale git lock file(s): ${locks.map((l) => path.basename(l)).join(', ')}`);
    if ((opts.removeLeftover || (force && ours)) && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      await run(repoDir, ['worktree', 'prune']);
      log(`removed a leftover folder at ${target}`);
    }
  };
  await clean(false);
  let r: GitResult = { ok: false, out: '', err: '' };
  for (let n = 1; n <= tries; n++) {
    beginMaking(repoDir, target);
    r = await run(repoDir, ['worktree', 'add', ...args]);
    if (r.ok) r = await verified(repoDir, target, run);
    if (r.ok) { finishMaking(repoDir, target); return r; }
    if (n === tries) break;
    const killed = KILLED_RE.test(gitWhy(r));
    log(`worktree add failed (${gitWhy(r).split('\n')[0]}); cleaning up and trying again (${n + 1} of ${tries})${killed ? ' with fewer checkouts at once' : ''}`);
    if (killed) opts.onKilled?.();
    // What a failed try left is never reused: its folder goes (a half-made checkout), then it is made again from nothing.
    await clean(true);
    await sleep(backoff[Math.min(n - 1, backoff.length - 1)] ?? 0);
  }
  await clean(true);
  finishMaking(repoDir, target);
  return { ...r, err: `worktree add ${path.basename(target)} failed: ${gitWhy(r)}` };
}
