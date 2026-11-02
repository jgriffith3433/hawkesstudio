// Studio's own beta signs a playtest in with a signed token (POST /auth/test-session), since Google's button can't run on
// the beta address. Beta lane only, secret set only; never on live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-session-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_LANE = 'beta';
process.env.STUDIO_GOOGLE_CLIENT_ID = '123456-abc.apps.googleusercontent.com';
const { handleAuthRoute } = await import('../src/auth-pages.ts');
const { checkSigninToken } = await import('../src/playtest-signin.ts');

const SECRET = 'tss_unit-test-secret';
function token(over: Record<string, any> = {}, secret = SECRET) {
  const exp = Math.floor(Date.now() / 1000) + 300, nonce = 'abc123', project = 'hawkesstudio';
  const sig = crypto.createHmac('sha256', secret).update(`${project}.${exp}.${nonce}`).digest('base64url');
  return { project, exp, nonce, sig, ...over };
}
function req(body: unknown): http.IncomingMessage {
  const r: any = (async function* () { yield Buffer.from(JSON.stringify(body)); })();
  r.headers = { 'content-type': 'application/json' };
  r.method = 'POST'; r.url = '/auth/test-session'; r.socket = { remoteAddress: '203.0.113.9' };
  return r;
}
function res() {
  const out: any = { status: 0, headers: {} as Record<string, any>, body: '' };
  out.writeHead = (s: number, h: Record<string, any> = {}) => { out.status = s; Object.assign(out.headers, h); return out; };
  out.end = (b?: string) => { out.body += b ?? ''; };
  return out;
}
const post = async (body: unknown) => { const r = res(); await handleAuthRoute(req(body), r, new URL('http://x/auth/test-session')); return r; };

test('checkSigninToken: good, forged, expired, other project', () => {
  checkSigninToken(token(), SECRET, 'hawkesstudio');
  assert.throws(() => checkSigninToken(token({}, 'other'), SECRET, 'hawkesstudio'), /signature/);
  assert.throws(() => checkSigninToken(token({ exp: 5 }), SECRET, 'hawkesstudio'), /expired/);
  assert.throws(() => checkSigninToken(token({ project: 'x' }), SECRET, 'hawkesstudio'), /Not a test/);
});

test('without the secret on the beta lane there is no test sign-in', async () => {
  delete process.env.STUDIO_TEST_SIGNIN_SECRET;
  assert.equal((await post(token())).status, 404);
});

test('with the secret: a valid token gets a session cookie, a forged one is refused', async () => {
  process.env.STUDIO_TEST_SIGNIN_SECRET = SECRET;
  const ok = await post(token());
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['Set-Cookie']), /hawkes_session_beta=/);
  assert.equal((await post(token({}, 'wrong'))).status, 401);
});
