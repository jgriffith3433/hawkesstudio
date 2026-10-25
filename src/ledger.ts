// The run ledger: one row per agent pass (which role, harness, model, tier and effort, what it cost, how long it ran, how
// it ended), joined to the change it belonged to. That answers "what did this setting cost, and did it land?": cost per
// merged change, first-try merge rate, harness stops, by role, harness and model. Copilot's premium requests aren't
// billed per token, so a pass is also counted (`passes`): on Copilot the count of prompts is the spend.

import { db } from './db.ts';

db.exec(`CREATE TABLE IF NOT EXISTS pass_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  product TEXT,
  task TEXT,
  role TEXT,
  harness TEXT,
  model TEXT,
  tier TEXT,
  effort TEXT,
  retry INTEGER,
  ms INTEGER,
  cost REAL,
  outcome TEXT
)`);
// The route that chose the tier (routing.ts): its category, and J's premium ask when one set it.
for (const col of ['category', 'premium']) try { db.exec(`ALTER TABLE pass_ledger ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
db.exec('CREATE INDEX IF NOT EXISTS pass_ledger_change ON pass_ledger (change_id)');
db.exec('CREATE INDEX IF NOT EXISTS pass_ledger_at ON pass_ledger (at)');

/** stuck: the agent stopped after two approaches and said so (.hawkes/stuck.md): the next attempt climbs a tier. */
export type PassOutcome = 'done' | 'time' | 'turns' | 'cut' | 'harness-stop' | 'model-refused' | 'stuck' | 'failed';
export type PassRecord = {
  change: string; product?: string | null; task?: string | null; role: string; harness: string; model: string;
  tier: string; effort: string; retry: number; ms: number; cost: number; outcome: PassOutcome;
  category?: string | null; premium?: string | null;
};

export function recordPass(p: PassRecord, now = Date.now()) {
  db.prepare('INSERT INTO pass_ledger (at, change_id, product, task, role, harness, model, tier, effort, retry, ms, cost, outcome, category, premium) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now, p.change, p.product ?? null, p.task ?? null, p.role, p.harness, p.model, p.tier, p.effort, p.retry, Math.round(p.ms), p.cost, p.outcome, p.category ?? null, p.premium ?? null);
}

/** The ledger by route category over the last `days`: passes, tiers used, and how its changes ended. */
export function categorySummary(days = 7, now = Date.now()) {
  return db.prepare(`
    SELECT COALESCE(l.category, 'unrouted') AS category, COUNT(*) AS passes, COUNT(DISTINCT l.change_id) AS changes,
      COUNT(DISTINCT CASE WHEN c.status = 'merged' THEN l.change_id END) AS merged,
      SUM(CASE WHEN l.tier = 'fast' THEN 1 ELSE 0 END) AS fast, SUM(CASE WHEN l.tier = 'standard' THEN 1 ELSE 0 END) AS standard,
      SUM(CASE WHEN l.tier = 'deep' THEN 1 ELSE 0 END) AS deep, SUM(CASE WHEN l.tier = 'max' THEN 1 ELSE 0 END) AS max,
      ROUND(COALESCE(SUM(l.cost), 0), 2) AS cost
    FROM pass_ledger l LEFT JOIN changes c ON c.id = l.change_id
    WHERE l.at >= ? GROUP BY 1 ORDER BY passes DESC`).all(now - days * 86400_000) as any[];
}

const lastPassStmt = db.prepare('SELECT role, harness, model, tier, effort, retry FROM pass_ledger WHERE change_id = ? ORDER BY id DESC LIMIT 1');
export function lastPassFor(changeId: string): { role: string; harness: string; model: string; tier: string; effort: string; retry: number } | null {
  return (lastPassStmt.get(changeId) as any) ?? null;
}

export type LedgerRow = {
  role: string; harness: string; model: string; passes: number; changes: number; merged: number; failed: number;
  cost: number; minutes: number; harnessStops: number; costPerMerged: number | null; mergeRate: number | null;
};

/** The ledger grouped by role, harness and model over the last `days`. A change counts once per group, by its status now. */
export function ledgerSummary(days = 7, now = Date.now()): LedgerRow[] {
  const rows = db.prepare(`
    SELECT l.role, l.harness, l.model,
      COUNT(*) AS passes,
      COUNT(DISTINCT l.change_id) AS changes,
      COUNT(DISTINCT CASE WHEN c.status = 'merged' THEN l.change_id END) AS merged,
      COUNT(DISTINCT CASE WHEN c.status = 'failed' THEN l.change_id END) AS failed,
      COALESCE(SUM(l.cost), 0) AS cost,
      COALESCE(SUM(l.ms), 0) / 60000.0 AS minutes,
      SUM(CASE WHEN l.outcome IN ('harness-stop', 'model-refused') THEN 1 ELSE 0 END) AS harnessStops
    FROM pass_ledger l LEFT JOIN changes c ON c.id = l.change_id
    WHERE l.at >= ?
    GROUP BY l.role, l.harness, l.model
    ORDER BY cost DESC, passes DESC`).all(now - days * 86400_000) as any[];
  return rows.map((r) => ({
    ...r,
    cost: Math.round(r.cost * 100) / 100,
    minutes: Math.round(r.minutes * 10) / 10,
    costPerMerged: r.merged ? Math.round((r.cost / r.merged) * 100) / 100 : null,
    mergeRate: r.changes ? Math.round((r.merged / r.changes) * 100) / 100 : null,
  }));
}

/** Changes that merged on their first agent pass of the last `days`: the cleanest quality signal for a tier. */
export function firstPassMerges(days = 7, now = Date.now()) {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT l.change_id FROM pass_ledger l JOIN changes c ON c.id = l.change_id
      WHERE l.at >= ? AND c.status = 'merged' GROUP BY l.change_id HAVING COUNT(*) = 1)`).get(now - days * 86400_000) as { n: number };
  return r.n;
}

/** The ledger as Markdown, for Talk, the CLI and the dashboard. */
export function ledgerReport(days = 7): string {
  const rows = ledgerSummary(days);
  if (!rows.length) return `No agent passes recorded in the last ${days} days.`;
  const head = '| role | harness | model | passes | changes | merged | failed | cost | min | stops | $/merged | merge rate |\n|---|---|---|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r) => `| ${r.role} | ${r.harness} | ${r.model || 'default'} | ${r.passes} | ${r.changes} | ${r.merged} | ${r.failed} | $${r.cost} | ${r.minutes} | ${r.harnessStops} | ${r.costPerMerged == null ? '-' : `$${r.costPerMerged}`} | ${r.mergeRate == null ? '-' : `${Math.round(r.mergeRate * 100)}%`} |`).join('\n');
  return `# Agent ledger: the last ${days} days\n\n${head}\n${body}\n\nMerged on the first pass: ${firstPassMerges(days)}. Cost is the harness's own report (Claude Code: API-price usage, not billed on Max; Copilot: premium requests, so count the passes).`;
}
