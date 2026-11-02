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
  assert.match(page.body, /accounts\.google\.com\/gsi\/client/);
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
