// Who may use Studio when it answers on a public address (Cloud Run, docs/studio-cloudrun.md). On the AWS server Caddy's
// forward_auth stood in front of everything; on Cloud Run nothing does, so server.ts asks gate() before every route.
//
//   Open: the sign-in pages (/auth/*), /api/health, /mcp (its own key, mcp-http.ts), GitHub's hooks (OIDC, server.ts),
//   Stripe's webhook (its signature, billing.ts) and the daily run's endpoint (Cloud Scheduler's OIDC token, checked there).
//   Everyone else needs one of:
//     - a session: Studio's own users (auth.ts), made by the password form or by Continue with Google
//     - Bearer STUDIO_OWNER_KEY: J's CLI and scripts (src/client.ts sends ~/.hawkes/client.json studioKey): J, an admin
//     - in an org cell (STUDIO_ORG, platform.ts): a hawkesgen.ai platform token for this org (the CLI, the MCP), or a
//       session made from one at /auth/platform. requester() (auth.ts) turns either into the account's user here.
//     - Bearer STUDIO_AGENT_KEY: agents' and Talk's Claude Code in their Cloud Run jobs. Never J: sandbox.ts
//       requestUser() calls it 'agent', so the guards (guards.ts) apply exactly as to the sandboxed Linux user.
//   Continue with Google: Google's button gives the page an ID token for STUDIO_GOOGLE_CLIENT_ID; Studio asks Google
//   whether it is real, then signs in the account with Google's permanent id (sub), else that email: one on
//   STUDIO_GOOGLE_EMAILS becomes (or stays) an admin, any other verified email signs in only as a user who already exists
//   (an invite made it), unless STUDIO_SIGNUP says otherwise (tenancy.ts: waitlist, or owner for a customer's own
//   Studio). No mail needed.

import crypto from 'node:crypto';
import type http from 'node:http';
import { googleIdToken } from './gcp.ts';

/** Studio runs on Cloud Run (or is told to act like it: STUDIO_CLOUD=1, for a local run of the cloud setup). */
export const cloudMode = () => Boolean(process.env.K_SERVICE) || process.env.STUDIO_CLOUD === '1';

const bearer = (req: http.IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;

function same(a: string, b: string | undefined) {
  if (!b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/** The request carries J's owner key. */
export const ownerKey = (req: http.IncomingMessage) => { const t = bearer(req); return Boolean(t && same(t, process.env.STUDIO_OWNER_KEY?.trim())); };
/** The request carries the agents' key (a Cloud Run job's Claude Code, through bin/studio-mcp.mjs). */
export const agentKey = (req: http.IncomingMessage) => { const t = bearer(req); return Boolean(t && same(t, process.env.STUDIO_AGENT_KEY?.trim())); };

/**
 * A call Studio makes to itself (its /mcp tools call its own API on 127.0.0.1, as on the AWS server): a loopback
 * connection that came through no proxy. Cloud Run's front end never connects from loopback, and the agents' jobs run on
 * other machines.
 */
export function fromItself(req: http.IncomingMessage) {
  const addr = req.socket?.remoteAddress ?? '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
}

/** The legal page's addresses (dashboard/legal.html). */
export const LEGAL_ROUTES = new Set(['/legal', '/terms', '/privacy', '/refunds']);

/** Paths anyone may reach (each checks its own caller where it needs to). */
export function openRoute(route: string, method: string) {
  if (route.startsWith('/auth/') || route === '/auth') return true;
  if (route === '/api/health' || route === '/mcp' || route.startsWith('/mcp/')) return true;
  // The editors' sign-in to /mcp (studiooauth.ts): discovery, registration and tokens; /oauth/authorize signs in itself.
  if (route.startsWith('/oauth/') || route.startsWith('/.well-known/oauth-') || route === '/.well-known/openid-configuration') return true;
  if (route.startsWith('/api/hooks/') && method === 'POST') return true;
  if (route === '/api/cloud/daily' && method === 'POST') return true;
  if (route === '/api/billing/webhook' && method === 'POST') return true;
  // Customers' Studios (cells.ts): the router's and the cells' calls (their own keys), the central cron (Scheduler's token).
  if (route.startsWith('/api/cells/edge/') || route === '/api/cells/self' || route.startsWith('/api/cells/self/') || route === '/api/cells/broker') return true;
  if (route === '/api/cells/cron' && method === 'POST') return true;
  if (route === '/favicon.ico') return true;
  // GitHub's answer to a sign-in or install (github-routes.ts; J, 2026-10-30: "Just do it right so customers can link
  // their GitHub"): its HMAC-signed state says who and for which Studio, and GitHub's one-time code only works with the
  // app's secret, so it needs no session here (a customer's person has none in J's Studio: the gate sent them round in
  // a loop). Without a state the route checks the session itself (J's own install from the app's page).
  if (route === '/api/github/callback' && method === 'GET') return true;
  // The terms, privacy and refunds page: for anyone, before signing up (server.ts LEGAL).
  if (LEGAL_ROUTES.has(route) && method === 'GET') return true;
  return false;
}

export type Refusal = { status: number; headers: Record<string, string>; body?: unknown };

/** null when the request may go on; otherwise the answer (a redirect to sign in for a page, 401 for the rest). */
export function gate(req: http.IncomingMessage, route: string, method: string, signedIn: (req: http.IncomingMessage) => boolean): Refusal | null {
  if (!cloudMode() || openRoute(route, method)) return null;
  if (ownerKey(req) || agentKey(req) || signedIn(req) || fromItself(req)) return null;
  const page = method === 'GET' && (String(req.headers['sec-fetch-mode'] ?? '') === 'navigate' || /text\/html/.test(String(req.headers.accept ?? '')));
  const next = `${route}${new URL(req.url ?? '/', 'http://x').search}`;
  if (page) return { status: 302, headers: { Location: `/auth/signin?next=${encodeURIComponent(next)}` } };
  return { status: 401, headers: {}, body: { error: 'Sign in first (or send Studio\'s owner key).', signin: '/auth/signin' } };
}

// ------------------------------------------------------------ Continue with Google

/** The emails let in as admins (lower case). */
export const googleEmails = () => String(process.env.STUDIO_GOOGLE_EMAILS ?? '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
/** The client id the sign-in button uses, or null while Google sign-in isn't set up. */
export const googleClientId = () => process.env.STUDIO_GOOGLE_CLIENT_ID?.trim() || null;

/** A Google sign-in, checked: real, for our client, verified. Its permanent id (sub) keys the account (auth.ts
 *  googleUser). Throws a sentence otherwise. */
export async function verifyGoogleProfile(credential: string, check = googleIdToken): Promise<{ email: string; sub: string | null; name: string | null }> {
  const clientId = googleClientId();
  if (!clientId) throw new Error('Google sign-in is not set up on this Studio.');
  const t = await check(credential);
  if (t.aud !== clientId) throw new Error('That sign-in was made for another app.');
  if (!t.email_verified || !t.email) throw new Error('That Google account has no verified email.');
  return { email: t.email, sub: t.sub ?? null, name: t.name ?? null };
}

/** A Google sign-in's email, checked (verifyGoogleProfile). */
export const verifyGoogleSignin = async (credential: string, check = googleIdToken) => (await verifyGoogleProfile(credential, check)).email;

// ------------------------------------------------------------ Cloud Scheduler

/**
 * Whether a call to /api/cloud/daily comes from Cloud Scheduler: an OIDC token Google signed for Studio's address
 * (STUDIO_PUBLIC_URL or the service's own, STUDIO_SCHEDULER_AUDIENCE) as the scheduler's service account
 * (STUDIO_SCHEDULER_SA). J's owner key works too (a run by hand).
 */
export async function schedulerCall(req: http.IncomingMessage, check = googleIdToken): Promise<boolean> {
  if (ownerKey(req)) return true;
  const t = bearer(req);
  const sa = process.env.STUDIO_SCHEDULER_SA?.trim().toLowerCase();
  if (!t || !sa) return false;
  try {
    const c = await check(t);
    const auds = [process.env.STUDIO_SCHEDULER_AUDIENCE, process.env.STUDIO_SERVICE_URL, process.env.STUDIO_PUBLIC_URL].filter(Boolean).map((a) => String(a).replace(/\/+$/, ''));
    return c.email === sa && c.email_verified && auds.some((a) => c.aud === a || c.aud === `${a}/api/cloud/daily`);
  } catch {
    return false;
  }
}
