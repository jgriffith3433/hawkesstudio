// Product repos on the server: clone what's missing and fast-forward what's there, from GitHub, into the same
// layout as C:\Projects (products.json "repos": top-level folder -> owner/name). On J's PC the repos are already
// there and this is a no-op unless asked. GitHub access on the server comes from the hawkes/github secret through
// the git credential helper (bin/git-credential-hawkes).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PROJECTS, paths, addedRepoFolders } from './config.ts';
import { trackCommand } from './ops.ts';
import { lockHash, installedFor, ensureInstalled, runShell } from './warm.ts';
import { REF_LOCK, fetchLocked } from './gitlock.ts';
import { lfsPull } from './lfs.ts';

export const BRANCH = process.env.STUDIO_BRANCH || 'main';
/** The branch between agent changes and the live site (beta.ts). On the server, product source repos are kept on it. */
export const BETA = process.env.STUDIO_BETA_BRANCH || 'beta';

/** git for quick local reads (rev-parse, status, log). */
function git(cwd: string, args: string[], timeoutMs = 20 * 60_000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
}

/** git for clone, fetch, checkout and merge, without blocking Studio (a sync of every repo used to freeze it). */
function gitA(cwd: string, args: string[], timeoutMs = 20 * 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  const done = trackCommand(`git ${args.join(' ')}`, cwd);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024 * 1024) out = out.slice(-32 * 1024 * 1024); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 1_000_000) err = err.slice(-500_000); });
    const end = (ok: boolean, e?: string) => { clearTimeout(timer); done(); resolve({ ok, out: out.trim(), err: (e ?? err).trim() }); };
    child.on('error', (e) => end(false, e.message));
    child.on('close', (code) => end(code === 0));
  });
}

export function repoMap(): Record<string, string> {
  // Games added in J's Studio (config.ts addedRepoFolders) are cloned beside products.json's.
  return { ...(JSON.parse(fs.readFileSync(paths.products, 'utf8')).repos ?? {}), ...addedRepoFolders() };
}

export type RepoResult = { folder: string; slug: string; action: 'cloned' | 'updated' | 'current' | 'kept' | 'failed'; detail: string; head?: string; dirty?: string[]; discarded?: string[];
  /** npm ci runs in the repo's web checkouts after the sync (installAfterSync): where, why, how long, the error. */
  install?: Install[];
  /** Uncommitted changes set aside (git stash) so a beta checkout could follow beta: the stash's commit, its message, the files. */
  setAside?: { stash: string; label: string; files: string[] } };

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
export async function syncRepo(folder: string, slug: string, branch = BRANCH, want?: string): Promise<RepoResult> {
  const dir = path.join(PROJECTS, folder);
  const before = fs.existsSync(path.join(dir, '.git')) ? git(dir, ['rev-parse', 'HEAD']).out : '';
  const r = await syncGit(folder, slug, branch, want);
  // The shared checkout's Git LFS files (the store every worktree of it reads from), and its pre-push hook.
  if (r.action !== 'failed') await lfsPull(dir);
  return installAfterSync(r, before);
}

async function syncGit(folder: string, slug: string, branch: string, want?: string): Promise<RepoResult> {
  const dir = path.join(PROJECTS, folder);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { folder, slug, action: 'failed', detail: `${dir} exists and isn't a git repo` };
    const c = await gitA(PROJECTS, ['clone', '--quiet', `https://github.com/${slug}.git`, folder]);
    if (!c.ok) return { folder, slug, action: 'failed', detail: c.err.split('\n').pop() ?? 'clone failed' };
    const pick = [want, branch].find((b) => b && git(dir, ['rev-parse', '--verify', '--quiet', `origin/${b}`]).ok);
    if (pick) await gitA(dir, ['checkout', '--quiet', pick]);
    return { folder, slug, action: 'cloned', detail: `cloned (${pick ?? 'default branch'})`, head: git(dir, ['log', '-1', '--format=%h %s']).out };
  }
  // Under the repo's lock with agents' and betawatch's fetches (gitlock.ts). A ref lock that outlasts the retries means
  // another git just updated those refs: carry on with them rather than fail the run over a race.
  const f = await fetchLocked(dir, ['fetch', '--quiet', '--prune', 'origin'], (a) => gitA(dir, a), (l) => console.log(`[repos] ${l}`));
  if (!f.ok && !REF_LOCK.test(f.err)) return { folder, slug, action: 'failed', detail: `fetch failed: ${f.err.split('\n').pop()}` };
  const raced = f.ok ? '' : `fetch kept hitting a ref lock (another fetch of this repo), used the refs it left; `;
  let cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const dirty = git(dir, ['status', '--porcelain']).out;
  let cleaned = '';
  let discarded: string[] | undefined;
  let setAside: RepoResult['setAside'];
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
      if (!s.ok) return kept(`; setting them aside failed: ${s.err.split('\n').pop()}`);
      if (git(dir, ['status', '--porcelain']).out) return kept('; still has uncommitted changes after setting them aside');
      const stash = git(dir, ['rev-parse', 'stash@{0}']).out;
      console.log(`[repos] ${folder}: set aside uncommitted changes in stash ${stash.slice(0, 7)} (${files.length} files): ${files.join(', ')}`);
      const list = files.slice(0, 20).join(', ') + (files.length > 20 ? `, and ${files.length - 20} more` : '');
      setAside = { stash, label, files };
      cleaned = `set aside uncommitted changes in stash ${stash.slice(0, 7)} (${list}); `;
    }
  }
  const done = (r: RepoResult): RepoResult => {
    if (setAside) tellSetAside(dir, folder, want!, setAside, r);
    if (raced) r = { ...r, detail: raced + r.detail };
    return cleaned ? { ...r, detail: cleaned + r.detail, ...(discarded ? { discarded } : {}), ...(setAside ? { setAside } : {}) } : r;
  };
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

/** One Talk notice for changes set aside in a stash: the files, the stash, and how to look at them or get them back. */
function tellSetAside(dir: string, folder: string, want: string, a: NonNullable<RepoResult['setAside']>, r: RepoResult) {
  const list = a.files.slice(0, 20).join(', ') + (a.files.length > 20 ? `, and ${a.files.length - 20} more` : '');
  const g = `git -C ${dir}`;
  const after = r.action === 'updated' || r.action === 'current' ? `and the checkout follows ${want} again (${r.head ?? ''})` : `but it still couldn't follow ${want}: ${r.detail}`;
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
