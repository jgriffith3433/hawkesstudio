// A park that names an outside condition comes back by itself (J, 2026-11-13: Dose of Destruction's portraits task was
// parked "until Gen credits are topped up" on Nov 12; nothing looked at the credits again, so it sat for a day and held up
// two planned tasks behind it. Hawkes Games' k_21faea83012b and k_1989d9a3f696 sat "waiting for GPU" the same way).
//
// The condition is data: a row in `task_parks` (task, kind credits | gpu | provider, what, since). Studio looks again on the
// events it already gets (parkevents.ts: a Gen job finishing ok, credits added, a GPU server up, a budget approved, a
// provider back), once per event, in the PM's pass; the park's deadline (the `park-condition` wait point, waits.ts) ends it
// otherwise by trying the task again. Releasing early costs nothing: the gates that hold a start (credits, GPU, provider)
// still hold it, and the attempt that hits the condition again parks it again. No timer re-checks anything.

import { db } from './db.ts';
import { getTask, setTask, logDecision, type Task } from './roadmap.ts';
import { beginWait, endWait, onDeadline, type WaitRow } from './waits.ts';
import { bootedAt, lastParkEvent, type ParkEvent } from './parkevents.ts';

export type ParkKind = 'credits' | 'gpu' | 'provider';
export type Park = { task: string; kind: ParkKind; detail: string; since: number; adopted: number };

db.exec(`CREATE TABLE IF NOT EXISTS task_parks (task TEXT PRIMARY KEY, kind TEXT NOT NULL, detail TEXT NOT NULL, since INTEGER NOT NULL, adopted INTEGER NOT NULL DEFAULT 0)`);

/** The events that can end each kind of park. */
export const ENDS: Record<ParkKind, ParkEvent[]> = {
  credits: ['credits-added', 'gen-job-done', 'budget-approved', 'roadmap-refill'],
  gpu: ['gpu-up', 'gen-job-done', 'budget-approved', 'credits-added'],
  provider: ['provider-back', 'gen-job-done', 'roadmap-refill'],
};

const HELD = /\b(held|hold|park(ed)?|wait(s|ing)?|until|after|once|when)\b/i;
const KINDS: [ParkKind, RegExp][] = [
  ['credits', /\b(gen(?:\s+credits?)?|credits?|top-?ups?|balance)\b.*\b(top-?ups?|topped|added|back|available|restored)\b|\bcredits?\b|\btop-?ups?\b/i],
  ['gpu', /\b(GPU|fleet)\b/i],
  ['provider', /\b(provider|usage limit|rate limit|quota|harness|elevenlabs|runpod|anthropic|outage)\b/i],
];
const NAMES_WORK = /\b[ik]_[0-9a-f]{12}\b|["“][^"”]{3,120}["”]/;
const BY_PERSON = /^(parked|dropped) on \S+'s answer/;

/** The outside condition a note names, or null (a note that names other work is releaseHeldIdeas's; a person's park is theirs). */
export function conditionOf(note: unknown): { kind: ParkKind; detail: string } | null {
  const text = String(note ?? '').replace(/\s+/g, ' ').trim();
  if (!text || !HELD.test(text) || BY_PERSON.test(text) || NAMES_WORK.test(text)) return null;
  for (const [kind, re] of KINDS) if (re.test(text)) return { kind, detail: text.slice(0, 300) };
  return null;
}

export const parkOf = (task: string): Park | null => (db.prepare('SELECT * FROM task_parks WHERE task = ?').get(task) as Park | undefined) ?? null;
export const listParks = (): Park[] => db.prepare('SELECT * FROM task_parks ORDER BY since').all() as unknown as Park[];

/** Records the condition a task waits on (data) and its deadline. Idempotent: a park already recorded keeps its start. */
export function recordPark(task: string, kind: ParkKind, detail: string, o: { since?: number; adopted?: boolean } = {}): Park {
  const t = getTask(task);
  const since = o.since ?? Date.now();
  db.prepare('INSERT OR IGNORE INTO task_parks (task, kind, detail, since, adopted) VALUES (?, ?, ?, ?, ?)').run(task, kind, detail.slice(0, 400), since, o.adopted ? 1 : 0);
  beginWait('park-condition', task, { waitsOn: `${kind}: ${detail}`.slice(0, 300), since, product: t?.product ?? null });
  return parkOf(task)!;
}

/** Parks a task as an idea with its condition (what Studio does itself, and what a PM turn should call). */
export function parkTask(task: string, kind: ParkKind, detail: string, by = 'Studio'): Task {
  const t = getTask(task);
  if (!t) throw new Error(`No task ${task}`);
  const note = `parked by ${by} until ${detail} (${kind}): Studio checks it again by itself and plans this task again once it clears`.slice(0, 600);
  setTask(task, { status: 'idea', note });
  recordPark(task, kind, detail);
  logDecision('park', task, t.product, `"${t.title}" parked until ${detail} (${kind}); Studio re-checks it on ${ENDS[kind].join(', ')} and plans it again`);
  return getTask(task)!;
}

/** A task waiting for GPU whose run found no GPU: its retry waits for the next GPU-capable moment (pm.ts rerunGpuWaits). */
export const holdForGpu = (task: string, detail: string) => recordPark(task, 'gpu', detail);
/** Whether a GPU rerun of the task is held until a GPU-capable moment. */
export const gpuHeld = (task: string) => parkOf(task)?.kind === 'gpu';

/**
 * Ideas whose note names an outside condition and have no park row yet (a PM turn wrote the note: "Parked until Gen credits
 * are topped up"): the condition is recorded now, as data. Returns the tasks adopted.
 */
export function adoptParks(): string[] {
  const out: string[] = [];
  const rows = db.prepare(`SELECT t.id FROM tasks t JOIN items i ON i.id = t.item WHERE t.status = 'idea' AND t.note IS NOT NULL
    AND i.status NOT IN ('idea', 'dropped') AND NOT (i.status = 'done' AND i.consumed IS NULL)`).all() as { id: string }[];
  for (const r of rows) {
    if (parkOf(r.id)) continue;
    const t = getTask(r.id)!;
    const c = conditionOf(t.note);
    if (!c) continue;
    // Parked before this code: nothing ever looked again, so no event is needed for the first look (adopted).
    recordPark(t.id, c.kind, c.detail, { since: t.updated ?? t.created, adopted: true });
    out.push(t.id);
  }
  return out;
}

/** How Studio sees each condition now (the gates that hold a start). Injected so tests need no Gen. */
export type ParkView = Partial<Record<ParkKind, () => boolean | Promise<boolean>>>;

const drop = (task: string, how: 'event' | 'deadline' | 'cancelled') => {
  db.prepare('DELETE FROM task_parks WHERE task = ?').run(task);
  endWait('park-condition', task, how);
};

/** Ends one park: an idea is planned again; a task waiting for GPU just loses its hold (rerunGpuWaits runs it). */
function release(p: Park, why: string): string | null {
  const t = getTask(p.task);
  drop(p.task, why.startsWith('deadline') ? 'deadline' : 'event');
  if (!t) return null;
  if (t.status === 'idea') {
    setTask(t.id, { status: 'planned', note: `released: ${why} (it was parked until ${p.detail.slice(0, 200)})` });
    logDecision('unpark', t.id, t.product, `"${t.title}" was parked until ${p.detail.slice(0, 200)} (${p.kind}); ${why}: planned again, it starts in a free slot`.slice(0, 600), { kind: 'tasks', change: null, tasks: [{ id: t.id, status: 'idea', tries: t.tries, note: t.note, checks: t.checks }] });
    return t.id;
  }
  if (t.status === 'waiting for GPU') {
    logDecision('unpark', t.id, t.product, `"${t.title}" waited for ${p.detail.slice(0, 200)} (${p.kind}); ${why}: its GPU run goes again`.slice(0, 600));
    return t.id;
  }
  return null;
}

/**
 * Looks at every park once: a park whose task moved on is forgotten; one whose condition clears (Studio's view says so, and
 * an event of its kind came after it began, or it was adopted, or Studio restarted since) is released. Returns the tasks
 * released. Called from the PM's pass, which an event kicks; it asks nothing of Gen itself.
 */
export async function releaseParks(view: ParkView = {}): Promise<string[]> {
  const out: string[] = [];
  for (const p of listParks()) {
    const t = getTask(p.task);
    if (!t || (t.status !== 'idea' && t.status !== 'waiting for GPU')) { drop(p.task, 'cancelled'); continue; }
    const heard = lastParkEvent(ENDS[p.kind]) >= p.since || p.adopted === 1 || p.since < bootedAt;
    if (!heard) continue;
    let clear = true;
    try { clear = (await view[p.kind]?.()) ?? true; } catch { clear = false; }
    if (!clear) { if (p.adopted) db.prepare('UPDATE task_parks SET adopted = 0, since = ? WHERE task = ?').run(Date.now(), p.task); continue; }
    const id = release(p, `${p.kind} cleared`);
    if (id) out.push(id);
  }
  return out;
}

// The deadline ends the park the lesser way: the task is tried again whatever Studio sees (if the condition still holds, the
// attempt that hits it parks the task again, with a new deadline).
onDeadline('park-condition', (w: WaitRow) => {
  const p = parkOf(w.subject);
  if (!p) return;
  const t = getTask(p.task);
  db.prepare('DELETE FROM task_parks WHERE task = ?').run(p.task);
  if (t?.status === 'idea') {
    setTask(t.id, { status: 'planned', note: `released: waited long enough for ${p.detail.slice(0, 200)}; trying again (if it still holds, it parks again)` });
    logDecision('unpark', t.id, t.product, `"${t.title}" waited ${Math.round((Date.now() - p.since) / 3600_000)} h for ${p.detail.slice(0, 200)} (${p.kind}): its park's deadline passed, so it is planned again`.slice(0, 600));
    void import('./pm.ts').then((m) => m.kick()).catch(() => {});
  } else if (t?.status === 'waiting for GPU') {
    logDecision('unpark', t.id, t.product, `"${t.title}" waited for ${p.detail.slice(0, 200)}: the deadline passed, its GPU run goes again`.slice(0, 600));
    void import('./pm.ts').then((m) => m.kick()).catch(() => {});
  }
});
