// How fast work goes from a task's start to a playtested beta, and where the time goes (J, 2026-11-10: "Is there
// anything we can do to make the tasks and agent run faster?"). Every change's status and step changes are kept
// (change_timeline, written by agents.ts update), so each phase's time is measured, not guessed:
//
//   queued    waiting for a slot, memory, disk or a provider
//   prepare   the worktree, the install, the brief
//   agent     the AI pass(es) themselves
//   gen       waiting on Hawkes Gen jobs (art, sound, builds)
//   checks    verifying: tests, build, review, playtest of the change
//   publish   the pull request and its merge
//   ready     done, waiting for a merge decision
//
// and per task: start (its first change) to on beta (merged_at) and to playtested on beta (verified_at).

import { db } from './db.ts';

db.exec(`CREATE TABLE IF NOT EXISTS change_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT,
  step TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS change_timeline_change ON change_timeline (change_id, id)');

const ins = db.prepare('INSERT INTO change_timeline (change_id, at, status, step) VALUES (?, ?, ?, ?)');
/** A change's status or step changed (agents.ts update). Never throws. */
export function noteTimeline(change: string, status: string | null, step: string | null, at = Date.now()) {
  try { ins.run(change, at, status, step); } catch { /* the metric never stops work */ }
}

export const PHASES = ['queued', 'prepare', 'agent', 'gen', 'checks', 'publish', 'ready'] as const;
export type SpeedPhase = (typeof PHASES)[number];
/** Which phase a moment of a change belongs to, from its status and step. Null: not counted (ended, failed, cancelled). */
export function phaseOf(status: string | null, step: string | null): SpeedPhase | null {
  if (!status || ['merged', 'closed', 'failed', 'cancelled'].includes(status)) return null;
  if (status === 'queued') return 'queued';
  if (status === 'waiting on Gen' || step === 'gen') return 'gen';
  if (status === 'ready') return 'ready';
  if (status === 'verifying' || step === 'verify') return 'checks';
  if (step === 'publish' || step === 'finish') return 'publish';
  if (step === 'agent') return 'agent';
  if (step === 'prepare') return 'prepare';
  return status === 'needs answer' ? null : 'prepare';
}

/** Each phase's milliseconds in a timeline (oldest first), up to `end` for the last open entry. */
export function phaseTimes(rows: { at: number; status: string | null; step: string | null }[], end = Date.now()) {
  const out: Record<SpeedPhase, number> = { queued: 0, prepare: 0, agent: 0, gen: 0, checks: 0, publish: 0, ready: 0 };
  for (let i = 0; i < rows.length; i++) {
    const p = phaseOf(rows[i].status, rows[i].step);
    if (!p) continue;
    const next = i + 1 < rows.length ? rows[i + 1].at : end;
    out[p] += Math.max(0, next - rows[i].at);
  }
  return out;
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const min = (ms: number | null) => (ms == null ? null : Math.round(ms / 60_000));

export type SpeedReport = {
  days: number;
  tasks: { count: number; toBetaMin: number | null; toBetaP75Min: number | null; toPlaytestedMin: number | null; playtested: number };
  changes: { count: number; phases: Record<SpeedPhase, number | null>; agentMin: number | null; passes: number | null };
  slowest: SpeedPhase | null;
};

/**
 * The last `days`: tasks that reached beta (median minutes from their first change to beta, and to playtested beta),
 * and changes merged (median minutes in each phase, from the timeline; agent time and passes from the pass ledger).
 */
export function speedReport(days = 7, now = Date.now()): SpeedReport {
  const since = now - days * 86_400_000;
  let tasks: { start: number | null; merged_at: number; verified_at: number | null }[] = [];
  try {
    tasks = db.prepare(`SELECT (SELECT MIN(c.created) FROM changes c WHERE c.task = t.id) AS start, t.merged_at, t.verified_at
      FROM tasks t WHERE t.merged_at >= ?`).all(since) as any[];
  } catch { /* no roadmap here */ }
  const started = tasks.filter((t) => t.start && t.merged_at >= t.start);
  const toBeta = started.map((t) => t.merged_at - t.start!);
  const toPlay = started.filter((t) => t.verified_at && t.verified_at >= t.start!).map((t) => t.verified_at! - t.start!);

  const merged = db.prepare(`SELECT id, merged_at FROM changes WHERE status = 'merged' AND COALESCE(merged_at, updated) >= ?`).all(since) as { id: string; merged_at: number | null }[];
  const tl = db.prepare('SELECT at, status, step FROM change_timeline WHERE change_id = ? ORDER BY id');
  const per: Record<SpeedPhase, number[]> = { queued: [], prepare: [], agent: [], gen: [], checks: [], publish: [], ready: [] };
  for (const c of merged) {
    const rows = tl.all(c.id) as any[];
    if (!rows.length) continue;
    const t = phaseTimes(rows, c.merged_at ?? now);
    for (const p of PHASES) per[p].push(t[p]);
  }
  const ledger = merged.length
    ? db.prepare(`SELECT change_id, SUM(ms) AS ms, COUNT(*) AS n FROM pass_ledger WHERE change_id IN (${merged.map(() => '?').join(',')}) GROUP BY change_id`).all(...merged.map((c) => c.id)) as { ms: number; n: number }[]
    : [];
  const phases = Object.fromEntries(PHASES.map((p) => [p, min(pct(per[p], 0.5))])) as Record<SpeedPhase, number | null>;
  const slowest = (PHASES.filter((p) => p !== 'ready' && phases[p] != null).sort((a, b) => phases[b]! - phases[a]!)[0] ?? null) as SpeedPhase | null;
  return {
    days,
    tasks: { count: started.length, toBetaMin: min(pct(toBeta, 0.5)), toBetaP75Min: min(pct(toBeta, 0.75)), toPlaytestedMin: min(pct(toPlay, 0.5)), playtested: toPlay.length },
    changes: { count: per.queued.length, phases, agentMin: min(pct(ledger.map((x) => x.ms), 0.5)), passes: pct(ledger.map((x) => x.n), 0.5) },
    slowest,
  };
}

const hm = (m: number | null) => (m == null ? 'n/a' : m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
/** One line for Talk and the Resources box. */
export function speedLine(r: SpeedReport) {
  if (!r.tasks.count && !r.changes.count) return `No task reached beta in the last ${r.days} days.`;
  return `Last ${r.days} days: a task takes ${hm(r.tasks.toBetaMin)} from its start to beta (median of ${r.tasks.count}; slowest quarter ${hm(r.tasks.toBetaP75Min)})`
    + `${r.tasks.playtested ? `, ${hm(r.tasks.toPlaytestedMin)} to a playtested beta` : ''}.`
    + `${r.slowest ? ` Most of a change's time goes to ${r.slowest} (${hm(r.changes.phases[r.slowest])} median).` : ''}`;
}
