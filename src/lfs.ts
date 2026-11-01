/**
 * Git LFS in the server's checkouts. Sick Of It keeps every image, sound, scene, prefab and material in LFS, so a checkout
 * without its LFS files hands agents, scouts and Talk pointer text instead of the art (2026-10-25: git-lfs was never
 * installed on the control server, and every Sick Of It agent worked blind).
 *
 * The server installs git-lfs with the smudge filter skipped (deploy.mjs setupGit: `git lfs install --system
 * --skip-smudge`), so making a worktree never waits on, or fails over, a download; this module fetches the files after.
 * The clean filter stays on, so art an agent commits goes into LFS, and the repo's pre-push hook uploads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Its own git and server check, not beta.ts's or repos.ts's: they import this module (a cycle breaks their start-up).
const isServer = () => process.platform !== 'win32' && process.env.STUDIO_SERVER === '1';
function gitAsync(cwd: string, args: string[], timeoutMs = 2 * 60_000): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    let err = '';
    const child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, err: err.trim() || (code === null ? 'timed out' : '') }); });
  });
}

const usesLfs = (dir: string) => {
  try {
    return /filter=lfs/.test(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'));
  } catch {
    return false;
  }
};

/**
 * Real files for every LFS pointer in this checkout or worktree. Fast when its objects are already in the shared store.
 * Only on the server: J's PC has git-lfs with its own hooks and credentials (a credential window there would hang).
 */
/**
 * A light checkout (repos.ts syncGit on Cloud Run: a big repo cloned partially, LFS smudge skipped, marked
 * hawkes.light in its config, which its worktrees share): its LFS files and node_modules are the Cloud Run job's to
 * fetch, never the Studio service's, whose disk is the instance's memory.
 */
export function lightCheckout(dir: string) {
  if (!process.env.K_SERVICE || !fs.existsSync(dir)) return false;
  const r = spawnSync('git', ['config', '--get', 'hawkes.light'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 && r.stdout.trim() === 'true';
}

export async function lfsPull(dir: string, log: (s: string) => void = (s) => console.log(`[lfs] ${s}`)) {
  if (!isServer() || !usesLfs(dir)) return;
  if (lightCheckout(dir)) {
    log(`git lfs pull skipped: a light checkout of a big repo on the cloud server (the agent's Cloud Run job works with the files)`);
    return;
  }
  const t0 = Date.now();
  if (!(await gitAsync(dir, ['lfs', 'version'])).ok) {
    log(`git-lfs isn't installed on this server (deploy.mjs setupGit installs it): this checkout has LFS pointers, not the files`);
    return;
  }
  // The repo's pre-push hook (shared by its worktrees): without it a push carries pointers whose files GitHub never gets.
  await gitAsync(dir, ['lfs', 'update']);
  const r = await gitAsync(dir, ['lfs', 'pull'], 30 * 60_000);
  log(r.ok ? `git lfs pull (${Math.round((Date.now() - t0) / 1000)} s)` : `git lfs pull failed: ${r.err.split('\n').pop()}: this checkout may have LFS pointers, not the files`);
}
