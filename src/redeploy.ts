// "Redeploy beta" on the Go live page (2026-11-02, Jaycee: a playtest that fails because the beta site doesn't answer
// "would turn a customer away. Fix this the right way or at least provide options"). A project whose beta is deployed by
// its own GitHub Actions (local.serve "remote": Studio's own beta on Cloud Run, a Firebase site) is redeployed by running
// again the workflow run that deployed beta's commit. Nothing goes live: it only touches the beta branch's own run.
// When Studio's token may not start runs (its GitHub App reads Actions only), it says so with the link to press Re-run.

import { getProduct, type Product } from './config.ts';
import { repoToken } from './ghtoken.ts';

const BETA = 'beta';

/** The repo whose Actions deploy a project's beta: its site's repo, else its source repo. */
export function betaRepoOf(p: Product): string | null {
  const slug = (s: unknown) => (typeof s === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s) ? s : null);
  return slug((p as any).github) ?? slug(p.site) ?? slug(p.repo);
}

/** Where a person sees beta's deploy runs on GitHub. */
export const betaRunsUrl = (slug: string) => `https://github.com/${slug}/actions?query=branch%3A${BETA}`;

/** The run to redeploy from a page of runs: the newest push to beta on beta's head, else the newest run on beta. */
export function pickRun(runs: any[], head: string | null): any | null {
  const onBeta = runs.filter((r) => r?.head_branch === BETA);
  const deploys = onBeta.filter((r) => /deploy/i.test(`${r.name ?? ''} ${r.path ?? ''} ${r.display_title ?? ''}`));
  const pool = deploys.length ? deploys : onBeta;
  return pool.find((r) => head && r.head_sha === head) ?? pool[0] ?? null;
}

type Fetch = typeof fetch;

/** Runs beta's deploy again. Returns a plain sentence either way, and the link to the run. */
export async function redeployBeta(productId: string, { fetchImpl = fetch as Fetch, token: given }: { fetchImpl?: Fetch; token?: string | null } = {}) {
  const p = getProduct(productId);
  const slug = betaRepoOf(p);
  if (!slug) return { ok: false, note: `${p.name} has no GitHub repository Studio knows, so its beta can't be redeployed from here.` };
  const token = given !== undefined ? given : await repoToken(slug);
  const runsLink = betaRunsUrl(slug);
  if (!token) return { ok: false, link: runsLink, note: `Studio has no GitHub access to ${slug}: open its beta runs and press Re-run on the newest one.` };
  const api = (route: string, init: RequestInit = {}) =>
    fetchImpl(`https://api.github.com/repos/${slug}/${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const head = await api(`branches/${BETA}`).then((r) => (r.ok ? r.json() : null)).then((b: any) => b?.commit?.sha ?? null).catch(() => null);
  const list: any = await api(`actions/runs?branch=${BETA}&per_page=30`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const run = pickRun(list?.workflow_runs ?? [], head);
  if (!run) return { ok: false, link: runsLink, note: `No deploy run of ${slug}'s beta was found: push to beta (or merge a change into it) to deploy it.` };
  const link = run.html_url ?? runsLink;
  if (run.status && run.status !== 'completed') return { ok: true, run: run.id, link, note: `Beta's deploy is already running (${run.name ?? 'run'} on ${String(run.head_sha).slice(0, 7)}): retry the playtest once it's done.` };
  const r = await api(`actions/runs/${run.id}/${run.conclusion === 'failure' ? 'rerun-failed-jobs' : 'rerun'}`, { method: 'POST', body: '{}' }).catch((e: any) => ({ ok: false, status: 0, e }) as any);
  if (r.ok) return { ok: true, run: run.id, link, note: `Redeploying beta: ${run.name ?? 'its deploy'} on ${String(run.head_sha).slice(0, 7)} runs again. Nothing goes live. Retry the playtest when it's done.` };
  if (r.status === 403 || r.status === 404)
    return { ok: false, run: run.id, link, note: `Studio may read ${slug}'s Actions but not start them: open beta's deploy run and press Re-run all jobs, then retry the playtest.` };
  return { ok: false, run: run.id, link, note: `GitHub didn't start beta's deploy again (HTTP ${r.status}): open the run and press Re-run.` };
}

/** True when a playtest's line says the deployed beta didn't answer (local.ts remoteDownLine, and the older wording). */
export const betaDownLine = (detail: unknown) => /beta \(\S+\) (didn't answer|isn't answering)/.test(String(detail ?? ''));
