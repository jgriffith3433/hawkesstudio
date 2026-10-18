// Unity beta builds collapse (J, 2026-10-18: "make this faster ... but also make sure it's reliable"). One build server,
// about 10 minutes and $0.12 a build: a burst of merges used to queue a beta build each, and beta lagged half an hour.
//
// - A beta run of a Unity product waits a short quiet time first (STUDIO_BETA_QUIET_MS, 2 min; each newer beta run of
//   the product starts its own, so a burst of pushes ends in one build).
// - While it waits, a newer beta run of the same product supersedes it: it ends "skipped: superseded by r_<newer>
//   (beta <sha>)", never failed, and the newer run builds beta's newest commit.
// - A run that has its turn waits for an older run's build of the product to finish (never two building into the beta
//   website copy at once). An older beta run's build job that is still *queued* in Hawkes Gen behind another build is
//   cancelled (Gen's state checked before and after: a job that started is never touched); a running build always
//   finishes. Daily runs, go-live builds (golive.ts) and agent change builds (agents.ts) are never cancelled or skipped.
//
// Steps: the beta run's "beta queue" step is running while it waits and done once it has its turn (pipeline.ts betaBody).

import { db, parse, J } from './db.ts';

try { db.exec('ALTER TABLE runs ADD COLUMN origin TEXT'); } catch { /* already there (followup.ts) */ }

export const BETA_QUIET_MS = () => Number(process.env.STUDIO_BETA_QUIET_MS ?? 120_000);
const TICK_MS = () => Number(process.env.STUDIO_BETA_TICK_MS ?? 5_000);
/** A run "running" for longer than this was left behind (startRun's rule): it holds nothing up. */
const STALE_MS = 6 * 3600_000;

/** What betaqueue needs from Hawkes Gen (gen.ts `gen`; a stand-in in tests). */
export type GenQueue = { job(id: string): Promise<any>; cancel(id: string): Promise<any>; jobs(q: Record<string, string>): Promise<any[]> };
const realGen = async (): Promise<GenQueue> => (await import('./gen.ts')).gen;

/** The last push to each Unity product's beta (betawatch.ts): a waiting run's quiet time restarts from it. */
const lastPush = new Map<string, number>();
export const notePush = (product: string, at = Date.now()) => void lastPush.set(product, at);

/**
 * A beta run of the product that hasn't started building yet (it builds the checkout's newest commit when it does, so
 * a push needs no run of its own), if any.
 */
export function waitingBetaRun(product: string): string | null {
  const rows = db.prepare(`SELECT id FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ? AND started > ? ORDER BY rowid DESC`).all(like(product), Date.now() - STALE_MS) as { id: string }[];
  for (const r of rows) {
    const steps = db.prepare(`SELECT kind, name, status FROM steps WHERE run = ? AND product = ? AND ((kind = 'beta' AND name = 'queue') OR (kind = 'build' AND name = 'unity'))`).all(r.id, product) as any[];
    if (!steps.some((s) => s.kind === 'build' || s.status !== 'running')) return r.id;
  }
  return null;
}

const like = (product: string) => `%"${product}"%`;
const me = (run: string) => db.prepare('SELECT rowid AS n, started FROM runs WHERE id = ?').get(run) as { n: number; started: number } | undefined;

/** The newest beta run of the product started after this one and still going (it supersedes this one), if any. */
export function newerBetaRun(run: string, product: string): string | null {
  const m = me(run);
  if (!m) return null;
  const r = db.prepare(`SELECT id FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ? AND rowid > ? ORDER BY rowid DESC LIMIT 1`).get(like(product), m.n) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * Older runs of the product that are building it now (or about to): beta runs past their quiet time whose build hasn't
 * finished, and daily runs with a Unity build going. With the build step, if any, and its Gen job.
 */
export function olderBuilds(run: string, product: string) {
  const m = me(run);
  if (!m) return [];
  const rows = db.prepare(`SELECT id, kind FROM runs WHERE status = 'running' AND kind IN ('beta', 'daily') AND products LIKE ? AND rowid < ? AND started > ?`)
    .all(like(product), m.n, Date.now() - STALE_MS) as { id: string; kind: string }[];
  const out: { run: string; kind: string; step: string | null; job: string | null }[] = [];
  for (const r of rows) {
    const build = db.prepare(`SELECT id, status, job FROM steps WHERE run = ? AND product = ? AND kind = 'build' AND name = 'unity' ORDER BY started DESC LIMIT 1`).get(r.id, product) as any;
    if (build && build.status !== 'running') continue; // built (or skipped): nothing in the way
    if (r.kind === 'beta') {
      // A beta run still in its quiet time isn't building: it will see this newer run and step aside.
      const turn = db.prepare(`SELECT status FROM steps WHERE run = ? AND product = ? AND kind = 'beta' AND name = 'queue'`).get(r.id, product) as any;
      if (!build && turn?.status !== 'done') continue;
    } else if (!build) continue; // a daily run not at this product's build
    out.push({ run: r.id, kind: r.kind, step: build?.id ?? null, job: build?.job ?? null });
  }
  return out;
}

/**
 * Cancels a beta build job only if it never started: Gen says it is queued and another build-server job is running (so
 * it can't start this instant), and after the cancel Gen says cancelled with no start time. True: cancelled unstarted.
 */
export async function cancelIfQueued(job: string, g?: GenQueue): Promise<boolean> {
  const api = g ?? (await realGen());
  try {
    const j = await api.job(job);
    if (j?.status !== 'queued' || j.started) return false;
    const busy = (await api.jobs({ status: 'running', limit: '100' })).some((x) => x.id !== job && /^unity\./.test(String(x.tool)));
    if (!busy) return false; // the build server is free: it may start any moment, so leave it (the newer run waits)
    const after = await api.cancel(job);
    const ok = after?.status === 'cancelled' && !after.started;
    if (!ok) console.warn(`[beta] ${job} was not cancelled before it started (${after?.status}); it builds and the newer run waits`);
    return ok;
  } catch (e: any) {
    console.warn(`[beta] couldn't check ${job} in Hawkes Gen: ${e.message ?? e}`);
    return false;
  }
}

/** Marks a beta run superseded: skipped (not failed), its queue slot free, the newer run named. Returns the detail. */
export function supersede(run: string, product: string, by: string, sha?: string | null) {
  const detail = `skipped: superseded by ${by}${sha ? ` (beta ${sha.slice(0, 7)})` : ''}`;
  const now = Date.now();
  db.prepare(`UPDATE steps SET status = 'skipped', detail = ?, finished = ? WHERE run = ? AND status = 'running'`).run(detail, now, run);
  const r = db.prepare('SELECT options, origin FROM runs WHERE id = ?').get(run) as any;
  db.prepare(`UPDATE runs SET status = 'skipped', detail = ?, finished = ?, options = ?, cost = (SELECT COALESCE(SUM(cost), 0) FROM steps WHERE run = ?) WHERE id = ?`)
    .run(detail, now, J({ ...(parse(r?.options) ?? {}), supersededBy: by }), run, run);
  // The conversation that asked for it hears the newer run's result too.
  if (r?.origin) db.prepare('UPDATE runs SET origin = ? WHERE id = ? AND origin IS NULL').run(r.origin, by);
  console.log(`[beta] ${run} (${product}) ${detail}`);
  return detail;
}

/**
 * What the runs this one superseded asked for (and theirs, all the way back): their playtest wish, criteria and
 * scenario carry over to the build that covers them.
 */
export function absorbed(run: string): { playtest?: boolean; criteria?: string[]; scenario?: string; options?: Record<string, unknown>; focus?: string; plays?: { scenario?: string; options?: Record<string, unknown>; criteria: string[] }[] }[] {
  const out: any[] = [];
  const seen = new Set([run]);
  const todo = [run];
  while (todo.length) {
    const id = todo.shift()!;
    for (const r of db.prepare(`SELECT id, options FROM runs WHERE kind = 'beta' AND status = 'skipped' AND options LIKE ?`).all(`%"supersededBy":"${id}"%`) as any[]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      todo.push(r.id);
      out.push(parse(r.options) ?? {});
    }
  }
  return out;
}

export type Turn = { superseded: string } | { go: true };

/**
 * A beta run's turn at the build server: waits out the quiet time (from the run's start) and any older build of the
 * product, cancelling older beta builds still queued in Gen. Ends early when a newer beta run arrives. onGo marks the
 * run's queue step done (synchronously, in the same tick as the check).
 */
export async function betaTurn(run: string, product: string, { quiet = BETA_QUIET_MS(), onWait, onGo, gen: g }: { quiet?: number; onWait?: (detail: string) => void; onGo?: () => void; gen?: GenQueue } = {}): Promise<Turn> {
  const begun = me(run)?.started ?? Date.now();
  let said = '';
  const say = (d: string) => { if (d !== said) { said = d; onWait?.(d); } };
  const tried = new Set<string>();
  for (;;) {
    const newer = newerBetaRun(run, product);
    if (newer) return { superseded: newer };
    // Quiet since this run started and since the last push to the product's beta.
    const left = (quiet > 0 ? Math.max(begun, lastPush.get(product) ?? 0) : begun) + quiet - Date.now();
    if (left > 0) say(`waiting ${Math.ceil(left / 1000)} s for more pushes (a newer beta run takes over from this one)`);
    else {
      const older = olderBuilds(run, product);
      if (!older.length) {
        // Recorded before anything else can run: a newer run checking now sees this one building and waits for it.
        onGo?.();
        return { go: true };
      }
      for (const o of older) {
        if (o.kind !== 'beta' || !o.job || tried.has(o.job)) continue;
        tried.add(o.job);
        // Cancelled unstarted: its own run sees the cancel and ends superseded (pipeline.ts finishBuild).
        if (await cancelIfQueued(o.job, g)) console.log(`[beta] cancelled ${o.job} of ${o.run} (queued, never started): ${run} builds ${product}'s newer beta`);
      }
      say(`waiting for ${older.map((o) => o.run).join(', ')} to finish building (a running build always finishes)`);
    }
    await new Promise((r) => setTimeout(r, Math.max(10, Math.min(TICK_MS(), left > 0 ? left : Infinity))));
  }
}
