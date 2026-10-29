// Beta sites on Cloudflare (docs/studio-cloudrun.md, "Beta sites"): who may see them and who may publish them, with one
// Ed25519 key pair per Studio lane and no shared secret.
//
//   - Studio derives its key pair from a secret it already has (STUDIO_SITES_SEED, else STUDIO_OWNER_KEY), so there is
//     nothing new to store. GET /auth/sites-key gives the public half to anyone (the Worker reads it from the lane's
//     Cloud Run address and caches it).
//   - A pass: GET /auth/pass on Studio (signed in) sets a short cookie for .hawkesgen.ai that Studio signed; the Worker
//     checks it on every request to a beta host without asking Studio, so a sleeping Studio is never woken to show a page.
//   - A publish: every write Studio sends the Worker is signed (lane, method, path, time, body), so only that lane's
//     Studio writes under its lane's prefix in R2 (live/ or beta/).
//
// Lanes: live Studio (studio.hawkesgen.ai) publishes https://<sub>.hawkesgen.ai; studio-beta publishes
// https://sb-<sub>.hawkesgen.ai. Their R2 prefixes, cookies and keys are separate, so neither overwrites the other.

import crypto from 'node:crypto';

export type Lane = 'live' | 'beta';
export const laneOf = (env: NodeJS.ProcessEnv = process.env): Lane => (env.STUDIO_LANE === 'beta' ? 'beta' : 'live');

/** The beta site's host for a products.json "previews" subdomain, in this Studio's lane. */
export const siteHost = (sub: string, domain: string, lane: Lane = laneOf()) => `${lane === 'beta' ? 'sb-' : ''}${sub}.${domain}`;

/** The pass cookie's name: one per lane, so signing in to studio-beta never replaces live's pass. */
export const passCookie = (lane: Lane = laneOf()) => (lane === 'beta' ? 'hawkes_pass_beta' : 'hawkes_pass');
/** How long a pass lasts (the Worker sends the browser back to Studio for a new one after that). */
export const PASS_MS = 12 * 3600_000;

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The lane's key pair, or null when this Studio has no secret to derive it from (a local Studio). */
export function siteKeys(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.STUDIO_SITES_SEED?.trim() || env.STUDIO_OWNER_KEY?.trim();
  if (!secret) return null;
  const seed = crypto.createHmac('sha256', secret).update('hawkes beta sites v1').digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const raw = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { priv, publicKey: Buffer.from(raw).toString('base64url') };
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** What a pass signs. The Worker builds the same string (server/beta-sites/src/index.ts passMessage). */
export const passMessage = (lane: Lane, exp: number, user: string) => `pass\n${lane}\n${exp}\n${user}`;
/** What a publish request signs (the Worker: publishMessage). */
export const publishMessage = (lane: Lane, method: string, pathAndQuery: string, ts: number, body: string) => `publish\n${lane}\n${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${body}`;

/** A pass for a signed-in user: v1.<lane>.<exp>.<user, base64url>.<signature>. */
export function makePass(userId: string, { now = Date.now(), lane = laneOf(), keys = siteKeys(), ms = PASS_MS } = {}) {
  if (!keys) throw new Error('beta site passes need STUDIO_SITES_SEED or STUDIO_OWNER_KEY');
  const exp = Math.floor((now + ms) / 1000);
  const sig = crypto.sign(null, Buffer.from(passMessage(lane, exp, userId)), keys.priv).toString('base64url');
  return `v1.${lane}.${exp}.${b64u(userId)}.${sig}`;
}

/**
 * A beta-site pass for a playtest (Gen's playtest.run `cookies`): an hour, user "playtest", for the whole domain, so a
 * playtest of a beta site gets past the sign-in. None where this Studio has no key (a local Studio).
 */
export function playtestCookies(lane: Lane = laneOf(), domain = process.env.STUDIO_COOKIE_DOMAIN ?? 'hawkesgen.ai') {
  const keys = siteKeys();
  if (!keys) return [];
  return [{ name: passCookie(lane), value: makePass('playtest', { lane, keys, ms: 3600_000 }), domain: `.${domain}` }];
}

/** The playtest's cookies param when there is a pass to give (spread into Gen's params). */
export const withPass = () => { const c = playtestCookies(); return c.length ? { cookies: c } : {}; };

/** The signature header of a publish request: <ts>.<signature>. */
export function signPublish(lane: Lane, method: string, pathAndQuery: string, body: string, { now = Date.now(), keys = siteKeys() } = {}) {
  if (!keys) throw new Error('publishing beta sites needs STUDIO_SITES_SEED or STUDIO_OWNER_KEY');
  const ts = Math.floor(now / 1000);
  return `${ts}.${crypto.sign(null, Buffer.from(publishMessage(lane, method, pathAndQuery, ts, body)), keys.priv).toString('base64url')}`;
}

/** The pass cookie (domain-wide: the beta hosts are other subdomains). */
export function passSetCookie(value: string, domain: string, lane: Lane = laneOf()) {
  return [`${passCookie(lane)}=${value}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Domain=${domain}`, `Max-Age=${Math.round(PASS_MS / 1000)}`].join('; ');
}

/**
 * Where /auth/pass may send the browser back to: an https beta host of this lane under the domain (never Studio itself or
 * another service's host). null otherwise.
 */
export function passReturn(next: unknown, domain: string, lane: Lane = laneOf()): string | null {
  try {
    const u = new URL(String(next ?? ''));
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || !host.endsWith(`.${domain}`)) return null;
    const label = host.slice(0, -domain.length - 1);
    if (label.includes('.')) return null;
    if (lane === 'beta' ? !label.startsWith('sb-') : label.startsWith('sb-')) return null;
    if (/^(studio|studio-beta|gen|gen-beta|net|hawkesnet|sites|www)$/.test(label)) return null;
    u.searchParams.delete('__hawkes_pass');
    u.searchParams.set('__hawkes_pass', '1');
    return u.toString();
  } catch {
    return null;
  }
}
