// /api/memory: the shared memory over HTTP (the dashboard's Memory tab, the MCP tools, agents through them).
// Who is calling decides what a write may do (memory.ts statusFor): J (the dashboard), Talk or the PM (their MCP
// server sends X-Talk-Conversation), an agent or scout (X-Studio-Agent: its change or scout id), checked against the
// agent sandbox's identity when it runs as its own Linux user (callerOf in sandbox.ts).

import type http from 'node:http';
import { db } from './db.ts';
import { StudioError } from './config.ts';
import * as mem from './memory.ts';
import { requestUser } from './sandbox.ts';
import { requester } from './auth.ts';
import { ownerName } from './owner.ts';

/** Who sent a request. A request from the agent sandbox's Linux user is never J, whatever its headers say. */
export function callerOf(req: http.IncomingMessage): mem.Caller {
  const agent = String(req.headers['x-studio-agent'] ?? '');
  const conv = String(req.headers['x-talk-conversation'] ?? '');
  const sandboxed = requestUser(req) === 'agent';
  if (/^[cx]_[0-9a-f]{12}$/.test(agent)) return { who: agent.startsWith('x_') ? 'scout' : 'agent', id: agent };
  if (/^t_[0-9a-f]{6,32}$/.test(conv)) {
    const c = db.prepare('SELECT kind FROM conversations WHERE id = ?').get(conv) as any;
    if (c) return { who: c.kind === 'pm' ? 'pm' : 'talk', id: conv };
  }
  // Talk at full power has a shell: a call without headers from its user is Talk's, not J's.
  return sandboxed ? { who: 'talk', id: null } : { who: 'J' };
}

type Send = (res: http.ServerResponse, status: number, body: unknown) => void;

/** This Studio's address as other Studios reach it (a customer's cell: its /o/<org> address). */
export const baseOf = (req: http.IncomingMessage) =>
  (process.env.STUDIO_PUBLIC_URL || (req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : `http://${req.headers.host ?? '127.0.0.1'}`)).replace(/\/+$/, '');
const studioName = () => `${ownerName()}'s Studio`;
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { throw new StudioError('That bundle is not JSON'); } };

/**
 * Exports and imports move a project's knowledge in or out of this Studio: an admin's (the dashboard, the owner key)
 * or Talk's and the PM's acting for one. Never an agent's or a scout's, never a member's.
 */
export function transferRefusal(req: http.IncomingMessage, c: mem.Caller) {
  if (c.who === 'agent' || c.who === 'scout') throw new StudioError("Agents don't move memory between Studios: ask the owner or Talk.", 403);
  const u = requester(req);
  if (u && u.role !== 'admin') throw new StudioError(`Only an admin can export or import a project's memory (you're signed in as ${u.email}, a member).`, 403);
}

/** GET /api/memory/export/<token>: another Studio fetching a one-time export link (no sign-in: the token is the check). */
export async function handleExportLink(req: http.IncomingMessage, res: http.ServerResponse, token: string, send: Send) {
  const T = await import('./memory-transfer.ts');
  try {
    const { product, kinds } = T.redeemLink(token);
    return send(res, 200, T.exportBundle({ product: product ?? 'studio', kinds, from: baseOf(req), name: studioName() }));
  } catch (e: any) {
    return send(res, e?.status ?? 500, { error: e?.message ?? String(e) });
  }
}

export async function handleMemory(req: http.IncomingMessage, res: http.ServerResponse, url: URL, send: Send, readJson: (req: http.IncomingMessage) => Promise<any>) {
  const route = url.pathname;
  const method = req.method ?? 'GET';
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const c = callerOf(req);
  if (route === '/api/memory' && method === 'GET') {
    return send(res, 200, { memories: mem.listMemories({ product: q('product'), kind: q('kind'), status: q('status'), q: q('q'), item: q('item'), limit: Number(q('limit')) || 200, scope: q('scope') }), stats: mem.memoryStats(), kinds: mem.KINDS, statuses: mem.STATUSES });
  }
  if (route === '/api/memory' && method === 'POST') {
    const b = await readJson(req);
    return send(res, 200, mem.writeMemory(b, c));
  }
  if (route === '/api/memory/search' && method === 'GET') {
    return send(res, 200, mem.search(String(q('q') ?? ''), { product: q('product'), kind: q('kind'), limit: Number(q('limit')) || 12, runs: q('runs') !== '0', status: q('status') }));
  }
  if (route === '/api/memory/block' && method === 'GET') {
    return send(res, 200, mem.memoryBlock({ product: q('product'), item: q('item'), text: q('text') ?? '', role: (q('role') as any) ?? 'fixer' }));
  }
  if (route === '/api/memory/curation' && method === 'GET') return send(res, 200, mem.curation());
  if (route === '/api/memory/runs' && method === 'GET') {
    return send(res, 200, { runs: q('q') ? mem.searchRuns(String(q('q')), { product: q('product'), limit: Number(q('limit')) || 20 }) : mem.listRuns({ product: q('product'), kind: q('kind'), limit: Number(q('limit')) || 50 }) });
  }
  let m = /^\/api\/memory\/runs\/(ar_[0-9a-f]+)$/.exec(route);
  if (m && method === 'GET') {
    const r = mem.getRun(m[1]);
    return r ? send(res, 200, r) : send(res, 404, { error: 'No such run' });
  }
  // Moving a project's memory between Studios (memory-transfer.ts): admins (and Talk acting for one), never agents.
  if (route === '/api/memory/export' && method === 'GET' && q('product') !== undefined) {
    transferRefusal(req, c);
    const T = await import('./memory-transfer.ts');
    const b = T.exportBundle({ product: q('product'), kinds: q('kinds'), from: baseOf(req), name: studioName() });
    if (q('format') === 'md' || q('format') === 'markdown') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(T.bundleMarkdown(b));
    }
    return send(res, 200, b);
  }
  if (route === '/api/memory/export/link' && method === 'POST') {
    transferRefusal(req, c);
    const b = await readJson(req);
    const T = await import('./memory-transfer.ts');
    return send(res, 200, T.createLink({ product: b.product, kinds: b.kinds, minutes: b.minutes, base: baseOf(req), by: requester(req)?.email ?? mem.callerName(c) }));
  }
  if (route === '/api/memory/import' && method === 'POST') {
    transferRefusal(req, c);
    const b = await readJson(req);
    const mode = b.mode === 'active' ? 'active' : 'candidates';
    // Active entries straight away are an admin's call: from Talk or the PM only with the owner's own words.
    if (mode === 'active' && c.who !== 'J' && !mem.jSaid(c.id, b.quote)) throw new StudioError("Importing as active needs the owner's yes: quote their own words from this conversation (quote), or import as candidates.", 403);
    const T = await import('./memory-transfer.ts');
    if (typeof b.markdown === 'string' && b.markdown.trim()) {
      return send(res, 200, T.importMarkdown({ markdown: b.markdown, name: b.name, product: b.product ?? null, kind: b.kind, mode }));
    }
    let bundle = typeof b.bundle === 'string' ? safeJson(b.bundle) : b.bundle;
    if (!bundle && b.url) bundle = await T.fetchBundle(String(b.url));
    if (!bundle) throw new StudioError('Give a bundle (pasted JSON), an export link (url) or a Markdown doc (markdown)');
    return send(res, 200, T.importBundle(bundle, { product: b.product ?? null, mode }));
  }
  if (route === '/api/memory/export' && method === 'GET') {
    const files = mem.exportMarkdown();
    const f = q('file');
    if (f) {
      if (!files[f]) return send(res, 404, { error: `No file ${f}. Files: ${Object.keys(files).join(', ')}` });
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(files[f]);
    }
    return send(res, 200, { files: Object.keys(files), branch: mem.MEMORY_BRANCH });
  }
  if (route === '/api/memory/publish' && method === 'POST') {
    if (c.who !== 'J' && c.who !== 'pm' && c.who !== 'talk') throw new StudioError('Only J, Talk or the PM publish the memory export', 403);
    return send(res, 200, await mem.publishMemory());
  }
  if (route === '/api/memory/seed' && method === 'POST') {
    if (c.who !== 'J') throw new StudioError('Only J re-imports the seed', 403);
    return send(res, 200, mem.importSeed());
  }
  if (route === '/api/memory/fade' && method === 'POST') return send(res, 200, { faded: mem.fadeUnused() });
  if (route === '/api/memory/curate' && method === 'POST') {
    if (c.who === 'agent' || c.who === 'scout') throw new StudioError('Agents propose; the PM and J curate', 403);
    return send(res, 200, await (await import('./memory-curate.ts')).autoCurate());
  }
  m = /^\/api\/memory\/(m_[0-9a-f]+)(?:\/(merge))?$/.exec(route);
  if (m) {
    if (m[2] === 'merge' && method === 'POST') {
      if (c.who === 'agent' || c.who === 'scout') throw new StudioError('Agents propose; the PM and J curate', 403);
      const b = await readJson(req);
      return send(res, 200, mem.mergeMemories(m[1], String(b.from ?? ''), c));
    }
    if (method === 'GET') {
      const e = mem.getMemory(m[1]);
      if (!e) return send(res, 404, { error: 'No such memory' });
      mem.markUsed([e.id]);
      return send(res, 200, e);
    }
    if (method === 'PATCH') {
      if (c.who === 'agent' || c.who === 'scout') throw new StudioError('Agents propose; the PM and J curate', 403);
      return send(res, 200, mem.updateMemory(m[1], await readJson(req), c));
    }
    if (method === 'DELETE') return send(res, 200, mem.deleteMemory(m[1], c));
  }
  return send(res, 404, { error: `No route ${method} ${route}` });
}
