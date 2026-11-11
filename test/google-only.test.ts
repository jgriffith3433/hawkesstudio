// On the cloud lanes with Google sign-in set up, Studio's sign-in is Google only (J, 2026-10-29: "I don't want to sign
// in with u/p"): the page has no password form and a password POST is refused. STUDIO_PASSWORD_LOGIN=1 brings it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-google-only-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_GOOGLE_CLIENT_ID = '123456-abc.apps.googleusercontent.com';
const { handleAuthRoute, passwordsAllowed } = await import('../src/auth-pages.ts');

function req(method = 'GET', body = '', url = '/auth/signin'): http.IncomingMessage {
  const r: any = (async function* () { if (body) yield Buffer.from(body); })();
  r.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  r.method = method;
  r.url = url;
  r.socket = { remoteAddress: '203.0.113.9' };
  return r;
}
function res() {
  const out: any = { status: 0, headers: {} as Record<string, any>, body: '' };
  out.writeHead = (s: number, h: Record<string, any> = {}) => { out.status = s; Object.assign(out.headers, h); return out; };
  out.end = (b?: string) => { out.body += b ?? ''; };
  return out;
}

test('the sign-in page is Google only; a password POST is refused', async () => {
  assert.equal(passwordsAllowed(), false);
  const page = res();
  await handleAuthRoute(req(), page, new URL('http://x/auth/signin'));
  assert.match(page.body, /accounts\.google\.com\/gsi\/client\?hl=en/);
  // Google's button needs the origin as Referer, or it answers "origin not allowed for the client ID".
  assert.equal(page.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(page.headers['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
  assert.doesNotMatch(page.body, /type="password"/);
  assert.doesNotMatch(page.body, /password instead/);
  const post = res();
  await handleAuthRoute(req('POST', 'email=a%40b.com&password=whatever-123'), post, new URL('http://x/auth/signin'));
  assert.equal(post.status, 410);
  assert.match(post.body, /Sign in with Google/);
});

test('Continue with Google stays English, matches the card, and keeps a 44px full-width tap area', async () => {
  const page = res();
  await handleAuthRoute(req(), page, new URL('http://x/auth/signin'));
  // f_98f714b98705: force English even when the browser is Romanian (hl + locale).
  assert.match(page.body, /gsi\/client\?hl=en/);
  assert.match(page.body, /locale:'en'/);
  assert.match(page.body, /text:'continue_with'/);
  // Theme follows the card (dark → filled_black, light → outline); never a white box on the dark card.
  assert.match(page.body, /theme:dark\?'filled_black':'outline'/);
  assert.match(page.body, /\.g-tap\{[^}]*background:transparent/);
  assert.match(page.body, /#g\{[^}]*background:transparent/);
  // f_f2966d06e2c3: reserved 44px row (no layout jump), full card width, GIS large scaled to 44px.
  assert.match(page.body, /class="g-tap"/);
  assert.match(page.body, /\.g-tap\{[^}]*min-height:44px/);
  assert.match(page.body, /\.g-tap\{[^}]*width:100%/);
  assert.match(page.body, /#g\{[^}]*transform:scale\(1\.1\)/);
  assert.match(page.body, /renderButton\([^)]*width:Math\.min\(400/);
});

test('phone redirect mode: login_uri has no query (Google matches it to a registered redirect URI), next travels in a cookie', async () => {
  const page = res();
  await handleAuthRoute(req(), page, new URL('http://x/auth/signin?next=/talk'));
  // f_33db36348aa3: "?next=" in login_uri made Google answer 400 redirect_uri_mismatch on phones.
  assert.match(page.body, /cfg\.login_uri=location\.origin\+'\/auth\/google';/);
  assert.doesNotMatch(page.body, /login_uri=[^;]*\?/);
  assert.match(page.body, /hs_next=/);
  // Google's POST comes back with no query; the cookie says where to go.
  const post: any = req('POST', 'credential=bad&g_csrf_token=t1', '/auth/google');
  post.headers.origin = 'https://accounts.google.com';
  post.headers.cookie = 'g_csrf_token=t1; hs_next=' + encodeURIComponent('/talk');
  const out = res();
  await handleAuthRoute(post, out, new URL('http://x/auth/google'));
  assert.equal(out.status, 303);
  // bad credential: back to sign-in carrying the cookie's next and the error
  assert.match(String(out.headers.Location), /^\/auth\/signin\?next=%2Ftalk&gerr=/);
});

test('STUDIO_PASSWORD_LOGIN=1 brings the password form back', async () => {
  process.env.STUDIO_PASSWORD_LOGIN = '1';
  try {
    assert.equal(passwordsAllowed(), true);
    const page = res();
    await handleAuthRoute(req(), page, new URL('http://x/auth/signin'));
    assert.match(page.body, /type="password"/);
  } finally {
    delete process.env.STUDIO_PASSWORD_LOGIN;
  }
});
