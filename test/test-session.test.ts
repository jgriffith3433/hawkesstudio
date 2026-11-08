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

test('without the secret a token from no trusted Studio is refused', async () => {
  delete process.env.STUDIO_TEST_SIGNIN_SECRET;
  assert.equal((await post(token())).status, 401);
});

test('with the secret: a valid token gets a session cookie, a forged one is refused', async () => {
  process.env.STUDIO_TEST_SIGNIN_SECRET = SECRET;
  const ok = await post(token());
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['Set-Cookie']), /hawkes_session_beta=/);
  assert.equal((await post(token({}, 'wrong'))).status, 401);
});

// ---- no secret: the beta asks the Studio that signed the token ----
const S = await import('../src/playtest-signin.ts');

test('a Studio verifies its own token once: forged, expired and reused are refused', () => {
  S.resetSigninNonces();
  const t = S.signinToken('hawkes-studio');
  S.verifyIssued(t);
  assert.throws(() => S.verifyIssued(t), /already used/);
  assert.throws(() => S.verifyIssued({ ...S.signinToken('hawkes-studio'), sig: 'AAAA' }), /signature/);
  const old = S.signinToken('hawkes-studio', Date.now() - 3_600_000);
  assert.throws(() => S.verifyIssued(old), /expired/);
  // A forged token doesn't spend the nonce of a real one.
  const real = S.signinToken('hawkes-studio', Date.now(), 'n1');
  assert.throws(() => S.verifyIssued({ ...real, sig: 'AAAA' }), /signature/);
  S.verifyIssued(real);
});

test('issuers: studio.hawkesgen.ai and its cells only', () => {
  assert.equal(S.allowedIssuer('https://studio.hawkesgen.ai'), 'https://studio.hawkesgen.ai');
  assert.equal(S.allowedIssuer('https://studio.hawkesgen.ai/o/j-studio-4f12/'), 'https://studio.hawkesgen.ai/o/j-studio-4f12');
  assert.equal(S.allowedIssuer('https://evil.example.com'), null);
  assert.equal(S.allowedIssuer('https://studio.hawkesgen.ai.evil.com'), null);
  assert.equal(S.allowedIssuer('http://studio.hawkesgen.ai'), null);
  assert.equal(S.allowedIssuer('https://studio.hawkesgen.ai/api/x'), null);
  assert.equal(S.allowedIssuer('https://user@studio.hawkesgen.ai'), null);
});

function withFetch(f: typeof fetch, run: () => Promise<void>) {
  const real = globalThis.fetch; globalThis.fetch = f;
  return run().finally(() => { globalThis.fetch = real; });
}
const issuerFetch = ((calls: string[]) => (async (url: any, init: any) => {
  calls.push(String(url));
  try { S.verifyIssued(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); } catch { return new Response('{"ok":false}', { status: 401 }); }
}) as typeof fetch);

test('beta without the secret: a token the issuer vouches for signs in; reused, forged, other-origin and non-Studio ones do not', async () => {
  delete process.env.STUDIO_TEST_SIGNIN_SECRET;
  S.resetSigninNonces();
  const calls: string[] = [];
  const mk = (project = 'hawkes-studio', issuer = 'https://studio.hawkesgen.ai') => ({ ...S.signinToken(project), issuer });
  await withFetch(issuerFetch(calls), async () => {
    const t = mk();
    const ok = await post(t);
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers['Set-Cookie']), /hawkes_session_beta=/);
    assert.deepEqual(calls, ['https://studio.hawkesgen.ai/api/signin/verify']);
    assert.equal((await post(t)).status, 401, 'reused');
    assert.equal((await post({ ...mk(), sig: 'AAAA' })).status, 401, 'forged');
    const n = calls.length;
    assert.equal((await post(mk('hawkes-studio', 'https://evil.example.com'))).status, 401, 'wrong origin');
    assert.equal((await post(mk('someone-else'))).status, 401, 'not Studio');
    assert.equal(calls.length, n, 'never asked an untrusted origin');
    assert.equal((await post({ ...S.signinToken('hawkesstudio', Date.now() - 3_600_000), issuer: 'https://studio.hawkesgen.ai' })).status, 401, 'expired');
    assert.equal((await post({ ...mk('hawkesstudio') })).status, 200, 'the old spelling');
  });
});

test('the live lane has no test sign-in, whatever the token', async () => {
  const lane = process.env.STUDIO_LANE;
  delete process.env.STUDIO_LANE;
  try {
    const calls: string[] = [];
    await withFetch(issuerFetch(calls), async () => {
      assert.equal((await post({ ...S.signinToken('hawkes-studio'), issuer: 'https://studio.hawkesgen.ai' })).status, 404);
      assert.equal(calls.length, 0);
    });
  } finally { process.env.STUDIO_LANE = lane; }
});

test('the issuer\'s verify route answers ok or 401 and never a secret', async () => {
  S.resetSigninNonces();
  const { openRoute } = await import('../src/cloudauth.ts');
  assert.equal(openRoute('/api/signin/verify', 'POST'), true);
  assert.equal(openRoute('/api/signin/verify', 'GET'), false);
});

test('Studio\'s own project signs in at studio-beta and plays smoke on desktop and phone', async () => {
  const { asCustomerGame } = await import('../src/config.ts');
  for (const id of ['hawkes-studio', 'hawkesstudio']) {
    const p = asCustomerGame({ id, name: 'Hawkes Studio' } as any);
    assert.equal(p.testSignIn?.url, S.STUDIO_BETA_SIGNIN);
    assert.deepEqual(p.playtests.map((t: any) => [t.scenario, t.where, t.device ?? 'desktop']), [['smoke', 'local', 'desktop'], ['smoke', 'local', 'phone']]);
  }
  assert.equal(asCustomerGame({ id: 'other', name: 'x' } as any).testSignIn, undefined);
});
