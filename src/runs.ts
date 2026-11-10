// Which AI provider and model each run is on, from what the harness itself said, not from the settings (J, 2026-11-10:
// "I need someway to visualize what model and providers each run and agent is using in the studio interface. Super
// important that this is working correctly").
//
//   Live runs: every agent pass, scout and Talk answer while it runs: its provider, the model it was asked for, and the
//              model the harness reported in its stream's init event (Claude Code and the adapters in bin/ all send one).
//              The Resources tab shows them grouped by provider; liveMismatches is the health check that a change shows
//              the provider its running job is really on.
//   History:   per change, every start, provider switch (with why), reported model, park and resume (brain_events), so
//              the change's page can show "Claude (claude-sonnet-5-5) → Codex (gpt-5-codex): Claude hit its weekly limit".

import { db } from './db.ts';
import type { Harness } from './brains.ts';

db.exec(`CREATE TABLE IF NOT EXISTS brain_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  why TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS brain_events_change ON brain_events (change_id, id)');

/**
 * start: a pass began on a provider (its first, or the same provider as before); switch: it began on another provider than
 * the last pass (why says what moved it); model: the harness reported the model it runs; park: the provider stopped the
 * pass and the change waits (the next start or switch is its resume).
 */
export type BrainKind = 'start' | 'switch' | 'model' | 'park';
export type BrainEvent = { at: number; kind: BrainKind; harness: Harness; model: string | null; why: string | null };

const insert = db.prepare('INSERT INTO brain_events (at, change_id, kind, harness, model, why) VALUES (?, ?, ?, ?, ?, ?)');
const historyStmt = db.prepare('SELECT at, kind, harness, model, why FROM brain_events WHERE change_id = ? ORDER BY id DESC LIMIT ?');

export function noteBrain(change: string, e: Omit<BrainEvent, 'at'>, now = Date.now()) {
  try {
    insert.run(now, change, e.kind, e.harness, e.model ?? null, e.why ? e.why.slice(0, 300) : null);
  } catch { /* the history never stops a pass */ }
}

/** A change's events, oldest first (the last `limit`). */
export function brainHistory(change: string, limit = 60): BrainEvent[] {
  return (historyStmt.all(change, limit) as BrainEvent[]).reverse();
}

/**
 * What the change's current (or last) pass ran on: the provider of its latest start or switch, and the model the harness
 * reported after it (reported: true), else the model the pass asked for (reported: false). Null before its first pass.
 */
export function currentBrain(change: string): { harness: Harness; model: string | null; reported: boolean; since: number } | null {
  let reported: string | null = null;
  for (const e of [...brainHistory(change, 30)].reverse()) {
    if (e.kind === 'model' && reported == null) reported = e.model;
    if (e.kind === 'start' || e.kind === 'switch') return { harness: e.harness, model: reported ?? e.model, reported: reported != null, since: e.at };
  }
  return null;
}

/** The provider the last pass ran on (the one a new pass is compared with to call it a switch). */
export function lastHarness(change: string): Harness | null {
  return currentBrain(change)?.harness ?? null;
}

/**
 * Model names a harness reports. The adapters send the provider's name when the CLI didn't say which model it picked
 * ("auto" on Cursor): that isn't a model, so it reads as unknown.
 */
export function reportedModel(m: unknown): string | null {
  const s = typeof m === 'string' ? m.trim() : '';
  if (!s || ['claude', 'cursor', 'copilot', 'gemini', 'antigravity', 'codex', 'grok', 'unknown'].includes(s.toLowerCase())) return null;
  return s.slice(0, 80);
}

// ------------------------------------------------------------------ live runs

export type RunKind = 'agent' | 'scout' | 'talk' | 'pm' | 'review';
export type LiveRun = {
  id: string; kind: RunKind; harness: Harness; model: string | null; reported: boolean; since: number;
  change?: string | null; product?: string | null; title?: string | null;
};
const live = new Map<string, LiveRun>();

/** A run started: shown until the returned end is called (safe to call twice). */
export function runStarted(r: Omit<LiveRun, 'since' | 'reported'> & { since?: number }) {
  const run: LiveRun = { ...r, model: r.model ?? null, reported: false, since: r.since ?? Date.now() };
  live.set(r.id, run);
  return () => { if (live.get(r.id) === run) live.delete(r.id); };
}
/** The model the run asked for (shown until the harness reports its own). */
export function runAsked(id: string, model: string | null) {
  const r = live.get(id);
  if (r && model && !r.reported) r.model = model;
}
/** The harness said which model it runs (its init event). */
export function runReported(id: string, model: string | null) {
  const r = live.get(id);
  if (r && model) { r.model = model; r.reported = true; }
}
export const liveRuns = (): LiveRun[] => [...live.values()].sort((a, b) => a.since - b.since);

/** Live runs per provider: how many, of which kinds, on which models (the Resources tab's provider load). */
export function loadByProvider(runs = liveRuns()) {
  const by = new Map<Harness, { harness: Harness; running: number; kinds: Record<string, number>; models: Record<string, number> }>();
  for (const r of runs) {
    const x = by.get(r.harness) ?? { harness: r.harness, running: 0, kinds: {}, models: {} };
    x.running++;
    x.kinds[r.kind] = (x.kinds[r.kind] ?? 0) + 1;
    const m = r.model ? `${r.model}${r.reported ? '' : ' (asked)'}` : 'model not reported yet';
    x.models[m] = (x.models[m] ?? 0) + 1;
    by.set(r.harness, x);
  }
  return [...by.values()].sort((a, b) => b.running - a.running);
}

/**
 * The health check: a change whose page shows another provider than the job really running it. `shown` is what the
 * change shows (brainOfChange). Empty when all agree. (A model a harness didn't report shows as "asked", not as wrong.)
 */
export function liveMismatches(shown: (change: string) => { harness?: string | null } | null, runs = liveRuns()) {
  const out: { change: string; text: string }[] = [];
  for (const r of runs) {
    if (r.kind !== 'agent' || !r.change) continue;
    const s = shown(r.change);
    if (s && s.harness && s.harness !== r.harness) out.push({ change: r.change, text: `${r.change} shows ${s.harness} but its pass runs on ${r.harness}` });
  }
  return out;
}
