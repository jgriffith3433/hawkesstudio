// Talk as J's PM: the loop that works the roadmap and the backlog with the agents, so J sets direction and comes back
// to test finished, verified work.
//
// Every minute (and right after anything finishes) the loop:
//   1. keeps every roadmap task's status current from its agent change (working, needs answer, review, merged) and,
//      after a merge, from beta's playtest of its criteria (verified) and from go lives (live); items follow their tasks
//   2. starts the next tasks in roadmap order, then the worst open bugs, within its caps (starts per day, agents at once,
//      one per product)
//   3. hands what needs judgment to a PM turn: a Talk turn in the day's "Studio PM" conversation (talk.ts) with the
//      events since the last one: changes to review, agent questions, failures, beta checks, the daily run, the daily
//      triage. Claude acts through the studio_pm tools: merges into beta what passed its criteria, sends failures back
//      with specific notes (3 tries, then J), answers agents from what J decided, triages the backlog
//   4. applies the defaults to whatever the PM turn left (or when no turn could run): merge if the gate passes (the
//      change was playtested, not "broken", no criterion failed), else revise with the unmet criteria; after 3 tries,
//      or an agent question nobody answered, J is asked
//
// Only real decisions reach J (askJ): direction, money, something still failing after 3 tries, anything touching
// live. Each is one question in Talk (the conversation that started the work, else the PM's) and on his phone.
// Every merge, won't-fix, start and answer is in the decision log (roadmap.ts pm_log), with undo where possible.
// Going live stays J's (DEPLOY <product>). Studio and Gen changes always need J's approval (they restart services).

import fs from 'node:fs';
import { criticalSync } from './drain.ts';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { db, J, parse } from './db.ts';
import { DATA, PROJECTS, getProduct, isInfra, today, StudioError } from './config.ts';
import {
  getTask, setTask, getItem, startableTasks, tasksAwaitingGpu, taskOfChange, addQuestion, listQuestions, getQuestion, setQuestion, addComment,
  logDecision, listDecisions, getDecision, markUndone, countToday, listItems, threadFor, milestonesToReach, markReached, getMilestone,
  type Task, type Check,
} from './roadmap.ts';
import { gate, allMet } from './acceptance.ts';
import { notify, PUBLIC_URL } from './notify.ts';
import { fileUrl } from './gen.ts';
import { BETA } from './beta.ts';
import { curationLine } from './memory.ts';

// ---------------------------------------------------------------- settings

const FILE = path.join(DATA, 'pm.json');
export type PmSettings = {
  /** The loop runs (the pause switch). */
  enabled: boolean;
  /** Talk may merge agent changes into beta itself when they pass their checks (J chose this). Never live, never Studio or Gen. */
  delegatedMerges: boolean;
  /** Agent starts the PM makes per day (Max-plan usage). */
  maxStartsPerDay: number;
  /** Agents working at once that the PM will add to (it never starts one beyond this). */
  maxConcurrent: number;
  /** Tries per task (the first attempt and its revisions) before J is asked. */
  maxTries: number;
  /** Fill free slots with the worst open bugs once no roadmap task can start. */
  fixBugs: boolean;
  /** The daily PM turn (triage, plan the day) runs after this hour (server time), or when the daily run finishes. */
  dailyHour: number;
  /** Minutes a ready change waits for a PM turn before the defaults apply. */
  graceMinutes: number;
};
const DEFAULTS: PmSettings = { enabled: true, delegatedMerges: true, maxStartsPerDay: 8, maxConcurrent: 2, maxTries: 3, fixBugs: true, dailyHour: 9, graceMinutes: 15 };
export function pmSettings(): PmSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return DEFAULTS;
  }
}
export function savePmSettings(patch: Partial<PmSettings>, by = 'J') {
  const cur = pmSettings();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS) as (keyof PmSettings)[]) {
    if (patch[k] === undefined) continue;
    if (typeof DEFAULTS[k] !== typeof patch[k]) throw new StudioError(`${k} must be a ${typeof DEFAULTS[k]}`);
    (next as any)[k] = patch[k];
  }
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  const changed = (Object.keys(patch) as (keyof PmSettings)[]).filter((k) => patch[k] !== undefined && cur[k] !== next[k]);
  if (changed.length) logDecision('settings', null, null, `${by} set ${changed.map((k) => `${k} = ${next[k]}`).join(', ')}`, { kind: 'settings', before: Object.fromEntries(changed.map((k) => [k, cur[k]])) });
  if (patch.enabled === true) kick();
  return next;
}

// State that survives restarts: the last daily turn, the PM conversation.
const STATE = path.join(DATA, 'pm-state.json');
const state = (): { daily?: string; conversation?: { id: string; day: string }; since?: number } => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (patch: Record<string, unknown>) => fs.writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, null, 2));

// ----------------------------------------------------------------- helpers

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const changes = () => import('./agents.ts');
const name = (product: string) => { try { return getProduct(product).name; } catch { return product; } };
const ACTIVE = ['queued', 'working', 'verifying', 'revising'];

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
  const s = pmSettings();
  for (const t of (db.prepare(`SELECT id FROM tasks WHERE status IN ('working', 'needs answer', 'review', 'merged', 'verified')`).all() as any[]).map((r) => getTask(r.id)!)) {
    const c = t.change ? getChange(t.change) : null;
    if (!c) continue;
    if (t.status !== 'merged' && t.status !== 'verified') {
      const next = ACTIVE.includes(c.status) ? 'working' : c.status === 'needs answer' ? 'needs answer' : c.status === 'ready' ? 'review' : c.status === 'merged' ? 'merged' : null;
      if (next && next !== t.status) {
        setTask(t.id, { status: next, pr: c.pr_url, ...(next === 'merged' ? { merged_at: Date.now() } : {}), ...(c.verify?.criteria ? { checks: { where: 'change', at: Date.now(), change: c.id, video: c.verify.video ?? null, verdict: c.verify.verdict, results: c.verify.criteria } } : {}), ...(c.verify?.try ? { try: c.verify.try } : {}) });
        if (next === 'merged') kick();
      }
      // A failed change is the PM's (watch() tells it; the defaults restart it or ask J). A closed one ends the task's run.
      if (c.status === 'closed') setTask(t.id, { status: 'failed', note: `its change ${c.id} was closed (${c.detail ?? ''})` });
      continue;
    }
    // Merged: beta's playtest of the criteria (the beta run after the merge, pipeline.ts startBeta) decides.
    if (t.status === 'merged') await checkOnBeta(t);
    // Verified (or merged): live once a go live after the merge has its commit on main.
    const deploy = db.prepare(`SELECT * FROM deploys WHERE product = ? AND kind = 'deploy' AND rolled_back IS NULL AND at > ? ORDER BY at DESC LIMIT 1`).get(t.product, t.merged_at ?? 0) as any;
    if (deploy && c.pr && !liveChecked.has(`${t.id}:${deploy.id}`)) {
      liveChecked.add(`${t.id}:${deploy.id}`);
      git(path.join(PROJECTS, c.repo), ['fetch', '--quiet', 'origin']);
      if (prCommit(c.repo, 'main', c.pr)) setTask(t.id, { status: getTask(t.id)!.status === 'verified' ? 'live' : getTask(t.id)!.status, live_at: Date.now() });
    }
  }
  // Items that just reached beta: J hears it's ready for him to test.
  for (const it of db.prepare(`SELECT id FROM items WHERE status = 'on beta' AND (note IS NULL OR note NOT LIKE '%[told ready]%')`).all() as any[]) announceReady(it.id);
  // Milestones whose items are all on beta: J's moment to playtest by hand (his phone, and Talk).
  for (const m of milestonesToReach()) announceMilestone(m.id);
}

/** Go lives already looked at per task (one git fetch each, not one a minute). */
const liveChecked = new Set<string>();

/** The beta check of a merged task: the newest beta review of its product since the merge that judged its criteria. */
async function checkOnBeta(t: Task) {
  const s = pmSettings();
  const steps = db.prepare(`SELECT s.*, r.kind AS run_kind, r.status AS run_status FROM steps s JOIN runs r ON r.id = s.run
    WHERE s.product = ? AND s.kind = 'review' AND r.kind = 'beta' AND s.started > ? ORDER BY s.started DESC LIMIT 10`).all(t.product, t.merged_at ?? 0) as any[];
  const judged = steps.map((x) => ({ ...x, data: parse(x.data) })).find((x) => Array.isArray(x.data?.criteria) && x.data.criteria.length);
  if (!judged) {
    // No beta check yet: start one if nothing is running for this product and the merge is a while ago.
    const running = db.prepare(`SELECT id FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ?`).get(`%"${t.product}"%`);
    const asked = listDecisions({ since: Date.now() - 6 * 3600_000, action: 'beta-check' }).some((d) => d.subject === t.id);
    if (!running && !asked && Date.now() - (t.merged_at ?? 0) > 45 * 60_000 && t.criteria.length && s.enabled) {
      const { getChange } = await changes();
      const c = getChange(t.change!);
      const { startBeta } = await import('./pipeline.ts');
      const r = startBeta(t.product, { focus: `Checking "${t.title}" on beta.`, criteria: t.criteria, scenario: c?.verify?.scenario, options: c?.verify?.options });
      logDecision('beta-check', t.id, t.product, `started beta run ${r.id} to check "${t.title}" against its criteria`);
    }
    if (!t.criteria.length && Date.now() - (t.merged_at ?? 0) > 2 * 3600_000) {
      // Nothing to judge: the beta run passing without a blocker is the check.
      const last = steps.map((x) => ({ ...x, data: parse(x.data) }))[0];
      if (last?.data?.verdict && last.data.verdict !== 'broken') setTask(t.id, { status: 'verified', verified_at: Date.now(), checks: { where: 'beta', at: last.started, run: last.run, verdict: last.data.verdict, results: [] } });
    }
    return;
  }
  const play = db.prepare(`SELECT data FROM steps WHERE run = ? AND kind = 'playtest' AND product = ? ORDER BY started DESC LIMIT 1`).get(judged.run, t.product) as any;
  const video = parse(play?.data)?.video ?? null;
  const results = judged.data.criteria as Check[];
  const checks = { where: 'beta' as const, at: judged.started, run: judged.run, video, verdict: judged.data.verdict, results };
  if (allMet(results, t.criteria)) {
    setTask(t.id, { status: 'verified', verified_at: Date.now(), checks });
    logDecision('verified', t.id, t.product, `"${t.title}": all ${t.criteria.length} criteria met on beta (run ${judged.run})`);
    pmEvent('verified', `Task ${t.id} ("${t.title}", ${name(t.product)}) passed every criterion on beta.`, t.id, t.product);
    return;
  }
  if (getTask(t.id)!.checks?.run === judged.run) return; // Already handled this check.
  setTask(t.id, { checks });
  const missed = results.filter((r) => r.met !== 'yes');
  const why = missed.map((r) => `${r.criterion} (${r.met}: ${r.evidence ?? ''})`).join('; ');
  if (t.tries >= s.maxTries) {
    setTask(t.id, { status: 'failed', note: `on beta: ${why}`.slice(0, 1000) });
    askJ(`"${t.title}" (${name(t.product)}) is on beta but still misses criteria after ${t.tries} tries: ${why}. Keep trying with a different approach, change the criteria, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change the criteria', 'drop it'] });
    return;
  }
  if (!s.enabled) return;
  // A follow-up change on top of beta, with what beta showed.
  await startTaskChange(getTask(t.id)!, `It was merged into beta, but beta's playtest shows these criteria not met: ${why}. Fix that on top of what is on beta now.`);
}

/** Starts (or restarts) the agent change of a task. */
async function startTaskChange(t: Task, note?: string) {
  const { startTask } = await changes();
  const request = `${t.request}${note ? `\n\nFrom the PM (an earlier attempt): ${note}` : ''}`;
  const id = startTask(t.product, request, { criteria: t.criteria, task: t.id, title: t.title, gpuBudget: t.gpu?.items?.length ? t.gpu.budget ?? 0 : null });
  setTask(t.id, { status: 'working', change: id, changes: [...t.changes, id], tries: t.tries + 1, merged_at: null });
  logDecision('start', t.id, t.product, `started ${id} for "${t.title}" (try ${t.tries + 1})${note ? `: ${note.slice(0, 300)}` : ''}`, { kind: 'start', change: id, task: t.id });
  return id;
}

// ------------------------------------------------------------- starting

/** Agents working now, and the PM's starts today. */
export function capacity() {
  const s = pmSettings();
  const active = (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status IN (${ACTIVE.map(() => '?').join(',')})`).get(...ACTIVE) as any).n as number;
  const started = countToday('start');
  return { active, started, maxConcurrent: s.maxConcurrent, maxStartsPerDay: s.maxStartsPerDay, free: Math.max(0, Math.min(s.maxConcurrent - active, s.maxStartsPerDay - started)) };
}

const busy = (product: string) => Boolean(db.prepare(`SELECT id FROM changes WHERE product = ? AND status IN ('queued', 'working', 'verifying', 'revising')`).get(product));

/** Starts what can start: roadmap tasks in order, then bugs, within the caps. Returns what it started. */
export async function startWork() {
  const s = pmSettings();
  if (!s.enabled || !process.env.GITHUB_TOKEN) return [];
  const { agentSettings, startFix } = await changes();
  if (!agentSettings().enabled) return [];
  // A Studio or Gen deploy waiting for agents to finish: start nothing new until it's through.
  const { selfDeploys } = await import('./selfdeploy.ts');
  const sd = selfDeploys(1)[0];
  if (sd?.outcome === 'waiting' && Date.now() - Date.parse(sd.at) < 3 * 3600_000) return [];
  const out: string[] = [];
  // Content tasks that would spend GPU money wait for J's budget: ask him once each, with the estimate.
  for (const t of tasksAwaitingGpu()) {
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
    const tries = (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE findings LIKE ?`).get(`%"${f.id}"%`) as any).n as number;
    if (tries >= s.maxTries) return null;
    const id = startFix(f.product, [f.id]);
    db.prepare('UPDATE changes SET criteria = ? WHERE id = ?').run(J([`Fixed: ${f.title}`]), id);
    logDecision('start', f.id, f.product, `started ${id} to fix ${why}[${f.severity}] ${f.title}`, { kind: 'start', change: id, finding: f.id });
    return id;
  };
  const reports = db.prepare(`SELECT * FROM findings WHERE status = 'open' AND source = 'J' ORDER BY CASE severity WHEN 'blocker' THEN 0 ELSE 1 END, first_seen`).all() as any[];
  for (const f of reports) {
    if (cap.free <= 0) break;
    if (busy(f.product) || isInfra(f.product)) continue;
    try {
      const id = startBug(f, "J's report ");
      if (id) { out.push(id); cap = capacity(); }
    } catch {
      continue;
    }
  }
  const waiting = startableTasks();
  for (const t of waiting) {
    if (cap.free <= 0) break;
    if (busy(t.product)) continue;
    try {
      out.push(await startTaskChange(t));
    } catch (e: any) {
      setTask(t.id, { note: `couldn't start: ${e.message}`.slice(0, 500) });
      continue;
    }
    cap = capacity();
  }
  if (s.fixBugs && cap.free > 0) {
    // The worst open bugs not tried 3 times, one per product, in products without a task waiting.
    const bugs = db.prepare(`SELECT * FROM findings WHERE status = 'open' AND severity IN ('blocker', 'bug') AND COALESCE(source, '') != 'J' ORDER BY CASE severity WHEN 'blocker' THEN 0 ELSE 1 END, seen DESC, last_seen DESC LIMIT 40`).all() as any[];
    for (const f of bugs) {
      if (cap.free <= 0) break;
      if (busy(f.product) || isInfra(f.product) || waiting.some((t) => t.product === f.product)) continue;
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
  // The daily cap is visible in the Roadmap tab and studio_pm status (no phone notification: nothing went wrong).
  return out;
}

// --------------------------------------------------------------- reviewing

/** Changes the PM reviews: roadmap tasks' changes, and finding fixes (not J's own requests; never Studio or Gen). */
export function reviewable(c: any) {
  // Changes from before the loop first ran stay J's to approve, as they were.
  return c.status === 'ready' && !c.infra && c.created >= pmSince() && (c.task || (c.findings?.length && !c.request)) && !c.pm_escalated && !waitingOnJ(c);
}
/** A change (or its task) J was asked about: the PM leaves it alone until he answers. */
const waitingOnJ = (c: any) => listQuestions('open,asked J').some((q) => q.kind === 'decision' && Boolean(q.subject) && [c.id, c.task].filter(Boolean).some((s) => q.subject!.split(/[\s,]+/).includes(s)));
/** When the PM loop first ran here: it only takes over work from then on. */
export const pmSince = () => state().since ?? Date.now();

/** Merges a ready change into beta for the PM, when delegated merges are on and it passes its gate. */
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
  const merged = await approve(changeId, { confirm: `MERGE ${changeId}`, by });
  const t = c.task ? getTask(c.task) : null;
  if (t) setTask(t.id, { status: 'merged', merged_at: Date.now(), pr: c.pr_url });
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
  const note = [`The verification playtest didn't pass: ${g.why.join('; ')}.`, v.summary ? `The review said: ${String(v.summary).slice(0, 800)}` : '', ...(v.findings ?? []).slice(0, 5).map((f: any) => `- [${f.severity}] ${f.title}: ${f.detail ?? ''}`)].filter(Boolean).join('\n');
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
  setQuestion(id, { status: 'answered', answer, answered_by: by });
  if (q.subject) addComment(q.subject.startsWith('c_') ? (taskOfChange(q.subject)?.id ?? q.subject) : q.subject, answer, by, 'answer');
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
    if (t && !['merged', 'verified', 'live', 'dropped'].includes(t.status)) setTask(t.id, { status: stop === 'park' ? 'idea' : 'dropped', note: `${stop === 'park' ? 'parked' : 'dropped'} on ${byJ ? 'J' : by}'s answer to ${id}` });
  }
  // A decision on a failed task: the PM's next turn acts on it ("try again", "drop it").
  if (q.kind === 'decision' && q.topic !== 'gpu') pmEvent('decided', `${byJ ? 'J' : by} decided on ${q.subject ?? 'a question'} (${id}): "${answer}" (the question was: ${q.text.slice(0, 400)})`, q.subject ?? id, q.product);
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
  const q = addQuestion({ kind: 'decision', subject, product, text, options, origin, recommendation: recommend ?? null, context, blocks, topic, forwards, askedBy });
  if (q.status !== 'open') return q;
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
  void postTo(it.origin, `On beta: ${it.title}`, `On beta and verified (Studio PM):\n\n${text}`);
  logDecision('ready', itemId, it.product, `"${it.title}" is on beta, its checks passed: told Talk`);
}

/** A milestone reached: every item in it passed its checks on beta. J's phone and Talk get its ready-to-test summary. */
function announceMilestone(id: string) {
  const m = getMilestone(id);
  if (!m) return;
  markReached(id);
  const ready = readyReport({ milestone: id });
  const verified = ready.flatMap((r) => r.criteria).filter((c) => c.met === 'yes').length;
  const total = ready.flatMap((r) => r.criteria).length;
  const bugs = ready.reduce((n, r) => n + r.bugs.length, 0);
  const text = [
    `Milestone reached: **${m.title}**${m.product ? ` (${name(m.product)})` : ''}. Everything in it passed its checks on beta, so it's yours to playtest.`,
    m.goal ? `Goal: ${m.goal}` : '',
    m.test ? `What you said you'd test: ${m.test}` : '',
    ...ready.map(readyMarkdown),
    'When you have played it: go live (DEPLOY <product>), or tell me what is wrong and I will make it tasks.',
  ].filter(Boolean).join('\n\n---\n\n');
  void postTo(m.origin, `Milestone reached: ${m.title}`, text);
  void notify(`Milestone reached: ${m.title}`, `${verified}/${total} criteria verified on beta${bugs ? ` · ${bugs} known bug(s)` : ''}. Ready for you to playtest.`, { url: `${PUBLIC_URL}/#ready`, priority: 4, tags: ['checkered_flag'] });
  logDecision('milestone', id, m.product, `milestone "${m.title}" reached (${ready.length} item(s), ${verified}/${total} criteria on beta): told J`);
}

export type Ready = {
  item: string; product: string; productName: string; title: string; goal: string | null; status: string; beta: string | null;
  changes: { task: string; title: string; status: string; pr: string | null; change: string | null; summary: string | null }[];
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
      : listItems({ product, status: 'on beta,in progress' });
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
      changes: tasks.map((t: Task) => ({ task: t.id, title: t.title, status: t.status, pr: t.pr, change: t.change, summary: summary(t.change)?.slice(0, 1500) ?? null })),
      criteria: tasks.flatMap((t: Task) => (t.checks?.results ?? t.criteria.map((k) => ({ criterion: k, met: 'unclear' as const, evidence: 'not checked on beta yet' }))).map((c) => ({ ...c, task: t.id, video: t.checks?.video ?? null, where: t.checks?.where ?? '-' }))),
      try: tasks.map((t: Task) => t.try).filter(Boolean) as string[],
      bugs: linked, partly: it.status !== 'on beta',
    });
  }
  return out;
}

export function readyMarkdown(r: Ready) {
  return [
    `**${r.title}** (${r.productName})${r.partly ? ' — partly on beta' : ''}${r.beta ? ` · try it: ${r.beta}` : ''}`,
    r.goal ? `Goal: ${r.goal}` : '',
    `What changed:\n${r.changes.map((c) => `- ${c.title} (${c.status})${c.pr ? ` ${c.pr}` : ''}`).join('\n')}`,
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
    if (u.finding) db.prepare(`UPDATE findings SET status = 'open' WHERE id = ? AND status = 'fixing'`).run(u.finding);
    detail = `closed ${u.change}`;
  } else if (u.kind === 'merge') {
    detail = revertOnBeta(u.repo, u.pr, by);
    if (u.task) setTask(u.task, { status: 'idea', note: `merge undone by ${by} (reverted on beta)` });
  } else if (u.kind === 'settings') {
    fs.writeFileSync(FILE, JSON.stringify({ ...pmSettings(), ...u.before }, null, 2));
    detail = `settings back: ${JSON.stringify(u.before)}`;
  } else throw new StudioError(`Don't know how to undo ${u.kind}`);
  markUndone(id);
  logDecision('undo', d.subject, d.product, `${by} undid ${id} (${d.action}): ${detail}`);
  return { ok: true, undone: id, detail };
}

/** A revert of a pull request's squash commit on beta, pushed to beta (nothing goes live). */
/** Reverting a merge on beta and pushing it is a critical section (drain.ts). */
const revertOnBeta = (repo: string, pr: number, by: string) => criticalSync(`reverting #${pr} on ${repo}'s beta`, () => revertOnBetaNow(repo, pr, by));
function revertOnBetaNow(repo: string, pr: number, by: string) {
  const dir = path.join(PROJECTS, repo);
  git(dir, ['fetch', '--quiet', 'origin']);
  const sha = prCommit(repo, BETA, pr);
  if (!sha) throw new StudioError(`Can't find pull request #${pr}'s commit on ${BETA}`);
  const wt = path.join(PROJECTS, '.work', `revert-${repo}-${pr}`);
  fs.rmSync(wt, { recursive: true, force: true });
  git(dir, ['worktree', 'prune']);
  const w = git(dir, ['worktree', 'add', '--detach', wt, `origin/${BETA}`]);
  if (!w.ok) throw new StudioError(`worktree: ${w.err}`);
  try {
    const r = git(wt, ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.com', 'revert', '--no-edit', sha]);
    if (!r.ok) throw new StudioError(`git revert failed (beta changed the same lines since?): ${r.err.slice(0, 300)}`);
    git(wt, ['commit', '--amend', '-m', `Revert #${pr} on ${BETA} (undone by ${by} in Studio)`, '-c', 'user.name=Hawkes Studio']);
    const p = git(wt, ['push', '--quiet', 'origin', `HEAD:${BETA}`]);
    if (!p.ok) throw new StudioError(`push failed: ${p.err.slice(0, 300)}`);
    return `reverted ${sha.slice(0, 7)} (#${pr}) on ${BETA}`;
  } finally {
    git(dir, ['worktree', 'remove', '--force', wt]);
  }
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
  const cap = capacity();
  return `[Studio PM loop: this turn was started by Studio, not J. You are J's producer/PM. J sets direction with you in
Talk; you work the roadmap and the backlog with the agents so he comes back to finished, verified work.]

What came in since your last PM turn:
${evs.length ? evs.map((e) => `- ${e.kind}${e.subject ? ` (${e.subject})` : ''}: ${e.text}`).join('\n') : '- nothing new'}
${daily ? '\nThis is also the daily PM turn: triage the backlog and look over the roadmap.\n' : ''}
J's Inbox: ${inbox ?? 'empty'}.
Limits now: ${cap.active} agents working (at most ${s.maxConcurrent}), ${cap.started} of ${s.maxStartsPerDay} starts used today, ${s.maxTries} tries per task. Delegated merges into beta: ${s.delegatedMerges ? 'ON' : 'OFF (J approves merges)'}.

Do, with the studio_pm, studio_roadmap and studio tools:
1. Review each ready change (studio_change shows its verification: playtest outcome, review verdict and summary, the
   per-criterion results, video, preview). Merge it into beta (studio_pm merge) when it does what its task asks and
   meets its criteria; "unclear" criteria are judged again on beta. Otherwise send it back (studio_pm revise) with
   specific notes: which criterion failed, what the review saw, what to change. After ${s.maxTries} tries it goes to J.
2. Answer agent questions (studio_pm answer) from what J already decided: the roadmap item's goal, why and criteria,
   the thread (studio_comments), earlier answers. Only a real direction choice goes to J (studio_pm ask_j).
3. Daily turn and after the daily run: triage the backlog (studio_backlog). Merge duplicates (studio_pm triage
   duplicate), mark polish that's below the product's bar won't-fix with a one-line note (triage wontfix), link bugs to
   the roadmap item they belong to (triage link). Leave blockers open. Don't churn: skip what's fine.
4. Failures (an agent errored or made nothing): look at studio_change's log and summary; revise with a better note,
   or ask J if it's really his call.
5. Starting work is automatic (roadmap order, then the worst bugs, within the limits). Change the order or statuses
   with studio_roadmap when what came in says so (a blocker on a product jumps the queue: make or reorder a task).
6. The shared memory${daily ? ' (daily turn)' : ' (when there are candidates)'}: ${curationLine() || 'nothing waiting.'} Curate with memory_curate:
   confirm a candidate that is true and useful, merge near-duplicates (list shows likely pairs), fade what no longer
   holds, delete what is wrong. A candidate that contradicts one of J's decisions or the canon: dispute it and ask J
   (studio_pm ask_j) which holds; never edit or fade J's decisions yourself. When J decided something in a thread or an
   answer, record it as a decision quoting his words. Keep it short: entries are one line plus specifics.
Never: go live or roll back, merge Studio or Gen changes, launch GPU servers, raise limits, or decide direction. Those
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
export async function tick() {
  if (ticking || !started) return;
  ticking = true;
  try {
    await watch();
    await syncTasks();
    const s = pmSettings();
    if (!s.enabled) return;
    // A PM turn that just ended: its leftovers get the defaults.
    if (turn && !turnRunning()) {
      const done = turn;
      turn = null;
      await applyDefaults(done.subjects);
    }
    await applyDefaults([], s.graceMinutes * 60_000);
    await startWork();
    const daily = state().daily !== today() && new Date().getHours() >= s.dailyHour;
    if ((events.length || daily) && !turnRunning() && process.env.STUDIO_PM_TALK !== 'off') await runPmTurn(daily);
    lastError = null;
  } catch (e: any) {
    lastError = String(e.message ?? e);
    console.warn(`[pm] ${lastError}`);
  } finally {
    ticking = false;
  }
}

/** Defaults for subjects of the last turn, and for anything waiting longer than `olderThan`. */
async function applyDefaults(subjects: string[], olderThan?: number) {
  const { listChanges, getChange } = await changes();
  const now = Date.now();
  for (const c of listChanges({ status: 'ready' })) {
    if (!reviewable(c)) continue;
    if (subjects.includes(c.id) || (olderThan !== undefined && now - (c.updated ?? c.created) > olderThan && !turnRunning())) await defaultReview(c.id);
  }
  for (const c of listChanges({ status: 'failed' })) {
    if (!c.task) continue;
    const t = getTask(c.task);
    if (!t || t.change !== c.id || t.status === 'failed') continue;
    if (subjects.includes(c.id) || (olderThan !== undefined && now - (c.updated ?? c.created) > olderThan && !turnRunning())) {
      if (t.tries >= pmSettings().maxTries) {
        setTask(t.id, { status: 'failed' });
        askJ(`"${t.title}" (${name(t.product)}) failed ${t.tries} times. The last: ${c.detail ?? '?'}. Try another way, change the task, or drop it?`, { subject: t.id, product: t.product, options: ['try again', 'change it', 'drop it'], from: 'the default after 3 tries' });
      } else {
        // The branch may be gone or empty: a fresh change with what went wrong.
        await startTaskChange(t, `The last attempt (${c.id}) failed: ${c.detail ?? ''}. ${String(c.summary ?? '').slice(0, 600)}`).catch((e) => console.warn(`[pm] restart ${t.id}: ${e.message}`));
      }
    }
  }
  // Agent questions nobody answered go to J.
  for (const q of listQuestions('open')) {
    if (q.kind !== 'agent') continue;
    if (subjects.includes(q.subject ?? '') || (olderThan !== undefined && now - q.at > olderThan && !turnRunning())) {
      const c = q.subject ? getChange(q.subject) : null;
      setQuestion(q.id, { status: 'asked J' });
      askJ(`An agent working on "${c?.title ?? q.subject}" asks: ${q.text.slice(0, 1200)}`, { subject: c?.task ?? q.subject, product: q.product, forwards: q.id, topic: 'agent question', blocks: `the agent on ${q.subject} (paused)`, from: 'an agent question the PM could not answer' });
    }
  }
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
      const what = t ? `Task ${t.id} ("${t.title}", ${name(c.product)}, try ${t.tries} of ${pmSettings().maxTries}): change ${c.id}` : `Fix ${c.id} ("${c.title}", ${name(c.product)})`;
      pmEvent(c.status === 'ready' ? 'ready' : 'failed', `${what} is ${c.status === 'ready' ? 'ready to review' : 'failed'}: ${c.detail ?? ''}`, c.id, c.product);
    }
  }
  // Studio and Gen changes stay J's; questions on them still go through the PM (it may ask J).
  for (const r of db.prepare(`SELECT id, kind, status, detail, products, pm_seen FROM runs WHERE status != 'running' AND COALESCE(finished, started) > ? AND pm_seen IS NULL AND kind IN ('daily', 'beta', 'live')`).all(since) as any[]) {
    db.prepare(`UPDATE runs SET pm_seen = 'yes' WHERE id = ?`).run(r.id);
    const products = (parse(r.products) ?? []).map(name).join(', ');
    if (r.kind === 'daily') pmEvent('daily run', `The daily run ${r.id} finished (${r.status}): ${r.detail ?? ''}. Read studio_report { run: "${r.id}" } and triage the new findings.`, r.id);
    else pmEvent(r.kind === 'beta' ? 'beta run' : 'live check', `${r.kind === 'beta' ? 'Beta run' : 'Go live'} ${r.id} (${products}) ${r.status}: ${r.detail ?? ''}`, r.id);
  }
}

/** What the dashboard and studio_pm status show. */
export async function pmStatus() {
  const { listChanges } = await changes();
  return {
    settings: pmSettings(), capacity: capacity(), lastError, turn: turn && turnRunning() ? turn : null, pending: events,
    conversation: state().conversation ?? null, daily: state().daily ?? null,
    questions: listQuestions(), reviewing: listChanges({ status: 'ready' }).filter(reviewable).map((c) => ({ id: c.id, product: c.product, title: c.title, detail: c.detail, task: c.task })),
    log: listDecisions({ limit: 60 }),
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
  setTimeout(() => void tick(), 15_000).unref();
  setInterval(() => void tick(), 60_000).unref();
}

