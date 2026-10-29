// An org cell (platform.ts, docs/platform-plan.md 4.4): Studio for one hawkesgen.ai org. The portal's platform token
// signs people in (as a bearer, or exchanged for a session at /auth/platform), only for this cell's org and only when the
// org's plan includes Studio; org owners and admins are admins here, members and viewers members. The cell's games live
// in its own products file, written by onboarding. Tokens are signed with a key made for the test, exactly as the
// portal signs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cell-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_ORG = 'org_aaaaaaaa';
delete process.env.STUDIO_PRODUCTS;
const P = await import('../src/platform.ts');
const A = await import('../src/auth.ts');
const C = await import('../src/config.ts');
const { handleAuthRoute } = await import('../src/auth-pages.ts');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const x = (publicKey.export({ format: 'jwk' }) as any).x as string;
P.setPlatformKeys([{ kty: 'OKP', crv: 'Ed25519', x, kid: 'k1' }]);

const sign = (claims: Record<string, unknown> = {}, key = privateKey) => {
  const now = Math.floor(Date.now() / 1000);
  const full = { iss: P.issuer(), aud: ['hawkesgen', 'hawkesstudio'], org: 'org_aaaaaaaa', user: 'usr_11111111', role: 'owner', plan: 'team', entitlements: { studio: { on: true } }, scopes: ['playtest'], iat: now, exp: now + 600, ...claims };
  const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
};
function req(headers: Record<string, string> = {}, body = '', method = 'GET', url = '/'): http.IncomingMessage {
  const r: any = (async function* () { if (body) yield Buffer.from(body); })();
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
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
const bearer = (t: string) => req({ Authorization: `Bearer ${t}` });

test('a token for this org signs its person in; roles follow the org', () => {
  const owner = A.requester(bearer(sign()));
  assert.equal(owner?.role, 'admin');
  assert.equal(owner?.email, 'usr_11111111@accounts.hawkesgen.ai');
  const member = A.requester(bearer(sign({ user: 'usr_22222222', role: 'member' })));
  assert.equal(member?.role, 'member');
  // The role follows the org's: promoted there, admin here on the next request.
  assert.equal(A.requester(bearer(sign({ user: 'usr_22222222', role: 'admin' })))?.role, 'admin');
});

test('tokens for another org, without Studio, or not the portal\'s are refused', () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  for (const [why, t] of [
    ['another org', sign({ org: 'org_bbbbbbbb' })],
    ['no Studio on the plan', sign({ entitlements: { studio: { on: false } } })],
    ['only for Gen', sign({ aud: ['hawkesgen'] })],
    ['expired', sign({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ['another key', sign({}, other)],
  ] as const) {
    assert.equal(A.requester(bearer(t)), null, why);
  }
});

test('members are refused admin routes, including editing games', () => {
  const m = req({ Authorization: `Bearer ${sign({ user: 'usr_33333333', role: 'member' })}` }, '', 'PUT');
  assert.match(A.memberRefusal(m, '/api/products/my-game', 'PUT') ?? '', /Only an admin/);
  const o = req({ Authorization: `Bearer ${sign()}` }, '', 'PUT');
  assert.equal(A.memberRefusal(o, '/api/products/my-game', 'PUT'), null);
});

test('/auth/platform turns a token into this cell\'s session', async () => {
  const r = res();
  const form = `token=${encodeURIComponent(sign({ user: 'usr_44444444', role: 'admin' }))}&next=%2F%23roadmap`;
  assert.equal(await handleAuthRoute(req({ 'Content-Type': 'application/x-www-form-urlencoded' }, form, 'POST', '/auth/platform'), r, new URL('http://x/auth/platform')), true);
  assert.equal(r.status, 303, r.body);
  assert.equal(r.headers.Location, '/#roadmap');
  const cookie = [].concat(r.headers['Set-Cookie']).join(';');
  const token = /hawkes_session=([^;]*)/.exec(cookie)![1];
  assert.equal(A.sessionUser(token)?.email, 'usr_44444444@accounts.hawkesgen.ai');
  const bad = res();
  await handleAuthRoute(req({ 'Content-Type': 'application/x-www-form-urlencoded' }, `token=${encodeURIComponent(sign({ org: 'org_bbbbbbbb' }))}`, 'POST', '/auth/platform'), bad, new URL('http://x/auth/platform'));
  assert.equal(bad.status, 401);
});

test('a cell\'s games: empty at first, added by onboarding, checked', () => {
  assert.deepEqual(C.loadProducts(), []);
  assert.throws(() => C.saveProduct({ id: 'X!', name: 'x', engine: 'web', live: 'https://a.example' }), /id:/);
  assert.throws(() => C.saveProduct({ id: 'g', name: 'x', engine: 'web', live: 'https://a.example' }), /id:/);
  assert.throws(() => C.saveProduct({ id: 'my-game', name: 'x', engine: 'web', live: 'http://insecure.example' }), /https/);
  assert.throws(() => C.saveProduct({ id: 'my-game', name: 'x', engine: 'web' }), /live|build/);
  const p = C.saveProduct({ id: 'my-game', name: 'My Game', engine: 'web', live: 'https://mygame.example/play', story: 'A knight looks for her cat.', quality: 'Boots, plays, no soft-lock.' });
  assert.deepEqual(p.playtests, [{ scenario: 'smoke', where: 'live' }]);
  assert.equal(C.getProduct('my-game').name, 'My Game');
  assert.match(C.storyOf(C.getProduct('my-game')), /looks for her cat/);
  C.removeProduct('my-game');
  assert.deepEqual(C.loadProducts(), []);
});
