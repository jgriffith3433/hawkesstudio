// Signing in to Studio's MCP from an editor (src/mcp-oauth.ts, the same file as in hawkesgen; J, 2026-10-30: "All of
// our MCPs should authenticate like this, no pasted keys"): Claude, Cursor or VS Code opens Studio, the person signs in
// with Studio's own sign-in (Continue with Google) and allows it; the editor gets an hsm_ token for /mcp.
// Studio's tools act as this Studio's owner (they call its own API on 127.0.0.1), so only who could hold the owner's
// key may connect: in J's Studio the platform admin, in a customer's Studio its admins (mcp-http.ts).

import type { IncomingMessage } from 'node:http';
import { db } from './db.ts';
import { createOAuth } from './mcp-oauth.ts';
import { cookieToken, sessionUser } from './auth.ts';

/**
 * This Studio's address as editors reach it: a customer's Studio is studio.<domain>/o/<org> (the edge Worker says so in
 * X-Forwarded-Prefix). Without it, its sign-in named J's Studio, and an editor signed in to the wrong Studio (2026-10-31).
 */
export function oauthBase(req: IncomingMessage) {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1').split(',')[0].trim();
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  const proto = String(req.headers['x-forwarded-proto'] ?? (local ? 'http' : 'https')).split(',')[0].trim();
  const prefix = String(req.headers['x-forwarded-prefix'] ?? '');
  return `${proto}://${host}${/^\/o\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(prefix) ? prefix : ''}`;
}

export const studioOAuth = createOAuth({
  db,
  name: 'Hawkes Studio',
  prefix: 'hsm',
  base: oauthBase,
  user: (req) => {
    const u = sessionUser(cookieToken(req));
    return u ? { id: u.id, label: u.email } : null;
  },
  signIn: (_req, res, next) => {
    res.writeHead(302, { Location: `/auth/signin?next=${encodeURIComponent(next)}`, 'Cache-Control': 'no-store' });
    res.end();
  },
});
