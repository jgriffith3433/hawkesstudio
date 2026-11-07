// Playtests of an app you have to sign in to (J, 2026-10-30: Studio playing a web app like Hawkes Gen, where almost
// everything is behind Continue with Google). A project names its beta's test sign-in (Product.testSignIn.url). Before a
// beta playtest, Studio posts it a short-lived token signed with the project's own secret:
//   POST <url>  { "project": "<id>", "exp": <unix seconds>, "nonce": "<hex>", "sig": "<base64url HMAC-SHA256(secret, `${project}.${exp}.${nonce}`)>" }
// The app checks the signature and the expiry (a few minutes), signs in a throwaway test account (its own, never a real
// person's; on its beta only) and answers with that session's Set-Cookie. Studio hands those cookies to the playtest's
// browser (Gen playtest.run `cookies`). The secret is the project's alone (derived from this Studio's secret and the id);
// the project's admins read it once to put in their beta's settings (GET /api/projects/<id>/signin).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, getProduct, type Product } from './config.ts';
import { db } from './db.ts';

const KEY_FILE = () => path.join(DATA, 'signin.key');
let master: Buffer | null = null;
function key() {
  if (master) return master;
  try { master = Buffer.from(fs.readFileSync(KEY_FILE(), 'utf8').trim(), 'hex'); } catch { /* made below */ }
  if (!master || master.length < 32) {
    master = crypto.randomBytes(32);
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(KEY_FILE(), master.toString('hex'), { mode: 0o600 });
  }
  return master;
}
export const resetSigninKeys = () => { master = null; };

/** A project's test sign-in secret (what its beta checks Studio's tokens with). */
export const signinSecret = (project: string) => `tss_${crypto.createHmac('sha256', key()).update(`signin:${project}`).digest('base64url')}`;

/** A token for one test sign-in, good for five minutes. Exported for the tests and for apps' own checkers. */
export function signinToken(project: string, now = Date.now(), nonce = crypto.randomBytes(12).toString('hex')) {
  const exp = Math.floor(now / 1000) + 300;
  const sig = crypto.createHmac('sha256', signinSecret(project)).update(`${project}.${exp}.${nonce}`).digest('base64url');
  return { project, exp, nonce, sig };
}

/** What a project's admins need to set it up (the secret, the protocol in a line). */
export function signinInfo(projectId: string) {
  const p = getProduct(projectId);
  return {
    project: p.id, url: p.testSignIn?.url ?? null, secret: signinSecret(p.id),
    how: 'Studio POSTs {project, exp, nonce, sig} (sig = base64url HMAC-SHA256(secret, `${project}.${exp}.${nonce}`), exp in unix seconds, five minutes ahead) to your beta\'s test sign-in; check it, sign in a test account (never a real person\'s, never on live) and answer with its Set-Cookie.',
  };
}

/**
 * The app's side of the protocol, for Studio's own beta (auth-pages.ts POST /auth/test-session): whether a posted body is a
 * token signed with `secret` (the one the owner copies from `studio_project signin`) and still fresh. Throws a sentence.
 */
export function checkSigninToken(body: any, secret: string, project: string, now = Date.now()) {
  const { exp, nonce, sig } = body ?? {};
  if (body?.project !== project || typeof nonce !== 'string' || typeof sig !== 'string' || !Number.isFinite(exp)) throw new Error('Not a test sign-in token.');
  const nowS = Math.floor(now / 1000);
  if (exp < nowS || exp > nowS + 600) throw new Error('That test sign-in token has expired.');
  const want = crypto.createHmac('sha256', secret).update(`${project}.${exp}.${nonce}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error('Bad test sign-in signature.');
}

/** Studio's own project id, in both spellings it has been given (the project is "hawkes-studio", the old default "hawkesstudio"). */
export const STUDIO_PROJECT_IDS = ['hawkes-studio', 'hawkesstudio'];
export const isStudioProject = (id: unknown) => typeof id === 'string' && STUDIO_PROJECT_IDS.includes(id);
/** Where Studio's beta playtests sign in, unless the project says otherwise. */
export const STUDIO_BETA_SIGNIN = 'https://studio-beta.hawkesgen.ai/auth/test-session';

// No secret to copy (J: customers never touch config): the beta asks the Studio that signed the token. Which Studios it
// asks is a setting (Settings → signin), by default Hawkes Studio and its cells (studio.hawkesgen.ai/o/<org>).
export const DEFAULT_ISSUERS = ['https://studio.hawkesgen.ai'];
export function signinSettings(): { issuers: string[] } {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'signin'`).get() as { value: string } | undefined;
  let v: any = {};
  try { v = r ? JSON.parse(r.value) : {}; } catch { /* defaults */ }
  return { issuers: Array.isArray(v?.issuers) && v.issuers.length ? v.issuers.map(String) : DEFAULT_ISSUERS };
}
export function saveSigninSettings(patch: Record<string, any>, by = 'J') {
  const next = signinSettings();
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k !== 'issuers') throw new Error(`signin.${k}: not a setting (issuers)`);
    if (!Array.isArray(v) || !v.length) throw new Error('signin.issuers: a list of https origins');
    next.issuers = v.map((o) => {
      let u: URL;
      try { u = new URL(String(o)); } catch { throw new Error(`signin.issuers: "${o}" is not an address`); }
      if (u.protocol !== 'https:') throw new Error('signin.issuers: https origins only');
      return u.origin;
    });
  }
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('signin', JSON.stringify(next), Date.now(), by);
  return next;
}

/** An issuer address we may ask: an allowlisted origin, at its root or one customer cell (/o/<org>). Returns its base or null. */
export function allowedIssuer(issuer: unknown, issuers = signinSettings().issuers): string | null {
  let u: URL;
  try { u = new URL(String(issuer)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (!issuers.some((o) => { try { return new URL(o).origin === u.origin; } catch { return false; } })) return null;
  if (!/^(\/|\/o\/[a-z0-9-]{1,60}\/?)$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** This Studio's address as a beta reaches it: the token's `issuer`. */
export const issuerBase = () => (process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.ai').replace(/\/+$/, '');

// One-time nonces (issuer side). In memory: a token lives five minutes, and a restart that forgets one still leaves it expired.
const seen = new Map<string, number>();
export const resetSigninNonces = () => seen.clear();

/**
 * The issuer's side: is this token one this Studio signed, fresh, and not used before? Throws a sentence. Returns nothing
 * (and never the secret). The nonce is spent only by a token whose signature is right.
 */
export function verifyIssued(body: any, now = Date.now()) {
  const { project, exp, nonce, sig } = body ?? {};
  if (typeof project !== 'string' || !project || typeof nonce !== 'string' || !nonce || nonce.length > 100 || typeof sig !== 'string' || !Number.isFinite(exp)) throw new Error('Not a test sign-in token.');
  const nowS = Math.floor(now / 1000);
  for (const [n, e] of seen) if (e < nowS) seen.delete(n);
  if (exp < nowS || exp > nowS + 600) throw new Error('That test sign-in token has expired.');
  const want = crypto.createHmac('sha256', signinSecret(project)).update(`${project}.${exp}.${nonce}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error('Bad test sign-in signature.');
  const k = `${project}.${nonce}`;
  if (seen.has(k)) throw new Error('That test sign-in token was already used.');
  seen.set(k, exp);
}

/** The beta's side without a secret: ask the allowlisted Studio that signed the token. Throws a sentence. */
export async function verifyViaIssuer(body: any, now = Date.now(), fetchImpl: typeof fetch = fetch) {
  const base = allowedIssuer(body?.issuer);
  if (!base) throw new Error('That test sign-in token comes from a Studio this one does not trust.');
  if (!isStudioProject(body?.project)) throw new Error('Not a test sign-in token.');
  const { exp } = body, nowS = Math.floor(now / 1000);
  if (!Number.isFinite(exp) || exp < nowS || exp > nowS + 600) throw new Error('That test sign-in token has expired.');
  const { project, nonce, sig } = body;
  let r: Response;
  try {
    r = await fetchImpl(`${base}/api/signin/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, exp, nonce, sig }), redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch (e: any) { throw new Error(`Could not reach the Studio that signed the token: ${e.message ?? e}`); }
  if (!r.ok) throw new Error(`The Studio that signed the token refused it (${r.status}).`);
  const j = await r.json().catch(() => null) as any;
  if (j?.ok !== true) throw new Error('The Studio that signed the token refused it.');
}

type Cookie ={ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean };

/** Set-Cookie lines as the playtest browser's cookies, for the sign-in's host. */
export function cookiesOf(setCookies: string[], host: string): Cookie[] {
  const out: Cookie[] = [];
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const c: Cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: host, path: '/' };
    for (const a of attrs) {
      const [k, v] = a.split('=');
      const lk = k.toLowerCase();
      if (lk === 'domain' && v) c.domain = v.startsWith('.') ? v : `.${v}`;
      if (lk === 'path' && v) c.path = v;
      if (lk === 'secure') c.secure = true;
      if (lk === 'httponly') c.httpOnly = true;
      if (lk === 'max-age' && Number(v) <= 0) c.value = '';
    }
    if (c.value) out.push(c);
  }
  return out;
}

/**
 * Signs a test account in on a project's beta for a playtest: its session cookies, or [] when the project has no test
 * sign-in. Fails loudly (the playtest would only see the sign-in page), with what the app said.
 */
export async function testSignIn(p: Product, fetchImpl: typeof fetch = fetch): Promise<Cookie[]> {
  const url = p.testSignIn?.url ?? (isStudioProject(p.id) ? STUDIO_BETA_SIGNIN : undefined);
  if (!url) return [];
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...signinToken(p.id), issuer: issuerBase() }), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${p.name}'s test sign-in answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const set = typeof (r.headers as any).getSetCookie === 'function' ? (r.headers as any).getSetCookie() as string[] : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')!] : []);
  const cookies = cookiesOf(set, new URL(url).hostname);
  if (!cookies.length) throw new Error(`${p.name}'s test sign-in answered without a session cookie`);
  return cookies;
}
