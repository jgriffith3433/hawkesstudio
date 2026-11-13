// Agent workers: a finding becomes a pull request.
//
//   startFix(product, findings)  ->  a "change":
//     1. a git worktree on a new branch fix/<change> from origin's beta branch (beta.ts; made from main when missing;
//        J's checkout is never touched)
//     2. the brief: the findings (with their screenshots from Hawkes Gen), the story doc, the project's checks
//     3. Claude Code, headless, in the worktree: reads AGENTS.md, fixes, runs the checks, commits
//     4. Studio pushes the branch and opens a pull request into beta (GitHub API, the hawkes/github token)
//     5. ready once the agent's checks pass and the pull request is open: no playtest. One runs only when J asks
//        (playtestChange): web products are served from the worktree, Unity ones are built on the build server into a
//        website copy (.work/<change>-site); then the change's scenario is playtested and reviewed. Beta's own run
//        after the merge judges a task's acceptance criteria.
//   autoMergeBeta(change) -> J's rule (2026-10-17): a ready product change merges into beta by itself, no Approve card
//                        or PM gate (settings.agents.autoMergeBeta, on by default). One that can't (a canon conflict,
//                        a merge conflict, a pull request GitHub won't merge) stays ready for a person; Talk says why.
//   approve(change)   -> merges the pull request into beta (nothing goes live): the beta site and its playtest follow,
//                        the findings are marked fixed. Also the Changes tab's button for ones that couldn't auto-merge.
//                        Going live is a separate step (deploy.ts: the deploy plan, then "DEPLOY <product>").
//                        Before merging, the branch is brought up to date with beta (updateFromBase, J 2026-10-18: tasks
//                        hit "merge conflicts" when another task merged first): a clean merge is pushed and merged with no
//                        agent; a conflict resumes the agent's own session to resolve it (resolveConflicts: not a try,
//                        and J hears of it only when the agent fails twice on it).
//   revise(change, note) -> the agent continues on the same branch with J's note; the PR updates.
//
// Hawkes Studio and Hawkes Gen themselves (products.json "infra") take requests too (startTask), but they have no beta
// lane: main is what runs on the control server. Their changes are a worktree of /srv/hawkes/<repo> on task/<id> cut
// from main, npm ci, the agent (typecheck and tests against the running Gen), guard rails (protected files), a pull
// request into main, then verifyInfra: CI on the pull request, the checks again, and a smoke check of the changed
// service on a spare port. Approving merges into main; CI on main tells the server and it deploys itself
// (deploy/hawkes-pull.mjs: waits for runs, agents and Talk answers; rolls back if unhealthy). Main moved since the
// checks: approving brings the branch up to date first (updateFromBase) and J's approval stands (`approved`) until it
// merges once CI is green (mergeApprovedInfra); a real conflict is a conflict pass of its agent first (not a try).
//
// Runs on the server (STUDIO_SERVER=1, repos cloned by repos.ts, GITHUB_TOKEN from /run/hawkes/github.env).
// Caps (settings.agents): how many fixes run at once and per day, and a daily cost limit.

import { cpuWaiting, cpuWaits } from './cpuroom.ts';
import { buildCheckBrief } from './buildfix.ts';
import { compileGate, compileFixPrompt, runCompileCheck, skippedCompile, COMPILE_FIXES, type CompileResult } from './compilecheck.ts';
import { unityBuildVerdict } from './unitybuild-policy.ts';
import { unityCheckAsync, unityFixPrompt, issueLines, looksUnity, changedCsFilesAsync, type UnityCheckResult } from './unitycheck.ts';
import { rubricBrief, isGame, qualityGate, failLine } from './quality.ts';
import { qualityScan, qualityFixPrompt, scanLines, type QualityScan } from './quality-scan.ts';
import { diskWaits } from './diskwait.ts';
import { noteDiskBaseline } from './disksweep.ts';
import { isStudioProject } from './playtest-signin.ts';
import { funReview } from './fun-review.ts';
import { forOwner } from './owner.ts';
import { isVideoTask, videoReady, versionsOf } from './videos.ts';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { db, newId, J, parse } from './db.ts';
import { PLAY_RULE } from './play-policy.ts';
import { getProduct, getInfra, isInfra, PROJECTS, DATA, ROOT, storyOf, localUrl, StudioError, betaPageGlobals, managedElsewhere, managedNote, type Product, type Infra, type Playtest } from './config.ts';
import { withPass } from './sitekeys.ts';
import { getFinding, updateFinding } from './backlog.ts';
import { replayOf } from './feel.ts';
import { reviewParams } from './review.ts';
import { reviewJob } from './review-cc.ts';
import { gen, genEvents, genRun, fileUrl, warmGenMcp, GEN_MCP_TIMEOUT_MS } from './gen.ts';
import { ghostQueued, laneJobs, QUEUED_GHOST_MS, stillQueued } from './gen-recover.ts';
import { SAFETY_MS as GEN_EVENTS_SAFETY_MS, terminal as genTerminal } from './genevents.ts';
import { runGenJob, playtestRunMs, PLAYTEST_IDLE_MS } from './playtests.ts';
import { unityBuild } from './buildpkgs.ts';
import { jobCancelDetail, noteCancel, cancelNote, cancelWords } from './cancel.ts';
import { repoMap, ensureCloned, bigProduct } from './repos.ts';
import { serveDir, stopServed } from './local.ts';
import { claudeEnv } from './claude.ts';
import { buildPreview, removePreview, previewUrl, changeSiteDir, changeBuild, type ChangeBuild } from './previews.ts';
import { BETA, ensureBeta, gitAsync } from './beta.ts';
import { addWorktree, discardIfHalfMade } from './worktree.ts';
import { saveWork, restoreBranch, catchUpWorktree } from './savework.ts';
import { lfsPull, pushPendingLfs } from './lfs.ts';
import { healSource, populateSource, probeSource, repairedError, sourceError, SOURCE_UNREADABLE_SAID } from './source-ready.ts';
import { runCommand, resumeGapMs, RESTART_LOOP, RESTART_WINDOW_MS } from './ops.ts';
import { deployPending, critical, clearStaleDeployFlag, deployFlagSince, watchDeployFlag } from './drain.ts';
import { onQueueWake } from './queuewake.ts';
import { notify, notifyOnce, PUBLIC_URL } from './notify.ts';
import { threadFor, getTask, addItem, addTask } from './roadmap.ts';
import { overlapWith, filesIn, othersSection, sortConflicts, UNITY_RULES, type WorkShape } from './parallel.ts';
import { judgeCriteria, gate } from './acceptance.ts';
import { briefSection, learnFrom, recordRun, LEARNED_ASK } from './memory.ts';
import { canonCheck, CONTENTISH, type CanonCheck } from './canon.ts';
import { roleArgs, loadRole, PLUGIN_DIR, type RoleName } from './roles.ts';
import { passLimitMs, roleTune } from './tuning.ts';
import { routeFor, routeLine, routingSettings, premiumFor, usePremium, modelPin, type Route } from './routing.ts';
import { recordPass, lastPassFor, type PassOutcome } from './ledger.ts';
import { markModelUnavailable, refusedModelOf, contextRefused } from './models.ts';
import { claudeCommand, spawnShell, sandboxShare, assertWorktree, shareWorktree } from './sandbox.ts';
import { launch, DetachedChild, detachedActivity, stopDetached, detachMode, type DetachRec } from './detach.ts';
import { cloudMcp, setWorkspaceRestorer, MERGE_BASE_FILE } from './cloudjob.ts';
import { cloudMode } from './cloudauth.ts';
import { warmDeps, installCold, markInstalled } from './warm.ts';
import { failingTests, compareFailures, describeTests } from './infra-tests.ts';
import { infraFailed, INFRA_FAILED_SQL, isInfraText } from './infra-failure.ts';
import { ensureGpuFor, needsGpu } from './gpustart.ts';
import { walkAwayOn, WALK_AWAY_BY } from './walkaway.ts';
import { brainId, brainLabel, brainSettings, harnessStopOf, isHarness, type Harness, type HarnessStop } from './brains.ts';
import { noProviderFree, notReady, pickHarness, providerSettings, using, whyHarness } from './providers.ts';
import { noteTimeline } from './speed.ts';
import { currentBrain, lastHarness, noteBrain, reportedModel, runAsked, runReported, runStarted } from './runs.ts';
import { harnessHeld, holdDetail, holdHarness, onHoldLifted, reviewHolds, LABEL as HARNESS_LABEL } from './harness-hold.ts';
import { githubReachable } from './ghtoken.ts';
import { kickFollowups } from './followup-kick.ts';
import { POLISH_BY } from './polish.ts';
import { sessionGone, freshSessionPrompt } from './sessiongone.ts';
import { memLow, memRoom, memFreed, memSummary } from './memgate.ts';
import { queueHold, parkedOut, failStreak } from './queue-heal.ts';
import { duplicateHold } from './dup-merged.ts';
import { refreshFromTask } from './queue-follow.ts';
import { inFlightPrompt, recordTouched, touchedFiles, doneByOf } from './inflight.ts';
import { noteRail, betaPart } from './change-rail.ts';
import { noteTiming, timingOf } from './change-timing.ts';
import { beginWait, endWait, endWaitsWhere, within, onDeadline } from './waits.ts';
import { lastGpuVerdict } from './gpuverdict.ts';
import { noCommitOutcome, passState, genUnreachableSaid, GEN_UNREACHABLE } from './outcomes.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, findings TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
    repo TEXT, slug TEXT, branch TEXT, base TEXT, worktree TEXT, pr INTEGER, pr_url TEXT, title TEXT, summary TEXT,
    commits TEXT, diffstat TEXT, verify TEXT, notes TEXT, log TEXT, cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER
  );
`);
// J's own requests (not findings) are changes too.
try { db.exec('ALTER TABLE changes ADD COLUMN request TEXT'); } catch { /* already there */ }
// The Talk conversation that started it (results report there, followup.ts), whether it was told, and who started it.
for (const col of ['origin', 'told', 'started_by']) try { db.exec(`ALTER TABLE changes ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
// A roadmap task's change (roadmap.ts): the task, its acceptance criteria, the agent's session (to resume after a question), what the PM saw.
for (const col of ['task', 'criteria', 'session', 'pm_seen', 'gpu_budget']) try { db.exec(`ALTER TABLE changes ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
// When the PM used up its tries and asked J (pm.ts pmRevise): the loop leaves it alone from then on.
try { db.exec('ALTER TABLE changes ADD COLUMN pm_escalated INTEGER'); } catch { /* already there */ }
// Where a change's work is (Phase), so it carries on from there after a Studio restart.
try { db.exec('ALTER TABLE changes ADD COLUMN phase TEXT'); } catch { /* already there */ }
// The automatic merge into beta (autoMergeBeta): 'trying', 'merged', or 'failed: <why>' (null: not tried).
try { db.exec('ALTER TABLE changes ADD COLUMN auto_merge TEXT'); } catch { /* already there */ }
// When it merged into its base (before beta's run after it starts: pm.ts matches beta's build to it), and how many
// conflict passes its agent made since its branch last merged cleanly with its base (resolveConflicts).
try { db.exec('ALTER TABLE changes ADD COLUMN merged_at INTEGER'); } catch { /* already there */ }
try { db.exec('ALTER TABLE changes ADD COLUMN conflicts INTEGER'); } catch { /* already there */ }
// J's approval of a Studio/Gen merge that main moving held up ({ by, origin, at } JSON): kept until it merges, CI or the
// checks fail, or a person revises it (approveInfra, mergeApprovedInfra).
try { db.exec('ALTER TABLE changes ADD COLUMN approved TEXT'); } catch { /* already there */ }
// Walk-away mode's fix passes of a Studio/Gen change whose CI or checks failed (walkAwayFix).
try { db.exec('ALTER TABLE changes ADD COLUMN auto_fixes INTEGER'); } catch { /* already there */ }
// Model routing (routing.ts): passes sent back by a person or the PM (each is an attempt: the next one climbs a tier),
// and the route of the current attempt (JSON), kept so every pass of one attempt runs on the same model.
try { db.exec('ALTER TABLE changes ADD COLUMN revisions INTEGER'); } catch { /* already there */ }
try { db.exec('ALTER TABLE changes ADD COLUMN route TEXT'); } catch { /* already there */ }
// When each phase was first reached (change-timing.ts, JSON).
try { db.exec('ALTER TABLE changes ADD COLUMN timing TEXT'); } catch { /* already there */ }

/**
 * Worktree paths are stored whole. When Studio's working folder moves (Cloud Run: from the in-memory /tmp/projects onto
 * the mounted disk, src/cellrun.ts CELL_DISK), a change's old path would be made again in memory and its cleanup would
 * refuse a folder outside .work. At start, every stored path under another root's .work is moved under this one.
 * Exported for the tests.
 */
export function rebaseWorktrees(work = path.join(PROJECTS, '.work')): number {
  const rows = db.prepare("SELECT id, worktree FROM changes WHERE worktree LIKE '%/.work/%' OR worktree LIKE '%\\.work\\%'").all() as { id: string; worktree: string }[];
  const set = db.prepare('UPDATE changes SET worktree = ? WHERE id = ?');
  let moved = 0;
  for (const r of rows) {
    const rel = path.relative(work, path.resolve(r.worktree));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) continue;
    const m = /[\\/]\.work[\\/](.+)$/.exec(r.worktree);
    if (!m) continue;
    set.run(path.join(work, ...m[1].split(/[\\/]/)), r.id);
    moved++;
  }
  return moved;
}
try { const n = rebaseWorktrees(); if (n) console.log(`[studio] ${n} change(s)' worktree paths moved under ${path.join(PROJECTS, '.work')} (the working folder moved)`); } catch (e: any) { console.warn(`[studio] worktree paths: ${e?.message ?? e}`); }
// The PM asks about changes by task and by status and date many times a pass. `created` and `task` sit after the agent's
// log in each row, so without these every question reads past every log, on the one thread that also answers J's
// browser (2026-11-06: a busy day froze a customer's Studio for up to 61 s at a time, and it stopped loading).
db.exec(`
  CREATE INDEX IF NOT EXISTS changes_task ON changes(task, created);
  CREATE INDEX IF NOT EXISTS changes_status_created ON changes(status, created);
`);

export type Change = {
  id: string; product: string; findings: string[]; status: string; detail: string | null; repo: string; slug: string; branch: string; base: string;
  worktree: string; request: string | null; pr: number | null; pr_url: string | null; title: string | null; summary: string | null; commits: string[]; diffstat: string | null;
  verify: any; notes: { at: number; by: string; text: string }[]; log: string[]; cost: number; created: number; updated: number | null;
  /** The roadmap task it works on (roadmap.ts), its acceptance criteria, and the agent's Claude Code session (to resume after a question). */
  task: string | null; criteria: string[]; session: string | null;
  /** Dollars J approved for GPU generation in this change (content work); null: no GPU approved. */
  gpu_budget: string | null;
  /** When the PM used up its tries and asked J (pm.ts): the loop leaves it alone. */
  pm_escalated?: number | null;
  /** The automatic merge into beta: 'trying', 'merged', or 'failed: <why>'; null: not tried. */
  auto_merge?: string | null;
  /** When it merged into its base; conflict passes since its branch last merged cleanly with its base. */
  merged_at?: number | null; conflicts?: number | null;
  /** Studio/Gen: J's approval still waiting to merge it (main moved: CI on the updated branch, or a conflict pass). JSON. */
  approved?: string | null;
  /** Studio/Gen in walk-away mode: fix passes its agent made because CI or the checks failed (walkAwayFix). */
  auto_fixes?: number | null;
  /** Passes a person or the PM sent back (revise); the route of the current attempt (routing.ts, JSON). */
  revisions?: number | null; route?: string | null;
  /** When each phase was reached and the seconds between them (change-timing.ts). */
  timing?: import('./change-timing.ts').Timing;
  /** The Talk conversation that started it (followup.ts). */
  origin?: string | null;
  /** A change to Hawkes Studio or Hawkes Gen (a pull request into main, which deploys itself), not a product. */
  infra: boolean;
  /** The role, harness and model that ran (or will run) this change. */
  role?: string | null;
  harness?: Harness | null;
  harness_label?: string | null;
  model?: string | null;
  model_reported?: boolean;
  /** Absolute links for Talk and J: the change in Studio (its playtest and review if one was asked for, its log), the playtest video, preview, pull request. */
  links: ChangeLinks;
};
export type ChangeLinks = { change: string; pr: string | null; preview: string | null; video: string | null };

function changeLinks(r: any, verify: any): ChangeLinks {
  return {
    change: `${PUBLIC_URL}/#changes/${r.id}`,
    pr: r.pr_url ?? null,
    preview: verify?.preview ?? null,
    video: verify?.video ? fileUrl(verify.video) : null,
  };
}

const SETTINGS_FILE = path.join(DATA, 'agents.json');
/**
 * autoMergeBeta: ready product changes merge into beta by themselves (J, 2026-10-17); off: a person merges them.
 * autoWorkVerdicts: a review or playtest that ends "fix-first" or "broken" starts a fixer on the findings behind it, or files one
 * Inbox card saying why it can't (verdictwork.ts; J, 2026-11-05: "studio should be working on it if it's failed or fix first");
 * autoReverify: a merge into beta that fixes a bad verdict is followed by ONE beta playtest and review per burst of merges.
 * idleMinutes: an agent with no new output that long, its processes only sleeping, is ended (runAgent's watchdog; 0: off).
 * perProduct: changes of one product that may run at once (a second only when it won't collide: parallel.ts);
 * productLimits: per-product overrides of it (J, 2026-10-18: Sick Of It 2). Studio and Gen always run one at a time.
 */
export type AgentSettings = { enabled: boolean; autoFix: boolean; autoWorkVerdicts: boolean; autoReverify: boolean; autoMergeBeta: boolean; betaPlaytests: boolean; betaPlayWhen: 'go-live' | 'merge'; maxConcurrent: number; perProduct: number; productLimits: Record<string, number>; maxPerDay: number; maxCostPerDay: number; severities: string[]; model: string; maxTurns: number; idleMinutes: number; genWaitHours: number; access?: { gen?: boolean; repos?: boolean }; showcase: 'web' | 'all' | 'off' };
/** showcase: which ready game changes that a player would see are playtested by themselves, so their pull request ships
 * with shots and a walk-through clip from the built game (the owner's gaps list, 2026-11-08): all, the default (Unity
 * too, for changes a player sees or feels: the change's build on the build server, within maxCostPerDay), web (web
 * games and site pages only: served from the worktree, no build), off.
 * access: what agents reach beyond their own project (access.ts; both on unless turned off here or on the project).
 * genWaitHours: a change parked on Gen jobs longer than this is told in Talk once (it isn't failed). */
const DEFAULTS: AgentSettings = { enabled: true, autoFix: true, autoWorkVerdicts: true, autoReverify: true, autoMergeBeta: true, betaPlaytests: false, betaPlayWhen: 'go-live', maxConcurrent: 2, perProduct: 1, productLimits: { sickofit: 2 }, maxPerDay: 1000, maxCostPerDay: 150, severities: ['blocker', 'bug'], model: 'claude-sonnet-5-5', maxTurns: 80, idleMinutes: 20, genWaitHours: 6, showcase: 'all' };
export function agentSettings(): AgentSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return DEFAULTS;
  }
}
/** How many changes of this product may run at once (at least 1; Studio and Gen: 1). */
export function perProductLimit(product: string, s: AgentSettings = agentSettings()) {
  if (isInfra(product)) return 1;
  const n = Number(s.productLimits?.[product] ?? s.perProduct);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
export function saveAgentSettings(patch: Partial<AgentSettings>) {
  const next = { ...agentSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** The role, harness and model for a change: from its running phase, its latest pass_ledger entry, or the active brain when queued/working. */
export function brainOfChange(r: any) {
  const ph = (typeof r.phase === 'string' ? parse(r.phase) : r.phase) as Phase | null;
  const findings: string[] = Array.isArray(r.findings) ? r.findings : parse(r.findings) ?? [];
  const infra = typeof r.infra === 'boolean' ? r.infra : isInfra(r.product);
  const pass = r.id ? lastPassFor(r.id) : null;
  const role = pass?.role ?? roleOf({ infra, request: r.request, findings, title: r.title });
  const roleArg = (role === 'infra' ? 'builder' : role) as RoleName;
  const phaseHarness = isHarness(ph?.brain) ? ph.brain : null;
  const active = ['queued', 'working', 'revising'].includes(r.status);
  const harness: Harness | null = phaseHarness ?? (pass?.harness as Harness | undefined) ?? (active ? brainId() : null);
  // The current attempt's route (routing.ts) names the model before its first pass is in the ledger.
  const routed = (() => { const x = parse(r.route ?? null) as Route | null; return x?.tier ? roleTune(roleArg, { tier: x.tier }).model : ''; })();
  const planned: string | null = phaseHarness
    ? (modelPin() || routed || roleArgs(roleArg).role.model)
    : pass?.reported ?? pass?.model ?? (active ? (modelPin() || routed || roleArgs(roleArg).role.model) : null);
  // What the harness itself said it runs, for the provider the change is on (runs.ts): that's what's shown when there is one.
  const ran = r.id ? currentBrain(r.id) : null;
  const reported = Boolean(ran?.reported && ran.harness === harness) || Boolean(!ran && !phaseHarness && pass?.reported);
  const model = ran?.reported && ran.harness === harness ? ran.model : planned;
  return {
    role,
    harness,
    harness_label: harness ? brainLabel(harness) : null,
    model,
    /** true: the model is what the harness reported running; false: what the pass asked for (not confirmed yet). */
    model_reported: reported,
  };
}

function prGeneratedBy(id: string) {
  const b = brainOfChange(db.prepare('SELECT id, product, status, phase, request, findings, title FROM changes WHERE id = ?').get(id) ?? { id, status: 'working' });
  if (b.harness && b.harness !== 'claude') return `🤖 Generated with ${b.harness_label}${b.model ? ` (${b.model})` : ''}`;
  return `🤖 Generated with [Claude Code](https://claude.com/claude-code)${b.model ? ` (${b.model})` : ''}`;
}

const toChange = (r: any): Change => {
  const verify = parse(r.verify);
  const b = brainOfChange(r);
  const timing = timingOf(r, { beta: (p, at) => (isInfra(p) ? null : betaPart(p, at)), verified: (task) => (db.prepare('SELECT verified_at FROM tasks WHERE id = ?').get(task) as any)?.verified_at ?? null });
  return { ...r, timing, infra: isInfra(r.product), criteria: parse(r.criteria) ?? [], findings: parse(r.findings) ?? [], commits: parse(r.commits) ?? [], verify, notes: parse(r.notes) ?? [], log: parse(r.log) ?? [], ...b, links: changeLinks(r, verify) };
};
export const getChange = (id: string) => {
  const r = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  return r ? toChange(r) : null;
};
export function listChanges(q: { status?: string; product?: string; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const args: any[] = [];
  if (q.status) { where.push(`status IN (${q.status.split(',').map(() => '?').join(',')})`); args.push(...q.status.split(',')); }
  if (q.product) { where.push('product = ?'); args.push(q.product); }
  return (db.prepare(`SELECT * FROM changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC LIMIT ? OFFSET ?`).all(...args, q.limit ?? 100, Math.max(0, q.offset ?? 0)) as any[]).map(toChange);
}
/** The columns update() writes (besides updated). */
const CHANGE_COLS = ['status', 'detail', 'pr', 'pr_url', 'title', 'summary', 'commits', 'diffstat', 'verify', 'notes', 'log', 'cost', 'session', 'phase', 'auto_merge'];
function update(id: string, patch: Partial<Record<string, any>>) {
  // A pass the stuck-work watchdog gave up on (checkStuck) writes nothing more: it ends here, and the pass that took over owns the change.
  const ctx = passCtx.getStore();
  if (ctx && ctx.id === id && ctx.gen !== passGen(id)) throw new PassAbandoned(id);
  const cur = db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as any;
  // A cancelled change stays cancelled until someone resumes (queued) or closes it: a pass still winding down can only log (cancelChange).
  if (cur?.status === 'cancelled' && !['queued', 'closed'].includes(patch.status) && Object.keys(patch).some((k) => !['log', 'notes', 'cost'].includes(k))) return;
  const next: any = { ...cur, ...patch, updated: Date.now() };
  // The speed metric (speed.ts): every status or step change, so each phase's time is measured.
  if (cur) {
    const stepOf = (ph: any) => { const x = typeof ph === 'string' ? parse(ph) : ph; return (x?.step as string | undefined) ?? null; };
    const step = patch.phase !== undefined ? stepOf(patch.phase) : stepOf(cur.phase);
    if (next.status !== cur.status || step !== stepOf(cur.phase)) noteTimeline(id, next.status ?? null, step);
  }
  for (const k of ['findings', 'commits', 'verify', 'notes', 'log', 'phase']) if (patch[k] !== undefined) next[k] = patch[k] === null ? null : J(patch[k]);
  // Nothing changed: no write. Every write rewrites the whole row (its log of up to 400 lines) and goes to the replica's
  // WAL; a loop setting the same status and detail over and over wrote ~13 MB/s on 2026-11-11 (the disk-wait loop).
  if (cur && CHANGE_COLS.every((k) => (next[k] ?? null) === (cur[k] ?? null))) return;
  db.prepare(`UPDATE changes SET status=?, detail=?, pr=?, pr_url=?, title=?, summary=?, commits=?, diffstat=?, verify=?, notes=?, log=?, cost=?, session=?, phase=?, auto_merge=?, updated=? WHERE id=?`)
    .run(next.status, next.detail, next.pr, next.pr_url, next.title, next.summary, next.commits, next.diffstat, next.verify, next.notes, next.log, next.cost, next.session ?? null, next.phase ?? null, next.auto_merge ?? null, next.updated, id);
  // The change's progress rail (change-rail.ts): when each step was reached, and a `change-step` event on the dashboard's stream.
  if (cur) noteRail(next);
  // Phase times (change-timing.ts): the first time each is reached.
  if (cur) {
    if (patch.status !== undefined && patch.status !== cur.status) {
      if (cur.status === 'queued' && ['working', 'revising'].includes(String(patch.status))) noteTiming(id, 'dispatched');
      if (patch.status === 'ready') noteTiming(id, 'checks_done');
      if (patch.status === 'merged') noteTiming(id, 'merged', Number(next.merged_at) || Date.now());
    }
    if (patch.pr && !cur.pr) noteTiming(id, 'pr_opened');
  }
  // A bug is consumed when an agent takes it (startFix marks it fixed). If that attempt fails, for whatever reason, the
  // bug goes back to open so the PM picks it up again (at most maxTries attempts, then J is asked): consumed means it
  // will get done, not that it's dropped when an attempt crashes.
  if (patch.status !== undefined && patch.status !== cur?.status) kickFollowups();
  // A change that ends may leave its project with nothing queued: the PM's pass looks now (a milestone's one Unity build
  // waits for exactly that, unitybuild-policy.ts), not on its next minute.
  if (patch.status !== undefined && patch.status !== cur?.status && ['merged', 'failed', 'closed', 'cancelled'].includes(String(patch.status))) void import('./pm.ts').then((m) => m.kick()).catch(() => {});
  if (patch.status === 'failed' && cur?.status !== 'failed') reopenTaken(id, (parse(next.findings) ?? []) as string[], String(next.detail ?? ''));
  // A status that changes what the queue may start wakes it, from wherever it was set (a pass, a cancel, a close, a
  // merge on GitHub): a change leaving a running status frees its slot and its product's place; one moving to verifying
  // frees its agent slot (AGENT_SLOT); one leaving the queue (failed, cancelled, closed) is no longer ahead of anything
  // "behind" it. Only the pump's own starts (queued -> working/revising) don't: that pass already looks again.
  if (cur && patch.status !== undefined && patch.status !== cur.status && wakesQueue(cur.status, String(patch.status))) void pump();
}

/** Whether a change moving from one status to another may let a queued change start (update wakes the queue then). */
export function wakesQueue(from: string, to: string) {
  if (from === 'queued' && (to === 'working' || to === 'revising')) return false;
  return ACTIVE.split(',').includes(from) || from === 'queued' || to === 'verifying' || to === 'queued';
}

/**
 * Whether change `id` still holds a finding: in the status it set itself (fixed with its note, the "consumed" rule, or
 * "fixing" from before 2026-10-17). One changed since by a person or the PM (wontfix, idea, fixed with another note) isn't.
 */
export function heldBy(fd: { status?: string; note?: string | null } | null | undefined, id: string) {
  return fd?.status === 'fixing' || (fd?.status === 'fixed' && fd.note === `agent change ${id}`);
}

/** The bugs a failed change still holds go back to open, for another attempt; ones triaged since stay as they are. */
export function reopenTaken(id: string, findings: string[], why: string) {
  for (const f of findings) {
    if (heldBy(getFinding(f), id)) updateFinding(f, { status: 'open', note: `agent change ${id} failed (${why.slice(0, 160)}); open again for another attempt` });
  }
}

/** The detail of a change whose agent changed nothing because J already decided it: not a failed try (pm.ts). */
export const DECIDED = 'nothing to change: J already decided';
/** An agent's summary saying it changed nothing because of a decision J already made. */
export function decidedNoChange(summary: string) {
  const s = String(summary ?? '');
  return /\bJ\b/.test(s)
    && /\b(already decided|decided|decision|chose|ruled|won'?t[- ]?fix|wontfix|by design|as designed|intentional)\b/i.test(s)
    && /\b(no change|no changes|nothing to (change|fix|do)|changed nothing|made no (change|commit)s?|no commit|committ?ed nothing|commit nothing|didn'?t change|did not change|not changing|unchanged|left (it )?as (it is|is))\b/i.test(s);
}
/** An agent's summary saying it changed nothing (whatever the reason). */
export function saysNoChange(summary: string) {
  return /\b(made no (change|commit)s?|no changes? (were |was )?(made|needed)|nothing to (change|fix|do)|changed nothing|committ?ed nothing|commit nothing|didn'?t change|did not change|not changing|left (it )?as (it is|is))\b/i.test(String(summary ?? ''));
}
/** The mark of a commit Studio made for the agent (the job's leftover step, cloudjob-run.ts; commitForAgent). */
/** Studio's trailers, each as the whole last line of the message (cloudjob-run.ts commitLeftovers, cloudjob.ts, commitForAgent). A phrase anywhere else in a message (an agent quoting it) is not the mark. */
const STUDIO_TRAILER = /^Committed by Hawkes Studio(?:'s job)?: (?:the agent left these changes uncommitted\.|the agent's own git commit was refused\b.*|the agent's commit\b.*)$/;
const STUDIO_EMAIL = 'studio@hawkesgen.ai';
/** One commit's message and committer/author emails: Studio's only when its last line is Studio's trailer and nobody else committed it (an agent's amend, even --no-edit, changes the committer). */
const isStudioCommit = (rec: string) => {
  const [authorEmail, committerEmail, ...body] = rec.split('\x01');
  const lines = body.join('\x01').trim().split('\n').map((l) => l.trimEnd());
  const last = lines[lines.length - 1] ?? '';
  if (!STUDIO_TRAILER.test(last)) return false;
  // Commits Studio made carry its own identity when the job made them; commitForAgent uses the worktree's (the agent's) identity, so only a *different, non-Studio* committer or author is refused when the trailer is the job's.
  if (/^Committed by Hawkes Studio's job/.test(last)) return authorEmail.trim() === STUDIO_EMAIL && committerEmail.trim() === STUDIO_EMAIL;
  return true;
};
/**
 * Whether every commit of the branch (beyond its base) was made by Studio for the agent, none by the agent itself: the job's
 * "leftover changes" commit after a pass that changed nothing (c_2d931adecba5 on 2026-11-03 merged two shader files the
 * agent never touched into Sick of It's beta). False with no commits.
 */
export function onlyStudioCommits(worktree: string, base: string) {
  const log = git(worktree, ['log', '--format=%ae%x01%ce%x01%B%x00', `origin/${base}..HEAD`]).out;
  const recs = log.split('\0').map((m) => m.trim()).filter(Boolean);
  return recs.length > 0 && recs.every(isStudioCommit);
}
/** The detail of a change whose agent was cut off and left only Studio's own leftover commit (c_cf47dbcaca13, 2026-11-09). */
export const CUT_OFF_LEFTOVERS = "the agent was cut off before finishing; its leftovers weren't merged";
/**
 * Whether a change is only Studio's leftover commit from an agent that never finished: every commit is Studio's
 * (`onlyStudio`) and the pass was cut off (`stopped`: time, turns, no result) or ended without the agent's own
 * .hawkes/summary.md (`hasSummaryFile` false: Studio ended its session while a background check ran, so the summary was just
 * its last words). Such a commit is a scratch file at best (scripts/_tmp-render.mjs) and must not reach beta as "ready".
 */
export function cutOffLeftovers({ onlyStudio, stopped, hasSummaryFile }: { onlyStudio: boolean; stopped?: string; hasSummaryFile: boolean }) {
  return onlyStudio && (Boolean(stopped) || !hasSummaryFile);
}
/** The detail of a change whose agent made no commit because the work is already done: the PM checks it (pm.ts), not a try. */
export const ALREADY = 'nothing to do: already done';
/** An agent's summary (of a change with no commit) saying the work is already there. */
export function alreadyDone(summary: string) {
  // Gen's MCP never connected: never close as "already done" (outcome reads Gen unreachable instead).
  if (genUnreachableSaid(summary)) return false;
  if (doneByOf(summary)) return true;
  return /\b(already (been )?(done|merged|landed|shipped|implemented|in place|on (beta|main)|there|present|fixed|exists?|works?)|nothing (left|more|else) to (do|change|implement)|(work|task|change) (is|was) (already )?(done|merged|complete))\b/i.test(String(summary ?? ''));
}
/** How many times one change requeues for Gen MCP CONNECT_TIMEOUT before it fails as Gen unreachable (still not a try). */
export const GEN_MISS_CAP = 3;
/** What the agent said about Gen (summary, stuck.md, the pass result) for CONNECT_TIMEOUT / unreachable. */
export function genUnreachableText(worktree: string, summary: string, result?: string | null): string {
  let stuck = '';
  try { stuck = fs.readFileSync(path.join(worktree, '.hawkes', 'stuck.md'), 'utf8'); } catch { /* none */ }
  return `${summary}\n${result ?? ''}\n${stuck}`;
}
/**
 * A pass that made no commit because Gen's MCP never connected (CONNECT_TIMEOUT while Gen was up): requeue like a
 * merge-conflict pass, not failed and not "already done"; tries unchanged. After GEN_MISS_CAP times, fail as
 * Gen unreachable with phase.failed so the PM does not count a try (infra-failure.ts).
 */
export function parkForGenUnreachable(
  id: string,
  ph: Phase,
  save: (patch: Partial<Phase>, extra?: Record<string, any>) => void,
  summary: string,
  commits: unknown[],
): boolean {
  const c = getChange(id);
  if (!c || commits.length) return false;
  const said = genUnreachableText(c.worktree, summary, ph.result);
  if (!genUnreachableSaid(said)) return false;
  const misses = (ph.genMisses ?? 0) + 1;
  if (misses >= GEN_MISS_CAP) {
    const detail = `${GEN_UNREACHABLE} (${misses}×; not counted as a try)`.slice(0, 300);
    addLog(id, `Gen's MCP still unreachable after ${misses} tries: ${detail}`);
    reopenTaken(id, c.findings ?? [], detail);
    update(id, { status: 'failed', detail, summary, commits, phase: { step: ph.step, failed: true, genMisses: misses } });
    return true;
  }
  // Warm Gen again on the next pass; a short gap lets a cold start finish without a watchdog.
  const retryAt = Date.now() + 30_000;
  addLog(id, `Gen unreachable (MCP connect timed out); queued to try again (${misses} of ${GEN_MISS_CAP}), not a try`);
  save(
    { step: 'agent', genMisses: misses, notBefore: retryAt, proc: undefined, result: undefined, stopped: undefined, nudge: false, genDone: undefined, harness: undefined },
    { status: 'queued', detail: GEN_UNREACHABLE, summary },
  );
  pumpAt(retryAt);
  return true;
}
/**
 * A fix (no task) whose agent made no commit because it found the bug already fixed (e.g. the error came from a beta
 * build older than the fix): its bugs are fixed with the agent's word, not opened again for the next agent to reach
 * the same answer, and pm.ts doesn't count it as a try. A task's claim is checked by the PM instead. True when it was.
 */
export function fixAlreadyDone(id: string, c: Pick<Change, 'task'>, findings: string[], summary: string, commits: unknown[]) {
  if (c.task || commits.length || !alreadyDone(summary)) return false;
  for (const f of findings) if (heldBy(getFinding(f), id)) updateFinding(f, { status: 'fixed', note: `agent ${id}: ${ALREADY}: ${summary.slice(0, 200)}` });
  update(id, { status: 'failed', detail: `${ALREADY} (the agent made no commit)`, summary, commits, phase: null });
  return true;
}
/**
 * A failed change whose agent never finished: Studio's own error around it (the worktree, an install, a push, a crash;
 * work()'s catch keeps the step it failed at, with `failed`). Not the agent's try (pm.ts; f_7f4ff7149602 burned its 3
 * tries in 2 minutes on such failures). STUDIO_FAILED_SQL is the same test on the changes table.
 */
export const studioFailed = (c: { status: string; phase?: unknown; detail?: unknown }) => infraFailed(c, parse);
export const STUDIO_FAILED_SQL = INFRA_FAILED_SQL;
/** Why a change with no commit failed: already done (ALREADY), else `why`. */
const noCommitDetail = (summary: string, why: string) => (alreadyDone(summary) ? `${ALREADY} (the agent made no commit)` : why);
/**
 * Whether the harness (not the agent) ended a pass (brains.ts harnessStopOf): its result when the pass failed or never
 * finished, and its stderr (Cursor prints "ActionRequiredError: You have an unpaid invoice" only there); a clean result
 * counts only when it is just the harness's own short message. The agent's summary only for usage and billing, and
 * never when it found the work already done or decided. Such a pass parks (parkForHarness): not a try, not a diagnosis.
 */
export function passStop(r: { ok: boolean; sawResult: boolean; result: string; stderr?: string; stopped?: AgentResult['stopped'] }, summary = ''): HarnessStop | null {
  if (alreadyDone(summary) || decidedNoChange(summary)) return null;
  // Studio's own time limit ended it: that's a nudge, whatever stderr says.
  if (r.stopped === 'time') return null;
  const clean = r.ok && r.sawResult;
  const result = String(r.result ?? '');
  // An outage (transient) only when the pass produced no result at all: a stray warning beside a result isn't one.
  const own = clean ? (result.length < 400 ? harnessStopOf(result, { kinds: ['usage', 'billing', 'auth'] }) : null)
    : harnessStopOf(`${result}\n${r.stderr ?? ''}`, r.sawResult ? { kinds: ['usage', 'billing', 'auth'] } : {});
  if (own) return own;
  if (clean) return null;
  // Only a short summary can be the harness's own message; a long one that mentions a limit is the agent's analysis.
  return summary.trim().length < SUMMARY_STOP_MAX ? harnessStopOf(summary, { kinds: ['usage', 'billing'] }) : null;
}
export const SUMMARY_STOP_MAX = 400;

/**
 * The harness stopped this pass: the change parks (queued, its worktree, branch, session and step kept) and the harness
 * is held studio-wide (harness-hold.ts). Never failed, never a try, no nudge spent: when the hold lifts (or the other
 * harness stands in) pump resumes it where it was (harnessResume). J, 2026-10-20: "It should just recover itself."
 */
/** The provider a stopped pass ran on: its result's, else the change's last pass (runs.ts), else its phase, else the one in use. */
export function parkHarness(id: string, ph: Pick<Phase, 'brain'>, ran?: Harness | null): Harness {
  return (ran ?? lastHarness(id) ?? (isHarness(ph.brain) ? ph.brain : brainId())) as Harness;
}
function parkForHarness(id: string, ph: Phase, save: (patch: Partial<Phase>, extra?: Record<string, any>) => void, stop: HarnessStop, ran?: Harness | null) {
  // The provider that really ran the pass (its result says, else the change's provider history), so a limit on one
  // provider never holds another: the phase's brain only when neither knows, and the harness in use last of all.
  const harness = parkHarness(id, ph, ran);
  if (isHarness(ph.brain) && ph.brain !== harness) addLog(id, `the stop came from ${HARNESS_LABEL[harness]}, the provider that ran the pass (its phase still said ${HARNESS_LABEL[ph.brain]})`);
  const { hold } = holdHarness(stop, { source: `agent change ${id}`, harness });
  noteBrain(id, { kind: 'park', harness, model: currentBrain(id)?.model ?? null, why: `${stop.kind}: ${stop.line}` });
  writeHandoff(id, harness, `${HARNESS_LABEL[harness]} stopped it (${stop.kind}: ${stop.line.slice(0, 160)})`);
  addLog(id, `${HARNESS_LABEL[harness]} stopped the agent (${stop.kind}): ${stop.line.slice(0, 200)}. Parked with its worktree and session: not a try; it resumes by itself (${holdDetail(hold)})`);
  const now = Date.now();
  const parks = [...(ph.harness?.parks ?? []), now].filter((t) => now - t < RESUME_WINDOW);
  save({ step: 'agent', proc: undefined, result: undefined, stopped: undefined, nudge: false, harness: { kind: stop.kind, line: stop.line.slice(0, 300), at: now, on: harness, parks } }, { status: 'queued', detail: holdDetail(hold) });
}
/**
 * A provider stopped a pass mid-way: what it was doing goes into .hawkes/handoff.md (in the worktree, so it reaches the
 * job), so the next session, on whichever provider, carries on from there (runAgentInner points it at the file). Its
 * commits are already on GitHub (saveWork after every pass) and its uncommitted files stay in the worktree.
 */
export function writeHandoff(id: string, harness: Harness, why: string) {
  try {
    const c = getChange(id);
    if (!c?.worktree || !fs.existsSync(c.worktree)) return;
    const now = currentBrain(id);
    const steps = c.log.filter((l) => /^\d\d:\d\d:\d\d (agent|tool): /.test(l)).slice(-30).map((l) => `- ${l.slice(9)}`);
    const dirty = (() => { try { return uncommitted(c.worktree).split('\n').filter(Boolean).length; } catch { return 0; } })();
    const text = [
      '# Where the last pass got to',
      '',
      `It ran on ${HARNESS_LABEL[harness]}${now?.model ? ` (${now.model})` : ''} and was cut off at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: ${why}.`,
      `Its commits are on this branch (\`git log\`)${dirty ? `; ${dirty} file(s) it changed aren't committed yet (\`git status\`)` : ''}.`,
      '',
      'What it was doing, newest last:',
      ...(steps.length ? steps : ['- (nothing logged)']),
      '',
    ].join('\n');
    fs.mkdirSync(path.join(c.worktree, '.hawkes'), { recursive: true });
    fs.writeFileSync(path.join(c.worktree, HANDOFF), text);
  } catch { /* a handoff never stops a park */ }
}
/**
 * How soon a change parked by a harness hold may start again, whatever the hold says (a probe that answers lifts the
 * hold at once, and c_f7171301e745 resumed every 15 s, $8.40): at least RESUME_GAP after its last park, and at most
 * RESUME_CAP parks an hour. Past the cap it waits until the hour lets one more in: a wait with an end. Before
 * 2026-11-11 the cap put the change in "needs answer" and asked J, and neither his "resume it" nor walk-away's "leave
 * it" ever started it again: a provider limit that lifts by itself left the change stopped for good.
 */
export const RESUME_GAP = Number(process.env.STUDIO_HARNESS_RESUME_GAP_MS) || 10 * 60_000;
export const RESUME_CAP = 3;
const RESUME_WINDOW = 3600_000;
export function resumeGate(h: { at: number; parks?: number[]; capped?: boolean } | undefined, now = Date.now()): { go: true } | { go: false; waitMs: number; capped: boolean } {
  if (!h) return { go: true };
  const parks = (h.parks ?? [h.at]).filter((t) => now - t < RESUME_WINDOW).sort((a, b) => a - b);
  if (parks.length >= RESUME_CAP) return { go: false, waitMs: Math.max(1000, parks[parks.length - RESUME_CAP] + RESUME_WINDOW - now), capped: true };
  const waitMs = h.at + RESUME_GAP - now;
  return waitMs > 0 ? { go: false, waitMs, capped: false } : { go: true };
}
/**
 * The harness refused the model this pass asked for (the account's plan doesn't have it): remember it (models.ts) and
 * run the pass again on the next tier down. Not a try, not a hold. Null when it wasn't that, or the model was already
 * known as refused (so a requeue never loops).
 */
export function modelRefused(r: { ok: boolean; sawResult: boolean; result: string; stderr?: string; harness?: Harness; model?: string }, ph: Phase, ranModel?: string | null) {
  const harness = (r.harness ?? (isHarness(ph.brain) ? ph.brain : brainId())) as Harness;
  // The model's context can't hold Studio's instructions there: the provider answers with that one line (a "result"),
  // so it is read whether or not the pass looked clean (2026-11-10: c_cad9c740157e failed as "made no commit").
  const tooBig = contextRefused(String(r.result ?? '')) || (!r.sawResult && contextRefused(String(r.stderr ?? '').slice(-600)));
  const known = r.model || ranModel;
  if (tooBig && known && known !== 'auto') return markModelUnavailable(harness, known) ? { model: known, harness, why: 'context' as const } : null;
  if (r.ok && r.sawResult) return null;
  const model = refusedModelOf(`${r.result ?? ''}\n${r.stderr ?? ''}`);
  return model && markModelUnavailable(harness, model) ? { model, harness } : null;
}
function requeueForModel(id: string, save: (patch: Partial<Phase>, extra?: Record<string, any>) => void, gone: { model: string; harness: Harness; why?: 'context' }) {
  addLog(id, gone.why === 'context'
    ? `${HARNESS_LABEL[gone.harness]} wouldn't run ${gone.model}: Studio's instructions and tools don't fit that model's context there. It is skipped there from now on and the pass runs again on another model (not a try)`
    : `${HARNESS_LABEL[gone.harness]} doesn't have the model ${gone.model} on this account: it is skipped from now on and the pass runs again on the next one down (not a try)`);
  save({ step: 'agent', proc: undefined, result: undefined, stopped: undefined }, { status: 'queued', detail: `${gone.model} isn't available: trying the next model` });
  setTimeout(() => void pump(), 0).unref();
}
const HARNESS_RESUME = `Your last pass was cut off because the AI harness stopped answering (a usage limit, billing or an outage), not because of anything you did. Your work so far is in the worktree (\`git status\`, \`git log\`): don't start over. Carry on with the task in .hawkes/brief.md from where you were, commit as you go, and finish it the way it says (.hawkes/summary.md and the rest).`;
const REVIVE_RESUME = (why: string) => `Your earlier pass ended before it finished (${why.slice(0, 600)}). Your work so far is still in the worktree (\`git status\`, \`git log\`): don't start over. Carry on with the task in .hawkes/brief.md from where it is, commit as you go, and finish it the way it says (.hawkes/summary.md and the rest).`;
/** The pass after a hold (or a revived attempt): the same session when the same harness runs it, else a new one told the same. */
function harnessResume(c: Change, ph: Phase) {
  const prompt = ph.harness?.kind === 'revive' ? REVIVE_RESUME(ph.harness.line) : HARNESS_RESUME;
  return c.session && sameHarness(ph) ? { session: c.session, prompt } : { prompt: `Read .hawkes/brief.md: it's your whole task. ${prompt}` };
}

/**
 * A task's latest attempt that failed with its work still in its worktree (uncommitted, or commits not on its pushed
 * branch): it carries on there, queued to resume (harnessResume), instead of a fresh branch cut from beta (pm.ts
 * startTaskChange; J, 2026-10-20: c_7f17015eddab's ~340 lines were left behind). Returns its id, or null.
 */
export function reviveForTask(task: string, note?: string) {
  const row = db.prepare('SELECT id FROM changes WHERE task = ? ORDER BY created DESC, rowid DESC LIMIT 1').get(task) as { id: string } | undefined;
  const c = row ? getChange(row.id) : null;
  if (!c || c.status !== 'failed' || !c.worktree || !fs.existsSync(c.worktree) || running.has(c.id)) return null;
  let dirty = '';
  let unpushed: string[] = [];
  try {
    assertWorktree(c.worktree, path.join(PROJECTS, c.repo));
    dirty = uncommitted(c.worktree);
    const pushed = git(c.worktree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${c.branch}`]).ok ? `origin/${c.branch}` : `origin/${c.base}`;
    unpushed = git(c.worktree, ['log', '--format=%h', `${pushed}..HEAD`]).out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (!dirty && !unpushed.length) return null;
  const old = phaseOf(c.id);
  const why = `${note ? `From the PM: ${note.slice(0, 400)}. ` : ''}It had ${dirty ? `${dirty.split('\n').length} uncommitted file(s)` : ''}${dirty && unpushed.length ? ' and ' : ''}${unpushed.length ? `${unpushed.length} commit(s) not pushed` : ''}`;
  update(c.id, {
    status: 'queued', detail: 'carries on in its own worktree (its work was still there)',
    phase: { step: 'agent', since: Date.now(), before: git(c.worktree, ['rev-parse', 'HEAD']).out, brain: old?.brain, harness: { kind: 'revive', line: why, at: Date.now(), on: old?.brain ?? brainId() } },
  });
  addLog(c.id, `revived for task ${task}: ${why}; the agent carries on here instead of a fresh branch`);
  setTimeout(() => void pump(), 0).unref();
  return c.id;
}
/** The harness a phase's session was made on (older phases saved none: Claude Code). */
const brainOf = (ph: Phase): Harness => (isHarness(ph.brain) ? ph.brain : 'claude');
/**
 * A recorded session can only be resumed by the harness that made it (a stand-in can't read the other's sessions). With
 * several providers (providers.ts), the next pass stays on that harness while it answers, so the session goes on.
 */
const sameHarness = (ph: Phase) => brainOf(ph) === pickHarness({ prefer: brainOf(ph) });
/** A resume for the harness running now: a session of the other harness becomes a fresh session told the same. */
function forHarness(ph: Phase, r: { session?: string; prompt: string } | undefined) {
  if (!r?.session || sameHarness(ph)) return r;
  return { prompt: `Read .hawkes/brief.md: it's your whole task. Your earlier session ran on another AI harness, so this one starts fresh: your work so far is in the worktree (\`git status\`, \`git log\`). ${r.prompt}` };
}
/** The agent's .hawkes/summary.md, or ''. */
function readSummary(worktree: string) {
  try { return fs.readFileSync(path.join(worktree, '.hawkes', 'summary.md'), 'utf8').trim(); } catch { return ''; }
}
/** A failed change with no commits and a clean tree: the worktree is only a copy of the base. Remove it. */
async function dropEmptyWorktree(id: string, commits: string[]) {
  if (commits.length) {
    // Commits are on the branch (savework pushed them): the worktree still fills Cloud Run's memory disk until removed.
    await endChangeDisk(id);
    return;
  }
  const c = getChange(id);
  if (!c?.worktree || !fs.existsSync(c.worktree)) return;
  try {
    if (uncommitted(c.worktree)) return;
  } catch {
    return;
  }
  await endChangeDisk(id);
}

/**
 * Where a change's work is, recorded as it goes so a Studio restart (a deploy) doesn't redo it: the steps in order
 * (prepare: worktree and brief; agent: Claude Code, detached, with its process and how far its output was read;
 * publish: push and pull request; verify: build, playtest and review, with their Gen jobs; finish: canon, preview,
 * ready), and what the pass is (J's note, an answer). Null once the change isn't being worked on
 * (a failed one keeps the step it failed at, with `failed`).
 */
export type Phase = {
  step: 'prepare' | 'agent' | 'publish' | 'verify' | 'finish' | 'gen';
  /** Played by itself to ship shots and a clip with the change (showcaseFor), not on J's request. */
  showcase?: boolean;
  note?: string;
  answer?: string;
  /** The worktree's HEAD before the agent's pass. */
  before?: string;
  /** The agent's detached process (detach.ts) and the byte of its output Studio had logged up to. */
  proc?: { rec: DetachRec; offset: number };
  /** Which brain ran this pass (claude or grok), so a restart after a switch starts a new session. */
  brain?: string;
  /** The agent's final words (the summary when it wrote none). */
  result?: string;
  /** The pushed commit under verification. */
  tip?: string;
  /** Verification's Hawkes Gen jobs (build, playtest, review): waited on again after a restart, not submitted again. */
  jobs?: Record<string, string>;
  verify?: any;
  /** When this pass started: how far the Activity panel's progress bar creeps through the coding stage. */
  since?: number;
  /** On a failed change: the step it failed at, kept for the Activity panel's stages (nothing resumes it). */
  failed?: boolean;
  /** A playtest asked for (playtestChange): who asked. It ends the pass with the change ready again, never failed. */
  requested?: string;
  /** The first failure line Studio's own job printed in the last pass (machineryFailure): with no commit, an infra failure, not a try. */
  machinery?: string;
  /** The last pass ran in a Cloud Run job's own workspace (ranInCloudJob): Studio's worktree isn't what it worked in. */
  job?: boolean;
  /** Why the last agent pass ended before finishing (AgentResult.stopped). */
  stopped?: 'time' | 'turns' | 'cut';
  /** How many times its session was resumed to commit work it left uncommitted (at most NUDGES); `nudge`: the next pass is one. */
  nudges?: number;
  nudge?: boolean;
  /** The Unity check (unitycheck.ts) that ran before the pull request: its last result; `unityFixes` passes sent back for it (at most UNITY_FIXES), `unityFix` the next pass is one. */
  unity?: UnityCheckResult;
  unityFixes?: number;
  unityFix?: boolean;
  /** The compile gate (compilecheck.ts): Gen's compile of the pushed branch, `compileFixes` passes sent back for it (at most COMPILE_FIXES), `compileFix` the next pass is one. */
  compile?: CompileResult;
  compileFixes?: number;
  compileFix?: boolean;
  /** The quality scan (quality-scan.ts, the game quality rubric's build gate) before the pull request: its last result; `qualityFixes` passes sent back for it (at most QUALITY_FIXES), `qualityFix` the next pass is one. */
  quality?: QualityScan;
  qualityFixes?: number;
  qualityFix?: boolean;
  /** A conflict pass (resolveConflicts): the files that conflict with the base; the agent's session merges and resolves. */
  conflict?: string[];
  /** Parked on Gen (status WAITING_GEN, step 'gen'): the agent's queued jobs, polled until every one has finished. */
  gen?: GenWait;
  /** The next pass continues the agent's session with its finished Gen jobs (this prompt). */
  genDone?: string;
  /** Parked by a harness hold (parkForHarness): what stopped it. The next pass resumes it (harnessResume). */
  harness?: { kind: string; line: string; at: number; on: string; /** When each park happened (the last hour's, for the resume cap). */ parks?: number[]; /** Asked J after the cap: no more resumes by itself. */ capped?: boolean };
  /** Restarts that resumed it at this step in a row (resumeChanges): a step that keeps ending Studio isn't resumed again. */
  restarts?: { step: string; n: number; at: number; /** A Cloud Run agent job's output offset at that restart: progress since is not counted. */ offset?: number };
  /** Times the stuck-work watchdog (checkStuck) took this change over at one step, and when. */
  watch?: { step: string; n: number; at: number };
  /** A change stopped for restarts that was carried on once Studio had stayed up (reviveRestartStopped): not again. */
  revived?: boolean;
  /** Whole-run retries after a Studio checkout failure in prepare (AUTO_RETRIES at most): Studio tries again by itself. */
  autoRetry?: number;
  /** Queued again to try by itself (endPass): not started before this time; the queue's own timer (pumpAt) wakes it. */
  notBefore?: number;
  /** Its agent's Cloud Run job never started for want of room, n times in a row (waitForJobRoom); cleared once one runs. */
  noRoom?: { n: number; at: number };
  /** Times this change requeued because Gen's MCP was unreachable at session start (parkForGenUnreachable); not a try. */
  genMisses?: number;
};

/**
 * A GPU agent that queued Gen jobs parks instead of waiting in its session (J, 2026-10-18, q_dda086e2af58): it writes
 * .hawkes/waiting-jobs.txt and ends; the change is "waiting on Gen" (not failed, not ready, no try, no product slot)
 * while Studio follows the jobs (pollGenWaits: Gen's events, genevents.ts), and its session is resumed with their results
 * once all have finished.
 */
export const WAITING_GEN = 'waiting on Gen';
export type GenJobWait = { id: string; note: string; status?: string; assets?: string[]; error?: string };
export type GenWait = { jobs: GenJobWait[]; since: number; checked?: number; told?: boolean };
const GEN_TERMINAL = new Set(['done', 'failed', 'cancelled', 'missing', 'timed out']);
export const genJobDone = (j: Pick<GenJobWait, 'status'>) => GEN_TERMINAL.has(String(j.status));
/** .hawkes/waiting-jobs.txt: one Gen job id per line, then (after a space, ":" or a dash) what to do with its output. */
export function parseWaitingJobs(text: string): GenJobWait[] {
  const out: GenJobWait[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '').replace(/`/g, '');
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]{4,})\s*(?:[:—–-]\s*|\s+|$)(.*)$/.exec(line);
    if (m && !out.some((j) => j.id === m[1])) out.push({ id: m[1], note: m[2].trim().slice(0, 500) });
  }
  return out.slice(0, 100);
}
/** "2 of 5 done" */
export const genProgress = (w: Pick<GenWait, 'jobs'>) => `${w.jobs.filter(genJobDone).length} of ${w.jobs.length} done`;
/** The prompt that resumes the agent's session once its jobs have finished. */
export function genDonePrompt(w: Pick<GenWait, 'jobs'>) {
  const lines = w.jobs.map((j) => `- \`${j.id}\`: ${j.status ?? '?'}${j.assets?.length ? `, assets ${j.assets.map((a) => `\`${a}\``).join(', ')}` : ''}${j.error ? ` (${j.error.slice(0, 200)})` : ''}${j.note ? `. Your note: ${j.note}` : ''}`);
  return `Your Gen jobs finished:
${lines.join('\n')}

Continue the task in .hawkes/brief.md with them: judge the outputs, bake or wire in the ones that pass, commit, and
write .hawkes/summary.md (and try.md, learned.md as the brief says). A failed or cancelled job: retry it within your
budget or say what's missing. If you queue more Gen jobs, park again the same way (.hawkes/waiting-jobs.txt, then end).`;
}
/** How long parked jobs may wait before Talk hears of it, once (agents.genWaitHours, default 6). */
/**
 * The end of a wait on Gen: twice the time Talk is told (12 h by default). Past it the jobs still unfinished are
 * "timed out" and the agent goes on without them (stand-ins, or says what's missing), as it does for a failed job. Before
 * 2026-11-11 a wait on Gen had no end: a job Gen lost track of, or a GPU queue that never drained, held the change (and,
 * through it, its task and a Unity milestone's build) for ever.
 */
export const genWaitEndMs = () => Number(process.env.STUDIO_GEN_WAIT_END_MS) > 0 ? Number(process.env.STUDIO_GEN_WAIT_END_MS) : Math.max(2 * genWaitMs(), 2 * 3600_000);
const genWaitMs = (s = agentSettings()) => Number(process.env.STUDIO_GEN_WAIT_MS) > 0 ? Number(process.env.STUDIO_GEN_WAIT_MS) : (s.genWaitHours > 0 ? s.genWaitHours : 6) * 3600_000;
/**
 * How often parked jobs are asked for (one GET per unfinished job). STUDIO_GEN_POLL_MS: tests. Gen's events (genevents.ts)
 * resume a change the moment its last job ends, so while the stream is open this is only the safety net for an event
 * missed: every 5 minutes (SAFETY_MS). While it is down (Gen restarting, an old Gen), the old pace: every 30 s while the
 * wait is young, and every 3 minutes once it has waited GEN_POLL_SLOW_AFTER (long GPU queues need no more). It was every
 * 3 minutes before that, so an agent whose Gen jobs finished sat up to 3 minutes before its session carried on.
 */
const genPollMs = () => Number(process.env.STUDIO_GEN_POLL_MS) > 0 ? Number(process.env.STUDIO_GEN_POLL_MS) : 30_000;
const GEN_POLL_SLOW_AFTER = 15 * 60_000;
/** Whether a parked change's jobs are due a look now (never looked at yet: at once). live: Gen's event stream is open. */
export function genPollDue(w: Pick<GenWait, 'since' | 'checked'>, now = Date.now(), base = genPollMs(), live = genEvents.live()) {
  if (!w.checked) return true;
  const every = live ? Math.max(base, GEN_EVENTS_SAFETY_MS()) : now - w.since < GEN_POLL_SLOW_AFTER ? base : Math.max(base, 3 * 60_000);
  return now - w.checked >= every - 1000; // a tick's own jitter doesn't skip a whole interval
}

/** Uncommitted work in a worktree (Studio's .hawkes/ notes aside). */
export function uncommitted(worktree: string) {
  return git(worktree, ['status', '--porcelain', '--', '.', ':(exclude).hawkes']).out;
}
const STOP_WHY = { time: "it reached Studio's time limit for one pass", turns: 'it reached its turn limit', cut: 'its session ended without finishing' } as const;
const STOP_YOU = { time: "you reached Studio's time limit for one pass", turns: 'you reached your turn limit', cut: 'your session ended before you finished' } as const;
/**
 * Whether an agent pass that just ended gets its session resumed to commit (J, 2026-10-18: "handle whatever situation
 * gracefully"): it left uncommitted work, and either made no new commit or was stopped before it finished, and it has
 * tries left. Not when it asked a question. An agent that changed nothing fails as before.
 */
export function needsNudge(ph: Pick<Phase, 'stopped' | 'nudges'>, { dirty, newCommit, question }: { dirty: boolean; newCommit: boolean; question: boolean }) {
  // One that ended on its own (it may have chosen not to commit) is asked once; one that was stopped, up to NUDGES times.
  return !question && dirty && (!newCommit || Boolean(ph.stopped)) && (ph.nudges ?? 0) < (ph.stopped ? NUDGES : 1);
}
const nudgePrompt = (ph: Phase) => `You stopped before committing: ${ph.stopped ? STOP_YOU[ph.stopped] : 'you ended without committing'}. Your work is still in the worktree (\`git status\`).

1. Commit what you have now, with a clear message (run the quick checks first if they take a minute or two).
2. Then finish the task in .hawkes/brief.md the way it says, committing after each piece. Don't sit in a long wait:
   check jobs that are still running, take what's done, and say in .hawkes/summary.md what's still running or left
   (Gen jobs still running: list them in .hawkes/waiting-jobs.txt as the brief says, and Studio resumes you after).
3. Write .hawkes/summary.md (and try.md, learned.md as the brief says).

If you left it uncommitted on purpose (the brief says not to commit when you couldn't do it), say why in
.hawkes/summary.md and end without committing.`;
/** The pass that commits it: the same session (claude --resume), or a new one told the same when none was recorded. */
function nudgeResume(c: Change, ph: Phase) {
  const prompt = nudgePrompt(ph);
  return c.session ? { session: c.session, prompt } : { prompt: `Read .hawkes/brief.md: it's your whole task. ${prompt}` };
}
/** How many times a change that fails the Unity check is sent back to its agent before it fails. */
export const UNITY_FIXES = 2;
function unityFixResume(c: Change, u: UnityCheckResult) {
  const prompt = unityFixPrompt(u);
  return c.session ? { session: c.session, prompt } : { prompt: `Read .hawkes/brief.md for what your change is. ${prompt}` };
}
/** The plugin's name (its subagents are "<name>:<role>"): hawkes in this Studio, studio in a customer's. */
function pluginName() {
  try { return String(JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR(), '.claude-plugin', 'plugin.json'), 'utf8')).name || 'hawkes'); } catch { return 'hawkes'; }
}
/** How many times a game change that fails the quality scan is sent back to its agent before it fails. */
export const QUALITY_FIXES = 2;
function qualityFixResume(c: Change, q: QualityScan) {
  const prompt = qualityFixPrompt(q);
  return c.session ? { session: c.session, prompt } : { prompt: `Read .hawkes/brief.md for what your change is. ${prompt}` };
}
function compileFixResume(c: Change, r: CompileResult) {
  const prompt = compileFixPrompt(r);
  return c.session ? { session: c.session, prompt } : { prompt: `Read .hawkes/brief.md for what your change is. ${prompt}` };
}
/** Where an agent says which conflicted files it couldn't resolve safely (a conflict pass): they go back to the PM. */
export const UNRESOLVED = '.hawkes/unresolved.md';
/**
 * A conflict pass: the agent's own session (it knows its change) merges the base and resolves; a new one reads the brief
 * first. `unity`: the conflicted files sorted into binary, Unity YAML, code and data, with the Unity rules (J,
 * 2026-10-19); `lfs`: the ones in Git LFS (binary, whatever their extension).
 */
export function conflictPrompt(c: Pick<Change, 'base'> & { infra?: boolean }, files: string[], { unity = false, lfs = new Set<string>() }: { unity?: boolean; lfs?: Set<string> } = {}) {
  const base = c.base ?? BETA;
  const q = (xs: string[]) => xs.slice(0, 20).map((f) => `\`${f}\``).join(', ') + (xs.length > 20 ? ` and ${xs.length - 20} more` : '');
  const k = sortConflicts(files, lfs);
  const sorted = unity && files.length ? `

The conflicted files, by kind:
${k.binary.length ? `- **Binary** (never hand-merged, never regenerated): ${q(k.binary)}. Take ${base}'s version
  (\`git checkout --theirs -- <file>\` while merging), then redo your own edit on top; if your change needs a different
  version, add it as a new file with its own .meta and point your work at that.
` : ''}${k.unity.length ? `- **Unity YAML**: ${q(k.unity)}. Merge by hand keeping both sides' objects; every GUID and fileID stays as it is
  (none duplicated or renumbered), each asset keeps its .meta. After: \`grep -nE '^(<<<<<<<|=======|>>>>>>>)'\` finds
  nothing, and the \`--- !u!\` document headers are all there.
` : ''}${k.code.length ? `- **Code**: ${q(k.code)}. Keep both sides' logic; it must still compile and pass the checks.
` : ''}${k.data.length ? `- **Data** (JSON, text): ${q(k.data)}. Keep both sides' entries; run the project's validators.
` : ''}
The rules for this project:
${UNITY_RULES}` : '';
  const giveUp = c.infra ? '' : `
5. A file you can't resolve safely (the same binary changed on both sides, a scene or prefab both sides restructured):
   don't commit a broken merge. \`git merge --abort\`, list each such file and why in \`${UNRESOLVED}\`, and end.
   Studio hands it to the PM with that list.`;
  return `${base === BETA ? 'Beta' : base} moved while your change waited to merge: another change merged into ${base} first, and your branch now conflicts with it${files.length ? ` in ${q(files)}` : ''}.

1. \`git merge origin/${base}\` (Studio already fetched it).
2. Resolve the conflicts keeping both sides' intent: what ${base} has now (the other change's work) and what your change does.
   Don't drop either side, and don't redo your task.
3. Re-run the checks the brief names, fix what fails, and commit the merge.
4. Update .hawkes/summary.md${unity ? ': say which files conflicted and how you resolved each one' : ' only if what your change does is different now'}.${giveUp}${sorted}`;
}
/** The files of `files` that are in Git LFS in a worktree (binary for a merge, whatever their extension). */
function lfsFiles(worktree: string, files: string[]) {
  if (!files.length || !fs.existsSync(worktree)) return new Set<string>();
  const out = git(worktree, ['check-attr', 'filter', '--', ...files.slice(0, 200)], 10_000).out;
  return new Set(out.split('\n').map((l) => l.match(/^(.*): filter: lfs$/)?.[1]).filter((f): f is string => Boolean(f)));
}
const conflictOpts = (c: Change, files: string[]) => (c.infra ? {} : { unity: isUnity(c.product), lfs: lfsFiles(c.worktree, files) });
function conflictResume(c: Change, files: string[]) {
  const prompt = conflictPrompt(c, files, conflictOpts(c, files));
  return c.session ? { session: c.session, prompt } : { prompt: `Read .hawkes/brief.md for what your change is. ${prompt}` };
}
/** Records the next pass as a nudge (saved, so a restart carries on with it) and says why in the log. */
function nudge(id: string, ph: Phase, save: (patch: Partial<Phase>) => void) {
  const n = (ph.nudges ?? 0) + 1;
  addLog(id, `agent: ${ph.stopped ? STOP_WHY[ph.stopped] : 'it ended without committing'}, with its work uncommitted in the worktree; resuming its session to commit it and finish (${n} of ${NUDGES})`);
  save({ step: 'agent', nudges: n, nudge: true, result: undefined, stopped: undefined, proc: undefined, since: Date.now() });
}
/**
 * Whether a change that made no commit did so because it never had the source: the worktree fails the probe now, or the
 * agent said it couldn't read the repo. Returns the detail to record (it carries the exact finding), else null.
 */
export function sourceLost(c: Pick<Change, 'worktree' | 'product' | 'infra'>, said: string, ranInJob = false): string | null {
  if (c.infra) return null;
  // A pass that ran in a Cloud Run job worked in the job's own workspace (its preflight already checked the source, and a
  // job that couldn't get one failed as machinery). Studio's worktree may have been remade light after a restart, so its
  // probe says nothing about that pass: judged from what the agent said (outcomes.ts noCommitOutcome).
  let probe: { ok: boolean; tracked: number; reason?: string } | null = null;
  if (!ranInJob) {
    const light = fs.existsSync(c.worktree) && git(c.worktree, ['config', '--get', 'hawkes.light']).out === 'true';
    if (light || isUnity(c.product)) probe = fs.existsSync(c.worktree) ? probeSource(c.worktree, { unity: light && isUnity(c.product) }) : { ok: false, tracked: 0, reason: `source missing: the worktree ${c.worktree} is gone` };
  }
  const hit = SOURCE_UNREADABLE_SAID.exec(said);
  const outcome = noCommitOutcome({
    ranInJob, worktreeProbeOk: probe ? probe.ok : null, saidUnreadable: Boolean(hit),
    saidAlreadyDone: alreadyDone(said), saidGenUnreachable: genUnreachableSaid(said),
  });
  if (outcome === 'gen-unreachable') return null;
  if (outcome === 'source-missing') return `${sourceError('the agent made no commit', probe as Parameters<typeof sourceError>[1])}`;
  if (outcome === 'source-unreadable') return `source unreadable: the agent made no commit and said it could not read the repo ("${hit![0].slice(0, 80)}"; not counted as a try)`;
  return null;
}
/** Whether a pass ran in a Cloud Run job: its recorded mode, or the `[job]` lines the job printed (cloudjob-run.ts). */
export const ranInCloudJob = (stderr: string | undefined | null, mode?: string) => mode === 'cloudrun' || /^\s*\[job\] /m.test(String(stderr ?? ''));
/** A failed change's reason: today's words, plus what's left when its work stayed uncommitted after the resumes. */
function noCommitWhy(worktree: string, ph: Phase) {
  if (!ph.nudges || !uncommitted(worktree)) return 'the agent made no commit';
  return `the agent made no commit: resumed ${ph.nudges}× to commit, it still left its work uncommitted (it is still in the worktree: revise to carry on)`;
}
/**
 * A failure line Studio's own job or bring-back step printed (cloudjob-run.ts `[job] ...`, cloudjob.ts `[studio] ...`): the
 * clone, the checkout, the bundle, the files coming back. With no commit that is why there is none (J, 2026-11-03: ~12
 * Unity changes ended "the agent made no commit" and were tried again 11 times, because the reason never reached the
 * change). null when the pass printed no such line.
 */
export function machineryFailure(stderr: string | undefined | null): string | null {
  for (const line of String(stderr ?? '').split('\n')) {
    const m = /^\s*\[(job|studio)\]\s+(.*)$/.exec(line);
    if (m && !/not copied/i.test(m[2]) && /\b(fail(ed|ure)?|couldn'?t|could not|cannot|can'?t|unable|error|missing|unreadable|killed|signal|out of memory|no spec|gone)\b/i.test(m[2])) return `Studio's ${m[1]} step: ${m[2]}`.slice(0, 300);
  }
  return null;
}
export const phaseOf = (id: string): Phase | null => parse((db.prepare('SELECT phase FROM changes WHERE id = ?').get(id) as any)?.phase ?? null);
/** A line on a change's log, from outside this file (access.ts). */
export const changeLog = (id: string, line: string) => addLog(id, line);
/** A change's fields written as the pass would (queue-heal.ts parks with it). */
export const patchChange = (id: string, patch: Partial<Record<string, any>>) => update(id, patch);
function addLog(id: string, line: string) {
  const c = getChange(id)!;
  const log = [...c.log, `${new Date().toISOString().slice(11, 19)} ${line}`].slice(-400);
  update(id, { log });
}

// ------------------------------------------------------------------- git

function git(cwd: string, args: string[], timeoutMs = 10 * 60_000) {
  const t0 = Date.now();
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  // Only for millisecond reads (beta.ts git): a slow one is named, so it moves to gitAsync.
  const ms = Date.now() - t0;
  if (ms > 300) console.warn(`[studio] synchronous git ${args.slice(0, 3).join(' ')} in ${path.basename(cwd)} held Studio for ${ms} ms: use gitAsync`);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
}

/**
 * What an agent says when its `git commit` was refused: the sandbox's permissions (index.lock: Permission denied), or
 * Claude Code's own tool permissions (2026-11-01: on Cloud Run, `git -C <dir> commit` isn't in the role's allowed
 * tools, and fixers in Hawkes Games and Hawkes Net for Unity said "the commit command needs your approval").
 */
export const COMMIT_DENIED = /index\.lock|(commit|\.git)[^\n]{0,80}permission denied|permission denied[^\n]{0,80}(commit|\.git)|unable to (create|append|write)[^\n]*\.git|commit[^\n]{0,60}\b(needs?|requires?|waits? for|awaiting) (your |an? )?(approval|permission)|commit[^\n]{0,60}\b(was|were|got|is) (blocked|denied|refused|not (allowed|permitted|approved))|(couldn't|could not|can't|cannot|unable to) (run )?(the )?(git )?commit/i;

/**
 * The safety net behind shareWorktree (sandbox.ts): an agent that finished but whose `git commit` was refused left its
 * work uncommitted. Studio commits it as it is (its own hooks off), says so, and the change publishes as usual. Only
 * when the agent said so and the tree has changes; the caller checked the worktree still links here (assertWorktree).
 */
async function commitForAgent(id: string, worktree: string, title: string, said: string) {
  if (!COMMIT_DENIED.test(said) || !(await gitAsync(worktree, ['status', '--porcelain'])).out) return false;
  const add = await gitAsync(worktree, ['add', '--sparse', '-A']);
  const commit = add.ok && await gitAsync(worktree, ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', `${title.slice(0, 72)}\n\nCommitted by Hawkes Studio: the agent's own git commit was refused (a permission error in the worktree's git folder).`]);
  if (!add.ok || !commit || !commit.ok) {
    addLog(id, `Studio couldn't commit the agent's work either: ${(add.ok ? commit && commit.err : add.err) ?? ''}`.slice(0, 300));
    return false;
  }
  addLog(id, 'the agent couldn\'t commit (a permission error): Studio committed its work and publishes it');
  return true;
}

/** The repo a product's fixes go to (its source repo), its folder and GitHub slug. */
function repoFor(p: Product) {
  const top = p.repo.split('/')[0];
  const slug = repoMap()[top];
  if (!slug) throw new Error(`products.json has no GitHub repo for ${top}`);
  return { top, slug, sub: p.repo.split('/').slice(1).join('/') };
}

/**
 * A Unity product's website repo (home page, blog, privacy, the game page: sickofitgamewebsite, YoobaLandGame,
 * theplacedepartmentwebsite), where its site is a repo of its own; null otherwise. A change with target "site" works
 * there: its branch is cut from the website's beta and its pull request merges into it (beta.ts).
 */
export function siteRepoFor(p: Product) {
  const top = p.site.split('/')[0];
  if (!p.build || top === p.repo.split('/')[0]) return null;
  const slug = repoMap()[top];
  return slug ? { top, slug, sub: p.site.split('/').slice(1).join('/') } : null;
}
/** True for a change that works in its product's website repo (target "site"), not the source repo. */
export const isSiteChange = (c: { repo: string; infra?: boolean | number | null }, p: Product) => !c.infra && c.repo !== p.repo.split('/')[0] && c.repo === siteRepoFor(p)?.top;
/** The repo a new change of a product works in: its source repo, or (target "site") its website repo. */
function repoForTarget(p: Product, target?: string | null) {
  const t = String(target ?? '').trim().toLowerCase();
  if (!t || t === 'source' || t === 'game') return repoFor(p);
  // A project with more than one repository (config.ts Product.repos): the target names one by owner/name, name or role.
  const other = (p.repos ?? []).find((r) => r.folder && [r.repo.toLowerCase(), r.repo.split('/')[1].toLowerCase(), String(r.role ?? '').toLowerCase()].includes(t));
  if (other) return { top: other.folder!, slug: repoMap()[other.folder!] ?? other.repo, sub: '' };
  if (p.repos?.length && t !== 'site' && t !== 'website') throw new StudioError(`target is one of ${p.name}'s repositories (${p.repos.map((r) => r.repo).join(', ')}) or empty (${p.github ?? p.repo})`);
  if (t !== 'site' && t !== 'website') throw new StudioError(`target is "site" (the website repo) or empty (the game's source repo), not "${target}"`);
  const site = siteRepoFor(p);
  if (!site) throw new StudioError(`${p.name} has no website repo of its own: its pages are in ${p.repo.split('/')[0]} (leave target empty).`);
  return site;
}

const WORK = () => path.join(PROJECTS, '.work');

/**
 * A change's worktree lost with a replaced Cloud Run instance (2026-11-02: worktrees live on the instance's own disk,
 * which is never synced) made again from the repo: its branch as saved on GitHub (savework.ts), else a new branch from
 * origin/<base>. The pass's job brings its commits into it (cloudjob.ts finish). One at a time per change; true once the
 * worktree is there. Never touches a folder that exists but isn't a worktree.
 */
const remaking = new Map<string, Promise<boolean>>();
export function remakeWorktree(id: string): Promise<boolean> {
  const c = getChange(id);
  if (!c?.worktree) return Promise.resolve(false);
  if (fs.existsSync(path.join(c.worktree, '.git'))) return Promise.resolve(true);
  let p = remaking.get(id);
  if (!p) {
    p = checkoutSlot(() => critical(`making the worktree of ${id} again`, async () => {
      if (fs.existsSync(path.join(c.worktree, '.git'))) return true;
      await discardIfHalfMade(path.join(PROJECTS, c.repo), c.worktree, gitAsync, (m) => addLog(id, m));
      if (fs.existsSync(c.worktree)) throw new Error(`${c.worktree} exists but isn't a worktree; not touching it`);
      const repoDir = path.join(PROJECTS, c.repo);
      fs.mkdirSync(WORK(), { recursive: true });
      await ensureCloned(c.repo, c.slug);
      const f = await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
      if (!f.ok) throw new Error(`fetch failed: ${f.err}`);
      git(repoDir, ['worktree', 'prune']);
      const restored = await restoreBranch(repoDir, c.branch);
      if (restored) addLog(id, restored);
      const has = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`]).ok;
      const w = await addWorktree(repoDir, c.worktree, has ? [c.worktree, c.branch] : ['-b', c.branch, c.worktree, `origin/${c.base}`], gitAsync, { removeLeftover: !fs.existsSync(path.join(c.worktree, '.git')), log: (m) => addLog(id, m), onKilled: lowerCheckouts });
      if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
      addLog(id, `worktree missing after a Studio restart: made again from ${has ? c.branch : `origin/${c.base}`}; the agent's job brings its work into it`);
      return true;
    })).finally(() => remaking.delete(id));
    remaking.set(id, p);
  }
  return p;
}
// A Cloud Run job ending into a missing worktree (cloudjob.ts finish): the change's worktree is made again first.
setWorkspaceRestorer(async (cwd) => {
  const row = db.prepare('SELECT id FROM changes WHERE worktree = ? OR worktree = ?').get(cwd, path.resolve(cwd)) as { id: string } | undefined;
  return row ? remakeWorktree(row.id) : false;
});
/** Studio's git would run in a folder that's gone ("spawn git ENOENT"): said plainly instead, never "made no commit". */
function assertWorktreeThere(c: Pick<Change, 'worktree'>) {
  if (!fs.existsSync(path.join(c.worktree, '.git'))) throw new Error(`worktree missing after restart: ${c.worktree} is gone (the agent's log says whether its job's work was kept)`);
}
/**
 * Resumed at the agent step with the worktree gone: with a job still followed (proc), the worktree is made again before
 * waiting on it; with none, the pass starts over from prepare (the worktree and its brief made again).
 */
async function worktreeForAgentStep(id: string, ph: Phase, save: (patch: Partial<Phase>) => void) {
  if (ph.step !== 'agent' || fs.existsSync(path.join(getChange(id)!.worktree, '.git'))) return;
  if (!ph.proc) {
    addLog(id, 'worktree missing after a Studio restart: preparing it again before the pass');
    save({ step: 'prepare' });
    return;
  }
  await remakeWorktree(id).catch((e: any) => addLog(id, `couldn't make the worktree again yet: ${String(e?.message ?? e).slice(0, 300)} (the job's work stays in the bucket until it can be applied)`));
}

/**
 * Resumed past the agent (publish, verify, finish) with the worktree gone (a restart on Cloud Run loses every worktree):
 * it is made again from the branch saved on GitHub before the step goes on, so a build never starts from a folder that
 * isn't there (2026-11-10: two Yooba Land changes sat 12 hours at "building the branch in the cloud" after restarts).
 * When it can't be made and the pull request is open with the work committed, the change is ready as it stands.
 * Returns true when the pass is over (carried to ready).
 */
async function worktreeForLaterSteps(id: string, ph: Phase): Promise<boolean> {
  if (!['publish', 'verify', 'finish'].includes(ph.step)) return false;
  const c = getChange(id)!;
  if (!c.worktree || fs.existsSync(path.join(c.worktree, '.git'))) return false;
  const ok = await remakeWorktree(id).catch((e: any) => { addLog(id, `couldn't make the worktree again: ${String(e?.message ?? e).slice(0, 300)}`); return false; });
  if (ok) return false;
  if (carryFinishedToReady(getChange(id)!, ph, `its worktree is gone and couldn't be made again from ${c.branch}`)) return true;
  throw new Error(`worktree missing after a restart and it couldn't be made again from ${c.branch} on GitHub`);
}

// --------------------------------------------------------------- GitHub

export async function github(route: string, init: { method?: string; body?: unknown } = {}) {
  // The repo's own token (ghtoken.ts): J's for his repos, the GitHub App's (or a customer's org's) for the rest.
  const { repoToken, slugOfRoute } = await import('./ghtoken.ts');
  const token = (await repoToken(slugOfRoute(route))) ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('No GitHub token on the server yet (node deploy/github-token.mjs, then restart hawkes-secrets and hawkes-studio).');
  // STUDIO_GITHUB_API: a stand-in for GitHub's API (tests).
  const r = await fetch(`${process.env.STUDIO_GITHUB_API ?? 'https://api.github.com'}${route}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${route}: ${r.status} ${data.message ?? ''}`);
  return data;
}

const mergeMethods = new Map<string, { method: 'squash' | 'merge' | 'rebase'; at: number }>();
/** The merge method a repo allows (squash first, then a merge commit, then rebase), read from GitHub and kept 10 minutes:
 *  repos that turn squash off answered 405 to every merge (2026-10-31 review). */
export async function mergeMethodOf(slug: string): Promise<'squash' | 'merge' | 'rebase'> {
  const hit = mergeMethods.get(slug);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.method;
  const r = await github(`/repos/${slug}`).catch(() => null);
  const method = !r || r.allow_squash_merge !== false ? 'squash' : r.allow_merge_commit !== false ? 'merge' : 'rebase';
  mergeMethods.set(slug, { method, at: Date.now() });
  return method;
}

// ----------------------------------------------------------------- brief

/** The marker a GPU change leaves when it merged stand-ins (J, 2026-10-18): what's still to make, with its Gen job ids. */
export const PENDING_GPU = '.hawkes/pending-gpu.txt';
const STAND_IN = /\b(stand-?ins?|interim (art|sheets?|pass|version)|placeholders?|fallback (art|code|only)|no-GPU (first )?pass)\b/i;
const NO_GPU = /\b(no GPU server (was |came |is )?(running|up|ready|available)|GPU (server )?(wasn'?t|was not|never|didn'?t|did not) (running|up|come up|came up|start|available|ready)|without (a |the )?GPU|no GPU (was )?available|GPU part is still waiting|still waiting (for|on) (a |the )?GPU)/i;
/**
 * What a GPU task's change left to make on the GPU: its marker file, else its summary when it says it shipped stand-ins
 * because no GPU server ran (the agents before the marker). null: the real thing is in.
 */
export function pendingGpuOf(worktree: string, summary: string, made: { imported?: string[]; inCommit?: string[] } = {}): string | null {
  try {
    const marked = fs.readFileSync(path.join(worktree, PENDING_GPU), 'utf8').trim();
    if (marked) return trimPendingGpu(marked.slice(0, 2000), made);
  } catch { /* no marker */ }
  const s = String(summary ?? '');
  return STAND_IN.test(s) && NO_GPU.test(s) ? `its summary says it shipped stand-ins because no GPU server ran: ${s.slice(0, 600)}` : null;
}

const PATH_TOKEN = /[\w.<>*{}-]+(?:\/[\w.<>*{}-]+)+/g;
const normPath = (x: string) => x.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
/** A listed path as a matcher: `<id>` and `*` stand for any name (portrait/<id>-512.webp). */
function pathMatcher(token: string): RegExp {
  const esc = normPath(token).replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}/g, '[^/]*').replace(/<[^>]*>|\*+/g, '[^/]*');
  return new RegExp(`^${esc}$`);
}
/**
 * A pending list can repeat the brief's old list word for word after the agent did the work (J, 2026-11-13: DoD #187
 * imported 33 portraits and kept the list; Studio queued a $0.50 retry for art that was in). When the agent imported Gen
 * files this session (studio_gen_import: `imported`; `inCommit`: the files the change added or changed), drop each entry
 * whose listed paths were all written and keep what is really missing. Nothing left: null. Nothing imported: unchanged
 * (credits refused, no GPU: the full list stays and the task waits as before). Entries naming no path stay.
 */
export function trimPendingGpu(pending: string, made: { imported?: string[]; inCommit?: string[] } = {}): string | null {
  const imported = (made.imported ?? []).map(normPath).filter(Boolean);
  if (!imported.length) return pending;
  const written = [...new Set([...imported, ...(made.inCommit ?? []).map(normPath)])];
  const lines = pending.split('\n').map((l) => l.trim()).filter(Boolean);
  let dropped = 0;
  const kept = lines.filter((l) => {
    const toks = l.match(PATH_TOKEN) ?? [];
    if (!toks.length || !toks.every((t) => written.some((w) => pathMatcher(t).test(w)))) return true;
    dropped++;
    return false;
  });
  if (!dropped) return pending;
  return kept.some((l) => (l.match(PATH_TOKEN) ?? []).length) ? kept.join('\n') : null;
}

/** The repo paths this change imported from Gen (access_log, written by the gen-import route) and the files it changed. */
async function madeOf(c: { id: string; worktree: string; base?: string | null }): Promise<{ imported: string[]; inCommit: string[] }> {
  let imported: string[] = [];
  try { imported = (db.prepare(`SELECT target FROM access_log WHERE who = ? AND kind = 'gen' AND target IS NOT NULL`).all(c.id) as { target: string }[]).map((r) => r.target); } catch { /* no log yet */ }
  if (!imported.length) return { imported, inCommit: [] };
  let inCommit: string[] = [];
  try {
    const r = await gitAsync(c.worktree, ['diff', '--name-only', '--diff-filter=AM', `${c.base || 'beta'}...HEAD`]);
    inCommit = (r.ok ? r.out : '').split('\n').map((x) => x.trim()).filter(Boolean);
  } catch { /* the imports alone decide */ }
  return { imported, inCommit };
}

/** A video task's brief (videos.ts): how it's judged (J screens it), where the work goes, what to leave for Studio. */
function videoBrief(c: Change) {
  const versions = versionsOf(c.task!);
  return `## This is a video (J screens it)

Follow the video skill below (every harness gets it here; Claude Code can also load it as \`video\`). No playtest and
no beta check judge this: J watches each version in Studio's Screening tab and either approves it or sends notes, which
come back to you here as a revision of this same work.

- Keep the video's source in this repo under \`videos/<slug>/\`: \`script.md\` (J's script, as written), \`video.json\`
  (cast and voices, shots, the cut's timeline, every Gen job and asset id). Commit it each pass: **text only, never
  media** (renders, clips, stills, audio, captions stay in Gen's library, by asset id; no \`git add -f\`).
- Work only in this worktree (\`${c.worktree}\`). Never write in the product's other checkouts (\`${path.join(PROJECTS, c.repo)}\`
  and the rest): Studio deploys beta from them, and files left there stop it.
- Render with Hawkes Gen (\`video.compose\` for the cut). Leave the finished cut in \`.hawkes/video.json\`:
  \`{ "asset": "a_...", "poster": "a_...", "seconds": 31.5, "summary": "what changed this version", "caption": "post text with hashtags", "stage": "animatic" or "final", "story": "the logline, wants, turn and payoff", "beats": [the beat sheet], "edit": { the cut as video.compose's timeline with Gen asset ids } }\`.
  Your first pass is the animatic unless the request says J turned it off; the final comes after J approves it.
  **Always hand over the \`edit\`** (the skill's "The edit"): it's how J's timeline notes find your shots and how Studio makes
  his quick edits (cut, speed, zoom) without you.
  If you can't put the cut into Gen yourself, give its path in this worktree instead (\`"file": "videos/<slug>/out/cut.mp4"\`,
  \`"poster": "videos/<slug>/out/poster.png"\`): Studio uploads it. Without one of them there is nothing for J to watch.
- On a revision: answer every note, change only what the notes are about, and say per note what you did in \`summary\`.
  J's notes come from the Screening timeline: \`[v3 · 0:12.4-0:15.0 · edit clips 4, 5 · beats 6 "ots_mech" (...)]\` names
  exactly which version, seconds, clips of your edit and beats he means, then what he asked for and his words. "Studio made
  a quick edit" lines are edits J already made: take them into your edit (don't undo them).
${versions.length ? `- Versions so far: ${versions.map((v) => `v${v.n} ${v.asset}${v.summary ? ` (${v.summary.slice(0, 120)})` : ''}`).join('; ')}.
` : ''}
${videoSkill()}
`;
}

/** The video skill's text (.claude/skills/video/SKILL.md without its frontmatter), for the brief. */
function videoSkill() {
  try {
    return fs.readFileSync(path.join(PLUGIN_DIR(), 'skills', 'video', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '').replace(/^# /m, '### The video skill: ').replace(/^## /gm, '#### ');
  } catch {
    return '(No video skill here: make the video with the video tools of Hawkes Gen, the gen-assets skill.)';
  }
}

/** What GPU generation this change may do (content work): its approved budget (J's, or Studio's under the auto-approval threshold), or none. */
export function gpuBrief(c: Change) {
  return `${gpuBriefBody(c)}${gpuStateBrief()}`;
}

/** Studio's one verdict on GPU work (gpuverdict.ts), so an agent never re-decides it from the fleet tool. */
function gpuStateBrief() {
  const v = lastGpuVerdict();
  return `### Can GPU work run now? Studio has already decided

${v ? `${v.line} (read ${new Date(v.at).toISOString().slice(11, 16)} UTC)` : "Studio has no fresh reading; assume GPU jobs can run, and let a job's own error tell you otherwise."}

- \`hawkesgen_fleet\` reports only Hawkes Gen's AWS servers. "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not in
  hawkesgen/.env" with servers [] means AWS isn't set up, nothing more: Gen sends GPU jobs to RunPod and Modal. It is NOT
  "the GPU fleet is down". Don't pause, wait or stop for it, and don't re-decide GPU availability from it; queue the job.
- A "paused" or "wait until the fleet works" note left by an earlier pass (a .hawkes/summary.md, a memory) is not a
  decision by J. Only an owner answer recorded in this brief is. If a job really is refused (402, no provider), say that
  error in the summary and stop; Studio parks the task on it.

`;
}

function gpuBriefBody(c: Change) {
  const b = c.gpu_budget === null ? null : Number(c.gpu_budget);
  if (b !== null && b > 0) {
    return `## GPU budget: $${b.toFixed(2)} (approved)

You may generate through Hawkes Gen up to that: queue each kind of job as one batch (one model load), reuse what
the library already has (\`reuse\`, asset manifests), and report the GPU minutes and dollars spent (\`hawkesgen_jobs\`).
Never spend past it: if it won't fit, make the most important part and say what the rest would cost, or ask (a
question) for more.

You can't start GPU servers yourself (that needs Gen's owner role), and you don't need to: when no GPU server is
running, Studio has started a stopped one for you as this change began (it takes a few minutes to boot, and stops
itself after Gen's idle time). Ignore Gen's "only J can start one" note (Studio already did; don't ask J), and never
launch a server.

**Don't wait for GPU jobs in your session.** Do the parts that need no GPU first, then:
1. Queue your Gen jobs (\`hawkesgen_run\` with \`wait_for_server: true\`; one batch per kind of job). Gen holds them
   until a server is ready.
2. Commit any work that doesn't need their outputs.
3. Write \`.hawkes/waiting-jobs.txt\`: one Gen job id per line, each followed by a note of what to do with its output
   (e.g. \`j_abc123 portal open clip: judge, then bake into Assets/Art/Portal\`).
4. End your session (a short \`.hawkes/summary.md\` of what's done so far).

Studio watches those jobs (they may take hours if servers are busy) and resumes this same session with their results
(ids, statuses, asset ids) once every one has finished; then you judge, bake and commit. That isn't a failure and
costs no try.

If you ship stand-in or interim art, or fallback code, because the GPU art isn't made yet, list what is still to make
in \`${PENDING_GPU}\` (one line each: the piece, what it needs, and its Hawkes Gen job ids). Then the task doesn't
count as done: Studio runs it again (not as a try) once a GPU server is up, until the real art lands. Delete that file
when nothing is left to make.

`;
  }
  return `## GPU budget: none

Nothing here was approved for GPU generation (images, video, music, 3D on the fleet). Do everything that needs no GPU
(design, data, specs, Claude-only steps, voice and sound effects are fine: cents each), price the GPU part with
\`hawkesgen_estimate\`, and end with that estimate in your summary so J can approve it. Never start a GPU server.

`;
}

/** Content and story work (dialogue, lore, levels, characters) is checked against canon; the rest is a fix or a build. */
const CONTENT = /\b(story|lore|canon|dialog(ue)?|line|lines|bark|script|cutscene|quest|character|fighter|level|floor|stage|map|name|text|copy|voice|narrat|chapter|scene|enemy|enemies|boss)\b/i;
export function roleOf(c: { infra?: boolean; request?: string | null; findings?: string[]; title?: string | null; gpu_budget?: string | null; task?: string | null }): 'infra' | 'content' | 'builder' | 'fixer' {
  if (c.infra) return 'infra';
  // A video (videos.ts) is content work: the content role, with the video skill.
  if (c.task && isVideoTask(c.task)) return 'content';
  // A task J gave a GPU budget is content work (generated art, music, levels).
  if (c.gpu_budget !== undefined && c.gpu_budget !== null) return 'content';
  if (CONTENT.test(`${c.request ?? ''} ${c.title ?? ''}`)) return 'content';
  return c.request ? 'builder' : 'fixer';
}

/**
 * The kind of work a change is, for its brief (the owner's gaps list, 2026-11-08: separate briefs for fix, feature,
 * content and polish work). polish: the weekly polish pass, or findings that are all polish; fix: playtest findings;
 * content: the content role's work; feature: any other request or task.
 */
export type JobKind = 'fix' | 'feature' | 'content' | 'polish' | 'new-game';
/** A request to make a game's first version (repokit.ts firstVersionBrief) or a new game from scratch. */
const NEW_GAME = /\b(first playable version|new game|from scratch|game pitch)\b/i;
export function jobKind(c: Parameters<typeof roleOf>[0] & { started_by?: string | null }, findings: { severity?: string }[] = []): JobKind {
  if (c.started_by === POLISH_BY || (!c.request && findings.length > 0 && findings.every((f) => f.severity === 'polish'))) return 'polish';
  if (!c.request) return 'fix';
  if (NEW_GAME.test(`${c.title ?? ''} ${c.request}`)) return 'new-game';
  return roleOf(c) === 'content' ? 'content' : 'feature';
}

/** Each kind's opening line, its rules, how to start, what to keep to, and its commit message prefix. */
/**
 * The design skills a game job loads (.claude/skills and customer-plugin/skills): story-through-play (characters with a
 * want, an arc, a voice and animations), level-design (docs/metrics.json numbers) and game-feel (coyote time, jump buffer
 * and hit-stop floors). Listed in the brief's "Skills to load" section.
 */
export const DESIGN_SKILLS = {
  'story-through-play': 'every named character has a want, an arc, the gameplay moment that shows it, three personality words, a Gen voice id and an idle, walk and talk animation set; story told by events and voice, not text',
  'level-design': 'build gaps, ledges and corridors from the measured numbers in docs/metrics.json (jump height and distance, run speed, corridor widths)',
  'game-feel': 'coyote time and jump buffer of at least 80 ms, hit-stop of at least 40 ms, a short screen shake',
  'ui-kit': 'menus use the Hawkes UI kit (hawkes-ui.js createUiKit, Unity HawkesUI): pressed, hover and focus states, a ui-bus click on every press, 150-200 ms screen slides (0 ms with reduced motion), safe-area containers, 44 px targets, one ui-press per press (docs/ui-kit-skill.md if the skill is not loadable)',
} as const;
export type DesignSkill = keyof typeof DESIGN_SKILLS;

export const JOB_BRIEFS: Record<JobKind, { intro: (name: string, about: string) => string; rules: string; look: string; keep: string; prefix: string; skills: DesignSkill[] }> = {
  fix: {
    intro: (name, about) => `You are fixing a problem Hawkes Studio's automated playtest found in ${name} (${about}).`,
    rules: `- Find the root cause and fix it where it starts. Prove it: the replay place or the scenario that hit it before now
  passes, and say how in the summary.
- Never make a check pass instead of fixing the game: don't loosen a test, a timeout, a threshold, a tolerance or a
  playtest scenario, don't skip or retry a step until it passes, and don't hide the symptom (an invisible wall over a
  hole, a catch that swallows the error, a longer wait). That is a failed fix, however green it looks.
- If the real fix is bigger than one change, fix what you can properly and say what's left.`,
    look: 'Look at the screenshots to see the problem. Find the cause in the code or data; prefer the smallest correct fix.',
    keep: 'Keep to this finding. Don\'t refactor unrelated code',
    prefix: 'Fix',
    skills: ['level-design', 'game-feel'],
  },
  feature: {
    intro: (name, about) => `You are building something new in ${name} (${about}).`,
    rules: `- Build it to the full quality bar the first time: no placeholder art, grey boxes, stub content or "TODO" UI. Make
  art, sound and voice with Hawkes Gen (within the budget this brief gives), and wire them in.
- It has to feel good, not only work: in a game, the camera and controls rule below holds for anything a player moves or sees.
- Done means a player can use it end to end and a playtest shows it: add or extend a playtest scenario that plays it
  through real input.`,
    look: 'Read the story doc, the world bible and the code it touches. Plan it, then build it.',
    keep: 'Keep to this request. Don\'t refactor unrelated code',
    prefix: 'Add',
    skills: ['story-through-play', 'level-design', 'game-feel', 'ui-kit'],
  },
  content: {
    intro: (name, about) => `You are making content for ${name} (${about}): story, places, characters, dialogue or art.`,
    rules: `- Canon first: read the story doc and \`docs/world-bible.md\`; names, tone and facts match them, and what you add goes
  into the world bible.
- Dense, not sparse: every area you touch is dressed, has a landmark, life and ambient sound, and a player never goes
  more than about 10 seconds without something to see, hear or do.
- Tell it through play: events, in-game cutscenes, Hawkes Gen voice lines and sound effects. On-screen text is a last
  resort, one line at most.`,
    look: 'Read the story doc and the world bible, then the scenes and data this touches. Plan what goes where, then make it.',
    keep: 'Keep to this request. Don\'t refactor unrelated code',
    prefix: 'Content',
    skills: ['story-through-play', 'level-design', 'game-feel'],
  },
  polish: {
    intro: (name, about) => `This is ${name}'s polish pass (${about}): the items below are the worst on its polish list, by how much they bother a player.`,
    rules: `- Make each item disappear for a player, not just stop being flagged: fix it at its source (the model, the material,
  the camera rig, the placement), never by hiding the spot or loosening a check.
- Each item stands alone: if one is too big for this pass, leave it as it is and say so in the summary, and do the rest.
- For each item, say in the summary what you changed and where to see it (the scene and place, the replay spot when
  there is one), so the before and after shots are taken at the same place.`,
    look: 'Look at each item\'s screenshots and replay place to see it the way a player does. Find where it comes from.',
    keep: 'Keep to these items. Don\'t refactor unrelated code',
    prefix: 'Polish',
    skills: ['game-feel', 'ui-kit'],
  },
  'new-game': {
    intro: (name, about) => `You are making the first version of ${name} (${about}): a new game, built as a vertical slice of a planned world.`,
    rules: `- Plan before code: docs/world-bible.md first (every section, Characters included), and docs/metrics.json with the
  measured jump height and distance, run speed and corridor widths of the player character you build.
- Its first minute has a character the player meets: a want, an arc, a voice (Hawkes Gen voice id) and idle, walk and
  talk animations, shown by what happens in play, not by text.
- Feel defaults from the start: coyote time and jump buffer of at least 80 ms, hit-stop of at least 40 ms, a short shake.
- Build to the full quality bar the first time: no placeholder art, grey boxes, stub content or "TODO" UI, and one solid
  core loop beats a big broken one. A playtest scenario plays it through real input.`,
    look: 'Read the pitch, the starter and the game-quality skill. Write the world bible and metrics first, commit them, then build the slice.',
    keep: 'Keep to this game\'s first version. Don\'t refactor unrelated code',
    prefix: 'New game',
    skills: ['story-through-play', 'level-design', 'game-feel', 'ui-kit'],
  },
};

/** The brief's "Skills to load" section for a game's job: the design skills of its kind, by name (the plugin's namespace in a customer's Studio). */
export function skillsBrief(kind: JobKind, plugin = 'hawkes') {
  const skills = JOB_BRIEFS[kind].skills;
  if (!skills.length) return '';
  const extra = kind === 'new-game' ? ['game-quality'] : [];
  return `\n## Skills to load (${kind})\n\nLoad these skills (the Skill tool) before you plan or build; they are this studio's craft for ${kind} work:\n${skills.map((k) => `- \`${plugin}:${k}\`: ${DESIGN_SKILLS[k]}`).join('\n')}${extra.map((k) => `\n- \`${plugin}:${k}\`: the quality rules, the world bible template and the playtest probes`).join('')}\n`;
}

// ------------------------------------------------------------------ routing (routing.ts)

/** Earlier attempts at the same work that didn't land: the same task's other changes, or changes on the same findings. */
export function earlierAttempts(c: Pick<Change, 'id' | 'task' | 'findings'>, limit = 3): { id: string; status: string; detail: string | null; summary: string | null; created: number; phase?: string | null }[] {
  const rows = c.task
    ? db.prepare(`SELECT id, status, detail, summary, created, phase FROM changes WHERE task = ? AND id != ? AND status IN ('failed', 'closed') ORDER BY created DESC LIMIT ?`).all(c.task, c.id, limit)
    : c.findings.length
      ? db.prepare(`SELECT id, status, detail, summary, created, phase FROM changes WHERE id != ? AND request IS NULL AND status IN ('failed', 'closed') AND (${c.findings.map(() => 'findings LIKE ?').join(' OR ')}) ORDER BY created DESC LIMIT ?`).all(c.id, ...c.findings.map((f) => `%"${f}"%`), limit)
      : [];
  return rows as any[];
}

/**
 * Which attempt this is (1 = first). A task's tries count its starts and revisions (pm.ts); a fix or a request counts
 * its own revisions, walk-away fix passes, and earlier changes on the same findings that failed.
 */
export function attemptOf(c: Change): number {
  if (c.task) return Math.max(1, getTask(c.task)?.tries || 1);
  const prior = c.findings.length ? earlierAttempts(c, 10).filter((x) => x.status === 'failed' && !studioFailed(x)).length : 0;
  return 1 + (c.revisions ?? 0) + (c.auto_fixes ?? 0) + prior;
}

/**
 * The route this change's current attempt runs on (routing.ts): stored with the attempt, so its nudges, resumes and
 * answers stay on the same model, and computed again when the attempt changes. null: routing is off (tuning.ts as before).
 */
export function changeRoute(c: Change, harness?: Harness): Route | null {
  if (!routingSettings().enabled) return null;
  const attempt = attemptOf(c);
  const stored = parse(c.route ?? null) as Route | null;
  const premium = premiumFor(c.id, c.task)?.tier ?? null;
  if (stored && stored.attempt === attempt && (stored.premium ?? null) === premium) return stored;
  const findings = c.findings.map((f) => getFinding(f)).filter(Boolean) as any[];
  const worst = findings.some((f) => f.severity === 'blocker') ? 'blocker' : findings[0]?.severity ?? null;
  const role = roleOf(c);
  const text = [c.request, c.title, ...findings.map((f) => `${f.title} ${f.area ?? ''} ${f.detail ?? ''}`)].filter(Boolean).join('\n');
  const r = routeFor({ text, role, criteria: c.criteria.length, severity: worst, attempt, premium, harness });
  if (r.premium) usePremium(c.id, c.task);
  db.prepare('UPDATE changes SET route = ? WHERE id = ?').run(J(r), c.id);
  return r;
}

/** The summary with the agent's stuck report (.hawkes/stuck.md) after it, so the next attempt's brief carries it up. */
export function withStuck(worktree: string, summary: string) {
  const file = path.join(worktree, '.hawkes', 'stuck.md');
  if (!fs.existsSync(file)) return summary;
  const stuck = fs.readFileSync(file, 'utf8').trim().slice(0, 3000);
  return stuck ? `${summary}${summary ? '\n\n' : ''}Stuck after two approaches:\n${stuck}` : summary;
}

/** The brief's section on routing: earlier attempts (context carries up), and re-scoping once escalations are used. */
function attemptsBrief(c: Change, r: Route | null) {
  const attempt = r?.attempt ?? attemptOf(c);
  if (attempt < 2) return '';
  const prior = earlierAttempts(c);
  const own = c.revisions && c.summary ? `- This branch's last pass said: ${c.summary.replace(/\s+/g, ' ').slice(0, 900)}` : '';
  const lines = prior.map((x) => `- ${x.id} (${x.status}${x.detail ? `: ${x.detail.slice(0, 200)}` : ''}): ${(x.summary ?? '').replace(/\s+/g, ' ').slice(0, 900) || 'no summary'}`);
  const rescope = r?.exhausted
    ? `\nThis work has failed ${attempt - 1} times, on bigger models each time. Don't repeat those approaches: check the premise
first (is the cause where they looked? is the request feasible as written?). If it is too big for one change, do a solid
smaller part that works and say exactly what's left; if it needs a decision, ask ONE question (step 8).\n`
    : '';
  return `\n## Earlier attempts (this is attempt ${attempt})\n\n${[own, ...lines].filter(Boolean).join('\n') || '- (no summaries kept)'}\n\nLearn from them: don't redo what failed.\n${rescope}`;
}

/** The roadmap item a task's change belongs to (its memory scope). */
function taskItem(c: Change) {
  if (!c.task) return null;
  return (db.prepare('SELECT item FROM tasks WHERE id = ?').get(c.task) as { item: string } | undefined)?.item ?? null;
}

/**
 * After an agent pass: what it left in .hawkes/learned.md becomes shared-memory candidates (once per pass), and its run
 * goes into the run history with the change's outcome (updated again when it is merged or closed).
 */
export function remember(id: string) {
  const c = getChange(id);
  if (!c) return;
  try {
    const file = path.join(c.worktree, '.hawkes', 'learned.md');
    let lessons = '';
    if (fs.existsSync(file)) {
      lessons = fs.readFileSync(file, 'utf8').trim().slice(0, 4000);
      const scope = c.infra ? { product: c.product } : { product: c.product, item: taskItem(c) };
      const ids = learnFrom(lessons, { who: 'agent', id: c.id }, { ...scope, source: c.pr_url ?? c.id });
      if (ids.length) addLog(id, `memory: ${ids.length} note(s) for the next agent (${ids.join(', ')})`);
      fs.renameSync(file, `${file}.${Date.now()}`);
    }
    const prev = db.prepare('SELECT lessons FROM agent_runs WHERE id = ?').get(`ar_${c.id.slice(2)}`) as { lessons: string } | undefined;
    recordRun({
      id: `ar_${c.id.slice(2)}`, kind: c.infra ? 'infra' : c.task ? 'task' : c.request ? 'request' : 'fix', subject: c.id, product: c.product, title: c.title ?? c.id,
      outcome: c.status, summary: `${c.summary ?? ''}${c.detail ? `\n\nStatus: ${c.detail}` : ''}${c.pr_url ? `\n${c.pr_url}` : ''}`, lessons: [prev?.lessons, lessons].filter(Boolean).join('\n'),
      by: c.task ? 'PM' : 'J', model: lastPassFor(c.id)?.model || (() => { try { return loadRole(agentRole(c)).model; } catch { return null; } })(), cost: c.cost, started: c.created, finished: Date.now(),
    });
  } catch (e: any) {
    console.warn(`[memory] ${id}: ${e.message}`);
  }
}

/**
 * A brief's "Players" section: how real players do on the live site (players.ts briefLine: top drop-off, hardest level,
 * rating, each over its minimum sample), and studio_analytics to check before and after. Empty when there's no data
 * or Gen doesn't answer in a few seconds (a brief never waits on it).
 */
async function playersBrief(product: string) {
  try {
    const { snapshot, briefLine } = await import('./players.ts');
    const snap = await Promise.race([snapshot(product), new Promise<null>((ok) => setTimeout(() => ok(null), 8000).unref())]);
    const line = briefLine(snap);
    if (!line) return '';
    return `\n## Players\n\n${line} studio_analytics { product: "${product}", view: dropoff | levels | feedback | errors } has the detail with sample sizes: check it before and after your change, and quote the numbers in your summary when they bear on it.\n`;
  } catch {
    return '';
  }
}

/**
 * The task bar's player goal (taskbar.ts) at the top of an agent's brief, above what J asked for: the work is done when a
 * player sees this on beta, not when the code compiles. An infra task gets its outcome. Empty for work with no task or bar.
 */
export function barBrief(c: Pick<Change, 'task'>): string {
  const bar = c.task ? getTask(c.task)?.bar : null;
  if (!bar || (!bar.goal && !bar.outcome)) return '';
  if (bar.outcome && !bar.goal) return `## Outcome

${bar.outcome}

The work is done when this is true on beta (a result someone can see or measure), not when the code compiles.

`;
  return `## Player goal

${bar.goal}
${bar.reference ? `\nReference (a best-in-class game, and the moment to match): ${bar.reference}` : ''}${bar.axis ? `\nCritic axis (what the critics will judge this on): ${bar.axis}` : ''}${bar.phone ? `\nOn a phone (390x844, touch): ${bar.phone}` : ''}

The work is done when a player sees this on beta, not when the code compiles.

`;
}

async function writeBrief(c: Change, p: Product, findings0: any[], note?: string) {
  // Each finding with the library entities it names (finding-entities.ts), so the agent can fix art there, not in code.
  const findings: any[] = await import('./finding-entities.ts').then(({ withEntities }) => withEntities(findings0)).catch(() => findings0);
  const dir = path.join(c.worktree, '.hawkes');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  // Keep the brief out of commits.
  const exclude = path.join(PROJECTS, c.repo, '.git', 'info', 'exclude');
  if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').includes('.hawkes/')) fs.appendFileSync(exclude, '\n.hawkes/\n');
  const shots: string[] = [];
  for (const f of findings) {
    for (const [i, a] of (f.shots ?? []).slice(0, 4).entries()) {
      const file = path.join(dir, 'shots', `${f.id}-${i + 1}.jpg`);
      try {
        await gen.download(a, file);
        shots.push(path.relative(c.worktree, file).replace(/\\/g, '/'));
      } catch {
        // A missing screenshot just isn't included.
      }
    }
  }
  const thread = threadFor(c);
  const mem = briefSection({ product: p.id, item: taskItem(c), role: roleOf(c), text: [c.request, c.title, ...findings.map((f) => `${f.title} ${f.area ?? ''} ${f.detail ?? ''}`)].filter(Boolean).join(' ') });
  // A Unity product's website repo (target "site") or its source repo; each has its own beta (beta.ts).
  const site = siteRepoFor(p);
  const onSite = isSiteChange(c, p);
  const checks = onSite ? '- (static pages: open the pages you changed and the links between them, and check the HTML is well formed)'
    : (p.checks ?? []).map((k) => `- \`${k.cmd}\` (in ${k.dir === p.repo ? 'the repo root' : k.dir})`).join('\n') || '- (none listed: at least make sure it builds or loads)';
  const sub = onSite ? site!.sub : repoFor(p).sub;
  const buildCheck = onSite ? '' : `\n${buildCheckBrief(p)}`.replace(/^\n$/, '');
  const players = await playersBrief(p.id);
  // Up to 3 agents per product (J, 2026-10-19): what the others are doing, and the Unity rules (parallel.ts).
  const others = onSite ? '' : othersSection(p.name, neighboursOf(c), perProductLimit(p.id));
  const unity = !onSite && isUnity(p.id) ? `\n## Working in Unity (several agents share this repo)\n\n${UNITY_RULES}\n` : '';
  // The game quality rubric (quality.ts): every game's agents get it, whatever the task (the owner, 2026-11-08).
  const quality = onSite ? '' : rubricBrief(p, pluginName());
  // What the agent reaches beyond its project (access.ts): Gen files from the owners' own libraries, the other repos.
  const reach = await import('./access.ts').then(async (A) => {
    const a = await A.agentAccess(p.id);
    const repos = a.repos && cloudMode() && !c.infra ? (await A.siblingRepos(p.id)).map((slug) => ({ slug, dir: path.relative(c.worktree, A.extraRepoDir(c.worktree, slug)).split(path.sep).join('/') })) : [];
    return A.accessBrief(a, repos);
  }).catch(() => '');
  const startedBy = (db.prepare('SELECT started_by FROM changes WHERE id = ?').get(c.id) as any)?.started_by ?? null;
  const kind = jobKind({ ...c, started_by: startedBy }, findings);
  const job = JOB_BRIEFS[kind];
  const brief = `# ${({ fix: 'Fix', feature: 'Work', content: 'Content', polish: 'Polish pass', 'new-game': 'New game' } as const)[kind]} for ${p.name}

${job.intro(p.name, p.about)}
${sub ? `The project lives in \`${sub}/\` inside this repository.` : ''}
${onSite ? `
## This is the website repo (${site!.top})

You are working in ${p.name}'s website repository (the home page, blog, privacy page and the game page), not the
game's source (${p.repo.split('/')[0]}). Your branch was cut from the website's beta and its pull request merges into
it; the beta site https://<sub>.hawkesgen.ai/ then shows your pages with beta's game build, and going live brings them
to the live site together with the build. Never touch \`Game/v*\` (Studio's Unity builds put the game there) or push
main. If the work also needs the game itself changed, say so in the summary: that is a change in the source repo.
` : site ? `
The website (home page, blog, privacy page, the game page) is a separate repo, ${site.top}, with its own beta. This change
works in the game's source only; if the request is really about those pages, say so in the summary (a task with target
"site" works there).
` : ''}
${barBrief(c)}${c.request ? `## What J asked for

${c.request}

Work out what that means in this project (read the story doc and AGENTS.md), make it well, and keep it consistent with
the product's tone and style. If it's too big for one change, do a solid first part and say what's left in the summary.

${gpuBrief(c)}` : ''}${c.task && isVideoTask(c.task) ? videoBrief(c) : ''}${c.criteria.length && !(c.task && isVideoTask(c.task)) ? `## Acceptance criteria (how this is judged)

The change is ready once your checks pass and its pull request is open; after it is merged into beta, beta's playtest
judges these, and the work is done only when every one of them passes there:
${c.criteria.map((k, i) => `${i + 1}. ${k}`).join('\n')}
${c.criteria.some((k) => /^\s*\[phone\]/i.test(k)) ? `
Criteria starting with "[phone]" are judged on a 390x844 touch playtest (beta plays them apart from the rest), so the
scenario must play them through touch input (taps and drags, no mouse or keyboard), and the layout must work at that size.
` : ''}
Where the game implements the playtest contract (\`window.hawkesPlaytest\`: see this project's AGENTS.md, and the spec
at \`hawkesstudio/docs/playtest.md\` next to this repository), add or extend a scenario that plays to what the criteria
describe (through real input, no teleporting; named setup shortcuts are fine) and logs events or checks that show each
one, so the review can judge them from the footage and the timeline. Write that scenario's name (one line, e.g.
\`checkout\`) in \`.hawkes/scenario.txt\`: beta's playtest plays it (and this change's, when J asks for one). To play specific content
(a new stage, level or enemy), add a second line with the scenario's options as JSON, e.g. \`{"stage":"neon-pit"}\`. Without a contract, make
sure each criterion can be seen when the page is played.

` : ''}${thread.length ? `## The thread (J, Talk and agents on this work; newest last)

${thread.map((m) => `- ${m.by}${m.kind !== 'comment' ? ` (${m.kind})` : ''}, ${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')}: ${m.text}`).join('\n')}

Follow what J said there; where it differs from the request, J's latest word wins.

` : ''}${findings.length ? `## The finding${findings.length > 1 ? 's' : ''}` : ''}

${findings.map((f) => `### [${f.severity}] ${f.title}
- Area: ${f.area ?? '-'} · scenario: ${f.scenario ?? '-'} · seen ${f.seen} time(s)
- What's wrong: ${f.detail ?? '-'}
- Suggested fix: ${f.fix ?? '-'}${replayOf(f.detail) ? `
- Replay (the playtest feel sensor's place): scenario \`${replayOf(f.detail)!.scenario}\` with options \`${JSON.stringify(replayOf(f.detail)!.options)}\`. The game's
  playtest puts the player at \`spot\` (x,y,z[,yaw]) when it gets one (hawkes-playtest.js \`t.spot\`, docs/playtest.md#feel); if
  this game's scenario doesn't yet, add that named setup shortcut. Studio replays this exact place to check your fix.` : ''}
- Screenshots: ${(shots.filter((s) => s.includes(f.id)).map((s) => `\`${s}\``).join(', ')) || 'none'}${f.entities?.length ? `
- In Hawkes Gen's library: ${f.entities.map((e: any) => `\`${e.id}\` (${e.kind})`).join(', ')}. When the problem is the art itself, fix it there (the hawkesgen MCP: hawkesgen_entities to see its versions, hawkesgen_entity_make with revise and feedback, hawkesgen_entity_judge to pick): a pick is written into this repo's files by Studio.` : ''}`).join('\n\n')}

## This kind of work (${kind})

${job.rules}
${onSite || !isGame(p) ? '' : skillsBrief(kind, pluginName())}${note ? `\n## Notes on the last attempt (J's or the PM's)\n\n${note}\n` : ''}${attemptsBrief(c, changeRoute(c))}${others ? `\n${others}` : ''}${unity}${quality}${reach}${players}${mem.text ? `\n${mem.text}` : ''}
## How to work

1. Read \`AGENTS.md\` (and any docs it points to) before changing anything. Follow its rules.
2. ${job.look}
3. ${job.keep}, don't touch generated output or build folders, don't change secrets, CI, or deploy scripts.
4. Run the project's checks:
${checks}${buildCheck}
5. Commit your change with a clear message (\`${job.prefix}: ...\`). Don't push; Studio does. Studio stops a pass after
   ${Math.round(agentLimitMs(c) / 60_000)} minutes: commit as you go (after each working piece or finished batch), so a stop loses nothing.
   A third-party error from a Gen job (ElevenLabs payment_issue, a 401 or 402) is not yours to retry: test ONE line
   first for voice work, and on that error stop at once, write \`.hawkes/stuck.md\` naming the service, and end.
6. Write \`.hawkes/summary.md\`: what was wrong, what you changed (files), how you checked it, and anything J should
   look at. If you couldn't fix it, explain why there instead, and don't commit.
   Two approaches, then stop: when two different approaches haven't worked (the checks still fail, or you can't find
   the cause), don't keep iterating. Write \`.hawkes/stuck.md\` (what you tried, what happened, where you think the cause
   is) and commit nothing that doesn't work: Studio gives the next attempt a bigger model, with your notes.
7. Write \`.hawkes/try.md\`: how J tries it on the beta site, in two to five short steps a player would follow (where to
   go, what to press, what he should see).
8. If you can't go on without a decision that the request, the criteria and the thread don't settle (a real direction
   choice, not a detail you can decide well yourself), write ONE clear question to \`.hawkes/question.md\` (the options
   you see and the one you'd pick), commit nothing, and stop. Studio gets you the answer and you continue in this same
   session.
9. ${LEARNED_ASK.replace(/\n/g, '\n   ')}

## The product's story (for tone and intent)

${storyOf(p, 6000)}
`;
  // A customer's Studio: their owner by name, never "J" (owner.ts).
  fs.writeFileSync(path.join(dir, 'brief.md'), forOwner(brief));
  return path.join(dir, 'brief.md');
}

// ------------------------------------------------------------------ agent

export const AGENT_MEMORY_TOOLS = ['memory_search', 'memory_get', 'memory_write'];
/** The Studio tools on an agent's or scout's own MCP server: the shared memory, and real players' data (read-only). */
export const AGENT_STUDIO_TOOLS = [...AGENT_MEMORY_TOOLS, 'studio_analytics', 'studio_social', 'studio_social_post'];
/**
 * Agent changes get Studio's whole tool server, as Talk does (J, 2026-11-02: "Why don't they just get the full MCP setup
 * like Talk"): the same guards apply to both (guards.ts: the agents' key), and a customer's Studio's server only reaches
 * that Studio. Theirs lists studio_tell (to Talk, and so the owner) instead of studio_talk (mcp-tools.ts).
 */
export const AGENT_FULL_TOOLS = true;
/** The role an agent change runs as: content work, a build (requests, roadmap tasks, Studio and Gen), or a fix. */
export const agentRole = (c: Change): RoleName => ({ infra: 'builder', content: 'content', builder: 'builder', fixer: 'fixer' } as const)[roleOf(c)];
/**
 * An agent's MCP config: Studio's whole server, as that agent (memory writes are candidates),
 * and Hawkes Gen's with a "user" role key (generate, estimate, read jobs and the library; no fleet launches, no keys):
 * AGENT_GEN_KEY, else Talk's, else the devtools' key. Never Studio's own (owner) key.
 */
export function agentMcp(id: string) {
  const dir = sandboxShare('mcp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const genKey = process.env.AGENT_GEN_KEY ?? process.env.TALK_GEN_KEY ?? process.env.DEV_GEN_KEY ?? '';
  // On Cloud Run the agent is a job on another machine: Studio over its address with the agents' key, Gen over HTTPS (cloudjob.ts).
  const cfg = cloudMode() ? { mcpServers: cloudMcp({ STUDIO_AGENT: id, ...(AGENT_FULL_TOOLS && id.startsWith('c_') ? {} : { STUDIO_MCP_TOOLS: AGENT_STUDIO_TOOLS.join(',') }) }, genKey) } : { mcpServers: {
    hawkesstudio: { command: process.execPath, args: [path.join(ROOT, 'bin', 'studio-mcp.mjs')], env: { STUDIO_SERVER: '1', STUDIO_AGENT: id, ...(AGENT_FULL_TOOLS && id.startsWith('c_') ? {} : { STUDIO_MCP_TOOLS: AGENT_STUDIO_TOOLS.join(',') }) } },
    ...(genKey ? { hawkesgen: { command: process.execPath, args: [path.join(PROJECTS, 'hawkesgen', 'bin', 'hawkesgen-mcp.mjs')], env: { HAWKESGEN_URL: process.env.HAWKESGEN_URL ?? 'http://127.0.0.1:8790', HAWKESGEN_KEY: genKey, HAWKESGEN_LABELS: JSON.stringify({ studioChange: id }) } } } : {}),
  } };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

/** An agent pass's end: `stopped` says why it ended before finishing ('time': Studio's time limit; 'turns': its turn limit; 'cut': no result). */
type AgentResult = { ok: boolean; cost: number; result: string; sawResult: boolean; lost: boolean; stopped?: 'time' | 'turns' | 'cut'; stderr?: string; harness?: Harness; model?: string; noRoom?: string };
/**
 * How an agent pass runs: as a new process (onStart records it), or reattached to one started before a restart; harness:
 * the provider it runs on (providers.ts), else the harness in use.
 */
type AgentRun = { reattach?: { rec: DetachRec; offset: number }; onStart?: (rec: DetachRec) => void; onProgress?: (offset: number) => void; harness?: Harness; onModel?: (model: string) => void };

/**
 * How long one agent pass may run before Studio stops it (counted from its unit's start, so a restart doesn't reset it).
 * Content and GPU work waits on long Gen batches: on 2026-10-18 two such agents were stopped at the hour mid-wait with
 * their work uncommitted. STUDIO_AGENT_LIMIT_MS: tests.
 */
export function agentLimitMs(c: { infra?: boolean; request?: string | null; findings?: string[]; title?: string | null; gpu_budget?: string | null }) {
  const env = Number(process.env.STUDIO_AGENT_LIMIT_MS);
  if (env > 0) return env;
  return passLimitMs(roleOf(c) === 'content');
}
/**
 * How long a session may stay open after its final result before Studio ends it: on 2026-10-18 an agent's own
 * background wait loop kept `claude -p` alive 70 minutes after it had finished, holding its product's slot.
 * STUDIO_AGENT_GRACE_MS: tests.
 */
export const graceMs = () => Number(process.env.STUDIO_AGENT_GRACE_MS) > 0 ? Number(process.env.STUDIO_AGENT_GRACE_MS) : 60_000;

/**
 * The watchdog's call on an agent that has been quiet (no new output) for `quietMs`: why it's stuck (a line for the
 * log), or null to leave it. Stuck only when quiet for the whole idle time, its processes used next to no CPU over it
 * (under 2% of one CPU), none is running or waiting on disk, and it isn't waiting on a Gen (GPU) job.
 */
export function stuckWhy({ quietMs, idleMs, cpuMs, overMs, procs, genBusy }: { quietMs: number; idleMs: number; cpuMs: number; overMs: number; procs: { state: string; comm: string }[]; genBusy: boolean }): string | null {
  if (!(idleMs > 0) || quietMs < idleMs || overMs < idleMs * 0.75 || genBusy) return null;
  if (cpuMs > overMs * 0.02) return null;
  if (procs.some((p) => p.state === 'R' || p.state === 'D')) return null;
  const left = [...new Set(procs.map((p) => p.comm))].filter((n) => !['node', 'claude', 'agent', 'sudo'].includes(n));
  return `no new output for ${Math.round(quietMs / 60_000)} minutes and its processes only waiting${left.length ? ` (${left.slice(0, 6).join(', ')})` : ''}`;
}

/** A session that ended with its work uncommitted is resumed this many times to commit it (agents.ts nudge). */
export const NUDGES = 2;

/**
 * One agent pass, shown as a live run (runs.ts) while it goes: its provider, the model it asked for, and the model the
 * harness reported, which also goes into the change's provider history once per pass.
 */
function runAgent(c: Change, briefFile: string, s: AgentSettings, env = claudeEnv(), resume?: { session?: string; prompt: string }, how: AgentRun = {}): Promise<AgentResult> {
  const harness = how.harness ?? brainId();
  const runId = `agent:${c.id}`;
  const end = runStarted({ id: runId, kind: 'agent', harness, model: how.reattach ? currentBrain(c.id)?.model ?? null : null, change: c.id, product: c.product, title: c.title });
  const onModel = (model: string) => {
    runReported(runId, model);
    const now = currentBrain(c.id);
    if (!now || !now.reported || now.model !== model || now.harness !== harness) noteBrain(c.id, { kind: 'model', harness, model, why: null });
    how.onModel?.(model);
  };
  return runAgentInner(c, briefFile, s, env, resume, { ...how, onModel }).finally(end);
}
/** What a fresh session reads first when the last pass was cut off mid-way (writeHandoff). */
const HANDOFF = path.join('.hawkes', 'handoff.md');
/**
 * The prompt a pass's session starts with: `base` (the brief, or what a resumed session is told), the handoff note when
 * a new session takes over a cut-off pass (writeHandoff), and what else is in flight on the product as it starts
 * (inflight.ts: other changes and their files, tasks, builds and runs, from Studio's own tables). Every pass gets it:
 * first, resumed, answer, conflict and nudge passes, products and Studio/Gen.
 */
export function passPrompt(c: Pick<Change, 'id' | 'product' | 'worktree' | 'infra'>, base: string, resumedSession = false) {
  const handoff = !resumedSession && fs.existsSync(path.join(c.worktree, HANDOFF))
    ? `${base}\n\nFirst read ${HANDOFF}: it says what the last pass was doing when it was cut off and what it had done. Carry on from there; don't redo finished work.`
    : base;
  const name = (() => { try { return c.infra ? getInfra(c.product).name : getProduct(c.product).name; } catch { return c.product; } })();
  const others = inFlightPrompt(c, name);
  return others ? `${handoff}\n\n${others}` : handoff;
}
function runAgentInner(c: Change, briefFile: string, s: AgentSettings, env = claudeEnv(), resume?: { session?: string; prompt: string }, how: AgentRun = {}): Promise<AgentResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof launch>['child'];
    let started = Date.now();
    // Reattached: its output is read again from the start (for the result), but lines logged before the restart aren't logged twice.
    let quietUntil = 0;
    if (how.reattach) {
      child = new DetachedChild(how.reattach.rec, { reattached: true });
      quietUntil = how.reattach.offset;
      started = how.reattach.rec.started;
    } else {
      const base = resume?.prompt ?? `Read ${path.relative(c.worktree, briefFile).replace(/\\/g, '/')} and do what it says. It's your whole task.`;
      // A new session after a pass was cut off (another provider took over, or the same one after a hold): it reads where
      // the last one got to before anything else (writeHandoff), so it carries on instead of starting over.
      const prompt = passPrompt(c, base, Boolean(resume?.session));
      // The role (.claude/agents/<role>.md): its model, standing instructions (the stable, cached part of the prompt),
      // tools and turn limit; the task itself is the brief.
      // The route (routing.ts): the category's tier, one up per failed attempt, Opus within the day's budget, Fable only on J's ask.
      const harness = how.harness ?? brainId();
      const route = changeRoute(c, harness);
      const { args: roleFlags, role } = roleArgs(agentRole(c), {
        harness,
        extraAllowed: [...(AGENT_FULL_TOOLS ? ['mcp__hawkesstudio'] : AGENT_STUDIO_TOOLS.map((t) => `mcp__hawkesstudio__${t}`)), 'mcp__hawkesgen'],
        maxTurns: s.maxTurns !== DEFAULTS.maxTurns ? s.maxTurns : undefined,
        retry: (c.task ? getTask(c.task)?.tries : 0) || 1,
        ...(route ? { tier: route.tier, effort: route.effort } : {}),
      });
      if (route) addLog(c.id, `route: ${routeLine(route, role.model)}`);
      // The change's provider history: a start, or a switch with why (what the change's page shows).
      const prev = lastHarness(c.id);
      noteBrain(c.id, { kind: prev && prev !== harness ? 'switch' : 'start', harness, model: role.model || null, why: whyHarness(prev, harness, agentRole(c)) });
      runAsked(`agent:${c.id}`, role.model || null);
      const args = [
        ...(resume?.session ? ['--resume', resume.session] : []),
        '-p', prompt, '--output-format', 'stream-json', '--verbose', ...roleFlags,
        '--permission-mode', 'acceptEdits',
        // Its own Studio MCP server (Talk's tools, as this change: X-Studio-Agent), and Gen's.
        '--mcp-config', agentMcp(c.id), '--strict-mcp-config',
      ];
      addLog(c.id, `role ${role.name} (${role.model})${harness !== 'claude' || brainId() !== 'claude' ? ` on ${brainLabel(harness)}` : ''}`);
      // Outside Studio where it can be (detach.ts): a deploy restarting Studio doesn't stop it. Same user, same environment.
      const l = launch(`agent-${c.id}`, claudeCommand(args, { cwd: c.worktree, env, brain: harness }));
      child = l.child;
      if (l.rec) {
        addLog(c.id, `agent runs as ${l.rec.mode === 'systemd' ? 'the unit' : l.rec.mode === 'cloudrun' ? 'the Cloud Run job' : 'the process'} ${l.rec.unit} (it survives a Studio restart)`);
        how.onStart?.(l.rec);
      }
    }
    let buf = '';
    const out: AgentResult = { ok: false, cost: 0, result: '', sawResult: false, lost: false, stderr: '' };
    let saved = 0;
    const limit = agentLimitMs(c);
    let timedOut = false;
    // Ending it on Studio's own call (done but still open, or stuck): kill() stops the whole unit (detached-run.mjs).
    let ending = false;
    const end = (line: string) => {
      if (ending) return;
      ending = true;
      addLog(c.id, `agent: ${line}`);
      child.kill('SIGTERM');
    };
    let grace: NodeJS.Timeout | undefined;
    // The watchdog: quiet since `lastOut`; CPU counted from the first look after it went quiet.
    let lastOut = Date.now();
    let usedGen = false;
    let base: { at: number; cpuUsec: number } | null = null;
    const idleMs = (s.idleMinutes ?? DEFAULTS.idleMinutes) * 60_000;
    const watch = setInterval(async () => {
      const rec = child instanceof DetachedChild ? child.rec : null;
      if (ending || !rec || !(idleMs > 0)) return;
      if (Date.now() - lastOut < Math.min(idleMs / 4, 60_000)) return void (base = null);
      const now = detachedActivity(rec);
      if (!now) return;
      if (!base) return void (base = { at: Date.now(), cpuUsec: now.cpuUsec });
      const quietMs = Date.now() - lastOut;
      if (quietMs < idleMs) return;
      // A Gen job it may be waiting on (a GPU batch) keeps it: anything queued or running (or Gen not answering) counts.
      let genBusy = false;
      if (usedGen) genBusy = await gen.jobs({ status: 'queued,running', limit: 20 }).then((j: any[]) => j.length > 0, () => true);
      const why = stuckWhy({ quietMs, idleMs, cpuMs: (now.cpuUsec - base.cpuUsec) / 1000, overMs: Date.now() - base.at, procs: now.procs, genBusy });
      if (!why || ending || Date.now() - lastOut < quietMs) return;
      end(`${why}: Studio ended it (the session and its background processes) and carries on with the change`);
      const { tellAbout } = await import('./followup.ts');
      const cur = getChange(c.id);
      if (cur) await tellAbout(cur, `Agent ended: ${cur.title ?? c.id}`, `Agent change ${c.id} (${cur.title}) was stuck: ${why}. Studio ended its session and carries on with the change.`).catch((e) => console.warn(`[studio] stuck notice ${c.id}: ${e.message ?? e}`));
    }, Math.max(1000, Math.min(60_000, idleMs / 8)));
    watch.unref();
    const timer = setTimeout(() => {
      timedOut = true;
      addLog(c.id, `agent: stopped at its ${limit >= 60_000 ? `${Math.round(limit / 60_000)}-minute` : `${Math.round(limit / 1000)}-second`} limit for one pass`);
      child.kill('SIGTERM');
    }, Math.max(5_000, limit - (Date.now() - started)));
    child.stdout!.on('data', (d) => {
      buf += d;
      lastOut = Date.now();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const quiet = child instanceof DetachedChild && child.offset <= quietUntil;
        try {
          const m = JSON.parse(line);
          // Its session id, so a question can be answered in the same session (claude --resume).
          if (m.type === 'system' && m.session_id && getChange(c.id)?.session !== m.session_id) update(c.id, { session: m.session_id });
          // The model the harness itself says it runs (Claude Code's init, the adapters' in bin/): what Studio shows.
          if (m.type === 'system' && m.subtype === 'init') {
            const rm = reportedModel(m.model);
            if (rm && rm !== out.model) { out.model = rm; how.onModel?.(rm); }
          }
          if (m.type === 'assistant' && !quiet) {
            for (const part of m.message?.content ?? []) {
              if (part.type === 'text' && part.text.trim()) addLog(c.id, `agent: ${part.text.trim().slice(0, 300)}`);
              if (part.type === 'tool_use') addLog(c.id, `tool: ${part.name} ${JSON.stringify(part.input).slice(0, 160)}`);
            }
          }
          if (m.type === 'assistant' && (m.message?.content ?? []).some((p: any) => p.type === 'tool_use' && String(p.name).startsWith('mcp__hawkesgen'))) usedGen = true;
          if (m.type === 'result') {
            out.cost = Number(m.total_cost_usd) || 0;
            out.result = String(m.result ?? '');
            out.ok = !m.is_error;
            out.sawResult = true;
            if (m.subtype === 'error_max_turns') out.stopped = 'turns';
            // Done: a session still open after the grace (its background shells keep it alive) is ended.
            grace ??= setTimeout(() => end(`finished, but its session was still open ${Math.round(graceMs() / 1000)} s after its final result (background processes keep it alive); ended it and its background processes, carrying on with the change`), graceMs());
          }
        } catch {
          // Not JSON.
        }
      }
      // How far the output was logged, every few seconds (lines after it may be logged again after a restart).
      if (child instanceof DetachedChild && how.onProgress && Date.now() - saved > 3000) {
        saved = Date.now();
        how.onProgress(child.offset);
      }
    });
    child.stderr!.on('data', (d) => {
      // Kept for passStop: a harness that refuses to run may say why only here.
      out.stderr = `${out.stderr ?? ''}${d}`.slice(-8000);
      addLog(c.id, `stderr: ${String(d).slice(0, 300)}`);
    });
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(watch);
      out.lost = child instanceof DetachedChild && child.lost && !out.sawResult;
      if (timedOut) out.stopped = 'time';
      else if (!out.sawResult && !out.lost) out.stopped ??= 'cut';
      resolve(out);
    });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(watch);
      const h = how.harness ?? brainId();
      addLog(c.id, `couldn't start ${h === 'claude' ? 'Claude Code' : brainLabel(h)}: ${e.message}`);
      resolve({ ok: false, cost: 0, result: e.message, sawResult: false, lost: false, stderr: out.stderr });
    });
  });
}

/**
 * The agent's pass in a change's "agent" step: reattached to its process when one was recorded (Studio restarted while
 * it ran), else started (and recorded). A process that vanished without a result (the server rebooted) runs again.
 */
async function agentPass(id: string, ph: Phase, save: (patch: Partial<Phase>) => void, s: AgentSettings, env: NodeJS.ProcessEnv, resume?: { session?: string; prompt: string }) {
  const t0 = Date.now();
  let r = await agentPassRaw(id, ph, save, s, env, resume);
  // The session it was told to resume is gone (its folder never reached the job): a new session told the same, once,
  // instead of failing the change with its uncommitted work (sessiongone.ts).
  if (resume?.session && !r.ok && (sessionGone(r.stderr) || sessionGone(r.result))) {
    addLog(id, `agent: its session ${resume.session.slice(0, 8)}… couldn't be found; starting a new session with the same brief`);
    update(id, { session: null });
    save({ proc: undefined });
    r = await agentPassRaw(id, ph, save, s, env, { prompt: freshSessionPrompt(resume.prompt) });
  }
  try {
    const c = getChange(id)!;
    const role = agentRole(c);
    const harness = r.harness ?? ((isHarness(ph.brain) ? ph.brain : brainId()) as Harness);
    const retry = (c.task ? getTask(c.task)?.tries : 0) || 1;
    const route = changeRoute(c, harness);
    const t = roleTune(role, { harness, retry, ...(route ? { tier: route.tier, effort: route.effort } : {}) });
    const text = `${r.result ?? ''}\n${r.stderr ?? ''}`;
    const stuck = fs.existsSync(path.join(c.worktree, '.hawkes', 'stuck.md'));
    const outcome: PassOutcome = refusedModelOf(text) && !(r.ok && r.sawResult) ? 'model-refused'
      : passStop(r) ? 'harness-stop'
      : stuck ? 'stuck'
      : r.stopped ?? (r.ok && r.sawResult ? 'done' : 'failed');
    recordPass({ change: id, product: c.product, task: c.task, role, harness, model: t.model, reported: r.model ?? null, tier: t.tier, effort: t.effort, retry, ms: Date.now() - t0, cost: r.cost, outcome, category: route?.category ?? null, premium: route?.premium ?? null });
    // Finished: the handoff note did its job (a later cut-off writes a new one).
    if (outcome === 'done') fs.rmSync(path.join(c.worktree, HANDOFF), { force: true });
    // The files it touched so far, for the other passes' in-flight section and the overlap test (inflight.ts).
    await recordTouched(c);
  } catch { /* the ledger never stops a pass */ }
  return r;
}
/** The last "[studio] ..." line a job's stderr has (why Studio gave up on it), without the prefix. */
/**
 * The job went because Cloud Run never started it for want of room (cloudjob.ts dropJob: the region's CPU quota is held),
 * as that line says it, or null. Starting another job at once only adds an execution to the same full place (2026-11-11
 * 05:06: about 7 passes and a Talk job each started again and again, 12 executions open and none running in us-east4).
 */
export function noRoomOf(stderr: string | undefined | null): string | null {
  const line = lastStudioLine(stderr);
  return line && /never started .*no room/i.test(line) ? line : null;
}

/** Times in a row a change's agent job may find no room before the attempt ends with that cause and is planned again. */
export const JOB_ROOM_TRIES = 3;
/** How long a change waits in the queue after its job found no room: 15 min, doubling, at most 2 hours. */
export const jobRoomWaitMs = (n: number) => Math.min(2 * 3600_000, 15 * 60_000 * 2 ** Math.max(0, n - 1));

/**
 * The change's agent job never started (Cloud Run had no room): the pass doesn't start another job in the same place
 * on the spot. It goes back to the queue through the one way a pass ends (endPass), holding no slot, no worktree and
 * no execution (dropJob cancelled it), and starts again only through the queue: so within maxConcurrent (0 means none
 * start), through the CPU gate (cpuroom.ts) and to the jobs' own place when there is one (jobsproject.ts). After
 * JOB_ROOM_TRIES in a row it ends failed with that cause, a failure on Studio's side the PM plans again (pm.ts
 * afterFailed: not a try, Studio's backoff, a fix for Studio itself after a few).
 */
async function waitForJobRoom(id: string, ph: Phase, why: string) {
  const n = (ph.noRoom?.n ?? 0) + 1;
  const where = await import('./jobsproject.ts').then((J) => { const p = J.startPlace(); return `${p.region}${p.project ? ` (${p.project})` : ''}`; }).catch(() => 'its region');
  const cause = why.replace(/^\[studio\]\s*/, '').slice(0, 160);
  const next: Phase = { ...ph, step: 'agent', proc: undefined, noRoom: { n, at: Date.now() } };
  if (n > JOB_ROOM_TRIES) {
    return endPass(id, {
      detail: `failed: Cloud Run had no room for its agent job in ${where} ${n - 1} times in a row (${cause}); planned again with that cause`,
      phase: { ...next, failed: true, noRoom: undefined },
      log: `agent: its job found no room in ${where} ${n - 1} times in a row: the attempt ends with that cause (Studio's side, not a try)`,
    });
  }
  const at = Date.now() + jobRoomWaitMs(n);
  return endPass(id, {
    detail: `queued: Cloud Run had no room for its agent job in ${where} (${cause}); it starts again through the queue after ${new Date(at).toISOString().slice(11, 16)} UTC (${n} of ${JOB_ROOM_TRIES})`,
    phase: next,
    retryAt: at,
    log: `agent: its job never started (no room in ${where}): back in the queue holding no slot, no new job until ${new Date(at).toISOString().slice(11, 16)} UTC (${n} of ${JOB_ROOM_TRIES})`,
  });
}

function lastStudioLine(stderr: string | undefined | null) {
  const l = String(stderr ?? '').split('\n').map((x) => x.trim()).filter((x) => x.startsWith('[studio] ')).pop();
  return l ? l.slice(9, 200) : null;
}
async function agentPassRaw(id: string, ph: Phase, save: (patch: Partial<Phase>) => void, s: AgentSettings, env: NodeJS.ProcessEnv, resume?: { session?: string; prompt: string }) {
  const brief = path.join(getChange(id)!.worktree, '.hawkes', 'brief.md');
  // A conflict pass tells the job which branch to bring in with its token (cloudjob-run.ts premerge): the job's clone has no
  // credentials of its own for the agent's `git merge`.
  const mergeBaseFile = path.join(getChange(id)!.worktree, MERGE_BASE_FILE);
  if (ph.conflict) { fs.mkdirSync(path.dirname(mergeBaseFile), { recursive: true }); fs.writeFileSync(mergeBaseFile, `${getChange(id)!.base}\n`); }
  else fs.rmSync(mergeBaseFile, { force: true });
  // The provider for this pass (providers.ts): a running process stays where it is; a session stays on the harness that
  // holds it while that one answers; otherwise the least busy provider that answers (or the harness in use).
  const spread = providerSettings().mode === 'spread';
  let harness: Harness = ph.proc && spread ? brainOf(ph) : pickHarness({ role: agentRole(getChange(id)!), prefer: ph.proc || resume?.session ? brainOf(ph) : null });
  // A session another harness made can't be resumed here: a new session told the same (forHarness).
  if (resume?.session && harness !== brainOf(ph)) resume = { prompt: `Read .hawkes/brief.md: it's your whole task. Your earlier session ran on another AI harness, so this one starts fresh: your work so far is in the worktree (\`git status\`, \`git log\`). ${resume.prompt}` };
  const fresh = (): AgentRun => ({
    onStart: (rec) => save({ proc: { rec, offset: 0 }, brain: harness }),
    onProgress: (offset) => save({ proc: { ...ph.proc!, offset } }),
    harness,
  });
  const release = using(harness);
  try {
    return await offMachine(id, async () => {
    if (ph.proc && brainOf(ph) !== harness) {
      addLog(id, `agent: stopping the ${brainOf(ph)} session; the brain is ${brainLabel(harness)} now, so this pass starts again`);
      writeHandoff(id, brainOf(ph), `Studio moved the change to ${brainLabel(harness)}`);
      stopDetached(ph.proc.rec);
      ph.proc = undefined;
      save({ proc: undefined, brain: harness });
    }
    if (ph.proc) {
      addLog(id, `agent: reattached to ${ph.proc.rec.unit} after a Studio restart`);
      const r = await runAgent(getChange(id)!, brief, s, env, resume, { ...fresh(), reattach: ph.proc });
      if (!r.lost) return { ...r, harness };
      save({ proc: undefined });
      // Cloud Run had no room to start it: another job now would wait in the same full place (waitForJobRoom).
      const full = noRoomOf(r.stderr);
      if (full) return { ...r, harness, noRoom: full };
      addLog(id, `agent: ${ph.proc.rec.unit} is gone with no result (${lastStudioLine(r.stderr) ?? 'the server restarted?'}); starting the pass again`);
    }
    if (harness !== brainOf(ph)) save({ brain: harness });
    const first = await runAgent(getChange(id)!, brief, s, env, resume, fresh());
    if (!first.lost) return { ...first, harness };
    const full = noRoomOf(first.stderr);
    if (full) { save({ proc: undefined }); return { ...first, harness, noRoom: full }; }
    // Its job went with no result (Cloud Run never started it, or it went silent: cloudjob.ts dropJob): once more with a
    // new job, not counted as a try.
    addLog(id, `agent: its job went with no result (${lastStudioLine(first.stderr) ?? 'it never answered'}); starting the pass again`);
    save({ proc: undefined });
    const second = await runAgent(getChange(id)!, brief, s, env, resume, fresh());
    if (!second.lost) return { ...second, harness };
    // Lost again: Studio's side (Cloud Run, the region), never the agent's. Before 2026-11-11 this result went on as a
    // pass that "made no commit" and was counted as a try. A full region waits for room (noRoom); anything else is a
    // machinery failure (machineryFailure reads the line), retried by itself and not a try.
    save({ proc: undefined });
    const fullAgain = noRoomOf(second.stderr);
    if (fullAgain) return { ...second, harness, noRoom: fullAgain };
    return { ...second, harness, stderr: `${second.stderr ?? ''}\n[studio] the agent's Cloud Run job is gone twice with no result (${lastStudioLine(second.stderr) ?? 'it never answered'})` };
    });
  } finally {
    release();
  }
}

// ------------------------------------------------------------------ flow

const running = new Set<string>();
/** Changes whose work has started in this process (pump, launchResume): what memRoom weighs memory against. */
let inFlight = 0;

/**
 * Each change's pass generation. The stuck-work watchdog (checkStuck) gives up on a pass that hangs (a build that never
 * started, a wait nobody will end) by moving its change to the next generation: the old pass can't write any more
 * (update() throws PassAbandoned in its async context) and the change is carried on by a new pass.
 */
const gens = new Map<string, number>();
const passGen = (id: string) => gens.get(id) ?? 0;
const passCtx = new AsyncLocalStorage<{ id: string; gen: number }>();
export class PassAbandoned extends Error {
  constructor(id: string) { super(`${id}: this pass was given up on as stuck; a new one carries the change on`); }
}
/** The release of each change's pass in this process (abandonPass frees it). */
const flightOf = new Map<string, () => void>();
/**
 * Takes a change for a pass in this process: it is `running` (and, with flight, counted in inFlight for memRoom). The
 * returned release is safe to call more than once, and once the watchdog moved the change on it leaves the new pass alone.
 */
function claim(id: string, o: { flight?: boolean } = {}) {
  running.add(id);
  const gen = passGen(id);
  if (o.flight) takeFlight(id);
  let done = false;
  const land = () => {
    if (done) return;
    done = true;
    if (o.flight) dropFlight(id);
    if (passGen(id) === gen) running.delete(id);
    if (flightOf.get(id) === land) flightOf.delete(id);
    // The slot it held is free: the queue looks again now, whoever started this pass (the pump, an answer, a conflict
    // pass, a resume), and Studio at rest is measured again once nothing is at work.
    queueIdle();
    void pump();
  };
  flightOf.set(id, land);
  return land;
}
/** The changes counted in inFlight: a pass holding memory on this machine now. */
const flying = new Set<string>();
function takeFlight(id: string) { if (!flying.has(id)) { flying.add(id); inFlight++; } }
function dropFlight(id: string) { if (flying.delete(id)) { inFlight--; memFreed(); void pump(); } }

/**
 * With no change at work in this process and no checkout under way, what the working files hold is Studio at rest: the
 * disk budget is that plus a share of the room above it (disksweep.ts diskBudget), so idle Studio never uses up the
 * room meant for its changes. Measured at start-up (startQueue) and each time the last pass lands.
 */
function queueIdle() {
  if (running.size || checkoutsActive) return;
  try { noteDiskBaseline(); void import('./diskreclaim.ts').then((r) => r.noteReclaimableBaseline()).catch(() => {}); void import('./disksweep.ts').then((d) => d.logBaselineMakeup()).catch(() => {}); } catch { /* no disk to read here */ }
}

/**
 * Runs a pass's agent step. On Cloud Run the agent is a job on another machine (detach.ts 'cloudrun'): while it works,
 * the pass holds no memory here, so it isn't counted against memRoom, and other changes can start beside it. On
 * 2026-11-10 every new start waited behind passes whose agents ran elsewhere for an hour: memory was low at rest (the
 * in-memory disk and Studio itself), and memRoom lets a start go only when nothing is in flight. The count comes back
 * when the agent step ends and the pass carries on here (its publish and checks use this machine).
 */
async function offMachine<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (detachMode() !== 'cloudrun' || !flying.has(id)) return fn();
  const gen = passGen(id);
  dropFlight(id);
  try {
    return await fn();
  } finally {
    if (passGen(id) === gen && running.has(id)) takeFlight(id);
  }
}

/** Gives up on a change's pass in this process (checkStuck): its slot and memory count are freed and it can write no more. */
function abandonPass(id: string) {
  gens.set(id, passGen(id) + 1);
  const land = flightOf.get(id);
  flightOf.delete(id);
  land?.();
  running.delete(id);
}

export function costToday() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM changes WHERE created >= ?').get(since.getTime()) as any;
  return { count: r.n as number, cost: r.cost as number };
}

/** Starts an agent on something J asked for (a feature, a change, a tweak): a branch, a pull request, a preview. */
export function startTask(productId: string, request: string, { criteria = [], task = null, title, gpuBudget = null, target: repoTarget = null }: { criteria?: string[]; task?: string | null; title?: string; gpuBudget?: number | null; target?: string | null } = {}) {
  const s = agentSettings();
  if (!s.enabled) throw new Error('Agent workers are turned off (settings).');
  // Studio and Gen themselves: a pull request into main (they have no beta lane).
  const inf = isInfra(productId) ? getInfra(productId) : null;
  const p = inf ? null : getProduct(productId);
  const target = inf ?? p!;
  // Handed over to another Studio: its agents work on it there (config.ts managedBy).
  if (p && managedElsewhere(p)) throw new StudioError(managedNote(p), 409);
  if (!request.trim()) throw new Error('Say what to do');
  // One attempt per roadmap task at a time, whichever path asks (the PM's starts and reruns, a revision).
  const other = task ? liveChangeOfTask(task) : null;
  if (other) throw new StudioError(`task ${task} already has change ${other.id} (${other.status}): no second one beside it`, 409);
  // J (2026-10-17): queue, don't refuse. One change runs per product; this one waits for it (pump starts it after).
  const ahead = aheadOf(target.id);
  if (inf && repoTarget) throw new StudioError(`${inf.name} has no website repo (leave target empty)`);
  // target "site": a Unity product's website repo (its own beta, merged into it like the source repo's).
  const { top, slug } = inf ? { top: inf.repo, slug: inf.slug } : repoForTarget(p!, repoTarget);
  const id = newId('c');
  const words = request.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, request, notes, log, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, target.id, '[]', 'queued', `${task ? 'queued by the PM (a roadmap task)' : 'queued (J asked)'}${ahead}`, top, slug, `task/${id.slice(2)}-${words}`, inf ? 'main' : BETA, path.join(WORK(), id), (title ?? request.split(String.fromCharCode(10))[0]).slice(0, 120), request, '[]', '[]', Date.now());
  db.prepare('UPDATE changes SET task = ?, criteria = ?, gpu_budget = ? WHERE id = ?').run(task, J(criteria), gpuBudget === null || !(gpuBudget >= 0) ? null : String(gpuBudget), id);
  noteTimeline(id, 'queued', null);
  void pump();
  return id;
}

/** Starts a fix for one or more findings of a product. Returns the change id; the work continues in the background. */
export function startFix(productId: string, findingIds: string[], { auto = false, by = 'the daily run' }: { auto?: boolean; by?: string } = {}) {
  const s = agentSettings();
  if (!s.enabled) throw new Error('Agent workers are turned off (settings).');
  if (isInfra(productId)) throw new Error(`${getInfra(productId).name} has no playtest findings: ask for the change with studio_task.`);
  const p = getProduct(productId);
  if (managedElsewhere(p)) throw new StudioError(managedNote(p), 409);
  const findings = findingIds.map((id) => getFinding(id)).filter(Boolean) as any[];
  if (!findings.length) throw new Error('No such findings');
  // Won't fix is the owner's answer: no one queues it (open it again first if the answer changed).
  const dropped = findings.filter((f) => f.status === 'wontfix');
  if (dropped.length) throw new StudioError(`${dropped.map((f) => f.id).join(', ')} ${dropped.length > 1 ? 'are' : 'is'} marked won't fix: no agent fixes ${dropped.length > 1 ? 'them' : 'it'}. Open ${dropped.length > 1 ? 'them' : 'it'} again first if that has changed.`, 409);
  const ahead = aheadOf(p.id);
  const today = costToday();
  if (auto && (today.count >= s.maxPerDay || today.cost >= s.maxCostPerDay)) {
    throw new Error(`Today's agent budget is used (${today.count} fixes, $${today.cost.toFixed(2)}).`);
  }
  const { top, slug } = repoFor(p);
  const id = newId('c');
  const branch = `fix/${id.slice(2)}-${findings[0].title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '')}`;
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, J(findings.map((f) => f.id)), 'queued', `${auto ? `queued by ${by}` : 'queued'}${ahead}`, top, slug, branch, BETA, path.join(WORK(), id), `Fix: ${findings[0].title}`.slice(0, 120), '[]', '[]', Date.now());
  noteTimeline(id, 'queued', null);
  if (auto) db.prepare('UPDATE changes SET started_by = ? WHERE id = ?').run(by, id);
  // J (2026-10-17): a finding is consumed as soon as an agent takes it: fixed now, assumed done by the change. A review
  // reporting it again doesn't reopen it while this change is unmerged (backlog.ts absorb); closing the change does.
  for (const f of findings) updateFinding(f.id, { status: 'fixed', note: `agent change ${id}` });
  void pump();
  return id;
}

/** A change on its way (not ended): one per roadmap task at a time. */
const TASK_LIVE = ['queued', 'working', 'verifying', 'revising', 'ready', 'needs answer', WAITING_GEN];
/**
 * The task's change that is on its way, other than `except`, or null. On 2026-11-10 one task ("Layered island sound")
 * got 42 changes in two minutes, and several of the failed ones were later revised back to life beside each other: four
 * merged into beta for the same task. A task has one change on its way, so starting or reviving a second is refused.
 */
export function liveChangeOfTask(task: string, except?: string): { id: string; status: string } | null {
  const rows = db.prepare(`SELECT id, status FROM changes WHERE task = ? AND status IN (${TASK_LIVE.map(() => '?').join(',')}) ORDER BY created DESC`).all(task, ...TASK_LIVE) as { id: string; status: string }[];
  return rows.find((r) => r.id !== except) ?? null;
}

/** The statuses of a change that holds one of its product's running slots. */
const ACTIVE = 'working,verifying,revising';
/**
 * " behind c_..." when the product's slots are taken by changes running or waiting ahead of a new one; else "". A queued
 * change that is held (parked, waiting for disk room, or not due before a later time) is not ahead of anything: the
 * pump passes it by, so naming it would say a change waits behind one that holds nothing (2026-11-11: c_00b65fd57cf2
 * read "behind c_1f94a6c6dcd4", a change that only waited for disk room).
 */
function aheadOf(product: string) {
  const busy = [...listChanges({ status: ACTIVE, product }), ...listChanges({ status: 'queued', product }).filter((c) => !heldInQueue(c))];
  return busy.length >= perProductLimit(product) ? ` behind ${busy[0].id}` : '';
}
/** A change that failed and was left waiting for memory: it goes behind others while memory is low. */
export const memoryStarved = (c: Pick<Change, 'id' | 'log'>) => failStreak(c) > 0 && /waiting for memory|waits for memory/.test((c.log ?? []).slice(-6).join('\n'));
/** A queued change the pump passes by for now (and so ahead of nothing): parked, waiting for disk room, or not due yet. */
function heldInQueue(c: Change) {
  if (parkedOut(c) || waitsForDisk(c.id)) return true;
  const ph = phaseOf(c.id);
  return Boolean(ph?.notBefore && !ph.failed && ph.notBefore > Date.now());
}

/**
 * Studio's own work (J, 2026-11-11: a fix to Studio's stuck queue waited in that same queue behind product work):
 * changes to Hawkes Studio itself, as a product of the beta lane (hawkes-studio) or as an infra target (Studio, Gen).
 * They run in a lane of their own (OWN_LANE_SLOTS), never counted against the products' maxConcurrent and picked first,
 * so a queue full of product work can never hold up the fix that unblocks it.
 */
export const studioOwn = (product: string) => isStudioProject(product) || isInfra(product);
/** Agent slots of Studio's own lane, beside maxConcurrent (STUDIO_OWN_LANE_SLOTS; 1). */
export const OWN_LANE_SLOTS = () => Math.max(1, Math.floor(Number(process.env.STUDIO_OWN_LANE_SLOTS) || 1));

/** A queued change's detail with its " behind c_..." brought up to date: the first of `ahead` when they fill its product's slots, else none. */
export function behindDetail(detail: string, ahead: string[], limit: number) {
  const m = detail.match(/ behind c_\w+/);
  if (!m) return detail;
  return detail.replace(m[0], ahead.length >= limit ? ` behind ${ahead[0]}` : '');
}

/** What a queued change that waits only for its turn says. */
export const SLOT_WAIT = 'queued: waits for a free agent slot';
/**
 * Details a pass may rewrite: a wait that ended (disk room, memory: the pass only sees changes no longer held for disk
 * room, and the memory wait is set again on the picks it still applies to), the slot wait itself and a bare "queued".
 * 2026-11-11 hawkes-studio changes read "waits for disk room ... 0.06 GB of memory free" for hours after a restart had
 * ended that wait, while they only waited for one of the 6 agent slots.
 */
const ENDED_WAIT = /^queued(: waits for (disk room|memory to free up|a free agent slot)\b.*)?$/s;

/** A queued change's detail brought up to date: a wait that ended says what it waits for now; else behindDetail. */
export function queuedDetail(detail: string, ahead: string[], limit: number) {
  if (!ENDED_WAIT.test(detail)) return behindDetail(detail, ahead, limit);
  return ahead.length >= limit ? `queued behind ${ahead[0]}` : SLOT_WAIT;
}

/**
 * Which queued changes start now: oldest first, at most `free` of them, and per product at most `limit(product)` at
 * once (default 1: a product with a change running, or one picked earlier in the pass, waits; it starts when that one
 * finishes and pump runs again). A product's second or later change also has to `fit` beside the others (parallel.ts):
 * `fit(id, picked)` gets the ids picked for its product earlier in this pass (the caller adds the ones running).
 */
export function pickQueued(queued: { id: string; product: string }[], busyProducts: Iterable<string>, free: number, { limit = () => 1, fit = () => false }: { limit?: (product: string) => number; fit?: (id: string, picked: string[]) => boolean } = {}) {
  const count = new Map<string, number>();
  for (const p of busyProducts) count.set(p, (count.get(p) ?? 0) + 1);
  const picked = new Map<string, string[]>();
  const out: string[] = [];
  for (const c of queued) {
    if (out.length >= free) break;
    const n = count.get(c.product) ?? 0;
    if (n >= limit(c.product)) continue;
    if (n > 0 && !fit(c.id, picked.get(c.product) ?? [])) continue;
    count.set(c.product, n + 1);
    picked.set(c.product, [...(picked.get(c.product) ?? []), c.id]);
    out.push(c.id);
  }
  return out;
}

/** The files a change touched so far (its worktree: commits on its branch and what's uncommitted); [] without one. */
export function changedFiles(c: Pick<Change, 'worktree' | 'base'>) {
  if (!c.worktree || !fs.existsSync(path.join(c.worktree, '.git'))) return [];
  const committed = git(c.worktree, ['diff', '--name-only', `origin/${c.base ?? BETA}...HEAD`], 10_000).out.split('\n');
  const open = git(c.worktree, ['status', '--porcelain'], 10_000).out.split('\n').map((l) => l.slice(3).split(' -> ').pop()!);
  return [...new Set([...committed, ...open].map((f) => f.trim()).filter((f) => f && !f.startsWith('.hawkes/')))];
}

/** A Unity product (Sick Of It, Yooba Land, The Place Department): its scenes and binaries need the Unity rules (parallel.ts). */
export function isUnity(product: string) {
  try { const p = getProduct(product); return p.engine === 'unity' || Boolean(p.build) || Boolean(p.builds?.some((b) => b.tool === 'unity')); } catch { return false; }
}

/** The product's other changes with work in a worktree (running, waiting, or ready to merge): the brief's "Other agents". */
function neighboursOf(c: Change) {
  return listChanges({ status: `${ACTIVE},ready,needs answer,${WAITING_GEN}`, product: c.product, limit: 20 })
    .filter((o) => o.id !== c.id)
    .map((o) => ({ id: o.id, status: o.status, title: o.title, request: o.request, files: touchedFiles(o.id) }));
}

/** A change as parallel.ts sees it: its task (and what that depends on), its title, the files it and its task's earlier changes touched. */
export function shapeOf(c: Change): WorkShape {
  const t = c.task ? getTask(c.task) : null;
  const earlier = (t?.changes ?? []).filter((x) => x !== c.id).map((x) => getChange(x)).filter((x): x is Change => Boolean(x));
  const findings = c.findings.map((f) => getFinding(f)?.title).filter(Boolean).join('; ');
  // What each recorded after its passes (inflight.ts) counts too: an earlier change's worktree is usually gone.
  const files = [...changedFiles(c), ...touchedFiles(c.id), ...earlier.flatMap((x) => [...changedFiles(x), ...touchedFiles(x.id)]), ...filesIn(c.request ?? '')];
  return { task: c.task ?? null, depends: t?.depends ?? [], text: [t?.title ?? c.title ?? '', findings].filter(Boolean).join('; '), files: [...new Set(files)] };
}

/**
 * Why `next` can't start beside the product's changes in `statuses` now (its slots are full, or it would collide with
 * one: parallel.ts), or null when it can.
 */
export function noRoomFor(product: string, next: WorkShape, statuses = `queued,${ACTIVE}`) {
  // Videos write only under videos/<slug>/ (videos.ts): they never collide with the product's other work or each other,
  // so they neither need a product slot nor hold one (J, 2026-10-22: a video waiting for his screening blocked four more).
  if (isVideoTask(next.task)) return null;
  // A parked change (queue-heal.ts: it failed again and again) holds no slot of its product.
  const others = listChanges({ status: statuses, product, limit: 50 }).filter((c) => !isVideoTask(c.task) && !parkedOut(c));
  const limit = perProductLimit(product);
  if (others.length >= limit) return limit === 1 ? `${others[0].id} is running` : `${limit} changes are running`;
  return others.length ? overlapWith(next, others.map(shapeOf), { unity: isUnity(product) }) : null;
}

/** A change parked by the harness waits out its gap and stops at the cap (resumeGate); the cap asks J once. */
function resumeAllowed(c: Change, free: () => Harness | null = freeHarness) {
  // Parked after failing again and again, or woken and at the end of its product's line (queue-heal.ts): not this pass.
  if (queueHold(c)) return false;
  const ph = phaseOf(c.id);
  // Queued to try again by itself (endPass): not before its time; the queue's one timer wakes it then.
  if (ph?.notBefore && !ph.failed && ph.notBefore > Date.now()) { pumpAt(ph.notBefore + 50); return false; }
  const h = ph?.harness;
  // Parked by one provider and another answers now (providers.ts, or a stand-in): it moves there at once. The gap and
  // the cap are for resuming on the provider that just stopped it.
  if (h && h.kind !== 'revive' && isHarness(h.on)) {
    const other = free();
    if (other && other !== h.on) { endWait('harness-cap', c.id, 'event', `${other} answers`); return true; }
  }
  const g = resumeGate(h);
  if (g.go) { endWait('harness-cap', c.id, 'event'); return true; }
  // The cap is a wait of the shared rule (waits.ts): recorded with its end, so a restart arms it again.
  if (g.capped) beginWait('harness-cap', c.id, { waitsOn: `the hour letting one more harness stop in (${RESUME_CAP} in the last hour)`, deadlineAt: Date.now() + g.waitMs, product: c.product, renew: true });
  // One timer for the earliest wake, not one per parked change per pass (2026-11-10: ~200 parked changes each set a
  // timer on every pass; they all came due together and ran thousands of pumps back to back, blocking the event loop
  // for 224 s, so Cloud Run refused claude.ai's token refreshes and Studio's connector was signed out).
  pumpAt(Date.now() + g.waitMs + 1000);
  if (g.capped && h && !h.capped) {
    update(c.id, { phase: { ...phaseOf(c.id)!, harness: { ...h, capped: true } }, detail: `the AI harness stopped it ${RESUME_CAP} times in an hour: it tries again in ${Math.ceil(g.waitMs / 60_000)} min` });
    addLog(c.id, `harness stops ${RESUME_CAP} times in an hour: waits ${Math.ceil(g.waitMs / 60_000)} min, then goes on by itself`);
  }
  return false;
}

/** Runs queued changes up to the concurrency limit, per product up to its limit when they don't collide. */
/** Why agents can't start in this customer's Studio (its plan, or no AI linked), or null; J's Studio is never gated. */
export async function customerAgentGate(): Promise<string | null> {
  const { customerStudio } = await import('./tenancy.ts');
  if (!customerStudio()) return null;
  try { await (await import('./entitlements.ts')).requireFeature('agents'); } catch { return 'waiting: this plan has no agents (Settings → Plan and credits to upgrade); it starts by itself after'; }
  if (!(await (await import('./ailink.ts')).aiReady())) return 'waiting: connect your AI first (Settings → Your AI); it starts by itself after';
  return null;
}

/**
 * Changes put back in the queue for want of disk room (waitForDisk): not picked again until room may have freed, which
 * is an event, not a timer (diskwait.ts): a pass ending, or a sweep that freed space (disksweep.ts diskFreed).
 */
const diskWait = diskWaits(() => void pump());
// Gates that hold the queue wake it when they open (queuewake.ts): the deploy drain ending, a customer's plan or AI link.
onQueueWake(() => void pump());
watchDeployFlag();
void import('./disksweep.ts').then((d) => d.onDiskFreed((why) => diskWait.freed(why))).catch(() => {});
const waitsForDisk = (id: string) => diskWait.holds(id);
/** A change that couldn't get disk room for its worktree: queued again (not failed), tried again once room may have freed. */
function waitForDisk(id: string, why: string) {
  const short = why.replace(/\. The full reclaim ladder .*$/, '').replace(/^(in-memory|working) disk is full/, 'the disk is full');
  // The wait ends (J, 2026-11-13: "Make it so agents never get stuck"): the first refusal after the full reclaim ladder
  // waits once for room to free by an event; a second one in a row fails the change with the cause (the PM plans it
  // again once, its own backoff for a full disk: pm.ts infraHoldOf), instead of a queue of changes waiting forever.
  const n = (diskStrikes.get(id) ?? 0) + 1;
  diskStrikes.set(id, n);
  if (n >= DISK_STRIKES && /reclaim ladder/.test(why)) {
    diskStrikes.delete(id);
    void endPass(id, { detail: `failed: no disk room after the full reclaim ladder, twice (${short.slice(0, 160)}); the PM plans it again once room is back`, phase: { step: 'prepare', failed: true }, log: `disk: still no room after the full reclaim ladder (${short.slice(0, 200)}), a second time: ended with that cause, not left waiting` });
    return;
  }
  diskWait.hold(id);
  const by = diskWait.deadline();
  const until = by ? `, at the latest at ${new Date(by).toISOString().slice(11, 16)} UTC` : '';
  update(id, { status: 'queued', phase: null, detail: `queued: waits for disk room (${short.slice(0, 200)})` });
  addLog(id, `disk: no room for its worktree after the reclaim ladder (${short.slice(0, 200)}): back in the queue, it looks again once the ladder frees room, work beside it ends or a worktree is removed${until}`);
}
/** Refusals after the full reclaim ladder per change: the second one ends the wait (waitForDisk). */
const diskStrikes = new Map<string, number>();
const DISK_STRIKES = 2;

/** A revision's note, kept until the pump starts its pass (revise). */
const reviseNotes = new Map<string, string>();

/** When the pump last started a change (checkQueue: a queue with free slots and no start for long is stalled). */
let lastStartAt = Date.now();
/** What the pump's last look came to (why it started nothing): the watchdog logs it with a stall. */
let pumpNote = 'not run yet';

/**
 * A queue that should be moving and isn't (J, 2026-11-10: "the goal shouldn't be to have to watch studio"). On
 * 2026-11-10 a disk budget below the disk's size at rest put every change back as "waits for disk room" for hours while
 * five of six slots sat free, and nothing said so. Pure: what the watchdog sees, and why it's stalled or null.
 */
export function queueStalled(o: { queued: number; free: number; lastStartAt: number; oldestQueuedAt: number; now: number; memLow: boolean; held: boolean; stallMs?: number }): string | null {
  const stall = o.stallMs ?? QUEUE_STALL_MS();
  if (!o.queued || o.free <= 0) return null;
  if (o.now - o.lastStartAt < stall || o.now - o.oldestQueuedAt < stall) return null;
  // A hold (a deploy, no provider) is a reason, not an excuse: one that lasts this long is reported like any stall.
  return `${o.queued} queued and ${o.free} slot(s) free, but nothing started for ${Math.round((o.now - o.lastStartAt) / 60_000)} min${o.memLow ? ' (memory is low)' : ''}${o.held ? ' (held: a deploy is pending or no provider is ready)' : ''}`;
}
/** How long a queue may sit with free slots before the watchdog steps in and health says so (STUDIO_QUEUE_STALL_MS; 10 minutes). */
export const QUEUE_STALL_MS = () => Number(process.env.STUDIO_QUEUE_STALL_MS) > 0 ? Number(process.env.STUDIO_QUEUE_STALL_MS) : 10 * 60_000;

/**
 * The statuses that hold one of the maxConcurrent agent slots: an agent at work. A change that is verifying waits on a
 * build or playtest in Hawkes Gen and runs no agent, so it holds none (2026-11-10: three of six slots sat on cloud
 * builds for up to an hour while 84 changes waited). The product's own limit (perProduct) still counts it.
 */
const AGENT_SLOT = 'working,revising';
/** Passes in this process that hold an agent slot (a verifying change's pass holds none). */
function slotHolders(own = false) {
  let n = 0;
  for (const id of running) {
    const c = getChange(id);
    if (c?.status !== 'verifying' && Boolean(c && studioOwn(c.product)) === own) n++;
  }
  return n;
}
/** Changes holding an agent slot of the products' pool (Studio's own lane apart), from the database. */
const productSlotRows = () => listChanges({ status: AGENT_SLOT, limit: 500 }).filter((c) => !studioOwn(c.product)).length;

/** The queue now, for /api/health, /api/ops and the Resources page: stalled says why when it sits with free slots. */
export function queueHealth(now = Date.now()) {
  const queued = listChanges({ status: 'queued', limit: 500 }).filter((c) => !parkedOut(c));
  const s = agentSettings();
  const free = s.maxConcurrent - Math.max(productSlotRows(), slotHolders());
  // Studio's own changes wait for their own lane, not the products' free slots: one waiting while its lane is busy
  // isn't a stall of the products' queue.
  const ownBusy = slotHolders(true) >= OWN_LANE_SLOTS();
  const waiting = queued.filter((c) => !(ownBusy && studioOwn(c.product)));
  const oldest = Math.min(...waiting.map((c) => c.updated ?? c.created ?? now), now);
  const held = deployPending() || noProviderFree();
  const stalled = s.enabled === false ? null : queueStalled({ queued: waiting.length, free, lastStartAt, oldestQueuedAt: oldest, now, memLow: memLow(), held });
  return { queued: queued.length, free, max: s.maxConcurrent, lastStartAt, idleMin: Math.round((now - lastStartAt) / 60_000), stalled, heldBy: stalled ? queueHeldBy(queued.map((c) => c.detail)) : null, why: pumpNote, diskWaiting: diskWait.size() };
}

/** The reasons queued changes give, counted (the first words of their detail): what holds the queue. */
export function queueHeldBy(details: (string | null | undefined)[]): string {
  const n = new Map<string, number>();
  for (const d of details) {
    const k = String(d ?? 'queued').replace(/\(.*$/, '').replace(/\b(behind|for) c_[0-9a-f]+.*$/, '$1 another change').trim().slice(0, 60) || 'queued';
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}x ${k}`).join('; ');
}

/**
 * Whether the queue is stalled, said in the log (health shows the same through queueHealth). It only reports: nothing
 * here unsticks the queue (J, 2026-11-11: no watchdog or supervisor does the rescuing). Every wait carries its own exit
 * (the event that ends it, and the disk wait its own deadline: diskwait.ts), so a stall this reports is a bug in a gate
 * to fix at its root, not something to paper over by dropping holds and pumping.
 */
export function checkQueue(now = Date.now()): string | null {
  const q = queueHealth(now);
  const why = q.stalled;
  if (!why) return null;
  console.warn(`[queue] queue stalled: ${why}; the pump's last look: ${pumpNote}; held by: ${q.heldBy}`);
  return `${why}; held by: ${q.heldBy}`;
}

/** The provider new work would go to now, when it isn't held; null when none is free. One look per pump pass. */
function freeHarness(): Harness | null {
  const h = pickHarness({ prefer: null });
  return harnessHeld(h) ? null : h;
}

/**
 * The pump, coalesced: a call while a pass runs asks for one more pass after it, never a second pass beside it. Every
 * part of Studio calls pump() when something may have freed a slot (25 callers), so on a busy day they arrive in
 * bursts; each pass reads every queued change, so passes must never pile up (2026-11-10: a 224 s event-loop block).
 */
let pumping: Promise<void> | null = null;
const PUMP_RETRY_MS = () => Number(process.env.STUDIO_PUMP_RETRY_MS) > 0 ? Number(process.env.STUDIO_PUMP_RETRY_MS) : 60_000;
/** Tests: a pass in place of the real one. */
export const pumpHooks: { pass?: () => Promise<void> } = {};
let pumpAgain = false;
export let pumpPasses = 0;
function pump(): Promise<void> {
  if (pumping) { pumpAgain = true; return pumping; }
  pumping = (async () => {
    try {
      do {
        pumpAgain = false;
        pumpPasses++;
        await (pumpHooks.pass ?? pumpPass)().catch((e) => {
          // A pass that throws partway has asked for none of its later wakes (resume gaps, retries, Gen deadlines):
          // it is tried again in a minute, so a queue never waits on an unrelated caller to pump it (2026-11-11 review).
          console.warn(`[studio] queue pass failed: ${e?.message ?? e}; trying again in a minute`);
          pumpAt(Date.now() + PUMP_RETRY_MS());
        });
        // Let requests (health, OAuth, MCP) in between passes.
        if (pumpAgain) await new Promise((r) => setImmediate(r));
      } while (pumpAgain);
    } finally {
      pumping = null;
    }
  })();
  return pumping;
}
/** One timer for the pump's next wake: the earliest asked for (resume gaps). Later asks are made again by the passes. */
let pumpTimer: { at: number; t: NodeJS.Timeout } | null = null;
export function pumpAt(at: number) {
  if (pumpTimer && pumpTimer.at <= at) return;
  if (pumpTimer) clearTimeout(pumpTimer.t);
  const t = setTimeout(() => { pumpTimer = null; void pump(); }, Math.max(0, at - Date.now()));
  t.unref?.();
  pumpTimer = { at, t };
}
/** Test hooks: the pump's pending wake time (or null), and a pump call as the rest of Studio makes it. */
export const pumpWakeAt = () => pumpTimer?.at ?? null;
export const pumpNow = () => pump();

async function pumpPass() {
  // A Studio deploy is waiting (drain.ts): start nothing new; the queue resumes after the deploy restarts Studio.
  // Its end wakes the queue (drain.ts watchDeployFlag); a flag no deploy takes away goes at its age limit, by this
  // pass's own deadline (pumpAt), not a watchdog.
  if (deployPending()) {
    const stale = clearStaleDeployFlag();
    if (stale) console.warn(`[studio] ${stale}`);
    else {
      const since = deployFlagSince();
      if (since != null) pumpAt(since + 20 * 60_000 + 1000);
      return void (pumpNote = 'a Studio deploy is pending (the drain flag is set)');
    }
  }
  // No provider can run (harness-hold.ts holds, providers.ts): nothing starts; the hold's own look resumes the queue.
  if (noProviderFree()) {
    pumpNote = `no AI provider can take work (${providerSettings().order.map((h) => `${h}: ${notReady(h) ?? 'ready'}`).join(', ')})`;
    return void reviewHolds().catch(() => {});
  }
  // A customer's Studio whose plan has no agents, or with no AI linked yet: nothing starts (it would only fail as a
  // harness stop and wait forever); the queued changes say why, and start the moment that's fixed (2026-10-31 review).
  const gate = await customerAgentGate();
  if (gate) {
    for (const c of listChanges({ status: 'queued', limit: 500 })) if (c.detail !== gate) update(c.id, { detail: gate });
    return void (pumpNote = gate);
  }
  const s = agentSettings();
  // Busy: anything running in this process (a revision or an answer is queued while it runs) and whatever is active.
  const active = new Map(listChanges({ status: ACTIVE, limit: 500 }).map((c) => [c.id, c]));
  for (const id of running) { const r = getChange(id); if (r) active.set(r.id, r); }
  // One look at the providers for the whole pass, not two per queued change (each reads every provider's hold and PATH).
  let free: Harness | null | undefined;
  const freeOnce = () => (free === undefined ? (free = freeHarness()) : free);
  // A change checks its task as it is about to start (queue-follow.ts): a rewritten task gives it the new request, a gone
  // one closes it.
  const queued = listChanges({ status: 'queued', limit: 500 }).reverse().filter((c) => !running.has(c.id) && !waitsForDisk(c.id) && resumeAllowed(c, freeOnce) && refreshFromTask(c.id) && duplicateHold(c.id));
  // Each change's shape (its task, earlier changes and files: git) once per pass, however many candidates it sits beside.
  const shapes = new Map<string, WorkShape>();
  const shape = (c: Change) => shapes.get(c.id) ?? (shapes.set(c.id, shapeOf(c)), shapes.get(c.id)!);
  const fit = (id: string, picked: string[]) => {
    const c = getChange(id)!;
    if (isVideoTask(c.task)) return true;
    const beside = [...[...active.values()].filter((r) => r.product === c.product && !isVideoTask(r.task)), ...picked.map((x) => getChange(x)!)];
    const why = overlapWith(shape(c), beside.map(shape), { unity: isUnity(c.product) });
    if (why && !c.detail?.includes(why)) update(id, { detail: `queued: waits for ${beside[0]?.id ?? 'the running change'} (${why})`.slice(0, 300) });
    return !why;
  };
  // A video has a lane of its own (noRoomFor): only the studio-wide cap applies to it.
  const lane = (c: Change) => (isVideoTask(c.task) ? `video:${c.id}` : c.product);
  const busy = [...active.values()].map(lane);
  const limit = (p: string) => (p.startsWith('video:') ? 1 : perProductLimit(p, s));
  // Studio's own work has its own lane (studioOwn): its slots aren't the products', and its picks go first, so the memory
  // gate below keeps them when it lets only one start.
  const own = (c: Change) => studioOwn(c.product);
  // Agents paused (maxConcurrent 0) pause Studio's own lane too.
  const ownFree = s.maxConcurrent > 0 ? OWN_LANE_SLOTS() - slotHolders(true) : 0;
  // A change that already waited for memory and failed (queue-heal.ts) goes behind the others while memory is low: the one
  // start memory allows goes to a change that can use it, and the starved one never holds its product's slot (2026-11-11).
  const starvedLast = memLow() ? (a: Change, b: Change) => Number(memoryStarved(a)) - Number(memoryStarved(b)) : () => 0;
  queued.sort(starvedLast);
  const ownPicks = pickQueued(queued.filter(own).map((c) => ({ id: c.id, product: lane(c) })), busy, ownFree, { limit, fit });
  const picks = [...ownPicks, ...pickQueued(queued.filter((c) => !own(c)).map((c) => ({ id: c.id, product: lane(c) })), busy, s.maxConcurrent - slotHolders(), { limit, fit })];
  // A queued change's " behind c_..." names what it waits for now, not one that finished since (J, 2026-10-18).
  const ahead = new Map<string, string[]>();
  for (const c of [...active.values(), ...picks.map((x) => getChange(x)!)]) ahead.set(c.product, [...(ahead.get(c.product) ?? []), c.id]);
  for (const c of queued) {
    if (picks.includes(c.id)) continue;
    const before = ahead.get(c.product) ?? [];
    const detail = queuedDetail(c.detail ?? '', before, perProductLimit(c.product, s));
    if (detail !== (c.detail ?? '')) update(c.id, { detail });
    ahead.set(c.product, [...before, c.id]);
  }
  // Memory is the floor under maxConcurrent (memgate.ts): while too little is free, nothing new starts beside running work.
  // With nothing running in this process one always starts, whatever memory reads: refusing then waits for work to end
  // when none is running (the memory gate's own rule, memRoom).
  const could = picks.length;
  if (picks.length && memLow()) {
    const room = inFlight > 0 && running.size > 0 ? 0 : 1;
    const why = `queued: waits for memory to free up (${memSummary()})`;
    for (const id of picks.splice(room)) { const c = getChange(id); if (c && !String(c.detail ?? '').startsWith('queued: waits for memory')) update(id, { detail: why }); }
  }
  pumpNote = picks.length ? `started ${picks.length}`
    : !queued.length ? 'nothing to start'
    : could ? `memory is low (${memSummary()}; ${inFlight} pass(es) on this machine: ${[...flying].join(', ') || 'none'})`
    : `no queued change fits: ${running.size} running of ${s.maxConcurrent} (${[...running].join(', ') || 'none'}), busy: ${busy.join(', ') || 'none'}`;
  if (picks.length) lastStartAt = Date.now();
  for (const id of picks) {
    const c = getChange(id)!;
    const land = claim(c.id, { flight: true });
    // Back from waiting on Gen: its own session continues with the jobs' results (same worktree, same branch).
    const ph = phaseOf(c.id);
    // Back from a harness hold: the same, from the step it parked at (harnessResume).
    // Queued to try again by itself (endPass): from its recorded phase.
    const back = (ph?.genDone || ph?.harness || ph?.notBefore) && !ph.failed ? ph : null;
    if (back?.notBefore) delete back.notBefore;
    if (back) update(c.id, { status: 'working', detail: ph!.harness ? `${brainLabel()} carries on after the harness hold` : ph!.genDone ? `its Gen jobs finished: ${brainLabel()} continues with them` : 'trying the run again (Studio tries it by itself)' });
    // After a restart the map is empty: a change still queued for another pass takes its newest note.
    const note = reviseNotes.get(c.id) ?? (c.detail === 'queued for another pass' ? c.notes.at(-1)?.text : undefined);
    reviseNotes.delete(c.id);
    void runPass(c.id, back ? undefined : note, undefined, back, Boolean(back)).finally(() => {
      land();
      remember(c.id);
      // A pass ending frees what it held: changes waiting for disk room may start now (this wakes the queue too). A
      // pass that only went back to wait for disk room held nothing, so it wakes no one (diskwait.ts passEnded).
      if (!diskWait.passEnded(c.id, `${c.id}'s pass ended`)) void pump();
    });
  }
}

/** Pushes a change's branch and opens its pull request (or updates the one it has); a critical section (drain.ts). */
async function publish(id: string, { force, title, body }: { force: boolean; title: string | null; body: string }) {
  return critical(`pushing ${id} and its pull request`, async () => {
    let c = getChange(id)!;
    // LFS files the job made go up first: GitHub must never get a pointer without its file.
    await pushPendingLfs(c.worktree, gitAsync, (m) => addLog(id, m));
    const push = await gitAsync(c.worktree, ['push', '--quiet', '-u', 'origin', `HEAD:${c.branch}`, ...(force ? ['--force-with-lease'] : [])]);
    if (!push.ok) throw new Error(`push failed: ${push.err}`);
    // A pull request merged or closed outside Studio (GitHub's website, another tool) takes no more commits: pushing
    // to its branch would leave the new ones off beta. Open a new pull request for what isn't on beta yet.
    if (c.pr && !c.infra) {
      const old = await github(`/repos/${c.slug}/pulls/${c.pr}`).catch(() => null);
      if (old && old.state !== 'open') {
        addLog(id, `pull request #${c.pr} was ${old.merged ? `merged outside Studio (${String(old.merged_at ?? '').slice(0, 16)}, head ${String(old.head?.sha ?? '').slice(0, 7)})` : 'closed'}; opening a new one for the commits not on ${c.base}`);
        update(id, { pr: null, pr_url: null });
        c = getChange(id)!;
      }
    }
    if (!c.pr) {
      // One already open for this branch: Studio opened it and restarted before it recorded it.
      const owner = c.slug.split('/')[0];
      const open: any[] = await github(`/repos/${c.slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${c.branch}`)}`).catch(() => []);
      const pr = open[0] ?? await github(`/repos/${c.slug}/pulls`, { method: 'POST', body: { title, head: c.branch, base: c.base, body, draft: false } });
      if (open[0]) await github(`/repos/${c.slug}/pulls/${pr.number}`, { method: 'PATCH', body: { body } });
      update(id, { pr: pr.number, pr_url: pr.html_url });
      addLog(id, `${open[0] ? 'found' : 'opened'} ${pr.html_url}`);
    } else {
      await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { body } });
      addLog(id, `updated pull request #${c.pr}`);
    }
  });
}

/**
 * Preflight (J, 2026-11-02: Unity agents never got the game source): before the agent starts, a light checkout (a big repo
 * cloned partially and sparse) gets the project's source files checked out by Studio, which holds the token, and a known
 * source file must exist and read in the worktree. If not, this throws "source unreadable/missing ..." and the agent is
 * never started: work()'s catch records an infra failure (infra-failure.ts: not a try, not one of the day's starts).
 */
export async function ensureSourceReady(id: string, c: Pick<Change, 'worktree' | 'product' | 'infra'>, log: (m: string) => void = (m) => addLog(id, m), opts: { rebuild?: () => Promise<void>; sleep?: (ms: number) => Promise<void> } = {}) {
  if (c.infra) return;
  const light = (await gitAsync(c.worktree, ['config', '--get', 'hawkes.light'])).out === 'true';
  // A full checkout shows its own Unity-ness (Assets/ tracked); a light one of a Unity product must have its code.
  const unity = light && isUnity(c.product);
  if (!light && !isUnity(c.product)) return;
  // Missing tracked files are repaired, not failed (healSource: the source again, a reapply, a full checkout, then the
  // worktree deleted and made again), and checked again after each, before the run is given up.
  const fixed = await healSource(c.worktree, gitAsync, { unity, light, log, rebuild: opts.rebuild, sleep: opts.sleep });
  if (!fixed.probe.ok) throw new Error(repairedError(`the worktree ${c.worktree}`, fixed));
  log(`source check: ${fixed.probe.tracked} tracked files, read ${fixed.probe.sample ?? 'the root files'}`);
}

/** A change's worktree thrown away and made again from its branch (or origin/<base>): the last repair for a checkout that stays bad. */
export async function rebuildWorktree(id: string) {
  const c = getChange(id)!;
  const repoDir = path.join(PROJECTS, c.repo);
  await checkoutSlot(() => critical(`making the worktree of ${id} again`, async () => {
    assertWorktreeRoot(c.worktree);
    await gitAsync(repoDir, ['worktree', 'remove', '--force', c.worktree]);
    fs.rmSync(c.worktree, { recursive: true, force: true });
    await gitAsync(repoDir, ['worktree', 'prune']);
    const has = (await gitAsync(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`])).ok;
    const w = await addWorktree(repoDir, c.worktree, has ? [c.worktree, c.branch] : ['-b', c.branch, c.worktree, `origin/${c.base}`], gitAsync, { removeLeftover: true, log: (m) => addLog(id, m), onKilled: lowerCheckouts });
    if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
  }));
  await lfsPull(c.worktree, (m) => addLog(id, m));
  await shareWorktree(c.worktree);
}
/** Studio only ever deletes a folder under its own .work (a worktree it made). */
function assertWorktreeRoot(dir: string) {
  const rel = path.relative(WORK(), path.resolve(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${dir} is not under ${WORK()}; not deleting it`);
}

/** Whole-run retries of a Studio checkout failure in prepare, before the change is left failed for the PM's backoff. */
export const AUTO_RETRIES = 2;
export const AUTO_RETRY_WAIT_MS = [30_000, 120_000];
/** Whether a failure at the prepare step is Studio's checkout machinery (retried by itself, never a try). */
export const checkoutFailure = (message: string) => isInfraText(message);

/**
 * A pass on a change, in its own async context (passCtx), so the watchdog can give up on it (abandonPass). A pass the
 * watchdog gave up on ends quietly. Passes started from inside a pass (a fix pass, a retry) keep the outer one's generation.
 */
function work(id: string, note?: string, answer?: string, resumed?: Phase | null, asked = false): Promise<void> {
  const cur = passCtx.getStore();
  const gen = cur?.id === id ? cur.gen : passGen(id);
  return passCtx.run({ id, gen }, () => workPass(id, note, answer, resumed, asked)).catch((e) => {
    if (e instanceof PassAbandoned) { console.warn(`[studio] ${e.message}`); return; }
    throw e;
  });
}
async function workPass(id: string, note?: string, answer?: string, resumed?: Phase | null, asked = false) {
  if (getChange(id)!.infra) return workInfra(id, note, resumed, false, asked);
  let c = getChange(id)!;
  const p = getProduct(c.product);
  const s = agentSettings();
  const repoDir = path.join(PROJECTS, c.repo);
  // Where the work is; after a restart it carries on from the recorded step (same agent process, same Gen jobs).
  const ph: Phase = resumed ?? { step: 'prepare', note, answer, since: Date.now() };
  ({ note, answer } = ph);
  const save = (patch: Partial<Phase>, extra: Record<string, any> = {}) => {
    Object.assign(ph, patch);
    update(id, { ...extra, phase: ph });
  };
  try {
    if (resumed && !asked) addLog(id, `Studio restarted: carrying on from the ${ph.step} step`);
    else if (!resumed) save({}, { status: note || answer ? 'revising' : 'working', detail: 'preparing the worktree' });
    // An approved GPU budget: Studio starts a stopped GPU server for it now (gpustart.ts; never a launch), in the background.
    // After a restart too, while the agent hasn't finished (its tries in between ended with the old process).
    if ((!resumed || ph.step === 'prepare' || ph.step === 'agent') && needsGpu(c)) void ensureGpuFor(c).then((r) => addLog(id, `GPU server: ${r}`)).catch(() => {});
    const findings = c.findings.map((f) => getFinding(f)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    await worktreeForAgentStep(id, ph, save);
    if (await worktreeForLaterSteps(id, ph)) return;

    if (ph.step === 'prepare') {
      update(id, { detail: 'preparing the worktree' });
      // A worktree a restart or a kill cut off halfway is never reused: discarded and made again below.
      await discardIfHalfMade(repoDir, c.worktree, gitAsync, (m) => addLog(id, m));
      if (!fs.existsSync(c.worktree)) {
        // A big repo on Cloud Run (a Unity project, or over STUDIO_CLONE_MAX_MB) is cloned light here (repos.ts syncGit:
        // partial, no LFS files, no npm ci) and the pass's job makes the full checkout; nothing is refused for its size.
        if (!isInfra(c.product) && !fs.existsSync(path.join(PROJECTS, c.repo.split(/[\\/]/)[0], '.git'))) {
          const big = await bigProduct(p).catch(() => null);
          if (big) addLog(id, `a big repo (${big}): cloned light on the cloud server; the agent's Cloud Run job makes the full checkout`);
        }
        fs.mkdirSync(WORK(), { recursive: true });
        // Agent branches start from beta (made from main the first time: pushing beta deploys nothing).
        // No disk room (it is memory on Cloud Run) is a wait, not a failure (J, 2026-11-10: three changes failed at
        // "preparing" this way and sat failed): back in the queue, picked again once work beside it ends.
        // The room is checked inside the checkout's turn, for every checkout under way (this one and the others in their
        // turn): checked before the turn, each of several changes saw room for one worktree and all of them wrote one.
        let full: string | null = null;
        await checkoutSlot(() => critical(`making the worktree of ${id}`, async () => {
          full = await diskRoomForCheckouts(id);
          if (full) return;
          // Studio on Cloud Run starts with no checkouts: the product's repo is cloned the first time it's needed.
          await ensureCloned(c.repo, c.slug);
          const beta = await ensureBeta(repoDir);
          if (beta.created) addLog(id, `made the ${BETA} branch from main (${beta.sha.slice(0, 7)})`);
          // Devtools saves still waiting in beta's working copy go to beta first, so the agent starts from them.
          const flushed = await import('./dev.ts').then(({ flushDev }) => flushDev(c.product, `before agent change ${id} started`)).catch((e) => ({ error: String(e.message ?? e) }));
          if ('pushed' in flushed && flushed.pushed) {
            addLog(id, `pushed devtools saves to ${BETA} first (${flushed.pushed.slice(0, 7)})`);
            await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
          }
          // A worktree a restart cut off halfway is forgotten first; its branch is reused.
          await gitAsync(repoDir, ['worktree', 'prune']);
          // Work saved on GitHub after an earlier pass (savework.ts) wins over beta: a restart that lost the worktree restarts from it.
          const restored = await restoreBranch(repoDir, c.branch);
          if (restored) addLog(id, restored);
          const has = (await gitAsync(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`])).ok;
          const w = await addWorktree(repoDir, c.worktree, has ? [c.worktree, c.branch] : ['-b', c.branch, c.worktree, `origin/${c.base}`], gitAsync, { removeLeftover: !fs.existsSync(path.join(c.worktree, '.git')), log: (m) => addLog(id, m), onKilled: lowerCheckouts });
          if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
        }));
        if (full) return void waitForDisk(id, full);
        diskStrikes.delete(id);
        // A warm start: node_modules from a checkout installed for the same lockfile (warm.ts), else a fresh npm ci.
        await checkoutSlot(async () => {
          await warmDeps(c.worktree, c.repo, (s) => addLog(id, s));
          await installCold(c.worktree, (dir, cmd) => sh(dir, cmd, { ...infraEnv({ keepGenKey: false }), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }), (s) => addLog(id, s));
        });
      } else {
        assertWorktree(c.worktree, repoDir);
        // A worktree a restart reset to beta while its branch holds saved work on GitHub carries on from that work.
        await gitAsync(c.worktree, ['fetch', '--quiet', 'origin', `+refs/heads/${c.branch}:refs/remotes/origin/${c.branch}`]);
        const caught = await catchUpWorktree(c.worktree, c.branch);
        if (caught) addLog(id, caught);
      }
      // Real files for its Git LFS pointers on every pass (a worktree made before git-lfs was on the server has pointers).
      await lfsPull(c.worktree, (s) => addLog(id, s));
      // The agent (sandbox user) commits here: its git folder must be the agent group's, on every pass (a worktree made
      // before, or files Studio's own git wrote there since).
      await shareWorktree(c.worktree);
      await ensureSourceReady(id, c, undefined, { rebuild: () => rebuildWorktree(id) });
      await writeBrief(c, p, findings, note);
      // A question or a stuck report from an earlier pass isn't read again (attemptsBrief carries what they said).
      fs.rmSync(path.join(c.worktree, '.hawkes', 'question.md'), { force: true });
      fs.rmSync(path.join(c.worktree, '.hawkes', 'stuck.md'), { force: true });
      save({ step: 'agent', before: (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out, proc: undefined });
    }

    if (ph.step === 'agent') {
      update(id, { detail: `${brainLabel()} is working on it` });
      // An answer to the agent's question continues its own session (claude --resume); anything else starts a new one.
      c = getChange(id)!;
      const resume = forHarness(ph, ph.nudge ? nudgeResume(c, ph)
        : ph.unityFix && ph.unity ? unityFixResume(c, ph.unity)
        : ph.compileFix && ph.compile ? compileFixResume(c, ph.compile)
        : ph.qualityFix && ph.quality ? qualityFixResume(c, ph.quality)
        : ph.conflict ? conflictResume(c, ph.conflict)
        : ph.genDone ? (c.session ? { session: c.session, prompt: ph.genDone } : { prompt: `Read .hawkes/brief.md: it's your whole task. ${ph.genDone}` })
        : answer && c.session
          ? { session: c.session, prompt: `The answer to your question:\n\n${answer}\n\nContinue the task in .hawkes/brief.md (rewritten with the latest thread) and finish it the way it says.` }
          : ph.harness ? harnessResume(c, ph)
          : undefined);
      if (!ph.proc && ph.harness) addLog(id, `agent ${resume?.session ? 'resumed its session' : 'started again in its worktree'} after the harness hold (${ph.harness.kind}): it carries on where it was`);
      else if (!ph.proc && ph.genDone) addLog(id, resume?.session ? 'agent resumed its session with its finished Gen jobs' : 'agent started again with its finished Gen jobs (no session recorded)');
      else if (!ph.proc && !ph.nudge) addLog(id, resumed && !ph.conflict ?'agent: it ran inside Studio, which restarted; starting the pass again' : resume?.session ? `agent resumed its session ${ph.conflict ? 'to resolve the conflicts with beta' : 'with the answer'}` : ph.conflict ? 'agent started: resolving the conflicts with beta' : `agent started`);
      // Wake Gen's MCP before the session (Cloud Run cold starts often beat the old 30 s CONNECT_TIMEOUT).
      if (!ph.proc && !ph.nudge) {
        const warm = await warmGenMcp();
        addLog(id, warm.ok
          ? `Gen MCP ready after ${Math.round(warm.ms / 1000)} s (${warm.attempts} probe${warm.attempts === 1 ? '' : 's'}, HTTP ${warm.status})`
          : `Gen MCP still not answering after ${Math.round(warm.ms / 1000)} s (${warm.attempts} probes${warm.error ? `: ${warm.error}` : ''}); session starts anyway with a longer connect timeout`);
      }
      const mcpMs = String(GEN_MCP_TIMEOUT_MS());
      const r = await agentPass(id, ph, save, s, claudeEnv({ MCP_TIMEOUT: mcpMs, MCP_CONNECT_TIMEOUT_MS: mcpMs }), resume);
      // Cancelled while it worked (cancelChange stopped it): not a failure, not a try; its branch and worktree stay.
      if (getChange(id)?.status === 'cancelled') return void addLog(id, 'agent: stopped because the change was cancelled');
      if (r.noRoom) return waitForJobRoom(id, ph, r.noRoom);
      // Its commits go to GitHub now, before anything else can lose them (never throws; publish pushes again for real).
      const cw = getChange(id)!;
      const saved = await saveWork(cw.worktree, cw.branch, cw.base);
      if ('pushed' in saved) addLog(id, `saved ${cw.branch} to GitHub (${saved.pushed.slice(0, 7)})`);
      else if ('error' in saved) addLog(id, `couldn't save ${cw.branch} to GitHub yet: ${saved.error}`);
      const gone = modelRefused(r, ph, currentBrain(id)?.model);
      if (gone) return requeueForModel(id, save, gone);
      const stop = passStop(r, readSummary(getChange(id)!.worktree));
      if (stop) {
        save({}, { cost: getChange(id)!.cost + r.cost });
        return parkForHarness(id, ph, save, stop, r.harness);
      }
      // The cost and the next step are written together, so a restart never counts a pass twice.
      save({ step: 'publish', result: r.result, stopped: r.stopped, machinery: machineryFailure(r.stderr) ?? undefined, job: ranInCloudJob(r.stderr, ph.proc?.rec.mode) || undefined, nudge: false, unityFix: false, compileFix: false, qualityFix: false, genDone: undefined, harness: undefined, proc: undefined, noRoom: undefined }, { cost: getChange(id)!.cost + r.cost });
    }

    if (ph.step === 'publish') {
      c = getChange(id)!;
      assertWorktreeThere(c);
      // The agent could write its worktree: Studio's git runs there only while it still links to this repo.
      assertWorktree(c.worktree, repoDir);
      const summaryFile = path.join(c.worktree, '.hawkes', 'summary.md');
      const summary = withStuck(c.worktree, fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8').trim() : ph.result ?? '');
      const listCommits = async () => (await gitAsync(c.worktree, ['log', '--format=%h %s', `origin/${c.base}..HEAD`])).out.split('\n').filter(Boolean);
      let commits = await listCommits();
      let changedNow = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out !== ph.before;
      // The agent said it changed nothing, and the only commit is Studio's own "leftover changes" one (files the checkout showed
      // as modified, never the agent's): that commit is dropped, so no pull request opens and nothing reaches beta.
      if (commits.length && (decidedNoChange(summary) || saysNoChange(summary)) && onlyStudioCommits(c.worktree, c.base)) {
        const r = await gitAsync(c.worktree, ['reset', '--quiet', '--hard', `origin/${c.base}`]);
        if (r.ok) {
          addLog(id, `the agent changed nothing (${summary.slice(0, 160).replace(/\s+/g, ' ')}): dropped Studio's leftover-changes commit (${commits.join('; ').slice(0, 160)}), no pull request`);
          commits = await listCommits();
          changedNow = false;
        }
      }
      // The agent asked a question: the change waits ("needs answer"); Talk answers from what J decided, or asks J (pm.ts).
      const questionFile = path.join(c.worktree, '.hawkes', 'question.md');
      const question = fs.existsSync(questionFile) ? fs.readFileSync(questionFile, 'utf8').trim() : '';
      // Its commit refused by a permission error: Studio commits the work (the safety net behind shareWorktree).
      if (!question && (!commits.length || !changedNow) && await commitForAgent(id, c.worktree, c.title ?? id, `${ph.result ?? ''}\n${summary}`)) {
        commits = await listCommits();
        changedNow = true;
      }
      // It queued Gen jobs and ended (.hawkes/waiting-jobs.txt): parked until they finish, holding no slot (pollGenWaits).
      const waitingFile = path.join(c.worktree, '.hawkes', 'waiting-jobs.txt');
      const parked = !question && fs.existsSync(waitingFile) ? parseWaitingJobs(fs.readFileSync(waitingFile, 'utf8')) : [];
      if (fs.existsSync(waitingFile)) fs.renameSync(waitingFile, `${waitingFile}.${Date.now()}`);
      if (parked.length) {
        const w: GenWait = { jobs: parked, since: Date.now() };
        update(id, { status: WAITING_GEN, detail: `waiting for GPU jobs (${genProgress(w)})`, summary, commits, phase: { step: 'gen', gen: w, since: ph.since } });
        addLog(id, `parked: waiting on ${parked.length} Gen job(s) (${parked.map((j) => j.id).join(', ')}); its session resumes when they finish`);
        genEvents.hold('parked-changes');
        setTimeout(() => void pollGenWaits(), 5_000).unref();
        return;
      }
      // It stopped with its work uncommitted (a time or turn limit, a cut session): its session is resumed to commit it.
      if (needsNudge(ph, { dirty: Boolean(uncommitted(c.worktree)), newCommit: commits.length > 0 && changedNow, question: Boolean(question) })) {
        nudge(id, ph, save);
        return work(id, note, answer, ph, true);
      }
      if (question) {
        update(id, { status: 'needs answer', detail: `the agent asks: ${question.split('\n')[0].slice(0, 200)}`, summary, commits, phase: null });
        addLog(id, `question: ${question.slice(0, 300)}`);
        const { addQuestion, addComment } = await import('./roadmap.ts');
        addComment(c.task ?? id, question.slice(0, 4000), 'agent', 'question');
        addQuestion({ kind: 'agent', subject: id, product: c.product, text: question });
        // The conversation that started it hears it now, so Talk asks the owner (access.ts agentPaused).
        void import('./access.ts').then((A) => A.agentPaused(id, question)).catch(() => {});
        return;
      }
      // The agent was cut off and the branch holds only Studio's leftover commit: not ready, nothing to merge.
      if (commits.length && cutOffLeftovers({ onlyStudio: onlyStudioCommits(c.worktree, c.base), stopped: ph.stopped, hasSummaryFile: fs.existsSync(summaryFile) })) {
        addLog(id, `${CUT_OFF_LEFTOVERS} (${commits.join('; ').slice(0, 160)}); last words: ${summary.slice(0, 160).replace(/\s+/g, ' ')}`);
        reopenTaken(id, findings.map((f) => f.id), CUT_OFF_LEFTOVERS);
        update(id, { status: 'failed', detail: CUT_OFF_LEFTOVERS, summary, commits, phase: null });
        await endChangeDisk(id);
        return;
      }
      // A conflict pass that couldn't resolve safely (its list, or markers left in): never a broken merge; the PM decides.
      if (ph.conflict) {
        const left = unresolvedConflicts(c.worktree, ph.conflict, changedNow);
        if (left) return conflictBack(id, ph, left);
      }
      // A conflict pass that committed nothing isn't a failure: ready again, it conflicts again (its next pass, or J).
      if (!commits.length || (note && !changedNow && !c.task && !ph.conflict)) {
        // Gen's MCP never connected: requeue (not a try), never "already done".
        if (parkForGenUnreachable(id, ph, save, summary, commits)) {
          if (getChange(id)?.status === 'failed') await dropEmptyWorktree(id, commits);
          return;
        }
        // Nothing to change because J already decided it: not a failed try, and the bugs it holds stay done (not reopened
        // for another agent to reach the same answer). Otherwise the bugs it still holds open again (reopenTaken):
        // never one the PM or J triaged while it ran (f_6ba75c6c2ac8: won't-fix reset to open on 2026-10-17).
        if (decidedNoChange(summary)) {
          for (const f of findings) if (heldBy(getFinding(f.id), id)) updateFinding(f.id, { status: 'fixed', note: `agent ${id}: ${DECIDED}: ${summary.slice(0, 200)}` });
          update(id, { status: 'failed', detail: `${DECIDED} (the agent made no commit)`, summary, commits, phase: null });
          await dropEmptyWorktree(id, commits);
          return;
        }
        if (fixAlreadyDone(id, c, findings.map((f) => f.id), summary, commits)) {
          await dropEmptyWorktree(id, commits);
          return;
        }
        // The harness's own words in the summary (it wrote one and then was refused): parked, not failed.
        const stopped = passStop({ ok: false, sawResult: false, result: ph.result ?? '' }, summary);
        if (stopped) return parkForHarness(id, ph, save, stopped);
        // No commit and the source was unreadable or missing (the worktree has none, or the agent said it couldn't read it):
        // Studio's failure, not the agent's try (infra-failure.ts reads the phrase and phase.failed).
        const lost = sourceLost(c, `${ph.result ?? ''}\n${summary}`, Boolean(ph.job));
        if (lost) {
          reopenTaken(id, findings.map((f) => f.id), lost);
          update(id, { status: 'failed', detail: lost.slice(0, 300), summary, commits, phase: { step: ph.step, failed: true } });
          await dropEmptyWorktree(id, commits);
          return;
        }
        // No commit because Studio's job failed around the agent (its clone, the bundle, the files coming back): Studio's
        // failure, with its own words in the detail, not a try (infra-failure.ts), so the finding isn't tried 11 times.
        if (ph.machinery) {
          const detail = `${ph.machinery} (the agent made no commit; not counted as a try)`.slice(0, 300);
          reopenTaken(id, findings.map((f) => f.id), detail);
          update(id, { status: 'failed', detail, summary, commits, phase: { step: ph.step, failed: true } });
          await dropEmptyWorktree(id, commits);
          return;
        }
        const why = noCommitWhy(c.worktree, ph);
        reopenTaken(id, findings.map((f) => f.id), `${why}: ${summary.slice(0, 120)}`);
        update(id, { status: 'failed', detail: noCommitDetail(summary, why), summary, commits, phase: null });
        await dropEmptyWorktree(id, commits);
        return;
      }
      if ((note || answer) && !changedNow) addLog(id, 'no new commit this pass; checking the branch again');
      // A project whose repository is Studio's or Gen's own (Gen's app: docs/projects.md) keeps their guard rails.
      const infraName = (/^jgriffith3433\/(hawkesstudio|hawkesgen)$/i.exec(c.slug ?? '') ?? [])[1]?.toLowerCase();
      if (infraName) {
        const files = (await gitAsync(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`])).out.split('\n').filter(Boolean);
        const bad = guardFiles(infraName, files, requestAndNotes(c));
        if (bad.length) {
          const list = bad.map((b) => `${b.file} (${b.why === 'forbidden' ? 'never changed by agents' : 'only when J names it'})`).join(', ');
          addLog(id, `guard rails: ${list}`);
          update(id, { status: 'failed', detail: `not pushed: it changes protected files: ${list}`.slice(0, 300), summary, commits, phase: null });
          await endChangeDisk(id);
          return;
        }
      }
      // The Unity check: every changed .cs file read for what the compiler rejects, before a pull request opens.
      if (!isSiteChange(c, p) && !c.infra && commits.length) {
        const files = await changedCsFilesAsync(c.worktree, `origin/${c.base}`);
        if (files.length && (isUnity(p.id) || looksUnity(files))) {
          update(id, { detail: 'Unity check: reading the C# the change touched' });
          const u = await unityCheckAsync(c.worktree, c.base);
          save({ unity: u });
          addLog(id, u.summary + (u.note ? ` (${u.note})` : ''));
          for (const l of issueLines(u)) addLog(id, `unity check: ${l}`);
          if (!u.ok) {
            const used = ph.unityFixes ?? 0;
            if (used < UNITY_FIXES) {
              addLog(id, `Unity check failed: sending the agent back to fix it (${used + 1} of ${UNITY_FIXES}); no pull request yet`);
              save({ step: 'agent', unityFixes: used + 1, unityFix: true, result: undefined, stopped: undefined, proc: undefined, since: Date.now() }, { status: 'working', detail: `the Unity check found ${u.issues.length} error${u.issues.length === 1 ? '' : 's'}: the agent is fixing them` });
              return work(id, note, answer, ph, true);
            }
            const detail = `the Unity check still fails after ${UNITY_FIXES} fix passes, no pull request: ${issueLines(u, 3).join('; ')}`.slice(0, 300);
            reopenTaken(id, findings.map((f) => f.id), detail);
            update(id, { status: 'failed', detail, summary, commits, phase: { ...ph, failed: true } });
            await endChangeDisk(id);
            return;
          }
        }
      }
      // The quality scan (quality-scan.ts): a game change's files read against the game quality rubric before a pull
      // request opens; what the change brings (not what was already on the base) sends it back, then fails it.
      if (!isSiteChange(c, p) && !c.infra && commits.length && isGame(p)) {
        update(id, { detail: 'quality scan: reading what the change touched against the game quality rules' });
        const q = await Promise.resolve().then(() => qualityScan(c.worktree, `origin/${c.base}`)).catch((e: any): QualityScan => ({ ok: true, files: 0, issues: [], known: [], summary: `Quality scan couldn't run: ${String(e.message ?? e).slice(0, 200)}` }));
        save({ quality: q });
        addLog(id, q.summary);
        for (const l of scanLines(q)) addLog(id, `quality scan: ${l}`);
        if (!q.ok) {
          const used = ph.qualityFixes ?? 0;
          if (used < QUALITY_FIXES) {
            addLog(id, `quality scan failed: sending the agent back to fix it (${used + 1} of ${QUALITY_FIXES}); no pull request yet`);
            save({ step: 'agent', qualityFixes: used + 1, qualityFix: true, result: undefined, stopped: undefined, proc: undefined, since: Date.now() }, { status: 'working', detail: `the quality scan found ${q.issues.length} problem${q.issues.length === 1 ? '' : 's'}: the agent is fixing them` });
            return work(id, note, answer, ph, true);
          }
          const detail = `blocked: it still breaks the game quality rules after ${QUALITY_FIXES} fix passes: ${scanLines(q, 3).join('; ')}`.slice(0, 300);
          reopenTaken(id, findings.map((f) => f.id), detail);
          update(id, { status: 'failed', detail, summary, commits, phase: { ...ph, failed: true, quality: q } });
          await endChangeDisk(id);
          return;
        }
      }
      const diffstat = (await gitAsync(c.worktree, ['diff', '--shortstat', `origin/${c.base}...HEAD`])).out;
      update(id, { summary, commits, diffstat, detail: 'pushing and opening the pull request' });
      const unityMd = ph.unity ? `\n\n**${ph.unity.summary}**` : '';
      const criteriaMd = c.criteria.length ? `\n\n**Acceptance criteria:**\n${c.criteria.map((k) => `- ${k}`).join('\n')}` : '';
      const body = `${summary}${unityMd}${criteriaMd}\n\n---\n**Findings** (Hawkes Studio playtest review):\n${findings.map((f: any) => `- [${f.severity}] ${f.title} (${f.id}, seen ${f.seen}×)`).join('\n')}\n\nMade by a Hawkes Studio agent. Approving it in Studio merges it into ${c.base} (the beta site, not live); going live is a separate step.\n\n${prGeneratedBy(id)}`;
      await publish(id, { force: Boolean(note || answer), title: c.title, body });
      // The compile gate: Gen compiles the pushed branch (no player build) before the change may be ready and merge.
      const gate = !isSiteChange(c, p) && !c.infra && isUnity(p.id) ? await compileGate() : null;
      // A gate that didn't run is said on the change, not only in its log: the ready line and the summary carry it, so the
      // owner knows nothing compiled this branch before it can merge (J, 2026-11-05).
      if (gate && !gate.run && gate.why) {
        addLog(id, gate.why);
        const skipped = skippedCompile(gate.why, (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out);
        save({ compile: skipped });
        const cur = getChange(id)!;
        if (!/Compile check skipped/.test(cur.summary ?? '')) update(id, { summary: `${cur.summary ?? summary}\n\n_${gate.why}._` });
      }
      if (gate?.run) {
        c = getChange(id)!;
        const tipNow = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out;
        update(id, { detail: 'Hawkes Gen is compiling the branch' });
        const cc = await runCompileCheck({ changeId: id, product: p.id, slug: c.slug, sha: tipNow, ref: `refs/heads/${c.branch}` }, (t) => update(id, { detail: t }));
        save({ compile: cc });
        addLog(id, cc.summary);
        for (const l of cc.issues.slice(0, 40)) addLog(id, `compile check: ${l.file}:${l.line} error ${l.code}: ${l.message}`);
        if (cc.outcome === 'failed') {
          const used = ph.compileFixes ?? 0;
          if (used < COMPILE_FIXES) {
            addLog(id, `compile check failed: sending the agent back to fix it (${used + 1} of ${COMPILE_FIXES}); not ready, it can't merge`);
            save({ step: 'agent', compileFixes: used + 1, compileFix: true, result: undefined, stopped: undefined, proc: undefined, since: Date.now() }, { status: 'working', detail: `the compile check found ${cc.issues.length} error${cc.issues.length === 1 ? '' : 's'}: the agent is fixing them` });
            return work(id, note, answer, ph, true);
          }
          const detail = `blocked from merging: the branch still doesn't compile after ${COMPILE_FIXES} fix passes: ${cc.issues.slice(0, 3).map((i) => `${i.file}:${i.line} ${i.code} ${i.message}`).join('; ')}`.slice(0, 300);
          reopenTaken(id, findings.map((f) => f.id), detail);
          update(id, { status: 'failed', detail, summary, commits, phase: { ...ph, failed: true, compile: cc } });
          await endChangeDisk(id);
          return;
        }
      }
      // The branch tip the agent's checks passed on; approving merges exactly this commit (approve() checks it). A change
      // is not played by itself (play-policy.ts, J 2026-11-11): its milestone's one play of the build judges its criteria.
      save({ step: 'finish', tip: (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out, jobs: {}, verify: undefined });
    }

    // A change that was about to be played before Studio stopped playing changes (play-policy.ts): it finishes unplayed.
    if (ph.step === 'verify') save({ step: 'finish' });

    c = getChange(id)!;
    // A playtest on request: its results join what the change already had (sha, preview, canon), and it's ready again.
    if (ph.requested) {
      const keep = Object.fromEntries(['scenario', 'options', 'canon', 'visible', 'capture', 'showcase', 'pendingGpu', 'unityCheck', 'compileCheck', 'qualityScan'].filter((k) => c.verify?.[k] !== undefined).map((k) => [k, c.verify[k]]));
      const verify = { ...keep, ...ph.verify, sha: ph.tip ?? c.verify?.sha, preview: c.verify?.preview ?? null, try: c.verify?.try ?? null, asked: { at: Date.now(), by: ph.requested } };
      addLog(id, `playtest (asked by ${ph.requested}): ${verify.outcome ?? '?'} · review: ${verify.verdict ?? 'n/a'}${verify.error ? ` · ${verify.error}` : ''}`);
      await attachShowcase(getChange(id)!, verify);
      update(id, { status: 'ready', detail: readyDetail(verify), verify, phase: null });
      return;
    }
    // Finish: the canon check, the preview, ready.
    const verify = ph.verify ?? { ...agentScenarioOf(c.worktree) };
    // Content and story changes are checked against the canon (canon.ts); a contradiction fails the merge gate.
    if (roleOf(c) === 'content') {
      update(id, { detail: 'checking the change against the canon' });
      const files = (await gitAsync(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`])).out.split('\n').filter((f) => CONTENTISH.test(f));
      const diff = files.length ? (await gitAsync(c.worktree, ['diff', `origin/${c.base}...HEAD`, '--', ...files.slice(0, 60)])).out : '';
      // The task's request and criteria go with it: what the task asked for is never a conflict (canon.ts).
      const canon: CanonCheck = await canonCheck(p.id, diff, c.title ?? c.request ?? id, { request: c.request, criteria: c.criteria }).catch((e: any) => ({ ok: true, summary: `couldn't check: ${e.message}`, conflicts: [], checked: 0, skipped: 'error' }));
      addLog(id, `canon: ${canon.ok ? 'ok' : 'CONFLICT'}: ${canon.summary}${canon.conflicts.length ? ` (${canon.conflicts.map((k) => k.entry).join(', ')})` : ''}`);
      // Flagged but not blocking (low confidence, ambiguous, requested, placeholder art, off the story path): notes.
      for (const n of canon.notes ?? []) addLog(id, `canon note (not blocking: ${n.note}): ${n.entry} ${n.why}`.slice(0, 600));
      if (verify) verify.canon = canon;
    }
    // A preview J can open: <product>.hawkesgen.ai/c/<id>/. Built only for a change that waits for a person: one that
    // merges into beta by itself (autoMergeBeta) is on beta's site moments later, so a build of its branch would be one
    // build per agent run for nothing (J, 2026-11-11: "we aren't building after every single run are we?"). A person can
    // still ask for one (POST /api/previews/<product> with the change).
    const waitsForPerson = !agentSettings().autoMergeBeta || Boolean(c.task && isVideoTask(c.task));
    const pv = waitsForPerson ? await Promise.resolve().then(() => buildPreview(p.id, { change: id, dir: c.worktree })).catch((e: any) => ({ status: 'failed', detail: e.message }) as any) : null;
    if (!waitsForPerson) addLog(id, 'preview: not built (the change merges into beta by itself; beta\'s site shows it)');
    const preview = pv?.status === 'ready' ? previewUrl(p.id, id) : null;
    if (preview) addLog(id, `preview: ${preview}`);
    const tryFile = path.join(c.worktree, '.hawkes', 'try.md');
    const howTo = fs.existsSync(tryFile) ? fs.readFileSync(tryFile, 'utf8').trim().slice(0, 2000) : null;
    // A GPU task's change that shipped stand-ins: merged, but its task waits for GPU (pm.ts) and runs again.
    const pendingGpu = c.task && (needsGpu(c) || roleOf(c) === 'content') ? pendingGpuOf(c.worktree, c.summary ?? '', await madeOf(c)) : null;
    if (pendingGpu) addLog(id, `stand-ins: still to make on the GPU: ${pendingGpu.split('\n')[0].slice(0, 200)}`);
    const visible = await visibleOf(c);
    const done = { ...verify, sha: ph.tip, preview, ...(visible !== null ? { visible } : {}), ...(ph.unity ? { unityCheck: ph.unity } : {}), ...(ph.compile ? { compileCheck: ph.compile } : {}), ...(ph.quality ? { qualityScan: { ok: ph.quality.ok, files: ph.quality.files, summary: ph.quality.summary, known: ph.quality.known.length } } : {}), try: howTo, ...(pendingGpu ? { pendingGpu } : {}) };
    // A video waits for J's screening (videos.ts): never merged by itself, its version kept, notes he left meanwhile sent back.
    if (c.task && isVideoTask(c.task)) {
      update(id, { status: 'ready', detail: 'ready to screen', verify: done, phase: null, auto_merge: null });
      const r = await videoReady({ id, task: c.task, worktree: c.worktree });
      addLog(id, r.version ? `video v${r.version.n}: ${r.version.asset}${r.resent ? ' (notes from while it worked: another pass)' : ''}` : 'no video left in .hawkes/video.json');
      return;
    }
    // Shots and a walk-through clip from the built game on the pull request (attachShowcase), before it can merge.
    await attachShowcase(getChange(id)!, done);
    const auto = agentSettings().autoMergeBeta;
    // 'trying' is written with 'ready', so Talk's "ready for J" notice (followup.ts) never races the merge.
    update(id, { status: 'ready', detail: readyDetail(done), verify: done, phase: null, auto_merge: auto ? 'trying' : null });
    // No phone notification (J's rule: only when something went wrong or a milestone is reached): Talk reports it.
    // Ready means merged into beta now (autoMergeBeta); with it off, a person merges it (or the PM, pm.ts).
    if (auto) await autoMergeBeta(id);
  } catch (e: any) {
    if (e instanceof PassAbandoned) throw e;
    addLog(id, `error: ${e.message}`);
    // A playtest on request that went wrong leaves the change as it was: ready, with what happened.
    if (ph.requested) {
      const v = { ...(getChange(id)!.verify ?? {}), outcome: 'not played', error: `the playtest couldn't run: ${String(e.message).slice(0, 300)}` };
      update(id, { status: 'ready', detail: readyDetail(v), verify: v, phase: null });
      return;
    }
    // Studio's own checkout failing in prepare (a clone killed, source missing after the repairs): it tries the whole run
    // again by itself, twice, after a wait, before leaving it failed (the PM's backoff and Studio blocker take over).
    const tried = ph.autoRetry ?? 0;
    if (ph.step === 'prepare' && tried < AUTO_RETRIES && checkoutFailure(String(e.message)) && getChange(id)?.status !== 'cancelled') {
      // Back in the queue to try again, not a wait inside the pass: the slot is free meanwhile.
      const wait = AUTO_RETRY_WAIT_MS[tried];
      return endPass(id, {
        detail: `queued: Studio's checkout failed; it tries the run again by itself (${tried + 1} of ${AUTO_RETRIES})`,
        phase: { step: 'prepare', note, answer, since: Date.now(), autoRetry: tried + 1 }, retryAt: Date.now() + wait,
        log: `Studio's checkout failed (${String(e.message).slice(0, 200)}): trying the whole run again by itself in ${Math.round(wait / 1000)} s (${tried + 1} of ${AUTO_RETRIES}; not a try)`,
      });
    }
    // update() opens the bugs it still holds again (reopenTaken); ones triaged while it ran stay as they are.
    const tail = ph.step === 'prepare' && tried ? ` (Studio already tried the run again ${tried}×; the PM tries it again later)` : '';
    await endPass(id, { detail: String(e.message).slice(0, 300 - tail.length) + tail, phase: { step: ph.step, jobs: ph.jobs, failed: true } });
  }
}

/** Files a player would see change: game code, scenes, assets and pages; not docs, tests, CI or the playtest's own scenarios. */
const UNSEEN = /(^|\/)(docs?|tests?|__tests__|\.github|\.claude|\.hawkes|playtest|scenarios?)\/|\.(md|txt|test\.[jt]sx?|spec\.[jt]sx?|d\.ts|lock|yml|yaml)$|(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|AGENTS\.md|CLAUDE\.md|LICENSE)$|(^|\/)hawkes-(playtest|feel|perf)\.js$/i;
const SEEN = /\.(html?|css|scss|[jt]sx?|mjs|glb|gltf|fbx|obj|png|jpe?g|webp|gif|svg|ogg|mp3|wav|m4a|json|cs|unity|prefab|mat|shader|shadergraph|anim|controller|asset|uxml|uss)$/i;
export function visibleFiles(files: string[]) {
  return files.filter((f) => SEEN.test(f) && !UNSEEN.test(f));
}

/**
 * A Unity change's files a player sees or feels: scenes, prefabs, models, animation, materials and shaders, VFX, UI,
 * audio and textures, and C# only where it drives the camera, controls, UI, animation, effects or sound. Pure code or
 * data with no visible effect (ScriptableObject .asset files, settings, editor tools, tests) is not.
 */
const UNITY_UNSEEN = /(^|\/)(Editor|Tests?|Plugins|Packages|ProjectSettings|docs?|\.github|\.claude|\.hawkes)\/|\.(asmdef|asmref|meta|md|txt|json|asset|yml|yaml)$/i;
const UNITY_SEEN = /\.(unity|prefab|fbx|obj|blend|glb|gltf|anim|controller|overrideController|mask|playable|mat|shader|shadergraph|hlsl|cginc|vfx|vfxoperator|uxml|uss|tss|wav|ogg|mp3|aif+|png|jpe?g|psd|tga|exr|ttf|otf)$/i;
const FELT_CS = /(camera|cinemachine|input|control|player|character|move|movement|locomotion|jump|dash|ui|hud|menu|screen|dialog|vfx|fx|particle|effect|anim|audio|sound|music|sfx|weapon|combat|hit|feel)/i;
export function unityVisibleFiles(files: string[]) {
  return files.filter((f) => !UNITY_UNSEEN.test(f) && (UNITY_SEEN.test(f) || (/\.cs$/i.test(f) && FELT_CS.test(f))));
}

/** Server-side code and tooling: never a visible change on its own, whatever its extension. */
const SERVER_ONLY = /(^|\/)(server|api|backend|functions|lambda|scripts?|bin|deploy|tools|migrations|db)\//i;
/**
 * Whether a change touches what a player sees: scenes, art, UI, shaders, content (and a web page's code). Docs, tests,
 * server code and CI never count, so they are never counted as "no capture yet" (J, 2026-11-11: captures are attached
 * by the milestone's play, never required before a merge). Pure.
 */
export function isVisibleChange(files: string[], { unity = false, infra = false }: { unity?: boolean; infra?: boolean } = {}) {
  if (infra) return false;
  const seen = unity ? unityVisibleFiles(files) : visibleFiles(files);
  return seen.some((f) => unity || !SERVER_ONLY.test(f));
}

/** The pull request's "From the built game" section: shots, motion sheets and the walk-through video, or null. Pure. */
export function showcaseSection(v: any) {
  if (!v || !playtested(v) || (!v.video && !v.shots?.length)) return null;
  const shots = ((v.shots ?? []) as any[]).map((s) => `![${s.reason ?? 'shot'} at ${s.t ?? '?'}s](${fileUrl(s.asset)})`);
  const sheets = ((v.sheets ?? []) as any[]).map((m) => `[motion ${m.start}s to ${m.end}s (${m.reason})](${fileUrl(m.asset)})`);
  return [
    SHOWCASE_MARK,
    '## From the built game',
    '',
    `Played by Hawkes Studio${v.scenario ? ` (scenario \`${v.scenario}\`)` : ''}: ${v.outcome ?? '?'}, review ${v.verdict ?? 'n/a'}${v.criteria?.length ? `, criteria ${v.criteria.filter((k: any) => k.met === 'yes').length}/${v.criteria.length} met` : ''}${v.quality?.fails?.length ? `, ${v.quality.fails.length} quality rule${v.quality.fails.length === 1 ? '' : 's'} broken` : ''}.`,
    '',
    v.video ? `Walk-through: [video](${fileUrl(v.video)})${sheets.length ? ` · ${sheets.join(' · ')}` : ''}` : sheets.join(' · '),
    '',
    shots.join('\n'),
    SHOWCASE_END,
  ].join('\n');
}
const SHOWCASE_MARK = '<!-- studio:showcase -->';
const SHOWCASE_END = '<!-- /studio:showcase -->';
/** A pull request body with the showcase section put in (replacing an earlier one). Pure. */
export function withShowcase(body: string | null | undefined, section: string) {
  const b = String(body ?? '');
  const i = b.indexOf(SHOWCASE_MARK);
  const j = b.indexOf(SHOWCASE_END);
  const rest = i >= 0 && j > i ? `${b.slice(0, i).trimEnd()}${b.slice(j + SHOWCASE_END.length)}` : b;
  return `${rest.trimEnd()}\n\n${section}\n`;
}

/** Puts the played change's shots and clip on its pull request; marks verify.showcase. Never fails the change. */
async function attachShowcase(c: Change, v: any) {
  const section = showcaseSection(v);
  if (!section || !c.pr || !c.slug) return;
  try {
    const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
    await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { body: withShowcase(pr?.body, section) } });
    v.showcase = { at: Date.now(), shots: (v.shots ?? []).length, video: v.video ?? null };
    addLog(c.id, `pull request #${c.pr}: shots and a walk-through clip from the built game added`);
  } catch (e: any) {
    addLog(c.id, `couldn't add the shots to pull request #${c.pr}: ${String(e.message ?? e).slice(0, 200)}`);
  }
}

/** Whether a change touches what a player sees, from its branch's files; null when they can't be read. */
async function visibleOf(c: Change): Promise<boolean | null> {
  if (c.infra) return false;
  try {
    const files = (await gitAsync(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`])).out.split('\n').map((f) => f.trim()).filter(Boolean);
    return isVisibleChange(files, { unity: isUnity(c.product) });
  } catch { return null; }
}

/** What a milestone's play shows: still shots (a phone's marked 390x844), motion sheets and one clip. */
export type MilestoneCapture = { run: string; scenario?: string; outcome?: string; shots: { asset: string; t?: number; reason?: string; phone?: boolean }[]; sheets: any[]; video: string | null; phone: boolean };

/**
 * A milestone's beta run finished: its shots and clip go on every visible change merged into beta before it that has no
 * capture yet (J, 2026-11-11: the milestone's one play is the only play; nothing is gated on it). Each gets
 * verify.capture and the pull request's "From the built game" section; the Home count drops. Returns the change ids.
 */
export async function attachMilestoneCapture(cap: MilestoneCapture, product: string, before = Date.now()): Promise<string[]> {
  if (!cap.shots.length && !cap.video) return [];
  const rows = db.prepare(`SELECT id FROM changes WHERE product = ? AND status = 'merged' AND merged_at IS NOT NULL AND merged_at <= ?
    AND json_extract(verify, '$.visible') = 1 AND json_extract(verify, '$.capture') IS NULL`).all(product, before) as { id: string }[];
  const done: string[] = [];
  for (const { id } of rows) {
    const c = getChange(id);
    if (!c) continue;
    const v: any = { ...(c.verify ?? {}), playtest: cap.run, outcome: cap.outcome ?? 'played', scenario: cap.scenario, shots: cap.shots, sheets: cap.sheets, video: cap.video };
    await attachShowcase(c, v);
    const verify = { ...(c.verify ?? {}), ...(v.showcase ? { showcase: v.showcase } : {}), capture: { at: Date.now(), run: cap.run, shots: cap.shots.length, phone: cap.phone, video: cap.video } };
    update(id, { verify });
    addLog(id, `seen in engine: milestone play ${cap.run} attached ${cap.shots.length} shot${cap.shots.length === 1 ? '' : 's'}${cap.video ? ' and a clip' : ''}${cap.phone ? ' (with a 390x844 phone shot)' : ''}`);
    done.push(id);
  }
  return done;
}

/** A ready change's one line: whether it was playtested (only on request), its review and criteria, its preview. */
export function readyDetail(v: any) {
  const played = playtested(v);
  const met = played && v.criteria?.length ? ` · criteria ${v.criteria.filter((k: any) => k.met === 'yes').length}/${v.criteria.length} met` : '';
  const what = played ? `playtest ${v.outcome ?? '?'} · review: ${v.verdict ?? 'n/a'}${met}`
    : v?.outcome === 'not played' && v.held ? `ready: agent's checks passed (not played: ${String(v.error ?? '').slice(0, 200)})`
    : v?.outcome === 'not played' ? `ready: agent's checks passed (the playtest asked for couldn't run: ${String(v.error ?? '').slice(0, 160)})`
      : "ready: agent's checks passed, pull request open (not playtested)";
  const unity = v?.unityCheck ? ` · ${v.unityCheck.engine === 'none' ? 'Unity check: no C# changed' : `Unity check passed (${v.unityCheck.engine === 'roslyn' ? 'Roslyn' : 'built-in'}, ${v.unityCheck.files.length} file${v.unityCheck.files.length === 1 ? '' : 's'})`}` : '';
  const compile = v?.compileCheck ? ` · ${v.compileCheck.summary}` : '';
  const notes = v?.canon?.notes?.length ? ` · ${v.canon.notes.length} canon note${v.canon.notes.length === 1 ? '' : 's'} (not blocking)` : '';
  // The game quality rubric (quality.ts): the scan before the pull request, and on a played build the rules it broke and the fun review.
  const scan = v?.qualityScan?.summary ? ` · ${v.qualityScan.summary}` : '';
  const broke = played && v?.quality?.fails?.length ? ` · ${v.quality.fails.length} quality rule${v.quality.fails.length === 1 ? '' : 's'} broken` : '';
  const fun = played && v?.fun?.verdict && v.fun.verdict !== 'unjudged' ? ` · fun review: ${v.fun.verdict}` : '';
  const shown = v?.showcase?.at ? ' · shots and a walk-through clip on the pull request' : '';
  return `${what}${unity}${compile}${scan}${broke}${fun}${notes}${shown}${v?.preview ? ` · preview ${v.preview}` : ''}`;
}
/** Whether a change was playtested (on request, or by the old automatic verification): its result is on it. */
export const playtested = (v: any) => Boolean(v && (v.playtest || (v.outcome && v.outcome !== 'not played')));

/** The scenario the agent added or extended for its criteria (.hawkes/scenario.txt line 1) and its options (line 2, JSON). */
function agentScenarioOf(worktree: string): { scenario?: string; options?: Record<string, unknown> } {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(worktree, '.hawkes', 'scenario.txt'), 'utf8').trim().split('\n');
  } catch {
    return {};
  }
  const scenario = /^[\w.-]{1,60}$/.exec(lines[0]?.trim() ?? '')?.[0];
  if (!scenario) return {};
  try {
    const o = JSON.parse(lines.slice(1).join('\n').trim() || 'null');
    return o && typeof o === 'object' && !Array.isArray(o) ? { scenario, options: o as Record<string, unknown> } : { scenario };
  } catch {
    return { scenario };
  }
}

/**
 * J's (or Talk's) request to playtest a ready change, with the same build, video and review the old automatic
 * verification had. The change is "verifying" meanwhile (resumable after a restart: changes.phase), then ready again
 * with the results; a playtest that can't run never fails it. Returns at once; the playtest goes on in the background.
 */
export function playtestChange(id: string, _by = 'J'): never {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (c.infra) throw new Error(`${getInfra(c.product).name} changes have checks (CI, the tests, a smoke check), not a playtest.`);
  if (c.status !== 'ready') throw new Error(`The change is ${c.status}: a playtest can be asked for once it's ready.`);
  if (!fs.existsSync(c.worktree)) throw new Error(`${id}'s worktree is gone; revise it to rebuild it.`);
  if (running.has(id)) throw new Error(`${id} is busy`);
  // Games are played once on each milestone's build (play-policy.ts, J 2026-11-11), not per change.
  throw new StudioError(`${id} isn't played on its own: ${PLAY_RULE}. Its criteria are judged in its milestone's play.`, 409);
}

/**
 * Ready changes whose pull request was merged outside Studio (J merging on GitHub): marked merged, not left "ready"
 * with an Approve card. Only when GitHub merged the commit Studio has on record; a pull request merged before the
 * agent's later commits stays as it is (approve() says to revise it, publish() opens a new pull request).
 */
export async function syncMergedOutside(repoFolder?: string) {
  const out: string[] = [];
  if (!githubReachable()) return out;
  for (const c of listChanges({ status: 'ready', limit: 100 })) {
    if (!c.pr || running.has(c.id) || (repoFolder && c.repo !== repoFolder)) continue;
    const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`).catch(() => null);
    if (!pr?.merged) continue;
    const head = String(pr.head?.sha ?? '');
    // After a conflict pass or update-branch the branch tip moved past the verified commit: the worktree's tip counts too.
    const tip = fs.existsSync(c.worktree) ? (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out : '';
    if (c.verify?.sha && head !== c.verify.sha && head !== tip) continue;
    await critical(`recording ${c.id} as merged`, async () => {
      if (getChange(c.id)?.status !== 'ready') return;
      const at = String(pr.merged_at ?? '').slice(0, 16).replace('T', ' ');
      const by = pr.merged_by?.login ? `${pr.merged_by.login} on GitHub` : 'GitHub';
      db.prepare('UPDATE changes SET merged_at = ? WHERE id = ?').run(Date.parse(pr.merged_at ?? '') || Date.now(), c.id);
      noteTiming(c.id, 'merged', Date.parse(pr.merged_at ?? '') || Date.now());
      update(c.id, { status: 'merged', detail: `merged into ${c.base} outside Studio (${by}, ${at}): ${String(pr.merge_commit_sha ?? '').slice(0, 7)}${c.infra ? '' : ' (not live yet)'}`, notes: [...c.notes, { at: Date.now(), by, text: `merged on GitHub (pull request #${c.pr})` }] });
      addLog(c.id, `pull request #${c.pr} was merged outside Studio (${by}, ${at}): marked merged`);
      remember(c.id);
      for (const f of c.findings) updateFinding(f, { status: 'fixed', note: `merged into ${c.base} in ${c.pr_url} (outside Studio)` });
      await cleanup(c.id, { deleteBranch: false });
    });
    out.push(c.id);
  }
  return out;
}

/** A verification's Gen jobs, recorded on the change as they're submitted (and found again after a restart). */
type JobMemo = { get: (k: string) => string | undefined; set: (k: string, job: string) => void };

/**
 * Builds a Unity change's branch on the build server into its own website copy (changeSiteDir: a worktree of the
 * site repo at main), never the real website folder. A commit that was already built isn't built again.
 */
async function buildChange(c: Change, p: Product, jobs?: JobMemo): Promise<ChangeBuild> {
  if (!p.build) throw new Error(`${p.name} has no build settings (products.json build)`);
  const sha = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out;
  const siteTop = p.site.split('/')[0];
  const copy = changeSiteDir(c.id);
  const last = changeBuild(c.id);
  if (last && last.sha === sha && (last.ok ? fs.existsSync(copy) : !last.retry)) {
    addLog(c.id, `build: ${sha.slice(0, 7)} was already built (${last.ok ? `Game/v${last.version ?? '?'}` : 'it failed'}); not building again`);
    return last;
  }
  const mark = `${copy}.json`;
  fs.rmSync(mark, { force: true });
  // A build started before a Studio restart: wait for that same job (its website copy is already set up, and may hold its output).
  const prior = jobs?.get('build');
  const siteRepo = path.join(PROJECTS, siteTop);
  if (!prior) await critical(`making the website copy of ${c.id}`, async () => {
  const f = await gitAsync(siteRepo, ['fetch', '--quiet', 'origin']);
  if (!f.ok) throw new Error(`fetching ${siteTop} failed: ${f.err}`);
  const head = (await gitAsync(siteRepo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).out || 'origin/main';
  if (!fs.existsSync(path.join(copy, '.git'))) {
    await gitAsync(siteRepo, ['worktree', 'prune']);
    const w = await gitAsync(siteRepo, ['worktree', 'add', '--detach', '--force', copy, head]);
    if (!w.ok) throw new Error(`making the website copy failed: ${w.err}`);
    await shareWorktree(copy);
  } else {
    const r = await gitAsync(copy, ['checkout', '--quiet', '--force', '--detach', head]);
    if (!r.ok) throw new Error(`resetting the website copy failed: ${r.err}`);
    await gitAsync(copy, ['clean', '-fdq']);
  }
  });
  const top = repoFor(p).top;
  const rel = (d: string) => path.relative(PROJECTS, d).replace(/\\/g, '/');
  const projectDir = path.join(c.worktree, path.relative(top, p.build.project));
  const siteDir = path.join(copy, path.relative(siteTop, p.site));
  addLog(c.id, prior ? `build: waiting for ${prior} again (started before Studio restarted)` : `build: ${sha.slice(0, 7)} on the build server (${p.build.method}) into ${rel(siteDir)}`);
  update(c.id, { detail: 'building the branch on the build server' });
  const job = await unityBuild(p.id, { project: p.build.project, site: p.build.site, method: p.build.method, projectDir: rel(projectDir), siteDir: rel(siteDir) },
    (j) => update(c.id, { detail: `build server: ${j.detail ?? j.status}` }), { job: prior, onSubmit: (id) => jobs?.set('build', id), log: (m) => addLog(c.id, `build: ${m}`) });
  const r = job.result ?? {};
  const cost = Number(job.cost ?? r.cost) || 0;
  update(c.id, { cost: getChange(c.id)!.cost + cost });
  // A Hawkes Gen without siteDir would have built into the real website folder: say so rather than playtest that.
  const stale = job.status === 'done' && r.site && r.site.folder !== rel(siteDir);
  const error = stale ? `Hawkes Gen's unity.build ignored siteDir (update Hawkes Gen); the build went to ${r.site.folder}` : job.status === 'done' ? undefined : job.status === 'cancelled' ? jobCancelDetail(job) : String(job.error ?? job.detail ?? 'build failed');
  // Unity's own errors come back the same for the same commit; the server being busy, unlicensed or unreachable doesn't.
  const b: ChangeBuild = {
    sha, ok: !error, at: Date.now(), job: job.id, version: r.version ?? null, cost, ...(r.packages ? { packages: r.packages } : {}), minutes: Math.round((r.seconds ?? 0) / 60),
    ...(error ? { error: error.slice(0, 500), retry: !/Unity exited with code|error CS\d+|Build ?Failed/i.test(error) } : {}),
  };
  fs.writeFileSync(mark, JSON.stringify(b, null, 2));
  addLog(c.id, b.ok ? `build: Game/v${b.version ?? '?'} in ${b.minutes} min ($${cost.toFixed(2)})` : `build failed: ${b.error}`);
  return b;
}

/** An agent's verify playtest goes ahead of daily and carried-over plays (0, -1), behind the go-live smoke (5): an agent and its tab wait on it. */
export const VERIFY_PRIORITY = 2;
/** How long it may wait in Gen's queue (behind other playtests: not a hang), as long as the whole wait used to be. */
const VERIFY_QUEUE_MS = 4 * 3600_000;

/**
 * An agent's verify playtest with the pipeline's limits (playtests.ts runGenJob): the scenario's run time (playtestRunMs,
 * counted from Gen's start) and no progress for PLAYTEST_IDLE_MS is stuck, so a stuck browser is cancelled and comes back
 * failed ("stuck: ...") instead of holding the agent and a tab for hours. Never shared: the page is served on the
 * change's own port, which stops with it. prior: a job submitted before a Studio restart, waited on again. The new job's
 * id goes into jobs as soon as Gen gives it (and its review starts afresh). api, pollMs: tests' stand-ins.
 */
export function verifyPlaytest(project: string, params: Record<string, unknown>, { prior, jobs, timeout, api, pollMs }: { prior?: string; jobs?: JobMemo; timeout?: number; api?: Parameters<typeof runGenJob>[4]['api']; pollMs?: number } = {}) {
  return runGenJob('playtest.run', project, params, (j) => {
    if (j?.id && jobs && jobs.get('playtest') !== j.id) { jobs.set('playtest', j.id); jobs.set('review', ''); }
  }, { runMs: playtestRunMs({ timeout } as Playtest), queueMs: VERIFY_QUEUE_MS, idleMs: PLAYTEST_IDLE_MS(), priority: VERIFY_PRIORITY, job: prior, ...(api ? { api } : {}), ...(pollMs ? { pollMs } : {}) });
}

/** How a change of a Unity product is built to be played: the build server's batch (products.json build), the project's Unity build in its builds list (any `on`), or not at all. null: not a Unity product. */
export type ChangeBuildPlan = { how: 'server' } | { how: 'cloud'; spec: NonNullable<Product['builds']>[number] } | { how: 'none'; why: string };
export function changeBuildPlan(p: Pick<Product, 'name' | 'engine' | 'build' | 'builds' | 'github'>): ChangeBuildPlan | { how: 'web' } {
  if (p.build) return { how: 'server' };
  const spec = p.builds?.find((b) => b.tool === 'unity');
  if (!spec && p.engine !== 'unity') return { how: 'web' };
  if (!spec) return { how: 'none', why: `${p.name} has no build settings (a Unity entry in its builds list, or products.json build)` };
  if ((spec.target ?? 'web') !== 'web') return { how: 'none', why: `${p.name}'s Unity build "${spec.id}" is for ${spec.target}, which can't be played in a browser` };
  if (!p.github) return { how: 'none', why: `${p.name}'s Unity build "${spec.id}" needs a GitHub repository to build from, and it has none` };
  return { how: 'cloud', spec };
}

/** Builds a change's pushed branch through the project's builds list (builds.ts, change mode) and says where it was published. */
async function buildChangeInCloud(c: Change, p: Product, buildId: string): Promise<ChangeBuild & { url?: string }> {
  const sha = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out || phaseOf(c.id)?.tip || '';
  const B = await import('./builds.ts');
  addLog(c.id, `build: ${sha.slice(0, 7) || c.branch} through ${p.name}'s builds list (${buildId}), published for this change only`);
  update(c.id, { detail: 'building the branch in the cloud' });
  // Only a playtest a person asked for gets here (verifyChange): a person's build (unitybuild-policy.ts).
  const r = await B.startBuild(p.id, { build: buildId, change: c.id, ref: c.branch, cause: 'person' });
  // Never waited on longer than a build may take (2026-11-10: a change waited 12 hours on a build that never ran): past
  // that, the run is cancelled and the change goes on without it (a verify that couldn't build never fails a change).
  const limit = B.BUILD_MAX_MS() + 15 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([(r?.done ?? Promise.resolve()).then(() => false), new Promise<boolean>((ok) => { timer = setTimeout(() => ok(true), limit); timer.unref?.(); })]);
  clearTimeout(timer);
  if (timedOut && r) {
    addLog(c.id, `build: no result after ${Math.round(limit / 60_000)} min: cancelling it and going on without it`);
    await import('./cancel.ts').then((m) => m.cancelRun(r.id, 'Studio', `the change's build gave no result in ${Math.round(limit / 60_000)} min`)).catch(() => {});
  }
  const row = db.prepare("SELECT status, url, detail FROM builds WHERE product = ? AND change = ? ORDER BY started DESC LIMIT 1").get(p.id, c.id) as { status: string; url: string | null; detail: string | null } | undefined;
  const ok = row?.status === 'ready' && Boolean(row.url);
  const error = ok ? undefined : String(row?.detail ?? (r ? 'build failed' : 'the build did not start')).slice(0, 500);
  addLog(c.id, ok ? `build: published at ${row!.url}` : `build failed: ${error}`);
  return { sha, ok, at: Date.now(), job: null as any, version: null, cost: 0, minutes: 0, ...(ok ? { url: row!.url! } : { error, retry: !/error CS\d+|Build ?Failed/i.test(String(error)) }) } as any;
}

/** One Studio fix task per product (never one per change) to add the build settings a Unity product lacks. */
function fileMissingBuildTask(p: Product) {
  try {
    const title = `Add build settings (products.json build) for ${p.name}`;
    if (db.prepare('SELECT 1 FROM items WHERE product = ? AND title = ?').get('hawkesstudio', title)) return;
    const item = addItem({ product: 'hawkesstudio', title, by: 'Studio', status: 'planned', goal: `Studio can't build ${p.name} to playtest its changes.`, criteria: [`products.json has a build entry for ${p.id} (project, site, method)`, `A change to ${p.name} gets built and played before it merges`] });
    addTask({ item: item.id, title, request: `${p.name} (${p.id}) is a Unity product with no \`build\` settings in products.json, so agent changes can't be built and played. Add its build settings (project, site, -executeMethod) like the other Unity products, following docs/builds.md. Until then its changes merge into beta on the agent's checks.` });
  } catch (e: any) { console.warn(`[studio] filing the build-settings task for ${p.id}: ${e.message ?? e}`); }
}

/**
 * A Unity change's verify playtest that nobody asked for isn't built (J, 2026-11-11: each change built its branch in the
 * cloud, and ~20 Unity builds queued at once used up the region's CPU quota): Unity builds wait for a milestone's end with
 * nothing else queued (unitybuild-policy.ts), and this change is still queued work. It goes on without that build, like a
 * verify that couldn't build; the compile gate (compilecheck.ts: Gen compiles the branch, no player build) is its check.
 * Exported for the tests.
 */
export function heldChangeVerify(c: Pick<Change, 'id'>, p: Pick<Product, 'id' | 'name'>, compile?: { summary?: string } | null): string {
  const why = unityBuildVerdict('auto', { name: p.name, milestone: null, changes: [c.id], tasks: [] }).why;
  return `${why}; this change is checked by the compile check instead${compile?.summary ? ` (${compile.summary})` : ''}, and played on beta's milestone build`;
}

export async function verifyChange(c: Change, p: Product, findings: any[], jobs?: JobMemo, o: { asked?: boolean } = {}) {
  let dir: string;
  let build: ChangeBuild | null = null;
  let cloudUrl: string | null = null;
  const plan = changeBuildPlan(p);
  if (isSiteChange(c, p)) {
    // A website change: its worktree is the site as it would be (with live's Game/v<n>): served as it is, no build.
    dir = path.join(c.worktree, path.relative(c.repo, p.local.dir));
  } else if (plan.how === 'none') {
    // A product Studio can't build for a playtest (no usable build settings) isn't a failed build: the change isn't played
    // and goes on to beta's own build on the agent's checks, like a skipped compile check. One Studio task asks for settings.
    fileMissingBuildTask(p);
    return { outcome: 'not played', error: `${plan.why}, so Studio can't build it to play: merged on the agent's checks`, build: null };
  } else if ((plan.how === 'cloud' || plan.how === 'server') && !o.asked) {
    // Nobody asked to play this change: no Unity build of its branch (heldChangeVerify), in the cloud or on a build server.
    const why = heldChangeVerify(c, p, phaseOf(c.id)?.compile ?? null);
    if (getChange(c.id)) addLog(c.id, `not played: ${why}`);
    return { outcome: 'not played', error: why, build: null, held: true };
  } else if (plan.how === 'cloud') {
    // A playtest a person asked for, of a project built through its builds list: the branch is built the way beta is
    // (builds.ts, Hawkes Gen's cloud build), published at c/<change>/, and that address is what gets played.
    build = await buildChangeInCloud(c, p, plan.spec.id).catch((e: any): ChangeBuild => ({ sha: '', ok: false, at: Date.now(), error: String(e.message ?? e).slice(0, 500), retry: true }));
    if (!build.ok && /^cancelled\b/.test(String(build.error))) return { outcome: 'not played', error: build.error, build, cancelled: true };
    if (!build.ok) return { outcome: 'build failed', error: build.error, build };
    dir = '';
    cloudUrl = (build as ChangeBuild & { url?: string }).url ?? null;
  } else if (plan.how === 'server') {
    // Unity: build the branch, then serve that build the way the site's local server would.
    build = await buildChange(c, p, jobs).catch((e: any): ChangeBuild => ({ sha: '', ok: false, at: Date.now(), error: String(e.message ?? e).slice(0, 500), retry: true }));
    // Cancelled isn't failed: the change is simply not played (the "not played" path), no revise, no try.
    if (!build.ok && /^cancelled\b/.test(String(build.error))) return { outcome: 'not played', error: build.error, build, cancelled: true };
    if (!build.ok) return { outcome: 'build failed', error: build.error, build };
    dir = path.join(changeSiteDir(c.id), path.relative(p.site.split('/')[0], p.local.dir));
  } else {
    dir = path.join(c.worktree, repoFor(p).sub, path.relative(p.repo, p.local.dir));
  }
  // The scenario the agent added or extended for its criteria (.hawkes/scenario.txt), else the finding's, else the first.
  // A second line in scenario.txt may give the scenario's options as JSON ({"stage":"neon-pit"}): the new content to play.
  const fromAgent = agentScenarioOf(c.worktree);
  // A feel finding carries a replay (feel.ts: scenario + seed + spot): with no scenario.txt, the fix is checked at that place.
  const replay = fromAgent.scenario ? null : findings.map((f: any) => replayOf(f.detail)).find(Boolean) ?? null;
  const agentScenario = fromAgent.scenario ?? replay?.scenario;
  const agentOptions = fromAgent.scenario ? fromAgent.options : replay?.options;
  const scenario = agentScenario ?? findings.map((f: any) => f.scenario).find((s: string) => s && s.endsWith('@local'))?.split('@')[0] ?? (p.playtests.find((t) => t.where === 'local')?.scenario ?? 'smoke');
  const mode = agentScenario ? undefined : p.playtests.find((t) => t.where === 'local' && (t.scenario ?? t.mode) === scenario)?.mode;
  const port = 8800 + (parseInt(c.id.slice(2, 6), 16) % 200);
  // After a Studio restart: a playtest that finished is kept and one still queued is waited for, but one that was
  // playing lost the page Studio served (its server stopped with Studio), so it is played again.
  let prior = jobs?.get('playtest') ? await gen.job(jobs.get('playtest')).catch(() => null) : null;
  if (prior && !['done', 'queued'].includes(prior.status)) {
    addLog(c.id, `playtest ${prior.id} was ${prior.status} when Studio restarted (its page server stopped); playing it again`);
    if (prior.status === 'running') await gen.cancel(prior.id).catch(() => {});
    prior = null;
  }
  const url = cloudUrl ?? (prior?.status === 'done' ? localUrl(p) : await serveDir(p, dir, port));
  const timeout = p.playtests.find((t) => t.where === 'local' && (t.scenario ?? t.mode) === scenario)?.timeout;
  try {
    const run = await verifyPlaytest(p.id, { url, mode: mode ?? (p.contract ? 'contract' : 'auto'), ...(mode ? {} : { scenario }), ...(mode === 'site' ? { maxPages: 40 } : {}), ...(agentScenario && agentOptions ? { options: agentOptions } : {}), globals: betaPageGlobals(), ...withPass() },
      { prior: prior?.id, jobs, timeout });
    if (run.status === 'cancelled') return { outcome: 'not played', error: jobCancelDetail(run), build, cancelled: true };
    if (run.status !== 'done') return { outcome: 'failed', error: run.error, playtest: run.id, build };
    // A verify review (review.ts): did the change work (it says by id whether the findings look fixed), did anything regress.
    // A roadmap task's acceptance criteria go with it and are judged one by one (acceptance.ts).
    const revParams = reviewParams(p, run.id, 'verify', {
      ...(c.criteria.length ? { criteria: c.criteria } : {}),
      focus: c.request ? `This is a proposed change J asked for: "${c.request.slice(0, 1500)}". Say clearly whether it does that well, and whether anything got worse.${c.criteria.length ? ` Judge each acceptance criterion: ${c.criteria.map((k, i) => `(${i + 1}) ${k}`).join(' ')}` : ''}` : `This is a proposed fix for: ${findings.map((f: any) => `"${f.title}" (${f.detail})`).join('; ')}. Say clearly whether it is fixed, and whether anything got worse.`,
    });
    // Gen's review, or Claude Code on the Max plan while Gen's Claude is out of credit (review-cc.ts).
    const rev = await reviewJob(p.id, revParams, () => genRun('playtest.review', p.id, revParams, undefined, undefined, { job: jobs?.get('review') || undefined, onSubmit: (id) => jobs?.set('review', id) }));
    const v = rev.result ?? {};
    const video = run.outputs?.find((o: any) => o.kind === 'video')?.asset ?? null;
    const criteria = c.criteria.length ? await judgeCriteria(c.criteria, v, run.result) : undefined;
    // The game quality rubric on the played build (quality.ts): the fun review (a demo fails), then every rule's
    // playtest and vision checks from the problems, metrics and findings. A broken rule fails the gate (acceptance.ts).
    const fun = isGame(p) ? await funReview(p, { review: v, playtest: { ...(run.result ?? {}), scenario }, dir: c.worktree, request: c.request }).catch(() => null) : null;
    const q = qualityGate(p, { problems: run.result?.problems, metrics: run.result?.metrics, findings: v.findings, fun, feel: run.result?.feel, polish: run.result?.polish?.hits, motion: v.motion ?? null, software: Boolean(run.result?.software) });
    if (fun) addLog(c.id, `fun review: ${fun.verdict}${fun.why ? `: ${fun.why}` : ''}`.slice(0, 600));
    for (const f of q.fails) addLog(c.id, failLine(f).slice(0, 600));
    // What the pull request shows (attachShowcase): the review's frames and motion sheets, and the run's video.
    const shots = ((v.frames ?? []) as any[]).filter((f) => f?.asset).slice(0, 6).map((f) => ({ asset: f.asset, t: f.t, reason: f.reason }));
    const sheets = ((v.motion?.sheets ?? []) as any[]).filter((m) => m?.asset).slice(0, 3).map((m) => ({ asset: m.asset, start: m.start, end: m.end, reason: m.reason }));
    return { outcome: run.result?.outcome, ...(isGame(p) ? { quality: q, ...(fun ? { fun } : {}) } : {}), scenario, shots, sheets, ...(agentScenario && agentOptions ? { options: agentOptions } : {}), playtest: run.id, review: rev.id, verdict: v.verdict, changeWorked: v.changeWorked, known: v.known ?? [], summary: v.summary, scores: v.scores, findings: (v.findings ?? []).slice(0, 8), video, url: localUrl(p), build, ...(criteria ? { criteria } : {}), ...(rev.via === 'claude-code' ? { reviewVia: `Claude Code, ${rev.billing}` } : {}) };
  } finally {
    stopServed(port);
  }
}

// ------------------------------------------------------------ Studio and Gen

/** Never changed by an agent, whatever the request says: data, keys, env files. */
const FORBIDDEN = [/^\.data\//, /(^|\/)\.env(\.|$)/, /^deploy\/\.keys\//, /\.pem$/, /(^|\/)keys\.env$/];
/**
 * Changed only when J names the file in his request (or a note on it): how the server deploys and checks itself,
 * Caddy (deploy/caddyfile.mjs: applied on the server by itself after a merge), secrets, and the GitHub hooks' token checks. A change that touches one otherwise isn't pushed.
 */
const GUARDED: Record<string, string[]> = {
  hawkesstudio: [
    'deploy/hawkes-pull.mjs', 'deploy/deploy.mjs', 'deploy/caddyfile.mjs', 'deploy/provision.mjs', 'deploy/cloud-init.sh', 'deploy/secrets.mjs', 'deploy/github-token.mjs',
    'deploy/claude-token.mjs', 'bin/git-credential-hawkes', 'src/github-oidc.ts', 'src/claude.ts', '.github/workflows/',
  ],
  hawkesgen: ['bin/fetch-secrets.mjs', 'src/auth.ts', '.github/workflows/'],
};

/** The files a change may not touch: forbidden ones always; guarded ones unless J's words name them. */
export function guardFiles(target: string, files: string[], words: string) {
  const said = words.toLowerCase();
  const named = (f: string) => said.includes(f.toLowerCase()) || said.includes(path.posix.basename(f).toLowerCase());
  const guarded = [...(GUARDED[target] ?? []), '.github/workflows/'];
  const out: { file: string; why: 'forbidden' | 'guarded' }[] = [];
  for (const f of files) {
    if (FORBIDDEN.some((r) => r.test(f))) out.push({ file: f, why: 'forbidden' });
    else if (guarded.some((g) => (g.endsWith('/') ? f.startsWith(g) : f === g)) && !named(f)) out.push({ file: f, why: 'guarded' });
  }
  return out;
}

const requestAndNotes = (c: Pick<Change, 'request' | 'notes'>) => [c.request ?? '', ...(c.notes ?? []).map((n) => n.text)].join('\n');

/** The environment of an infra agent and its checks: no GitHub, AWS or other service keys (the harness login stays for the agent). */
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDS|AWS_|ANTHROPIC|ELEVENLABS|OPENAI|GITHUB|CLAUDE|STRIPE|SMTP)/i;
export function infraEnv({ agent = false, keepGenKey = true } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(agent ? claudeEnv() : process.env)) {
    if (v === undefined) continue;
    // CURSOR_API_KEY matches SECRET (KEY). Product agents keep it via sandbox.ts; Studio and Gen agents go through here.
    const login = agent && /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|CURSOR_API_KEY|COPILOT_GITHUB_TOKEN|GEMINI_API_KEY|GEMINI_OAUTH_CREDS|AGY_CREDS|CURSOR_CREDS|COPILOT_CREDS|CODEX_CREDS)$/.test(k);
    if (!SECRET.test(k) || login || (keepGenKey && k === 'HAWKESGEN_KEY')) env[k] = v;
  }
  // Not the server: a worktree must never act like the running Studio (repo syncs) or Gen (fleet access).
  delete env.STUDIO_SERVER;
  delete env.HAWKES_AWS_ROLE;
  // Partial GIT_CONFIG_* (e.g. COUNT without KEY_0) breaks `git -c user.name=…` in the agent.
  for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k];
  return env as NodeJS.ProcessEnv;
}

function sh(cwd: string, cmd: string, env: NodeJS.ProcessEnv, timeoutMs = 15 * 60_000): Promise<{ ok: boolean; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawnShell(cmd, { cwd, env });
    let out = '';
    const keep = (d: any) => { out = (out + d).slice(-20_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { out += `\n(timed out after ${Math.round(timeoutMs / 60_000)} min)`; child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, ms: Date.now() - t0 }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message, ms: Date.now() - t0 }); });
  });
}
const tail = (s: string, n = 25) => s.trim().split('\n').slice(-n).join('\n');

/** npm ci in the worktree, unless node_modules already matches package-lock.json. */
async function npmCi(id: string, dir: string) {
  const lock = path.join(dir, 'package-lock.json');
  const hash = fs.existsSync(lock) ? crypto.createHash('sha1').update(fs.readFileSync(lock)).digest('hex') : 'none';
  const stamp = path.join(dir, 'node_modules', '.hawkes-lock');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return;
  update(id, { detail: 'installing packages (npm ci)' });
  const r = await sh(dir, 'npm ci --no-audit --no-fund', { ...infraEnv(), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });
  if (!r.ok) throw new Error(`npm ci failed: ${tail(r.out, 5)}`);
  fs.writeFileSync(stamp, hash);
  markInstalled(dir, hash === 'none' ? null : hash);
  addLog(id, `npm ci (${Math.round(r.ms / 1000)} s)`);
}

function writeInfraBrief(c: Change, t: Infra, note?: string) {
  const mem = briefSection({ product: t.id, role: 'infra', text: `${c.request ?? ''} ${c.title ?? ''}` });
  const dir = path.join(c.worktree, '.hawkes');
  fs.mkdirSync(dir, { recursive: true });
  const exclude = path.join(PROJECTS, c.repo, '.git', 'info', 'exclude');
  if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').includes('.hawkes/')) fs.appendFileSync(exclude, '\n.hawkes/\n');
  const brief = `# Work on ${t.name}

You are changing ${t.name} itself: ${t.about}

This repository deploys itself. There is no beta lane: when J approves your change, Studio merges its pull request
into main, CI runs typecheck and tests, and the control server pulls main and restarts ${t.name} (it rolls back if
the service doesn't come up healthy). A mistake here breaks the service J uses for everything: be careful and keep
the change small.

## What J asked for

${c.request ?? '(no request)'}
${note ? `\n## J's note on the last attempt\n\n${note}\n` : ''}${attemptsBrief(c, changeRoute(c))}
## How to work

1. Read \`AGENTS.md\` (and the docs it points to, e.g. \`docs/cloud.md\`) before changing anything. Follow its rules.
2. Make the smallest correct change that does what J asked. Don't refactor unrelated code.
3. Never touch \`.data/\`, \`.env\` files, keys (\`deploy/.keys/\`, \`*.pem\`, \`keys.env\`) or secrets. Don't change these
   unless J's request names the file: ${(GUARDED[t.id] ?? []).map((f) => `\`${f}\``).join(', ')}. A change that touches
   them anyway is thrown away.
4. Run the checks, and fix what fails:
${t.checks.map((k) => `   - \`${k}\``).join('\n')}
   ${t.id === 'hawkesstudio' ? `Studio's tests use the running Hawkes Gen at ${process.env.HAWKESGEN_URL ?? 'http://127.0.0.1:8790'} (free local tools only).` : 'Tests that need something missing here skip themselves.'}
5. Commit your change with a clear message. Don't push; Studio does.
6. Write \`.hawkes/summary.md\`: what you changed (files) and why, how you checked it, and anything J should know
   (in plain words: J doesn't read code). If you couldn't do it, explain why there instead, and don't commit.
   Two approaches, then stop: when two different approaches haven't worked, write \`.hawkes/stuck.md\` (what you
   tried, what happened, where you think the cause is) and commit nothing that doesn't work.
7. ${LEARNED_ASK.replace(/\n/g, '\n   ')}
${mem.text ? `\n${mem.text}` : ''}`;
  // A customer's Studio: their owner by name, never "J" (owner.ts).
  fs.writeFileSync(path.join(dir, 'brief.md'), forOwner(brief));
  return path.join(dir, 'brief.md');
}

async function workInfra(id: string, note?: string, resumed?: Phase | null, nudged = false, asked = false) {
  let c = getChange(id)!;
  const t = getInfra(c.product);
  const s = agentSettings();
  const repoDir = path.join(PROJECTS, c.repo);
  // The same steps as a product change (work()), so a Studio restart carries on from where it was.
  const ph: Phase = resumed ?? { step: 'prepare', note, since: Date.now() };
  ({ note } = ph);
  const save = (patch: Partial<Phase>, extra: Record<string, any> = {}) => {
    Object.assign(ph, patch);
    update(id, { ...extra, phase: ph });
  };
  try {
    if (resumed && !nudged && !asked) addLog(id, `Studio restarted: carrying on from the ${ph.step} step`);
    else if (!resumed) save({}, { status: note ? 'revising' : 'working', detail: 'preparing the worktree' });

    await worktreeForAgentStep(id, ph, save);
    if (await worktreeForLaterSteps(id, ph)) return;

    if (ph.step === 'prepare') {
      update(id, { detail: 'preparing the worktree' });
      await checkoutSlot(() => critical(`making the worktree of ${id}`, async () => {
        if (!fs.existsSync(c.worktree)) {
          fs.mkdirSync(WORK(), { recursive: true });
          await ensureCloned(c.repo, c.slug);
          // Only refs move in the server's checkout; its files only change through deploy/hawkes-pull.mjs.
          const f = await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
          if (!f.ok) throw new Error(`fetch failed: ${f.err}`);
          await gitAsync(repoDir, ['worktree', 'prune']);
          const has = (await gitAsync(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`])).ok;
          const w = await addWorktree(repoDir, c.worktree, has ? [c.worktree, c.branch] : ['-b', c.branch, c.worktree, `origin/${c.base}`], gitAsync, { removeLeftover: !fs.existsSync(path.join(c.worktree, '.git')), log: (m) => addLog(id, m), onKilled: lowerCheckouts });
          if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
          // A warm start: node_modules from a checkout with the same lockfile (warm.ts), not a fresh npm ci.
          await warmDeps(c.worktree, c.repo, (s) => addLog(id, s));
          await lfsPull(c.worktree, (s) => addLog(id, s));
        } else if (note) {
          // Another pass: bring the branch up to date with main first (main may have moved, or the merge conflicted).
          await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
          const m = await gitAsync(c.worktree, ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai', 'merge', ...MERGE_QUIET, '--no-edit', `origin/${c.base}`]);
          if (!m.ok) await gitAsync(c.worktree, ['merge', '--abort']);
          addLog(id, m.ok ? `merged origin/${c.base} into the branch` : `merging origin/${c.base} conflicted; the agent works from the branch as it was`);
        }
      }));
      assertWorktree(c.worktree, repoDir);
      // The agent commits here: its git folder must be the agent group's, on every pass (sandbox.ts).
      await shareWorktree(c.worktree);
      await npmCi(id, c.worktree);
      writeInfraBrief(c, t, note);
      save({ step: 'agent', before: (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out, proc: undefined });
    }

    if (ph.step === 'agent') {
      update(id, { detail: `${brainLabel()} is working on it` });
      if (!ph.proc && !ph.nudge) addLog(id, ph.conflict ? `agent resumed to resolve the conflicts with ${c.base}` : resumed ? 'agent: it ran inside Studio, which restarted; starting the pass again' : `agent started`);
      if (!ph.proc && ph.harness) addLog(id, `agent carries on after the harness hold (${ph.harness.kind})`);
      if (!ph.proc && !ph.nudge) {
        const warm = await warmGenMcp();
        addLog(id, warm.ok
          ? `Gen MCP ready after ${Math.round(warm.ms / 1000)} s (${warm.attempts} probe${warm.attempts === 1 ? '' : 's'}, HTTP ${warm.status})`
          : `Gen MCP still not answering after ${Math.round(warm.ms / 1000)} s (${warm.attempts} probes${warm.error ? `: ${warm.error}` : ''}); session starts anyway with a longer connect timeout`);
      }
      const mcpMs = String(GEN_MCP_TIMEOUT_MS());
      const r = await agentPass(id, ph, save, s, { ...infraEnv({ agent: true }), MCP_TIMEOUT: mcpMs, MCP_CONNECT_TIMEOUT_MS: mcpMs }, forHarness(ph, ph.nudge ? nudgeResume(getChange(id)!, ph) : ph.conflict ? conflictResume(getChange(id)!, ph.conflict) : ph.harness ? harnessResume(getChange(id)!, ph) : undefined));
      if (getChange(id)?.status === 'cancelled') return void addLog(id, 'agent: stopped because the change was cancelled');
      if (r.noRoom) return waitForJobRoom(id, ph, r.noRoom);
      // Its commits go to GitHub now, before anything else can lose them (never throws; publish pushes again for real).
      const cw = getChange(id)!;
      const saved = await saveWork(cw.worktree, cw.branch, cw.base);
      if ('pushed' in saved) addLog(id, `saved ${cw.branch} to GitHub (${saved.pushed.slice(0, 7)})`);
      else if ('error' in saved) addLog(id, `couldn't save ${cw.branch} to GitHub yet: ${saved.error}`);
      const gone = modelRefused(r, ph, currentBrain(id)?.model);
      if (gone) return requeueForModel(id, save, gone);
      const stop = passStop(r, readSummary(getChange(id)!.worktree));
      if (stop) {
        save({}, { cost: getChange(id)!.cost + r.cost });
        return parkForHarness(id, ph, save, stop, r.harness);
      }
      save({ step: 'publish', result: r.result, stopped: r.stopped, nudge: false, harness: undefined, proc: undefined, noRoom: undefined }, { cost: getChange(id)!.cost + r.cost });
    }

    if (ph.step === 'publish') {
      c = getChange(id)!;
      assertWorktreeThere(c);
      // The agent could write its worktree: Studio's git runs there only while it still links to this repo.
      assertWorktree(c.worktree, repoDir);
      const summaryFile = path.join(c.worktree, '.hawkes', 'summary.md');
      const summary = withStuck(c.worktree, fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8').trim() : ph.result ?? '');
      const listCommits = async () => (await gitAsync(c.worktree, ['log', '--format=%h %s', `origin/${c.base}..HEAD`])).out.split('\n').filter(Boolean);
      let commits = await listCommits();
      let changedNow = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out !== ph.before;
      // Its commit refused by a permission error: Studio commits the work (the safety net behind shareWorktree).
      if ((!commits.length || !changedNow) && await commitForAgent(id, c.worktree, c.title ?? id, `${ph.result ?? ''}\n${summary}`)) {
        commits = await listCommits();
        changedNow = true;
      }
      // It stopped with its work uncommitted: its session is resumed to commit it (as for a product change).
      if (needsNudge(ph, { dirty: Boolean(uncommitted(c.worktree)), newCommit: commits.length > 0 && changedNow, question: false })) {
        nudge(id, ph, save);
        return workInfra(id, note, ph, true);
      }
      // A conflict pass that committed nothing isn't a failure: ready again, it conflicts again (its next pass, or J).
      if (!commits.length || (note && !changedNow && !ph.conflict)) {
        if (parkForGenUnreachable(id, ph, save, summary, commits)) {
          if (getChange(id)?.status === 'failed') await dropEmptyWorktree(id, commits);
          return;
        }
        const stopped = passStop({ ok: false, sawResult: false, result: ph.result ?? '' }, summary);
        if (stopped) return parkForHarness(id, ph, save, stopped);
        update(id, { status: 'failed', detail: noCommitDetail(summary, noCommitWhy(c.worktree, ph)), summary, commits, phase: null });
        await dropEmptyWorktree(id, commits);
        return;
      }
      // Guard rails, before anything leaves the server.
      const files = (await gitAsync(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`])).out.split('\n').filter(Boolean);
      const bad = guardFiles(t.id, files, requestAndNotes(c));
      if (bad.length) {
        const list = bad.map((b) => `${b.file} (${b.why === 'forbidden' ? 'never changed by agents' : 'only when J names it'})`).join(', ');
        addLog(id, `guard rails: ${list}`);
        update(id, { status: 'failed', detail: `not pushed: it changes protected files: ${list}`.slice(0, 300), summary, commits, phase: null });
        await endChangeDisk(id);
        return;
      }
      const diffstat = (await gitAsync(c.worktree, ['diff', '--shortstat', `origin/${c.base}...HEAD`])).out;
      update(id, { summary, commits, diffstat, detail: 'pushing and opening the pull request' });
      const body = `${summary}\n\n---\n**J asked:** ${c.request ?? ''}\n\nMade by a Hawkes Studio agent. Approving it in Studio merges it into main, and ${t.name} deploys itself once CI passes (the control server pulls it, restarts the service and rolls back if it isn't healthy).\n\n${prGeneratedBy(id)}`;
      await publish(id, { force: Boolean(note), title: c.title, body });
      save({ step: 'verify', tip: (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out, verify: undefined }, { status: 'verifying', detail: 'checking: CI on the pull request, the checks, a smoke check' });
    }

    // Verify (checked again from the start after a restart: CI is GitHub's, the checks and smoke check take minutes), then ready.
    if (resumed && ph.step === 'verify') update(id, { status: 'verifying', detail: 'checking: CI on the pull request, the checks, a smoke check' });
    const v = ph.step === 'finish' ? ph.verify : await verifyInfra(getChange(id)!, t);
    // auto_merge starts over: walk-away mode decides this new head afresh (walkAwayMerge).
    update(id, { status: 'ready', detail: `${v.outcome}: ${v.summary}`.slice(0, 300), verify: v, phase: null, auto_merge: null });
    // Talk tells J in the chat; no phone notification (only failures and milestones go to the phone). A conflict pass
    // after J's approval: it merges once green (his approval stands). Walk-away mode: it merges by itself once green.
    if (getChange(id)!.approved) void mergeApprovedInfra(id).catch((e) => console.warn(`[studio] approved merge ${id}: ${e.message ?? e}`));
    else {
      // Once this pass has let go of the change (a fix pass it may start takes it over).
      const go = () => {
        if (running.has(id)) return void setTimeout(go, 200).unref();
        void walkAwayMerge(id).catch((e) => console.warn(`[studio] walk-away merge ${id}: ${e.message ?? e}`));
      };
      setTimeout(go, 0).unref();
    }
  } catch (e: any) {
    if (e instanceof PassAbandoned) throw e;
    addLog(id, `error: ${e.message}`);
    await endPass(id, { detail: String(e.message), phase: { step: ph.step, failed: true } });
  }
}

/**
 * Push and pull_request both post a job named "test" on the same SHA. Keep the newest run per name
 * ("Tell the server" never counts: it only starts the deploy on main).
 */
export function latestChecks(runs: { name: string; status?: string; conclusion?: string | null; html_url?: string; completed_at?: string | null; started_at?: string | null }[]) {
  const byName = new Map<string, (typeof runs)[number]>();
  for (const x of runs) {
    if (x.name === 'Tell the server') continue;
    const prev = byName.get(x.name);
    const t = Date.parse(x.completed_at || x.started_at || '') || 0;
    const pt = prev ? (Date.parse(prev.completed_at || prev.started_at || '') || 0) : -1;
    if (!prev || t >= pt) byName.set(x.name, x);
  }
  return [...byName.values()];
}

/**
 * What failed in a red CI job, from its log text: the failing tests (node's "failing tests:" block), then error lines.
 * A red CI that says only "test: failure" sent whole fix passes after a failure nobody could read (NET-08).
 */
export function failureFromLog(log: string, max = 1800) {
  const lines = String(log).split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
  const at = lines.findIndex((l) => /failing tests:/.test(l));
  const block = at >= 0 ? lines.slice(at, at + 60).filter((l) => l.trim()) : [];
  const errors = lines.filter((l) => /##\[error\]|error TS\d+|^npm error/.test(l)).slice(0, 12);
  return [...block, ...errors].join('\n').slice(0, max);
}

/** The log of a failed CI job (best effort: the token may not read Actions; then there is no text). */
async function ciJobLog(slug: string, jobId: number): Promise<string> {
  try {
    const token = (await (await import('./ghtoken.ts')).repoToken(slug)) ?? process.env.GITHUB_TOKEN;
    const r = await fetch(`${process.env.STUDIO_GITHUB_API ?? 'https://api.github.com'}/repos/${slug}/actions/jobs/${jobId}/logs`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(20_000),
    });
    return r.ok ? failureFromLog(await r.text()) : '';
  } catch {
    return '';
  }
}

/** GitHub's check runs of a commit ("Tell the server" doesn't count: it only runs on main). waitMs 0: one look. */
/**
 * GitHub Actions no longer runs Studio's and Gen's tests (J, 2026-10-25: "i don't want github running the tests
 * anymore"). What gates a Studio/Gen change is Studio's own typecheck, tests and smoke check (verifyInfra), and the
 * server's deploy runs them again on main before it deploys (deploy/hawkes-pull.mjs testOnServer). STUDIO_GITHUB_CI=1
 * brings back waiting for GitHub's check runs.
 */
export const githubCi = () => process.env.STUDIO_GITHUB_CI === '1';
export async function ciChecks(slug: string, sha: string, { waitMs = 30 * 60_000, onWait }: { waitMs?: number; onWait?: (detail: string) => void } = {}) {
  const t0 = Date.now();
  if (!githubCi()) return { state: 'success', detail: 'no GitHub CI: Studio ran the checks itself, and the deploy tests main on the server', runs: [] as { name: string; status: string; conclusion: string | null; url: string }[] };
  for (;;) {
    const r = await github(`/repos/${slug}/commits/${sha}/check-runs?per_page=100`);
    const runs = latestChecks((r.check_runs ?? []) as any[]);
    const list = runs.map((x) => ({ name: x.name, status: x.status, conclusion: x.conclusion, url: x.html_url }));
    const open = runs.filter((x) => x.status !== 'completed');
    if (runs.length && !open.length) {
      const bad = runs.filter((x) => !['success', 'skipped', 'neutral'].includes(x.conclusion as string));
      const failure = bad.length && (bad[0] as any).id ? await ciJobLog(slug, (bad[0] as any).id) : '';
      return { state: bad.length ? 'failure' : 'success', detail: bad.length ? bad.map((x) => `${x.name}: ${x.conclusion}`).join(', ') : `${runs.length} check(s) passed`, runs: list, ...(failure ? { failure } : {}) };
    }
    const waited = Date.now() - t0;
    if (waited >= waitMs || (!runs.length && waited >= Math.min(waitMs, 5 * 60_000))) {
      return { state: runs.length ? 'pending' : 'none', detail: runs.length ? `${open.length} check(s) still running` : 'no CI ran on this commit', runs: list };
    }
    onWait?.(runs.length ? `waiting for CI (${open.length} running)` : 'waiting for CI to start');
    await new Promise((res) => setTimeout(res, 20_000));
  }
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); });
});

/**
 * Starts the changed service from the worktree on a spare port with a scratch data folder (no keys, none of the live
 * service's state), then: its health answers ok, the dashboard page loads, and every dashboard script parses.
 */
export async function smokeCheck(dir: string, t: Infra) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `hawkes-smoke-${t.id}-`));
  const env = { ...infraEnv({ keepGenKey: false }), ...(t.smoke.env ?? {}), [t.smoke.portEnv]: String(port), [t.smoke.dataEnv]: data };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', t.smoke.start], { cwd: dir, env, windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log = (log + d).slice(-8000); });
  child.stderr.on('data', (d) => { log = (log + d).slice(-8000); });
  let exited: number | null = null;
  child.on('close', (code) => { exited = code ?? -1; });
  const base = `http://127.0.0.1:${port}`;
  const get = async (route: string) => {
    try {
      const r = await fetch(base + route, { signal: AbortSignal.timeout(10_000) });
      return { status: r.status, text: await r.text() };
    } catch (e: any) {
      return { status: 0, text: String(e.message ?? e) };
    }
  };
  try {
    let health: any = null;
    for (let i = 0; i < 60 && exited === null; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const h = await get(t.smoke.health);
      if (h.status === 200) { try { health = JSON.parse(h.text); } catch { health = { ok: false }; } break; }
    }
    const page = health ? await get('/') : null;
    const dashboard = Boolean(page && page.status === 200 && /<html/i.test(page.text));
    const scriptDir = path.join(dir, t.smoke.scripts);
    const scripts: { file: string; ok: boolean; error?: string }[] = [];
    for (const f of fs.existsSync(scriptDir) ? fs.readdirSync(scriptDir).filter((f) => f.endsWith('.js')) : []) {
      const r = await runCommand(process.execPath, ['--check', path.join(scriptDir, f)], { timeoutMs: 60_000 });
      scripts.push({ file: `${t.smoke.scripts}/${f}`, ok: r.ok, error: r.ok ? undefined : tail(r.err, 5) });
    }
    const ok = Boolean(health?.ok) && dashboard && scripts.every((x) => x.ok);
    const detail = !health ? (exited !== null ? `the server exited (code ${exited})` : 'no health answer in 60 s')
      : !health.ok ? 'health is not ok'
        : !dashboard ? 'the dashboard page did not load'
          : scripts.some((x) => !x.ok) ? `script errors: ${scripts.filter((x) => !x.ok).map((x) => x.file).join(', ')}`
            : `health ok, dashboard ok, ${scripts.length} script(s) parse`;
    return { ok, port, health: Boolean(health?.ok), dashboard, scripts, detail, log: ok ? undefined : tail(log, 30) };
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => fs.rmSync(data, { recursive: true, force: true }), 3000).unref();
  }
}

type InfraCheck = { cmd: string; ok: boolean; seconds: number; out?: string; failed?: string[]; known?: string[]; baseline?: string };
/**
 * A Studio or Gen change's checks (products.json infra "checks": typecheck and tests), all at once: they read the
 * worktree and write nothing the other reads (tsc is noEmit), so the slowest one sets the time (the tests, ~100 s)
 * instead of their sum (+ ~14 s of typecheck). Every one runs to the end and each result is kept, in the listed order,
 * so a change failing both hears of both. onDone: each one as it finishes. run: tests' stand-in for sh.
 */
export async function infraChecks(dir: string, cmds: string[], onDone?: (k: InfraCheck) => void, run: (cwd: string, cmd: string, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; out: string; ms: number }> = sh, extraEnv: Record<string, string> = {}): Promise<InfraCheck[]> {
  return Promise.all(cmds.map(async (cmd) => {
    const r = await run(dir, cmd, { ...infraEnv(), ...extraEnv }).catch((e: any) => ({ ok: false, out: String(e?.message ?? e), ms: 0 }));
    const k: InfraCheck = { cmd, ok: r.ok, seconds: Math.round(r.ms / 1000), out: r.ok ? undefined : tail(r.out) };
    onDone?.(k);
    return k;
  }));
}

/**
 * The tests already red on a clean checkout of the branch a change goes into (beta's own result), found by running the
 * same check there once per commit (kept in .data/infra-baseline/). Visible on the change as "already failing", never
 * skipped; only a failure that isn't in this list blocks. null when the baseline can't be had (then nothing is excused).
 */
export async function baselineFailures(c: Pick<Change, 'id' | 'worktree' | 'base'>, t: Infra, run: (cwd: string, cmd: string, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; out: string; ms: number }> = sh): Promise<{ sha: string; branch: string; failed: string[] } | null> {
  const branch = t.baselineBranch ?? c.base ?? 'main';
  const cmd = t.baselineCheck!;
  let f = await gitAsync(c.worktree, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (!f.ok) return null;
  const sha = (await gitAsync(c.worktree, ['rev-parse', `origin/${branch}`])).out;
  if (!sha) return null;
  const dir = path.join(DATA, 'infra-baseline');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${t.id}-${sha}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hawkes-base-${t.id}-`));
  try {
    const w = await gitAsync(c.worktree, ['worktree', 'add', '--detach', '--force', tmp, sha]);
    if (!w.ok) return null;
    const env = { ...infraEnv(), ...(t.checkEnv ?? {}), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
    const ci = await run(tmp, 'npm ci --no-audit --no-fund', env);
    if (!ci.ok) return null;
    const r = await run(tmp, cmd, env);
    const out = { sha, branch, failed: failingTests(r.out) };
    // A run that failed with no failing test named (it crashed, or timed out) says nothing about which tests are red.
    if (!r.ok && !out.failed.length) return null;
    fs.writeFileSync(file, JSON.stringify(out));
    return out;
  } finally {
    await gitAsync(c.worktree, ['worktree', 'remove', '--force', tmp]).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Verification of a Studio or Gen change: the checks and a smoke check here, and CI on the pull request (GitHub). */
async function verifyInfra(c: Change, t: Infra) {
  const sha = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out;
  const ci = ciChecks(c.slug, sha, { onWait: (d) => update(c.id, { detail: d }) }).catch((e: any) => ({ state: 'error', detail: String(e.message ?? e), runs: [] as any[] }));
  await npmCi(c.id, c.worktree);
  update(c.id, { detail: `running ${t.checks.join(' and ')}` });
  const checks = await infraChecks(c.worktree, t.checks, (k) => addLog(c.id, `${k.cmd}: ${k.ok ? 'ok' : 'FAILED'} (${k.seconds} s)`), sh, t.checkEnv);
  // Compared with beta's own result: a test red there too is shown as already failing, and only new failures block.
  const compared: string[] = [];
  for (const k of checks) {
    if (k.ok || k.cmd !== t.baselineCheck) continue;
    const failed = failingTests(k.out ?? '');
    if (!failed.length) continue;
    update(c.id, { detail: `${k.cmd} failed: comparing with ${t.baselineBranch ?? c.base}'s own result` });
    const base = await baselineFailures(c, t).catch(() => null);
    if (!base) { k.failed = failed; addLog(c.id, `${k.cmd}: no baseline from ${t.baselineBranch ?? c.base}, so none of ${failed.length} failing test(s) is excused`); continue; }
    const cmp = compareFailures(failed, base.failed);
    k.failed = cmp.fresh; k.known = cmp.known; k.baseline = base.sha.slice(0, 7);
    if (!cmp.fresh.length) { k.ok = true; k.out = undefined; }
    compared.push(describeTests(cmp, k.seconds, k.ok));
    addLog(c.id, `${k.cmd}: ${cmp.fresh.length} new failing, ${cmp.known.length} already failing on ${base.branch} @ ${k.baseline}`);
  }
  update(c.id, { detail: 'smoke check: starting the changed service on a spare port' });
  const smoke = await smokeCheck(c.worktree, t).catch((e: any) => ({ ok: false, detail: String(e.message ?? e) }) as any);
  addLog(c.id, `smoke: ${smoke.ok ? 'ok' : 'FAILED'}: ${smoke.detail}`);
  const ciResult = await ci;
  addLog(c.id, `CI: ${ciResult.state}: ${ciResult.detail}`);
  const ok = ciResult.state === 'success' && checks.every((k) => k.ok) && smoke.ok;
  const summary = [
    `CI ${ciResult.state === 'success' ? 'green' : `${ciResult.state} (${ciResult.detail})`}`,
    ...checks.map((k) => k.failed?.length || k.known?.length ? describeTests({ failed: [...(k.failed ?? []), ...(k.known ?? [])], known: k.known ?? [], fresh: k.failed ?? [], fixed: [] }, k.seconds, k.ok) : `${k.cmd} ${k.ok ? `ok (${k.seconds} s)` : 'FAILED'}`),
    `smoke: ${smoke.detail}`,
  ].join(' · ');
  return { kind: 'infra', sha, outcome: ok ? 'passed' : 'failed', verdict: ok ? 'ship' : 'broken', summary, ci: ciResult, checks, smoke };
}

/**
 * J's approval of a Studio or Gen change: merge into main (only with CI green on the pull request); the server deploys
 * it itself. Main moved since the checks (J, 2026-10-18: "405 Pull Request has merge conflicts" after PR #42 merged
 * first): the branch is brought up to date first, as for a product change (updateFromBase). A clean merge is pushed and
 * merges once CI on it is green; a real conflict resumes its agent (a conflict pass, not a try) and it merges once that
 * is checked and green. Either way J's approval stands meanwhile (`approved`); red CI never merges.
 */
async function approveInfra(c: Change, by: string, origin?: string | null) {
  const t = getInfra(c.product);
  const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
  if (pr.state !== 'open') throw new Error(`Pull request #${c.pr} is ${pr.merged ? 'already merged' : pr.state}.`);
  if (c.verify?.sha && pr.head.sha !== c.verify.sha) throw new Error(`Pull request #${c.pr}'s head moved after the checks (checked ${String(c.verify.sha).slice(0, 7)}, now ${String(pr.head.sha).slice(0, 7)}). Revise ${c.id} so the new head is checked.`);
  // Tests gate every merge, whoever asks (J's tap, a delegated merge, walk-away): a failed Studio check never merges.
  if (c.verify?.outcome === 'failed' || (c.verify?.checks ?? []).some((k: any) => !k.ok)) throw new Error(`The checks on ${c.id} failed (${String(c.verify?.summary ?? 'see its log').slice(0, 400)}); not merging into ${c.base}. Revise it so they pass.`);
  const up = await updateFromBase(c.id);
  if (up.state === 'merged' || up.state === 'conflict') return holdForMain(c, up, by, origin);
  const head = getChange(c.id)!.verify?.sha ?? pr.head.sha;
  const ci = await ciChecks(c.slug, head, { waitMs: 0 });
  if (ci.state !== 'success') throw new Error(`CI on pull request #${c.pr} isn't green (${ci.state}: ${ci.detail}); not merging into main, which deploys ${t.name}.`);
  let m: any;
  try {
    m = await github(`/repos/${c.slug}/pulls/${c.pr}/merge`, { method: 'PUT', body: { merge_method: await mergeMethodOf(c.slug!), sha: head, commit_title: `${c.title} (#${c.pr})` } });
  } catch (e: any) {
    // Main moved again between the update and the merge: up to date once more, and it merges once green.
    const again = MERGE_REFUSED.test(String(e.message ?? e)) ? await updateFromBase(c.id) : null;
    if (again && (again.state === 'merged' || again.state === 'conflict')) return holdForMain(c, again, by, origin);
    throw new Error(`Merging into main failed: ${e.message ?? e}. If main changed the same files, revise ${c.id} so the agent updates its branch from main.`);
  }
  const sha = String(m.sha ?? '').slice(0, 7);
  db.prepare('UPDATE changes SET merged_at = ?, conflicts = NULL, approved = NULL WHERE id = ?').run(Date.now(), c.id);
  noteTiming(c.id, 'merged');
  update(c.id, {
    status: 'merged',
    detail: `merged into main by ${by}: ${sha}. CI runs on main, then the server deploys ${t.name} itself (it waits for runs, agents and Talk answers, and rolls back if unhealthy): GET /api/self-deploys`,
    notes: [...getChange(c.id)!.notes, { at: Date.now(), by, text: `approved and merged into main (${t.name} deploys itself)` }],
  });
  remember(c.id);
  await cleanup(c.id, { deleteBranch: true });
  return getChange(c.id);
}

/** Main moved under an approved Studio/Gen change: J's approval is kept while the branch catches up (approveInfra). */
function holdForMain(c: Change, up: { state: string; files?: string[]; sha?: string }, by: string, origin?: string | null) {
  const keep = J({ by, origin: origin ?? c.origin ?? null, at: Date.now() });
  db.prepare('UPDATE changes SET approved = ? WHERE id = ?').run(keep, c.id);
  if (up.state === 'conflict') {
    if (!resolveConflicts(c.id, up.files ?? [])) {
      db.prepare('UPDATE changes SET approved = NULL WHERE id = ?').run(c.id);
      throw conflictError(getChange(c.id)!, up.files ?? []);
    }
    update(c.id, { notes: [...getChange(c.id)!.notes, { at: Date.now(), by, text: `approved; ${c.base} moved and conflicts, so its agent resolves that first, then it merges once CI is green` }] });
    return getChange(c.id);
  }
  update(c.id, {
    detail: `${c.base} moved: merged it into the branch (no conflicts); merging into ${c.base} once CI on ${String(up.sha).slice(0, 7)} is green (approved by ${by})`,
    notes: [...getChange(c.id)!.notes, { at: Date.now(), by, text: `approved; ${c.base} moved, so the branch was brought up to date and merges once CI is green` }],
  });
  void mergeApprovedInfra(c.id).catch((e) => console.warn(`[studio] approved merge ${c.id}: ${e.message ?? e}`));
  return getChange(c.id);
}

/** Approved changes whose merge waits on CI here (one wait each). */
const awaitingMerge = new Set<string>();
/**
 * An approved Studio/Gen change that main held up (approveInfra): once CI on its updated branch is green (and, after a
 * conflict pass, its checks passed), it merges on J's approval, with one line to J. Red CI, failed checks, or a conflict
 * its agent couldn't resolve: not merged, the approval dropped, one line saying why. Revised or closed meanwhile: nothing.
 */
export async function mergeApprovedInfra(id: string) {
  const c = getChange(id);
  if (!c?.infra || !c.approved || c.status !== 'ready' || awaitingMerge.has(id)) return null;
  awaitingMerge.add(id);
  const a = parse(c.approved) as { by: string; origin?: string | null };
  const name = getInfra(c.product).name;
  const walking = a.by === WALK_AWAY_BY;
  const drop = async (why: string, red = false) => {
    db.prepare('UPDATE changes SET approved = NULL WHERE id = ?').run(id);
    update(id, { detail: `not merged into ${c.base}: ${why}`.slice(0, 300) });
    addLog(id, `approved merge into ${c.base} stopped: ${why}`);
    // Walk-away mode's own merge: red CI or failed checks go back to its agent (a fix pass), anything else waits for J.
    if (walking) return red ? walkAwayFix(id, why) : walkAwayStuck(id, why);
    const { tellAbout } = await import('./followup.ts');
    await tellAbout(getChange(id)!, `Not merged: ${c.title ?? id}`, `${name} change ${id} ("${c.title}") was approved but didn't merge into ${c.base}: ${why.slice(0, 300)}. Nothing deployed. Revise it, or approve it again once it's fixed: ${PUBLIC_URL}/#changes/${id}`).catch(() => {});
    return null;
  };
  try {
    let merged: Change | null = null;
    // Main moving again while it waits: up to date once more (approveInfra), and it waits for CI on that.
    for (let cur = c; ; cur = getChange(id)!) {
      if (cur.verify?.outcome === 'failed') return await drop(`its checks failed after ${c.base} moved (${String(cur.verify.summary ?? '').slice(0, 200)})`, true);
      const sha = String(cur.verify?.sha ?? '');
      const ci = await ciChecks(c.slug, sha, { onWait: (d) => update(id, { detail: `${d}: it merges into ${c.base} once CI is green (approved by ${a.by})` }) });
      const now = getChange(id)!;
      // Revised, closed or merged meanwhile: that's someone else's call now.
      if (!now.approved || now.status !== 'ready' || now.verify?.sha !== sha) return null;
      update(id, { verify: { ...now.verify, ci } });
      if (ci.state !== 'success') return await drop(`CI on ${sha.slice(0, 7)} isn't green (${ci.state}: ${ci.detail}); red CI never merges`, ci.state === 'failure');
      try {
        merged = await critical(`merging ${id} into main`, () => approveInfra(getChange(id)!, a.by, a.origin));
      } catch (e: any) {
        return await drop(isConflict(e) ? `it still conflicts with ${c.base} after ${CONFLICT_PASSES} conflict passes by its agent` : String(e.message ?? e));
      }
      if (merged?.status === 'merged') break;
      // A conflict this time: its agent's pass ends in a merge of its own (workInfra).
      if (merged?.status !== 'ready') return merged;
    }
    const how = c.conflicts ? `its agent resolved the conflicts (${c.conflicts} conflict pass${c.conflicts === 1 ? '' : 'es'}, not counted as tries)` : `Studio brought its branch up to date (no conflicts)`;
    addLog(id, `merged into ${c.base} on ${a.by}'s approval once CI was green`);
    const { tellAbout } = await import('./followup.ts');
    await tellAbout(merged, `Merged: ${c.title ?? id}`, `${name} change ${id} ("${c.title}") merged into ${c.base} ${walking ? 'by itself (walk-away mode)' : 'on your approval'}: ${c.base} had moved, ${how}, and CI went green. ${name} deploys itself next.`).catch(() => {});
    if (walking) {
      update(id, { auto_merge: 'merged' });
      walkAwayLog(merged!, `merged ${id} (${c.title}) into ${c.base} by itself after bringing it up to date: CI green`);
    }
    return merged;
  } finally {
    awaitingMerge.delete(id);
  }
}

// ------------------------------------------------------------ walk-away mode (Studio and Gen)

/** Protected files (FORBIDDEN always, and GUARDED unless J named them in `words`) a Studio/Gen change touches: those wait for J. */
export function protectedTouched(target: string, files: string[], words = '') {
  return guardFiles(target, files, words).map((b) => b.file);
}

/** A line in the PM's decision log for what walk-away mode did on its own. */
function walkAwayLog(c: Pick<Change, 'id' | 'task' | 'product'>, detail: string) {
  void import('./roadmap.ts').then(({ logDecision }) => logDecision('walk-away', c.task ?? c.id, c.product, detail)).catch(() => {});
}

/** Walk-away merges being decided now (one at a time per change). */
const walking = new Set<string>();

/**
 * Walk-away mode (walkaway.ts): a ready Studio/Gen change merges into main by itself, as product changes merge into
 * beta (J, 2026-10-18: "just merge okay?"). Only when its checks passed (typecheck, tests, the smoke check) and CI on its
 * head is green; through approveInfra (brought up to date with main first; a moved main waits for CI on the updated
 * head, mergeApprovedInfra; a conflict is its agent's conflict pass), by WALK_AWAY_BY. The server's deploy keeps its
 * health check and rollback. Red CI or failed checks: a fix pass of its agent (walkAwayFix), never a merge. Protected
 * files: it waits for J (his Inbox card). One Talk line per merge. Off, or anything else: nothing happens here.
 * auto_merge on an infra change: null (not decided), 'trying', 'merged', 'held: <why>' (waits for J).
 */
export async function walkAwayMerge(id: string) {
  if (!walkAwayOn()) return null;
  const c = getChange(id);
  if (!c?.infra || c.status !== 'ready' || !c.pr || c.approved || running.has(id) || walking.has(id) || awaitingMerge.has(id)) return null;
  if (c.auto_merge && c.auto_merge !== 'trying') return null;
  walking.add(id);
  const name = getInfra(c.product).name;
  try {
    const v = c.verify ?? {};
    const sha = String(v.sha ?? '');
    const files = fs.existsSync(c.worktree) ? (await gitAsync(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`])).out.split('\n').filter(Boolean) : [];
    if (!files.length) return await walkAwayHold(c, `Studio can't see which files it changes (its worktree is gone): you decide`);
    const prot = protectedTouched(c.product, files, requestAndNotes(c));
    if (prot.length) return await walkAwayHold(c, `it changes protected files (${prot.join(', ')}): those always wait for you`);
    const checksOk = sha && (v.checks ?? []).every((k: any) => k.ok) && v.smoke?.ok !== false && (v.checks ?? []).length > 0;
    if (!checksOk) return await walkAwayFix(id, `its checks failed: ${String(v.summary ?? 'no checks on record').slice(0, 600)}`);
    const ci = await ciChecks(c.slug, sha, { waitMs: 0 }).catch((e: any) => ({ state: 'error', detail: String(e.message ?? e), runs: [] as any[] }));
    if (ci.state === 'success' || ci.state === 'failure') update(id, { verify: { ...(getChange(id)!.verify ?? {}), ci } });
    if (ci.state === 'failure') return await walkAwayFix(id, `CI on ${sha.slice(0, 7)} is red: ${ci.detail}`);
    // Still running, not started, or GitHub not answering: looked at again on the PM's next pass.
    if (ci.state !== 'success') {
      const detail = `walk-away: merges into ${c.base} by itself once CI on ${sha.slice(0, 7)} is green (${ci.detail})`.slice(0, 300);
      if (getChange(id)!.detail !== detail || c.auto_merge) update(id, { auto_merge: null, detail });
      return null;
    }
    update(id, { auto_merge: 'trying' });
    addLog(id, `walk-away: checks passed and CI green on ${sha.slice(0, 7)}: merging into ${c.base} by itself`);
    let r: Change | null;
    try {
      r = await critical(`merging ${id} into main`, () => approveInfra(getChange(id)!, WALK_AWAY_BY, c.origin ?? null));
    } catch (e: any) {
      const msg = String(e.message ?? e);
      if (/isn't green/.test(msg)) return await walkAwayFix(id, msg);
      return await walkAwayStuck(id, isConflict(e) ? `it still conflicts with ${c.base} after ${CONFLICT_PASSES} conflict passes by its agent` : msg);
    }
    if (r?.status === 'merged') {
      update(id, { auto_merge: 'merged' });
      walkAwayLog(r, `merged ${id} (${c.title}) into ${c.base} by itself: checks passed, CI green on ${sha.slice(0, 7)}`);
      const { tellAbout } = await import('./followup.ts');
      await tellAbout(r, `Merged: ${c.title ?? id}`, `${name} change ${id} ("${c.title}") merged into ${c.base} by itself (walk-away mode): typecheck, tests and the smoke check passed and CI is green. ${name} deploys itself next (it rolls back if it isn't healthy). ${PUBLIC_URL}/#changes/${id}`).catch(() => {});
    }
    // Otherwise main moved: it merges once CI on the updated head is green (mergeApprovedInfra), or its agent resolves a conflict first.
    return r;
  } finally {
    walking.delete(id);
  }
}

/** Waits for J (his Inbox's merge card says why): protected files, or something Studio can't settle itself. */
async function walkAwayHold(c: Change, why: string) {
  update(c.id, { auto_merge: `held: ${why}`.slice(0, 500), detail: `waits for you: ${why}`.slice(0, 300) });
  addLog(c.id, `walk-away: not merged by itself: ${why}`);
  walkAwayLog(c, `left ${c.id} (${c.title}) for J: ${why}`);
  const { tellAbout } = await import('./followup.ts');
  await tellAbout(getChange(c.id)!, `Waits for you: ${c.title ?? c.id}`, `${getInfra(c.product).name} change ${c.id} ("${c.title}") didn't merge by itself: ${why}. It's in your Inbox. ${PUBLIC_URL}/#changes/${c.id}`).catch(() => {});
  return null;
}

/**
 * Red CI or failed checks in walk-away mode: its agent gets a fix pass with what failed (revise; the first isn't counted
 * as a try, then up to the PM's maxTries). Out of passes: walkAwayStuck (J's Inbox and phone).
 */
export async function walkAwayFix(id: string, why: string) {
  const c = getChange(id);
  if (!c) return null;
  const { pmSettings } = await import('./pm.ts');
  const max = pmSettings().maxTries;
  const n = (c.auto_fixes ?? 0) + 1;
  if (n - 1 > max) return walkAwayStuck(id, `still failing after ${n - 1} fix passes: ${why}`);
  if (!['ready', 'failed'].includes(c.status) || running.has(id)) return null;
  db.prepare('UPDATE changes SET auto_fixes = ? WHERE id = ?').run(n, id);
  const v = c.verify ?? {};
  const failed = [
    ...(v.checks ?? []).filter((k: any) => !k.ok).map((k: any) => `\`${k.cmd}\` failed:\n${String(k.out ?? '').slice(-1500)}`),
    v.smoke && !v.smoke.ok ? `The smoke check failed: ${v.smoke.detail}${v.smoke.log ? `\n${String(v.smoke.log).slice(-1000)}` : ''}` : '',
    v.ci?.state === 'failure' ? `CI failed: ${v.ci.detail}${(v.ci.runs ?? []).filter((r: any) => r.conclusion && r.conclusion !== 'success').map((r: any) => ` (${r.url})`).join('')}${v.ci.failure ? `\nWhat failed in its log:\n${v.ci.failure}` : ''}` : '',
  ].filter(Boolean).join('\n\n');
  const note = `Walk-away mode: this change didn't merge because ${why}. Fix what fails, run the checks again (npm run typecheck, npm test) and commit; it merges into ${c.base} by itself once everything is green.${failed ? `\n\n${failed}` : ''}`;
  addLog(id, `walk-away: fix pass ${n} (${n === 1 ? 'not counted as a try' : `try ${n - 1} of ${max}`}): ${why.slice(0, 200)}`);
  walkAwayLog(c, `sent ${id} (${c.title}) back to its agent, fix pass ${n}${n === 1 ? ' (not a try)' : ` (try ${n - 1} of ${max})`}: ${why.slice(0, 400)}`);
  return revise(id, note, WALK_AWAY_BY);
}

/** Failed after all its fix passes (or a merge Studio can't make): J's call, in his Inbox and on his phone (askJ). */
async function walkAwayStuck(id: string, why: string) {
  const c = getChange(id)!;
  update(id, { auto_merge: `held: ${why}`.slice(0, 500), detail: `waits for you: ${why}`.slice(0, 300) });
  addLog(id, `walk-away: stopped: ${why}`);
  walkAwayLog(c, `gave ${id} (${c.title}) to J: ${why.slice(0, 400)}`);
  const { askJ } = await import('./pm.ts');
  askJ(`${getInfra(c.product).name} change "${c.title ?? id}" couldn't merge into ${c.base} by itself: ${why.slice(0, 500)}. Try again, or close it?`,
    { subject: id, product: c.product, options: ['try again', 'close it'], recommend: 'try again', blocks: `merging ${id} into ${c.base}`, from: 'walk-away: failed after its tries' });
  return null;
}

/** Ready Studio/Gen changes walk-away mode hasn't decided yet (the PM's pass, and after a restart). */
export function walkAwayPending() {
  if (!walkAwayOn()) return [];
  const out: string[] = [];
  for (const c of listChanges({ status: 'ready', limit: 100 })) {
    if (!c.infra || c.approved || running.has(c.id) || (c.auto_merge && c.auto_merge !== 'trying')) continue;
    out.push(c.id);
    void walkAwayMerge(c.id).catch((e) => console.warn(`[studio] walk-away merge ${c.id}: ${e.message ?? e}`));
  }
  return out;
}

/**
 * The commit an approval merges: the pull request's head, which must be the branch tip that was verified. Refuses when
 * the pull request isn't open (merged or closed outside Studio: whatever came after that never reaches beta through it)
 * or when its head moved after verification (a push nobody verified).
 */
async function verifiedHead(c: Change) {
  const verifiedSha = c.verify?.sha || (fs.existsSync(c.worktree) ? (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out : '');
  let pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
  // Right after Studio pushes, GitHub can report the old head for a few seconds: on 2026-10-17 an automatic merge read
  // the previous commit a moment after the agent's push and refused. Read again before calling it moved (up to ~20 s).
  for (let i = 0; i < 7 && verifiedSha && pr.state === 'open' && String(pr.head?.sha ?? '') !== verifiedSha; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
  }
  const head = String(pr.head?.sha ?? '');
  if (pr.state !== 'open') {
    throw new Error(pr.merged
      ? `Pull request #${c.pr} was already merged (${String(pr.merged_at ?? '').slice(0, 16)}, outside this approval) at ${head.slice(0, 7)}; commits the agent pushed after that are not on ${c.base}. Revise ${c.id} so Studio opens a new pull request for them.`
      : `Pull request #${c.pr} is closed. Revise ${c.id} to open a new one, or close the change.`);
  }
  // Changes verified before Studio recorded the verified commit: the worktree's head is what was pushed and played.
  const verified = c.verify?.sha || (fs.existsSync(c.worktree) ? (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out : '');
  if (!verified) throw new Error(`${c.id} has no verified commit on record; revise it so it is verified again.`);
  if (head !== verified) throw new Error(`Pull request #${c.pr}'s head moved after verification (verified ${verified.slice(0, 7)}, now ${head.slice(0, 7)}): not merging what wasn't checked. Revise ${c.id} so the new head is checked.`);
  return head;
}

/** Conflict passes an agent gets on one conflict before J hears of it (resolveConflicts). */
export const CONFLICT_PASSES = 2;
/**
 * An error from approve(): the branch conflicts with its base; `conflict` names the files (the agent resolves them).
 * `uncompared`: GitHub says it conflicts but neither Studio's clone nor GitHub's compare could say where; `conflict` is
 * then the files the change touches (or none known), and it is still a conflict pass: its agent merges the base on a
 * full checkout, which names the files itself (2026-11-11, Sick of It PR #328: "could not compare the sides (not a
 * conflict)" left the change ready and unmerged for good).
 */
const conflictError = (c: Change, files: string[], uncompared = false) => Object.assign(new Error(uncompared
  ? `${c.base} moved and GitHub says the branch conflicts with it; Studio couldn't compare the two sides, so its agent merges ${c.base} on a full checkout${files.length ? ` (the change touches ${files.slice(0, 10).join(', ')})` : ''}`
  : `${c.base} moved and the branch conflicts with it${files.length ? ` in ${files.slice(0, 10).join(', ')}` : ''}`), { conflict: files, uncompared });
export const isConflict = (e: unknown): e is Error & { conflict: string[]; uncompared?: boolean } => Array.isArray((e as any)?.conflict);
/** A conflict error that names nothing to resolve: no shared file, and not an uncompared one (never a conflict pass). */
const nothingShared = (e: Error & { conflict: string[]; uncompared?: boolean }) => !e.conflict.length && !e.uncompared;
/** The files a pull request touches (up to 100), [] when GitHub doesn't say. */
const prFiles = (c: Pick<Change, 'slug' | 'pr'>) => github(`/repos/${c.slug}/pulls/${c.pr}/files?per_page=100`).then((fs: any[]) => fs.map((f) => String(f.filename))).catch(() => [] as string[]);
/** GitHub refusing a merge because of the base (a conflict, "not mergeable", the base modified meanwhile). */
const MERGE_REFUSED = /not mergeable|merge conflict|base branch was modified|405|409/i;

/**
 * GitHub says the pull request conflicts with its base (mergeable false, state "dirty"). What tells a conflict when
 * Studio couldn't bring the branch up to date itself (updateFromBase skipped: no worktree here, e.g. a big Unity repo on
 * Cloud Run; J, 2026-11-04: PR #454 of Yoobaland refused six times in a row and was never handed to its agent).
 * GitHub works mergeability out lazily (null at first): asked once more after a moment.
 */
async function githubSaysConflict(c: Change) {
  for (let i = 0; i < 2; i++) {
    const p = await github(`/repos/${c.slug}/pulls/${c.pr}`).catch(() => null);
    if (p?.mergeable === false) return p.mergeable_state === 'dirty';
    if (p?.mergeable === true) return false;
    await new Promise((r) => setTimeout(r, Number(process.env.STUDIO_MERGE_RETRY_MS ?? 3000)));
  }
  return false;
}

/** The files both lists name, in the first list's order (what two sides changed in common). */
export const overlapOf = (mine: string[], theirs: string[]) => { const t = new Set(theirs); return [...new Set(mine)].filter((f) => t.has(f)); };

/**
 * The files a pull request really conflicts on when GitHub says it does (it only says "dirty"): what the branch changed
 * since it forked from its base, and what the base changed since, in common. Not every file the change touches (J,
 * 2026-11-08: a conflict pass on 15 new PNGs that beta never touched). [] when the sides share no file (a conflict git
 * reports for another reason), null when GitHub can't say.
 */
export async function githubConflictFiles(c: Pick<Change, 'slug' | 'base' | 'branch'>): Promise<string[] | null> {
  try {
    const names = (r: any) => (r.files ?? []).map((f: any) => String(f.filename));
    const mine = await github(`/repos/${c.slug}/compare/${encodeURIComponent(c.base)}...${encodeURIComponent(c.branch)}`);
    const fork = mine.merge_base_commit?.sha;
    if (!fork) return null;
    const theirs = await github(`/repos/${c.slug}/compare/${fork}...${encodeURIComponent(c.base)}`);
    // GitHub lists at most 300 files per comparison: past that it can't be sure which overlap.
    if ((mine.files ?? []).length >= 300 || (theirs.files ?? []).length >= 300) return null;
    return overlapOf(names(mine), names(theirs));
  } catch { return null; }
}

/**
 * Brings the pull request's branch current with its base on GitHub's side (PUT update-branch with expected_head_sha), for
 * when Studio couldn't do it in a worktree (no worktree, the fetch failed, a big Unity repo). The new head is what merges
 * (verify.sha). A conflict only when GitHub refuses with a conflict AND the two sides share at least one file
 * (githubConflictFiles); a refusal over no shared file, or any other trouble, is `failed`: never a conflict pass.
 */
export async function updateBranchOnGithub(id: string): Promise<{ state: 'current' | 'merged' | 'conflict' | 'failed'; files?: string[]; sha?: string; why?: string; uncompared?: boolean }> {
  const c = getChange(id);
  if (!c || !c.slug || !c.pr) return { state: 'failed', why: 'no pull request' };
  try {
    const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
    const head = String(pr.head?.sha ?? '');
    if (!head) return { state: 'failed', why: 'GitHub gave no head sha' };
    if (pr.state && pr.state !== 'open') return { state: 'failed', why: `pull request #${c.pr} is ${pr.merged ? 'merged' : 'closed'}` };
    // Only the verified head is brought up to date: the new head becomes verify.sha, so updating a head nobody verified
    // would merge it unchecked (the merge-tip tests caught update-branch on a moved head, 2026-11-11).
    if (c.verify?.sha && head !== c.verify.sha) return { state: 'failed', why: `the head moved after verification (verified ${c.verify.sha.slice(0, 7)}, now ${head.slice(0, 7)})` };
    try {
      await github(`/repos/${c.slug}/pulls/${c.pr}/update-branch`, { method: 'PUT', body: { expected_head_sha: head } });
    } catch (e: any) {
      const msg = String(e.message ?? e);
      if (/up.to.date|no new commits|already/i.test(msg)) return { state: 'current', sha: head };
      if (/conflict|dirty|not mergeable/i.test(msg)) {
        const both = await githubConflictFiles(c);
        if (both && both.length) return { state: 'conflict', files: both };
        // GitHub can't compare the sides (too many files, its compare failed): GitHub's own merge says it conflicts, so it
        // is a conflict, for its agent on a full checkout; never "not a conflict", which left nobody to act on it.
        if (!both) return { state: 'conflict', files: await prFiles(c), uncompared: true };
        return { state: 'failed', why: `GitHub refused to update the branch (${msg.slice(0, 200)}) but the two sides share no file` };
      }
      return { state: 'failed', why: msg.slice(0, 200) };
    }
    // GitHub makes the merge commit in the background: the head moves a moment later.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, Number(process.env.STUDIO_MERGE_RETRY_MS ?? 3000)));
      const now = await github(`/repos/${c.slug}/pulls/${c.pr}`).catch(() => null);
      const sha = String(now?.head?.sha ?? '');
      if (sha && sha !== head) {
        update(id, { verify: { ...(c.verify ?? {}), sha } });
        addLog(id, `${c.base} moved: GitHub brought the branch up to date (update-branch) and ${sha.slice(0, 7)} is what merges`);
        return { state: 'merged', sha };
      }
    }
    return { state: 'failed', why: 'GitHub accepted update-branch but the head did not move' };
  } catch (e: any) { return { state: 'failed', why: String(e.message ?? e).slice(0, 200) }; }
}

/**
 * The base branch moved (GitHub's push webhook, server push): ready changes of that repo that couldn't merge by themselves
 * try again. Never a timer.
 */
export function onBaseMoved(repoFolder: string) {
  // A pull request merged on GitHub moves beta: its ready change is marked merged now (no timer), before any retry.
  void syncMergedOutside(repoFolder).catch((e) => console.warn(`[studio] merged outside Studio: ${e.message ?? e}`));
  for (const c of listChanges()) {
    if (c.repo !== repoFolder || c.infra || c.status !== 'ready' || !c.pr || !String(c.auto_merge ?? '').startsWith('failed')) continue;
    void autoMergeBeta(c.id).catch((e) => console.warn(`[studio] auto-merge ${c.id} after ${c.base} moved: ${e.message ?? e}`));
  }
}

/**
 * A person's (or the PM's, or walk-away's) merge that met a conflict: its own agent resolves it, like an automatic
 * merge does (J, 2026-11-04: "it should be able to deal with the merge conflicts"). The error says so, and carries
 * `resolving` so a caller doesn't start a pass of its own; with the passes used up, it says J decides.
 */
function conflictHandled(id: string, e: Error & { conflict: string[] }) {
  // No file really conflicts: never a pass, never an Inbox card.
  if (nothingShared(e)) return Object.assign(new Error(`${e.message} (no shared file: not a conflict pass)`), { conflict: e.conflict });
  if (resolveConflicts(id, e.conflict)) {
    const c = getChange(id)!;
    return Object.assign(new Error(`${e.message}: its agent is resolving the conflicts (conflict pass ${c.conflicts} of ${CONFLICT_PASSES}, not a try); it merges once they're resolved`), { conflict: e.conflict, resolving: true });
  }
  // The passes are used up: J decides, once (the PM leaves a change alone while J is asked about it, so its minute
  // tick doesn't try the same merge again and again).
  if ((getChange(id)?.conflicts ?? 0) >= CONFLICT_PASSES) void conflictStuck(id, e.message).catch((x) => console.warn(`[studio] conflict question ${id}: ${x.message ?? x}`));
  return Object.assign(new Error(`${e.message}, and its agent already had ${CONFLICT_PASSES} conflict passes: revise it or close it`), { conflict: e.conflict });
}

/** The last merge of a change that failed for another reason (approve): the same failure isn't asked of GitHub again for a minute, and Talk hears it once. */
const mergeFailed = new Map<string, { at: number; why: string; told: number }>();
const MERGE_FAIL_QUIET_MS = 60_000;
const MERGE_NOTICE_QUIET_MS = 30 * 60_000;

/**
 * Brings a ready product change's branch up to date with its base before it merges (J, 2026-10-18: four Sick Of It
 * tasks hit "Pull request has merge conflicts" because another task merged into beta first). Up to date already:
 * nothing. Behind: origin/<base> is merged into the worktree; a clean merge is pushed, and that commit is what merges
 * (verify.sha: the agent's checks passed on its side, the base's on the other). A conflict is aborted, the files
 * named: resolveConflicts gives it to the agent. Skipped (no worktree, git trouble): the merge goes on as before.
 */
export async function updateFromBase(id: string): Promise<{ state: 'current' | 'merged' | 'conflict' | 'skipped'; files?: string[]; sha?: string; why?: string }> {
  const c = getChange(id);
  if (!c || !c.worktree || !fs.existsSync(c.worktree)) return { state: 'skipped', why: 'no worktree' };
  const repoDir = path.join(PROJECTS, c.repo);
  assertWorktree(c.worktree, repoDir);
  const f = await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
  if (!f.ok) return { state: 'skipped', why: `fetch failed: ${f.err.slice(0, 200)}` };
  if (!(await gitAsync(c.worktree, ['rev-parse', '--verify', '--quiet', `origin/${c.base}`])).ok) return { state: 'skipped', why: `no origin/${c.base}` };
  const untracked = await untrackNotes(c.worktree);
  if (untracked) addLog(id, `${NOTES} was committed on the branch: Studio took it out of git (the notes stay in the worktree)`);
  const current = (await gitAsync(c.worktree, ['merge-base', '--is-ancestor', `origin/${c.base}`, 'HEAD'])).ok;
  if (current && !untracked) return { state: 'current' };
  const before = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out;
  if (!current) {
    // A merge writes over ignored files, and .hawkes/ may be tracked on the base: the notes are kept aside and put back.
    let notes = snapshotNotes(c.worktree);
    const merge = () => gitAsync(c.worktree, [...STUDIO_GIT, 'merge', ...MERGE_QUIET, '--no-ff', '--no-edit', '-m', `Merge ${c.base} into ${c.branch} (Hawkes Studio: ${c.base} moved)`, `origin/${c.base}`]);
    const unmerged = async () => (await gitAsync(c.worktree, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
    let m = await merge();
    let files = m.ok ? [] : await unmerged();
    // A light clone that couldn't fetch the other side's file contents while merging (the promisor remote: Sick of It
    // PR #328, 2026-11-11): Studio fetches exactly what the merge needs itself, with the repo's credentials, and merges
    // once more. Only a merge that still can't read the sides is "not a conflict" below.
    if (!m.ok && !files.length && PROMISOR_FETCH_FAILED.test(`${m.err}\n${m.out}`)) {
      await gitAsync(c.worktree, ['merge', '--abort']);
      await gitAsync(c.worktree, ['reset', '--hard', before]);
      restoreNotes(c.worktree, notes);
      notes = snapshotNotes(c.worktree);
      const got = await fetchMergeObjects(c.worktree, `origin/${c.base}`);
      addLog(id, `${c.base} moved: merging origin/${c.base} couldn't fetch file contents from the remote (${lastLines(m)}); ${got.ok ? `Studio fetched the ${got.count} the merge needs and merges again` : `fetching them failed too (${got.why})`}`);
      if (got.ok) {
        m = await merge();
        files = m.ok ? [] : await unmerged();
      }
    }
    // Only agents' notes conflict (each change writes its own summary.md, try.md, learned.md): none of them belong in git.
    const notesOnly = !m.ok && files.length > 0 && files.every((f) => f.startsWith(NOTES));
    if (!m.ok && !notesOnly) {
      await gitAsync(c.worktree, ['merge', '--abort']);
      await gitAsync(c.worktree, ['reset', '--hard', before]);
      restoreNotes(c.worktree, notes);
      // No unmerged file: git never got as far as comparing (credentials, a blob it couldn't fetch from the promisor
      // remote). That is a failure of the fetch, not a conflict: an agent can't resolve it and a pass must not be spent on it.
      if (!files.length) {
        const why = `merging origin/${c.base} failed before any file conflicted: ${lastLines(m)}`;
        addLog(id, `${c.base} moved: ${why} (not a conflict)`);
        return { state: 'skipped', why };
      }
      addLog(id, `${c.base} moved: merging origin/${c.base} into the branch conflicts in ${files.join(', ')}`);
      return { state: 'conflict', files };
    }
    await gitAsync(c.worktree, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', NOTES]);
    restoreNotes(c.worktree, notes);
    if (notesOnly || (await gitAsync(c.worktree, ['diff', '--cached', '--quiet'])).ok === false) {
      const done = await gitAsync(c.worktree, [...STUDIO_GIT, 'commit', '--no-verify', ...(notesOnly ? ['--no-edit'] : ['--amend', '--no-edit'])]);
      if (!done.ok) {
        await gitAsync(c.worktree, ['merge', '--abort']);
        await gitAsync(c.worktree, ['reset', '--hard', before]);
        restoreNotes(c.worktree, notes);
        return { state: 'skipped', why: `committing the merge failed: ${done.err.slice(0, 200)}` };
      }
    }
    if (notesOnly) addLog(id, `${c.base} moved: only agents' notes conflicted (${files.join(', ')}); Studio kept them out of git`);
  }
  const sha = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out;
  const lfsUp = await pushPendingLfs(c.worktree, gitAsync, (m) => addLog(id, m)).then(() => null, (e: any) => String(e.message ?? e));
  const p = lfsUp ? { ok: false, err: lfsUp } : await gitAsync(c.worktree, ['push', '--quiet', 'origin', `HEAD:${c.branch}`]);
  if (!p.ok) {
    await gitAsync(c.worktree, ['reset', '--hard', before]);
    return { state: 'skipped', why: `push failed: ${p.err.slice(0, 200)}` };
  }
  // The agent's group keeps writing here (a later pass): what Studio's git just wrote is shared again (sandbox.ts).
  await shareWorktree(c.worktree);
  update(id, { verify: { ...(c.verify ?? {}), sha } });
  addLog(id, current ? `pushed ${sha.slice(0, 7)} (${NOTES} out of git)` : `${c.base} moved: merged origin/${c.base} into the branch (no conflicts) and pushed ${sha.slice(0, 7)}`);
  return { state: 'merged', sha };
}

/** The last lines of a failed git command, for the log. */
const lastLines = (r: { out: string; err: string }) => (r.err || r.out).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);

/** A git command that failed because a light clone couldn't fetch objects it lacks (no credentials, the remote refused). */
export const PROMISOR_FETCH_FAILED = /could not fetch [0-9a-f]{7,64} from promisor remote|promisor remote|could not read (username|password)|terminal prompts disabled|authentication failed|could not read from remote repository/i;

/**
 * The objects a merge of `ref` into HEAD reads that a light clone (`--filter=blob:none`) doesn't have yet, fetched from
 * origin in one explicit, credentialed fetch per batch, the way git's own lazy fetch asks for them. A full clone has none
 * missing: nothing is fetched.
 *
 * Only what the merge reads (2026-11-13: this fetched every file of the merge base, HEAD and `ref`, the whole game: one
 * Yooba Land catch-up with beta brought its 2 GB of art and video into the cloud server's 2.5 GB disk, which is memory;
 * the disk sat full, every change waited for disk room, and each restart did it again as the catch-up ran once more):
 *   - files changed on both sides since the merge base: the three versions (git compares their contents),
 *   - a side's added files when that side deleted a file the other side changed (git looks for a rename),
 *   - files changed on `ref`'s side that this worktree checks out (its sparse patterns): `ref`'s version.
 * A file only one side changed and the worktree doesn't check out is merged by its name alone and never read.
 */
export async function fetchMergeObjects(worktree: string, ref: string): Promise<{ ok: boolean; count: number; why?: string }> {
  const mb = (await gitAsync(worktree, ['merge-base', 'HEAD', ref])).out;
  const list = await gitAsync(worktree, ['rev-list', '--objects', '--missing=print', '--no-walk', ...(mb ? [mb] : []), ref, 'HEAD']);
  if (!list.ok) return { ok: false, count: 0, why: lastLines(list) };
  const absent = new Set(list.out.split('\n').filter((l) => l.startsWith('?')).map((l) => l.slice(1).trim()).filter((o) => /^[0-9a-f]{40,64}$/.test(o)));
  if (!absent.size) return { ok: true, count: 0 };
  const needed = mb ? await mergeReads(worktree, mb, ref) : null;
  if (needed && !needed.ok) return { ok: false, count: 0, why: needed.why };
  const missing = needed ? [...needed.oids].filter((o) => absent.has(o)) : [...absent];
  for (let i = 0; i < missing.length; i += 1000) {
    const f = await gitAsync(worktree, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', 'origin', ...missing.slice(i, i + 1000)]);
    if (!f.ok) return { ok: false, count: i, why: lastLines(f) };
  }
  return { ok: true, count: missing.length };
}

/** A side's changes since the merge base by name (no renames: finding one would read the files): status letter → paths. */
async function sideChanges(worktree: string, from: string, to: string) {
  const r = await gitAsync(worktree, ['diff', '--no-renames', '--no-ext-diff', '--name-status', '-z', from, to]);
  if (!r.ok) return null;
  const parts = r.out.split('\0').filter(Boolean);
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) out.set(parts[i + 1], parts[i][0]);
  return out;
}

/** The blob ids at `rev` of `files` (`ls-tree` reads trees only, never a file's contents). */
async function blobsAt(worktree: string, rev: string, files: string[]) {
  const oids = new Set<string>();
  for (let i = 0; i < files.length; i += 500) {
    const r = await gitAsync(worktree, ['ls-tree', '-z', '--full-tree', rev, '--', ...files.slice(i, i + 500).map((f) => `:(literal)${f}`)]);
    if (!r.ok) continue;
    for (const e of r.out.split('\0')) { const m = /^\d+ blob ([0-9a-f]{40,64})\t/.exec(e); if (m) oids.add(m[1]); }
  }
  return oids;
}

/** Which of `files` this worktree checks out (its sparse patterns); all of them when it isn't sparse or git can't say. */
function checkedOut(worktree: string, files: string[]): string[] {
  if (!files.length) return [];
  const sparse = spawnSync('git', ['config', '--bool', 'core.sparseCheckout'], { cwd: worktree, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (sparse.stdout.trim() !== 'true') return files;
  const r = spawnSync('git', ['sparse-checkout', 'check-rules', '-z'], { cwd: worktree, input: files.join('\0') + '\0', encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : files;
}

/** What `git merge ref` into HEAD reads (fetchMergeObjects), as blob ids. */
export async function mergeReads(worktree: string, mb: string, ref: string): Promise<{ ok: true; oids: Set<string> } | { ok: false; why: string }> {
  const ours = await sideChanges(worktree, mb, 'HEAD');
  const theirs = await sideChanges(worktree, mb, ref);
  if (!ours || !theirs) return { ok: false, why: `listing what each side of the merge changed failed` };
  const both = [...ours.keys()].filter((f) => theirs.has(f));
  const bothSet = new Set(both);
  // A side that deleted a file the other changed: git looks among that side's new files for where it went.
  const renameTargets = (side: Map<string, string>) => [...side].some(([f, s]) => s === 'D' && bothSet.has(f)) ? [...side].filter(([, s]) => s === 'A').map(([f]) => f) : [];
  const oids = new Set<string>();
  const add = (s: Set<string>) => { for (const o of s) oids.add(o); };
  for (const rev of [mb, 'HEAD', ref]) add(await blobsAt(worktree, rev, both));
  add(await blobsAt(worktree, 'HEAD', renameTargets(ours)));
  add(await blobsAt(worktree, ref, renameTargets(theirs)));
  const written = checkedOut(worktree, [...theirs].filter(([f, s]) => s !== 'D' && !bothSet.has(f)).map(([f]) => f));
  add(await blobsAt(worktree, ref, written));
  return { ok: true, oids };
}

/** Agents' notes (brief, summary, try, learned, video.json): Studio reads them from the worktree; they never belong in git. */
const NOTES = '.hawkes/';
/**
 * A merge that prints no diffstat (2026-11-13): `git merge` ends by counting the lines of every file the other side
 * changed, and in a light clone (`--filter=blob:none`) counting reads each one, so git fetched them all. One Yooba Land
 * change behind beta pulled beta's new art and video, 2.5 GB, into the cloud server's 2.5 GB in-memory disk; the disk sat
 * full, every change waited for disk room, and each restart did it again when the catch-up ran once more.
 */
export const MERGE_QUIET = ['--no-stat'];
const STUDIO_GIT = ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai', '-c', 'core.hooksPath=/dev/null'];

/**
 * .git/info/exclude only keeps untracked notes out; once a commit had them (Dose Of Destruction's video passes,
 * 2026-10-22), every later change edited them and any two changes conflicted on them (J, 2026-10-24: a video's
 * "Approve and post drafts" stopped on .hawkes/summary.md). Takes them out of the branch's index, files kept.
 */
async function untrackNotes(worktree: string) {
  if (!(await gitAsync(worktree, ['ls-files', '--', NOTES])).out) return false;
  const exclude = path.resolve(worktree, (await gitAsync(worktree, ['rev-parse', '--git-common-dir'])).out, 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').includes(NOTES)) fs.appendFileSync(exclude, `\n${NOTES}\n`);
  await gitAsync(worktree, ['rm', '-r', '--cached', '--quiet', '--', NOTES]);
  const r = await gitAsync(worktree, [...STUDIO_GIT, 'commit', '--no-verify', '--quiet', '-m', `Keep ${NOTES} out of git (Hawkes Studio: agents' notes)`]);
  if (!r.ok) await gitAsync(worktree, ['reset', '--quiet', 'HEAD', '--', NOTES]);
  return r.ok;
}
function snapshotNotes(worktree: string) {
  const dir = path.join(worktree, NOTES);
  if (!fs.existsSync(dir)) return null;
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-notes-'));
  fs.cpSync(dir, copy, { recursive: true });
  return copy;
}
function restoreNotes(worktree: string, copy: string | null) {
  const dir = path.join(worktree, NOTES);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!copy) return;
  fs.cpSync(copy, dir, { recursive: true });
  fs.rmSync(copy, { recursive: true, force: true });
}

/**
 * A conflict with the base goes back to the change's own agent: its session is resumed to merge the base and resolve
 * the conflicts keeping both sides' intent, then re-run its checks (a "conflict pass"). Not a try (the PM's tries are
 * for the work itself), and nobody is asked: when the pass finishes the change is ready again and merges by itself.
 * After CONFLICT_PASSES on the same conflict, false: it's stuck (the caller tells J). Revising by hand starts over.
 */
export function resolveConflicts(id: string, files: string[]) {
  const c = getChange(id);
  // No worktree here (a big repo on Cloud Run, a restart): the pass's prepare step makes it again from the branch.
  if (!c || c.status !== 'ready') return false;
  const n = (c.conflicts ?? 0) + 1;
  if (n > CONFLICT_PASSES) return false;
  db.prepare('UPDATE changes SET conflicts = ? WHERE id = ?').run(n, id);
  const note = conflictPrompt(c, files, conflictOpts(c, files));
  const ph: Phase = { step: 'prepare', note, conflict: files, since: Date.now() };
  update(id, { status: 'revising', detail: `${c.base} moved: its agent is resolving the conflicts (pass ${n} of ${CONFLICT_PASSES}, not a try)`, auto_merge: null, phase: ph, notes: [...c.notes, { at: Date.now(), by: 'Studio', text: `${c.base} moved: conflict pass ${n} (${files.join(', ') || 'conflicting files'})` }] });
  addLog(id, `conflict pass ${n} of ${CONFLICT_PASSES}: the agent merges origin/${c.base} and resolves the conflicts`);
  // Called from the end of its own pass (work() merging it): the conflict pass starts once that one has let go.
  const go = () => {
    if (running.has(id)) return void setTimeout(go, 200).unref();
    const land = claim(id);
    void syncToRemoteHead(id).catch((e) => addLog(id, `conflict pass: could not check the remote head (${String(e.message ?? e).slice(0, 120)})`)).then(() => work(id, note, undefined, ph, true)).finally(() => {
      land();
      remember(id);
      void pump();
    });
  };
  go();
  return true;
}

/**
 * Before a conflict pass: if the branch's head moved on GitHub (someone merged beta into it, update-branch), the worktree
 * is reset to that head, so the pass doesn't report conflicts from a stale local branch. Only a clean worktree whose HEAD
 * is an ancestor of the remote head is moved (nothing local is lost).
 */
export async function syncToRemoteHead(id: string) {
  const c = getChange(id);
  if (!c || !c.slug || !c.pr || !c.worktree || !fs.existsSync(path.join(c.worktree, '.git'))) return false;
  const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
  const remote = String(pr.head?.sha ?? '');
  const local = (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out;
  if (!remote || remote === local) return false;
  const f = await gitAsync(c.worktree, ['fetch', '--quiet', 'origin', c.branch]);
  if (!f.ok || !(await gitAsync(c.worktree, ['cat-file', '-e', `${remote}^{commit}`])).ok) return false;
  if (!(await gitAsync(c.worktree, ['merge-base', '--is-ancestor', local, remote])).ok) return false;
  const r = await gitAsync(c.worktree, ['reset', '--hard', remote]);
  if (!r.ok) return false;
  await shareWorktree(c.worktree);
  update(id, { verify: { ...(c.verify ?? {}), sha: remote } });
  addLog(id, `the branch moved on GitHub (${local.slice(0, 7)} -> ${remote.slice(0, 7)}): the worktree is reset to it before the conflict pass`);
  return true;
}

/**
 * What a conflict pass left unresolved: the agent's own list (UNRESOLVED: files it couldn't resolve safely, e.g. the
 * same binary changed on both sides), else conflict markers its commit left in the conflicted files; null when clean.
 */
export function unresolvedConflicts(worktree: string, files: string[], committed = true) {
  const file = path.join(worktree, UNRESOLVED);
  if (fs.existsSync(file)) {
    const said = fs.readFileSync(file, 'utf8').trim();
    fs.renameSync(file, `${file}.${Date.now()}`);
    return `its agent couldn't resolve them safely: ${said.replace(/\s+/g, ' ').slice(0, 600) || files.join(', ')}`;
  }
  if (!committed || !files.length) return null;
  const marked = git(worktree, ['grep', '-lE', '^(<<<<<<<|>>>>>>>)( |$)', 'HEAD', '--', ...files.slice(0, 200)], 10_000).out
    .split('\n').filter(Boolean).map((l) => l.replace(/^HEAD:/, ''));
  return marked.length ? `its merge left conflict markers in ${marked.slice(0, 10).join(', ')}` : null;
}

/**
 * A conflict pass that didn't resolve safely: the branch goes back to where it was before the pass (nothing pushed, no
 * broken merge), no more passes, and the PM gets the files to decide (conflictStuck), like passes used up.
 */
async function conflictBack(id: string, ph: Phase, why: string) {
  const c = getChange(id)!;
  if (fs.existsSync(path.join(c.worktree, '.git'))) {
    await gitAsync(c.worktree, ['merge', '--abort']);
    if (ph.before) await gitAsync(c.worktree, ['reset', '--hard', ph.before]);
    await shareWorktree(c.worktree);
  }
  db.prepare('UPDATE changes SET conflicts = ? WHERE id = ?').run(CONFLICT_PASSES, id);
  const files = ph.conflict ?? [];
  const text = `${why} (conflicted with ${c.base}: ${files.slice(0, 20).join(', ') || 'files not named'})`;
  update(id, { status: 'ready', phase: null, auto_merge: `failed: ${text}`.slice(0, 500), detail: `couldn't merge into ${c.base}: ${text}`.slice(0, 300) });
  addLog(id, `conflict pass: ${text}; the branch is back where it was (nothing pushed), and the PM decides`);
  await conflictStuck(id, text, true).catch((x) => console.warn(`[studio] conflict question ${id}: ${x.message ?? x}`));
}

/** Truly stuck on a conflict (its agent failed CONFLICT_PASSES times): one line in Talk, and J decides in his Inbox. */
async function conflictStuck(id: string, why: string, unsafe = false) {
  const c = getChange(id)!;
  const { askJ } = await import('./pm.ts');
  askJ(unsafe ? `"${c.title ?? id}" can't merge into ${c.base}: ${why.slice(0, 700)}. Its branch is as it was before (nothing broken pushed). Try again, or close it?`
    : `"${c.title ?? id}" can't merge into ${c.base}: its agent tried ${CONFLICT_PASSES} times to resolve the conflicts with ${c.base} (${why.slice(0, 300)}) and it still conflicts. Try again, or close it?`,
    { subject: c.task ?? id, product: c.product, options: ['try again', 'close it'], recommend: 'try again', blocks: `merging ${id} into ${c.base}`, from: 'conflict passes used up' });
}

/**
 * J's approval: merge the pull request (squash) into beta. Nothing goes live: the beta site is rebuilt and beta is
 * playtested with the change in; going live is deploy() (the deploy plan, then "DEPLOY <product>").
 */
export async function approve(id: string, { confirm, by = 'J', origin, auto = false }: { confirm?: string; by?: string; origin?: string | null; auto?: boolean } = {}) {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (confirm !== `MERGE ${id}`) throw new Error(c.infra
    ? `Approving merges this change into main, and ${getInfra(c.product).name} deploys itself once CI passes (a restart). Send confirm: "MERGE ${id}" (J's call).`
    : `Approving merges this change into ${BETA} (the beta site; going live is a separate step). Send confirm: "MERGE ${id}" (J's call).`);
  if (!c.pr) throw new Error('This change has no pull request');
  if (c.infra) {
    if (c.status !== 'ready') throw new Error(`The change is ${c.status}, not ready to approve.`);
    return critical(`merging ${id} into main`, () => approveInfra(c, by, origin));
  }
  // An agent still on it moves the branch: what would be merged isn't what was verified.
  if (['queued', 'working', 'revising', 'verifying'].includes(c.status)) throw new Error(`The change is ${c.status}: its branch is still moving. Approve it once it's ready (verified).`);
  // A merge is a critical section (drain.ts): a deploy waits for it rather than cut it off between GitHub and Studio's records.
  return critical(`merging ${id} into ${BETA}`, async () => {
    // Changes opened before the beta lane target main: point them at beta first, so approving never goes live.
    if (c.base !== BETA) {
      await ensureBeta(path.join(PROJECTS, c.repo));
      await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { base: BETA } });
      db.prepare('UPDATE changes SET base = ? WHERE id = ?').run(BETA, id);
      addLog(id, `pull request #${c.pr} now targets ${BETA} (was ${c.base})`);
    }
    // Devtools saves in beta's working copy (dev.ts) go in first, so the merge sees them; a conflict there stops it.
    const { flushDev, pullDev } = await import('./dev.ts');
    const flushed = await flushDev(c.product, `before merging ${id}`);
    if ('conflict' in flushed && flushed.conflict) throw new Error(`Beta's working copy conflicts with beta (${flushed.conflict.join(', ')}); resolve that first (studio_dev_status).`);
    // The same merge failed moments ago (a caller trying again and again: J, 2026-11-04, six "Merge stopped" in 40 s): not
    // asked of GitHub again yet.
    const failed = mergeFailed.get(id);
    if (!auto && failed && Date.now() - failed.at < MERGE_FAIL_QUIET_MS) throw new Error(`Merging ${id} failed ${Math.round((Date.now() - failed.at) / 1000)} s ago: ${failed.why}. Not tried again for a minute; revise it if it needs changing.`);
    // Beta moved since the agent's pass: the branch is brought up to date first (a clean merge pushed; a conflict thrown,
    // and its agent resolves it).
    const up = await updateFromBase(id);
    if (up.state === 'conflict') {
      const e = conflictError(getChange(id)!, up.files ?? []);
      throw auto ? e : conflictHandled(id, e);
    }
    // Studio couldn't update it here (no worktree, fetch failed): GitHub does it. Only a real shared file is a conflict.
    if (up.state === 'skipped') {
      const ub = await updateBranchOnGithub(id);
      if (ub.state === 'conflict') {
        const e = conflictError(getChange(id)!, ub.files ?? [], ub.uncompared);
        throw auto ? e : conflictHandled(id, e);
      }
      if (ub.state === 'failed') addLog(id, `${up.why ?? 'not updated here'}; update-branch: ${ub.why} (not a conflict)`);
    }
    // The pull request's head is checked before the merge (a verified commit: the agent's, or Studio's merge of beta).
    let sha = await verifiedHead(getChange(id)!);
    let m: any;
    let retried = false;
    for (;;) try {
      // `sha`: GitHub refuses the merge if the pull request's head moved since the check above.
      m = await github(`/repos/${c.slug}/pulls/${c.pr}/merge`, { method: 'PUT', body: { merge_method: await mergeMethodOf(c.slug!), sha, commit_title: `${c.title} (#${c.pr})` } });
      break;
    } catch (e0: any) {
      let e = e0;
      const files = () => prFiles(c);
      // GitHub says it conflicts with beta (the branch couldn't be brought up to date here): a conflict like any other.
      // GitHub doesn't name the conflicting files: they are the ones both sides changed (githubConflictFiles); only when
      // GitHub can't compare, the ones the change touches.
      if (!isConflict(e) && MERGE_REFUSED.test(String(e.message ?? e)) && await githubSaysConflict(c)) {
        const both = await githubConflictFiles(c);
        if (both?.length) {
          addLog(id, `GitHub says the branch conflicts with ${c.base}; both sides changed ${both.slice(0, 10).join(', ')}`);
          e = conflictError(c, both);
        } else {
          // No shared file: not a conflict, never a pass or an Inbox card. Bring the branch current on GitHub and merge
          // once more. GitHub can't compare the sides: the same first, and if GitHub still says it conflicts, it is one
          // (its agent merges on a full checkout): never left ready and unmerged with nobody to act (Sick of It PR #328).
          addLog(id, both ? `GitHub says the branch conflicts with ${c.base}, but the two sides changed no file in common (not a conflict)`
            : `GitHub says the branch conflicts with ${c.base} and couldn't compare the sides: bringing it up to date on GitHub, else its agent merges ${c.base} on a full checkout`);
          if (!retried) {
            retried = true;
            const ub = await updateBranchOnGithub(id);
            if (ub.state === 'conflict') e = conflictError(c, ub.files ?? [], ub.uncompared);
            else if (ub.state === 'merged' || ub.state === 'current') { sha = await verifiedHead(getChange(id)!); continue; }
            else addLog(id, `update-branch: ${ub.why ?? 'failed'}`);
          }
          if (!isConflict(e) && !both) e = conflictError(c, await files(), true);
        }
      }
      if (isConflict(e)) throw auto ? e : conflictHandled(id, e);
      if (auto) throw e;
      // Anything else (an automatic merge says it in one line itself: autoMergeBeta): J hears it in Talk with the files,
      // once for a while, and the same merge isn't tried again for a minute.
      const why = String(e.message ?? e).slice(0, 300);
      const told = mergeFailed.get(id)?.told ?? 0;
      const tell = Date.now() - told > MERGE_NOTICE_QUIET_MS;
      mergeFailed.set(id, { at: Date.now(), why, told: tell ? Date.now() : told });
      if (tell) {
        const touched = await files();
        const { postNotice } = await import('./talk.ts');
        postNotice(`Merge stopped: ${c.title}`, `Merging ${id} (${c.pr_url}) into ${BETA} failed: ${why}\n\nThe change touches: ${touched.slice(0, 30).join(', ') || '(unknown)'}\n\nIf beta changed those files since (devtools saves or another change), ask the agent to update its branch from ${BETA} (revise ${id}) and approve again.`);
      }
      throw e;
    }
    mergeFailed.delete(id);
    void pullDev(c.product, `after merging ${id}`).catch((e) => console.warn(`[studio] beta working copy after ${id}: ${e.message ?? e}`));
    // Before beta's run starts: the PM matches beta's build after this time to the task (pm.ts followBuilds).
    db.prepare('UPDATE changes SET merged_at = ?, conflicts = NULL WHERE id = ?').run(Date.now(), id);
    noteTiming(id, 'merged');
    update(id, { status: 'merged', detail: `merged into ${BETA} by ${by}: ${String(m.sha ?? '').slice(0, 7)} (not live yet)`, notes: [...c.notes, { at: Date.now(), by, text: auto ? `merged into ${BETA} automatically (ready: the agent's checks passed)` : `approved and merged into ${BETA}` }], ...(auto ? { auto_merge: 'merged' } : {}) });
    remember(id);
    for (const f of c.findings) updateFinding(f, { status: 'fixed', note: `merged into ${BETA} in ${c.pr_url} (goes live with the next deploy)` });
    await cleanup(id, { deleteBranch: true });
    // A build fixer's change: rebuild the failed build on beta's head now, whatever triggers that build (buildfix.ts fixMerged).
    void import('./buildfix.ts').then((m) => m.fixMerged(id)).catch((e) => console.warn(`[studio] rebuild after ${id}: ${e.message ?? e}`));
    // Beta moved: its pre-deploy build, its build (Unity), the beta site and a local playtest of it follow, in the background.
    // A roadmap task's criteria are judged again on beta, on the scenario its agent wrote for them.
    // A fix for a project that reads fix-first or broken: ONE beta playtest + review follows the burst of merges (verdictwork.ts).
    void import('./verdictwork.ts').then((m) => m.noteMerge(c.product, id)).catch(() => {});
    void Promise.all([import('./pipeline.ts'), import('./taskbar.ts')]).then(([{ startBeta }, bar]) => {
      // A roadmap task's player goal goes into the focus, and its "[phone]" criteria play at 390x844 touch (taskbar.ts).
      const task = c.task ? getTask(c.task) : null;
      const focus = bar.focusWithGoals(`Just merged into beta: ${c.title}. Check it works and nothing regressed.`, task ? [task] : []);
      return startBeta(c.product, { focus, origin, merge: id, ...(c.criteria.some((k) => bar.PHONE.test(k)) ? { plays: bar.splitPlays(c.verify?.scenario, c.verify?.options, c.criteria), playtest: true } : { criteria: c.criteria, scenario: c.verify?.scenario, options: c.verify?.options }) });
    }).catch((e) => console.warn(`[studio] beta after ${id}: ${e.message ?? e}`));
    return getChange(id);
  });
}

/**
 * A ready product change goes into beta by itself (J, 2026-10-17: no Approve card, no PM gate), through approve()'s
 * merge (the devtools flush and pull, the critical section, the beta run after it). One that can't stays ready for a
 * person (the Changes tab's Merge button), with one line in Talk saying why; a merged one gets one line too. Never the
 * phone, never Studio or Gen (their merges into main stay J's). The PM still judges a task's criteria on beta.
 */
export async function autoMergeBeta(id: string) {
  if (isVideoTask(getChange(id)?.task)) return null; // J screens videos (videos.ts approveVideo merges them)
  const c = getChange(id);
  if (!c || c.infra || c.status !== 'ready') return null;
  const fail = async (why: string) => {
    update(id, { auto_merge: `failed: ${why}`.slice(0, 500), detail: `couldn't merge into ${BETA} by itself: ${why}`.slice(0, 300) });
    addLog(id, `not merged into ${BETA} automatically: ${why}`);
    const { autoMergeFailedNotice, tellAbout } = await import('./followup.ts');
    await tellAbout(getChange(id)!, `Couldn't merge: ${c.title ?? id}`, autoMergeFailedNotice(getChange(id)!, why)).catch((e) => console.warn(`[studio] auto-merge notice ${id}: ${e.message ?? e}`));
    return null;
  };
  // A canon conflict never merges by itself (acceptance.ts gate); a requested playtest that failed doesn't either.
  const g = gate(c.verify, c.criteria);
  if (!g.pass) return fail(g.why.join('; ').slice(0, 300));
  if (!c.pr) return fail('it has no pull request');
  const merge = () => approve(id, { confirm: `MERGE ${id}`, by: 'Studio (auto-merge)', origin: c.origin ?? null, auto: true });
  try {
    let merged;
    try {
      merged = await merge();
    } catch (e: any) {
      // GitHub refused because of beta (it moved again, or its mergeability lagged): up to date once more, one retry.
      if (isConflict(e) || !MERGE_REFUSED.test(String(e.message ?? e))) throw e;
      addLog(id, `GitHub wouldn't merge it (${String(e.message ?? e).slice(0, 160)}): bringing it up to date with ${BETA} and trying once more`);
      await new Promise((r) => setTimeout(r, Number(process.env.STUDIO_MERGE_RETRY_MS ?? 5000)));
      merged = await merge();
    }
    addLog(id, `merged into ${BETA} automatically`);
    const { autoMergedNotice, tellAbout } = await import('./followup.ts');
    const beta = await import('./dev.ts').then(({ betaUrl }) => betaUrl(getProduct(c.product))).catch(() => null);
    // A conflict its agent resolved: one line in Talk that it did (J, 2026-10-18: "I have no idea if it even worked").
    const title = c.conflicts ? `Conflict resolved: ${c.title ?? id}` : null;
    await tellAbout(merged!, title, `${autoMergedNotice(merged!, beta)}${c.conflicts ? ` Its branch conflicted with ${BETA}; its agent resolved it (${c.conflicts} conflict pass${c.conflicts === 1 ? '' : 'es'}, not counted as tries).` : ''}`).catch((e) => console.warn(`[studio] auto-merge notice ${id}: ${e.message ?? e}`));
    return merged;
  } catch (e: any) {
    // A conflict with beta: its own agent resolves it (no try, nobody asked); stuck after CONFLICT_PASSES, J decides.
    if (isConflict(e) && nothingShared(e)) return fail(`${String(e.message).slice(0, 200)} (no shared file: not a conflict pass)`);
    if (isConflict(e)) {
      if (resolveConflicts(id, e.conflict)) return null;
      const r = await fail(`it still conflicts with ${BETA} after ${CONFLICT_PASSES} conflict passes by its agent: ${String(e.message).slice(0, 200)}`);
      await conflictStuck(id, e.message).catch((x) => console.warn(`[studio] conflict question ${id}: ${x.message ?? x}`));
      return r;
    }
    return fail(String(e.message ?? e).slice(0, 300));
  }
}

/** J's note: the agent continues on the same branch. */
export function revise(id: string, note: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (!['ready', 'failed'].includes(c.status)) throw new Error(`The change is ${c.status}`);
  // A failed attempt of a task that has a newer one on its way stays ended: reviving it would run two beside each other.
  const other = c.task ? liveChangeOfTask(c.task, id) : null;
  if (other) throw new StudioError(`task ${c.task} already has change ${other.id} (${other.status}): revise that one, or close it first`, 409);
  // A person's revision: the conflict passes start over, and an approval waiting to merge (Studio/Gen) is for what was.
  db.prepare('UPDATE changes SET conflicts = NULL, approved = NULL, revisions = COALESCE(revisions, 0) + 1 WHERE id = ?').run(id);
  update(id, { status: 'queued', detail: 'queued for another pass', notes: [...c.notes, { at: Date.now(), by, text: note }] });
  // It waits its turn like any change: the pump starts it within the cap, the memory gate and the overlap rules. On
  // 2026-11-10 the PM revised ten failed changes at once, each started on the spot: 13 passes ran on a cap of 6 on a
  // Studio already short of memory.
  reviseNotes.set(id, note);
  void pump();
  return getChange(id);
}

/** The answer to an agent's question (from J, or Talk from what J decided): the agent resumes its own session. */
export function answerChange(id: string, answer: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (c.status !== 'needs answer') throw new Error(`The change is ${c.status}, not waiting for an answer`);
  if (!answer.trim()) throw new Error('Say the answer');
  update(id, { status: 'queued', detail: 'answered; the agent continues', notes: [...c.notes, { at: Date.now(), by, text: `answer: ${answer.slice(0, 500)}` }] });
  const land = claim(id);
  void work(id, undefined, `${by}: ${answer}`).finally(() => {
    land();
    remember(id);
    void pump();
  });
  return getChange(id);
}

/** Changes an agent is on, or is waiting to be on: the ones that can be cancelled. */
const CANCELLABLE = ['queued', 'working', 'verifying', 'revising', 'needs answer', 'waiting on Gen'];
/**
 * Cancels an agent change (Activity's Cancel, Talk's studio_cancel): the agent's unit is stopped, the branch and worktree
 * are kept, the status is `cancelled`. Not a failed try (attempts count failed and closed ones), not a harness stop, and the
 * PM never restarts it: only resumeChange or close does. Who and why are kept (cancel.ts).
 */
export async function cancelChange(id: string, by = 'J', reason?: string | null) {
  const c = getChange(id);
  if (!c) throw new StudioError('No such change');
  if (!CANCELLABLE.includes(c.status)) throw new StudioError(`Change ${id} is ${c.status}: there is nothing to cancel`);
  noteCancel(`change:${id}`, by, reason);
  const ph = phaseOf(id);
  update(id, {
    status: 'cancelled', detail: `cancelled ${cancelWords(cancelNote(`change:${id}`))}; its branch and worktree are kept (Resume or Close)`.slice(0, 300),
    notes: [...c.notes, { at: Date.now(), by, text: `cancelled${reason ? `: ${reason}` : ''}` }], ...(ph ? { phase: { ...ph, proc: undefined } } : {}),
  });
  addLog(id, `cancelled ${cancelWords(cancelNote(`change:${id}`))}`);
  if (ph?.proc) {
    stopDetached(ph.proc.rec);
    addLog(id, 'agent: its unit was stopped');
  }
  // Its verification's Gen jobs go too (queued or running; a finished one is left alone).
  for (const j of Object.values(ph?.jobs ?? {})) if (j) await gen.cancel(String(j)).catch(() => {});
  await cancelChangeBuilds(id, `its change was cancelled by ${by}`);
  return getChange(id);
}

/**
 * A cancelled or closed change's own builds (c/<id>) are cancelled too, so they don't hold Hawkes Gen's builders for a
 * change nobody will play (2026-11-10: the builds of two cancelled Yooba Land changes still waited in Gen's queue).
 */
async function cancelChangeBuilds(id: string, why: string) {
  try {
    const runs = db.prepare(`SELECT DISTINCT b.run FROM builds b JOIN runs r ON r.id = b.run WHERE b.change = ? AND b.status = 'building' AND r.status = 'running'`).all(id) as { run: string }[];
    if (!runs.length) return;
    const { cancelRun } = await import('./cancel.ts');
    for (const r of runs) await cancelRun(r.run, 'Studio', why).catch(() => {});
    addLog(id, `its build${runs.length > 1 ? 's' : ''} (${runs.map((r) => r.run).join(', ')}) cancelled too`);
  } catch { /* no builds table in some tests */ }
}

/** Carries on a cancelled change in its own worktree (the agent's session when it can); the PM never does this by itself. */
export function resumeChange(id: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new StudioError('No such change');
  if (c.status !== 'cancelled') throw new StudioError(`Change ${id} is ${c.status}, not cancelled`);
  const other = c.task ? liveChangeOfTask(c.task, id) : null;
  if (other) throw new StudioError(`task ${c.task} already has change ${other.id} (${other.status}) on its way: close one of them first`, 409);
  if (!c.worktree || !fs.existsSync(c.worktree)) throw new StudioError(`Change ${id} has no worktree any more: close it and start the task again`);
  assertWorktree(c.worktree, path.join(PROJECTS, c.repo));
  const old = phaseOf(id);
  const now = Date.now();
  update(id, {
    status: 'queued', detail: `resumed by ${by}: carries on in its own worktree`, notes: [...c.notes, { at: now, by, text: 'resumed' }],
    // at is back-dated by the harness gap: a person's resume starts now (resumeGate).
    phase: { step: 'agent', since: now, before: git(c.worktree, ['rev-parse', 'HEAD']).out, brain: old?.brain, harness: { kind: 'revive', line: `a person cancelled it and ${by} resumed it`, at: now - RESUME_GAP - 1, on: old?.brain ?? brainId(), parks: [] } },
  });
  addLog(id, `resumed by ${by}`);
  setTimeout(() => void pump(), 0).unref();
  return getChange(id);
}

export async function close(id: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  return critical(`closing ${id}`, () => closeNow(c, by));
}
async function closeNow(c: Change, by: string) {
  const id = c.id;
  // Closing while the agent is still in the worktree deletes the tree under it (ENOENT on .git). Stop it first.
  const ph = phaseOf(id);
  if (ph?.proc) {
    stopDetached(ph.proc.rec);
    addLog(id, 'stopping the agent before the worktree is removed');
  }
  if (c.pr) await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { state: 'closed' } }).catch(() => {});
  await cancelChangeBuilds(id, `its change was closed by ${by}`);
  update(id, { status: 'closed', detail: `closed by ${by}`, notes: [...c.notes, { at: Date.now(), by, text: 'closed' }] });
  remember(id);
  for (const f of c.findings) {
    const fd = getFinding(f);
    // Taken by this change (fixed with its note, or "fixing" from before 2026-10-17) and it won't land: open again.
    if (heldBy(fd, id)) updateFinding(f, { status: 'open' });
  }
  await cleanup(id, { deleteBranch: true });
  return getChange(id);
}

async function cleanup(id: string, { deleteBranch = false } = {}) {
  const c = getChange(id)!;
  if (!c.infra) await removePreview(c.product, id).catch(() => {});
  const repoDir = path.join(PROJECTS, c.repo);
  await gitAsync(repoDir, ['worktree', 'remove', '--force', c.worktree]).catch(() => {});
  // Always drop the folder (and its -site / .repos siblings): a failed `worktree remove` used to leave the tree on
  // Cloud Run's in-memory disk (2026-11-10: disk 2.0–2.7 GB of 4 GB before each kill).
  try {
    assertWorktreeRoot(c.worktree);
    const { removeChangeDirs } = await import('./disksweep.ts');
    // Its files gone, room may have freed: changes waiting for disk room look again (diskwait.ts). The sweep below only
    // tells them about what it clears itself, and this folder is gone before it measures.
    if (removeChangeDirs(c.worktree) > 0) diskWait.freed(`${id}'s worktree was removed`);
  } catch { /* not under .work, or already gone */ }
  await gitAsync(repoDir, ['worktree', 'prune']).catch(() => {});
  await gitAsync(repoDir, ['branch', '-D', c.branch]).catch(() => {});
  // A Unity change's website copy (its build).
  const copy = changeSiteDir(id);
  if (fs.existsSync(copy)) {
    const p = getProduct(c.product);
    await gitAsync(path.join(PROJECTS, p.site.split('/')[0]), ['worktree', 'remove', '--force', copy]).catch(() => {});
    await fs.promises.rm(copy, { recursive: true, force: true });
  }
  fs.rmSync(`${copy}.json`, { force: true });
  if (deleteBranch) await github(`/repos/${c.slug}/git/refs/heads/${c.branch}`, { method: 'DELETE' }).catch(() => {});
  void import('./disksweep.ts').then((d) => d.sweepNow({ say: (s) => addLog(id, s.replace(/^\[disksweep\] /, 'disk: ')) })).catch(() => {});
}

/**
 * A change that has ended (failed with or without commits, or already cleaned when empty): free its worktree. Commits
 * stay on the branch on GitHub (savework.ts); a revive remakes the worktree from that branch.
 */
async function endChangeDisk(id: string) {
  const c = getChange(id);
  if (!c?.worktree || !fs.existsSync(c.worktree)) return;
  await cleanup(id, { deleteBranch: false }).catch((e) => addLog(id, `worktree cleanup: ${String(e?.message ?? e).slice(0, 200)}`));
}

/**
 * The one way a pass on a change ends when it can't carry on: work()'s failure, the infra pass's, a resume that couldn't
 * carry on after a restart, the stuck watch giving up, and a restart loop. Owned by the pass that failed, so nothing else
 * has to come and find it.
 *   - retryAt: Studio tries the change again by itself. It goes back in the queue with its phase, holding no slot and no
 *     disk meanwhile, and the queue's one timer (pumpAt) starts it at that time.
 *   - otherwise it ends failed with why (the PM's own backoff takes it from there, pm.ts afterFailed).
 * Either way its worktree is freed (its commits are on its branch, savework.ts) and the queue looks again for the slot
 * it let go of. Before this each of those five places set the status itself, and three left the worktree on disk.
 */
export async function endPass(id: string, o: { detail: string; phase?: Phase | null; retryAt?: number; log?: string }) {
  if (o.log) addLog(id, o.log);
  const c = getChange(id);
  if (!c || ['cancelled', 'closed', 'merged'].includes(c.status)) return;
  if (o.retryAt && o.phase) {
    update(id, { status: 'queued', detail: o.detail.slice(0, 300), phase: { ...o.phase, notBefore: o.retryAt, proc: undefined } });
    await endChangeDisk(id);
    pumpAt(o.retryAt);
    return;
  }
  update(id, { status: 'failed', detail: o.detail.slice(0, 300), phase: o.phase === undefined ? { step: phaseOf(id)?.step ?? 'prepare', failed: true } : o.phase });
  await endChangeDisk(id);
  setImmediate(() => void pump());
}

/**
 * At most STUDIO_CHECKOUTS (default 2) worktree checkouts and dependency installs at once. Several big ones together
 * (a 1,256-file worktree plus npm ci each) were what the cloud server's memory couldn't hold on 2026-11-01: the git
 * process was killed (signal 9) and Studio restarted. The rest wait their turn; nothing is refused.
 */
let checkoutsActive = 0;
const checkoutWaiters: (() => void)[] = [];
let lowerUntil = 0;
/** A checkout was killed for memory (signal 9): one at a time for the next 10 minutes (J, 2026-11-05: make checkouts reliable). */
export function lowerCheckouts(now = Date.now()) { lowerUntil = now + 10 * 60_000; }
export const checkoutLimit = (now = Date.now()) => (now < lowerUntil || memLow() ? 1 : Math.max(1, Number(process.env.STUDIO_CHECKOUTS) || 2));
/**
 * Room for one more worktree beside the checkouts under way now (each counted at WORKTREE_NEED, this one included), or
 * why there is none ("... disk is full ..."). Called inside checkoutSlot, so two checkouts can't both see the same room.
 */
export async function diskRoomForCheckouts(id: string, active = checkoutsActive, others = [...running].filter((x) => x !== id).length): Promise<string | null> {
  const d = await import('./disksweep.ts');
  // No other change at work and no other checkout under way: this one is all the queue can start, and refusing it
  // would wait for work to end when none runs (2026-11-11: 59 of 72 changes waited that way for hours). Only a write
  // that can't fit at all refuses it then (disksweep.ts ensureDiskRoom alone).
  const alone = others === 0 && active <= 1;
  return d.ensureDiskRoom(d.WORKTREE_NEED * Math.max(1, active), { alone, say: (s) => addLog(id, s.replace(/^\[disksweep\] /, 'disk: ')) }).then(() => null, (e) => {
    const m = String(e?.message ?? e);
    if (/(in-memory|working) disk is full/.test(m)) return m;
    throw e;
  });
}
export const checkoutsUnderWay = () => checkoutsActive;
/**
 * How long one checkout may hold its turn. Each git step has its own 10 min limit, but a checkout is many steps (a clone,
 * beta, a fetch, the worktree, an install) and the turn had no end of its own: one that hung held every other change's
 * checkout behind it (stall-paths.md, Nov 11). At the limit the turn passes on; the slow checkout carries on outside it.
 */
export const CHECKOUT_TURN_MS = () => Math.max(1000, Number(process.env.STUDIO_CHECKOUT_TURN_MS) || 30 * 60_000);
let checkoutTurnSeq = 0;
export async function checkoutSlot<T>(fn: () => Promise<T>, o: { turnMs?: number; onLong?: () => void } = {}): Promise<T> {
  while (checkoutsActive >= checkoutLimit()) await new Promise<void>((r) => checkoutWaiters.push(r));
  checkoutsActive++;
  let held = true;
  // The turn is a wait of the shared rule (waits.ts): it records what it holds the line for and its deadline.
  const turn = `turn-${++checkoutTurnSeq}`;
  const turnMs = within('checkout-turn', o.turnMs ?? CHECKOUT_TURN_MS());
  beginWait('checkout-turn', turn, { waitsOn: 'the checkout in its turn finishing', deadlineMs: turnMs });
  const free = (how: 'event' | 'deadline') => {
    if (!held) return;
    held = false;
    endWait('checkout-turn', turn, how);
    checkoutsActive--;
    checkoutWaiters.shift()?.();
  };
  const timer = setTimeout(() => {
    console.warn(`[agents] a checkout held its turn for ${Math.round(turnMs / 60_000)} min: the next one goes ahead`);
    o.onLong?.();
    free('deadline');
  }, turnMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    free('event');
  }
}

/** Changes that failed on one finding in a UTC day before auto-fix stops starting it again (J, 2026-11-01). */
export const AUTO_FIX_FAILS_PER_DAY = 2;

/**
 * Why an automatic fix must not start for this finding now, or null. An earlier change of it still has an open pull
 * request (not merged or closed), or it already failed AUTO_FIX_FAILS_PER_DAY times today (UTC): on 2026-11-01 auto-fix
 * ran the same finding 4 times (PH Origins), 4 times (sign-in) and 3 times (an intro video) while Studio kept restarting.
 * J's own requests and the PM's answers to a question don't go through this.
 */
export function autoFixBlock(findingId: string, now = Date.now()): string | null {
  if (getFinding(findingId)?.status === 'wontfix') return "it is marked won't fix";
  const like = `%"${findingId}"%`;
  const open = db.prepare(`SELECT id, pr FROM changes WHERE findings LIKE ? AND pr IS NOT NULL AND status NOT IN ('merged', 'closed') ORDER BY created DESC LIMIT 1`).get(like) as { id: string; pr: number } | undefined;
  if (open) return `${open.id} already has pull request #${open.pr} open for it`;
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const failed = (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE findings LIKE ? AND status = 'failed' AND COALESCE(detail, '') NOT LIKE ? AND COALESCE(detail, '') NOT LIKE ? AND NOT ${STUDIO_FAILED_SQL} AND created >= ?`).get(like, `${DECIDED}%`, `${ALREADY}%`, day.getTime()) as { n: number }).n;
  if (failed >= AUTO_FIX_FAILS_PER_DAY) return `it already failed ${failed} times today`;
  return null;
}

/** After a daily run: start fixes for new findings worth fixing, within the day's budget. */
export function autoFix(runId: string) {
  const s = agentSettings();
  if (!s.enabled || !s.autoFix || !githubReachable()) return [];
  const started: string[] = [];
  const fresh = db.prepare(`SELECT * FROM findings WHERE status = 'open' AND last_run = ? ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'bug' THEN 1 ELSE 2 END, seen DESC`).all(runId) as any[];
  const byProduct = new Map<string, any>();
  for (const f of fresh) {
    if (!s.severities.includes(f.severity) || byProduct.has(f.product)) continue;
    const block = autoFixBlock(f.id);
    if (block) { console.log(`[studio] auto-fix skips ${f.id}: ${block}`); continue; }
    byProduct.set(f.product, f);
  }
  for (const [product, f] of byProduct) {
    try {
      started.push(startFix(product, [f.id], { auto: true }));
    } catch {
      // The budget is used (a product already being fixed queues the new one behind it): skip.
    }
  }
  return started;
}

/**
 * After a restart (a deploy): changes that were being worked on carry on from their recorded step, reattached to the
 * same agent process and Gen jobs (work()). Ones with no step recorded (from before steps were) go back to the queue.
 */
/** Restarts in a row at one step (each within RESTART_WINDOW_MS of the last) before a change stops being resumed (ops.ts). */
export { RESTART_LOOP };

/**
 * A change whose work is committed and whose pull request is open, cut off again and again in its finish step (the
 * preview build, the canon check): it is carried to ready (and beta's automatic merge) as it stands instead of being
 * failed (2026-11-01: c_28347ae3cb6d had committed and opened phoriginswebsite PR 36, then failed after 3 restarts).
 * Returns whether it did. approve() still refuses a head that moved, so nothing unchecked merges.
 */
export function carryFinishedToReady(c: Change, ph: Phase, why?: string): boolean {
  if (!c.pr || !['verify', 'finish'].includes(ph.step) || ph.requested) return false;
  let tip = ph.tip ?? '';
  if (!tip && c.worktree && fs.existsSync(c.worktree)) tip = git(c.worktree, ['rev-parse', 'HEAD']).out;
  if (!tip) return false;
  const done = { ...(c.verify ?? {}), ...(ph.verify ?? {}), sha: tip, preview: c.verify?.preview ?? null, try: c.verify?.try ?? null };
  const auto = agentSettings().autoMergeBeta;
  update(c.id, { status: 'ready', detail: readyDetail(done), verify: done, phase: null, auto_merge: auto ? 'trying' : null });
  addLog(c.id, `${why ?? `Studio restarted ${RESTART_LOOP}+ times in its ${ph.step} step`}, but its pull request #${c.pr} is open and the work committed (${tip.slice(0, 7)}): ready${auto ? ', merging into beta' : ''}`);
  if (auto) void autoMergeBeta(c.id).catch((e) => console.warn(`[studio] auto-merge ${c.id}: ${e.message ?? e}`));
  return true;
}

/** Carries a change on from its recorded step after `wait` ms (a failure outside work()'s own handling is logged, never an unhandled rejection). */
function launchResume(c: Change, ph: Phase, wait: number) {
  let land = claim(c.id);
  const gen = passGen(c.id);
  waitingStart.add(c.id);
  void new Promise((r) => setTimeout(r, wait))
    // After a restart every change comes back: each carries on only when there is memory for it (memgate.ts).
    .then(() => memRoom(() => inFlight, () => addLog(c.id, `waiting for memory before carrying on (${memSummary()})`)))
    .then(() => {
      waitingStart.delete(c.id);
      // Given up on while it waited (checkStuck): the pass that took over owns the change.
      if (passGen(c.id) !== gen) return;
      land();
      land = claim(c.id, { flight: true });
      return work(c.id, undefined, undefined, ph);
    }).catch((e) => {
      if (passGen(c.id) !== gen) return;
      console.warn(`[studio] resume ${c.id}: ${e?.message ?? e}`);
      return endPass(c.id, { detail: `couldn't carry on after the restart: ${String(e?.message ?? e).slice(0, 200)}`, phase: { ...ph, failed: true } });
    }).finally(() => {
      waitingStart.delete(c.id);
      land();
      remember(c.id);
      void pump();
    });
}
/** Resumed changes still waiting for their turn (resumeGapMs) or for memory (memRoom): queued in effect, not stuck. */
const waitingStart = new Set<string>();

/** Changes that resumeChanges stopped for restarting Studio too often ("stopped: Studio restarted N times in a row"). */
export const restartStopped = (c: Pick<Change, 'status' | 'detail'>) => c.status === 'failed' && /^stopped: Studio restarted \d+ times in a row/.test(String(c.detail ?? ''));

/**
 * Studio has stayed up for a while (stable.ts), so what the restarts stopped is not what keeps ending it: those changes
 * carry on from the step they were at, once each (phase.revived). Returns the ids.
 */
export function reviveRestartStopped(): string[] {
  const out: string[] = [];
  for (const c of listChanges({ status: 'failed', limit: 200 })) {
    const ph = phaseOf(c.id);
    if (!restartStopped(c) || !ph?.step || ph.revived || running.has(c.id)) continue;
    const next: Phase = { ...ph, failed: false, revived: true, restarts: undefined };
    update(c.id, { status: 'working', detail: 'carrying on: Studio has stayed up since the restarts that stopped it', phase: next });
    addLog(c.id, `Studio has been stable for a while: resuming at the ${ph.step} step`);
    launchResume(c, next, out.length * resumeGapMs());
    out.push(c.id);
  }
  return out;
}

/** How long a step may go with no sign of life (a log line, a status change, a build or Gen job of its own) before the watchdog takes it over. */
export const STALL_MS: Record<Phase['step'], number> = { prepare: 30 * 60_000, agent: 90 * 60_000, publish: 30 * 60_000, verify: 45 * 60_000, finish: 60 * 60_000, gen: 24 * 3600_000 };
const stallMs = (step: Phase['step']) => {
  const n = Number(process.env.STUDIO_STALL_MS);
  return n > 0 ? n : STALL_MS[step] ?? 45 * 60_000;
};
/** A change with no pass in this process that still says it's being worked on: left this long before the watchdog carries it on (a pass may be just starting). */
const ORPHAN_MS = () => Number(process.env.STUDIO_ORPHAN_MS) > 0 ? Number(process.env.STUDIO_ORPHAN_MS) : 10 * 60_000;
/** Times the watchdog carries a change on at the same step before it settles it instead (ready with its pull request, or failed for the PM to try again). */
export const WATCH_TRIES = 2;

/**
 * Whether something outside the pass is still working for the change: a build of its branch that is building in a
 * running run (builds.ts, up to its maximum), or a Hawkes Gen job its verification waits on (up to the queue's limit).
 */
function workingElsewhere(id: string, ph: Phase, now: number): string | null {
  try {
    const { BUILD_MAX_MS } = buildsLimits;
    const b = db.prepare("SELECT b.build, b.started FROM builds b JOIN runs r ON r.id = b.run WHERE b.change = ? AND b.status = 'building' AND r.status = 'running' ORDER BY b.started DESC LIMIT 1").get(id) as { build: string; started: number } | undefined;
    if (b && now - b.started < BUILD_MAX_MS() + 30 * 60_000) return `its ${b.build} build is going`;
  } catch { /* no builds table in some tests */ }
  if (['verify', 'gen'].includes(ph.step) && Object.values(ph.jobs ?? {}).some(Boolean) && now - (ph.since ?? now) < VERIFY_QUEUE_MS + 3600_000) return 'its Hawkes Gen jobs are going';
  return null;
}
const buildsLimits = { BUILD_MAX_MS: () => Number(process.env.STUDIO_BUILD_MAX_MS) > 0 ? Number(process.env.STUDIO_BUILD_MAX_MS) : 4 * 3600_000 };

export type StuckAction = { id: string; step: string; was: 'orphan' | 'stalled'; idleMin: number; did: 'resumed' | 'ready' | 'failed' | 'requeued' };

/**
 * The stuck-work watchdog (J, 2026-11-10: "that is a terrible studio bug", after changes sat 12 hours at "building the
 * branch in the cloud" and "pushing and opening the pull request" with nothing behind them). Every change that says it's
 * being worked on (working, verifying, revising) has either a pass in this process that is still moving, or work of its
 * own elsewhere (a build, Gen jobs). Otherwise:
 * - no pass here at all (orphan: a restart, a pass that died without settling it): it carries on from its step, its
 *   worktree made again from its branch on GitHub when it's gone;
 * - a pass here with no sign of life for longer than its step's STALL_MS (stalled: a wait nobody ends): that pass is
 *   given up on (abandonPass) and a new one carries the change on from its step.
 * The same step taken over WATCH_TRIES times: a verify or finish step with its pull request open and work committed is
 * ready as it stands (the playtest or preview is what hung); anything else fails with why, and the PM tries it again.
 * Runs at start-up and on a long timer; it reads the database only.
 */
export function checkStuck(now = Date.now()): StuckAction[] {
  const out: StuckAction[] = [];
  const rows = db.prepare("SELECT id, status, updated, phase FROM changes WHERE status IN ('working', 'verifying', 'revising')").all() as { id: string; status: string; updated: number | null; phase: string | null }[];
  for (const r of rows) {
    const ph: Phase | null = parse(r.phase);
    const idle = now - (r.updated ?? 0);
    const here = running.has(r.id);
    if (!ph?.step || ph.failed) {
      if (here || idle < ORPHAN_MS()) continue;
      update(r.id, { status: 'queued', detail: 'requeued: it said it was being worked on, but nothing was working on it' });
      addLog(r.id, `watchdog: nothing was working on it for ${Math.round(idle / 60_000)} min and it had no step to carry on from: back in the queue`);
      out.push({ id: r.id, step: '?', was: 'orphan', idleMin: Math.round(idle / 60_000), did: 'requeued' });
      continue;
    }
    // One reading of what the change is doing (outcomes.ts passState): only a pass that is hung or orphaned is taken over;
    // moving, waiting its turn or for CPU room (each ends by its own wait: waits.ts) and work elsewhere are left alone.
    const state = passState({
      here, idleMs: idle, stallMs: stallMs(ph.step), orphanMs: ORPHAN_MS(), step: ph.step,
      waitingToStart: remaking.has(r.id) || waitingStart.has(r.id),
      waitingForRoom: Boolean(ph.proc?.rec?.unit && cpuWaiting(ph.proc.rec.unit)),
      elsewhere: (here ? idle >= stallMs(ph.step) : idle >= ORPHAN_MS()) && Boolean(workingElsewhere(r.id, ph, now)),
    });
    if (state !== 'hung' && state !== 'orphaned') continue;
    const was: StuckAction['was'] = here ? 'stalled' : 'orphan';
    const mins = Math.round(idle / 60_000);
    if (here) abandonPass(r.id);
    const prev = ph.watch;
    const n = prev?.step === ph.step ? prev.n + 1 : 1;
    const c = getChange(r.id)!;
    const what = here ? `no sign of life for ${mins} min at the ${ph.step} step` : `nothing working on it for ${mins} min at the ${ph.step} step (a restart or a pass that ended without settling it)`;
    console.warn(`[stuckwatch] ${r.id}: ${what} (${n} of ${WATCH_TRIES})`);
    if (n > WATCH_TRIES) {
      if (carryFinishedToReady(c, ph, `watchdog: stuck at the ${ph.step} step ${n - 1} times`)) { out.push({ id: r.id, step: ph.step, was, idleMin: mins, did: 'ready' }); continue; }
      if (ph.requested) {
        const v = { ...(c.verify ?? {}), outcome: 'not played', error: `the playtest got stuck at the ${ph.step} step ${n - 1} times; ask for it again` };
        update(r.id, { status: 'ready', detail: readyDetail(v), verify: v, phase: null });
        addLog(r.id, `watchdog: the playtest asked for got stuck ${n - 1} times: ready again as it was`);
        out.push({ id: r.id, step: ph.step, was, idleMin: mins, did: 'ready' });
        continue;
      }
      void endPass(r.id, { detail: `stuck: it hung at the ${ph.step} step ${n - 1} times (the PM tries it again)`, phase: { ...ph, failed: true, watch: { step: ph.step, n, at: now } }, log: `watchdog: hung at the ${ph.step} step ${n - 1} times: failed so it starts over (not a try against the work)` });
      out.push({ id: r.id, step: ph.step, was, idleMin: mins, did: 'failed' });
      continue;
    }
    // A finish or verify step with the pull request open and the work committed: carry on from the step, but the
    // second time it hangs it is ready as it stands (above).
    // A stalled agent step's job is stopped (a Cloud Run execution that never started, or went silent): the new pass
    // starts a fresh one instead of reattaching to it.
    if (ph.step === 'agent' && ph.proc) { try { stopDetached(ph.proc.rec); } catch { /* already gone */ } }
    const next: Phase = { ...ph, watch: { step: ph.step, n, at: now }, restarts: undefined, ...(ph.step === 'agent' && ph.proc ? { proc: undefined } : {}) };
    update(r.id, { phase: next, detail: `carrying on: ${here ? 'it hung' : 'nothing was working on it'} at the ${ph.step} step` });
    addLog(r.id, `watchdog: ${what}: carrying on from the ${ph.step} step (${n} of ${WATCH_TRIES})`);
    launchResume(getChange(r.id)!, next, out.length * resumeGapMs());
    out.push({ id: r.id, step: ph.step, was, idleMin: mins, did: 'resumed' });
  }
  return out;
}

/** What a pump start runs: a change's pass (work). The tests put a stand-in here to watch the queue on its own. */
let runPass: typeof work = work;

/** For the tests: a pass's claim, the watchdog's give-up, and code run as a pass of a change. */
export const passInternals = {
  claim, abandonPass, offMachine, isRunning: (id: string) => running.has(id), inFlight: () => inFlight,
  setRunPass: (f: typeof work | null) => { runPass = f ?? work; }, running: () => [...running],
  waitForJobRoom: (id: string, ph: Phase, why: string) => waitForJobRoom(id, ph, why),
  diskWait: () => diskWait, waitForDisk: (id: string, why: string) => waitForDisk(id, why), checkoutSlot: <T>(fn: () => Promise<T>, o?: { turnMs?: number; onLong?: () => void }) => checkoutSlot(fn, o),
  asPass: <T>(id: string, fn: () => T) => passCtx.run({ id, gen: passGen(id) }, fn),
};

let stuckTimer: NodeJS.Timeout | null = null;
/** How often the watchdog looks (STUDIO_STUCK_EVERY_MS; 5 minutes). */
const STUCK_EVERY_MS = () => Number(process.env.STUDIO_STUCK_EVERY_MS) > 0 ? Number(process.env.STUDIO_STUCK_EVERY_MS) : 5 * 60_000;
/** Starts the watchdog (server.ts, after resumeChanges): a first look once start-up has settled, then every STUCK_EVERY_MS. */
export function startStuckWatch() {
  if (stuckTimer) return;
  const look = () => {
    try {
      const did = checkStuck();
      if (did.length) console.log(`[stuckwatch] took over ${did.length}: ${did.map((d) => `${d.id} ${d.step} ${d.was} ${d.idleMin}m -> ${d.did}`).join('; ')}`);
      checkQueue();
    } catch (e: any) {
      console.warn(`[stuckwatch] ${e?.message ?? e}`);
    }
  };
  setTimeout(look, 3 * 60_000).unref();
  stuckTimer = setInterval(look, STUCK_EVERY_MS());
  stuckTimer.unref();
}

/**
 * What a Studio restart adds to a change's restarts-in-a-row at its step. A Cloud Run agent job outlives Studio, so when its
 * output offset moved since the previous restart it is making progress and the restart isn't counted (n goes back to 1:
 * the counter exists to catch a step that crashes Studio, J 2026-11-11: c_537e53d5b27d lost 7 minutes of good work). A
 * step whose output didn't move, and any local agent, counts as before. `why` is the log line.
 */
export function restartCount(prev: Phase['restarts'], ph: Pick<Phase, 'step' | 'proc'>, now = Date.now()): { n: number; why: string } {
  const same = prev?.step === ph.step && now - (prev.at ?? 0) < RESTART_WINDOW_MS;
  if (!same) return { n: 1, why: 'first restart at this step: 1 of ' + RESTART_LOOP };
  if (ph.step === 'agent' && ph.proc?.rec.mode === 'cloudrun' && typeof prev!.offset === 'number' && ph.proc.offset > prev!.offset) {
    return { n: 1, why: `progress since last restart: not counted (its output moved ${prev!.offset} -> ${ph.proc.offset})` };
  }
  return { n: prev!.n + 1, why: `no progress: ${prev!.n + 1} of ${RESTART_LOOP}` };
}

/** An agent's own question on a change still waiting for its answer (not a decision Studio asked about it). */
function agentAsks(change: string): boolean {
  try { return Boolean(db.prepare(`SELECT 1 FROM questions WHERE kind = 'agent' AND subject = ? AND status IN ('open', 'asked J')`).get(change)); } catch { return false; }
}
export function resumeChanges() {
  const out: string[] = [];
  // Stopped at the harness cap by the old rule ("needs answer", J asked): the cap is a wait with an end now (resumeGate).
  for (const c of listChanges({ status: 'needs answer', limit: 200 })) {
    const h = phaseOf(c.id)?.harness;
    if (h?.capped && !agentAsks(c.id)) { update(c.id, { status: 'queued', detail: 'parked by the AI harness: goes on by itself once its hour allows' }); addLog(c.id, 'the harness cap waits by itself now: back in the queue'); }
  }
  for (const c of listChanges({ status: 'working,verifying,revising', limit: 200 })) {
    const ph = phaseOf(c.id);
    if (!ph?.step || ph.failed) {
      update(c.id, { status: 'queued', detail: 'requeued after a restart' });
      continue;
    }
    if (running.has(c.id)) continue;
    // The same step resumed RESTART_LOOP times in a row and never got past it: it is what keeps ending Studio (a clone
    // too big for its memory crashed the customer Studio on every restart, 2026-10-31). It stops, said plainly.
    // Only quick ones count: a crash loop restarts every minute or two; deploys during a long agent pass are far apart.
    const prev = ph.restarts;
    const { n, why } = restartCount(prev, ph);
    if (n > RESTART_LOOP) {
      // Its pull request is already open and the work committed: only the finish was cut off. That is ready, not failed.
      if (carryFinishedToReady(c, ph)) continue;
      void endPass(c.id, { detail: `stopped: Studio restarted ${n - 1} times in a row during its ${ph.step} step, so it isn't resumed again (start it again once the cause is fixed)`, phase: { ...ph, failed: true }, log: `stopped after ${n - 1} restarts in a row at the ${ph.step} step` });
      console.warn(`[studio] ${c.id}: stopped after ${n - 1} restarts in a row at ${ph.step}`);
      continue;
    }
    ph.restarts = { step: ph.step, n, at: Date.now(), ...(ph.proc?.rec.mode === 'cloudrun' ? { offset: ph.proc.offset } : {}) };
    if (ph.step === 'agent') addLog(c.id, `restart: ${why}`);
    update(c.id, { phase: ph });
    // One every RESUME_GAP_MS, not all at once: each picks up with git and file work, which together froze Studio's start.
    const wait = out.length * resumeGapMs();
    out.push(c.id);
    launchResume(c, ph, wait);
  }
  // A restart between "ready" and its automatic merge: the merge is tried again (approve() refuses a moved head).
  for (const c of listChanges({ status: 'ready', limit: 100 })) {
    if (c.auto_merge !== 'trying' || c.infra || running.has(c.id)) continue;
    void autoMergeBeta(c.id).catch((e) => console.warn(`[studio] auto-merge ${c.id}: ${e.message ?? e}`));
  }
  // A restart while an approved Studio/Gen change waited for CI: it waits again (mergeApprovedInfra).
  for (const c of listChanges({ status: 'ready', limit: 100 })) {
    if (c.infra && c.approved && !running.has(c.id)) void mergeApprovedInfra(c.id).catch((e) => console.warn(`[studio] approved merge ${c.id}: ${e.message ?? e}`));
  }
  // Walk-away mode: ready Studio/Gen changes not decided yet (or cut off mid-merge) are looked at again.
  walkAwayPending();
  // Changes parked on Gen jobs: their jobs are looked at again now (they may have finished while Studio was down).
  void pollGenWaits({ force: true });
  return out;
}

let polling = false;
/** A look asked for while one ran (an event, a reconnect): run right after it, so nothing is dropped. */
let pendingLook: GenLook | null = null;
/** force: every parked change is looked at now (a restart, the event stream reconnecting). jobs: jobs Gen says ended (events). */
type GenLook = { force?: boolean; jobs?: Map<string, any> };
const applyGenJob = (j: GenJobWait, r: any) => {
  j.status = String(r.status ?? j.status ?? 'queued');
  j.assets = (r.outputs ?? []).map((o: any) => o.asset).filter(Boolean);
  if (r.error) j.error = String(r.error).slice(0, 300);
};
/**
 * Changes waiting on Gen: once every job is done, failed or cancelled (or unknown to Gen), the change is queued to resume
 * its agent's session with the results (pump). A job's end comes as Gen's event (look.jobs, at once); a change is also
 * looked at when due (genPollDue: each unfinished job asked for, GET /v1/jobs/<id>), forced (look.force), or due to tell
 * Talk. Jobs waiting longer than agents.genWaitHours are told in Talk once; that never fails the change.
 */
export async function pollGenWaits(look: GenLook = {}) {
  if (polling) {
    // The look running now does what a plain one would; an event or a forced look is kept for right after it.
    if (look.force || look.jobs?.size) {
      const p = (pendingLook ??= {});
      if (look.force) p.force = true;
      if (look.jobs) for (const [id, j] of look.jobs) (p.jobs ??= new Map()).set(id, j);
    }
    return;
  }
  polling = true;
  try {
    const parked = listChanges({ status: WAITING_GEN, limit: 100 });
    // Gen's events are wanted while a change is parked (genevents.ts opens its stream only while something waits).
    if (parked.length) genEvents.hold('parked-changes');
    else genEvents.release('parked-changes');
    // Changes no longer parked on Gen (closed, failed, moved on): their waits end.
    endWaitsWhere('gen-wait', (id) => !parked.some((c) => c.id === id));
    for (const c of parked) {
      const ph = phaseOf(c.id);
      const w = ph?.gen;
      if (!ph || !w) continue;
      // The wait on Gen is a wait of the shared rule (waits.ts): its end is recorded, so a restart arms it again and the
      // deadline wakes this look by itself (no interval has to find it).
      beginWait('gen-wait', c.id, { waitsOn: `Gen jobs ${w.jobs.filter((j) => !genJobDone(j)).map((j) => j.id).join(', ') || '(done)'}`, deadlineAt: w.since + genWaitEndMs(), since: w.since, product: c.product });
      const ended = look.jobs ? w.jobs.filter((j) => !genJobDone(j) && look.jobs!.has(j.id)) : [];
      const tellDue = !w.told && Date.now() - w.since > genWaitMs();
      const over = Date.now() - w.since > genWaitEndMs();
      const due = Boolean(look.force) || genPollDue(w) || tellDue || over;
      if (!ended.length && !due) continue;
      for (const j of w.jobs) {
        if (genJobDone(j)) continue;
        const known = look.jobs?.get(j.id);
        if (known) {
          applyGenJob(j, known);
          continue;
        }
        if (!due) continue;
        try {
          const r = await gen.job(j.id);
          applyGenJob(j, r);
          // Still queued past the bound while Gen's lane shows free room: same shared recovery as builds/playtests
          // (gen-recover.ts). Parked GPU work can't resubmit here; the agent is told the job is gone and goes on.
          if (stillQueued(r) && Date.now() - w.since >= QUEUED_GHOST_MS()) {
            const listed = await laneJobs(gen as any, String(r.tool || ''));
            if (ghostQueued({ ...r, id: j.id }, listed, w.since)) {
              Object.assign(j, { status: 'missing', error: listed && !listed.some((x) => String(x?.id) === j.id) ? "Hawkes Gen no longer has this job in its queue" : "Hawkes Gen's lane is free but this job stayed queued" });
            }
          }
        } catch (e: any) {
          // Gen doesn't know it (a wrong id): nothing to wait for. Gen not answering: next time.
          if (e?.status === 404 || /no such job/i.test(String(e?.message ?? ''))) Object.assign(j, { status: 'missing', error: 'Hawkes Gen has no such job' });
        }
      }
      if (due) w.checked = Date.now();
      // Closed (or otherwise moved on) while we asked Gen: leave it.
      if (getChange(c.id)?.status !== WAITING_GEN) continue;
      if (over) {
        const late = w.jobs.filter((j) => !genJobDone(j));
        for (const j of late) Object.assign(j, { status: 'timed out', error: `still not finished after ${Math.round(genWaitEndMs() / 3600_000)} h: go on without it` });
        if (late.length) addLog(c.id, `waited ${Math.round(genWaitEndMs() / 3600_000)} h on Gen: ${late.map((j) => j.id).join(', ')} timed out; the agent goes on without them`);
      }
      if (w.jobs.every(genJobDone)) {
        endWait('gen-wait', c.id, over ? 'deadline' : 'event');
        const prompt = genDonePrompt(w);
        update(c.id, {
          status: 'queued', detail: `its Gen jobs finished (${w.jobs.map((j) => j.status).join(', ')}); the agent continues`,
          phase: { step: 'agent', since: Date.now(), before: (await gitAsync(c.worktree, ['rev-parse', 'HEAD'])).out, gen: w, genDone: prompt },
        });
        addLog(c.id, `Gen jobs finished: ${w.jobs.map((j) => `${j.id} ${j.status}${j.assets?.length ? ` (${j.assets.length} asset${j.assets.length === 1 ? '' : 's'})` : ''}`).join(', ')}; resuming its session`);
        void pump();
        continue;
      }
      let tell = false;
      if (!w.told && Date.now() - w.since > genWaitMs()) tell = w.told = true;
      update(c.id, { detail: `waiting for GPU jobs (${genProgress(w)})`, phase: { ...ph, gen: w } });
      if (tell) {
        const hours = Math.round((Date.now() - w.since) / 360_000) / 10;
        const line = `Agent change ${c.id} ("${c.title}") has waited ${hours} h on its Gen jobs (${genProgress(w)}: ${w.jobs.filter((j) => !genJobDone(j)).map((j) => j.id).join(', ')}). Nothing failed: it resumes by itself when they finish. ${PUBLIC_URL}/#changes/${c.id}`;
        addLog(c.id, `told Talk: waited ${hours} h on its Gen jobs`);
        const { tellAbout } = await import('./followup.ts');
        await tellAbout(getChange(c.id), `GPU jobs waiting: ${c.title ?? c.id}`, line).catch((e) => console.warn(`[studio] gen wait notice ${c.id}: ${e.message ?? e}`));
      }
    }
  } catch (e: any) {
    console.warn(`[studio] Gen waits: ${e.message ?? e}`);
  } finally {
    polling = false;
    const p = pendingLook;
    pendingLook = null;
    if (p) void pollGenWaits(p);
  }
}
// A parked job's end, pushed by Gen (genevents.ts): its change resumes at once. Ends that come in together are one look.
let endedJobs: Map<string, any> | null = null;
genEvents.onEvent((type, job) => {
  if (type !== 'job' || !job?.id || !genTerminal(job)) return;
  if (!endedJobs) {
    endedJobs = new Map();
    setTimeout(() => {
      const jobs = endedJobs!;
      endedJobs = null;
      void pollGenWaits({ jobs });
    }, 100).unref();
  }
  endedJobs.set(String(job.id), job);
});
// The stream (re)opened: every parked job is asked for once (one may have ended while it was down).
genEvents.onConnect(() => void pollGenWaits({ force: true }));
// The clock behind the events: a change due a look (the stream down, or its safety check) or due to tell Talk.
setInterval(() => void pollGenWaits(), genPollMs()).unref();
// The server calls it once it listens (server.ts); a process that only imports this module (the CLI, tests) doesn't.
setTimeout(() => void pump(), 5000).unref();
// A hold lifted or a stand-in took over: parked and queued changes start now, not at the next minute.
onHoldLifted(() => void pump());
// The CPU turn (cpuroom.ts, point cpu-turn) is recorded as a wait of the shared rule from here: the gate itself stays free of the database.
cpuWaits.begin = (tag, waitsOn, since, deadlineMs) => void beginWait('cpu-turn', tag, { waitsOn, since, deadlineMs });
cpuWaits.end = (tag, how) => void endWait('cpu-turn', tag, how);
// The fallbacks of the waits recorded here (waits.ts): a deadline passing wakes the part that carries on in its lesser way.
onDeadline('harness-cap', () => void pump()); // the hour is up: the change goes again
onDeadline('gen-wait', () => void pollGenWaits({ force: true })); // the jobs still unfinished are timed out, the agent goes on
// No interval re-runs the queue (J, 2026-11-11: no watchdog, the parts catch themselves). Every wait has its own exit:
// a slot or a product's place frees when a pass lands (claim) or a change's status moves (update); memory when a pass
// lets go of it (dropFlight); disk room when a pass ends, a worktree is removed (cleanup) or a sweep frees room, with the
// disk wait's own deadline for room freed outside Studio (diskwait.ts); a provider when its hold lifts (onHoldLifted);
// a deploy drain when its flag goes or reaches its age (drain.ts, pumpPass); a retry or a resume gap at its own time
// (pumpAt); a customer's plan or AI link when it changes (queuewake.ts); start-up (startQueue). With nothing running,
// the memory and disk gates always let one change start.

/** Start-up (server.ts, before the resumes): Studio at rest is measured, and the queue looks once. */
export function startQueue() {
  queueIdle();
  return pump();
}
