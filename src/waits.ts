// The one rule every wait follows (J, 2026-11-11: "Double check all the paths in which things can get stuck ... Let's solve
// this problem once and for all"): a wait records what it waits on and a deadline, in the database. The event ends it
// (the gate calls endWait or just carries on); if the event never comes, the deadline does, and the work goes on in a
// lesser way (the point's fallback, registered here with onDeadline). The list of waits and their deadlines is
// waitpoints.ts; docs/stall-paths.md is it in words; test/stall-paths.test.ts keeps the three in step.
//
// No polling, no watchdog: there is ONE timer, set for the earliest pending deadline, set again whenever a wait begins or
// ends, and set again at start-up from the table (rearmWaits), so a crash, a failed deploy or Cloud Run stopping the
// instance loses nothing: the next start finds every pending wait and fires the ones whose time came while it was down.
import { db } from './db.ts';
import { pointOf, deadlineOf, type WaitPoint } from './waitpoints.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS waits (
    point TEXT NOT NULL, subject TEXT NOT NULL, product TEXT, waits_on TEXT NOT NULL,
    started INTEGER NOT NULL, deadline INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', ended INTEGER, how TEXT, note TEXT,
    PRIMARY KEY (point, subject)
  );
  CREATE INDEX IF NOT EXISTS waits_pending ON waits(state, deadline);
`);

/** How a wait ended: the event came, the deadline did, the thing it waited for went away, or Studio restarted with nobody to end it. */
export type WaitEnd = 'event' | 'deadline' | 'cancelled' | 'restart';
export type WaitRow = { point: string; subject: string; product: string | null; waits_on: string; started: number; deadline: number; state: 'pending' | 'ended'; ended: number | null; how: WaitEnd | null; note: string | null };

/** The longest one timer is set for (setTimeout's limit is 2^31 ms); a later deadline is armed again when this fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type BeginOptions = {
  /** What it waits on, in plain words (shown with the wait; the docs' "event"). */
  waitsOn: string;
  /** The deadline as a time, or ms after `since`. Both missing: the point's own (deadlineOf). */
  deadlineAt?: number;
  deadlineMs?: number;
  /** When the wait really began (a restart finds work that already waited): default now. */
  since?: number;
  product?: string | null;
  /** Count again from now (a wait that began anew), instead of keeping the pending row's start and deadline. */
  renew?: boolean;
};

const get = (point: string, subject: string) => db.prepare('SELECT * FROM waits WHERE point = ? AND subject = ?').get(point, subject) as WaitRow | undefined;

/**
 * A gate begins waiting. Idempotent: a wait already pending keeps its start and deadline, so a gate looked at again on
 * every pass never pushes its own deadline back. The deadline is clamped to the point's maximum (waitpoints.ts), so no
 * caller can ask for a wait longer than the one the docs promise. An unknown point throws: a gate without an entry.
 */
export function beginWait(point: string, subject: string, o: BeginOptions): WaitRow {
  const p = pointOf(point);
  if (!p) throw new Error(`unknown wait point "${point}": add it to src/waitpoints.ts and docs/stall-paths.md`);
  const now = Date.now();
  const had = get(point, subject);
  if (had?.state === 'pending' && !o.renew) { arm(); return had; }
  const since = o.since ?? now;
  // The same wait (it began at the same time) that its deadline already ended is not opened again: a gate asked on every
  // pass would otherwise end it, begin it, and end it again at once, for ever.
  if (had?.state === 'ended' && o.since !== undefined && had.started === since && !o.renew) return had;
  const ask = o.deadlineAt ?? since + (o.deadlineMs ?? deadlineOf(point));
  if (!Number.isFinite(ask)) throw new Error(`wait ${point}/${subject} has no deadline`);
  // Never later than the point's maximum counted from when the wait began.
  const deadline = Math.min(ask, since + p.maxMs);
  db.prepare(`INSERT INTO waits (point, subject, product, waits_on, started, deadline, state, ended, how, note) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)
    ON CONFLICT(point, subject) DO UPDATE SET product = excluded.product, waits_on = excluded.waits_on, started = excluded.started, deadline = excluded.deadline, state = 'pending', ended = NULL, how = NULL, note = NULL`)
    .run(point, subject, o.product ?? null, o.waitsOn.slice(0, 300), since, deadline);
  arm();
  return get(point, subject)!;
}

/** A gate's own length of wait, never longer than the point's maximum (waitpoints.ts): the figure a gate's timer uses. */
export const within = (point: string, ms: number) => Math.min(ms, pointOf(point)?.maxMs ?? ms);

/** The wait ended by its event (or was dropped). True when one was pending. */
export function endWait(point: string, subject: string, how: WaitEnd = 'event', note?: string): boolean {
  const r = db.prepare(`UPDATE waits SET state = 'ended', ended = ?, how = ?, note = ? WHERE point = ? AND subject = ? AND state = 'pending'`).run(Date.now(), how, note?.slice(0, 300) ?? null, point, subject);
  if (r.changes) arm();
  return r.changes > 0;
}

/** Every wait of a point that is still pending for a subject matching `keep` ends: the thing they waited for is gone. */
export function endWaitsWhere(point: string, drop: (subject: string) => boolean, how: WaitEnd = 'cancelled') {
  let n = 0;
  for (const w of pendingWaits(point)) if (drop(w.subject) && endWait(point, w.subject, how)) n++;
  return n;
}

/** Whether the wait's deadline ended it (the gate is carrying on in its lesser way, or is about to). */
export const lateWait = (point: string, subject: string) => { const w = get(point, subject); return w?.state === 'ended' && w.how === 'deadline'; };
/** The wait is over for good (the work it held up is done or gone): its row goes. */
export function forgetWait(point: string, subject: string) { db.prepare('DELETE FROM waits WHERE point = ? AND subject = ?').run(point, subject); arm(); }
export const forgetWaitsWhere = (point: string, drop: (subject: string) => boolean) => {
  const rows = db.prepare('SELECT subject FROM waits WHERE point = ?').all(point) as { subject: string }[];
  let n = 0;
  for (const r of rows) if (drop(r.subject)) { forgetWait(point, r.subject); n++; }
  return n;
};

export const waitOf = (point: string, subject: string): WaitRow | null => get(point, subject) ?? null;
export const pendingWaits = (point?: string): WaitRow[] => (point
  ? db.prepare(`SELECT * FROM waits WHERE state = 'pending' AND point = ? ORDER BY deadline`).all(point)
  : db.prepare(`SELECT * FROM waits WHERE state = 'pending' ORDER BY deadline`).all()) as unknown as WaitRow[];

/** Whether a pending wait is past its deadline (a gate that reads its own clock asks the same question). */
export function waitOverdue(point: string, subject: string, now = Date.now()): boolean {
  const w = get(point, subject);
  return Boolean(w && w.state === 'pending' && w.deadline <= now);
}

/** What a wait does when its deadline ends it: the point's fallback. It may begin another wait (a longer one) itself. */
export type DeadlineHandler = (w: WaitRow) => void | Promise<void>;
const handlers = new Map<string, DeadlineHandler>();
/** Registers the fallback of a wait point (once, at the gate's module load). */
export function onDeadline(point: string, fn: DeadlineHandler) {
  if (!pointOf(point)) throw new Error(`unknown wait point "${point}"`);
  handlers.set(point, fn);
}
export const hasHandler = (point: string) => handlers.has(point);

/**
 * Waits whose deadline has come end now: each is marked ended by the deadline, then its point's fallback runs (a handler
 * that throws is logged; the wait is already ended, so it never runs twice). Returns how many ended.
 */
export async function fireDue(now = Date.now()): Promise<number> {
  const due = db.prepare(`SELECT * FROM waits WHERE state = 'pending' AND deadline <= ? ORDER BY deadline`).all(now) as unknown as WaitRow[];
  let n = 0;
  for (const w of due) {
    if (!endWait(w.point, w.subject, 'deadline', `waited ${Math.round((now - w.started) / 60_000)} min for ${w.waits_on}`.slice(0, 300))) continue;
    n++;
    try { await handlers.get(w.point)?.(w); } catch (e: any) { console.warn(`[waits] ${w.point} ${w.subject}: its fallback failed: ${e?.message ?? e}`); }
  }
  arm();
  return n;
}

let timer: { at: number; t: NodeJS.Timeout } | null = null;
/** The one timer: set for the earliest pending deadline (never a look at an interval), unref'd so it never holds Studio open. */
function arm() {
  const next = (db.prepare(`SELECT MIN(deadline) AS d FROM waits WHERE state = 'pending'`).get() as { d: number | null }).d;
  if (next == null) { if (timer) { clearTimeout(timer.t); timer = null; } return; }
  if (timer && timer.at === next) return;
  if (timer) clearTimeout(timer.t);
  const t = setTimeout(() => { timer = null; void fireDue(); }, Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now())));
  t.unref?.();
  timer = { at: next, t };
}
/** The time the next deadline timer fires (tests, health), or null with nothing pending. */
export const nextWakeAt = () => timer?.at ?? null;

/**
 * Start-up: every pending wait is armed again from the table, and the ones whose deadline passed while Studio was down
 * end now through their fallback. Called once (server.ts) before the resumes, and by any request that wakes a stopped
 * instance, since that starts the process. Old ended rows are dropped. Returns what's pending after it.
 */
export async function rearmWaits(now = Date.now()): Promise<{ overdue: number; pending: number }> {
  db.prepare(`DELETE FROM waits WHERE state = 'ended' AND ended < ?`).run(now - 7 * 86_400_000);
  // A turn in a line lived in the process that's gone: nothing waits on it now, and its owner resumes the work.
  for (const w of pendingWaits()) if (pointOf(w.point)?.inProcess) endWait(w.point, w.subject, 'restart', 'Studio restarted: the wait was in the old process');
  const overdue = await fireDue(now);
  arm();
  return { overdue, pending: pendingWaits().length };
}

/**
 * An in-process wait with an end: `event` (a promise the gate already has) races the point's deadline. The wait is
 * recorded while it lasts and ended by whichever came first; a crash in between leaves the row, which rearmWaits finds.
 * `timedOut` tells the gate to carry on in its lesser way.
 */
export async function raceDeadline<T>(point: string, subject: string, event: Promise<T>, o: BeginOptions): Promise<{ timedOut: false; value: T } | { timedOut: true; value?: undefined }> {
  const w = beginWait(point, subject, o);
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((ok) => { t = setTimeout(() => ok('late'), Math.max(0, w.deadline - Date.now())); t.unref?.(); });
  try {
    const r = await Promise.race([event.then((value) => ({ value })), late]);
    if (r === 'late') { endWait(point, subject, 'deadline'); return { timedOut: true }; }
    endWait(point, subject, 'event');
    return { timedOut: false, value: r.value };
  } catch (e) {
    endWait(point, subject, 'cancelled', String((e as any)?.message ?? e));
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** A line for health and the docs' own check: every pending wait, how long it has waited, and when it ends. */
export function waitsHealth(now = Date.now()) {
  const rows = pendingWaits();
  return { pending: rows.length, overdue: rows.filter((w) => w.deadline <= now).length, next: rows[0] ? { point: rows[0].point, subject: rows[0].subject, in: Math.max(0, rows[0].deadline - now) } : null };
}

export type { WaitPoint };
