// GitHub for agents and Talk (J, 2026-11-02: "just make it so agents can use the mcp server and github and everything"):
// the studio_github_api tool sends one GitHub REST call through Studio, which adds the Studio's own token for that one
// repo. The agent never holds a GitHub credential.
//
// What it may reach: only the repositories of this Studio's own projects (a customer's cell: its org's, through the
// control plane), so it never crosses Studios. What it may do there:
//   - read anything (GET)
//   - issues and their comments and labels; pull requests (open, edit, comment, review with comments); workflow runs
//     (dispatch, re-run, cancel); branches of its own (claude/*, agent/*): create, move, delete; files on those branches
// What stays with Studio's gates, never here: merging a pull request, approving one, pushing to any other branch (main,
// beta, dev), releases and tags, settings, secrets, webhooks, collaborators, branch protection and deleting anything
// else. Going live is Studio's go live, as before.

import { StudioError, loadProducts } from './config.ts';

export type GhCall = { method?: string; path: string; body?: unknown; query?: Record<string, unknown> };

const OWN_BRANCH = /^(claude|agent)\/[\w./-]{1,200}$/;
const has = (s: string, re: RegExp) => re.test(s);

/** owner/name of a /repos/{owner}/{repo}/... path, and the rest after it. */
export function repoOfPath(p: string): { slug: string; rest: string } | null {
  const m = /^\/repos\/([\w.-]+)\/([\w.-]+)(\/.*)?$/.exec(p);
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return { slug: `${m[1]}/${m[2]}`, rest: m[3] ?? '' };
}

/**
 * Why this call is refused, or null when it may go. `rest` is the path after /repos/{owner}/{repo}; body is the call's
 * JSON body. Pure, so the rules read in one place (test/agent-github.test.ts).
 */
export function githubRefusal(method: string, rest: string, body: any): string | null {
  const m = method.toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) return `method ${method}: GET, POST, PATCH, PUT or DELETE`;
  if (/\.\.|%2e|%2f/i.test(rest)) return 'path: no dot segments or encoded slashes';
  if (m === 'GET') return /^\/(actions\/secrets|actions\/variables|environments\/[^/]+\/secrets|dependabot\/secrets|codespaces\/secrets|keys|hooks)/.test(rest) ? 'secrets, keys and webhooks are the owner\'s, in GitHub' : null;
  // Merging and approving: Studio's gates (beta auto-merges on green; main is Studio's go live).
  if (has(rest, /^\/pulls\/\d+\/merge$/) || has(rest, /^\/merges$/)) return 'Merging is Studio\'s: a pull request into beta merges by itself on green, and main goes live through Studio\'s go live.';
  if (has(rest, /^\/pulls\/\d+\/reviews/) && String(body?.event ?? '').toUpperCase() === 'APPROVE') return 'Approving a pull request is a person\'s.';
  // Issues: open, edit, close, comment, label.
  if (has(rest, /^\/issues(\/\d+(\/(comments|labels(\/[^/]+)?|assignees|reactions))?)?$/) && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) {
    if (m === 'DELETE' && !has(rest, /\/(labels\/[^/]+|assignees|reactions)$/)) return 'Deleting issues is the owner\'s.';
    return null;
  }
  if (has(rest, /^\/issues\/comments\/\d+(\/reactions)?$/) && ['PATCH', 'POST'].includes(m)) return null;
  if (has(rest, /^\/labels(\/[^/]+)?$/) && ['POST', 'PATCH'].includes(m)) return null;
  // Pull requests: open (into any branch: merging stays gated), edit, comment, review with comments, ask reviewers.
  if (rest === '/pulls' && m === 'POST') return OWN_BRANCH.test(String(body?.head ?? '').replace(/^[\w.-]+:/, '')) ? null : 'head: a branch of your own (claude/... or agent/...)';
  if (has(rest, /^\/pulls\/\d+$/) && m === 'PATCH') return null;
  if (has(rest, /^\/pulls\/\d+\/(comments|reviews|requested_reviewers)$/) && ['POST', 'DELETE'].includes(m)) return m === 'DELETE' && !rest.endsWith('requested_reviewers') ? 'Deleting reviews is a person\'s.' : null;
  if (has(rest, /^\/pulls\/\d+\/comments\/\d+\/replies$/) && m === 'POST') return null;
  if (has(rest, /^\/pulls\/comments\/\d+$/) && m === 'PATCH') return null;
  // Workflow runs: start one, run one again, cancel one. Not their settings.
  if (has(rest, /^\/actions\/workflows\/[\w.-]+\/dispatches$/) && m === 'POST') return null;
  if (has(rest, /^\/actions\/runs\/\d+\/(rerun|rerun-failed-jobs|cancel)$/) && m === 'POST') return null;
  if (has(rest, /^\/actions\/jobs\/\d+\/rerun$/) && m === 'POST') return null;
  // Branches of its own: make, move, delete.
  if (rest === '/git/refs' && m === 'POST') return OWN_BRANCH.test(String(body?.ref ?? '').replace(/^refs\/heads\//, '')) && String(body?.ref ?? '').startsWith('refs/heads/') ? null : 'ref: refs/heads/claude/... or refs/heads/agent/... (other branches are pushed by Studio)';
  const ref = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
  if (ref && ['PATCH', 'DELETE'].includes(m)) return OWN_BRANCH.test(decodeURIComponent(ref[1])) ? null : 'Only branches of your own (claude/..., agent/...) are moved or deleted here.';
  // Git objects (blobs, trees, commits) change no branch by themselves.
  if (has(rest, /^\/git\/(blobs|trees|commits)$/) && m === 'POST') return null;
  // Files, on branches of its own only.
  if (has(rest, /^\/contents\/.+/) && ['PUT', 'DELETE'].includes(m)) return OWN_BRANCH.test(String(body?.branch ?? '')) ? null : 'branch: a branch of your own (claude/... or agent/...): main, beta and dev change through Studio';
  return 'Studio keeps this GitHub step for the owner or its own gates (settings, releases, protection, secrets, deletes, merges).';
}

/** The repositories this Studio's projects use (lower case owner/name). */
export async function studioRepos(): Promise<Set<string>> {
  const { productSlugs } = await import('./repos.ts');
  const out = new Set<string>();
  for (const p of loadProducts()) if (!(p as any).managedBy) for (const s of productSlugs(p as any)) out.add(s.toLowerCase());
  return out;
}

/**
 * One GitHub call for an agent or Talk. Only /repos/{owner}/{repo}/... of this Studio's own projects (and the GitHub
 * search API, scoped to them), with the Studio's token for that repo.
 */
export async function agentGithub(call: GhCall, deps: { repos?: () => Promise<Set<string>>; token?: (slug: string) => Promise<string | null>; fetcher?: typeof fetch } = {}) {
  const method = String(call.method ?? 'GET').toUpperCase();
  const raw = String(call.path ?? '').trim();
  const p = raw.replace(/^https:\/\/api\.github\.com/, '').split('?')[0];
  if (!p.startsWith('/')) throw new StudioError('path: a GitHub REST path, like /repos/owner/name/issues', 400);
  const repos = await (deps.repos ?? studioRepos)();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined && v !== null) qs.set(k, String(v));
  for (const [k, v] of new URLSearchParams(raw.split('?')[1] ?? '')) if (!qs.has(k)) qs.set(k, v);
  let slug: string;
  if (/^\/search\/(issues|code|commits)$/.test(p) && method === 'GET') {
    // Search, inside this Studio's repos: each repo: in the query must be one of them; none given means all of them.
    const q = String(qs.get('q') ?? '');
    const named = [...q.matchAll(/\brepo:([\w.-]+\/[\w.-]+)/g)].map((x) => x[1].toLowerCase());
    if (/\b(org|user):/.test(q)) throw new StudioError('search: name repos with repo:owner/name (this Studio\'s own), not org: or user:', 400);
    const scope = named.length ? named : [...repos].slice(0, 20);
    if (!scope.length || scope.some((r) => !repos.has(r))) throw new StudioError('search: only this Studio\'s own repos', 403);
    if (!named.length) qs.set('q', `${q} ${scope.map((r) => `repo:${r}`).join(' ')}`.trim());
    slug = scope[0];
  } else {
    const r = repoOfPath(p);
    if (!r) throw new StudioError('path: /repos/{owner}/{repo}/... (one of this Studio\'s repos), or /search/issues|code|commits', 400);
    if (!repos.has(r.slug.toLowerCase())) throw new StudioError(`${r.slug} isn't one of this Studio's projects' repositories.`, 403);
    const no = githubRefusal(method, r.rest, call.body);
    if (no) throw new StudioError(no, 403);
    slug = r.slug;
  }
  const token = await (deps.token ?? (async (s: string) => (await import('./ghtoken.ts')).repoToken(s)))(slug);
  if (!token) throw new StudioError(`Studio has no GitHub access to ${slug} (install its GitHub app on it: studio_github status).`, 409);
  const url = `https://api.github.com${p}${qs.size ? `?${qs}` : ''}`;
  const r = await (deps.fetcher ?? fetch)(url, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hawkes-studio', ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: call.body !== undefined && method !== 'GET' ? JSON.stringify(call.body) : undefined,
  });
  const text = await r.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* a log or a diff */ }
  if (typeof data === 'string' && data.length > 200_000) data = `${data.slice(0, 200_000)}\n[cut at 200 KB]`;
  return { status: r.status, ok: r.ok, data, repo: slug, ...(r.headers.get('link') ? { link: r.headers.get('link') } : {}) };
}
