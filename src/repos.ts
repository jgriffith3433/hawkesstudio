// Product repos on the server: clone what's missing and fast-forward what's there, from GitHub, into the same
// layout as C:\Projects (products.json "repos": top-level folder -> owner/name). On J's PC the repos are already
// there and this is a no-op unless asked. GitHub access on the server comes from the hawkes/github secret through
// the git credential helper (bin/git-credential-hawkes).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECTS, paths } from './config.ts';

export const BRANCH = process.env.STUDIO_BRANCH || 'main';
/** The branch between agent changes and the live site (beta.ts). On the server, product source repos are kept on it. */
export const BETA = process.env.STUDIO_BETA_BRANCH || 'beta';

function git(cwd: string, args: string[], timeoutMs = 20 * 60_000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
}

export function repoMap(): Record<string, string> {
  return JSON.parse(fs.readFileSync(paths.products, 'utf8')).repos ?? {};
}

export type RepoResult = { folder: string; slug: string; action: 'cloned' | 'updated' | 'current' | 'kept' | 'failed'; detail: string; head?: string; dirty?: string[] };

/**
 * Brings one repo up to date: clone if missing; else fetch, and fast-forward the branch when the working tree is
 * clean (local changes are never thrown away: the repo is "kept" and reported). With `want`, a clean checkout is
 * switched to that branch first when origin has it (the server keeps product source repos on beta).
 */
export function syncRepo(folder: string, slug: string, branch = BRANCH, want?: string): RepoResult {
  const dir = path.join(PROJECTS, folder);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { folder, slug, action: 'failed', detail: `${dir} exists and isn't a git repo` };
    const c = git(PROJECTS, ['clone', '--quiet', `https://github.com/${slug}.git`, folder]);
    if (!c.ok) return { folder, slug, action: 'failed', detail: c.err.split('\n').pop() ?? 'clone failed' };
    const pick = [want, branch].find((b) => b && git(dir, ['rev-parse', '--verify', '--quiet', `origin/${b}`]).ok);
    if (pick) git(dir, ['checkout', '--quiet', pick]);
    return { folder, slug, action: 'cloned', detail: `cloned (${pick ?? 'default branch'})`, head: git(dir, ['log', '-1', '--format=%h %s']).out };
  }
  const f = git(dir, ['fetch', '--quiet', '--prune', 'origin']);
  if (!f.ok) return { folder, slug, action: 'failed', detail: `fetch failed: ${f.err.split('\n').pop()}` };
  let cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const dirty = git(dir, ['status', '--porcelain']).out;
  if (dirty) {
    const files = [...new Set([...git(dir, ['diff', '--name-only', 'HEAD']).out.split('\n'), ...git(dir, ['ls-files', '--others', '--exclude-standard']).out.split('\n')])].filter(Boolean);
    return { folder, slug, action: 'kept', detail: `${cur}: uncommitted changes (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}), not updated`, head: git(dir, ['log', '-1', '--format=%h %s']).out, dirty: files };
  }
  let switched = '';
  if (want && cur !== want && git(dir, ['rev-parse', '--verify', '--quiet', `origin/${want}`]).ok) {
    const c = git(dir, ['checkout', '--quiet', want]);
    if (!c.ok) return { folder, slug, action: 'failed', detail: `switching to ${want} failed: ${c.err.split('\n').pop()}` };
    switched = `switched ${cur} -> ${want}; `;
    cur = want;
  }
  const behind = Number(git(dir, ['rev-list', '--count', `HEAD..origin/${cur}`]).out) || 0;
  if (!behind) return { folder, slug, action: switched ? 'updated' : 'current', detail: `${switched}${cur} is up to date`, head: git(dir, ['log', '-1', '--format=%h %s']).out };
  const m = git(dir, ['merge', '--ff-only', '--quiet', `origin/${cur}`]);
  if (!m.ok) return { folder, slug, action: 'kept', detail: `${switched}${cur} has local commits; not fast-forwarded`, head: git(dir, ['log', '-1', '--format=%h %s']).out };
  return { folder, slug, action: 'updated', detail: `${switched}${cur}: ${behind} new commits`, head: git(dir, ['log', '-1', '--format=%h %s']).out };
}

/** The repos agents change (each product's source repo): on the server they're kept on beta, so local playtests play it. */
export function betaFolders() {
  const products = JSON.parse(fs.readFileSync(paths.products, 'utf8')).products as { repo: string }[];
  return new Set(products.map((p) => p.repo.split('/')[0]));
}

/** Every product repo. On the server, source repos are switched to beta (when it exists); website repos stay on main. */
export function syncRepos(only?: string[]) {
  const beta = isServer() ? betaFolders() : new Set<string>();
  return Object.entries(repoMap()).filter(([f]) => !only?.length || only.includes(f)).map(([f, s]) => syncRepo(f, s, BRANCH, beta.has(f) ? BETA : undefined));
}

/** True on the server (where Studio clones the repos itself). */
export const isServer = () => process.platform !== 'win32' && process.env.STUDIO_SERVER === '1';
