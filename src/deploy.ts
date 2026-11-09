// Going live. Pushing a website repo's main branch publishes it (GitHub Pages, or DoD's Actions workflow) within
// minutes, so main only ever moves here, and only on J's word:
//
//   deployPlan(product)  what going live ships: the commits on beta that main lacks (titles, authors), the beta commit
//                        that was playtested and how those playtests and reviews went, blockers and warnings. Read-only.
//   deploy(product, { confirm: "DEPLOY <product>" })
//                        fast-forwards main to the playtested beta commit (never a merge, never a force push). Refused
//                        when beta moved since it was played, or main has commits beta lacks (mergeMain() first).
//                        Unity: the beta website copy (the website's beta, its page changes, plus the beta build's
//                        Game/v<n>) is committed and fast-forwards the website repo's main (and its beta follows), and the
//                        source repo's main is fast-forwarded to beta. Studio then playtests live.
//   rollbackPlan / rollback(product, { confirm: "ROLLBACK <product>" })
//                        puts main back to what was live before the last go live: a new commit with that commit's
//                        files (never a force push). Beta keeps its commits: fix forward there.
//
// Every go live and rollback is a row in `deploys` (beta.ts), so "the previous live commit" is known.
// Only J gives the confirmations; agents (and Talk) show the plan and wait for his exact words.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { critical } from './drain.ts';
import { getProduct, StudioError, managedElsewhere, managedNote, type Product } from './config.ts';
import { git } from './local.ts';
import { startPartial } from './pipeline.ts';
import { db, newId, rowToStep, type Step } from './db.ts';
import { previewUrl } from './previews.ts';
import { noRuntimeChange } from './playplan.ts';
import { opLog, registerOp, enqueue, queuePosition, getOp, type Op } from './ops.ts';
import {
  BETA, MAIN, STUDIO_ROLLBACK, AUTHOR, must, repoDirs, compareBeta, compareRefs, fetchForRead, NotClonedError, fetchOrigin, shaOf, commitOf, commitsIn, betaBuild, saveBetaBuild,
  betaSiteDir, betaSiteFolder, scratch, listDeploys, mergeMainIntoBeta, prebuilt, git as gitIn, gitAsync, type Commit, type DeployRow,
} from './beta.ts';
import { cloudGoLive, cloudRefs, cloudBlockers, cloudGoLiveNow, compareOnGitHub, type CloudRefs, type Compare } from './deploy-cloud.ts';
import { githubSlugOf, isGoLiveMerge, publishTargets, buildRunsAt, onlyDocsSince, goLiveOnGitHub, rollbackRefs, rollbackOnGitHub, type GitHubIO } from './deploy-github.ts';
import { repoMap } from './repos.ts';
import { qualityGate, failLine, type QualityFail } from './quality.ts';
import { customerStudio } from './tenancy.ts';
import { asFirebase, firebaseBuildOf } from './firebasebuild.ts';
import { STUDIO_RELEASE, RELEASES, playedCommit, releasesAt, releasesPath, readReleases, draftWithin, addReleaseTo, releaseLine, releaseNotesLine, type Draft } from './release.ts';

const brief = (c: Commit | null) => c && { sha: c.sha, short: c.short, title: c.title, author: c.author, date: c.date };

/** The latest local playtest of each scenario that played `sha` (clean), with its review. */
export function testedAt(productId: string, sha: string | undefined, carries: (from: string) => boolean = () => false) {
  const steps = (db.prepare(`SELECT * FROM steps WHERE product = ? AND kind IN ('playtest', 'review') AND name LIKE '%@local%' ORDER BY started DESC LIMIT 300`).all(productId) as any[]).map(rowToStep);
  const plays = steps.filter((s) => s.kind === 'playtest' && s.status !== 'running');
  const last = plays.find((s) => s.data?.played) ?? null;
  const byName = new Map<string, Step>();
  // A deployed app or a beta site may report a short commit: the same commit either way.
  const same = (x: unknown) => typeof x === 'string' && (x === sha || (x.length >= 7 && (sha!.startsWith(x) || x.startsWith(sha!))));
  if (sha) for (const s of plays) if (same(s.data?.played?.sha) && !s.data.played.dirty && !byName.has(s.name)) byName.set(s.name, s);
  // A clean pass of an earlier commit counts when nothing a player can see changed since (only docs and notes): a beta
  // run doesn't replay it (pipeline.ts unchangedPass), so go live must not ask for it either. Exact plays win.
  const carried = new Set<string>();
  if (sha) {
    const tried = new Map<string, boolean>();
    for (const s of plays) {
      const from = s.data?.played?.sha;
      if (byName.has(s.name) || s.status !== 'done' || !['won', 'done'].includes(s.data?.outcome) || !from || from === sha || s.data.played.dirty) continue;
      if (!tried.has(from)) tried.set(from, carries(from));
      if (tried.get(from)) { byName.set(s.name, s); carried.add(s.name); }
    }
  }
  const tested = [...byName.values()].map((s) => playOf(s, steps, carried.has(s.name)));
  return { tested, last: last && { name: last.name, when: last.finished, played: last.data.played } };
}

/** One finished playtest as the plan shows it, with its review. */
function playOf(s: Step, steps: Step[], carried = false) {
  const rv = steps.find((r) => r.kind === 'review' && r.run === s.run && r.name === s.name && ['done', 'skipped'].includes(r.status));
  return {
    name: s.name, status: s.status, outcome: s.data?.outcome ?? null, detail: carried ? `passed on ${String(s.data.played.sha).slice(0, 7)}; only docs and notes changed since, so it isn't played again` : s.detail, when: s.finished, run: s.run, video: s.data?.video ?? null,
    carriedFrom: carried ? String(s.data.played.sha).slice(0, 7) : null,
    verdict: rv?.data?.verdict ?? null, summary: rv?.data?.summary ?? null, scores: rv?.data?.scores ?? null,
    blockers: (rv?.data?.findings ?? []).filter((f: any) => f.severity === 'blocker').map((f: any) => f.title),
    quality: qualityOfPlay(s, rv),
  };
}

/** The game quality rubric on one played build (quality.ts): the rules it broke, and what wasn't measured. */
function qualityOfPlay(s: Step, rv: Step | undefined) {
  let p: Product;
  try { p = getProduct(s.product); } catch { return { fails: [], unmeasured: [], notes: [] }; }
  return qualityGate(p, { problems: s.data?.problems, metrics: s.data?.metrics, findings: rv?.data?.findings, fun: rv?.data?.fun ?? null, feel: s.data?.feel, polish: s.data?.polishHits, motion: rv?.data?.motion ?? null, software: Boolean(s.data?.software) });
}

/**
 * Rules that are a game's goal, not a go-live gate (J, 2026-11-09, on PH Origins and Yooba Land stuck for days behind
 * "a full, living world, not a demo"): no single fix loop finishes a world, so holding every fix behind it only keeps
 * players on an older, worse build. A break of one is still filed for agents on beta and shown as a warning.
 */
export const GOAL_RULES = new Set(['living-world']);
/**
 * Whether a broken quality rule holds going live. Not: a goal rule (GOAL_RULES), or what the vision judge saw on
 * screen (a prop that looks like it floats) when the review of that same play says "ship". Those go to agents as fixes
 * and the card shows them; the sensors' and scans' measured breaks (clipping, the camera in a wall, a hitch in play)
 * still hold it, and a person can still go live past them (isOverridable).
 */
export function holdsGoLive(f: QualityFail, verdict?: string | null) {
  if (GOAL_RULES.has(f.rule)) return false;
  if (f.kind === 'vision' && verdict === 'ship') return false;
  return true;
}

/**
 * The game quality rubric as a go-live gate: a played build of beta that broke a rule that holds going live
 * (holdsGoLive) blocks it until beta plays clean or a person goes live anyway (approvals.ts). Studio files each broken
 * rule as a bug (pipeline.ts fileFeel), its agents fix it on beta and beta is played again. Breaks that don't hold it,
 * checks the game doesn't measure yet, and notes (load stutter, the recording's stutters) are warnings.
 */
export function qualityBlockers(tested: { name: string; verdict?: string | null; quality?: { fails: QualityFail[]; unmeasured: string[]; notes?: string[] } }[], short: string | undefined) {
  const blockers: string[] = [];
  const goals: string[] = [];
  const unmeasured = new Set<string>();
  const notes = new Set<string>();
  for (const t of tested) {
    const all = t.quality?.fails ?? [];
    const fails = all.filter((f) => holdsGoLive(f, t.verdict));
    const soft = all.filter((f) => !holdsGoLive(f, t.verdict));
    if (fails.length) blockers.push(`Playtest ${t.name} on ${short ?? 'beta'} broke ${fails.length} game quality rule${fails.length === 1 ? '' : 's'}: ${fails.slice(0, 4).map(failLine).join('; ')}${fails.length > 4 ? ` (and ${fails.length - 4} more)` : ''}. Studio is fixing ${fails.length === 1 ? 'it' : 'them'} on ${BETA} and plays ${BETA} again by itself; you can also go live past ${fails.length === 1 ? 'it' : 'them'} (Go live anyway).`);
    if (soft.length) goals.push(`Not holding go live (Studio keeps fixing ${soft.length === 1 ? 'it' : 'these'} on ${BETA}): ${t.name} on ${short ?? 'beta'} ${soft.slice(0, 3).map(failLine).join('; ')}${soft.length > 3 ? ` (and ${soft.length - 3} more)` : ''}.`);
    for (const u of t.quality?.unmeasured ?? []) unmeasured.add(u);
    for (const n of t.quality?.notes ?? []) notes.add(`${t.name}: ${n}`);
  }
  const warnings = [...goals];
  if (unmeasured.size) warnings.push(`Not measured by the playtests yet (the game doesn't report them): ${[...unmeasured].join(', ')}.`);
  warnings.push(...[...notes].slice(0, 6));
  return { blockers, warnings };
}

/** The latest finished playtest of each scenario of a project in these runs (a build's run plays it where it is mounted). */
export function testedInRuns(productId: string, runs: string[]) {
  if (!runs.length) return [];
  const steps = (db.prepare(`SELECT * FROM steps WHERE product = ? AND kind IN ('playtest', 'review') AND run IN (${runs.map(() => '?').join(', ')}) ORDER BY started DESC`).all(productId, ...runs) as any[]).map(rowToStep);
  const byName = new Map<string, Step>();
  for (const s of steps) if (s.kind === 'playtest' && s.status !== 'running' && !byName.has(s.name)) byName.set(s.name, s);
  return [...byName.values()].map((s) => playOf(s, steps));
}

/** The plan's warnings about the played commit's playtests and reviews. */
function playWarnings(tested: ReturnType<typeof playOf>[], short: string | undefined) {
  const out: string[] = [];
  for (const t of tested) {
    if (t.status !== 'done' || !['won', 'done'].includes(t.outcome)) out.push(`Playtest ${t.name} on ${short} ${t.status === 'done' ? `ended "${t.outcome}"` : t.status === 'skipped' ? 'was inconclusive' : 'failed'}${t.detail ? ` (${t.detail})` : ''}.`);
    if (t.verdict === 'broken') out.push(`The review of ${t.name} said "broken": ${t.summary ?? ''}`);
    if (t.blockers.length) out.push(`The review of ${t.name} found ${t.blockers.length} blocker(s): ${t.blockers.join('; ')}`);
    if (!t.verdict) out.push(`${t.name} on ${short} has no review.`);
  }
  return out;
}

/**
 * The beta-only step that clears a plan blocker (the Go live cards' button): "merge-main" merges live into beta (it
 * also makes a missing beta) and then plays beta; "beta" is the beta run (pre-deploy build, Unity build, beta site, a
 * local playtest); "rebuild" is a forced Unity build of beta on top of live. None of them goes live. null: no button.
 */
export type BlockerFix = 'merge-main' | 'beta' | 'rebuild' | 'sync' | 'build';
export function blockerFix(blocker: string): BlockerFix | null {
  if (/^git: \S+ isn't cloned on this server yet/.test(blocker)) return 'sync';
  if (/^git:|^Nothing to go live/.test(blocker)) return null;
  // A project's own builds (builds.ts): the Build button starts them, whatever their triggers are.
  if (/use the Build button \(/.test(blocker)) return 'build';
  if (/ has no \S+ branch yet|commit\(s\) \S+ lacks/.test(blocker)) return 'merge-main';
  if (/'s \S+ moved since the beta build/.test(blocker)) return 'rebuild';
  if (/hasn't been playtested|isn't its pre-deploy build|The beta build is of|has no build yet|The last build of|The beta website copy sits on/.test(blocker)) return 'beta';
  return null;
}
/**
 * The one button for a plan's blockers: merging live in first (it plays beta after), then the beta run (it rebuilds
 * too). None when there's nothing to go live.
 */
export function planFix(blockers: string[]): BlockerFix | null {
  if (blockers.some((b) => b.startsWith('Nothing to go live'))) return null;
  const fixes = new Set(blockers.map(blockerFix));
  return (['sync', 'merge-main', 'build', 'beta', 'rebuild'] as const).find((f) => fixes.has(f)) ?? null;
}

/**
 * The blockers a person may go live past (J, 2026-11-01: "Add a bypass button for going live for projects that haven't
 * playtested the current commit"): only beta's exact commit not having been playtested. Everything else (nothing to go
 * live, live ahead of beta, no build, GitHub unreadable) still stops it.
 */
export const isPlaytestBlocker = (b: string) => /hasn't been playtested/.test(b);
/** True when a plan's only blockers are its commit not being playtested: "Go live anyway" is offered (a person's tap only). */
export const playtestOnly = (blockers: string[]) => blockers.length > 0 && blockers.every(isPlaytestBlocker);
/** A playtest of beta broke a quality rule that holds going live (qualityBlockers). */
export const isQualityBlocker = (b: string) => /^Playtest \S+ on \S+ broke \d+ game quality rules?:/.test(b);
/**
 * The blockers a person may go live past (J, 2026-11-09: "there should always be a way for the user to at least handle
 * this situation"): beta's commit not playtested, and quality rules its playtest broke. What would make going live
 * impossible or wrong (nothing to go live, live ahead of beta, no build, GitHub unreadable) still stops it, each with
 * its own button (Bring beta up to date, the Go live page's fix).
 */
export const isOverridable = (b: string) => isPlaytestBlocker(b) || isQualityBlocker(b);
/** True when every blocker of a plan is one a person may go live past: the card offers "Go live anyway". */
export const overridableOnly = (blockers: string[]) => blockers.length > 0 && blockers.every(isOverridable);

/**
 * The agent work on a product that is fixing beta now (queued, working, verifying, revising, ready to merge), newest
 * first, and the open findings of the plays that hold going live with no change on them: the card shows both, so a
 * stalled fix loop is visible and one tap starts it again (approvals.ts 'fixnow').
 */
export function fixWork(productId: string, runs: string[] = []) {
  let changes: { id: string; title: string; status: string; detail: string | null; updated: number | null }[] = [];
  try {
    changes = db.prepare(`SELECT id, title, status, detail, COALESCE(updated, created) AS updated FROM changes WHERE product = ? AND status IN ('queued', 'working', 'verifying', 'revising', 'ready', 'needs answer', 'waiting on Gen') ORDER BY COALESCE(updated, created) DESC LIMIT 6`).all(productId) as any[];
  } catch { /* no agents table on this server */ }
  let open: { id: string; title: string }[] = [];
  const rs = [...new Set(runs.filter(Boolean))];
  if (rs.length) {
    try {
      open = db.prepare(`SELECT id, title FROM findings WHERE product = ? AND status = 'open' AND last_run IN (${rs.map(() => '?').join(', ')}) ORDER BY last_seen DESC LIMIT 6`).all(productId, ...rs) as any[];
    } catch { /* no findings table */ }
  }
  return { changes, open };
}

/** What a person recorded when they took a commit live without its playtest (approvals.ts "Go live anyway"). */
export type PlaytestSkip = { by: string; at: number; sha: string; why: string[]; approval: string };
const skipOf = (d: DeployRow): PlaytestSkip | null => { try { return d.skipped_playtest ? JSON.parse(d.skipped_playtest) : null; } catch { return null; } };

/**
 * The skip an Approve card carries, when this go live came from a person's "Go live anyway" on it: only the card's own
 * row says so (decideApproval writes it, from a person's click; walk-away, auto, Talk and agents have no way to), it is
 * being carried out now, and it is for this product and this beta commit. null otherwise.
 */
export function playtestSkipFor(approval: string | undefined, product: string, sha: string | undefined): PlaytestSkip | null {
  if (!approval || !sha) return null;
  let r: any;
  try { r = db.prepare(`SELECT kind, target, status, params, decided_by FROM approvals WHERE id = ?`).get(approval); } catch { return null; }
  if (!r || r.kind !== 'deploy' || r.target !== product || r.status !== 'approving') return null;
  let s: any;
  try { s = JSON.parse(r.params ?? '{}')?.skipPlaytest; } catch { return null; }
  if (!s || typeof s.sha !== 'string' || s.sha !== sha || typeof s.by !== 'string' || s.by !== r.decided_by) return null;
  return { by: s.by, at: Number(s.at) || Date.now(), sha: s.sha, why: Array.isArray(s.why) ? s.why.map(String).slice(0, 10) : [], approval };
}

/** notesWaitMs: how long to wait for the release notes being written (the Approve card waits longer, to show them). */
export async function deployPlan(productId: string, opts: { notesWaitMs?: number; io?: GitHubIO } = {}) {
  const plan = await planOf(productId, opts);
  // Builds whose newest attempt failed (buildfail.ts): Go live's red badge, whatever else the plan says.
  const BF = await import('./buildfail.ts');
  const buildFailing = BF.failingBuilds(productId);
  const runs = ((plan as any).tested?.playtests ?? []).map((t: any) => t.run).filter(Boolean);
  return { ...plan, playtestOnly: playtestOnly(plan.blockers), overridable: overridableOnly(plan.blockers), fixWork: fixWork(productId, runs), betaDown: await betaDownOf(productId, plan), buildFailing, buildRunning: BF.buildsRunning(productId), buildDone: BF.buildsDone(productId) };
}
/**
 * When beta's last playtest failed because the beta site didn't answer: what happened in plain words and the two ways
 * on (the Go live page's "Redeploy beta" and "Retry playtest"), instead of a warning with nowhere to go. null otherwise.
 */
async function betaDownOf(productId: string, plan: { tested?: { playtests?: { status?: string; detail?: string | null }[] } }) {
  const { betaDownLine, betaRepoOf, betaRunsUrl } = await import('./redeploy.ts');
  const down = (plan.tested?.playtests ?? []).find((t) => t.status !== 'done' && betaDownLine(t.detail));
  if (!down) return null;
  const slug = betaRepoOf(getProduct(productId));
  return {
    line: 'Beta was not played: its site did not answer. Its last deploy may have failed, or it was still starting. Redeploy beta, or retry the playtest if it is up now.',
    detail: down.detail ?? null,
    runs: slug ? betaRunsUrl(slug) : null,
  };
}
async function planOf(productId: string, { notesWaitMs = 20_000, io }: { notesWaitMs?: number; io?: GitHubIO } = {}) {
  const p = getProduct(productId);
  // A project with a GitHub repo, in any Studio (a customer's included): read and moved through GitHub's API, no clones.
  if (githubSlugOf(p)) return githubPlan(p, io);
  const { source, site, unity } = repoDirs(p);
  // A Unity game on Cloud Run: no checkout of its repos here, so the plan reads them from GitHub (deploy-cloud.ts).
  if (unity && cloudGoLive()) return cloudPlan(p);
  const blockers: string[] = [];
  const warnings: string[] = [];
  let cmp: Awaited<ReturnType<typeof compareBeta>> = { main: null, beta: null, ahead: [], behind: [] };
  // Unity: the website repo's own beta (page changes by agents) vs its main.
  let web: typeof cmp = { main: null, beta: null, ahead: [], behind: [] };
  let notCloned: string | null = null;
  try {
    // Read-only: a repo fetched in the last minute, or busy with a push (a go live), is read as of its last fetch.
    // Going live fetches again before it pushes, so a stale plan can't go live.
    for (const dir of unity && site !== source ? [source, site] : [source]) {
      const why = await fetchForRead(dir);
      if (why) warnings.push(`Couldn't check GitHub just now: ${why}.`);
    }
    cmp = compareRefs(source);
    if (unity && site !== source) web = compareRefs(site);
  } catch (e: any) {
    if (e instanceof NotClonedError) notCloned = e.folder;
    blockers.push(`git: ${e.message}`);
  }
  const beta = cmp.beta;
  if (!beta && !notCloned) blockers.push(`${p.repo.split('/')[0]} has no ${BETA} branch yet. It's made from ${MAIN} when the first agent change starts (or "studio deploy ${p.id} --merge-main" makes it now).`);
  if (cmp.behind.length) {
    const rollbacks = cmp.behind.every((c) => c.title.startsWith(STUDIO_ROLLBACK));
    blockers.push(`${MAIN} has ${cmp.behind.length} commit(s) ${BETA} lacks (${cmp.behind.slice(0, 5).map((c) => `"${c.title}"`).join(', ')}), so ${MAIN} can't be fast-forwarded. Merge ${MAIN} into ${BETA} first (studio deploy ${p.id} --merge-main${rollbacks ? `; they're rollbacks, so the merge keeps ${BETA}'s files` : ''}), then playtest ${BETA}.`);
  }
  if (web.behind.length) {
    const rollbacks = web.behind.every((c) => c.title.startsWith(STUDIO_ROLLBACK));
    blockers.push(`${p.site}'s ${MAIN} has ${web.behind.length} commit(s) ${BETA} lacks (${web.behind.slice(0, 5).map((c) => `"${c.title}"`).join(', ')}), so the website's ${MAIN} can't be fast-forwarded. Merge ${MAIN} into ${BETA} first (studio deploy ${p.id} --merge-main${rollbacks ? `; they're rollbacks, so the merge keeps ${BETA}'s files` : ''}), then playtest ${BETA}.`);
  }

  // The playtests of the exact beta commit (a Studio release commit on top, only releases.json, doesn't count as moving it).
  const played = beta ? playedCommit(source, beta) : null;
  const { tested, last } = testedAt(p.id, played?.sha, (from) => {
    const d = gitIn(source, ['diff', '--name-only', from, played!.sha]);
    return d.ok && noRuntimeChange(d.out.split('\n').map((x) => x.trim()).filter(Boolean));
  });
  if (played && !tested.length) {
    blockers.push(last ? `${BETA} hasn't been playtested at ${played.short} (the last local playtest played ${last.played.branch} ${String(last.played.sha).slice(0, 7)}${last.played.dirty ? ' with uncommitted changes' : ''}). Playtest ${BETA} first (the daily run, or "studio beta ${p.id}").` : `${BETA} hasn't been playtested yet (the daily run on the server plays it, or "studio beta ${p.id}").`);
  }
  for (const t of tested) {
    if (t.status !== 'done' || !['won', 'done'].includes(t.outcome)) warnings.push(`Playtest ${t.name} on ${beta?.short} ${t.status === 'done' ? `ended "${t.outcome}"` : t.status === 'skipped' ? 'was inconclusive' : 'failed'}${t.detail ? ` (${t.detail})` : ''}.`);
    if (t.verdict === 'broken') warnings.push(`The review of ${t.name} said "broken": ${t.summary ?? ''}`);
    if (t.blockers.length) warnings.push(`The review of ${t.name} found ${t.blockers.length} blocker(s): ${t.blockers.join('; ')}`);
    if (!t.verdict) warnings.push(`${t.name} on ${beta?.short} has no review.`);
  }
  { const q = qualityBlockers(tested, beta?.short); blockers.push(...q.blockers); warnings.push(...q.warnings); }

  // The pre-deploy build lives on beta (beta.ts prepareBeta), so the playtested commit is exactly what ships.
  if (played && p.deploy?.prebuild && !prebuilt(p, played.sha, played.title)) {
    blockers.push(`${BETA}'s newest commit isn't its pre-deploy build (${p.deploy.prebuild}). Run "studio beta ${p.id}" (it builds, commits to ${BETA} and playtests it).`);
  }

  // Unity: the beta build in its website copy is what goes to the website repo's main.
  let build: any = null;
  if (unity) {
    const b = betaBuild(p);
    const siteMain = shaOf(site, `origin/${MAIN}`);
    const siteBeta = web.beta?.sha ?? null;
    const files = b?.ok ? (await gitAsync(betaSiteDir(p), ['status', '--porcelain'])).out.split('\n').filter(Boolean) : [];
    build = b && { ...b, files: files.length, sample: files.slice(0, 20) };
    if (!b) blockers.push(`${BETA} has no build yet (the daily run on the server builds it, or "studio build ${p.id}").`);
    else if (!b.ok) blockers.push(`The last build of ${BETA} failed: ${b.error ?? '?'}`);
    else {
      if (beta && b.sha !== beta.sha) blockers.push(`The beta build is of ${b.sha.slice(0, 7)}, but ${BETA} is ${beta.short}: build ${BETA} again ("studio beta ${p.id}").`);
      // The copy sits on the website's beta (its page changes); before the website had a beta, on its main.
      // (A copy ahead of the website's beta is a go live whose beta update a restart cut off: merging main into beta fixes it.)
      if (siteBeta && b.base !== siteBeta && !gitIn(site, ['merge-base', '--is-ancestor', siteBeta, b.base]).ok) blockers.push(`The beta website copy sits on ${b.base.slice(0, 7)}, but ${p.site}'s ${BETA} is ${siteBeta.slice(0, 7)} now: run ${BETA} again ("studio beta ${p.id}": it moves the build onto the new pages, or builds again).`);
      else if (!siteBeta && siteMain && b.base !== siteMain) blockers.push(`${p.site}'s ${MAIN} moved since the beta build (${b.base.slice(0, 7)} -> ${siteMain.slice(0, 7)}): build ${BETA} again so it sits on what's live.`);
      if (!files.length && !cmp.ahead.length && !web.ahead.length) blockers.push(`Nothing to go live: the beta build matches what's live and ${BETA} has no new commits.`);
    }
  } else if (beta && !cmp.ahead.length && !cmp.behind.length) {
    blockers.push(`Nothing to go live: ${MAIN} already is ${BETA} (${beta.short}).`);
  }

  // The release going live adds to releases.json (release.ts): its version and notes (waited for, so the plan shows
  // what ships), or the entry already on beta, kept.
  let release: Awaited<ReturnType<typeof draftWithin>> | null = null;
  if (beta && played && !blockers.some((b) => /^Nothing to go live|^git:/.test(b))) {
    try {
      const fallbackCommits = [...cmp.ahead, ...web.ahead].filter((c) => !c.title.startsWith(STUDIO_RELEASE));
      const live = unity ? releasesAt(site, `origin/${MAIN}`, releasesPath(p)) : releasesAt(source, `origin/${MAIN}`, releasesPath(p));
      const data = unity ? readReleases(path.join(betaSiteFolder(p), RELEASES)) ?? live : releasesAt(source, beta.sha, releasesPath(p));
      if (data) release = await draftWithin(p, unity
        ? { data, live, source, target: beta.sha, build: String(build?.version ?? beta.short), fallbackCommits }
        : { data, live, source, target: played.sha, build: played.short, fallbackCommits }, notesWaitMs);
    } catch (e: any) {
      warnings.push(`The release notes couldn't be drafted (${e.message}); going live still works, without a new release entry.`);
    }
  }
  const relNote = release ? ` ${releaseNotesLine(release)}${release.since ? ` (notes cover ${release.commits} commit(s) since the last release entry, ${release.since.slice(0, 7)})` : ''}.` : '';

  const previous = listDeploys(p.id, 5);
  const players = await livePlayers(p.id);
  if (managedElsewhere(p)) blockers.unshift(managedNote(p));
  return {
    product: p.id, name: p.name, live: p.live, betaSite: previewUrl(p.id), repo: p.repo, site: p.site, unity,
    main: brief(cmp.main), beta: brief(beta), played: brief(played), release,
    commits: cmp.ahead.map(brief), mainOnly: cmp.behind.map(brief),
    // Unity: the website's page changes going live with the build (its beta's commits), and its main's commits beta lacks.
    siteCommits: web.ahead.map(brief), siteMainOnly: web.behind.map(brief),
    tested: { sha: beta?.short ?? null, playtests: tested }, lastPlayed: last,
    build,
    previous: previous.map((d) => ({ id: d.id, kind: d.kind, at: d.at, by: d.by, before: d.before?.slice(0, 7) ?? null, after: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, detail: d.detail, rolledBack: d.rolled_back, skippedPlaytest: skipOf(d) })),
    // How the build that's live now does with real players (players.ts), so the next release can be compared.
    players,
    blockers, warnings, canDeploy: !blockers.length, fix: planFix(blockers), notCloned,
    confirm: `DEPLOY ${p.id}`,
    what: unity
      ? `Commits ${BETA}'s build${build?.version ? ` (Game/v${build.version})` : ''} to ${p.site}'s ${MAIN}${web.ahead.length ? ` together with ${web.ahead.length} website commit(s) from its ${BETA} (${web.ahead.slice(0, 3).map((c) => `"${c.title}"`).join(', ')})` : ''} and fast-forwards ${p.repo.split('/')[0]}'s ${MAIN} to ${beta?.short ?? BETA}; GitHub Pages publishes ${p.live}.${relNote}`
      : `Fast-forwards ${p.site}'s ${MAIN} to ${BETA}${played ? ` ${played.short}` : ''} (${cmp.ahead.length} commit(s))${release && !release.existing ? ', with a release entry on top' : ''}; ${publisherOf(p).says} ${p.live}.${relNote}`,
  };
}

/** The go-live plan of a Unity game on Cloud Run, from GitHub (deploy-cloud.ts): the same shape and checks as above. */
async function cloudPlan(p: Product) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let refs: CloudRefs | null = null;
  try {
    refs = await cloudRefs(p);
    blockers.push(...await cloudBlockers(p, refs));
  } catch (e: any) {
    blockers.push(`GitHub: ${e.message}`);
  }
  const beta = refs?.source.beta ?? null;
  const { tested, last } = testedAt(p.id, beta?.sha);
  if (beta && !tested.length) {
    blockers.push(last ? `${BETA} hasn't been playtested at ${beta.short} (the last local playtest played ${last.played.branch} ${String(last.played.sha).slice(0, 7)}). Playtest ${BETA} first ("studio beta ${p.id}").` : `${BETA} hasn't been playtested yet ("studio beta ${p.id}").`);
  }
  for (const t of tested) {
    if (t.status !== 'done' || !['won', 'done'].includes(t.outcome)) warnings.push(`Playtest ${t.name} on ${beta?.short} ${t.status === 'done' ? `ended "${t.outcome}"` : t.status === 'skipped' ? 'was inconclusive' : 'failed'}${t.detail ? ` (${t.detail})` : ''}.`);
    if (t.verdict === 'broken') warnings.push(`The review of ${t.name} said "broken": ${t.summary ?? ''}`);
    if (t.blockers.length) warnings.push(`The review of ${t.name} found ${t.blockers.length} blocker(s): ${t.blockers.join('; ')}`);
    if (!t.verdict) warnings.push(`${t.name} on ${beta?.short} has no review.`);
  }
  { const q = qualityBlockers(tested, beta?.short); blockers.push(...q.blockers); warnings.push(...q.warnings); }
  const b = betaBuild(p);
  const siteBeta = refs?.site.beta ?? null;
  const top = p.repo.split('/')[0];
  if (managedElsewhere(p)) blockers.unshift(managedNote(p));
  return {
    product: p.id, name: p.name, live: p.live, betaSite: previewUrl(p.id), repo: p.repo, site: p.site, unity: true,
    main: brief(refs?.source.main ?? null), beta: brief(beta), played: brief(beta), release: null,
    commits: (refs?.source.ahead ?? []).map(brief), mainOnly: (refs?.source.behind ?? []).map(brief),
    siteCommits: (refs?.site.ahead ?? []).map(brief), siteMainOnly: (refs?.site.behind ?? []).map(brief),
    tested: { sha: beta?.short ?? null, playtests: tested }, lastPlayed: last,
    build: b && { ...b, files: 0, sample: [] },
    previous: listDeploys(p.id, 5).map((d) => ({ id: d.id, kind: d.kind, at: d.at, by: d.by, before: d.before?.slice(0, 7) ?? null, after: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, detail: d.detail, rolledBack: d.rolled_back, skippedPlaytest: skipOf(d) })),
    players: await livePlayers(p.id),
    blockers, warnings, canDeploy: !blockers.length, fix: planFix(blockers), notCloned: null,
    confirm: `DEPLOY ${p.id}`,
    what: `Fast-forwards ${p.site}'s ${MAIN} to its ${BETA}${siteBeta ? ` ${siteBeta.short}` : ''} (the build${b?.version ? ` Game/v${b.version}` : ''}, already published) and ${top}'s ${MAIN} to ${beta?.short ?? BETA}, through GitHub; GitHub Pages publishes ${p.live}. No release entry this time.`,
    cloud: { siteBeta: siteBeta?.sha ?? null },
  };
}

/**
 * The go-live plan of a project with a GitHub repo (deploy-github.ts), the same shape and checks as above: the commits
 * on beta that main lacks, the playtests of that exact beta commit (and of its builds where they are mounted), the
 * builds that go into another project's repo, blockers.
 */
async function githubPlan(p: Product, io: GitHubIO = {}) {
  const slug = githubSlugOf(p)!;
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (managedElsewhere(p)) blockers.push(managedNote(p));
  let cmp: Compare = { main: null, beta: null, ahead: [], behind: [] };
  try {
    cmp = await compareOnGitHub(slug, io.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), io.token);
  } catch (e: any) {
    blockers.push(`GitHub: ${e.message}`);
  }
  const beta = cmp.beta;
  if (!cmp.main && !beta) blockers.push(`Studio can't read ${slug}'s ${MAIN} or ${BETA} on GitHub: connect GitHub and give Studio's app access to it (the project's setup check has the link).`);
  else if (!beta) blockers.push(`${slug} has no ${BETA} branch on GitHub yet: make it from ${MAIN} (the project's setup does), then playtest it.`);
  else if (!cmp.main) blockers.push(`${slug} has no ${MAIN} branch on GitHub.`);
  // Live's extra commits only Studio's rollbacks: going live records them in beta first (an "ours" merge, beta's files),
  // never a blocker. Anything else: Studio merges live into beta itself (studio_deploy action merge-main, or by itself on
  // policy auto), and beta is built and playtested before it goes live (2026-10-31 review).
  // Merge commits of earlier go lives through a pull request (golive-pr.ts) are Studio's own: the next go live merges
  // over them, so they are neither a blocker nor merged into beta.
  const foreign = cmp.behind.filter((c) => !isGoLiveMerge(c.title));
  const liveMergesOnly = cmp.behind.length > 0 && !foreign.length;
  const rollbacksOnly = foreign.length > 0 && foreign.every((c) => String(c.title).startsWith(STUDIO_ROLLBACK));
  if (rollbacksOnly) warnings.push(`${MAIN} has ${foreign.length} rollback commit(s) ${BETA} lacks: going live records them in ${BETA} first, keeping ${BETA}'s files.`);
  else if (foreign.length) blockers.push(`${MAIN} has ${foreign.length} commit(s) ${BETA} lacks (${foreign.slice(0, 5).map((c) => `"${c.title}"`).join(', ')}), so ${MAIN} can't be fast-forwarded. Studio merges ${MAIN} into ${BETA} (studio_deploy action merge-main), then ${BETA} is built and playtested and can go live.`);
  // The playtests of the exact beta commit; a clean pass of an earlier one counts when only docs and notes changed since.
  const carries = new Set<string>();
  if (beta) {
    const seen = new Set<string>();
    for (const r of db.prepare(`SELECT data FROM steps WHERE product = ? AND kind = 'playtest' AND status = 'done' AND name LIKE '%@local%' ORDER BY started DESC LIMIT 100`).all(p.id) as any[]) {
      const from = (() => { try { return JSON.parse(r.data ?? '{}')?.played?.sha; } catch { return null; } })();
      if (typeof from === 'string' && from && !beta.sha.startsWith(from) && !seen.has(from) && seen.size < 4) seen.add(from);
    }
    for (const from of seen) if (await onlyDocsSince(slug, from, beta.sha, io).catch(() => false)) carries.add(from);
  }
  const { tested, last } = testedAt(p.id, beta?.sha, (from) => carries.has(from));
  // A build mounted into another project's site is played there (builds.ts playIt): those plays count for this commit.
  if (beta) {
    const runs = buildRunsAt(p.id, beta.sha);
    const { buildsOf } = await import('./builds.ts');
    for (const b of buildsOf(p).filter((x) => x.publish && x.publish.project !== p.id)) {
      for (const t of testedInRuns(b.publish!.project, runs)) if (!tested.some((x) => x.run === t.run && x.name === t.name)) tested.push({ ...t, name: `${t.name} (${b.publish!.project})` });
    }
  }
  if (beta && !tested.length) blockers.push(last ? `${BETA} hasn't been playtested at ${beta.short} (the last playtest played ${last.played.branch} ${String(last.played.sha).slice(0, 7)}). Playtest ${BETA} first.` : `${BETA} hasn't been playtested yet: play it first (a beta run or a playtest of the project).`);
  warnings.push(...playWarnings(tested, beta?.short));
  { const q = qualityBlockers(tested, beta?.short); blockers.push(...q.blockers); warnings.push(...q.warnings); }
  const tg = beta ? await publishTargets(p, beta.sha, io).catch((e: any) => ({ targets: [], blockers: [`GitHub: ${e.message}`], attempts: [] })) : { targets: [], blockers: [], attempts: [] };
  blockers.push(...tg.blockers);
  const moving = tg.targets.filter((t) => t.move);
  if (beta && cmp.main && !cmp.ahead.length && !cmp.behind.length && !moving.length) blockers.push(`Nothing to go live: ${MAIN} already is ${BETA} (${beta.short})${tg.targets.length ? ' and its builds are live' : ''}.`);
  const into = moving.map((t) => `${t.slug}'s ${MAIN} to its ${BETA} commit holding build ${t.build} ${t.version} (${t.commit.slice(0, 7)})`);
  return {
    product: p.id, name: p.name, live: p.live, betaSite: previewUrl(p.id), repo: slug, site: slug, unity: false,
    main: brief(cmp.main), beta: brief(beta), played: brief(beta), release: null,
    commits: cmp.ahead.map(brief), mainOnly: cmp.behind.map(brief), siteCommits: [] as ReturnType<typeof brief>[], siteMainOnly: [] as ReturnType<typeof brief>[],
    tested: { sha: beta?.short ?? null, playtests: tested }, lastPlayed: last,
    build: null as any,
    buildAttempts: tg.attempts,
    previous: listDeploys(p.id, 5).map((d) => ({ id: d.id, kind: d.kind, at: d.at, by: d.by, before: d.before?.slice(0, 7) ?? null, after: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, detail: d.detail, rolledBack: d.rolled_back, skippedPlaytest: skipOf(d) })),
    players: await livePlayers(p.id),
    blockers, warnings, canDeploy: !blockers.length, fix: planFix(blockers) as BlockerFix | null, notCloned: null,
    confirm: `DEPLOY ${p.id}`,
    what: `${cmp.ahead.length ? `Fast-forwards ${slug}'s ${MAIN} to ${BETA}${beta ? ` ${beta.short}` : ''} (${cmp.ahead.length} commit(s))` : `Leaves ${slug}'s ${MAIN} as it is`}${into.length ? `, and ${into.join(', ')}` : ''}, through GitHub (never a merge or a force push); ${publisherOf(p).says} ${p.live || 'its live site'}.`,
    github: { slug, targets: tg.targets, rollbacksOnly, liveMergesOnly },
  };
}

const firebaseOf = (p: Product) => firebaseBuildOf((p.builds ?? []).map(asFirebase));

/**
 * Main moved (a go live or a rollback): a project with a Firebase build deploys main to its live Firebase project now,
 * from Studio's own cloud build (the build run shows it; a failure is told like any build's). Nothing for other projects.
 */
export async function deployMain(p: Product, sha: string, origin?: string | null): Promise<string | null> {
  const b = firebaseOf(p);
  if (!b) return null;
  const { startBuild } = await import('./builds.ts');
  const run = await startBuild(p.id, { build: b.id, ref: 'main', sha, origin: origin ?? null });
  opLog(`deploying ${sha.slice(0, 7)} to Firebase (live) from Studio's cloud build${run ? `: run ${run.id}` : ''}`);
  return run?.id ?? null;
}

/**
 * Who publishes a product's main: GitHub Pages (the default), or the product's own server (products.json deploy.via
 * "ec2": its box pulls it; Studio only moves main and plays the live site).
 */
export function publisherOf(p: Product) {
  // A Firebase build (firebasebuild.ts): Studio deploys main itself from its own cloud build, never GitHub Actions.
  if (firebaseOf(p)) return { box: true as const, says: 'Studio deploys it to Firebase (hosting and functions) from its own cloud build, at', done: 'Studio deploys it to Firebase from its own cloud build within about 10 minutes (a build run shows it)' };
  if (p.deploy?.via === 'firebase') return { box: true as const, says: 'GitHub Actions deploys it to Firebase (hosting and functions)', done: 'GitHub Actions deploys it to Firebase within about 10 minutes' };
  // A customer's project is hosted wherever they host it (GitHub Pages, Netlify, Vercel, Cloudflare, a server): its host
  // deploys its live branch, and Studio checks the live site once the host reports the commit (verifyLive).
  if (p.deploy?.via !== 'ec2' && !p.deploy && customerStudio()) return { box: false as const, says: 'its host (GitHub Pages, Netlify, Vercel, Cloudflare or its own server) deploys it to', done: 'its host deploys it within a few minutes' };
  if (p.deploy?.via !== 'ec2') return { box: false as const, says: 'GitHub Pages publishes', done: 'GitHub Pages publishes within a few minutes' };
  const box = p.deploy.box ?? 'its own server';
  return { box: true as const, says: `${box} pulls it and restarts (health check, rollback if unhealthy)`, done: `${box} pulls it within a couple of minutes (no tests there; it rolls back if unhealthy)` };
}

/** Going live (pushing main, recording it) is a critical section (drain.ts): a Studio deploy waits for it. */
export const deploy = (...a: Parameters<typeof deployNow>) => critical(`going live: ${a[0]}`, async () => {
  const r: any = await deployNow(...a);
  // A person went live past the playtest ("Go live anyway"): who, when and which commit go on the go live's record.
  const skip = playtestSkipFor(a[1]?.approval, a[0], a[1]?.beta);
  if (skip && r?.deploy) {
    db.prepare('UPDATE deploys SET skipped_playtest = ? WHERE id = ?').run(JSON.stringify(skip), r.deploy);
    opLog(`${skip.by} took ${a[0]} live without a playtest of ${skip.sha.slice(0, 7)}`);
    return { ...r, skippedPlaytest: skip };
  }
  return r;
});
async function deployNow(productId: string, { confirm, by = 'J', mergeMain, origin, beta: expect, approval, io }: { confirm?: string; by?: string; mergeMain?: boolean; message?: string; origin?: string | null; beta?: string; approval?: string; io?: GitHubIO }) {
  const p = getProduct(productId);
  if (mergeMain && githubSlugOf(p)) {
    const { syncBetaWithLive } = await import('./deploy-github.ts');
    const s = await syncBetaWithLive(githubSlugOf(p)!, io);
    return { ok: true, product: p.id, merged: s.how, sha: s.sha, note: `${s.message} Nothing went live.` };
  }
  if (mergeMain) return { ok: true, product: p.id, ...(await mergeMainIntoBeta(p, by)), note: `Nothing went live. Playtest ${BETA} again before going live.` };
  opLog(`making the plan for ${p.name}`);
  const plan = await deployPlan(p.id, { io });
  if (confirm !== plan.confirm) throw new StudioError(`Going live publishes ${plan.live}: ${plan.what} Show J the plan, then send confirm: "${plan.confirm}" (J's call).`);
  // A person's "Go live anyway" on an Approve card (playtestSkipFor) goes past beta not being playtested and the quality
  // rules its playtests broke (isOverridable), and nothing else.
  const skip = playtestSkipFor(approval, p.id, expect);
  const blockers = skip ? plan.blockers.filter((b) => !isOverridable(b)) : plan.blockers;
  if (blockers.length) throw new StudioError(`Not going live:\n- ${blockers.join('\n- ')}`);
  // An Approve card (approvals.ts) is for one beta commit: a different one now isn't what J approved.
  if (expect && plan.beta?.sha !== expect && plan.played?.sha !== expect) throw new StudioError(`${BETA} is ${plan.beta?.short ?? '?'} now, not ${expect.slice(0, 7)} that J approved; look at the plan again.`);
  // A project with a GitHub repo (deploy-github.ts): its main, and the repos its builds went into, through GitHub's API.
  if (githubSlugOf(p)) {
    const r = await goLiveOnGitHub(p, plan as any, io);
    for (const l of r.log) opLog(l);
    const id = newId('d');
    const after = r.after ?? plan.beta!.sha;
    const insert = db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(id, p.id, 'deploy', r.slug, r.before, after, plan.beta!.sha, null, null, null, null, by, `${plan.commits.length} commit(s): ${plan.commits.slice(0, 8).map((c) => c!.title).join('; ')}${r.targets.length ? ` · builds: ${r.targets.map((t) => `${t.build} ${t.version} into ${t.slug}`).join(', ')}` : ''}`.slice(0, 1000), Date.now());
    // Each repo a build went into is that project's go live too (its own rollback puts it back).
    for (const t of r.targets) insert.run(newId('d'), t.project, 'deploy', t.slug, t.before, t.after, t.after, r.slug, null, plan.beta!.sha, String(t.version), by, `build ${t.build} ${t.version} of ${p.name} (${plan.beta!.short})`, Date.now());
    await deployMain(p, after, origin).catch((e: any) => opLog(`couldn't start the Firebase deploy of ${MAIN}: ${String(e?.message ?? e).slice(0, 300)}`));
    if (after !== r.before && p.live) void verifyLive(p.id, after, `Just went live (${BETA} ${plan.beta!.short}: ${plan.commits.slice(0, 3).map((c) => c!.title).join('; ')})`, origin);
    for (const t of r.targets) {
      const tp = (() => { try { return getProduct(t.project); } catch { return null; } })();
      if (tp?.live) void verifyLive(tp.id, t.after, `Just went live: build ${t.build} ${t.version} of ${p.name} (${plan.beta!.short})`, origin);
    }
    return { ok: true, product: p.id, deploy: id, live: p.live, main: after.slice(0, 7), beta: plan.beta!.short, release: null, log: r.log, note: `${publisherOf(p).done}; Studio waits for it, then playtests the live site where there is one. If it went wrong: the rollback plan.` };
  }
  const { source, site, unity } = repoDirs(p);
  // A Unity game on Cloud Run: both mains move through GitHub's API (deploy-cloud.ts), fast-forward only.
  if (unity && cloudGoLive()) {
    const r = await cloudGoLiveNow(p, { beta: plan.beta, site: { beta: (plan as any).cloud?.siteBeta ?? null } });
    for (const l of r.log) opLog(l);
    const id = newId('d');
    db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, 'deploy', p.site, r.before, r.after, plan.beta!.sha, p.repo, r.sourceBefore, r.sourceAfter, plan.build?.version ?? null, by, `${plan.commits.length} commit(s): ${plan.commits.slice(0, 8).map((c) => c!.title).join('; ')}${plan.siteCommits.length ? ` · website ${plan.siteCommits.length} commit(s): ${plan.siteCommits.slice(0, 8).map((c) => c!.title).join('; ')}` : ''}`.slice(0, 1000), Date.now());
    if (r.after !== r.before) void verifyLive(p.id, r.after, `Just went live (${BETA} ${plan.beta!.short}: ${plan.commits.slice(0, 3).map((c) => c!.title).join('; ')})`, origin);
    return { ok: true, product: p.id, deploy: id, live: p.live, main: r.after.slice(0, 7), beta: plan.beta!.short, release: null, log: r.log, note: `${publisherOf(p).done}; Studio waits for it, then playtests the live site (a run appears in the dashboard). If it went wrong: the rollback plan.` };
  }
  const beta = plan.beta!;
  const log: string[] = [];
  let before: string | null;
  let after: string;
  let sourceAfter: string | null = null;
  let release: Draft | null = null;
  const fallbackCommits = [...(plan.commits as Commit[]), ...(plan.siteCommits as Commit[])].filter((c) => !c.title.startsWith(STUDIO_RELEASE));
  // Beta must still be the commit that was played (it could have moved while J read the plan).
  await fetchOrigin(source);
  if (shaOf(source, `origin/${BETA}`) !== beta.sha) throw new StudioError(`${BETA} moved since the plan was made; look at the plan again.`);
  if (!unity) {
    before = plan.main?.sha ?? null;
    // The release entry: a commit on beta on top of the playtested commit (already there when a restart cut this short).
    let target = beta.sha;
    if (plan.played && plan.played.sha === beta.sha) {
      try {
        opLog('writing the release notes');
        const r = await commitRelease(p, source, beta, fallbackCommits);
        release = r.release;
        if (r.sha && release) {
          target = r.sha;
          log.push(`${BETA}: ${releaseLine(release)} (${r.sha.slice(0, 7)}, on top of ${beta.short})`);
        }
      } catch (e: any) {
        log.push(`warning: no release entry this time (${String(e.message ?? e).split('\n')[0]}); going live without it`);
      }
    }
    // A plain push of the commit: git refuses anything that isn't a fast-forward (and pushing it again is a no-op).
    opLog(`pushing ${p.site}'s ${MAIN} to ${target.slice(0, 7)}`);
    log.push(must(await gitAsync(source, ['push', 'origin', `${target}:refs/heads/${MAIN}`]), `pushing ${MAIN}`) || `${MAIN} -> ${target.slice(0, 7)}`);
    after = target;
  } else {
    const copy = betaSiteDir(p);
    await fetchOrigin(site);
    before = shaOf(site, `origin/${MAIN}`);
    const b = betaBuild(p)!;
    // The website's beta must still be what the copy sits on (a page change could have merged while J read the plan).
    const siteBeta = shaOf(site, `origin/${BETA}`);
    if (siteBeta && siteBeta !== b.base && !gitIn(site, ['merge-base', '--is-ancestor', siteBeta, shaOf(copy, 'HEAD') ?? b.base]).ok) throw new StudioError(`${p.site}'s ${BETA} moved since the plan was made; look at the plan again.`);
    // The release entry goes into the website copy, inside the build commit (never stops going live).
    try {
      release = await addReleaseTo(p, betaSiteFolder(p), { source, target: beta.sha, build: String(b.version ?? beta.short), fallbackCommits, live: releasesAt(site, `origin/${MAIN}`, releasesPath(p)) });
      if (release && release.source !== 'existing') log.push(`${p.site}: ${releaseLine(release)}`);
    } catch (e: any) {
      log.push(`warning: no release entry this time (${String(e.message ?? e).split('\n')[0]}); going live without it`);
    }
    must(await gitAsync(copy, ['add', '-A']), 'git add');
    if (!(await gitAsync(copy, ['diff', '--cached', '--quiet'])).ok) {
      opLog(`committing the build${b.version ? ` (Game/v${b.version})` : ''}`);
      must(await gitAsync(copy, [...AUTHOR, 'commit', '--quiet', '-m', `Go live: ${p.name}${b.version ? ` Game/v${b.version}` : ''}${release ? ` ${release.version}` : ''} (${BETA} ${beta.short}, by ${by})`]), 'committing the build');
    }
    const head = shaOf(copy, 'HEAD')!;
    // A build commit not on main yet: just made, or made before a restart cut this short. Pushing it is the go live.
    if (before && head !== before && gitIn(copy, ['merge-base', '--is-ancestor', before, head]).ok) {
      opLog(`pushing ${p.site}'s ${MAIN} (the build: this can take a few minutes)`);
      // 90 minutes: a Unity build is about a gigabyte (Sick Of It's Game/v264 was 1.2 GB, pushed at ~0.4 MB/s), and a
      // push cut off at 30 minutes is a failed go live that has to send it all again.
      must(await gitAsync(copy, ['push', 'origin', `HEAD:refs/heads/${MAIN}`], 90 * 60_000), `pushing ${p.site}'s ${MAIN}`);
      after = head;
      log.push(`${p.site}: ${MAIN} -> ${after.slice(0, 7)} (the beta build${b.version ? `, Game/v${b.version}` : ''}${plan.siteCommits.length ? ` and ${plan.siteCommits.length} website commit(s) from ${BETA}` : ''})`);
      saveBetaBuild(p, { ...b, base: after });
      // The website's beta follows (a fast-forward: it then has the build too, so its main has nothing beta lacks). When
      // a page change merged meanwhile it can't: merging main into beta (the plan's fix) brings it in.
      const fb = await gitAsync(copy, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]);
      log.push(fb.ok ? `${p.site}: ${BETA} -> ${after.slice(0, 7)}` : `warning: ${p.site}'s ${BETA} wasn't fast-forwarded to the go live (${fb.err.split('\n').pop()}): merge ${MAIN} into ${BETA} before the next go live`);
    } else {
      after = before!;
      log.push(`${p.site}: the build is already live`);
    }
    // The source's main follows (it doesn't publish anything); a failure here is reported, not fatal.
    if (plan.commits.length) {
      const r = await gitAsync(source, ['push', 'origin', `${beta.sha}:refs/heads/${MAIN}`]);
      if (r.ok) sourceAfter = beta.sha;
      log.push(r.ok ? `${p.repo.split('/')[0]}: ${MAIN} -> ${beta.short}` : `warning: ${p.repo.split('/')[0]}'s ${MAIN} wasn't fast-forwarded: ${r.err.split('\n').pop()}`);
    }
  }
  for (const l of log) opLog(l);
  const id = newId('d');
  db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, 'deploy', p.site, before, after, plan.played?.sha ?? beta.sha, unity ? p.repo : null, unity ? plan.main?.sha ?? null : null, sourceAfter, plan.build?.version ?? null, by, `${plan.commits.length} commit(s): ${plan.commits.slice(0, 8).map((c) => c!.title).join('; ')}${plan.siteCommits.length ? ` · website ${plan.siteCommits.length} commit(s): ${plan.siteCommits.slice(0, 8).map((c) => c!.title).join('; ')}` : ''}`.slice(0, 1000), Date.now());
  await fetchOrigin(site);
  if (after !== before) void verifyLive(p.id, after, `Just went live (${BETA} ${beta.short}: ${plan.commits.slice(0, 3).map((c) => c!.title).join('; ')})`, origin);
  const rel = release && { version: release.version, title: release.title, notes: release.notes, build: release.build };
  return { ok: true, product: p.id, deploy: id, live: p.live, main: after.slice(0, 7), beta: beta.short, release: rel, log, note: `${publisherOf(p).done}; Studio waits for it, then playtests the live site (a run appears in the dashboard). If it went wrong: the rollback plan.` };
}

/** The go-live plan's players line: the live build's numbers from Hawkes Gen (builds, last 30 days), or null within 5 s. */
async function livePlayers(product: string): Promise<string | null> {
  try {
    const { liveBuildLine } = await import('./players.ts');
    const { gen } = await import('./gen.ts');
    const b = await Promise.race([gen.request(`/analytics/${encodeURIComponent(product)}/builds?range=30d`), new Promise<null>((ok) => setTimeout(() => ok(null), 5000).unref())]);
    return liveBuildLine(b);
  } catch {
    return null;
  }
}

/**
 * Web: the release entry as a commit on beta on top of the playtested commit, pushed (a fast-forward of beta: refused if
 * beta moved). sha: the new commit, or null when the entry was already there.
 */
async function commitRelease(p: ReturnType<typeof getProduct>, source: string, beta: Commit | { sha: string; short: string }, fallbackCommits: Commit[]) {
  const wt = await scratch(source, `${p.id}-release`, beta.sha);
  const release = await addReleaseTo(p, path.join(wt, path.dirname(releasesPath(p))), { source, target: beta.sha, build: beta.short, fallbackCommits, live: releasesAt(source, `origin/${MAIN}`, releasesPath(p)) });
  if (!release || release.source === 'existing') return { release, sha: null };
  must(await gitAsync(wt, ['add', releasesPath(p)]), 'git add');
  must(await gitAsync(wt, [...AUTHOR, 'commit', '--quiet', '-m', `${STUDIO_RELEASE} ${p.name} ${release.version}: ${release.title}`]), 'committing the release entry');
  must(await gitAsync(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]), `pushing ${BETA}`);
  await fetchOrigin(source);
  // The beta working copy (devtools saves) catches up, as after any merge into beta.
  void import('./dev.ts').then(({ pullDev }) => pullDev(p.id, 'after the release entry')).catch(() => {});
  return { release, sha: shaOf(wt, 'HEAD')! };
}

// ----------------------------------------------------------------- rollback

const lastLive = (product: string) => db.prepare(`SELECT * FROM deploys WHERE product = ? AND kind = 'deploy' AND rolled_back IS NULL ORDER BY at DESC LIMIT 1`).get(product) as DeployRow | undefined;

/**
 * The repo a rollback moves through GitHub's API (no checkout): a project's own GitHub repo, or a Unity game's website
 * on Cloud Run (no clone of it there). null: the local checkout as before.
 */
function rollbackSlug(p: Product): string | null {
  const own = githubSlugOf(p);
  if (own) return own;
  if (p.build && cloudGoLive()) return repoMap()[p.site.split('/')[0]] ?? null;
  return null;
}

/** The deploy rows a go live of `slug` made in the repos its builds went into (deploy-github.ts targets), not rolled back yet. */
function buildTargetsOf(slug: string, d: { id: string; after: string; beta?: string | null }) {
  return db.prepare("SELECT id, product, repo, before, after FROM deploys WHERE kind = 'deploy' AND source = ? AND source_after IN (?, ?) AND rolled_back IS NULL AND id != ?").all(slug, d.beta ?? d.after, d.after, d.id) as { id: string; product: string; repo: string; before: string | null; after: string }[];
}

async function githubRollbackPlan(p: Product, slug: string, io: GitHubIO = {}) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (managedElsewhere(p)) blockers.push(managedNote(p));
  const d = lastLive(p.id);
  if (!d) blockers.push(`No go live by Studio is recorded for ${p.name} (or each one was rolled back already), so the previous live commit isn't known. Roll back by hand (git revert on ${slug}).`);
  else if (!d.before) blockers.push(`The last go live (${d.id}) has no previous commit recorded.`);
  let refs: Awaited<ReturnType<typeof rollbackRefs>> = { main: null, to: null, undo: [] };
  try { refs = await rollbackRefs(slug, d?.before ?? null, io); } catch (e: any) { blockers.push(`GitHub: ${e.message}`); }
  const main = refs.main?.sha ?? null;
  if (!refs.main) blockers.push(`Studio can't read ${slug}'s ${MAIN} on GitHub.`);
  if (p.deploy?.via === 'ec2') warnings.push(`${p.name} runs on its own server with a database: a rollback puts the previous code back through the same CI and pull, but nothing in the database (accounts, credits, payments, migrations) is undone.`);
  if (d && main && main !== d.after) warnings.push(`${MAIN} moved since that go live (${d.after.slice(0, 7)} -> ${main.slice(0, 7)}): rolling back also undoes those commits.`);
  // The repos its builds went into in that go live (a Unity game's website): rolled back with it, or players keep the
  // build that went wrong (2026-10-31 review).
  const targets = d ? buildTargetsOf(slug, d) : [];
  if (d?.before && main === d.before && !targets.length) blockers.push(`${MAIN} already is ${d.before.slice(0, 7)}.`);
  if (targets.length) warnings.push(`It also rolls back ${targets.map((t) => `${t.repo} (to ${String(t.before ?? '?').slice(0, 7)})`).join(', ')}, where this go live put its build.`);
  return {
    product: p.id, name: p.name, live: p.live, repo: slug,
    main: brief(refs.main), to: brief(refs.to),
    deploy: d ? { id: d.id, at: d.at, by: d.by, after: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, detail: d.detail } : null,
    undo: refs.undo.map(brief), blockers, warnings, canRollback: !blockers.length,
    confirm: `ROLLBACK ${p.id}`,
    what: `A new commit on ${slug}'s ${MAIN} with the files of ${d?.before?.slice(0, 7) ?? '?'} (what was live before the last go live), made through GitHub; never a force push. ${BETA} keeps its commits: fix forward there, merge ${MAIN} into ${BETA}, playtest, and go live again.`,
    github: { slug, targets: targets.map((t) => ({ project: t.product, repo: t.repo, to: t.before, deploy: t.id })) },
  };
}

export async function rollbackPlan(productId: string, { io }: { io?: GitHubIO } = {}) {
  const p = getProduct(productId);
  const viaGitHub = rollbackSlug(p);
  if (viaGitHub) return githubRollbackPlan(p, viaGitHub, io);
  const { site } = repoDirs(p);
  const blockers: string[] = [];
  const warnings: string[] = [];
  await fetchOrigin(site);
  const main = shaOf(site, `origin/${MAIN}`);
  const d = lastLive(p.id);
  if (!d) blockers.push(`No go live by Studio is recorded for ${p.name} (or each one was rolled back already), so the previous live commit isn't known. Roll back by hand (git revert on ${p.site}).`);
  else if (!d.before) blockers.push(`The last go live (${d.id}) has no previous commit recorded.`);
  const undo = d?.before && main ? commitsIn(site, `${d.before}..${main}`) : [];
  if (p.deploy?.via === 'ec2') warnings.push(`${p.name} runs on its own server with a database: a rollback puts the previous code back through the same CI and pull, but nothing in the database (accounts, credits, payments, migrations) is undone.`);
  if (d && main && main !== d.after) warnings.push(`${MAIN} moved since that go live (${d.after.slice(0, 7)} -> ${main.slice(0, 7)}): rolling back also undoes those commits.`);
  if (d?.before && main === d.before) blockers.push(`${MAIN} already is ${d.before.slice(0, 7)}.`);
  if (managedElsewhere(p)) blockers.unshift(managedNote(p));
  return {
    product: p.id, name: p.name, live: p.live, repo: p.site,
    main: brief(main ? commitOf(site, main) : null), to: brief(d?.before ? commitOf(site, d.before) : null),
    deploy: d ? { id: d.id, at: d.at, by: d.by, after: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, detail: d.detail } : null,
    undo: undo.map(brief), blockers, warnings, canRollback: !blockers.length,
    confirm: `ROLLBACK ${p.id}`,
    what: `A new commit on ${p.site}'s ${MAIN} with the files of ${d?.before?.slice(0, 7) ?? '?'} (what was live before the last go live: its build and its pages); never a force push. ${BETA} keeps its commits: fix forward there, merge ${MAIN} into ${BETA} (it keeps ${BETA}'s files), playtest, and go live again.`,
  };
}

/** A rollback (pushing main, recording it) is a critical section too. */
export const rollback = (...a: Parameters<typeof rollbackNow>) => critical(`rolling back: ${a[0]}`, () => rollbackNow(...a));
async function rollbackNow(productId: string, { confirm, by = 'J', origin, io }: { confirm?: string; by?: string; origin?: string | null; io?: GitHubIO }) {
  const plan = await rollbackPlan(productId, { io });
  if (confirm !== plan.confirm) throw new StudioError(`Rolling back publishes ${plan.live}: ${plan.what} Show J the rollback plan, then send confirm: "${plan.confirm}" (J's call).`);
  if (plan.blockers.length) throw new StudioError(`Not rolling back:\n- ${plan.blockers.join('\n- ')}`);
  const p = getProduct(productId);
  const viaGitHub = rollbackSlug(p);
  if (viaGitHub) {
    const d = lastLive(p.id)!;
    // The repos its build went into first (what players see), then its own main when that moved.
    for (const t of buildTargetsOf(viaGitHub, d)) {
      if (!t.before) continue;
      const tr = await rollbackOnGitHub(t.repo, t.before, `${STUDIO_ROLLBACK} build of ${p.name} in ${t.repo} to ${t.before.slice(0, 7)} (undoes ${t.id}; by ${by})`, io).catch((e: any) => { if (/already has the files/.test(String(e.message))) return null; throw e; });
      const tid = newId('d');
      db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(tid, t.product, 'rollback', t.repo, tr?.before ?? t.after, tr?.after ?? t.before, by, `with ${p.name}'s rollback, undoing ${t.id}`, Date.now());
      db.prepare('UPDATE deploys SET rolled_back = ? WHERE id = ?').run(tid, t.id);
      const tp = (() => { try { return getProduct(t.product); } catch { return null; } })();
      if (tr && tp?.live) void verifyLive(tp.id, tr.after, `Just rolled back the build of ${p.name} (undoing ${t.id}). Check the live site works.`, origin);
    }
    if (d.before === plan.main?.sha) {
      db.prepare('UPDATE deploys SET rolled_back = ? WHERE id = ?').run('targets-only', d.id);
      return { ok: true, product: p.id, rollback: null, live: p.live, main: d.before!.slice(0, 7), to: d.before!.slice(0, 7), note: `Rolled back where its build went; its own ${MAIN} hadn't moved.` };
    }
    const r = await rollbackOnGitHub(viaGitHub, d.before!, `${STUDIO_ROLLBACK} ${p.name} to ${d.before!.slice(0, 7)} (undoes go live ${d.id}, ${d.after.slice(0, 7)}; by ${by})`, io, plan.main?.sha ?? null);
    const id = newId('d');
    db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, 'rollback', viaGitHub, r.before, r.after, by, `to ${d.before!.slice(0, 7)}, undoing ${d.id}`, Date.now());
    db.prepare('UPDATE deploys SET rolled_back = ? WHERE id = ?').run(id, d.id);
    await deployMain(p, r.after, origin).catch((e: any) => opLog(`couldn't start the Firebase deploy of the rollback: ${String(e?.message ?? e).slice(0, 300)}`));
    if (p.live) void verifyLive(p.id, r.after, `Just rolled back to ${d.before!.slice(0, 7)} (undoing ${d.after.slice(0, 7)}). Check the live site works.`, origin);
    return { ok: true, product: p.id, rollback: id, live: p.live, main: r.after.slice(0, 7), to: d.before!.slice(0, 7), note: `${publisherOf(p).done}; Studio then playtests live. ${BETA} still has the rolled-back commits: fix forward there.` };
  }
  const { site } = repoDirs(p);
  const d = lastLive(p.id)!;
  const wt = await scratch(site, `${p.id}-rollback`, plan.main!.sha);
  must(await gitAsync(wt, ['read-tree', '-u', '--reset', d.before!]), 'restoring the files');
  if ((await gitAsync(wt, ['diff', '--cached', '--quiet'])).ok) throw new StudioError(`${MAIN} already has the files of ${d.before!.slice(0, 7)}; nothing to roll back.`);
  must(gitIn(wt, [...AUTHOR, 'commit', '--quiet', '-m', `${STUDIO_ROLLBACK} ${p.name} to ${d.before!.slice(0, 7)} (undoes go live ${d.id}, ${d.after.slice(0, 7)}; by ${by})`]), 'committing the rollback');
  must(await gitAsync(wt, ['push', 'origin', `HEAD:refs/heads/${MAIN}`]), `pushing ${MAIN}`);
  const after = shaOf(wt, 'HEAD')!;
  const id = newId('d');
  db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, 'rollback', p.site, plan.main!.sha, after, by, `to ${d.before!.slice(0, 7)}, undoing ${d.id}`, Date.now());
  db.prepare('UPDATE deploys SET rolled_back = ? WHERE id = ?').run(id, d.id);
  gitIn(site, ['worktree', 'remove', '--force', wt]);
  await fetchOrigin(site);
  void verifyLive(p.id, after, `Just rolled back to ${d.before!.slice(0, 7)} (undoing ${d.after.slice(0, 7)}). Check the live site works.`, origin);
  return { ok: true, product: p.id, rollback: id, live: p.live, main: after.slice(0, 7), to: d.before!.slice(0, 7), note: `${publisherOf(p).done}; Studio then playtests live. ${BETA} still has the rolled-back commits: fix forward there.` };
}

// ------------------------------------------------------------------- live

/** owner/repo from the site repo's origin URL. */
export function repoSlug(site: string) {
  const url = git(site, ['remote', 'get-url', 'origin']).out;
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/);
  return m ? m[1] : null;
}

const gh = (args: string[]) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
};

// Waiting never keeps a process alive by itself (the CLI and tests exit; the service runs anyway).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Waits for GitHub to publish a commit (its Pages or Actions runs, through gh when signed in), then playtests live. */
export async function verifyLive(productId: string, sha: string, focus: string, origin?: string | null) {
  const p = getProduct(productId);
  if (!p.live) return;
  // A project with a GitHub repo has no checkout to read its origin from (a customer's Studio): its repo is known.
  const slug = githubSlugOf(p) ?? repoSlug(p.site);
  const end = Date.now() + 15 * 60_000;
  let published = false;
  const own = publisherOf(p).box;
  // A project that says which commit it runs (a web app with its own deploy: Product.versionPath): live answers with
  // this commit once its CI has deployed it.
  if (p.versionPath) {
    const { deployedOf, sameCommit } = await import('./deployed.ts');
    const until = Date.now() + 30 * 60_000;
    while (Date.now() < until && !published) {
      await sleep(20_000);
      published = sameCommit((await deployedOf(p, 'live'))?.commit, sha);
    }
    const t = p.playtests.find((x) => x.where === 'live');
    startPartial('playtest', p.id, { where: 'live', scenario: t?.scenario, mode: t?.mode, focus: `${focus} Check the live site works and nothing regressed.${published ? '' : ' (Live did not report the new commit within 30 minutes: say so.)'}`, origin });
    return;
  }
  // GitHub's API with the repo's own token (ghtoken.ts: J's for his repos, the GitHub App's for a customer's): Pages has
  // built this commit, or (sites that publish through a workflow, like Dose Of Destruction's pages.yml) every workflow
  // run for it finished.
  const token = slug ? (await (await import('./ghtoken.ts')).repoToken(slug).catch(() => null)) ?? process.env.GITHUB_TOKEN : process.env.GITHUB_TOKEN;
  if (slug && token) {
    const api = async (route: string) => {
      const r = await fetch(`https://api.github.com/repos/${slug}/${route}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      return r?.ok ? r.json() : null;
    };
    while (Date.now() < end && !published) {
      await sleep(20_000);
      if (own) {
        // The product's own server: its CI (every workflow but Studio's hook) is done; its box pulls a passing commit
        // on its own timer (2 minutes), so give it that and a little more before the live playtest.
        const runs: any = await api(`actions/runs?head_sha=${sha}&event=push`);
        const ci = (runs?.workflow_runs ?? []).filter((r: any) => !/hawkes-studio/i.test(`${r.name} ${r.path}`));
        if (ci.length && ci.every((r: any) => r.status === 'completed')) { published = true; await sleep(3 * 60_000); }
        continue;
      }
      const build: any = await api('pages/builds/latest');
      if (build?.commit === sha && build.status === 'built') published = true;
      // Hosts that report back on the commit (Netlify, Vercel, Cloudflare Pages, Firebase, Render: a commit status or a
      // deployment): published once they say so, instead of waiting out the 15 minutes (2026-10-31 review).
      const status: any = await api(`commits/${sha}/status`);
      const hosts = (status?.statuses ?? []).filter((x: any) => /netlify|vercel|cloudflare|firebase|render|deploy/i.test(String(x.context ?? '')));
      if (hosts.length && hosts.every((x: any) => x.state === 'success')) published = true;
      const deps: any = await api(`deployments?sha=${sha}&per_page=5`);
      for (const d of (Array.isArray(deps) ? deps : []).filter((x: any) => /prod|live|github-pages/i.test(String(x.environment ?? '')))) {
        const st: any = await api(`deployments/${d.id}/statuses?per_page=1`);
        if (Array.isArray(st) && st[0]?.state === 'success') published = true;
      }
      const runs: any = await api(`actions/runs?head_sha=${sha}&event=push`);
      const pagesRuns = (runs?.workflow_runs ?? []).filter((r: any) => /pages/i.test(`${r.name} ${r.path}`));
      if (pagesRuns.length && pagesRuns.every((r: any) => r.status === 'completed')) published = true;
    }
  } else if (slug && gh(['auth', 'status']).ok) {
    while (Date.now() < end && !published) {
      await sleep(20_000);
      const runs = gh(['api', `repos/${slug}/actions/runs?head_sha=${sha}`, '--jq', '[.workflow_runs[] | {status, conclusion}]']);
      try {
        const list = JSON.parse(runs.out || '[]') as { status: string; conclusion: string | null }[];
        if (list.length && list.every((r) => r.status === 'completed')) published = true;
      } catch {
        // Not readable yet.
      }
    }
  } else {
    await sleep((own ? 7 : 4) * 60_000);
  }
  const t = p.playtests.find((x) => x.where === 'live');
  startPartial('playtest', p.id, { where: 'live', scenario: t?.scenario, mode: t?.mode, focus: `${focus} Check the live site works and nothing regressed.`, origin });
}


// ------------------------------------------------------------------- the queue

/**
 * Going live and rolling back run as queued operations (ops.ts): an Approve tap or an API call is accepted at once, one
 * product goes at a time, two products at most in all, and Studio answers throughout (all git here is async). A restart
 * puts a running one back in the queue: going live again is a no-op once main is the approved beta commit.
 */
type LiveJob = { product: string; confirm: string; by?: string; origin?: string | null; beta?: string; approval?: string; mergeMain?: boolean };

/** The approval card an operation came from hears how it ended, and so does the conversation that asked. */
async function settleApproval(op: Op, ok: boolean, text: string) {
  const a = op.payload?.approval as string | undefined;
  if (a) db.prepare(`UPDATE approvals SET status = ?, result = ? WHERE id = ?`).run(ok ? 'approved' : 'failed', text.slice(0, 2000), a);
  const conv = op.origin ?? (a ? (db.prepare('SELECT conversation FROM approvals WHERE id = ?').get(a) as any)?.conversation : null);
  if (conv) await import('./talk.ts').then((t) => t.studioSays(conv, `${op.title}: ${text}`)).catch(() => {});
  // Going live failing is "something went wrong": J's phone hears it.
  if (!ok) await import('./notify.ts').then((n) => n.notify(`${op.title} failed`, text.slice(0, 300), { tags: ['warning'], priority: 4 })).catch(() => {});
}

registerOp('golive', async (j: LiveJob, ctx) => {
  ctx.step(j.mergeMain ? `merging main into ${j.product}'s beta` : `going live with ${j.product}`);
  try {
    return await deploy(j.product, { confirm: j.confirm, by: j.by, origin: j.origin, beta: j.beta, mergeMain: j.mergeMain, approval: j.approval });
  } catch (e: any) {
    // A second attempt after a restart that finds it already done: that's the first attempt's success.
    if (ctx.op.attempts > 1 && /Nothing to go live/.test(String(e.message))) {
      const d = db.prepare(`SELECT * FROM deploys WHERE product = ? AND kind = 'deploy' AND at >= ? ORDER BY at DESC LIMIT 1`).get(j.product, ctx.op.created) as DeployRow | undefined;
      if (d && (!j.beta || d.beta === j.beta)) return { ok: true, product: j.product, deploy: d.id, main: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, note: 'went live before Studio restarted' };
    }
    throw e;
  }
}, {
  done: (op) => settleApproval(op, true, op.result?.main ? `Live: main is ${op.result.main} (beta ${op.result.beta}).${op.result.release ? ` ${releaseLine(op.result.release)}.` : ''} ${op.result.note ?? ''}`.trim() : String(op.result?.detail ?? 'done')),
  failed: (op) => settleApproval(op, false, op.error ?? 'failed'),
});

registerOp('rollback', async (j: LiveJob, ctx) => {
  ctx.step(`rolling back ${j.product}`);
  return rollback(j.product, { confirm: j.confirm, by: j.by, origin: j.origin });
}, {
  done: (op) => settleApproval(op, true, `Rolled back: main is ${op.result?.main}. ${op.result?.note ?? ''}`.trim()),
  failed: (op) => settleApproval(op, false, op.error ?? 'failed'),
});

/** Queues going live (or a rollback) and returns at once: the operation, and where it is in the queue. */
export function queueLive(kind: 'golive' | 'rollback', j: LiveJob) {
  const p = getProduct(j.product);
  const title = kind === 'rollback' ? `Rolling back ${p.name}` : j.mergeMain ? `Merging main into ${p.name}'s beta` : `Going live with ${p.name}`;
  const op = enqueue(kind, { product: p.id, title, payload: j, by: j.by ?? null, origin: j.origin ?? null });
  return { op, ahead: queuePosition(op.id) };
}

/** Queues it and waits for it (the API and the CLI want the answer); Studio keeps answering meanwhile. */
export async function runLive(kind: 'golive' | 'rollback', j: LiveJob, maxMs = 45 * 60_000) {
  const { op } = queueLive(kind, j);
  const end = Date.now() + maxMs;
  for (;;) {
    const now = getOp(op.id)!;
    if (now.status === 'done') return now.result;
    if (now.status === 'failed') throw new StudioError(now.error ?? 'failed', 409);
    if (Date.now() > end) throw new StudioError(`${now.title} is still ${now.status} (${now.step ?? ''}); it carries on: see Activity.`, 202);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
