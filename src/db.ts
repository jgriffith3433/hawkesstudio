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
