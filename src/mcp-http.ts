// /mcp: the Studio MCP tools over Streamable HTTP, for Claude Code anywhere (claude mcp add --transport http) and
// claude.ai connectors. On the server the key is STUDIO_MCP_KEY (/etc/hawkes/keys.env, made by deploy/deploy.mjs), sent
// as "Authorization: Bearer hs_..." or in the URL (/mcp/hs_..., for clients that can't send headers). Caddy lets
// these through without the website login. Without STUDIO_MCP_KEY (J's PC), only direct local requests get in.
// docs/cloud.md has the setup.

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveHttp, mcpKey } from './mcp-core.ts';
import { studioMcp } from './mcp-tools.ts';
import { studioAt, waitRun } from './client.ts';
import { PORT } from './config.ts';

// The tools call this service directly (never the cloud address from ~/.hawkes/client.json).
const local = studioAt(`http://127.0.0.1:${PORT}`);
const mcp = studioMcp({ studio: local, waitRun: (id, onStep, timeoutMs) => waitRun(id, onStep, timeoutMs, local) });

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export async function handleMcp(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const expected = process.env.STUDIO_MCP_KEY ?? '';
  const key = mcpKey(req, pathname);
  const addr = req.socket.remoteAddress ?? '';
  const direct = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr) && !req.headers['x-forwarded-for'];
  const ok = expected ? Boolean(key) && same(key!, expected) : direct;
  if (!ok) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="hawkesstudio"' });
    return void res.end(JSON.stringify({ error: expected ? 'Send the Studio MCP key: Authorization: Bearer hs_...' : 'The Studio MCP key (STUDIO_MCP_KEY) is not set up here' }));
  }
  return serveHttp(req, res, mcp);
}
