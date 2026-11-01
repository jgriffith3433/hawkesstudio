// Going live with no bypass list (J, 2026-11-01: "I don't want the customer to have to do any manual action").
// The owner's Go live tap is the whole approval. When a repo's rules don't let this Studio's GitHub App move main
// directly, Studio opens a pull request from the exact commit, waits for main's required checks, and merges it itself.
//   - rulesShape: what a branch's rules (GET rules/branches/<b>) mean for that: which checks to wait for, and what
//     stops an app from merging a pull request on its own (a restrict-updates rule, a required reviewer, linear
//     history, a merge queue, required deployments);
//   - moveLive: the direct fast-forward first (no rules, or the app is allowed), else the pull request;
//   - rulesFix / applyRulesFix: the one-time setup step (repokit.ts step "rules", an Approve card at onboarding) that
//     brings main's rules into a shape Studio can go live through: main still only moves through pull requests that
//     pass its checks, can't be deleted or rewritten, and keeps its bypass list as it is; the pull requests need no
//     reviewer, because the owner's tap in Studio is the review.

import { StudioError } from './config.ts';

type Fetch = typeof fetch;
export type Rule = { type: string; parameters?: Record<string, any> | null; ruleset_id?: number };
export type Api = (method: string, url: string, body?: unknown) => Promise<{ ok: boolean; status: number; j: any }>;

/** The title prefix of the merge commits a go live through a pull request leaves on main (deploy.ts ignores them). */
export const STUDIO_GOLIVE = 'Studio go live:';

const base = () => (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
export function apiOf(f: Fetch, token: string | null | undefined): Api {
  return async (method, url, body) => {
    const r = await f(`${base()}${url}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hawkes-studio', ...(token ? { Authorization: `token ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    return { ok: r.ok, status: r.status, j };
  };
}

export type RulesShape = {
  /** No rule stops a direct ref update (only then can Studio fast-forward without a pull request). */
  direct: boolean;
  /** Studio can go live on its own through a pull request (blockers is empty). */
  viaPr: boolean;
  /** The required status checks to wait for. */
  checks: string[];
  /** In plain words, what stops an app from merging a pull request into the branch by itself. */
  blockers: string[];
};

/** What a branch's rules mean for going live with no manual step. Pure. */
export function rulesShape(rules: Rule[]): RulesShape {
  const blockers: string[] = [];
  const checks: string[] = [];
  let direct = true;
  for (const r of rules ?? []) {
    const p = r.parameters ?? {};
    switch (r.type) {
      case 'update':
        direct = false;
        blockers.push('a rule restricts updates to it, so only people on its bypass list can change it, even through a pull request');
        break;
      case 'pull_request': {
        direct = false;
        const n = Number(p.required_approving_review_count ?? 0);
        if (n > 0) blockers.push(`pull requests into it need ${n} approving review${n > 1 ? 's' : ''}, and an app can't approve its own`);
        if (p.require_code_owner_review) blockers.push('pull requests into it need a code owner to review them');
        if (p.require_last_push_approval && n > 0) blockers.push('the last push to a pull request must be approved by someone else');
        if (Array.isArray(p.allowed_merge_methods) && !p.allowed_merge_methods.includes('merge')) blockers.push(`pull requests into it can only be merged by ${p.allowed_merge_methods.join(' or ')}, so the playtested commits wouldn't be the ones that go live`);
        break;
      }
      case 'required_status_checks':
        direct = false;
        for (const c of (p.required_status_checks ?? []) as { context?: string }[]) if (c?.context && !checks.includes(c.context)) checks.push(c.context);
        break;
      case 'required_linear_history':
        direct = false;
        blockers.push('it needs a linear history, so a go live can\'t keep the playtested commits as they are');
        break;
      case 'merge_queue':
        direct = false;
        blockers.push('pull requests into it go through a merge queue');
        break;
      case 'required_deployments':
        direct = false;
        blockers.push(`it needs deployments to ${((p.required_deployment_environments ?? []) as string[]).join(', ') || 'an environment'} to succeed first`);
        break;
      default:
        // deletion, non_fast_forward, creation, required_signatures (GitHub signs the merges it makes), commit message
        // patterns: none of them stop a pull request merged by GitHub.
        break;
    }
  }
  return { direct, viaPr: blockers.length === 0, checks, blockers };
}

/** A branch's rules, or null when GitHub won't say (then a pull request is tried anyway). */
export async function branchRules(api: Api, slug: string, branch: string): Promise<Rule[] | null> {
  const r = await api('GET', `/repos/${slug}/rules/branches/${encodeURIComponent(branch)}`);
  return r.ok && Array.isArray(r.j) ? (r.j as Rule[]) : null;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type MoveOptions = {
  api: Api;
  /** The direct fast-forward (deploy-cloud.ts fastForward); its errors carry `rules` or `diverged`. */
  direct: () => Promise<void>;
  /** live: a merge commit (the playtested commits stay as they are); rollback: one squashed commit with this title. */
  kind: 'live' | 'rollback';
  title: string;
  body?: string;
  /** Go through a pull request also when main merely isn't an ancestor (it only has Studio's go live merges). */
  ifDiverged?: 'pr' | 'fail';
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** Moves `branch` of `slug` to `sha`: directly when GitHub allows it, else through a pull request Studio merges itself. */
export async function moveLive(slug: string, branch: string, sha: string, o: MoveOptions): Promise<{ how: 'direct' | 'pr'; sha: string; pr?: number }> {
  try {
    await o.direct();
    return { how: 'direct', sha };
  } catch (e: any) {
    if (!e?.rules && !(e?.diverged && o.ifDiverged === 'pr')) throw e;
  }
  const { api } = o;
  const short = sha.slice(0, 7);
  const rules = await branchRules(api, slug, branch);
  const shape = rulesShape(rules ?? []);
  if (!shape.viaPr) {
    throw new StudioError(`${slug}'s ${branch} can't go live from Studio on its own yet: ${shape.blockers.join('; ')}. Approve "Let Studio go live" in the project's Get it ready (one card, once), then go live again. Nothing moved.`, 409);
  }
  // A branch of Studio's own at the exact commit, so beta moving meanwhile changes nothing.
  const head = `studio/${o.kind === 'rollback' ? 'rollback' : 'go-live'}-${short}`;
  const made = await api('POST', `/repos/${slug}/git/refs`, { ref: `refs/heads/${head}`, sha });
  if (!made.ok) {
    const moved = made.status === 422 ? await api('PATCH', `/repos/${slug}/git/refs/heads/${head}`, { sha, force: true }) : made;
    if (!moved.ok) throw new StudioError(`GitHub refused making the go live branch ${head} in ${slug} (${moved.status}${moved.j?.message ? `: ${moved.j.message}` : ''})`, 409);
  }
  const owner = slug.split('/')[0];
  const open = await api('GET', `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(branch)}`);
  let pr = open.ok && Array.isArray(open.j) && open.j[0] ? open.j[0] : null;
  if (!pr) {
    const c = await api('POST', `/repos/${slug}/pulls`, { title: o.title, head, base: branch, body: o.body ?? 'Opened by Hawkes Studio for a go live the owner approved. Studio merges it once the required checks pass.' });
    if (!c.ok) {
      if (/no commits between/i.test(String(c.j?.message ?? JSON.stringify(c.j?.errors ?? '')))) { await api('DELETE', `/repos/${slug}/git/refs/heads/${head}`); return { how: 'pr', sha }; }
      throw new StudioError(`GitHub refused opening the go live pull request in ${slug} (${c.status}${c.j?.message ? `: ${c.j.message}` : ''})`, 409);
    }
    pr = c.j;
  }
  const n = Number(pr.number);
  o.log?.(`${slug}: pull request #${n} into ${branch} (${short}); waiting for ${shape.checks.length ? shape.checks.join(', ') : "GitHub's checks"}`);
  const sleep = o.sleep ?? sleepDefault;
  const deadline = Date.now() + (o.waitMs ?? 30 * 60_000);
  const merge = o.kind === 'rollback'
    ? { merge_method: 'squash', sha, commit_title: o.title, commit_message: o.body ?? '' }
    : { merge_method: 'merge', sha, commit_title: o.title, commit_message: o.body ?? '' };
  for (;;) {
    const failed = await failedChecks(api, slug, sha, shape.checks);
    if (failed.length) throw new StudioError(`${slug}'s go live pull request #${n} failed its required check${failed.length > 1 ? 's' : ''} (${failed.join(', ')}), so ${branch} wasn't moved. Fix ${failed.length > 1 ? 'them' : 'it'} on beta and go live again.`, 409);
    const m = await api('PUT', `/repos/${slug}/pulls/${n}/merge`, merge);
    if (m.ok) {
      await api('DELETE', `/repos/${slug}/git/refs/heads/${head}`).catch(() => null);
      const after = String(m.j?.sha ?? '');
      o.log?.(`${slug}: merged #${n} into ${branch} (${after.slice(0, 7)})`);
      return { how: 'pr', sha: after || sha, pr: n };
    }
    const why = String(m.j?.message ?? '');
    const waitable = (m.status === 405 || m.status === 409) && /status check|expected|pending|in progress|not mergeable|base branch was modified|mergeable/i.test(why);
    if (!waitable) throw new StudioError(`GitHub refused merging the go live pull request #${n} in ${slug} (${m.status}${why ? `: ${why}` : ''}); ${branch} wasn't moved.`, 409);
    if (Date.now() >= deadline) throw new StudioError(`${slug}'s go live pull request #${n} is still waiting (${why || 'checks'}) after ${Math.round((o.waitMs ?? 30 * 60_000) / 60_000)} minutes; ${branch} wasn't moved. Go live again once its checks have run.`, 409);
    await sleep(o.pollMs ?? 15_000);
  }
}

/** The required checks on `sha` that finished and didn't pass (check runs and commit statuses). */
async function failedChecks(api: Api, slug: string, sha: string, required: string[]): Promise<string[]> {
  if (!required.length) return [];
  const [runs, status] = await Promise.all([api('GET', `/repos/${slug}/commits/${sha}/check-runs?per_page=100`), api('GET', `/repos/${slug}/commits/${sha}/status`)]);
  const bad = new Set<string>();
  for (const r of (runs.ok ? runs.j?.check_runs ?? [] : []) as any[]) if (required.includes(r.name) && r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion)) bad.add(r.name);
  for (const s of (status.ok ? status.j?.statuses ?? [] : []) as any[]) if (required.includes(s.context) && ['failure', 'error'].includes(s.state)) bad.add(s.context);
  return [...bad];
}

// ------------------------------------------------------------------ the one-time setup step

/** A pull request rule that needs no reviewer: the owner's Go live tap in Studio is the review. */
export const NO_REVIEW_PR = { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['merge', 'squash', 'rebase'] };

/** One ruleset's rules brought into a shape Studio can go live through (null: nothing to change). Pure. */
export function fixRules(rules: Rule[]): Rule[] | null {
  let changed = false;
  let hasPr = false;
  const out: Rule[] = [];
  for (const r of rules) {
    if (r.type === 'update' || r.type === 'required_linear_history' || r.type === 'merge_queue' || r.type === 'required_deployments') { changed = true; continue; }
    if (r.type === 'pull_request') {
      hasPr = true;
      const p = r.parameters ?? {};
      const methods = Array.isArray(p.allowed_merge_methods) ? p.allowed_merge_methods : null;
      const next = { ...NO_REVIEW_PR, ...p, required_approving_review_count: 0, require_code_owner_review: false, require_last_push_approval: false, ...(methods && !methods.includes('merge') ? { allowed_merge_methods: [...methods, 'merge'] } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(p)) changed = true;
      out.push({ type: 'pull_request', parameters: next });
      continue;
    }
    out.push({ type: r.type, ...(r.parameters ? { parameters: r.parameters } : {}) });
  }
  // A restrict-updates rule removed: main still only moves through pull requests.
  if (changed && !hasPr && rules.some((r) => r.type === 'update')) out.push({ type: 'pull_request', parameters: { ...NO_REVIEW_PR } });
  return changed ? out : null;
}

export type RulesFix = { slug: string; branch: string; rulesets: { id: number; name: string; rules: Rule[] }[]; cannot: string[] };

/** The changes the setup step would make to the rulesets on `branch` (what the card shows). */
export async function rulesFix(api: Api, slug: string, branch: string): Promise<RulesFix> {
  const rules = (await branchRules(api, slug, branch)) ?? [];
  const ids = [...new Set(rules.map((r) => r.ruleset_id).filter((x): x is number => typeof x === 'number'))];
  const out: RulesFix = { slug, branch, rulesets: [], cannot: [] };
  for (const id of ids) {
    const rs = await api('GET', `/repos/${slug}/rulesets/${id}`);
    if (!rs.ok) { out.cannot.push(`Studio can't read ruleset ${id} on ${slug} (${rs.status}).`); continue; }
    if (rs.j.source_type && rs.j.source_type !== 'Repository') {
      if (!rulesShape(rs.j.rules ?? []).viaPr) out.cannot.push(`The ruleset "${rs.j.name}" belongs to the ${String(rs.j.source_type).toLowerCase()} ${rs.j.source}, not the repository: an owner there changes it.`);
      continue;
    }
    const next = fixRules((rs.j.rules ?? []) as Rule[]);
    if (next) out.rulesets.push({ id, name: String(rs.j.name), rules: next });
  }
  return out;
}

/** Plain words for the card: what changes, and what stays. */
export function describeRulesFix(fix: RulesFix) {
  return [
    `${fix.slug}'s ${fix.branch} keeps only moving through pull requests that pass its checks, and still can't be deleted or rewritten. Its bypass list stays as it is.`,
    'Those pull requests need no reviewer: your Go live tap in Studio is the review, and Studio merges them itself.',
    ...fix.rulesets.map((r) => `Ruleset "${r.name}" becomes: ${r.rules.map((x) => x.type).join(', ')}.`),
  ];
}

/** Applies the setup step (only after the owner's tap on the card). */
export async function applyRulesFix(api: Api, fix: RulesFix): Promise<string> {
  if (fix.cannot.length && !fix.rulesets.length) throw new StudioError(fix.cannot.join(' '), 409);
  const done: string[] = [];
  for (const r of fix.rulesets) {
    const put = await api('PUT', `/repos/${fix.slug}/rulesets/${r.id}`, { rules: r.rules });
    if (!put.ok) throw new StudioError(`GitHub refused changing the ruleset "${r.name}" on ${fix.slug} (${put.status}${put.j?.message ? `: ${put.j.message}` : ''}): the GitHub App needs the Administration permission there.`, 409);
    done.push(r.name);
  }
  return `${fix.slug}'s ${fix.branch} now goes live from Studio on its own${done.length ? ` (changed: ${done.join(', ')})` : ''}.${fix.cannot.length ? ` ${fix.cannot.join(' ')}` : ''}`;
}
