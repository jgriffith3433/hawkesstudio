// The queue heals itself (J, 2026-11-10: "every problem that comes up should be dealt with by itself somehow").
//
// Head-of-line blocking left every hawkes-studio fix stuck for hours on 2026-11-10. Every queued hawkes-studio change
// read "queued behind c_d24c7d05df35": a change that had failed publish three times and was waiting for memory. It was
// the oldest, so each time a slot or memory let one change of its product start it was that one: it failed again, came
// back as the oldest, and held its product's slot in between. Once it was cancelled, c_88cdeb289512 (failed twice,
// waiting for memory) did the same.
//
// Now a change whose publish or start failed PARK_AFTER times is parked: it is out of the pump's list, holds no slot of
// its product (noRoomFor, aheadOf) and doesn't count as a stalled queue, and it is not started again until something
// changes: Studio restarts, new code lands on its beta, or a person resumes it (Cancel then Resume, or the undo of the
// decision). Woken by a restart or new code, it waits at the end of its product's line. An ops note (the decision log,
// with an undo) says what was parked and why.
//
// Nothing here polls or sets a timer: it runs when the pump looks at each queued change (agents.ts resumeAllowed) and
// when the self-healing supervisor (selfheal.ts) calls parkBlockers() on its look.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.ts';
import { PROJECTS } from './config.ts';
import { getChange, changeLog, patchChange, pumpNow, type Change } from './agents.ts';

/** Failed publishes or starts (since it was last woken) before a change is parked. */
export const PARK_AFTER = 3;

db.exec(`
  CREATE TABLE IF NOT EXISTS queue_parks (
    change TEXT PRIMARY KEY, product TEXT NOT NULL, at INTEGER NOT NULL, why TEXT, errors INTEGER NOT NULL,
    boot TEXT NOT NULL, beta TEXT NOT NULL, notes INTEGER NOT NULL, woke INTEGER, woke_why TEXT, manual INTEGER
  );
`);

type Park = { change: string; product: string; at: number; why: string | null; errors: number; boot: string; beta: string; notes: number; woke: number | null; woke_why: string | null; manual: number | null };

/** This process: a park made by an earlier one wakes (Studio restarted). Tests set it. */
let BOOT: string = crypto.randomUUID();
export function setBoot(id: string) { BOOT = id; }

// Parks are read on every pump look at a queued change: kept in memory, written through to the table.
const parks = new Map<string, Park>();
for (const r of db.prepare('SELECT * FROM queue_parks').all() as any[]) parks.set(r.change, r as Park);

function savePark(p: Park) {
  parks.set(p.change, p);
  db.prepare(`INSERT INTO queue_parks (change, product, at, why, errors, boot, beta, notes, woke, woke_why, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(change) DO UPDATE SET product = excluded.product, at = excluded.at, why = excluded.why, errors = excluded.errors, boot = excluded.boot,
    beta = excluded.beta, notes = excluded.notes, woke = excluded.woke, woke_why = excluded.woke_why, manual = excluded.manual`)
    .run(p.change, p.product, p.at, p.why, p.errors, p.boot, p.beta, p.notes, p.woke, p.woke_why, p.manual);
}
function dropPark(id: string) {
  parks.delete(id);
  db.prepare('DELETE FROM queue_parks WHERE change = ?').run(id);
}

/** Log lines of a failed publish or start (work()'s catch, a resume that couldn't carry on, an agent job that failed). */
const FAIL_LINE = /^\d\d:\d\d:\d\d (error: |stderr: \[studio\] the Cloud Run job failed|couldn't carry on after the restart)/;
/** A change's failed publishes and starts, from its log. */
export function failCount(log: string[] | null | undefined) {
  let n = 0;
  for (const l of log ?? []) if (FAIL_LINE.test(l)) n++;
  return n;
}
/** Failures since the change was last woken (all of them when it was never parked). */
export const failStreak = (c: Pick<Change, 'id' | 'log'>) => failCount(c.log) - (parks.get(c.id)?.errors ?? 0);

function readRef(dir: string, ref: string): string {
  const name = ref.replace(/[^\w.-]/g, '');
  try { return fs.readFileSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', name), 'utf8').trim(); } catch { /* packed */ }
  try {
    return fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8').match(new RegExp(`^([0-9a-f]{40}) refs/remotes/origin/${name}$`, 'm'))?.[1] ?? '';
  } catch { return ''; }
}
/**
 * Where the product's beta is: the newest of its changes Studio merged, and the beta its checkout last fetched (a file
 * read, no git). Either moving is new code on beta.
 */
export function betaMark(c: Pick<Change, 'product' | 'repo' | 'base'>) {
  const m = (db.prepare(`SELECT MAX(merged_at) AS m FROM changes WHERE status = 'merged' AND product = ?`).get(c.product) as any)?.m ?? 0;
  return `${m}|${c.repo ? readRef(path.join(PROJECTS, c.repo), c.base || 'beta') : ''}`;
}

/** What changed since the change was parked (so it may start again), or null. */
function wakeWhy(p: Park, c: Change): { why: string; manual: boolean } | null {
  if ((c.notes?.length ?? 0) > p.notes) return { why: `${c.notes.at(-1)?.by ?? 'someone'} resumed it`, manual: true };
  if (p.boot !== BOOT) return { why: 'Studio restarted', manual: false };
  if (betaMark(c) !== p.beta) return { why: 'new code on beta', manual: false };
  return null;
}

function wake(p: Park, c: Pick<Change, 'id'>, why: string, manual: boolean) {
  savePark({ ...p, woke: Date.now(), woke_why: why, manual: manual ? 1 : 0 });
  changeLog(c.id, `queue heal: unparked (${why})${manual ? '' : "; it waits at the end of its product's line"}`);
  patchChange(c.id, { detail: manual ? `queued: resumed after being parked (${why})` : `queued: unparked (${why}); at the end of its product's line` });
}

function park(c: Change, n: number) {
  const last = [...c.log].reverse().find((l) => FAIL_LINE.test(l))?.slice(9, 200) ?? '?';
  const why = `its publish or start failed ${n} times (last: ${last})`;
  savePark({ change: c.id, product: c.product, at: Date.now(), why, errors: failCount(c.log), boot: BOOT, beta: betaMark(c), notes: c.notes?.length ?? 0, woke: null, woke_why: null, manual: null });
  patchChange(c.id, { detail: `queued: parked: ${why}. It starts again by itself after a Studio restart or new code on beta (at the end of its product's line), or when resumed`.slice(0, 300) });
  changeLog(c.id, `queue heal: parked: ${why}; the rest of ${c.product}'s queue goes ahead of it`);
  const text = `"${c.title ?? c.id}" (${c.id}) parked: ${why}. It no longer holds ${c.product}'s queue; it starts again after a Studio restart, new code on beta, or a resume (undo this).`;
  console.warn(`[queue-heal] ${text}`);
  void import('./roadmap.ts').then(({ logDecision }) => logDecision('queue-park', c.task ?? c.id, c.product, text, { kind: 'queue-heal', op: 'park', change: c.id }))
    .catch((e) => console.warn(`[queue-heal] decision log: ${e?.message ?? e}`));
}

/** Whether a change is out of the queue for now (parked): the pump, the product's slots and the queue's health skip it. */
export function parkedOut(c: Pick<Change, 'id' | 'status'>) {
  const p = parks.get(c.id);
  return c.status === 'queued' && Boolean(p) && p!.woke == null;
}

/** A woken change waits until every change of its product that was queued before it woke has started. */
function behindLine(c: Change, p: Park) {
  const others = db.prepare(`SELECT id, created FROM changes WHERE status = 'queued' AND product = ? AND id != ?`).all(c.product, c.id) as { id: string; created: number }[];
  return others.some((o) => o.created <= (p.woke ?? 0) && !parkedOut({ id: o.id, status: 'queued' }));
}

/**
 * Why a queued change doesn't start in this pass, or null (agents.ts resumeAllowed, once per queued change per pass):
 * parked (and nothing changed since), parked now (it just reached PARK_AFTER failures), or woken but still behind its
 * product's line. Never throws: a fault here must never hold the queue.
 */
export function queueHold(c: Change): string | null {
  try {
    if (c.status !== 'queued') return null;
    const p = parks.get(c.id);
    if (p && p.woke == null) {
      const w = wakeWhy(p, c);
      if (!w) return 'parked';
      wake(p, c, w.why, w.manual);
    }
    const n = failStreak(c);
    if (n >= PARK_AFTER) { park(c, n); return 'parked'; }
    const q = parks.get(c.id);
    if (q && q.woke != null && !q.manual && behindLine(c, q)) return "at the end of its product's line";
    return null;
  } catch (e: any) {
    console.warn(`[queue-heal] ${c.id}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Parks every queued change that failed PARK_AFTER times since it was last woken, and wakes the parked ones something
 * changed for. The self-healing supervisor calls it on its look; the pump's look at each change does the same check.
 */
export function parkBlockers(): { parked: string[]; woke: string[] } {
  const parked: string[] = [];
  const woke: string[] = [];
  for (const r of db.prepare(`SELECT id FROM changes WHERE status = 'queued'`).all() as { id: string }[]) {
    const c = getChange(r.id);
    if (!c) continue;
    const p = parks.get(c.id);
    if (p && p.woke == null) {
      const w = wakeWhy(p, c);
      if (w) { wake(p, c, w.why, w.manual); woke.push(c.id); }
      continue;
    }
    const n = failStreak(c);
    if (n >= PARK_AFTER) { park(c, n); parked.push(c.id); }
  }
  // Parks of changes that are done for good are forgotten (a failed one may be queued again: its count stays).
  for (const [id] of parks) {
    const s = (db.prepare('SELECT status FROM changes WHERE id = ?').get(id) as any)?.status;
    if (!s || ['merged', 'closed'].includes(s)) dropPark(id);
  }
  if (woke.length) void pumpNow();
  return { parked, woke };
}

/** Resumes a parked change now, ahead of the line (pm.ts undoDecision, kind "queue-heal"). Returns what it did. */
export function resumeParked(id: string, by = 'J'): string {
  const c = getChange(id);
  if (!c) throw new Error(`No change ${id}`);
  const p = parks.get(id);
  if (!p || p.woke != null || c.status !== 'queued') return `${id} is not parked (${c.status})`;
  wake(p, c, `resumed by ${by}`, true);
  void pumpNow();
  return `${id} unparked`;
}
