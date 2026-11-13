// The events that can end a park (src/parks.ts): a Hawkes Gen job finishing, credits added, a GPU server coming up, a
// GPU budget approved, a provider coming back. This file has no imports so gen.ts, creditwait.ts and gpustart.ts can
// raise them without a cycle; the PM listens (pm.ts) and looks at its parked tasks once per event. Nothing here is a timer.

export type ParkEvent = 'gen-job-done' | 'credits-added' | 'gpu-up' | 'budget-approved' | 'provider-back' | 'roadmap-refill';

const last = new Map<ParkEvent, number>();
let listener: ((e: ParkEvent) => void) | null = null;
export const bootedAt = Date.now();

/** Something a parked task may be waiting for happened. */
export function parkEvent(e: ParkEvent, now = Date.now()) {
  last.set(e, now);
  try { listener?.(e); } catch { /* the listener's own failure never stops the raiser */ }
}
/** The PM's wake-up (one listener). */
export function onParkEvent(fn: ((e: ParkEvent) => void) | null) { listener = fn; }
/** When the newest of the given events (default: all) happened, or 0. */
export function lastParkEvent(of?: ParkEvent[]): number {
  let m = 0;
  for (const [k, at] of last) if (!of || of.includes(k)) m = Math.max(m, at);
  return m;
}
/** For tests. */
export function forgetParkEvents() { last.clear(); }
