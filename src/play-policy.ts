// When a game is playtested (J, 2026-11-11: "Make sure runpod isn't wasted on builds and playtests if at all
// possible", "Builds and playtests stay on GPUs. Just don't be wasteful", "playtests don't need to be so frequent
// either", "Do it during milestones"). That day Studio played about 490 playtests across 19 products: a daily run of
// every saved scenario, a play after every published build, a showcase play of every agent change, a play before and
// after every go-live, and one-off plays from Talk and agents. Each one kept a RunPod GPU worker busy.
//
// The rule, in this one place:
//   1. A product is played only at a milestone's end, on that milestone's one build (pm.ts milestoneCheck starts the one
//      beta run; unitybuild-policy.ts decides its one build). That run plays the milestone's scenarios once.
//   2. Never twice on the same build: a scenario already played to an end on a build, or being played on it now, is not
//      played again on it, whoever asks (a recheck, a rerun, a go-live, a person, a run started meanwhile). Its result
//      stands (claimPlay, pipeline.ts playScenario: the first play to ask claims the build's scenario, in one step).
//   3. Nothing else starts a play: no daily or scheduled plays, no play after a build, no per-change or showcase play, no
//      play before or after going live, no one-off play from Talk or an agent. A person asking to take a commit live
//      that no milestone played gets that commit played once (rule 2 still holds).
// A play that never reached an end (cut off, refused, stuck, cancelled, played in software) judged nothing, so it
// isn't counted: the next play of that build still plays it.
// Nothing here polls or watches: each starting place asks these functions once, when it would have started a play.
import { db } from './db.ts';

/** Why a beta run may play: its milestone's check, or a person taking a commit live that no milestone played. */
export type PlayCause = 'milestone' | 'golive';

/** The words a play that isn't started shows (a skipped step, an API answer). */
export const PLAY_RULE = 'playtests run once on each milestone\'s build, at the milestone\'s end (J, 2026-11-11)';

/** Whether a beta run plays at all: a milestone's check, or a person taking a commit live. Pure. */
export const playsFor = (cause: PlayCause | null | undefined): cause is PlayCause => cause === 'milestone' || cause === 'golive';

/** The scenario part of a step name ("smoke@local:phone" -> "smoke:phone"): where it played doesn't make it another play of the build. */
export const scenarioKey = (name: string) => {
  const [head, device] = name.split(':');
  return `${head.split('@')[0]}${device ? `:${device}` : ''}`;
};

export type PlayedBefore = { run: string; step: string; job: string | null; status: string; detail: string | null };

/**
 * The play of this scenario that already reached an end on this build (a done playtest step: its Gen job finished),
 * or null. build: the commit, or the build id, the step recorded as played (pipeline.ts: data.played.build ?? sha).
 */
db.exec(`CREATE TABLE IF NOT EXISTS play_claims (
  product TEXT NOT NULL, build TEXT NOT NULL, scenario TEXT NOT NULL, step TEXT NOT NULL, run TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (product, build, scenario)
)`);

/**
 * Claims this build's play of the scenario for one step, or returns the play that has it: one done on this build, or one
 * still playing (its step and run running). Synchronous (one statement after another, nothing awaited), so two runs
 * asking at once can't both get it. A claim whose play ended without playing (failed, cancelled, its run gone) is taken
 * over. null: this step plays.
 */
export function claimPlay(product: string, build: string | null | undefined, name: string, step: string, run: string, now = Date.now()): PlayedBefore | null {
  if (!build) return null;
  const done = playedBefore(product, build, name, step);
  if (done) return done;
  const scenario = scenarioKey(name);
  const c = db.prepare(`SELECT c.step, c.run, s.status AS step_status, s.job, s.detail, r.status AS run_status FROM play_claims c
    LEFT JOIN steps s ON s.id = c.step LEFT JOIN runs r ON r.id = c.run WHERE c.product = ? AND c.build = ? AND c.scenario = ?`).get(product, build, scenario) as any;
  if (c && c.step !== step && c.step_status === 'running' && c.run_status === 'running') {
    return { run: c.run, step: c.step, job: c.job ?? null, status: 'running', detail: 'being played now' };
  }
  db.prepare('INSERT OR REPLACE INTO play_claims (product, build, scenario, step, run, at) VALUES (?, ?, ?, ?, ?, ?)').run(product, build, scenario, step, run, now);
  return null;
}

export function playedBefore(product: string, build: string | null | undefined, name: string, except?: string): PlayedBefore | null {
  if (!build) return null;
  const want = scenarioKey(name);
  const rows = db.prepare(`SELECT id, run, name, job, status, detail FROM steps WHERE product = ? AND kind = 'playtest' AND status = 'done' AND job IS NOT NULL AND job != ''
    AND (json_extract(data, '$.played.build') = ? OR json_extract(data, '$.played.sha') = ?) ORDER BY started DESC LIMIT 50`).all(product, build, build) as any[];
  const hit = rows.find((r) => r.id !== except && scenarioKey(String(r.name)) === want);
  return hit ? { run: hit.run, step: hit.id, job: hit.job ?? null, status: hit.status, detail: hit.detail ?? null } : null;
}
