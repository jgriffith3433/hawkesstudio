// Projects (J, 2026-10-30: games are "projects", and a project may be a web app with its own server, beta and live, like
// Hawkes Gen): the project's own fields, more than one repository with tasks naming one, bug reports from its pages with
// its report key, playtests signed in through its beta's test sign-in, and the commit its deployed beta or live runs.
// A customer's Studio, scratch data; no network but small stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-projects-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai/o/acme-1a2b';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
delete process.env.STUDIO_PRODUCTS;

const C = await import('../src/config.ts');
const RK = await import('../src/reportkey.ts');
const SI = await import('../src/playtest-signin.ts');
const D = await import('../src/deployed.ts');

const APP = {
  id: 'gen-app', name: 'Gen app', kind: 'app' as const, engine: 'web' as const, live: 'https://app.example.com/', beta: 'https://beta.app.example.com/',
  repo: 'acme/app', repos: [{ repo: 'acme/worker', role: 'gpu worker' }], versionPath: '/v1/health', checks: 'npm ci && npm run typecheck && npm test',
  testSignIn: { url: 'https://beta.app.example.com/v1/users/test-session' }, reportOrigins: ['https://app.example.com'],
};

test("a web app is a project: its kind, repositories, version address, checks, test sign-in and report sites are kept and checked", () => {
  const saved = C.saveProduct(APP);
  assert.equal(saved.kind, 'app');
  assert.deepEqual(saved.repos, [{ repo: 'acme/worker', role: 'gpu worker' }]);
  assert.equal(saved.versionPath, '/v1/health');
  assert.equal(saved.checksCmd, APP.checks);
  assert.throws(() => C.saveProduct({ ...APP, versionPath: 'v1/health' }), /versionPath/);
  assert.throws(() => C.saveProduct({ ...APP, repos: [{ repo: 'not a repo' }] }), /repos/);
  assert.throws(() => C.saveProduct({ ...APP, reportOrigins: ['https://x.example.com/path'] }), /reportOrigins/);
  assert.throws(() => C.saveProduct({ ...APP, kind: 'thing' as any }), /kind/);
  // As a product agents work on: both repositories cloned, its own checks, its beta played where its CI deployed it.
  const p = C.getProduct('gen-app');
  assert.deepEqual(C.addedRepoFolders(), { app: 'acme/app', worker: 'acme/worker' });
  assert.deepEqual(p.repos, [{ repo: 'acme/worker', role: 'gpu worker', folder: 'worker' }]);
  assert.deepEqual(p.checks, [{ dir: 'app', cmd: APP.checks }]);
  assert.equal(p.local.serve, 'remote');
});

test("its pages report bugs with its key, from its own sites only, through the same widget", async () => {
  const info = RK.reportInfo('gen-app');
  assert.match(info.key, /^rk_[\w-]{32}$/);
  assert.equal(info.script, `https://studio.hawkesgen.ai/o/acme-1a2b/r/gen-app.js?k=${info.key}`);
  assert.deepEqual(info.origins, ['https://beta.app.example.com', 'https://app.example.com']);
  const server = http.createServer((req, res) => { void RK.handleReportRoutes(req, res, new URL(req.url!, 'http://x')).then((done) => { if (!done) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const js = await fetch(`${base}/r/gen-app.js?k=${info.key}`);
    assert.equal(js.status, 200);
    const loader = await js.text();
    assert.match(loader, /\/r\/widget\.js/);
    assert.match(loader, /\/r\/gen-app\/report\?k=rk_/, 'the widget posts to this project with its key');
    assert.equal((await fetch(`${base}/r/gen-app.js?k=rk_wrong`)).status, 403);
    assert.equal((await fetch(`${base}/r/widget.js`)).status, 200);
    const post = (origin: string, key = info.key) => fetch(`${base}/r/gen-app/report?k=${key}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'The export button does nothing.', url: 'https://beta.app.example.com/', state: JSON.stringify({ scene: { id: 'sc_9' } }) }) });
    assert.equal((await post('https://evil.example.com')).status, 403, 'only its own sites');
    assert.equal((await post('https://beta.app.example.com', 'rk_nope')).status, 403, 'only with its key');
    const pre = await fetch(`${base}/r/gen-app/report?k=${info.key}`, { method: 'OPTIONS', headers: { origin: 'https://beta.app.example.com' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://beta.app.example.com');
    const ok = await post('https://beta.app.example.com');
    assert.equal(ok.status, 200, await ok.clone().text());
    const { db } = await import('../src/db.ts');
    const f = db.prepare("SELECT * FROM findings WHERE product = 'gen-app' ORDER BY first_seen DESC LIMIT 1").get() as any;
    assert.equal(f.title, 'The export button does nothing.');
    assert.match(JSON.parse(f.report).state, /sc_9/);
  } finally {
    server.close();
  }
});

test("playtests sign in on its beta: a token its secret signs, and the session cookies it answers with", async () => {
  const secret = SI.signinSecret('gen-app');
  assert.match(secret, /^tss_/);
  const t = SI.signinToken('gen-app');
  assert.equal(t.sig, crypto.createHmac('sha256', secret).update(`gen-app.${t.exp}.${t.nonce}`).digest('base64url'), 'the protocol the app checks');
  assert.ok(t.exp > Date.now() / 1000 && t.exp <= Date.now() / 1000 + 300);
  let sent: any = null;
  const fake = (async (url: string, init: any) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response('{}', { status: 200, headers: [['set-cookie', 'hg_session=abc123; HttpOnly; Path=/; SameSite=Lax; Secure'], ['set-cookie', 'old=; Max-Age=0']] });
  }) as unknown as typeof fetch;
  const cookies = await SI.testSignIn(C.getProduct('gen-app'), fake);
  assert.equal(sent.url, APP.testSignIn.url);
  assert.equal(sent.body.project, 'gen-app');
  assert.deepEqual(cookies, [{ name: 'hg_session', value: 'abc123', domain: 'beta.app.example.com', path: '/', httpOnly: true, secure: true }]);
  const refused = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(SI.testSignIn(C.getProduct('gen-app'), refused), /test sign-in answered 401/);
});

test("the commit its deployed beta or live runs, from its version address", async () => {
  const fake = (async (url: string) => {
    if (url === 'https://beta.app.example.com/v1/health') return Response.json({ ok: true, version: '1.11.0', commit: 'ABCDEF1234567890abcdef1234567890abcdef12' });
    return new Response('down', { status: 503 });
  }) as unknown as typeof fetch;
  const d = await D.deployedOf(C.getProduct('gen-app'), 'beta', fake);
  assert.equal(d?.commit, 'abcdef1234567890abcdef1234567890abcdef12');
  assert.equal(d?.version, '1.11.0');
  assert.equal(await D.deployedOf(C.getProduct('gen-app'), 'live', fake), null);
  assert.ok(D.sameCommit('abcdef1', 'abcdef1234567890abcdef1234567890abcdef12'));
  assert.ok(!D.sameCommit('abcdef1', '1234567'));
});

test('a library plays its demo on beta, with real players in one room: playtests keep where "beta" and peers', () => {
  const LIB = { id: 'net-lib', name: 'Net lib', kind: 'app' as const, engine: 'web' as const, live: 'https://github.com/acme/net-lib', repo: 'acme/net-lib',
    builds: [{ id: 'package', tool: 'npm', target: 'web', path: '.', out: 'dist', command: 'npm ci && npm run build', on: ['beta'], playtest: true }] };
  const saved = C.saveProduct({ ...LIB, playtests: [{ scenario: 'smoke', where: 'beta' }, { scenario: 'two-players', where: 'beta', peers: 2 }, { scenario: 'x', where: 'local', peers: 9 }] } as any);
  assert.deepEqual(saved.playtests, [{ scenario: 'smoke', where: 'local' }, { scenario: 'two-players', where: 'local', peers: 2 }, { scenario: 'x', where: 'local', peers: 4 }]);
  // live stays live; one player is no peers field
  assert.deepEqual(C.saveProduct({ ...LIB, playtests: [{ scenario: 'smoke', where: 'live', peers: 1 }] } as any).playtests, [{ scenario: 'smoke', where: 'live' }]);
  // Without a beta there is nowhere to play it
  assert.throws(() => C.saveProduct({ id: 'no-beta', name: 'No beta', engine: 'web', live: 'https://x.example.com', playtests: [{ scenario: 'smoke', where: 'beta' }] } as any), /beta/);
});
