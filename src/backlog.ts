// The backlog: findings from playtest reviews, merged across days. A finding seen again updates the existing
// one (seen count, last seen, latest screenshots) instead of piling up. Blockers and bugs are the backlog; polish and
// ideas are the ideas list (status idea), never auto-fixed and expired after 14 days unseen. Reviews are told what's
// known (knownFindings) and report only new problems, saying which known ones look fixed or are still there (applyKnown).

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

/** The best match for a title among findings (same key first, then the most similar at 55% or more). */
const bestMatch = (list: Finding[], title: string) => {
  const key = keyOf(title);
  return list.find((o) => o.key === key) ?? list.filter((o) => similar(o.title, title) >= 0.55).sort((a, b) => similar(b.title, title) - similar(a.title, title))[0];
};

/** Review modes (Hawkes Gen's playtest.review): full = the daily review; verify and regression take only regressions and blockers. */
export type ReviewMode = 'full' | 'verify' | 'regression';
const isIdea = (severity: string) => severity === 'polish' || severity === 'idea';
/** Ideas (polish and ideas) not seen for this long expire. */
export const IDEA_DAYS = 14;

/**
 * Adds a review's findings to the backlog. Returns which were new. Blockers and bugs go to the backlog (open); polish
 * and ideas go to the ideas list (status idea: never auto-fixed, expired after IDEA_DAYS unseen). Outside a full review
 * only regressions and blockers are taken. A finding J marked won't-fix stays won't-fix when a review reports it again
 * (its seen count and screenshots still update, so it's visible that it keeps happening); only a report of it as a
 * blocker reopens it. One that was fixed and is reported again comes back.
 */
export function absorb(product: string, run: string, scenario: string, findings: any[], { mode = 'full' as ReviewMode } = {}) {
  const now = Date.now();
  const pool = (statuses: string) => (db.prepare(`SELECT * FROM findings WHERE product = ? AND status IN (${statuses})`).all(product) as any[]).map(toFinding);
  const open = pool(`'open', 'fixing'`);
  const wontfix = pool(`'wontfix'`);
  const ideas = pool(`'idea', 'expired'`);
  const fixed = pool(`'fixed'`);
  const added: string[] = [];
  const updated: string[] = [];
  const ideasAdded: string[] = [];
  let skipped = 0;
  for (const f of findings) {
    if (!f?.title) continue;
    if (mode !== 'full' && f.severity !== 'blocker' && f.regression !== true) { skipped++; continue; }
    const key = keyOf(f.title);
    const live = bestMatch(open, f.title);
    const dropped = live ? null : bestMatch(wontfix, f.title);
    const idea = live || dropped ? null : bestMatch(ideas, f.title);
    const back = live || dropped || idea ? null : bestMatch(fixed, f.title);
    const match = live ?? dropped ?? idea ?? back;
    if (match) {
      // Seen again (counted once per run, however many scenarios hit it).
      const severity = worse(match.severity, f.severity);
      db.prepare(`UPDATE findings SET seen = seen + (CASE WHEN last_run = ? THEN 0 ELSE 1 END), last_seen = ?, last_run = ?, shots = ?, severity = ?, detail = ?, fix = ?, scenario = ? WHERE id = ?`)
        .run(run, now, run, J([...(f.shots ?? []), ...match.shots].slice(0, 6)), severity, f.detail ?? match.detail, f.fix ?? match.fix, scenario, match.id);
      const day = new Date(now).toISOString().slice(0, 10);
      let status: string | null = null;
      let note = '';
      if (dropped && f.severity === 'blocker') [status, note] = ['open', `Reopened ${day}: reported again as a blocker (it was won't-fix).`];
      else if (idea && !isIdea(severity)) [status, note] = ['open', `Moved to the backlog ${day}: reported as a ${severity}.`];
      else if (idea && match.status === 'expired') [status, note] = ['idea', `Back on the ideas list ${day}: seen again.`];
      else if (back) [status, note] = [isIdea(severity) ? 'idea' : 'open', `Came back ${day}: it was fixed, and a review of ${scenario} saw it again.`];
      if (status) {
        db.prepare(`UPDATE findings SET status = ?, note = ?, updated = ? WHERE id = ?`).run(status, note, now, match.id);
        const row = toFinding(db.prepare('SELECT * FROM findings WHERE id = ?').get(match.id));
        for (const list of [open, wontfix, ideas, fixed]) if (list.includes(match)) list.splice(list.indexOf(match), 1);
        (status === 'open' ? open : ideas).push(row);
      }
      updated.push(match.id);
    } else {
      const id = newId('f');
      const status = isIdea(f.severity ?? 'bug') ? 'idea' : 'open';
      db.prepare(`INSERT INTO findings (id, product, key, title, severity, area, detail, fix, status, scenario, shots, first_seen, last_seen, seen, last_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(id, product, key, f.title, f.severity ?? 'bug', f.area ?? null, f.detail ?? null, f.fix ?? null, status, scenario, J((f.shots ?? []).slice(0, 6)), now, now, run);
      (status === 'open' ? open : ideas).push(toFinding(db.prepare('SELECT * FROM findings WHERE id = ?').get(id)));
      (status === 'open' ? added : ideasAdded).push(id);
    }
  }
  return { added, updated, ideas: ideasAdded, skipped };
}

/**
 * What a review is told is already known for a product (so it reports only new problems): the backlog (open, fixing),
 * the ideas list and won't-fix, worst and most seen first.
 */
export function knownFindings(product: string, limit = 150) {
  return (db.prepare(`SELECT id, title, severity, status FROM findings WHERE product = ? AND status IN ('open', 'fixing', 'idea', 'wontfix')
    ORDER BY CASE status WHEN 'fixing' THEN 0 WHEN 'open' THEN 0 WHEN 'idea' THEN 1 ELSE 2 END,
      CASE severity WHEN 'blocker' THEN 0 WHEN 'bug' THEN 1 WHEN 'polish' THEN 2 ELSE 3 END, seen DESC, last_seen DESC LIMIT ?`).all(product, limit) as any[])
    .map((r) => ({ id: r.id as string, title: r.title as string, severity: r.severity as string, status: r.status as string }));
}

/**
 * A review's word on known findings (by id): "present" counts as seen again; "fixed" marks an open finding or idea of
 * the same scenario fixed (with a note; one that comes back reopens). A finding an agent is fixing, one from another
 * scenario, or a won't-fix only gets the note.
 */
export function applyKnown(product: string, run: string, scenario: string, known: { id: string; status: string; note?: string }[]) {
  const now = Date.now();
  const fixed: string[] = [];
  const present: string[] = [];
  for (const k of known ?? []) {
    const f = getFinding(k.id);
    if (!f || f.product !== product) continue;
    const why = `${String(k.note ?? '').slice(0, 300)} (review of ${scenario}, ${run}, ${new Date(now).toISOString().slice(0, 10)})`;
    if (k.status === 'present') {
      db.prepare(`UPDATE findings SET seen = seen + (CASE WHEN last_run = ? THEN 0 ELSE 1 END), last_seen = ?, last_run = ?, status = CASE status WHEN 'expired' THEN 'idea' ELSE status END WHERE id = ?`).run(run, now, run, f.id);
      present.push(f.id);
    } else if (k.status === 'fixed') {
      if (['open', 'idea'].includes(f.status) && (!f.scenario || f.scenario === scenario)) {
        db.prepare(`UPDATE findings SET status = 'fixed', note = ?, updated = ? WHERE id = ?`).run(`Looks fixed: ${why}`, now, f.id);
        fixed.push(f.id);
      } else if (f.status !== 'fixed') {
        db.prepare(`UPDATE findings SET note = ? WHERE id = ?`).run(`${f.note ? `${f.note} · ` : ''}Looked fixed: ${why}`.slice(-1500), f.id);
      }
    }
  }
  return { fixed, present };
}

/** Ideas not seen for IDEA_DAYS expire (status expired: kept, out of the list). Studio runs it at startup and after each run. */
export function expireIdeas(days = IDEA_DAYS) {
  const cutoff = Date.now() - days * 86_400_000;
  return Number(db.prepare(`UPDATE findings SET status = 'expired', note = ?, updated = ? WHERE status = 'idea' AND last_seen < ?`)
    .run(`Expired: not seen for ${days} days.`, Date.now(), cutoff).changes);
}

/**
 * Once: open polish and ideas from before the ideas list existed move to it (none are deleted; findings an agent is
 * fixing stay). Idempotent (a migrations row records it), so findings J later moves back to the backlog stay there.
 */
export function moveOldPolishToIdeas() {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  if (db.prepare(`SELECT id FROM migrations WHERE id = 'ideas-list'`).get()) return 0;
  const n = Number(db.prepare(`UPDATE findings SET status = 'idea', note = COALESCE(note || ' · ', '') || 'Moved to the ideas list (polish and ideas are not auto-fixed).', updated = ? WHERE status = 'open' AND severity IN ('polish', 'idea')`).run(Date.now()).changes);
  db.prepare(`INSERT INTO migrations (id, at) VALUES ('ideas-list', ?)`).run(Date.now());
  return n;
}

/**
 * Repair: open findings created after J marked a matching finding won't-fix (before absorb knew to match those) are
 * folded into it: marked won't-fix with a note, and the won't-fix one's seen count goes up. Blockers are left open.
 * Idempotent; Studio runs it at startup.
 */
export function foldIntoWontfix() {
  const products = (db.prepare(`SELECT DISTINCT product FROM findings WHERE status = 'wontfix'`).all() as any[]).map((r) => r.product as string);
  let folded = 0;
  for (const product of products) {
    const wontfix = (db.prepare(`SELECT * FROM findings WHERE product = ? AND status = 'wontfix'`).all(product) as any[]).map(toFinding);
    const open = (db.prepare(`SELECT * FROM findings WHERE product = ? AND status = 'open' AND severity != 'blocker'`).all(product) as any[]).map(toFinding);
    for (const o of open) {
      const w = bestMatch(wontfix, o.title);
      if (!w || o.first_seen <= (w.updated ?? 0)) continue;
      db.prepare(`UPDATE findings SET status = 'wontfix', note = ?, updated = ? WHERE id = ?`).run(`Same as ${w.id} (won't fix): reported again after it was marked won't-fix.`, Date.now(), o.id);
      db.prepare(`UPDATE findings SET seen = seen + ?, last_seen = MAX(last_seen, ?) WHERE id = ?`).run(o.seen, o.last_seen, w.id);
      folded++;
    }
  }
  return folded;
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

export const STATUSES = ['open', 'fixing', 'fixed', 'wontfix', 'idea', 'expired'];

export function getFinding(id: string) {
  const r = db.prepare('SELECT * FROM findings WHERE id = ?').get(id);
  return r ? toFinding(r) : null;
}

/** status: open | fixing (an agent is on it) | fixed | wontfix | idea (the ideas list) | expired (an idea not seen for IDEA_DAYS). */
export function updateFinding(id: string, patch: { status?: string; note?: string; severity?: string }) {
  const f = getFinding(id);
  if (!f) throw new Error(`No finding ${id}`);
  const status = patch.status ?? f.status;
  if (!STATUSES.includes(status)) throw new Error(`status must be ${STATUSES.join(', ')}`);
  db.prepare('UPDATE findings SET status = ?, note = ?, severity = ?, updated = ? WHERE id = ?').run(status, patch.note ?? f.note, patch.severity ?? f.severity, Date.now(), id);
  return getFinding(id)!;
}

/** Open findings a run looked for (same product and scenario) but didn't see again: probably fixed. */
export function notSeenIn(run: string, product: string, scenarios: string[]) {
  if (!scenarios.length) return [];
  return listFindings({ product, status: 'open' }).filter((f) => f.last_run !== run && f.scenario && scenarios.includes(f.scenario));
}
