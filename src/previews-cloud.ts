// The beta sites when Studio runs on Cloud Run (docs/studio-cloudrun.md, "Beta sites"): previews.ts build() hands over
// here, and the site is published to R2 through the beta-sites Worker (sitestore.ts) instead of a folder Caddy served.
//
//   - Static sites (the corporate site, Imagine Live TV) and Unity sites (the website repo's beta, where tag builds put
//     Game/v<n>): the files of that commit straight from GitHub's API. No clone (Sick Of It's website is 1.4 GB).
//   - Sites with a build (Dose Of Destruction, PH Origins, I Can Be: previews.ts RECIPES): the build runs as one
//     execution of the agents' Cloud Run job (cloudjob.ts runCloudBuild), never in Studio's own process, and only its
//     output comes back; the committed part of the site still comes from GitHub.
//   - An agent change's preview (/c/<change>/): the change's commit, from its worktree here (git ls-tree / cat-file);
//     its build gets the commits GitHub lacks as a bundle. Files beta already has are copied inside R2.
//   - Unity source changes get no preview here: their build is a tag build onto the website's beta (tagbuild.ts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Product } from './config.ts';
import { repoMap, BETA, BRANCH } from './repos.ts';
import { cloudMode } from './cloudauth.ts';
import { siteKeys } from './sitekeys.ts';
import { WIDGET, type PageInfo } from './bugreport.ts';
import { githubCommit, githubFiles, localGitFiles, folderFiles, publishSite, publishWidget, removeSite, readManifest, sitesUrl, workerStore, type SiteFile, type SiteStore } from './sitestore.ts';

/** Beta sites go to R2 (Cloud Run, with a key to sign with), not to a local folder. STUDIO_SITES=local turns it off. */
export const remoteSites = () => cloudMode() && process.env.STUDIO_SITES !== 'local' && Boolean(siteKeys());

/** Not built, and not a failure either: nothing to publish yet (previews.ts records "waiting"). */
export class SiteWaiting extends Error {}

export type CloudRecipe = { build?: string; site: 'tracked' | 'none' | string[]; out?: { from: string; to: string } };
export type CloudDeps = {
  store?: SiteStore;
  fetcher?: typeof fetch;
  build?: typeof import('./cloudjob.ts').runCloudBuild;
  /** A change's row (agents.ts): its worktree and repo. */
  changeRow?: (id: string) => { worktree: string | null; branch: string; repo?: string } | null;
  /** previews.ts keepOldBuilds's state: when each older Game/v<n> stopped being beta's build. */
  kept?: { get(): Record<string, number>; set(v: Record<string, number>): void };
  keptVersions?: (published: number[], old: number[], since: Record<string, number>) => Record<string, number>;
  skip?: (rel: string) => boolean;
  recipe?: CloudRecipe;
  domain?: string;
};

const run = (cwd: string) => (args: string[]) => {
  const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, raw: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? Buffer.alloc(0)).toString('utf8').trim() };
};
const rel = (top: string, p: string) => path.posix.relative(top, p.replace(/\\/g, '/'));
const versionsIn = (paths: Iterable<string>) => [...new Set([...paths].map((r) => /^Game\/v([1-9]\d*)\//.exec(r)?.[1]).filter(Boolean).map(Number))];

/** Picks what a recipe publishes of the committed files. */
export function pick(files: SiteFile[], site: CloudRecipe['site']) {
  if (site === 'tracked') return files;
  if (site === 'none') return [];
  return files.filter((f) => site.some((top) => f.path === top || f.path.startsWith(`${top}/`)));
}

export type CloudPublished = { sha: string; ref: string; files: number; version?: string | null; detail: string };

/** Publishes a product's beta site (or an agent change's preview) at <sub>/beta or <sub>/c/<change> in this lane. */
export async function publishCloud(p: Product, sub: string, o: { change?: string }, progress: (s: string) => void, deps: CloudDeps = {}): Promise<CloudPublished> {
  const store = deps.store ?? workerStore(sitesUrl(deps.domain ?? 'hawkesgen.ai'));
  const repos = repoMap();
  const base = `${sub}/${o.change ? `c/${o.change}` : 'beta'}`;
  const skip = deps.skip ?? (() => false);
  const recipe = deps.recipe ?? { site: 'tracked' };
  const row = o.change ? deps.changeRow?.(o.change) ?? null : null;
  if (o.change && !row) throw new Error(`No change ${o.change}`);
  const local = row?.worktree && fs.existsSync(row.worktree) ? row.worktree : null;
  let files: SiteFile[];
  let sha: string;
  let ref: string;
  let version: string | null = null;
  let keep: ((p: string) => boolean) | undefined;

  if (p.engine === 'unity' || p.build) {
    const siteTop = p.site.split('/')[0];
    const siteSub = rel(siteTop, p.site);
    if (o.change) {
      if (row?.repo !== siteTop || !local) throw new SiteWaiting('Unity changes get no preview on Google Cloud (no build server): the beta site shows the change once a build-* tag has built it onto the website\'s beta');
      sha = run(local)(['rev-parse', 'HEAD']).raw.toString('utf8').trim();
      ref = `change ${o.change} (website)`;
      progress('listing the change\'s website files');
      files = localGitFiles(local, sha, run(local), siteSub);
    } else {
      const slug = repos[siteTop];
      if (!slug) throw new Error(`${siteTop} isn't in products.json "repos"`);
      progress(`asking GitHub for ${slug} ${BETA}`);
      const beta = await githubCommit(slug, BETA, deps.fetcher);
      const at = beta ?? (await githubCommit(slug, BRANCH, deps.fetcher));
      if (!at) throw new Error(`${slug} has no ${BETA} or ${BRANCH} on GitHub`);
      sha = at;
      progress(`listing ${slug} at ${sha.slice(0, 7)}`);
      files = await githubFiles(slug, sha, { sub: siteSub, fetcher: deps.fetcher });
      const published = versionsIn(files.map((f) => f.path));
      version = published.length ? String(Math.max(...published)) : null;
      ref = `${beta ? BETA : `${BRANCH} (no ${BETA} yet)`}${version ? ` (build Game/v${version})` : ''}`;
      // A page still open on the previous build keeps loading its files (previews.ts keepOldBuilds).
      if (deps.kept && deps.keptVersions && published.length) {
        const prev = await readManifest(store, base);
        const old = versionsIn(Object.keys(prev?.files ?? {}));
        const kept = deps.keptVersions(published, old, deps.kept.get());
        deps.kept.set(kept);
        const keepSet = new Set(Object.keys(kept).map((v) => `Game/v${v}/`));
        keep = (f) => [...keepSet].some((k) => f.startsWith(k));
      }
    }
  } else {
    const top = p.repo.split('/')[0];
    const siteSub = rel(top, p.site);
    const slug = repos[top];
    if (!slug) throw new Error(`${top} isn't in products.json "repos"`);
    let bundle: string | null = null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-site-'));
    try {
      if (o.change) {
        if (!local) throw new SiteWaiting(`the change's worktree is gone, so its preview can't be built`);
        sha = run(local)(['rev-parse', 'HEAD']).raw.toString('utf8').trim();
        ref = `change ${o.change}`;
        progress('listing the change\'s files');
        files = pick(localGitFiles(local, sha, run(local), siteSub), recipe.site);
        if (recipe.build && !(await githubCommit(slug, sha, deps.fetcher).catch(() => null))) {
          // Commits GitHub doesn't have yet go to the build job as a bundle (as an agent's pass gets them).
          bundle = path.join(tmp, 'in.bundle');
          if (!run(local)(['bundle', 'create', bundle, 'HEAD', '--not', '--remotes']).ok) bundle = null;
        }
      } else {
        progress(`asking GitHub for ${slug} ${BETA}`);
        const beta = await githubCommit(slug, BETA, deps.fetcher);
        const at = beta ?? (await githubCommit(slug, BRANCH, deps.fetcher));
        if (!at) throw new Error(`${slug} has no ${BETA} or ${BRANCH} on GitHub`);
        sha = at;
        ref = beta ? BETA : `${BRANCH} (no ${BETA} branch yet)`;
        progress(`listing ${slug} at ${sha.slice(0, 7)}`);
        files = pick(await githubFiles(slug, sha, { sub: siteSub, fetcher: deps.fetcher }), recipe.site);
      }
      if (recipe.build && recipe.out) {
        const build = deps.build ?? (await import('./cloudjob.ts')).runCloudBuild;
        const cd = siteSub ? `cd '${siteSub.replace(/'/g, '')}' && ` : '';
        const install = `if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error; elif [ -f package.json ]; then npm install --no-audit --no-fund --loglevel=error; fi`;
        const out = path.posix.join(siteSub || '.', recipe.out.from);
        progress(`building ${sha.slice(0, 7)} in a Cloud Run job (${recipe.build})`);
        const b = await build(`site-${p.id}-${Date.now().toString(36)}`, {
          remote: `https://github.com/${slug}.git`, head: sha, cwd: `/tmp/build/${top}`, bundle,
          command: `${cd}(${install}) && ${recipe.build}`, outputs: [out], gitToken: process.env.GITHUB_TOKEN ?? null,
          onLine: (l) => { if (/^\[job\]|error|built in/i.test(l)) progress(l.slice(0, 200)); },
        });
        const tail = b.log.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
        if (b.error || b.code !== 0) throw new Error(`${recipe.build} failed${b.error ? `: ${b.error}` : ` (exit ${b.code})`}${tail ? `: ${tail}` : ''}`);
        if (!b.outputs) throw new Error(`the build made no ${recipe.out.from}/`);
        const x = spawnSync('tar', ['-xzf', '-'], { cwd: tmp, input: b.outputs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (x.status !== 0) throw new Error(`unpacking the build: ${String(x.stderr).trim().slice(0, 300)}`);
        const built = folderFiles(path.join(tmp, out), recipe.out.to);
        if (!built.length) throw new Error(`the build made no ${recipe.out.from}/`);
        const byPath = new Map(files.map((f) => [f.path, f]));
        for (const f of built) byPath.set(f.path, f);
        files = [...byPath.values()];
        files = await publishAll(store, base, files, skip, p, sha, ref, version, o.change, progress, keep);
        return { sha: sha.slice(0, 7), ref, files: files.length, version, detail: '' };
      }
    } finally {
      // Built files are read during the publish above, before this runs.
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  files = await publishAll(store, base, files, skip, p, sha, ref, version, o.change, progress, keep);
  return { sha: sha.slice(0, 7), ref, files: files.length, version, detail: '' };
}

async function publishAll(store: SiteStore, base: string, all: SiteFile[], skip: (rel: string) => boolean, p: Product, sha: string, ref: string, version: string | null, change: string | undefined, progress: (s: string) => void, keep?: (p: string) => boolean) {
  const files = all.filter((f) => !skip(f.path));
  if (!files.length) throw new Error('nothing to publish');
  const page: PageInfo = { product: p.id, sha: sha.slice(0, 7), ref, ...(change ? { change } : {}), ...(version ? { version } : {}), built: Date.now() };
  progress(`publishing ${files.length} files`);
  const sub = base.split('/')[0];
  const r = await publishSite(store, base, files, {
    page, keep, progress, meta: { sha, ref },
    copyFrom: change ? [`${sub}/beta`] : [],
    build: change ? undefined : { sha: sha.slice(0, 7), version, at: Date.now() },
  });
  await publishWidget(store, WIDGET).catch(() => {});
  progress(`published: ${r.sent} sent, ${r.copied} copied, ${r.removed} removed (${Math.round(r.bytes / 1e6)} MB)`);
  return files;
}

/** Removes a change's preview from R2. */
export async function removeCloud(sub: string, change: string, deps: { store?: SiteStore; domain?: string } = {}) {
  return removeSite(deps.store ?? workerStore(sitesUrl(deps.domain ?? 'hawkesgen.ai')), `${sub}/c/${change}`);
}

