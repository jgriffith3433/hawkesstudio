// Walk-away mode (J, 2026-10-18: "there's WAYYY too much going into my inbox ... just merge okay? ... I just want this
// system to build build build"). While it's on (settings.pm.walkAway, on by default in J's Studio):
//   - Studio and Gen changes merge into main by themselves once green (agents.ts walkAwayMerge); red CI or failed checks
//     get a fix pass of their agent instead (never a merge); protected files still wait for J
//   - the PM decides routine calls itself (pm.ts decideMiss: a task that misses its criteria on beta; one investigation
//     when many tasks fail the same way) and logs each in its decision log
//   - GPU budgets are approved by Studio up to costs.gpuAutoApprove per task within walkAwayGpuPerDay a day (roadmap.ts)
//   - stale merge cards settle at once (approvals.ts), and the Inbox keeps only J-only things (inbox.ts)
//   - Approve cards approve themselves, as "Studio (walk-away)" (approvals.ts selfApprove, walkAwayCards): GPU budgets
//     only within the caps, and cost-raising settings and protected-file merges still wait for J
// Off: everything is exactly as before.
//
// A customer's Studio (tenancy.ts; J, 2026-11-01: "Make Walk Away mode available for Team accounts"): the owner turns
// it on in their own Settings, on a plan with the PM (Team and up; settings.ts refuses it below that with an Upgrade).
// It is off there until they do, and it spends nothing of theirs unless they say so: GPU budgets are approved by Studio
// only in walk-away mode, under their own walkAwayGpuPerTask and walkAwayGpuPerDay (both 0 at first: every budget is
// theirs to approve). There are no Studio/Gen changes there, and going live is always theirs.
//
// The switch lives in the PM's settings file (pm.json, pm.ts pmSettings); this module reads it without importing pm.ts,
// so approvals.ts, inbox.ts, roadmap.ts and agents.ts can ask synchronously.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.ts';
import { customerStudio } from './tenancy.ts';

export type WalkAwaySettings = {
  /** Walk-away mode on: Studio and the PM decide routine calls themselves (see above). */
  walkAway: boolean;
  /** Dollars of GPU budgets Studio approves by itself per day in walk-away mode; above that, one digest card for J. */
  walkAwayGpuPerDay: number;
  /**
   * A customer's Studio: a GPU budget under this many dollars Studio approves by itself in walk-away mode (0: every one
   * waits for the owner). J's Studio uses costs.gpuAutoApprove instead (the platform's budgets).
   */
  walkAwayGpuPerTask: number;
  /**
   * In walk-away mode, Approve cards approve themselves (approvals.ts selfApprove; J, 2026-11-01: "Make it so all cards
   * auto approve when in walk away mode"), within the GPU caps above; cost-raising settings and protected-file merges
   * still wait. Off: every card waits for a tap, as before.
   */
  walkAwayCards: boolean;
};
/** J's Studio: on, $25 a day. */
export const WALK_DEFAULTS: WalkAwaySettings = { walkAway: true, walkAwayGpuPerDay: 25, walkAwayGpuPerTask: 0, walkAwayCards: true };
/** A customer's Studio: off, and nothing spent by itself until the owner sets their caps. */
export const CUSTOMER_WALK_DEFAULTS: WalkAwaySettings = { walkAway: false, walkAwayGpuPerDay: 0, walkAwayGpuPerTask: 0, walkAwayCards: true };
export const walkAwayDefaults = (): WalkAwaySettings => ({ ...(customerStudio() ? CUSTOMER_WALK_DEFAULTS : WALK_DEFAULTS) });

/** Who merges and decides in walk-away mode (notes, the PM log, approved.by). */
export const WALK_AWAY_BY = 'Studio (walk-away)';

export function walkAwaySettings(): WalkAwaySettings {
  const d = walkAwayDefaults();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'pm.json'), 'utf8'));
    const n = (v: unknown, def: number) => (typeof v === 'number' && v >= 0 ? v : def);
    return {
      walkAway: typeof j.walkAway === 'boolean' ? j.walkAway : d.walkAway,
      walkAwayGpuPerDay: n(j.walkAwayGpuPerDay, d.walkAwayGpuPerDay),
      walkAwayGpuPerTask: n(j.walkAwayGpuPerTask, d.walkAwayGpuPerTask),
      walkAwayCards: typeof j.walkAwayCards === 'boolean' ? j.walkAwayCards : d.walkAwayCards,
    };
  } catch {
    return d;
  }
}
export const walkAwayOn = () => walkAwaySettings().walkAway;
/** Walk-away mode is on and its cards approve themselves (approvals.ts selfApprove). */
export const walkAwayCardsOn = () => {
  const w = walkAwaySettings();
  return w.walkAway && w.walkAwayCards;
};

/**
 * GPU budgets under this many dollars Studio approves by itself (roadmap.ts autoApproveGpu, the Inbox's digest).
 * J's Studio: costs.gpuAutoApprove. A customer's: their own walkAwayGpuPerTask, and only in walk-away mode (0 otherwise).
 */
export async function gpuAutoApproveLimit(): Promise<number> {
  if (customerStudio()) {
    const w = walkAwaySettings();
    return w.walkAway ? w.walkAwayGpuPerTask : 0;
  }
  return (await import('./costs.ts')).costSettings().gpuAutoApprove;
}
