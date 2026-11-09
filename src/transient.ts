// Transient failures retry by themselves (J, 2026-11-09: "make transient failures retry with backoff instead of stopping
// work or filing cards"). Nothing polls: each failure schedules its own timer (and a row, so a restart carries it on).
//
//   Playtests refused with HTTP 429 (Dose of Destruction r_a47c789f90fa, r_affe80564a2d): the step ends `cancelled`
//     ("rate limited, retrying", never a failure, no review), and the same playtest is started again after 2, 5, 10, 20
//     and 30 minutes. The new run reports to the same origin, so the conversation that asked hears the result when it lands.
//   Runs and agent changes stopped for "Studio restarted N times in a row": once Studio has stayed up STABLE_MS the cause
//     was not them, so each is started again once (a change carries on from its step: agents.ts reviveRestartStopped; a
//     run is started again as a new one; project builds it stopped are rebuilt once).
//   Gen lookups of an import: access.ts answers 503, mcp-tools.ts retries (backoff.ts).

import { db } from './db.ts';

/** HTTP 429 (a provider, Gen, the playtest lane) or words saying so. */
export function isRateLimited(e: unknown): boolean {
  const x: any = e;
  if (Number(x?.status) === 429) return true;
  return /(^|[^\d])429([^\d]|$)|too many requests|rate.?limit(ed)?\b/i.test(String(x?.message ?? x ?? ''));
}

export const RATE_WAITS_MS = [2, 5, 10, 20, 30].map((m) => m * 60_000);
/** How long Studio must have been up before what restarts stopped is started again. STUDIO_STABLE_MS: tests and operators. */
export const STABLE_MS = () => Number(process.env.STUDIO_STABLE_MS ?? 15 * 60_000);

db.exec(`CREATE TABLE IF NOT EXISTS rate_retries (
  run TEXT PRIMARY KEY, product TEXT NOT NULL, kind TEXT NOT NULL, spec TEXT NOT NULL, origin TEXT, attempt INTEGER NOT NULL,
  due INTEGER NOT NULL, state TEXT NOT NULL, next_run TEXT, why TEXT
)`);

export type PlaySpec = Record<string, unknown>;
/** Replaced by the tests (nothing really plays). */
export const hooks: { start: (kind: 'beta' | 'playtest', product: string, spec: PlaySpec, origin: string | null) => Promise<string | null> } = {
  start: async (kind, product, spec, origin) => {
    const P = await import('./pipeline.ts');
    if (kind === 'beta') return P.startBeta(product, { ...(spec as any), origin }).id;
    return P.startPartial('playtest', product, { ...(spec as any), origin }).id;
  },
};

const timers = new Map<string, NodeJS.Timeout>();
function arm(run: string, ms: number) {
  const old = timers.get(run);
  if (old) clearTimeout(old);
  const t = setTimeout(() => { timers.delete(run); void fireRateRetry(run); }, Math.max(0, ms));
  t.unref?.();
  timers.set(run, t);
}

/**
 * A playtest of `run` was refused with 429. It is played again after the next wait; the third, fourth... refusal of its
 * retries wait longer, up to RATE_WAITS_MS.length tries. Returns when (ms since epoch) it plays again, or null when the
 * tries are used up (the caller then lets the refusal stand as a failure).
 */
export function scheduleRateRetry(o: { run: string; product: string; kind: 'beta' | 'playtest'; spec: PlaySpec; why: string }): number | null {
  const prev = db.prepare(`SELECT * FROM rate_retries WHERE next_run = ?`).get(o.run) as any;
  const attempt = prev ? Number(prev.attempt) + 1 : 1;
  if (attempt > RATE_WAITS_MS.length) return null;
  const origin = (db.prepare('SELECT origin FROM runs WHERE id = ?').get(o.run) as any)?.origin ?? null;
  const due = Date.now() + RATE_WAITS_MS[attempt - 1];
  db.prepare(`INSERT OR REPLACE INTO rate_retries (run, product, kind, spec, origin, attempt, due, state, next_run, why) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, ?)`)
    .run(o.run, o.product, o.kind, JSON.stringify(o.spec), origin, attempt, due, o.why.slice(0, 300));
  arm(o.run, due - Date.now());
  return due;
}

export function rateRetryOf(run: string) {
  return db.prepare('SELECT * FROM rate_retries WHERE run = ?').get(run) as { attempt: number; due: number; state: string; next_run: string | null } | undefined;
}

export async function fireRateRetry(run: string): Promise<string | null> {
  const r = db.prepare(`SELECT * FROM rate_retries WHERE run = ? AND state = 'waiting'`).get(run) as any;
  if (!r) return null;
  try {
    const next = await hooks.start(r.kind, r.product, JSON.parse(r.spec), r.origin ?? null);
    db.prepare(`UPDATE rate_retries SET state = 'started', next_run = ? WHERE run = ?`).run(next, run);
    return next;
  } catch (e: any) {
    console.warn(`[studio] ${run}: the rate-limited playtest couldn't start again: ${String(e?.message ?? e).slice(0, 200)}`);
    db.prepare(`UPDATE rate_retries SET state = 'gaveup' WHERE run = ?`).run(run);
    return null;
  }
}

/** After a restart: retries that were waiting carry on (late ones a few seconds from now). */
export function resumeRateRetries() {
  for (const r of db.prepare(`SELECT run, due FROM rate_retries WHERE state = 'waiting'`).all() as any[]) arm(r.run, Math.max(5_000, r.due - Date.now()));
}

// ------------------------------------------------------------------ what restarts stopped

/** Runs "stopped: Studio restarted ..." (pipeline.ts stopResumedRun) that have not been started again, newest first. */
export function restartStoppedRuns(sinceMs = 24 * 3600_000): any[] {
  return (db.prepare(`SELECT * FROM runs WHERE status = 'failed' AND detail LIKE 'stopped: Studio restarted%' AND finished > ? ORDER BY finished DESC LIMIT 50`).all(Date.now() - sinceMs) as any[])
    .filter((r) => !JSON.parse(r.options || '{}')?.revived);
}

export type Revive = { runs: string[]; changes: string[]; builds: string[] };
/** Starts again, once each, what Studio's restarts stopped. `deps` is for the tests. */
export async function reviveStopped(deps: { startRun?: (r: any) => Promise<string | null>; changes?: () => string[] } = {}): Promise<Revive> {
  const out: Revive = { runs: [], changes: [], builds: [] };
  for (const r of restartStoppedRuns()) {
    const options = JSON.parse(r.options || '{}');
    // Marked first: whatever happens next, a run is started again at most once.
    db.prepare('UPDATE runs SET options = ? WHERE id = ?').run(JSON.stringify({ ...options, revived: true }), r.id);
    try {
      const id = await (deps.startRun ?? startAgain)(r);
      if (id) { out.runs.push(id); if (r.kind === 'build') out.builds.push(id); }
    } catch (e: any) {
      console.warn(`[studio] ${r.id}: couldn't start it again after the restarts: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  out.changes = (deps.changes ?? (() => []))();
  if (!deps.changes) out.changes = (await import('./agents.ts')).reviveRestartStopped();
  return out;
}

async function startAgain(r: any): Promise<string | null> {
  const options = JSON.parse(r.options || '{}');
  const [product] = JSON.parse(r.products || '[]') as string[];
  if (!product) return null;
  const P = await import('./pipeline.ts');
  const origin = r.origin ?? undefined;
  if (r.kind === 'build' && Array.isArray(options.builds)) {
    // A project's builds that failed because Studio kept restarting: built again once.
    const B = await import('./builds.ts');
    let id: string | null = null;
    for (const b of options.builds as string[]) id = (await B.startBuild(product, { build: b, ref: options.ref, retry: 3, origin }))?.id ?? id;
    return id;
  }
  if (r.kind === 'beta') return P.startBeta(product, { focus: options.focus, criteria: options.criteria, scenario: options.scenario, options: options.options, playtest: options.playtest, plays: options.plays, origin }).id;
  if (['build', 'playtest', 'test'].includes(r.kind)) return P.startPartial(r.kind, product, { ...(options as any), origin, resumes: undefined, restarts: undefined, revived: undefined }).id;
  return null; // the daily run: tomorrow's covers it
}

let stableTimer: NodeJS.Timeout | null = null;
/** Arms the one timer for this start-up: when Studio has been up STABLE_MS, what restarts stopped is started again. */
export function reviveWhenStable(fire: () => unknown = () => reviveStopped()) {
  if (stableTimer) clearTimeout(stableTimer);
  const left = Math.max(0, STABLE_MS() - process.uptime() * 1000);
  stableTimer = setTimeout(() => { stableTimer = null; void Promise.resolve(fire()).catch((e) => console.warn(`[studio] reviving what restarts stopped: ${e?.message ?? e}`)); }, left);
  stableTimer.unref?.();
  return left;
}
