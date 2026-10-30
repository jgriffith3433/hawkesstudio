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
