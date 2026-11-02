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
  const url = p.testSignIn?.url;
  if (!url) return [];
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signinToken(p.id)), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${p.name}'s test sign-in answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const set = typeof (r.headers as any).getSetCookie === 'function' ? (r.headers as any).getSetCookie() as string[] : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')!] : []);
  const cookies = cookiesOf(set, new URL(url).hostname);
  if (!cookies.length) throw new Error(`${p.name}'s test sign-in answered without a session cookie`);
  return cookies;
}
