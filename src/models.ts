// Which models a harness refused ("Model X from --model flag is not available": the account's plan doesn't have it).
// Learned from the runs themselves: tuning (tuning.ts) skips a refused model for a day and steps down a tier, so one
// wrong id in Settings costs one pass at most, not every run (J, 2026-10-20: 4 content runs died in 2 s on an Opus id).

import { db, J, parse } from './db.ts';
import type { Harness } from './brains.ts';

const KEY = 'models.unavailable';
/** A refusal is trusted for a day: a plan change is noticed the next day. */
export const REFUSAL_MS = 24 * 3600_000;
const REFUSED = /Model\s+"?([\w.\-:/]+)"?\s+(?:from\s+--model\s+flag\s+)?(?:is\s+not\s+available|not\s+found|does\s+not\s+exist|is\s+not\s+supported)/i;

type Gone = Record<string, number>;
const load = (): Gone => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  return (r ? parse(r.value) : {}) as Gone;
};

/** The model a harness refused, from its output, or null. */
export const refusedModelOf = (text: string): string | null => REFUSED.exec(text)?.[1] ?? null;

export function unavailableModels(now = Date.now()): { harness: Harness; model: string; at: number }[] {
  return Object.entries(load()).filter(([, at]) => now - at < REFUSAL_MS).map(([k, at]) => {
    const [harness, ...m] = k.split('|');
    return { harness: harness as Harness, model: m.join('|'), at };
  });
}

export function modelUnavailable(harness: Harness, model: string, now = Date.now()) {
  if (!model) return false;
  const at = load()[`${harness}|${model}`];
  return typeof at === 'number' && now - at < REFUSAL_MS;
}

/** Records a refusal. Returns false when it was already known (a requeue must not loop on the same model). */
export function markModelUnavailable(harness: Harness, model: string, now = Date.now()) {
  if (modelUnavailable(harness, model, now)) return false;
  const all = load();
  for (const [k, at] of Object.entries(all)) if (now - at >= REFUSAL_MS) delete all[k];
  all[`${harness}|${model}`] = now;
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(KEY, J(all), now, 'Studio');
  return true;
}

export function clearUnavailable(harness?: Harness) {
  const all = load();
  for (const k of Object.keys(all)) if (!harness || k.startsWith(`${harness}|`)) delete all[k];
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(KEY, J(all), Date.now(), 'Studio');
}
