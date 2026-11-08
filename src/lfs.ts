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

// ---------------------------------------------------------------------------------------------------------------------
// New LFS files made in a job (2026-11-08, Sick of It c_8cc679606350: 71 mp3s committed in the Cloud Run job reached Studio
// as pointers only, and the push failed "Unable to find source for object"). The job sends each new object back with its
// commits (cloudjob-run.ts collect); Studio stores them in the checkout's .git/lfs/objects, lists them as pending, and
// uploads exactly those with `git lfs push --object-id` before the branch push (a light checkout has no pre-push hook).

export type LfsRef = { oid: string; size: number };

/** The oid and size a Git LFS pointer file says, else null. */
export function parsePointer(text: string): LfsRef | null {
  if (!text.startsWith('version https://git-lfs.github.com/spec')) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}

const commonDir = (cwd: string) => {
  const r = spawnSync('git', ['-c', 'safe.directory=*', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : path.join(cwd, '.git');
};
/** Where git-lfs keeps an object: <git common dir>/lfs/objects/aa/bb/<oid>. */
export const lfsObjectPath = (cwd: string, oid: string) => path.join(commonDir(cwd), 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
const pendingFile = (cwd: string) => path.join(commonDir(cwd), 'hawkes-lfs-pending');

/** Puts an LFS object the job made into this checkout's store and remembers it for the next push. */
export function storeLfsObject(cwd: string, ref: LfsRef, data: Buffer) {
  const file = lfsObjectPath(cwd, ref.oid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  const list = pendingLfs(cwd);
  if (!list.some((r) => r.oid === ref.oid)) fs.writeFileSync(pendingFile(cwd), [...list, ref].map((r) => `${r.oid} ${r.size}`).join('\n') + '\n');
}

/** The objects stored for the next push and not yet uploaded. */
export function pendingLfs(cwd: string): LfsRef[] {
  try {
    return fs.readFileSync(pendingFile(cwd), 'utf8').split('\n').map((l) => /^([0-9a-f]{64}) (\d+)$/.exec(l)).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => ({ oid: m[1], size: Number(m[2]) }));
  } catch { return []; }
}

/**
 * Uploads the pending objects to the remote's LFS store. Call before pushing the branch, so GitHub never has a pointer
 * without its file. `run` is beta.ts gitAsync (it adds the repo's token). Throws with git-lfs's reason; clears the list on success.
 */
export async function pushPendingLfs(cwd: string, run: (cwd: string, args: string[]) => Promise<{ ok: boolean; err: string }>, log: (s: string) => void = () => {}) {
  const list = pendingLfs(cwd);
  if (!list.length) return 0;
  for (let i = 0; i < list.length; i += 100) {
    const r = await run(cwd, ['lfs', 'push', '--object-id', 'origin', ...list.slice(i, i + 100).map((x) => x.oid)]);
    if (!r.ok) throw new Error(`uploading ${list.length} LFS file(s) failed: ${r.err.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
  }
  try { fs.rmSync(pendingFile(cwd), { force: true }); } catch { /* */ }
  log(`uploaded ${list.length} LFS file(s) before the push`);
  return list.length;
}
