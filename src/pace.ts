// The studio's pace (J, 2026-10-19: "Make this entire system faster"). Agents were fast; the time went around them:
// long beta checks replaying scenarios from the start, criteria "unclear: not reached" spending tries, and agent slots
// idle with nothing planned. This holds the small pieces pm.ts and pipeline.ts use for that:
//
// - the time budget per playtest scenario (SCENARIO_BUDGET_S, 10 minutes): over it, the run step says so and the
//   task's agent is told to start the scenario nearer (the contract's `at`, docs/playtest.md);
// - "not reached": a criterion judged unclear because the bot never got to it (notReached), which goes back once as a
//   scenario fix, never as a try (pm.ts scenarioFix);
// - idle slots: free agent slots with nothing the PM may start for IDLE_MS, and products with no planned work: a scout
//   per idle product, then ONE Inbox question for J with their proposals (idleWatch). Nothing goes on the roadmap
//   without his yes, except in his own Studio in walk-away mode, where the PM answers it itself (causes.ts gateQuestion);
// - "Where the time goes" (whereTimeGoes, in studio_pm status): today's median agent time, merge-to-verified, build and
//   playtest time, time parked on Gen/GPU and idle slot-hours (the last two sampled by the PM's tick: samplePace).

import { db, J, parse } from './db.ts';
import type { Check } from './roadmap.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS pace_days (day TEXT PRIMARY KEY, idle_slot_ms REAL NOT NULL DEFAULT 0, parked_ms REAL NOT NULL DEFAULT 0, since INTEGER, last INTEGER);
  CREATE TABLE IF NOT EXISTS pace_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// ------------------------------------------------------------ scenario budget

/** A scenario's play time over this many seconds is too slow for a check (STUDIO_SCENARIO_BUDGET_S, default 10 minutes). */
export const SCENARIO_BUDGET_S = () => Number(process.env.STUDIO_SCENARIO_BUDGET_S ?? 600);

/** "12 min 5 s", "45 s". */
export const playTime = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`;
};

/** The run step's warning for a scenario over its budget, or null. */
export function slowNote(seconds: number | null | undefined): string | null {
  const budget = SCENARIO_BUDGET_S();
  if (!seconds || seconds <= budget) return null;
  return `over the ${Math.round(budget / 60)}-minute budget: shorten it (start it nearer with "at", docs/playtest.md)`;
}

// ------------------------------------------------------------ not reached

/** Evidence that says the bot never got to a criterion (rather than that it got there and couldn't tell). */
export const NOT_REACHED = /\b(not reached|never (?:reached|got to|gets to|arrived|played|showed|shown|appeared|seen|saw)|(?:didn't|did not|doesn't|does not) (?:reach|get to|get that far|arrive|show|appear)|not (?:seen|shown|visible|played|captured)|wasn't (?:reached|seen|shown)|no (?:evidence|frame|event|footage)s? (?:of|shows?|that)|nothing (?:shows|showed|in the frames)|ended before|stopped before|before (?:it|the bot) (?:got|reached))/i;

/** The unclear criteria the bot never reached (not reached / not seen). */
export const notReached = (checks: Check[]) => checks.filter((c) => c.met === 'unclear' && NOT_REACHED.test(String(c.evidence ?? '')));

// ------------------------------------------------------------ idle slots and parked time, sampled

const dayOf = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayStart = (now: number) => new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
/** A gap longer than this between samples (Studio was down, the PM paused) counts this much, not all of it. */
const MAX_GAP_MS = 5 * 60_000;

/**
 * One sample from the PM's tick: free agent slots (maxConcurrent - active) and work parked on Gen or a GPU (changes
 * waiting on Gen jobs, tasks waiting for a GPU), counted for the time since the last sample.
 */
export function samplePace({ freeSlots, parked }: { freeSlots: number; parked: number }, now = Date.now()) {
  const day = dayOf(now);
  const row = db.prepare('SELECT * FROM pace_days WHERE day = ?').get(day) as any;
  if (!row) {
    db.prepare('INSERT INTO pace_days (day, idle_slot_ms, parked_ms, since, last) VALUES (?, 0, 0, ?, ?)').run(day, now, now);
    return;
  }
  const dt = Math.max(0, Math.min(MAX_GAP_MS, now - (row.last ?? now)));
  db.prepare('UPDATE pace_days SET idle_slot_ms = idle_slot_ms + ?, parked_ms = parked_ms + ?, last = ? WHERE day = ?').run(Math.max(0, freeSlots) * dt, Math.max(0, parked) * dt, now, day);
}

// ------------------------------------------------------------ where the time goes

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const minutes = (ms: number | null) => (ms == null ? null : Math.round(ms / 6_000) / 10);
const hours = (ms: number) => Math.round(ms / 360_000) / 10;

export type TimeReport = {
  day: string; since: number;
  agent: { median: number | null; n: number };
  mergeToVerified: { median: number | null; n: number };
  build: { median: number | null; total: number; n: number };
  playtest: { median: number | null; total: number; n: number; slow: number };
  parkedHours: number; idleSlotHours: number; sampledSince: number | null;
  lines: string[];
};

/**
 * Where today's time went (minutes unless named): agents from start to merged (product changes), merge to verified on
 * beta (tasks), Unity/pre-deploy builds, playtests (their steps' wall time), and from the PM's samples the hours parked
 * on Gen/GPU and the idle agent slot-hours. `infra`: Studio and Gen, left out of the agents' median (no beta lane).
 */
export function whereTimeGoes(now = Date.now(), infra: (product: string) => boolean = () => false): TimeReport {
  const since = dayStart(now);
  let agentMs: number[] = [];
  try {
    agentMs = (db.prepare('SELECT product, created, merged_at FROM changes WHERE merged_at >= ? AND merged_at > created').all(since) as any[])
      .filter((c) => !infra(c.product)).map((c) => c.merged_at - c.created);
  } catch { /* no changes table (agents.ts not loaded) */ }
  let verifyMs: number[] = [];
  try {
    verifyMs = (db.prepare('SELECT merged_at, verified_at FROM tasks WHERE verified_at >= ? AND merged_at IS NOT NULL AND verified_at >= merged_at').all(since) as any[]).map((t) => t.verified_at - t.merged_at);
  } catch { /* no tasks table */ }
  const steps = (kind: string) => (db.prepare(`SELECT started, finished, data FROM steps WHERE kind = ? AND status = 'done' AND finished >= ? AND finished > started`).all(kind, since) as any[]);
  const builds = steps('build').map((s) => s.finished - s.started);
  const plays = steps('playtest');
  const playMs = plays.map((s) => s.finished - s.started);
  const slow = plays.filter((s) => parse(s.data)?.slow).length;
  const row = db.prepare('SELECT * FROM pace_days WHERE day = ?').get(dayOf(now)) as any;
  const r: TimeReport = {
    day: dayOf(now), since,
    agent: { median: minutes(median(agentMs)), n: agentMs.length },
    mergeToVerified: { median: minutes(median(verifyMs)), n: verifyMs.length },
    build: { median: minutes(median(builds)), total: minutes(builds.reduce((a, b) => a + b, 0)) ?? 0, n: builds.length },
    playtest: { median: minutes(median(playMs)), total: minutes(playMs.reduce((a, b) => a + b, 0)) ?? 0, n: playMs.length, slow },
    parkedHours: hours(row?.parked_ms ?? 0), idleSlotHours: hours(row?.idle_slot_ms ?? 0), sampledSince: row?.since ?? null,
    lines: [],
  };
  const m = (x: number | null) => (x == null ? 'n/a' : `${x} min`);
  r.lines = [
    `Agents: median ${m(r.agent.median)} from start to merged (${r.agent.n} change${r.agent.n === 1 ? '' : 's'} today).`,
    `Merge to verified on beta: median ${m(r.mergeToVerified.median)} (${r.mergeToVerified.n} task${r.mergeToVerified.n === 1 ? '' : 's'}).`,
    `Builds: median ${m(r.build.median)}, ${r.build.total} min in all (${r.build.n}).`,
    `Playtests: median ${m(r.playtest.median)}, ${r.playtest.total} min in all (${r.playtest.n}${r.playtest.slow ? `; ${r.playtest.slow} over the ${Math.round(SCENARIO_BUDGET_S() / 60)}-minute budget` : ''}).`,
    `Parked on Gen/GPU: ${r.parkedHours} h. Idle agent slots: ${r.idleSlotHours} slot-hours${r.sampledSince ? ` (since ${new Date(r.sampledSince).toTimeString().slice(0, 5)})` : ' (not sampled yet today)'}.`,
  ];
  return r;
}

// ------------------------------------------------------------ idle slots get work

/** Free slots with nothing the PM may start this long before the idle products are scouted (STUDIO_IDLE_MS, 30 min). */
export const IDLE_MS = () => Number(process.env.STUDIO_IDLE_MS ?? 30 * 60_000);
/** The scouts get this long to report; the question is filed with what's in by then. */
const SCOUT_WAIT_MS = 3 * 3600_000;
/** The same idle products aren't asked about again for this long (a newly idle product is). */
const REASK_MS = 7 * 86_400_000;
/** The question's subject: one card, merged by subject, never one per product. */
export const IDLE_SUBJECT = 'idle-slots';

type IdleState = { since: number | null; scouts: Record<string, { id: string; at: number }>; asked: number | null; askedFor: string[]; question: string | null };
const readIdle = (): IdleState => ({ since: null, scouts: {}, asked: null, askedFor: [], question: null, ...(parse((db.prepare(`SELECT value FROM pace_state WHERE key = 'idle'`).get() as any)?.value ?? null) ?? {}) });
const saveIdle = (s: IdleState) => db.prepare(`INSERT INTO pace_state (key, value) VALUES ('idle', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(J(s));
export const idleState = readIdle;

export type IdleDeps = {
  /** Products with no planned or running work (roadmap tasks, changes, open bugs). */
  idleProducts: () => string[];
  startScout: (product: string, question: string) => { id: string };
  getScout: (id: string) => { status: string; report: string | null; detail: string | null } | null;
  askJ: (text: string, o: { subject: string; options: string[]; recommend: string; topic: string; from: string; context: string }) => { id: string };
  log: (detail: string) => void;
  name?: (product: string) => string;
};

/** A scout report's proposed roadmap item (its "## Proposed roadmap item" section), short. */
export function proposalOf(report: string | null | undefined, max = 450): string | null {
  const r = String(report ?? '').trim();
  if (!r) return null;
  const m = /##\s*Proposed roadmap item\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(r);
  const text = (m ? m[1] : r).replace(/\n{2,}/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Idle agent slots get work (J, 2026-10-19): when the PM has free slots and nothing it may start (`started` 0) for
 * IDLE_MS, and products have no planned work, a scout runs per idle product (two at a time: scout.ts), then ONE Inbox
 * question lists them with each scout's proposed next roadmap item. Asked once per set of idle products (again only
 * when another product falls idle, or after REASK_MS); an open question merges by subject. Returns what it did.
 */
export function idleWatch({ free, started }: { free: number; started: number }, deps: IdleDeps, now = Date.now()): 'busy' | 'waiting' | 'scouting' | 'asked' | 'nothing idle' | 'already asked' {
  const st = readIdle();
  if (free <= 0 || started > 0) {
    if (st.since !== null) saveIdle({ ...st, since: null });
    return 'busy';
  }
  if (st.since === null) {
    saveIdle({ ...st, since: now });
    return 'waiting';
  }
  if (now - st.since < IDLE_MS()) return 'waiting';
  const idle = deps.idleProducts();
  if (!idle.length) return 'nothing idle';
  const fresh = idle.some((p) => !st.askedFor.includes(p));
  if (st.asked && now - st.asked < REASK_MS && !fresh) return 'already asked';
  const name = deps.name ?? ((p: string) => p);
  for (const p of idle) {
    if (st.scouts[p] && now - st.scouts[p].at < 86_400_000) continue;
    try {
      const x = deps.startScout(p, `Agent slots are idle and ${name(p)} has no planned roadmap work. What is the most valuable next roadmap item for it (small enough to start today), given its story, quality bar and what real players do?`);
      st.scouts[p] = { id: x.id, at: now };
    } catch {
      break; // two scouts already run (scout.ts): the next tick starts the rest
    }
  }
  saveIdle(st);
  const first = Math.min(...Object.values(st.scouts).map((x) => x.at), now);
  const pending = idle.filter((p) => !st.scouts[p] || deps.getScout(st.scouts[p].id)?.status === 'running');
  if (pending.length && now - first < SCOUT_WAIT_MS) return 'scouting';
  const lines = idle.map((p) => {
    const sc = st.scouts[p] ? deps.getScout(st.scouts[p].id) : null;
    const prop = proposalOf(sc?.report);
    return `- **${name(p)}**${st.scouts[p] ? ` (scout ${st.scouts[p].id})` : ''}: ${prop ?? (sc ? `no proposal (${String(sc.detail ?? sc.status).slice(0, 120)})` : 'not scouted yet')}`;
  });
  const text = `Agent slots have been idle for ${Math.round((now - st.since) / 60_000)} min with nothing the PM may start, and ${idle.length} product(s) have no planned work. A scout read each one and proposes a next roadmap item:\n\n${lines.join('\n')}\n\nAdd these to the roadmap (the PM files them as items with their tasks), only some (say which), or not now? Nothing is added without your yes (in walk-away mode in your own Studio, the PM adds them itself).`;
  const q = deps.askJ(text.slice(0, 3900), {
    subject: IDLE_SUBJECT, options: ['Yes: add them', 'Only some (say which)', 'Not now'], recommend: 'Yes: add them', topic: 'idle', from: 'idle agent slots',
    context: Object.values(st.scouts).map((x) => x.id).join(' '),
  });
  deps.log(`agent slots idle ${Math.round((now - st.since) / 60_000)} min, ${idle.length} product(s) with no planned work (${idle.map(name).join(', ')}): scouted, ONE question for J (${q.id})`);
  saveIdle({ since: st.since, scouts: {}, asked: now, askedFor: [...new Set([...(st.asked && now - st.asked < REASK_MS ? st.askedFor : []), ...idle])], question: q.id });
  return 'asked';
}
