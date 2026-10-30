// A customer linking their GitHub, end to end, from the control plane's side (J, 2026-10-30: "Just do it right so
// customers can link their GitHub properly"). Everything a customer's Studio asks goes through the real keyed route
// (/api/cells/self/github*, the cell's own key) and every GitHub answer through the real callback route, against a
// stand-in GitHub with two customers' accounts. What GitHub's docs say and this relies on: a sign-in Studio starts
// carries its state back; the sign-in GitHub starts after an install doesn't (so an install is linked by the person's
// GitHub account); redirect_uri is the exact callback; a GitHub App's sign-in only reaches accounts it's installed on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-customer-github-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_MASTER = 'm'.repeat(40);
process.env.STUDIO_PUBLIC_URL = 'https://studio.test';
delete process.env.STUDIO_ORG;
delete process.env.STUDIO_CUSTOMER;
delete process.env.STUDIO_SIGNUP;
delete process.env.GITHUB_TOKEN;

// ------------------------------------------------------------------ the stand-in GitHub: two customers' accounts
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const ACCOUNTS: Record<string, { login: string; installs: number[] }> = { 'c-ana': { login: 'ana', installs: [] }, 'c-bo': { login: 'bo', installs: [] } };
const INSTALLS: Record<number, { account: string; selection: string }> = {};
const tokenOf = (auth: string) => Object.entries(ACCOUNTS).find(([c]) => auth.endsWith(`ghu_${c}`));
const tokenScopes: any[] = [];
const revoked: string[] = [];
const gh = http.createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : null;
  const out = (s: number, o: unknown) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const auth = String(req.headers.authorization ?? '');
  const p = u.pathname;
  if (p === '/login/oauth/access_token') return ACCOUNTS[b.code] ? out(200, { access_token: `ghu_${b.code}`, refresh_token: `ghr_${b.code}`, expires_in: 28800 }) : out(200, { error: 'bad_verification_code' });
  const me = tokenOf(auth);
  if (p === '/user') return me ? out(200, { login: me[1].login }) : out(401, { message: 'Bad credentials' });
  if (p === '/user/installations') return me ? out(200, { installations: me[1].installs.map((id) => ({ id, account: { login: INSTALLS[id].account }, repository_selection: INSTALLS[id].selection })) }) : out(401, {});
  if (p === '/app/installations') return out(200, Object.entries(INSTALLS).map(([id, i]) => ({ id: Number(id), account: { login: i.account, type: 'User' }, repository_selection: i.selection })));
  const t = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p);
  if (t) { tokenScopes.push({ id: Number(t[1]), repositories: b?.repositories }); return out(201, { token: `ghs_${t[1]}_${b?.repositories?.join(',')}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }); }
  // GitHub's revoke of a person's grant: the app's client id and secret (Basic), their token in the body.
  if (p === '/applications/Iv1.x/grant' && req.method === 'DELETE') {
    if (auth !== `Basic ${Buffer.from('Iv1.x:s').toString('base64')}`) return out(401, {});
    revoked.push(b.access_token);
    res.writeHead(204); return res.end();
  }
  out(404, { message: `no ${req.method} ${p}` });
});
await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
const ghBase = `http://127.0.0.1:${(gh.address() as any).port}`;
process.env.GITHUB_API_BASE = ghBase;
process.env.GITHUB_WEB_BASE = ghBase;
test.after(() => gh.close());

fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'github-app.json'), JSON.stringify({ id: 1, slug: 'hawkes-studio', clientId: 'Iv1.x', clientSecret: 's', pem, htmlUrl: 'x', owner: 'piercehawkes' }));

const K = await import('../src/cellkeys.ts');
const C = await import('../src/cells.ts');
const { gate } = await import('../src/cloudauth.ts');
const { handleGithubRoutes } = await import('../src/github-routes.ts');

const orgAna = C.createOrg({ sub: '8000001', email: 'ana@example.com', name: 'Ana' }, 'Ana Games').id;
const orgBo = C.createOrg({ sub: '8000002', email: 'bo@example.com', name: 'Bo' }, 'Bo Games').id;

// A tiny HTTP harness over the real handlers.
function fakeRes() {
  const r: any = { status: 0, headers: {}, body: '', writeHead(s: number, h: any) { r.status = s; r.headers = { ...r.headers, ...h }; }, setHeader(k: string, v: string) { r.headers[k] = v; }, end(b?: string) { r.body = b ?? ''; } };
  return r;
}
const send = (res: any, status: number, body: unknown) => { res.status = status; res.body = JSON.stringify(body); };
const fakeReq = (url: string, headers: Record<string, string> = {}, body: any = null): any => ({ url, method: body === null ? 'GET' : 'POST', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), socket: { remoteAddress: '203.0.113.7' }, _body: body });
const readJson = async (req: any) => req._body ?? {};
/** The cell asking the control plane (its own key), as cellside.ts does. */
async function cellAsks(org: string, what: string, body: any) {
  const res = fakeRes();
  const req = fakeReq(`/api/cells/self/${what}`, { Authorization: `Bearer ${K.deriveKey('cell', org)}`, 'X-Studio-Cell': org, 'Content-Type': 'application/json' }, body);
  assert.equal(await C.handleCellsKeyed(req, res, `/api/cells/self/${what}`, 'POST', send, readJson), true);
  return { status: res.status, body: JSON.parse(res.body) };
}
/** GitHub sending the person's browser back to the control plane's callback: no Studio session, as a customer has none. */
async function githubCallsBack(query: Record<string, string>) {
  const url = new URL(`https://studio.test/api/github/callback?${new URLSearchParams(query)}`);
  assert.equal(gate(fakeReq(url.pathname + url.search, { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' }), url.pathname, 'GET', () => false), null, 'the sign-in gate lets it through');
  const res = fakeRes();
  await handleGithubRoutes(fakeReq(url.pathname + url.search, { Host: 'studio.test' }), res, url.pathname, 'GET', url, send, readJson, null);
  return { status: res.status, body: String(res.body), location: res.headers.Location as string | undefined };
}

test('only GitHub\'s callback is let through the sign-in gate, and only as a GET', () => {
  process.env.STUDIO_CLOUD = '1';
  try {
    const page = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };
    assert.equal(gate(fakeReq('/api/github/callback?code=x', page), '/api/github/callback', 'GET', () => false), null);
    assert.notEqual(gate(fakeReq('/api/github/callback', page), '/api/github/callback', 'POST', () => false), null);
    for (const r of ['/api/github', '/api/github/connect', '/api/github/app/setup', '/api/github/token', '/api/games/new']) {
      assert.notEqual(gate(fakeReq(r, page), r, 'GET', () => false), null, `${r} still needs a session`);
    }
  } finally { delete process.env.STUDIO_CLOUD; }
});

test('Ana: sign in with GitHub from her Studio, then install: linked to her Studio, tokens for her repos only', async () => {
  process.env.STUDIO_CLOUD = '1';
  try {
    // Her Studio asks how GitHub stands for her (u_ana in her Studio): not signed in; the two links.
    let s = await cellAsks(orgAna, 'github', { user: 'u_ana', back: `https://studio.test/o/${orgAna}/` });
    assert.equal(s.status, 200);
    assert.equal(s.body.user, null);
    const connect = new URL(s.body.connect);
    assert.equal(connect.searchParams.get('redirect_uri'), 'https://studio.test/api/github/callback', "the app's exact callback");
    assert.equal(new URL(s.body.install).pathname, '/apps/hawkes-studio/installations/new', "GitHub's documented install page");
    // GitHub sends her back with Studio's state: signed in, pointed at choosing repositories next, back to her Studio.
    let r = await githubCallsBack({ code: 'c-ana', state: connect.searchParams.get('state')! });
    assert.equal(r.status, 200);
    // Signed in, then on by itself to choosing repositories (none yet), with a way back to her Studio.
    assert.match(r.body, /Signed in as ana/);
    assert.ok(r.body.includes('location.replace(') && r.body.includes('/apps/hawkes-studio/installations/new"'), 'on to choosing repositories by itself');
    assert.match(r.body, new RegExp(`href="https://studio.test/o/${orgAna}/"`));
    // She installs on her account (chosen repositories); GitHub's sign-in after the install has no state.
    INSTALLS[11] = { account: 'ana', selection: 'selected' };
    ACCOUNTS['c-ana'].installs.push(11);
    r = await githubCallsBack({ code: 'c-ana', installation_id: '11', setup_action: 'install' });
    assert.match(r.body, /GitHub is connected/);
    assert.match(r.body, /in ana/);
    assert.ok(r.body.includes(`location.replace("https://studio.test/o/${orgAna}/?github=installed")`), 'and back to her Studio by itself');
    // Her Studio now sees her and her installation, and gets a token scoped to one of her repos.
    s = await cellAsks(orgAna, 'github', { user: 'u_ana' });
    assert.equal(s.body.user.login, 'ana');
    assert.deepEqual(s.body.installations.map((i: any) => i.id), [11]);
    assert.equal(s.body.connect, null);
    const t = await cellAsks(orgAna, 'github-token', { repo: 'ana/space-game' });
    assert.equal(t.body.token, 'ghs_11_space-game');
    assert.deepEqual(tokenScopes.at(-1), { id: 11, repositories: ['space-game'] }, 'scoped to that one repo');
    assert.equal((await cellAsks(orgAna, 'github-user', { user: 'u_ana' })).body.login, 'ana', 'her sign-in, for making new repos');
  } finally { delete process.env.STUDIO_CLOUD; }
});

test("Bo installs before signing in: nothing linked until he signs in from his Studio; he can't reach Ana's", async () => {
  INSTALLS[12] = { account: 'bo', selection: 'all' };
  ACCOUNTS['c-bo'].installs.push(12);
  let r = await githubCallsBack({ code: 'c-bo', installation_id: '12', setup_action: 'install' });
  assert.match(r.body, /Installed/);
  assert.match(r.body, /sign in with GitHub from your Studio/);
  assert.deepEqual((await cellAsks(orgBo, 'github', { user: 'u_bo' })).body.installations, [], 'not linked yet');
  // He signs in from his Studio: the install his account can reach is linked by itself.
  const s = await cellAsks(orgBo, 'github', { user: 'u_bo', back: `https://studio.test/o/${orgBo}/` });
  r = await githubCallsBack({ code: 'c-bo', state: new URL(s.body.connect).searchParams.get('state')! });
  assert.match(r.body, /Signed in as bo/);
  assert.ok(r.body.includes(`location.replace("https://studio.test/o/${orgBo}/?github=connected")`), 'already installed: straight back to his Studio');
  const after = await cellAsks(orgBo, 'github', { user: 'u_bo' });
  assert.deepEqual(after.body.installations.map((i: any) => i.id), [12]);
  // Neither reaches the other's repos, and a cell's key opens only its own org.
  assert.equal((await cellAsks(orgBo, 'github-token', { repo: 'ana/space-game' })).body.token, null);
  assert.equal((await cellAsks(orgAna, 'github-token', { repo: 'bo/game' })).body.token, null);
  const res = fakeRes();
  await C.handleCellsKeyed(fakeReq('/api/cells/self/github-token', { Authorization: `Bearer ${K.deriveKey('cell', orgAna)}`, 'X-Studio-Cell': orgBo }, { repo: 'bo/game' }), res, '/api/cells/self/github-token', 'POST', send, readJson);
  assert.equal(res.status, 401, "Ana's key can't speak for Bo's Studio");
});

test('a forged or stale state is refused; a sign-in with no state and no install is refused', async () => {
  for (const q of [{ code: 'c-ana', state: 'forged.state' }, { code: 'c-ana', state: '' }]) {
    const res = fakeRes();
    const url = new URL(`https://studio.test/api/github/callback?${new URLSearchParams(q)}`);
    await handleGithubRoutes(fakeReq(url.pathname + url.search), res, url.pathname, 'GET', url, send, readJson, null);
    assert.equal(res.status, 400);
    assert.match(String(res.body), /That didn&#39;t work|That didn't work/);
    assert.match(String(res.body), /expired or was not made here/);
  }
});

test('disconnecting: the sign-in is forgotten and revoked on GitHub; with installations her Studio stops using the repos', async () => {
  // How it stands: signed in, one install, with its page on GitHub to manage or remove Studio.
  let s = await cellAsks(orgAna, 'github', { user: 'u_ana' });
  assert.equal(s.body.user.login, 'ana');
  assert.equal(s.body.installations[0].manage, `${ghBase}/settings/installations/11`);
  // Disconnect her GitHub sign-in: forgotten here, revoked on GitHub (her own token, the app's credentials).
  let d = await cellAsks(orgAna, 'github-disconnect', { user: 'u_ana' });
  assert.deepEqual({ forgot: d.body.forgot, login: d.body.login, revoked: d.body.revoked, unlinked: d.body.unlinked }, { forgot: true, login: 'ana', revoked: true, unlinked: [] });
  assert.ok(revoked.includes('ghu_c-ana'));
  s = await cellAsks(orgAna, 'github', { user: 'u_ana' });
  assert.equal(s.body.user, null);
  assert.ok(s.body.connect, 'she can sign in again');
  assert.equal((await cellAsks(orgAna, 'github-token', { repo: 'ana/space-game' })).body.token, 'ghs_11_space-game', 'the install still works for her Studio');
  // With installations: her Studio stops using them (still installed on GitHub until she removes it there).
  d = await cellAsks(orgAna, 'github-disconnect', { user: 'u_ana', installations: true });
  assert.deepEqual(d.body.unlinked, ['ana']);
  assert.deepEqual((await cellAsks(orgAna, 'github', { user: 'u_ana' })).body.installations, []);
  assert.equal((await cellAsks(orgAna, 'github-token', { repo: 'ana/space-game' })).body.token, null);
  // Bo's are untouched.
  assert.deepEqual((await cellAsks(orgBo, 'github', { user: 'u_bo' })).body.installations.map((i: any) => i.id), [12]);
});
