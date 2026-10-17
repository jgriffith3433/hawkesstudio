// The beta lane: every product repo agents change has a `beta` branch between agent changes and the live site.
//
//   agent branch (fix/..., task/...)  --J approves-->  beta  --playtested, J says "go live"-->  main (= live, GitHub Pages)
//
// - beta is created from main when it's missing (pushing a branch other than main never deploys anything).
// - Agent branches are cut from beta and their pull requests target it; approving merges into beta.
// - The staging site https://<sub>.hawkesgen.com/ is built from beta (previews.ts), and "local" playtests on the server
//   play beta (repos.ts checks it out; Unity products play the beta build in their beta website copy).
// - Going live (deploy.ts) fast-forwards main to the beta commit that was playtested. Unity products commit that beta
//   build's Game/v<n> to the website repo's main. Every go live and rollback is recorded in the db (deploys).
//
// Unity products: beta lives in the source repo (where agents work). The beta build lands in a scratch website copy,
// .work/beta/<product>-site (a worktree of the website repo at its main), never in the real website folder.

import fs from 'node:fs';
import { critical, criticalSync } from './drain.ts';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { PROJECTS, abs, type Product } from './config.ts';
import { db } from './db.ts';
import { BRANCH, BETA, isServer } from './repos.ts';
import { trackCommand, opLog } from './ops.ts';

export { BETA };
export const MAIN = BRANCH;
/** Studio's own commits on beta and main (pre-deploy builds, rollbacks, merges), so they're recognizable. */
export const STUDIO_BUILD = 'Studio build:';
export const STUDIO_ROLLBACK = 'Rollback:';
export const AUTHOR = ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.com'];

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
export type DeployRow = {
  id: string; product: string; kind: 'deploy' | 'rollback'; repo: string; before: string | null; after: string; beta: string | null;
  source: string | null; source_before: string | null; source_after: string | null; version: string | null; by: string | null; detail: string | null; rolled_back: string | null; at: number;
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
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  // A "quick" read that wasn't (git status on a Unity site copy with a big build takes seconds): name it, so it moves to gitAsync.
  const ms = Date.now() - t0;
  if (ms > 300) console.warn(`[studio] synchronous git ${args.slice(0, 3).join(' ')} in ${path.basename(cwd)} held Studio for ${ms} ms: use gitAsync`);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
}
const SLOW = new Set(['fetch', 'push', 'clone', 'pull']);

/** git without blocking Studio: listed while it runs (ops.ts commands), logged to the operation it runs in, timed out. */
export function gitAsync(cwd: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ ok: boolean; out: string; err: string }> {
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
    const child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024 * 1024) out = out.slice(-32 * 1024 * 1024); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 1_000_000) err = err.slice(-500_000); });
    child.on('error', (e) => finish({ ok: false, out, err: e.message }));
    child.on('close', (code) => finish({ ok: code === 0, out, err }));
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
export const fetchOrigin = async (dir: string) => must(await gitAsync(dir, ['fetch', '--quiet', '--prune', 'origin']), `fetching ${path.basename(dir)}`);

/** The folders (repo roots under PROJECTS) of a product: its source repo (agents and beta) and its website repo. */
export function repoDirs(p: Product) {
  const source = abs(p.repo.split('/')[0]);
  const site = abs(p.site.split('/')[0]);
  return { source, site, unity: Boolean(p.build) || p.engine === 'unity' };
}

/** Makes sure origin has a beta branch (from main when missing). Returns its commit. */
export async function ensureBeta(dir: string) {
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
export type BetaBuild = { sha: string; base: string; ok: boolean; at: number; job?: string; version?: string | null; error?: string; cost?: number; minutes?: number };
export function betaBuild(p: Product): BetaBuild | null {
  try {
    return JSON.parse(fs.readFileSync(`${betaSiteDir(p)}.json`, 'utf8'));
  } catch {
    return null;
  }
}
export function saveBetaBuild(p: Product, b: BetaBuild | null) {
  if (b) fs.writeFileSync(`${betaSiteDir(p)}.json`, JSON.stringify(b, null, 2));
  else fs.rmSync(`${betaSiteDir(p)}.json`, { force: true });
}

/**
 * Whether the beta build in the website copy is still what beta needs: it built `head`, and it sits on the website's
 * main as it is now (`siteMain`; when live moved, the build must be redone on top of it or going live is blocked).
 */
export function betaBuildCurrent(b: BetaBuild | null, head: string, siteMain: string | null, folderExists: boolean) {
  return Boolean(b?.ok && b.sha === head && folderExists && (!siteMain || b.base === siteMain));
}

/** Resets the beta website copy to the website repo's origin/main (before a beta build lands in it). */
export async function resetBetaSite(p: Product) {
  const { site } = repoDirs(p);
  await fetchOrigin(site);
  const base = shaOf(site, `origin/${MAIN}`);
  if (!base) throw new Error(`${p.site} has no origin/${MAIN}`);
  saveBetaBuild(p, null);
  const dir = await scratch(site, `${p.id}-site`, base);
  return { dir, folder: betaSiteFolder(p), base };
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

/** npm ci in a worktree, only when its package-lock changed since the last time. */
export async function ensureDeps(dir: string, log: (s: string) => void = () => {}) {
  const lockFile = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(lockFile)) return;
  const lock = crypto.createHash('sha1').update(fs.readFileSync(lockFile)).digest('hex');
  const mark = path.join(dir, 'node_modules', '.studio-lock');
  if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === lock) return;
  log('npm ci');
  const r = await sh('npm ci --no-audit --no-fund --loglevel=error', dir);
  if (!r.ok) throw new Error(`npm ci failed: ${r.tail}`);
  fs.writeFileSync(mark, lock);
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
 * Products with a pre-deploy build (products.json deploy.prebuild: PH Origins builds play/, I Can Be bumps its
 * version) get it run on beta and committed there ("Studio build: ..."), so the beta commit that's playtested is
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
 * Brings main's extra commits into beta (they would block a fast-forward). When they're all Studio rollbacks, the merge
 * keeps beta's files ("-s ours": beta is the version being fixed forward); otherwise it's a normal merge, and a conflict
 * stops it (resolve on a branch by hand).
 */
/** Merging main into beta and pushing it is a critical section (drain.ts). */
export const mergeMainIntoBeta = (...a: Parameters<typeof mergeMainIntoBetaNow>) => critical(`merging main into ${a[0].id}'s beta`, () => mergeMainIntoBetaNow(...a));
async function mergeMainIntoBetaNow(p: Product, by = 'J') {
  const { source } = repoDirs(p);
  await ensureBeta(source);
  const cmp = await compareBeta(source, { fetch: false });
  if (!cmp.behind.length) return { merged: false, detail: `${BETA} already has everything on ${MAIN}` };
  const onlyRollbacks = cmp.behind.every((c) => c.title.startsWith(STUDIO_ROLLBACK));
  const wt = await scratch(source, `${p.id}-merge`, cmp.beta!.sha);
  const msg = `Merge ${MAIN} into ${BETA}${onlyRollbacks ? ' (rollbacks: keeps beta\'s files)' : ''} (by ${by})`;
  const m = await gitAsync(wt, [...AUTHOR, 'merge', '--no-ff', '--no-edit', '-m', msg, ...(onlyRollbacks ? ['-s', 'ours'] : []), cmp.main!.sha]);
  if (!m.ok) {
    git(wt, ['merge', '--abort']);
    throw new Error(`Merging ${MAIN} into ${BETA} conflicts (${(m.out || m.err).split('\n').filter((l) => /CONFLICT/.test(l)).slice(0, 5).join('; ') || m.err}). Resolve it by hand on a branch.`);
  }
  must(await gitAsync(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]), 'pushing beta');
  await fetchOrigin(source);
  return { merged: true, sha: shaOf(wt, 'HEAD'), detail: `${msg}: ${cmp.behind.length} commit(s) from ${MAIN}`, keptBeta: onlyRollbacks };
}

/** True when `dir`'s origin has a beta branch (no fetch). */
export const hasBeta = (dir: string) => Boolean(shaOf(dir, `origin/${BETA}`));
