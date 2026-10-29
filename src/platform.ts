// Platform tokens from hawkesgen.ai (docs/platform-plan.md 4.2, 4.4). Studio runs as one cell per org: a cell is told
// its org (STUDIO_ORG) and trusts the portal's short-lived JWT for that org only: EdDSA, checked against the portal's
// public keys (<portal>/.well-known/jwks.json, cached), audience "hawkesstudio". The token's person becomes a Studio
// user of this cell: the org's owners and admins are admins here, members and viewers are members (auth.ts
// memberRefusal keeps going live, merges, money and users to admins).
//
// Two ways in:
//   - a bearer token (the CLI, the MCP, the portal calling on someone's behalf), checked on every request;
//   - /auth/platform?token=… (a link from hawkesgen.ai's "Open Studio"): the token is exchanged for this cell's own
//     session cookie, so the dashboard works like any sign-in.
// Without STUDIO_ORG (J's Studio as it is today) none of this is on.
//
// The same check as Hawkes Gen's src/platform.ts, kept apart because the two services are separate repos.

import crypto from 'node:crypto';
import type http from 'node:http';

export type PlatformClaims = {
  iss: string; aud: string | string[]; org: string; user: string; project?: string; role: 'owner' | 'admin' | 'member' | 'viewer';
  plan: string; entitlements: Record<string, any>; scopes: string[]; exp: number; iat?: number; nbf?: number;
};
type Jwk = { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string };

const ORG_ID = /^org_[0-9a-f]{8,32}$/;
const ROLES = new Set(['owner', 'admin', 'member', 'viewer']);

/** The org this Studio is the cell of, or null (J's Studio: no platform tokens). */
export const cellOrg = () => {
  const o = process.env.STUDIO_ORG?.trim();
  return o && ORG_ID.test(o) ? o : null;
};

/** The portal this cell trusts: STUDIO_PLATFORM_ISSUER, else hawkesgen.ai (live) or beta.hawkesgen.ai (beta). */
export const issuer = () => (process.env.STUDIO_PLATFORM_ISSUER?.trim() || (process.env.STUDIO_LANE === 'beta' ? 'https://beta.hawkesgen.ai' : 'https://hawkesgen.ai')).replace(/\/+$/, '');

let keys: { iss: string; at: number; jwks: Jwk[] } | null = null;
let fetching: Promise<void> | null = null;
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;

async function fetchKeys(iss: string) {
  try {
    const r = await fetch(`${iss}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { keys?: Jwk[] };
    keys = { iss, at: Date.now(), jwks: (j.keys ?? []).filter((k) => k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && typeof k.kid === 'string') };
  } catch (e) {
    console.error(`[platform] could not read ${iss}/.well-known/jwks.json: ${(e as Error).message}`);
    keys = keys && keys.iss === iss ? { ...keys, at: Date.now() - FRESH_MS + RETRY_MS } : { iss, at: Date.now() - FRESH_MS + RETRY_MS, jwks: [] };
  }
}

const JWT = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;
/** A bearer that is a JWT, else null. */
export function bearerJwt(req: http.IncomingMessage): string | null {
  const t = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  return JWT.test(t) ? t : null;
}

/** Fetches the portal's keys when a token arrives and they're stale or lack its key id (at most every 30 s). The checks
 *  below are synchronous, so the server calls this first. */
export async function primeToken(token: string | null) {
  if (!token || !cellOrg() || !JWT.test(token)) return;
  const iss = issuer();
  let kid = '';
  try { kid = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).kid ?? ''; } catch { return; }
  const stale = !keys || keys.iss !== iss || Date.now() - keys.at > FRESH_MS;
  const unknown = keys && !keys.jwks.some((k) => k.kid === kid) && Date.now() - keys.at > RETRY_MS;
  if (!stale && !unknown) return;
  fetching ??= fetchKeys(iss).finally(() => { fetching = null; });
  await fetching;
}
export const primePlatform = (req: http.IncomingMessage) => primeToken(bearerJwt(req));

/** For tests: use these keys instead of fetching them. */
export function setPlatformKeys(jwks: Jwk[], iss = issuer()) {
  keys = { iss, at: Date.now(), jwks };
}

/** Checks a token for this cell: the portal's key, the issuer, audience "hawkesstudio", the time, and this cell's org.
 *  Throws why. */
export function verifyPlatformToken(token: string, now = Date.now()): PlatformClaims {
  const org = cellOrg();
  if (!org) throw new Error('this Studio is not an org cell');
  const parts = token.split('.');
  let head: any, claims: any;
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('not a JWT');
  }
  if (head?.alg !== 'EdDSA') throw new Error('alg must be EdDSA');
  const iss = issuer();
  const jwk = keys?.iss === iss ? keys.jwks.find((k) => k.kid === head.kid) : undefined;
  if (!jwk) throw new Error('unknown key id');
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
  const sec = Math.floor(now / 1000);
  if (claims.iss !== iss) throw new Error('wrong issuer');
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes('hawkesstudio')) throw new Error('wrong audience');
  if (!(Number(claims.exp) > sec - 30)) throw new Error('expired');
  if (Number(claims.nbf ?? claims.iat ?? 0) > sec + 30) throw new Error('not yet valid');
  if (!ORG_ID.test(String(claims.org)) || !ROLES.has(claims.role) || typeof claims.user !== 'string' || !/^[a-z][a-z0-9]{0,15}_[0-9a-f]{8,32}$/.test(claims.user)) throw new Error('missing claims');
  if (claims.org !== org) throw new Error('a token for another org');
  if (!claims.entitlements?.studio?.on) throw new Error("this org's plan doesn't include Studio");
  return claims as PlatformClaims;
}

/** The Studio role a token's org role gives. */
export const studioRole = (role: PlatformClaims['role']): 'admin' | 'member' => (role === 'owner' || role === 'admin' ? 'admin' : 'member');

/** The email a portal account has in this cell's users table: the account id, so it's stable and never collides with a
 *  real address (the token carries no email). */
export const platformEmail = (user: string) => `${user}@accounts.hawkesgen.ai`;
