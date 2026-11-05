// The Customers page's API (admin-customers.ts): platform-admin-only on every route (403 for an admin of J's Studio, a
// member and a stranger, whatever the method), the list and one studio's detail, suspend and unsuspend, and gifted credits
// (validation, the labeled ledger entry, the new balance, a double click being one gift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { SessionVia, User } from '../src/auth.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-admincust-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_MASTER = 'm'.repeat(40);
process.env.STUDIO_CELLS_PROJECT = 'hawkes-test';
process.env.STUDIO_CELLS_PROJECT_NUMBER = '123456';
process.env.STUDIO_CELLS_REGION = 'us-east4';
process.env.STUDIO_CELLS_SA = 'studio-cells@hawkes-test.iam.gserviceaccount.com';
process.env.STUDIO_CELLS_BUCKET = 'hawkes-test-studio-cells';
process.env.STUDIO_CELLS_IMAGE = 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v1';
process.env.STUDIO_OWNER_KEY = 'owner-key-for-the-test';
delete process.env.STUDIO_ORG;
delete process.env.STUDIO_SIGNUP;
delete process.env.STUDIO_CUSTOMER;
delete process.env.STUDIO_PLATFORM_ADMINS;
delete process.env.STUDIO_GOOGLE_EMAILS;
const A = await import('../src/auth.ts');
const C = await import('../src/cells.ts');
const B = await import('../src/billing.ts');
const AC = await import('../src/admin-customers.ts');
const L = await import('../src/lockdown.ts');

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
A.createInvite({ email: 'member@example.com', role: 'member', by: j });
const member = A.googleUser({ email: 'member@example.com', sub: '1000003' });
const jGoogle = as(j, 'google');

const send = (res: any, status: number, body: unknown) => { res.status = status; res.body = body; };
const call = async (r: http.IncomingMessage, route: string, method = 'GET', body: any = {}) => {
  const out: any = {};
  const handled = await AC.handleAdminApi(r, out, route, method, send, async () => body);
  assert.equal(handled, true);
  return out;
};

const org = C.createOrg({ sub: '8000001', email: 'owner@studio.example', name: 'Owner' }, 'Gift Studio');
const base = `/api/admin/customers/${org.id}`;

test('every admin route is the platform admin\'s: others get 403 on every method, through the handler and lockdown', async () => {
  const routes: [string, string][] = [['GET', '/api/admin/customers'], ['GET', base], ['POST', `${base}/suspend`], ['POST', `${base}/unsuspend`], ['POST', `${base}/gift-credits`], ['GET', '/api/admin/nothing']];
  const others = [as(helper, 'google'), as(member, 'google'), as(j, 'password'), () => req({}, 'GET')];
  for (const who of others) for (const [method, route] of routes) {
    const out = await call(who(method), route, method, { amount: 5, reason: 'nope', confirm: true });
    assert.equal(out.status, 403, `${method} ${route}`);
    // Studio's own calls (no account) are guards.ts's in front; the handler above refused them already.
    if (A.requester(who(method))) assert.match(L.platformRefusal(who(method), route, method) ?? '', /platform admin/);
  }
  assert.equal(B.creditBalance(org.id), 0, 'a refused gift gave nothing');
  assert.equal(L.platformRefusal(jGoogle('GET'), '/api/admin/customers', 'GET'), null);
  assert.equal((await call(req({ Authorization: 'Bearer owner-key-for-the-test' }), '/api/admin/customers')).status, 200, "J's owner key passes");
  assert.equal(await AC.adminRefusal(jGoogle()), null);
  assert.equal((await call(jGoogle(), '/api/admin/nothing')).status, 404);
});

test('the dashboard hides Customers from everyone but the platform admin', () => {
  assert.ok(L.hiddenFor(as(helper, 'google')()).hide.includes('customers'), 'an admin of this Studio');
  assert.ok(L.hiddenFor(as(member, 'google')()).hide.includes('customers'));
  assert.ok(!L.hiddenFor(jGoogle()).hide.includes('customers'));
});

test('the list has what the page shows, and one studio\'s detail has people, ledger and usage', async () => {
  C.setAccess(org.id, [{ email: 'second@studio.example', role: 'member', kind: 'invite' }]);
  const list = await call(jGoogle(), '/api/admin/customers');
  assert.equal(list.status, 200);
  const r = list.body.customers.find((c: any) => c.id === org.id);
  assert.deepEqual(Object.keys(r).filter((k) => ['name', 'ownerEmail', 'plan', 'credits', 'created', 'lastActivity', 'projects', 'status', 'members'].includes(k)).length, 9);
  assert.equal(r.name, 'Gift Studio');
  assert.equal(r.ownerEmail, 'owner@studio.example');
  assert.equal(r.plan.id, 'free');
  assert.equal(r.status, 'new');
  assert.equal(r.members, 2);
  const d = await call(jGoogle(), base);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.members.map((m: any) => m.email).sort(), ['owner@studio.example', 'second@studio.example']);
  assert.equal(d.body.usage.days, 30);
  assert.equal((await call(jGoogle(), '/api/admin/customers/nobody-0000')).status, 404);
});

test('a studio reports its project count with its people (cell key), shown in the list', async () => {
  const K = await import('../src/cellkeys.ts');
  const out: any = {};
  const r = req({ Authorization: `Bearer ${K.deriveKey('cell', org.id)}`, 'X-Studio-Cell': org.id }, 'POST');
  await C.handleCellsKeyed(r, out, '/api/cells/self/members', 'POST', send, async () => ({ people: [], projects: 3 }));
  assert.equal(out.status, 200);
  assert.equal((await call(jGoogle(), base)).body.projects, 3);
});

test('gifting credits: a labeled ledger entry, the new balance, confirmed, validated, once per key', async () => {
  const gift = (b: any) => call(jGoogle('POST'), `${base}/gift-credits`, 'POST', b);
  for (const [b, re] of [
    [{ amount: 100, reason: 'launch week' }, /confirm/],
    [{ amount: 100, reason: 'launch week', confirm: 'yes' }, /confirm/],
    [{ amount: 0, reason: 'launch week', confirm: true }, /amount/],
    [{ amount: -5, reason: 'launch week', confirm: true }, /amount/],
    [{ amount: 2.5, reason: 'launch week', confirm: true }, /amount/],
    [{ amount: 'lots', reason: 'launch week', confirm: true }, /amount/],
    [{ amount: 100_001, reason: 'launch week', confirm: true }, /amount/],
    [{ amount: 100, reason: '', confirm: true }, /reason/],
    [{ amount: 100, reason: '  ', confirm: true }, /reason/],
    [{ amount: 100, reason: 'x'.repeat(201), confirm: true }, /reason/],
  ] as [any, RegExp][]) {
    const out = await gift(b);
    assert.equal(out.status, 400, JSON.stringify(b));
    assert.match(out.body.error, re);
  }
  assert.equal(B.creditBalance(org.id), 0, 'no refused gift touched the balance');
  assert.equal(B.creditLedger(10, org.id).length, 0);

  const ok = await gift({ amount: 250, reason: 'Launch week thank-you', confirm: true, key: 'dialog-key-1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.added, 250);
  assert.equal(ok.body.credits, 250);
  assert.equal(ok.body.detail.credits, 250, 'the page gets the studio back with its new balance');
  const [entry] = B.creditLedger(1, org.id);
  assert.equal(entry.kind, 'admin_gift');
  assert.equal(entry.delta, 250);
  assert.equal(entry.balance_after, 250);
  assert.match(entry.detail, /Admin gift from pierce.*Launch week thank-you/i, 'who gave it and why');
  assert.ok(Date.now() - entry.created < 60_000, 'when');
  // A double click (same key) is one gift; another gift stacks on the balance.
  const again = await gift({ amount: 250, reason: 'Launch week thank-you', confirm: true, key: 'dialog-key-1' });
  assert.equal(again.body.added, 0);
  assert.equal(again.body.credits, 250);
  const more = await gift({ amount: 50, reason: 'second', confirm: true, key: 'dialog-key-2' });
  assert.equal(more.body.credits, 300);
  assert.equal(B.creditLedger(10, org.id).length, 2);
  const d = (await call(jGoogle(), base)).body;
  assert.equal(d.credits, 300);
  assert.equal(d.usage.added, 300);
  assert.equal(d.ledger[0].kind, 'admin_gift');
  // The cap is a setting (the control plane's), not a constant.
  C.saveCellsSettings({ giftMaxCredits: 60 });
  assert.equal((await gift({ amount: 61, reason: 'over the cap', confirm: true })).status, 400);
  assert.equal((await gift({ amount: 60, reason: 'at the cap', confirm: true })).body.credits, 360);
  assert.throws(() => C.saveCellsSettings({ giftMaxCredits: 0 }), /giftMaxCredits/);
  C.saveCellsSettings({ giftMaxCredits: 100_000 });
});

test('suspend needs a reason, stops charges and wake-ups, and unsuspend gives them back', async () => {
  const K = await import('../src/cellkeys.ts');
  assert.equal((await call(jGoogle('POST'), `${base}/suspend`, 'POST', {})).status, 400);
  const s = await call(jGoogle('POST'), `${base}/suspend`, 'POST', { reason: 'unpaid invoice' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, 'suspended');
  assert.match(s.body.suspended.reason, /unpaid/);
  assert.match(s.body.suspended.by ?? '', /pierce/i);
  assert.equal((await call(jGoogle(), '/api/admin/customers')).body.customers.find((c: any) => c.id === org.id).status, 'suspended');
  await assert.rejects(C.ensureCell(org.id, 'a visit', { dry: true }), /suspended/);
  await assert.rejects(C.cellCredits(org.id, 'charge', { charge: 'job-123456', credits: 1 }), /suspended/);
  const wake: any = {};
  await C.handleCellsKeyed(req({ Authorization: `Bearer ${K.edgeKey()}` }, 'POST'), wake, `/api/cells/edge/${org.id}/wake`, 'POST', send, async () => ({}));
  assert.equal(wake.status, 403, 'the router is told it is suspended');
  assert.equal(wake.body.state, 'suspended');
  const u = await call(jGoogle('POST'), `${base}/unsuspend`, 'POST', {});
  assert.equal(u.body.suspended, null);
  assert.equal((await C.ensureCell(org.id, 'a visit', { dry: true })).state, 'awake');
});
