// Signing in to Studio's MCP from an editor (studiooauth.ts, mcp-oauth.ts, mcp-http.ts): the 401 that names where to
// sign in, registration, the code with PKCE, and who may connect: J (the platform admin) in his Studio, never an invited
// admin there (the tools act as Studio's owner). A scratch database; Studio's real OAuth routes and /mcp on a small server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-oauth-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_MCP_KEY = 'hs_test_key';
delete process.env.STUDIO_ORG;
delete process.env.STUDIO_CUSTOMER;
delete process.env.STUDIO_SIGNUP;
delete process.env.STUDIO_PLATFORM_ADMINS;
const A = await import('../src/auth.ts');
const { studioOAuth } = await import('../src/studiooauth.ts');
const { handleMcp } = await import('../src/mcp-http.ts');

const server = http.createServer(async (req, res) => {
  const route = new URL(req.url ?? '/', 'http://x').pathname;
  try {
    if (route === '/mcp') return await handleMcp(req, res, route);
    if (!(await studioOAuth.handle(req, res, route))) { res.writeHead(404); res.end(); }
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const j = A.googleUser({ email: 'piercehawkes3@gmail.com', sub: '2000001', name: 'J' });
A.createInvite({ email: 'helper@example.com', role: 'admin', by: j });
const helper = A.googleUser({ email: 'helper@example.com', sub: '2000002' });
const REDIRECT = 'http://127.0.0.1:53682/callback';
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const mcp = (auth?: string, body: unknown = initialize) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.5', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });

/** The whole editor flow for one person: register, allow, swap the code. Returns the access token. */
async function connect(who: typeof j) {
  const reg = (await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }) })).json()) as any;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's' });
  const cookie = `${A.COOKIE}=${A.startSession(who, { via: 'google' }).token}`;
  const page = await (await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } })).text();
  assert.match(page, /Claude Code wants to use Hawkes Studio/);
  const allow = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), action: 'allow' }) });
  const code = new URL(allow.headers.get('location')!).searchParams.get('code')!;
  const t = (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT }) })).json()) as any;
  assert.match(t.access_token, /^hsm_/);
  return t.access_token as string;
}

test('with no sign-in, /mcp answers 401 and names where to sign in', async () => {
  const r = await mcp();
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
  assert.equal(meta.resource_name, 'Hawkes Studio');
});

test('signed out, authorize sends the person to Studio\'s sign-in and back', async () => {
  const reg = (await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Cursor', redirect_uris: [REDIRECT] }) })).json()) as any;
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
  const r = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/auth/signin?next=${encodeURIComponent(`/oauth/authorize?${q}`)}`);
});

test("J connects and gets Studio's tools", async () => {
  const token = await connect(j);
  assert.equal((await mcp(token)).status, 200);
  const r = await mcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const text = await r.text();
  const json = JSON.parse(text.includes('data:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text);
  assert.ok(json.result.tools.some((t: any) => t.name === 'studio_deploy_plan'));
});

test("an invited admin of J's Studio can't use the tools (they act as its owner)", async () => {
  const token = await connect(helper);
  const r = await mcp(token);
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as any).error, /owner's alone/);
});

test('the pasted key still works, and a wrong one does not', async () => {
  assert.equal((await mcp('hs_test_key')).status, 200);
  assert.equal((await mcp('hs_wrong')).status, 401);
});

test("a customer's Studio names its own address in its sign-in (studio.<domain>/o/<org>), never J's Studio", async () => {
  const S = await import('../src/studiooauth.ts');
  const cell: any = { headers: { 'x-forwarded-host': 'studio.hawkesgen.ai', 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/o/acme-1a2b' } };
  assert.equal(S.oauthBase(cell), 'https://studio.hawkesgen.ai/o/acme-1a2b');
  assert.match(studioOAuth.challenge(cell), /resource_metadata="https:\/\/studio\.hawkesgen\.ai\/o\/acme-1a2b\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal(S.oauthBase({ headers: { 'x-forwarded-host': 'studio.hawkesgen.ai', 'x-forwarded-prefix': '/evil/../x' } } as any), 'https://studio.hawkesgen.ai', 'only an org prefix');
  assert.equal(S.oauthBase({ headers: { 'x-forwarded-host': 'studio.hawkesgen.ai' } } as any), 'https://studio.hawkesgen.ai', "J's Studio as before");
});

test("the Connect page: this Studio's MCP address, whether you may connect, your editors, and Disconnect", async () => {
  const { handleConnectApi } = await import('../src/mcp-http.ts');
  const call = (route: string, user: string | null, method = 'GET') => {
    const out: any = { status: 0, body: null };
    out.writeHead = (s: number) => { out.status = s; return out; };
    out.end = (b: string) => { out.body = JSON.parse(b); };
    const req: any = { method, headers: { 'x-forwarded-host': 'studio.hawkesgen.ai', 'x-forwarded-proto': 'https' } };
    handleConnectApi(req, out, route, user);
    return out;
  };
  assert.equal(call('/api/connect', null).status, 401);
  const token = await connect(j);
  const mine = call('/api/connect', j.id);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.url, 'https://studio.hawkesgen.ai/mcp');
  assert.equal(mine.body.name, 'hawkesstudio');
  assert.equal(mine.body.mayConnect, true, 'the platform admin, in J\'s Studio');
  const conn = mine.body.connections.find((x: any) => x.name === 'Claude Code');
  assert.ok(conn, 'the editor just connected is listed');
  assert.equal(call('/api/connect', helper.id).body.mayConnect, false, 'not an admin here');
  assert.equal(call(`/api/connect/${conn.id}/revoke`, helper.id, 'POST').body.revoked, false, "only your own editors");
  assert.equal(call(`/api/connect/${conn.id}/revoke`, j.id, 'POST').body.revoked, true);
  assert.equal((await mcp(token)).status, 401, 'its token stops at once');
  assert.ok(!call('/api/connect', j.id).body.connections.some((x: any) => x.id === conn.id));
});

test("the consent page lets Allow's redirect reach the app (CSP form-action names its return address, nothing else)", async () => {
  const reg = (await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) })).json()) as any;
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's' });
  const cookie = `${A.COOKIE}=${A.startSession(j, { via: 'google' }).token}`;
  const page = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy')!;
  assert.match(csp, /form-action 'self' https:\/\/claude\.ai;/, 'Chrome blocks the redirect to claude.ai otherwise');
  assert.doesNotMatch(csp, /form-action[^;]*\*/);
  const app = (await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Cursor', redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback'] }) })).json()) as any;
  q.set('client_id', app.client_id);
  q.set('redirect_uri', 'cursor://anysphere.cursor-retrieval/oauth/callback');
  assert.match((await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } })).headers.get('content-security-policy')!, /form-action 'self' cursor:;/, 'an app scheme by its scheme');
});

test("a customer's Studio under /o/<org>: the consent form posts to its own address, and its Allow is same-site", async () => {
  const site = { 'x-forwarded-host': 'studio.hawkesgen.ai', 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/o/acme-1a2b' };
  const reg = (await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) })).json()) as any;
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', resource: 'https://studio.hawkesgen.ai/o/acme-1a2b/mcp' });
  const cookie = `${A.COOKIE}=${A.startSession(j, { via: 'google' }).token}`;
  const page = await (await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie, ...site } })).text();
  assert.match(page, /action="https:\/\/studio\.hawkesgen\.ai\/o\/acme-1a2b\/oauth\/authorize"/, 'never the domain root (J\'s Studio)');
  // The browser's Origin is the scheme and host alone.
  const allow = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, ...site, origin: 'https://studio.hawkesgen.ai', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), action: 'allow' }) });
  assert.equal(allow.status, 302, await allow.clone().text());
  const to = new URL(allow.headers.get('location')!);
  assert.equal(to.origin + to.pathname, 'https://claude.ai/api/mcp/auth_callback');
  assert.ok(to.searchParams.get('code'));
  assert.equal(to.searchParams.get('iss'), 'https://studio.hawkesgen.ai/o/acme-1a2b');
  const evil = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, ...site, origin: 'https://evil.example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(q), action: 'allow' }) });
  assert.equal(evil.status, 403, 'another site still refused');
});
