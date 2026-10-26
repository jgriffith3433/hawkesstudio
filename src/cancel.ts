// Cancelling (J, 2026-10-26: "make the system aware of what cancelled is"). Cancelled is its own outcome, never a
// failure: a Gen job that ends `cancelled` makes its step `cancelled`, a run with cancelled steps ends `cancelled` (or
// `partial` when other steps finished), and nothing is blamed: no finding, no question, no try, no fix task. Who cancelled
// and why is kept here (`cancellations`), keyed by subject: job:<id>, run:<id>, change:<id>.
// J and admins cancel from the Activity drawer (server.ts routes), Talk and the PM through studio_cancel; the agent
// sandbox only with a Talk/PM conversation behind it (guards.ts), never an agent on its own.

import { db } from './db.ts';
import { gen } from './gen.ts';

db.exec(`CREATE TABLE IF NOT EXISTS cancellations (subject TEXT PRIMARY KEY, by TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL);`);

export type CancelNote = { by: string; reason: string | null; at: number };

/** Records who cancelled a job, run or change, and why (the first record stands). */
export function noteCancel(subject: string, by: string, reason?: string | null) {
  db.prepare('INSERT OR IGNORE INTO cancellations (subject, by, reason, at) VALUES (?, ?, ?, ?)').run(subject, by, reason ? String(reason).slice(0, 300) : null, Date.now());
}
export function cancelNote(subject: string): CancelNote | null {
  const r = db.prepare('SELECT by, reason, at FROM cancellations WHERE subject = ?').get(subject) as CancelNote | undefined;
  return r ?? null;
}
/** The record as a sentence: "by Talk (to hold builds for an art pass)". */
export const cancelWords = (n: CancelNote | null) => (n ? `by ${n.by}${n.reason ? ` (${n.reason})` : ''}` : 'in Hawkes Gen');

/** A run's end status from its steps: failed wins; else cancelled steps (or a cancelled run) make it cancelled, or partial when other steps finished. */
export function endStatus(n: { failed: number; cancelled: number; done: number }, flagged = false): 'failed' | 'cancelled' | 'partial' | 'done' {
  if (n.failed) return 'failed';
  if (n.cancelled || flagged) return n.done ? 'partial' : 'cancelled';
  return 'done';
}
export function runCounts(run: string) {
  const c = (s: string) => (db.prepare('SELECT COUNT(*) AS n FROM steps WHERE run = ? AND status = ?').get(run, s) as any).n as number;
  return { failed: c('failed'), cancelled: c('cancelled'), done: c('done') };
}
export const runCancelled = (run: string) => Boolean(cancelNote(`run:${run}`));

/** Whether a run's beta build step was cancelled: that beta was not built, so nothing is blamed and the next push builds again. */
export function buildCancelled(run: string, product?: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM steps WHERE run = ? AND kind = 'build' AND status = 'cancelled' ${product ? 'AND product = ?' : ''}`).get(...(product ? [run, product] : [run])));
}

/** The note for a step whose Gen job ended cancelled: who did it, if Studio did (else it was cancelled in Gen). */
export function jobCancelDetail(job: { id?: string; error?: string | null; detail?: string | null }) {
  const n = job.id ? cancelNote(`job:${job.id}`) : null;
  return `cancelled ${cancelWords(n)}${n ? '' : job.error ? `: ${String(job.error).slice(0, 160)}` : ''}`;
}

/** Cancels one Gen job (queued or running) and records who. Returns Gen's answer. */
export async function cancelJob(jobId: string, by: string, reason?: string | null) {
  noteCancel(`job:${jobId}`, by, reason);
  const after = await gen.cancel(jobId);
  return { job: jobId, status: after?.status ?? 'cancelled' };
}

/**
 * Cancels a whole run: it plays and builds nothing more (the pipeline checks runCancelled before each step), and the
 * Gen jobs its running steps wait on are cancelled. The run ends cancelled (or partial) when its body gets there.
 */
export async function cancelRun(runId: string, by: string, reason?: string | null) {
  const run = db.prepare('SELECT id, status FROM runs WHERE id = ?').get(runId) as { id: string; status: string } | undefined;
  if (!run) throw new Error(`No such run ${runId}`);
  if (run.status !== 'running') throw new Error(`Run ${runId} is ${run.status}, not running`);
  noteCancel(`run:${runId}`, by, reason);
  const jobs = (db.prepare(`SELECT job FROM steps WHERE run = ? AND status = 'running' AND job IS NOT NULL`).all(runId) as { job: string }[]).map((s) => s.job);
  const out: { job: string; status?: string; error?: string }[] = [];
  for (const j of new Set(jobs)) out.push(await cancelJob(j, by, reason).catch((e: any) => ({ job: j, error: String(e.message ?? e) })));
  return { run: runId, cancelledJobs: out };
}

/** What a cancelled run reads like in a list: its detail with who and why. */
export function runCancelDetail(run: string, base: string) {
  const n = cancelNote(`run:${run}`);
  return n ? `${base} (cancelled ${cancelWords(n)})` : base;
}

/** One-time repair of what a Gen-side cancel left as "failed" before Studio knew the word (run r_f75a40eec26e, 2026-10-26). */
export function repairCancelled() {
  const steps = db.prepare(`SELECT id, run, detail FROM steps WHERE status = 'failed' AND kind IN ('build', 'playtest', 'check') AND (detail LIKE 'failed: cancelled%' OR detail LIKE 'failed: %cancelled before it started%')`).all() as { id: string; run: string; detail: string }[];
  const runs = new Set<string>();
  for (const s of steps) {
    db.prepare(`UPDATE steps SET status = 'cancelled', detail = ? WHERE id = ?`).run(s.detail.replace(/^failed: /, 'cancelled in Hawkes Gen: '), s.id);
    runs.add(s.run);
  }
  for (const run of runs) {
    const r = db.prepare('SELECT status FROM runs WHERE id = ?').get(run) as { status: string } | undefined;
    if (!r || r.status === 'running') continue;
    const status = endStatus(runCounts(run));
    db.prepare(`UPDATE runs SET status = ?, detail = ? WHERE id = ?`).run(status, `cancelled in Hawkes Gen (not a failure)`, run);
  }
  return [...runs];
}

/**
 * The cancel routes (server.ts): POST /api/runs/<id>/cancel, /api/jobs/<id>/cancel (any Gen job: a playtest, a build,
 * GPU work), /api/changes/<id>/cancel and /resume. `by` is inbox.ts actor() (J, Talk, Talk (PM)). Every cancel is a line
 * in the PM's decision log. Returns null when the route is not one of these.
 */
export async function cancelRoute(route: string, method: string, by: string, body: { reason?: unknown } = {}): Promise<unknown | null> {
  if (method !== 'POST') return null;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;
  const { logDecision } = await import('./roadmap.ts');
  const words = (x: string) => `${by} ${x}${reason ? `: ${reason}` : ''}`;
  let m = /^\/api\/runs\/(r_[0-9a-f]+)\/cancel$/.exec(route);
  if (m) {
    const r = await cancelRun(m[1], by, reason);
    const product = (JSON.parse((db.prepare('SELECT products FROM runs WHERE id = ?').get(m[1]) as any)?.products ?? '[]') as string[])[0] ?? null;
    logDecision('cancelled', m[1], product, words(`cancelled run ${m[1]} (${r.cancelledJobs.length} Gen job(s) cancelled)`));
    return { ok: true, ...r };
  }
  m = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(route);
  if (m) {
    const job = await gen.job(m[1]).catch(() => null);
    if (!job) throw new Error(`No such Gen job ${m[1]}`);
    if (['done', 'failed', 'cancelled'].includes(job.status)) throw new Error(`Gen job ${m[1]} is already ${job.status}`);
    const r = await cancelJob(m[1], by, reason);
    logDecision('cancelled', m[1], job.project ?? null, words(`cancelled Gen job ${m[1]} (${job.tool}, ${job.status})`));
    return { ok: true, ...r };
  }
  m = /^\/api\/changes\/(c_[0-9a-f]+)\/(cancel|resume)$/.exec(route);
  if (m) {
    const agents = await import('./agents.ts');
    const c = m[2] === 'cancel' ? await agents.cancelChange(m[1], by, reason) : agents.resumeChange(m[1], by);
    logDecision(m[2] === 'cancel' ? 'cancelled' : 'resumed', c?.task ?? m[1], c?.product ?? null, words(`${m[2] === 'cancel' ? 'cancelled' : 'resumed'} agent change ${m[1]}`));
    return { ok: true, change: c };
  }
  return null;
}
