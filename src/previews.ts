// Staging sites: every product, built the way it deploys, behind the same login as Studio.
//
//   https://<sub>.hawkesgen.com/          the product from its beta branch (beta.ts: what "go live" would ship)
//   https://<sub>.hawkesgen.com/c/<id>/   an agent change (its branch), before J approves it
//
// Subdomains are products.json "previews". Files go to PREVIEWS/<product>/beta and PREVIEWS/<product>/c/<change>
// (/srv/hawkes/previews on the server); Caddy serves them (deploy/deploy.mjs, previewSites).
//
// Web products are built in their own worktree (.work/previews/<product>, detached at the commit), never in the
// checkout that repos.ts syncs, so a build (PH Origins commits play/) can't make it dirty. Products without a build
// step copy the files git would publish. Unity products copy their beta website copy (.work/beta/<product>-site, which
// the build server's build of beta lands in; beta.ts), never the real website folder; a Unity change copies its own
// website copy (changeSiteDir) once its branch is built. Repos without a beta branch yet show main.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PROJECTS, DATA, paths, getProduct, loadProducts, StudioError, type Product } from './config.ts';
import { db } from './db.ts';
import { BRANCH, BETA, isServer, type RepoResult } from './repos.ts';
import { betaBuild, betaSiteFolder } from './beta.ts';

export const DOMAIN = process.env.STUDIO_DOMAIN || 'hawkesgen.com';
export const PREVIEWS = process.env.STUDIO_PREVIEWS || (isServer() ? path.join(PROJECTS, 'previews') : path.join(DATA, 'previews'));
const WORK = path.join(PROJECTS, '.work', 'previews');
const STATE = path.join(DATA, 'previews.json');

/**
 * A Unity change's website copy: a worktree of the site repo at its main (.work/<change>-site) that the build server's
 * build of the change lands in (agents.ts), so the real website folder never gets it. `<dir>.json` says what's in it.
 */
export type ChangeBuild = { sha: string; ok: boolean; at: number; job?: string; version?: string | null; error?: string; retry?: boolean; cost?: number; minutes?: number };
export const changeSiteDir = (change: string) => path.join(PROJECTS, '.work', `${change}-site`);
export function changeBuild(change: string): ChangeBuild | null {
  try {
    return JSON.parse(fs.readFileSync(`${changeSiteDir(change)}.json`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * How a web product deploys. site: what goes in besides the build ("tracked" = the files git would publish, a list =
 * just those paths, "none"); out: the build output and where it lands. Products not listed: "tracked", no build.
 */
type Recipe = { build?: string; site: 'tracked' | 'none' | string[]; out?: { from: string; to: string } };
const RECIPES: Record<string, Recipe> = {
  // .github/workflows/pages.yml "Assemble site": the static pages and content, then the bundled game over them.
  doseofdestruction: { build: 'npm run build', site: ['index.html', 'characters.html', 'privacypolicy.html', 'favicon.svg', 'CNAME', 'site', 'characters', 'audio', 'stages'], out: { from: 'dist', to: '' } },
  // Pages serves the repo; the game is built into play/ (committed on deploy).
  phorigins: { build: 'npm run build', site: 'tracked', out: { from: 'play', to: 'play' } },
  // The corporate site isn't listed: Pages serves its repo root as committed (dist/ is only the old local build).
};

export type Preview = { status: 'building' | 'ready' | 'failed' | 'waiting'; at: number; sha?: string | null; ref?: string; detail?: string; files?: number; ms?: number };
/** beta: the staging root (it was "main" before the beta lane; that entry is ignored and rebuilt). */
type State = Record<string, { beta?: Preview; changes?: Record<string, Preview> }>;

/** Subdomain -> product id (products.json "previews"). */
export function previewHosts(): Record<string, string> {
  return JSON.parse(fs.readFileSync(paths.products, 'utf8')).previews ?? {};
}
const subOf = (id: string) => Object.entries(previewHosts()).find(([, v]) => v === id)?.[0];
export const previewUrl = (id: string, change?: string) => {
  const sub = subOf(id);
  return sub ? `https://${sub}.${DOMAIN}/${change ? `c/${change}/` : ''}` : null;
};

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}
function record(product: string, change: string | undefined, v: Preview | null) {
  const s = readState();
  const e = (s[product] ??= {});
  if (!change) {
    delete (e as any).main;
    if (v) e.beta = v;
    else delete e.beta;
  } else {
    e.changes ??= {};
    if (v) e.changes[change] = v;
    else delete e.changes[change];
  }
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  return v;
}

function exec(cmd: string, args: string[], cwd: string, { shell = false, timeoutMs = 20 * 60_000 } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell, windowsHide: true, timeout: timeoutMs });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d; if (out.length > 1e6) out = out.slice(-5e5); });
    child.stderr?.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
    child.on('error', (e) => resolve({ ok: false, out, err: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
  });
}
const git = (cwd: string, args: string[]) => exec('git', args, cwd);
const tail = (s: string) => s.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);

/** One build at a time per product. */
const queues = new Map<string, Promise<unknown>>();
const active = new Set<string>();

/**
 * Builds a product's staging site: beta (default), or an agent change (`change`, from its worktree `dir` or its
 * branch). Queued per product; resolves when done and never throws for a failed build (the status says).
 */
export function buildPreview(productId: string, o: { change?: string; dir?: string } = {}): Promise<Preview | null> {
  const p = getProduct(productId);
  if (!subOf(p.id)) throw new StudioError(`${p.name} has no staging site (products.json "previews")`);
  if (o.change && !/^c_[0-9a-f]+$/.test(o.change)) throw new StudioError(`Not a change id: ${o.change}`);
  const key = `${p.id}/${o.change ?? 'beta'}`;
  const prev = readState()[p.id];
  const last = o.change ? prev?.changes?.[o.change] : prev?.beta;
  record(p.id, o.change, { ...(last ?? {}), status: 'building', at: Date.now(), detail: 'queued' });
  active.add(key);
  const next = (queues.get(p.id) ?? Promise.resolve()).catch(() => {}).then(() => build(p, o)).finally(() => active.delete(key));
  queues.set(p.id, next);
  return next;
}

async function build(p: Product, o: { change?: string; dir?: string }): Promise<Preview | null> {
  const t0 = Date.now();
  const target = o.change ? path.join(PREVIEWS, p.id, 'c', o.change) : path.join(PREVIEWS, p.id, 'beta');
  const progress = (detail: string) => record(p.id, o.change, { status: 'building', at: t0, detail });
  try {
    let files: Map<string, { src: string; link: boolean }>;
    let sha: string | null;
    let ref: string;
    if (p.engine === 'unity' || p.build) {
      let site = path.join(PROJECTS, p.site);
      if (o.change) {
        // The change's website copy, once the build server has built the branch into it (agents.ts).
        const b = changeBuild(o.change);
        const copy = path.join(changeSiteDir(o.change), path.relative(p.site.split('/')[0], p.site));
        if (!b?.ok || !fs.existsSync(copy)) {
          return record(p.id, o.change, { status: 'waiting', at: t0, detail: b && !b.ok ? `the build of the branch failed: ${b.error ?? '?'}` : 'Unity changes get a preview once a build of the branch exists (not built yet)' });
        }
        site = copy;
        sha = b.sha.slice(0, 7);
        ref = `change ${o.change} (build${b.version ? ` Game/v${b.version}` : ''})`;
      } else {
        // The beta build (pipeline.ts buildProduct on the beta lane), in its own website copy.
        const b = betaBuild(p);
        site = betaSiteFolder(p);
        if (!b?.ok || !fs.existsSync(site)) {
          return record(p.id, undefined, { status: 'waiting', at: t0, detail: b && !b.ok ? `the build of ${BETA} failed: ${b.error ?? '?'}` : `waiting for a build of ${BETA} (the daily run or "studio build ${p.id}" makes one)` });
        }
        sha = b.sha.slice(0, 7);
        ref = `${BETA} (build${b.version ? ` Game/v${b.version}` : ''})`;
      }
      progress('collecting the website folder');
      files = await collect(site, { site: 'tracked' });
    } else {
      const top = p.repo.split('/')[0];
      const repoDir = path.join(PROJECTS, top);
      const sub = path.relative(top, p.site);
      progress('fetching');
      await git(repoDir, ['fetch', '--quiet', '--prune', 'origin']);
      let commit: string;
      if (o.dir) {
        commit = (await git(o.dir, ['rev-parse', 'HEAD'])).out;
        ref = `change ${o.change ?? ''} (worktree)`.trim();
      } else if (o.change) {
        const c = changeRow(o.change);
        if (!c) throw new Error(`No change ${o.change}`);
        commit = c.worktree && fs.existsSync(c.worktree) ? (await git(c.worktree, ['rev-parse', 'HEAD'])).out : (await git(repoDir, ['rev-parse', `origin/${c.branch}`])).out;
        ref = c.branch;
      } else {
        const beta = await git(repoDir, ['rev-parse', '--verify', '--quiet', `origin/${BETA}`]);
        commit = beta.ok ? beta.out : (await git(repoDir, ['rev-parse', `origin/${BRANCH}`])).out;
        ref = beta.ok ? BETA : `${BRANCH} (no ${BETA} branch yet)`;
      }
      if (!commit) throw new Error(`Couldn't find the commit for ${ref}`);
      sha = commit.slice(0, 7);
      progress(`checking out ${ref} (${sha})`);
      const wt = await worktree(repoDir, p.id, commit);
      const dir = path.join(wt, sub);
      const r = RECIPES[p.id] ?? { site: 'tracked' };
      if (r.build) {
        if (fs.existsSync(path.join(dir, 'package-lock.json'))) {
          const lock = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');
          const mark = path.join(dir, 'node_modules', '.preview-lock');
          if (!fs.existsSync(mark) || fs.readFileSync(mark, 'utf8') !== lock) {
            progress('npm ci');
            const ci = await exec('npm ci --no-audit --no-fund --loglevel=error', [], dir, { shell: true });
            if (!ci.ok) throw new Error(`npm ci failed: ${tail(ci.err || ci.out)}`);
            fs.writeFileSync(mark, lock);
          }
        }
        progress(r.build);
        const b = await exec(r.build, [], dir, { shell: true });
        if (!b.ok) throw new Error(`${r.build} failed: ${tail(b.err || b.out)}`);
      }
      files = await collect(dir, r);
    }
    progress(`copying ${files.size} files`);
    await place(files, target);
    return record(p.id, o.change, { status: 'ready', at: Date.now(), sha, ref, files: files.size, ms: Date.now() - t0 });
  } catch (e: any) {
    const prev = readState()[p.id];
    const last = o.change ? prev?.changes?.[o.change] : prev?.beta;
    return record(p.id, o.change, { ...(last ?? {}), status: 'failed', at: Date.now(), detail: String(e.message ?? e).slice(0, 500) });
  }
}

function changeRow(id: string): { worktree: string | null; branch: string } | null {
  try {
    return (db.prepare('SELECT worktree, branch FROM changes WHERE id = ?').get(id) as any) ?? null;
  } catch {
    return null;
  }
}

/** The product's preview worktree, detached at `commit` (node_modules and build caches stay between builds). */
async function worktree(repoDir: string, id: string, commit: string) {
  const wt = path.join(WORK, id);
  if (!fs.existsSync(path.join(wt, '.git'))) {
    fs.mkdirSync(WORK, { recursive: true });
    await git(repoDir, ['worktree', 'prune']);
    const a = await git(repoDir, ['worktree', 'add', '--detach', '--force', wt, commit]);
    if (!a.ok) throw new Error(`worktree failed: ${tail(a.err)}`);
    return wt;
  }
  const c = await git(wt, ['checkout', '--quiet', '--detach', '--force', commit]);
  if (!c.ok) throw new Error(`checkout failed: ${tail(c.err)}`);
  await git(wt, ['clean', '-fdq']); // untracked leftovers (ignored files like node_modules stay)
  return wt;
}

/** Never published: git and agent folders, dependencies, keys. */
const skip = (rel: string) => rel.split('/').some((s) => (s.startsWith('.') && s !== '.well-known' && s !== '.nojekyll') || s === 'node_modules')
  || /\.(pem|key)$/i.test(rel) || /(^|\/)\.env/.test(rel);

/** dest path -> source file. Sources from git are hard-linked (git replaces files, never rewrites them); build output is copied. */
async function collect(dir: string, r: Recipe) {
  const files = new Map<string, { src: string; link: boolean }>();
  const add = (rel: string, src: string, link: boolean) => { if (!skip(rel)) files.set(rel, { src, link }); };
  if (r.site === 'tracked') {
    const ls = await git(dir, ['ls-files', '-co', '--exclude-standard', '-z']);
    if (!ls.ok) throw new Error(`git ls-files failed: ${tail(ls.err)}`);
    for (const rel of ls.out.split('\0').filter(Boolean)) {
      const src = path.join(dir, rel);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) add(rel, src, true);
    }
  } else if (Array.isArray(r.site)) {
    for (const top of r.site) for (const rel of walk(dir, top)) add(rel, path.join(dir, rel), true);
  }
  if (r.out) {
    const outDir = path.join(dir, r.out.from);
    if (!fs.existsSync(outDir)) throw new Error(`the build made no ${r.out.from}/`);
    for (const rel of walk(outDir, '')) add(path.posix.join(r.out.to, rel), path.join(outDir, rel), false);
  }
  if (!files.size) throw new Error('nothing to publish');
  return files;
}

function walk(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs.readdirSync(abs).flatMap((n) => walk(root, rel ? `${rel}/${n}` : n));
}

/** Writes the files into a fresh folder, then swaps it in for the old one. */
async function place(files: Map<string, { src: string; link: boolean }>, target: string) {
  const tmp = `${target}.new-${Date.now()}`;
  const made = new Set<string>();
  for (const [rel, { src, link }] of files) {
    const dest = path.join(tmp, rel);
    const d = path.dirname(dest);
    if (!made.has(d)) {
      await fs.promises.mkdir(d, { recursive: true });
      made.add(d);
    }
    if (link) {
      try {
        await fs.promises.link(src, dest);
        continue;
      } catch {
        // Another disk, or links unsupported: copy.
      }
    }
    await fs.promises.copyFile(src, dest);
  }
  const old = `${target}.old-${Date.now()}`;
  if (fs.existsSync(target)) await fs.promises.rename(target, old);
  await fs.promises.rename(tmp, target);
  await fs.promises.rm(old, { recursive: true, force: true });
}

/** Removes a change's preview (when it's merged or closed). */
export async function removePreview(productId: string, change: string) {
  if (!/^c_[0-9a-f]+$/.test(change)) throw new StudioError(`Not a change id: ${change}`);
  await fs.promises.rm(path.join(PREVIEWS, getProduct(productId).id, 'c', change), { recursive: true, force: true });
  record(getProduct(productId).id, change, null);
}

/**
 * After `repos sync`: rebuilds the beta preview of every product whose repo or website folder changed (and any that
 * was never built). Runs in the background; returns the products queued. Unity products are rebuilt after their beta
 * build instead (pipeline.ts), since a sync alone doesn't change what's built.
 */
export function previewsAfterSync(results: RepoResult[], { missing = true } = {}) {
  const changed = new Set(results.filter((r) => r.action === 'updated' || r.action === 'cloned').map((r) => r.folder));
  const state = readState();
  const queued: string[] = [];
  for (const p of loadProducts()) {
    if (!subOf(p.id)) continue;
    const touched = !p.build && [p.repo, p.site].some((f) => changed.has(f.split('/')[0]));
    if (touched || (missing && !state[p.id]?.beta)) {
      void buildPreview(p.id);
      queued.push(p.id);
    }
  }
  return queued;
}

/** Every product's staging URLs and when each was built. */
export function listPreviews() {
  const state = readState();
  const live = (p: Product) => { try { return new URL(p.live).pathname; } catch { return '/'; } };
  const shown = (key: string, v?: Preview) => v && (v.status === 'building' && !active.has(key) ? { ...v, status: 'failed' as const, detail: 'interrupted (Studio restarted)' } : v);
  return loadProducts().filter((p) => subOf(p.id)).map((p) => {
    const url = previewUrl(p.id)!;
    const s = state[p.id] ?? {};
    return {
      product: p.id, name: p.name, sub: subOf(p.id), url, play: url.replace(/\/$/, '') + live(p),
      beta: shown(`${p.id}/beta`, s.beta) ?? null,
      changes: Object.entries(s.changes ?? {}).map(([id, v]) => ({ id, url: previewUrl(p.id, id), play: previewUrl(p.id, id)!.replace(/\/$/, '') + live(p), ...shown(`${p.id}/${id}`, v) })),
    };
  });
}
