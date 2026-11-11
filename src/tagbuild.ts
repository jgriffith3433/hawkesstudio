// Tag builds: J pushes a tag named build-<anything> in a Unity source repo (sickofitgame-unity, YoobaLand,
// breakingthrough) and the game is built in the cloud from GitHub and pushed to its website repo's beta.
//
//   git tag build-2026-10-28 && git push origin build-2026-10-28
//
// 1. The repo's workflow (.github/workflows/hawkes-studio.yml, on push of tags build-*) calls POST /api/hooks/github
//    with GitHub's OIDC token, exactly as for pushes (server.ts checks it: J's repos, a push).
// 2. onBuildTag starts a beta run of each Unity product in that repo with options.tag. Its build step (buildTag) asks
//    Hawkes Gen for unity.build in GitHub mode: that exact commit, fetched by the Cloud Run job, built, and committed as
//    Game/v<n> plus the loader to the website repo's beta (never main; Gen and its container both refuse main).
// 3. The beta website copy moves onto the pushed commit and is recorded as the beta build of that commit, so the run's
//    playtest plays it and going live (J's typed DEPLOY <product>) publishes it.
//
// Pushes to beta still build as before (betawatch.ts); a tag is the way to build one exact commit on demand.

import { loadProducts, type Product } from './config.ts';
import { db } from './db.ts';
import { repoMap, BETA } from './repos.ts';

/** The tags that start a build: build-<letters, digits, . _ ->. Anything else is ignored. */
export const BUILD_TAG_RE = /^build-[A-Za-z0-9._-]{1,80}$/;

export type BuildTag = { name: string; sha: string };

/** The build tag in a pushed ref (refs/tags/build-x), or null for any other ref or tag. */
export function buildTagOf(ref: string): string | null {
  const m = /^refs\/tags\/(.+)$/.exec(ref);
  return m && BUILD_TAG_RE.test(m[1]) ? m[1] : null;
}

/** The Unity products whose source repo is this folder. */
export const unityProductsIn = (folder: string, products: Product[] = loadProducts()) =>
  products.filter((p) => p.build && p.repo.split('/')[0] === folder);

/**
 * The Game/v<n> a tag build makes: one past every number Studio built before and every one on the website's beta and
 * main, so a browser never plays an old build from its cache. Only for products whose deploy method reads it from the
 * environment (products.json build.versionEnv); the others count up from what their website's beta holds.
 */
export function nextVersion(builtMax: number, onSite: number[]) {
  return Math.max(0, builtMax || 0, ...onSite) + 1;
}

/** The Game/v<n> numbers in a website repo branch, from GitHub's contents API (no clone; [] when it can't tell). */
export async function siteVersions(slug: string, ref: string, fetcher: typeof fetch = fetch, token?: string | null): Promise<number[]> {
  try {
    // The repo's own token (ghtoken.ts: J's for his repos, the GitHub App's for anyone else's) unless one is given.
    if (token === undefined) token = await (await import('./ghtoken.ts')).repoToken(slug).catch(() => null);
    const r = await fetcher(`https://api.github.com/repos/${slug}/contents/Game?ref=${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return [];
    const list = (await r.json()) as { name?: string; type?: string; download_url?: string }[];
    if (!Array.isArray(list)) return [];
    const out = list.filter((e) => e.type === 'dir').map((e) => /^v([1-9]\d*)$/.exec(String(e.name))?.[1]).filter(Boolean).map(Number);
    // Builds in R2 leave no Game/v<n> in git: Game/build.json names the version (docs/unity-builds-storage.md).
    const bj = list.find((e) => e.name === 'build.json' && e.type === 'file');
    if (bj?.download_url) {
      const v = Number(((await (await fetcher(bj.download_url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) })).json().catch(() => ({}))) as any)?.version);
      if (Number.isInteger(v) && v > 0) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

/** The commit a branch points at on GitHub, or null when it can't tell. The Beta button on Cloud Run builds beta's head
 *  this way, through the tag path (GitHub mode): there is no source checkout or beta website copy on the instance. */
export async function branchHead(slug: string, branch: string, fetcher: typeof fetch = fetch, token?: string | null): Promise<string | null> {
  try {
    if (token === undefined) token = await (await import('./ghtoken.ts')).repoToken(slug).catch(() => null);
    const r = await fetcher(`https://api.github.com/repos/${slug}/commits/${encodeURIComponent(branch)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const sha = String(((await r.json()) as { sha?: string })?.sha ?? '');
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Hawkes Gen's unity.build params for a tag build (GitHub mode). */
export function tagBuildParams(p: Product, tag: BuildTag, { repos = repoMap(), version }: { repos?: Record<string, string>; version?: number } = {}) {
  const b = p.build;
  if (!b) throw new Error(`${p.name} isn't a Unity product`);
  const repo = repos[p.repo.split('/')[0]];
  const siteRepo = repos[p.site.split('/')[0]];
  if (!repo || !siteRepo) throw new Error(`products.json "repos" has no GitHub repo for ${!repo ? p.repo.split('/')[0] : p.site.split('/')[0]}`);
  if (!/^[0-9a-f]{40}$/i.test(tag.sha)) throw new Error(`the tag ${tag.name} has no commit sha (got "${tag.sha}")`);
  return {
    project: b.project, site: b.site, method: b.method,
    ...(version && b.versionEnv ? { env: { [b.versionEnv]: String(version) } } : {}),
    github: { repo, commit: tag.sha.toLowerCase(), ref: tag.name, siteRepo, branch: BETA, ...(b.r2 ? { builds: b.r2 } : {}) },
  };
}

/** A tag build of this commit already going (a re-pushed tag, GitHub retrying the hook): not started twice. */
export function tagRunGoing(productId: string, sha: string): string | null {
  const r = db.prepare(`SELECT id FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ? AND json_extract(options, '$.tag.sha') = ? LIMIT 1`).get(`%"${productId}"%`, sha) as { id: string } | undefined;
  return r?.id ?? null;
}

export type TagStart = (productId: string, opts: { tag: BuildTag; playtest: boolean; quiet: number }) => { id: string };

/** A build tag pushed in a source repo folder: one beta run per Unity product in it, building that commit. */
export async function onBuildTag(folder: string, tagName: string, sha: string, { start, products }: { start?: TagStart; products?: Product[] } = {}) {
  const unity = unityProductsIn(folder, products);
  if (!unity.length) return { ok: false as const, ignored: `${folder} has no Unity product: tags build only Unity games` };
  // Loaded lazily: pipeline.ts pulls in most of Studio.
  const begin: TagStart = start ?? (await import('./pipeline.ts')).startBeta;
  const runs: Record<string, string> = {};
  for (const p of unity) {
    const going = tagRunGoing(p.id, sha);
    // A tag build plays its build (go live needs a played beta build); quiet 0: it was asked for on purpose.
    runs[p.id] = going ?? begin(p.id, { tag: { name: tagName, sha }, playtest: true, quiet: 0 }).id;
  }
  return { ok: true as const, tag: tagName, sha, runs };
}

export type TagBuildDeps = {
  startStep: (run: string, product: string, kind: string, name: string, detail?: string) => string;
  updateStep: (id: string, patch: { status?: string; detail?: string; job?: string; data?: unknown; cost?: number; finished?: boolean }) => void;
  resumedStep: (id: string) => { status: string; job?: string | null; data?: any } | null;
  unityBuild: (project: string, params: Record<string, unknown>, onUpdate?: (job: any) => void, opts?: { job?: string; onSubmit?: (id: string) => void; log?: (s: string) => void; halt?: () => string | null; priority?: 'person' | 'auto'; identity?: string }) => Promise<any>;
  /** The highest Game/v<n> Studio built for the product. */
  builtMax: (productId: string) => number;
  /** The Game/v<n> numbers on a website repo branch. */
  versionsOn: (slug: string, ref: string) => Promise<number[]>;
  /** After the push: the beta website copy at the pushed website commit, recorded as the beta build of the tag's commit. */
  settle: (p: Product, b: { sha: string; base: string; job: string; version: string | null; cost: number; minutes: number; tag: string }) => Promise<void>;
  halt?: () => string | null;
  repos?: Record<string, string>;
};

/** The build step of a tag's beta run: Gen builds the commit from GitHub and pushes it to the website's beta. */
export async function buildTag(run: string, p: Product, tag: BuildTag, d: TagBuildDeps) {
  const s = d.startStep(run, p.id, 'build', 'unity', `building ${tag.name} (${tag.sha.slice(0, 7)}) in the cloud`);
  const was = d.resumedStep(s);
  if (was && was.status !== 'running') return was.status === 'done' ? { id: was.job, status: 'done', result: was.data } : { id: was.job, status: was.status };
  const repos = d.repos ?? repoMap();
  let version: number | undefined;
  if (p.build?.versionEnv && !was?.job) {
    const siteRepo = repos[p.site.split('/')[0]];
    const onSite = siteRepo ? [...await d.versionsOn(siteRepo, BETA), ...await d.versionsOn(siteRepo, 'main')] : [];
    version = nextVersion(d.builtMax(p.id), onSite);
  }
  const params = tagBuildParams(p, tag, { repos, version });
  d.updateStep(s, { data: { tag: tag.name, beta: tag.sha, pinned: version ?? null, fingerprint: null } });
  const job = await d.unityBuild(p.id, params, (j) => d.updateStep(s, { job: j.id, detail: j.detail }),
    { job: was?.job ?? undefined, onSubmit: (id) => d.updateStep(s, { job: id }), log: (m) => d.updateStep(s, { detail: m }), halt: d.halt, priority: 'person', identity: `tag|${p.id}|${tag.sha.toLowerCase()}` });
  if (job.status === 'cancelled') {
    d.updateStep(s, { status: 'cancelled', job: job.id ?? undefined, detail: `cancelled: ${job.error ?? job.detail ?? 'not built'}`, data: { tag: tag.name, cancelled: true, fingerprint: null }, finished: true });
    return { ...job, status: 'cancelled' };
  }
  const r = job.result ?? {};
  const pushed = r.pushed as { repo: string; branch: string; commit: string; before?: string | null } | null | undefined;
  // A build that said done but didn't go through GitHub mode (an older Gen) never counts as the beta build.
  const wrong = job.status === 'done' && !r.github ? 'Hawkes Gen ran unity.build without GitHub mode (update Hawkes Gen)' : job.status === 'done' && pushed && pushed.branch !== BETA ? `the build was pushed to ${pushed.branch}, not ${BETA}` : null;
  if (job.status !== 'done' || wrong) {
    const error = wrong ?? String(job.error ?? job.detail ?? 'build failed');
    d.updateStep(s, { status: 'failed', job: job.id, cost: job.cost ?? r.cost ?? 0, detail: `failed: ${error}`, data: { ...r, tag: tag.name, beta: tag.sha, error, fingerprint: null }, finished: true });
    return { ...job, status: 'failed', error };
  }
  const minutes = Math.round((r.seconds ?? 0) / 60);
  const cost = job.cost ?? r.cost ?? 0;
  let settled: string | null = null;
  if (pushed) {
    try {
      await d.settle(p, { sha: tag.sha, base: pushed.commit, job: job.id, version: r.version ?? null, cost, minutes, tag: tag.name });
    } catch (e: any) {
      settled = String(e.message ?? e);
    }
  }
  const where = pushed ? `${pushed.repo} ${pushed.branch} ${pushed.commit.slice(0, 7)}` : `nothing new for ${BETA}`;
  d.updateStep(s, {
    status: 'done', job: job.id, cost,
    detail: `built ${tag.name} (${tag.sha.slice(0, 7)})${r.version ? ` Game/v${r.version}` : ''} in ${minutes} min ($${Number(cost).toFixed(2)}), pushed to ${where}${settled ? `; the beta website copy didn't move: ${settled}` : ''}`,
    data: { ...r, tag: tag.name, beta: tag.sha, fingerprint: null, ...(pushed && !settled ? { served: { sha: tag.sha, version: r.version ?? null } } : {}) }, finished: true,
  });
  return job;
}

/** The real dependencies of buildTag inside Studio (pipeline.ts uses this). */
export async function studioTagDeps(run: string): Promise<TagBuildDeps> {
  const pipeline = await import('./pipeline.ts');
  const { unityBuild } = await import('./buildpkgs.ts');
  const { haltOf } = await import('./cancel.ts');
  const beta = await import('./beta.ts');
  const { waitForBetaPlays } = await import('./betaplay.ts');
  return {
    startStep: pipeline.startStep, updateStep: pipeline.updateStep, resumedStep: pipeline.resumedStep, unityBuild, halt: haltOf(run),
    builtMax: (id) => Number((db.prepare(`SELECT MAX(CAST(json_extract(data, '$.version') AS INTEGER)) AS v FROM steps WHERE product = ? AND kind = 'build' AND name = 'unity' AND status = 'done'`).get(id) as any)?.v) || 0,
    versionsOn: (slug, ref) => siteVersions(slug, ref),
    settle: async (p, b) => {
      // Runs still playing the current beta copy finish first (betaplay.ts); then the copy is the pushed website commit.
      // On Cloud Run the beta site comes from the website's beta on GitHub (previews-cloud.ts): publish it now, before
      // the local website copy below (which a large website repo may not fit for).
      const { remoteSites } = await import('./previews-cloud.ts');
      if (remoteSites()) void import('./previews.ts').then(({ buildPreview }) => buildPreview(p.id)).catch(() => {});
      await waitForBetaPlays(p.id, run);
      // On Cloud Run there is no local website copy: the published R2 site is the beta copy, and a Unity website repo
      // (Sick Of It's is 8 GB) doesn't fit the instance's memory disk.
      if (remoteSites()) return void beta.saveBetaBuild(p, { sha: b.sha, base: b.base, ok: true, at: Date.now(), job: b.job, version: b.version, cost: b.cost, minutes: b.minutes });
      const { site } = beta.repoDirs(p);
      await beta.ensureCloned(site);
      await beta.fetchOrigin(site);
      await beta.scratch(site, `${p.id}-site`, b.base);
      beta.saveBetaBuild(p, { sha: b.sha, base: b.base, ok: true, at: Date.now(), job: b.job, version: b.version, cost: b.cost, minutes: b.minutes });
      if (!remoteSites()) void import('./previews.ts').then(({ buildPreview }) => buildPreview(p.id)).catch(() => {});
    },
  };
}
