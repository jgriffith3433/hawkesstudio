// A beta run behind a build that is still publishing waits for it (J, 2026-11-13: Dose of Destruction's published beta site
// was at 5cf5829 while beta was e8efd9a; the real publish, build run r_7a309b98757f, took 25+ minutes for ~3,975 files, and
// three beta runs in a row, four minutes apart, each failed 4 playtests as "Stale verdict ... didn't finish within 120 s",
// each starting its own republish that queued behind the running build).
//
// The rule, in one place:
//   - a play that finds the site behind beta while a build run of the project is going starts no second republish: its
//     step ends `cancelled` (data.waitingForBuild; never failed, no finding, no fix, nothing blamed: cancel.ts) and the run
//     is recorded here as WAITING for that build (holdForBuild)
//   - a beta run asked for while such a wait is open and its build still goes is recorded waiting at once and plays
//     nothing (startBeta; guarded), so there is no failed run every four minutes
//   - when the build run ends (builds.ts startBuild, its `done`; and once at start-up for a build that ended while Studio
//     was down) resumeAfterBuild starts ONE beta run per product, for what the held run was for
// No polling: the build's own end is the event.

import { db, newId } from './db.ts';

db.exec(`CREATE TABLE IF NOT EXISTS build_waits (
  id TEXT PRIMARY KEY, run TEXT, product TEXT NOT NULL, build_run TEXT NOT NULL, since INTEGER NOT NULL, resumed INTEGER, resume_run TEXT
)`);

/** The build run of the project that is going now (its newest), or null. */
export function runningBuildOf(product: string): string | null {
  const rows = db.prepare("SELECT id, products FROM runs WHERE kind = 'build' AND status = 'running' ORDER BY started DESC").all() as { id: string; products: string | null }[];
  for (const r of rows) {
    try { if ((JSON.parse(r.products ?? '[]') as string[]).includes(product)) return r.id; } catch { /* unreadable products */ }
  }
  return null;
}

/** Records that a beta run is waiting for a build run of its project (once per run). */
export function holdForBuild(run: string, product: string, buildRun: string, now = Date.now()) {
  if (db.prepare('SELECT 1 FROM build_waits WHERE run = ?').get(run)) return;
  db.prepare('INSERT INTO build_waits (id, run, product, build_run, since) VALUES (?, ?, ?, ?, ?)').run(newId('bw'), run, product, buildRun, now);
  console.log(`[studio] ${product}: run ${run} waits for build ${buildRun}; one beta run plays when it is done`);
}

/** Whether this run ended waiting for a build (its steps are not the game's, nor a change's). */
export const heldForBuild = (run: string): boolean => Boolean(db.prepare('SELECT 1 FROM build_waits WHERE run = ?').get(run));

/** The build run the project's beta play is waiting on: a wait is open and a build of the project still goes. Null otherwise. */
export function waitingOnBuild(product: string): { buildRun: string; since: number } | null {
  const w = db.prepare('SELECT since FROM build_waits WHERE product = ? AND resumed IS NULL ORDER BY since LIMIT 1').get(product) as { since: number } | undefined;
  if (!w) return null;
  const buildRun = runningBuildOf(product);
  return buildRun ? { buildRun, since: w.since } : null;
}

type StartBeta = (product: string, o: { focus: string; playtest: boolean; play?: 'milestone' | 'golive'; plays?: any[]; cause?: 'person' | 'milestone'; criteria?: string[]; scenario?: string; options?: Record<string, unknown> }) => { id: string };

/**
 * The build run of the product ended: its waiting beta runs are played again, ONE run per product however many waited,
 * for what the newest of them was for. Nothing starts while another build of the product still goes. Returns the new runs.
 * `startBeta` is pipeline.ts's (a parameter: no import cycle).
 */
export function resumeAfterBuild(startBeta: StartBeta, product?: string, now = Date.now()): string[] {
  const products = product ? [product] : (db.prepare('SELECT DISTINCT product FROM build_waits WHERE resumed IS NULL').all() as { product: string }[]).map((r) => r.product);
  const started: string[] = [];
  for (const prod of products) {
    if (runningBuildOf(prod)) continue; // another build of it goes: its end resumes
    const rows = db.prepare('SELECT * FROM build_waits WHERE product = ? AND resumed IS NULL ORDER BY since DESC').all(prod) as any[];
    if (!rows.length) continue;
    // Marked before it starts: a second event while this runs can't start it twice.
    const took = db.prepare('UPDATE build_waits SET resumed = ? WHERE product = ? AND resumed IS NULL').run(now, prod);
    if (!Number(took.changes)) continue;
    let o: any = {};
    try { o = JSON.parse((db.prepare('SELECT options FROM runs WHERE id = ?').get(rows[0].run) as any)?.options || '{}'); } catch { o = {}; }
    const play = o.play === 'milestone' || o.play === 'golive' ? o.play : undefined;
    try {
      const b = startBeta(prod, {
        focus: `Playing beta again: the earlier run was waiting for build ${rows[0].build_run}, which is done.${o.focus ? ` ${o.focus}` : ''}`,
        playtest: o.playtest !== false,
        ...(play ? { play } : {}), ...(o.plays ? { plays: o.plays } : {}), ...(o.cause ? { cause: o.cause } : {}),
        ...(o.criteria ? { criteria: o.criteria } : {}), ...(o.scenario ? { scenario: o.scenario } : {}), ...(o.options ? { options: o.options } : {}),
      });
      db.prepare('UPDATE build_waits SET resume_run = ? WHERE product = ? AND resumed = ?').run(b.id, prod, now);
      started.push(b.id);
    } catch (e: any) {
      console.warn(`[studio] ${prod}: couldn't play beta again after its build: ${e?.message ?? e}`);
    }
  }
  if (started.length) console.log(`[studio] build done: played beta again in ${started.join(', ')}`);
  return started;
}
