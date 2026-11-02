// The GitHub token for one repository (J, 2026-10-30: GitHub for customers' games). J's own repos keep his token
// (GITHUB_TOKEN); every other repo gets what github-app.ts accessFor finds (the GitHub App's installation, a pasted
// token), and a customer's Studio asks the control plane (cellside.ts cellGithubToken), never J's token. Tokens are kept
// a little under their life, so the synchronous paths (starting an agent's job, a git command) can use one that an
// async step fetched first (primeRepoToken, called by repos.ts before a clone or fetch and by agents before a job).

import path from 'node:path';
import { customerStudio, PLATFORM_GITHUB } from './tenancy.ts';

const cache = new Map<string, { token: string | null; until: number }>();
const TTL = 4 * 60_000;

const platformRepo = (slug: string) => slug.split('/')[0].toLowerCase() === PLATFORM_GITHUB;

/**
 * Whether this Studio can reach GitHub for the loops that start or sync agents (the PM's starts, the daily run's
 * auto-fix, merges done on GitHub). J's Studio has GITHUB_TOKEN; a customer's Studio (an org cell) never does and gets
 * each repo's token from the control plane instead (repoToken). Gating on GITHUB_TOKEN alone meant walk-away never
 * started a bug in an org cell (2026-11-01: 9 open bugs, 2 free slots, nothing started all day).
 */
export const githubReachable = () => Boolean(process.env.GITHUB_TOKEN) || customerStudio();

/** owner/name from an API route (/repos/<owner>/<name>/...), or null. */
export const slugOfRoute = (route: string) => /^\/repos\/([^/]+\/[^/?#]+)/.exec(route)?.[1] ?? null;

/** owner/name from a GitHub clone address (https://github.com/<owner>/<name>(.git), git@github.com:...), or null. */
export const slugOfRemote = (url: string | null | undefined) =>
  /^(?:https?:\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim())?.[1] ?? null;

/** The token for a repo now (null: none Studio may use). */
export async function repoToken(slug: string | null | undefined): Promise<string | null> {
  if (!slug) return null;
  const key = slug.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  let token: string | null = null;
  // J's repos use his token when the service has one; without it they go through the GitHub App like anyone's.
  if (!customerStudio() && platformRepo(slug) && process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN;
  else {
    try {
      token = (await (await import('./github-app.ts')).accessFor(slug))?.token ?? null;
      if (!token && customerStudio()) token = await (await import('./cellside.ts')).cellGithubToken(slug).catch(() => null);
    } catch { token = null; }
    // J's Studio: a repo of someone else's that J's token can still reach (a collaborator), as before.
    if (!token && !customerStudio()) token = process.env.GITHUB_TOKEN ?? null;
  }
  // Short: the caches behind accessFor and cellGithubToken hand back a token with as little as 5 minutes left, and a
  // miss (the app not installed yet) must clear soon after the person installs it.
  cache.set(key, { token, until: Date.now() + (token ? TTL : 60_000) });
  return token;
}

/**
 * The token a Cloud Run job clones its repo with: this Studio's app's token for that one repo, read-only
 * (github-app.ts repoJobToken), else the repo's token as above (a customer's Studio: the control plane's, scoped to it).
 */
export async function jobRepoToken(slug: string | null | undefined): Promise<string | null> {
  if (!slug) return null;
  try {
    const t = await (await import('./github-app.ts')).repoJobToken(slug);
    if (t) return t;
  } catch { /* GitHub unreachable or the app's key unusable: the repo's token */ }
  return repoToken(slug);
}

/**
 * A read-only token for one repo, or null: an agent's read-only copy of another of the Studio's projects (access.ts).
 * Only tokens that are read-only and scoped to that repo: this Studio's app's, or in a customer's Studio the control
 * plane's (cellside.ts read); never J's own token or one with the installation's write permissions.
 */
export async function readRepoToken(slug: string | null | undefined): Promise<string | null> {
  if (!slug) return null;
  try {
    const t = await (await import('./github-app.ts')).repoJobToken(slug, { strict: true });
    if (t) return t;
  } catch { /* the cell's way, below */ }
  if (!customerStudio()) return null;
  return (await import('./cellside.ts')).cellGithubToken(slug, { read: true }).catch(() => null);
}

/** Fetches and keeps a repo's token, so repoTokenNow can give it to a synchronous caller. */
export const primeRepoToken = (slug: string | null | undefined) => repoToken(slug).catch(() => null);

/** The kept token (after primeRepoToken), else J's token in his Studio, else null. */
export function repoTokenNow(slug: string | null | undefined): string | null {
  const hit = slug ? cache.get(slug.toLowerCase()) : null;
  if (hit && hit.until > Date.now()) return hit.token;
  return customerStudio() ? null : process.env.GITHUB_TOKEN ?? null;
}

/** The repo a folder under PROJECTS belongs to (repos.ts repoMap: top-level folder -> owner/name). */
export async function slugOfPath(dir: string, projects: string): Promise<string | null> {
  const rel = path.relative(projects, dir).split(/[\\/]/)[0];
  if (!rel || rel.startsWith('..')) return null;
  const { repoMap } = await import('./repos.ts');
  return repoMap()[rel] ?? null;
}

/**
 * Environment that gives one git command the token as a header (GIT_CONFIG_* : never written into the clone's config or
 * its remote address), for repos that aren't J's (his go through the credential helper as before). {} when none.
 */
export function gitAuthEnv(slug: string | null | undefined): Record<string, string> {
  if (!slug || (!customerStudio() && platformRepo(slug) && process.env.GITHUB_TOKEN)) return {};
  const token = repoTokenNow(slug);
  if (!token) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

/** Forgets kept tokens (tests; a disconnected app). */
export const forgetRepoTokens = () => cache.clear();

/**
 * fetch with a repo's own token on GitHub's hosts (its API and codeload): a customer's Studio has no GITHUB_TOKEN, so
 * listing or downloading a private repo, or more than GitHub's anonymous 60 calls an hour, needs the repo's token.
 * Redirects to storage elsewhere (an artifact's zip) don't carry it (fetch drops Authorization across origins).
 */
export function githubFetch(token: string | null, fetcher: typeof fetch = fetch): typeof fetch {
  if (!token) return fetcher;
  return ((url: any, init: any = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (/^https:\/\/(api\.github\.com|codeload\.github\.com)\//.test(String(url))) headers.set('Authorization', `Bearer ${token}`);
    return fetcher(url, { ...init, headers });
  }) as typeof fetch;
}
