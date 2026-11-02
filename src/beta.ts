// The beta lane: every product repo agents change has a `beta` branch between agent changes and the live site.
//
//   agent branch (fix/..., task/...)  --J approves-->  beta  --playtested, J says "go live"-->  main (= live, GitHub Pages)
//
// - beta is created from main when it's missing (pushing a branch other than main never deploys anything).
// - Agent branches are cut from beta and their pull requests target it; approving merges into beta.
// - The staging site https://<sub>.hawkesgen.ai/ is built from beta (previews.ts), and "local" playtests on the server
//   play beta (repos.ts checks it out; Unity products play the beta build in their beta website copy).
// - Going live (deploy.ts) fast-forwards main to the beta commit that was playtested. Unity products commit that beta
//   build's Game/v<n> to the website repo's main. Every go live and rollback is recorded in the db (deploys).
//
// Unity products: the source repo and the website repo (home page, blog, privacy, the game page) each have a beta.
// Agents work in either (a change with target "site" works in the website repo). The beta build lands in a scratch
// website copy, .work/beta/<product>-site (a worktree of the website repo at its beta), never in the real website
// folder, so the beta site is website beta's pages plus beta's build. Going live puts both on the website's main.

import fs from 'node:fs';
import { critical, criticalSync } from './drain.ts';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PROJECTS, DATA, abs, type Product } from './config.ts';
import { db } from './db.ts';
import { BRANCH, BETA, isServer, repoMap, syncRepo } from './repos.ts';
import { trackCommand, opLog } from './ops.ts';
import { ensureInstalled } from './warm.ts';
import { REF_LOCK, fetchBackoff, fetchLocked, repoKey, repoBusy, withRepoLock } from './gitlock.ts';

export { BETA };
export const MAIN = BRANCH;
/** Studio's own commits on beta and main (pre-deploy builds, rollbacks, merges), so they're recognizable. */
export const STUDIO_BUILD = 'Studio build:';
export const STUDIO_ROLLBACK = 'Rollback:';
export const AUTHOR = ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai'];

/**
 * True where local playtests play beta (the server). On J's PC, local playtests play his checkout as it is, and his
 * checkouts are never switched; the plan and go live work the same everywhere (they read origin/beta and origin/main).
 */
export const betaLane = () => isServer() || process.env.STUDIO_BETA_LANE === '1';

db.exec(`
  CREATE TABLE IF NOT EXISTS deploys (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL, before TEXT, after TEXT NOT NULL,
    beta TEXT, source TEXT, source_before TEXT, source_after TEXT, version TEXT, by TEXT, detail TEXT, rolled_back TEXT, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deploys_product ON deploys(product, at);
`);
// A go live a person took past the playtest (deploy.ts PlaytestSkip, as JSON): who, when, which commit and why.
try { db.exec('ALTER TABLE deploys ADD COLUMN skipped_playtest TEXT'); } catch { /* already there */ }
export type DeployRow = {
  id: string; product: string; kind: 'deploy' | 'rollback'; repo: string; before: string | null; after: string; beta: string | null;
  source: string | null; source_before: string | null; source_after: string | null; version: string | null; by: string | null; detail: string | null; rolled_back: string | null; at: number; skipped_playtest?: string | null;
};
export const listDeploys = (product: string, limit = 20) => db.prepare('SELECT * FROM deploys WHERE product = ? ORDER BY at DESC LIMIT ?').all(product, limit) as DeployRow[];

// ------------------------------------------------------------------- git

/**
 * git, synchronously: only for local commands that answer in milliseconds (rev-parse, log, status, diff). Anything that
 * talks to GitHub or rewrites a big tree (fetch, push, clone, checkout, worktree add, merge) goes through gitAsync, so
 * Studio keeps answering while it runs (a synchronous push of a Unity build once froze Studio for minutes).
 */
export function git(cwd: string, args: string[], timeoutMs = 10 * 60_000) {
  if (SLOW.has(args[0])) console.warn(`[studio] synchronous git ${args[0]} in ${path.basename(cwd)}: use gitAsync`);
  const t0 = Date.now();
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
  // A "quick" read that wasn't (git status on a Unity site copy with a big build takes seconds): name it, so it moves to gitAsync.
  const ms = Date.now() - t0;
  if (ms > 300) console.warn(`[studio] synchronous git ${args.slice(0, 3).join(' ')} in ${path.basename(cwd)} held Studio for ${ms} ms: use gitAsync`);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: ((r.stderr ?? r.error?.message ?? '').trim() || (r.status === 0 ? '' : `git exited ${r.signal ? `by signal ${r.signal}` : `with code ${r.status}`}`)) };
}
const SLOW = new Set(['fetch', 'push', 'clone', 'pull']);
/**
 * No optional locks: a read (git status, diff) never takes index.lock to refresh the index, so Studio's background
 * status polls can't make a go-live's `git add -A` on the same checkout fail ("index.lock: File exists", Sick Of It
 * 2026-10-26: a 38 s add of a Unity build raced the polls twice).
 */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

/**
 * git without blocking Studio: listed while it runs (ops.ts commands), logged to the operation it runs in, timed out.
 * Fetches and pushes take turns per repository (its worktrees share refs: two at once fail with "cannot lock ref
 * origin/beta"), and a fetch that still hits a ref lock (git outside Studio) is tried again after a short wait (gitlock.ts).
 */
export async function gitAsync(cwd: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  // Talking to GitHub about a repo that isn't J's: its own token as a header for this command (ghtoken.ts).
  const env = gitNeedsAuth(args) ? await authEnvFor(cwd) : {};
  if (args[0] === 'fetch') return fetchLocked(cwd, args, (a) => runGit(cwd, a, timeoutMs, env), opLog);
  if (args[0] === 'push') return withRepoLock(repoKey(cwd), () => runGit(cwd, args, timeoutMs, env));
  return lockRetry(cwd, args, () => runGit(cwd, args, timeoutMs, env));
}

/**
 * Git commands that may talk to GitHub. A light clone (`--filter=blob:none`, a Unity repo) fetches file contents while it
 * checks out, so `worktree add` and `checkout` need the repo's token too: without it an org cell's agent changes on
 * Yooba Land and Sick of It (Unity) failed with "could not read Username" (2026-11-01).
 */
export const gitNeedsAuth = (args: string[]) => ['fetch', 'push', 'pull', 'ls-remote', 'worktree', 'checkout', 'switch'].includes(args[0]);

/** The token header for a checkout's GitHub repo (its origin), fetched first; {} for J's repos and anything else. */
async function authEnvFor(cwd: string): Promise<Record<string, string>> {
  const url = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
  const slug = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  if (!slug) return {};
  const { primeRepoToken, gitAuthEnv } = await import('./ghtoken.ts');
  await primeRepoToken(slug);
  return gitAuthEnv(slug);
}
export { REF_LOCK, fetchBackoff, repoKey, withRepoLock, repoBusy };

/**
 * A write that meets another git's index.lock (a git outside Studio, or one still finishing) waits and tries again,
 * about a minute in all. A lock nobody has touched for 10 minutes is left by a git that died: it is removed, logged.
 */
export const INDEX_LOCKED = /index\.lock'?:? File exists|Another git process seems to be running/i;
async function lockRetry(cwd: string, args: string[], run: () => Promise<{ ok: boolean; out: string; err: string }>) {
  let r = await run();
  for (let i = 0; !r.ok && INDEX_LOCKED.test(r.err) && i < 8; i++) {
    const lock = indexLockOf(cwd);
    const age = lock ? Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) : 0;
    if (lock && age > 10 * 60_000) {
      opLog(`removing a stale ${path.basename(lock)} (${Math.round(age / 60_000)} min old) in ${path.basename(cwd)}`);
      try { fs.rmSync(lock, { force: true }); } catch { /* the retry says what's wrong */ }
    } else {
      opLog(`git ${args[0]} in ${path.basename(cwd)}: index.lock held by another git, trying again`);
      await new Promise((ok) => setTimeout(ok, 2_000 + i * 1_500));
    }
    r = await run();
  }
  return r;
}
/** The index.lock of a checkout or worktree (a worktree's lives in its git dir). */
function indexLockOf(cwd: string): string | null {
  const dotgit = path.join(cwd, '.git');
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return path.join(dotgit, 'index.lock');
    const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
    return m ? path.join(path.resolve(cwd, m[1].trim()), 'index.lock') : null;
  } catch { return null; }
}

function runGit(cwd: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const label = `git ${args.filter((a) => !a.startsWith('-c')).join(' ')}`.slice(0, 200);
  const done = trackCommand(label, cwd);
  if (SLOW.has(args[0]) || ['worktree', 'checkout', 'merge'].includes(args[0])) opLog(`$ ${label} (${path.basename(cwd)})`);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: { ok: boolean; out: string; err: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
      resolve({ ok: r.ok, out: r.out.trim(), err: r.err.trim() });
    };
    const child = spawn('git', args, { cwd, windowsHide: true, env: { ...gitEnv(), ...extraEnv } });
    child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024 * 1024) out = out.slice(-32 * 1024 * 1024); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 1_000_000) err = err.slice(-500_000); });
    child.on('error', (e) => finish({ ok: false, out, err: e.message }));
    child.on('close', (code, signal) => finish({ ok: code === 0, out, err: code === 0 ? err : `${err.trim()}${err.trim() ? '\n' : ''}git exited ${signal ? `by signal ${signal}` : `with code ${code}`}` }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, out, err: `${err}\ntimed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    timer.unref();
  });
}
export const must = (r: { ok: boolean; out: string; err: string }, what: string) => {
  if (!r.ok) throw new Error(`${what} failed: ${(r.err || r.out).split('\n').slice(-3).join(' | ')}`);
  return r.out;
};
export const shaOf = (dir: string, ref: string) => {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok && r.out ? r.out : null;
};
/** A product's repo has no checkout on this server yet (a product added after the server was set up). `folder` is what syncing it needs. */
export class NotClonedError extends Error {
  folder: string;
  constructor(folder: string) {
    super(`${folder} isn't cloned on this server yet: sync it (Go live > Sync repo, or POST /api/repos/sync {"only":["${folder}"]}).`);
    this.folder = folder;
  }
}
export const isCloned = (dir: string) => fs.existsSync(path.join(dir, '.git'));
/** Fetches origin; a missing checkout is a NotClonedError (never git's "spawn git ENOENT" for a folder that isn't there). */
export const fetchOrigin = async (dir: string) => {
  if (!isCloned(dir)) throw new NotClonedError(path.basename(dir));
  const out = must(await gitAsync(dir, ['fetch', '--quiet', '--prune', 'origin']), `fetching ${path.basename(dir)}`);
  fetchedAt.set(repoKey(dir), Date.now());
  return out;
};
const fetchedAt = new Map<string, number>();
/**
 * A fetch for something that only reads (the go-live plan, its cards): skipped when this repo was fetched in the last
 * `maxAgeMs`, and when a fetch or push of it is running, since waiting would hold the reader for as long as that runs
 * (J, 2026-10-27: Sick Of It's plan never came back while its go live pushed a 1.2 GB build for half an hour).
 * Going live itself always fetches. Returns why it didn't fetch, or null when it did (or the last one is fresh).
 */
export async function fetchForRead(dir: string, maxAgeMs = 60_000): Promise<string | null> {
  if (!isCloned(dir)) throw new NotClonedError(path.basename(dir));
  const key = repoKey(dir);
  if (Date.now() - (fetchedAt.get(key) ?? 0) < maxAgeMs) return null;
  if (repoBusy(key)) return `${path.basename(dir)} is busy (a push or fetch is running), so this is as of its last fetch`;
  await fetchOrigin(dir);
  return null;
}
/** Clones the repo first when the server has no checkout yet (agents and beta pushes start from one). */
export async function ensureCloned(dir: string) {
  if (isCloned(dir)) return;
  const folder = path.basename(dir);
  const slug = repoMap()[folder];
  if (!slug) throw new NotClonedError(folder);
  const r = await syncRepo(folder, slug, BRANCH, BETA);
  if (r.action === 'failed' || !isCloned(dir)) throw new Error(`cloning ${folder} failed: ${r.detail}`);
}

/** The folders (repo roots under PROJECTS) of a product: its source repo (agents and beta) and its website repo. */
export function repoDirs(p: Product) {
  const source = abs(p.repo.split('/')[0]);
  const site = abs(p.site.split('/')[0]);
  return { source, site, unity: Boolean(p.build) || p.engine === 'unity' };
}

/** Makes sure origin has a beta branch (from main when missing). Returns its commit. */
export async function ensureBeta(dir: string) {
  await ensureCloned(dir);
  await fetchOrigin(dir);
  const have = shaOf(dir, `origin/${BETA}`);
  if (have) return { sha: have, created: false };
  const main = shaOf(dir, `origin/${MAIN}`);
  if (!main) throw new Error(`${path.basename(dir)} has no origin/${MAIN} to start ${BETA} from`);
  must(await gitAsync(dir, ['push', '--quiet', 'origin', `${main}:refs/heads/${BETA}`]), `creating ${BETA}`);
  await fetchOrigin(dir);
  return { sha: main, created: true };
}

export type Commit = { sha: string; short: string; author: string; date: string; title: string };
export function commitsIn(dir: string, range: string, max = 200): Commit[] {
  const r = git(dir, ['log', `--max-count=${max}`, '--format=%H%x09%an%x09%cI%x09%s', range]);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').map((l) => {
    const [sha, author, date, ...t] = l.split('\t');
    return { sha, short: sha.slice(0, 7), author, date, title: t.join('\t') };
  });
}
export const commitOf = (dir: string, sha: string): Commit | null => commitsIn(dir, sha, 1)[0] ?? null;

/**
 * beta vs main on origin (fetched first unless fetch is false): beta's and main's commits, what's on beta and not on
 * main (what going live ships) and what's on main and not on beta (it must be merged into beta first).
 */
export async function compareBeta(dir: string, { fetch = true } = {}) {
  if (fetch) await fetchOrigin(dir);
  return compareRefs(dir);
}

/** beta vs main as of the last fetch (no network: for pages and quick reads). */
export function compareRefs(dir: string) {
  const main = shaOf(dir, `origin/${MAIN}`);
  const beta = shaOf(dir, `origin/${BETA}`);
  return {
    main: main ? commitOf(dir, main) : null,
    beta: beta ? commitOf(dir, beta) : null,
    ahead: main && beta ? commitsIn(dir, `${main}..${beta}`) : [],
    behind: main && beta ? commitsIn(dir, `${beta}..${main}`) : [],
  };
}

// -------------------------------------------------------------- worktrees

export const WORK = () => path.join(PROJECTS, '.work', 'beta');

/** A worktree of `repoDir` at `.work/beta/<name>`, detached at `commit`, cleaned (ignored files like node_modules stay). */
export async function scratch(repoDir: string, name: string, commit: string) {
  const wt = path.join(WORK(), name);
  if (!fs.existsSync(path.join(wt, '.git'))) {
    fs.mkdirSync(WORK(), { recursive: true });
    git(repoDir, ['worktree', 'prune']);
    must(await gitAsync(repoDir, ['worktree', 'add', '--detach', '--force', wt, commit]), 'making a worktree');
  } else {
    must(await gitAsync(wt, ['checkout', '--quiet', '--detach', '--force', commit]), 'checking out');
    await gitAsync(wt, ['clean', '-fdq']);
  }
  return wt;
}

/** The Unity product's beta website copy: a worktree of the website repo that the beta build lands in. */
export const betaSiteDir = (p: Product) => path.join(WORK(), `${p.id}-site`);
/** The website folder inside the beta copy (the site may be a subfolder of its repo). */
export const betaSiteFolder = (p: Product, sub = p.site) => path.join(betaSiteDir(p), path.relative(p.site.split('/')[0], sub));

/** What's in the beta website copy: the source commit built, and the website commit it sits on. */
export type BetaBuild = { sha: string; base: string; ok: boolean; at: number; job?: string; version?: string | null; error?: string; cost?: number; minutes?: number; packages?: Record<string, { sha: string; behind: number }> };
/**
 * Where a product's beta-build record lives: beside its local website copy, or on Cloud Run (no website copy there, and
 * the projects folder is the instance's memory) in Studio's data folder, which goes to Cloud Storage with the other state
 * files, so going live still knows the build after an instance is replaced (2026-10-29).
 */
const betaBuildFile = (p: Product) => (process.env.K_SERVICE ? path.join(DATA, 'beta-builds', `${p.id}.json`) : `${betaSiteDir(p)}.json`);

export function betaBuild(p: Product): BetaBuild | null {
  try {
    return JSON.parse(fs.readFileSync(betaBuildFile(p), 'utf8'));
  } catch {
    return null;
  }
}
export function saveBetaBuild(p: Product, b: BetaBuild | null) {
  const f = betaBuildFile(p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (b) fs.writeFileSync(f, JSON.stringify(b, null, 2));
  else fs.rmSync(f, { force: true });
}

/**
 * Whether the beta build in the website copy is still what beta needs: it built `head`, and it sits on the website
 * commit it should (`siteBase`: the website's beta, or its main where it has no beta yet; when that moved, the copy is
 * moved onto it (refreshBetaSite) or the build redone, else going live is blocked).
 */
export function betaBuildCurrent(b: BetaBuild | null, head: string, siteBase: string | null, folderExists: boolean) {
  return Boolean(b?.ok && b.sha === head && folderExists && (!siteBase || b.base === siteBase));
}

/** The website commit a Unity product's beta build sits on: the website repo's beta, or its main where it has none yet (no fetch). */
export const siteBaseOf = (p: Product) => {
  const { site } = repoDirs(p);
  return shaOf(site, `origin/${BETA}`) ?? shaOf(site, `origin/${MAIN}`);
};

/** Resets the beta website copy to the website repo's origin/beta (made from main the first time) before a beta build lands in it. */
export async function resetBetaSite(p: Product) {
  const { site } = repoDirs(p);
  const { sha: base } = await ensureBeta(site);
  saveBetaBuild(p, null);
  const dir = await scratch(site, `${p.id}-site`, base);
  return { dir, folder: betaSiteFolder(p), base };
}

/**
 * A page change merged into the website's beta: the beta website copy moves onto it and keeps its build (no new Unity
 * build). git carries the build's files along; when the new pages touch the same files it refuses (moved: false), and
 * the next beta build is made on top of them. No fetch (the caller fetched the website repo).
 */
export async function refreshBetaSite(p: Product): Promise<{ moved: boolean; base?: string; why?: string }> {
  const b = betaBuild(p);
  if (!b?.ok || !fs.existsSync(path.join(betaSiteDir(p), '.git'))) return { moved: false, why: 'no beta build' };
  const want = shaOf(repoDirs(p).site, `origin/${BETA}`);
  if (!want || want === b.base) return { moved: false, why: 'the copy already sits on the website\'s beta' };
  const r = await gitAsync(betaSiteDir(p), ['checkout', '--quiet', '--detach', want]);
  if (!r.ok) return { moved: false, why: (r.err || r.out).split('\n').slice(-2).join(' ') };
  saveBetaBuild(p, { ...b, base: want });
  return { moved: true, base: want };
}

/** The Game/v<n> numbers in a website folder (v0000000-style templates aren't versions). */
export function gameVersions(folder: string): number[] {
  try {
    return fs.readdirSync(path.join(folder, 'Game')).map((n) => /^v([1-9]\d*)$/.exec(n)?.[1]).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const PLACEHOLDER = 'studio-placeholder.txt';

/**
 * Pins the Game/v<n> a beta build makes, so no two beta builds share a folder (a browser would play its cached old
 * build). The beta website copy only holds live's Game/v<n>, so a deploy method's "latest + 1" would pick live + 1
 * every time: n is one past the highest Studio ever built for the product (or live's). Products whose deploy method
 * reads the number from the environment (products.json build.versionEnv) get it there; for the others a placeholder
 * Game/v<n-1> in the copy makes their latest + 1 come out as n (they delete it as "the old version"; pruneGameVersions
 * then removes live's folder, as a normal deploy does).
 */
export function pinBetaVersion(p: Product, folder = betaSiteFolder(p)): { version: number; env?: Record<string, string>; placeholder?: boolean } {
  const built = db.prepare(`SELECT MAX(CAST(json_extract(data, '$.version') AS INTEGER)) AS v FROM steps WHERE product = ? AND kind = 'build' AND name = 'unity' AND status = 'done'`).get(p.id) as any;
  const live = Math.max(0, ...gameVersions(folder));
  const version = Math.max(live, Number(built?.v) || 0) + 1;
  if (p.build?.versionEnv) return { version, env: { [p.build.versionEnv]: String(version) } };
  if (version - 1 <= live) return { version };
  const dir = path.join(folder, 'Game', `v${version - 1}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PLACEHOLDER), `Hawkes Studio: makes the beta build Game/v${version} (never a number used before). Not a build.\n`);
  return { version, placeholder: true };
}

/** After a placeholder-pinned build: removes the older Game/v<n> folders left in the copy (live's, a placeholder). */
export function pruneGameVersions(folder: string, built: number) {
  for (const v of gameVersions(folder)) if (v < built) fs.rmSync(path.join(folder, 'Game', `v${v}`), { recursive: true, force: true });
}

/** The port the beta website copy is served on for local playtests (next to the product's own port). */
export const betaPort = (p: Product) => 9000 + (p.local.port % 1000);

/**
 * What a local playtest plays, recorded with each playtest (step data "played") so the report and the deploy plan
 * know which commit was tested. Unity on the beta lane: the beta build. Otherwise: the product's checkout.
 */
export type Played = { branch: string; sha: string; title?: string; dirty?: number; build?: string | null };
export function playedLocal(p: Product): Played | null {
  if (p.build && betaLane()) {
    const b = betaBuild(p);
    if (!b?.ok) return null;
    return { branch: BETA, sha: b.sha, title: commitOf(repoDirs(p).source, b.sha)?.title, build: b.version ?? null };
  }
  const dir = repoDirs(p).source;
  const sha = shaOf(dir, 'HEAD');
  if (!sha) return null;
  const dirty = git(dir, ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
  return { branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out, sha, title: commitOf(dir, sha)?.title, ...(dirty ? { dirty } : {}) };
}

// ------------------------------------------------------- pre-deploy builds

function sh(cmd: string, cwd: string, timeoutMs = 20 * 60_000): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [], { cwd, shell: true, windowsHide: true, timeout: timeoutMs });
    let out = '';
    const keep = (d: Buffer) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => resolve({ ok: false, tail: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, tail: out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n') }));
  });
}

/** npm ci in a worktree when its packages weren't installed for its lockfile (warm.ts ensureInstalled). */
export async function ensureDeps(dir: string, log: (s: string) => void = () => {}) {
  const r = await ensureInstalled(dir, { log });
  if (!r.ok) throw new Error(`npm ci failed: ${r.error}`);
}

/** The beta commit whose pre-deploy build changed no tracked files (so it needs no build commit). */
const prebuiltFile = (p: Product) => path.join(WORK(), `${p.id}.prebuild.json`);
/** True when `sha` (beta's head) has had its pre-deploy build: it is a build commit, or the build changed nothing there. */
export function prebuilt(p: Product, sha: string, title: string) {
  if (title.startsWith(STUDIO_BUILD)) return true;
  try {
    return JSON.parse(fs.readFileSync(prebuiltFile(p), 'utf8')).sha === sha;
  } catch {
    return false;
  }
}

/**
 * Products with a pre-deploy build (products.json deploy.prebuild: PH Origins builds play/, I Can Be stamps its build
 * and version) get it run on beta and committed there ("Studio build: ..."), so the beta commit that's playtested is
 * exactly what goes live. Skipped when beta's newest commit is already such a build.
 */
/** Committing a pre-deploy build to beta and pushing it is a critical section (drain.ts). */
export const prepareBeta = (...a: Parameters<typeof prepareBetaNow>) => critical(`committing ${a[0].id}'s pre-deploy build to beta`, () => prepareBetaNow(...a));
async function prepareBetaNow(p: Product, log: (s: string) => void = () => {}) {
  if (!p.deploy?.prebuild) return { skipped: 'no pre-deploy build' };
  const { source } = repoDirs(p);
  // Never makes beta (that happens with the first agent change, or J's merge-main): no beta, nothing to build.
  await fetchOrigin(source);
  const sha = shaOf(source, `origin/${BETA}`);
  if (!sha) return { skipped: `no ${BETA} branch yet` };
  const head = commitOf(source, sha);
  if (head && prebuilt(p, sha, head.title)) return { skipped: `beta's newest commit already has its build (${sha.slice(0, 7)})`, sha };
  const wt = await scratch(source, p.id, sha);
  const dir = path.join(wt, path.relative(p.repo.split('/')[0], p.site));
  await ensureDeps(dir, log);
  log(`$ ${p.deploy.prebuild}`);
  const r = await sh(p.deploy.prebuild, dir);
  if (!r.ok) throw new Error(`${p.deploy.prebuild} failed on beta (${sha.slice(0, 7)}):\n${r.tail}`);
  must(await gitAsync(wt, ['add', '-A']), 'git add');
  if (!(await gitAsync(wt, ['diff', '--cached', '--quiet'])).ok) {
    must(git(wt, [...AUTHOR, 'commit', '--quiet', '-m', `${STUDIO_BUILD} ${p.deploy.prebuild} (beta ${sha.slice(0, 7)})`]), 'committing the build');
    must(await gitAsync(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]), 'pushing beta');
    await fetchOrigin(source);
    const now = shaOf(wt, 'HEAD')!;
    log(`committed the build to beta: ${now.slice(0, 7)}`);
    return { committed: now, sha: now };
  }
  fs.writeFileSync(prebuiltFile(p), JSON.stringify({ sha, at: Date.now() }));
  return { skipped: 'the build changed no tracked files', sha };
}

// ------------------------------------------------------ main into beta

/**
 * Brings main's extra commits into beta (they would block a fast-forward), in the source repo and, for Unity products,
 * in the website repo too (a rollback or a go live whose beta update didn't land). When they're all Studio rollbacks, the
 * merge keeps beta's files ("-s ours": beta is the version being fixed forward); otherwise it's a normal merge, and a
 * conflict stops it (resolve on a branch by hand).
 */
/** Merging main into beta and pushing it is a critical section (drain.ts). */
export const mergeMainIntoBeta = (...a: Parameters<typeof mergeMainIntoBetaNow>) => critical(`merging main into ${a[0].id}'s beta`, () => mergeMainIntoBetaNow(...a));
async function mergeMainIntoBetaNow(p: Product, by = 'J') {
  const { source, site, unity } = repoDirs(p);
  const out = await mergeMainIn(source, `${p.id}-merge`, by);
  if (!unity || site === source) return out;
  const web = await mergeMainIn(site, `${p.id}-site-merge`, by);
  return { ...out, merged: out.merged || web.merged, detail: `${path.basename(source)}: ${out.detail}. ${path.basename(site)}: ${web.detail}`, site: web };
}

async function mergeMainIn(dir: string, name: string, by: string) {
  await ensureBeta(dir);
  const cmp = await compareBeta(dir, { fetch: false });
  if (!cmp.behind.length) return { merged: false, detail: `${BETA} already has everything on ${MAIN}` };
  const onlyRollbacks = cmp.behind.every((c) => c.title.startsWith(STUDIO_ROLLBACK));
  const wt = await scratch(dir, name, cmp.beta!.sha);
  const msg = `Merge ${MAIN} into ${BETA}${onlyRollbacks ? ' (rollbacks: keeps beta\'s files)' : ''} (by ${by})`;
  const m = await gitAsync(wt, [...AUTHOR, 'merge', '--no-ff', '--no-edit', '-m', msg, ...(onlyRollbacks ? ['-s', 'ours'] : []), cmp.main!.sha]);
  if (!m.ok) {
    git(wt, ['merge', '--abort']);
    throw new Error(`Merging ${MAIN} into ${BETA} in ${path.basename(dir)} conflicts (${(m.out || m.err).split('\n').filter((l) => /CONFLICT/.test(l)).slice(0, 5).join('; ') || m.err}). Resolve it by hand on a branch.`);
  }
  must(await gitAsync(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]), 'pushing beta');
  await fetchOrigin(dir);
  return { merged: true, sha: shaOf(wt, 'HEAD'), detail: `${msg}: ${cmp.behind.length} commit(s) from ${MAIN}`, keptBeta: onlyRollbacks };
}

/** True when `dir`'s origin has a beta branch (no fetch). */
export const hasBeta = (dir: string) => Boolean(shaOf(dir, `origin/${BETA}`));
