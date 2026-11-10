// The invariants the self-healing supervisor keeps (selfheal.ts), each with the remedy Studio applies by itself. Every
// one comes from a stall that happened: the date and what it did are next to it. A new kind of stall becomes a new entry
// here, filed by the supervisor itself as a Studio fix task (selfheal.ts anomaly and escalation).
//
// Rules for a remedy: it never spends money beyond Studio's caps, it is logged with what it touched, and anything it
// does can be undone (a requeue, a cap that ends by itself, a run stopped with its jobs cancelled, a stale flag removed).

import { db } from './db.ts';
import { register, type Look } from './selfheal.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ok: Look = { breach: null };

/** The supervisor's look at changes and runs, read from the database (pure on the rows: tested). */
export type QueueRow = { id: string; task: string | null; status: string; detail: string | null; product: string; created: number; updated: number | null };

/** Two or more open changes for the same task (a duplicate the PM or a restart made): the newest queued ones are extra. */
export function duplicates(rows: QueueRow[]): { keep: string; extra: string[]; task: string }[] {
  const OPEN = new Set(['queued', 'working', 'verifying', 'revising', 'needs answer', 'ready']);
  const by = new Map<string, QueueRow[]>();
  for (const r of rows) if (r.task && OPEN.has(r.status)) by.set(r.task, [...(by.get(r.task) ?? []), r]);
  const out: { keep: string; extra: string[]; task: string }[] = [];
  for (const [task, list] of by) {
    if (list.length < 2) continue;
    // Keep the one furthest along (anything not queued), else the oldest; the extra ones are queued and never started.
    const sorted = [...list].sort((a, b) => Number(a.status === 'queued') - Number(b.status === 'queued') || a.created - b.created);
    const extra = sorted.slice(1).filter((r) => r.status === 'queued').map((r) => r.id);
    if (extra.length) out.push({ keep: sorted[0].id, extra, task });
  }
  return out;
}

/** Queued changes held by a gate (memory, disk) while the machine has room for them now. */
export function falselyGated(rows: Pick<QueueRow, 'id' | 'status' | 'detail'>[], o: { memLow: boolean; diskFull: boolean }) {
  return rows.filter((r) => r.status === 'queued' && ((/^queued: waits for memory/.test(r.detail ?? '') && !o.memLow) || (/waits for disk room/.test(r.detail ?? '') && !o.diskFull))).map((r) => r.id);
}

/** A run still "running" with no step started or finished for this long is stuck (its process died, or a wait nobody ends). */
export const RUN_STUCK_MS = () => Number(process.env.STUDIO_RUN_STUCK_MS) > 0 ? Number(process.env.STUDIO_RUN_STUCK_MS) : 3 * HOUR;
export function stuckRuns(runs: { id: string; kind: string; started: number; lastStep: number | null }[], now: number, limit = RUN_STUCK_MS()) {
  return runs.filter((r) => now - Math.max(r.started, r.lastStep ?? 0) > limit);
}

/** The daily run is late when none started in this long (Cloud Scheduler calls it at 05:00 Los Angeles time). */
export const DAILY_LATE_MS = () => 26 * HOUR;

/** Failures that read as Studio's own machinery breaking (not the work being hard) and that no known cause explains. */
export const MACHINERY = /\b(TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EACCES|EPIPE|ECONNRESET|EMFILE|SIGKILL|SIGSEGV|Cannot read propert|is not a function|undefined is not|out of memory|heap)\b/i;

export function registerChecks() {
  const A = () => import('./agents.ts');

  // 2026-11-10: a disk budget below the disk's size at rest held every change for hours with five of six slots free.
  register({
    key: 'queue-idle', label: 'Free agent slots while work waits', escalate: 'fix',
    async look(now) {
      const a = await A();
      const q = a.queueHealth(now);
      if (!q.stalled) return ok;
      const did = a.checkQueue(now);
      return { breach: q.stalled, did: did ? 'dropped timed holds and started the queue' : null, evidence: [`held by: ${q.heldBy ?? '?'}`] };
    },
  });

  // 2026-11-10: changes sat 12 hours at "building the branch in the cloud" with nothing behind them.
  register({
    key: 'stuck-work', label: 'A change with no progress', escalate: 'fix',
    async look(now) {
      const a = await A();
      const took = a.checkStuck(now);
      // The watchdog takes them over each time; the same thing again and again is a cause to fix, not to keep taking over.
      const lastHour = (db.prepare("SELECT COUNT(*) n FROM selfheal_log WHERE key = 'stuck-work' AND kind = 'remedy' AND at > ?").get(now - HOUR) as any).n as number;
      const did = took.length ? `took over ${took.length}: ${took.map((d) => `${d.id} at ${d.step} (${d.idleMin} min) -> ${d.did}`).join('; ')}`.slice(0, 600) : null;
      if (lastHour + (took.length ? 1 : 0) >= 6) return { breach: `changes keep stalling: the watchdog took over work ${lastHour + 1} times in an hour`, did, evidence: took.map((d) => `${d.id} ${d.step} ${d.was} ${d.idleMin}m -> ${d.did}`) };
      return { breach: took.length ? `${took.length} change(s) had no progress` : null, did };
    },
  });

  // 2026-11-10: a usage hold whose reset time had passed stayed on, and work sat parked while the provider answered.
  register({
    key: 'provider-probe', label: 'A provider hold that is never probed again', escalate: 'fix',
    async look(now) {
      const H = await import('./harness-hold.ts');
      const overdue = H.activeHolds().filter((h) => now > h.until + 10 * MIN);
      if (!overdue.length) return ok;
      await H.reviewHolds(now);
      const still = H.activeHolds().filter((h) => Date.now() > h.until + 10 * MIN);
      return { breach: `${overdue.map((h) => h.harness).join(', ')} held past their probe time`, did: `probed ${overdue.length} provider(s)${still.length ? `; ${still.map((h) => h.harness).join(', ')} still overdue` : ', each looked at again'}` };
    },
  });

  // Gen restarting or unreachable: every build, playtest and verification waits on it.
  register({
    key: 'gen-reachable', label: 'Hawkes Gen answering', escalate: 'fix',
    async look() {
      const G = await import('./gen.ts');
      if (await G.genUp()) return ok;
      const back = await G.ensureGen();
      return { breach: 'Hawkes Gen is not answering', did: back ? 'started Hawkes Gen again; it answers' : 'asked for a Gen restart; it does not answer yet' };
    },
  });

  // A deploy that died left the drain flag: the queue waited for a deploy that would never come.
  register({
    key: 'deploy-paused', label: "Studio's own deploy or restart leaving work paused", escalate: 'fix',
    async look() {
      const D = await import('./drain.ts');
      if (!D.deployPending()) return ok;
      const did = D.clearStaleDeployFlag();
      return did ? { breach: 'a deploy drain flag held the queue with no deploy behind it', did } : ok;
    },
  });

  // 2026-11-10: "waits for disk room" and "waits for memory" stayed on changes after memory and disk were free again.
  register({
    key: 'gates-false', label: 'Memory or disk gates holding work while there is room', escalate: 'fix',
    async look() {
      const a = await A();
      const M = await import('./memgate.ts');
      const S = await import('./disksweep.ts');
      const rows = db.prepare("SELECT id, status, detail FROM changes WHERE status = 'queued'").all() as any[];
      const ids = falselyGated(rows, { memLow: M.memLow(), diskFull: S.diskFull() });
      if (!ids.length) return ok;
      const cleared = a.clearDiskWaits();
      await a.pumpNow();
      return { breach: `${ids.length} change(s) said they wait for memory or disk while there is room`, did: `looked at them again now${cleared ? ` (${cleared} disk wait(s) dropped)` : ''}`, evidence: ids.slice(0, 20) };
    },
  });

  // The PM or a restart made a second change for the same task: it would redo the work and hold a slot.
  register({
    key: 'duplicates', label: 'Duplicate changes for one task', escalate: 'fix',
    async look() {
      const rows = db.prepare("SELECT id, task, status, detail, product, created, updated FROM changes WHERE status IN ('queued','working','verifying','revising','needs answer','ready') AND task IS NOT NULL").all() as QueueRow[];
      const dup = duplicates(rows);
      if (!dup.length) return ok;
      const a = await A();
      const closed: string[] = [];
      for (const d of dup) for (const id of d.extra) {
        // Queued and never started: nothing to undo but the status; the log names the one it duplicated.
        if (await a.closeDuplicate(id, d.keep)) closed.push(id);
      }
      return { breach: `${dup.length} task(s) had more than one open change`, did: closed.length ? `closed ${closed.length} queued duplicate(s): ${closed.join(', ')}` : null, evidence: dup.map((d) => `${d.task}: kept ${d.keep}, extra ${d.extra.join(', ')}`) };
    },
  });

  // A queued change for a task that was dropped or is done: it would redo or undo finished work.
  register({
    key: 'orphans', label: 'Changes for dropped or finished tasks', escalate: 'fix',
    async look() {
      const rows = db.prepare(`SELECT c.id, t.id task, t.status tstatus FROM changes c JOIN tasks t ON t.id = c.task WHERE c.status = 'queued' AND t.status IN ('dropped', 'done', 'live', 'verified')`).all() as { id: string; task: string; tstatus: string }[];
      if (!rows.length) return ok;
      const a = await A();
      const closed: string[] = [];
      for (const r of rows) if (await a.closeOrphan(r.id, `its task ${r.task} is ${r.tstatus}`)) closed.push(r.id);
      return { breach: `${rows.length} queued change(s) on dropped or finished tasks`, did: closed.length ? `closed ${closed.length}: ${closed.join(', ')}` : null, evidence: rows.map((r) => `${r.id} -> ${r.task} (${r.tstatus})`) };
    },
  });

  // 2026-11-01: seven runs whose process died held every playtest browser tab for half an hour.
  register({
    key: 'run-stuck', label: 'A run or playtest stuck with nothing moving', escalate: 'fix',
    async look(now) {
      const runs = db.prepare(`SELECT r.id, r.kind, r.started, (SELECT MAX(COALESCE(s.finished, s.started)) FROM steps s WHERE s.run = r.id) lastStep FROM runs r WHERE r.status = 'running'`).all() as any[];
      const stuck = stuckRuns(runs, now);
      if (!stuck.length) return ok;
      const P = await import('./pipeline.ts');
      for (const r of stuck) await P.stopResumedRun(r.id, `stopped by self-healing: nothing moved for ${Math.round((now - Math.max(r.started, r.lastStep ?? 0)) / HOUR)} h (its Gen jobs are cancelled; the next run plays it again)`);
      return { breach: `${stuck.length} run(s) with nothing moving`, did: `stopped ${stuck.map((r) => `${r.kind} ${r.id}`).join(', ')} and freed their playtest browsers` };
    },
  });

  // 2026-11-10: 275 of 319 live tasks went live with criteria unchecked: the daily run never started.
  register({
    key: 'daily-run', label: 'The daily run starting', escalate: 'fix',
    async look(now) {
      if ((await import('./tenancy.ts')).customerStudio()) return ok;
      const last = (db.prepare("SELECT MAX(started) at FROM runs WHERE kind = 'daily'").get() as any)?.at as number | null;
      if (last && now - last < DAILY_LATE_MS()) return ok;
      const P = await import('./pipeline.ts');
      try {
        const { id } = P.startRun('daily', {});
        return { breach: `no daily run for ${last ? Math.round((now - last) / HOUR) : 'ever'} h`, did: `started the daily run ${id}` };
      } catch (e: any) {
        return { breach: `no daily run for ${last ? Math.round((now - last) / HOUR) : 'ever'} h, and it can't start: ${String(e?.message ?? e).slice(0, 200)}` };
      }
    },
  });

  // 2026-11-10: agent jobs took the region's Cloud Run CPU quota and Gen answered 429/503 for 11 minutes.
  register({
    key: 'cloud-quota', label: 'Cloud Run refusing for its CPU quota', escalate: 'card', graceMs: 2 * HOUR,
    async look() {
      const busy = (await import('./genpace.ts')).genBusy();
      if (busy.lastHour < 20) return ok;
      const a = await A();
      const s = a.agentSettings();
      const cap = Math.max(2, Math.floor(s.maxConcurrent / 2));
      a.setSelfHealCap(cap, 30 * MIN, 'Cloud Run refused for its CPU quota');
      return { breach: `Gen answered busy ${busy.lastHour} times in the last hour (the region's CPU quota is full)`, did: `ran at most ${cap} agents for 30 minutes so Gen has room` };
    },
    card: (detail) => ({
      text: `Google Cloud's CPU quota in us-east4 keeps running out (${detail}). Studio is running fewer agents at once so Gen keeps working, but raising the quota is yours: only you can ask Google Cloud for more. Raise it?`,
      options: ['raise the quota', 'keep running fewer agents'], recommend: 'raise the quota',
    }),
  });

  // A crash (an uncaught exception stops Studio) or a run of unhandled rejections: Studio's own bug, filed with its stack.
  register({
    key: 'crashes', label: 'Studio crashing or throwing unhandled errors', escalate: 'fix', graceMs: 0,
    async look(now) {
      const L = (await import('./crashlog.ts')).crashEntries(now - 6 * HOUR);
      const crashes = L.filter((e) => e.event === 'uncaughtException');
      const rejections = L.filter((e) => e.event === 'unhandledRejection' && e.at > now - HOUR);
      if (!crashes.length && rejections.length < 5) return ok;
      return {
        breach: crashes.length ? `Studio crashed ${crashes.length} time(s) in 6 hours on an uncaught exception` : `${rejections.length} unhandled rejections in an hour`,
        evidence: [...crashes, ...rejections].slice(-6).map((e) => `${new Date(e.at).toISOString()} ${e.event}: ${String(e.error ?? '').slice(0, 600)}`),
      };
    },
  });

  // New shapes: failures that read as Studio's own machinery breaking and that no known cause explains.
  register({
    key: 'unknown-failures', label: 'Failures no known cause explains', escalate: 'fix', graceMs: 0,
    async look(now) {
      const C = await import('./causes.ts');
      const rows = db.prepare("SELECT id, task, detail FROM changes WHERE status = 'failed' AND updated > ?").all(now - 2 * HOUR) as { id: string; task: string | null; detail: string | null }[];
      const odd = rows.filter((r) => MACHINERY.test(r.detail ?? '') && !C.causeOf(r.detail));
      if (new Set(odd.map((r) => r.task ?? r.id)).size < 3) return ok;
      return { breach: `${odd.length} change(s) failed on Studio's own machinery with no known cause in 2 hours`, evidence: odd.slice(0, 15).map((r) => `${r.id}: ${String(r.detail).slice(0, 200)}`) };
    },
  });
}
