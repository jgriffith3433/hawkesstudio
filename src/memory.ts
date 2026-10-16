// Shared memory: what every agent, scout, reviewer and Talk knows across runs and conversations (docs/memory.md).
//
// Entries are typed and scoped:
//   kind   decision (J's word: only J, or Talk quoting J's own message), preference (how J likes things), convention
//          (how a codebase works), lesson (what broke and the fix), canon (story and IP facts shared across products),
//          state (work in progress; fades after a week without an update)
//   scope  studio (everything), product, or a roadmap item
// Each has provenance (who wrote it, when, from which run or conversation), when it was last confirmed, and how often
// it was used. Agents and scouts only write candidates; the PM curates them (confirm, merge, fade, flag a contradiction
// to J). Entries nobody uses fade (decisions and canon never do); faded ones stay searchable.
//
// Read path (memoryBlock): Studio puts the few most relevant entries into every agent brief, scout, review and Talk
// turn: the scope's decisions and preferences first (stable, so prompts cache), then full-text matches on the task.
// memory_search / memory_get (MCP) for more. Run history (agent_runs): every agent, scout and PM run's summary,
// outcome and lessons, searchable ("how did we fix X last time?").
//
// Human-readable: exportMarkdown() renders a "Learned" file per product and the canon as a story bible; on the server
// publishMemory() commits them to the orphan branch "memory" of hawkesstudio ([skip ci]: it deploys nothing). J edits
// entries in the dashboard's Memory tab.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { db, newId, J, parse } from './db.ts';
import { ROOT, DATA, loadProducts, loadInfra, StudioError } from './config.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, product TEXT, item TEXT, title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, by TEXT NOT NULL, source TEXT,
    quote TEXT, key TEXT, edited INTEGER DEFAULT 0, created INTEGER NOT NULL, updated INTEGER, confirmed INTEGER,
    uses INTEGER NOT NULL DEFAULT 0, last_used INTEGER, sources TEXT, note TEXT
  );
  CREATE INDEX IF NOT EXISTS memories_scope ON memories(status, product, kind);
  CREATE UNIQUE INDEX IF NOT EXISTS memories_key ON memories(key) WHERE key IS NOT NULL;
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, tags, content='memories', content_rowid='rowid', tokenize='porter unicode61');
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
  END;

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT, product TEXT, title TEXT NOT NULL, outcome TEXT,
    summary TEXT NOT NULL DEFAULT '', lessons TEXT NOT NULL DEFAULT '', by TEXT, model TEXT, cost REAL DEFAULT 0,
    started INTEGER, finished INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_runs_product ON agent_runs(product, finished);
  CREATE VIRTUAL TABLE IF NOT EXISTS agent_runs_fts USING fts5(title, summary, lessons, content='agent_runs', content_rowid='rowid', tokenize='porter unicode61');
  CREATE TRIGGER IF NOT EXISTS agent_runs_ai AFTER INSERT ON agent_runs BEGIN
    INSERT INTO agent_runs_fts(rowid, title, summary, lessons) VALUES (new.rowid, new.title, new.summary, new.lessons);
  END;
  CREATE TRIGGER IF NOT EXISTS agent_runs_ad AFTER DELETE ON agent_runs BEGIN
    INSERT INTO agent_runs_fts(agent_runs_fts, rowid, title, summary, lessons) VALUES ('delete', old.rowid, old.title, old.summary, old.lessons);
  END;
  CREATE TRIGGER IF NOT EXISTS agent_runs_au AFTER UPDATE OF title, summary, lessons ON agent_runs BEGIN
    INSERT INTO agent_runs_fts(agent_runs_fts, rowid, title, summary, lessons) VALUES ('delete', old.rowid, old.title, old.summary, old.lessons);
    INSERT INTO agent_runs_fts(rowid, title, summary, lessons) VALUES (new.rowid, new.title, new.summary, new.lessons);
  END;
`);

export const KINDS = ['decision', 'preference', 'convention', 'lesson', 'canon', 'state'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['active', 'candidate', 'disputed', 'faded'] as const;
export type Status = (typeof STATUSES)[number];

export type Memory = {
  id: string; kind: Kind; scope: 'studio' | 'product' | 'item'; product: string | null; item: string | null; title: string; body: string;
  tags: string; status: Status; by: string; source: string | null; quote: string | null; key: string | null; edited: number;
  created: number; updated: number | null; confirmed: number | null; uses: number; last_used: number | null;
  /** Other places it was seen again (merged duplicates): { by, source, at }. */
  sources: { by: string; source: string | null; at: number }[]; note: string | null;
};
export type AgentRun = {
  id: string; kind: string; subject: string | null; product: string | null; title: string; outcome: string | null; summary: string;
  lessons: string; by: string | null; model: string | null; cost: number; started: number | null; finished: number;
};

/** Who is writing: J (the dashboard), Talk (a conversation), the PM (its conversation), an agent or scout, the seed, Studio. */
export type Caller = { who: 'J' | 'talk' | 'pm' | 'agent' | 'scout' | 'seed' | 'studio'; id?: string | null; name?: string };
export const callerName = (c: Caller) => c.name ?? ({ J: 'J', talk: 'Talk', pm: 'Talk (PM)', agent: 'agent', scout: 'scout', seed: 'seed', studio: 'Studio' } as const)[c.who] + (c.id && ['agent', 'scout'].includes(c.who) ? ` ${c.id}` : '');

const toMemory = (r: any): Memory => ({ ...r, sources: parse(r.sources) ?? [] });
export const getMemory = (id: string) => {
  const r = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  return r ? toMemory(r) : null;
};
export const getRun = (id: string) => (db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRun | undefined) ?? null;

// ------------------------------------------------------------------ helpers

const STOP = new Set('the a an and or of to in on for with is are was were be been it this that these those at by from as not no but if then so do does did can could should would will just into than too very you your we our they their them his her its what when where which who how why there here also only any all some each more most other such use used using get got make made via per about over after before'.split(' '));
/** The words of a text that matter for matching (lowercase, no stopwords, at most `max`). */
export function words(text: string, max = 24) {
  const out: string[] = [];
  for (const w of String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ')) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}
/** An FTS5 query that matches any of the words (ranked by bm25), or null when there are none. */
export function ftsQuery(text: string, max = 16) {
  const w = words(text, max);
  return w.length ? w.map((x) => `"${x}"`).join(' OR ') : null;
}
/** How alike two texts are (0..1): the overlap of their words. */
export function similarity(a: string, b: string) {
  const x = new Set(words(a, 60));
  const y = new Set(words(b, 60));
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.sqrt(x.size * y.size);
}
/** A roadmap item's row (roadmap.ts makes the table; null before it exists). */
const itemRow = (id: string) => {
  try {
    return (db.prepare('SELECT product FROM items WHERE id = ?').get(id) as { product: string } | undefined) ?? null;
  } catch {
    return null;
  }
};
const clip = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A product id from an id or a name (Studio and Gen count as products for memory); null when none. */
export function productId(p: unknown) {
  if (p === undefined || p === null || p === '') return null;
  const s = String(p).toLowerCase();
  const all = [...loadProducts(), ...loadInfra()];
  const hit = all.find((x) => x.id === s || x.name.toLowerCase() === s);
  if (!hit) throw new StudioError(`No product "${p}". Products: ${all.map((x) => x.id).join(', ')}`);
  return hit.id;
}

// ------------------------------------------------------------------ write

export type WriteInput = {
  kind: string; title: string; body?: string; product?: string | null; item?: string | null; tags?: string | string[];
  /** J's exact words (a decision written by Talk must quote J's own message in that conversation). */
  quote?: string | null; source?: string | null; key?: string | null; status?: Status; supersedes?: string | null;
};

/** Whether `quote` is in one of J's own messages of a Talk conversation (not Studio's notices, not Claude's text). */
export function jSaid(conversation: string | null | undefined, quote: string | null | undefined) {
  if (!conversation || !quote || norm(quote).length < 8) return false;
  let r: any;
  try {
    r = db.prepare('SELECT messages FROM conversations WHERE id = ?').get(conversation);
  } catch {
    return false;
  }
  const msgs = (parse(r?.messages) ?? []) as { role: string; text: string; notice?: boolean }[];
  const q = norm(quote);
  return msgs.some((m) => m.role === 'user' && !m.notice && norm(m.text).includes(q));
}

/** The status a new entry gets, by who writes it (or why it is refused). */
function statusFor(kind: Kind, c: Caller, input: WriteInput): Status {
  const agentish = c.who === 'agent' || c.who === 'scout';
  if (kind === 'decision') {
    if (c.who === 'J' || c.who === 'seed') return 'active';
    if ((c.who === 'talk' || c.who === 'pm') && jSaid(c.id, input.quote)) return 'active';
    if (c.who === 'talk' || c.who === 'pm') throw new StudioError("A decision is J's word: quote his own message in this conversation (quote: his exact words), or write it as a preference.");
    throw new StudioError("Decisions are J's: write what you found as a lesson or convention (a candidate the PM reviews).");
  }
  if (agentish) return 'candidate';
  if (kind === 'canon' && (c.who === 'talk' || c.who === 'pm') && !input.source && !jSaid(c.id, input.quote)) return 'candidate';
  if (input.status && STATUSES.includes(input.status) && c.who !== 'studio') return input.status;
  return 'active';
}

/**
 * Writes an entry. A near-duplicate of one in the same kind and scope isn't added again: the existing one is confirmed
 * (seen again counts as confirmation) and remembers where else it came from. Returns the entry and whether it merged.
 */
export function writeMemory(input: WriteInput, c: Caller): { memory: Memory; merged: boolean } {
  const kind = String(input.kind ?? '').toLowerCase() as Kind;
  if (!KINDS.includes(kind)) throw new StudioError(`kind must be one of ${KINDS.join(', ')}`);
  const title = clip(input.title, 200);
  if (title.length < 4) throw new StudioError('Give it a short title (what to remember, in a line)');
  const body = clip(input.body ?? '', 4000);
  let item = input.item ? String(input.item) : null;
  let product = productId(input.product);
  if (item) {
    const it = itemRow(item);
    if (!it) throw new StudioError(`No roadmap item ${item}`);
    product = it.product;
  }
  const scope = item ? 'item' : product ? 'product' : 'studio';
  const tags = (Array.isArray(input.tags) ? input.tags.join(' ') : String(input.tags ?? '')).slice(0, 300);
  const by = callerName(c);
  const source = input.source ? clip(input.source, 300) : c.id ?? null;
  const now = Date.now();

  // Seeds and imports are keyed: the same key updates (unless J edited it).
  if (input.key) {
    const cur = db.prepare('SELECT * FROM memories WHERE key = ?').get(input.key) as any;
    if (cur) {
      if (!cur.edited && (cur.title !== title || cur.body !== body || cur.tags !== tags)) db.prepare('UPDATE memories SET title = ?, body = ?, tags = ?, updated = ? WHERE id = ?').run(title, body, tags, now, cur.id);
      return { memory: getMemory(cur.id)!, merged: true };
    }
  }
  const status = statusFor(kind, c, input);
  const dup = findDuplicate({ kind, product, item, title, body });
  if (dup && !input.supersedes) {
    const sources = [...dup.sources, { by, source, at: now }].slice(-20);
    // A candidate seen again by J, Talk or the PM becomes active; an agent seeing it again only confirms it.
    const next = dup.status === 'candidate' && status === 'active' ? 'active' : dup.status === 'faded' ? (status === 'active' ? 'active' : 'candidate') : dup.status;
    db.prepare('UPDATE memories SET confirmed = ?, sources = ?, status = ?, updated = ? WHERE id = ?').run(now, J(sources), next, now, dup.id);
    return { memory: getMemory(dup.id)!, merged: true };
  }
  const id = newId('m');
  db.prepare(`INSERT INTO memories (id, kind, scope, product, item, title, body, tags, status, by, source, quote, key, created, updated, confirmed, sources)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, kind, scope, product, item, title, body, tags, status, by, source, input.quote ? clip(input.quote, 1000) : null, input.key ?? null, now, now, now, '[]');
  if (input.supersedes) {
    const old = getMemory(input.supersedes);
    if (old) db.prepare(`UPDATE memories SET status = 'faded', note = ?, updated = ? WHERE id = ?`).run(`superseded by ${id}`, now, old.id);
  }
  return { memory: getMemory(id)!, merged: false };
}

/** An entry of the same kind and scope that says the same thing, if any. */
export function findDuplicate(e: { kind: string; product: string | null; item: string | null; title: string; body: string }, threshold = 0.72) {
  const q = ftsQuery(`${e.title} ${e.body}`, 20);
  if (!q) return null;
  const rows = db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
    WHERE memories_fts MATCH ? AND m.kind = ? AND COALESCE(m.product, '') = ? AND COALESCE(m.item, '') = ? ORDER BY bm25(memories_fts) LIMIT 8`)
    .all(q, e.kind, e.product ?? '', e.item ?? '') as any[];
  let best: { m: Memory; s: number } | null = null;
  for (const r of rows) {
    const s = norm(r.title) === norm(e.title) ? 1 : Math.max(similarity(`${r.title} ${r.body}`, `${e.title} ${e.body}`), similarity(r.title, e.title) * 0.9);
    if (s >= threshold && (!best || s > best.s)) best = { m: toMemory(r), s };
  }
  return best?.m ?? null;
}

/** J's edits (the dashboard) and the PM's curation. Setting a field by hand marks it edited (seeds won't overwrite it). */
export function updateMemory(id: string, patch: Partial<{ kind: string; title: string; body: string; tags: string; product: string | null; item: string | null; status: string; note: string }>, c: Caller) {
  const cur = getMemory(id);
  if (!cur) throw new StudioError('No such memory', 404);
  const next: any = { ...cur };
  if (patch.kind !== undefined) {
    if (!KINDS.includes(patch.kind as Kind)) throw new StudioError(`kind must be one of ${KINDS.join(', ')}`);
    if (patch.kind === 'decision' && c.who !== 'J') throw new StudioError("Only J makes something a decision.");
    next.kind = patch.kind;
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status as Status)) throw new StudioError(`status must be one of ${STATUSES.join(', ')}`);
    // Only J can fade or dispute his own decisions; nobody but J activates a decision someone else proposed.
    if (cur.kind === 'decision' && c.who !== 'J' && patch.status !== cur.status && patch.status !== 'disputed') throw new StudioError("A decision's status is J's to change (dispute it and ask him).");
    next.status = patch.status;
  }
  if (patch.title !== undefined) next.title = clip(patch.title, 200);
  if (patch.body !== undefined) next.body = clip(patch.body, 4000);
  if (patch.tags !== undefined) next.tags = String(patch.tags).slice(0, 300);
  if (patch.note !== undefined) next.note = clip(patch.note, 1000) || null;
  if (patch.product !== undefined || patch.item !== undefined) {
    next.item = patch.item === undefined ? cur.item : patch.item || null;
    next.product = next.item ? itemRow(next.item)?.product ?? null : productId(patch.product === undefined ? cur.product : patch.product);
    next.scope = next.item ? 'item' : next.product ? 'product' : 'studio';
  }
  const edited = c.who === 'J' && (patch.title !== undefined || patch.body !== undefined || patch.kind !== undefined) ? 1 : cur.edited;
  const confirmed = next.status === 'active' && cur.status !== 'active' ? Date.now() : cur.confirmed;
  db.prepare('UPDATE memories SET kind = ?, scope = ?, product = ?, item = ?, title = ?, body = ?, tags = ?, status = ?, note = ?, edited = ?, confirmed = ?, updated = ? WHERE id = ?')
    .run(next.kind, next.scope, next.product, next.item, next.title, next.body, next.tags, next.status, next.note, edited, confirmed, Date.now(), id);
  return getMemory(id)!;
}

export function deleteMemory(id: string, c: Caller) {
  const cur = getMemory(id);
  if (!cur) throw new StudioError('No such memory', 404);
  if (c.who !== 'J' && (cur.kind === 'decision' || cur.status === 'active')) throw new StudioError('Only J deletes active entries and decisions (fade it instead).');
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return { ok: true };
}

/** Merges `from` into `into`: its sources and uses move over and `from` is deleted. */
export function mergeMemories(into: string, from: string, c: Caller) {
  const a = getMemory(into);
  const b = getMemory(from);
  if (!a || !b) throw new StudioError('No such memory', 404);
  if (a.id === b.id) throw new StudioError('That is the same entry');
  if (b.kind === 'decision' && c.who !== 'J') throw new StudioError("Merging away a decision is J's call.");
  const sources = [...a.sources, { by: b.by, source: b.source, at: b.created }, ...b.sources].slice(-20);
  db.prepare('UPDATE memories SET sources = ?, uses = uses + ?, confirmed = ?, updated = ?, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run(J(sources), b.uses, Date.now(), Date.now(), 'candidate', b.status === 'active' ? 'active' : 'candidate', a.id);
  db.prepare('DELETE FROM memories WHERE id = ?').run(b.id);
  return getMemory(a.id)!;
}

// ------------------------------------------------------------------- read

export type ListQuery = { product?: string; kind?: string; status?: string; q?: string; item?: string; limit?: number; scope?: string };
/** Entries for the dashboard and the tools: a full-text query ranks them; without one, newest first. */
export function listMemories(qy: ListQuery = {}) {
  const where: string[] = [];
  const args: any[] = [];
  const statuses = (qy.status ?? 'active,candidate,disputed').split(',').filter(Boolean);
  if (!statuses.includes('all')) { where.push(`m.status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
  if (qy.kind) { const k = qy.kind.split(','); where.push(`m.kind IN (${k.map(() => '?').join(',')})`); args.push(...k); }
  if (qy.product) {
    const p = productId(qy.product);
    // A product's view includes what holds studio-wide.
    where.push(qy.scope === 'exact' ? 'm.product = ?' : '(m.product = ? OR m.product IS NULL)');
    args.push(p);
  }
  if (qy.item) { where.push('(m.item = ? OR m.item IS NULL)'); args.push(qy.item); }
  const limit = Math.min(Math.max(Number(qy.limit) || 50, 1), 500);
  const fq = qy.q ? ftsQuery(qy.q, 20) : null;
  if (qy.q && /^m_[0-9a-f]{12}$/.test(qy.q.trim())) return [getMemory(qy.q.trim())].filter(Boolean) as Memory[];
  if (fq) {
    return (db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY bm25(memories_fts, 3.0, 1.0, 2.0) LIMIT ?`)
      .all(fq, ...args, limit) as any[]).map(toMemory);
  }
  return (db.prepare(`SELECT m.* FROM memories m ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(m.updated, m.created) DESC LIMIT ?`).all(...args, limit) as any[]).map(toMemory);
}

export function searchRuns(q: string, { product, limit = 10 }: { product?: string; limit?: number } = {}) {
  const fq = ftsQuery(q, 20);
  const p = product ? productId(product) : null;
  if (!fq) return (db.prepare(`SELECT * FROM agent_runs ${p ? 'WHERE product = ?' : ''} ORDER BY finished DESC LIMIT ?`).all(...(p ? [p] : []), limit) as AgentRun[]);
  return db.prepare(`SELECT r.* FROM agent_runs_fts f JOIN agent_runs r ON r.rowid = f.rowid WHERE agent_runs_fts MATCH ? ${p ? 'AND r.product = ?' : ''} ORDER BY bm25(agent_runs_fts, 2.0, 1.0, 2.0) LIMIT ?`)
    .all(fq, ...(p ? [p] : []), limit) as AgentRun[];
}

/** memory_search: entries and past runs. */
export function search(q: string, opts: { product?: string; kind?: string; limit?: number; runs?: boolean; status?: string } = {}) {
  const memories = listMemories({ q, product: opts.product, kind: opts.kind, limit: opts.limit ?? 12, status: opts.status ?? 'active,candidate,disputed,faded' });
  markUsed(memories.map((m) => m.id));
  return {
    memories: memories.map(brief),
    runs: opts.runs === false ? [] : searchRuns(q, { product: opts.product, limit: 6 }).map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, product: r.product, title: r.title, outcome: r.outcome, when: new Date(r.finished).toISOString().slice(0, 10), summary: clip(r.summary, 600), lessons: clip(r.lessons, 600) })),
  };
}
const brief = (m: Memory) => ({ id: m.id, kind: m.kind, scope: m.scope, product: m.product, item: m.item, status: m.status, title: m.title, body: clip(m.body, 900), by: m.by, when: new Date(m.created).toISOString().slice(0, 10), uses: m.uses });

export function markUsed(ids: string[]) {
  if (!ids.length) return;
  const now = Date.now();
  const st = db.prepare('UPDATE memories SET uses = uses + 1, last_used = ? WHERE id = ?');
  for (const id of ids) st.run(now, id);
}

/** A line for prompts: "[kind] title: body (id, unconfirmed)". */
export function line(m: Memory, bodyMax = 400) {
  const tag = m.status === 'candidate' ? ', unconfirmed' : m.status === 'disputed' ? ', disputed' : '';
  const where = m.item ? ` (item ${m.item})` : '';
  return `- [${m.kind}] ${m.title}${m.body ? `: ${clip(m.body.replace(/\s+/g, ' '), bodyMax)}` : ''}${where} (${m.id}${tag})`;
}

const KIND_ORDER: Record<string, number> = { decision: 0, preference: 1, canon: 2, convention: 3, lesson: 4, state: 5 };
const scopeArgs = (product: string | null, item: string | null) => {
  const conds = ['m.product IS NULL'];
  const args: any[] = [];
  if (product) { conds.push('(m.product = ? AND m.item IS NULL)'); args.push(product); }
  if (item) { conds.push('m.item = ?'); args.push(item); }
  return { sql: `(${conds.join(' OR ')})`, args };
};

export type BlockOpts = {
  product?: string | null; item?: string | null; text?: string;
  /** Which job: agents and scouts get lessons; content work and reviews get the product's canon. */
  role?: 'talk' | 'pm' | 'fixer' | 'builder' | 'content' | 'scout' | 'reviewer' | 'infra';
  limit?: number; maxChars?: number; exclude?: string[];
  /** Only the stable part (decisions, preferences, canon for content roles): for system prompts that should cache. */
  stableOnly?: boolean; relevantOnly?: boolean;
};

/**
 * The memory block for a prompt: the scope's decisions and preferences (always, ordered by id so the text is stable),
 * the product's canon for content work and reviews, then the entries that best match the task (full-text), lessons
 * and conventions included while unconfirmed (marked). Small: about `maxChars`. Returns the text and the ids used.
 */
export function memoryBlock(o: BlockOpts = {}) {
  let product: string | null = null;
  try { product = productId(o.product); } catch { product = null; }
  const item = o.item ?? null;
  const sc = scopeArgs(product, item);
  const limit = o.limit ?? 12;
  const maxChars = o.maxChars ?? 3500;
  const picked = new Map<string, Memory>();
  const exclude = new Set(o.exclude ?? []);
  const add = (rows: any[], cap: number) => {
    let n = 0;
    for (const r of rows) {
      if (n >= cap || picked.size >= limit + 8) break;
      if (picked.has(r.id) || exclude.has(r.id)) continue;
      picked.set(r.id, toMemory(r));
      n++;
    }
  };
  if (!o.relevantOnly) {
    add(db.prepare(`SELECT m.* FROM memories m WHERE m.status = 'active' AND m.kind IN ('decision', 'preference') AND ${sc.sql} ORDER BY CASE m.kind WHEN 'decision' THEN 0 ELSE 1 END, m.product IS NOT NULL, m.id`).all(...sc.args) as any[], 10);
    if (o.role === 'content' || o.role === 'reviewer') {
      add(db.prepare(`SELECT m.* FROM memories m WHERE m.status = 'active' AND m.kind = 'canon' AND ${sc.sql} ORDER BY m.product IS NULL, m.uses DESC, m.id`).all(...sc.args) as any[], 14);
    }
  }
  const fq = o.stableOnly ? null : ftsQuery(o.text ?? '', 16);
  if (fq) {
    const kinds = o.role === 'talk' || o.role === 'pm' ? `'decision','preference','convention','lesson','canon','state'` : `'convention','lesson','canon','state','preference'`;
    // Talk works across products: its matches come from everywhere; agents stay in their scope.
    const scope = o.role === 'talk' || o.role === 'pm' ? { sql: '1', args: [] as any[] } : sc;
    const rows = db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND ${scope.sql}
      AND (m.status = 'active' OR (m.status IN ('candidate', 'disputed') AND m.kind IN ('lesson', 'convention', 'state')))
      AND m.kind IN (${kinds}) ORDER BY bm25(memories_fts, 3.0, 1.0, 2.0) LIMIT 30`).all(fq, ...scope.args) as any[];
    add(rows, limit);
  }
  // Stable order: kind, then id (the relevant ones keep their rank among themselves).
  const list = [...picked.values()];
  const rank = new Map(list.map((m, i) => [m.id, i]));
  list.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (o.stableOnly ? a.id.localeCompare(b.id) : (rank.get(a.id)! - rank.get(b.id)!)));
  const lines: string[] = [];
  const used: string[] = [];
  let size = 0;
  for (const m of list) {
    const l = line(m);
    if (size + l.length > maxChars && used.length) break;
    lines.push(l);
    used.push(m.id);
    size += l.length + 1;
  }
  if (!o.stableOnly) markUsed(used);
  return { text: lines.join('\n'), ids: used };
}

/** The memory section of an agent's or scout's brief (what the studio knows that bears on this task). */
export function briefSection(o: BlockOpts) {
  const b = memoryBlock(o);
  if (!b.text) return { text: '', ids: [] as string[] };
  return {
    ids: b.ids,
    text: `## What the studio already knows (shared memory)

Earlier agents, J and Talk learned these; follow decisions and preferences, respect canon, and use the lessons
(unconfirmed ones are an earlier agent's notes: check them). More: memory_search, if you have the tool.
${b.text}
`,
  };
}

/** The canon that holds for a product (its own and the studio-wide), as prompt lines. */
export function canonLines(product: string | null, max = 6000) {
  let p: string | null = null;
  try { p = productId(product); } catch { p = null; }
  const rows = (db.prepare(`SELECT * FROM memories WHERE status = 'active' AND kind = 'canon' AND (product IS NULL ${p ? 'OR product = ?' : ''}) ORDER BY product IS NULL, id`).all(...(p ? [p] : [])) as any[]).map(toMemory);
  const out: string[] = [];
  let size = 0;
  for (const m of rows) {
    const l = line(m, 300);
    if (size + l.length > max) break;
    out.push(l);
    size += l.length + 1;
  }
  return { text: out.join('\n'), ids: rows.slice(0, out.length).map((m) => m.id) };
}

// --------------------------------------------------------------- run history

export function recordRun(r: Omit<AgentRun, 'id' | 'finished' | 'cost' | 'lessons' | 'summary' | 'model' | 'started' | 'by'> & { id?: string; finished?: number; cost?: number; summary?: string; lessons?: string; model?: string | null; started?: number | null; by?: string | null }) {
  const id = r.id ?? newId('ar');
  db.prepare(`INSERT INTO agent_runs (id, kind, subject, product, title, outcome, summary, lessons, by, model, cost, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, summary = excluded.summary, lessons = excluded.lessons, cost = excluded.cost, finished = excluded.finished`)
    .run(id, r.kind, r.subject ?? null, r.product ?? null, clip(r.title, 200), r.outcome ?? null, clip(r.summary ?? '', 8000), clip(r.lessons ?? '', 4000), r.by ?? null, r.model ?? null, r.cost ?? 0, r.started ?? null, r.finished ?? Date.now());
  return id;
}
export const listRuns = (q: { product?: string; kind?: string; limit?: number } = {}) => {
  const where: string[] = [];
  const args: any[] = [];
  if (q.product) { where.push('product = ?'); args.push(productId(q.product)); }
  if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
  return db.prepare(`SELECT * FROM agent_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY finished DESC LIMIT ?`).all(...args, q.limit ?? 50) as AgentRun[];
};

/**
 * What an agent left for the next one (.hawkes/learned.md): lines like
 *   - lesson: <title> — <what to know>
 *   - convention: <title> — <how it works>
 * (also canon:, preference:, state:). Each becomes a candidate with the run as its source. Returns the ids.
 */
export function parseLearned(text: string) {
  const out: { kind: Kind; title: string; body: string }[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\**(lesson|convention|canon|preference|state)\**\s*[:—-]\s*(.+)$/i.exec(raw);
    if (m) {
      const rest = m[2].trim();
      const cut = rest.search(/\s[—–]\s|\s-\s|:\s/);
      const [title, body] = cut > 8 ? [rest.slice(0, cut), rest.slice(cut).replace(/^\s*[—–:-]\s*/, '')] : [rest, ''];
      out.push({ kind: m[1].toLowerCase() as Kind, title: title.trim(), body: body.trim() });
    } else if (out.length && /^\s{2,}\S/.test(raw)) {
      out[out.length - 1].body = `${out[out.length - 1].body} ${raw.trim()}`.trim();
    }
  }
  return out.slice(0, 12);
}
export function learnFrom(text: string, c: Caller, { product, item, source }: { product?: string | null; item?: string | null; source?: string | null } = {}) {
  const ids: string[] = [];
  for (const e of parseLearned(text)) {
    try {
      ids.push(writeMemory({ ...e, product, item, source }, c).memory.id);
    } catch (err: any) {
      console.warn(`[memory] ${callerName(c)}: ${err.message}`);
    }
  }
  return ids;
}

/** What an agent's brief asks it to leave for the next one. */
export const LEARNED_ASK = `Before you finish, write \`.hawkes/learned.md\`: what the next agent working on this project should know that
isn't obvious from the code (at most 5 lines, only real knowledge: a trap you hit and how you got past it, how a part of
the codebase really works, a check that matters). One per line, in this form:
- lesson: <short title> — <what broke or misled you, and the fix>
- convention: <short title> — <how this codebase does it>
Write nothing there if you learned nothing new. Studio keeps these in the shared memory for the next agent.`;

// --------------------------------------------------------------- curation

const DAY = 86_400_000;
export const FADE = { activeDays: 60, candidateDays: 21, stateDays: 7 };

/**
 * Housekeeping (daily, no model): state entries without an update for a week fade; candidates nobody confirmed or
 * used in three weeks fade; active entries unused for two months fade. Decisions, canon and J's edits never fade.
 */
export function fadeUnused(now = Date.now()) {
  const faded: string[] = [];
  const rows = db.prepare(`SELECT * FROM memories WHERE status IN ('active', 'candidate') AND kind NOT IN ('decision', 'canon') AND edited = 0`).all() as any[];
  for (const r of rows) {
    const last = Math.max(r.last_used ?? 0, r.confirmed ?? 0, r.updated ?? 0, r.created);
    const days = (now - last) / DAY;
    const stale = r.kind === 'state' ? (now - Math.max(r.updated ?? 0, r.created)) / DAY > FADE.stateDays : r.status === 'candidate' ? days > FADE.candidateDays : days > FADE.activeDays;
    if (stale) faded.push(r.id);
  }
  const st = db.prepare(`UPDATE memories SET status = 'faded', note = COALESCE(note, 'faded: unused'), updated = ? WHERE id = ?`);
  for (const id of faded) st.run(now, id);
  return faded;
}

/** What the PM's curation looks at: candidates, likely duplicates, disputed entries, and contradictions to check. */
export function curation({ limit = 25 } = {}) {
  const candidates = (db.prepare(`SELECT * FROM memories WHERE status = 'candidate' ORDER BY created LIMIT ?`).all(limit) as any[]).map(toMemory);
  const disputed = (db.prepare(`SELECT * FROM memories WHERE status = 'disputed' ORDER BY updated DESC LIMIT 20`).all() as any[]).map(toMemory);
  const pairs: { a: string; b: string; similarity: number }[] = [];
  for (const c of candidates) {
    const q = ftsQuery(`${c.title} ${c.body}`, 16);
    if (!q) continue;
    const rows = db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND m.id != ? AND m.status IN ('active', 'candidate', 'disputed') AND COALESCE(m.product, '') = ? ORDER BY bm25(memories_fts) LIMIT 4`).all(q, c.id, c.product ?? '') as any[];
    for (const r of rows) {
      const s = similarity(`${r.title} ${r.body}`, `${c.title} ${c.body}`);
      if (s >= 0.4 && !pairs.some((p) => (p.a === r.id && p.b === c.id) || (p.a === c.id && p.b === r.id))) pairs.push({ a: r.id, b: c.id, similarity: Math.round(s * 100) / 100 });
    }
  }
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`).all() as any[];
  return { counts: Object.fromEntries(counts.map((r) => [r.status, r.n])), candidates: candidates.map(brief), similar: pairs.slice(0, 30), disputed: disputed.map(brief) };
}

/** One line for the PM's turn prompt (empty when there is nothing to curate). */
export function curationLine() {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status = 'candidate'`).get() as any).n as number;
  const d = (db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status = 'disputed'`).get() as any).n as number;
  if (!n && !d) return '';
  return `Shared memory: ${n} candidate entr${n === 1 ? 'y' : 'ies'} from agents${d ? ` and ${d} disputed` : ''} wait for curation (memory_curate list).`;
}

// ------------------------------------------------------------------ export

const pname = (id: string | null) => {
  if (!id) return 'All of Hawkes';
  return [...loadProducts(), ...loadInfra()].find((x) => x.id === id)?.name ?? id;
};
const KIND_TITLE: Record<string, string> = { decision: "J's decisions", preference: 'Preferences', convention: 'How the code works', lesson: 'Lessons (what broke, and the fix)', state: 'In progress', canon: 'Canon' };

/** The Markdown files: learned/<product>.md (and studio.md), canon.md (the story bible), README.md. */
export function exportMarkdown() {
  const all = (db.prepare(`SELECT * FROM memories WHERE status IN ('active', 'disputed') ORDER BY product, kind, title`).all() as any[]).map(toMemory);
  const files: Record<string, string> = {};
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry = (m: Memory) => `- **${m.title}**${m.status === 'disputed' ? ' _(disputed)_' : ''}${m.body ? `: ${m.body.replace(/\n+/g, ' ')}` : ''}  \n  <sub>${m.id} · ${m.by} · ${new Date(m.created).toISOString().slice(0, 10)}${m.item ? ` · item ${m.item}` : ''}${m.source ? ` · ${m.source}` : ''}</sub>`;
  const byProduct = new Map<string | null, Memory[]>();
  for (const m of all.filter((x) => x.kind !== 'canon')) byProduct.set(m.product, [...(byProduct.get(m.product) ?? []), m]);
  for (const [p, list] of byProduct) {
    const sections = KINDS.filter((k) => k !== 'canon').map((k) => {
      const xs = list.filter((m) => m.kind === k);
      return xs.length ? `## ${KIND_TITLE[k]}\n\n${xs.map(entry).join('\n')}\n` : '';
    }).filter(Boolean);
    files[`learned/${p ?? 'studio'}.md`] = `# Learned: ${pname(p)}\n\nGenerated from Hawkes Studio's shared memory (${stamp} UTC). Edit entries in Studio's Memory tab, not here.\n\n${sections.join('\n')}`;
  }
  const canon = all.filter((m) => m.kind === 'canon');
  const groups = new Map<string | null, Memory[]>();
  for (const m of canon) groups.set(m.product, [...(groups.get(m.product) ?? []), m]);
  const order = [null, ...[...groups.keys()].filter((k) => k !== null).sort()];
  files['canon.md'] = `# The Hawkes story bible (canon)\n\nThe facts every product shares, and each product's own: characters, places and rules. Content and story changes are
checked against these. Generated from Studio's shared memory (${stamp} UTC); edit them in Studio's Memory tab.\n\n${order.filter((k) => groups.has(k)).map((k) => `## ${pname(k)}\n\n${groups.get(k)!.map(entry).join('\n')}\n`).join('\n')}`;
  files['README.md'] = `# Hawkes shared memory (export)\n\nWhat Hawkes Studio's agents, scouts, reviewers and Talk have learned, as Markdown. Generated ${stamp} UTC; this branch
only holds the export (commits say [skip ci]; nothing deploys from it). The live memory is in Studio (Memory tab,
memory_search over MCP). See hawkesstudio/docs/memory.md.\n\n- [canon.md](canon.md): the story bible\n${[...byProduct.keys()].map((p) => `- [learned/${p ?? 'studio'}.md](learned/${p ?? 'studio'}.md): ${pname(p)}`).join('\n')}\n`;
  return files;
}

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
}

export const MEMORY_BRANCH = 'memory';
/**
 * Commits the export to the orphan branch "memory" of hawkesstudio and pushes it (server only: it has the push
 * credential). Its commits say [skip ci] and the branch has no code, so nothing runs or deploys from it.
 */
export function publishMemory() {
  const repo = ROOT;
  const wt = path.join(DATA, 'memory-export');
  if (!fs.existsSync(path.join(wt, '.git'))) {
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, ['worktree', 'prune']);
    git(repo, ['fetch', '--quiet', 'origin', MEMORY_BRANCH]);
    const has = git(repo, ['rev-parse', '--verify', `origin/${MEMORY_BRANCH}`]).ok;
    const w = has ? git(repo, ['worktree', 'add', '--force', '-B', 'memory-export', wt, `origin/${MEMORY_BRANCH}`]) : git(repo, ['worktree', 'add', '--force', '--orphan', '-b', 'memory-export', wt]);
    if (!w.ok) throw new Error(`memory export worktree: ${w.err}`);
  } else {
    git(wt, ['fetch', '--quiet', 'origin', MEMORY_BRANCH]);
    if (git(wt, ['rev-parse', '--verify', `origin/${MEMORY_BRANCH}`]).ok) git(wt, ['reset', '--quiet', '--hard', `origin/${MEMORY_BRANCH}`]);
  }
  const files = exportMarkdown();
  fs.rmSync(path.join(wt, 'learned'), { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), text);
  }
  git(wt, ['add', '-A']);
  if (!git(wt, ['status', '--porcelain']).out) return { changed: false, files: Object.keys(files).length };
  const c = git(wt, ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.com', 'commit', '--quiet', '-m', `Memory export ${new Date().toISOString().slice(0, 10)} [skip ci]`]);
  if (!c.ok) throw new Error(`memory export commit: ${c.err}`);
  const p = git(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${MEMORY_BRANCH}`]);
  if (!p.ok) throw new Error(`memory export push: ${p.err}`);
  return { changed: true, files: Object.keys(files).length, sha: git(wt, ['rev-parse', '--short', 'HEAD']).out };
}

// -------------------------------------------------------------------- seed

/**
 * The seed (memory/seed/*.json in this repo): canon from the story docs, and conventions and lessons written down by
 * hand. Keyed, so importing again updates entries (unless J edited them) and never duplicates. Runs at startup.
 */
export function importSeed(dir = path.join(ROOT, 'memory', 'seed')) {
  if (!fs.existsSync(dir)) return { files: 0, entries: 0 };
  let entries = 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  db.exec('BEGIN');
  try {
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const e of (data.entries ?? []) as any[]) {
        const key = e.key ?? `seed:${f.replace(/\.json$/, '')}:${norm(e.title).replace(/ /g, '-').slice(0, 80)}`;
        try {
          writeMemory({ kind: e.kind ?? data.kind, title: e.title, body: e.body, product: e.product ?? data.product ?? null, tags: e.tags, source: e.source ?? data.source ?? f, key }, { who: 'seed' });
          entries++;
        } catch (err: any) {
          console.warn(`[memory] seed ${f}: ${err.message}`);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { files: files.length, entries };
}

// -------------------------------------------------------------- the service

let started = false;
/** At startup: import the seed; daily: fade what nobody uses and (on the server) publish the export. */
export function startMemory() {
  if (started) return;
  started = true;
  try {
    const s = importSeed();
    if (s.entries) console.log(`[memory] seed: ${s.entries} entries from ${s.files} files`);
  } catch (e: any) {
    console.warn(`[memory] seed: ${e.message}`);
  }
  const daily = () => {
    try {
      const f = fadeUnused();
      if (f.length) console.log(`[memory] faded ${f.length} unused entries`);
      // Haiku's first pass over the candidates (memory-curate.ts): duplicates fold in, contradictions go to J.
      if (process.env.STUDIO_SERVER === '1' && process.env.STUDIO_MEMORY_CURATE !== 'off') {
        void import('./memory-curate.ts').then(({ autoCurate }) => autoCurate()).then((r) => { if (r.looked) console.log(`[memory] curation: ${JSON.stringify(r)}`); }).catch((e) => console.warn(`[memory] curation: ${e.message}`));
      }
      if (process.env.STUDIO_SERVER === '1' && process.env.STUDIO_MEMORY_PUBLISH !== 'off' && process.env.GITHUB_TOKEN) {
        const r = publishMemory();
        if (r.changed) console.log(`[memory] export pushed to ${MEMORY_BRANCH} (${r.sha})`);
      }
    } catch (e: any) {
      console.warn(`[memory] daily: ${e.message}`);
    }
  };
  setTimeout(daily, 5 * 60_000).unref();
  setInterval(daily, DAY).unref();
}

export const memoryStats = () => ({
  ...Object.fromEntries((db.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all() as any[]).map((r) => [r.status, r.n])),
  runs: (db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as any).n,
});

