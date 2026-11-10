// Going live and rolling back for any project with a GitHub repo, in any Studio (customers' included; J, 2026-10-31),
// through GitHub's API with each repo's own token (ghtoken.ts): no clones, nothing assumed about J's repos.
//   - the plan (deploy.ts githubPlan): the commits on beta that main lacks (compare API), the played beta commit's
//     playtests (deploy.ts testedAt, keyed on project + sha), blockers;
//   - going live: main fast-forwarded to that exact beta commit (PATCH git/refs, force: false), or, when the repo's rules
//     don't let this Studio's app move main, a pull request from that commit merged by the app once main's checks pass
//     (golive-pr.ts: no bypass list, the owner's tap is the whole approval); and for each build with
//     `publish.commit` (builds.ts commitInto put it on the target repo's beta) that repo's main fast-forwarded to the
//     beta commit holding that build;
//   - rollback: a new commit on main with the tree of the commit live before (git data API: the old tree, the current
//     main as parent), never a force push. J's Unity games on Cloud Run roll their website back the same way.
// deploy.ts does the checks, the owner's typed words or Approve tap, the deploys rows and the live check.

import { BETA, MAIN, STUDIO_ROLLBACK, type Commit } from './beta.ts';
import { gh, commitOf, fastForward, liveBranchOf } from './deploy-cloud.ts';
import { getProduct, StudioError, type Product } from './config.ts';
import { db } from './db.ts';
import { apiOf, moveLive, STUDIO_GOLIVE } from './golive-pr.ts';

type Fetch = typeof fetch;
/** Stand-ins for tests: GitHub's fetch, and a token for every repo (undefined: each repo's own). */
export type GitHubIO = { fetch?: Fetch; token?: string | null; pollMs?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> };

const fetchOf = (io: GitHubIO) => io.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
const tokenFor = async (slug: string, io: GitHubIO) => (io.token !== undefined ? io.token : await (await import('./ghtoken.ts')).repoToken(slug).catch(() => null));

/** Moves a repo's live branch to `sha`: directly, else through a pull request Studio merges (golive-pr.ts moveLive). */
async function move(slug: string, branch: string, sha: string, io: GitHubIO, o: { kind: 'live' | 'rollback'; title: string; body?: string; ifDiverged?: 'pr' | 'fail'; log?: string[] }) {
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  return moveLive(slug, branch, sha, {
    api: apiOf(f, token), direct: () => fastForward(slug, branch, sha, f, token), kind: o.kind, title: o.title, body: o.body, ifDiverged: o.ifDiverged,
    pollMs: io.pollMs, waitMs: io.waitMs, sleep: io.sleep, log: (l) => o.log?.push(l),
  });
}

/** Beta fast-forwarded to main's go live merge commit when beta is still the commit that went live (best effort). */
async function followBeta(slug: string, was: string, to: string, io: GitHubIO) {
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  const b = await gh(f, token, 'GET', `/repos/${slug}/git/ref/heads/${encodeURIComponent(BETA)}`);
  if (b.ok && String(b.j?.object?.sha) === was) await fastForward(slug, BETA, to, f, token).catch(() => null);
}

/** Commits only a go live through a pull request leaves on main (its merge commits): never a reason to merge main into beta. */
export const isGoLiveMerge = (title: string) => String(title).startsWith(STUDIO_GOLIVE);

/**
 * The GitHub repo a project goes live through here: a project added in a Studio (`github`: owner/name). J's products.json
 * products (no `github`; Unity ones with their own `build` block) keep their own flows in deploy.ts.
 */
export const githubSlugOf = (p: Pick<Product, 'github' | 'build'>): string | null => (p.github && !p.build ? String(p.github) : null);

/**
 * A customer's project Studio can't go live for (cells): no GitHub repo, or no token for it (the Studio's GitHub App isn't
 * installed on it). Then the plan is URL-only: Studio plays it where it is deployed and says what's missing. null when
 * the project goes live through GitHub here (githubPlan / goLiveOnGitHub).
 */
export async function urlOnlyPlan(p: Product, io: GitHubIO = {}) {
  const slug = githubSlugOf(p);
  if (slug && (await tokenFor(slug, io))) return null;
  const note = slug
    ? `${p.name} is played and reviewed at ${p.live}. Studio can't reach its repository (${slug}) on GitHub: install your Studio's GitHub App on it (or connect GitHub), then agents fix bugs in it and Studio keeps a beta site and goes live from it.`
    : `${p.name} has no repository here: Studio plays and reviews it at ${p.live}, and it goes live wherever you deploy it. Add its GitHub repository to get agent fixes, a beta site and going live from Studio.`;
  const error = slug
    ? `${p.name} can't go live from Studio yet: its repository (${slug}) isn't reachable with your Studio's GitHub App. Install the app on it and try again.`
    : `${p.name} has no repository: it goes live where you deploy it, not from Studio.`;
  return { plan: { product: p.id, name: p.name, urlOnly: true, repo: slug, live: p.live, beta: p.beta ?? null, canDeploy: false, blockers: [] as string[], warnings: [] as string[], note }, error };
}

/** A build that goes into another project's repo (publish.commit): where, the commit holding it, and whether main moves. */
export type Target = { build: string; project: string; name: string; slug: string; commit: string; version: number; main: string | null; move: boolean };

/** The build runs of a project at a commit (their playtests play the build where it is mounted: builds.ts playIt). */
export const buildRunsAt = (product: string, sha: string) =>
  (db.prepare(`SELECT DISTINCT run FROM builds WHERE product = ? AND change IS NULL AND run IS NOT NULL AND (sha = ? OR ? LIKE sha || '%')`).all(product, sha, sha) as { run: string }[]).map((r) => r.run);

/**
 * The builds of `p` with publish.commit, for its beta commit `sha`: the commit on the target repo's beta that holds each
 * (recorded when it was committed: builds.ts), and whether that repo's main can fast-forward to it.
 */
export async function publishTargets(p: Product, sha: string, io: GitHubIO = {}): Promise<{ targets: Target[]; blockers: string[]; attempts: { build: string; sha: string; attempts: import('./buildfail.ts').FailureView[] }[] }> {
  const { buildsOf, buildHint } = await import('./builds.ts');
  const f = fetchOf(io);
  const targets: Target[] = [];
  const blockers: string[] = [];
  const attempts: { build: string; sha: string; attempts: import('./buildfail.ts').FailureView[] }[] = [];
  for (const b of buildsOf(p).filter((x) => x.publish?.commit)) {
    let target: Product;
    try { target = getProduct(b.publish!.project); } catch { blockers.push(`Build ${b.id} goes into project "${b.publish!.project}", which isn't in this Studio.`); continue; }
    const slug = target.github ? String(target.github) : null;
    if (!slug) { blockers.push(`Build ${b.id} goes into ${target.name}, which has no GitHub repo here.`); continue; }
    const row = db.prepare(`SELECT version, commit_sha FROM builds WHERE product = ? AND build = ? AND change IS NULL AND commit_sha IS NOT NULL AND status IN ('ready', 'pruned') AND sha = ? ORDER BY version DESC LIMIT 1`).get(p.id, b.id, sha) as { version: number; commit_sha: string } | undefined;
    if (!row) {
      // Not "build first" and nothing else (J, 2026-11-03: seven failed builds, and Go live only said it wasn't there): what
      // was tried for this commit, each attempt with its result and reason, goes in the plan and the refusal.
      const F = await import('./buildfail.ts');
      const tried = F.attemptsAt(p.id, sha).filter((a) => a.build === b.id);
      attempts.push({ build: b.id, sha, attempts: tried });
      const said = F.attemptsLine(tried);
      blockers.push(`Build ${b.id} of ${BETA} ${sha.slice(0, 7)} isn't in ${slug}'s ${BETA} yet${said ? `. ${said}` : ''}: use the Build button (${buildHint(p)}).`);
      continue;
    }
    const token = await tokenFor(slug, io);
    const live = await liveBranchOf(slug, f, token);
    const main = await gh(f, token, 'GET', `/repos/${slug}/commits/${encodeURIComponent(live)}`);
    if (!main.ok) { blockers.push(`${slug} has no ${live} branch on GitHub (or Studio can't read it: ${main.status}).`); continue; }
    const mainSha = String(main.j.sha);
    const cmp = await gh(f, token, 'GET', `/repos/${slug}/compare/${mainSha}...${row.commit_sha}`);
    if (!cmp.ok) { blockers.push(`GitHub couldn't compare ${slug} ${live}...${row.commit_sha.slice(0, 7)} (${cmp.status}).`); continue; }
    // ahead: main fast-forwards to it; identical or behind: that build is already in main; diverged: it can't.
    if (cmp.j.status === 'diverged') { blockers.push(`${slug}'s ${live} has commits its ${BETA} lacks, so it can't be fast-forwarded to build ${b.id} (${row.commit_sha.slice(0, 7)}). Merge ${live} into ${BETA} in ${slug}, build again, then go live.`); continue; }
    targets.push({ build: b.id, project: target.id, name: target.name, slug, commit: row.commit_sha, version: row.version, main: mainSha, move: cmp.j.status === 'ahead' });
  }
  return { targets, blockers, attempts };
}

/** Whether a later commit changed nothing a player sees since `from` (only docs and notes: playplan.ts noRuntimeChange). */
export async function onlyDocsSince(slug: string, from: string, to: string, io: GitHubIO = {}) {
  const r = await gh(fetchOf(io), await tokenFor(slug, io), 'GET', `/repos/${slug}/compare/${from}...${to}`);
  if (!r.ok || r.j.status !== 'ahead' || !Array.isArray(r.j.files)) return false;
  const { noRuntimeChange } = await import('./playplan.ts');
  return noRuntimeChange((r.j.files as any[]).map((x) => String(x.filename)));
}

/**
 * Going live, after deploy.ts checked the plan and the owner's word: the targets' mains first (they serve the build),
 * then the project's main to the played beta commit (fatal when it is the whole go live, reported when targets moved).
 * Beta must still be that commit.
 */
/**
 * Beta brought up to date with the live branch, through GitHub (2026-10-31 review: going live again after a rollback,
 * or after someone pushed to main, was a blocker with a manual pull request as the fix):
 *   - live's extra commits are only Studio's rollbacks: an "ours" merge (beta's files, both parents), so the rollback is
 *     recorded without undoing beta's work, and beta's tree (what was playtested) is unchanged;
 *   - anything else: GitHub merges live into beta (a new beta commit to build and playtest before it goes live).
 * A real conflict says so; nothing is forced.
 */
export async function syncBetaWithLive(slug: string, io: GitHubIO = {}): Promise<{ how: 'ours' | 'merged' | 'none'; sha: string | null; message: string }> {
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  const live = await liveBranchOf(slug, f, token);
  const cmp = await gh(f, token, 'GET', `/repos/${slug}/compare/${encodeURIComponent(BETA)}...${encodeURIComponent(live)}`);
  if (!cmp.ok) throw new StudioError(`GitHub couldn't compare ${slug}'s ${BETA} and ${live} (${cmp.status})`, 409);
  const behind = ((cmp.j.commits ?? []) as any[]).filter((c) => !isGoLiveMerge(String(c.commit?.message ?? '')));
  if (!behind.length) return { how: 'none', sha: null, message: `${BETA} already has everything ${live} has.` };
  const rollbacksOnly = behind.every((c) => String(c.commit?.message ?? '').startsWith(STUDIO_ROLLBACK));
  const betaHead = await gh(f, token, 'GET', `/repos/${slug}/git/ref/heads/${encodeURIComponent(BETA)}`);
  const liveHead = await gh(f, token, 'GET', `/repos/${slug}/git/ref/heads/${encodeURIComponent(live)}`);
  if (!betaHead.ok || !liveHead.ok) throw new StudioError(`GitHub couldn't read ${slug}'s ${BETA} and ${live}`, 409);
  const betaSha = String(betaHead.j.object.sha), liveSha = String(liveHead.j.object.sha);
  if (rollbacksOnly) {
    const bc = await gh(f, token, 'GET', `/repos/${slug}/git/commits/${betaSha}`);
    const c = await gh(f, token, 'POST', `/repos/${slug}/git/commits`, { message: `Merge ${live} into ${BETA}: keep ${BETA}'s files (${live} only has ${behind.length} rollback commit(s))`, tree: bc.j.tree.sha, parents: [betaSha, liveSha] });
    if (!c.ok) throw new StudioError(`GitHub refused the merge commit (${c.status})`, 409);
    await fastForward(slug, BETA, String(c.j.sha), f, token);
    return { how: 'ours', sha: String(c.j.sha), message: `Recorded ${live}'s rollback(s) in ${BETA}, keeping ${BETA}'s files (what was playtested).` };
  }
  const m = await gh(f, token, 'POST', `/repos/${slug}/merges`, { base: BETA, head: live, commit_message: `Merge ${live} into ${BETA} (Studio, before going live)` });
  if (m.status === 409) throw new StudioError(`${live} and ${BETA} conflict in ${slug}: an agent can resolve it (studio_task "merge ${live} into ${BETA} and resolve the conflicts"), then ${BETA} is playtested and goes live.`, 409);
  if (!m.ok && m.status !== 204) throw new StudioError(`GitHub couldn't merge ${live} into ${BETA} (${m.status}${m.j?.message ? `: ${m.j.message}` : ''})`, 409);
  return { how: 'merged', sha: m.j?.sha ? String(m.j.sha) : null, message: `Merged ${live}'s ${behind.length} commit(s) into ${BETA}; ${BETA} is built and playtested next, then it can go live.` };
}

export async function goLiveOnGitHub(p: Product, plan: { beta: { sha: string; short: string } | null; main: { sha: string } | null; commits: unknown[]; ancestorOk?: boolean; github?: { targets: Target[]; rollbacksOnly?: boolean; liveMergesOnly?: boolean } }, io: GitHubIO = {}) {
  const slug = githubSlugOf(p)!;
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  const head = await gh(f, token, 'GET', `/repos/${slug}/commits/${BETA}`);
  // ancestorOk (a go live on green CI at an older beta commit, deploy.ts): beta may be ahead of it, but it has to be on beta.
  const onBeta = async () => {
    if (!plan.ancestorOk || !plan.beta || !head.ok) return false;
    const c = await gh(f, token, 'GET', `/repos/${slug}/compare/${plan.beta.sha}...${head.j.sha}`);
    return c.ok && ['ahead', 'identical'].includes(String(c.j.status));
  };
  if (!plan.beta || !head.ok || (head.j.sha !== plan.beta.sha && !(await onBeta()))) throw new StudioError(`${BETA} moved since the plan was made; look at the plan again.`, 409);
  const log: string[] = [];
  // Live had only rollbacks: recorded in beta first (same files), and live then fast-forwards to that commit.
  if (plan.github?.rollbacksOnly) {
    const s = await syncBetaWithLive(slug, io);
    log.push(s.message);
    if (s.sha) plan = { ...plan, beta: { sha: s.sha, short: s.sha.slice(0, 7) } };
  }
  const moved: { project: string; slug: string; build: string; version: number; before: string | null; after: string }[] = [];
  for (const t of (plan.github?.targets ?? []).filter((x) => x.move)) {
    const tLive = await liveBranchOf(t.slug, f, await tokenFor(t.slug, io));
    const m = await move(t.slug, tLive, t.commit, io, { kind: 'live', title: `${STUDIO_GOLIVE} build ${t.build} ${t.version} of ${p.name} (${t.commit.slice(0, 7)})`, ifDiverged: 'pr', log });
    if (m.how === 'pr' && m.sha !== t.commit) await followBeta(t.slug, t.commit, m.sha, io);
    moved.push({ project: t.project, slug: t.slug, build: t.build, version: t.version, before: t.main, after: m.sha });
    log.push(`${t.slug}: ${tLive} -> ${m.sha.slice(0, 7)} (build ${t.build} ${t.version} of ${p.name}${m.how === 'pr' ? `, pull request #${m.pr}` : ''})`);
  }
  const before = plan.main?.sha ?? null;
  let after = before;
  const live = await liveBranchOf(slug, f, token);
  if (plan.commits.length && before !== plan.beta!.sha) {
    try {
      const m = await move(slug, live, plan.beta!.sha, io, { kind: 'live', title: `${STUDIO_GOLIVE} ${BETA} ${plan.beta!.short} of ${p.name}`, body: `Hawkes Studio takes ${p.name} live: ${live} gets ${BETA} ${plan.beta!.short}, the commit that was playtested. The owner approved this go live in Studio.`, ifDiverged: plan.github?.liveMergesOnly ? 'pr' : 'fail', log });
      after = m.sha;
      log.push(`${slug}: ${live} -> ${m.sha.slice(0, 7)}${m.how === 'pr' ? ` (pull request #${m.pr}, merging ${plan.beta!.short})` : ''}`);
      // A merge commit on main: beta follows it when nothing new landed, so main and beta stay equal (same files).
      if (m.how === 'pr' && m.sha !== plan.beta!.sha) await followBeta(slug, plan.beta!.sha, m.sha, io);
    } catch (e: any) {
      if (!moved.length) throw new StudioError(e?.diverged ? `${e.message}: merge ${live} into ${BETA}, playtest ${BETA}, then go live.` : String(e?.message ?? e), 409);
      log.push(`warning: ${slug}'s ${live} wasn't moved: ${e.message}`);
    }
  }
  return { slug, before, after, targets: moved, log };
}

/** What a rollback of `slug`'s main to `to` would undo: main now, the commit it goes back to, the commits in between. */
export async function rollbackRefs(slug: string, to: string | null, io: GitHubIO = {}) {
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  const one = async (ref: string) => { const r = await gh(f, token, 'GET', `/repos/${slug}/commits/${ref}`); return r.ok ? commitOf(r.j) : null; };
  const main = await one(encodeURIComponent(await liveBranchOf(slug, f, token)));
  const back = to ? await one(to) : null;
  let undo: Commit[] = [];
  if (main && back && main.sha !== back.sha) {
    const c = await gh(f, token, 'GET', `/repos/${slug}/compare/${back.sha}...${main.sha}`);
    undo = c.ok ? ((c.j.commits ?? []) as any[]).map(commitOf).reverse() : [];
  }
  return { main, to: back, undo };
}

/**
 * The rollback: a new commit on main whose files are `to`'s (its tree), with main as its parent, and main
 * fast-forwarded to it. Refused when main moved from `expectMain` or already has those files.
 */
export async function rollbackOnGitHub(slug: string, to: string, message: string, io: GitHubIO = {}, expectMain?: string | null) {
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  const must = async (method: string, url: string, body?: unknown) => {
    const r = await gh(f, token, method, url, body);
    if (!r.ok) throw new StudioError(`GitHub ${method} ${url}: ${r.status}${r.j?.message ? ` ${r.j.message}` : ''}`, 409);
    return r.j;
  };
  const live = await liveBranchOf(slug, f, token);
  const ref = await must('GET', `/repos/${slug}/git/ref/heads/${encodeURIComponent(live)}`);
  const before = String(ref.object?.sha ?? '');
  if (expectMain && before !== expectMain) throw new StudioError(`${slug}'s ${live} moved since the plan was made; look at the rollback plan again.`, 409);
  const [old, cur] = await Promise.all([must('GET', `/repos/${slug}/git/commits/${to}`), must('GET', `/repos/${slug}/git/commits/${before}`)]);
  if (old.tree?.sha === cur.tree?.sha) throw new StudioError(`${live} already has the files of ${to.slice(0, 7)}; nothing to roll back.`, 409);
  const c = await must('POST', `/repos/${slug}/git/commits`, { message, tree: old.tree.sha, parents: [before] });
  const m = await move(slug, live, String(c.sha), io, { kind: 'rollback', title: message.split('\n')[0], body: message.split('\n').slice(1).join('\n').trim() || undefined });
  return { before, after: m.sha };
}
