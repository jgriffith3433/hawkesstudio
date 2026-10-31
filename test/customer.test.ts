// A customer's own Studio (tenancy.ts STUDIO_SIGNUP=owner, docs/studio-customers.md): the first Google account claims it
// and is its admin; its admin runs their own games, users, settings and Claude, but gets 403 on every feature that is
// the platform admin's (lockdown.ts), and nothing reaches them without a platform admin, not even Studio's own calls.
// Claude is only ever the customer's own. Onboarding adds the first game; J's repositories are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { SessionVia, User } from '../src/auth.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-customer-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_SIGNUP = 'owner';
delete process.env.STUDIO_ORG;
delete process.env.STUDIO_PLATFORM_ADMINS;
delete process.env.STUDIO_GOOGLE_EMAILS;
delete process.env.STUDIO_PRODUCTS;
// Ours, on this server: a customer's Studio must never hand these to Claude Code.
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-JsOwnMaxPlanTokenNeverForCustomers';
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-OurOwnKeyNeverForCustomers0000';
const A = await import('../src/auth.ts');
const L = await import('../src/lockdown.ts');
const C = await import('../src/config.ts');
const T = await import('../src/tenancy.ts');
const { handleUsersApi } = await import('../src/auth-pages.ts');

function req(headers: Record<string, string> = {}, method = 'GET'): http.IncomingMessage {
  const r: any = (async function* () {})();
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  r.method = method;
  r.socket = { remoteAddress: '203.0.113.9' };
  return r;
}
const as = (u: User, via: SessionVia = 'google') => (method = 'GET') => req({ Cookie: `${A.COOKIE}=${A.startSession(u, { via }).token}` }, method);

test('the first Google account claims the Studio as its admin; after that it takes an invite', () => {
  assert.ok(T.customerStudio());
  const owner = A.googleUser({ email: 'dev@indie.example', sub: '3000001', name: 'Indie Dev' });
  assert.equal(owner.role, 'admin');
  assert.equal(owner.name, 'Indie Dev');
  assert.throws(() => A.googleUser({ email: 'stranger@example.com', sub: '3000002' }), /no account here/);
  // J has no way in to a customer's Studio without their invite (no silent operator access).
  assert.throws(() => A.googleUser({ email: 'piercehawkes3@gmail.com', sub: '1000001' }), /no account here/);
  A.createInvite({ email: 'artist@indie.example', role: 'member', by: owner });
  assert.equal(A.googleUser({ email: 'artist@indie.example', sub: '3000003' }).role, 'member');
});

const owner = () => A.userByEmail('dev@indie.example')!;

// What is the platform admin's in every Studio, a customer's too.
const PLATFORM_ONLY: [string, string][] = [
  ['GET', '/api/broadcast'], ['POST', '/api/broadcast/live'], ['GET', '/api/social'], ['POST', '/api/social/config'],
  ['GET', '/api/costs'], ['POST', '/api/costs/settings'], ['GET', '/api/ledger'], ['GET', '/api/resources'], ['GET', '/api/brief/cost'],
  ['GET', '/api/self-deploys'], ['GET', '/api/services'], ['POST', '/api/services/restart'],
  ['POST', '/api/memory/seed'], ['GET', '/api/analytics/overview'], ['GET', '/api/videos'], ['POST', '/api/billing/plans'],
  ['POST', '/api/gen/v1/fleet/launch'], ['GET', '/api/gen/v1/settings'], ['GET', '/api/gen/v1/machines'],
];

test('the customer\'s admin gets 403 on every platform feature', () => {
  const me = as(owner());
  for (const [method, route] of PLATFORM_ONLY) assert.match(L.platformRefusal(me(method), route, method) ?? '', /only the platform admin/, `${method} ${route}`);
  assert.match(L.platformRefusal(as(owner(), 'password')('GET'), '/api/costs', 'GET') ?? '', /only the platform admin/);
});

test('nothing without a user reaches them in a customer\'s Studio either (their Talk, agents, MCP key)', () => {
  for (const [method, route] of PLATFORM_ONLY) assert.match(L.platformRefusal(req({}, method), route, method) ?? '', /only the platform admin/, `${method} ${route}`);
});

test('the customer\'s admin keeps their own: their games, going live with them, settings, users, their Claude', () => {
  const me = as(owner());
  for (const [method, route] of [['POST', '/api/deploy/my-game'], ['POST', '/api/rollback/my-game'], ['POST', '/api/settings'], ['GET', '/api/users'], ['POST', '/api/users/invite'],
    ['POST', '/api/claude/key'], ['GET', '/api/claude/accounts'], ['PUT', '/api/products/my-game'], ['POST', '/api/agents/settings'], ['POST', '/api/approvals/a_0123456789ab/approve'],
    ['POST', '/api/billing/checkout'], ['POST', '/api/billing/cancel'], ['POST', '/api/billing/portal']]) {
    assert.equal(L.platformRefusal(me(method), route, method), null, `${method} ${route}`);
  }
  // Their members are still members (auth.ts memberRefusal).
  const artist = as(A.userByEmail('artist@indie.example')!);
  assert.match(A.memberRefusal(artist('POST'), '/api/claude/key', 'POST') ?? '', /Only an admin/);
  assert.match(A.memberRefusal(artist('POST'), '/api/deploy/my-game', 'POST') ?? '', /Only an admin/);
  assert.match(A.memberRefusal(artist('POST'), '/api/billing/checkout', 'POST') ?? '', /Only an admin/);
});

test('onboarding: /api/me opens it for the admin of a Studio with no game; the first game is theirs, never J\'s repos', async () => {
  const me = async (r: http.IncomingMessage) => {
    const out: any = { body: '' };
    out.writeHead = () => out;
    out.end = (b?: string) => { out.body += b ?? ''; };
    await handleUsersApi(r, out, new URL('http://x/api/me'));
    return JSON.parse(out.body);
  };
  const before = await me(as(owner())());
  assert.equal(before.customer, true);
  assert.equal(before.onboarding, true);
  assert.equal(before.signup, 'owner');
  assert.equal(before.claude.ready, false);
  for (const tab of ['costs', 'resources', 'social', 'onair']) assert.ok(before.hide.includes(tab), tab);
  assert.ok(!before.hide.includes('users'), 'their own users are theirs');
  // One of J's repos only with this Studio's own GitHub App installation on it (none here: no control plane).
  await assert.rejects(C.checkRepoOwnership({ repo: 'https://github.com/jgriffith3433/doseofdestructionwebsite' } as any), /isn't installed for this Studio/);
  await assert.rejects(C.checkRepoOwnership({ repo: 'indie/x', repos: [{ repo: 'jgriffith3433/hawkesgen' }] } as any), /jgriffith3433\/hawkesgen/);
  await C.checkRepoOwnership({ repo: 'indie/my-game' } as any);
  C.saveProduct({ id: 'my-game', name: 'My Game', engine: 'web', live: 'https://my-game.example', repo: 'indie/my-game' } as any);
  assert.deepEqual(C.loadProducts().map((p) => p.id), ['my-game']);
  assert.equal((await me(as(owner())())).onboarding, false);
});

test('Claude in a customer\'s Studio is only ever theirs: never this server\'s token or key', async () => {
  const cl = await import('../src/claude.ts');
  let env = cl.claudeEnv();
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(cl.customerClaude().ready, false);
  assert.throws(() => cl.setCustomerKey('not-a-key'), /not an Anthropic API key/);
  cl.setCustomerKey('sk-ant-api03-TheCustomersOwnKey0123456789');
  env = cl.claudeEnv();
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api03-TheCustomersOwnKey0123456789');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(cl.customerClaude(), { ready: true, via: 'api-key', keyTail: '6789' });
  const accounts = (await import('../src/claude-accounts.ts')).listAccounts();
  assert.equal(accounts.accounts.length, 0, 'the server\'s token is never adopted as an account');
  cl.setCustomerKey(null);
  assert.equal(cl.customerClaude().ready, false);
});
