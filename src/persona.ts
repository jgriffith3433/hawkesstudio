// The newcomer persona (J, 2026-11-11: "Studio finds where a real newcomer gets lost, which no scripted bot can show";
// reference: nunu.ai and modl.ai play from the screen alone, Roblox onboarding funnels find the steepest drop).
//
// A mode of Hawkes Gen's playtest.run (params `persona: "newcomer"`, only with the built-in first-five scenario): a vision
// model plays the page from the screen alone (no DOM, no contract), says what it is trying to do at each step, and marks a
// LOST stretch when nothing progressed for 15 s or more, or inputs failed again and again. Gen reports, in the result:
//
//   { type: 'persona-step', t, detail: '{"intent": "..."}' }                         what it tried (the timeline's lines)
//   { type: 'lost', t, detail: '{"from","to","reason":"idle"|"failed-inputs","intent","shot"?}' }   one stretch
//   result.personaCost  dollars of the vision model's calls (also `persona.cost`)
//
// Here: when it runs (once per game per week and device, claimed BEFORE the play so a second ask starts nothing: the
// claim table), what Studio does with the result (the timeline, a finding per lost stretch with its clip, the critic's
// evidence, the cost on the run line). Gen's half is its own repo's change; until it ships, a result with no persona
// events says "persona: not reported" instead of guessing.

import { db } from './db.ts';
import { newId } from './db.ts';
import { fileUrl } from './gen.ts';

export const PERSONA = 'newcomer';
/** No progress for this long is a lost stretch (seconds). */
export const LOST_SECONDS = 15;
/** This many failed inputs in a row is one too. */
export const FAILED_INPUTS = 3;

db.exec(`CREATE TABLE IF NOT EXISTS persona_claims (product TEXT NOT NULL, device TEXT NOT NULL, week TEXT NOT NULL, at INTEGER NOT NULL, step TEXT, PRIMARY KEY (product, device, week))`);

export type Lost = { from: number; to: number; seconds: number; reason: 'idle' | 'failed-inputs'; intent: string; shot: string | null };
export type PersonaStep = { at: number; intent: string };
export type Persona = {
  device: 'desktop' | 'phone';
  steps: PersonaStep[];
  lost: Lost[];
  lostSeconds: number;
  /** Dollars of the persona's own model calls; null: Gen didn't report it. */
  cost: number | null;
  clip: { asset: string } | null;
  /** False: the play carried no persona events at all (Gen without the mode), so nothing is claimed about it. */
  reported: boolean;
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r1 = (n: number) => Math.round(n * 10) / 10;
const detailOf = (e: any): any => {
  if (e?.detail === undefined || e?.detail === null) return {};
  if (typeof e.detail === 'object') return e.detail;
  try { const d = JSON.parse(String(e.detail)); return d && typeof d === 'object' ? d : { intent: String(d) }; } catch { return { intent: String(e.detail) }; }
};

/** Monday 00:00 UTC of the week a time falls in, as a date: the weekly cap's key. */
export function weekOf(now = Date.now()): string {
  const d = new Date(now);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

/**
 * Take this week's persona run for a game and device. True once per game, device and week: the claim is written before the
 * play (a failed play still cost money, so it counts), and the second ask gets false and starts nothing.
 */
export function claimPersona(product: string, device: 'desktop' | 'phone', now = Date.now()): boolean {
  const r: any = db.prepare(`INSERT OR IGNORE INTO persona_claims (product, device, week, at) VALUES (?, ?, ?, ?)`).run(product, device, weekOf(now), now);
  return Number(r.changes) === 1;
}
export const personaClaimed = (product: string, device: 'desktop' | 'phone', now = Date.now()) =>
  !!db.prepare(`SELECT 1 FROM persona_claims WHERE product = ? AND device = ? AND week = ?`).get(product, device, weekOf(now));
export const noteClaimStep = (product: string, device: 'desktop' | 'phone', step: string, now = Date.now()) =>
  void db.prepare(`UPDATE persona_claims SET step = ? WHERE product = ? AND device = ? AND week = ?`).run(step, product, device, weekOf(now));

/** A resumed play (a restart re-attached to the same Gen job) is the persona's when this step took the claim. */
export const claimStepIs = (product: string, device: 'desktop' | 'phone', step: string, now = Date.now()) =>
  !!db.prepare(`SELECT 1 FROM persona_claims WHERE product = ? AND device = ? AND week = ? AND step = ?`).get(product, device, weekOf(now), step);

/** Gen's extra params for a persona play (added to firstFiveParams). */
export function personaParams(): Record<string, unknown> {
  return { persona: PERSONA, personaLostSeconds: LOST_SECONDS, personaFailedInputs: FAILED_INPUTS };
}

/** The persona's timeline from a playtest result. Pure. Stretches are sorted by start and merged when they overlap. */
export function personaOf(r: any, device: 'desktop' | 'phone' = 'desktop'): Persona {
  const events: any[] = Array.isArray(r?.events) ? r.events : [];
  const steps: PersonaStep[] = events.filter((e) => e?.type === 'persona-step').map((e) => ({ at: r1(num(e.t) ?? 0), intent: String(detailOf(e).intent ?? '').slice(0, 200) }));
  const raw: Lost[] = events.filter((e) => e?.type === 'lost').map((e) => {
    const d = detailOf(e);
    const from = r1(num(d.from) ?? num(e.t) ?? 0);
    const to = r1(Math.max(from, num(d.to) ?? from));
    return { from, to, seconds: r1(to - from), reason: d.reason === 'failed-inputs' ? 'failed-inputs' : 'idle', intent: String(d.intent ?? '').slice(0, 200), shot: typeof d.shot === 'string' ? d.shot : null };
  }).sort((a, b) => a.from - b.from);
  const lost: Lost[] = [];
  for (const s of raw) {
    const last = lost[lost.length - 1];
    if (last && s.from <= last.to) { last.to = Math.max(last.to, s.to); last.seconds = r1(last.to - last.from); } else lost.push({ ...s });
  }
  const cost = num(r?.personaCost) ?? num(r?.metrics?.['persona.cost']);
  return {
    device, steps, lost,
    lostSeconds: r1(lost.reduce((n, l) => n + l.seconds, 0)),
    cost: cost === null ? null : Math.round(cost * 1000) / 1000,
    clip: r?.video ? { asset: String(r.video) } : null,
    reported: steps.length > 0 || events.some((e) => e?.type === 'lost') || cost !== null,
  };
}

const mmss = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
export const money = (n: number | null) => (n === null ? 'cost not reported' : `$${n.toFixed(2)}`);

/** The persona's cost, said for a run line / step detail. */
export const personaLine = (p: Persona) => (p.reported ? `persona ${money(p.cost)} · ${p.lost.length} lost stretch${p.lost.length === 1 ? '' : 'es'} (${p.lostSeconds} s)` : 'persona: not reported by Gen');

/** The persona timeline as report lines: each lost stretch with its start, length, why and the clip at that moment. */
export function personaLines(p: Persona | null | undefined, opts: { step?: string } = {}): string[] {
  if (!p) return [];
  const who = p.device === 'phone' ? 'Phone 390x844 touch' : 'Desktop';
  if (!p.reported) return [`- **${who} newcomer persona:** Gen didn't report a persona timeline for this play.`];
  const out = [`- **${who} newcomer persona** (${money(p.cost)}): ${p.lost.length ? `lost ${p.lost.length} time${p.lost.length === 1 ? '' : 's'}, ${p.lostSeconds} s in all.` : 'never lost.'}`];
  for (const l of p.lost) {
    const clip = p.clip ? ` · [clip at ${mmss(l.from)}](${fileUrl(p.clip.asset)}#t=${Math.floor(l.from)},${Math.ceil(l.to)})${opts.step ? ` · [playtest](#playtests/${opts.step})` : ''}` : '';
    out.push(`  - lost at ${l.from} s for ${l.seconds} s (${l.reason === 'failed-inputs' ? 'inputs kept failing' : `no progress for ${LOST_SECONDS} s or more`})${l.intent ? `, trying to: ${l.intent}` : ''}${clip}`);
  }
  return out;
}

/** The critic's evidence block for clarity and first-five: lost counts and seconds per device, the stretches' intents. */
export function personaBlock(product: string): string {
  const rows = latestPersona(product);
  if (!rows.length) return 'No newcomer persona play yet this week (it plays once per game per week, from the screen alone).\n';
  const L = rows.flatMap((p) => personaLines(p));
  return `A newcomer persona played the first five minutes from the screen alone and marked where it got lost (each stretch of ${LOST_SECONDS} s or more with no progress, or repeated failed inputs). Score "clarity" and "first five minutes" down for each stretch, harder the longer it is, and name the stretch:\n${L.join('\n')}\n`;
}

/** The last persona timeline per device, from the steps' data (7 days). */
export function latestPersona(product: string, now = Date.now()): Persona[] {
  const out: Persona[] = [];
  for (const dev of ['desktop', 'phone'] as const) {
    const names = ['local', 'live'].map((w) => `first-five@${w}${dev === 'phone' ? ':phone' : ''}`);
    const rows = db.prepare(`SELECT data FROM steps WHERE product = ? AND kind = 'playtest' AND name IN (?, ?) AND status = 'done' AND started > ? ORDER BY started DESC`).all(product, names[0], names[1], now - 7 * 86400_000) as any[];
    for (const row of rows) {
      try { const d = JSON.parse(row.data ?? '{}'); if (d?.persona?.reported) { out.push(d.persona as Persona); break; } } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * One finding per lost stretch, carrying its clip (shots: the stretch's screenshot when Gen took one) and kept apart by
 * its key (product, device, start second and reason), so a week's play never merges two stretches and a replay of the same
 * week's result never doubles them. Severity "polish": a place a newcomer loses time is clarity work, on the ideas list
 * the polish pass takes from; a stretch of a minute or more, or one that failed inputs, is a bug. Returns the ids.
 */
export function filePersonaFindings(product: string, p: Persona, run: string, scenario: string, now = Date.now()): string[] {
  const ids: string[] = [];
  try { db.exec('ALTER TABLE findings ADD COLUMN source TEXT'); } catch { /* already there */ }
  const week = weekOf(now);
  for (const l of p.lost) {
    const key = `persona:${week}:${p.device}:${Math.round(l.from)}:${l.reason}`;
    const dev = p.device === 'phone' ? 'on a phone' : 'on desktop';
    const title = `A newcomer got lost for ${Math.round(l.seconds)} s at ${Math.round(l.from)} s ${dev}`;
    const clip = p.clip ? `${fileUrl(p.clip.asset)}#t=${Math.floor(l.from)},${Math.ceil(l.to)}` : null;
    const detail = `The newcomer persona (plays from the screen alone) ${l.reason === 'failed-inputs' ? 'kept failing inputs' : `made no progress for ${LOST_SECONDS} s or more`} from ${l.from} s to ${l.to} s ${dev}${l.intent ? `, trying to: ${l.intent}` : ''}.${clip ? ` Clip: ${clip}` : ''}`;
    const severity = l.seconds >= 60 || l.reason === 'failed-inputs' ? 'bug' : 'polish';
    const old = db.prepare(`SELECT id FROM findings WHERE product = ? AND key = ?`).get(product, key) as any;
    if (old) { ids.push(old.id); continue; }
    const id = newId('f');
    const shots = JSON.stringify([l.shot, p.clip?.asset].filter(Boolean));
    db.prepare(`INSERT INTO findings (id, product, key, title, severity, area, detail, fix, status, scenario, shots, first_seen, last_seen, seen, last_run, note, source)
      VALUES (?, ?, ?, ?, ?, 'clarity', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'persona')`)
      .run(id, product, key, title, severity, detail, 'Make the next step obvious at that moment: a prompt, a highlight or a first action that needs no explanation, then play it cold again.', severity === 'bug' ? 'open' : 'idea', scenario, shots, now, now, run, `Newcomer persona, week of ${week}.`);
    ids.push(id);
  }
  return ids;
}
