// Product repos on the server: clone what's missing and fast-forward what's there, from GitHub, into the same
// layout as C:\Projects (products.json "repos": top-level folder -> owner/name). On J's PC the repos are already
// there and this is a no-op unless asked. GitHub access on the server comes from the hawkes/github secret through
// the git credential helper (bin/git-credential-hawkes).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PROJECTS, DATA, paths, addedRepoFolders, loadProducts, type Product } from './config.ts';
import { gitAuthEnv, primeRepoToken, repoToken } from './ghtoken.ts';

/** The GitHub repo of a folder under PROJECTS (its top-level folder in repoMap), for git's token. */
const slugOfDir = (dir: string) => {
  const top = path.relative(PROJECTS, dir).split(/[\\/]/)[0];
  return top && !top.startsWith('..') ? repoMap()[top] ?? null : null;
};
import { trackCommand } from './ops.ts';
import { lockHash, installedFor, ensureInstalled, runShell } from './warm.ts';
import { REF_LOCK, fetchLocked, repoBusy, repoKey } from './gitlock.ts';
import { lfsPull, lightCheckout } from './lfs.ts';

export const BRANCH = process.env.STUDIO_BRANCH || 'main';
/** The branch between agent changes and the live site (beta.ts). On the server, product source repos are kept on it. */
export const BETA = process.env.STUDIO_BETA_BRANCH || 'beta';

/** git for quick local reads (rev-parse, status, log). */
function git(cwd: string, args: string[], timeoutMs = 20 * 60_000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
}

/** git for clone, fetch, checkout and merge, without blocking Studio (a sync of every repo used to freeze it). */
function gitA(cwd: string, args: string[], timeoutMs = 20 * 60_000, slug: string | null = null, extraEnv: Record<string, string> = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const done = trackCommand(`git ${args.join(' ')}`, cwd);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    // A repo that isn't J's: its own token as a header for this one command (ghtoken.ts gitAuthEnv, primed by the caller).
    const child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...gitAuthEnv(slug ?? slugOfDir(cwd)), ...extraEnv } });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024 * 1024) out = out.slice(-32 * 1024 * 1024); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 1_000_000) err = err.slice(-500_000); });
    const end = (ok: boolean, e?: string) => { clearTimeout(timer); done(); resolve({ ok, out: out.trim(), err: (e ?? err).trim() }); };
    child.on('error', (e) => end(false, e.message));
    // A failure always says how it ended: git's own words, then the exit code or the signal (a kill prints nothing).
    child.on('close', (code, signal) => end(code === 0, code === 0 ? undefined : `${err.trim()}${err.trim() ? '\n' : ''}git exited ${signal ? `by signal ${signal}` : `with code ${code}`}`));
  });
}

/** Wait before a failed clone is tried once more (tests shorten it). */
export const CLONE_RETRY_MS = Number(process.env.STUDIO_CLONE_RETRY_MS ?? 3000);

export function repoMap(): Record<string, string> {
  // Games added in J's Studio (config.ts addedRepoFolders) are cloned beside products.json's.
  return { ...(JSON.parse(fs.readFileSync(paths.products, 'utf8')).repos ?? {}), ...addedRepoFolders() };
}

export type RepoResult = { folder: string; slug: string; action: 'cloned' | 'updated' | 'current' | 'kept' | 'failed'; detail: string; head?: string; dirty?: string[]; discarded?: string[];
  /** npm ci runs in the repo's web checkouts after the sync (installAfterSync): where, why, how long, the error. */
  install?: Install[];
  /** Uncommitted changes set aside (git stash) so a beta checkout could follow beta: the stash's commit, its message, the files. */
  setAside?: { stash: string; label: string; files: string[]; /** When the stash failed: the tar of the files that were there and differ from GitHub (a local path, or gs:// on Cloud Run; none: nothing to save), how many were left out as unchanged from GitHub, and why it failed. */ backup?: string; unchanged?: number; why?: string; /** Clearing failed too, so the checkout was cloned again. */ recloned?: boolean } };

/** Backups kept per repo folder: making one deletes that folder's older ones beyond these (no timer, no sweep). */
export const KEEP_BACKUPS = 5;

const backupName = (folder: string) => `${folder}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** One folder's backups by name (newest last): `<folder>-<ISO time>.tar.gz`, never another folder that starts the same. */
const ofFolder = (folder: string) => new RegExp(`^${escapeRe(folder)}-\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.tar\\.gz$`);

/**
 * Backs the given repo files up to a .tar.gz (tar as a child process, the list on stdin: never spawnSync, never the
 * files in Node's memory). Only files that exist are listed (a deleted tracked file is in HEAD).
 *
 * Where it goes: on Cloud Run (STUDIO_STATE_BUCKET) the instance's disk is its memory, so tar's output is streamed
 * straight to the state bucket, under <prefix>backups/repos/ (one GCS_CHUNK in memory at a time, never a file on
 * /data): PH Origins' half-written checkout was 1,256 files, ~518 MiB as a .tar.gz, written to /data on a 4 GiB cell
 * beside its ~585 MiB checkout (2026-11-01). Elsewhere (J's PC, the AWS server) it is a file under <data>/backups/repos.
 * Either way only the newest KEEP_BACKUPS of a folder are kept.
 */
export async function backupFiles(dir: string, folder: string, files: string[]): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }> {
  const present = files.filter((f) => { try { fs.lstatSync(path.join(dir, f)); return true; } catch { return false; } });
  const name = backupName(folder);
  const { stateBucket, statePrefix } = await import('./cloudhost.ts');
  const bucket = stateBucket();
  if (bucket) {
    if (!present.length) return { ok: false, error: 'none of the files exist to back up' };
    return backupToBucket(dir, folder, present, bucket, `${statePrefix()}backups/repos/`, name);
  }
  const root = path.join(DATA, 'backups', 'repos');
  const file = path.join(root, name);
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!present.length) return { ok: false, error: 'none of the files exist to back up' };
    const r = await new Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }>((resolve) => {
      const done = trackCommand(`tar -czf ${file}`, dir);
      const tar = spawn('tar', ['-czf', file, '--null', '-T', '-'], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      tar.stderr.on('data', (d) => { if (err.length < 2000) err += String(d); });
      tar.stdin.on('error', () => {});
      tar.on('error', (e) => { done(); resolve({ ok: false, error: e.message }); });
      tar.on('close', (code) => {
        done();
        if (code === 0) resolve({ ok: true, file, bytes: fs.statSync(file).size });
        else { fs.rmSync(file, { force: true }); resolve({ ok: false, error: tarError(err, code) }); }
      });
      tar.stdin.end(present.join('\0') + '\0');
    });
    if (r.ok) {
      const mine = ofFolder(folder);
      const old = fs.readdirSync(root).filter((n) => mine.test(n)).sort();
      for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(root, n), { force: true });
    }
    return r;
  } catch (e: any) { return { ok: false, error: e.message }; }
}

const tarError = (err: string, code: number | null) => err.trim().replace(/\s+/g, ' ').slice(0, 300) || `tar exited ${code}`;

/** tar's output piped into a resumable upload (gcp.ts gcsUploadStream); a tar that fails leaves no object behind. */
async function backupToBucket(dir: string, folder: string, present: string[], bucket: string, prefix: string, name: string): Promise<{ ok: true; file: string; bytes: number } | { ok: false; error: string }> {
  const { gcsUploadStream, gcsDelete, gcsList } = await import('./gcp.ts');
  const key = `${prefix}${name}`;
  const url = `gs://${bucket}/${key}`;
  const done = trackCommand(`tar -cz | ${url}`, dir);
  const tar = spawn('tar', ['-cz', '--null', '-T', '-'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  let spawnError = '';
  tar.stderr.on('data', (d) => { if (err.length < 2000) err += String(d); });
  tar.stdin.on('error', () => {});
  const exit = new Promise<number | null>((resolve) => {
    tar.on('error', (e) => { spawnError = e.message; resolve(null); });
    tar.on('close', (code) => resolve(code));
  });
  tar.stdin.end(present.join('\0') + '\0');
  try {
    let bytes: number;
    try {
      bytes = await gcsUploadStream(bucket, key, tar.stdout, 'application/gzip');
    } catch (e: any) {
      tar.kill('SIGKILL');
      await exit;
      return { ok: false, error: String(e.message ?? e).slice(0, 300) };
    }
    const code = await exit;
    if (code !== 0) {
      await gcsDelete(bucket, key).catch(() => {});
      return { ok: false, error: spawnError || tarError(err, code) };
    }
    // Retention, now that the new one is safe: the folder's older backups beyond KEEP_BACKUPS go.
    try {
      const mine = ofFolder(folder);
      const old = (await gcsList(bucket, `${prefix}${folder}-`)).map((o) => o.name).filter((n) => mine.test(n.slice(prefix.length))).sort();
      for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await gcsDelete(bucket, n);
    } catch (e: any) { console.warn(`[repos] ${folder}: pruning old backups failed: ${e.message ?? e}`); }
    return { ok: true, file: url, bytes };
  } finally { done(); }
}

/**
 * Of `files` (relative to `dir`, all present), those whose content is exactly what git has at the same path in one of
 * `revs` (HEAD, origin/beta): they are on GitHub, so backing them up saves nothing. A half-written checkout (a clone or
 * switch cut off partway) is mostly these: PH Origins' 1,256 "changes" were its whole beta tree (2026-11-01). Anything
 * git can't vouch for (not in those trees, not a regular file, a failed hash) is not in the set, so it is backed up.
 */
export async function sameAsGit(dir: string, files: string[], revs: string[]): Promise<Set<string>> {
  const known = new Map<string, Set<string>>();
  for (const rev of revs) {
    const t = await gitA(dir, ['ls-tree', '-r', '-z', '--full-tree', rev]);
    if (!t.ok) continue;
    for (const e of t.out.split('\0')) {
      const tab = e.indexOf('\t');
      const [, type, oid] = e.slice(0, tab).split(' ');
      if (tab < 0 || type !== 'blob') continue;
      const p = e.slice(tab + 1);
      (known.get(p) ?? known.set(p, new Set()).get(p)!).add(oid);
    }
  }
  const ask = files.filter((f) => known.has(f) && !f.includes('\n') && (() => { try { return fs.lstatSync(path.join(dir, f)).isFile(); } catch { return false; } })());
  const same = new Set<string>();
  if (!ask.length) return same;
  const oids = await new Promise<string[] | null>((resolve) => {
    const done = trackCommand(`git hash-object --stdin-paths (${ask.length} files)`, dir);
    const h = spawn('git', ['hash-object', '--stdin-paths'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    h.stdout.on('data', (d) => { out += d; });
    h.stdin.on('error', () => {});
    h.on('error', () => { done(); resolve(null); });
    h.on('close', (code) => { done(); resolve(code === 0 ? out.split('\n').filter(Boolean) : null); });
    h.stdin.end(ask.join('\n') + '\n');
  });
  if (!oids || oids.length !== ask.length) return same;
  ask.forEach((f, i) => { if (known.get(f)!.has(oids[i])) same.add(f); });
  return same;
}

/**
 * The generated build output in a repo folder (products.json): for every product in it with a pre-deploy build or a
 * Unity build, play/, dist/ and Game/v<n>/ under its site folder, plus any deploy.output paths. A test on a path
 * relative to the repo's root.
 */
export function buildOutputs(folder: string): (file: string) => boolean {
  const products = (JSON.parse(fs.readFileSync(paths.products, 'utf8')).products ?? []) as any[];
  const tests: ((f: string) => boolean)[] = [];
  for (const p of products) {
    if (!p.deploy?.prebuild && !p.build) continue;
    const at = [p.site, p.repo].find((x) => typeof x === 'string' && x.split('/')[0] === folder);
    if (!at) continue;
    const base = at.split('/').slice(1).join('/');
    const extra = ((p.deploy?.output ?? []) as string[]).map((o) => o.replace(/^\.?\//, ''));
    tests.push((f) => {
      if (base && !f.startsWith(`${base}/`)) return false;
      const rel = base ? f.slice(base.length + 1) : f;
      return /^(play|dist)\/|^Game\/v\d+\//.test(rel) || extra.some((o) => rel === o || rel.startsWith(o.endsWith('/') ? o : `${o}/`));
    });
  }
  return (f) => tests.some((t) => t(f));
}

/**
 * Brings one repo up to date: clone if missing; else fetch, and fast-forward the branch when the working tree is
 * clean (local changes are never thrown away: the repo is "kept" and reported). The one exception: on the server, a
 * beta source checkout whose only changes are generated build output (buildOutputs: a leftover build) has them
 * discarded, named in the result, and is updated; any other uncommitted changes there are set aside in a git stash
 * (never deleted; Talk is told how to get them back) and it is updated, or "kept" as before when the stash fails. With `want`, a clean checkout is switched to that branch first when
 * origin has it (the server keeps product source repos on beta).
 */
/**
 * Syncs in flight, per repo folder: one at a time. Two at once (a desktop and a phone playtest of the same game start
 * together) meant one cloned while the other saw the new .git, fetched, found every file "missing" mid-checkout and
 * tried to stash them: PH Origins' checkout sat on main with ~1,300 "changes" (2026-11-01).
 */
const syncing = new Map<string, Promise<unknown>>();

/** Waits for the sync of a folder that is running or queued, if any (a folder mid-clone isn't ready to use). */
export const syncSettled = async (folder: string) => { await syncing.get(folder)?.catch(() => {}); };

export function syncRepo(folder: string, slug: string, branch = BRANCH, want?: string): Promise<RepoResult> {
  const prev = syncing.get(folder) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => syncRepoNow(folder, slug, branch, want));
  const tail = run.catch(() => {});
  syncing.set(folder, tail);
  void tail.then(() => { if (syncing.get(folder) === tail) syncing.delete(folder); });
  return run;
}

async function syncRepoNow(folder: string, slug: string, branch: string, want?: string): Promise<RepoResult> {
  const dir = path.join(PROJECTS, folder);
  const before = fs.existsSync(path.join(dir, '.git')) ? git(dir, ['rev-parse', 'HEAD']).out : '';
  const r = await syncGit(folder, slug, branch, want);
  // The shared checkout's Git LFS files (the store every worktree of it reads from), and its pre-push hook. A light
  // clone (Cloud Run, a big repo) gets neither LFS files nor an npm ci: lfsPull skips it, and so does the install.
  if (r.action !== 'failed') await lfsPull(dir);
  return lightCheckout(dir) ? r : installAfterSync(r, before);
}

/** True on Cloud Run, where the repo folder is the instance's memory disk: big repos take the light path there. */
export const cloudHost = () => Boolean(process.env.K_SERVICE);

/** Megabytes of repo over which, on Cloud Run, a clone is light (partial, no LFS files, no npm ci): STUDIO_CLONE_MAX_MB. */
export const cloneMaxMb = () => Number(process.env.STUDIO_CLONE_MAX_MB) || 600;

/** GitHub's size of a repo in MB (what a clone downloads), cached per repo; null when GitHub doesn't say. */
const sizes = new Map<string, { mb: number; at: number }>();
const SIZE_TTL_MS = 30 * 60_000;
export async function repoSizeMb(slug: string, fetcher: typeof fetch = fetch): Promise<number | null> {
  const key = slug.toLowerCase();
  const hit = sizes.get(key);
  if (hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.mb;
  try {
    const token = await repoToken(slug).catch(() => null);
    const r = await fetcher(`${process.env.STUDIO_GITHUB_API ?? 'https://api.github.com'}/repos/${slug}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'hawkes-studio', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const kb = Number((await r.json() as any)?.size);
    if (!Number.isFinite(kb)) return null;
    const mb = Math.round(kb / 1024);
    // Only a real answer is kept: not knowing (no token, GitHub down) asks again next time.
    sizes.set(key, { mb, at: Date.now() });
    return mb;
  } catch { return null; }
}

/** Forgets the cached sizes (tests). */
export const forgetRepoSizes = () => sizes.clear();

type CloneProduct = Pick<Product, 'id' | 'engine' | 'repo' | 'site'> & Partial<Pick<Product, 'github' | 'repos' | 'builds' | 'build'>>;

/** A Unity project: a legacy products.json `build`, a `builds` entry with tool unity, or the unity engine. */
export const isUnityProduct = (p: CloneProduct) => (p.engine as string) === 'unity' || Boolean(p.build) || Boolean(p.builds?.some((b) => b.tool === 'unity'));

/** Every GitHub repo (owner/name) a product's work would clone: its repo, its site's and its other `repos`. */
export function productSlugs(p: CloneProduct, map: Record<string, string> = safeRepoMap()): string[] {
  const ofPath = (rel?: string) => {
    const top = rel?.split(/[\\/]/)[0];
    return top ? map[top] ?? null : null;
  };
  const all = [p.github, ofPath(p.repo), ofPath(p.site), ...(p.repos ?? []).map((r) => (r.folder ? map[r.folder] : null) ?? r.repo)];
  return [...new Set(all.filter((s): s is string => Boolean(s) && /^[\w.-]+\/[\w.-]+$/.test(s!)))];
}

function safeRepoMap() {
  try { return repoMap(); } catch { return {}; }
}

/**
 * Whether a repo is big (why, else null): over STUDIO_CLONE_MAX_MB by GitHub's size, or used only by Unity projects
 * (their repos run to GBs). Only asked on Cloud Run, where a big repo is cloned light (syncGit) and its agent work's
 * heavy part (the full checkout, LFS files) happens in the Cloud Run job; nothing is refused for it any more (a full
 * clone of a 3 GB Unity repo filled the memory disk and every restart resumed it, 2026-10-31 and 2026-11-01). Off
 * Cloud Run, always null and GitHub is never asked.
 */
export async function bigRepo(slug: string, fetcher: typeof fetch = fetch, folder?: string): Promise<string | null> {
  if (!cloudHost()) return null;
  const unity = unityOnlyRepo(slug, folder);
  if (unity) return unity;
  const mb = await repoSizeMb(slug, fetcher);
  return mb !== null && mb > cloneMaxMb() ? `${slug} is about ${mb} MB (over ${cloneMaxMb()} MB)` : null;
}

/** Whether any repo a product would clone is big (why, else null): routing and logging only, never a refusal. */
export async function bigProduct(p: CloneProduct, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!cloudHost()) return null;
  if (isUnityProduct(p)) return `${p.id} is a Unity project`;
  for (const slug of productSlugs(p)) {
    const big = await bigRepo(slug, fetcher);
    if (big) return big;
  }
  return null;
}

/**
 * On Cloud Run, a Unity project's builds come from GitHub (Gen builds the commit; beta sites publish from GitHub), so a
 * run or a beta push has no need of its checkout here: why not, else null. Not a refusal: the run carries on.
 */
export const builtFromGitHub = (p: CloneProduct) => cloudHost() && isUnityProduct(p) ? `${p.id} is a Unity project, built from GitHub: no checkout needed on the cloud server` : null;

/** A repo that only Unity projects use (why, else null); one a web project shares isn't. */
function unityOnlyRepo(slug: string, folder?: string): string | null {
  let products: Product[];
  try { products = loadProducts(); } catch { return null; }
  const map = { ...safeRepoMap(), ...(folder ? { [folder]: slug } : {}) };
  const users = products.filter((p) => productSlugs(p, map).some((s) => s.toLowerCase() === slug.toLowerCase()));
  const unity = users.filter(isUnityProduct);
  return users.length && unity.length === users.length ? `${slug} belongs to a Unity project (${unity.map((p) => p.id).join(', ')})` : null;
}

/**
 * The clone's arguments: a full clone, or on the light path a partial one (`--filter=blob:none`: history without file
 * contents; git fetches the blobs a checkout needs). A light clone's LFS files are skipped (GIT_LFS_SKIP_SMUDGE, and the
 * smudge filter set to skip in its config so later checkouts and worktrees skip them too). Exported for the tests.
 */
export const cloneArgs = (slug: string, folder: string, light: boolean) => ['clone', '--quiet', '--no-checkout', ...(light ? ['--filter=blob:none'] : []), `https://github.com/${slug}.git`, folder];

/** git's reason in one line: its last non-empty line, or what a silent failure most likely was (killed: a timeout or memory). */
/** The last `n` non-empty lines of git's output on one line (its reason is usually the last two or three). */
export const lastLines = (err: string, n = 3) => err.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ') || 'git exited without saying why (likely killed: a timeout or out of memory)';
export const lastLine = (err: string) => err.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'git exited without saying why (likely killed: a timeout or out of memory)';

/** What a light clone gets in its config: LFS smudge skipped, and the mark lfs.ts and warm.ts read (hawkes.light). */
export const LIGHT_CONFIG: [string, string][] = [
  ['hawkes.light', 'true'],
  ['filter.lfs.smudge', 'git-lfs smudge --skip -- %f'],
  ['filter.lfs.process', 'git-lfs filter-process --skip'],
];

/**
 * Why the server's checkout of a repo can't be thrown away and cloned again, else null: agents' worktrees hang off
 * its .git (a new clone would orphan them), or a fetch or push of it is under way.
 */
export function recloneBlocked(dir: string): string | null {
  const wt = git(dir, ['worktree', 'list', '--porcelain']);
  const others = wt.ok ? wt.out.split('\n').filter((l) => l.startsWith('worktree ')).length - 1 : 0;
  if (others > 0) return `${others} worktree${others === 1 ? '' : 's'} (agents' or the beta working copy) use it`;
  if (repoBusy(repoKey(dir))) return 'a fetch or push of it is running';
  return null;
}

/**
 * Moves a checkout that can't be cleared out of the way (to PROJECTS/.trash, deleted in the background) and clones it
 * again, on `want`. Only after what was in it is saved (syncGit).
 */
async function reclone(folder: string, slug: string, branch: string, want: string): Promise<RepoResult> {
  const dir = path.join(PROJECTS, folder);
  const trash = path.join(PROJECTS, '.trash', `${folder}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(dir, trash);
  } catch (e: any) {
    return { folder, slug, action: 'failed', detail: `moving the old checkout aside failed: ${e.message}` };
  }
  void fs.promises.rm(trash, { recursive: true, force: true }).catch((e) => console.warn(`[repos] ${folder}: removing ${trash} failed: ${e.message}`));
  console.log(`[repos] ${folder}: moved the old checkout to ${trash} (being deleted); cloning it again`);
  return syncGit(folder, slug, branch, want);
}

async function syncGit(folder: string, slug: string, branch: string, want?: string): Promise<RepoResult> {
  const dir = path.join(PROJECTS, folder);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { folder, slug, action: 'failed', detail: `${dir} exists and isn't a git repo` };
    await primeRepoToken(slug);
    // On Cloud Run a big repo is cloned light (bigRepo, cloneArgs): the agent's job does the heavy checkout itself.
    const big = await bigRepo(slug, fetch, folder);
    // --no-checkout, then one checkout of the branch it should be on: a light clone fetches file contents as it checks
    // out, and checking out main and then beta did that twice. A clone or checkout that fails (or is killed: a timeout,
    // the instance's memory) leaves a half-written folder that every later sync read as ~1,300 uncommitted changes and
    // refused to touch (PH Origins, 2026-11-01): it is removed instead, so the next sync clones it again.
    const halfClone = (what: string, err: string) => {
      fs.rmSync(dir, { recursive: true, force: true });
      const why = lastLines(err);
      console.warn(`[repos] ${folder}: ${what} failed (${why}); removed the half-made clone, the next sync clones it again`);
      return { folder, slug, action: 'failed' as const, detail: `${what} failed: ${why} (removed the half-made clone; the next sync clones it again)` };
    };
    let c = await gitA(PROJECTS, cloneArgs(slug, folder, Boolean(big)), undefined, slug, big ? { GIT_LFS_SKIP_SMUDGE: '1' } : {});
    if (!c.ok) {
      // Once more after 3 seconds, from a clean folder (a killed clone leaves a half-made one that would refuse the retry).
      console.warn(`[repos] ${folder}: clone failed (${lastLines(c.err)}); trying once more in 3 seconds`);
      fs.rmSync(dir, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, CLONE_RETRY_MS));
      c = await gitA(PROJECTS, cloneArgs(slug, folder, Boolean(big)), undefined, slug, big ? { GIT_LFS_SKIP_SMUDGE: '1' } : {});
    }
    if (!c.ok) return halfClone('clone', c.err);
    if (big) for (const [k, v] of LIGHT_CONFIG) git(dir, ['config', k, v]);
    const pick = [want, branch].find((b) => b && git(dir, ['rev-parse', '--verify', '--quiet', `origin/${b}`]).ok)
      ?? git(dir, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).out.replace(/^origin\//, '');
    const co = await gitA(dir, ['checkout', '--quiet', ...(pick ? [pick] : [])], undefined, slug, big ? { GIT_LFS_SKIP_SMUDGE: '1' } : {});
    if (!co.ok || git(dir, ['status', '--porcelain']).out) return halfClone(`checking out ${pick || 'the default branch'}`, co.ok ? 'files missing after the checkout' : co.err);
    const how = big ? `; light clone (partial, no LFS files, no npm ci: ${big})` : '';
    if (big) console.log(`[repos] ${folder}: light clone: ${big}`);
    return { folder, slug, action: 'cloned', detail: `cloned (${pick ?? 'default branch'})${how}`, head: git(dir, ['log', '-1', '--format=%h %s']).out };
  }
  // Under the repo's lock with agents' and betawatch's fetches (gitlock.ts). A ref lock that outlasts the retries means
  // another git just updated those refs: carry on with them rather than fail the run over a race.
  await primeRepoToken(slug);
  const f = await fetchLocked(dir, ['fetch', '--quiet', '--prune', 'origin'], (a) => gitA(dir, a, undefined, slug), (l) => console.log(`[repos] ${l}`));
  if (!f.ok && !REF_LOCK.test(f.err)) return { folder, slug, action: 'failed', detail: `fetch failed: ${f.err.split('\n').pop()}` };
  const raced = f.ok ? '' : `fetch kept hitting a ref lock (another fetch of this repo), used the refs it left; `;
  let cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const dirty = git(dir, ['status', '--porcelain']).out;
  let cleaned = '';
  let discarded: string[] | undefined;
  let setAside: RepoResult['setAside'];
  function done(r: RepoResult, action: RepoResult['action'] = r.action): RepoResult {
    r = { ...r, action };
    if (setAside) tellSetAside(dir, folder, want!, setAside, r);
    if (raced) r = { ...r, detail: raced + r.detail };
    return cleaned ? { ...r, detail: cleaned + r.detail, ...(discarded ? { discarded } : {}), ...(setAside ? { setAside } : {}) } : r;
  }
  if (dirty) {
    const tracked = git(dir, ['diff', '--name-only', '--no-renames', 'HEAD']).out.split('\n').filter(Boolean);
    const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean);
    const files = [...new Set([...tracked, ...untracked])];
    const output = want && isServer() ? buildOutputs(folder) : null;
    const kept = (why = '') => ({ folder, slug, action: 'kept' as const, detail: `${cur}: uncommitted changes (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}), not updated${why}`, head: git(dir, ['log', '-1', '--format=%h %s']).out, dirty: files });
    if (!output) return kept();
    if (files.length && files.every(output)) {
      // Only build output: a leftover build, regenerated by the next one. Back to HEAD, and say exactly what went.
      const r = tracked.length ? await gitA(dir, ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]) : { ok: true, err: '' };
      const c = r.ok && untracked.length ? await gitA(dir, ['--literal-pathspecs', 'clean', '-f', '-q', '--', ...untracked]) : r;
      if (!r.ok || !c.ok) return { folder, slug, action: 'failed', detail: `${cur}: discarding build output failed: ${(r.ok ? c : r).err.split('\n').pop()}`, head: git(dir, ['log', '-1', '--format=%h %s']).out, dirty: files };
      if (git(dir, ['status', '--porcelain']).out) return { folder, slug, action: 'kept', detail: `${cur}: still has uncommitted changes after discarding build output, not updated`, head: git(dir, ['log', '-1', '--format=%h %s']).out, dirty: files };
      console.log(`[repos] ${folder}: discarded uncommitted build output (${files.length} files): ${files.join(', ')}`);
      discarded = files;
      cleaned = `discarded uncommitted build output (${files.slice(0, 20).join(', ')}${files.length > 20 ? `, and ${files.length - 20} more` : ''}); `;
    } else {
      // Not only build output, on a beta source checkout on the server: stray files (an asset made into the checkout,
      // 2026-10-18) froze beta twice. Set them aside in a stash (nothing is lost) and follow beta; Talk hears how to
      // get them back. A stash that fails keeps today's refusal (staleBeta tells Talk).
      const to = git(dir, ['rev-parse', '--short', `origin/${want}`]).out || want;
      const label = `studio: set aside before following ${want} ${to} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const s = await gitA(dir, ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai', 'stash', 'push', '--include-untracked', '-m', label]);
      const list = files.slice(0, 20).join(', ') + (files.length > 20 ? `, and ${files.length - 20} more` : '');
      if (s.ok && !git(dir, ['status', '--porcelain']).out) {
        const stash = git(dir, ['rev-parse', 'stash@{0}']).out;
        console.log(`[repos] ${folder}: set aside uncommitted changes in stash ${stash.slice(0, 7)} (${files.length} files): ${files.join(', ')}`);
        setAside = { stash, label, files };
        cleaned = `set aside uncommitted changes in stash ${stash.slice(0, 7)} (${list}); `;
      } else {
        // The stash failed (or left changes behind): say why in full, then back the files that are there up to a tar
        // (backupFiles: the state bucket on Cloud Run, the data folder elsewhere) and only then put the checkout back to
        // HEAD. No backup, no reset: the refusal stays. What GitHub already has holds nothing to lose: files git expects
        // but that aren't there, and files exactly as they are in HEAD or origin/<want> (sameAsGit). A half-written
        // checkout (a clone or switch killed partway) is all of those: PH Origins 2026-11-01, 1,256 "changes", its whole
        // beta tree, tarred to ~518 MiB on a cell's in-memory disk. So with nothing else there, nothing is backed up.
        const why = s.ok ? 'it left uncommitted changes in the checkout' : lastLine(s.err).slice(0, 500);
        console.warn(`[repos] ${folder}: git stash failed (${why}); backing the ${files.length} files up to a tar`);
        const present = files.filter((f) => { try { fs.lstatSync(path.join(dir, f)); return true; } catch { return false; } });
        const same = present.length ? await sameAsGit(dir, present, ['HEAD', `origin/${want}`]) : new Set<string>();
        const toSave = present.filter((f) => !same.has(f));
        let backup: string | undefined;
        if (toSave.length) {
          const b = await backupFiles(dir, folder, toSave);
          if (!b.ok) {
            console.warn(`[repos] ${folder}: tar backup failed: ${b.error}`);
            return kept(`; setting them aside failed: git stash: ${why}; tar backup: ${b.error}`);
          }
          backup = b.file;
          console.log(`[repos] ${folder}: backed up ${toSave.length} files to ${backup} (${(b.bytes / 1048576).toFixed(1)} MiB)`);
        }
        const leftOut = same.size ? `; ${same.size} unchanged from GitHub left out` : '';
        const saved = backup ? `backed up to ${backup}${leftOut}`
          : present.length ? `the ${present.length} files there are unchanged from GitHub (HEAD or origin/${want}), nothing to back up (a half-written checkout)`
          : `none of the ${files.length} files were there to back up (a half-written checkout)`;
        const unchanged = same.size || undefined;
        const r = tracked.length ? await gitA(dir, ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]) : { ok: true, err: '' };
        const c = r.ok && untracked.length ? await gitA(dir, ['--literal-pathspecs', 'clean', '-f', '-q', '--', ...untracked]) : r;
        if (!r.ok || !c.ok || git(dir, ['status', '--porcelain']).out) {
          const e = r.ok && c.ok ? 'changes remain' : lastLine((r.ok ? c : r).err);
          // Last resort: the server's copy is only ever a clone of GitHub, and what was in it is saved: clone it again.
          const blocked = recloneBlocked(dir);
          if (blocked) {
            console.warn(`[repos] ${folder}: ${saved} but couldn't clear the checkout (${e}), and won't clone it again: ${blocked}`);
            return kept(`; setting them aside failed: git stash: ${why}; ${saved} but clearing the checkout failed: ${e}; not cloned again: ${blocked}`);
          }
          console.warn(`[repos] ${folder}: ${saved} but couldn't clear the checkout (${e}); cloning it again`);
          const again = await reclone(folder, slug, branch, want!);
          setAside = { stash: '', label, files, backup, unchanged, why, recloned: true };
          cleaned = `git stash failed (${why}); ${saved} (${list}); clearing the checkout failed (${e}), so it was cloned again; `;
          return done(again, again.action === 'cloned' ? 'updated' : again.action);
        }
        console.log(`[repos] ${folder}: git stash failed (${why}); ${saved}, then cleared them: ${files.join(', ')}`);
        setAside = { stash: '', label, files, backup, unchanged, why };
        cleaned = `git stash failed (${why}); ${backup ? `backed up uncommitted changes to ${backup}${leftOut}` : saved} (${list}); `;
      }
    }
  }
  let switched = '';
  if (want && cur !== want && git(dir, ['rev-parse', '--verify', '--quiet', `origin/${want}`]).ok) {
    const c = await gitA(dir, ['checkout', '--quiet', want]);
    if (!c.ok) return done({ folder, slug, action: 'failed', detail: `switching to ${want} failed: ${c.err.split('\n').pop()}` });
    switched = `switched ${cur} -> ${want}; `;
    cur = want;
  }
  const behind = Number(git(dir, ['rev-list', '--count', `HEAD..origin/${cur}`]).out) || 0;
  if (!behind) return done({ folder, slug, action: switched ? 'updated' : 'current', detail: `${switched}${cur} is up to date`, head: git(dir, ['log', '-1', '--format=%h %s']).out });
  const m = await gitA(dir, ['merge', '--ff-only', '--quiet', `origin/${cur}`]);
  if (!m.ok) return done({ folder, slug, action: 'kept', detail: `${switched}${cur} has local commits; not fast-forwarded`, head: git(dir, ['log', '-1', '--format=%h %s']).out });
  return done({ folder, slug, action: 'updated', detail: `${switched}${cur}: ${behind} new commits`, head: git(dir, ['log', '-1', '--format=%h %s']).out });
}

export type Install = { dir: string; why: string; ok: boolean; seconds: number; error?: string };

/** The web products' checkouts (products.json local.serve "npm"), relative to PROJECTS; only `folder`'s when given. */
export function webCheckouts(folder?: string) {
  const products = (JSON.parse(fs.readFileSync(paths.products, 'utf8')).products ?? []) as any[];
  const dirs = new Set<string>();
  for (const p of products) if (p.local?.serve === 'npm' && typeof p.local.dir === 'string' && (!folder || p.local.dir.split('/')[0] === folder)) dirs.add(p.local.dir);
  return [...dirs].filter((d) => fs.existsSync(path.join(PROJECTS, d, 'package-lock.json')));
}

/** Why `rel`'s node_modules needs an npm ci (`changed`: files the sync brought in, repo-relative), or null. */
function installReason(rel: string, changed: string[] = []) {
  const dir = path.join(PROJECTS, rel);
  const sub = rel.split('/').slice(1).join('/');
  const touched = (f: string) => changed.includes(sub ? `${sub}/${f}` : f);
  const was = installedFor(dir);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return 'no node_modules';
  if (touched('package-lock.json')) return 'package-lock.json changed';
  if (touched('package.json')) return 'package.json changed';
  if (was !== lockHash(dir)) return was ? 'installed for another package-lock.json' : 'no record of an install for this package-lock.json';
  return null;
}

const installing = new Map<string, Promise<Install>>();
/** The last failed install per checkout (its lockfile hash): not retried for 10 minutes unless the lockfile changes. */
const failedInstall = new Map<string, { hash: string | null; error: string; at: number }>();

/** npm ci in a web checkout (one at a time per checkout), stamped (warm.ts) so warm starts may copy it. */
export function installIn(rel: string, why: string): Promise<Install> {
  const dir = path.join(PROJECTS, rel);
  const hash = lockHash(dir);
  const failed = failedInstall.get(rel);
  if (failed && failed.hash === hash && Date.now() - failed.at < 10 * 60_000) return Promise.resolve({ dir: rel, why, ok: false, seconds: 0, error: `${failed.error} (failed ${Math.round((Date.now() - failed.at) / 60_000)} min ago; retried when package-lock.json changes or after 10 minutes)` });
  const busy = installing.get(rel);
  if (busy) return busy;
  const job = (async (): Promise<Install> => {
    // Through warm.ts's ensureInstalled: one install at a time per checkout, whoever asks (a local server, a sync).
    const r = await ensureInstalled(dir, { why, run: (d, cmd) => { const done = trackCommand(cmd, rel); return runShell(d, cmd).finally(done); } });
    const seconds = Math.round(r.ms / 1000);
    if (!r.ok) {
      const error = r.error ?? 'npm ci failed';
      failedInstall.set(rel, { hash, error, at: Date.now() });
      console.warn(`[repos] ${rel}: npm ci failed (${why}, ${seconds} s): ${error}`);
      return { dir: rel, why, ok: false, seconds, error };
    }
    failedInstall.delete(rel);
    console.log(`[repos] ${rel}: dependencies changed: npm ci (${why}, ${seconds} s)`);
    // A local server started before has the old packages loaded: the next playtest starts it again.
    await import('./local.ts').then(({ stopServerIn }) => stopServerIn(rel)).catch(() => {});
    return { dir: rel, why, ok: true, seconds };
  })().finally(() => installing.delete(rel));
  installing.set(rel, job);
  return job;
}

/**
 * On the server, after a sync: npm ci in the repo's web checkouts whose packages don't match (the sync changed
 * package-lock.json or package.json, or the stamp of the last install is for another lockfile or missing), before a
 * build or a local playtest uses them. Each install is on the result (detail, `install`); a failed one fails it.
 */
async function installAfterSync(r: RepoResult, before: string): Promise<RepoResult> {
  if (!isServer() || r.action === 'failed' || r.action === 'kept') return r;
  const dir = path.join(PROJECTS, r.folder);
  const after = git(dir, ['rev-parse', 'HEAD']).out;
  const changed = before && after && before !== after ? git(dir, ['diff', '--name-only', before, after]).out.split('\n').filter(Boolean) : [];
  for (const rel of webCheckouts(r.folder)) {
    const why = installReason(rel, changed);
    if (!why) continue;
    const i = await installIn(rel, why);
    (r.install ??= []).push(i);
    r.detail += i.ok ? `; dependencies changed: npm ci in ${rel} (${why}): ${i.seconds} s` : `; npm ci in ${rel} failed (${why}): ${i.error}`;
    if (!i.ok) r.action = 'failed';
  }
  return r;
}

/**
 * Once at start on the server: every web checkout whose packages weren't installed for its lockfile (the stamp
 * differs or is missing: a checkout synced before Studio installed after syncs) gets an npm ci, one at a time.
 */
export async function reinstallStale() {
  const out: Install[] = [];
  if (!isServer()) return out;
  for (const rel of webCheckouts()) {
    if (!fs.existsSync(path.join(PROJECTS, rel.split('/')[0], '.git'))) continue;
    const why = installReason(rel);
    if (why) out.push(await installIn(rel, why));
  }
  return out;
}

/** Where syncRepo's notices go: a Talk notice (tests replace it). */
export const repoNotices = {
  post: (title: string, text: string) => { void import('./talk.ts').then(({ postNotice }) => postNotice(title, text)).catch(() => {}); },
};

/** How to list and restore a backup: a gs:// one (Cloud Run: the instance and its checkout are gone) from anywhere with gcloud, a local one on the server. */
export function restoreSteps(backup: string, dir: string) {
  if (backup.startsWith('gs://')) {
    return `It is in Cloud Storage (the instance's checkout doesn't last). To get them back, from a machine signed in to gcloud with access to the bucket, into a checkout of the repo:\n\n\`\`\`\ngcloud storage cat ${backup} | tar -tzf -   # list\ngcloud storage cat ${backup} | tar -xzf - -C <your checkout>   # restore\n\`\`\``;
  }
  return `To get them back, on the server:\n\n\`\`\`\ntar -tzf ${backup}   # list\ntar -xzf ${backup} -C ${dir}   # restore\n\`\`\``;
}

/** One Talk notice for changes set aside in a stash: the files, the stash, and how to look at them or get them back. */
function tellSetAside(dir: string, folder: string, want: string, a: NonNullable<RepoResult['setAside']>, r: RepoResult) {
  const list = a.files.slice(0, 20).join(', ') + (a.files.length > 20 ? `, and ${a.files.length - 20} more` : '');
  const g = `git -C ${dir}`;
  const after = r.action === 'updated' || r.action === 'current' ? `and the checkout follows ${want} again (${r.head ?? ''})` : `but it still couldn't follow ${want}: ${r.detail}`;
  if (!a.stash) {
    const how = a.recloned ? 'cleared them by cloning the checkout again (clearing them in place failed)' : 'then cleared them';
    const same = a.unchanged ? ` ${a.unchanged} of them were exactly as they are on GitHub (HEAD or ${want}), so they were left out of it.` : '';
    const kept = a.backup
      ? `Studio backed them up first and ${how}, ${after}.${same}\n\nFiles: ${list}\n\nThe backup: ${a.backup}\n\n${restoreSteps(a.backup, dir)}`
      : a.unchanged
        ? `The files that were there were exactly as they are on GitHub (a half-written checkout: a clone or switch that was cut off), so there was nothing to back up; Studio ${how.replace(/^then /, '')}, ${after}.\n\nFiles: ${list}`
        : `None of those files were there (a half-written checkout: a clone or switch that was cut off), so there was nothing to back up; Studio ${how.replace(/^then /, '')}, ${after}.\n\nFiles: ${list}`;
    repoNotices.post(`${folder}: stray files ${a.backup ? 'backed up' : 'cleared'} to follow ${want}`, `The server's ${want} checkout of ${folder} had uncommitted files that aren't build output. git stash failed (${a.why}). ${kept}`);
    return;
  }
  repoNotices.post(`${folder}: stray files set aside to follow ${want}`, `The server's ${want} checkout of ${folder} had uncommitted files that aren't build output, which kept it from following ${want}. Studio set them aside in a git stash (nothing was deleted), ${after}.\n\nFiles: ${list}\n\nThe stash: "${a.label}" (${a.stash.slice(0, 7)}).\n\nTo look at them or get them back, on the server:\n\n\`\`\`\n${g} stash list\n${g} stash show -p --include-untracked ${a.stash.slice(0, 7)}\n${g} stash pop stash@{N}   # N: its number in stash list (0 while it's the newest)\n\`\`\`\n\nIf it's work worth keeping, commit it to ${want} (from an agent's own worktree, not this checkout). If not, drop it: ${g} stash drop stash@{N}.`);
}

/** The repos agents change (each product's source repo): on the server they're kept on beta, so local playtests play it. */
export function betaFolders() {
  const products = JSON.parse(fs.readFileSync(paths.products, 'utf8')).products as { repo: string }[];
  return new Set(products.map((p) => p.repo.split('/')[0]));
}

/** products.json "repoSetup": folder -> a shell command run in it after a clone or an update (on the server). */
export function repoSetup(): Record<string, string> {
  const all = JSON.parse(fs.readFileSync(paths.products, 'utf8')).repoSetup ?? {};
  return Object.fromEntries(Object.entries(all).filter(([k, v]) => !k.startsWith('$') && typeof v === 'string')) as Record<string, string>;
}

/** Runs a repo's setup (hawkes-assets: install, then pull its files from S3) and notes how it went on the result. */
async function setUp(r: RepoResult, cmd: string) {
  const done = trackCommand(cmd, r.folder);
  const res = await new Promise<{ ok: boolean; tail: string }>((resolve) => {
    let log = '';
    const child = spawn('bash', ['-lc', cmd], { cwd: path.join(PROJECTS, r.folder), windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60 * 60_000);
    timer.unref();
    const keep = (d: Buffer) => { log = (log + d).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, tail: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, tail: log.trim().split('\n').filter(Boolean).slice(-2).join(' | ') }); });
  });
  done();
  r.detail += res.ok ? `; set up (${res.tail.slice(0, 160) || 'ok'})` : `; setup failed: ${res.tail.slice(0, 300)}`;
  if (!res.ok) r.action = 'failed';
}

/** Every product repo. On the server, source repos are switched to beta (when it exists); website repos stay on main. */
export async function syncRepos(only?: string[]) {
  const beta = isServer() ? betaFolders() : new Set<string>();
  const setup = isServer() ? repoSetup() : {};
  const out: RepoResult[] = [];
  // One at a time: they share the network and the disk.
  for (const [f, s] of Object.entries(repoMap()).filter(([f]) => !only?.length || only.includes(f))) {
    const r = await syncRepo(f, s, BRANCH, beta.has(f) ? BETA : undefined);
    if (setup[f] && (r.action === 'cloned' || r.action === 'updated')) await setUp(r, setup[f]);
    out.push(r);
  }
  return out;
}

/**
 * Clones a product repo that isn't here yet (Studio on Cloud Run starts with none: they are cloned on demand, with the
 * GitHub token from Secret Manager through git's credential helper set up by the image's entry). `rel` is a path under
 * PROJECTS whose first folder is the repo. A repo already here is left as it is.
 */
export async function ensureCloned(rel: string, slugIn?: string) {
  const top = rel.split(/[\\/]/)[0];
  await syncSettled(top);
  if (fs.existsSync(path.join(PROJECTS, top, '.git'))) return null;
  const slug = repoMap()[top] ?? slugIn;
  if (!slug) return null;
  fs.mkdirSync(PROJECTS, { recursive: true });
  const r = repoMap()[top] ? (await syncRepos([top]))[0] : await syncRepo(top, slug, BRANCH);
  if (r?.action === 'failed') throw new Error(`couldn't clone ${slug}: ${r.detail}`);
  return r ?? null;
}

/** True on the server (where Studio clones the repos itself). */
export const isServer = () => process.platform !== 'win32' && process.env.STUDIO_SERVER === '1';
