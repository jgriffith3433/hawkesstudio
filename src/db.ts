// SQLite (node:sqlite): runs, their steps, and the backlog of findings.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { paths } from './config.ts';

export const db = new DatabaseSync(paths.db);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
    products TEXT, options TEXT, started INTEGER NOT NULL, finished INTEGER, cost REAL DEFAULT 0, report TEXT
  );
  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY, run TEXT NOT NULL, product TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL, detail TEXT, job TEXT, data TEXT, started INTEGER NOT NULL, finished INTEGER, cost REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS steps_run ON steps(run);
  CREATE INDEX IF NOT EXISTS steps_product ON steps(product, kind, name);
  -- Runs are looked up by kind and status on every PM pass and page (the running beta run of a product, the beta run after
  -- a merge): without these each look read the whole table, thousands of rows, and Studio froze (2026-11-14).
  CREATE INDEX IF NOT EXISTS runs_kind_status ON runs(kind, status, started);
  CREATE INDEX IF NOT EXISTS runs_kind_started ON runs(kind, started);
  CREATE INDEX IF NOT EXISTS runs_status ON runs(status, started);
  CREATE INDEX IF NOT EXISTS runs_started ON runs(started);
  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, severity TEXT NOT NULL,
    area TEXT, detail TEXT, fix TEXT, status TEXT NOT NULL DEFAULT 'open', scenario TEXT, shots TEXT,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 1, last_run TEXT, note TEXT, updated INTEGER
  );
  CREATE INDEX IF NOT EXISTS findings_product ON findings(product, status);
`);

// Writes, reported (J, 2026-11-02: no polling): every insert/update/delete statement that ran tells the listeners which
// table it wrote, so the push stream (stream.ts) learns that something moved without looking at the database on a timer.
// Tables that change all the time without anything a page shows are left out.
const NOISY = new Set(['resource_samples', 'access_log', 'signin_log', 'sessions', 'migrations', 'llm_fallbacks', 'pace_state', 'pace_days', 'gen_charges', 'cancellations', 'run_plan', 'waits']);
const writeListeners = new Set<(table: string) => void>();
/** fn(table) after a statement wrote a table (not the noisy ones). Returns stop(). */
export function onDbWrite(fn: (table: string) => void) {
  writeListeners.add(fn);
  return () => void writeListeners.delete(fn);
}
const WRITE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([a-z_][a-z0-9_]*)/i;
const prepare = db.prepare.bind(db);
// Prepared statements, kept (2026-11-10): Studio's ~1000 db.prepare(sql) calls each compiled their SQL again on every
// call, and a PM pass over a few hundred tasks spent 400-1100 ms of a 1.5-3.6 s event-loop freeze in SQLite's prepare
// alone. A statement is compiled once per SQL text and reused (node:sqlite statements reset on each run/get/all, and
// SQLite recompiles one by itself after a schema change). The least recently used go once there are more than
// STMT_CACHE_MAX (SQL built with a varying IN list makes new texts).
export const STMT_CACHE_MAX = 2000;
const statements = new Map<string, ReturnType<typeof prepare>>();
/** How many SQL compiles the cache saved and paid (tests, studio_ops). */
export const stmtStats = { hits: 0, compiles: 0 };
function compile(sql: string) {
  const st = prepare(sql);
  stmtStats.compiles++;
  const table = WRITE.exec(sql)?.[1]?.toLowerCase();
  if (!table || NOISY.has(table)) return st;
  const run = st.run.bind(st);
  st.run = ((...args: any[]) => {
    const r = (run as any)(...args);
    for (const fn of writeListeners) try { fn(table); } catch { /* a listener never breaks a write */ }
    return r;
  }) as typeof st.run;
  return st;
}
(db as any).prepare = (sql: string) => {
  const known = statements.get(sql);
  if (known) {
    stmtStats.hits++;
    // Most recently used last (Map keeps insertion order).
    statements.delete(sql);
    statements.set(sql, known);
    return known;
  }
  const st = compile(sql);
  statements.set(sql, st);
  if (statements.size > STMT_CACHE_MAX) statements.delete(statements.keys().next().value!);
  return st;
};

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export const J = (v: unknown) => JSON.stringify(v ?? null);
export const parse = (s: unknown) => {
  if (typeof s !== 'string') return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export type Step = {
  id: string; run: string; product: string; kind: string; name: string; status: string; detail: string | null;
  job: string | null; data: any; started: number; finished: number | null; cost: number;
};

export function rowToStep(r: any): Step {
  return { ...r, data: parse(r.data) };
}
