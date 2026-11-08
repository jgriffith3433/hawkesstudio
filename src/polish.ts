// The polish list (the owner's gaps list, 2026-11-08: "a polish list that never expires, scored by player pain, with a
// weekly polish pass per product"). Polish findings stay on the ideas list until they're fixed or J says won't fix;
// only plain ideas expire (backlog.ts expireIdeas). The list is ordered by how much a player suffers from each item
// (painScore), and once a week per game, after the daily run, an agent takes the top POLISH_BATCH items in one change
// (weeklyPolish: the brief for it is a polish brief, agents.ts jobKind). No timer of its own: the daily run calls it.

import { db } from './db.ts';
import type { Finding } from './backlog.ts';

/** Days between a game's polish passes. */
export const POLISH_DAYS = 7;
/** Items one polish pass takes. */
export const POLISH_BATCH = 5;
/** Who starts a polish pass (changes.started_by): how a pass is found again, and how the brief knows it is one. */
export const POLISH_BY = 'the weekly polish pass';

const SEVERITY: Record<string, number> = { blocker: 8, bug: 5, polish: 3, idea: 1 };
/** What a player feels most: control and camera first, then what they see, then words on screen. */
const FELT: [RegExp, number][] = [
  [/camera|control|input|latency|stuck|jitter|stutter|hitch|lag|clip|fall(s|ing)? through|snap|jump|collision|movement|move/i, 1.6],
  [/z-?fight|flicker|float|sunk|stretch|texture|lighting|model|building|animation|slid/i, 1.25],
  [/text|label|ui|button|menu|font/i, 1.0],
];

/**
 * How much a finding hurts a player: severity, how often it's been seen (log, so a constant nag doesn't drown the
 * rest), how it's felt (FELT), and whether it is still being seen (last two weeks). Higher is worse.
 */
export function painScore(f: Pick<Finding, 'severity' | 'seen' | 'title' | 'area' | 'detail' | 'last_seen'>, now = Date.now()) {
  const sev = SEVERITY[f.severity] ?? 2;
  const seen = 1 + Math.log(Math.max(1, Number(f.seen) || 1));
  const text = `${f.title ?? ''} ${f.area ?? ''} ${f.detail ?? ''}`;
  const felt = FELT.find(([re]) => re.test(text))?.[1] ?? 1.1;
  const fresh = now - (Number(f.last_seen) || 0) <= 14 * 86_400_000 ? 1 : 0.7;
  return Math.round(sev * seen * felt * fresh * 10) / 10;
}

const parseShots = (r: any) => { try { return JSON.parse(r.shots ?? '[]'); } catch { return []; } };

/** A product's polish list, worst for a player first (status idea, severity polish; never expired). */
export function polishList(product?: string | null, limit = 50, now = Date.now()) {
  const rows = (product
    ? db.prepare(`SELECT * FROM findings WHERE status = 'idea' AND severity = 'polish' AND product = ?`).all(product)
    : db.prepare(`SELECT * FROM findings WHERE status = 'idea' AND severity = 'polish'`).all()) as any[];
  return rows.map((r) => ({ ...r, shots: parseShots(r), pain: painScore(r, now) } as Finding & { pain: number }))
    .sort((a, b) => b.pain - a.pain || b.last_seen - a.last_seen)
    .slice(0, limit);
}

/**
 * Once: polish that expired before the polish list was kept (backlog.ts used to expire polish with ideas after 14
 * days unseen) goes back on it. Idempotent (a migrations row records it).
 */
export function restoreExpiredPolish() {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  if (db.prepare(`SELECT id FROM migrations WHERE id = 'polish-never-expires'`).get()) return 0;
  const n = Number(db.prepare(`UPDATE findings SET status = 'idea', note = COALESCE(note || ' · ', '') || 'Back on the polish list (polish no longer expires).', updated = ? WHERE status = 'expired' AND severity = 'polish'`).run(Date.now()).changes);
  db.prepare(`INSERT INTO migrations (id, at) VALUES ('polish-never-expires', ?)`).run(Date.now());
  return n;
}

/** When a product's last polish pass started, or null. */
export function lastPolishPass(product: string): number | null {
  const r = db.prepare(`SELECT MAX(created) AS at FROM changes WHERE product = ? AND started_by = ?`).get(product, POLISH_BY) as any;
  return r?.at ?? null;
}

/** Whether a product is due a polish pass now: none yet, or the last one POLISH_DAYS or more ago, and something to polish. */
export function polishDue(product: string, now = Date.now()) {
  const last = lastPolishPass(product);
  if (last !== null && now - last < POLISH_DAYS * 86_400_000) return false;
  return polishList(product, 1, now).length > 0;
}

/**
 * After a daily run: each game that's due gets one change on its top POLISH_BATCH polish items by pain. `start` is
 * agents.ts startFix (passed in, so this module stays free of the agent machinery and testable). Returns what started
 * and, per product, why not when it didn't (the day's agent budget, a product managed elsewhere).
 */
export function weeklyPolish(products: { id: string }[], start: (product: string, findings: string[], o: { auto: boolean; by: string }) => string, now = Date.now()) {
  const started: { product: string; change: string; findings: string[] }[] = [];
  const skipped: { product: string; why: string }[] = [];
  for (const p of products) {
    if (!polishDue(p.id, now)) continue;
    const items = polishList(p.id, POLISH_BATCH, now).map((f) => f.id);
    try {
      started.push({ product: p.id, change: start(p.id, items, { auto: true, by: POLISH_BY }), findings: items });
    } catch (e: any) {
      skipped.push({ product: p.id, why: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { started, skipped };
}
