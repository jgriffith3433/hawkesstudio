// What playtests are worth and what they cost (J, 2026-10-25: "look hard at what playtests are worth and what they
// cost, across ALL products"). Per scenario and per kind of run, over the last N days: how often it was played, the
// minutes it took, how it ended, how many of its reviews found nothing new, the findings it filed (and how many of those
// were real: fixed or still open, not "won't fix"), and when it last caught anything. `GET /api/playtests/audit`, the
// notes in docs/playtest-audit.md. Pure over rows (`auditRows`), so it is tested without a database.

import { db, parse } from './db.ts';

type RunRow = { id: string; kind: string; status: string; started: number };
type StepRow = { run: string; product: string; kind: string; name: string; status: string; detail: string | null; data: any; started: number; finished: number | null };
type FindingRow = { product: string; scenario: string | null; severity: string; status: string; first_seen: number; source: string | null };

export type AuditLine = {
  key: string; plays: number; minutes: number; ok: number; error: number; stuck: number; failed: number; skipped: number;
  reviews: number; nothingNew: number; newFindings: number; lastNew: number | null;
  filed: number; real: number; fixed: number; lastFiled: number | null;
  byKind: Record<string, number>;
};
export type KindLine = { kind: string; runs: number; plays: number; minutes: number; reviews: number; nothingNew: number; newFindings: number; longest: number; superseded: number };

const blank = (key: string): AuditLine => ({ key, plays: 0, minutes: 0, ok: 0, error: 0, stuck: 0, failed: 0, skipped: 0, reviews: 0, nothingNew: 0, newFindings: 0, lastNew: null, filed: 0, real: 0, fixed: 0, lastFiled: null, byKind: {} });

/** The new findings a review step reports ("ship · verify · 0 findings (0 new, 1 known still there)"). */
export const newIn = (detail: string | null | undefined, data: any): number => {
  const m = /(\d+) new/.exec(detail ?? '');
  if (m) return Number(m[1]);
  return Array.isArray(data?.findings) ? data.findings.length : 0;
};

export function auditRows(runs: RunRow[], steps: StepRow[], findings: FindingRow[], since: number) {
  const kindOf = new Map(runs.map((r) => [r.id, r]));
  const lines = new Map<string, AuditLine>();
  const kinds = new Map<string, KindLine & { perRun: Map<string, number> }>();
  const line = (k: string) => lines.get(k) ?? (lines.set(k, blank(k)), lines.get(k)!);
  const kindLine = (k: string) => kinds.get(k) ?? (kinds.set(k, { kind: k, runs: 0, plays: 0, minutes: 0, reviews: 0, nothingNew: 0, newFindings: 0, longest: 0, superseded: 0, perRun: new Map() }), kinds.get(k)!);
  for (const r of runs) {
    if (r.started < since) continue;
    const k = kindLine(r.kind);
    k.runs++;
    if (r.status === 'skipped') k.superseded++;
  }
  const reviews = new Map<string, StepRow>();
  for (const s of steps) if (s.kind === 'review' && s.status === 'done') reviews.set(`${s.run}|${s.product}|${s.name}`, s);
  for (const s of steps) {
    const run = kindOf.get(s.run);
    if (s.kind !== 'playtest' || !run || s.started < since) continue;
    const key = `${s.product}/${s.name}`;
    const l = line(key);
    if (s.status === 'skipped') { l.skipped++; continue; }
    const minutes = ((s.finished ?? s.started) - s.started) / 60000;
    const k = kindLine(run.kind);
    l.plays++; l.minutes += minutes; l.byKind[run.kind] = (l.byKind[run.kind] ?? 0) + 1;
    k.plays++; k.minutes += minutes;
    k.perRun.set(s.run, (k.perRun.get(s.run) ?? 0) + 1);
    const outcome = parse(s.data)?.outcome ?? s.data?.outcome;
    if (s.status === 'failed') l.failed++;
    else if (outcome === 'error') l.error++;
    else if (outcome === 'stuck') l.stuck++;
    else l.ok++;
    const rv = reviews.get(`${s.run}|${s.product}|${s.name}`);
    if (rv) {
      const n = newIn(rv.detail, rv.data);
      l.reviews++; k.reviews++;
      if (n) { l.newFindings += n; k.newFindings += n; l.lastNew = Math.max(l.lastNew ?? 0, s.started); } else { l.nothingNew++; k.nothingNew++; }
    }
  }
  for (const f of findings) {
    if (f.first_seen < since || !f.scenario || f.source === 'J') continue;
    const l = line(`${f.product}/${f.scenario}`);
    l.filed++;
    if (f.status === 'fixed' || f.status === 'open') l.real++;
    if (f.status === 'fixed') l.fixed++;
    l.lastFiled = Math.max(l.lastFiled ?? 0, f.first_seen);
  }
  return {
    scenarios: [...lines.values()].sort((a, b) => b.minutes - a.minutes),
    kinds: [...kinds.values()].map(({ perRun, ...k }) => ({ ...k, longest: Math.max(0, ...perRun.values()) })).sort((a, b) => b.minutes - a.minutes),
  };
}

/** From Studio's database: the last `days` days. */
export function playAudit(days = 30) {
  const since = Date.now() - days * 86400_000;
  const runs = db.prepare('SELECT id, kind, status, started FROM runs WHERE started > ?').all(since) as RunRow[];
  const steps = db.prepare(`SELECT run, product, kind, name, status, detail, data, started, finished FROM steps WHERE started > ? AND kind IN ('playtest', 'review')`).all(since) as StepRow[];
  const findings = db.prepare('SELECT product, scenario, severity, status, first_seen, source FROM findings WHERE first_seen > ?').all(since) as FindingRow[];
  return { days, ...auditRows(runs, steps, findings, since) };
}
