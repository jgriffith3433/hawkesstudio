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
const NOISY = new Set(['resource_samples', 'access_log', 'signin_log', 'sessions', 'migrations', 'llm_fallbacks', 'pace_state', 'pace_days', 'gen_charges', 'cancellations', 'run_plan']);
const writeListeners = new Set<(table: string) => void>();
/** fn(table) after a statement wrote a table (not the noisy ones). Returns stop(). */
export function onDbWrite(fn: (table: string) => void) {
  writeListeners.add(fn);
  return () => void writeListeners.delete(fn);
}
const WRITE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?([a-z_][a-z0-9_]*)/i;
const prepare = db.prepare.bind(db);
(db as any).prepare = (sql: string) => {
  const st = prepare(sql);
  const table = WRITE.exec(sql)?.[1]?.toLowerCase();
  if (!table || NOISY.has(table)) return st;
  const run = st.run.bind(st);
  st.run = ((...args: any[]) => {
    const r = (run as any)(...args);
    for (const fn of writeListeners) try { fn(table); } catch { /* a listener never breaks a write */ }
    return r;
  }) as typeof st.run;
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
