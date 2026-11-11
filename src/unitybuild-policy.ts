// When a Unity build runs by itself (J, 2026-11-11: "I don't know why we have so many unity builds that is just a waste
// if we are doing so much development. Unity builds should really just be for the milestone end but only if there's not
// more work to be done"). That day about 20 Unity builds (8 vCPU Cloud Run jobs each, hawkes-unity-build and
// hawkes-unity-build-customer in us-east4) were queued at once: one per agent change's verify, one per beta push, one per
// beta run after a merge. They used up the region's CPU quota and Studio's own server couldn't start.
//
// The rule, in this one place, for a project Studio builds from its `builds` list with a unity build (betabuild.ts
// unityBuildOf): a full Unity build that nobody asked for runs only when
//   1. a milestone of that project is complete in code (every task of its items merged into beta, roadmap.ts
//      codeComplete; not "built by beta", which would wait for the very build this holds), and
//   2. nothing else is queued for the project: no agent change queued or in flight, no roadmap task in progress, and no
//      planned task that will start by itself (one blocked by a stuck task, or waiting for the owner's GPU budget, won't).
// Then one build of beta's head runs (pm.ts milestoneCheck starts it; the same commit is never built twice, builds.ts
// buildOne), and the flow carries on from it: the milestone's playtest, the one beta playtest before going live, go live.
//
// Always built: what a person asked for (the Inbox's Build again, the builds route, Talk's build tool, rebuilding the
// beta site), a build-* tag, the release build when going live, and a retry of a build that already ran (buildaccess.ts,
// inbox.ts: the same build finishing after an infrastructure failure, not a new one). Every other start is held, and
// says so where its run, step or change shows it (HELD). Changes in between are checked by the compile gate
// (compilecheck.ts: Gen compiles the branch, no player build), not by a build of their own (agents.ts verifyChange).
// Nothing here polls: the PM's pass after a merge, or after a change of the project ends, is what finds it idle.
import { db } from './db.ts';
import { loadProducts } from './config.ts';
import * as R from './roadmap.ts';
import { beginWait, endWait, onDeadline } from './waits.ts';

/** What started a build: a person, a build-* tag, the go-live release, a retry of a build that ran, a milestone's check, or anything else (auto). */
export type UnityBuildCause = 'person' | 'tag' | 'release' | 'retry' | 'milestone' | 'auto';

/** What the rule reads about a project (unityWork): pure data, so the rule itself is a pure function. */
export type UnityWork = {
  name: string;
  /** An open milestone of the project whose items are all complete in code, or null. */
  milestone: { id: string; title: string } | null;
  /** Agent changes of the project still queued or in flight. */
  changes: string[];
  /** Roadmap tasks of the project in progress, or planned and able to start by themselves. */
  tasks: string[];
  /** When the oldest merged task with no build of its own (none yet, or one that proved nothing) merged, or null. */
  unbuiltSince?: number | null;
  /** The time the rule is asked at (tests pass it; default now). */
  now?: number;
};

/**
 * The longest merged work waits for its Unity build (the same 6 h a complete milestone waits for more work,
 * milestone-batch.ts). The hold is a wait with an end: a project that never goes quiet, or whose work sits outside any
 * complete milestone, still gets one build of beta's head this often, so merged work can't wait for ever (Yooba Land,
 * 2026-11-11: 13 merged tasks with no build while agents kept working on it). One build at a time per project still holds
 * (builds.ts), so this is at most one build per project per 6 h under constant work.
 */
export const UNITY_HOLD_MAX_MS = () => Number(process.env.STUDIO_UNITY_HOLD_MAX_MS) || 6 * 3600_000;

export type UnityVerdict = { go: boolean; why: string };

/** The words a held build shows (on its beta step, its change, the hook's answer, the log). */
export const heldWords = (name: string) => `held: Unity builds run once the milestone is complete and nothing else is queued for ${name}`;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The rule. Pure: the same cause and work always give the same verdict. */
export function unityBuildVerdict(cause: UnityBuildCause, w: UnityWork): UnityVerdict {
  if (cause === 'person') return { go: true, why: 'a person asked for this build' };
  if (cause === 'tag') return { go: true, why: 'a build-* tag asked for this commit' };
  if (cause === 'release') return { go: true, why: 'going live needs the release build' };
  if (cause === 'retry') return { go: true, why: 'a retry of a build that already ran' };
  const waited = w.unbuiltSince ? (w.now ?? Date.now()) - w.unbuiltSince : 0;
  if (waited >= UNITY_HOLD_MAX_MS()) return { go: true, why: `merged work has waited ${Math.round(waited / 3600_000)} h for a build (at most ${Math.round(UNITY_HOLD_MAX_MS() / 3600_000)} h): one build of beta's head now` };
  const queued = [w.changes.length ? plural(w.changes.length, 'agent change') : '', w.tasks.length ? plural(w.tasks.length, 'roadmap task') : ''].filter(Boolean);
  if (!w.milestone) return { go: false, why: `${heldWords(w.name)} (no milestone of it is complete yet${queued.length ? `; still queued: ${queued.join(', ')}` : ''})` };
  // The milestone's own check asked this rule when it started (milestoneBuildDue): work queued since then (the PM starts
  // the next bug fix in the same pass) doesn't take that one build away from it.
  if (cause === 'milestone') return { go: true, why: `milestone "${w.milestone.title}" is complete: its one build` };
  if (queued.length) return { go: false, why: `${heldWords(w.name)} (milestone "${w.milestone.title}" is complete in code, but still queued: ${queued.join(', ')})` };
  return { go: true, why: `milestone "${w.milestone.title}" is complete and nothing else is queued for ${w.name}` };
}

/** Whether this project's Unity builds go by the rule: a project Studio builds from GitHub with a unity build. */
export const unityGatedProduct = R.unityGated;

/** Agent changes still on their way: queued, an agent on them, ready but not merged, waiting on an answer or on Gen. */
const CHANGE_LIVE = ['queued', 'working', 'verifying', 'revising', 'ready', 'needs answer', 'waiting on Gen'];
/** Tasks being worked on (an agent, a question, a review). Planned ones are read one by one (they may never start). */
const TASK_WORKING = ['working', 'needs answer', 'review'];

/** What the rule reads about a project, from the database. */
export function unityWork(product: string): UnityWork {
  const name = (() => { try { return loadProducts().find((x) => x.id === product)?.name ?? product; } catch { return product; } })();
  let changes: string[] = [];
  try {
    changes = (db.prepare(`SELECT id FROM changes WHERE product = ? AND status IN (${CHANGE_LIVE.map(() => '?').join(',')})`).all(product, ...CHANGE_LIVE) as { id: string }[]).map((r) => r.id);
  } catch { /* no changes table: agents.ts not loaded, so no changes */ }
  const tasks: string[] = [];
  const rows = db.prepare(`SELECT t.id, t.status FROM tasks t JOIN items i ON i.id = t.item WHERE t.product = ? AND (t.status IN (${TASK_WORKING.map(() => '?').join(',')})
    OR (t.status = 'planned' AND (i.status IN ('planned', 'in progress') OR (i.status = 'done' AND i.consumed IS NOT NULL))))`).all(product, ...TASK_WORKING) as { id: string; status: string }[];
  for (const r of rows) {
    if (r.status !== 'planned') { tasks.push(r.id); continue; }
    // A planned task that can't start by itself (behind an idea, a failed or missing task, or the owner's GPU budget)
    // isn't work Studio will do: counting it would hold the build for ever.
    const t = R.getTask(r.id);
    if (!t) continue;
    if (R.blockedBy(t).some((d) => R.STUCK_DEPENDENCY.includes(d.status))) continue;
    if (!R.gpuCleared(t)) continue;
    tasks.push(r.id);
  }
  const milestone = (R.listMilestones({ product, status: 'open' }) as any[])
    .find((m) => m.items.some((i: any) => i.product === product) && R.milestoneComplete(m)) ?? null;
  return { name, milestone: milestone ? { id: milestone.id, title: milestone.title } : null, changes, tasks, unbuiltSince: unbuiltSince(product) };
}

/** When the oldest merged task of the project that no build has covered merged (no build on it, or one that proved nothing). */
export function unbuiltSince(product: string): number | null {
  const rows = db.prepare(`SELECT merged_at, build FROM tasks WHERE product = ? AND status = 'merged' AND merged_at IS NOT NULL`).all(product) as { merged_at: number; build: string | null }[];
  let oldest: number | null = null;
  for (const r of rows) {
    let b: any = null;
    try { b = r.build ? JSON.parse(r.build) : null; } catch { /* unreadable: treat as no build */ }
    if (b && (b.ok || !b.unproven)) continue; // built, or its build failed and an agent fixes it
    if (oldest === null || r.merged_at < oldest) oldest = r.merged_at;
  }
  return oldest;
}

/** The verdict for one start of a project's Unity build (builds.ts startBuild, the beta run, a change's verify). */
export function unityBuildGate(product: string, cause: UnityBuildCause): UnityVerdict {
  if (cause !== 'auto' && cause !== 'milestone') return unityBuildVerdict(cause, { name: product, milestone: null, changes: [], tasks: [] });
  const work = unityWork(product);
  const v = unityBuildVerdict(cause, work);
  recordHold(product, work, v);
  return v;
}

/**
 * The hold is a wait of the shared rule (waits.ts, point unity-hold): while merged work has no build and the verdict holds
 * it, the wait is recorded with its deadline (UNITY_HOLD_MAX_MS after the oldest merge), so a restart arms it again and
 * the deadline wakes the PM by itself; once the build may go, or nothing waits for one, the wait ends.
 */
export function recordHold(product: string, w: UnityWork, v: UnityVerdict) {
  if (!v.go && w.unbuiltSince) {
    beginWait('unity-hold', product, { waitsOn: `a complete milestone with nothing else queued for ${w.name}`, deadlineAt: w.unbuiltSince + UNITY_HOLD_MAX_MS(), since: w.unbuiltSince, product });
  } else {
    endWait('unity-hold', product, 'event');
  }
}
// At the deadline the verdict says go (the same rule: unityBuildVerdict) and the PM's next pass starts the one build.
onDeadline('unity-hold', async () => { try { (await import('./pm.ts')).kick(0); } catch { /* the PM isn't loaded here: its start-up pass asks */ } });

/** Whether a milestone's check may build this project now (pm.ts milestoneCheck asks before it starts the one beta run). */
export const milestoneBuildDue = (product: string) => unityBuildGate(product, 'auto');

/** The cause a build start carries when its caller named none (builds.ts StartOptions): asked, unless a trigger or change started it. */
export function causeOf(o: { cause?: UnityBuildCause; trigger?: string; change?: string }): UnityBuildCause {
  if (o.cause) return o.cause;
  if (o.trigger === 'tag') return 'tag';
  if (o.trigger || o.change) return 'auto';
  return 'person';
}

/** A beta run whose Unity build of beta's head was held (its build step says so): it built nothing and checked nothing. */
export function heldBuildRun(run: string, product?: string): string | null {
  const rows = db.prepare(`SELECT data FROM steps WHERE run = ? AND kind = 'build'${product ? ' AND product = ?' : ''}`).all(...(product ? [run, product] : [run])) as { data: string | null }[];
  for (const r of rows) {
    try { const d = r.data ? JSON.parse(r.data) : null; if (d?.held) return String(d.held); } catch { /* not ours */ }
  }
  return null;
}
