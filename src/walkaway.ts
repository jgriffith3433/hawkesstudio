// Walk-away mode (J, 2026-10-18: "there's WAYYY too much going into my inbox ... just merge okay? ... I just want this
// system to build build build"). While it's on (settings.pm.walkAway, on by default):
//   - Studio and Gen changes merge into main by themselves once green (agents.ts walkAwayMerge); red CI or failed checks
//     get a fix pass of their agent instead (never a merge); protected files still wait for J
//   - the PM decides routine calls itself (pm.ts decideMiss: a task that misses its criteria on beta; one investigation
//     when many tasks fail the same way) and logs each in its decision log
//   - GPU budgets are approved by Studio up to costs.gpuAutoApprove per task within walkAwayGpuPerDay a day (roadmap.ts)
//   - stale merge cards settle at once (approvals.ts), and the Inbox keeps only J-only things (inbox.ts)
// Off: everything is exactly as before.
//
// The switch lives in the PM's settings file (pm.json, pm.ts pmSettings); this module reads it without importing pm.ts,
// so approvals.ts, inbox.ts, roadmap.ts and agents.ts can ask synchronously.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.ts';

export type WalkAwaySettings = {
  /** Walk-away mode on: Studio and the PM decide routine calls themselves (see above). */
  walkAway: boolean;
  /** Dollars of GPU budgets Studio approves by itself per day in walk-away mode; above that, one digest card for J. */
  walkAwayGpuPerDay: number;
};
export const WALK_DEFAULTS: WalkAwaySettings = { walkAway: true, walkAwayGpuPerDay: 25 };

/** Who merges and decides in walk-away mode (notes, the PM log, approved.by). */
export const WALK_AWAY_BY = 'Studio (walk-away)';

export function walkAwaySettings(): WalkAwaySettings {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'pm.json'), 'utf8'));
    return {
      walkAway: typeof j.walkAway === 'boolean' ? j.walkAway : WALK_DEFAULTS.walkAway,
      walkAwayGpuPerDay: typeof j.walkAwayGpuPerDay === 'number' ? j.walkAwayGpuPerDay : WALK_DEFAULTS.walkAwayGpuPerDay,
    };
  } catch {
    return { ...WALK_DEFAULTS };
  }
}
export const walkAwayOn = () => walkAwaySettings().walkAway;
