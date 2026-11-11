// Talk as J's PM: the loop that works the roadmap and the backlog with the agents, so J sets direction and comes back
// to test finished, verified work.
//
// Every minute (and right after anything finishes) the loop:
//   1. keeps every roadmap task's status current from its agent change (working, needs answer, review, merged) and,
//      after a merge, beta's build of it (followBuilds: a failed build sends the task back to an agent, the first time
//      without counting a try), beta's playtest of its criteria (verified) and go lives (live); items follow their tasks.
//      A milestone whose tasks are all merged and built gets ONE beta run playing its tasks' scenarios (milestoneCheck);
//      once that has judged their criteria, it's reached and J hears it (phone and Talk)
//   2. starts the next tasks in roadmap order, then the worst open bugs, within its caps (starts per day, agents at once,
//      one per product; a product's slot is also held by a change that is ready but not merged yet: fewer conflicts)
//   3. hands what needs judgment to a PM turn: a Talk turn in the day's "Studio PM" conversation (talk.ts) with the
//      events since the last one: changes to review, agent questions, failures, beta checks, the daily run, the daily
//      triage. Claude acts through the studio_pm tools: merges into beta what passed its criteria, sends failures back
//      with specific notes (3 tries, then J), answers agents from what J decided, triages the backlog
//   4. applies the defaults to whatever the PM turn left (or when no turn could run): merge if the gate passes (the
//      agent's checks passed and nothing contradicts the canon; a change is playtested only on request, and then its
//      playtest must not fail), else revise with what failed; beta's run judges the criteria after the merge; after 3 tries,
//      or an agent question nobody answered, J is asked
//
// Only real decisions reach J (askJ): direction, money, something still failing after 3 tries, anything touching
// live. Each is one question in Talk (the conversation that started the work, else the PM's) and on his phone.
// Every merge, won't-fix, start and answer is in the decision log (roadmap.ts pm_log), with undo where possible.
// Going live stays J's (DEPLOY <product>). Studio and Gen changes need J's approval (they restart services), except in
// walk-away mode (walkaway.ts), where they merge by themselves once green and the PM decides routine calls itself.

import { INFRA_FAILED_SQL, infraWaitMs, isInfraText, MAX_FINDING_STARTS_PER_DAY } from './infra-failure.ts';
import { isVideoTask } from './videos.ts';
import { unityBuildOf, buildProof, builtBy, buildFailedIn, includesMerge, missingScenarioSkips } from './betabuild.ts';
import { heldBuildRun, milestoneBuildDue, unityBuildGate } from './unitybuild-policy.ts';
import * as MB from './milestone-batch.ts';
import fs from 'node:fs';
import { critical, criticalSync } from './drain.ts';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { db, J, parse } from './db.ts';
import { DATA, PROJECTS, getProduct, getInfra, isInfra, today, StudioError, betaPlaytestsOn, loadInfra, loadProducts, managedElsewhereId, fileSig, CRITIC_DIMENSIONS, targetFor, releaseFloorOf } from './config.ts';
import {
  getTask, setTask, getItem, startableTasks, tasksAwaitingGpu, taskOfChange, addQuestion, listQuestions, getQuestion, setQuestion, addComment, isCommentSubject,
  logDecision, listDecisions, getDecision, markUndone, countToday, listItems, threadFor, milestonesToReach, markReached, getMilestone, milestoneTasks, setMilestoneChecks,
  itemProgress, gpuCleared, setStartWaitHook, GPU_WAIT, priceUnpriced, autoApproveWaiting, gpuDigestTasks, type Task, type Check, type TaskBuild, type Question,
  addItem, addTask, askedJ, landed, blockedBy, updateTask, taskWaits, DONE, adoptDoneDrops, tasksOf, waitingOn, STUCK_DEPENDENCY,
  pmLogVersion, unityGated, setBar,
} from './roadmap.ts';
import { gateTask, PHONE, splitPlays, focusWithGoals } from './taskbar.ts';
import { milestoneCriticStatus } from './critic-gate.ts';
import { askKey } from './playplan.ts';
import { gate, allMet, runVerdicts, changeVerdictHolds, localGitDeps, awaitingVerdict, SWEEP_MAX } from './acceptance.ts';
import { buildCancelled, cancelNote, cancelWords, repairCancelled } from './cancel.ts';
import { notify, PUBLIC_URL } from './notify.ts';
import { fileUrl, signFileLinks } from './gen.ts';
import { BETA, gitAsync, repoDirs, shaOf } from './beta.ts';
import { REF_LOCK } from './gitlock.ts';
import { buildErrors, pickCulprit } from './buildblame.ts';
import { heldRun, creditsWaitReason } from './creditwait.ts';
import { curationLine } from './memory.ts';
import { filesIn, type WorkShape } from './parallel.ts';
import { walkAwayDefaults, WALK_AWAY_BY, walkAwayOn, gpuAutoApproveLimit, type WalkAwaySettings } from './walkaway.ts';
import { customerStudio } from './tenancy.ts';
import { getFinding, updateFinding, takenBy } from './backlog.ts';
import { waitsForCurrentBuild, staleReport, staleNote } from './bugreport.ts';
import { notReached, slowNote, playTime, samplePace, whereTimeGoes, idleWatch, idleState, IDLE_SUBJECT } from './pace.ts';
import { harnessBlocked, harnessStopOf } from './brains.ts';
import { holdStatus, onHoldLifted } from './harness-hold.ts';
import { noProviderFree } from './providers.ts';
import { addWorktree } from './worktree.ts';
import { gateQuestion, settleQuestion, logCause } from './causes.ts';

// ---------------------------------------------------------------- settings

const FILE = path.join(DATA, 'pm.json');
export type PmSettings = {
  /** The loop runs (the pause switch). */
  enabled: boolean;
  /** Talk may merge agent changes into beta itself when they pass their checks (J chose this). Never live, never Studio or Gen. */
  delegatedMerges: boolean;
  /** Agent starts the PM makes per day (Max-plan usage). */
  maxStartsPerDay: number;
  /** Agents working at once that the PM will add to (it never starts one beyond this). Never below Agents' own max concurrent: pmSettings() raises it to that. */
  maxConcurrent: number;
  /** Tries per task (the first attempt and its revisions) before J is asked. */
  maxTries: number;
  /** Fill free slots with the worst open bugs once no roadmap task can start. */
  fixBugs: boolean;
  /** The daily PM turn (triage, plan the day) runs after this hour (server time), or when the daily run finishes. */
  dailyHour: number;
  /** Minutes a ready change waits for a PM turn before the defaults apply. */
  graceMinutes: number;
} & WalkAwaySettings;
// The defaults are read each time (walkaway.ts: a customer's Studio starts with walk-away off and no GPU caps).
const BASE = { enabled: true, delegatedMerges: true, maxStartsPerDay: 1000, maxConcurrent: 2, maxTries: 3, fixBugs: true, dailyHour: 9, graceMinutes: 15 };
const defaults = (): PmSettings => ({ ...BASE, ...walkAwayDefaults() });
const stored = (): Partial<PmSettings> => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
};
/** The ceiling Settings → Agents sets (agents.json, read here because agents.ts imports this file lazily). */
function agentsCeiling(): number {
  try {
    const n = JSON.parse(fs.readFileSync(path.join(DATA, 'agents.json'), 'utf8')).maxConcurrent;
    return typeof n === 'number' ? n : 0;
  } catch {
    return 0;
  }
}
/** What was saved or defaulted, before the agents' ceiling applies. */
const rawPmSettings = (): PmSettings => ({ ...defaults(), ...stored() });
/**
 * One ceiling (J, 2026-11-10: "6 of 4 used"): agents may run up to agents.maxConcurrent, so the PM's own "Agents at once"
 * can never be lower than it. It is the higher of the two, so the PM never refuses a start while agents have room, and
 * its capacity can't read over-full just because Agents allows more.
 */
export function pmSettings(): PmSettings {
  const s = rawPmSettings();
  return { ...s, maxConcurrent: Math.max(s.maxConcurrent, agentsCeiling()) };
}
/** Dollar caps of walk-away mode: 0 or more, at most this. */
const GPU_CAP_MAX = 1000;
export function savePmSettings(patch: Partial<PmSettings>, by = 'J') {
  const d = defaults();
  const cur = rawPmSettings();
  const next = { ...cur };
  const write: Record<string, unknown> = { ...stored() };
  for (const k of Object.keys(d) as (keyof PmSettings)[]) {
    if (patch[k] === undefined) continue;
    if (typeof d[k] !== typeof patch[k]) throw new StudioError(`${k} must be a ${typeof d[k]}`);
    if ((k === 'walkAwayGpuPerDay' || k === 'walkAwayGpuPerTask') && !((patch[k] as number) >= 0 && (patch[k] as number) <= GPU_CAP_MAX)) throw new StudioError(`${k}: 0 to ${GPU_CAP_MAX} dollars`);
    (next as any)[k] = patch[k];
    write[k] = patch[k];
  }
  // Only what was ever set is written (the defaults stay the defaults: a customer's walk-away isn't saved "on" by
  // saving another PM setting).
  fs.writeFileSync(FILE, JSON.stringify(write, null, 2));
  const changed = (Object.keys(patch) as (keyof PmSettings)[]).filter((k) => patch[k] !== undefined && cur[k] !== next[k]);
  if (changed.length) logDecision('settings', null, null, `${by} set ${changed.map((k) => `${k} = ${next[k]}`).join(', ')}`, { kind: 'settings', before: Object.fromEntries(changed.map((k) => [k, cur[k]])) });
  if (patch.enabled === true) kick();
  return next;
}

// State that survives restarts: the last daily turn, the PM conversation.
const STATE = path.join(DATA, 'pm-state.json');
type PmState = { daily?: string; conversation?: { id: string; day: string }; since?: number };
// Read once per version of the file (2026-11-10): heldFor/rescues/blockers per task parsed pm-state.json on every call,
// 270-700 ms of each event-loop freeze over a few hundred tasks. What state() returns is shared: read it, and copy
// (structuredClone) before changing anything, then saveState.
let stateMemo: { sig: string; v: PmState } | null = null;
const state = (): PmState => {
  const sig = fileSig(STATE);
  if (stateMemo?.sig === sig) return stateMemo.v;
  let v: PmState = {};
  try { v = JSON.parse(fs.readFileSync(STATE, 'utf8')) ?? {}; } catch { /* none yet */ }
  stateMemo = { sig, v };
  return v;
};
const saveState = (patch: Record<string, unknown>) => {
  const text = JSON.stringify({ ...state(), ...patch }, null, 2);
  fs.writeFileSync(STATE, text);
  // The memo is what was written (a copy: the caller may keep changing what it passed).
  stateMemo = { sig: fileSig(STATE), v: JSON.parse(text) };
};

// ----------------------------------------------------------------- helpers

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const changes = () => import('./agents.ts');
const name = (product: string) => { try { return isInfra(product) ? getInfra(product).name : getProduct(product).name; } catch { return product; } };
const ACTIVE = ['queued', 'working', 'verifying', 'revising'];
/** Changes an agent is actually running: capacity counts only these, never queued ones waiting for their product's slot. */
const RUNNING = ['working', 'verifying', 'revising'];

/** The squash commit of a pull request on a branch of the repo (its title ends with "(#<pr>)"), if it's there. */
function prCommit(repo: string, branch: string, pr: number) {
  const dir = path.join(PROJECTS, repo);
  if (!fs.existsSync(dir)) return null;
  const r = git(dir, ['log', `origin/${branch}`, '-F', `--grep=(#${pr})`, '--format=%H', '-n', '1']);
  return r.ok && r.out ? r.out : null;
}

// ------------------------------------------------------------------ events

export type PmEvent = { kind: string; subject?: string | null; product?: string | null; text: string; at: number };
let events: PmEvent[] = [];
/** What the PM's next turn will hear (tests). */
export const pendingPmEvents = () => events.slice();
/** Something the PM should look at in its next turn. */
export function pmEvent(kind: string, text: string, subject?: string | null, product?: string | null) {
  if (events.some((e) => e.kind === kind && e.subject && e.subject === subject)) return;
  events.push({ kind, subject: subject ?? null, product: product ?? null, text, at: Date.now() });
  kick();
}

let kicked: NodeJS.Timeout | null = null;
/** Runs the loop soon (several events in a few seconds share one pass). */
export function kick(ms = 3000) {
  // Only where the loop runs (the server, or STUDIO_PM=on): elsewhere edits just sit until the cloud sees them.
  if (kicked || !started) return;
  kicked = setTimeout(() => { kicked = null; void tick(); }, ms);
  kicked.unref?.();
}

// --------------------------------------------------------- task statuses

/**
 * Task statuses from their changes, beta checks and go lives. Runs every pass, even while the loop is paused (it
 * only records what happened; it starts and merges nothing).
 */
export async function syncTasks() {
  const { getChange } = await changes();
  // Every task's status from its changes first (a stale "working" or "failed" would hide what to do next).
  try {
    reconcileTasks();
  } catch (e: any) {
    console.warn(`[pm] reconcile: ${e.message ?? e}`);
  }
  for (const t of (db.prepare(`SELECT id FROM tasks WHERE status IN ('working', 'needs answer', 'review', 'merged', 'verified')`).all() as any[]).map((r) => getTask(r.id)!)) {
    // One task going wrong never stops the loop (and the starts after it): its note says why.
    try {
      await syncTask(t, getChange);
    } catch (e: any) {
      console.warn(`[pm] task ${t.id}: ${e.message ?? e}`);
      try { setTask(t.id, { note: `the PM couldn't follow it up: ${e.message ?? e}`.slice(0, 500) }); } catch {}
    }
  }
  // Beta's build after each merge, on its task ("did it work"); a failed one goes back to an agent.
  try {
    await followBuilds();
  } catch (e: any) {
    console.warn(`[pm] beta builds: ${e.message ?? e}`);
  }
  // Walk-away mode: investigations that finished let their held tasks go (judged again, or decided one by one).
  try {
    await releaseInvestigations();
  } catch (e: any) {
    console.warn(`[pm] investigations: ${e.message ?? e}`);
  }
  // Fixes in another repo that merged: the product they blocked builds beta again. Rescues whose scout reported: retried.
  for (const [what, f] of [['blockers', followBlockers], ['rescues', followRescues]] as const) {
    try {
      await f();
    } catch (e: any) {
      console.warn(`[pm] ${what}: ${e.message ?? e}`);
    }
  }
  // Items that just reached beta: J hears it's ready for him to test.
  for (const it of db.prepare(`SELECT id FROM items WHERE status = 'on beta' AND (note IS NULL OR note NOT LIKE '%[told ready]%')`).all() as any[]) announceReady(it.id);
  // Milestones whose tasks are all merged and built: one beta playtest judges their criteria, then J's moment to
  // playtest by hand (his phone, and Talk).
  await reachMilestones();
}

/**
 * Complete milestones: those already checking are followed one by one; those not yet checked are batched by product
 * (milestone-batch.ts), so a product plays once for all of them, and only once enough of its work is in.
 */
export async function reachMilestones() {
  const ready = milestonesToReach();
  const fresh: { id: string; product: string | null; items: number; since: number }[] = [];
  for (const m of ready) {
    if ((parse(m.checks ?? null) ?? []).length) {
      try { await milestoneCheck(m.id); } catch (e: any) { console.warn(`[pm] milestone ${m.id}: ${e.message ?? e}`); }
      continue;
    }
    if (!recheckDue(m.id, checkProducts(m.id).products)) continue;
    fresh.push({ id: m.id, product: m.product, items: (m as any).total ?? 0, since: MB.waitingSince(m.id) });
  }
  if (!fresh.length) return;
  const v = MB.batchVerdict(fresh, (product) => MB.milestonesComing(product, new Set(ready.map((m) => m.id))));
  for (const w of v.wait) {
    const m = getMilestone(w.id);
    const line = `milestone "${m?.title}": every task is in; it ${w.why}`;
    const last = listDecisions({ since: 0, action: 'milestone-batch', limit: 10_000 }).find((d) => d.subject === w.id);
    if (!last || !String(last.detail).startsWith(line.slice(0, line.indexOf(' item')))) logDecision('milestone-batch', w.id, m?.product ?? null, line);
  }
  for (const group of v.go) {
    try { await milestoneCheck(group[0], group); } catch (e: any) { console.warn(`[pm] milestones ${group.join(', ')}: ${e.message ?? e}`); }
  }
}

/** What a milestone's check plays: its merged tasks with criteria, its Unity projects (built once for it), every product it changed. */
function checkProducts(id: string) {
  const tasks = milestoneTasks(id).filter((t) => t.status === 'merged' && hasBeta(t.product) && t.criteria.length);
  const unity = [...new Set(milestoneTasks(id).filter((t) => ['merged', 'verified'].includes(t.status) && hasBeta(t.product) && unityGated(t.product)).map((t) => t.product))];
  const changed = milestoneTasks(id).filter((t) => ['merged', 'verified'].includes(t.status) && hasBeta(t.product)).map((t) => t.product);
  return { tasks, unity, products: [...new Set([...tasks.map((t) => t.product), ...unity, ...changed])] };
}

/** Studio and Gen have no beta lane: their changes merge into main, which deploys them. */
const hasBeta = (product: string) => {
  if (isInfra(product)) return false;
  // Handed over to another Studio (config.ts managedBy): its beta is run there (startBeta refuses it here).
  try { return !managedElsewhereId(getProduct(product).id); } catch { return false; }
};

async function syncTask(t: Task, getChange: (id: string) => any) {
  if (t.status === DONE) return; // already done: nothing to follow (a milestone's check passes every task here)
  const c = t.change ? getChange(t.change) : null;
  if (!c) return;
  if (t.status !== 'merged' && t.status !== 'verified') {
    // Parked on its Gen jobs (agents.ts WAITING_GEN): still working, without a slot (the roadmap says how far its jobs are).
    const next = ACTIVE.includes(c.status) || c.status === 'waiting on Gen' ? 'working' : c.status === 'needs answer' ? 'needs answer' : c.status === 'ready' ? 'review' : c.status === 'merged' ? mergedStatus(t, c) : null;
    if (next && next !== t.status) {
      setTask(t.id, { status: next, pr: c.pr_url, ...(next === 'merged' || next === GPU_WAIT ? { merged_at: c.merged_at ?? Date.now(), build: null } : {}), ...(c.verify?.criteria ? { checks: { where: 'change', at: Date.now(), change: c.id, ...(c.verify.played ? { sha: String(c.verify.played) } : {}), video: c.verify.video ?? null, verdict: c.verify.verdict, results: c.verify.criteria } } : {}), ...(c.verify?.try ? { try: c.verify.try } : {}) });
      if (next === 'merged') kick();
      if (next === GPU_WAIT) waitForGpu(t, c);
    }
    // A run for the real GPU art that failed (no server after all, nothing made): the stand-ins stay on beta, and the
    // task waits for GPU again, not a try.
    if (c.status === 'failed' && gpuRerunOf(c.id)) {
      setTask(t.id, { status: GPU_WAIT, merged_at: Date.now(), note: `the run for the GPU art (${c.id}) failed: ${String(c.detail ?? '').slice(0, 300)}` });
      logDecision('gpu-wait', t.id, t.product, `"${t.title}": ${c.id} (the run for its GPU art) failed: ${String(c.detail ?? '').slice(0, 300)}; it waits for a GPU server again (not a try)`);
      return;
    }
    // A failed change is the PM's (watch() tells it; the defaults restart it or ask J). A closed one is retried (closed by
    // the PM or walk-away) or asked of J (he closed it), never left failed (a couple of minutes first: J's "drop it"
    // closes the change, then drops the task).
    if (c.status === 'closed' && Date.now() - (c.updated ?? 0) > 2 * 60_000) afterClosed(t, c);
    // Cancelled (Activity's Cancel, or Talk): not a failure and not a try. The PM leaves it alone until someone resumes
    // or closes it; the task says so.
    if (c.status === 'cancelled' && !String(t.note ?? '').includes(`${c.id} was cancelled`)) {
      setTask(t.id, { note: `its agent change ${c.id} was cancelled ${cancelWords(cancelNote(`change:${c.id}`))}: not a failure and not a try; Resume or Close it in Activity` });
    }
    return;
  }
  // Studio and Gen: merged into main is deployed, and its checks were CI, the tests and the smoke check.
  if (t.status === 'merged' && isInfra(t.product)) {
    setTask(t.id, { status: 'verified', verified_at: Date.now() });
    logDecision('verified', t.id, t.product, `"${t.title}": merged into main (${name(t.product)} deploys itself; checked by CI, the tests and the smoke check), no beta run`);
    return;
  }
  // Merged: beta's playtest of the criteria (the beta run after the merge, pipeline.ts startBeta) decides.
  if (t.status === 'merged') await checkOnBeta(t);
  // Verified (or merged): live once a go live after the merge has its commit on main.
  const deploy = db.prepare(`SELECT * FROM deploys WHERE product = ? AND kind = 'deploy' AND rolled_back IS NULL AND at > ? ORDER BY at DESC LIMIT 1`).get(t.product, t.merged_at ?? 0) as any;
  if (deploy && c.pr && !liveChecked.has(`${t.id}:${deploy.id}`)) {
    liveChecked.add(`${t.id}:${deploy.id}`);
    await gitAsync(path.join(PROJECTS, c.repo), ['fetch', '--quiet', 'origin']);
    // Live once its commit is on main: from verified, or from merged when beta isn't played after merges (nothing
    // verifies it there, config.ts betaPlaytestsOn).
    const now = getTask(t.id)!.status;
    if (prCommit(c.repo, 'main', c.pr)) setTask(t.id, { status: now === 'verified' || (now === 'merged' && !betaPlaytestsOn()) ? 'live' : now, live_at: Date.now() });
  }
}

/** Go lives already looked at per task (one git fetch each, not one a minute). */
const liveChecked = new Set<string>();

/**
 * A review step's data, parsed once while it stays the same: every merged task reads its product's last ten beta reviews
 * on every pass, and parsing those (large) JSON blobs again per task froze Studio for over a second with 300 tasks
 * (2026-11-10, studio_ops: checkOnBeta). Keyed by step and the text's length and ends; at most 300 kept.
 */
const reviewMemo = new Map<string, { key: string; v: any }>();
function reviewData(id: string, text: string | null): any {
  const raw = text ?? '';
  const key = `${raw.length}:${raw.slice(0, 32)}:${raw.slice(-64)}`;
  const hit = reviewMemo.get(id);
  if (hit && hit.key === key) return hit.v;
  const v = parse(raw);
  reviewMemo.set(id, { key, v });
  if (reviewMemo.size > 300) reviewMemo.delete(reviewMemo.keys().next().value!);
  return v;
}

/** The beta check of a merged task: the newest beta review of its product since the merge that judged its criteria. */
async function checkOnBeta(t: Task) {
  if (!hasBeta(t.product)) return; // Nothing to run a beta check on (startBeta would throw).
  // Beta playtests are on request (J, 2026-10-17): no check is started for each merge here (a milestone's check plays
  // its tasks once, milestoneCheck); a beta review that did judge this task's criteria still decides it.
  const playsAfterMerges = betaPlaytestsOn();
  const s = pmSettings();
  // Its change's own playtest before the merge passed every criterion, and beta since touched none of its files.
  if (await carryChangeVerdict(t)) return;
  // Beta runs, and the daily run's plays of beta (they judge every merged task's criteria: acceptance.ts sweepCriteria).
  const steps = db.prepare(`SELECT s.*, r.kind AS run_kind, r.status AS run_status FROM steps s JOIN runs r ON r.id = s.run
    WHERE s.product = ? AND s.kind = 'review' AND r.kind IN ('beta', 'daily') AND s.started > ? ORDER BY s.started DESC LIMIT 10`).all(t.product, t.merged_at ?? 0) as any[];
  // Only reviews that judged this task's own criteria (a beta run checks whatever its starter asked: another task's, a fix's).
  // Never from a run that broke (stuck, a missing scenario, not built: brokenCheck): that's played again, not a miss. A
  // daily run plays live and phone too: only the play behind the review counts there. A review that judged merged
  // tasks in passing (data.sweep: their ids) counts only for those (beta had built them when it played).
  const parsedSteps = steps.map((x) => ({ ...x, data: reviewData(x.id, x.data) }));
  const usable = parsedSteps.filter((x) => Array.isArray(x.data?.criteria) && x.data.criteria.some((r: any) => t.criteria.includes(r?.criterion))
    && (!Array.isArray(x.data.sweep) || x.data.sweep.includes(t.id))
    && (x.run_kind === 'daily' ? playedClean(x.run, t.product, x.name) : !brokenCheck(x.run, t.product)));
  const judged = runVerdicts(usable, t.criteria);
  if (!judged) {
    // No beta check yet: start one if nothing is running for this product and the merge is a while ago (only looked up
    // when beta is played after merges: two more queries per merged task every pass otherwise, 2026-11-10 freezes).
    // A Unity project whose build of beta waits for the milestone's end: no check of its own (it would play nothing new).
    const due = playsAfterMerges && Date.now() - (t.merged_at ?? 0) > 45 * 60_000 && t.criteria.length && s.enabled && !(unityGated(t.product) && !unityBuildGate(t.product, 'auto').go);
    const running = due && db.prepare(`SELECT id FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ?`).get(`%"${t.product}"%`);
    const asked = due && !running && listDecisions({ since: Date.now() - 6 * 3600_000, action: 'beta-check' }).some((d) => d.subject === t.id);
    if (due && !running && !asked && !creditsWaitReason()) {
      const { getChange } = await changes();
      const c = getChange(t.change!);
      const { startBeta } = await import('./pipeline.ts');
      const split = t.criteria.some((k) => PHONE.test(k));
      const r = startBeta(t.product, { focus: focusWithGoals(`Checking "${t.title}" on beta.`, [t]), ...(split ? { plays: splitPlays(c?.verify?.scenario, c?.verify?.options, t.criteria), playtest: true } : { criteria: t.criteria, scenario: c?.verify?.scenario, options: c?.verify?.options }) });
      logDecision('beta-check', t.id, t.product, `started beta run ${r.id} to check "${t.title}" against its criteria`);
    }
    if (playsAfterMerges && !t.criteria.length && Date.now() - (t.merged_at ?? 0) > 2 * 3600_000) {
      // Nothing to judge: the beta run passing without a blocker is the check.
      const last = parsedSteps[0];
      if (last?.data?.verdict && last.data.verdict !== 'broken') setTask(t.id, { status: 'verified', verified_at: Date.now(), checks: { where: 'beta', at: last.started, run: last.run, verdict: last.data.verdict, results: [] } });
    }
    return;
  }
  const play = db.prepare(`SELECT data FROM steps WHERE run = ? AND kind = 'playtest' AND product = ? ORDER BY started DESC LIMIT 1`).get(judged.run, t.product) as any;
  const video = parse(play?.data)?.video ?? null;
  const results = judged.results;
  const checks = { where: 'beta' as const, at: judged.started, run: judged.run, video, verdict: judged.verdict ?? undefined, results };
  if (allMet(results, t.criteria)) {
    setTask(t.id, { status: 'verified', verified_at: Date.now(), checks });
    logDecision('verified', t.id, t.product, `"${t.title}": all ${t.criteria.length} criteria met on beta (run ${judged.run}${judged.sweep ? ", judged with the other merged tasks in that run's play" : ''})`);
    // A swept verdict needs nothing from the PM (no Talk turn for each of them).
    if (!judged.sweep) pmEvent('verified', `Task ${t.id} ("${t.title}", ${name(t.product)}) passed every criterion on beta.`, t.id, t.product);
    return;
  }
  if (getTask(t.id)!.checks?.run === judged.run) return; // Already handled this check.
  setTask(t.id, { checks });
  const missed = results.filter((r) => r.met !== 'yes');
  const why = missed.map((r) => `${r.criterion} (${r.met}: ${r.evidence ?? ''})`).join('; ');
  // A merged task is never started again by the loop: a second agent redoes the merged work and both land on beta
  // (k_da696e030f80, 2026-10-17: one "unclear" started a third change that merged a duplicate). Unclear isn't a miss:
  // the PM hears it and can ask for a playtest that reaches it. A real miss is J's call; "try again" puts the task back
  // to planned, which starts it fresh.
  // The scenario took longer than its budget: its agent is told (in a scenario fix or a retry's note) to start it nearer.
  const playData = parse(play?.data);
  const slow = playData?.slow ? ` Beta's playtest of it took ${playTime(Number(playData.seconds) || 0)}, ${slowNote(Number(playData.seconds) || 0) ?? 'over its budget'}.` : '';
  if (slow && !listDecisions({ since: 0, action: 'slow-scenario', limit: 10_000 }).some((d) => d.subject === t.id)) {
    // On the task's thread, so its next agent reads it in the brief.
    try { addComment(t.id, `Too slow to check:${slow} Start the scenario nearer what the criteria need (a named start point, "at").`, 'Studio PM'); } catch { /* not a thread subject */ }
    logDecision('slow-scenario', t.id, t.product, `"${t.title}":${slow}`.slice(0, 1000));
  }
  if (!missed.some((r) => r.met === 'no')) {
    // Judged in a play that wasn't its own scenario (the play before going live, the daily run): unclear only waits for a
    // play that shows it. Never an agent change for it (no new work or spend): its checks say what that play saw.
    if (judged.sweep) {
      logDecision('beta-check', t.id, t.product, `"${t.title}": judged in run ${judged.run}'s play of beta with the other merged tasks; nothing failed, unclear: ${why}`.slice(0, 1000));
      return;
    }
    // Unclear because the bot never got there (not reached, not seen): sent back ONCE as a scenario fix, not a try.
    const unseen = notReached(missed);
    if (unseen.length && await scenarioFix(t, unseen, judged.run, checks, slow)) return;
    logDecision('beta-check', t.id, t.product, `"${t.title}": on beta, nothing failed but unclear (run ${judged.run}): ${why}`.slice(0, 1000));
    pmEvent('beta check', `Task ${t.id} ("${t.title}", ${name(t.product)}) is merged; beta's run ${judged.run} couldn't tell for: ${why}. Nothing restarts; ask for a playtest that reaches it if it matters.`, t.id, t.product);
    return;
  }
  // Walk-away mode: the PM decides it (try again, park, or one investigation for many), never a question per task.
  if (walkAwayOn()) {
    await decideMiss(getTask(t.id)!, { where: 'beta', at: judged.started, run: judged.run, video, verdict: judged.verdict ?? undefined }, judged.all);
    return;
  }
  setTask(t.id, { status: 'failed', note: `on beta: ${why}`.slice(0, 1000) });
  askJ(`"${t.title}" (${name(t.product)}) is merged into beta but misses criteria there (try ${t.tries} of ${s.maxTries}): ${why}. Try again on top of beta, change the criteria, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change the criteria', 'drop it'] });
}

/** Carry checks already made per task and change (one git comparison each, not one a minute). */
const carryTried = new Set<string>();

/**
 * A merged task whose change's own playtest before the merge (its showcase) met every criterion: once beta built it,
 * that is its verdict, unless beta changed the same files since that play (acceptance.ts changeVerdictHolds). Once per
 * task and change; otherwise beta's plays judge it. Returns whether it was verified.
 */
export async function carryChangeVerdict(t: Task, deps?: Parameters<typeof changeVerdictHolds>[2]) {
  if (!t.criteria.length || !t.change || t.build?.ok !== true || t.checks?.where !== 'change' || t.checks.change !== t.change) return false;
  const key = `${t.id}:${t.change}`;
  if (carryTried.has(key)) return false;
  carryTried.add(key);
  const { getChange } = await changes();
  const c = getChange(t.change);
  if (!c || c.status !== 'merged') return false;
  const dir = path.join(PROJECTS, c.repo);
  if (!deps && !fs.existsSync(dir)) return false;
  const r = await changeVerdictHolds(c, t.criteria, deps ?? localGitDeps(dir, c.base, c.pr));
  const now = getTask(t.id);
  if (!now || now.status !== 'merged') return false;
  if (!r.holds) {
    logDecision('carry', t.id, t.product, `"${t.title}": its change's playtest before the merge is not its verdict on beta: ${r.why}; beta's plays judge it`.slice(0, 1000));
    return false;
  }
  setTask(t.id, { status: 'verified', verified_at: Date.now(), checks: { ...t.checks, carried: r.why } });
  logDecision('verified', t.id, t.product, `"${t.title}": ${r.why}`.slice(0, 1000));
  return true;
}

/**
 * The merged tasks the play before going live judges (golive-policy.ts playBeforeGoLive): merged and not verified yet,
 * whose merge commit is an ancestor of the beta commit it plays (a task merged after that commit isn't in the build
 * played), and only those whose criteria need no scenario the play doesn't already run (playsFor: the product's default
 * beta scenario on desktop; a task's own scenario or a phone play would be a playtest of its own). Whole tasks, up to
 * SWEEP_MAX criteria. `deps` are the tests'.
 */
export async function coveredByBetaPlay(product: string, betaSha: string, deps: { merge?: (t: Task) => Promise<{ slug: string; sha: string } | null>; includes?: typeof includesMerge; tasks?: Task[] } = {}): Promise<{ criteria: string[]; tasks: string[] }> {
  const out = { criteria: [] as string[], tasks: [] as string[] };
  if (!betaSha || !hasBeta(product)) return out;
  const { betaPlaytestOf } = await import('./pipeline.ts');
  const dflt = betaPlaytestOf(getProduct(product))?.scenario;
  for (const t of deps.tasks ?? awaitingVerdict(product)) {
    const own = await playsFor([t]);
    if (!own.length || own.some((p) => p.device === 'phone' || p.options || (p.scenario && p.scenario !== dflt))) continue;
    try {
      const m = await (deps.merge ?? mergeOf)(t);
      if (!m) continue;
      const gt = deps.includes ? null : await import('./ghtoken.ts');
      const gh = gt ? gt.githubFetch(await gt.repoToken(m.slug)) : (undefined as never);
      const inside = await (deps.includes ?? includesMerge)(m.slug, m.sha, betaSha, gh);
      if (inside !== true) continue;
    } catch { continue; }
    const add = [...new Set(t.criteria)].filter((k) => !out.criteria.includes(k));
    if (out.criteria.length && out.criteria.length + add.length > SWEEP_MAX()) continue;
    out.criteria.push(...add);
    out.tasks.push(t.id);
  }
  return out;
}

/** A daily run's play behind a review: done, and not stuck (the rest of a daily run says nothing about it). */
function playedClean(run: string, product: string, name: string) {
  const x = db.prepare(`SELECT status, detail, data FROM steps WHERE run = ? AND product = ? AND kind = 'playtest' AND name = ? ORDER BY started DESC LIMIT 1`).get(run, product, name) as any;
  return Boolean(x) && x.status === 'done' && !/\bstuck\b/i.test(String(x.detail ?? '')) && parse(x.data)?.outcome !== 'stuck';
}

/**
 * A merged task whose criteria came back unclear because the bot never reached them (pace.ts notReached): sent back
 * ONCE as a scenario fix (J, 2026-10-19: "unclear is not a free retry"): a change from beta whose agent makes the
 * scenario reach each criterion and log it, without touching the feature. Not a try. A second "not reached" is left
 * to the PM and the milestone's checks as before. Returns whether it was sent.
 */
async function scenarioFix(t: Task, unseen: Check[], run: string, checks: TaskChecks, slow = '') {
  if (!pmSettings().enabled) return false;
  if (listDecisions({ since: 0, action: 'scenario-fix', limit: 10_000 }).some((d) => d.subject === t.id)) return false;
  const { getChange } = await changes();
  const v = t.change ? getChange(t.change)?.verify : null;
  const what = unseen.map((r) => `${r.criterion} (${r.evidence ?? 'unclear'})`).join('; ');
  const note = `Beta's playtest (run ${run}) never reached these criteria, so it couldn't judge them: ${what}.${slow}\n\nYour task's work is already merged on beta (this branch starts from it) and nothing says it is wrong: don't redo or change the feature. Fix the playtest scenario${v?.scenario ? ` "${v.scenario}"` : ''} so the bot gets to each of these through real input and logs an event that shows it, and name it in .hawkes/scenario.txt. If it replays a long way from the start, start it nearer: a named start point the game takes ("at" in the scenario's options, hawkesstudio docs/playtest.md), e.g. a second line {"at":"<place>"} in .hawkes/scenario.txt. Keep it under 10 minutes.`;
  setTask(t.id, { status: 'planned', checks });
  try {
    await startTaskChange(getTask(t.id)!, note, `a scenario fix: beta's playtest never reached ${unseen.length} criteria (not a try)`, false);
  } catch (e: any) {
    setTask(t.id, { status: 'merged', note: `couldn't send it back for a scenario fix: ${e.message}`.slice(0, 500) });
    return false;
  }
  logDecision('scenario-fix', t.id, t.product, `"${t.title}": beta run ${run} never reached ${unseen.map((r) => `"${r.criterion}"`).join(', ')}: sent back once to fix its scenario (not a try)`.slice(0, 1500));
  pmEvent('scenario fix', `Task ${t.id} ("${t.title}", ${name(t.product)}): beta's run ${run} never reached: ${what}. Sent back once to fix its playtest scenario (not a try).`, t.id, t.product);
  return true;
}
type TaskChecks = NonNullable<Task['checks']>;

// ------------------------------------------------------------ beta builds

/** A Unity project Studio builds from GitHub (its `builds`): its beta runs build beta's head first (betabuild.ts). */
/** A Unity project Studio builds from GitHub (its `builds`): its beta build proves a task (buildProof). */
const unityStudioBuilt = (product: string) => { try { return Boolean(unityBuildOf(getProduct(product))); } catch { return false; } };

/**
 * What a beta run's build proves for one task (betabuild.ts buildProof): the commit the run built or kept must include the
 * task's merge commit (its pull request's, compared on GitHub). Not a Unity project Studio builds: always fine.
 */
export async function proofFor(product: string, t: Task, runId: string, deps: { merge?: (t: Task) => Promise<{ slug: string; sha: string } | null>; includes?: typeof includesMerge } = {}) {
  if (!unityStudioBuilt(product)) return undefined;
  const built = builtBy(runId, product);
  // A build that broke is a failed build (buildOf reads its error), not "built nothing" (betabuild.ts buildFailedIn).
  if (!built && buildFailedIn(runId, product)) return undefined;
  if (!built) return buildProof({ unity: true, built: null, includes: null });
  let includes: boolean | null = null;
  try {
    const m = await (deps.merge ?? mergeOf)(t);
    if (m) {
      const { repoToken, githubFetch } = await import('./ghtoken.ts');
      includes = await (deps.includes ?? includesMerge)(m.slug, m.sha, built.sha, githubFetch(await repoToken(m.slug)));
    }
  } catch { /* couldn't tell */ }
  return buildProof({ unity: true, built, includes });
}

/** A task's merge commit on GitHub: its change's pull request (merge_commit_sha) in the project's repo. */
async function mergeOf(t: Task): Promise<{ slug: string; sha: string } | null> {
  const { getChange } = await changes();
  const c = t.change ? getChange(t.change) : null;
  const slug = String((getProduct(t.product) as any).github ?? '');
  if (!c?.pr || !slug) return null;
  const { repoToken, githubFetch } = await import('./ghtoken.ts');
  const r = await githubFetch(await repoToken(slug))(`https://api.github.com/repos/${slug}/pulls/${c.pr}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio' } });
  const sha = r.ok ? ((await r.json()) as any)?.merge_commit_sha : null;
  return sha ? { slug, sha: String(sha) } : null;
}

/** A beta run's result as a task's build: OK unless a step before the playtest failed (the repo, pre-deploy build, Unity build). */
export function buildOf(product: string, r: { id: string; status: string; detail?: string | null; finished?: number | null }, proof?: { ok: boolean; why: string | null }): TaskBuild {
  const failed = (db.prepare(`SELECT kind, name, detail FROM steps WHERE run = ? AND product = ? AND status = 'failed' AND kind NOT IN ('playtest', 'review')`).all(r.id, product) as any[])
    // A fetch race in Studio's own repo step (two fetches of one repo) says nothing about the build: never a failure.
    .filter((x) => !(x.kind === 'repo' && REF_LOCK.test(String(x.detail ?? ''))));
  let unity = false;
  try { const gp = getProduct(product); unity = Boolean(gp.build) || Boolean(unityBuildOf(gp)); } catch { /* gone from products.json */ }
  // A Unity project Studio builds from GitHub: only a run that built a commit with the task's merge counts (betabuild.ts).
  if (proof && !proof.ok) return { ok: false, unproven: true, run: r.id, at: r.finished ?? Date.now(), unity, detail: `not built by beta run ${r.id}: ${proof.why}`.slice(0, 1200) };
  // Failed only in its playtest (a milestone's check): built. Failed with no failed step (the run itself threw): not.
  const steps = (db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run = ? AND status = 'failed'`).get(r.id) as any).n as number;
  const ok = !failed.length && (r.status === 'done' || steps > 0);
  const why = failed.map((x) => `${x.kind} ${x.name}: ${String(x.detail ?? '').slice(0, 400)}`).join('; ') || String(r.detail ?? 'the beta run failed');
  return { ok, run: r.id, at: r.finished ?? Date.now(), unity, detail: ok ? `built OK${unity ? ' (the Unity build compiled)' : ''} in beta run ${r.id}` : `beta's build failed (run ${r.id}): ${why}`.slice(0, 1200) };
}

/**
 * Beta's build after each merge, on its task ("did it work", J 2026-10-18): the newest beta run of the product that
 * started after the task's change merged and finished (a superseded run is skipped: the newer one built it). OK: the
 * task is on beta (Unity: it compiled). Failed: the error is on the task, and ONE task goes back to an agent with the
 * build's error lines (decideFailedBuild: the one whose change touched the files they name, else the one merged last;
 * nothing while beta has moved since that build or a fix for it is underway). No beta run after a merge: one is started.
 */
export async function followBuilds(deps?: Parameters<typeof carryChangeVerdict>[1]) {
  const { getChange } = await changes();
  await settleCancelledBuilds(getChange);
  const byProduct = new Map<string, { t: Task; at: number }[]>();
  for (const r of db.prepare(`SELECT id FROM tasks WHERE status = 'merged'`).all() as any[]) {
    const t = getTask(r.id)!;
    if (!hasBeta(t.product)) continue;
    // Changes merged before Studio recorded when: the PM's record of it, a little earlier (it notices within a tick).
    const at = (t.change ? getChange(t.change)?.merged_at : null) ?? Math.max(0, (t.merged_at ?? 0) - 5 * 60_000);
    byProduct.set(t.product, [...(byProduct.get(t.product) ?? []), { t, at }]);
  }
  for (const [product, list] of byProduct) {
    const since = Math.min(...list.map((x) => x.at));
    // A run whose build was cancelled (J, Talk, the PM or Gen) built nothing: it is neither a build nor a failed one, and
    // the "nothing built the newest merge" check below starts another (cancel.ts).
    // A run whose Unity build was held (unitybuild-policy.ts) built nothing either: its tasks wait for the milestone's build.
    const runs = (db.prepare(`SELECT id, status, detail, started, finished FROM runs WHERE kind = 'beta' AND products LIKE ? AND started >= ? ORDER BY started DESC, rowid DESC`).all(`%"${product}"%`, since) as any[])
      .filter((x) => !buildCancelled(x.id, product) && !heldRun(x.id) && !heldBuildRun(x.id, product));
    // Beta's Unity build waits for a milestone's end with nothing else queued: no beta run of its own is started for a
    // merge meanwhile (it would only be held again); the milestone's check builds it (milestoneCheck). Asked only when a
    // start is otherwise due: reading the project's work every pass for every product froze Studio before (2026-11-10).
    let held: boolean | undefined;
    const unityHeld = () => (held ??= unityGated(product) && !unityBuildGate(product, 'auto').go);
    // A run refused for credits built nothing and says nothing about the change: never blamed (creditwait.ts).
    for (const { t } of list) if (t.build?.run && (buildCancelled(t.build.run, product) || heldRun(t.build.run))) setTask(t.id, { build: null });
    const finished = runs.filter((x) => ['done', 'failed', 'partial'].includes(x.status));
    for (const { t, at } of list) {
      const r = finished.find((x) => x.started >= at);
      if (r && t.build?.run !== r.id) {
        setTask(t.id, { build: buildOf(product, r, await proofFor(product, t, r.id)) });
        // Its change's own playtest met every criterion and beta's build of a commit with the merge succeeded: verified now,
        // no beta run for it. A failed build leaves it merged (carryChangeVerdict needs build.ok).
        const now = getTask(t.id);
        if (now?.build?.ok === true) await carryChangeVerdict(now, deps).catch((e: any) => console.warn(`[pm] carry ${t.id}: ${e.message ?? e}`));
      }
    }
    // Nothing built the newest merge (startBeta threw, a restart lost it): a beta build of its own, once.
    const last = list.reduce((a, b) => (a.at >= b.at ? a : b));
    if (!runs.some((x) => x.started >= last.at) && Date.now() - last.at > 20 * 60_000 && pmSettings().enabled && !creditsWaitReason() && !betaBuildSpent(product, last.at) && !unityHeld()) {
      const { startBeta } = await import('./pipeline.ts');
      const r = startBeta(product, { focus: `Building beta after "${last.t.title}" merged.`, playtest: false });
      logDecision('beta-build', last.t.id, product, `no beta run built "${last.t.title}" after its merge: started ${r.id}`);
    }
    // The newest finished run failed: ONE task goes back to an agent (once per run): the one whose change touched the
    // files the build's errors name, else the one merged last.
    const newest = finished[0];
    if (!newest) continue;
    // A run that built nothing that includes a task's merge (betabuild.ts) proves nothing about it: never blamed on the task;
    // beta is built once more (a Unity project's beta run builds its head first).
    const unproven = list.filter((x) => { const b = getTask(x.t.id)?.build; return Boolean(b && b.run === newest.id && b.unproven); });
    if (unproven.length && pmSettings().enabled && !creditsWaitReason() && !betaBuildSpent(product, newest.started) && !unityHeld()) {
      const { startBeta } = await import('./pipeline.ts');
      const r = startBeta(product, { focus: `Building beta's head: run ${newest.id} didn't build a commit with ${unproven.map((x) => `"${x.t.title}"`).join(', ')}.`, playtest: false });
      logDecision('beta-build', unproven[0].t.id, product, `beta run ${newest.id} built nothing that includes ${unproven.length} merged task(s): started ${r.id}, which builds beta's head first`);
    }
    const hit = list.map((x) => ({ ...x, t: getTask(x.t.id)! })).filter((x) => x.t.status === 'merged' && x.t.build?.run === newest.id && !x.t.build?.ok && !x.t.build?.unproven);
    if (!hit.length || deciding.has(newest.id) || listDecisions({ since: newest.started, action: 'build-failed', limit: 10_000 }).some((d) => d.subject === newest.id)) continue;
    deciding.add(newest.id);
    try {
      await decideFailedBuild(product, newest, runs, hit);
    } finally {
      deciding.delete(newest.id);
    }
  }
}

/**
 * Whether the PM's own beta build for a product since `since` is spent: a run it started still runs or ran a build. A run
 * that was held (Unity hold, credits) or cancelled built nothing, so its decision doesn't stop the next start: before
 * 2026-11-11 the decision alone counted, and merged work waited for the next merge (or for ever) once one start was held.
 * A decision whose run Studio no longer has counts (nothing to tell), so this never starts runs back to back.
 */
export function betaBuildSpent(product: string, since: number): boolean {
  return listDecisions({ since, action: 'beta-build', limit: 10_000 }).some((d) => {
    if (d.product !== product) return false;
    const run = /started (r_[0-9a-f]+)/.exec(String(d.detail ?? ''))?.[1];
    if (!run || !db.prepare('SELECT 1 FROM runs WHERE id = ?').get(run)) return true;
    return !(buildCancelled(run, product) || heldRun(run) || heldBuildRun(run, product));
  });
}

/**
 * What a cancel in Hawkes Gen left behind as "failed" (run r_f75a40eec26e, 2026-10-26: Talk cancelled a queued Unity
 * build, the run recorded a failed build, and a task went back to an agent to "fix the compile errors"): the steps and
 * runs read cancelled, and an agent change sent back for such a run's build is cancelled too (by the PM, with the reason).
 */
async function settleCancelledBuilds(getChange: (id: string) => any) {
  try { repairCancelled(); } catch (e: any) { console.warn(`[pm] repairing cancelled runs: ${e.message ?? e}`); }
  const cancelledRuns = new Set((db.prepare(`SELECT DISTINCT run FROM steps WHERE kind = 'build' AND status = 'cancelled'`).all() as any[]).map((x) => x.run as string));
  if (!cancelledRuns.size) return;
  const { cancelChange } = await changes();
  for (const c of db.prepare(`SELECT id, request, status, task FROM changes WHERE status IN ('queued', 'working', 'verifying', 'revising') AND request LIKE '%build failed after your change%'`).all() as any[]) {
    const run = [...cancelledRuns].find((r) => String(c.request).includes(r));
    if (!run) continue;
    const reason = `beta's build in run ${run} was cancelled, not failed: there is no compile error to fix`;
    await cancelChange(c.id, 'the PM', reason).catch((e: any) => console.warn(`[pm] cancel ${c.id}: ${e.message ?? e}`));
    const t = c.task ? getTask(c.task) : null;
    if (t) {
      const prior = t.changes.filter((x) => x !== c.id).map((x) => getChange(x)).filter((x) => x?.status === 'merged').pop();
      setTask(t.id, { status: 'merged', change: prior?.id ?? t.change, merged_at: prior?.merged_at ?? prior?.created ?? Date.now(), build: null, note: `beta's build was cancelled (run ${run}), not failed; waiting for the next beta run` });
      logDecision('cancelled', t.id, t.product, `"${t.title}": ${reason}; its send-back ${c.id} was cancelled and the build is not counted against it`);
    }
  }
}

/** Failed beta runs being decided now (decideFailedBuild awaits GitHub and Gen: a second pass mustn't decide it too). */
const deciding = new Set<string>();

/**
 * A failed beta build, decided once (its 'build-failed' decision): wait when beta moved since the commit it built (the
 * newer commit's build decides: a later merge may have fixed it), or when a send-back for beta's build is still being
 * worked on; else send ONE task back, with the build's error lines.
 */
async function decideFailedBuild(product: string, run: { id: string; started: number; finished?: number | null }, runs: any[], hit: { t: Task; at: number }[]) {
  const step = db.prepare(`SELECT job, data FROM steps WHERE run = ? AND product = ? AND kind = 'build' ORDER BY started DESC LIMIT 1`).get(run.id, product) as any;
  const data = parse(step?.data ?? null) ?? {};
  const built = typeof data.beta === 'string' ? data.beta : '';
  const now = betaHead(product);
  if (built && now && !now.startsWith(built) && !built.startsWith(now)) {
    const newer = runs.find((x) => x.status === 'running' && x.started > run.started);
    logDecision('build-failed', run.id, product, `beta's build of ${built.slice(0, 7)} failed, but beta has moved to ${now.slice(0, 7)} since: nothing sent back; ${newer ? `beta run ${newer.id} builds it` : 'building it'}, and that build decides`);
    if (!newer && pmSettings().enabled && !creditsWaitReason()) {
      const { startBeta } = await import('./pipeline.ts');
      const r = startBeta(product, { focus: `Building beta's newest commit after the build of ${built.slice(0, 7)} failed.`, playtest: false });
      logDecision('beta-build', run.id, product, `beta moved since the failed build of ${built.slice(0, 7)}: started ${r.id} for ${now.slice(0, 7)}`);
    }
    return;
  }
  // The fix is in another repo (an agent said so, fileBlocker): beta builds again once that merges (followBlockers).
  const blocker = blockerOf(product);
  if (blocker) {
    logDecision('build-failed', run.id, product, `beta's build failed while the fix in ${name(blocker.b.target)} ("${getTask(blocker.fix)?.title ?? blocker.fix}", ${blocker.fix}) is underway: nothing more sent back; beta builds again once it merges`);
    return;
  }
  // A task already sent back for beta's build (a failed build before this one) is still being fixed: its merge builds
  // beta again; a second agent on the same error is what this prevents. Only while an agent really is on it: a task
  // that sits with no change going fixes nothing (J, 2026-10-19: Yooba Land's tasks waited for a build that never came).
  const fixing = listDecisions({ since: Date.now() - 14 * 86400_000, action: 'build-sendback', limit: 10_000 })
    .filter((d) => d.product === product).map((d) => (d.subject ? getTask(d.subject) : null))
    .find((x) => x && ['planned', 'working', 'needs answer', 'review'].includes(x.status) && hasLiveChange(x.id));
  if (fixing) {
    logDecision('build-failed', run.id, product, `beta's build failed again while "${fixing.title}" (${fixing.id}) is still fixing it: nothing more sent back; its merge builds beta again`);
    return;
  }
  const log = await buildLog(step, data);
  const errors = buildErrors(log);
  const { getChange, github } = await changes();
  // What each task's merged changes touched (asked only when the errors name files).
  const filesOf = async (t: Task) => {
    const out: string[] = [];
    for (const id of new Set([...(t.changes ?? []), ...(t.change ? [t.change] : [])])) {
      const c = getChange(id);
      if (!c?.pr || !c.slug) continue;
      const files: any[] = await github(`/repos/${c.slug}/pulls/${c.pr}/files?per_page=100`).catch(() => []);
      out.push(...(Array.isArray(files) ? files.map((f) => String(f.filename)) : []));
    }
    return out;
  };
  const candidates = await Promise.all(hit.map(async (x) => ({ ...x, files: errors.files.length ? await filesOf(x.t) : [] })));
  const { culprit: pick, matched } = pickCulprit(candidates, errors.files);
  const culprit = pick.t;
  const why = matched.length ? `its change touched ${matched.join(', ')}, named in the build's errors` : hit.length > 1 ? 'merged last (the errors name no file another change touched)' : 'the only change merged since the last build';
  logDecision('build-failed', run.id, product, `beta's build failed after "${culprit.title}" (${culprit.id}) merged (${why}): ${culprit.build!.detail}`.slice(0, 1500));
  await buildSendBack(culprit, { errors: errors.lines, matched });
}

/** Beta's newest commit for a product (its source checkout's origin/beta), or null. */
export function betaHead(product: string) {
  try {
    const dir = repoDirs(getProduct(product)).source;
    return fs.existsSync(dir) ? shaOf(dir, `origin/${BETA}`) : null;
  } catch {
    return null;
  }
}

/** A failed build's Unity log: the whole log from its Hawkes Gen job when there is one, else what the step kept. */
async function buildLog(step: any, data: any) {
  const kept = [...(Array.isArray(data.errors) ? data.errors : []), String(data.logTail ?? ''), String(data.error ?? '')].join('\n');
  if (!step?.job) return kept;
  try {
    const { gen } = await import('./gen.ts');
    const job = await gen.job(step.job);
    const out = (job?.outputs ?? []).find((x: any) => /unity log/i.test(String(x.title ?? '')) || x.mime === 'text/plain');
    if (!out?.asset) return kept;
    return `${Buffer.from(await gen.bytes(out.asset)).toString('utf8')}\n${kept}`;
  } catch {
    return kept;
  }
}

/**
 * A task whose merge broke beta's build goes back to an agent with the build log: a new change from beta (the merged
 * work is in it). The first time for a task it isn't a try; later ones are, and past maxTries J decides.
 */
async function buildSendBack(t: Task, { errors = [], matched = [] }: { errors?: string[]; matched?: string[] } = {}) {
  const s = pmSettings();
  const free = !listDecisions({ since: 0, action: 'build-sendback', limit: 10_000 }).some((d) => d.subject === t.id);
  if (!s.enabled) return;
  // A cancelled build isn't a broken one: nothing to fix, nothing blamed (cancel.ts).
  if (t.build?.run && buildCancelled(t.build.run, t.product)) return void setTask(t.id, { build: null });
  if (t.build?.run && heldRun(t.build.run)) return void setTask(t.id, { build: null }); // waiting for credits, not broken
  if (!free && t.tries >= s.maxTries) {
    setTask(t.id, { status: 'failed', note: t.build?.detail.slice(0, 1000) ?? "beta's build failed" });
    outOfTries(getTask(t.id)!, `beta's build fails after it: ${t.build?.detail.slice(0, 600) ?? ''}`, () => askJ(`"${t.title}" (${name(t.product)}) is merged into beta but beta's build fails after it, and its agents couldn't fix that in ${t.tries} tries: ${t.build?.detail.slice(0, 600)}. Try again, revert it on beta, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'revert it', 'drop it'], from: `the default after ${s.maxTries} tries` }));
    return;
  }
  const lines = errors.length ? `\n\nThe errors in the build's Unity log${matched.length ? ` (in files your change touched: ${matched.join(', ')})` : ''}:\n\n\`\`\`\n${errors.join('\n').slice(0, 4000)}\n\`\`\`` : '';
  const note = `Beta's build failed after your change ${t.change ?? ''} merged into beta: ${t.build?.detail ?? ''}${lines}\n\nYour change is already on beta (this branch starts from it). Make beta build again (for Unity: fix the compile errors), keep what the task asks for, and run the checks.`;
  setTask(t.id, { status: 'planned' });
  try {
    await startTaskChange(getTask(t.id)!, note, `beta's build failed after its merge${free ? ' (the first time: not a try)' : ''}`, !free);
    logDecision('build-sendback', t.id, t.product, `"${t.title}": beta's build failed after its merge; sent back to an agent${free ? ' (not counted as a try)' : ''}`);
  } catch (e: any) {
    setTask(t.id, { status: 'merged', note: `couldn't send it back after beta's build failed: ${e.message}`.slice(0, 500) });
  }
}

// --------------------------------------------------------------- milestones

/**
 * A milestone whose tasks are all merged and built (milestonesToReach): ONE beta run per product plays its tasks'
 * scenarios (verify mode) and judges every task's criteria (checkOnBeta reads them), so J's ready-to-test summary has
 * a verdict and a video per criterion before his phone hears it's reached. Started once (milestones.checks); reached
 * when those runs are over (a superseded run follows the newer one). Nothing to play (Studio/Gen, no criteria): reached.
 */
export async function milestoneCheck(id: string, group: string[] = [id]) {
  const m = getMilestone(id);
  if (!m || m.status !== 'open') return;
  let runs: string[] = parse(m.checks ?? null) ?? [];
  const tasks = milestoneTasks(id).filter((t) => t.status === 'merged' && hasBeta(t.product) && t.criteria.length);
  if (!runs.length) {
    // Checked again after a miss: once beta built again (the misses' fixes, or the next merge).
    // A group (milestone-batch.ts): complete milestones of one product checked together, one play per product for all.
    const members = group.filter((g) => { const x = getMilestone(g); return x?.status === 'open' && !(parse(x.checks ?? null) ?? []).length && recheckDue(g, checkProducts(g).products); });
    if (!members.includes(id)) return;
    const parts = members.map((g) => ({ id: g, m: getMilestone(g)!, ...checkProducts(g) }));
    // A Unity project Studio builds: its merges weren't built one by one (unitybuild-policy.ts, J 2026-11-11), so this
    // check is what builds beta's head, ONE build, once nothing else is queued for it, even with no criteria to play.
    const unity = [...new Set(parts.flatMap((x) => x.unity))];
    const allTasks = parts.flatMap((x) => x.tasks);
    // Every product the milestones changed gets its one play, on its milestone build (play-policy.ts): nothing else plays it.
    const products = [...new Set(parts.flatMap((x) => x.products))];
    const titles = parts.map((x) => `"${x.m.title}"`).join(', ');
    if (!products.length || !pmSettings().enabled) { for (const x of parts) announceMilestone(x.id); return; }
    // Work still queued for a Unity project: its one build waits. The PM's pass after that work ends (a merge, a change
    // that ends: agents.ts kicks the loop) asks again; said once per reason in the decision log.
    for (const product of unity) {
      const v = milestoneBuildDue(product);
      if (v.go) continue;
      const line = `milestone "${m.title}": every task is merged; its build of ${name(product)} waits: ${v.why}`;
      if (listDecisions({ since: 0, action: 'milestone-wait', limit: 10_000 }).find((d) => d.subject === id)?.detail !== line.slice(0, 2000)) logDecision('milestone-wait', id, m.product, line);
      return;
    }
    const { startBeta } = await import('./pipeline.ts');
    for (const product of products) {
      const mine = allTasks.filter((x) => x.product === product);
      const plays = await playsFor(mine);
      const what = parts.length > 1 ? `Milestones ${titles}` : `Milestone "${m.title}"`;
      const r = startBeta(product, { focus: focusWithGoals(`${what}: every task is on beta. ${plays.length ? 'Check each one works and nothing regressed.' : 'Play its build once for the milestone.'}`, mine), plays, playtest: true, play: 'milestone', quiet: 0, origin: m.origin, ...(unity.includes(product) ? { cause: 'milestone' as const } : {}) });
      runs.push(r.id);
    }
    for (const x of parts) {
      setMilestoneChecks(x.id, runs);
      const along = parts.length > 1 ? `, checked together with ${parts.filter((y) => y.id !== x.id).map((y) => `"${y.m.title}"`).join(', ')} (one play per product)` : '';
      logDecision('milestone-check', x.id, x.m.product, `milestone "${x.m.title}": every task merged${unity.length ? ` (${unity.map(name).join(', ')}: complete in code, nothing else queued, so beta's head is built once now)` : ' and built'}${along}; started ${runs.join(', ')} to playtest its tasks on beta and judge their criteria`);
    }
    return;
  }
  // A run a newer beta run took over: the newer one plays it (betaqueue.ts absorbed).
  runs = runs.map((r) => {
    let id2 = r;
    for (let i = 0; i < 20; i++) {
      const row = db.prepare('SELECT status, options FROM runs WHERE id = ?').get(id2) as any;
      const next = row?.status === 'skipped' ? parse(row.options)?.supersededBy : null;
      if (!next) break;
      id2 = next;
    }
    return id2;
  });
  const going = runs.some((r) => (db.prepare('SELECT status, started FROM runs WHERE id = ?').get(r) as any)?.status === 'running');
  // A check that hangs (a stuck build) doesn't hold J's milestone for ever.
  const at = lastDecision('milestone-check', id);
  if (going && Date.now() - at < 4 * 3600_000) return;
  const s = pmSettings();
  const tries = milestoneTries(id);
  // A run that broke (stuck at one spot, a missing scenario, beta not built) says nothing about the criteria: it's played
  // again, never counted as missed (J, 2026-10-19).
  const broken = tries < s.maxTries && s.enabled ? runs.map((r) => brokenCheck(r)).find(Boolean) : null;
  if (broken) {
    setMilestoneChecks(id, []);
    logDecision('milestone-rerun', id, m.product, `milestone "${m.title}": its beta check broke (${broken}), so its criteria aren't counted as missed: playing it again (${tries + 1} of ${s.maxTries})`.slice(0, 1500));
    return;
  }
  // A run whose scenarios were skipped as "no scenario" (the build played predates them) checked nothing: it is not a
  // milestone check, whatever else it did, so nothing is judged or announced from it. Checked again after beta's next build.
  const unchecked = runs.flatMap((r) => missingScenarioSkips(r).map((x) => `${x.scenario} (run ${r})`));
  if (unchecked.length) {
    setMilestoneChecks(id, []);
    logDecision('milestone-recheck', id, m.product, `milestone "${m.title}" not checked: the build played has no scenario ${unchecked.join(', ')}, so those runs don't count as a check; it is checked again after beta's next build`.slice(0, 1500));
    return;
  }
  // Its tasks judged from those runs first (checkOnBeta: a "no" goes to decideMiss in walk-away mode), then J hears, but
  // only when every criterion is met, or misses remain after the tries (J, 2026-10-19: "0 of 2 criteria met" was announced).
  for (const t of tasks) await syncTask(getTask(t.id)!, (await changes()).getChange).catch((e) => console.warn(`[pm] milestone task ${t.id}: ${e.message ?? e}`));
  const left = milestoneTasks(id).filter((t) => hasBeta(t.product) && t.criteria.length && !['verified', 'live', DONE].includes(t.status));
  if (!left.length || tries >= s.maxTries || !s.enabled) return announceMilestone(id);
  setMilestoneChecks(id, []);
  const what = left.map((t) => `"${t.title}" (${t.status}${t.checks?.results?.length ? `: ${t.checks.results.filter((r) => r.met !== 'yes').map((r) => `${r.criterion} ${r.met}`).join('; ')}` : ''})`).join(', ');
  logDecision('milestone-recheck', id, m.product, `milestone "${m.title}" not reached: ${left.length} task(s) not verified on beta (${what}); misses go to their agents, and the milestone is checked again after beta's next build (${tries + 1} of ${s.maxTries})`.slice(0, 1500));
}

/**
 * A beta check of these tasks plays only their own scenarios (J, 2026-10-19: checks replayed long story scenarios):
 * one play per scenario and options (the one each task's agent wrote for its criteria, with its start point "at" when
 * it gave one; none: the product's default, its first local one), its tasks' criteria judged on it. pipeline.ts plays
 * them in parallel across the playtester's slots.
 */
export async function playsFor(tasks: Task[]) {
  const { getChange } = await changes();
  const plays = new Map<string, { scenario?: string; options?: Record<string, unknown>; device?: 'phone'; criteria: string[] }>();
  for (const t of tasks) {
    const v = t.change ? getChange(t.change)?.verify : null;
    // A task's "[phone]" criteria (taskbar.ts) are played apart, at 390x844 touch (same scenario and options); the rest on desktop.
    for (const phone of [false, true]) {
      const crit = t.criteria.filter((k) => PHONE.test(k) === phone);
      if (!crit.length) continue;
      const key = askKey({ scenario: v?.scenario, options: v?.options, device: phone ? 'phone' : undefined });
      const p = plays.get(key) ?? { ...(v?.scenario ? { scenario: v.scenario, ...(v.options ? { options: v.options } : {}) } : {}), ...(phone ? { device: 'phone' as const } : {}), criteria: [] as string[] };
      for (const k of crit) if (!p.criteria.includes(k)) p.criteria.push(k);
      plays.set(key, p);
    }
  }
  return [...plays.values()].filter((p) => p.criteria.length);
}

/** A milestone check waiting after a miss: due once each product's beta built again since (or RECHECK_WAIT_MS passed). */
const RECHECK_WAIT_MS = 2 * 3600_000;
const lastDecision = (action: string, subject: string) => listDecisions({ since: 0, action, limit: 10_000 }).find((d) => d.subject === subject)?.at ?? 0;
/** A milestone's checks played again so far (broken runs and misses). */
const milestoneTries = (id: string) => ['milestone-rerun', 'milestone-recheck'].reduce((n, a) => n + listDecisions({ since: 0, action: a, limit: 10_000 }).filter((d) => d.subject === id).length, 0);
function recheckDue(id: string, products: string[]) {
  const at = lastDecision('milestone-recheck', id);
  if (!at || at < lastDecision('milestone-check', id) || Date.now() - at > RECHECK_WAIT_MS) return true;
  return products.every((p) => db.prepare(`SELECT 1 FROM runs WHERE kind = 'beta' AND products LIKE ? AND started > ? AND status IN ('done', 'failed')`).get(`%"${p}"%`, at));
}

/**
 * Why a beta run says nothing about criteria (it broke), or null: still running, a playtest that failed, was skipped (a
 * missing scenario, no GPU, "beta isn't built yet") or got stuck, or beta's build failed in it.
 */
export function brokenCheck(run: string, product?: string): string | null {
  const r = db.prepare('SELECT id, status, detail, products, finished FROM runs WHERE id = ?').get(run) as any;
  if (!r) return `run ${run} is gone`;
  if (r.status === 'running') return `run ${run} is still running`;
  const p = product ?? (parse(r.products) ?? [])[0];
  const play = (db.prepare(`SELECT name, status, detail, data FROM steps WHERE run = ? AND product = ? AND kind = 'playtest'`).all(run, p) as any[])
    .find((x) => x.status === 'failed' || x.status === 'skipped' || x.status === 'cancelled' || /\bstuck\b/i.test(String(x.detail ?? '')) || parse(x.data)?.outcome === 'stuck');
  if (play) return `playtest ${play.name} ${play.status === 'done' ? 'got stuck' : play.status}: ${String(play.detail ?? '').slice(0, 300)}`;
  // Over and not failed counts as done here (buildOf reads any other status as a run that threw).
  // A cancelled build was never built: this run says nothing about beta (and nothing is blamed), the next one builds it.
  if (buildCancelled(run, p)) return `beta's build was cancelled in run ${run}, so beta was not built or checked there`;
  // Its Unity build was held (unitybuild-policy.ts): nothing was built or played, so nothing was checked.
  const held = heldBuildRun(run, p);
  if (held) return `beta's Unity build was held in run ${run} (${held}), so beta was not built or checked there`;
  // A Unity project Studio builds: a run with no build of beta's head built nothing, so it checked nothing.
  const sp = unityStudioBuilt(p) && !buildFailedIn(run, p) ? buildProof({ unity: true, built: builtBy(run, p), includes: true }) : undefined;
  const build = buildOf(p, { ...r, status: r.status === 'failed' ? 'failed' : 'done' }, sp);
  return build.ok ? null : build.detail;
}

/** A task's change still in flight: an agent on it, ready for review, waiting on an answer or on its Gen jobs. */
const LIVE = [...ACTIVE, 'ready', 'needs answer', 'waiting on Gen'];
/** After a change Studio itself failed to run (agents.ts studioFailed): the wait before the next attempt, and how many in a row before J hears. */
export const INFRA_WAIT_MS = 10 * 60_000;
export const INFRA_LIMIT = 4;

/**
 * Why a task can't get another agent change now, or null. One attempt at a time, and a merged one is the task done:
 * only putting the task back to planned by hand (J, or Talk on his word) starts it again. Read from the changes table,
 * not the task row, so a stale task (a failed change's retry, a second tick) can't miss an attempt that went on.
 */
export function startBlocked(taskId: string): string | null {
  const t = getTask(taskId);
  if (!t) return `no task ${taskId}`;
  const rows = db.prepare(`SELECT id, status FROM changes WHERE task = ? ORDER BY created DESC`).all(t.id) as any[];
  const live = rows.find((r) => LIVE.includes(r.status));
  if (live) return `its change ${live.id} is ${live.status}`;
  const merged = rows.find((r) => r.status === 'merged');
  // Merged with stand-ins (waiting for GPU): it runs again for the real art (rerunGpuWaits).
  if (merged && t.status !== 'planned' && t.status !== GPU_WAIT) return `its change ${merged.id} is already merged`;
  return null;
}

/** Starts (or restarts) the agent change of a task, unless startBlocked says it has one going or merged. */
async function startTaskChange(task: Task, note?: string, why?: string, countTry = true) {
  const { startTask, reviveForTask } = await changes();
  // Out of credits: no agent is started (a refused beta run is no reason to), the run plays again when credits are back.
  const waiting = creditsWaitReason();
  if (waiting) throw new StudioError(`"${task.title}" isn't started: ${waiting}`);
  // Checked after the await and with nothing awaited before the insert: two callers in one tick, or two ticks, can't both pass.
  const blocked = startBlocked(task.id);
  if (blocked) throw new StudioError(`"${task.title}" isn't started again: ${blocked}`);
  const t = getTask(task.id)!;
  // The latest attempt left work in its worktree (uncommitted or unpushed): it carries on there, not a fresh branch.
  const revived = reviveForTask(t.id, note);
  if (revived) {
    const tries = countTry ? t.tries + 1 : t.tries;
    setTask(t.id, { status: 'working', change: revived, tries, merged_at: null, build: null });
    logDecision('start', t.id, t.product, `carried on with ${revived} for "${t.title}" in its own worktree, which still had its work (${countTry ? `try ${tries}` : `not counted as a try, ${tries} used`}${why ? `; ${why}` : ''})`, { kind: 'start', change: revived, task: t.id });
    return revived;
  }
  const request = `${t.request}${note ? `\n\nFrom the PM (an earlier attempt): ${note}` : ''}`;
  const id = startTask(t.product, request, { criteria: t.criteria, task: t.id, title: t.title, gpuBudget: t.gpu?.items?.length ? t.gpu.budget ?? 0 : null, target: t.target });
  const tries = countTry ? t.tries + 1 : t.tries;
  setTask(t.id, { status: 'working', change: id, changes: [...t.changes, id], tries, merged_at: null, build: null });
  logDecision('start', t.id, t.product, `started ${id} for "${t.title}" (${countTry ? `try ${tries}` : `not counted as a try, ${tries} used`}${why ? `; ${why}` : ''})${note ? `: ${note.slice(0, 300)}` : ''}`, { kind: 'start', change: id, task: t.id });
  return id;
}

// ------------------------------------------------------------- starting

/** Midnight (this server's day, UTC on Cloud Run) when today's start count began, and when it resets. */
export const dayBounds = (now = Date.now()) => {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  const next = new Date(since);
  next.setDate(next.getDate() + 1);
  return { since: since.getTime(), next: next.getTime() };
};

/**
 * The PM's starts today that count against maxStartsPerDay: only the ones where an agent actually ran. A start whose
 * change Studio itself failed to run (a clone killed, a session gone, a shell that refused git: infra-failure.ts) is
 * given back, so a retry loop around broken machinery cannot use up the day (J, 2026-11-02: 8 of 8 burned, no task started).
 */
/**
 * Memo of startsToday: the PM asks for it once per task on every pass (capacity, startWaitReason), and with 300 tasks
 * on the roadmap the two queries behind it froze Studio for 1-2 s a pass (2026-11-10, studio_ops). Kept until pm_log
 * changes (pmLogVersion) or the day turns, and at most 15 s: a change failing meanwhile only gives a start back later.
 */
let startsMemo: { key: string; at: number; n: number } | null = null;
export function startsToday(now = Date.now()): number {
  const { since } = dayBounds(now);
  const key = `${since}|${pmLogVersion.n}`;
  if (process.env.STUDIO_PM_MEMO !== 'off' && startsMemo && startsMemo.key === key && Math.abs(now - startsMemo.at) < 15_000) return startsMemo.n;
  const n = startsTodayRead(since);
  startsMemo = { key, at: now, n };
  return n;
}
function startsTodayRead(since: number): number {
  // Automatic resends (an agent carried on in its own worktree, a run again for GPU art or after a build failure: logged
  // "not counted as a try") are the same work going on, not new starts (J, 2026-11-03: they filled the day).
  return startsWithAgent(db.prepare(`SELECT detail FROM pm_log WHERE action = 'start' AND at >= ? AND undone IS NULL
    AND COALESCE(detail, '') NOT LIKE 'carried on with%' AND COALESCE(detail, '') NOT LIKE '%not counted as a try%'`).all(since) as any[], since);
}

/**
 * The starts whose change Studio didn't fail to run. Runs on every capacity check, so many times a pass and once per
 * task: the failed changes are looked up once and the starts compared here, never one query joining the two with LIKE,
 * which took seconds a call by the morning of a busy day (2026-11-06).
 */
function startsWithAgent(rows: { detail: string | null }[], since: number): number {
  if (!rows.length) return 0;
  const failed = (db.prepare(`SELECT id FROM changes WHERE status = 'failed' AND created >= ? AND ${INFRA_FAILED_SQL}`).all(since - 6 * 3600_000) as any[]).map((c) => c.id as string);
  return rows.filter((r) => !failed.some((id) => String(r.detail ?? '').includes(id))).length;
}

/** Whether a finding already has an agent change (a retry: it waits behind roadmap tasks). */
const hasEarlierAttempt = (findingId: string) => Boolean(db.prepare(`SELECT 1 FROM changes WHERE findings LIKE ? LIMIT 1`).get(`%"${findingId}"%`));

/** Files ONE blocker for Studio itself (a roadmap task, deduped per product) with the infrastructure error. */
const infraBlockerAt = new Map<string, number>();
function fileInfraBlocker(a: { from: string; product: string; text: string; tasks: string[] }) {
  // Called on every pass while the failures continue: the blocker is deduped (fileBlocker), the log says it once a day.
  if (Date.now() - (infraBlockerAt.get(a.product) ?? 0) < 24 * 3600_000) return null;
  infraBlockerAt.set(a.product, Date.now());
  try {
    const fix = fileBlocker({ ...a, target: 'hawkesstudio', text: `Studio itself failed to run the agent ${INFRA_LIMIT} times in a row (a clone, checkout, resume or shell around it), so work on this product keeps failing before any agent runs. The error:\n\n${a.text}\n\nFind and fix the cause (memory, disk, credentials, session handling) so agents can run.` });
    logDecision('infra-blocker', a.tasks[0] ?? null, a.product, `Studio failed to run ${name(a.product)}'s agent ${INFRA_LIMIT} times in a row (${a.text.slice(0, 300)}): one blocker for Studio filed (${fix}) instead of another restart`);
    return fix;
  } catch (e: any) {
    console.warn(`[pm] couldn't file the infrastructure blocker: ${e.message}`);
    return null;
  }
}

/** Starts of one finding today (its agents that ran; the PM's cap per finding is MAX_FINDING_STARTS_PER_DAY). */
export function findingStartsToday(findingId: string, now = Date.now()): number {
  const { since } = dayBounds(now);
  return startsWithAgent(db.prepare(`SELECT detail FROM pm_log WHERE action = 'start' AND subject = ? AND at >= ? AND undone IS NULL`).all(findingId, since) as any[], since);
}

/** Agents working now, and the PM's starts today. */
/**
 * How many more changes the PM may start now. A queued change takes a place as much as a running one: it is work the
 * agents' queue already has and hasn't started. Counting only the running ones let the PM queue one more change per
 * product on every pass while nothing could start (no disk room, low memory, a held provider): on 2026-11-10 it queued
 * about 20 at 16:37 and 20 more at 18:15, and the queue reached 111, each one more change for the full disk to refuse.
 */
export function capacity() {
  const s = pmSettings();
  const count = (st: string[]) => (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status IN (${st.map(() => '?').join(',')})`).get(...st) as any).n as number;
  const active = count(RUNNING);
  const queued = count(['queued']);
  const started = startsToday();
  return { active, queued, started, maxConcurrent: s.maxConcurrent, maxStartsPerDay: s.maxStartsPerDay, free: Math.max(0, Math.min(s.maxConcurrent - active - queued, s.maxStartsPerDay - started)) };
}

/**
 * Exactly why a startable task isn't starting, or null when it would (J, 2026-11-02: "waits: a free agent" for a day
 * while the daily limit was used up): the daily limit and when it resets, every agent slot busy, the AI harness on hold,
 * Studio failing to run agents for the task's product (and when it tries again), or PM off.
 */
export function startWaitReason(t?: Pick<Task, 'id' | 'product'>, now = Date.now()): string | null {
  const s = pmSettings();
  if (!s.enabled) return 'the PM is paused (Settings)';
  if (noProviderFree()) return 'the AI harness is on hold (a usage limit or billing); it starts when the harness answers';
  const credits = creditsWaitReason(now);
  if (credits) return credits;
  const cap = capacity();
  if (t) {
    const hold = infraHoldOf(t.id, now);
    if (hold) return `Studio could not run its agent ${hold.n} time${hold.n === 1 ? '' : 's'} in a row (${hold.why.slice(0, 160)}); trying again ${new Date(hold.until).toISOString().slice(11, 16)} UTC`;
  }
  if (cap.started >= s.maxStartsPerDay) return `daily start limit ${cap.started}/${s.maxStartsPerDay} reached, resets ${new Date(dayBounds(now).next).toISOString().slice(11, 16)} UTC`;
  if (cap.active + cap.queued >= s.maxConcurrent) return `all ${s.maxConcurrent} agent slot${s.maxConcurrent === 1 ? ' is' : 's are'} busy (${cap.active} working${cap.queued ? `, ${cap.queued} queued` : ''}); it starts when one finishes`;
  return null;
}

setStartWaitHook((t) => startWaitReason(t));

export type LimitNotice = { cause: string; label: string; used: number; limit: number; resets: string | null; raise: string; waiting: number; text: string };

/**
 * Every cap that is holding roadmap work back right now (J, 2026-11-03: the daily start limit stopped the roadmap and the
 * only trace was a small line on one item): which limit, used/limit, when it resets or how to raise it. Only while
 * startable tasks are waiting; empty when nothing is held. The Roadmap tab shows them as a banner; startWork tells J once a
 * day per cause (notifyLimits).
 */
export async function limitNotices(now = Date.now()): Promise<LimitNotice[]> {
  const s = pmSettings();
  if (!s.enabled) return [];
  const waiting = startableTasks().filter((t) => !managedElsewhereId(t.product));
  const out: LimitNotice[] = [];
  if (!waiting.length) return out;
  const reset = `${new Date(dayBounds(now).next).toISOString().slice(11, 16)} UTC`;
  const mk = (cause: string, label: string, used: number, limit: number, resets: string | null, raise: string, n = waiting.length) =>
    out.push({ cause, label, used, limit, resets, raise, waiting: n, text: `${label}: ${used} of ${limit} used, so ${n} roadmap task${n === 1 ? ' waits' : 's wait'}. ${resets ? `It resets at ${resets}. ` : ''}Raise it: ${raise}.` });
  const cap = capacity();
  if (cap.started >= s.maxStartsPerDay) mk('starts-per-day', 'Daily start limit', cap.started, s.maxStartsPerDay, reset, 'Settings → PM → Starts per day');
  else if (cap.active + cap.queued >= s.maxConcurrent) mk('concurrency', 'Agents at once', cap.active + cap.queued, s.maxConcurrent, null, 'Settings → PM → Agents at once (it also frees when an agent finishes)');
  const { costToday, agentSettings } = await changes();
  const a = agentSettings();
  const t = costToday();
  if (t.cost >= a.maxCostPerDay) mk('cost-per-day', 'Agent spend per day', Math.round(t.cost * 100) / 100, a.maxCostPerDay, reset, 'Settings → Agents → cost per day', waiting.length);
  if (t.count >= a.maxPerDay) mk('agents-per-day', 'Auto-fixes per day', t.count, a.maxPerDay, reset, 'Settings → Agents → Auto-fixes per day', waiting.length);
  return out;
}

/** Tells J once a day per cause that a limit is holding the roadmap: a PM log line and a phone notification. */
export async function notifyLimits(now = Date.now()) {
  const list = await limitNotices(now);
  if (!list.length) return [];
  const day = today();
  const seen = ((state() as any).limitNotified ?? {}) as Record<string, string>;
  const fresh = list.filter((n) => seen[n.cause] !== day);
  if (!fresh.length) return [];
  saveState({ limitNotified: { ...seen, ...Object.fromEntries(fresh.map((n) => [n.cause, day])) } });
  for (const n of fresh) {
    logDecision('limit', null, null, n.text);
    void notify(`${n.label} is holding the roadmap`, n.text, { url: `${PUBLIC_URL}/#roadmap`, priority: 3, tags: ['hourglass'] });
  }
  return fresh;
}

/**
 * A task or finding whose last attempts Studio failed to run: how many in a row, why, and when the next attempt may
 * start (exponential: 10 min, 20, 40, ... up to 4 hours; infraWaitMs). A task's first failure retries at once (afterFailed
 * already waited its grace); a finding's first already waits (INFRA_WAIT_MS). null when its latest attempt wasn't one.
 */
export function infraHoldOf(subject: string, now = Date.now(), o: { firstWaits?: boolean } = {}): { n: number; why: string; until: number; change: string } | null {
  const isFinding = subject.startsWith('f_');
  const rows = (isFinding
    ? db.prepare(`SELECT id, detail, updated, created, ${INFRA_FAILED_SQL} AS infra FROM changes WHERE findings LIKE ? ORDER BY created DESC, rowid DESC LIMIT 12`).all(`%"${subject}"%`)
    : db.prepare(`SELECT id, detail, updated, created, ${INFRA_FAILED_SQL} AS infra FROM changes WHERE task = ? ORDER BY created DESC, rowid DESC LIMIT 12`).all(subject)) as any[];
  let n = 0;
  while (n < rows.length && rows[n].infra) n++;
  if (!n) return null;
  const wait = isFinding || o.firstWaits ? infraWaitMs(n) : infraWaitMs(n - 1);
  const last = rows[0];
  const until = (last.updated ?? last.created ?? 0) + wait;
  return until > now ? { n, why: String(last.detail ?? '?'), until, change: last.id } : null;
}

// Agents queue a product's changes behind the running ones (agents.ts pump); the PM still starts them one slot at a
// time per product, so its picks (priorities, retries) are made when a slot frees, not long before. With more than
// one slot (settings agents.perProduct, productLimits) a second starts only when it won't collide (parallel.ts).
const busy = async (product: string, next: WorkShape) => Boolean((await changes()).noRoomFor(product, next, 'queued,working,verifying,revising'));
/**
 * Whether the product has no slot for new roadmap tasks and bugs (J, 2026-10-18: tasks finished, then conflicted
 * because another merged first): its changes queued, working or ready but not merged yet (merging, or waiting for a
 * person) fill its slots, or `next` would collide with one of them. A revision or a conflict pass holds a slot too
 * (revising). Without `next` any change in flight holds it. J's own reports only wait for busy.
 */
export const slotHeld = async (product: string, next: WorkShape = { text: '' }) => Boolean((await changes()).noRoomFor(product, next, 'queued,working,verifying,revising,ready'));
/** A roadmap task as parallel.ts sees it: its title, what it depends on, the files its earlier changes touched or its request names. */
async function taskShape(t: Task): Promise<WorkShape> {
  const { getChange, changedFiles } = await changes();
  const files = t.changes.map((x) => getChange(x)).filter(Boolean).flatMap((c) => changedFiles(c!));
  return { task: t.id, depends: t.depends, text: t.title, files: [...new Set([...files, ...filesIn(t.request)])] };
}

/** When the PM last priced unpriced GPU tasks and swept Studio's own approvals (every 10 minutes at most). */
let lastGpuSweep = 0;

/** Starts what can start: J's reports, then roadmap tasks (highest priority first, then in order), then bugs, within the caps. Returns what it started. */
export async function startWork() {
  const s = pmSettings();
  if (!s.enabled || !(await import('./ghtoken.ts')).githubReachable()) return [];
  // The harness in use refuses to run (harness-hold.ts): starting would only burn tries. The hold resumes the loop.
  if (noProviderFree()) return [];
  // Out of credits: nothing starts (one "waiting for credits" state, one Inbox card); credits coming back resume it (creditwait.ts).
  if (creditsWaitReason()) return [];
  const { agentSettings, startFix, DECIDED, ALREADY, STUDIO_FAILED_SQL, autoFixBlock } = await changes();
  if (!agentSettings().enabled) return [];
  // A Studio or Gen deploy waiting for agents to finish: start nothing new until it's through.
  const { selfDeploys } = await import('./selfdeploy.ts');
  const sd = selfDeploys(1)[0];
  if (sd?.outcome === 'waiting' && Date.now() - Date.parse(sd.at) < 3 * 3600_000) return [];
  const out: string[] = [];
  // Content tasks that would spend GPU money wait for J's budget: ask him once each, with the estimate. Walk-away mode:
  // Studio approved what fits its caps (roadmap.ts autoApproveGpu); the rest is one digest card in his Inbox and one
  // phone line a day, not a question per task.
  // Tasks never priced (or whose pricing failed) are priced, and what fits Studio's caps approved, before J hears of any.
  if (tasksAwaitingGpu().length && Date.now() - lastGpuSweep > 10 * 60_000) {
    lastGpuSweep = Date.now();
    await priceUnpriced().catch((e: any) => console.warn(`[pm] pricing GPU tasks: ${e.message}`));
    await autoApproveWaiting().catch((e: any) => console.warn(`[pm] GPU auto-approval: ${e.message}`));
  }
  const gpuWaits = tasksAwaitingGpu();
  // Walk-away's digest holds only what's above the caps (roadmap.ts gpuDigestTasks): never one within them, or $0.
  const digest = walkAwayOn() && gpuWaits.length ? gpuDigestTasks({ threshold: await gpuAutoApproveLimit() }) : [];
  if (digest.length) {
    const st = state() as any;
    if (st.gpuDigest !== today()) {
      saveState({ gpuDigest: today() });
      const sum = digest.reduce((a, x) => a + (x.amount ?? 0), 0);
      logDecision('gpu digest', null, null, `${digest.length} GPU budget(s) above walk-away's caps (about $${sum.toFixed(2)}): one card in J's Inbox`);
      void notify('GPU budgets wait for you', `${digest.length} task(s) need GPU budgets above Studio's own limits (about $${sum.toFixed(2)} in all): one card in your Inbox.`, { url: `${PUBLIC_URL}/#inbox`, priority: 3, tags: ['moneybag'] });
    }
  }
  for (const t of walkAwayOn() ? [] : gpuWaits) {
    const e = t.gpu?.estimate;
    const text = e && !e.error
      ? `"${t.title}" (${name(t.product)}) will generate on the GPU: about ${e.gpuHours} GPU-hours on ${e.servers} server(s), ~$${e.cost.toFixed(2)} ($${e.withIdleTail.toFixed(2)} if the servers idle out instead of being stopped), about ${e.wallMinutes} min. Approve a budget for it?`
      : `"${t.title}" (${name(t.product)}) will generate on the GPU, but it couldn't be priced${e?.error ? ` (${e.error})` : ''}. Price it again, or approve a budget anyway?`;
    const amount = e && !e.error ? `Approve $${(Math.ceil(e.cost * 1.25 * 100) / 100).toFixed(2)}` : null;
    askJ(text, { subject: t.id, product: t.product, options: amount ? [amount, 'Not now'] : ['Price it again', 'Not now'], recommend: amount ?? 'Price it again', topic: 'gpu', blocks: `task "${t.title}" (can't start)`, from: 'PM' });
  }
  let cap = capacity();
  // J's own reports from the beta sites (bugreport.ts) come first: before roadmap tasks and the reviews' bugs.
  const startBug = (f: any, why: string) => {
    // One attempt at a time: a change of this finding still queued, working, ready or waiting is the attempt.
    if (db.prepare(`SELECT 1 FROM changes WHERE findings LIKE ? AND status IN (${LIVE.map(() => '?').join(',')}) LIMIT 1`).get(`%"${f.id}"%`, ...LIVE)) return null;
    // Studio's own failures (the worktree, a clone, a resume, a push: infra-failure.ts) aren't the agent's tries or the
    // day's starts, but the next attempt waits longer after each (10 min, 20, 40 ...), and after INFRA_LIMIT in a row
    // ONE blocker for Studio itself is filed with the error, and the retries go on by themselves (nobody is asked).
    const last = db.prepare(`SELECT id, detail, updated, created, ${STUDIO_FAILED_SQL} AS infra FROM changes WHERE findings LIKE ? ORDER BY created DESC, rowid DESC LIMIT 1`).get(`%"${f.id}"%`) as any;
    if (last?.infra) {
      // Studio's failure is Studio's to fix (J, 2026-11-03): after INFRA_LIMIT in a row ONE blocker for Studio is filed with
      // the exact error (deduped per product), and the finding is retried by itself, further apart each time (at most
      // every 4 hours). Nobody is asked "try again / drop it" for a cause that is not theirs.
      const rows = db.prepare(`SELECT ${STUDIO_FAILED_SQL} AS infra FROM changes WHERE findings LIKE ? ORDER BY created DESC, rowid DESC LIMIT ?`).all(`%"${f.id}"%`, INFRA_LIMIT) as any[];
      if (rows.length >= INFRA_LIMIT && rows.every((r) => r.infra)) fileInfraBlocker({ from: last.id, product: f.product, text: `${f.title}: ${String(last.detail ?? '?')}`, tasks: [] });
      if (infraHoldOf(f.id)) return null;
    }
    // One finding uses at most MAX_FINDING_STARTS_PER_DAY starts a day: retry loops can't take the day from the roadmap.
    if (findingStartsToday(f.id) >= MAX_FINDING_STARTS_PER_DAY) return null;
    // An agent that changed nothing because J already decided it (DECIDED, agents.ts), or because it was already done
    // (ALREADY: e.g. the error came from a build older than the fix), didn't fail a try; nor did one Studio failed to run.
    const tries = (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE findings LIKE ? AND COALESCE(detail, '') NOT LIKE ? AND COALESCE(detail, '') NOT LIKE ? AND NOT ${STUDIO_FAILED_SQL}`).get(`%"${f.id}"%`, `${DECIDED}%`, `${ALREADY}%`) as any).n as number;
    if (tries >= s.maxTries) {
      // Out of attempts: J decides, once per round of attempts (not again each minute after he has answered).
      const last = (db.prepare(`SELECT MAX(created) AS t FROM changes WHERE findings LIKE ?`).get(`%"${f.id}"%`) as any).t ?? 0;
      const asked = db.prepare(`SELECT 1 FROM questions WHERE subject = ? AND at > ? LIMIT 1`).get(f.id, last);
      if (!asked) askJ(`"${f.title}" (${name(f.product)}) failed ${tries} attempts by agents. Try another way, or drop it (won't fix)?`, { subject: f.id, product: f.product, options: ['try again', "won't fix"], from: `the default after ${s.maxTries} tries` });
      return null;
    }
    // An earlier change's pull request is still open, or it failed twice today: not again (agents.ts autoFixBlock).
    if (autoFixBlock(f.id)) return null;
    const id = startFix(f.product, [f.id]);
    db.prepare('UPDATE changes SET criteria = ? WHERE id = ?').run(J([`Fixed: ${f.title}`]), id);
    logDecision('start', f.id, f.product, `started ${id} to fix ${why}[${f.severity}] ${f.title}`, { kind: 'start', change: id, finding: f.id });
    return id;
  };
  const reports = db.prepare(`SELECT * FROM findings WHERE status = 'open' AND source = 'J' ORDER BY CASE severity WHEN 'blocker' THEN 0 ELSE 1 END, first_seen`).all() as any[];
  for (const f of reports) {
    if (cap.free <= 0) break;
    // A report already tried waits behind the roadmap's tasks (the bug stage below): retries don't take slots from them.
    if (hasEarlierAttempt(f.id)) continue;
    if (isInfra(f.product) || managedElsewhereId(f.product) || await busy(f.product, { text: f.title })) continue;
    try {
      const id = startBug(f, "J's report ");
      if (id) { out.push(id); cap = capacity(); }
    } catch {
      continue;
    }
  }
  // Tasks whose stand-ins are on beta: run again for the real art once a GPU server is up (not a try).
  const taken = new Set<string>();
  for (const id of await rerunGpuWaits(cap.free, taken).catch((e) => { console.warn(`[pm] GPU waits: ${e.message ?? e}`); return []; })) { out.push(id); cap = capacity(); }
  // Not blocked (what they depend on is merged), highest effective priority first, then roadmap order (startableTasks).
  // A project handed over to another Studio (config.ts managedBy): its PM works it there.
  const waiting = startableTasks().filter((t) => !managedElsewhereId(t.product));
  for (const t of waiting) {
    if (cap.free <= 0) break;
    // The change it starts is queued at once, so the next task of the product sees it here.
    if (await slotHeld(t.product, await taskShape(t))) continue;
    // Studio failed to run its last agents for this task: it waits, longer each time (infraHoldOf), not a restart loop.
    if (infraHoldOf(t.id)) continue;
    // The task bar (taskbar.ts): a task that doesn't meet it is rewritten into the shape or parked, never started as it is.
    try {
      if (await gateTask(t) !== 'ok') continue;
    } catch (e: any) {
      console.warn(`[pm] task bar on ${t.id}: ${e.message ?? e}`);
      continue;
    }
    try {
      out.push(await startTaskChange(t, rescueNote(t.id), `priority ${t.effective_priority}${t.priority ? '' : ' (its item\'s)'}, not blocked${rescueNote(t.id) ? '; with a scout\'s diagnosis' : ''}`));
    } catch (e: any) {
      setTask(t.id, { note: `couldn't start: ${e.message}`.slice(0, 500) });
      continue;
    }
    cap = capacity();
  }
  if (s.fixBugs && cap.free > 0) {
    // The worst open bugs not tried 3 times, one per product, in products without a task waiting.
    const bugs = db.prepare(`SELECT * FROM findings WHERE status = 'open' AND severity IN ('blocker', 'bug') AND (COALESCE(source, '') != 'J' OR EXISTS (SELECT 1 FROM changes WHERE changes.findings LIKE '%"' || findings.id || '"%')) ORDER BY CASE severity WHEN 'blocker' THEN 0 ELSE 1 END, seen DESC, last_seen DESC LIMIT 40`).all() as any[];
    const { betaPreview } = await import('./previews.ts');
    for (const f of bugs) {
      if (cap.free <= 0) break;
      if (isInfra(f.product) || managedElsewhereId(f.product) || waiting.some((t) => t.product === f.product) || await slotHeld(f.product, { text: f.title })) continue;
      // An automatic error report from a beta build older than a fix waits for the current build to catch it again.
      if (f.source === 'auto') {
        // A page left open on an older Unity build (filed before stale pages were told apart): not a game bug.
        const stale = await staleReport(f);
        if (stale) {
          updateFinding(f.id, { status: 'wontfix', note: staleNote(stale) });
          logDecision('wontfix', f.id, f.product, `"${f.title}": ${staleNote(stale)}`.slice(0, 1500));
          continue;
        }
        const beta = betaPreview(f.product);
        if (beta?.status === 'building') continue; // which build beta serves is known once it's published
        const held = waitsForCurrentBuild(f, beta);
        if (held) {
          if (f.note !== held) {
            updateFinding(f.id, { note: held });
            logDecision('hold', f.id, f.product, `"${f.title}": ${held}`.slice(0, 1500));
          }
          continue;
        }
      }
      try {
        const id = startBug(f, '');
        if (!id) continue;
        out.push(id);
      } catch {
        continue;
      }
      cap = capacity();
    }
  }
  // A limit holding the roadmap back is told once a day per cause (banner on the Roadmap tab, PM log, J's phone).
  await notifyLimits().catch((e: any) => console.warn(`[pm] limit notice: ${e.message}`));
  return out;
}

// --------------------------------------------------------- waiting for GPU

/** Runs for a task's real GPU art after stand-ins, before J is asked (each is not a try). */
export const MAX_GPU_RERUNS = 3;

/**
 * What a task's merged change makes it: merged, or waiting for GPU when the change shipped stand-ins because no GPU
 * server ran (J, 2026-10-18: "stand-ins don't count as done"; agents.ts pendingGpuOf, `.hawkes/pending-gpu.txt`).
 */
export function mergedStatus(t: Pick<Task, 'gpu'>, c: { verify?: any }): string {
  // Only a task with a GPU budget can run again for its art (one without stays merged, as before).
  return c.verify?.pendingGpu && t.gpu?.items?.length && (t.gpu.budget ?? 0) > 0 ? GPU_WAIT : 'merged';
}

const STUDIO_FAILED_SQL = INFRA_FAILED_SQL;
/** The change was a run for a task's real GPU art (rerunGpuWaits). */
const gpuRerunOf = (change: string) => Boolean(db.prepare(`SELECT 1 FROM pm_log WHERE action = 'gpu-rerun' AND detail LIKE ?`).get(`%${change}%`));
export function gpuReruns(task: string): number {
  const since = (db.prepare(`SELECT answer, at, answered_at FROM questions WHERE subject = ? AND status = 'answered'`).all(task) as any[])
    .filter((q) => /^(try|retry|again|yes)/i.test(String(q.answer ?? '').trim()))
    .reduce((m, q) => Math.max(m, q.answered_at ?? q.at ?? 0), 0);
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM pm_log WHERE action = 'gpu-rerun' AND subject = ? AND at > ?
      AND NOT EXISTS (SELECT 1 FROM changes WHERE pm_log.detail LIKE '%' || changes.id || '%' AND ${STUDIO_FAILED_SQL})`).get(task, since) as any).n as number;
  } catch {
    return (db.prepare(`SELECT COUNT(*) AS n FROM pm_log WHERE action = 'gpu-rerun' AND subject = ? AND at > ?`).get(task, since) as any).n as number;
  }
}

// When Studio last tried to start a GPU server for a task waiting for GPU.
const ensuredAt = new Map<string, number>();

/** A task just merged with stand-ins: the PM log, Talk, and Studio starting a stopped GPU server for its rerun. */
function waitForGpu(t: Task, c: { id: string; verify?: any }) {
  const what = String(c.verify?.pendingGpu ?? '').split('\n').filter(Boolean).slice(0, 4).join('; ').slice(0, 400);
  logDecision('gpu-wait', t.id, t.product, `"${t.title}": ${c.id} merged stand-ins (still to make on the GPU: ${what}); it waits for a GPU server and runs again, not as a try`);
  void import('./followup.ts').then(({ tellAbout }) => tellAbout({ ...c, task: t.id }, 'Waiting for GPU', `"${t.title}" (${name(t.product)}) merged stand-ins into beta because no GPU server ran; it isn't done: Studio runs it again for the real art as soon as a GPU server is up. Still to make: ${what}`)).catch(() => {});
  kick();
}

// The fleet, read at most every 2 minutes while tasks wait for GPU.
let fleetSeen: { at: number; running: boolean } | null = null;
async function gpuRunning() {
  if (fleetSeen && Date.now() - fleetSeen.at < 2 * 60_000) return fleetSeen.running;
  const { gen } = await import('./gen.ts');
  const { generatorRunning, serverlessReady, fleetGone } = await import('./gpustart.ts');
  // RunPod, Modal and the like run GPU jobs with no server to start: one of them ready counts as a GPU server up.
  try {
    if (serverlessReady(await (gen as any).request('/gpu/providers'))) { fleetSeen = { at: Date.now(), running: true }; return true; }
  } catch { /* Gen couldn't say: the fleet as before */ }
  const f: any = await gen.fleet();
  // No AWS at all (the account suspended 2026-10-28): Gen's other providers take the GPU work, so the waits run now.
  fleetSeen = { at: Date.now(), running: f?.error ? fleetGone(f.error) : generatorRunning(f?.servers ?? []) };
  return fleetSeen.running;
}

/**
 * Tasks waiting for GPU: with a GPU server running, each gets a new agent change for the real art (on top of beta,
 * where its stand-ins are; not a try), within the free slots, one per product. With none running, Studio starts a
 * stopped one for them (gpustart.ts: never a launch; its tries, PM-log and Talk lines). After MAX_GPU_RERUNS, J decides.
 * deps are for tests.
 */
export async function rerunGpuWaits(free: number, taken = new Set<string>(), deps: { running?: () => Promise<boolean>; ensure?: (c: any) => Promise<string> } = {}) {
  const out: string[] = [];
  const waits = (db.prepare(`SELECT id FROM tasks WHERE status = ?`).all(GPU_WAIT) as any[]).map((r) => getTask(r.id)!);
  if (!waits.length) return out;
  let running: boolean;
  try {
    running = await (deps.running ?? gpuRunning)();
  } catch (e: any) {
    console.warn(`[pm] the GPU fleet: ${e.message ?? e}`);
    return out;
  }
  for (const t of waits) {
    const n = gpuReruns(t.id);
    if (n >= MAX_GPU_RERUNS) {
      const last = (db.prepare(`SELECT MAX(at) AS at FROM pm_log WHERE action = 'gpu-rerun' AND subject = ?`).get(t.id) as any)?.at ?? 0;
      if (!db.prepare(`SELECT 1 FROM questions WHERE subject = ? AND at > ? LIMIT 1`).get(t.id, last)) {
        askJ(`"${t.title}" (${name(t.product)}) still has stand-in art on beta: its real GPU art didn't land in ${n} runs. Try again, keep the stand-ins (count it as done), or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'keep the stand-ins', 'drop it'], recommend: 'try again', from: `the default after ${n} runs for its GPU art` });
      }
      continue;
    }
    if (!running) {
      // A stopped server started for it (once at a time per task: gpustart's own tries for about 45 minutes).
      const budget = t.gpu?.budget ?? null;
      // gpustart tries for about 45 minutes; after it gives up, again two hours later.
      if (budget && budget > 0 && Date.now() - (ensuredAt.get(t.id) ?? 0) > 2 * 3600_000) {
        ensuredAt.set(t.id, Date.now());
        const ensure = deps.ensure ?? (async (c: any) => (await import('./gpustart.ts')).ensureGpuFor(c));
        void ensure({ id: `gpu-wait-${t.id}`, product: t.product, task: t.id, title: t.title, gpu_budget: String(budget), stillNeeds: () => getTask(t.id)?.status === GPU_WAIT })
          .then((r) => { if (/^started|already (running|pending)/.test(r)) { fleetSeen = null; kick(); } }).catch(() => {});
      }
      continue;
    }
    if (free <= out.length || taken.has(t.product) || await slotHeld(t.product, await taskShape(t))) continue;
    // Studio failed to run its last runs for this task (a full disk, a clone killed): it waits, longer each time, like
    // every other start (infraHoldOf). Such a run isn't counted against MAX_GPU_RERUNS (gpuReruns) and puts the task
    // straight back to waiting for GPU, so without this a GPU server that is up made a new change on every PM pass:
    // 2026-11-10 16:37-16:39, "Layered island sound" (k_d9e3d07e803e) got 42 changes, one every 3 s, each failing at once
    // on "in-memory disk is full".
    // Its first such failure waits too: no grace period came before this start (afterFailed's does for other tasks).
    if (infraHoldOf(t.id, Date.now(), { firstWaits: true })) continue;
    try {
      const { getChange } = await changes();
      const prev = t.change ? getChange(t.change) : null;
      const left = String(prev?.verify?.pendingGpu ?? '').slice(0, 1500);
      const note = `Your earlier change ${t.change ?? ''} merged stand-ins into beta because no GPU server ran. A GPU server is up now: make the real art, replace the stand-ins (they're on beta, where this branch starts), and delete .hawkes/pending-gpu.txt when nothing is left (else list what still is).${left ? ` Still to make:\n${left}` : ''}`;
      const id = await startTaskChange(t, note, `a GPU server is up: the real art for its stand-ins (run ${n + 1} of ${MAX_GPU_RERUNS})`, false);
      logDecision('gpu-rerun', t.id, t.product, `"${t.title}": a GPU server is up, ${id} makes the real art for its stand-ins (run ${n + 1} of ${MAX_GPU_RERUNS}, not a try)`);
      taken.add(t.product);
      out.push(id);
    } catch (e: any) {
      setTask(t.id, { note: `couldn't run it again for its GPU art: ${e.message}`.slice(0, 500) });
    }
  }
  return out;
}

// --------------------------------------------------------------- reviewing

/** Changes the PM reviews: roadmap tasks' changes, and finding fixes (not J's own requests; never Studio or Gen). */
export function reviewable(c: any) {
  // Changes from before the loop first ran stay J's to approve, as they were.
  // One being merged into beta automatically (agents.ts autoMergeBeta) isn't the PM's to merge as well.
  return c.status === 'ready' && !c.infra && !isVideoTask(c.task) && c.auto_merge !== 'trying' && c.created >= pmSince() && (c.task || (c.findings?.length && !c.request)) && !c.pm_escalated && !waitingOnJ(c);
}
/** A change (or its task) J was asked about: the PM leaves it alone until he answers. */
const waitingOnJ = (c: any) => listQuestions('open,asked J').some((q) => q.kind === 'decision' && Boolean(q.subject) && [c.id, c.task].filter(Boolean).some((s) => q.subject!.split(/[\s,]+/).includes(s)));
/** When the PM loop first ran here: it only takes over work from then on. */
export const pmSince = () => state().since ?? Date.now();

/**
 * Merges a ready change into beta for the PM, when delegated merges are on and it passes its gate. A change needs no
 * playtest for that (its agent's checks passed): beta's own run after the push playtests it and judges the criteria.
 */
export async function pmMerge(changeId: string, why = '', by = 'Talk (PM)') {
  const s = pmSettings();
  const { getChange, approve } = await changes();
  const c = getChange(changeId);
  if (!c) throw new StudioError(`No change ${changeId}`, 404);
  if (c.infra) throw new StudioError(`${changeId} changes ${c.product}: Studio and Gen changes need J's approval (they restart the service).`);
  if (!s.delegatedMerges) throw new StudioError('Delegated merges are off (Roadmap > PM): J approves merges himself.');
  if (c.status !== 'ready') throw new StudioError(`${changeId} is ${c.status}, not ready`);
  const g = gate(c.verify, c.criteria);
  if (!g.pass) throw new StudioError(`${changeId} doesn't pass its checks: ${g.why.join('; ')}. Revise it instead.`);
  let merged;
  try {
    merged = await approve(changeId, { confirm: `MERGE ${changeId}`, by });
  } catch (e: any) {
    // Beta moved and the branch conflicts: its agent resolves it (agents.ts resolveConflicts; not a try).
    const { isConflict, resolveConflicts } = await changes();
    if (isConflict(e) && ((e as any).resolving || resolveConflicts(changeId, e.conflict))) {
      logDecision('conflict', c.task ?? changeId, c.product, `${changeId} conflicts with ${BETA}: its agent resolves it (not a try)`);
      return getChange(changeId);
    }
    throw e;
  }
  const t = c.task ? getTask(c.task) : null;
  const st = t ? mergedStatus(t, c) : null;
  if (t) setTask(t.id, { status: st!, merged_at: merged?.merged_at ?? Date.now(), pr: c.pr_url, build: null });
  if (t && st === GPU_WAIT) waitForGpu(t, c);
  logDecision('merge', c.task ?? changeId, c.product, `merged ${changeId} (${c.title}) into ${BETA}${why ? `: ${why}` : ''}${g.unclear.length ? ` · unclear, judged again on beta: ${g.unclear.join('; ')}` : ''}`, { kind: 'merge', change: changeId, repo: c.repo, pr: c.pr, task: c.task, product: c.product });
  return merged;
}

/** Sends a change back with notes (a try); after the last try, J is asked. */
export async function pmRevise(changeId: string, note: string, by = 'Talk (PM)') {
  const s = pmSettings();
  const { getChange, revise } = await changes();
  const c = getChange(changeId);
  if (!c) throw new StudioError(`No change ${changeId}`, 404);
  if (c.status !== 'ready') throw new StudioError(`${changeId} is ${c.status}, not ready`);
  if (!note.trim()) throw new StudioError('Say what to change');
  const t = c.task ? getTask(c.task) : null;
  const tries = t ? t.tries : (c.notes ?? []).filter((n: any) => /PM/.test(n.by)).length + 1;
  if (tries >= s.maxTries) {
    // Already with J: his answer decides (a fresh start is the task back to planned), never another question.
    if (c.pm_escalated) return { escalated: true, already: true };
    // Walk-away mode: one investigation and a fresh round first (the change closed: the retry starts from beta).
    if (t && walkAwayOn() && !rescues()[t.id]) {
      setTask(t.id, { status: 'failed', note: note.slice(0, 1000) });
      await (await changes()).close(changeId, WALK_AWAY_BY).catch((e: any) => console.warn(`[pm] close ${changeId}: ${e.message ?? e}`));
      startRescue(getTask(t.id)!, `still not right after ${tries} tries: ${note}`);
      return { escalated: false, rescue: true };
    }
    if (t) setTask(t.id, { status: 'failed', note: note.slice(0, 1000) });
    const before = new Set(listQuestions().map((q) => q.id));
    const q = askJ(`"${c.title}" (${name(c.product)}) still isn't right after ${tries} tries: ${note.slice(0, 600)} Try another way, change what it should do, or drop it?`, { subject: c.task ?? changeId, product: c.product, options: ['try again', 'change it', 'drop it'] });
    db.prepare('UPDATE changes SET pm_escalated = ? WHERE id = ?').run(Date.now(), changeId);
    // Merged into a question already open: nothing new was asked.
    if (!before.has(q.id)) logDecision('escalate', c.task ?? changeId, c.product, `asked J about ${changeId} after ${tries} tries`);
    return { escalated: true, question: q.id };
  }
  revise(changeId, note, by);
  if (t) setTask(t.id, { status: 'working', tries: t.tries + 1 });
  addComment(c.task ?? changeId, note, by);
  logDecision('revise', c.task ?? changeId, c.product, `sent ${changeId} back (try ${tries + 1}): ${note.slice(0, 400)}`);
  return { revised: changeId, try: tries + 1 };
}

/** The defaults for a ready change nobody decided: merge if it passes, else revise with what failed. */
async function defaultReview(changeId: string) {
  const { getChange } = await changes();
  const c = getChange(changeId);
  if (!c || !reviewable(c)) return;
  const g = gate(c.verify, c.criteria);
  if (g.pass && pmSettings().delegatedMerges) {
    await pmMerge(changeId, 'passed its checks (the default)').catch((e) => console.warn(`[pm] merge ${changeId}: ${e.message}`));
    return;
  }
  if (g.pass) return; // Delegated merges off: J approves.
  const v = c.verify ?? {};
  const note = [`It doesn't pass its checks: ${g.why.join('; ')}.`, v.summary ? `The review said: ${String(v.summary).slice(0, 800)}` : '', ...(v.findings ?? []).slice(0, 5).map((f: any) => `- [${f.severity}] ${f.title}: ${f.detail ?? ''}`)].filter(Boolean).join('\n');
  await pmRevise(changeId, note, 'Studio PM (default)').catch((e) => console.warn(`[pm] revise ${changeId}: ${e.message}`));
}

// --------------------------------------------------------------- questions

/**
 * Answers a question: an agent's (the agent resumes its session), or a decision (the agent behind it resumes too; the
 * PM's next turn hears it). "yes" to a question with a recommendation means the recommendation. A GPU budget question
 * approves the budget (J only). by: who answered (inbox.ts actor), never "J" for the PM's own answers.
 */
export async function answerQuestion(id: string, answer: string, by = 'Talk (PM)') {
  const q = getQuestion(id);
  if (!q) throw new StudioError(`No question ${id}`, 404);
  if (!['open', 'asked J'].includes(q.status)) throw new StudioError(`${id} is ${q.status}${q.answered_by ? ` (answered by ${q.answered_by})` : ''}`);
  if (!answer.trim()) throw new StudioError('Say the answer');
  const { isYes, gpuAnswer } = await import('./inbox.ts');
  const byJ = by === 'J' || by.startsWith('J ');
  // "yes" takes the asker's recommendation.
  if (q.recommendation && isYes(answer) && answer.trim().split(/\s+/).length <= 3 && answer.trim().toLowerCase() !== q.recommendation.trim().toLowerCase()) answer = `${q.recommendation} (${by}: "${answer.trim()}")`;
  if (q.topic === 'gpu' && q.subject?.startsWith('k_')) {
    if (!byJ) throw new StudioError(`A GPU budget is J's call (answered by ${by}). Leave it in his Inbox.`);
    const t = getTask(q.subject);
    if (t) await gpuAnswer(t, answer, by, q);
  }
  // New roadmap work for idle products (pace.ts idleWatch): nothing is added without J's yes.
  if (q.topic === 'idle' && !byJ) throw new StudioError(`New roadmap work for idle products is J's call (answered by ${by}). Leave it in his Inbox.`);
  setQuestion(id, { status: 'answered', answer, answered_by: by });
  // The answer on the subject's thread, when it has one: the PM files questions on slugs too ("deploy-safety-net"), and a
  // thread comment never fails an answer that is already recorded (the routing below still runs).
  const thread = q.subject?.startsWith('c_') ? (taskOfChange(q.subject)?.id ?? q.subject) : q.subject;
  if (isCommentSubject(thread)) {
    try { addComment(thread, answer, by, 'answer'); } catch (e: any) { console.warn(`[pm] answer ${id} on ${thread}: ${e.message}`); }
  }
  const resume = async (change: string) => {
    const { getChange, answerChange } = await changes();
    if (getChange(change)?.status === 'needs answer') answerChange(change, answer, by);
  };
  if (q.kind === 'agent' && q.subject) {
    await resume(q.subject);
    // The decision that passed it on to J is answered with it.
    for (const d of listQuestions().filter((x) => x.forwards === id)) setQuestion(d.id, { status: 'answered', answer, answered_by: by });
  }
  // A decision passing on an agent's question: the agent gets the answer too.
  if (q.kind === 'decision') {
    const t = q.subject?.startsWith('k_') ? getTask(q.subject) : null;
    const change = t?.change ?? (q.subject?.startsWith('c_') ? q.subject : null);
    const waiting = q.forwards ? getQuestion(q.forwards) : listQuestions().find((x) => x.kind === 'agent' && x.subject === change) ?? null;
    if (waiting && ['open', 'asked J'].includes(waiting.status)) {
      setQuestion(waiting.id, { status: 'answered', answer, answered_by: by });
      if (waiting.subject) await resume(waiting.subject);
    }
  }
  // Drop / close / park: the change closes now (its task dropped, or back to an idea when parked), not on a PM turn.
  const stop = q.kind === 'decision' && q.topic !== 'gpu' ? answer.trim().toLowerCase().match(/^(drop|close|park)/)?.[1] : null;
  if (stop && q.subject) {
    const { getChange, close } = await changes();
    const t = q.subject.startsWith('k_') ? getTask(q.subject) : q.subject.startsWith('c_') ? taskOfChange(q.subject) : null;
    const c = getChange(q.subject.startsWith('c_') ? q.subject : t?.change ?? '');
    if (c && !['merged', 'closed'].includes(c.status)) {
      await close(c.id, by);
      logDecision('close', t?.id ?? c.id, c.product, `closed ${c.id} (${c.title}) on ${byJ ? 'J' : by}'s answer to ${id}: ${answer.slice(0, 300)}`);
    }
    if (t && !['merged', 'verified', 'live', 'dropped', DONE].includes(t.status)) setTask(t.id, { status: stop === 'park' ? 'idea' : 'dropped', note: `${stop === 'park' ? 'parked' : 'dropped'} on ${byJ ? 'J' : by}'s answer to ${id}` });
  }
  // The stall watch's question: "try" plans again the failed or parked tasks it names (and what they wait on); "drop"
  // drops the stuck ones (its context); anything else leaves them.
  if (q.kind === 'decision' && q.topic === 'stall') {
    const a = answer.trim().toLowerCase();
    const ids = /^(try|retry|again|yes)/.test(a) ? [...new Set(q.text.match(/\bk_[0-9a-f]{12}\b/g) ?? [])] : /^drop/.test(a) ? String(q.context ?? '').split(/\s+/).filter(Boolean) : [];
    for (const k of ids) {
      const t = getTask(k);
      if (!t) continue;
      if (/^drop/.test(a) && !['merged', 'verified', 'live', 'dropped', DONE].includes(t.status)) updateTask(k, { status: 'dropped', note: `dropped on ${byJ ? 'J' : by}'s answer to ${id}` });
      else if (!/^drop/.test(a) && ['failed', 'idea'].includes(t.status)) updateTask(k, { status: 'planned', note: `planned again on ${byJ ? 'J' : by}'s answer to ${id}` });
    }
    if (ids.length) logDecision('stall', null, null, `${byJ ? 'J' : by} answered ${id} "${answer.slice(0, 80)}": ${ids.join(', ')}`);
  }
  // Keep the stand-ins (a task waiting for GPU): it counts as merged now. "Try again" gives it a fresh round of GPU reruns.
  if (q.kind === 'decision' && q.subject?.startsWith('k_') && getTask(q.subject)?.status === GPU_WAIT) {
    if (/^keep/i.test(answer.trim())) {
      setTask(q.subject, { status: 'merged', note: `stand-ins kept on ${byJ ? 'J' : by}'s answer to ${id}` });
      logDecision('gpu-keep', q.subject, q.product, `"${getTask(q.subject)!.title}": its stand-ins kept as the art (${byJ ? 'J' : by}'s answer to ${id})`);
    } else if (/^(try|retry|again|yes)/i.test(answer.trim())) {
      ensuredAt.delete(q.subject);
      while (Date.now() <= (getQuestion(id)?.answered_at ?? 0)) await new Promise((r) => setTimeout(r, 1));
      kick();
    }
  }
  // A decision on a failed task: the PM's next turn acts on it ("try again", "drop it").
  if (q.kind === 'decision' && q.topic !== 'gpu') pmEvent('decided', `${byJ ? 'J' : by} decided on ${q.subject ?? 'a question'} (${id}): "${answer}" (the question was: ${q.text.slice(0, 400)})`, isCommentSubject(q.subject) ? q.subject : id, q.product);
  if (!byJ) logDecision('answer', q.subject, q.product, `${by} answered ${id}: ${answer.slice(0, 500)}`);
  return getQuestion(id);
}

/**
 * Files one clear question for J (a direction choice, money, something failing after 3 tries, anything touching live)
 * in his Inbox, with the options and the asker's recommendation. A question on the same subject (and topic) merges into
 * the open one. The first time, Talk hears it too (the conversation that started the work, else the PM's) and his phone
 * (decisions only he can make); a repeat only updates the card.
 */
export function askJ(text: string, { subject, product, options, from, recommend, context, blocks, topic, forwards }: {
  subject?: string | null; product?: string | null; options?: string[]; from?: string; recommend?: string | null; context?: string | null; blocks?: string | null; topic?: string | null; forwards?: string | null;
} = {}) {
  const item = subject?.startsWith('k_') ? getItem(getTask(subject)?.item ?? '') : subject?.startsWith('i_') ? getItem(subject) : null;
  const origin = item?.origin ?? null;
  const askedBy = !from ? 'Studio PM' : /^(Talk|J|agent)/.test(from) ? from : `Studio PM (${from})`;
  // The one gate in front of the Inbox (causes.ts): transient causes are retried by Studio, a recommendation that spends
  // nothing is the PM's to give in walk-away mode, and only J-only calls (or the last failure of a retry limit) are filed.
  const g = gateQuestion({ text, context, subject, product, options, recommendation: recommend ?? null, topic, forwards, asker: from ? askedBy : null });
  if (g.file && g.note) context = `${g.note}${context ? ` ${context}` : ''}`;
  const q = addQuestion({ kind: 'decision', subject, product, text, options, origin, recommendation: recommend ?? null, context, blocks, topic, forwards, askedBy });
  if (q.status !== 'open') return q;
  if (g.cause) db.prepare('UPDATE questions SET cause = ? WHERE id = ?').run(g.cause.key, q.id);
  if (!g.file) {
    setQuestion(q.id, { status: 'held' });
    settleQuestion(q.id, g, { product, subject, text });
    logDecision(g.action === 'retry' ? 'self-retry' : 'self-answer', subject ?? null, product ?? null, g.action === 'retry'
      ? `held ${q.id} (${g.cause?.label}): Studio answers "${g.answer}" itself in ${Math.round(g.inMs / 60_000)} min, try ${g.attempt}: ${text.slice(0, 300)}`
      : `answered ${q.id} with its recommendation "${g.answer}" instead of asking J: ${text.slice(0, 300)}`);
    return getQuestion(q.id)!;
  }
  if (g.note && g.cause) logCause(g.cause, { product, kind: 'filed-after-tries', ref: q.id, subject: subject ?? product ?? 'studio', detail: `${g.note} ${text}`, dedup: `filed:${q.id}` });
  setQuestion(q.id, { status: 'asked J' });
  const body = `Studio PM needs your call (${q.id})${product ? `, ${name(product)}` : ''}:\n\n${text}${options?.length ? `\n\nOptions: ${options.join(' · ')}` : ''}${recommend ? `\nRecommended: ${recommend}` : ''}\n\nIt's in your Inbox (${PUBLIC_URL}/#inbox); answer there, or here ("${q.id}: <answer>").`;
  void postTo(origin, `Question for you: ${text.slice(0, 60)}`, body);
  void notify(`Studio needs your call${product ? `: ${name(product)}` : ''}`, text.slice(0, 400), { url: `${PUBLIC_URL}/#inbox`, priority: 4, tags: ['raising_hand'] });
  if (from) logDecision('ask', subject ?? null, product ?? null, `asked J (${from}): ${text.slice(0, 400)}`);
  return getQuestion(q.id)!;
}

/** Puts a message into a Talk conversation (with Claude's answer when talk.ts can start one), else a new notice. */
async function postTo(conversation: string | null, title: string, text: string) {
  const talk: any = await import('./talk.ts');
  text = await signFileLinks(text);
  if (conversation && typeof talk.studioSays === 'function' && talk.studioSays(conversation, text)) return conversation;
  return talk.postNotice(title, text) as string;
}

// ------------------------------------------------------------ ready to test

function announceReady(itemId: string) {
  const it = getItem(itemId);
  if (!it) return;
  db.prepare(`UPDATE items SET note = COALESCE(note || ' ', '') || '[told ready]' WHERE id = ?`).run(itemId);
  const r = readyReport({ item: itemId })[0];
  const text = r ? readyMarkdown(r) : `"${it.title}" is on beta.`;
  // Talk only: J's phone hears about milestones (and what went wrong), not every item.
  // Studio and Gen items are done once merged into main (it deploys them): there is no beta to try them on.
  const where = isInfra(it.product) ? ['Done', 'Merged into main and deployed'] : ['On beta', 'On beta and verified'];
  void postTo(it.origin, `${where[0]}: ${it.title}`, `${where[1]} (Studio PM):\n\n${text}`);
  logDecision('ready', itemId, it.product, `"${it.title}" is on beta, its checks passed: told Talk`);
}

/** A milestone reached: every item in it passed its checks on beta. J's phone and Talk get its ready-to-test summary. */
function announceMilestone(id: string) {
  const m = getMilestone(id);
  if (!m) return;
  // Critic gate (critic-gate.ts): a game milestone stays open until a beta critic run scores every touched dimension
  // at or above target. Triggered again when that critic step finishes (critic.afterRun → reachMilestones).
  try {
    const c = milestoneCriticStatus(id);
    if (c.waiting) {
      const line = `milestone "${m.title}": ${c.line || 'waiting for the critic'}`;
      if (listDecisions({ since: 0, action: 'milestone-critic', limit: 10_000 }).find((d) => d.subject === id)?.detail !== line.slice(0, 2000)) {
        logDecision('milestone-critic', id, m.product, line);
      }
      return;
    }
  } catch (e: any) { console.warn(`[pm] milestone critic ${id}: ${e?.message ?? e}`); }
  markReached(id);
  const ready = readyReport({ milestone: id });
  const verified = ready.flatMap((r) => r.criteria).filter((c) => c.met === 'yes').length;
  const total = ready.flatMap((r) => r.criteria).length;
  const bugs = ready.reduce((n, r) => n + r.bugs.length, 0);
  // Reached with misses only after its tries (milestoneCheck): ONE card saying what's left.
  const left = ready.flatMap((r) => r.criteria).filter((c) => c.met !== 'yes');
  const leftLine = left.map((c) => `${c.criterion} (${c.met}${c.evidence ? `: ${c.evidence}` : ''})`).join('; ').slice(0, 1500);
  const text = [
    left.length
      ? `Milestone checked: **${m.title}**${m.product ? ` (${name(m.product)})` : ''}. Every task in it is merged and beta built it, but after its checks and tries ${left.length} of ${total} criteria still aren't met on beta. What's left: ${leftLine}`
      : `Milestone reached: **${m.title}**${m.product ? ` (${name(m.product)})` : ''}. Every task in it is merged and beta built it; ${total ? `beta's playtest met all ${total} of its criteria` : 'it had no criteria to check'}, so it's yours to playtest.`,
    m.goal ? `Goal: ${m.goal}` : '',
    m.test ? `What you said you'd test: ${m.test}` : '',
    ...ready.map(readyMarkdown),
    'When you have played it: tap Go live on its card (nothing to type), or tell me what is wrong and I will make it tasks.',
  ].filter(Boolean).join('\n\n---\n\n');
  const title = left.length ? `Milestone needs a look: ${m.title}` : `Milestone reached: ${m.title}`;
  void postTo(m.origin, title, text);
  void notify(title, left.length ? `${verified}/${total} criteria met on beta after its tries. Still not met: ${leftLine}`.slice(0, 400) : `${total ? `All ${total} criteria verified on beta` : 'On beta'}${bugs ? ` · ${bugs} known bug(s)` : ''}. Ready for you to playtest.`, { url: `${PUBLIC_URL}/#${left.length ? 'inbox' : 'ready'}`, priority: 4, tags: [left.length ? 'warning' : 'checkered_flag'] });
  logDecision('milestone', id, m.product, `milestone "${m.title}" ${left.length ? 'checked with misses left after its tries' : 'reached'} (${ready.length} item(s), ${verified}/${total} criteria on beta)${left.length ? `; what's left: ${leftLine}` : ''}: told J`.slice(0, 1500));
}

export type Ready = {
  item: string; product: string; productName: string; title: string; goal: string | null; status: string; beta: string | null;
  changes: { task: string; title: string; status: string; pr: string | null; change: string | null; summary: string | null; build: TaskBuild | null }[];
  /** What J sees on the roadmap for it (roadmap.ts itemProgress). */
  progress: string;
  criteria: (Check & { task: string; video?: string | null; where: string })[];
  try: string[]; bugs: { id: string; severity: string; title: string; status: string }[]; partly: boolean;
};

/**
 * What's ready for J to test: per roadmap item on beta (or in progress with tasks verified), what changed, which
 * criteria were verified (where, with the playtest video), how to try it (the beta link, the agents' steps), and the
 * open bugs known for it.
 */
export function readyReport({ product, item, milestone }: { product?: string; item?: string; milestone?: string } = {}): Ready[] {
  const { listPreviews } = previews ?? { listPreviews: () => [] as any[] };
  const pv = listPreviews();
  const items = item ? [getItem(item)].filter(Boolean) as any[]
    : milestone ? (db.prepare(`SELECT id FROM items WHERE milestone = ? AND status != 'dropped' ORDER BY ord, created`).all(milestone) as any[]).map((r) => getItem(r.id)!)
      // Consumed items (done when their tasks were created) too: they show once a task is verified on beta.
      : listItems({ product, status: 'on beta,in progress,done' }).filter((it) => it.status !== 'done' || it.consumed);
  const out: Ready[] = [];
  for (const it of items) {
    const tasks = (it.tasks ?? []).filter((t: Task) => t.status !== 'dropped' && t.status !== 'idea');
    const done = tasks.filter((t: Task) => ['verified', 'live'].includes(t.status));
    if (!done.length && it.status !== 'on beta') continue;
    const summary = (cid: string | null) => (cid ? ((db.prepare('SELECT summary FROM changes WHERE id = ?').get(cid) as any)?.summary ?? null) : null);
    const since = Math.min(...tasks.map((t: Task) => t.merged_at ?? Date.now()));
    const linked = db.prepare(`SELECT id, severity, title, status FROM findings WHERE status IN ('open', 'fixing') AND (item = ? OR (product = ? AND severity IN ('blocker', 'bug') AND first_seen >= ?)) ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'bug' THEN 1 ELSE 2 END LIMIT 20`).all(it.id, it.product, since) as any[];
    out.push({
      item: it.id, product: it.product, productName: name(it.product), title: it.title, goal: it.goal, status: it.status,
      beta: pv.find((x: any) => x.product === it.product)?.play ?? null,
      changes: tasks.map((t: Task) => ({ task: t.id, title: t.title, status: t.status, pr: t.pr, change: t.change, summary: summary(t.change)?.slice(0, 1500) ?? null, build: t.build ?? null })),
      progress: itemProgress(it).label,
      criteria: tasks.flatMap((t: Task) => (t.checks?.results ?? t.criteria.map((k) => ({ criterion: k, met: 'unclear' as const, evidence: 'not checked on beta yet' }))).map((c) => ({ ...c, task: t.id, video: t.checks?.video ?? null, where: t.checks?.where ?? '-' }))),
      try: tasks.map((t: Task) => t.try).filter(Boolean) as string[],
      bugs: linked, partly: it.status === 'done' && it.consumed ? done.length < tasks.length : it.status !== 'on beta',
    });
  }
  return out;
}

export function readyMarkdown(r: Ready) {
  return [
    `**${r.title}** (${r.productName})${r.partly ? ' — partly on beta' : ''}${r.beta ? ` · try it: ${r.beta}` : ''}`,
    r.goal ? `Goal: ${r.goal}` : '',
    `What changed:\n${r.changes.map((c) => `- ${c.title} (${c.status}${c.build ? `; ${c.build.ok ? '✅' : '❌'} ${c.build.detail.slice(0, 200)}` : ''})${c.pr ? ` ${c.pr}` : ''}`).join('\n')}`,
    `Criteria:\n${r.criteria.map((c) => `- ${c.met === 'yes' ? '✅' : c.met === 'no' ? '❌' : '❔'} ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ''}${c.video ? ` (video: ${fileUrl(c.video)})` : ''}`).join('\n')}`,
    r.try.length ? `How to try it:\n${r.try.join('\n')}` : '',
    `Known bugs: ${r.bugs.length ? r.bugs.map((b) => `[${b.severity}] ${b.title} (${b.id})`).join('; ') : 'none known'}`,
  ].filter(Boolean).join('\n\n');
}
let previews: typeof import('./previews.ts') | null = null;
void import('./previews.ts').then((m) => (previews = m)).catch(() => {});

// ------------------------------------------------------------------- triage

/** The PM's backlog triage, logged with undo. */
export function triageFinding(id: string, action: 'wontfix' | 'duplicate' | 'link' | 'reopen' | 'idea', { note = '', of, item, by = 'Talk (PM)' }: { note?: string; of?: string; item?: string; by?: string } = {}) {
  const f = db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as any;
  if (!f) throw new StudioError(`No finding ${id}`, 404);
  const undo = { kind: 'finding', id, status: f.status, note: f.note, item: f.item };
  if (action === 'link') {
    if (!item || !getItem(item)) throw new StudioError('link needs item (i_...)');
    db.prepare('UPDATE findings SET item = ?, updated = ? WHERE id = ?').run(item, Date.now(), id);
    logDecision('link', id, f.product, `linked [${f.severity}] ${f.title} to ${item} (${getItem(item)!.title})${note ? `: ${note}` : ''}`, undo);
  } else if (action === 'duplicate') {
    const o = of ? db.prepare('SELECT * FROM findings WHERE id = ?').get(of) as any : null;
    if (!o || o.product !== f.product) throw new StudioError('duplicate needs of: a finding of the same product');
    db.prepare(`UPDATE findings SET status = 'wontfix', note = ?, updated = ? WHERE id = ?`).run(`Duplicate of ${of} (${o.title})${note ? `: ${note}` : ''}`, Date.now(), id);
    db.prepare('UPDATE findings SET seen = seen + ?, last_seen = MAX(last_seen, ?) WHERE id = ?').run(f.seen, f.last_seen, of!);
    logDecision('duplicate', id, f.product, `merged "${f.title}" into ${of} ("${o.title}")`, undo);
  } else {
    if (!note.trim() && action === 'wontfix') throw new StudioError("won't-fix needs a note (why it's below the bar)");
    const status = action === 'reopen' ? 'open' : action;
    db.prepare('UPDATE findings SET status = ?, note = ?, updated = ? WHERE id = ?').run(status, `${note}${note ? ' ' : ''}(${by}, ${today()})`, Date.now(), id);
    logDecision(action === 'wontfix' ? 'wontfix' : action, id, f.product, `${action} [${f.severity}] ${f.title}${note ? `: ${note}` : ''}`, undo);
  }
  return db.prepare('SELECT * FROM findings WHERE id = ?').get(id);
}

// ------------------------------------------------------------ walk-away mode

// Walk-away mode (walkaway.ts): the PM decides routine calls itself, each in its decision log with undo, never one
// question per task. What stays J's: going live, rollbacks, new GPU servers, spend above the caps, protected files,
// failures after all tries, milestones, real direction questions.

/** One investigation per product holding the tasks that missed their criteria on beta the same way (pm-state.json). */
type Investigation = { change: string; tasks: string[]; run: string; at: number };
const investigations = (): Record<string, Investigation> => (state() as any).investigations ?? {};
const saveInvestigations = (v: Record<string, Investigation>) => saveState({ investigations: v });
/** The open investigation holding a task (tests, the Roadmap's note), or null. */
export const heldFor = (taskId: string) => Object.values(investigations()).find((i) => i.tasks.includes(taskId)) ?? null;

/** How to take back a decision about tasks: their fields before it, and a change it started (closed on undo). */
const tasksUndo = (ids: string[], change: string | null = null) => ({
  kind: 'tasks', change, tasks: ids.map((id) => { const x = getTask(id)!; return { id, status: x.status, tries: x.tries, note: x.note, checks: x.checks }; }),
});

/** A task that missed its criteria, decided alone: try again (a try) while it has tries, else parked as an idea. */
function retryOrPark(t: Task, why: string): 'retry' | 'rescue' | 'park' {
  const s = pmSettings();
  const undo = tasksUndo([t.id]);
  // Out of tries: one investigation and a fresh round first (rescue); only after that is it parked, and J asked.
  if (t.tries >= s.maxTries && !rescues()[t.id]) {
    startRescue(t, `missed its criteria on beta after ${t.tries} tries: ${why}`);
    return 'rescue';
  }
  if (t.tries < s.maxTries) {
    setTask(t.id, { status: 'planned', checks: null, note: `trying again (the PM decided): ${why}`.slice(0, 1000) });
    try { addComment(t.id, `On beta it missed its criteria: ${why}. Try again on top of beta (the earlier attempt is merged there).`.slice(0, 4000), WALK_AWAY_BY); } catch { /* not a thread subject */ }
    logDecision('retry', t.id, t.product, `"${t.title}" misses criteria on beta: trying again (${t.tries} of ${s.maxTries} tries used): ${why}`.slice(0, 1500), undo);
    return 'retry';
  }
  setTask(t.id, { status: 'idea', note: `parked by the PM after ${t.tries} tries and an investigation: ${why}`.slice(0, 1000) });
  logDecision('park', t.id, t.product, `"${t.title}" still misses criteria on beta after ${t.tries} tries and an investigation: parked as an idea, J asked: ${why}`.slice(0, 1500), undo);
  askJ(`"${t.title}" (${name(t.product)}) still misses its criteria on beta after its tries and a scout's investigation, so it's parked as an idea: ${why.slice(0, 600)}. Try again, change what it should do, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change it', 'drop it'], from: 'walk-away: after its tries and an investigation' });
  return 'park';
}

/**
 * A merged task missing criteria on beta, decided by the PM in walk-away mode (no question for J). When beta itself
 * looks broken (two or more of the product's tasks missed in the same beta run, beta's build failed after it, or an
 * investigation is already open), ONE investigation change is filed for the product and the tasks are held until it
 * merges (then judged again on beta: releaseInvestigations). Otherwise: try again, or parked after maxTries.
 * checks: beta's check of this task (its run, verdict); results: everything that run judged.
 */
export async function decideMiss(t: Task, checks: { where: 'beta'; at: number; run: string; video?: string | null; verdict?: string }, results: Check[]) {
  const all = structuredClone(investigations());
  const open = all[t.product];
  if (open?.tasks.includes(t.id)) return 'held';
  const missed = (x: Task) => x.criteria.filter((k) => results.find((r) => r.criterion === k)?.met === 'no');
  const why = (x: Task) => missed(x).map((k) => `${k} (${results.find((r) => r.criterion === k)?.evidence ?? 'no'})`).join('; ') || 'missed on beta';
  // Others of the product this same run judged and missed (merged, or already failed by it).
  const same = (db.prepare(`SELECT id FROM tasks WHERE product = ? AND status IN ('merged', 'failed')`).all(t.product) as any[])
    .map((r) => getTask(r.id)!).filter((x) => x.id === t.id || missed(x).length > 0);
  if (!same.some((x) => x.id === t.id)) same.push(t);
  const brokenBuild = Boolean(t.build && !t.build.ok);
  if (same.length < 2 && !brokenBuild && !open) {
    setTask(t.id, { checks });
    return retryOrPark(getTask(t.id)!, why(t));
  }
  const fresh = same.filter((x) => !open?.tasks.includes(x.id));
  const undo = tasksUndo(fresh.map((x) => x.id));
  let change = open?.change ?? null;
  if (!change) {
    const list = fresh.map((x) => `- ${x.id} "${x.title}": ${why(x)}`).join('\n');
    const request = `Investigate beta (filed by the Studio PM in walk-away mode): beta run ${checks.run} missed the acceptance criteria of ${fresh.length} task(s) at once${brokenBuild ? `, and beta's build failed after "${t.title}" merged (${String(t.build?.detail ?? '').slice(0, 300)})` : ''}. That usually means beta's build or data is broken or stale, not each task's work.\n\n${list}\n\nFind the shared cause on beta (a build that didn't pick up the merges, stale generated data, a broken scene or config) and fix it. Don't redo the tasks' own work. Say in .hawkes/summary.md what was wrong.`;
    try {
      const { startTask } = await changes();
      change = startTask(t.product, request, { title: `Investigate: ${fresh.length} task(s) miss their criteria on beta (run ${checks.run})` });
    } catch (e: any) {
      // No agents here: each task is decided on its own.
      console.warn(`[pm] investigation for ${t.product}: ${e.message ?? e}`);
      setTask(t.id, { checks });
      return retryOrPark(getTask(t.id)!, why(t));
    }
  }
  for (const x of fresh) setTask(x.id, { status: 'failed', checks: { ...checks, results: x.criteria.map((k) => results.find((r) => r.criterion === k)).filter(Boolean) }, note: `held: beta looks broken for several tasks; investigation ${change} fixes it, then this is judged again on beta (the PM decided)` });
  all[t.product] = { change: change!, tasks: [...(open?.tasks ?? []), ...fresh.map((x) => x.id)], run: open?.run ?? checks.run, at: open?.at ?? Date.now() };
  saveInvestigations(all);
  logDecision('investigate', t.id, t.product, `${fresh.length} task(s) of ${name(t.product)} miss their criteria on beta run ${checks.run}${brokenBuild ? ' after a failed build' : ''} (${fresh.map((x) => `"${x.title}"`).join(', ')}): ${open ? `held with the open investigation ${change}` : `filed ONE investigation ${change}`} and held them until it merges`.slice(0, 1500), { ...undo, change: open ? null : change });
  if (!open) void postTo(null, `Investigating beta: ${name(t.product)}`, `Studio PM (walk-away): ${fresh.length} ${name(t.product)} task(s) miss their criteria on beta run ${checks.run} the same way, so beta itself looks broken. I filed one investigation (${change}) and hold the tasks until it merges; then they're judged again on beta. Nothing for you to decide.`).catch(() => {});
  return 'investigate';
}

/** Investigations that finished: merged, their tasks judged again on beta (one beta run); failed or closed, each task decided alone. */
export async function releaseInvestigations() {
  const all = structuredClone(investigations());
  if (!Object.keys(all).length) return [];
  const { getChange } = await changes();
  const out: string[] = [];
  for (const [product, inv] of Object.entries(all)) {
    const c = getChange(inv.change);
    if (c && !['merged', 'closed', 'failed'].includes(c.status)) continue;
    delete all[product];
    saveInvestigations(all);
    out.push(inv.change);
    const tasks = inv.tasks.map((id) => getTask(id)).filter((x): x is Task => Boolean(x) && x!.status === 'failed');
    if (c?.status === 'merged') {
      for (const x of tasks) setTask(x.id, { status: 'merged', merged_at: Date.now(), checks: null, note: `judged again on beta after investigation ${inv.change} merged` });
      const criteria = [...new Set(tasks.flatMap((x) => x.criteria))];
      let run = '';
      if (criteria.length && hasBeta(product)) {
        try {
          const { startBeta } = await import('./pipeline.ts');
          // Each task's own scenario, not one default for all their criteria.
          run = startBeta(product, { focus: focusWithGoals(`Re-checking ${tasks.length} task(s) after investigation ${inv.change} fixed beta.`, tasks), plays: await playsFor(tasks.filter((x) => x.criteria.length)), playtest: true }).id;
        } catch (e: any) {
          console.warn(`[pm] re-check after ${inv.change}: ${e.message ?? e}`);
        }
      }
      logDecision('recheck', inv.change, product, `investigation ${inv.change} merged: ${tasks.length} held task(s) judged again on beta${run ? ` (run ${run})` : ''}`);
    } else {
      for (const x of tasks) retryOrPark(x, `its investigation ${inv.change} ${c?.status ?? 'is gone'}; on beta it missed: ${String(x.note ?? '').slice(0, 300)}`);
      logDecision('recheck', inv.change, product, `investigation ${inv.change} ${c?.status ?? 'is gone'}: its ${tasks.length} held task(s) decided one by one`);
    }
  }
  return out;
}

/** The text checkOnBeta asked J with before walk-away mode ("... is merged into beta but misses criteria there ..."). */
const MISS_QUESTION = /is merged into beta but misses criteria there/;
/** A change already fixing beta for a product (not a task's): stale build or data, an investigation. */
const FIXING_BETA = /\b(stale|investigat\w*|build data|beta'?s build|rebuild)\b/i;

/**
 * Walk-away mode taking over the "misses criteria" questions already in J's Inbox: grouped by product, two or more (or
 * a change already fixing beta's build or data) are held under one investigation (that change, else a new one); a lone
 * one is tried again or parked. Each question is closed with what the PM decided. Returns the questions it settled.
 */
export async function settleMissQuestions() {
  const qs = listQuestions().filter((q) => q.kind === 'decision' && q.subject?.startsWith('k_') && MISS_QUESTION.test(q.text));
  if (!qs.length) return [];
  const byProduct = new Map<string, { q: Question; t: Task }[]>();
  for (const q of qs) {
    const t = getTask(q.subject!);
    if (!t) continue;
    byProduct.set(t.product, [...(byProduct.get(t.product) ?? []), { q, t }]);
  }
  const out: string[] = [];
  for (const [product, list] of byProduct) {
    const all = structuredClone(investigations());
    let inv = all[product];
    if (!inv) {
      const fixing = (db.prepare(`SELECT id, title, request FROM changes WHERE product = ? AND task IS NULL AND status NOT IN ('merged', 'closed', 'failed') ORDER BY created DESC`).all(product) as any[])
        .find((c) => FIXING_BETA.test(`${c.title ?? ''} ${c.request ?? ''}`));
      if (fixing) inv = { change: fixing.id, tasks: [], run: 'earlier beta runs', at: Date.now() };
    }
    const decided = new Map<string, string>();
    if (inv || list.length >= 2) {
      const undo = tasksUndo(list.map((x) => x.t.id));
      if (!inv) {
        const { startTask } = await changes();
        try {
          const change = startTask(product, `Investigate beta (filed by the Studio PM in walk-away mode): ${list.length} task(s) are merged into beta but miss their acceptance criteria there, which usually means beta's build or data is broken or stale, not each task's work.\n\n${list.map((x) => `- ${x.t.id} "${x.t.title}": ${String(x.t.note ?? '').slice(0, 300)}`).join('\n')}\n\nFind the shared cause on beta and fix it. Don't redo the tasks' own work. Say in .hawkes/summary.md what was wrong.`, { title: `Investigate: ${list.length} task(s) miss their criteria on beta` });
          inv = { change, tasks: [], run: 'earlier beta runs', at: Date.now() };
        } catch (e: any) {
          console.warn(`[pm] investigation for ${product}: ${e.message ?? e}`);
        }
      }
      if (inv) {
        for (const { t } of list) {
          if (!inv.tasks.includes(t.id)) inv.tasks.push(t.id);
          setTask(t.id, { status: 'failed', note: `held: investigation ${inv.change} fixes beta, then this is judged again on beta (the PM decided)` });
          decided.set(t.id, `held until ${inv.change} (fixing beta) merges, then judged again on beta`);
        }
        all[product] = inv;
        saveInvestigations(all);
        logDecision('investigate', list[0].t.id, product, `took over ${list.length} "misses criteria" question(s) of ${name(product)}: held the tasks under ${inv.change}, which fixes beta; they're judged again once it merges`, { ...undo, change: null });
      }
    }
    for (const { q, t } of list) {
      const what = decided.get(t.id) ?? ({ retry: 'trying again', rescue: 'a scout investigates, then a fresh round of tries', park: 'parked as an idea' } as const)[retryOrPark(t, String(t.note ?? 'missed its criteria on beta').replace(/^on beta: /, ''))];
      setQuestion(q.id, { status: 'resolved', answer: `(the PM decided in walk-away mode: ${what})`, answered_by: WALK_AWAY_BY });
      out.push(q.id);
    }
  }
  return out;
}

/**
 * Questions about a bug that no longer need J (q_ef8448c712e3, 2026-10-19: "failed 3 attempts" for an error already
 * fixed): an open bug whose every attempt said it was already done (ALREADY, agents.ts; from before such attempts
 * marked it fixed themselves) is fixed with the last one's word; then a question about a bug that is fixed, won't-fix
 * or an idea, with no agent on it, is settled. Returns the questions it settled.
 */
export async function settleFindingQuestions() {
  const { ALREADY } = await changes();
  const out: string[] = [];
  for (const q of listQuestions().filter((x) => x.subject?.startsWith('f_'))) {
    let f = getFinding(q.subject!);
    if (!f || takenBy(f.id)) continue;
    if (f.status === 'open') {
      const cs = db.prepare(`SELECT id, detail, summary FROM changes WHERE findings LIKE ? ORDER BY created DESC`).all(`%"${f.id}"%`) as any[];
      if (cs.length && cs.every((c) => String(c.detail ?? '').startsWith(ALREADY))) {
        updateFinding(f.id, { status: 'fixed', note: `agent ${cs[0].id}: ${ALREADY}: ${String(cs[0].summary ?? '').slice(0, 200)}` });
        logDecision('already-done', f.id, f.product, `"${f.title}": all ${cs.length} attempt(s) found it already done (${cs.map((c) => c.id).join(', ')}): marked fixed`);
        f = getFinding(f.id)!;
      }
    }
    if (!['fixed', 'wontfix', 'idea'].includes(f.status)) continue;
    const what = f.status === 'fixed' ? 'fixed' : f.status === 'wontfix' ? "won't fix" : 'an idea now';
    setQuestion(q.id, { status: 'resolved', answer: `(no longer needed: ${f.id} is ${what}${f.note ? `: ${String(f.note).slice(0, 300)}` : ''})`, answered_by: 'Studio' });
    logDecision('settle', f.id, f.product, `settled ${q.id} ("${q.text.slice(0, 120)}"): no longer needed, ${f.id} is ${what}`);
    out.push(q.id);
  }
  return out;
}

/** Decisions walk-away mode and the PM made on their own (the daily digest). */
const SELF_DECIDED = ['hold', 'settle', 'walk-away', 'retry', 'park', 'investigate', 'recheck', 'gpu auto-approve', 'merge', 'revise', 'answer', 'start', 'wontfix', 'duplicate', 'link', 'conflict', 'rescue', 'rescue-retry', 'already-done', 'blocker', 'reconcile', 'stall'];

/**
 * Once a day (after dailyHour) in walk-away mode: one line per kind of what the PM decided by itself in the last day,
 * in the day's PM conversation (Talk). Also the phone, once, for a Studio or Gen deploy that rolled back.
 */
async function walkAwayDaily() {
  const st = state() as any;
  const now = Date.now();
  const s = pmSettings();
  if (st.digest !== today() && new Date().getHours() >= s.dailyHour) {
    saveState({ digest: today() });
    const ds = listDecisions({ since: now - 86_400_000, limit: 500 }).filter((d) => SELF_DECIDED.includes(d.action) && !d.undone);
    if (ds.length) {
      const by = new Map<string, typeof ds>();
      for (const d of ds) by.set(d.action, [...(by.get(d.action) ?? []), d]);
      const lines = [...by].map(([a, list]) => `- ${a} (${list.length}): ${list.slice(0, 4).map((d) => d.detail?.slice(0, 160)).join(' · ')}${list.length > 4 ? ' …' : ''}`);
      const text = `What I decided on my own in the last day (walk-away mode; every one is in the PM log with undo, ${PUBLIC_URL}/#roadmap):\n\n${lines.join('\n')}`;
      try {
        const talk = await import('./talk.ts');
        if (!talk.studioNote(await pmConversation(), text)) talk.postNotice('Walk-away: the day', text);
      } catch (e: any) {
        console.warn(`[pm] walk-away digest: ${e.message ?? e}`);
      }
    }
  }
  // A Studio or Gen deploy that rolled back: the phone, once each (hawkes-pull records it in self-deploys.jsonl).
  const { selfDeploys } = await import('./selfdeploy.ts');
  const seen = Number(st.rollbackSeen ?? 0);
  const back = selfDeploys(10).filter((d) => d.outcome === 'failed' && Date.parse(d.at) > seen);
  if (back.length) {
    saveState({ rollbackSeen: Math.max(...back.map((d) => Date.parse(d.at))) });
    // The first look after this starts only records where things are (old rollbacks aren't news).
    if (seen) for (const d of back) void notify(`${d.repo} deploy rolled back`, `${String(d.detail ?? '').slice(0, 300)} (${String(d.to ?? '').slice(0, 7)})`, { url: `${PUBLIC_URL}/#changes`, priority: 4, tags: ['warning'] });
  } else if (!seen) saveState({ rollbackSeen: now });
}

// ---------------------------------------------------------------------- undo

/** Takes a PM decision back where that's possible. */
export async function undoDecision(id: string, by = 'J') {
  const d = getDecision(id);
  if (!d) throw new StudioError(`No decision ${id}`, 404);
  if (d.undone) throw new StudioError(`${id} was already undone`);
  const u = d.undo;
  if (!u) throw new StudioError(`${d.action} can't be undone (${d.detail})`);
  let detail = '';
  if (u.kind === 'finding') {
    db.prepare('UPDATE findings SET status = ?, note = ?, item = ?, updated = ? WHERE id = ?').run(u.status, u.note, u.item ?? null, Date.now(), u.id);
    detail = `${u.id} back to ${u.status}`;
  } else if (u.kind === 'start') {
    const { close, getChange } = await changes();
    if (getChange(u.change) && !['merged', 'closed'].includes(getChange(u.change)!.status)) await close(u.change, by);
    if (u.task) setTask(u.task, { status: 'idea', note: `start undone by ${by}` });
    if (u.finding) db.prepare(`UPDATE findings SET status = 'open' WHERE id = ? AND (status = 'fixing' OR (status = 'fixed' AND note = ?))`).run(u.finding, `agent change ${u.change}`);
    detail = `closed ${u.change}`;
  } else if (u.kind === 'merge') {
    detail = await revertOnBeta(u.repo, u.pr, by);
    if (u.task) setTask(u.task, { status: 'idea', note: `merge undone by ${by} (reverted on beta)` });
  } else if (u.kind === 'tasks') {
    // A walk-away decision (retry, park, investigate): the tasks as they were; an investigation it started is closed.
    const { close, getChange } = await changes();
    if (u.change && getChange(u.change) && !['merged', 'closed'].includes(getChange(u.change)!.status)) await close(u.change, by);
    if (u.change) {
      const all = structuredClone(investigations());
      for (const [k, v] of Object.entries(all)) if (v.change === u.change) delete all[k];
      saveInvestigations(all);
    }
    for (const x of u.tasks ?? []) if (getTask(x.id)) setTask(x.id, { status: x.status, tries: x.tries, note: x.note, checks: x.checks });
    detail = `${(u.tasks ?? []).length} task(s) back as they were${u.change ? `; closed ${u.change}` : ''}`;
  } else if (u.kind === 'task-bar') {
    // A rewrite by the task bar: the request, criteria and bar as they were (judged as passing, so it isn't rewritten again).
    if (getTask(u.task)) {
      updateTask(u.task, { request: u.request, criteria: u.criteria });
      setBar(u.task, u.bar ?? null);
    }
    detail = `${u.task} has its original request and criteria back`;
  } else if (u.kind === 'settings') {
    fs.writeFileSync(FILE, JSON.stringify({ ...pmSettings(), ...u.before }, null, 2));
    detail = `settings back: ${JSON.stringify(u.before)}`;
  } else if (u.kind === 'queue-heal') {
    // A change the queue heal parked (queue-heal.ts): resumed now.
    detail = (await import('./queue-heal.ts')).resumeParked(u.change, by);
  } else if (u.kind === 'dup-closed') {
    // A change closed before it started because its work was already merged (dup-merged.ts): queued again.
    detail = (await import('./dup-merged.ts')).reopenDuplicate(u.change, by);
  } else throw new StudioError(`Don't know how to undo ${u.kind}`);
  markUndone(id);
  logDecision('undo', d.subject, d.product, `${by} undid ${id} (${d.action}): ${detail}`);
  return { ok: true, undone: id, detail };
}

/** A revert of a pull request's squash commit on beta, pushed to beta (nothing goes live). */
/** Reverting a merge on beta and pushing it is a critical section (drain.ts). */
const revertOnBeta = (repo: string, pr: number, by: string) => critical(`reverting #${pr} on ${repo}'s beta`, () => revertOnBetaNow(repo, pr, by));
async function revertOnBetaNow(repo: string, pr: number, by: string) {
  const dir = path.join(PROJECTS, repo);
  await gitAsync(dir, ['fetch', '--quiet', 'origin']);
  const sha = prCommit(repo, BETA, pr);
  if (!sha) throw new StudioError(`Can't find pull request #${pr}'s commit on ${BETA}`);
  const wt = path.join(PROJECTS, '.work', `revert-${repo}-${pr}`);
  const w = await addWorktree(dir, wt, ['--detach', wt, `origin/${BETA}`], gitAsync, { removeLeftover: true });
  if (!w.ok) throw new StudioError(`worktree: ${w.err}`);
  try {
    const r = git(wt, ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai', 'revert', '--no-edit', sha]);
    if (!r.ok) throw new StudioError(`git revert failed (beta changed the same lines since?): ${r.err.slice(0, 300)}`);
    git(wt, ['commit', '--amend', '-m', `Revert #${pr} on ${BETA} (undone by ${by} in Studio)`, '-c', 'user.name=Hawkes Studio']);
    const p = await gitAsync(wt, ['push', '--quiet', 'origin', `HEAD:${BETA}`]);
    if (!p.ok) throw new StudioError(`push failed: ${p.err.slice(0, 300)}`);
    return `reverted ${sha.slice(0, 7)} (#${pr}) on ${BETA}`;
  } finally {
    git(dir, ['worktree', 'remove', '--force', wt]);
  }
}

// ----------------------------------------------------- keeping it moving

// J (2026-10-19): "so it keeps working on items that are in the road map until it's done". Tonight's stalls, each
// handled here: a build blocker in another repo (blockers), tasks failed after their tries with nobody asked (rescues,
// sweepFailed), stale task statuses (reconcileTasks), "already done" loops (afterFailed), and a watchdog that says why
// nothing moves (stallWatch).

/** Task statuses that follow their changes (reconcileTasks). */
const FOLLOWED = ['working', 'needs answer', 'review', 'merged', 'failed'];
/** A task's status from a change still in flight. */
const statusOfLive = (s: string) => (s === 'needs answer' ? 'needs answer' : s === 'ready' ? 'review' : 'working');
/** An agent is on the task now (or its change is ready, asks, or waits on Gen). */
const hasLiveChange = (task: string) => Boolean(db.prepare(`SELECT 1 FROM changes WHERE task = ? AND status IN (${LIVE.map(() => '?').join(',')}) LIMIT 1`).get(task, ...LIVE));

/**
 * Every task's status from its own changes (newest first), on each pass and right after a restart: the change it
 * follows is the one in flight, else the newest (a merged task: the newest merged one); the latest change merged wins
 * over a stale "working" or "failed"; with no change in flight a task isn't "working" (it follows its newest change,
 * which the defaults then retry, re-plan or ask about: afterFailed, afterClosed); never started at all: planned again.
 * A failed task stays failed when that came after the merge: missed on beta, broke beta's build, held by an
 * investigation or a rescue, or asked of J. Returns the tasks whose status it changed.
 */
export function reconcileTasks() {
  const out: string[] = [];
  let rows: any[];
  try {
    rows = db.prepare(`SELECT id FROM tasks WHERE status IN (${FOLLOWED.map(() => '?').join(',')})`).all(...FOLLOWED) as any[];
    db.prepare('SELECT 1 FROM changes LIMIT 1').get();
  } catch {
    return out; // no changes table here (agents.ts not loaded)
  }
  const asked = askedJ();
  for (const r of rows) {
    try {
      const t = getTask(r.id)!;
      const cs = db.prepare(`SELECT id, status, created, merged_at, pr_url, verify FROM changes WHERE task = ? ORDER BY created DESC, rowid DESC`).all(t.id) as any[];
      if (!cs.length) {
        if (!t.change && ['working', 'needs answer', 'review'].includes(t.status)) {
          setTask(t.id, { status: 'planned', note: 'no agent change was ever running for it: planned again (reconciled)' });
          out.push(t.id);
        }
        continue;
      }
      const live = cs.find((c) => LIVE.includes(c.status));
      const merged = cs.find((c) => c.status === 'merged');
      const changes = [...new Set([...t.changes, ...cs.map((c) => c.id).reverse()])];
      // The change it follows is right: syncTask keeps its status (and records its checks).
      if (live) {
        // Failed and asked of J (an escalated change still open): his answer decides.
        if (t.status === 'failed' && (asked.has(t.id) || asked.has(live.id))) continue;
        const next = statusOfLive(live.status);
        if (t.change !== live.id) {
          setTask(t.id, { change: live.id, changes, status: next, pr: live.pr_url ?? t.pr });
          if (t.status !== next) out.push(t.id);
        }
        continue;
      }
      if (merged && merged === cs[0]) {
        if (t.status === 'merged') {
          if (t.change !== merged.id) setTask(t.id, { change: merged.id, changes });
          continue;
        }
        if (t.status !== 'failed' && t.change === merged.id) continue; // syncTask's (the usual merge)
        const at = merged.merged_at ?? merged.created;
        const rescue = rescues()[t.id];
        if (t.status === 'failed' && ((t.checks?.where === 'beta' && t.checks.at >= at) || (t.build && !t.build.ok) || heldFor(t.id) || asked.has(t.id) || (rescue && rescue.at >= at))) continue;
        const next = mergedStatus(t, { verify: parse(merged.verify) });
        setTask(t.id, { status: next, change: merged.id, changes, pr: merged.pr_url ?? t.pr, merged_at: at, build: null, note: `reconciled: its latest change ${merged.id} merged (it showed ${t.status})` });
        logDecision('reconcile', t.id, t.product, `"${t.title}" showed ${t.status}, but its latest change ${merged.id} merged: ${next} now`);
        if (next === GPU_WAIT) waitForGpu(getTask(t.id)!, { id: merged.id, verify: parse(merged.verify) });
        out.push(t.id);
        continue;
      }
      // Nothing in flight; the newest change failed or was closed.
      if (t.status === 'merged') {
        if (merged && t.change !== merged.id) setTask(t.id, { change: merged.id, changes });
        continue;
      }
      if (t.status === 'failed') continue; // sweepFailed's
      if (t.change !== cs[0].id) setTask(t.id, { change: cs[0].id, changes });
    } catch (e: any) {
      console.warn(`[pm] reconcile ${r.id}: ${e.message ?? e}`);
    }
  }
  return out;
}

/** Another repo an agent's words say the fix belongs in ("the broken file is in Hawkes Gen; PM: please start a Gen change"), or null. */
export function crossRepoFix(text: string, own: string): string | null {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targets = [
    ...loadInfra().map((x) => ({ id: x.id, names: [x.id, x.name, x.repo, x.name.replace(/^Hawkes\s+/i, '')] })),
    ...loadProducts().map((p) => ({ id: p.id, names: [p.id, p.name, p.repo.split('/')[0]] })),
  ];
  for (const t of targets) {
    if (t.id === own) continue;
    for (const n of [...new Set(t.names.filter((x) => x && x.length >= 3))]) {
      const a = esc(n);
      const asks = new RegExp(`\\b(start|open|file|make|need|needs|requires?|wants?|create)\\s+(a|an|the)?\\s*(new\\s+|separate\\s+)?${a}\\s+(change|fix|task|pull request|PR)\\b`, 'i');
      const lives = new RegExp(`\\b(fix|cause|bug|broken files?|broken code|culprit)\\b[^.;\\n]{0,80}\\b(is|are|lives?|belongs?|sits?|has to be made|must be made|needs to be made)\\s+in\\s+(the\\s+)?${a}\\b`, 'i');
      if (asks.test(s) || lives.test(s)) return t.id;
    }
  }
  return null;
}

/** Fixes in another repo the PM filed, by their task: the product they block and its tasks waiting on them (pm-state.json). */
type Blocker = { product: string; target: string; from: string; tasks: string[]; at: number };
const blockers = (): Record<string, Blocker> => (state() as any).blockers ?? {};
const saveBlockers = (v: Record<string, Blocker>) => saveState({ blockers: v });
/** The open fix elsewhere that blocks a product's beta, or null. */
const blockerOf = (product: string) => {
  const e = Object.entries(blockers()).find(([, b]) => b.product === product);
  return e ? { fix: e[0], b: e[1] } : null;
};

/**
 * An agent found its fix belongs in another repo: the PM files that change itself, as a high-priority roadmap task in
 * the other repo (one per blocked product and repo; more blocked tasks join it), so it starts in the next pass (walk-away
 * merges it by the usual rules). The blocked tasks depend on it; once it merges, the blocked product's beta builds again
 * (followBlockers). Returns the fix's task.
 */
export function fileBlocker(a: { from: string; product: string; target: string; text: string; tasks: string[] }) {
  const all = structuredClone(blockers());
  let fix = Object.entries(all).find(([, b]) => b.product === a.product && b.target === a.target)?.[0] ?? null;
  if (!fix || !getTask(fix)) {
    const it = addItem({ product: a.target, title: `Unblock ${name(a.product)}: a fix in ${name(a.target)}`, status: 'planned', priority: 'high', by: 'Studio PM', goal: `${name(a.product)}'s work waits on this` });
    const k = addTask({
      item: it.id, priority: 'high', title: `Fix what blocks ${name(a.product)} (found by ${a.from})`.slice(0, 160),
      request: `${name(a.product)} is blocked by something in ${name(a.target)}: its agent (change ${a.from}) found the fix belongs here and made no commit there. Its words:\n\n${a.text.slice(0, 3000)}\n\nFix it here in ${name(a.target)} (keep the change small) and run the checks. Once this merges, Studio builds ${name(a.product)}'s beta again.`,
      outcome: `${name(a.product)}'s beta builds again and its waiting tasks start`,
      criteria: [`${name(a.product)}'s next beta build ends done, not failed`, `${name(a.product)}'s tasks that waited on this one start (their status leaves "planned")`],
    });
    fix = k.id;
    all[fix] = { product: a.product, target: a.target, from: a.from, tasks: [], at: Date.now() };
    logDecision('blocker', fix, a.target, `${a.from} (${name(a.product)}) found the fix is in ${name(a.target)}: filed "${k.title}" (${fix}, high priority); ${name(a.product)}'s blocked work waits on it and its beta builds again once it merges`);
    void postTo(null, `Unblocking ${name(a.product)}`, `Studio PM: ${name(a.product)}'s agent (${a.from}) found the fix is in ${name(a.target)}, so I filed that change (${fix}, high priority). ${name(a.product)}'s blocked work waits on it, and its beta builds again once it merges. Nothing for you to decide.`).catch(() => {});
  }
  const b = all[fix];
  b.tasks = [...new Set([...b.tasks, ...a.tasks])];
  saveBlockers(all);
  for (const id of a.tasks) {
    const t = getTask(id);
    if (t && !t.depends.includes(fix)) setTask(id, { depends: [...t.depends, fix] });
  }
  return fix;
}

/** A failed finding fix (no task) whose agent named another repo: that fix is filed (fileBlocker). */
async function blockerFromFix(changeId: string) {
  const c = (await changes()).getChange(changeId);
  if (!c || c.task || (c.commits ?? []).length || isInfra(c.product)) return null;
  const target = crossRepoFix(`${c.summary ?? ''}\n${c.detail ?? ''}`, c.product);
  if (!target) return null;
  // The product's merged tasks waiting on beta's build wait on the fix too.
  const waiting = (db.prepare(`SELECT id FROM tasks WHERE product = ? AND status = 'merged'`).all(c.product) as any[]).map((r) => getTask(r.id)!).filter((t) => t.build && !t.build.ok).map((t) => t.id);
  return fileBlocker({ from: c.id, product: c.product, target, text: String(c.summary ?? c.detail ?? ''), tasks: waiting });
}

/** Fixes elsewhere that merged: the product they blocked builds beta again. Dropped ones release their tasks. */
export async function followBlockers() {
  const all = structuredClone(blockers());
  const out: string[] = [];
  for (const [fix, b] of Object.entries(all)) {
    const k = getTask(fix);
    if (k && !['merged', 'verified', 'live', 'dropped', DONE].includes(k.status)) continue;
    delete all[fix];
    saveBlockers(all);
    out.push(fix);
    if (!k || k.status === 'dropped') {
      for (const id of b.tasks) { const t = getTask(id); if (t?.depends.includes(fix)) setTask(id, { depends: t.depends.filter((d) => d !== fix) }); }
      logDecision('blocker', fix, b.target, `the fix in ${name(b.target)} for ${name(b.product)} was dropped: its ${b.tasks.length} blocked task(s) no longer wait on it`);
      continue;
    }
    if (hasBeta(b.product) && pmSettings().enabled) {
      const { startBeta } = await import('./pipeline.ts');
      const r = startBeta(b.product, { focus: `Building beta again after the fix in ${name(b.target)} ("${k.title}") merged.`, playtest: false });
      logDecision('beta-build', fix, b.product, `the fix in ${name(b.target)} ("${k.title}", ${fix}) merged: started ${r.id} to build ${name(b.product)}'s beta again`);
    }
  }
  return out;
}

/** What shows a task's "already done" is true: a merged change of it, or a change or pull request the agent named that is merged. */
async function doneProof(t: Task, c: any): Promise<{ change: string | null; why: string; own?: boolean } | null> {
  const own = db.prepare(`SELECT id FROM changes WHERE task = ? AND status = 'merged' ORDER BY created DESC LIMIT 1`).get(t.id) as any;
  if (own) return { change: own.id, why: `its change ${own.id} is merged`, own: true };
  const text = `${c.summary ?? ''}\n${c.detail ?? ''}`;
  for (const id of new Set(text.match(/\bc_[0-9a-f]{12}\b/g) ?? [])) {
    const x = db.prepare(`SELECT id, product FROM changes WHERE id = ? AND status = 'merged'`).get(id) as any;
    if (x && x.product === t.product) return { change: x.id, why: `${x.id} (named by the agent) is merged` };
  }
  for (const n of new Set([...text.matchAll(/(?:#|\/pull\/)(\d{1,6})\b/g)].map((m) => Number(m[1])))) {
    if (prCommit(c.repo, c.base ?? BETA, n)) return { change: null, why: `pull request #${n} (named by the agent) is on ${c.base ?? BETA}` };
  }
  return null;
}
/**
 * A task whose every attempt (two or more, Studio's own failures aside) made no commit and said the work was already
 * done: done, not failed (k_9a7fab7e3d75: three tries each said PR #57 already did it, and it had). doneProof couldn't
 * show it, but every agent finding the same is the evidence. True when it marked the task done.
 */
async function everyTrySaidDone(t: Task) {
  const { ALREADY, alreadyDone, studioFailed } = await changes();
  const cs = (db.prepare(`SELECT id, status, detail, summary, commits, phase FROM changes WHERE task = ? ORDER BY created, rowid`).all(t.id) as any[]).filter((c) => !studioFailed(c));
  const said = (c: any) => c.status === 'failed' && !(parse(c.commits) ?? []).length && (String(c.detail ?? '').startsWith(ALREADY) || alreadyDone(String(c.summary ?? '')));
  if (cs.length < 2 || !cs.every(said)) return false;
  const undo = tasksUndo([t.id]);
  // Its questions (try again? drop it?) no longer wait on J.
  for (const q of listQuestions().filter((x) => x.subject === t.id && x.topic !== 'needs J')) setQuestion(q.id, { status: 'resolved', answer: '(no longer waiting: every attempt found it already done, so it is done)', answered_by: 'Studio' });
  setTask(t.id, { status: DONE, note: `every attempt (${cs.map((c) => c.id).join(', ')}) found it already done, with nothing to commit: done` });
  logDecision('already-done', t.id, t.product, `"${t.title}": all ${cs.length} attempts (${cs.map((c) => c.id).join(', ')}) found it already done and made no commit: done, not failed. The last said: ${String(cs[cs.length - 1].summary ?? '').slice(0, 400)}`, undo);
  return true;
}

/** What's left needs J (his PC, his OK, something only he can run). */
const NEEDS_J = /\b(needs? J|J (needs to|must|has to|should|will need to|can)|J'?s (own )?(PC|laptop|machine|hands?|OK|approval|login)|on (his|J'?s) (PC|laptop|machine)|by hand|only J)\b/i;

/** The PM's note an attempt was started with (startTaskChange), carried to the next one. */
const pmNoteOf = (c: any) => String(c.request ?? '').split('\n\nFrom the PM (an earlier attempt): ')[1] ?? '';

/**
 * A task's change failed (the defaults, after the grace period): J already decided it (stops, no try); the fix is in
 * another repo (that change is filed, the task waits on it, no try); the work is already done (checked: merged or
 * verified, no try; one Inbox question if what remains needs J); out of tries (outOfTries); else a fresh attempt
 * with what went wrong (and what the PM told the last one).
 */
async function afterFailed(t: Task, c: any) {
  const { DECIDED, ALREADY } = await changes();
  const s = pmSettings();
  const detail = String(c.detail ?? '');
  const summary = String(c.summary ?? '');
  const noCommit = !(c.commits ?? []).length;
  const back = Math.max(0, t.tries - 1);
  const merged = db.prepare(`SELECT id, merged_at, created FROM changes WHERE task = ? AND status = 'merged' ORDER BY created DESC LIMIT 1`).get(t.id) as any;
  // Studio couldn't run its agent (the worktree, an install, a push): not a try; planned again, it starts in a free slot
  // (this runs after the grace period, so not in a loop a minute apart). After INFRA_LIMIT in a row, J hears.
  const { studioFailed } = await changes();
  if (studioFailed(c)) {
    const recent = db.prepare(`SELECT status, phase, detail FROM changes WHERE task = ? ORDER BY created DESC, rowid DESC LIMIT ?`).all(t.id, INFRA_LIMIT) as any[];
    // After INFRA_LIMIT in a row: ONE blocker for Studio itself with the exact error. The task is planned again all the same
    // (infraHoldOf spaces the attempts: 10 min, 20, 40 ... 4 hours): nobody is asked "try again / drop it" for Studio's own failure.
    if (recent.length >= INFRA_LIMIT && recent.every(studioFailed)) fileInfraBlocker({ from: c.id, product: t.product, text: `"${t.title}": ${detail}`, tasks: [] });
    setTask(t.id, merged ? { status: 'merged', change: merged.id, tries: back } : { status: 'planned', tries: back, note: `${c.id}: Studio couldn't run its agent (${detail.slice(0, 300)}); not counted as a try, it starts again in a free slot` });
    logDecision('retry', t.id, t.product, `"${t.title}": ${c.id} failed in Studio, not in its agent (${detail.slice(0, 300)}): not counted as a try${merged ? '' : ', planned again'}`);
    return;
  }
  if (detail.startsWith(DECIDED)) {
    // Nothing to change because J already decided it: not a failed try (its try is given back), and no restart to
    // reach the same answer again; the task stops here with the agent's reason (sweepFailed asks J once).
    setTask(t.id, { status: 'failed', tries: back, note: `${c.id}: ${DECIDED}: ${summary.slice(0, 600)}` });
    logDecision('decided', t.id, t.product, `"${t.title}": ${c.id} changed nothing, J already decided it (not counted as a try): ${summary.slice(0, 400)}`);
    return;
  }
  const target = noCommit ? crossRepoFix(`${summary}\n${detail}`, t.product) : null;
  if (target) {
    // The product's other merged tasks waiting on a broken beta build wait on the fix too.
    const waiting = (db.prepare(`SELECT id FROM tasks WHERE product = ? AND status = 'merged' AND id != ?`).all(t.product, t.id) as any[]).map((r) => getTask(r.id)!).filter((x) => x.build && !x.build.ok).map((x) => x.id);
    const fix = fileBlocker({ from: c.id, product: t.product, target, text: summary || detail, tasks: [t.id, ...waiting] });
    // Its work already on beta (a send-back for beta's build): merged again, waiting for the fix and beta's build.
    setTask(t.id, merged
      ? { status: 'merged', change: merged.id, merged_at: merged.merged_at ?? merged.created, tries: back, note: `waits on the fix in ${name(target)} (${fix}); beta builds again once it merges` }
      : { status: 'planned', tries: back, note: `waits on the fix in ${name(target)} (${fix}); it starts again once that merges` });
    logDecision('blocker', t.id, t.product, `"${t.title}": ${c.id} found the fix is in ${name(target)}: it waits on ${fix} (not counted as a try)`);
    return;
  }
  const claimed = noCommit && (detail.startsWith(ALREADY) || (await changes()).alreadyDone(summary));
  if (claimed) {
    const proof = await doneProof(t, c);
    if (proof) {
      const sendBack = /Beta's build failed after your change/.test(String(c.request ?? ''));
      // Done by other work (a change or pull request the agent named): done, on beta. Its own change merged (or a
      // send-back for beta's build): merged, and beta's build of it decides.
      const status = sendBack || proof.own ? 'merged' : DONE;
      setTask(t.id, { status, ...(proof.change ? { change: proof.change } : {}), merged_at: Date.now(), tries: back, build: null, note: `${c.id}: already done (${proof.why}); not counted as a try` });
      logDecision('already-done', t.id, t.product, `"${t.title}": ${c.id} found it already done, and it is (${proof.why}): ${status}, not counted as a try`);
      if (NEEDS_J.test(summary)) {
        askJ(`"${t.title}" (${name(t.product)}) is done as far as agents can take it; its agent says what's left needs you: ${summary.slice(0, 900)}`, { subject: t.id, product: t.product, options: ['done', 'drop that part'], topic: 'needs J', blocks: `"${t.title}" being finished`, from: 'an agent found the work already done' });
      }
      // A send-back for beta's build that found nothing to fix: beta builds again (the newer build decides).
      if (sendBack && hasBeta(t.product) && !db.prepare(`SELECT 1 FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ?`).get(`%"${t.product}"%`)) {
        const { startBeta } = await import('./pipeline.ts');
        const r = startBeta(t.product, { focus: `Building beta again: "${t.title}"'s agent found nothing left to fix.`, playtest: false });
        logDecision('beta-build', t.id, t.product, `"${t.title}": its build fix found nothing to change: started ${r.id} to build beta again`);
      }
      return;
    }
  }
  if (t.tries >= s.maxTries) {
    // Every attempt said it was already done (k_9a7fab7e3d75: three tries each said PR #57 did it): done, not failed.
    if (claimed && await everyTrySaidDone(t)) return;
    setTask(t.id, { status: 'failed', note: `failed ${t.tries} times; the last (${c.id}): ${detail}`.slice(0, 1000) });
    outOfTries(getTask(t.id)!, `failed ${t.tries} times; the last (${c.id}): ${detail}. ${summary.slice(0, 400)}`, () => askJ(`"${t.title}" (${name(t.product)}) failed ${t.tries} times. The last: ${detail || '?'}. Try another way, change the task, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change it', 'drop it'], from: `the default after ${s.maxTries} tries` }));
    return;
  }
  // The branch may be gone or empty: a fresh change with what went wrong.
  const earlier = pmNoteOf(c);
  const unproven = claimed ? ' Its agent said the work was already done, but Studio found no merged change or pull request for it: check beta, then do what is missing (or name the change or pull request that did it).' : '';
  const note = `The last attempt (${c.id}) failed: ${detail}. ${summary.slice(0, 600)}${unproven}${earlier ? `\n\nWhat the PM told that attempt:\n${earlier.slice(0, 3000)}` : ''}`;
  // Its earlier work merged (a send-back for beta's build): planned, so it may start again on top of beta.
  if (merged) setTask(t.id, { status: 'planned' });
  try {
    await startTaskChange(getTask(t.id)!, note);
  } catch (e: any) {
    if (merged) setTask(t.id, { status: 'merged', change: merged.id });
    console.warn(`[pm] restart ${t.id}: ${e.message}`);
  }
}

/** A task's change was closed: by the PM or walk-away, tried again (planned); by J, one question; out of tries, outOfTries. */
function afterClosed(t: Task, c: any) {
  const s = pmSettings();
  const why = `its change ${c.id} was closed (${c.detail ?? ''})`;
  if (/^closed by J\b/.test(String(c.detail ?? ''))) {
    setTask(t.id, { status: 'failed', note: why });
    askJ(`You closed ${c.id} ("${t.title}", ${name(t.product)}). Try the task again from scratch, change what it should do, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change it', 'drop it'], from: 'a change J closed' });
    return;
  }
  if (t.tries < s.maxTries) {
    setTask(t.id, { status: 'planned', note: `${why}: planned again (the PM decided)` });
    logDecision('retry', t.id, t.product, `"${t.title}": ${why}; planned again, it starts in a free slot (${t.tries} of ${s.maxTries} tries used)`, tasksUndo([t.id]));
    return;
  }
  setTask(t.id, { status: 'failed', note: why });
  outOfTries(getTask(t.id)!, why, () => askJ(`"${t.title}" (${name(t.product)}) used its ${t.tries} tries and ${why}. Try again, change it, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change it', 'drop it'], from: `the default after ${s.maxTries} tries` }));
}

/** Walk-away rescues by task: a scout's diagnosis, then one more round of tries (pm-state.json). */
type Rescue = { scout: string | null; at: number; state: 'scouting' | 'retrying'; why: string; diagnosis?: string };
const rescues = (): Record<string, Rescue> => (state() as any).rescues ?? {};
const saveRescue = (id: string, r: Rescue | null) => {
  const all = structuredClone(rescues());
  if (r) all[id] = r; else delete all[id];
  saveState({ rescues: all });
};
/** How a rescue's scout is started and read (tests replace them). */
export const rescueDeps = {
  scout: async (product: string, question: string, brief: string) => (await import('./scout.ts')).startScout(product, question, null, { brief, quiet: true }).id,
  report: async (id: string) => (await import('./scout.ts')).getScout(id),
};

/**
 * A task out of tries: in walk-away mode, the first time, a rescue (a scout's diagnosis, then a fresh round of tries
 * with it in the brief); otherwise (or after that round) `ask` files J's question in his Inbox.
 */
function outOfTries(t: Task, why: string, ask: () => unknown): 'rescue' | 'asked' {
  if (walkAwayOn() && !rescues()[t.id]) {
    startRescue(t, why);
    return 'rescue';
  }
  ask();
  return 'asked';
}

function startRescue(t: Task, why: string) {
  const undo = tasksUndo([t.id]);
  setTask(t.id, { status: 'failed', note: `investigating (walk-away): a scout reads what went wrong, then one more round of tries: ${why}`.slice(0, 1000) });
  saveRescue(t.id, { scout: null, at: Date.now(), state: 'scouting', why: why.slice(0, 1500) });
  logDecision('rescue', t.id, t.product, `"${t.title}" is out of tries: a scout reads its misses, pull requests and beta, then a fresh retry with its diagnosis (one more round; the PM decided): ${why}`.slice(0, 1500), undo);
  void scoutFor(t.id).catch((e: any) => console.warn(`[pm] rescue scout ${t.id}: ${e.message ?? e}`));
}

/** What a rescue's scout is told: the task, every attempt and how it ended, beta's checks and build. */
function rescueBrief(t: Task, why: string) {
  const cs = (db.prepare(`SELECT id, status, detail, summary, pr_url FROM changes WHERE task = ? ORDER BY created DESC LIMIT 6`).all(t.id) as any[]);
  return [
    `You are a scout for the Hawkes Studio PM. Roadmap task ${t.id} "${t.title}" (${name(t.product)}) used all its tries and still isn't done. Find out why, so ONE fresh attempt can succeed.`,
    `Why it stopped: ${why}`,
    `The task's request:\n${t.request.slice(0, 3000)}`,
    t.criteria.length ? `Its acceptance criteria:\n${t.criteria.map((k) => `- ${k}`).join('\n')}` : '',
    cs.length ? `Its attempts, newest first:\n${cs.map((c) => `- ${c.id} (${c.status}${c.pr_url ? `, ${c.pr_url}` : ''}): ${String(c.detail ?? '').slice(0, 300)}${c.summary ? `\n  The agent said: ${String(c.summary).slice(0, 700)}` : ''}`).join('\n')}` : '',
    t.checks?.results?.length ? `Beta's check (${t.checks.where}, run ${t.checks.run ?? '?'}):\n${t.checks.results.map((r) => `- ${r.met}: ${r.criterion}${r.evidence ? ` (${r.evidence})` : ''}`).join('\n')}` : '',
    t.build ? `Beta's build: ${t.build.detail}` : '',
    `This checkout is beta (where merged attempts are). Read the code and data the task touches and what the attempts did. Reply with a short Markdown report:\n## What went wrong\n(the real cause, with file paths)\n## What the next attempt must do\n(concrete steps)\n## What an agent can't do\n(anything that needs J, or a fix in another repo: name it; "nothing" if none)`,
  ].filter(Boolean).join('\n\n');
}

async function scoutFor(id: string) {
  const r = rescues()[id];
  const t = getTask(id);
  if (!r || !t || r.scout) return;
  let scout: string;
  try {
    scout = await rescueDeps.scout(t.product, `Why did "${t.title}" fail its tries?`, rescueBrief(t, r.why));
  } catch (e: any) {
    console.warn(`[pm] rescue scout for ${id} (tried again next pass): ${e.message ?? e}`);
    return;
  }
  const now = rescues()[id];
  if (now) saveRescue(id, { ...now, scout });
}

/** Rescues whose scout reported (or gave up): the task planned again with a fresh round of tries and the diagnosis. */
export async function followRescues() {
  const out: string[] = [];
  // Scouts can't run while the harness is held: the rescues wait (their scouts start when it lifts).
  if (noProviderFree()) return out;
  for (const [id, r] of Object.entries(rescues())) {
    if (r.state !== 'scouting') continue;
    const t = getTask(id);
    if (!t) { saveRescue(id, null); continue; }
    // Moved by J or the PM meanwhile: the rescue counts as used.
    if (t.status !== 'failed') { saveRescue(id, { ...r, state: 'retrying' }); continue; }
    if (!r.scout) await scoutFor(id);
    const scout = rescues()[id]?.scout ?? null;
    // No scout could start for half an hour (two running all along, no repo for it): the fresh round goes ahead without.
    if (!scout && Date.now() - r.at < 30 * 60_000) continue;
    const x = scout ? await rescueDeps.report(scout).catch(() => null) : null;
    if (x?.status === 'running' && Date.now() - r.at < 60 * 60_000) continue;
    // A scout that only hit the usage cap or a login error has no diagnosis. Don't reset the tries or paste it into the next brief.
    // The rescue round is given back: its scout runs again once the harness answers (not counted, no diagnosis-less retry).
    if (harnessBlocked(`${x?.report ?? ''}\n${x?.detail ?? ''}`)) {
      saveRescue(id, { ...r, scout: null, at: Date.now() });
      logDecision('rescue', id, t.product, `"${t.title}": scout ${scout ?? '(none)'} was stopped by the harness, which is not a diagnosis: it runs again once the harness answers`.slice(0, 1500));
      continue;
    }
    const diagnosis = x?.status === 'done' && x.report ? x.report.slice(0, 6000) : `(the scout couldn't report: ${x?.detail ?? 'it is gone'})`;
    saveRescue(id, { ...r, scout, state: 'retrying', diagnosis });
    setTask(id, { status: 'planned', tries: 0, checks: null, note: `retrying from scratch${scout ? ` with scout ${scout}'s diagnosis` : ''}: one more round of tries (the PM decided)` });
    logDecision('rescue-retry', id, t.product, `"${t.title}": scout ${scout ?? '(none could start)'} ${x?.status === 'done' ? 'reported' : 'gave no report'}; planned again with a fresh round of ${pmSettings().maxTries} tries and its diagnosis in the brief: ${diagnosis.slice(0, 600)}`.slice(0, 1500));
    out.push(id);
  }
  return out;
}

/** The brief note of a task being retried after a rescue: the scout's diagnosis. */
export function rescueNote(id: string) {
  const r = rescues()[id];
  return r?.state === 'retrying' && r.diagnosis ? `Every earlier attempt failed, so a scout investigated why (${r.scout}). Its diagnosis; follow it:\n\n${r.diagnosis}` : undefined;
}

/**
 * Failed tasks nobody is deciding: no question waiting on J, not held by an investigation, no rescue under way. J's
 * "try again" that nothing acted on (15 minutes): planned again. J already decided it (its agent changed nothing): one
 * question. Otherwise outOfTries: a rescue (walk-away, the first time), else one question in J's Inbox. An answer of the
 * last day is the PM's to act on (a "decided" event) and left alone. Returns the tasks it acted on.
 */
export async function sweepFailed() {
  const out: string[] = [];
  const asked = askedJ();
  const { DECIDED } = await changes();
  for (const r of db.prepare(`SELECT id FROM tasks WHERE status = 'failed'`).all() as any[]) {
    const t = getTask(r.id)!;
    // Every attempt found it already done: done (a question asked about it is settled in the Inbox: inbox.ts tidy).
    if (!heldFor(t.id) && await everyTrySaidDone(t)) { out.push(t.id); continue; }
    if (heldFor(t.id) || asked.has(t.id) || (t.change && asked.has(t.change)) || rescues()[t.id]?.state === 'scouting') continue;
    // Liveness: a Studio-side failure is retried (tries given back), a failed task holding others up gets two automatic re-plans before J.
    if (retryStudioFailure(t) || autoReplan(t)) { out.push(t.id); continue; }
    const since = (db.prepare(`SELECT MAX(created) AS at FROM changes WHERE task = ?`).get(t.id) as any)?.at ?? t.created;
    const q = (db.prepare(`SELECT * FROM questions WHERE subject IN (?, ?) AND at >= ? ORDER BY at DESC LIMIT 1`).get(t.id, t.change ?? t.id, since) as any) ?? null;
    if (q && q.status === 'answered' && /^(try|retry|again|yes)/i.test(String(q.answer ?? '').trim())) {
      if (Date.now() - (q.answered_at ?? 0) < 15 * 60_000) continue;
      updateTask(t.id, { status: 'planned' });
      logDecision('retry', t.id, t.product, `"${t.title}": ${q.answered_by ?? 'J'} answered ${q.id} "${String(q.answer).slice(0, 120)}" and nothing started it: planned again from scratch`, tasksUndo([t.id]));
      out.push(t.id);
      continue;
    }
    if (q && Date.now() - (q.answered_at ?? q.at) < 86_400_000) continue;
    if (String(t.note ?? '').includes(DECIDED)) {
      askJ(`"${t.title}" (${name(t.product)}): its agent changed nothing because you already decided it (${String(t.note).slice(0, 500)}). Drop the task, or change what it should do?`, { subject: t.id, product: t.product, options: ['drop it', 'change it'], recommend: 'drop it', from: 'a failed task nobody was asked about' });
    } else {
      const s = pmSettings();
      outOfTries(t, `it was failed and nobody was asked: ${String(t.note ?? '').slice(0, 600)}`, () => askJ(`"${t.title}" (${name(t.product)}) failed (${t.tries} of ${s.maxTries} tries used): ${String(t.note ?? '?').slice(0, 600)}. Try again, change it, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change it', 'drop it'], recommend: 'try again', from: 'a failed task nobody was asked about' }));
    }
    out.push(t.id);
  }
  return out;
}

/**
 * A task whose agents never got to work because Studio failed (a clone, a checkout, the source of a Unity repo): its latest
 * attempt was a Studio failure (infra-failure.ts), so nothing the agent did is held against it. Returns the error and how
 * many of its tries were the agent's own (the rest are given back), or null when the cause was the work itself.
 */
function studioSideFailure(t: Task): { why: string; tries: number } | null {
  const rows = db.prepare(`SELECT status, detail, ${INFRA_FAILED_SQL} AS infra FROM changes WHERE task = ? ORDER BY created DESC, rowid DESC LIMIT 12`).all(t.id) as any[];
  if (!rows.length) return isInfraText(t.note) ? { why: String(t.note), tries: 0 } : null;
  if (!rows[0].infra) return null;
  return { why: String(rows[0].detail ?? t.note ?? '?'), tries: rows.filter((r) => r.status === 'failed' && !r.infra).length };
}

/**
 * Dependencies that will not move by themselves (J, 2026-11-03: Yooba Land's k_b14454bbe903, k_1e22e77e1fb3 and k_881cfd303c31
 * sat in Planned for days behind k_49f909a23801, an idea whose agents had failed on Studio's own checkout). A planned task
 * is blocked by a task that is an idea, failed, or gone: nobody is working on it, so it waits for ever. Each pass:
 *  - a dependency whose latest attempt was a Studio-side failure (no source, a clone) is planned again with the tries
 *    that were Studio's given back (undo in the PM log); it starts in a free slot, spaced by infraHoldOf;
 *  - a dependency that no longer exists is taken off the task;
 *  - an idea nobody is planning (not held for other work, not asked about, not J's own park) is ONE question in J's
 *    Inbox (the stall question: try them again / drop them / leave them), once a day at most.
 * A failed dependency with real tries used is sweepFailed's (rescue, then J). The task's own page says why it waits (waitingOn).
 */
export function unblockDependencies(now = Date.now()): string[] {
  const out: string[] = [];
  const dependents = (db.prepare(`SELECT t.id FROM tasks t JOIN items i ON i.id = t.item WHERE t.status = 'planned' AND t.depends != '[]'
    AND i.status NOT IN ('idea', 'dropped') AND NOT (i.status = 'done' AND i.consumed IS NULL) ORDER BY i.ord, t.ord`).all() as any[]).map((r) => getTask(r.id)!).filter(Boolean);
  const stuck = new Map<string, Task[]>();
  for (const t of dependents) {
    for (const b of blockedBy(t)) {
      if (!STUCK_DEPENDENCY.includes(b.status)) continue;
      if (b.status === 'missing') {
        const rest = t.depends.filter((d) => d !== b.id);
        setTask(t.id, { depends: rest, note: `its dependency ${b.id} no longer exists: taken off, it no longer waits on it` });
        logDecision('unblock', t.id, t.product, `"${t.title}" waited on ${b.id}, which no longer exists: the dependency is taken off`, { kind: 'tasks', change: null, tasks: [{ id: t.id, status: t.status, tries: t.tries, note: t.note, checks: t.checks }] });
        out.push(t.id);
        continue;
      }
      stuck.set(b.id, [...(stuck.get(b.id) ?? []), t]);
    }
  }
  const asked = askedJ();
  const s = pmSettings();
  const ask: { dep: Task; waiting: Task[] }[] = [];
  for (const [id, waiting] of stuck) {
    const dep = getTask(id);
    if (!dep || heldFor(dep.id) || hasLiveChange(dep.id) || asked.has(dep.id) || (dep.change && asked.has(dep.change)) || rescues()[dep.id]?.state === 'scouting') continue;
    const cause = studioSideFailure(dep);
    const parkedByPerson = /^(parked|dropped) on \S+'s answer/.test(String(dep.note ?? ''));
    if (cause && !parkedByPerson) {
      const undo = tasksUndo([dep.id]);
      setTask(dep.id, { status: 'planned', tries: Math.min(dep.tries, cause.tries), checks: null, note: `planned again by the PM: it was ${dep.status} because Studio could not run its agent (${cause.why.slice(0, 240)}), not because of the work; tries given back, ${waiting.length} task(s) wait on it` });
      logDecision('unblock', dep.id, dep.product, `"${dep.title}" was ${dep.status} and holds up ${waiting.map((w) => `"${w.title}" (${w.id})`).join(', ')}: its last attempt failed in Studio (${cause.why.slice(0, 240)}), so it is planned again with ${Math.min(dep.tries, cause.tries)} of ${s.maxTries} tries used`.slice(0, 1500), undo);
      out.push(dep.id);
      continue;
    }
    // Two automatic re-plans (a failed dependency one tier up, an idea planned) before J is asked.
    if (!parkedByPerson && autoReplan(dep, waiting)) { out.push(dep.id); continue; }
    // An idea held for other work (releaseHeldIdeas), a failed task (sweepFailed): not this pass's to decide.
    if (dep.status !== 'idea' || /\b(held|hold|holds|holding|waits? for|until|after|once)\b/i.test(String(dep.note ?? ''))) continue;
    ask.push({ dep, waiting });
  }
  if (ask.length) {
    const day = db.prepare(`SELECT context, text FROM questions WHERE topic = 'stall' AND COALESCE(answered_at, at) >= ?`).all(now - 86_400_000) as any[];
    const fresh = ask.filter(({ dep }) => !day.some((q) => String(q.context ?? '').split(/\s+/).includes(dep.id) || String(q.text ?? '').includes(dep.id)));
    if (fresh.length) {
      const list = fresh.map(({ dep, waiting }) => `${dep.id} "${dep.title}" (${name(dep.product)}, an idea${dep.note ? `: ${String(dep.note).replace(/\s+/g, ' ').slice(0, 160)}` : ''}) holds up ${waiting.map((w) => `${w.id} "${w.title}"`).join(', ')}`).join('; ');
      askJ(`Roadmap tasks are waiting on tasks that nobody is working on: ${list}. Plan them (so the rest can start), drop them (the rest start without them), or leave them?`.slice(0, 3500),
        { subject: 'stall', topic: 'stall', options: ['try them again', 'drop them', 'leave them'], recommend: 'try them again', context: fresh.map((f) => f.dep.id).join(' '), blocks: `${fresh.reduce((n, f) => n + f.waiting.length, 0)} roadmap task(s) behind them`, from: 'tasks blocked by an idea' });
      logDecision('unblock', null, null, `asked J about ${fresh.length} idea(s) that hold up other tasks: ${fresh.map((f) => f.dep.id).join(', ')}`);
    }
  }
  return out;
}

/** Liveness (J, 2026-11-03: "work that's in the roadmap is ALWAYS being worked on"): how many automatic repairs a task has had. */
export const AUTO_REPLANS = 2;
const repairsOf = (subject: string) => (db.prepare(`SELECT COUNT(*) AS n FROM pm_log WHERE action = 'replan' AND subject = ? AND undone IS NULL`).get(subject) as any).n as number;
const dependentsOf = (id: string) => (db.prepare(`SELECT t.id FROM tasks t WHERE t.status = 'planned' AND t.depends LIKE ?`).all(`%${id}%`) as any[]).map((r) => getTask(r.id)!).filter((t) => t && t.depends.includes(id));
/** Minutes a Studio-side failure waits before it is tried again (a back-off, not a tight loop). */
export const STUDIO_RETRY_MS = 10 * 60_000;

/**
 * A failed task whose latest attempt was Studio's own failure (no source, a restart, a tool error: infra-failure.ts) is
 * planned again with the tries that were Studio's given back, once the back-off has passed. Nothing the agent did is
 * held against it. A task a person parked, or one under investigation, is left alone. Returns whether it acted.
 */
export function retryStudioFailure(t: Task, now = Date.now()): boolean {
  if (t.status !== 'failed' || heldFor(t.id) || /^(parked|dropped) on \S+'s answer/.test(String(t.note ?? ''))) return false;
  const cause = studioSideFailure(t);
  if (!cause) return false;
  const lastAt = (db.prepare(`SELECT MAX(updated) AS at FROM changes WHERE task = ?`).get(t.id) as any)?.at ?? t.updated ?? t.created;
  if (now - lastAt < STUDIO_RETRY_MS) return false;
  const undo = tasksUndo([t.id]);
  setTask(t.id, { status: 'planned', tries: Math.min(t.tries, cause.tries), checks: null, note: `planned again by the PM: Studio could not run its agent (${cause.why.slice(0, 240)}), not the work; tries given back` });
  logDecision('replan', t.id, t.product, `"${t.title}" failed in Studio (${cause.why.slice(0, 240)}), not in its work: planned again after a ${Math.round(STUDIO_RETRY_MS / 60_000)}-minute back-off with ${Math.min(t.tries, cause.tries)} tries used (not counted: Studio's)`.slice(0, 1500), undo);
  return true;
}

/**
 * A failed task or idea that holds up planned tasks is planned again by Studio itself, twice (the third time is J's
 * question): a failed one gets one more try on the next model tier up (the attempt number drives the route, routing.ts, so
 * its tries are set one below the limit; its earlier attempts go in the brief), an idea is planned. Returns whether it acted.
 */
export function autoReplan(t: Task, waiting: Task[] = dependentsOf(t.id)): boolean {
  if (!['failed', 'idea'].includes(t.status) || !waiting.length || heldFor(t.id) || hasLiveChange(t.id) || repairsOf(t.id) >= AUTO_REPLANS) return false;
  if (/^(parked|dropped) on \S+'s answer/.test(String(t.note ?? '')) || (t.status === 'idea' && /\b(held|hold|holds|holding|waits? for|until|after|once)\b/i.test(String(t.note ?? '')))) return false;
  if (rescues()[t.id]?.state === 'scouting') return false;
  const s = pmSettings();
  const n = repairsOf(t.id) + 1;
  const undo = tasksUndo([t.id]);
  const tries = t.status === 'failed' ? Math.max(0, Math.min(t.tries, s.maxTries - 1)) : t.tries;
  setTask(t.id, { status: 'planned', tries, checks: null, note: `planned again by the PM (automatic re-plan ${n} of ${AUTO_REPLANS}): ${waiting.length} task(s) wait on it; ${t.status === 'failed' ? 'one more try on the next model tier up, with what the earlier attempts found' : 'it was an idea nobody was planning'}` });
  logDecision('replan', t.id, t.product, `"${t.title}" was ${t.status} and holds up ${waiting.map((w) => `"${w.title}" (${w.id})`).join(', ')}: planned again by Studio (automatic re-plan ${n} of ${AUTO_REPLANS}${t.status === 'failed' ? `, ${tries} of ${s.maxTries} tries used, so its agent runs one tier up` : ''}); J is asked only if this fails too`.slice(0, 1500), undo);
  return true;
}

/**
 * An item that is planned but has no tasks (i_6dd54b95d6c6 sat so for days: nothing scheduled it). A task is made from its
 * goal and acceptance criteria. When merged changes already name the item, they go in the task's request as evidence
 * and its agent checks first: found done, the task is done (everyTrySaidDone), on beta with the evidence, no new change.
 * Returns the items it planned.
 */
export function planEmptyItems(now = Date.now()): string[] {
  const out: string[] = [];
  const rows = db.prepare(`SELECT id FROM items WHERE status = 'planned' ORDER BY ord`).all() as any[];
  for (const r of rows) {
    const it = getItem(r.id);
    if (!it || (it.tasks ?? []).length) continue;
    if (now - (it.updated ?? it.created) < 60_000) continue; // Talk may be adding its tasks right now
    const text = [it.goal, it.why].filter(Boolean).join('\n\n').trim() || it.title;
    let merged: any[] = [];
    try { merged = db.prepare(`SELECT id, title FROM changes WHERE status = 'merged' AND (request LIKE ? OR title LIKE ?) ORDER BY created DESC LIMIT 5`).all(`%${it.id}%`, `%${it.id}%`) as any[]; } catch { /* no request column */ }
    const evidence = merged.length ? `\n\nEvidence: ${merged.map((c) => `${c.id} "${String(c.title ?? '').slice(0, 80)}"`).join(', ')} already merged and name this item. Check whether they did it: if every criterion is already met on beta, make no change and say so; else do what is missing.` : '';
    // The item's goal is the task's player goal (an infra item's, its outcome); the gate (taskbar.ts) writes the rest.
    const t = addTask({ item: it.id, title: it.title, request: `${it.title}\n\n${text}${evidence}`, criteria: it.criteria, priority: null, ...(it.goal ? (isInfra(it.product) ? { outcome: it.goal } : { goal: it.goal }) : {}) });
    logDecision('plan', t.id, it.product, `"${it.title}" (${it.id}) was planned with no tasks, so nothing could start: Studio made ${t.id} from its goal and ${it.criteria.length} acceptance criteri${it.criteria.length === 1 ? 'on' : 'a'}${merged.length ? `; ${merged.length} merged change(s) already name it, its agent checks them first` : ''}`.slice(0, 1500), { kind: 'tasks', change: null, tasks: [{ id: t.id, status: 'dropped', tries: 0, note: 'dropped: undone', checks: null }] });
    out.push(it.id);
  }
  return out;
}

export const LIVENESS_MINUTES = 30;
/**
 * The liveness watchdog (each PM tick, after a restart, and on the stall pass; no timer of its own): every unfinished roadmap
 * task or item with no change in 30 minutes and no agent running, that isn't waiting on J, a GPU budget or a dependency
 * that is moving, gets a repair (above) and a line in the PM log. What no repair fits is logged once an hour with the exact
 * reason and who acts, and the stall watch asks J. Returns what it did.
 */
export function livenessWatch(now = Date.now()): string[] {
  const out: string[] = [];
  const asked0 = askedJ();
  const log = (id: string | null, product: string | null, msg: string) => { logDecision('liveness', id, product, msg.slice(0, 1500)); out.push(msg); };
  // Repairs first, so the check below sees their result (the tick already ran the dependency passes).
  try { const p = planEmptyItems(now); if (p.length) log(null, null, `planned ${p.length} item(s) that had no tasks: ${p.join(', ')}`); } catch (e: any) { console.warn(`[pm] liveness repair: ${e.message ?? e}`); }
  for (const r of db.prepare(`SELECT id FROM tasks WHERE status IN ('failed', 'idea')`).all() as any[]) {
    const t = getTask(r.id)!;
    if (asked0.has(t.id) || (t.change && asked0.has(t.change)) || (t.status === 'failed' && now - (t.updated ?? t.created) < LIVENESS_MINUTES * 60_000)) continue;
    if (t.status === 'failed' ? retryStudioFailure(t, now) : false) log(t.id, t.product, `"${t.title}": a Studio-side failure, planned again (tries given back)`);
    else if (autoReplan(t)) log(t.id, t.product, `"${t.title}" (${t.id}) held up other tasks: planned again`);
  }
  const asked = askedJ();
  const sinceLog = (db.prepare(`SELECT subject, MAX(at) AS at FROM pm_log WHERE action = 'liveness' GROUP BY subject`).all() as any[]);
  const lastLogged = new Map<string, number>(sinceLog.map((r) => [r.subject, r.at]));
  for (const r of stallReasons()) {
    const t = getTask(r.task)!;
    if (hasLiveChange(t.id) || ['working', 'needs answer', 'review'].includes(t.status)) continue;
    const changed = Math.max(t.updated ?? 0, t.created, (db.prepare(`SELECT MAX(updated) AS at FROM changes WHERE task = ?`).get(t.id) as any)?.at ?? 0);
    if (now - changed < LIVENESS_MINUTES * 60_000) continue;
    if (asked.has(t.id) || (t.change && asked.has(t.change)) || (t.gpu?.items?.length && !gpuCleared(t))) continue;
    if (blockedBy(t).some((b) => !STUCK_DEPENDENCY.includes(b.status))) continue; // a live dependency: it moves when that does
    if (now - (lastLogged.get(t.id) ?? 0) < 3600_000) continue;
    const who = /^needs J|^failed|^blocked by .*(idea|failed)/.test(r.why) ? 'Studio acts first, then J if two automatic re-plans fail' : 'Studio acts';
    log(t.id, t.product, `"${t.title}" (${t.id}, ${t.status}) has not moved for ${Math.round((now - changed) / 60_000)} min: ${r.why} (${who})`);
  }
  return out;
}

/** An item is on beta (itemProgress), or will never be (gone, dropped, every task dropped): nothing to hold for. */
const itemSettled = (id: string) => {
  const it = getItem(id);
  return !it || it.status === 'dropped' || ['on beta', 'verified', 'live', 'done', 'dropped'].includes(itemProgress(it).state);
};

/**
 * Tasks parked as ideas until other work is on beta (their note: "held until i_... is on beta", "waits for k_...",
 * "after \"The Shaft\" lands"): planned again, with a log line, once everything the note names is on beta (or dropped).
 * Items and tasks by id, or an item of the same product by its quoted title. In planned (or consumed) items only: an
 * item J parked stays parked. Returns the tasks it released.
 */
export function releaseHeldIdeas() {
  const out: string[] = [];
  const HELD = /\b(held|hold|holds|holding|park(ed)?|wait(s|ing)?|until|after|once)\b/i;
  const rows = db.prepare(`SELECT t.id FROM tasks t JOIN items i ON i.id = t.item WHERE t.status = 'idea' AND t.note IS NOT NULL
    AND i.status NOT IN ('idea', 'dropped') AND NOT (i.status = 'done' AND i.consumed IS NULL)`).all() as any[];
  for (const r of rows) {
    const t = getTask(r.id)!;
    const note = String(t.note);
    if (!HELD.test(note)) continue;
    const items = new Set(note.match(/\bi_[0-9a-f]{12}\b/g) ?? []);
    const tasks = new Set((note.match(/\bk_[0-9a-f]{12}\b/g) ?? []).filter((k) => k !== t.id));
    for (const m of note.matchAll(/["“]([^"”]{3,120})["”]/g)) {
      const hit = db.prepare(`SELECT id FROM items WHERE product = ? AND lower(title) = lower(?)`).get(t.product, m[1].trim()) as any;
      if (hit) items.add(hit.id);
    }
    items.delete(t.item);
    if (!items.size && !tasks.size) continue;
    const waiting = [...[...items].filter((x) => !itemSettled(x)), ...[...tasks].filter((k) => { const x = getTask(k); return Boolean(x) && !landed(x!) && x!.status !== 'dropped'; })];
    if (waiting.length) continue;
    const names = [...items, ...tasks];
    setTask(t.id, { status: 'planned', note: `released: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} on beta (it was held: ${note.slice(0, 300)})` });
    logDecision('release', t.id, t.product, `"${t.title}" was held as an idea until ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} on beta, and ${names.length === 1 ? 'it is' : 'they are'}: planned, it starts in a free slot`, { kind: 'tasks', change: null, tasks: [{ id: t.id, status: 'idea', tries: t.tries, note: t.note, checks: t.checks }] });
    out.push(t.id);
  }
  return out;
}

/**
 * The stall reasons nothing in Studio will resolve by itself: failed with nobody deciding, blocked by a task that
 * failed, is an idea or is gone, or planned and startable but not starting. The rest wait on an agent, a build, a
 * GPU budget, J's open question, or Studio's own next pass.
 */
function stuckOf(reasons: StallReason[]) {
  return reasons.filter((r) => {
    if (r.why.startsWith('failed:')) return true;
    if (r.why.startsWith('blocked by')) return blockedBy(getTask(r.task)!).some((b) => ['failed', 'idea', 'missing'].includes(b.status));
    // Startable, yet nothing of its product is in flight to wait for.
    return r.status === 'planned' && r.why.startsWith('a free agent')
      && !db.prepare(`SELECT 1 FROM changes WHERE product = ? AND status IN (${LIVE.map(() => '?').join(',')}) LIMIT 1`).get(r.product, ...LIVE);
  });
}

/** Minutes with nothing started or finished before the stall watch looks into it. */
export const STALL_MINUTES = 30;
export type StallReason = { task: string; title: string; product: string; status: string; why: string };
let lastStall: { at: number; stalled: boolean; reasons: StallReason[] } | null = null;

/** Why each unfinished roadmap task isn't moving, in plain words (studio_pm status, the stall decision). */
export function stallReasons(): StallReason[] {
  const out: StallReason[] = [];
  let rows: any[];
  try {
    rows = db.prepare(`SELECT t.id FROM tasks t JOIN items i ON i.id = t.item WHERE t.status NOT IN ('idea', 'dropped', 'verified', 'live', 'done')
      AND i.status NOT IN ('idea', 'dropped') AND NOT (i.status = 'done' AND i.consumed IS NULL) ORDER BY i.ord, t.ord`).all() as any[];
  } catch {
    return out;
  }
  const asked = askedJ();
  for (const r of rows) {
    const t = getTask(r.id)!;
    if (landed(t)) continue;
    const blocker = blockerOf(t.product);
    let why: string;
    if (asked.has(t.id) || (t.change && asked.has(t.change))) why = 'needs J: a question in his Inbox';
    else if (t.status === 'working' && !hasLiveChange(t.id) && t.change && db.prepare(`SELECT 1 FROM changes WHERE id = ? AND status = 'cancelled'`).get(t.change)) why = `paused: its agent change ${t.change} was cancelled (Resume or Close it in Activity)`;
    else if (['working', 'needs answer', 'review'].includes(t.status) && !hasLiveChange(t.id)) why = 'stale status: no agent change is running for it (reconciled next pass)';
    else if (t.status === 'failed') why = heldFor(t.id) ? `held: investigation ${heldFor(t.id)!.change} fixes beta first` : rescues()[t.id]?.state === 'scouting' ? 'out of tries: a scout is investigating, then a fresh round' : `failed: ${String(t.note ?? '').slice(0, 200)}`;
    else if (t.status === 'merged' && t.build && !t.build.ok) why = `broken build: ${t.build.detail.slice(0, 200)}${blocker ? `; the fix in ${name(blocker.b.target)} (${blocker.fix}) is under way` : ''}`;
    else if (t.status === 'planned' && blockedBy(t).length) why = `blocked by ${waitingOn(t).replace(/^waiting on /, '')}`;
    else if (t.status === 'planned' && !blockedBy(t).length && !(t.gpu?.items?.length && !gpuCleared(t)) && startWaitReason(t)) why = `waits: ${startWaitReason(t)}`;
    else why = taskWaits(t, asked) ?? t.status;
    out.push({ task: t.id, title: t.title, product: t.product, status: t.status, why });
  }
  return out;
}

let lastSelfCheck = 0;
/**
 * The self-check (J, 2026-11-02: planned work sat for a day and nobody noticed): planned, startable tasks and nothing
 * started or finished for STALL_MINUTES logs the exact reasons (the daily limit, busy slots, a failing clone, ...) once an
 * hour, and says so in the PM log. It runs on the first pass after a start and on every pass. Returns what it logged.
 */
export function stallSelfCheck(reasons: StallReason[], moved: number, now = Date.now(), log: (m: string) => void = (m) => console.warn(m)): string | null {
  const planned = reasons.filter((r) => r.status === 'planned' && r.why.startsWith('waits:'));
  if (!planned.length || now - moved < STALL_MINUTES * 60_000 || now - lastSelfCheck < 3600_000) return null;
  lastSelfCheck = now;
  const kinds = new Map<string, number>();
  for (const r of planned) kinds.set(r.why, (kinds.get(r.why) ?? 0) + 1);
  const msg = `${planned.length} planned task(s) have not started for ${Math.round((now - moved) / 60_000)} min: ${[...kinds].map(([k, n]) => `${n} ${k}`).join('; ')}`.slice(0, 1500);
  log(`[pm] stall self-check: ${msg}`);
  logDecision('stall-check', null, null, msg);
  return msg;
}
/** Tests: the hour between self-checks starts over. */
export const resetSelfCheck = () => { lastSelfCheck = 0; };

/**
 * The stall watch, each pass: unfinished roadmap work, free agents, and nothing started or finished for STALL_MINUTES.
 * Then it says why per task (stallReasons) and fixes what it can: reconciling and failed tasks happen every pass
 * already; a product whose beta build is broken with nobody on it gets a task sent back (top priority). One "stall"
 * decision per stall. Only what really needs J reaches his Inbox (outOfTries, the questions above).
 */
export async function stallWatch(now = Date.now()) {
  const s = pmSettings();
  const reasons = stallReasons();
  lastStall = { at: now, stalled: false, reasons };
  // Its question about stuck tasks is settled once none are stuck.
  if (!stuckOf(reasons).length) {
    for (const q of listQuestions().filter((x) => x.topic === 'stall')) setQuestion(q.id, { status: 'resolved', answer: '(no longer waiting: the roadmap moves again)', answered_by: 'Studio' });
  }
  const moved = Math.max(
    (db.prepare(`SELECT MAX(created) AS at FROM changes`).get() as any)?.at ?? 0,
    (db.prepare(`SELECT MAX(updated) AS at FROM changes WHERE status IN ('ready', 'merged', 'failed', 'closed')`).get() as any)?.at ?? 0,
    (db.prepare(`SELECT MAX(at) AS at FROM pm_log WHERE action = 'start'`).get() as any)?.at ?? 0,
  );
  stallSelfCheck(reasons, moved, now);
  if (!s.enabled || !reasons.length || capacity().free <= 0) return lastStall;
  if (now - moved < STALL_MINUTES * 60_000) return lastStall;
  lastStall.stalled = true;
  // Once per stall (until something starts or finishes again).
  if (((state() as any).stallAt ?? 0) >= moved) return lastStall;
  saveState({ stallAt: now });
  const fixed: string[] = [];
  // Broken beta builds nobody is fixing: the newest merged task goes back to an agent.
  const broken = new Map<string, Task[]>();
  for (const r of db.prepare(`SELECT id FROM tasks WHERE status = 'merged'`).all() as any[]) {
    const t = getTask(r.id)!;
    if (t.build && !t.build.ok && hasBeta(t.product)) broken.set(t.product, [...(broken.get(t.product) ?? []), t]);
  }
  for (const [product, list] of broken) {
    if (blockerOf(product)) continue;
    const productTasks = (db.prepare(`SELECT id FROM tasks WHERE product = ?`).all(product) as any[]).map((x) => x.id as string);
    if (productTasks.some(hasLiveChange)) continue;
    if (db.prepare(`SELECT 1 FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ?`).get(`%"${product}"%`)) continue;
    const last = list.reduce((a, b) => ((a.merged_at ?? 0) >= (b.merged_at ?? 0) ? a : b));
    await buildSendBack(last);
    if (getTask(last.id)!.status !== 'merged') fixed.push(`${name(product)}: "${last.title}" ${getTask(last.id)!.status === 'failed' ? 'is out of tries for beta\'s build' : 'sent back for beta\'s build'}`);
  }
  // What nothing here resolves by itself: ONE question in J's Inbox (filed again, it merges into the open one); his
  // answer acts on the tasks it names (answerQuestion, topic "stall").
  const stuck = stuckOf(stallReasons());
  if (stuck.length) {
    askJ(`Roadmap work isn't moving and Studio can't move it by itself (${stuck.length} task(s)): ${stuck.slice(0, 8).map((r) => `${r.task} "${r.title}" (${name(r.product)}): ${r.why}`).join('; ')}. Try them again (and what they wait on), drop them, or leave them for now?`.slice(0, 3500),
      { subject: 'stall', topic: 'stall', options: ['try them again', 'drop them', 'leave them'], recommend: 'try them again', context: stuck.map((r) => r.task).join(' '), blocks: `${stuck.length} roadmap task(s)`, from: 'the stall watch' });
    fixed.push(`asked J about ${stuck.length} task(s) nothing else moves`);
  }
  {
    const kinds = new Map<string, number>();
    for (const r of reasons) { const k = r.why.split(':')[0]; kinds.set(k, (kinds.get(k) ?? 0) + 1); }
    logDecision('stall', null, null, `nothing started or finished for ${Math.round((now - moved) / 60_000)} min with ${capacity().free} free agent(s) and ${reasons.length} unfinished task(s): ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}${fixed.length ? `. Fixed: ${fixed.join('; ')}` : ''}`.slice(0, 1500));
  }
  return lastStall;
}

// ---------------------------------------------------------------- PM turns

let turn: { conversation: string; subjects: string[]; started: number } | null = null;

/** The day's PM conversation (a Talk conversation of kind "pm"). */
export async function pmConversation() {
  const st = state();
  const talk = await import('./talk.ts');
  if (st.conversation?.day === today() && talk.getConversation(st.conversation.id)) return st.conversation.id;
  try { db.exec('ALTER TABLE conversations ADD COLUMN kind TEXT'); } catch { /* already there */ }
  const c = talk.startConversation(`Studio PM: ${today()}`);
  db.prepare(`UPDATE conversations SET kind = 'pm' WHERE id = ?`).run(c.id);
  saveState({ conversation: { id: c.id, day: today() } });
  return c.id;
}

/** The PM's instructions, sent with each PM turn (the events go below them). */
export function pmPrompt(evs: PmEvent[], daily: boolean, inbox: string | null = null) {
  const s = pmSettings();
  const customer = customerStudio();
  const cap = capacity();
  return `[Studio PM loop: this turn was started by Studio, not J. You are J's producer/PM. J sets direction with you in
Talk; you work the roadmap and the backlog with the agents so he comes back to finished, verified work.]

What came in since your last PM turn:
${evs.length ? evs.map((e) => `- ${e.kind}${e.subject ? ` (${e.subject})` : ''}: ${e.text}`).join('\n') : '- nothing new'}
${daily ? '\nThis is also the daily PM turn: triage the backlog and look over the roadmap.\n' : ''}
J's Inbox: ${inbox ?? 'empty'}.
Limits now: ${cap.active} agents working and ${cap.queued} queued (at most ${s.maxConcurrent} together), ${cap.started} of ${s.maxStartsPerDay} starts used today, ${s.maxTries} tries per task. Delegated merges into beta: ${s.delegatedMerges ? 'ON' : 'OFF (J approves merges)'}.
${s.walkAway ? (customer ? `Walk-away mode: ON (J turned it on in Settings). Decide routine calls yourself and log them; J's Inbox is
only for going live, rollbacks, GPU spending above J's caps ($${s.walkAwayGpuPerTask} a task, $${s.walkAwayGpuPerDay} a day), failures
after all tries, milestones and real direction choices. Criteria misses on beta are decided by Studio (retry, park, or
one investigation). Ready changes merge into beta, never live: going live is always J's.
` : `Walk-away mode: ON (J, 2026-10-18: "I just want this system to build build build"). Decide routine calls yourself and
log them; J's Inbox is only for going live, rollbacks, launching new GPU servers, spending above the caps, protected
files, failures after all tries, milestones and real direction choices. Studio and Gen changes merge into main by
themselves once green; criteria misses on beta are decided by Studio (retry, park, or one investigation). ${s.walkAwayCards ? `Approve cards
(studio_approval) approve themselves at once (as Studio (walk-away)); only GPU past the caps, cost-raising settings and
protected-file merges wait for J.` : ''}
`) : ''}
Do, with the studio_pm, studio_roadmap and studio tools:
1. Review each ready change (studio_change: the agent's summary, commits, diff size, preview; ready means its own checks
   passed and the pull request is open). Changes aren't playtested automatically: merge one into beta (studio_pm merge)
   when its summary and diff do what its task asks; beta isn't played after each merge (J's call): a merged task is on
   beta once beta's build of it succeeds (a failed build sends it back to an agent by itself), and when a milestone's
   tasks are all on beta, one beta playtest of their scenarios judges their criteria before J hears it's reached.
   Merge conflicts with beta resolve themselves (Studio merges beta into the branch; a real conflict goes back to the
   change's agent, not counted as a try): never revise a change just because it conflicts. Ask for a playtest of the change first (studio_change playtest) only when it's
   risky or unclear and a playtest would settle it. A change that was playtested and failed: send it back (studio_pm
   revise) with specific notes (what failed, what the review saw, what to change). After ${s.maxTries} tries it goes to J.
2. Answer agent questions (studio_pm answer) from what J already decided: the roadmap item's goal, why and criteria,
   the thread (studio_comments), earlier answers. Only a real direction choice goes to J (studio_pm ask_j).
3. Daily turn and after the daily run: triage the backlog (studio_backlog). Merge duplicates (studio_pm triage
   duplicate), mark polish that's below the product's bar won't-fix with a one-line note (triage wontfix), link bugs to
   the roadmap item they belong to (triage link). Leave blockers open. Don't churn: skip what's fine.
   Real players' data is already filed by Studio after the daily run, over minimum samples (source "players": errors
   they hit are backlog bugs; drop-offs, hard levels, low ratings and repeated complaints are ideas, never auto-fixed:
   J moves them). Weigh bugs and tasks by how many players they touch (studio_analytics), and say the sample.
4. Failures (an agent errored or made nothing): look at studio_change's log and summary; revise with a better note,
   or ask J if it's really his call.
5. Starting work is automatic (roadmap order, then the worst bugs, within the limits). Change the order or statuses
   with studio_roadmap when what came in says so (a blocker on a product jumps the queue: make or reorder a task).
   A task whose work is already on beta (another change did it) is status done (update_task, with a note saying
   which change), never dropped: done counts as on beta, dropped means it will never be done.
6. The shared memory${daily ? ' (daily turn)' : ' (when there are candidates)'}: ${curationLine() || 'nothing waiting.'} Curate with memory_curate:
   confirm a candidate that is true and useful, merge near-duplicates (list shows likely pairs), fade what no longer
   holds, delete what is wrong. A candidate that contradicts one of J's decisions or the canon: dispute it and ask J
   (studio_pm ask_j) which holds; never edit or fade J's decisions yourself. When J decided something in a thread or an
   answer, record it as a decision quoting his words. Keep it short: entries are one line plus specifics.
Never: go live or roll back, merge Studio or Gen changes yourself (walk-away mode does it when they're green), launch GPU servers, raise limits, or decide direction. Those
are J's. Anything you need from J is FILED, never only asked in prose: studio_inbox ask { text, options, recommend,
subject, product, blocks } (one clear question, the options as buttons, the option you would pick, what waits on it).
A question on the same subject merges into the open one, so filing again just updates it. Answers come back to you as
"decided" events. Anything you leave undecided gets Studio's default after this turn (merge if the change passes its
gate, else revise with the failures; unanswered agent questions go to J's Inbox).
End with a short log of what you did (a few lines): it stays in this PM conversation for J. Don't list or repeat
what is waiting on J: say "${inbox ?? 'N decisions in your Inbox'}" at most once, when it changed.`;
}

async function runPmTurn(daily: boolean) {
  const evs = events;
  events = [];
  const id = await pmConversation();
  const talk: any = await import('./talk.ts');
  const { inboxLine } = await import('./inbox.ts');
  const prompt = pmPrompt(evs, daily, await inboxLine().catch(() => null));
  if (typeof talk.studioTurn === 'function') talk.studioTurn(id, prompt);
  else talk.say(id, prompt);
  turn = { conversation: id, subjects: evs.map((e) => e.subject).filter(Boolean) as string[], started: Date.now() };
  if (daily) saveState({ daily: today() });
}

function turnRunning() {
  if (!turn) return false;
  const c = db.prepare('SELECT status FROM conversations WHERE id = ?').get(turn.conversation) as any;
  if (c?.status === 'thinking' && Date.now() - turn.started < 40 * 60_000) return true;
  return false;
}

// -------------------------------------------------------------------- loop

let ticking = false;
let lastError: string | null = null;
/** Whether a pass is running now (a tick() meanwhile does nothing): tests wait for the loop's own pass to end. */
export const pmTicking = () => ticking;
export async function tick() {
  if (ticking || !started) return;
  // A customer's Studio whose plan has no PM: the loop rests (it would start agents the plan doesn't include).
  if ((await import('./tenancy.ts')).customerStudio()) {
    try { await (await import('./entitlements.ts')).requireFeature('pm'); } catch { return; }
  }
  ticking = true;
  try {
    // Recording what happened can fail without stopping the starts below (it did: a Studio task's beta check threw).
    let failed: string | null = null;
    for (const [what, f] of [['watch', watch], ['syncTasks', syncTasks]] as const) {
      try {
        await f();
      } catch (e: any) {
        failed = `${what}: ${e.message ?? e}`;
        console.warn(`[pm] ${failed}`);
      }
    }
    lastError = failed;
    await settleFindingQuestions().catch((e) => console.warn(`[pm] settling bug questions: ${e.message ?? e}`));
    const s = pmSettings();
    // Walk-away mode: ready Studio/Gen changes merge by themselves once green, and the daily digest (agents.ts, above).
    if (s.walkAway) {
      try {
        (await changes()).walkAwayPending();
        await settleMissQuestions();
        await walkAwayDaily();
        // Cards that may approve themselves now (made before walk-away was on, or blocked until now).
        await (await import('./approvals.ts')).selfApproveWaiting();
      } catch (e: any) {
        console.warn(`[pm] walk-away: ${e.message ?? e}`);
      }
    }
    if (!s.enabled) return;
    // A PM turn that just ended: its leftovers get the defaults.
    if (turn && !turnRunning()) {
      const done = turn;
      turn = null;
      await applyDefaults(done.subjects);
    }
    await applyDefaults([], s.graceMinutes * 60_000);
    // Tasks that only failed because the harness stopped their agents: planned again with fresh tries (harness-hold.ts).
    await repairHarnessFailures().catch((e: any) => console.warn(`[pm] harness repair: ${e.message ?? e}`));
    // Failed tasks nobody was asked about: an investigation (walk-away) or one question in J's Inbox.
    await sweepFailed().catch((e: any) => console.warn(`[pm] failed tasks: ${e.message ?? e}`));
    // Tasks dropped as already done count as done; ideas held until other work is on beta are released once it is.
    try {
      adoptDoneDrops();
      planEmptyItems();
      releaseHeldIdeas();
      unblockDependencies();
    } catch (e: any) {
      console.warn(`[pm] done and held tasks: ${e.message ?? e}`);
    }
    const startedNow = await startWork();
    // A harness hold isn't idle slots or a stall: nothing may start, and it resumes by itself (studio_pm status "hold").
    const held = noProviderFree();
    // Where the time goes (pace.ts): idle slots and work parked on Gen/GPU, sampled each tick; idle slots with nothing
    // the PM may start get ONE question for J with scouts' proposals for the idle products.
    try {
      if (!held) await pace(startedNow.length);
    } catch (e: any) {
      console.warn(`[pm] pace: ${e.message ?? e}`);
    }
    // Nothing moving with free agents and work left: why, per task, and what it can fix (one "stall" decision).
    if (!held) { try { livenessWatch(); } catch (e: any) { console.warn(`[pm] liveness: ${e.message ?? e}`); } }
    if (!held) await stallWatch().catch((e: any) => console.warn(`[pm] stall watch: ${e.message ?? e}`));
    const daily = state().daily !== today() && new Date().getHours() >= s.dailyHour;
    if ((events.length || daily) && !turnRunning() && process.env.STUDIO_PM_TALK !== 'off') await runPmTurn(daily);
    lastError = failed;
  } catch (e: any) {
    lastError = String(e.message ?? e);
    console.warn(`[pm] ${lastError}`);
  } finally {
    ticking = false;
  }
}

/** Products with no planned or running work: no roadmap task to do, no change in flight, no open bug or report. */
export function idleProducts() {
  const busyStatuses = ['planned', 'working', 'needs answer', 'review'];
  return loadProducts().filter((p) => !managedElsewhereId(p.id)).map((p) => p.id).filter((id) => !isInfra(id)
    && !db.prepare(`SELECT 1 FROM tasks WHERE product = ? AND status IN (${busyStatuses.map(() => '?').join(',')}) LIMIT 1`).get(id, ...busyStatuses)
    && !db.prepare(`SELECT 1 FROM changes WHERE product = ? AND status IN (${LIVE.map(() => '?').join(',')}) LIMIT 1`).get(id, ...LIVE)
    && !db.prepare(`SELECT 1 FROM findings WHERE product = ? AND status = 'open' AND severity IN ('blocker', 'bug') LIMIT 1`).get(id));
}

/** One pace sample, and the idle-slot watch (pace.ts). startedNow: what this tick's startWork started. */
async function pace(startedNow: number, deps: Partial<IdleDepsLike> = {}) {
  const s = pmSettings();
  const cap = capacity();
  const { WAITING_GEN, agentSettings } = await changes();
  const parked = (db.prepare('SELECT COUNT(*) AS n FROM changes WHERE status = ?').get(WAITING_GEN) as any).n + (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ?').get(GPU_WAIT) as any).n;
  samplePace({ freeSlots: Math.max(0, s.maxConcurrent - cap.active), parked });
  const { startScout, getScout } = await import('./scout.ts');
  return idleWatch({ free: agentSettings().enabled ? cap.free : 0, started: startedNow }, {
    idleProducts, name,
    startScout: (product, question) => startScout(product, question, null, { quiet: true }),
    getScout,
    askJ: (text, o) => askJ(text, o),
    log: (detail) => logDecision('idle', IDLE_SUBJECT, null, detail.slice(0, 1500)),
    ...deps,
  });
}
type IdleDepsLike = Parameters<typeof idleWatch>[1];
/** For tests: one pace pass with stand-ins for the scouts and the products. */
export const paceForTest = pace;
/** For tests: the defaults pass (agent questions nobody answered, failed tasks). */
export const defaultsForTest = (subjects: string[], olderThan?: number) => applyDefaults(subjects, olderThan);

/** Defaults for subjects of the last turn, and for anything waiting longer than `olderThan`. */
async function applyDefaults(subjects: string[], olderThan?: number) {
  const { listChanges, getChange } = await changes();
  const now = Date.now();
  for (const c of listChanges({ status: 'ready' })) {
    if (!reviewable(c)) continue;
    if (subjects.includes(c.id) || (olderThan !== undefined && now - (c.updated ?? c.created) > olderThan && !turnRunning())) await defaultReview(c.id);
  }
  // Tasks whose change failed (read from the tasks, not the newest 100 changes: an older failure was never retried and
  // its task showed "working" for ever).
  for (const r of db.prepare(`SELECT t.id AS task, c.id AS change FROM tasks t JOIN changes c ON c.id = t.change WHERE c.status = 'failed' AND t.status IN ('working', 'needs answer', 'review')`).all() as any[]) {
    const c = getChange(r.change);
    const t = getTask(r.task);
    if (!c || !t) continue;
    // Another attempt of this task is going, or a newer one merged: that one is the task now, nothing to retry.
    if (db.prepare(`SELECT 1 FROM changes WHERE task = ? AND id != ? AND (status IN (${LIVE.map(() => '?').join(',')}) OR (status = 'merged' AND created > ?)) LIMIT 1`).get(t.id, c.id, ...LIVE, c.created)) continue;
    if (subjects.includes(c.id) || (olderThan !== undefined && now - (c.updated ?? c.created) > olderThan && !turnRunning())) {
      try {
        await afterFailed(t, c);
      } catch (e: any) {
        console.warn(`[pm] after ${c.id} failed: ${e.message ?? e}`);
      }
    }
  }
  // Agent questions nobody answered go to J.
  for (const q of listQuestions('open')) {
    if (q.kind !== 'agent') continue;
    if (subjects.includes(q.subject ?? '') || (olderThan !== undefined && now - q.at > olderThan && !turnRunning())) {
      const c = q.subject ? getChange(q.subject) : null;
      // A blocked agent first: Studio checks Gen (diagnose.ts) and resumes it with what it found; the card says what was tried.
      const tried = await diagnoseBlocked(q).catch((e: any) => { console.warn(`[pm] diagnosing ${q.id}: ${e?.message ?? e}`); return null; });
      if (tried === 'resumed') continue;
      setQuestion(q.id, { status: 'asked J' });
      askJ(`An agent working on "${c?.title ?? q.subject}" asks: ${q.text.slice(0, 1200)}`, { subject: c?.task ?? q.subject, product: q.product, forwards: q.id, topic: 'agent question', context: tried, blocks: `the agent on ${q.subject} (paused)`, from: 'an agent question the PM could not answer' });
    }
  }
}

/** Replaced by the tests: Hawkes Gen as Studio's key (diagnose.ts liveIO). */
export const diagnoseIO: { get: () => Promise<import('./diagnose.ts').IO> } = { get: async () => (await import('./diagnose.ts')).liveIO() };

/**
 * An agent's question that is really Gen refusing something (an expired link, a file or project not found, a 401): Studio
 * checks it (diagnose.ts), and if the check passes the agent is answered with what was found (it resumes). Otherwise the
 * card is filed with what was tried. Returns 'resumed', the "Tried:" line for the card, or null (not a Gen problem).
 */
export async function diagnoseBlocked(q: { id: string; text: string; subject?: string | null; product?: string | null }): Promise<'resumed' | string | null> {
  const D = await import('./diagnose.ts');
  const d = await D.diagnose(q.text, await diagnoseIO.get());
  if (!d) return null;
  const { causeFromKey } = await import('./causes.ts');
  const cause = causeFromKey(`gen-${d.kind}`);
  const line = `Studio checked first: ${d.tried.join('; ')}. ${d.found}.`;
  logCause(cause, { product: q.product, kind: d.ok ? 'answered' : 'card', ref: q.id, subject: q.subject ?? q.id, detail: line, dedup: `diagnosed:${q.id}` });
  if (!d.ok) return `${line} That did not clear it.`;
  logDecision('self-answer', q.subject ?? null, q.product ?? null, `diagnosed ${q.id} (${cause.label}) and resumed its agent: ${line}`.slice(0, 1500));
  await answerQuestion(q.id, `${d.answer}\n\n(${line})`, 'Studio PM (self-healing)');
  return 'resumed';
}

/** Events from the database: changes reaching ready, failed or needs answer; runs finishing. Each seen once. */
async function watch() {
  const since = Math.max(Date.now() - 2 * 86_400_000, pmSince());
  for (const c of db.prepare(`SELECT id, product, status, title, detail, task, findings, request, pm_seen FROM changes WHERE status IN ('ready', 'failed', 'needs answer', 'merged') AND COALESCE(updated, created) > ? AND COALESCE(pm_seen, '') != status`).all(since) as any[]) {
    db.prepare('UPDATE changes SET pm_seen = ? WHERE id = ?').run(c.status, c.id);
    if (isInfra(c.product) || c.status === 'merged') continue;
    const mine = c.task || (parse(c.findings)?.length && !c.request);
    if (!mine) continue;
    if (c.status === 'needs answer') {
      const q = listQuestions('open').find((x) => x.subject === c.id);
      pmEvent('question', `The agent on ${c.id} ("${c.title}") asks (${q?.id ?? '?'}): ${String(q?.text ?? c.detail).slice(0, 1500)}`, c.id, c.product);
    } else {
      const t = c.task ? getTask(c.task) : null;
      // A fix whose agent found the cause in another repo (Gen, Studio, another product): that change is started.
      if (c.status === 'failed' && !t) await blockerFromFix(c.id).catch((e: any) => console.warn(`[pm] blocker from ${c.id}: ${e.message ?? e}`));
      const what = t ? `Task ${t.id} ("${t.title}", ${name(c.product)}, try ${t.tries} of ${pmSettings().maxTries}): change ${c.id}` : `Fix ${c.id} ("${c.title}", ${name(c.product)})`;
      pmEvent(c.status === 'ready' ? 'ready' : 'failed', `${what} is ${c.status === 'ready' ? 'ready to review' : 'failed'}: ${c.detail ?? ''}`, c.id, c.product);
    }
  }
  // Studio and Gen changes stay J's; questions on them still go through the PM (it may ask J).
  for (const r of db.prepare(`SELECT id, kind, status, detail, products, pm_seen FROM runs WHERE status != 'running' AND COALESCE(finished, started) > ? AND pm_seen IS NULL AND kind IN ('daily', 'beta', 'live')`).all(since) as any[]) {
    db.prepare(`UPDATE runs SET pm_seen = 'yes' WHERE id = ?`).run(r.id);
    // A beta run a newer one took over (betaqueue.ts) is nothing to act on: the newer run reports.
    if (r.kind === 'beta' && r.status === 'skipped') continue;
    const products = (parse(r.products) ?? []).map(name).join(', ');
    if (r.kind === 'daily') {
      const filed = await workFromPlayers(r.id).catch((e: any) => { console.warn(`[pm] work from players: ${e.message ?? e}`); return []; });
      pmEvent('daily run', `The daily run ${r.id} finished (${r.status}): ${r.detail ?? ''}. Read studio_report { run: "${r.id}" } (each product's "Players" section is its real players) and triage the new findings.${filed.length ? ` From player data: ${filed.join('; ')}.` : ''}`, r.id);
    }
    else pmEvent(r.kind === 'beta' ? 'beta run' : 'live check', `${r.kind === 'beta' ? 'Beta run' : 'Go live'} ${r.id} (${products}) ${r.status}: ${r.detail ?? ''}`, r.id);
  }
}

/**
 * A daily run's player data (its "players" steps: pipeline.ts recordPlayers) becomes work, over the minimum samples
 * (players.ts MIN): errors real players hit become backlog bugs (source "players"), drop-offs, hard levels, low ratings
 * and repeated complaints go on the ideas list (never auto-fixed: J moves them). Deduped by key (backlog.ts
 * filePlayerWork). Each new one is in the PM log; undo marks it won't-fix (so it isn't filed again). Returns a line per
 * product that got new work.
 */
export async function workFromPlayers(run: string) {
  const { playerWork } = await import('./players.ts');
  const { filePlayerWork } = await import('./backlog.ts');
  const { isNoise } = await import('./bugreport.ts');
  const out: string[] = [];
  for (const st of db.prepare(`SELECT product, data FROM steps WHERE run = ? AND kind = 'players' AND status = 'done'`).all(run) as any[]) {
    const items = playerWork(parse(st.data), (m, s) => isNoise(m, s));
    if (!items.length) continue;
    const r = filePlayerWork(st.product, items);
    const kinds = new Map(items.map((w) => [w.key, w.kind]));
    const rows = [...r.added, ...r.reopened].map((id) => db.prepare('SELECT id, key, title, severity FROM findings WHERE id = ?').get(id) as any).filter(Boolean);
    for (const f of rows) {
      const bug = kinds.get(f.key) === 'bug';
      logDecision(bug ? 'players bug' : 'players idea', f.id, st.product, `${bug ? 'Backlog bug' : 'Ideas list'} from real players: "${f.title}"`, { kind: 'finding', id: f.id, status: 'wontfix', note: 'Filed from player data; undone in the PM log.' });
    }
    if (rows.length) out.push(`${name(st.product)}: ${rows.map((f) => `${f.id} "${f.title}" (${f.severity === 'bug' ? 'bug' : 'idea'})`).join(', ')}`);
  }
  return out;
}

// ------------------------------------------------------------------ the critic's scores become work

/** The roadmap's critic axis (roadmap.ts AXES) that a critic dimension belongs to. */
export const AXIS_OF_DIMENSION: Record<string, string> = {
  'fun': 'core-loop', 'feel': 'feel', 'clarity': 'core-loop', 'first five minutes': 'first-minute', 'menus and UI': 'menus-ui',
  'sound': 'sound', 'art cohesion': 'feel', 'story through play': 'story', 'phone': 'phone', 'reasons to come back': 'retention',
};
/** A task still on its way (the one to reuse); verified, live, done, dropped and failed ones are finished. */
const OPEN_TASK = ['idea', 'planned', 'working', 'needs answer', 'review', 'merged', 'waiting for GPU'];
const criticMark = (dimension: string) => `[critic:${dimension}]`;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The one open critic task for this game and dimension, if any (marked in its request). */
export function openCriticTask(product: string, dimension: string): Task | null {
  const rows = db.prepare(`SELECT id FROM tasks WHERE product = ? AND request LIKE ? AND status IN (${OPEN_TASK.map(() => '?').join(',')}) ORDER BY created`)
    .all(product, `%${criticMark(dimension)}%`, ...OPEN_TASK) as { id: string }[];
  return rows.length ? getTask(rows[0].id) : null;
}

/** The roadmap item this game's critic tasks hang on: made once, and again only if it can no longer start tasks. */
function criticItem(product: string, now: number) {
  const row = db.prepare(`SELECT id FROM items WHERE product = ? AND origin = 'critic' AND (status IN ('planned', 'in progress') OR (status = 'done' AND consumed IS NOT NULL)) ORDER BY created LIMIT 1`).get(product) as { id: string } | undefined;
  if (row) return getItem(row.id)!;
  return addItem({ product, title: 'Critic scores under target', goal: 'Every dimension the critic scores comes up to its target.', why: "The critic's weekly review: each score under target gets an owner and a fix.", origin: 'critic', by: 'Studio (critic)', status: 'planned', ord: now });
}

/** A critic score as a roadmap task that meets the task bar (taskbar.ts): player goal, reference, axis, phone line, criteria. */
export function criticTaskOf(a: { product: string; game: string; dimension: string; score: number; target: number; floor: number; reference: string; why: string; fix: string; frame?: string | null; at?: string; scenario?: string | null }) {
  const where = [a.frame ? `frame ${a.frame}` : '', a.at].filter(Boolean).join(', ');
  const fix = clip(a.fix, 300) || `raise ${a.dimension}`;
  const axis = AXIS_OF_DIMENSION[a.dimension] ?? 'core-loop';
  const phone = a.dimension === 'phone';
  const evidence = `Critic's review of ${a.game}${a.scenario ? ` (${a.scenario})` : ''}: ${a.dimension} scored ${a.score}/10, target ${a.target}/10.\nEvidence${where ? ` (${where})` : ''}: ${clip(a.why, 400) || 'none given'}\nReference game: ${a.reference}\nFix the critic named: ${fix}`;
  const request = [
    `Player goal: ${a.game} no longer loses a harsh player on ${a.dimension}: it reads ${a.target}/10 or better against ${a.reference}.`,
    `Reference: ${a.reference}${where ? `, the moment at ${where}` : ''}.`,
    `Critic axis: ${axis}`,
    `Phone: ${phone ? 'this IS the phone dimension: every part of the fix is judged at 390x844 on touch.' : 'the fix shows at 390x844 on touch with no sideways scrolling and every tap target about 44 px.'}`,
    '',
    `Bring ${a.dimension} up to ${a.target}/10: ${fix}`,
    '',
    'Original request:',
    `${criticMark(a.dimension)} ${evidence}`,
  ].join('\n');
  const criteria = [
    `The next critic review of ${a.game} scores ${a.dimension} at ${a.target}/10 or higher (it was ${a.score}/10)`,
    `Within one playtest of ${a.scenario ?? "the game"} the fix shows: ${fix}`.slice(0, 340),
    `[phone] On a 390x844 touch playtest the change shows with no horizontal scrolling and every control reachable by tap`,
  ];
  return { title: `${a.dimension} ${a.score}/10 (target ${a.target}): ${clip(a.fix, 90) || 'raise it'}`.slice(0, 160), request, criteria, axis, priority: a.score < a.floor ? 'high' : 'normal' };
}

/**
 * A critic review (critic.ts, a `critic` step) becomes work the same day: every dimension scored under its game's target
 * (products.json `targets`, default 7) gets exactly one planned roadmap task for that game, naming the dimension and
 * carrying the critic's evidence, its reference game and its fix, written to the task bar. A dimension that already has an
 * open task reuses it (a planned one not yet started takes the newer evidence; one underway gets a comment): no duplicates.
 * A dimension the critic couldn't judge ("no evidence") is not work. Returns a line per task made or reused.
 */
export function workFromCritic(productId: string, critic: any, run?: string | null, now = Date.now()) {
  if (!critic || critic.verdict !== 'judged' || !Array.isArray(critic.scores)) return [];
  const p = getProduct(productId);
  const floor = releaseFloorOf(p);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of critic.scores) {
    const score = Number(s?.score);
    const dimension = String(s?.dimension ?? '');
    if (!Number.isFinite(score) || !CRITIC_DIMENSIONS.includes(dimension as any) || seen.has(dimension)) continue;
    seen.add(dimension);
    const target = targetFor(p, dimension);
    if (score >= target || /^no evidence/i.test(String(s.why ?? '').trim())) continue;
    const t = criticTaskOf({ product: productId, game: p.name, dimension, score, target, floor, reference: clip(s.reference, 80) || 'its genre', why: s.why, fix: s.fix, frame: s.frame, at: s.at, scenario: critic.scenario });
    const open = openCriticTask(productId, dimension);
    if (open) {
      if (open.status === 'planned' && open.tries === 0) updateTask(open.id, { title: t.title, request: t.request, criteria: t.criteria, axis: t.axis, priority: t.priority });
      else addComment(open.id, `The critic scored ${dimension} ${score}/10 again (target ${target}/10)${run ? ` in ${run}` : ''}: ${clip(s.why, 300)} Fix: ${clip(s.fix, 300)}`, 'Studio (critic)', 'comment');
      out.push(`${name(productId)} ${dimension} ${score}/10: reused ${open.id}`);
      continue;
    }
    const item = criticItem(productId, now);
    const task = addTask({ item: item.id, title: t.title, request: t.request, criteria: t.criteria, axis: t.axis, priority: t.priority, status: 'planned' });
    logDecision('critic task', task.id, productId, `The critic scored ${name(productId)}'s ${dimension} ${score}/10 (target ${target}/10${score < floor ? `, under the release floor ${floor}` : ''}): planned "${task.title}" with its evidence, reference and fix.`, { kind: 'tasks', change: null, tasks: [{ id: task.id, status: 'dropped', tries: task.tries, note: 'Undone in the PM log.', checks: task.checks }] });
    out.push(`${name(productId)} ${dimension} ${score}/10: planned ${task.id}`);
  }
  return out;
}

/** What the dashboard and studio_pm status show. */
export async function pmStatus() {
  const { listChanges } = await changes();
  return {
    settings: pmSettings(), capacity: capacity(), limits: await limitNotices(), lastError, turn: turn && turnRunning() ? turn : null, pending: events,
    // The harness hold (harness-hold.ts): what refuses to run, until when, the stand-in, and what is parked on it.
    hold: holdStatus(),
    conversation: state().conversation ?? null, daily: state().daily ?? null,
    questions: listQuestions(), reviewing: listChanges({ status: 'ready' }).filter(reviewable).map((c) => ({ id: c.id, product: c.product, title: c.title, detail: c.detail, task: c.task })),
    log: listDecisions({ limit: 60 }),
    // Why each unfinished roadmap task isn't moving (the stall watch), and the PM's own unblocking work.
    stall: { stalled: lastStall?.stalled ?? false, at: lastStall?.at ?? null, reasons: stallReasons() },
    rescues: rescues(), blockers: blockers(),
    // Where today's time went (pace.ts), and the idle-slot watch's state.
    time: whereTimeGoes(Date.now(), isInfra), idle: idleState(),
  };
}

/** For a change's agent: its thread (re-exported for the API). */
export const threadOf = (c: any) => threadFor(c);

let started = false;
/** Whether the loop runs in this process (the server, or STUDIO_PM=on). */
export const pmRunning = () => started;
/** The loop: every minute, and soon after anything finishes. Not on J's PC unless STUDIO_PM=on (the cloud runs it). */
export function startPm() {
  if (started) return;
  started = true;
  if (!state().since) saveState({ since: Date.now() });
  // After a restart: every task reconciled from its changes at once, then a pass that starts what's startable (not a
  // minute later, nor on the next event).
  try {
    const n = reconcileTasks();
    if (n.length) logDecision('reconcile', null, null, `Studio started: ${n.length} task(s) reconciled from their changes (${n.slice(0, 12).join(', ')})`);
  } catch (e: any) {
    console.warn(`[pm] reconcile at start: ${e.message ?? e}`);
  }
  setTimeout(() => void tick(), 1000).unref();
  setInterval(() => void tick(), 60_000).unref();
  // A hold lifted or a stand-in took over: start what waited now (rescues' scouts, planned tasks).
  onHoldLifted(() => setTimeout(() => void tick(), 2000).unref());
}

// ---------------------------------------------------------------- harness repair

/**
 * Whether a failed change was stopped by the harness, not the agent: its detail, or the harness's own lines in its log
 * (stderr, and the agent lines that are its last words). Old rows too (from before harness-hold.ts parked them).
 */
export function harnessFailed(c: { status: string; detail?: string | null; log?: string[] }) {
  if (c.status !== 'failed') return false;
  const log = c.log ?? [];
  const err = log.filter((l) => /^\d\d:\d\d:\d\d stderr:/.test(l)).slice(-20).join('\n');
  const said = [c.detail ?? '', ...log.filter((l) => /^\d\d:\d\d:\d\d agent: /.test(l)).slice(-6)]
    .filter((l) => l.length < 300).join('\n');
  return Boolean(harnessStopOf(err, { kinds: ['usage', 'billing', 'auth'] }) || harnessStopOf(said, { kinds: ['usage', 'billing'] }));
}

/**
 * The self-repair sweep (J, 2026-10-20: "It should just recover itself"): a failed task whose recent attempts were all
 * stopped by the harness (a usage cap, billing, no login), or by Studio itself, is planned again with fresh tries, its
 * open "failed 3 times" question closed and a rescue round given back. Its next start carries on in the last attempt's
 * worktree when that still has work (startTaskChange, agents.ts reviveForTask). Logged as harness-repair (undo).
 */
export async function repairHarnessFailures() {
  const { getChange, studioFailed } = await changes();
  const out: string[] = [];
  for (const r of db.prepare(`SELECT id FROM tasks WHERE status = 'failed'`).all() as any[]) {
    const t = getTask(r.id);
    if (!t) continue;
    const cs = [...t.changes].reverse().map((x) => getChange(x)).filter(Boolean).slice(0, 3) as any[];
    if (!cs.length || !harnessFailed(cs[0])) continue;
    if (cs.some((c) => c.status === 'failed' && !harnessFailed(c) && !studioFailed(c))) continue;
    if (cs.some((c) => ['queued', 'working', 'verifying', 'revising', 'ready', 'needs answer'].includes(c.status))) continue;
    const undo = tasksUndo([t.id]);
    setTask(t.id, { status: 'planned', tries: 0, checks: null, note: 'planned again: its tries were stopped by the AI harness (usage, billing or login), not by the work' });
    for (const q of listQuestions().filter((x) => String(x.subject ?? '').split(/[\s,]+/).includes(t.id))) {
      setQuestion(q.id, { status: 'answered', answer: 'Studio: its tries were stopped by the AI harness (a usage limit or billing), not by the work, so it was planned again with fresh tries. Nothing for you to decide.', answered_by: 'Studio' });
    }
    if (rescues()[t.id]) saveRescue(t.id, null);
    logDecision('harness-repair', t.id, t.product, `"${t.title}": its last attempts (${cs.map((c) => c.id).join(', ')}) were stopped by the AI harness, not the work; planned again with a fresh round of ${pmSettings().maxTries} tries`.slice(0, 1500), undo);
    out.push(t.id);
  }
  return out;
}

