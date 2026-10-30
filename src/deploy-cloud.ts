// Going live with a Unity game when Studio runs on Cloud Run (J, 2026-10-30: "Fix Go live"). There is no checkout of the
// Unity repos there (Sick Of It's is 8 GB; the instance's disk is memory), so the plan and the go live read and move the
// branches through GitHub's API instead of git:
//   - the build is already published: a build-tag or Beta-button build (GitHub mode, tagbuild.ts) committed the loader to
//     the website's beta and its files to R2, so going live is the website's main fast-forwarded to its beta, and the
//     source's main to the playtested beta commit. Never a merge, never a force push (GitHub refuses a non-fast-forward).
//   - the same checks as deploy.ts: the build is of beta's commit, beta was playtested there, main has nothing beta lacks.
// No release entry is written here (that needs the website copy); the plan says so.

import { BETA, MAIN, betaBuild, type Commit } from './beta.ts';
import { repoMap } from './repos.ts';
import type { Product } from './config.ts';

type Fetch = typeof fetch;
export type Compare = { main: Commit | null; beta: Commit | null; ahead: Commit[]; behind: Commit[] };

/** Whether this Studio goes live through GitHub's API: Cloud Run (no checkouts of the Unity repos). */
export const cloudGoLive = () => Boolean(process.env.K_SERVICE);

const headers = (token?: string) => ({ Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) });

async function gh(f: Fetch, token: string | undefined, method: string, url: string, body?: unknown) {
  const r = await f(`https://api.github.com${url}`, { method, headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const j = (await r.json().catch(() => ({}))) as any;
  return { ok: r.ok, status: r.status, j };
}

const commitOf = (c: any): Commit => ({ sha: c.sha, short: String(c.sha).slice(0, 7), author: c.commit?.author?.name ?? c.author?.login ?? '?', date: c.commit?.committer?.date ?? c.commit?.author?.date ?? '', title: String(c.commit?.message ?? '').split('\n')[0] });

/** main and beta of a repo, the commits beta has that main lacks (ahead) and the other way (behind). */
export async function compareOnGitHub(slug: string, f: Fetch = fetch, token = process.env.GITHUB_TOKEN): Promise<Compare> {
  const head = async (b: string) => { const r = await gh(f, token, 'GET', `/repos/${slug}/commits/${b}`); return r.ok ? commitOf(r.j) : null; };
  const [main, beta] = await Promise.all([head(MAIN), head(BETA)]);
  if (!main || !beta) return { main, beta, ahead: [], behind: [] };
  const fwd = await gh(f, token, 'GET', `/repos/${slug}/compare/${MAIN}...${BETA}`);
  if (!fwd.ok) throw new Error(`GitHub couldn't compare ${slug} ${MAIN}...${BETA} (${fwd.status})`);
  const ahead = ((fwd.j.commits ?? []) as any[]).map(commitOf).reverse();
  let behind: Commit[] = [];
  if (Number(fwd.j.behind_by) > 0) {
    const back = await gh(f, token, 'GET', `/repos/${slug}/compare/${BETA}...${MAIN}`);
    behind = back.ok ? ((back.j.commits ?? []) as any[]).map(commitOf).reverse() : [];
  }
  return { main, beta, ahead, behind };
}

/** Whether `ancestor` is in `of`'s history (GitHub's compare: ancestor...of is "ahead" or "identical"). */
export async function isAncestorOnGitHub(slug: string, ancestor: string, of: string, f: Fetch = fetch, token = process.env.GITHUB_TOKEN) {
  if (ancestor === of) return true;
  const r = await gh(f, token, 'GET', `/repos/${slug}/compare/${ancestor}...${of}`);
  return r.ok && (r.j.status === 'ahead' || r.j.status === 'identical');
}

export type CloudRefs = { sourceSlug: string; siteSlug: string; source: Compare; site: Compare };

/** Both repos of a Unity game, read from GitHub. */
export async function cloudRefs(p: Product, f: Fetch = fetch, token = process.env.GITHUB_TOKEN): Promise<CloudRefs> {
  const repos = repoMap();
  const sourceSlug = repos[p.repo.split('/')[0]];
  const siteSlug = repos[p.site.split('/')[0]];
  if (!sourceSlug || !siteSlug) throw new Error(`products.json "repos" has no GitHub repo for ${!sourceSlug ? p.repo.split('/')[0] : p.site.split('/')[0]}`);
  const [source, site] = await Promise.all([compareOnGitHub(sourceSlug, f, token), compareOnGitHub(siteSlug, f, token)]);
  return { sourceSlug, siteSlug, source, site };
}

/** The blockers a Unity go live on GitHub has besides the playtests (deploy.ts adds those): the build, main vs beta. */
export async function cloudBlockers(p: Product, refs: CloudRefs, f: Fetch = fetch, token = process.env.GITHUB_TOKEN) {
  const out: string[] = [];
  const { source, site, siteSlug } = refs;
  const top = p.repo.split('/')[0];
  if (!source.beta) out.push(`${top} has no ${BETA} branch on GitHub yet.`);
  if (!site.beta) out.push(`${p.site} has no ${BETA} branch on GitHub yet: build ${BETA} first (a build tag or the Beta button).`);
  if (source.behind.length) out.push(`${MAIN} has ${source.behind.length} commit(s) ${BETA} lacks (${source.behind.slice(0, 5).map((c) => `"${c.title}"`).join(', ')}), so ${MAIN} can't be fast-forwarded. Merge ${MAIN} into ${BETA} first (studio deploy ${p.id} --merge-main), then playtest ${BETA}.`);
  if (site.behind.length) out.push(`${p.site}'s ${MAIN} has ${site.behind.length} commit(s) ${BETA} lacks (${site.behind.slice(0, 5).map((c) => `"${c.title}"`).join(', ')}), so the website's ${MAIN} can't be fast-forwarded. Merge ${MAIN} into ${BETA} first (studio deploy ${p.id} --merge-main), then playtest ${BETA}.`);
  const b = betaBuild(p);
  if (!b) out.push(`${BETA} has no build yet (a build tag or the Beta button builds it).`);
  else if (!b.ok) out.push(`The last build of ${BETA} failed: ${b.error ?? '?'}`);
  else {
    if (source.beta && b.sha !== source.beta.sha) out.push(`The beta build is of ${b.sha.slice(0, 7)}, but ${BETA} is ${source.beta.short}: build ${BETA} again ("studio beta ${p.id}").`);
    // The build's website commit must be in the website's beta (page changes merged on top of it ship with it).
    if (site.beta && b.base && !(await isAncestorOnGitHub(siteSlug, b.base, site.beta.sha, f, token))) out.push(`The beta website copy sits on ${b.base.slice(0, 7)}, but ${p.site}'s ${BETA} is ${site.beta.short} without it: run ${BETA} again ("studio beta ${p.id}").`);
  }
  if (source.beta && site.beta && !source.ahead.length && !site.ahead.length) out.push(`Nothing to go live: the beta build matches what's live and ${BETA} has no new commits.`);
  return out;
}

/** Moves a branch to a commit, fast-forward only (GitHub answers 422 for anything else). */
async function fastForward(slug: string, branch: string, sha: string, f: Fetch, token?: string) {
  const r = await gh(f, token, 'PATCH', `/repos/${slug}/git/refs/heads/${branch}`, { sha, force: false });
  if (!r.ok) throw new Error(`GitHub refused moving ${slug} ${branch} to ${sha.slice(0, 7)} (${r.status}${r.j?.message ? `: ${r.j.message}` : ''})`);
}

/**
 * The go live itself, after deploy.ts checked the plan and J's word: the website's main to its beta (that publishes it),
 * then the source's main to the playtested beta commit (it publishes nothing; a failure there is reported, not fatal).
 * Beta must not have moved since the plan: both are read again first.
 */
export async function cloudGoLiveNow(p: Product, plan: { beta: { sha: string; short: string } | null; site: { beta: string | null } }, f: Fetch = fetch, token = process.env.GITHUB_TOKEN) {
  const refs = await cloudRefs(p, f, token);
  if (!plan.beta || refs.source.beta?.sha !== plan.beta.sha) throw new Error(`${BETA} moved since the plan was made; look at the plan again.`);
  if (!refs.site.beta || (plan.site.beta && refs.site.beta.sha !== plan.site.beta)) throw new Error(`${p.site}'s ${BETA} moved since the plan was made; look at the plan again.`);
  const log: string[] = [];
  const before = refs.site.main?.sha ?? null;
  const after = refs.site.beta.sha;
  if (before !== after) {
    await fastForward(refs.siteSlug, MAIN, after, f, token);
    log.push(`${p.site}: ${MAIN} -> ${after.slice(0, 7)}${refs.site.ahead.length ? ` (${refs.site.ahead.length} commit(s) from ${BETA}, the build's loader among them)` : ''}`);
  } else log.push(`${p.site}: the build is already live`);
  let sourceAfter: string | null = null;
  if (refs.source.ahead.length) {
    try {
      await fastForward(refs.sourceSlug, MAIN, plan.beta.sha, f, token);
      sourceAfter = plan.beta.sha;
      log.push(`${p.repo.split('/')[0]}: ${MAIN} -> ${plan.beta.short}`);
    } catch (e: any) {
      log.push(`warning: ${p.repo.split('/')[0]}'s ${MAIN} wasn't fast-forwarded: ${e.message}`);
    }
  }
  log.push(`no release entry this time (going live through GitHub has no website copy to write it in)`);
  return { before, after, sourceBefore: refs.source.main?.sha ?? null, sourceAfter, log };
}
