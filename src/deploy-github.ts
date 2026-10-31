// Going live and rolling back for any project with a GitHub repo, in any Studio (customers' included; J, 2026-10-31),
// through GitHub's API with each repo's own token (ghtoken.ts): no clones, nothing assumed about J's repos.
//   - the plan (deploy.ts githubPlan): the commits on beta that main lacks (compare API), the played beta commit's
//     playtests (deploy.ts testedAt, keyed on project + sha), blockers;
//   - going live: main fast-forwarded to that exact beta commit (PATCH git/refs, force: false), and for each build with
//     `publish.commit` (builds.ts commitInto put it on the target repo's beta) that repo's main fast-forwarded to the
//     beta commit holding that build;
//   - rollback: a new commit on main with the tree of the commit live before (git data API: the old tree, the current
//     main as parent), never a force push. J's Unity games on Cloud Run roll their website back the same way.
// deploy.ts does the checks, the owner's typed words or Approve tap, the deploys rows and the live check.

import { BETA, MAIN, type Commit } from './beta.ts';
import { gh, commitOf, fastForward } from './deploy-cloud.ts';
import { getProduct, StudioError, type Product } from './config.ts';
import { db } from './db.ts';

type Fetch = typeof fetch;
/** Stand-ins for tests: GitHub's fetch, and a token for every repo (undefined: each repo's own). */
export type GitHubIO = { fetch?: Fetch; token?: string | null };

const fetchOf = (io: GitHubIO) => io.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
const tokenFor = async (slug: string, io: GitHubIO) => (io.token !== undefined ? io.token : await (await import('./ghtoken.ts')).repoToken(slug).catch(() => null));

/**
 * The GitHub repo a project goes live through here: a project added in a Studio (`github`: owner/name). J's products.json
 * products (no `github`; Unity ones with their own `build` block) keep their own flows in deploy.ts.
 */
export const githubSlugOf = (p: Pick<Product, 'github' | 'build'>): string | null => (p.github && !p.build ? String(p.github) : null);

/** A build that goes into another project's repo (publish.commit): where, the commit holding it, and whether main moves. */
export type Target = { build: string; project: string; name: string; slug: string; commit: string; version: number; main: string | null; move: boolean };

/** The build runs of a project at a commit (their playtests play the build where it is mounted: builds.ts playIt). */
export const buildRunsAt = (product: string, sha: string) =>
  (db.prepare(`SELECT DISTINCT run FROM builds WHERE product = ? AND change IS NULL AND run IS NOT NULL AND (sha = ? OR ? LIKE sha || '%')`).all(product, sha, sha) as { run: string }[]).map((r) => r.run);

/**
 * The builds of `p` with publish.commit, for its beta commit `sha`: the commit on the target repo's beta that holds each
 * (recorded when it was committed: builds.ts), and whether that repo's main can fast-forward to it.
 */
export async function publishTargets(p: Product, sha: string, io: GitHubIO = {}): Promise<{ targets: Target[]; blockers: string[] }> {
  const { buildsOf } = await import('./builds.ts');
  const f = fetchOf(io);
  const targets: Target[] = [];
  const blockers: string[] = [];
  for (const b of buildsOf(p).filter((x) => x.publish?.commit)) {
    let target: Product;
    try { target = getProduct(b.publish!.project); } catch { blockers.push(`Build ${b.id} goes into project "${b.publish!.project}", which isn't in this Studio.`); continue; }
    const slug = target.github ? String(target.github) : null;
    if (!slug) { blockers.push(`Build ${b.id} goes into ${target.name}, which has no GitHub repo here.`); continue; }
    const row = db.prepare(`SELECT version, commit_sha FROM builds WHERE product = ? AND build = ? AND change IS NULL AND commit_sha IS NOT NULL AND status IN ('ready', 'pruned') AND sha = ? ORDER BY version DESC LIMIT 1`).get(p.id, b.id, sha) as { version: number; commit_sha: string } | undefined;
    if (!row) { blockers.push(`Build ${b.id} of ${BETA} ${sha.slice(0, 7)} isn't in ${slug}'s ${BETA} yet: build ${BETA} first (a push to ${BETA}, or "build" on the project).`); continue; }
    const token = await tokenFor(slug, io);
    const main = await gh(f, token, 'GET', `/repos/${slug}/commits/${MAIN}`);
    if (!main.ok) { blockers.push(`${slug} has no ${MAIN} branch on GitHub (or Studio can't read it: ${main.status}).`); continue; }
    const mainSha = String(main.j.sha);
    const cmp = await gh(f, token, 'GET', `/repos/${slug}/compare/${mainSha}...${row.commit_sha}`);
    if (!cmp.ok) { blockers.push(`GitHub couldn't compare ${slug} ${MAIN}...${row.commit_sha.slice(0, 7)} (${cmp.status}).`); continue; }
    // ahead: main fast-forwards to it; identical or behind: that build is already in main; diverged: it can't.
    if (cmp.j.status === 'diverged') { blockers.push(`${slug}'s ${MAIN} has commits its ${BETA} lacks, so it can't be fast-forwarded to build ${b.id} (${row.commit_sha.slice(0, 7)}). Merge ${MAIN} into ${BETA} in ${slug}, build again, then go live.`); continue; }
    targets.push({ build: b.id, project: target.id, name: target.name, slug, commit: row.commit_sha, version: row.version, main: mainSha, move: cmp.j.status === 'ahead' });
  }
  return { targets, blockers };
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
export async function goLiveOnGitHub(p: Product, plan: { beta: { sha: string; short: string } | null; main: { sha: string } | null; commits: unknown[]; github?: { targets: Target[] } }, io: GitHubIO = {}) {
  const slug = githubSlugOf(p)!;
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  const head = await gh(f, token, 'GET', `/repos/${slug}/commits/${BETA}`);
  if (!plan.beta || !head.ok || head.j.sha !== plan.beta.sha) throw new StudioError(`${BETA} moved since the plan was made; look at the plan again.`, 409);
  const log: string[] = [];
  const moved: { project: string; slug: string; build: string; version: number; before: string | null; after: string }[] = [];
  for (const t of (plan.github?.targets ?? []).filter((x) => x.move)) {
    await fastForward(t.slug, MAIN, t.commit, f, io.token);
    moved.push({ project: t.project, slug: t.slug, build: t.build, version: t.version, before: t.main, after: t.commit });
    log.push(`${t.slug}: ${MAIN} -> ${t.commit.slice(0, 7)} (build ${t.build} ${t.version} of ${p.name})`);
  }
  const before = plan.main?.sha ?? null;
  let after = before;
  if (plan.commits.length && before !== plan.beta.sha) {
    try {
      await fastForward(slug, MAIN, plan.beta.sha, f, token);
      after = plan.beta.sha;
      log.push(`${slug}: ${MAIN} -> ${plan.beta.short}`);
    } catch (e: any) {
      if (!moved.length) throw new StudioError(`${e.message}: merge ${MAIN} into ${BETA}, playtest ${BETA}, then go live.`, 409);
      log.push(`warning: ${slug}'s ${MAIN} wasn't fast-forwarded: ${e.message}`);
    }
  }
  return { slug, before, after, targets: moved, log };
}

/** What a rollback of `slug`'s main to `to` would undo: main now, the commit it goes back to, the commits in between. */
export async function rollbackRefs(slug: string, to: string | null, io: GitHubIO = {}) {
  const f = fetchOf(io);
  const token = await tokenFor(slug, io);
  const one = async (ref: string) => { const r = await gh(f, token, 'GET', `/repos/${slug}/commits/${ref}`); return r.ok ? commitOf(r.j) : null; };
  const main = await one(MAIN);
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
  const ref = await must('GET', `/repos/${slug}/git/ref/heads/${MAIN}`);
  const before = String(ref.object?.sha ?? '');
  if (expectMain && before !== expectMain) throw new StudioError(`${slug}'s ${MAIN} moved since the plan was made; look at the rollback plan again.`, 409);
  const [old, cur] = await Promise.all([must('GET', `/repos/${slug}/git/commits/${to}`), must('GET', `/repos/${slug}/git/commits/${before}`)]);
  if (old.tree?.sha === cur.tree?.sha) throw new StudioError(`${MAIN} already has the files of ${to.slice(0, 7)}; nothing to roll back.`, 409);
  const c = await must('POST', `/repos/${slug}/git/commits`, { message, tree: old.tree.sha, parents: [before] });
  await fastForward(slug, MAIN, String(c.sha), f, token);
  return { before, after: String(c.sha) };
}
