// Moving a project's knowledge between Studios (docs/memory.md, "Moving memory between Studios"). Any Studio exports a
// project's active memory as a portable bundle (format hawkes-memory/1) or as Markdown; any Studio imports one, scoped
// to one of its own projects, as candidates for curation (default) or active (an admin who says so). Duplicates fold
// into what is already there (memory.ts findDuplicate), decisions keep their quote and source and say where they came
// from. Plain Markdown docs (a story doc, a repo's AGENTS.md) import as one candidate per section.
//
// A bundle carries only knowledge: kind, title, body, tags, source, quote, product, created (and who wrote it there).
// Never run history, usage counters, ids, roadmap items, keys, or anything that looks like a secret (redact()).
//
// One-time export links: an admin of the exporting Studio makes a signed, expiring URL (GET /api/memory/export/<token>)
// that the importing Studio fetches once without keys. The token is HMAC-signed with a key kept in this Studio's data
// folder; each link works once (memory_links.used) and only until it expires.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, J, newId } from './db.ts';
import { DATA, StudioError } from './config.ts';
import * as mem from './memory.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS memory_links (
    nonce TEXT PRIMARY KEY, product TEXT, kinds TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
    by TEXT, used INTEGER
  );
`);

export const FORMAT = 'hawkes-memory/1';
/** What a project's memory is made of when it moves (state is work in progress: it stays where it is). */
export const EXPORT_KINDS = ['canon', 'decision', 'convention', 'lesson', 'preference'] as const;
const MAX_ENTRIES = 3000;

export type BundleEntry = { kind: string; title: string; body: string; tags: string; source: string | null; quote: string | null; product: string | null; created: number; by?: string };
export type Bundle = { format: typeof FORMAT; from: string; name?: string; product: string | null; exported: string; entries: BundleEntry[] };

const clip = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ------------------------------------------------------------------ secrets

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, // Anthropic / OpenAI
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(?:hsm|hsk|hgk|ustg|usk)_[A-Za-z0-9]{16,}/g, // Hawkes keys and MCP tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*)["']?[^\s"']{8,}/gi,
];
/** The text with anything that looks like a key, token or password replaced by [redacted]. */
export function redact(text: string) {
  let s = String(text ?? '');
  for (const re of SECRETS) s = s.replace(re, (m, pre) => (typeof pre === 'string' && pre && m.startsWith(pre) ? `${pre}[redacted]` : '[redacted]'));
  return s;
}

// ------------------------------------------------------------------ export

/** The product a bundle is for: an id here, or null for studio-wide ("studio", "" or nothing). */
const exportScope = (product: unknown) => (product === undefined || product === null || product === '' || product === 'studio' ? null : mem.productId(product));

export function parseKinds(kinds: unknown): string[] {
  const list = (Array.isArray(kinds) ? kinds : String(kinds ?? '').split(',')).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return [...EXPORT_KINDS];
  const bad = list.filter((k) => !(EXPORT_KINDS as readonly string[]).includes(k));
  if (bad.length) throw new StudioError(`kinds can be ${EXPORT_KINDS.join(', ')} (not ${bad.join(', ')})`);
  return [...new Set(list)];
}

/** A project's active memory as a portable bundle. `from` is this Studio's address, `name` what to call it. */
export function exportBundle({ product, kinds, from, name }: { product?: unknown; kinds?: unknown; from: string; name?: string }): Bundle {
  const p = exportScope(product);
  const ks = parseKinds(kinds);
  const rows = db.prepare(`SELECT * FROM memories WHERE status = 'active' AND COALESCE(product, '') = ? AND kind IN (${ks.map(() => '?').join(', ')}) ORDER BY kind, title`).all(p ?? '', ...ks) as any[];
  return {
    format: FORMAT, from, ...(name ? { name } : {}), product: p, exported: new Date().toISOString(),
    entries: rows.map((r) => ({
      kind: r.kind, title: redact(r.title), body: redact(r.body ?? ''), tags: r.tags ?? '', source: r.source ? redact(r.source) : null,
      quote: r.quote ? redact(r.quote) : null, product: p, created: r.created, by: r.by,
    })),
  };
}

const KIND_TITLE: Record<string, string> = { canon: 'Canon (story and world)', decision: 'Decisions', preference: 'Preferences', convention: 'How the code works', lesson: 'Lessons (what broke, and the fix)' };
/** The same bundle as Markdown, for people. */
export function bundleMarkdown(b: Bundle) {
  const sections = EXPORT_KINDS.map((k) => {
    const xs = b.entries.filter((e) => e.kind === k);
    if (!xs.length) return '';
    return `## ${KIND_TITLE[k]}\n\n${xs.map((e) => `- **${e.title}**${e.body ? `: ${e.body.replace(/\n+/g, ' ')}` : ''}${e.quote ? `\n  > “${e.quote.replace(/\n+/g, ' ')}”` : ''}${e.source ? `\n  <sub>source: ${e.source}</sub>` : ''}`).join('\n')}\n`;
  }).filter(Boolean);
  return `# Memory of ${b.product ?? 'the whole studio'}\n\nExported from ${b.name ? `${b.name} (${b.from})` : b.from} on ${b.exported.slice(0, 16).replace('T', ' ')} UTC: ${b.entries.length} entr${b.entries.length === 1 ? 'y' : 'ies'}. Import the JSON bundle (format ${FORMAT}) into another Studio from its Memory tab.\n\n${sections.join('\n')}`;
}

// ------------------------------------------------------------------ one-time links

let keyCache: Buffer | null = null;
function linkKey() {
  if (keyCache) return keyCache;
  const f = path.join(DATA, 'memory-links.key');
  try {
    keyCache = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    if (keyCache.length >= 32) return keyCache;
  } catch { /* first link */ }
  keyCache = crypto.randomBytes(32);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(f, keyCache.toString('hex'), { mode: 0o600 });
  return keyCache;
}
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (payload: string) => crypto.createHmac('sha256', linkKey()).update(`memory-export:${payload}`).digest('base64url');

/** A signed URL that gives one project's bundle once, until it expires (default an hour, at most a day). */
export function createLink({ product, kinds, minutes, base, by }: { product?: unknown; kinds?: unknown; minutes?: unknown; base: string; by?: string }) {
  const p = exportScope(product);
  const ks = parseKinds(kinds);
  const mins = Math.min(24 * 60, Math.max(1, Math.round(Number(minutes) || 60)));
  const nonce = crypto.randomBytes(12).toString('hex');
  const expires = Date.now() + mins * 60_000;
  db.prepare('INSERT INTO memory_links (nonce, product, kinds, created, expires, by) VALUES (?, ?, ?, ?, ?, ?)').run(nonce, p, J(ks), Date.now(), expires, by ?? null);
  const payload = b64(JSON.stringify({ n: nonce, e: expires }));
  const token = `${payload}.${sign(payload)}`;
  return { url: `${base.replace(/\/+$/, '')}/api/memory/export/${token}`, token, expires: new Date(expires).toISOString(), minutes: mins, product: p, kinds: ks, once: true };
}

/** The link's product and kinds, used up; throws when it's forged, expired or already used. */
export function redeemLink(token: string): { product: string | null; kinds: string[] } {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) throw new StudioError('Not an export link', 404);
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new StudioError('Not an export link of this Studio', 404);
  let p: { n: string; e: number };
  try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new StudioError('Not an export link', 404); }
  if (!p?.n || !(p.e > Date.now())) throw new StudioError('This export link has expired: make a new one in the Memory tab of the Studio it came from.', 410);
  const row = db.prepare('SELECT * FROM memory_links WHERE nonce = ?').get(p.n) as any;
  if (!row || row.expires <= Date.now()) throw new StudioError('This export link has expired: make a new one in the Memory tab of the Studio it came from.', 410);
  const used = db.prepare('UPDATE memory_links SET used = ? WHERE nonce = ? AND used IS NULL').run(Date.now(), p.n).changes;
  if (!used) throw new StudioError('This export link was already used: make a new one.', 410);
  return { product: row.product ?? null, kinds: JSON.parse(row.kinds) };
}

/** Fetches a bundle from another Studio's one-time export link (only such links: /api/memory/export/<token>). */
export async function fetchBundle(url: string, fetcher: typeof fetch = fetch): Promise<Bundle> {
  let u: URL;
  try { u = new URL(String(url ?? '').trim()); } catch { throw new StudioError('That is not a link'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new StudioError('Export links are https:// addresses');
  if (!/\/api\/memory\/export\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(u.pathname)) throw new StudioError('That is not a Studio export link (…/api/memory/export/<token>): make one in the Memory tab of the Studio it comes from.');
  const r = await fetcher(u.toString(), { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (text.length > 8_000_000) throw new StudioError('That bundle is too big');
  let body: any;
  try { body = JSON.parse(text); } catch { throw new StudioError(`The export link answered ${r.status} without a bundle`); }
  if (!r.ok) throw new StudioError(`The other Studio said: ${body?.error ?? r.status}`, r.status === 410 ? 410 : 502);
  return body;
}

// ------------------------------------------------------------------ import

export type ImportMode = 'candidates' | 'active';
export type ImportResult = { product: string | null; from: string; mode: ImportMode; added: number; merged: number; skipped: number; entries: { id: string; kind: string; title: string; status: string; merged: boolean }[]; notes: string[] };

/**
 * Imports a bundle into this Studio's memory, scoped to `product` (an id here: renames the bundle's) or the bundle's
 * own product. Candidates by default; 'active' for an admin who says so. Near-duplicates confirm what is there (and a
 * candidate seen again in active mode becomes active); importing the same bundle again changes nothing.
 */
export function importBundle(bundle: any, { product, mode = 'candidates' }: { product?: string | null; mode?: ImportMode } = {}): ImportResult {
  if (!bundle || typeof bundle !== 'object') throw new StudioError('Give a bundle (the JSON an export gave you)');
  if (bundle.format !== FORMAT) throw new StudioError(`Not a memory bundle (format should be ${FORMAT})`);
  if (!Array.isArray(bundle.entries)) throw new StudioError('The bundle has no entries');
  if (bundle.entries.length > MAX_ENTRIES) throw new StudioError(`At most ${MAX_ENTRIES} entries at once`);
  if (mode !== 'candidates' && mode !== 'active') throw new StudioError("mode is 'candidates' or 'active'");
  const target = product !== undefined && product !== null && product !== '' ? exportScope(product) : bundle.product ? exportScope(bundle.product) : null;
  const from = clip(bundle.from || 'another Studio', 200);
  const label = `imported from ${bundle.name ? `${clip(bundle.name, 80)} (${from})` : from}`;
  const status = mode === 'active' ? 'active' : 'candidate';
  const out: ImportResult = { product: target, from, mode, added: 0, merged: 0, skipped: 0, entries: [], notes: [] };
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const raw of bundle.entries as any[]) {
      const kind = String(raw?.kind ?? '').toLowerCase();
      const title = clip(redact(raw?.title ?? ''), 200);
      if (!(EXPORT_KINDS as readonly string[]).includes(kind) || title.length < 4) { out.skipped++; continue; }
      const body = clip(redact(raw?.body ?? ''), 4000);
      const tags = clip(raw?.tags ?? '', 300);
      const source = raw?.source ? clip(redact(raw.source), 300) : null;
      const quote = raw?.quote ? clip(redact(raw.quote), 1000) : null;
      const key = `import:${crypto.createHash('sha256').update(`${from}|${target ?? ''}|${kind}|${norm(title)}`).digest('hex').slice(0, 24)}`;
      const seen = { by: label, source, at: now };
      const keyed = db.prepare('SELECT id FROM memories WHERE key = ?').get(key) as { id: string } | undefined;
      const dup = keyed ? mem.getMemory(keyed.id) : mem.findDuplicate({ kind, product: target, item: null, title, body });
      if (dup) {
        const next = dup.status === 'candidate' && status === 'active' ? 'active' : dup.status === 'faded' ? status : dup.status;
        const sources = keyed ? dup.sources : [...dup.sources, seen].slice(-20);
        db.prepare('UPDATE memories SET confirmed = ?, sources = ?, status = ?, quote = COALESCE(quote, ?), updated = ? WHERE id = ?').run(now, J(sources), next, quote, now, dup.id);
        out.merged++;
        out.entries.push({ id: dup.id, kind, title: dup.title, status: next, merged: true });
        continue;
      }
      const id = newId('m');
      const created = Number(raw?.created) > 0 && Number(raw.created) <= now ? Number(raw.created) : now;
      const note = `${label}${raw?.by ? `; written there by ${clip(raw.by, 80)}` : ''}${created !== now ? ` on ${new Date(created).toISOString().slice(0, 10)}` : ''}`;
      db.prepare(`INSERT INTO memories (id, kind, scope, product, item, title, body, tags, status, by, source, quote, key, created, updated, confirmed, sources, note)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, kind, target ? 'product' : 'studio', target, title, body, tags, status, label, source, quote, key, created, now, now, '[]', note);
      out.added++;
      out.entries.push({ id, kind, title, status, merged: false });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (mode === 'candidates' && out.added) out.notes.push(`${out.added} new entr${out.added === 1 ? 'y waits' : 'ies wait'} as candidates: the daily curation and the PM review them, or confirm them in the Memory tab.`);
  if (out.skipped) out.notes.push(`${out.skipped} skipped (work in progress, unknown kinds or empty titles).`);
  return out;
}

// ------------------------------------------------------------------ Markdown docs

/** A Markdown doc's sections: { title, body } per heading with text under it (code fences kept whole). */
export function sectionsOf(markdown: string, name = 'document') {
  const out: { title: string; body: string }[] = [];
  const stack: string[] = [];
  let title = '';
  let lines: string[] = [];
  let fence = false;
  const flush = () => {
    const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body.replace(/\s+/g, ' ').length >= 20) out.push({ title: title || name, body });
    lines = [];
  };
  for (const line of String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) { lines.push(line); continue; }
    flush();
    const level = h[1].length;
    stack.length = level - 1;
    stack[level - 1] = h[2].replace(/[*_`]/g, '').trim();
    // A sub-section keeps its parent's name ("Characters: Yooba"); the doc's own title (#) isn't repeated.
    const parts = stack.filter(Boolean);
    title = parts.length > 2 ? `${parts[parts.length - 2]}: ${parts[parts.length - 1]}` : parts[parts.length - 1];
  }
  flush();
  return out;
}

/** Whether a doc reads as how a codebase works (AGENTS.md, README) rather than story and world. */
const codeDoc = (name: string) => /agents|readme|claude|contributing|convention|architecture|setup|develop/i.test(name);

/** Imports a Markdown doc: one canon or convention entry per section, as candidates unless mode is 'active'. */
export function importMarkdown({ markdown, name, product, kind, mode = 'candidates', from }: { markdown: string; name?: string; product?: string | null; kind?: string; mode?: ImportMode; from?: string }) {
  const doc = clip(name || 'document', 120);
  const k = kind ? String(kind).toLowerCase() : codeDoc(doc) ? 'convention' : 'canon';
  if (!(EXPORT_KINDS as readonly string[]).includes(k) || k === 'decision') throw new StudioError('A doc imports as canon, convention, lesson or preference (decisions are the owner\'s own words)');
  const sections = sectionsOf(markdown, doc);
  if (!sections.length) throw new StudioError('No sections with text in that doc');
  const bundle: Bundle = {
    format: FORMAT, from: from ? `${doc} (${from})` : doc, product: null, exported: new Date().toISOString(),
    entries: sections.map((s) => ({ kind: k, title: s.title, body: s.body, tags: 'imported-doc', source: doc, quote: null, product: null, created: Date.now() })),
  };
  return { ...importBundle(bundle, { product: product ?? null, mode }), sections: sections.length, kind: k };
}
