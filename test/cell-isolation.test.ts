// Cells isolated from each other (docs/studio-customers.md "Isolation"; cellrun.ts, cells.ts): with STUDIO_CELLS_ISOLATE=1
// every cell runs as its own service account, whose only data grant is objectAdmin on its own managed folder o/<org>/
// (plus running the shared agents' job). So one cell can never hold a credential for another's prefix: no cell account
// is on another's folder or on the bucket itself, and its agent runs reach only their own run's folder through the
// broker (test/jobbroker.test.ts). Deleting an org's data takes its account, folder and job grant away.
// Google is a stand-in (IAM service accounts, Cloud Storage managed folders and their policies, Cloud Run services and
// the job's policy); Gen too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-isolation-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_ISOLATE = '1';
process.env.STUDIO_CELLS_MASTER = 'i'.repeat(40);
process.env.STUDIO_CELLS_PROJECT = 'hawkes-test';
process.env.STUDIO_CELLS_PROJECT_NUMBER = '123456';
process.env.STUDIO_CELLS_REGION = 'us-east4';
process.env.STUDIO_CELLS_SA = 'studio-cells@hawkes-test.iam.gserviceaccount.com';
process.env.STUDIO_CELLS_BUCKET = 'hawkes-test-studio-cells';
process.env.STUDIO_CELLS_AGENT_JOB = 'studio-cell-agent';
process.env.STUDIO_CELLS_IMAGE = 'us-east4-docker.pkg.dev/hawkes-test/studio/studio:v1';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai';
for (const k of ['STUDIO_ORG', 'STUDIO_SIGNUP', 'STUDIO_CELLS_DRY_RUN', 'STUDIO_LANE']) delete process.env[k];

const R = await import('../src/cellrun.ts');
const C = await import('../src/cells.ts');
const { setGcpFetch } = await import('../src/gcp.ts');
C.setGenCall(async (method, p) => (method === 'POST' && p === '/clients' ? { key: 'hg_x', client: { id: 'c_000001' } } : { ok: true }));

// Google, standing in.
const accounts = new Set<string>();
const folders = new Map<string, { bindings: { role: string; members: string[] }[] }>();
const services = new Map<string, any>();
const objects = new Map<string, Buffer>();
let jobPolicy: { bindings: { role: string; members: string[] }[]; etag?: string } = { bindings: [{ role: 'roles/run.jobsExecutorWithOverrides', members: ['serviceAccount:studio-cells@hawkes-test.iam.gserviceaccount.com'] }] };
const bucketPolicy = { bindings: [{ role: 'roles/storage.objectAdmin', members: ['serviceAccount:studio-control@hawkes-test.iam.gserviceaccount.com'] }] };
setGcpFetch((async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  let m = /iam\.googleapis\.com\/v1\/projects\/[^/]+\/serviceAccounts(?:\/([^/?]+))?$/.exec(url);
  if (m) {
    if (method === 'POST') {
      const email = `${body.accountId}@hawkes-test.iam.gserviceaccount.com`;
      assert.ok(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(body.accountId), `a valid account id: ${body.accountId}`);
      if (accounts.has(email)) return json(409, { error: { message: 'exists' } });
      accounts.add(email);
      return json(200, { email });
    }
    if (method === 'DELETE') return accounts.delete(decodeURIComponent(m[1])) ? json(200, {}) : json(404, { error: { message: 'gone' } });
  }
  m = /storage\/v1\/b\/[^/]+\/managedFolders(?:\/([^/?]+)(\/iam)?)?$/.exec(url);
  if (m) {
    if (!m[1] && method === 'POST') { if (folders.has(body.name)) return json(409, { error: { message: 'exists' } }); folders.set(body.name, { bindings: [] }); return json(200, body); }
    const name = decodeURIComponent(m[1]);
    if (m[2] && method === 'PUT') { if (!folders.has(name)) return json(404, { error: { message: 'no folder' } }); folders.set(name, { bindings: body.bindings }); return json(200, body); }
    if (!m[2] && method === 'DELETE') return folders.delete(name) ? json(200, {}) : json(404, { error: { message: 'gone' } });
  }
  m = /run\.googleapis\.com\/v2\/projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/:]+:(getIamPolicy|setIamPolicy)$/.exec(url);
  if (m) { if (m[1] === 'setIamPolicy') jobPolicy = body.policy; return json(200, jobPolicy); }
  m = /run\.googleapis\.com\/v2\/projects\/[^/]+\/locations\/[^/]+\/services(?:\?serviceId=([^&]+))?$/.exec(url);
  if (m && method === 'POST') { services.set(m[1], { name: m[1], ...body }); return json(200, { name: `operations/${m[1]}` }); }
  m = /\/services\/([^/:?]+)(:setIamPolicy)?(\?.*)?$/.exec(url);
  if (m) {
    if (m[2]) return json(200, {});
    if (method === 'DELETE') return services.delete(m[1]) ? json(200, {}) : json(404, { error: { message: 'gone' } });
    if (method === 'PATCH') { const s = services.get(m[1]); s.template = { ...s.template, ...body.template }; return json(200, {}); }
    return services.has(m[1]) ? json(200, services.get(m[1])) : json(404, { error: { message: 'gone' } });
  }
  m = /storage\/v1\/b\/[^/]+\/o\?prefix=([^&]+)/.exec(url);
  if (m) return json(200, { items: [...objects.keys()].filter((k) => k.startsWith(decodeURIComponent(m![1]))).map((name) => ({ name, size: 1, updated: '' })) });
  m = /upload\/storage\/v1\/b\/[^/]+\/o\?uploadType=media&name=([^&]+)/.exec(url);
  if (m) { objects.set(decodeURIComponent(m[1]), Buffer.from(init.body)); return json(200, {}); }
  m = /storage\/v1\/b\/[^/]+\/o\/([^?]+)$/.exec(url);
  if (m && method === 'DELETE') { objects.delete(decodeURIComponent(m[1])); return json(200, {}); }
  return json(404, { error: { message: `no stand-in for ${method} ${url}` } });
}) as typeof fetch, 'test-token');

const env = (svc: any) => Object.fromEntries(svc.template.containers[0].env.map((e: any) => [e.name, e.value]));
const memberOf = (sa: string) => `serviceAccount:${sa}`;

test('two cells: each its own account, each account on its own folder alone, never on the bucket or another folder', async () => {
  const a = C.createOrg({ sub: '8100001', email: 'a@a.example', name: null }, 'Alpha Games');
  const b = C.createOrg({ sub: '8100002', email: 'b@b.example', name: null }, 'Beta Works');
  await C.ensureCell(a.id, 'first game', { game: { id: 'one', name: 'One', engine: 'web', live: 'https://one.example' } });
  await C.ensureCell(b.id, 'first game', { game: { id: 'two', name: 'Two', engine: 'web', live: 'https://two.example' } });
  const saA = R.cellSaEmail(a.id);
  const saB = R.cellSaEmail(b.id);
  assert.notEqual(saA, saB);
  assert.ok(accounts.has(saA) && accounts.has(saB));
  // Each service runs as its own account, not the shared one.
  assert.equal(services.get(R.serviceName(a.id)).template.serviceAccount, saA);
  assert.equal(services.get(R.serviceName(b.id)).template.serviceAccount, saB);
  // Each folder's whole policy: its own account only.
  assert.deepEqual(folders.get(`o/${a.id}/`), { bindings: [{ role: 'roles/storage.objectAdmin', members: [memberOf(saA)] }] });
  assert.deepEqual(folders.get(`o/${b.id}/`), { bindings: [{ role: 'roles/storage.objectAdmin', members: [memberOf(saB)] }] });
  // No cell account anywhere else that could reach another prefix: not on another folder, not on the bucket.
  for (const [name, pol] of folders) for (const sa of [saA, saB]) {
    const own = name === `o/${sa === saA ? a.id : b.id}/`;
    assert.equal(pol.bindings.some((x) => x.members.includes(memberOf(sa))), own, `${sa} on ${name}`);
  }
  for (const sa of [saA, saB]) assert.ok(!bucketPolicy.bindings.some((x) => x.members.includes(memberOf(sa))), 'no bucket-wide grant');
  // They may run the shared agents' job (whose runs reach only their own run folder through the broker).
  for (const sa of [saA, saB]) for (const role of ['roles/run.jobsExecutorWithOverrides', 'roles/run.viewer']) {
    assert.ok(jobPolicy.bindings.find((x) => x.role === role)!.members.includes(memberOf(sa)), `${sa} ${role}`);
  }
  // The shared account already on the job keeps its grant (the job's policy is read, changed and written back).
  assert.ok(jobPolicy.bindings.find((x) => x.role === 'roles/run.jobsExecutorWithOverrides')!.members.includes('serviceAccount:studio-cells@hawkes-test.iam.gserviceaccount.com'));
  // Ids: 6-30 characters, per lane, from the org (stable: the same account the next time).
  assert.match(R.cellSaId(a.id), /^cell-l-[0-9a-f]{20}$/);
  assert.equal(R.cellSaId(a.id), R.cellSaId(a.id));
  assert.equal(env(services.get(R.serviceName(a.id))).STUDIO_STATE_PREFIX, `o/${a.id}/`);
});

test('the setup\'s migration: a cell made on the shared account moves to its own; running it again changes nothing', async () => {
  // A cell from before isolation: on the shared account, no folder.
  process.env.STUDIO_CELLS_ISOLATE = '0';
  const old = C.createOrg({ sub: '8100003', email: 'c@c.example', name: null }, 'Old Cell');
  await C.ensureCell(old.id, 'first game', { game: { id: 'three', name: 'Three', engine: 'web', live: 'https://three.example' } });
  assert.equal(services.get(R.serviceName(old.id)).template.serviceAccount, process.env.STUDIO_CELLS_SA);
  await assert.rejects(C.isolateCells(), /Turn isolation on first/);
  process.env.STUDIO_CELLS_ISOLATE = '1';
  const r = await C.isolateCells();
  assert.ok(r.moved.some((x) => x.startsWith(old.id)), JSON.stringify(r));
  assert.deepEqual(r.errors, []);
  assert.equal(services.get(R.serviceName(old.id)).template.serviceAccount, R.cellSaEmail(old.id));
  assert.deepEqual(folders.get(`o/${old.id}/`)!.bindings[0].members, [memberOf(R.cellSaEmail(old.id))]);
  const again = await C.isolateCells();
  assert.deepEqual(again.errors, []);
  assert.equal(accounts.size, 3, 'no second account for anyone');
});

test("deleting an org's data takes its account, folder and job grant away; the others keep theirs", async () => {
  const [a, b] = C.listOrgs().filter((o) => o.name === 'Alpha Games' || o.name === 'Beta Works');
  const sa = R.cellSaEmail(a.id);
  objects.set(`o/${a.id}/state/products.json`, Buffer.from('{}'));
  await C.deleteOrgData(a.id);
  assert.equal(accounts.has(sa), false);
  assert.equal(folders.has(`o/${a.id}/`), false);
  assert.ok(!jobPolicy.bindings.some((x) => x.members.includes(memberOf(sa))));
  assert.ok(accounts.has(R.cellSaEmail(b.id)) && folders.has(`o/${b.id}/`));
  assert.ok(jobPolicy.bindings.some((x) => x.members.includes(memberOf(R.cellSaEmail(b.id)))));
});

test('beta and live cells of the same org id get different accounts (they share the project)', () => {
  process.env.STUDIO_LANE = 'beta';
  const beta = R.cellSaId('same-org-1a2b');
  delete process.env.STUDIO_LANE;
  assert.match(beta, /^cell-b-/);
  assert.notEqual(beta, R.cellSaId('same-org-1a2b'));
});
