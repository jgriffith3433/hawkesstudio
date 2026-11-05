// The platform admin in J's Studio (lockdown.ts, docs/studio-customers.md): only for managing the platform for customers
// (J, 2026-10-30: "admin should just be for managing the platform for customers"): customers' Studios, the plans, the
// waitlist. Only a Google sign-in with an email on STUDIO_PLATFORM_ADMINS (or J's owner key) passes those; everything
// else is Studio's admin role. Also: Google accounts keyed by Google's sub, and the waitlist. A customer's Studio (where
// J's machinery stays the platform admin's) is test/customer.test.ts.
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

// Managing the platform for customers: the platform admin's alone, as the dashboard, CLI or MCP call them.
const PLATFORM_ONLY: [string, string][] = [
  ['GET', '/api/cells'], ['POST', '/api/cells/roll'], ['POST', '/api/cells/acme-1a2b/hibernate'], ['POST', '/api/billing/plans'], ['GET', '/api/signups'],
];
// Everything else an admin of J's Studio does: Studio's admin role is enough (J's own Approve card was refused, 2026-10-30).
const ADMIN_ROLE: [string, string][] = [
  ['POST', '/api/approvals/a_0123456789ab/approve'], ['POST', '/api/changes/c_0123456789ab/approve'],
  ['POST', '/api/claude/signin'], ['GET', '/api/claude/accounts'], ['GET', '/api/broadcast'], ['GET', '/api/costs'],
  ['GET', '/api/users'], ['POST', '/api/users/invite'], ['POST', '/api/settings'], ['POST', '/api/agents/settings'],
  ['PUT', '/api/products/doseofdestruction'], ['POST', '/api/gen/v1/jobs'], ['POST', '/api/deploy/doseofdestruction'],
];

test('J signs in with Google as an admin (a platform admin is let in like STUDIO_GOOGLE_EMAILS)', () => {
  assert.equal(j.role, 'admin');
  assert.equal(j.email, 'piercehawkes3@gmail.com');
  assert.ok(j.google);
  assert.equal(helper.role, 'admin', 'the invite made an admin of this Studio');
});

test("an admin of J's Studio who is not the platform admin: everything but managing the platform for customers", () => {
  for (const [method, route] of PLATFORM_ONLY) assert.match(L.platformRefusal(helperGoogle(method), route, method) ?? '', /only the platform admin/, `${method} ${route}`);
  for (const [method, route] of ADMIN_ROLE) {
    assert.equal(L.platformRefusal(helperGoogle(method), route, method), null, `${method} ${route}`);
    assert.equal(A.memberRefusal(helperGoogle(method), route, method), null, 'they are an admin by role');
  }
  assert.equal(L.infraRefusal(helperGoogle('POST'), 'hawkesstudio'), null, "a change to Studio itself: an admin's in J's Studio");
});

test("J with Google, and J's owner key, manage the platform; J with a password session does not", () => {
  const owner = (method: string) => req({ Authorization: 'Bearer owner-key-for-the-test' }, method);
  const jPassword = as(j, 'password');
  for (const [method, route] of PLATFORM_ONLY) {
    assert.equal(L.platformRefusal(jGoogle(method), route, method), null, `${method} ${route}`);
    assert.equal(L.platformRefusal(owner(method), route, method), null, `${method} ${route} (owner key)`);
    assert.match(L.platformRefusal(jPassword(method), route, method) ?? '', /only the platform admin/, `${method} ${route} (password)`);
  }
  for (const [method, route] of ADMIN_ROLE) assert.equal(L.platformRefusal(jPassword(method), route, method), null, `${method} ${route}: his admin role`);
});

test("a member of J's Studio still can't do an admin's things (the role check, unchanged)", () => {
  A.createInvite({ email: 'member@example.com', role: 'member', by: j });
  const member = A.googleUser({ email: 'member@example.com', sub: '1000009' });
  assert.equal(member.role, 'member');
  for (const route of ['/api/deploy/doseofdestruction', '/api/approvals/a_0123456789ab/approve', '/api/settings']) {
    assert.match(A.memberRefusal(as(member, 'google')('POST'), route, 'POST') ?? '', /Only an admin/, route);
  }
});

test("J's session from before sessions recorded how (via empty) counts as Google on Cloud Run", async () => {
  const { db } = await import('../src/db.ts');
  const old = A.startSession(j, { via: 'password' });
  db.prepare('UPDATE sessions SET via = NULL WHERE user = ? AND via = ?').run(j.id, 'password');
  const jOld = (method: string) => req({ Cookie: `${A.COOKIE}=${old.token}` }, method);
  assert.equal(L.platformRefusal(jOld('POST'), '/api/cells/roll', 'POST'), null);
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
    assert.match(L.platformRefusal(jGoogle('GET'), '/api/cells', 'GET') ?? '', /only the platform admin/);
  } finally {
    delete process.env.STUDIO_PLATFORM_ADMINS;
  }
});

test('what everyone may still use in J\'s Studio is untouched', () => {
  for (const [method, route] of [['GET', '/api/overview'], ['GET', '/api/backlog'], ['POST', '/api/talk'], ['GET', '/api/products'], ['POST', '/api/changes'], ['GET', '/api/settings']]) {
    assert.equal(L.platformRefusal(helperGoogle(method), route, method), null, `${method} ${route}`);
  }
  // Studio's own calls, Talk and the agents: guards.ts decides, not this.
  assert.equal(L.platformRefusal(req({}, 'GET'), '/api/cells', 'GET'), null);
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
  assert.deepEqual(h.hide, ['customers'], "an admin of J's Studio sees everything but Customers (the platform admin's)");
  assert.equal(h.customer, false);
  const member = A.userByEmail('member@example.com')!;
  const m = await me(as(member, 'google')());
  for (const tab of ['costs', 'resources', 'social', 'onair', 'users', 'claude']) assert.ok(m.hide.includes(tab), tab);
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
