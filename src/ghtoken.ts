// The GitHub token for one repository (J, 2026-10-30: GitHub for customers' games). J's own repos keep his token
// (GITHUB_TOKEN); every other repo gets what github-app.ts accessFor finds (the GitHub App's installation, a pasted
// token), and a customer's Studio asks the control plane (cellside.ts cellGithubToken), never J's token. Tokens are kept
// a little under their life, so the synchronous paths (starting an agent's job, a git command) can use one that an
// async step fetched first (primeRepoToken, called by repos.ts before a clone or fetch and by agents before a job).

import path from 'node:path';
import { customerStudio, PLATFORM_GITHUB } from './tenancy.ts';

const cache = new Map<string, { token: string | null; until: number }>();
const TTL = 40 * 60_000;

const platformRepo = (slug: string) => slug.split('/')[0].toLowerCase() === PLATFORM_GITHUB;

/** owner/name from an API route (/repos/<owner>/<name>/...), or null. */
export const slugOfRoute = (route: string) => /^\/repos\/([^/]+\/[^/?#]+)/.exec(route)?.[1] ?? null;

/** The token for a repo now (null: none Studio may use). */
export async function repoToken(slug: string | null | undefined): Promise<string | null> {
  if (!slug) return null;
  const key = slug.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  let token: string | null = null;
  if (!customerStudio() && platformRepo(slug)) token = process.env.GITHUB_TOKEN ?? null;
  else {
    try {
      token = (await (await import('./github-app.ts')).accessFor(slug))?.token ?? null;
      if (!token && customerStudio()) token = await (await import('./cellside.ts')).cellGithubToken(slug).catch(() => null);
    } catch { token = null; }
    // J's Studio: a repo of someone else's that J's token can still reach (a collaborator), as before.
    if (!token && !customerStudio()) token = process.env.GITHUB_TOKEN ?? null;
  }
  cache.set(key, { token, until: Date.now() + TTL });
  return token;
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
  if (!slug || (!customerStudio() && platformRepo(slug))) return {};
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
