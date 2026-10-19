// Background operations: everything slow that Studio does on its own (going live, rollbacks, merging main into beta,
// syncing repos), run off the request that asked for it, visible while it runs, and kept for a week.
//
//   The queue: enqueue() records an operation and returns at once (an Approve tap answers in milliseconds). pump() runs
//   them: one at a time per product, at most two in all. A restart puts a running one back in the queue; its handler
//   is idempotent (going live again is a no-op once main is the beta commit), and after 3 attempts it fails instead.
//   Visibility: each operation has a current step and its last log lines; every git or shell command Studio is running
//   right now is listed (commands); the event-loop monitor records any moment Studio couldn't answer for over a
//   second, and what was running then. GET /api/ops, the Activity drawer, Talk's studio_ops.

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { db, newId, J, parse } from './db.ts';
import { startProfiler, captureBlock, describe, profiling, type BlockCause } from './loopprof.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS ops (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, product TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
    step TEXT, log TEXT, payload TEXT, result TEXT, error TEXT, by TEXT, origin TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, started INTEGER, finished INTEGER, heartbeat INTEGER
  );
  CREATE INDEX IF NOT EXISTS ops_status ON ops(status, created);
`);

export type OpStatus = 'queued' | 'running' | 'done' | 'failed';
export type Op = {
  id: string; kind: string; product: string | null; title: string; status: OpStatus; step: string | null; log: string[];
  payload: any; result: any; error: string | null; by: string | null; origin: string | null; attempts: number;
  created: number; started: number | null; finished: number | null; heartbeat: number | null; seconds: number | null; stuck?: boolean;
};

const MAX_RUNNING = Number(process.env.STUDIO_OPS_PARALLEL) || 2;
const MAX_ATTEMPTS = 3;
/** How long an operation may run before it shows as stuck (going live with a Unity build push can take minutes). */
const STUCK_MS: Record<string, number> = { golive: 20 * 60_000, rollback: 15 * 60_000, 'merge-main': 15 * 60_000, sync: 15 * 60_000 };

function toOp(r: any): Op {
  const now = Date.now();
  const seconds = r.started ? Math.round(((r.finished ?? now) - r.started) / 1000) : null;
  return {
    ...r, log: parse(r.log) ?? [], payload: parse(r.payload), result: parse(r.result), seconds,
    stuck: r.status === 'running' && r.started && now - r.started > (STUCK_MS[r.kind] ?? 20 * 60_000) ? true : undefined,
  };
}

export const getOp = (id: string) => {
  const r = db.prepare('SELECT * FROM ops WHERE id = ?').get(id);
  return r ? toOp(r) : null;
};

/** Running and queued operations, then the recent finished ones (newest first). */
export function listOps({ product, since = Date.now() - 7 * 86_400_000, limit = 100 }: { product?: string; since?: number; limit?: number } = {}) {
  const rows = db.prepare(`SELECT * FROM ops WHERE (status IN ('queued', 'running') OR created > ?) ${product ? 'AND product = ?' : ''} ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, created DESC LIMIT ?`)
    .all(...(product ? [since, product, limit] : [since, limit])) as any[];
  return rows.map(toOp);
}

// ------------------------------------------------------------- handlers and the queue

type Ctx = { op: Op; step: (s: string) => void; log: (s: string) => void };
type Handler = (payload: any, ctx: Ctx) => Promise<any>;
const handlers = new Map<string, Handler>();
/** What each kind of operation does; done/failed hooks (e.g. an approval card hears the result). */
const hooks = new Map<string, { done?: (op: Op) => void | Promise<void>; failed?: (op: Op) => void | Promise<void> }>();

export function registerOp(kind: string, run: Handler, h: { done?: (op: Op) => void | Promise<void>; failed?: (op: Op) => void | Promise<void> } = {}) {
  handlers.set(kind, run);
  hooks.set(kind, h);
}

/** Queues an operation and returns it at once. A queued or running one of the same kind for the same product is reused. */
export function enqueue(kind: string, { product = null, title, payload = {}, by = null, origin = null }: { product?: string | null; title: string; payload?: any; by?: string | null; origin?: string | null }) {
  const same = db.prepare(`SELECT * FROM ops WHERE kind = ? AND product IS ? AND status IN ('queued', 'running') AND payload = ?`).get(kind, product, J(payload)) as any;
  if (same) return toOp(same);
  const id = newId('op');
  db.prepare('INSERT INTO ops (id, kind, product, title, status, payload, by, origin, created, log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, product, title, 'queued', J(payload), by, origin, Date.now(), J([]));
  setImmediate(() => void pump());
  return getOp(id)!;
}

/** Where this operation stands in the queue (0: running now). */
export function queuePosition(id: string) {
  const op = getOp(id);
  if (!op || op.status !== 'queued') return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM ops WHERE status = 'queued' AND created <= ?`).get(op.created) as any).n as number;
}

const store = new AsyncLocalStorage<{ id: string }>();
/** The operation the calling code runs inside (git and shell commands log to it). */
export const currentOp = () => store.getStore()?.id ?? null;

function append(id: string, line: string) {
  const r = db.prepare('SELECT log FROM ops WHERE id = ?').get(id) as any;
  if (!r) return;
  const log = [...((parse(r.log) as string[]) ?? []), `${new Date().toISOString().slice(11, 19)} ${line}`].slice(-60);
  db.prepare('UPDATE ops SET log = ?, heartbeat = ? WHERE id = ?').run(J(log), Date.now(), id);
}

/** A line in the current operation's log (no-op outside one). */
export function opLog(line: string) {
  const id = currentOp();
  if (id) append(id, line.slice(0, 400));
}

let pumping = false;
/** Starts queued operations: one per product at a time, MAX_RUNNING in all. */
export async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const running = db.prepare(`SELECT product FROM ops WHERE status = 'running'`).all() as any[];
      if (running.length >= MAX_RUNNING) return;
      const busy = new Set(running.map((r) => r.product).filter(Boolean));
      const next = (db.prepare(`SELECT * FROM ops WHERE status = 'queued' ORDER BY created`).all() as any[]).find((r) => !r.product || !busy.has(r.product));
      if (!next) return;
      const claimed = db.prepare(`UPDATE ops SET status = 'running', started = COALESCE(started, ?), heartbeat = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'`).run(Date.now(), Date.now(), next.id);
      if (!claimed.changes) continue;
      void runOp(next.id);
    }
  } finally {
    pumping = false;
  }
}

async function runOp(id: string) {
  const op = getOp(id)!;
  const run = handlers.get(op.kind);
  const ctx: Ctx = {
    op,
    step: (s) => {
      db.prepare('UPDATE ops SET step = ?, heartbeat = ? WHERE id = ?').run(s.slice(0, 300), Date.now(), id);
      append(id, `· ${s}`);
    },
    log: (s) => append(id, s.slice(0, 400)),
  };
  try {
    if (!run) throw new Error(`no handler for ${op.kind} operations (an older or newer Studio queued it)`);
    if (op.attempts > 1) ctx.log(`attempt ${op.attempts} (Studio restarted while it ran; it picks up where it is)`);
    const result = await store.run({ id }, () => run(op.payload, ctx));
    db.prepare(`UPDATE ops SET status = 'done', result = ?, finished = ?, step = 'done' WHERE id = ?`).run(J(result ?? null), Date.now(), id);
    await hooks.get(op.kind)?.done?.(getOp(id)!);
  } catch (e: any) {
    db.prepare(`UPDATE ops SET status = 'failed', error = ?, finished = ? WHERE id = ?`).run(String(e?.message ?? e).slice(0, 2000), Date.now(), id);
    append(id, `failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
    await Promise.resolve(hooks.get(op.kind)?.failed?.(getOp(id)!)).catch(() => {});
  } finally {
    setImmediate(() => void pump());
  }
}

/** The gap between agent changes and runs resumed after a restart (agents.ts, pipeline.ts). STUDIO_RESUME_GAP_MS: tests. */
export const resumeGapMs = () => process.env.STUDIO_RESUME_GAP_MS !== undefined && Number(process.env.STUDIO_RESUME_GAP_MS) >= 0 ? Number(process.env.STUDIO_RESUME_GAP_MS) : 2000;

/** After a restart: running operations go back in the queue (handlers are idempotent), up to MAX_ATTEMPTS. */
export function resumeOps() {
  const rows = db.prepare(`SELECT id, attempts FROM ops WHERE status = 'running'`).all() as any[];
  for (const r of rows) {
    if (r.attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE ops SET status = 'failed', error = ?, finished = ? WHERE id = ?`).run(`Studio restarted ${r.attempts} times while it ran; stopped trying. Look at its log, then start it again.`, Date.now(), r.id);
      const op = getOp(r.id)!;
      void Promise.resolve(hooks.get(op.kind)?.failed?.(op)).catch(() => {});
    } else {
      db.prepare(`UPDATE ops SET status = 'queued' WHERE id = ?`).run(r.id);
    }
  }
  db.prepare('DELETE FROM ops WHERE finished < ?').run(Date.now() - 7 * 86_400_000);
  setTimeout(() => void pump(), 2000).unref();
  return rows.length;
}

// ------------------------------------------------------------- commands running now

type Cmd = { id: number; cmd: string; cwd: string; started: number; op: string | null };
const commands = new Map<number, Cmd>();
let cmdSeq = 0;

/** Records a child process Studio is waiting on (git, npm, a build); returns the function that ends the record. */
export function trackCommand(cmd: string, cwd: string) {
  const id = ++cmdSeq;
  commands.set(id, { id, cmd: cmd.slice(0, 200), cwd, started: Date.now(), op: currentOp() });
  return () => void commands.delete(id);
}

/**
 * A command (not git: beta.ts gitAsync) without blocking Studio: listed while it runs, timed out, output kept (capped).
 * What spawnSync did for cp, chgrp, node --check and the like.
 */
export function runCommand(file: string, args: string[], { cwd = process.cwd(), timeoutMs = 10 * 60_000, env }: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; code: number | null; out: string; err: string }> {
  const done = trackCommand(`${file} ${args.join(' ')}`, cwd);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
      resolve({ ok: code === 0, code, out: out.trim(), err: (err + extra).trim() });
    };
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    child.stdout.on('data', (d) => { if (out.length < 4_000_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 200_000) err += d; });
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null, `\ntimed out after ${Math.round(timeoutMs / 1000)} s`); }, timeoutMs);
    timer.unref();
  });
}

export const runningCommands = () => [...commands.values()].map((c) => ({ ...c, seconds: Math.round((Date.now() - c.started) / 1000), slow: Date.now() - c.started > 5 * 60_000 }));

// ------------------------------------------------------------- the event loop

const BLOCK_MS = 1000;
/** A block: when, how long, what tracked work was running, and (the profiler on) the code it was in. */
type Block = { at: number; ms: number; running: string[]; where?: string; cause?: BlockCause };
const blocks: Block[] = [];
let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let lastTick = 0;

/**
 * Watches for moments Studio can't answer (a synchronous call holding the event loop): logged and kept (last 50), each
 * with the code it was in (loopprof.ts: a rolling CPU profile, kept in .data/profiles/ when a block lands in it).
 */
export function startLoopMonitor() {
  if (histogram) return;
  void startProfiler();
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const late = now - lastTick - 500;
    lastTick = now;
    if (late < BLOCK_MS) return;
    const running = [...runningCommands().map((c) => `${c.cmd} (${c.seconds}s)`), ...listOps({ since: now }).filter((o) => o.status === 'running').map((o) => `${o.title}: ${o.step ?? ''}`)];
    const block: Block = { at: now, ms: late, running };
    blocks.push(block);
    if (blocks.length > 50) blocks.shift();
    const warn = () => console.warn(`[studio] the event loop was blocked for ${late} ms${block.where ? ` ${block.where}` : ''}${running.length ? ` (running: ${running.join('; ').slice(0, 300)})` : ''}${block.cause?.profile ? ` [profile ${block.cause.profile}]` : ''}`);
    if (!profiling()) return warn();
    void captureBlock(late).then((cause) => {
      if (cause) Object.assign(block, { cause, where: describe(cause) });
    }).catch(() => {}).finally(warn);
  }, 500).unref();
  // Percentiles per minute: the last full minute is what health shows.
  setInterval(() => {
    const h = histogram!;
    lastMinute = { p50ms: Math.round(h.percentile(50) / 1e6), p99ms: Math.round(h.percentile(99) / 1e6), maxms: Math.round(h.max / 1e6) };
    h.reset();
  }, 60_000).unref();
}
let lastMinute: { p50ms: number; p99ms: number; maxms: number } | null = null;

/** The event loop's health: delay percentiles over the last minute, and the recent blocks. */
export function loopHealth() {
  return { lastMinute, blocks: blocks.slice(-10).reverse(), blocksLastHour: blocks.filter((b) => b.at > Date.now() - 3600_000).length };
}
