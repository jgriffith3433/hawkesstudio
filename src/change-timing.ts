// Phase times of every change, kept in the change's own row (`changes.timing`, JSON: phase -> epoch ms) so iteration speed is
// measured all the time (J, 2026-11-11: each agent pass waited 2 to 13 minutes before the agent's first line).
//
//   created            the change was made                         (changes.created)
//   dispatched         it left the queue and an agent was started   (agents.ts update())
//   job_started        the Cloud Run job's runner began             (the runner's `[job] timing` line)
//   workspace_ready    its workspace was checked out                (same)
//   first_output       the agent's first output line                (same)
//   pr_opened          the pull request was opened                  (agents.ts update(): `pr` set)
//   checks_done        the pre-merge checks passed (status ready)   (agents.ts update())
//   merged             merged into its base                         (agents.ts update() / merged_at)
//   beta_built         beta's build of it finished                  (derived from the beta run, change-rail.ts betaPart)
//   first_verdict      the first beta verdict on its task           (derived: the task's verified_at, else beta's playtest)
//
// The first time a phase is reached wins (a revision's later passes don't move it). No timers: every time is written by the
// event that reaches it. `timingOf` adds the spans between phases (seconds) for the `timing` field of studio_changes and
// studio_change.

import { db, parse } from './db.ts';

export const PHASES = ['created', 'dispatched', 'job_started', 'workspace_ready', 'first_output', 'pr_opened', 'checks_done', 'merged', 'beta_built', 'first_verdict'] as const;
export type Phase = (typeof PHASES)[number];
export type Timing = Partial<Record<Phase, number>> & {
  /** Seconds from each phase to the next one that has a time. */
  spans: Partial<Record<string, number>>;
  /** Seconds from created to the last phase reached. */
  total_s: number | null;
};

// The `timing` column is added next to the table's others (agents.ts).

const isPhase = (p: string): p is Phase => (PHASES as readonly string[]).includes(p);

/** Records when a change first reached a phase. A phase already recorded keeps its first time. Never throws. */
export function noteTiming(id: string, phase: Phase, at: number = Date.now()): boolean {
  try {
    if (!isPhase(phase) || !Number.isFinite(at)) return false;
    const row = db.prepare('SELECT timing FROM changes WHERE id = ?').get(id) as { timing: string | null } | undefined;
    if (!row) return false;
    const cur = (parse(row.timing) ?? {}) as Record<string, number>;
    if (cur[phase]) return false;
    cur[phase] = Math.round(at);
    db.prepare('UPDATE changes SET timing = ? WHERE id = ?').run(JSON.stringify(cur), id);
    return true;
  } catch { return false; }
}

/** The change an agent job's unit belongs to (detach.ts names them hawkes-agent-<change>-<time>), or null. */
export const changeOfUnit = (unit: string) => /^hawkes-agent-(c_[a-z0-9]+)-/.exec(unit)?.[1] ?? null;

const JOB_TIMING = /^\[job\] timing (job_started|workspace_ready|first_output)=(\d{10,14})\s*$/gm;

/** Records the phase times a job's runner printed (`[job] timing <phase>=<epoch ms>`) for the change the unit belongs to. */
export function noteJobTiming(unit: string, text: string): number {
  const id = changeOfUnit(unit);
  if (!id || !text.includes('[job] timing ')) return 0;
  let n = 0;
  for (const m of text.matchAll(JOB_TIMING)) if (noteTiming(id, m[1] as Phase, Number(m[2]))) n++;
  return n;
}

/** The line a job's runner prints when it reaches a phase. */
export const jobTimingLine = (phase: 'job_started' | 'workspace_ready' | 'first_output', at: number = Date.now()) => `[job] timing ${phase}=${at}`;

/**
 * The `timing` field of a change: every phase reached (epoch ms), the seconds between them and the total. `row` is a
 * `changes` row; the beta phases come from beta's run (`beta`, change-rail.ts betaPart) and the task's verification
 * (`verifiedAt`) when the stored times don't have them yet. Pure.
 */
export function timingFrom(row: { created?: number | null; timing?: string | null; merged_at?: number | null; status?: string | null }, beta?: { built?: number | null; played?: number | null } | null, verifiedAt?: number | null): Timing {
  const t = { ...(parse(row.timing) ?? {}) } as Record<string, number>;
  if (row.created) t.created ??= row.created;
  if (row.status === 'merged' && row.merged_at) t.merged ??= row.merged_at;
  if (beta?.built) t.beta_built ??= beta.built;
  if (verifiedAt) t.first_verdict ??= verifiedAt;
  else if (beta?.played) t.first_verdict ??= beta.played;
  const out: Timing = { spans: {}, total_s: null };
  let prev: Phase | null = null;
  for (const p of PHASES) {
    if (!t[p]) continue;
    out[p] = t[p];
    if (prev) out.spans[`${prev}_to_${p}`] = Math.round((t[p] - t[prev]) / 100) / 10;
    prev = p;
  }
  if (prev && t.created) out.total_s = Math.round((t[prev] - t.created) / 100) / 10;
  return out;
}

/** A change row's timing, with beta's and the task's part for a merged change (looked up through `lookup`); stores them once they exist. */
export function timingOf(row: any, lookup: { beta?: (product: string, mergedAt: number | null) => { built?: { state: string; at: number | null } | null; played?: { state: string; at: number | null } | null } | null; verified?: (task: string) => number | null } = {}): Timing {
  const stored = (parse(row.timing) ?? {}) as Record<string, number>;
  let beta: { built?: number | null; played?: number | null } | null = null;
  let verifiedAt: number | null = null;
  if (row.status === 'merged' && !(stored.beta_built && stored.first_verdict)) {
    try {
      const b = lookup.beta?.(row.product, row.merged_at ?? row.updated ?? null);
      if (b) beta = { built: b.built?.state === 'done' ? b.built.at : null, played: b.played?.state === 'done' ? b.played.at : null };
      if (row.task) verifiedAt = lookup.verified?.(row.task) ?? null;
    } catch { /* the lane has nothing to say yet */ }
  }
  const t = timingFrom(row, beta, verifiedAt);
  // Kept once reached, so the lane's own tables can be pruned and the list stays cheap.
  if (row.id) {
    if (beta?.built && !stored.beta_built) noteTiming(row.id, 'beta_built', beta.built);
    const v = verifiedAt ?? beta?.played ?? null;
    if (v && !stored.first_verdict) noteTiming(row.id, 'first_verdict', v);
  }
  return t;
}
