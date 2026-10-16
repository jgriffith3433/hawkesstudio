// Accounts (auth.ts, auth-pages.ts): the first admin's default password works only until it's changed, sign-in
// lockout, sessions and their cookie, forward_auth's answers, invites and resets, roles on admin-only routes, and
// J's script login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-auth-'));
process.env.STUDIO_MAIL = 'off';
const A = await import('../src/auth.ts');
const { handleAuthRoute, handleUsersApi } = await import('../src/auth-pages.ts');

/** A fake request: headers, and a body for the pages. */
function req(headers: Record<string, string> = {}, body = '', method = 'GET'): http.IncomingMessage {
  const r: any = (async function* () { if (body) yield Buffer.from(body); })();
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  r.method = method;
  r.socket = { remoteAddress: '203.0.113.9' };
  return r;
}

/** A fake response that records what was written. */
function res() {
  const out: any = { status: 0, headers: {} as Record<string, any>, body: '' };
  out.writeHead = (s: number, h: Record<string, any> = {}) => { out.status = s; Object.assign(out.headers, h); return out; };
  out.end = (b?: string) => { out.body += b ?? ''; };
  return out;
}

const web = { 'X-Forwarded-Host': 'studio.hawkesgen.com', 'X-Forwarded-Proto': 'https' };
const cookieOf = (setCookie: string) => /hawkes_session=([^;]*)/.exec(setCookie)![1];

test('the first admin: "admin" signs in once, must set a password, and never works again', async () => {
  assert.ok(A.ensureDefaultAdmin());
  assert.equal(A.ensureDefaultAdmin(), null, 'only when there are no users');
  const u = A.signIn('Admin@HawkesGen.com ', 'admin', { ip: '1.1.1.1' });
  assert.equal(u.role, 'admin');
  assert.ok(u.must_change && u.default_password);
  assert.throws(() => A.signIn(A.DEFAULT_ADMIN, 'nope', { ip: '1.1.1.1' }), /don't match/);

  // forward_auth sends a must-change user to set a password, for pages and API calls alike.
  const s = A.startSession(u);
  const page = A.check(req({ ...web, Cookie: `hawkes_session=${s.token}`, 'Sec-Fetch-Mode': 'navigate', 'X-Forwarded-Uri': '/' }));
  assert.equal(page.status, 302);
  assert.match(page.headers.Location, /\/auth\/set-password\?next=/);
  assert.equal(A.check(req({ ...web, Cookie: `hawkes_session=${s.token}` })).status, 403);

  assert.throws(() => A.setPassword(u.id, 'short'), /at least 12/);
  assert.throws(() => A.setPassword(u.id, 'admin'), /at least 12/);
  A.setPassword(u.id, 'correct horse battery staple', { email: 'j@example.com' });
  assert.throws(() => A.signIn(A.DEFAULT_ADMIN, 'admin', { ip: '1.1.1.2' }), /don't match/, 'the default address is gone');
  assert.throws(() => A.signIn('j@example.com', 'admin', { ip: '1.1.1.2' }), /don't match/, '"admin" never works again');
  const j = A.signIn('j@example.com', 'correct horse battery staple', { ip: '1.1.1.2' });
  assert.equal(j.must_change, false);
  const ok = A.check(req({ ...web, Cookie: `hawkes_session=${s.token}` }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['X-Hawkes-User'], 'j@example.com');
  assert.equal(ok.headers['X-Hawkes-Role'], 'admin');
  // The log has every attempt, never a password.
  const log = A.signinLog(50);
  assert.ok(log.some((l) => !l.ok && l.reason === 'wrong password'));
  assert.ok(!JSON.stringify(log).includes('correct horse'));
});

test('lockout: five wrong passwords lock the account for 15 minutes, even with the right one', () => {
  for (let i = 0; i < 5; i++) assert.throws(() => A.signIn('j@example.com', `wrong ${i}`, { ip: `10.0.0.${i}` }));
  assert.throws(() => A.signIn('j@example.com', 'correct horse battery staple', { ip: '10.0.0.99' }), (e: any) => e.status === 429);
});

test('forward_auth: no session -> the sign-in page for a page load, 401 for anything else; next comes back', () => {
  const page = A.check(req({ 'X-Forwarded-Host': 'icanbe.hawkesgen.com', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Uri': '/c/x/?a=1', Accept: 'text/html' }));
  assert.equal(page.status, 302);
  assert.equal(page.headers.Location, `https://studio.hawkesgen.com/auth/signin?next=${encodeURIComponent('https://icanbe.hawkesgen.com/c/x/?a=1')}`);
  assert.equal(A.check(req({ ...web, Accept: 'application/json' })).status, 401);
  assert.equal(A.safeNext('https://icanbe.hawkesgen.com/x'), 'https://icanbe.hawkesgen.com/x');
  assert.equal(A.safeNext('https://evil.example/x'), '/');
  assert.equal(A.safeNext('//evil.example'), '/');
  assert.equal(A.safeNext('https://hawkesgen.com.evil.example/'), '/');
});

test('the cookie: HttpOnly, Secure and domain-wide on the web; 30 days only when remembered', () => {
  const c = A.sessionCookie(req(web), 'tok', A.cookieAge(true));
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Domain=hawkesgen\.com/);
  assert.match(c, /Max-Age=2592000/);
  assert.doesNotMatch(A.sessionCookie(req(web), 'tok', A.cookieAge(false)), /Max-Age/);
  assert.doesNotMatch(A.sessionCookie(req({ Host: '127.0.0.1:8791' }), 'tok', null), /Domain=/);
});

test('the sign-in page: a form post sets the cookie and goes to next; a form from another site is refused', async () => {
  const r = res();
  await handleAuthRoute(req({ ...web, 'Content-Type': 'application/x-www-form-urlencoded' }, 'email=nobody%40x.com&password=x&next=%2F', 'POST'), r, new URL('http://x/auth/signin'));
  assert.equal(r.status, 401);
  assert.match(r.body, /don&#39;t match/);
  const g = res();
  await handleAuthRoute(req(web), g, new URL('http://x/auth/signin?next=https%3A%2F%2Fphorigins.hawkesgen.com%2F'));
  assert.match(g.body, /autocomplete="username"/);
  assert.match(g.body, /autocomplete="current-password"/);
  const x = res();
  await handleAuthRoute(req({ ...web, Origin: 'https://evil.example' }, 'email=a&password=b', 'POST'), x, new URL('http://x/auth/signin'));
  assert.equal(x.status, 403);
});

test('invites: an admin invites, the link makes a member once; members are refused admin-only routes', async () => {
  const j = A.userByEmail('j@example.com')!;
  const admin = A.startSession(j);
  const r = res();
  await handleUsersApi(req({ ...web, Cookie: `hawkes_session=${admin.token}`, 'Content-Type': 'application/json' }, JSON.stringify({ email: 'Pat@Example.com', role: 'member' }), 'POST'), r, new URL('http://x/api/users/invite'));
  assert.equal(r.status, 200, r.body);
  const out = JSON.parse(r.body);
  assert.equal(out.emailed, false);
  const t = new URL(out.link).searchParams.get('token')!;
  assert.ok(A.openInvite(t));
  assert.throws(() => A.acceptInvite(t, 'tiny'), /at least 12/);
  const pat = A.acceptInvite(t, 'a long enough passphrase', 'Pat');
  assert.equal(pat.email, 'pat@example.com');
  assert.equal(pat.role, 'member');
  assert.equal(A.openInvite(t), null, 'single use');
  assert.throws(() => A.acceptInvite(t, 'a long enough passphrase'), /expired or was already used/);

  const s = A.startSession(pat);
  const memberReq = (route: string) => req({ ...web, Cookie: `hawkes_session=${s.token}` }, '', 'POST');
  for (const route of ['/api/deploy/sickofit', '/api/rollback/sickofit', '/api/approvals/a_0123456789ab/approve', '/api/users/invite', '/api/settings', '/api/roadmap/tasks/k_0123456789ab/gpu'])
    assert.match(String(A.memberRefusal(memberReq(route), route, 'POST')), /Only an admin/, route);
  assert.equal(A.memberRefusal(memberReq('/api/talk'), '/api/talk', 'POST'), null, 'members can use Talk');
  assert.equal(A.memberRefusal(req({ ...web, Cookie: `hawkes_session=${admin.token}` }, '', 'POST'), '/api/deploy/sickofit', 'POST'), null);
  const denied = res();
  await assert.rejects(handleUsersApi(memberReq('/api/users'), denied, new URL('http://x/api/users')), /Only an admin/);

  // A reset signs Pat out everywhere; a disabled user's sessions end.
  const reset = A.createInvite({ email: pat.email, kind: 'reset', by: j });
  A.acceptInvite(reset.token, 'another long passphrase');
  assert.equal(A.sessionUser(s.token), null);
  const s2 = A.startSession(A.getUser(pat.id)!);
  A.updateUser(pat.id, { disabled: true }, j);
  assert.equal(A.sessionUser(s2.token), null);
  assert.throws(() => A.signIn(pat.email, 'another long passphrase', { ip: '9.9.9.9' }), /don't match/);
  // There is always an admin.
  assert.throws(() => A.updateUser(j.id, { role: 'member' }, j), /no admin/);
  // Revoked invites don't open.
  const inv = A.createInvite({ email: 'sam@example.com', by: j });
  A.revokeInvite(inv.id);
  assert.equal(A.openInvite(inv.token), null);
});

test('J\'s script login (Basic j:<web password>) counts as an admin; a wrong one or another user does not', () => {
  process.env.WEB_LOGIN_SHA256 = crypto.createHash('sha256').update('the-web-password').digest('hex');
  const basic = (u: string, p: string) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
  assert.equal(A.check(req({ ...web, ...basic('j', 'the-web-password') })).headers['X-Hawkes-Role'], 'admin');
  assert.equal(A.check(req({ ...web, ...basic('J', 'the-web-password') })).status, 401);
  assert.equal(A.check(req({ ...web, ...basic('j', 'wrong') })).status, 401);
  // The forward_auth answer for a stale popup login in a browser is the sign-in page, not another popup.
  const page = A.check(req({ ...web, ...basic('j', 'wrong'), 'Sec-Fetch-Mode': 'navigate' }));
  assert.equal(page.status, 302);
  assert.equal(page.headers['WWW-Authenticate'], undefined);
});
