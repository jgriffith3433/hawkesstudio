// /mcp: the Studio MCP tools over Streamable HTTP, for Claude Code anywhere (claude mcp add --transport http) and
// claude.ai connectors. Signing in is OAuth (src/studiooauth.ts, J, 2026-10-30: no pasted keys): with no token the
// answer is a 401 naming where to sign in, the editor opens Studio, and the person signs in and allows it. Only who could
// hold the owner's key may (the tools act as this Studio's owner): J's Studio's platform admin, a customer Studio's
// admins. The pasted key still works: on the server it is STUDIO_MCP_KEY (/etc/hawkes/keys.env, made by deploy/deploy.mjs), sent
// as "Authorization: Bearer hs_..." or in the URL (/mcp/hs_..., for clients that can't send headers). Caddy lets
// these through without the website login. Without STUDIO_MCP_KEY (J's PC), only direct local requests get in.
// docs/cloud.md has the setup.

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveHttp, mcpKey } from './mcp-core.ts';
import { studioMcp } from './mcp-tools.ts';
import { studioAt, waitRun } from './client.ts';
import { PORT } from './config.ts';
import { cellOrg, primeToken, studioRole, verifyPlatformToken } from './platform.ts';
import { oauthBase, studioOAuth } from './studiooauth.ts';
import { getUser } from './auth.ts';
import { customerStudio, platformAdmins } from './tenancy.ts';

/**
 * The Connect page (dashboard/connect.js; J, 2026-10-31: "an easy way for customers to connect to their MCP"):
 *   GET  /api/connect                  this Studio's MCP address and server name, whether you may connect, your editors
 *   POST /api/connect/<id>/revoke      disconnects one of your editors (its tokens stop at once)
 */
export function handleConnectApi(req: IncomingMessage, res: ServerResponse, route: string, userId: string | null) {
  if (route !== '/api/connect' && !route.startsWith('/api/connect/')) return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (!userId) return send(401, { error: 'Sign in first.' }), true;
  if (route === '/api/connect' && req.method === 'GET') {
    const org = process.env.STUDIO_ORG?.trim();
    return send(200, {
      url: `${oauthBase(req)}/mcp`,
      // The name editors list it under: one per Studio, so a person with more than one tells them apart.
      name: customerStudio() && org ? `studio-${org}`.slice(0, 40) : 'hawkesstudio',
      mayConnect: mayConnect(userId),
      connections: studioOAuth.connections(userId),
    }), true;
  }
  const m = /^\/api\/connect\/([\w-]+)\/revoke$/.exec(route);
  if (m && req.method === 'POST') return send(200, { revoked: studioOAuth.revoke(userId, m[1]) }), true;
  return send(404, { error: 'No such call' }), true;
}

/** Whether an editor signed in through OAuth as this person may use Studio's tools (they act as its owner). */
export function mayConnect(userId: string) {
  const u = getUser(userId) as { role?: string; email?: string; google?: unknown } | null;
  if (!u || u.role !== 'admin') return false;
  return customerStudio() || Boolean(u.google && platformAdmins().includes(String(u.email ?? '').toLowerCase()));
}

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
  // In an org cell, the org's owners and admins may also connect with a hawkesgen.ai platform token (platform.ts). Only
  // they: the tools act on this Studio as its owner would, so members use the dashboard.
  let viaPlatform = false;
  if (key && cellOrg() && /^eyJ/.test(key)) {
    await primeToken(key);
    try { viaPlatform = studioRole(verifyPlatformToken(key).role) === 'admin'; } catch { viaPlatform = false; }
  }
  const access = key && studioOAuth.owns(key) ? studioOAuth.verify(key) : null;
  const viaOAuth = Boolean(access && mayConnect(access.userId));
  const ok = viaPlatform || viaOAuth || (expected ? Boolean(key) && !studioOAuth.owns(key!) && same(key!, expected) : direct);
  if (!ok) {
    res.writeHead(access ? 403 : 401, { 'Content-Type': 'application/json', 'WWW-Authenticate': studioOAuth.challenge(req, Boolean(key)), 'Access-Control-Expose-Headers': 'WWW-Authenticate' });
    return void res.end(JSON.stringify({ error: access ? "This account can't use Studio's tools here (its owner's alone)." : key ? 'This sign-in expired or was disconnected: connect again.' : 'Sign in: add this server in your editor and it opens Studio to connect.' }));
  }
  return serveHttp(req, res, mcp);
}
