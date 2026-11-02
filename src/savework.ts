// An agent's commits must outlive Studio's worktree. Cloud Run jobs bring their commits back into the worktree, and a
// restart can remove or reset that worktree (to beta) before the publish step pushes anything: the commits were lost
// (2026-11-01: c_2377730c53c1, c_ace72a81894a, c_0440e1c8cdb8, c_121ffa70a3b9, c_20c98a23a212).
//
//   saveWork: right after each agent pass, push the task branch to GitHub. Never throws: a failed save is told, and
//             the publish step (which pushes for real and fails loudly) still follows.
//   restoreBranch: when a worktree is made again (or found reset), start from the branch on GitHub if it has the work.
import fs from 'node:fs';
import path from 'node:path';
import { gitAsync } from './beta.ts';

export type GitRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string; err: string }>;
const run: GitRun = (cwd, args) => gitAsync(cwd, args, 5 * 60_000);

export type Saved = { pushed: string } | { skipped: string } | { error: string };

/** Pushes `branch` (the worktree's HEAD) to GitHub when it holds commits beyond `origin/<base>`. Never throws. */
export async function saveWork(worktree: string, branch: string, base: string, git: GitRun = run): Promise<Saved> {
  try {
    // A replaced Cloud Run instance took the worktree with it: git there would only say "spawn git ENOENT".
    if (!fs.existsSync(path.join(worktree, '.git'))) return { error: `worktree missing after restart: ${worktree} is gone, nothing to save from it` };
    const head = await git(worktree, ['rev-parse', 'HEAD']);
    if (!head.ok || !head.out) return { error: `no HEAD to save: ${head.err}` };
    const ahead = await git(worktree, ['rev-list', '--count', `origin/${base}..HEAD`]);
    if (!ahead.ok) return { error: `couldn't count the commits on ${branch}: ${ahead.err}` };
    if (!Number(ahead.out)) return { skipped: 'no commits beyond ' + base };
    // Already on GitHub at this commit: nothing to send.
    const remote = await git(worktree, ['ls-remote', '--heads', 'origin', branch]);
    if (remote.ok && remote.out.split(/\s/)[0] === head.out) return { skipped: 'already on GitHub' };
    const p = await git(worktree, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    if (!p.ok) return { error: `push of ${branch} failed: ${p.err.split('\n').slice(-3).join(' | ') || 'git printed nothing'}` };
    return { pushed: head.out };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * Before a worktree is made from `repoDir`: if `origin/<branch>` exists on GitHub and the local branch is missing or
 * is only behind it (a reset to beta), the local branch is moved to it, so `worktree add` starts from the saved work.
 * Returns what it did (for the log), or null. Never throws.
 */
export async function restoreBranch(repoDir: string, branch: string, git: GitRun = run): Promise<string | null> {
  try {
    await git(repoDir, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const remote = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (!remote.ok || !remote.out) return null;
    const local = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (local.ok && local.out === remote.out) return null;
    if (local.ok) {
      // Only when the local branch is an ancestor of GitHub's: never throw away commits that exist only here.
      const anc = await git(repoDir, ['merge-base', '--is-ancestor', local.out, remote.out]);
      if (!anc.ok) return null;
    }
    const mv = await git(repoDir, ['update-ref', `refs/heads/${branch}`, remote.out]);
    return mv.ok ? `${branch} restored from GitHub (${remote.out.slice(0, 7)}): the saved work, not beta` : null;
  } catch {
    return null;
  }
}

/** A worktree that was reset (clean tree, HEAD an ancestor of the branch on GitHub) moves to the saved work. Never throws. */
export async function catchUpWorktree(worktree: string, branch: string, git: GitRun = run): Promise<string | null> {
  try {
    const remote = await git(worktree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    const head = await git(worktree, ['rev-parse', 'HEAD']);
    if (!remote.ok || !head.ok || remote.out === head.out) return null;
    if (!(await git(worktree, ['merge-base', '--is-ancestor', head.out, remote.out])).ok) return null;
    if ((await git(worktree, ['status', '--porcelain'])).out) return null;
    const r = await git(worktree, ['reset', '--quiet', '--hard', remote.out]);
    return r.ok ? `worktree was behind ${branch} on GitHub: moved to ${remote.out.slice(0, 7)}` : null;
  } catch {
    return null;
  }
}
