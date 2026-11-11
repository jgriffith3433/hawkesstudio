// What a build, a playtest and an agent pass came to, read into ONE of a fixed set of outcomes (J, 2026-11-11: "this is the
// 50th time"; the Nov 11 review found outcomes read wrong three times: a broken build read as "built nothing", a pass
// waiting for CPU room read as "hung", a job lost twice read as "the agent made no commit").
//
// Each classifier is total and pure: every input gets an outcome, an input it doesn't know is `unread` (nothing is
// concluded from it; it is looked at again), and no branch falls through to a default that blames the work. The sets are
// listed so a test can walk every member (test/outcomes.test.ts) and docs/stall-paths.md names them.

// ------------------------------------------------------------------------------------------------------------ builds

/**
 * What a beta run's build came to for a product:
 * - built: it ran and nothing before the playtest failed (a Unity build compiled; a run that failed only in its playtest still built).
 * - failed: a step before the playtest failed, or the run itself threw: the error is real and goes to an agent.
 * - unproven: it built, but not a commit with the task's merge (betabuild.ts buildProof): proves nothing about the task.
 * - held: the Unity hold (unitybuild-policy.ts) didn't build: nothing built, nothing checked, nothing blamed.
 * - cancelled: someone or something cancelled the build (cancel.ts): not a failure, not a build.
 * - superseded: a newer run took it over: the newer one's build counts.
 * - waiting: the run is still going or queued (Gen's builder queue, CPU room): neither built nor failed yet.
 * - unread: a status this reading doesn't know: looked at again, never counted as built or failed.
 */
export const BUILD_OUTCOMES = ['built', 'failed', 'unproven', 'held', 'cancelled', 'superseded', 'waiting', 'unread'] as const;
export type BuildOutcome = (typeof BUILD_OUTCOMES)[number];

export type BuildFacts = {
  /** The run's status ('done', 'failed', 'partial', 'running', 'queued', 'skipped', ...). */
  runStatus: string;
  /** Steps before the playtest and review that failed (a Studio-side fetch race already left out). */
  failedBuildSteps: number;
  /** Steps of the run that failed at all (a milestone's check failing only in its playtest still built). */
  failedSteps: number;
  held?: boolean;
  cancelled?: boolean;
  superseded?: boolean;
  /** betabuild.ts buildProof: whether the commit built includes the task's merge (Unity projects Studio builds). */
  proof?: { ok: boolean } | null;
};

export function buildOutcome(f: BuildFacts): BuildOutcome {
  if (f.cancelled) return 'cancelled';
  if (f.held) return 'held';
  if (f.superseded || f.runStatus === 'skipped') return 'superseded';
  if (f.proof && !f.proof.ok) return 'unproven';
  if (f.runStatus === 'running' || f.runStatus === 'queued') return 'waiting';
  if (f.failedBuildSteps > 0) return 'failed';
  if (f.runStatus === 'done') return 'built';
  // Over, not 'done': a run that failed or came out partial built when only its playtest failed; with no failed step at all
  // the run itself threw, and that is a failed build, not one that built nothing.
  if (f.runStatus === 'failed' || f.runStatus === 'partial') return f.failedSteps > 0 ? 'built' : 'failed';
  return 'unread';
}

// ---------------------------------------------------------------------------------------------------------- playtests

/**
 * What one playtest step came to:
 * - played: it ran to its end (its review judges it).
 * - stuck: the bot got stuck at a spot (the run says "stuck", or its outcome does): played again, never counted as missed.
 * - failed: the step threw or the job failed.
 * - skipped: not played (no scenario in the build, credits, capacity): nothing was checked.
 * - cancelled: cancelled in Gen or by Studio.
 * - running: still going.
 * - unread: a status this reading doesn't know.
 */
export const PLAY_OUTCOMES = ['played', 'stuck', 'failed', 'skipped', 'cancelled', 'running', 'unread'] as const;
export type PlayOutcome = (typeof PLAY_OUTCOMES)[number];

export function playOutcome(s: { status: string; detail?: string | null; outcome?: string | null }): PlayOutcome {
  if (s.status === 'cancelled') return 'cancelled';
  if (s.status === 'failed') return 'failed';
  if (s.status === 'skipped') return 'skipped';
  if (s.status === 'running' || s.status === 'queued') return 'running';
  if (s.status === 'done') return /\bstuck\b/i.test(String(s.detail ?? '')) || s.outcome === 'stuck' ? 'stuck' : 'played';
  return 'unread';
}
/** The outcomes that mean a play checked nothing (a check that broke): played again, never a miss, never a try. */
export const PLAYED_NOTHING: readonly PlayOutcome[] = ['stuck', 'failed', 'skipped', 'cancelled'];

// ----------------------------------------------------------------------------------------------------- agent passes

/**
 * What a change that says it is being worked on is doing, for the stuck-work look (agents.ts checkStuck):
 * - moving: its pass is alive and has shown a sign of life inside its step's time.
 * - waiting-for-room: its Cloud Run job is in line for CPU room (cpuroom.ts): that line ends it, it is not hung.
 * - waiting-to-start: its checkout, or memory beside running work: that ends when the work beside it ends.
 * - working-elsewhere: its own work runs elsewhere (a build, Gen jobs), with its own end.
 * - hung: its pass is alive here but silent past its step's time: given up on, a new pass carries it on.
 * - orphaned: nothing in this process works on it: carried on from its step.
 */
export const PASS_STATES = ['moving', 'waiting-for-room', 'waiting-to-start', 'working-elsewhere', 'hung', 'orphaned'] as const;
export type PassState = (typeof PASS_STATES)[number];

export function passState(f: { here: boolean; idleMs: number; stallMs: number; orphanMs: number; step: string; waitingForRoom: boolean; waitingToStart: boolean; elsewhere: boolean }): PassState {
  if (f.here ? f.idleMs < f.stallMs : f.idleMs < f.orphanMs) return 'moving';
  if (f.here && f.waitingToStart) return 'waiting-to-start';
  if (f.here && f.step === 'agent' && f.waitingForRoom) return 'waiting-for-room';
  if (f.elsewhere) return 'working-elsewhere';
  return f.here ? 'hung' : 'orphaned';
}
