// The backlog: findings from playtest reviews, merged across days. A finding seen again updates the existing
// one (seen count, last seen, latest screenshots) instead of piling up.

import { db, newId, J, parse } from './db.ts';

export type Finding = {
  id: string; product: string; key: string; title: string; severity: string; area: string | null; detail: string | null;
  fix: string | null; status: string; scenario: string | null; shots: string[]; first_seen: number; last_seen: number;
  seen: number; last_run: string | null; note: string | null; updated: number | null;
};

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'on', 'in', 'of', 'to', 'and', 'or', 'at', 'for', 'with', 'from', 'not', 'no', 'it', 'its', 'by', 'be', 'as', 'this', 'that']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
export const keyOf = (title: string) => words(title).sort().join(' ');

function similar(a: string, b: string) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

const toFinding = (r: any): Finding => ({ ...r, shots: parse(r.shots) ?? [] });

/** Adds a review's findings to the backlog. Returns which were new. */
export function absorb(product: string, run: string, scenario: string, findings: any[]) {
  const now = Date.now();
  const open = (db.prepare(`SELECT * FROM findings WHERE product = ? AND status IN ('open', 'fixing')`).all(product) as any[]).map(toFinding);
  const added: string[] = [];
  const updated: string[] = [];
  for (const f of findings) {
    if (!f?.title) continue;
    const key = keyOf(f.title);
    const match = open.find((o) => o.key === key) ?? open.filter((o) => similar(o.title, f.title) >= 0.55).sort((a, b) => similar(b.title, f.title) - similar(a.title, f.title))[0];
    if (match) {
      // Seen again (counted once per run, however many scenarios hit it).
      db.prepare(`UPDATE findings SET seen = seen + (CASE WHEN last_run = ? THEN 0 ELSE 1 END), last_seen = ?, last_run = ?, shots = ?, severity = ?, detail = ?, fix = ?, scenario = ? WHERE id = ?`)
        .run(run, now, run, J([...(f.shots ?? []), ...match.shots].slice(0, 6)), worse(match.severity, f.severity), f.detail ?? match.detail, f.fix ?? match.fix, scenario, match.id);
      updated.push(match.id);
    } else {
      const id = newId('f');
      db.prepare(`INSERT INTO findings (id, product, key, title, severity, area, detail, fix, status, scenario, shots, first_seen, last_seen, seen, last_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 1, ?)`)
        .run(id, product, key, f.title, f.severity ?? 'bug', f.area ?? null, f.detail ?? null, f.fix ?? null, scenario, J((f.shots ?? []).slice(0, 6)), now, now, run);
      open.push(toFinding(db.prepare('SELECT * FROM findings WHERE id = ?').get(id)));
      added.push(id);
    }
  }
  return { added, updated };
}

const RANK: Record<string, number> = { blocker: 4, bug: 3, polish: 2, idea: 1 };
const worse = (a: string, b: string) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

export function listFindings(q: { product?: string; status?: string; severity?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: any[] = [];
  if (q.product) { where.push('product = ?'); args.push(q.product); }
  if (q.status) { where.push(`status IN (${q.status.split(',').map(() => '?').join(',')})`); args.push(...q.status.split(',')); }
  if (q.severity) { where.push(`severity IN (${q.severity.split(',').map(() => '?').join(',')})`); args.push(...q.severity.split(',')); }
  const rows = db.prepare(`SELECT * FROM findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'bug' THEN 1 WHEN 'polish' THEN 2 ELSE 3 END, seen DESC, last_seen DESC LIMIT ?`).all(...args, q.limit ?? 500) as any[];
  return rows.map(toFinding);
}

export function getFinding(id: string) {
  const r = db.prepare('SELECT * FROM findings WHERE id = ?').get(id);
  return r ? toFinding(r) : null;
}

/** status: open | fixing (an agent is on it) | fixed | wontfix. */
export function updateFinding(id: string, patch: { status?: string; note?: string; severity?: string }) {
  const f = getFinding(id);
  if (!f) throw new Error(`No finding ${id}`);
  const status = patch.status ?? f.status;
  if (!['open', 'fixing', 'fixed', 'wontfix'].includes(status)) throw new Error(`status must be open, fixing, fixed or wontfix`);
  db.prepare('UPDATE findings SET status = ?, note = ?, severity = ?, updated = ? WHERE id = ?').run(status, patch.note ?? f.note, patch.severity ?? f.severity, Date.now(), id);
  return getFinding(id)!;
}

/** Open findings a run looked for (same product and scenario) but didn't see again: probably fixed. */
export function notSeenIn(run: string, product: string, scenarios: string[]) {
  if (!scenarios.length) return [];
  return listFindings({ product, status: 'open' }).filter((f) => f.last_run !== run && f.scenario && scenarios.includes(f.scenario));
}
