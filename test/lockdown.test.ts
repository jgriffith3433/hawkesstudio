// The platform admin's lockdown in J's Studio (lockdown.ts, docs/studio-customers.md): Studio's `admin` role is not
// enough for J's machinery. Only a Google sign-in with an email on STUDIO_PLATFORM_ADMINS (or J's owner key) passes; an
// invited admin, J's own password sign-in and everyone else get 403. Also: Google accounts keyed by Google's sub, and
// the waitlist. A customer's Studio is test/customer.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { SessionVia, User } from '../src/auth.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lockdown-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_OWNER_KEY = 'owner-key-for-the-test';
delete process.env.STUDIO_ORG;
delete process.env.STUDIO_SIGNUP;
delete process.env.STUDIO_CUSTOMER;
delete process.env.STUDIO_PLATFORM_ADMINS;
delete process.env.STUDIO_GOOGLE_EMAILS;
delete process.env.STUDIO_PRODUCTS;
const A = await import('../src/auth.ts');
const L = await import('../src/lockdown.ts');
const { handleUsersApi } = await import('../src/auth-pages.ts');

function req(headers: Record<string, string> = {}, method = 'GET'): http.IncomingMessage {
  const r: any = (async function* () {})();
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  r.method = method;
  r.socket = { remoteAddress: '203.0.113.9' };
  return r;
}
const as = (u: User, via: SessionVia) => (method = 'GET') => req({ Cookie: `${A.COOKIE}=${A.startSession(u, { via }).token}` }, method);

const j = A.googleUser({ email: 'PierceHawkes3@gmail.com', sub: '1000001', name: 'J' });
A.createInvite({ email: 'helper@example.com', role: 'admin', by: j });
const helper = A.googleUser({ email: 'helper@example.com', sub: '1000002' });
const jGoogle = as(j, 'google');
const helperGoogle = as(helper, 'google');

// Every feature that is J's alone, as the route and method the dashboard, CLI or MCP use.
// (Going live and rolling back a product are an admin's, not J's alone: J, 2026-10-30; the test below.)
const J_ONLY: [string, string][] = [
  ['POST', '/api/approvals/a_0123456789ab/approve'], ['POST', '/api/changes/c_0123456789ab/approve'],
  ['POST', '/api/claude/signin'], ['GET', '/api/claude/accounts'], ['POST', '/api/antigravity/signin'], ['GET', '/api/antigravity/login'],
  ['GET', '/api/broadcast'], ['POST', '/api/broadcast/live'], ['POST', '/api/broadcast/desk'],
  ['GET', '/api/social'], ['POST', '/api/social/config'], ['POST', '/api/social/disconnect/youtube'],
  ['GET', '/api/costs'], ['POST', '/api/costs/settings'], ['GET', '/api/ledger'], ['GET', '/api/resources'], ['GET', '/api/brief/cost'],
  ['GET', '/api/self-deploys'], ['GET', '/api/services'], ['POST', '/api/services/restart'],
  ['GET', '/api/users'], ['POST', '/api/users/invite'], ['POST', '/api/invites/inv_0123456789ab/revoke'], ['GET', '/api/signups'],
  ['POST', '/api/settings'], ['POST', '/api/agents/settings'], ['POST', '/api/pm/settings'], ['POST', '/api/notify'],
  ['POST', '/api/memory/seed'], ['PUT', '/api/products/doseofdestruction'], ['POST', '/api/billing/plans'], ['POST', '/api/billing/checkout'],
  ['POST', '/api/gen/v1/fleet/launch'], ['GET', '/api/gen/v1/settings'], ['POST', '/api/gen/v1/jobs'],
];

test('J signs in with Google as an admin (a platform admin is let in like STUDIO_GOOGLE_EMAILS)', () => {
  assert.equal(j.role, 'admin');
  assert.equal(j.email, 'piercehawkes3@gmail.com');
  assert.ok(j.google);
  assert.equal(helper.role, 'admin', 'the invite made an admin of this Studio');
});

test('an admin of J\'s Studio who is not the platform admin gets 403 on every J-only feature', () => {
  for (const [method, route] of J_ONLY) {
    assert.match(L.platformRefusal(helperGoogle(method), route, method) ?? '', /only the platform admin/, `${method} ${route}`);
    assert.equal(A.memberRefusal(helperGoogle(method), route, method), null, 'they are an admin by role');
  }
  assert.match(L.infraRefusal(helperGoogle('POST'), 'hawkesstudio') ?? '', /Changing Hawkes Studio/);
  assert.match(L.infraRefusal(helperGoogle('POST'), 'hawkesgen') ?? '', /Changing Hawkes Studio/);
  assert.equal(L.infraRefusal(helperGoogle('POST'), 'doseofdestruction'), null, 'a game agent is not infra');
});

test('J with Google, and J\'s owner key, pass; J with a password session does not', () => {
  const owner = (method: string) => req({ Authorization: 'Bearer owner-key-for-the-test' }, method);
  const jPassword = as(j, 'password');
  for (const [method, route] of J_ONLY) {
    assert.equal(L.platformRefusal(jGoogle(method), route, method), null, `${method} ${route}`);
    assert.equal(L.platformRefusal(owner(method), route, method), null, `${method} ${route} (owner key)`);
    assert.match(L.platformRefusal(jPassword(method), route, method) ?? '', /only the platform admin/, `${method} ${route} (password)`);
  }
  assert.equal(L.infraRefusal(jGoogle('POST'), 'hawkesstudio'), null);
});

test("going live and rolling back need Studio's admin role, not the platform admin (J, 2026-10-30)", async () => {
  const { db } = await import('../src/db.ts');
  for (const route of ['/api/deploy/doseofdestruction', '/api/rollback/doseofdestruction']) {
    assert.equal(L.platformRefusal(helperGoogle('POST'), route, 'POST'), null, `${route}: an admin of J's Studio`);
    assert.equal(A.memberRefusal(helperGoogle('POST'), route, 'POST'), null, `${route}: an admin by role`);
  }
  // Tapping an Approve card to go live or roll back is the same; any other card (a merge, money, settings) stays J's.
  await import('../src/approvals.ts');
  const card = (id: string, kind: string) => db.prepare("INSERT INTO approvals (id, kind, target, bind, token, card, status, created, expires) VALUES (?, ?, 'doseofdestruction', 'x', 't', '{}', 'pending', ?, ?)").run(id, kind, Date.now(), Date.now() + 60_000);
  card('a_00000000d001', 'deploy');
  card('a_00000000d002', 'rollback');
  card('a_00000000d003', 'settings');
  assert.equal(L.platformRefusal(helperGoogle('POST'), '/api/approvals/a_00000000d001/approve', 'POST'), null);
  assert.equal(L.platformRefusal(helperGoogle('POST'), '/api/approvals/a_00000000d002/deny', 'POST'), null);
  assert.match(L.platformRefusal(helperGoogle('POST'), '/api/approvals/a_00000000d003/approve', 'POST') ?? '', /only the platform admin/);
  // A member still can't: that is the role check, unchanged.
  A.createInvite({ email: 'member@example.com', role: 'member', by: j });
  const member = A.googleUser({ email: 'member@example.com', sub: '1000009' });
  assert.equal(member.role, 'member');
  assert.match(A.memberRefusal(as(member, 'google')('POST'), '/api/deploy/doseofdestruction', 'POST') ?? '', /Only an admin/);
});

test("J's session from before sessions recorded how (via empty) counts as Google on Cloud Run", async () => {
  const { db } = await import('../src/db.ts');
  const old = A.startSession(j, { via: 'password' });
  db.prepare('UPDATE sessions SET via = NULL WHERE user = ? AND via = ?').run(j.id, 'password');
  const jOld = (method: string) => req({ Cookie: `${A.COOKIE}=${old.token}` }, method);
  assert.equal(L.platformRefusal(jOld('POST'), '/api/settings', 'POST'), null);
  assert.ok(L.platformAdminOf(jOld('GET')));
  // Someone else's old session is still not the platform admin (the email check stands).
  const hs = A.startSession(helper, { via: 'password' });
  db.prepare('UPDATE sessions SET via = NULL WHERE user = ? AND via = ?').run(helper.id, 'password');
  assert.equal(L.platformAdminOf(req({ Cookie: `${A.COOKIE}=${hs.token}` }, 'GET')), null);
});

test('a wrong owner key or another listed email is not the platform admin', () => {
  // (A wrong key has no user at all: Cloud Run's gate, cloudauth.ts, answers 401 before this.)
  assert.equal(L.platformAdminOf(req({ Authorization: 'Bearer nope' }, 'POST')), null);
  process.env.STUDIO_PLATFORM_ADMINS = 'someone-else@example.com';
  try {
    assert.match(L.platformRefusal(jGoogle('GET'), '/api/costs', 'GET') ?? '', /only the platform admin/);
  } finally {
    delete process.env.STUDIO_PLATFORM_ADMINS;
  }
});

test('what everyone may still use in J\'s Studio is untouched', () => {
  for (const [method, route] of [['GET', '/api/overview'], ['GET', '/api/backlog'], ['POST', '/api/talk'], ['GET', '/api/products'], ['POST', '/api/changes'], ['GET', '/api/settings']]) {
    assert.equal(L.platformRefusal(helperGoogle(method), route, method), null, `${method} ${route}`);
  }
  // Studio's own calls, Talk and the agents: guards.ts decides, not this.
  assert.equal(L.platformRefusal(req({}, 'GET'), '/api/costs', 'GET'), null);
});

test('/api/me tells the dashboard what to hide', async () => {
  const me = async (r: http.IncomingMessage) => {
    const out: any = { body: '' };
    out.writeHead = () => out;
    out.end = (b?: string) => { out.body += b ?? ''; };
    await handleUsersApi(r, out, new URL('http://x/api/me'));
    return JSON.parse(out.body);
  };
  const h = await me(helperGoogle());
  assert.equal(h.platformAdmin, false);
  for (const tab of ['costs', 'resources', 'social', 'onair', 'users', 'claude']) assert.ok(h.hide.includes(tab), tab);
  assert.equal(h.customer, false);
  const jm = await me(jGoogle());
  assert.equal(jm.platformAdmin, true);
  assert.deepEqual(jm.hide, []);
});

test('Google accounts are keyed by Google\'s sub: the email follows it, another Google account can\'t take it', () => {
  const moved = A.googleUser({ email: 'helper.new@example.com', sub: '1000002' });
  assert.equal(moved.id, helper.id);
  assert.equal(moved.email, 'helper.new@example.com');
  assert.throws(() => A.googleUser({ email: 'helper.new@example.com', sub: '9999999' }), /different Google account/);
  assert.throws(() => A.googleUser({ email: 'stranger@example.com', sub: '1000003' }), /no account here/);
});

test('the waitlist: a stranger is recorded for J, gets no account, and an invite lets them in', () => {
  process.env.STUDIO_SIGNUP = 'waitlist';
  try {
    assert.throws(() => A.googleUser({ email: 'fan@example.com', sub: '2000001', name: 'A Fan' }), (e: any) => e instanceof A.Waitlisted && /on the list/.test(e.message));
    assert.throws(() => A.googleUser({ email: 'fan@example.com', sub: '2000001' }), A.Waitlisted);
    assert.equal(A.userByEmail('fan@example.com'), null);
    const [s] = A.listSignups();
    assert.equal(s.email, 'fan@example.com');
    assert.equal(s.tries, 2);
    A.decideSignup('2000001', 'invite', j);
    const fan = A.googleUser({ email: 'fan@example.com', sub: '2000001' });
    assert.equal(fan.role, 'member');
    assert.equal(A.listSignups().length, 0);
  } finally {
    delete process.env.STUDIO_SIGNUP;
  }
});
