// Verifies a GitHub Actions OIDC token (the JWT a workflow gets with `permissions: id-token: write`), so a workflow in
// one of J's repos can call Studio with no shared secret: GitHub signs who it is (repository, branch, event).

import crypto from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
let jwks: { at: number; keys: any[] } = { at: 0, keys: [] };

async function keys(force = false) {
  if (!force && jwks.keys.length && Date.now() - jwks.at < 60 * 60_000) return jwks.keys;
  const r = await fetch(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`GitHub's signing keys answered HTTP ${r.status}`);
  jwks = { at: Date.now(), keys: ((await r.json()) as any).keys ?? [] };
  return jwks.keys;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** The token's claims when it is a valid GitHub Actions token for this audience; throws otherwise. */
export async function verifyGitHubOidc(token: string, audience: string): Promise<Record<string, any>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${header.alg}`);
  let jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error('wrong issuer');
  if (![claims.aud].flat().includes(audience)) throw new Error('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new Error('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) throw new Error('not valid yet');
  return claims;
}
