// OAuth 2.1 for MCP clients (Claude, Claude Code, Cursor, VS Code, ChatGPT...): sign in once in the browser, no pasted
// keys (J, 2026-10-30: "All of our MCPs should authenticate like this"). The same file in hawkesgen and hawkesstudio,
// like mcp-core.ts: each product passes its database, its name, its token prefix and its own sign-in.
//
// The flow: the editor finds us (/.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server),
// registers itself (dynamic client registration, /oauth/register), sends the person to /oauth/authorize (signed in with
// the product's own sign-in, then Allow), and swaps the code for tokens with PKCE S256 (/oauth/token). Each approval is a
// connection the person can list and revoke. Secrets are kept only as their sha256.
//   <table>_clients       a registered app: name, redirect_uris
//   <table>_codes         a code for one app and person, five minutes, used once
//   <table>_connections   an approval: user, app, name, created, last_used, revoked
//   <table>_tokens        access (an hour) and refresh (90 days, rotated on use) tokens of a connection

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Db = { exec(sql: string): unknown; prepare(sql: string): { get(...a: any[]): any; all(...a: any[]): any[]; run(...a: any[]): any } };
export type OAuthUser = { id: string; label: string };
export type OAuthHost = {
  db: Db;
  /** Table name prefix (oauth). */
  table?: string;
  /** What the consent page and metadata call the product: "Hawkes Gen", "Hawkes Studio". */
  name: string;
  /** Token prefix: access <prefix>_..., refresh <prefix>r_... (hgm: Gen, hsm: Studio). */
  prefix: string;
  /** The person signed in on this request (the product's own session), or null. */
  user: (req: IncomingMessage) => OAuthUser | null;
  /** Sends the person to sign in, coming back to `next` (a path on this site). */
  signIn: (req: IncomingMessage, res: ServerResponse, next: string) => void;
  /** This site's public origin (default: X-Forwarded-Host / Host with X-Forwarded-Proto). */
  base?: (req: IncomingMessage) => string;
  /** Where the MCP endpoint is (default /mcp). */
  resourcePath?: string;
};
export type Access = { userId: string; connectionId: string; app: string };

const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 24 * 3600;
const CODE_TTL = 5 * 60;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class OAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Where a client may send the code: https, a loopback http port, or an app's own scheme (cursor://, vscode://...). */
export function allowedRedirect(uri: string) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'http:'].includes(u.protocol);
  } catch {
    return false;
  }
}
/** A loopback redirect matches whatever port the app opens this time (RFC 8252); anything else matches exactly. */
export function sameRedirect(registered: string, asked: string) {
  if (registered === asked) return true;
  try {
    const a = new URL(registered), b = new URL(asked);
    return a.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > max) throw new OAuthError('invalid_request', 'The request is too big');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if (String(req.headers['content-type'] ?? '').includes('application/json')) {
    try { return JSON.parse(text); } catch { throw new OAuthError('invalid_request', 'The body is not JSON'); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function createOAuth(h: OAuthHost) {
  const t = h.table ?? 'oauth';
  const resourcePath = h.resourcePath ?? '/mcp';
  h.db.exec(`CREATE TABLE IF NOT EXISTS ${t}_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL)`);
  h.db.exec(`CREATE TABLE IF NOT EXISTS ${t}_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER)`);
  h.db.exec(`CREATE TABLE IF NOT EXISTS ${t}_connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER)`);
  h.db.exec(`CREATE TABLE IF NOT EXISTS ${t}_tokens (hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL)`);

  const base = (req: IncomingMessage) => {
    if (h.base) return h.base(req).replace(/\/+$/, '');
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1').split(',')[0].trim();
    const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
    const proto = String(req.headers['x-forwarded-proto'] ?? (local ? 'http' : 'https')).split(',')[0].trim();
    return `${proto}://${host}`;
  };
  const resource = (req: IncomingMessage) => `${base(req)}${resourcePath}`;

  function protectedResource(req: IncomingMessage) {
    return { resource: resource(req), authorization_servers: [base(req)], bearer_methods_supported: ['header'], resource_name: h.name };
  }
  function authorizationServer(req: IncomingMessage) {
    const b = base(req);
    return {
      issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`, revocation_endpoint: `${b}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    };
  }

  function register(body: any) {
    const uris: string[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(allowedRedirect)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https, loopback http, or an app scheme');
    const name = String(body?.client_name ?? 'An app').slice(0, 80) || 'An app';
    const id = `mcp_${rand(12)}`;
    const now = Date.now();
    h.db.prepare(`INSERT INTO ${t}_clients (id, name, redirect_uris, created) VALUES (?, ?, ?, ?)`).run(id, name, JSON.stringify(uris), now);
    return { client_id: id, client_id_issued_at: Math.floor(now / 1000), client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }

  /** The authorize request, checked: the app, its redirect, PKCE, the resource. Throws why. */
  function authorizeRequest(req: IncomingMessage, q: URLSearchParams) {
    const row = h.db.prepare(`SELECT * FROM ${t}_clients WHERE id = ?`).get(q.get('client_id') ?? '');
    if (!row) throw new OAuthError('invalid_client', `This app is not registered with ${h.name}. Remove it from your editor and add it again.`);
    const redirect = q.get('redirect_uri') ?? '';
    if (!(JSON.parse(row.redirect_uris) as string[]).some((u) => sameRedirect(u, redirect))) throw new OAuthError('invalid_request', "The app's return address doesn't match what it registered");
    if (q.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.get('code_challenge') ?? '')) throw new OAuthError('invalid_request', 'PKCE (S256) is required');
    const asked = q.get('resource')?.replace(/\/+$/, '');
    if (asked && asked !== resource(req) && asked !== base(req)) throw new OAuthError('invalid_target', 'Unknown resource');
    return { client: { id: row.id as string, name: row.name as string }, redirect, state: q.get('state'), challenge: q.get('code_challenge')! };
  }

  function consentPage(req: IncomingMessage, user: OAuthUser, q: URLSearchParams, appName: string) {
    const hidden = [...q.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to ${esc(h.name)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f2ed;color:#1a1915}
@media (prefers-color-scheme:dark){body{background:#141413;color:#ecebe6}.card{background:#1f1e1c!important;border-color:#33312d!important}.muted{color:#a6a39a!important}button.no{color:#ecebe6!important;border-color:#4a4741!important}}
.card{max-width:420px;margin:16px;padding:28px;background:#fff;border:1px solid #e3dfd6;border-radius:10px}h1{font-size:20px;margin:0 0 8px}.muted{color:#6b675e;margin:0 0 20px}
.row{display:flex;gap:10px}button{flex:1;padding:11px 14px;border-radius:6px;font:inherit;font-weight:600;cursor:pointer;border:1px solid transparent}button.yes{background:#1a1915;color:#f4f2ed}button.no{background:transparent;border-color:#cfcabf;color:#1a1915}</style></head>
<body><form class="card" method="post" action="${esc(base(req))}/oauth/authorize"><h1>${esc(appName)} wants to use ${esc(h.name)}</h1>
<p class="muted">Signed in as ${esc(user.label)}. It can do what you can in ${esc(h.name)} through its tools, until you disconnect it.</p>
${hidden}<div class="row"><button class="no" name="action" value="deny" type="submit">Cancel</button><button class="yes" name="action" value="allow" type="submit">Allow</button></div></form></body></html>`;
  }

  function redirectTo(res: ServerResponse, url: string) {
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    res.end();
  }

  function issue(connectionId: string) {
    const access = `${h.prefix}_${rand()}`;
    const refresh = `${h.prefix}r_${rand()}`;
    const now = Date.now();
    const put = h.db.prepare(`INSERT INTO ${t}_tokens (hash, connection_id, kind, expires) VALUES (?, ?, ?, ?)`);
    put.run(sha(access), connectionId, 'access', now + ACCESS_TTL * 1000);
    put.run(sha(refresh), connectionId, 'refresh', now + REFRESH_TTL * 1000);
    h.db.prepare(`DELETE FROM ${t}_tokens WHERE expires < ?`).run(now);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh };
  }

  function token(body: Record<string, any>) {
    const now = Date.now();
    if (body.grant_type === 'authorization_code') {
      const row = h.db.prepare(`SELECT * FROM ${t}_codes WHERE hash = ?`).get(sha(String(body.code ?? '')));
      if (!row || row.used || row.expires < now) throw new OAuthError('invalid_grant', 'The code is invalid, used or expired');
      h.db.prepare(`UPDATE ${t}_codes SET used = ? WHERE hash = ?`).run(now, row.hash);
      if (body.client_id && body.client_id !== row.client_id) throw new OAuthError('invalid_grant', 'The code was made for another app');
      if (body.redirect_uri && body.redirect_uri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
      if (crypto.createHash('sha256').update(String(body.code_verifier ?? '')).digest('base64url') !== row.challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed');
      const app = h.db.prepare(`SELECT name FROM ${t}_clients WHERE id = ?`).get(row.client_id);
      const id = `conn_${rand(9)}`;
      h.db.prepare(`INSERT INTO ${t}_connections (id, user_id, client_id, name, created) VALUES (?, ?, ?, ?, ?)`).run(id, row.user_id, row.client_id, app?.name ?? 'An app', now);
      return issue(id);
    }
    if (body.grant_type === 'refresh_token') {
      const row = h.db.prepare(`SELECT * FROM ${t}_tokens WHERE hash = ?`).get(sha(String(body.refresh_token ?? '')));
      if (!row || row.kind !== 'refresh' || row.expires < now) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired');
      const conn = h.db.prepare(`SELECT * FROM ${t}_connections WHERE id = ?`).get(row.connection_id);
      if (!conn || conn.revoked) throw new OAuthError('invalid_grant', 'This connection was disconnected');
      // Rotated: the old refresh token works once.
      h.db.prepare(`DELETE FROM ${t}_tokens WHERE hash = ?`).run(row.hash);
      return issue(conn.id);
    }
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  function send(res: ServerResponse, status: number, body: unknown, cors = false) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(cors ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {}) });
    res.end(JSON.stringify(body));
  }

  return {
    /** The WWW-Authenticate value for a 401 from the MCP endpoint (tells the editor where to sign in). */
    challenge: (req: IncomingMessage, invalid = false) => `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource${resourcePath}"${invalid ? ', error="invalid_token"' : ''}`,

    /** Whether a bearer is one of ours (by prefix). */
    owns: (token: string) => token.startsWith(`${h.prefix}_`),

    /** An access token's person and connection, or null (expired, revoked, unknown). */
    verify(token: string): Access | null {
      if (!token.startsWith(`${h.prefix}_`)) return null;
      const row = h.db.prepare(`SELECT tk.expires, c.id, c.user_id, c.name, c.revoked, c.last_used FROM ${t}_tokens tk JOIN ${t}_connections c ON c.id = tk.connection_id WHERE tk.hash = ? AND tk.kind = 'access'`).get(sha(token));
      if (!row || row.revoked || row.expires < Date.now()) return null;
      if (!row.last_used || Date.now() - row.last_used > 60_000) h.db.prepare(`UPDATE ${t}_connections SET last_used = ? WHERE id = ?`).run(Date.now(), row.id);
      return { userId: row.user_id, connectionId: row.id, app: row.name };
    },

    /** A person's connections (apps they allowed), newest first. */
    connections: (userId: string) => h.db.prepare(`SELECT id, name, created, last_used FROM ${t}_connections WHERE user_id = ? AND revoked IS NULL ORDER BY created DESC`).all(userId),

    /** Disconnects one of a person's connections: its tokens stop working at once. */
    revoke(userId: string, connectionId: string) {
      const r = h.db.prepare(`UPDATE ${t}_connections SET revoked = ? WHERE id = ? AND user_id = ? AND revoked IS NULL`).run(Date.now(), connectionId, userId);
      h.db.prepare(`DELETE FROM ${t}_tokens WHERE connection_id = ?`).run(connectionId);
      return Number(r.changes ?? 0) > 0;
    },

    /** Handles the OAuth routes; false when the route isn't one of them. */
    async handle(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://x');
      try {
        if (route === '/.well-known/oauth-protected-resource' || route === `/.well-known/oauth-protected-resource${resourcePath}`) {
          if (method === 'OPTIONS') return send(res, 204, {}, true), true;
          return send(res, 200, protectedResource(req), true), true;
        }
        if (route === '/.well-known/oauth-authorization-server' || route === '/.well-known/openid-configuration') {
          if (method === 'OPTIONS') return send(res, 204, {}, true), true;
          return send(res, 200, authorizationServer(req), true), true;
        }
        if (route === '/oauth/register') {
          if (method === 'OPTIONS') return send(res, 204, {}, true), true;
          if (method !== 'POST') return false;
          return send(res, 201, register(await readBody(req)), true), true;
        }
        if (route === '/oauth/token') {
          if (method === 'OPTIONS') return send(res, 204, {}, true), true;
          if (method !== 'POST') return false;
          return send(res, 200, token(await readBody(req)), true), true;
        }
        if (route === '/oauth/revoke') {
          if (method === 'OPTIONS') return send(res, 204, {}, true), true;
          if (method !== 'POST') return false;
          // RFC 7009: revoking a token (access or refresh) ends its connection; an unknown one is fine.
          const body = await readBody(req);
          const row = h.db.prepare(`SELECT connection_id FROM ${t}_tokens WHERE hash = ?`).get(sha(String(body.token ?? '')));
          if (row) {
            h.db.prepare(`UPDATE ${t}_connections SET revoked = ? WHERE id = ?`).run(Date.now(), row.connection_id);
            h.db.prepare(`DELETE FROM ${t}_tokens WHERE connection_id = ?`).run(row.connection_id);
          }
          return send(res, 200, {}, true), true;
        }
        if (route === '/oauth/authorize') {
          if (method === 'GET') {
            const r = authorizeRequest(req, url.searchParams);
            const user = h.user(req);
            if (!user) return h.signIn(req, res, `/oauth/authorize${url.search}`), true;
            // form-action also governs where the form's answer redirects (Chrome): the app's own return address must be in it,
            // or Allow posts, gets its 302 to the app, and the browser stays on this page (2026-10-31, claude.ai).
            const back = new URL(r.redirect);
            const app = /^https?:$/.test(back.protocol) ? back.origin : back.protocol;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${app}; frame-ancestors 'none'` });
            res.end(consentPage(req, user, url.searchParams, r.client.name));
            return true;
          }
          if (method === 'POST') {
            // Same site only: the form is ours (a cross-site post never carries the session anyway).
            const origin = String(req.headers.origin ?? '');
            // The browser's Origin is scheme and host alone: a Studio under a path (/o/<org>) still has this one.
            if (origin && origin !== new URL(base(req)).origin) throw new OAuthError('access_denied', 'That came from another site', 403);
            const body = await readBody(req);
            const q = new URLSearchParams(Object.entries(body).filter(([k]) => k !== 'action').map(([k, v]) => [k, String(v)]));
            const r = authorizeRequest(req, q);
            const user = h.user(req);
            if (!user) return h.signIn(req, res, `/oauth/authorize?${q}`), true;
            const to = new URL(r.redirect);
            if (body.action === 'allow') {
              const code = rand();
              h.db.prepare(`INSERT INTO ${t}_codes (hash, client_id, user_id, redirect_uri, challenge, expires) VALUES (?, ?, ?, ?, ?, ?)`).run(sha(code), r.client.id, user.id, r.redirect, r.challenge, Date.now() + CODE_TTL * 1000);
              to.searchParams.set('code', code);
              to.searchParams.set('iss', base(req));
            } else to.searchParams.set('error', 'access_denied');
            if (r.state) to.searchParams.set('state', r.state);
            return redirectTo(res, to.toString()), true;
          }
        }
        return false;
      } catch (e: any) {
        const err = e instanceof OAuthError ? e : new OAuthError('server_error', String(e?.message ?? e), 500);
        if (route === '/oauth/authorize' && method === 'GET') {
          res.writeHead(err.status, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>${esc(h.name)}</title><p style="font:15px system-ui;margin:40px">${esc(err.message)}</p>`);
          return true;
        }
        return send(res, err.status, { error: err.code, error_description: err.message }, true), true;
      }
    },
  };
}
