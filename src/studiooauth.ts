// Signing in to Studio's MCP from an editor (src/mcp-oauth.ts, the same file as in hawkesgen; J, 2026-10-30: "All of
// our MCPs should authenticate like this, no pasted keys"): Claude, Cursor or VS Code opens Studio, the person signs in
// with Studio's own sign-in (Continue with Google) and allows it; the editor gets an hsm_ token for /mcp.
// Studio's tools act as this Studio's owner (they call its own API on 127.0.0.1), so only who could hold the owner's
// key may connect: in J's Studio the platform admin, in a customer's Studio its admins (mcp-http.ts).

import { db } from './db.ts';
import { createOAuth } from './mcp-oauth.ts';
import { cookieToken, sessionUser } from './auth.ts';

export const studioOAuth = createOAuth({
  db,
  name: 'Hawkes Studio',
  prefix: 'hsm',
  user: (req) => {
    const u = sessionUser(cookieToken(req));
    return u ? { id: u.id, label: u.email } : null;
  },
  signIn: (_req, res, next) => {
    res.writeHead(302, { Location: `/auth/signin?next=${encodeURIComponent(next)}`, 'Cache-Control': 'no-store' });
    res.end();
  },
});
