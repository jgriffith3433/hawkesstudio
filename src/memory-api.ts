// /api/memory: the shared memory over HTTP (the dashboard's Memory tab, the MCP tools, agents through them).
// Who is calling decides what a write may do (memory.ts statusFor): J (the dashboard), Talk or the PM (their MCP
// server sends X-Talk-Conversation), an agent or scout (X-Studio-Agent: its change or scout id), checked against the
// agent sandbox's identity when it runs as its own Linux user (callerOf in sandbox.ts).

import type http from 'node:http';
import { db } from './db.ts';
import { StudioError } from './config.ts';
import * as mem from './memory.ts';
import { requestUser } from './sandbox.ts';

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
    return send(res, 200, mem.publishMemory());
  }
  if (route === '/api/memory/seed' && method === 'POST') {
    if (c.who !== 'J') throw new StudioError('Only J re-imports the seed', 403);
    return send(res, 200, mem.importSeed());
  }
  if (route === '/api/memory/fade' && method === 'POST') return send(res, 200, { faded: mem.fadeUnused() });
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
