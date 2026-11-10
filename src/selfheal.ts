// The self-healing supervisor (J, 2026-11-10: "do what it takes so that these issues resolve themselves WITHOUT you having
// to step in (or a human etc) every problem that comes up should be dealt with by itself somehow").
//
// Studio kept stalling in new ways, each one found by a person and fixed by hand. The supervisor turns that into a loop
// that needs no one:
//
//   invariants   Each is a thing that must hold (selfheal-checks.ts): free agent slots while work waits, no change
//                without progress, a provider hold that is probed, Gen answering, the daily run started, no gate holding
//                work while the machine has room, and so on. Its look() checks it and, when it doesn't hold, applies its
//                remedy at once (requeue, cancel or park the offender, re-probe, restart, scale down, retry), and says
//                what it did.
//   the ladder   An invariant still broken after its grace time (15 minutes unless it says otherwise) escalates once:
//                    fix    one Hawkes Studio fix task with the evidence (causes.ts openFix): its agent finds the root
//                           cause and ships it through the normal gates, so the remedy becomes code;
//                    card   one Inbox card, only for what is truly J's (money above his caps, a Google Cloud quota,
//                           an access grant): never a silent stall.
//   new shapes   Anything no invariant knows (an event-loop block, a crash, a check that throws, failures with no
//                known cause) is reported with anomaly(), which files the fix task straight away with its evidence.
//   the record   Every breach, remedy, clear and escalation is in selfheal_log; the Resources page shows each invariant,
//                its last breach and what was done, and /api/health says not ok while one has been broken past its
//                grace with nothing done about it.
//
// It never spends money beyond the caps Studio already has, and every cancel, requeue or hold it makes is logged with the
// change it touched so it can be undone. Nothing here polls: the supervisor runs on the stuck-work watchdog's timer
// (agents.ts startStuckWatch) and when something reports a breach (superviseSoon).

import { db, newId } from './db.ts';

export type Look = {
  /** Why the invariant doesn't hold now, or null when it does. */
  breach: string | null;
  /** What the remedy did this time (null: nothing to do, or nothing it can do). */
  did?: string | null;
  /** Lines that back the breach (ids, counts, log lines) for the fix task. */
  evidence?: string[];
};

export type Invariant = {
  key: string;
  label: string;
  /** What the escalation is when the remedy doesn't clear it: a Studio fix task, or J's Inbox card (only J-only matters). */
  escalate: 'fix' | 'card';
  /** How long a breach may last, with its remedy applied, before it escalates (default 15 minutes; 0 escalates at once). */
  graceMs?: number;
  look: (now: number) => Look | Promise<Look>;
  /** For a card: what J is asked, with the options and the one Studio recommends. */
  card?: (detail: string) => { text: string; options: string[]; recommend: string };
};

export type State = {
  key: string; label: string; since: number | null; lastBreach: number | null; detail: string | null;
  did: string | null; didAt: number | null; looks: number; escalated: string | null; escalatedAt: number | null; lastLook: number | null;
};
export type LogRow = { id: string; at: number; key: string; kind: 'breach' | 'remedy' | 'cleared' | 'escalated' | 'anomaly'; detail: string | null; ref: string | null };

export const GRACE_MS = () => Number(process.env.STUDIO_SELFHEAL_GRACE_MS) > 0 ? Number(process.env.STUDIO_SELFHEAL_GRACE_MS) : 15 * 60_000;

db.exec(`CREATE TABLE IF NOT EXISTS selfheal_state (
  key TEXT PRIMARY KEY, since INTEGER, last_breach INTEGER, detail TEXT, did TEXT, did_at INTEGER, looks INTEGER NOT NULL DEFAULT 0,
  escalated TEXT, escalated_at INTEGER, last_look INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS selfheal_log (id TEXT PRIMARY KEY, at INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, ref TEXT)`);
db.exec('CREATE INDEX IF NOT EXISTS selfheal_log_at ON selfheal_log(at)');

const registry = new Map<string, Invariant>();
/** Adds (or replaces) an invariant. */
export function register(inv: Invariant) { registry.set(inv.key, inv); }
export const invariants = () => [...registry.values()];
/** Tests: forget every invariant and the record. */
export function resetSelfHeal() { registry.clear(); db.exec('DELETE FROM selfheal_state; DELETE FROM selfheal_log'); }

/** What escalation does (tests replace it): files the fix task or asks J. Returns a reference (task id, question id) or null. */
export const escalation: {
  fix: (key: string, label: string, detail: string, evidence: string[]) => string | null;
  card: (key: string, q: { text: string; options: string[]; recommend: string }) => string | null;
} = {
  fix: (key, label, detail, evidence) => fileFix(key, label, detail, evidence),
  card: (key, q) => askCard(key, q),
};

function log(key: string, kind: LogRow['kind'], detail: string | null, ref: string | null = null, now = Date.now()) {
  db.prepare('INSERT INTO selfheal_log (id, at, key, kind, detail, ref) VALUES (?, ?, ?, ?, ?, ?)').run(newId('h'), now, key, kind, detail ? detail.slice(0, 1000) : null, ref);
  db.prepare('DELETE FROM selfheal_log WHERE at < ?').run(now - 14 * 86_400_000);
}

function rowOf(key: string): any {
  return db.prepare('SELECT * FROM selfheal_state WHERE key = ?').get(key) ?? { key, since: null, last_breach: null, detail: null, did: null, did_at: null, looks: 0, escalated: null, escalated_at: null, last_look: null };
}
function save(r: any) {
  db.prepare(`INSERT OR REPLACE INTO selfheal_state (key, since, last_breach, detail, did, did_at, looks, escalated, escalated_at, last_look) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.key, r.since, r.last_breach, r.detail, r.did, r.did_at, r.looks, r.escalated, r.escalated_at, r.last_look);
}

let running: Promise<SuperviseResult[]> | null = null;
export type SuperviseResult = { key: string; breach: string | null; did: string | null; escalated: string | null };

/** One look at every invariant: remedies applied, breaches tracked, escalations made. Coalesced: one at a time. */
export function supervise(now = Date.now()): Promise<SuperviseResult[]> {
  running ??= superviseOnce(now).finally(() => { running = null; });
  return running;
}

async function superviseOnce(now: number): Promise<SuperviseResult[]> {
  const out: SuperviseResult[] = [];
  for (const inv of registry.values()) {
    let look: Look;
    try {
      look = await inv.look(now);
    } catch (e: any) {
      // A check that throws is a stall of the supervisor itself: a new shape, filed for a fix like any other.
      look = { breach: `the check itself failed: ${String(e?.message ?? e).slice(0, 300)}`, evidence: [String(e?.stack ?? e).slice(0, 1500)] };
    }
    out.push(record(inv, look, now));
  }
  return out;
}

function record(inv: Invariant, look: Look, now: number): SuperviseResult {
  const r = rowOf(inv.key);
  r.last_look = now;
  r.looks = (r.looks ?? 0) + 1;
  let escalated: string | null = null;
  if (!look.breach) {
    if (r.since) log(inv.key, 'cleared', `held again after ${Math.max(1, Math.round((now - r.since) / 60_000))} min${r.did ? ` (last remedy: ${r.did})` : ''}`, r.escalated, now);
    r.since = null;
    r.escalated = null;
    r.escalated_at = null;
    if (look.did) { r.did = look.did; r.did_at = now; log(inv.key, 'remedy', look.did, null, now); }
    save(r);
    return { key: inv.key, breach: null, did: look.did ?? null, escalated: null };
  }
  if (!r.since) { r.since = now; log(inv.key, 'breach', look.breach, null, now); }
  r.last_breach = now;
  r.detail = look.breach.slice(0, 600);
  if (look.did) { r.did = look.did; r.did_at = now; log(inv.key, 'remedy', look.did, null, now); }
  const grace = inv.graceMs ?? GRACE_MS();
  if (!r.escalated && now - r.since >= grace) {
    const evidence = [`${new Date(r.since).toISOString()} first seen: ${r.detail}`, ...recentLog(inv.key, 12).map((l) => `${new Date(l.at).toISOString()} ${l.kind}: ${l.detail ?? ''}`), ...(look.evidence ?? [])];
    try {
      escalated = inv.escalate === 'card' && inv.card ? escalation.card(inv.key, inv.card(look.breach)) : escalation.fix(inv.key, inv.label, look.breach, evidence);
    } catch (e: any) {
      escalated = null;
      console.warn(`[selfheal] ${inv.key}: couldn't escalate: ${e?.message ?? e}`);
    }
    if (escalated) {
      r.escalated = escalated;
      r.escalated_at = now;
      log(inv.key, 'escalated', `${inv.escalate === 'card' ? "asked J (only J can do this)" : 'filed a Studio fix task'} after ${Math.round((now - r.since) / 60_000)} min: ${look.breach}`, escalated, now);
    }
  }
  save(r);
  return { key: inv.key, breach: look.breach, did: look.did ?? null, escalated };
}

/**
 * Something no invariant knows went wrong (a new stall shape): an event-loop block, a crash, failures with no known
 * cause. Logged, and a Studio fix task is filed at once with the evidence (one per kind while it is open).
 */
export function anomaly(kind: string, label: string, detail: string, evidence: string[] = []): string | null {
  const key = `anomaly:${kind}`;
  log(key, 'anomaly', detail);
  try {
    const ref = escalation.fix(key, label, detail, evidence);
    if (ref) log(key, 'escalated', `filed a Studio fix task: ${detail}`, ref);
    return ref;
  } catch (e: any) {
    console.warn(`[selfheal] ${key}: couldn't file its fix: ${e?.message ?? e}`);
    return null;
  }
}

let soon: NodeJS.Timeout | null = null;
/** Something reported a breach: look again in a few seconds (coalesced), not on the next timed look. */
export function superviseSoon(ms = 5000) {
  if (soon) return;
  soon = setTimeout(() => { soon = null; void supervise().catch((e) => console.warn(`[selfheal] ${e?.message ?? e}`)); }, ms);
  soon.unref?.();
}

export function recentLog(key?: string, limit = 50): LogRow[] {
  return db.prepare(`SELECT * FROM selfheal_log ${key ? 'WHERE key = ?' : ''} ORDER BY at DESC LIMIT ?`).all(...(key ? [key, limit] : [limit])) as LogRow[];
}

export function states(): State[] {
  const rows = new Map((db.prepare('SELECT * FROM selfheal_state').all() as any[]).map((r) => [r.key, r]));
  return invariants().map((inv) => {
    const r = rows.get(inv.key) ?? rowOf(inv.key);
    return { key: inv.key, label: inv.label, since: r.since, lastBreach: r.last_breach, detail: r.detail, did: r.did, didAt: r.did_at, looks: r.looks, escalated: r.escalated, escalatedAt: r.escalated_at, lastLook: r.last_look };
  });
}

/**
 * Broken past its grace with nothing done about it: no remedy in the grace time and no escalation. /api/health says
 * not ok while any is (pure on its input: tested).
 */
export function failing(list: State[], now = Date.now(), grace = GRACE_MS()): State[] {
  return list.filter((s) => s.since && now - s.since > grace && !s.escalated && !(s.didAt && now - s.didAt <= grace));
}

/** For /api/health and the Resources page. */
export function selfHealHealth(now = Date.now()) {
  const list = states();
  const bad = failing(list, now);
  const lastLook = Math.max(0, ...list.map((s) => s.lastLook ?? 0)) || null;
  // The supervisor not looking is a breach of its own: no look in three of its periods means its timer died.
  const stale = lastLook !== null && now - lastLook > 3 * SUPERVISE_EVERY_MS();
  return {
    ok: !bad.length && !stale,
    lastLook,
    stale,
    failing: bad.map((s) => ({ key: s.key, label: s.label, minutes: Math.round((now - (s.since ?? now)) / 60_000), detail: s.detail })),
    breached: list.filter((s) => s.since).map((s) => ({ key: s.key, label: s.label, minutes: Math.round((now - (s.since ?? now)) / 60_000), detail: s.detail, did: s.did, escalated: s.escalated })),
    lastHour: (db.prepare("SELECT kind, COUNT(*) n FROM selfheal_log WHERE at > ? GROUP BY kind").all(now - 3600_000) as { kind: string; n: number }[]).reduce((o, r) => ({ ...o, [r.kind]: r.n }), {} as Record<string, number>),
  };
}

/** For the Resources page: each invariant with its last breach and what was done, and the latest record. */
export function selfHealPanel(now = Date.now()) {
  const h = selfHealHealth(now);
  return {
    ok: h.ok, lastLook: h.lastLook, stale: h.stale, lastHour: h.lastHour,
    invariants: states().map((s) => ({ ...s, breachedMin: s.since ? Math.round((now - s.since) / 60_000) : null, failing: h.failing.some((f) => f.key === s.key) })),
    log: recentLog(undefined, 30),
  };
}

/** How often the supervisor looks (STUDIO_SELFHEAL_EVERY_MS; 5 minutes, the stuck-work watchdog's timer). */
export const SUPERVISE_EVERY_MS = () => Number(process.env.STUDIO_SELFHEAL_EVERY_MS) > 0 ? Number(process.env.STUDIO_SELFHEAL_EVERY_MS) : 5 * 60_000;

// ------------------------------------------------------------------ escalation

/** One Hawkes Studio fix task per invariant or anomaly kind while it's open (causes.ts keeps the one-per-cause record). */
function fileFix(key: string, label: string, detail: string, evidence: string[]): string | null {
  const causes = requireCauses();
  const cause = `selfheal:${key}`;
  const open = causes.openFix(cause);
  if (open) return open.task;
  const rows = evidence.slice(-20).map((line, i) => ({ id: `e${i}`, at: Date.now(), cause, product: causes.STUDIO_PRODUCT, kind: 'card' as const, ref: null, subject: key, detail: line }));
  const made = causes.hooks.openFix({ key: cause, label: `self-healing: ${label}`, cls: 'other' }, [{ id: 'now', at: Date.now(), cause, product: causes.STUDIO_PRODUCT, kind: 'card', ref: null, subject: key, detail }, ...rows]);
  if (!made) return null;
  db.prepare('INSERT OR REPLACE INTO cause_fixes (cause, task, item, opened, evidence) VALUES (?, ?, ?, ?, ?)').run(cause, made.task, made.item, Date.now(), JSON.stringify([]));
  // Studio's own fixes come first (agents.ts pumpPass), and this one is the highest priority on the roadmap.
  try { db.prepare("UPDATE tasks SET priority = 'high' WHERE id = ?").run(made.task); } catch { /* no tasks table in some tests */ }
  return made.task;
}

function askCard(key: string, q: { text: string; options: string[]; recommend: string }): string | null {
  const pm = requirePm();
  const r: any = pm.askJ(q.text, { subject: `selfheal:${key}`, options: q.options, recommend: q.recommend, from: 'self-healing', topic: 'self-healing' });
  return r?.id ?? `selfheal:${key}`;
}

// causes.ts and pm.ts are loaded by server start-up before the supervisor runs; required lazily so this module stays
// importable by the tests without the whole PM.
let causesMod: typeof import('./causes.ts') | null = null;
let pmMod: typeof import('./pm.ts') | null = null;
export async function loadEscalation() {
  causesMod ??= await import('./causes.ts');
  pmMod ??= await import('./pm.ts');
}
function requireCauses() { if (!causesMod) throw new Error('self-healing escalation not loaded'); return causesMod; }
function requirePm() { if (!pmMod) throw new Error('self-healing escalation not loaded'); return pmMod; }
