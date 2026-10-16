// MCP (Model Context Protocol) for the Hawkes tool tables: JSON-RPC handling shared by the stdio server (src/mcp.ts,
// local Claude Code) and the Streamable HTTP endpoint (/mcp, Claude Code anywhere and claude.ai).
// The same file is in hawkesgen/src/mcp-core.ts and hawkesstudio/src/mcp-core.ts: change both.
//
// Streamable HTTP (spec 2025-06-18), stateless: POST one JSON-RPC message (or a batch) and get the answer as JSON,
// or as an SSE stream when the client accepts text/event-stream (tool calls can run for minutes, so the stream sends a
// comment every 15 s to keep proxies from closing it). There is no server-initiated stream: GET and DELETE are 405.

import readline from 'node:readline';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type McpTool = { name: string; description: string; inputSchema: any; run: (a: any) => Promise<unknown> };
export type McpServer = { name: string; version: string; instructions: string; tools: McpTool[] };

const PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

export const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const str = (description: string) => ({ type: 'string', description });

/** One JSON-RPC message in, its response out (null for notifications and responses, which get none). */
export async function rpc(server: McpServer, msg: any): Promise<any | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  const { id, method, params } = msg;
  if (id === undefined || id === null || !method) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return ok({ protocolVersion: SUPPORTED.has(asked) ? asked : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: server.name, version: server.version }, instructions: server.instructions });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: server.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === 'tools/call') {
      const t = server.tools.find((x) => x.name === params?.name);
      if (!t) return fail(-32602, `Unknown tool ${params?.name}`);
      try {
        const out = await t.run(params.arguments ?? {});
        return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] });
      } catch (e: any) {
        return ok({ isError: true, content: [{ type: 'text', text: e.message ?? String(e) }] });
      }
    }
    return fail(-32601, `No method ${method}`);
  } catch (e: any) {
    return fail(-32603, e.message ?? String(e));
  }
}

/** The stdio transport: one JSON message per line. */
export function serveStdio(server: McpServer) {
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    void rpc(server, msg).then((r) => r && send(r));
  });
}

async function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The Streamable HTTP transport. Call it after authenticating the request. */
export async function serveHttp(req: IncomingMessage, res: ServerResponse, server: McpServer) {
  const method = req.method ?? 'GET';
  if (method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST JSON-RPC messages here (no server-initiated stream)' } }));
  }
  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
  }
  const batch = Array.isArray(body);
  const msgs: any[] = batch ? body : [body];
  if (!msgs.some((m) => m && m.method && m.id !== undefined && m.id !== null)) return void res.writeHead(202).end();

  const answer = async () => {
    const out = (await Promise.all(msgs.map((m) => rpc(server, m)))).filter(Boolean);
    return batch ? out : out[0];
  };
  const sse = /text\/event-stream/.test(String(req.headers.accept ?? '')) && msgs.some((m) => m?.method === 'tools/call');
  if (!sse) {
    const out = await answer();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify(out));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const ping = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  res.on('close', () => clearInterval(ping));
  try {
    const out = await answer();
    if (!res.writableEnded) res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
  } finally {
    clearInterval(ping);
  }
}

/** The bearer token of a request: "Authorization: Bearer <key>", or the last path segment of /mcp/<key>. */
export function mcpKey(req: IncomingMessage, pathname: string): string | null {
  const h = String(req.headers.authorization ?? '');
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const m = /^\/mcp\/([\w-]{16,})\/?$/.exec(pathname);
  return m ? m[1] : null;
}
