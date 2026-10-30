// Customers' Studios: the control plane in J's Studio (cells.ts), the Cloud Run Admin API calls (cellrun.ts) against a
// stand-in for Google, keys from one master (cellkeys.ts), and billing for the orgs on the one Stripe webhook.
// Nothing here reaches Google or Stripe: setGcpFetch answers for Google, STRIPE_API_BASE is never called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cells-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_MASTER = 'm'.repeat(40);
process.env.STUDIO_CELLS_PROJECT = 'hawkes-test';
process.env.STUDIO_CELLS_PROJECT_NUMBER = '123456';
process.env.STUDIO_CELLS_REGION = 'us-east4';
process.env.STUDIO_CELLS_SA = 'studio-cells@hawkes-test.iam.gserviceaccount.com';
process.env.STUDIO_CELLS_BUCKET = 'hawkes-test-studio-cells';
process.env.STUDIO_CELLS_IMAGE = 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v1';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai';
process.env.STUDIO_SERVICE_URL = 'https://studio-123456.us-east4.run.app';
const WHSEC = 'whsec_test_cells';
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'stripe.json'), JSON.stringify({ secretKey: 'sk_test_x', webhookSecret: WHSEC }));
delete process.env.STUDIO_ORG;
delete process.env.STUDIO_SIGNUP;
delete process.env.STUDIO_CELLS_DRY_RUN;

const K = await import('../src/cellkeys.ts');
const R = await import('../src/cellrun.ts');
const C = await import('../src/cells.ts');
const B = await import('../src/billing.ts');
const { setGcpFetch } = await import('../src/gcp.ts');

// Hawkes Gen, standing in: the control plane makes each cell's key with J's Gen owner key (cells.ts genCall).
const genCalls: { method: string; path: string; body: any }[] = [];
let nextClient = 0;
C.setGenCall(async (method, path, body) => {
  genCalls.push({ method, path, body });
  if (method === 'POST' && path === '/clients') { nextClient++; return { key: `hg_cell_${nextClient}`, client: { id: `c_${nextClient.toString(16).padStart(6, '0')}` } }; }
  return { ok: true };
});

// A stand-in for Google: Cloud Run services and Cloud Storage objects in memory, every call recorded.
const services = new Map<string, any>();
const objects = new Map<string, Buffer>();
const calls: { method: string; url: string; body: any }[] = [];
setGcpFetch((async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  calls.push({ method, url, body });
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  let m = /run\.googleapis\.com\/v2\/projects\/[^/]+\/locations\/[^/]+\/services(?:\?serviceId=([^&]+))?$/.exec(url);
  if (m && method === 'POST') { services.set(m[1], { name: `projects/p/locations/l/services/${m[1]}`, ...body }); return json(200, { name: `operations/${m[1]}` }); }
  m = /\/services\?pageSize/.exec(url);
  if (m) return json(200, { services: [...services.values()] });
  m = /\/services\/([^/:?]+)(:setIamPolicy)?(\?.*)?$/.exec(url);
  if (m) {
    if (m[2]) return json(200, {});
    if (method === 'DELETE') { const had = services.delete(m[1]); return had ? json(200, {}) : json(404, { error: { message: 'not found' } }); }
    if (method === 'PATCH') { const s = services.get(m[1]) ?? { name: m[1], template: { containers: [{}] } }; s.template = { ...s.template, ...body.template }; services.set(m[1], s); return json(200, {}); }
    const s = services.get(m[1]);
    return s ? json(200, s) : json(404, { error: { message: 'not found' } });
  }
  m = /storage\/v1\/b\/[^/]+\/o\?prefix=([^&]+)/.exec(url);
  if (m) return json(200, { items: [...objects.keys()].filter((k) => k.startsWith(decodeURIComponent(m![1]))).map((name) => ({ name, size: 1, updated: '' })) });
  m = /upload\/storage\/v1\/b\/[^/]+\/o\?uploadType=media&name=([^&]+)/.exec(url);
  if (m) { objects.set(decodeURIComponent(m[1]), Buffer.from(init.body)); return json(200, {}); }
  m = /storage\/v1\/b\/[^/]+\/o\/([^?]+)$/.exec(url);
  if (m && method === 'DELETE') { objects.delete(decodeURIComponent(m[1])); return json(200, {}); }
  return json(404, { error: { message: `no stand-in for ${method} ${url}` } });
}) as typeof fetch, 'test-token');

const A1 = { sub: '7000001', email: 'dev@indie.example', name: 'Indie Dev' };
const req = (headers: Record<string, string> = {}, method = 'GET'): http.IncomingMessage => {
  const r: any = (async function* () {})();
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  r.method = method;
  r.socket = { remoteAddress: '203.0.113.9' };
  return r;
};
const res = () => { const r: any = { status: 0, body: null }; return r; };
const send = (r: any, status: number, body: unknown) => { r.status = status; r.body = body; };
const noJson = async () => ({});

test('keys: one master, a different key per org and purpose, the master never in a cell', () => {
  const a = K.cellKeyEnv('acme-1a2b');
  const b = K.cellKeyEnv('other-3c4d');
  assert.deepEqual(Object.keys(a).sort(), ['STUDIO_AGENT_KEY', 'STUDIO_BROKER_KEY', 'STUDIO_CELL_KEY', 'STUDIO_MCP_KEY', 'STUDIO_OWNER_KEY', 'STUDIO_SECRETS_KEY', 'STUDIO_SITES_SEED']);
  assert.equal(new Set(Object.values(a)).size, 7, 'every purpose its own key');
  for (const k of Object.keys(a)) assert.notEqual(a[k], b[k], 'every org its own');
  assert.deepEqual(K.cellKeyEnv('acme-1a2b'), a, 'derived, so the same every time');
  assert.ok(!Object.values(a).includes(process.env.STUDIO_CELLS_MASTER!));
  assert.ok(K.isCellKey('acme-1a2b', a.STUDIO_CELL_KEY));
  assert.ok(!K.isCellKey('other-3c4d', a.STUDIO_CELL_KEY), "one cell's key opens nothing of another's");
  assert.throws(() => K.deriveKey('owner', 'Bad Org'), /Not an org id/);
  const m = process.env.STUDIO_CELLS_MASTER;
  process.env.STUDIO_CELLS_MASTER = 'short';
  assert.throws(() => K.master(), (e: any) => e.status === 503);
  process.env.STUDIO_CELLS_MASTER = m;
});

test('sealing: AES-GCM under the cell\'s key; plain text from before passes; a wrong key fails', () => {
  process.env.STUDIO_SECRETS_KEY = 'cell-secrets-key';
  const sealed = K.seal('sk-ant-api03-secret');
  assert.ok(K.isSealed(sealed) && !sealed.includes('secret'));
  assert.notEqual(K.seal('sk-ant-api03-secret'), sealed, 'a fresh IV each time');
  assert.equal(K.unseal(sealed), 'sk-ant-api03-secret');
  assert.equal(K.unseal('plain-from-before'), 'plain-from-before');
  process.env.STUDIO_SECRETS_KEY = 'another-cell';
  assert.throws(() => K.unseal(sealed));
  delete process.env.STUDIO_SECRETS_KEY;
  assert.equal(K.seal('x'), 'x', 'no key, no sealing (J\'s Studio)');
});

test('the front door: a stranger gets a control-plane session and the sign-up, never a Studio session', () => {
  assert.ok(C.cellsOn());
  const d = C.frontDoor({ email: 'Dev@Indie.example', sub: A1.sub, name: A1.name });
  assert.equal(d.next, '/auth/start');
  assert.match(d.cookie, /^hs_cp=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  const token = decodeURIComponent(/^hs_cp=([^;]+)/.exec(d.cookie)![1]);
  assert.deepEqual(C.cpAccount(req({ Cookie: `hs_cp=${encodeURIComponent(token)}` })), A1);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...A1, sub: 'someone-else', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(C.cpAccount(req({ Cookie: `hs_cp=${forged}.${sig}` })), null, 'a changed body fails the signature');
  assert.equal(C.cpAccount(req({ Cookie: `hs_cp=${body}.${sig}` }), Date.now() + 31 * 86_400_000), null, 'expired');
});

test('signing up makes only the record; the first game makes the cell (shared account, own prefix, derived keys)', async () => {
  const org = C.createOrg(A1, 'Moonlight Games');
  assert.match(org.id, /^moonlight-games-[0-9a-f]{4}$/);
  assert.equal(org.state, 'new');
  assert.equal(calls.length, 0, 'no Google call at sign-up');
  assert.equal(C.frontDoor({ ...A1 }).next, `/o/${org.id}/`, 'next time: straight into it');
  // Where they were going goes on in their own Studio (a link Talk gave them); never the front door's own pages.
  assert.equal(C.frontDoor({ ...A1 }, Date.now(), '/api/github/connect').next, `/o/${org.id}/api/github/connect`);
  assert.equal(C.frontDoor({ ...A1 }, Date.now(), '/auth/start').next, `/o/${org.id}/`);
  assert.equal(C.frontDoor({ ...A1 }, Date.now(), '//evil.example').next, `/o/${org.id}/`);
  const up = await C.ensureCell(org.id, 'first game', { game: { id: 'moon', name: 'Moon', engine: 'web', live: 'https://moon.example' } });
  assert.equal(up.state, 'awake');
  assert.equal(up.image, process.env.STUDIO_CELLS_IMAGE);
  // The first game waits for the cell in its own state (config.ts applyOnboardingSeed adds it there).
  assert.deepEqual(JSON.parse(objects.get(`o/${org.id}/state/onboarding.json`)!.toString()).game.id, 'moon');
  const svc = services.get(`studio-o-${org.id}`);
  assert.ok(svc, 'the service studio-o-<org>');
  assert.equal(svc.template.serviceAccount, process.env.STUDIO_CELLS_SA, 'the one shared service account');
  assert.deepEqual(svc.template.scaling, { minInstanceCount: 0, maxInstanceCount: 1 });
  assert.equal(svc.labels['hawkes-studio-cell'], '1');
  const env = Object.fromEntries(svc.template.containers[0].env.map((e: any) => [e.name, e.value]));
  assert.equal(env.STUDIO_ORG, org.id);
  assert.equal(env.STUDIO_SIGNUP, 'owner');
  assert.equal(env.STUDIO_OWNER_SUB, A1.sub, 'only the owner can claim it');
  assert.equal(env.STUDIO_STATE_BUCKET, process.env.STUDIO_CELLS_BUCKET);
  assert.equal(env.STUDIO_STATE_PREFIX, `o/${org.id}/`);
  assert.equal(env.STUDIO_COOKIE_NAME, `hs_o_${org.id.replace(/-/g, '_')}`);
  assert.equal(env.STUDIO_COOKIE_HOST_ONLY, '1');
  assert.equal(env.STUDIO_PUBLIC_URL, `https://studio.hawkesgen.ai/o/${org.id}`);
  assert.equal(env.STUDIO_OWNER_KEY, K.deriveKey('owner', org.id));
  assert.equal(env.STUDIO_CELLS_MASTER, undefined, 'never the master');
  // Its own Gen key: role user, only its Gen org's projects, made with J's Gen owner key (which the cell never gets).
  const made = genCalls.find((g) => g.path === '/clients')!;
  const genOrg = C.getOrg(org.id)!.genOrg!;
  assert.match(genOrg, /^org_[0-9a-f]{16}$/);
  assert.deepEqual(made.body, { name: `Hawkes Studio cell ${org.id}`, role: 'user', projects: [genOrg, `${genOrg}.*`] });
  assert.equal(env.HAWKESGEN_KEY, 'hg_cell_1');
  assert.equal(env.HAWKESGEN_PROJECT_PREFIX, `${genOrg}.`);
  assert.equal(env.STUDIO_GEN_OWNER_KEY, undefined);
  assert.equal(env.STUDIO_BROKER_KEY, K.deriveKey('broker', org.id));
  assert.equal(R.serviceUrl(org.id), `https://studio-o-${org.id}-123456.us-east4.run.app`);
});

test('hibernation: idle 14 days loses the service, keeps the data; the next visit wakes it on J\'s image', async () => {
  const org = C.orgsOf(A1.sub)[0];
  const now = Date.now() + 15 * 86_400_000;
  const r = await C.sweep({ now });
  assert.deepEqual(r.hibernated, [org.id]);
  assert.equal(services.has(`studio-o-${org.id}`), false);
  assert.ok(objects.has(`o/${org.id}/state/onboarding.json`), 'the data stays');
  assert.equal(C.getOrg(org.id)!.state, 'hibernated');
  // The router's question with the edge key wakes it.
  const out = res();
  assert.ok(await C.handleCellsKeyed(req({ Authorization: `Bearer ${K.edgeKey()}` }, 'POST'), out, `/api/cells/edge/${org.id}/wake`, 'POST', send, noJson));
  assert.equal(out.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(C.getOrg(org.id)!.state, 'awake');
  assert.ok(services.has(`studio-o-${org.id}`));
  const woken = Object.fromEntries(services.get(`studio-o-${org.id}`).template.containers[0].env.map((e: any) => [e.name, e.value]));
  assert.equal(woken.HAWKESGEN_KEY, 'hg_cell_1', 'woken with the same Gen key, not a new one');
  assert.equal(genCalls.filter((g) => g.path === '/clients').length, 1);
  // Without the edge key: nothing.
  const no = res();
  await C.handleCellsKeyed(req({ Authorization: 'Bearer nope' }, 'POST'), no, `/api/cells/edge/${org.id}/wake`, 'POST', send, noJson);
  assert.equal(no.status, 401);
  // An org with no cell yet goes to the sign-up.
  const fresh = C.createOrg({ sub: '7000002', email: 'b@b.example', name: null }, 'Second');
  const n = res();
  await C.handleCellsKeyed(req({ Authorization: `Bearer ${K.edgeKey()}` }, 'POST'), n, `/api/cells/edge/${fresh.id}/wake`, 'POST', send, noJson);
  assert.deepEqual(n.body, { state: 'new', next: '/auth/start' });
});

test('90 days with no sign-in and no plan: an email first, the data deleted 14 days later; a plan keeps it', async () => {
  const sent: string[] = [];
  const mail = async (to: string, subject: string) => { sent.push(`${to}: ${subject}`); };
  const org = C.getOrg(C.orgsOf('7000002')[0].id)!;
  const moon = C.orgsOf(A1.sub)[0];
  const t0 = Date.now() + 91 * 86_400_000;
  // The first org's owner keeps signing in: only the second is left alone that long.
  C.touch(moon.id, 'signin', t0);
  let r = await C.sweep({ now: t0, mail });
  assert.ok(!r.warned.includes(moon.id));
  assert.ok(r.warned.includes(org.id));
  assert.ok(sent.some((s) => s.startsWith('b@b.example: Your Hawkes Studio "Second" will be deleted in 14 days')));
  r = await C.sweep({ now: t0 + 86_400_000, mail });
  assert.equal(r.deleted.length, 0, 'not before the 14 days');
  objects.set(`o/${org.id}/state/x.json`, Buffer.from('{}'));
  C.touch(moon.id, 'signin', t0 + 15 * 86_400_000);
  r = await C.sweep({ now: t0 + 15 * 86_400_000, mail });
  assert.ok(r.deleted.includes(org.id));
  assert.equal(C.getOrg(org.id)!.state, 'deleted');
  // Its Gen key is disabled, its Claude credentials removed from Gen.
  const dead = C.getOrg(org.id)!;
  if (dead.genClient) {
    assert.ok(genCalls.some((g) => g.method === 'POST' && g.path === `/clients/${dead.genClient}/disable`));
    assert.ok(genCalls.some((g) => g.method === 'DELETE' && g.path === `/org/keys/anthropic?org=${dead.genOrg}`));
  }
  assert.equal([...objects.keys()].some((k) => k.startsWith(`o/${org.id}/`)), false);
  // Signing in again clears a warning.
  const paid = C.orgsOf(A1.sub)[0];
  C.touch(paid.id, 'signin');
  assert.equal(C.getOrg(paid.id)!.warnedAt, null);
});

const sign = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex')}`; };
const deliver = (e: unknown) => { const b = JSON.stringify(e); return B.handleStripeWebhook(b, sign(b)); };

test('billing for orgs: the one webhook here applies an org\'s events to it and makes its cell; others are ignored', async () => {
  await C.wireBilling();
  const org = C.createOrg({ sub: '7000003', email: 'c@c.example', name: null }, 'Paying Co');
  const meta = { product: 'studio', studio_id: org.id, plan_id: 'studio_indie', user_id: '7000003' };
  const r = deliver({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_org', customer: 'cus_org', metadata: meta } } });
  assert.equal(r.studio, org.id);
  assert.equal(B.currentSubscription(org.id)!.planId, 'studio_indie');
  assert.equal(B.currentSubscription(), null, "J's Studio's own plan untouched");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(C.getOrg(org.id)!.state, 'awake', 'subscribing made the cell');
  deliver({ type: 'invoice.paid', data: { object: { id: 'in_org', customer: 'cus_org', subscription: 'sub_org' } } });
  assert.equal(B.creditBalance(org.id), 1500);
  assert.equal(B.creditBalance(), 0);
  assert.match(String(deliver({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_x', customer: 'cus_x', metadata: { ...meta, studio_id: 'nobody-0000' } } } }).ignored), /not this Studio's/);
  // The cell asks for its plan with its own key.
  const out = res();
  await C.handleCellsKeyed(req({ Authorization: `Bearer ${K.deriveKey('cell', org.id)}`, 'X-Studio-Cell': org.id }), out, '/api/cells/self', 'GET', send, noJson);
  assert.equal(out.body.plan, 'studio_indie');
  assert.equal(out.body.credits, 1500);
  const other = res();
  await C.handleCellsKeyed(req({ Authorization: `Bearer ${K.deriveKey('cell', org.id)}`, 'X-Studio-Cell': C.orgsOf(A1.sub)[0].id }), other, '/api/cells/self', 'GET', send, noJson);
  assert.equal(other.status, 401, "a cell's key is only its own");
});

test('the nightly cron: only paying orgs with nightly runs, each woken, asked with its own owner key', async () => {
  const got: { url: string; key: string }[] = [];
  const r = await C.nightly({ call: async (url, key) => { got.push({ url, key }); return 202; } });
  const paying = C.orgsOf('7000003')[0];
  assert.deepEqual(r.started, [paying.id]);
  assert.ok(r.skipped.includes(C.orgsOf(A1.sub)[0].id), 'free: no nightly run');
  assert.deepEqual(got, [{ url: `${R.serviceUrl(paying.id)}/api/cloud/daily`, key: K.deriveKey('owner', paying.id) }]);
  // A plan keeps an org however long nobody signs in.
  const later = await C.sweep({ now: Date.now() + 400 * 86_400_000, mail: async () => {} });
  assert.ok(!later.warned.includes(paying.id) && !later.deleted.includes(paying.id));
});

test('a rolling upgrade: J\'s Studio first, then each awake cell; a failing cell stops it', async () => {
  await C.ensureCell(C.orgsOf('7000003')[0].id, 'awake for the roll');
  services.set('studio', { name: 'studio', template: { containers: [{ image: 'old' }] } });
  calls.length = 0;
  const r = await R.rollImage('us-east4-docker.pkg.dev/hawkes-test/studio/studio:v2', { health: async () => true, log: () => {} });
  assert.equal(r.done[0], 'studio');
  assert.equal(services.get('studio').template.containers[0].image, 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v2');
  const awake = C.listOrgs().filter((o) => o.state === 'awake').map((o) => `studio-o-${o.id}`);
  assert.deepEqual(r.done.slice(1).sort(), awake.sort());
  for (const s of awake) assert.equal(services.get(s).template.containers[0].image, 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v2');
  const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.url.split('/services/')[1].split('?')[0]);
  assert.equal(patches[0], 'studio', "J's Studio before any customer");
  const bad = await R.rollImage('us-east4-docker.pkg.dev/hawkes-test/studio/studio:v3', { health: async () => false, log: () => {} });
  assert.ok(bad.failed);
  assert.equal(bad.done.length, 1, 'stopped at the first cell');
  await assert.rejects(R.rollImage('not an image'), /Not an image/);
});

test("every deploy rolls the awake cells onto J's Studio's own image (and the nightly cron catches up)", async () => {
  services.set('studio', { name: 'studio', template: { containers: [{ image: 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v9' }] } });
  const r: any = await C.followRoll('deploy', { health: async () => true });
  assert.equal(r.image, 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v9');
  assert.ok(r.behind >= 1 && r.done.length === r.behind, 'every awake cell behind it');
  assert.ok(!r.done.includes('studio'), "J's Studio itself isn't touched: it's the one that just deployed");
  for (const s of r.done) assert.equal(services.get(s).template.containers[0].image, 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v9');
  const again: any = await C.followRoll('nightly', { health: async () => true });
  assert.equal(again.behind, 0, 'nothing behind: nothing to do');
  assert.equal(C.rollingCells(), false);
});

test('dry run: nothing reaches Google; the plan says what would be made', async () => {
  process.env.STUDIO_CELLS_DRY_RUN = '1';
  calls.length = 0;
  R.planned.length = 0;
  const org = C.createOrg({ sub: '7000004', email: 'd@d.example', name: null }, 'Dry Run');
  await C.ensureCell(org.id, 'test', { game: { id: 'g', name: 'G', engine: 'web', live: 'https://g.example' } });
  assert.equal(calls.length, 0);
  // The first game left for the cell, its Gen key asked for, the service, then who may reach it.
  assert.deepEqual(R.planned.map((p) => p.method), ['PUT', 'POST', 'POST', 'POST']);
  assert.match(R.planned[1].url, /\/v1\/clients$/);
  assert.match(R.planned[2].url, new RegExp(`/services\\?serviceId=studio-o-${org.id}$`));
  delete process.env.STUDIO_CELLS_DRY_RUN;
});

test('invited people at the front door: they land in the org that invited them, or pick among several; never the sign-up', async () => {
  const paying = C.orgsOf('7000003')[0];
  const cellReq = (org: string) => req({ Authorization: `Bearer ${K.deriveKey('cell', org)}`, 'X-Studio-Cell': org }, 'POST');
  const body = (b: unknown) => async () => b;
  // The cell reports its people: a member who signed in (sub known) and an open invite (email only).
  const out = res();
  await C.handleCellsKeyed(cellReq(paying.id), out, '/api/cells/self/members', 'POST', send, body({ people: [
    { email: 'c@c.example', sub: '7000003', role: 'admin', kind: 'member' },
    { email: 'Artist@Studio.example', role: 'member', kind: 'invite' },
  ] }));
  assert.equal(out.body.people, 2);
  const artist = { email: 'artist@studio.example', sub: '7100001', name: 'Artist' };
  assert.equal(C.frontDoor(artist).next, `/o/${paying.id}/`, 'straight into the org that invited them');
  // In two orgs: they pick one.
  const other = C.createOrg({ sub: '7000009', email: 'z@z.example', name: null }, 'Other Studio');
  await C.handleCellsKeyed(cellReq(other.id), res(), '/api/cells/self/members', 'POST', send, body({ people: [{ email: 'artist@studio.example', role: 'member', kind: 'invite' }] }));
  assert.equal(C.frontDoor(artist).next, '/auth/start');
  assert.deepEqual(C.orgsOf(artist.sub, artist.email).map((o) => o.id).sort(), [paying.id, other.id].sort());
  // By Google's id from now on, even if the email were to change.
  assert.deepEqual(C.orgsOf(artist.sub).map((o) => o.id).sort(), [paying.id, other.id].sort());
  // Removed in the cell: no way in from here.
  await C.handleCellsKeyed(cellReq(paying.id), res(), '/api/cells/self/members', 'POST', send, body({ people: [{ email: 'c@c.example', sub: '7000003', role: 'admin' }] }));
  assert.deepEqual(C.orgsOf(artist.sub, artist.email).map((o) => o.id), [other.id]);
  // Another cell's key can't speak for this one.
  const no = res();
  await C.handleCellsKeyed(req({ Authorization: `Bearer ${K.deriveKey('cell', other.id)}`, 'X-Studio-Cell': paying.id }, 'POST'), no, '/api/cells/self/members', 'POST', send, body({ people: [] }));
  assert.equal(no.status, 401);
});

test("the cell's Connect your AI goes to Gen for its org (reviews and Gen tools use it); removing it removes it there", async () => {
  const paying = C.getOrg(C.orgsOf('7000003')[0].id)!;
  const cellReq = () => req({ Authorization: `Bearer ${K.deriveKey('cell', paying.id)}`, 'X-Studio-Cell': paying.id }, 'POST');
  genCalls.length = 0;
  await C.handleCellsKeyed(cellReq(), res(), '/api/cells/self/ai', 'POST', send, async () => ({ kind: 'anthropic', key: 'sk-ant-api03-PayingOwnKey_abcdefghijklmnop' }));
  await C.handleCellsKeyed(cellReq(), res(), '/api/cells/self/ai', 'POST', send, async () => ({ kind: 'claude-subscription', key: null }));
  assert.deepEqual(genCalls.map((g) => `${g.method} ${g.path}`), [`PUT /org/keys/anthropic?org=${paying.genOrg}`, `DELETE /org/keys/claude-subscription?org=${paying.genOrg}`]);
  assert.deepEqual(genCalls[0].body, { key: 'sk-ant-api03-PayingOwnKey_abcdefghijklmnop' });
});

test('no game yet: the first-game page has "Make one with Talk", which starts the studio empty and opens Talk on it', async () => {
  const A9 = { sub: '7000009', email: 'new@maker.example', name: 'New Maker' };
  const org = C.createOrg(A9, 'Blank Slate');
  const cookie = /^hs_cp=[^;]+/.exec(C.frontDoor(A9).cookie)![0];
  const page = (route: string, method = 'GET', bodyText = '') => {
    const r: any = (async function* () { if (bodyText) yield Buffer.from(bodyText); })();
    r.headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' };
    r.method = method;
    r.socket = { remoteAddress: '203.0.113.9' };
    const out: any = { status: 0, headers: {}, body: '' };
    out.writeHead = (s: number, h: any) => { out.status = s; out.headers = h; };
    out.end = (b?: string) => { out.body = b ?? ''; };
    return C.handleStart(r, out, new URL(`https://studio.hawkesgen.ai${route}`)).then(() => out);
  };
  const form = await page(`/auth/start/${org.id}`);
  assert.match(form.body, /No game yet\? Make one with Talk/);
  const made = await page(`/auth/start/${org.id}/game`, 'POST', 'make=1');
  assert.equal(made.status, 303);
  assert.equal(made.headers.Location, `/o/${org.id}/?ask=make#talk`);
  assert.equal(C.getOrg(org.id)!.state, 'awake', 'the studio is up, with no game in it');
  assert.equal(objects.has(`o/${org.id}/state/onboarding.json`), false);
});
