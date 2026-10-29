// The job broker (jobbroker.ts): a customer's agent run reaches only its own run's folder through the control plane;
// the job itself has no bucket access. An org A run can't list or read org B's objects, nor another run's in its own
// org; a cell can only sign tokens for its own org. The bucket is an in-memory stand-in; the broker runs over real HTTP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.STUDIO_CELLS_MASTER = 'b'.repeat(40);
const K = await import('../src/cellkeys.ts');
const J = await import('../src/jobbroker.ts');

const objects = new Map<string, Buffer>([
  ['o/org-aaaa/jobs/u1/spec.json', Buffer.from('{"a":1}')],
  ['o/org-aaaa/jobs/u2/spec.json', Buffer.from('{"other run":1}')],
  ['o/org-bbbb/jobs/u1/spec.json', Buffer.from('{"secret of B":1}')],
  ['o/org-bbbb/state/products.json', Buffer.from('{"B":1}')],
  ['o/org-bbbb/db/studio.db', Buffer.from('B db')],
]);
const signed: string[] = [];
const deps: import('../src/jobbroker.ts').BrokerDeps = {
  bucket: 'cells',
  list: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)),
  read: async (n) => objects.get(n) ?? null,
  write: async (n, d) => { objects.set(n, d); },
  remove: async (n) => { objects.delete(n); },
  sign: async (m, n) => { signed.push(`${m} ${n}`); return null; },
};
const srv = http.createServer((req, res) => void J.handleBroker(req, res, new URL(req.url!, 'http://x'), deps));
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(srv.address() as any).port}/api/cells/broker`;
after(() => srv.close());

const tokenA = J.runToken('org-aaaa', 'u1', K.deriveKey('broker', 'org-aaaa'));
const call = (token: string, op: string, key: string, method = 'GET', body?: string) => fetch(`${base}?op=${op}&key=${encodeURIComponent(key)}`, { method, headers: { 'X-Hawkes-Run-Token': token }, body });

test("org A's run: its own folder works, through the broker", async () => {
  const s = J.brokerStore(base, tokenA);
  assert.equal((await s.get('jobs/u1/spec.json'))!.toString(), '{"a":1}');
  await s.put('jobs/u1/out/exit.json', '{"code":0}');
  assert.equal(objects.get('o/org-aaaa/jobs/u1/out/exit.json')!.toString(), '{"code":0}');
  assert.deepEqual((await s.list('jobs/u1/out/')).sort(), ['jobs/u1/out/exit.json']);
  assert.equal(await s.get('jobs/u1/missing'), null);
  await s.remove('jobs/u1/out/exit.json');
  assert.equal(objects.has('o/org-aaaa/jobs/u1/out/exit.json'), false);
  assert.ok(signed.includes('GET o/org-aaaa/jobs/u1/spec.json'), 'a signed URL was asked for first');
});

test("org A's run can't list or read org B's objects, nor another run's, nor its Studio's own data", async () => {
  for (const key of ['jobs/u2/spec.json', 'state/products.json', 'db/studio.db', '../org-bbbb/jobs/u1/spec.json', 'jobs/u1/../../../org-bbbb/db/studio.db', 'o/org-bbbb/jobs/u1/spec.json', 'jobs/u1//x']) {
    for (const op of ['read', 'url', 'list']) assert.equal((await call(tokenA, op, key)).status, 403, `${op} ${key}`);
  }
  assert.equal((await call(tokenA, 'write', 'jobs/u2/spec.json', 'PUT', 'x')).status, 403);
  assert.equal((await call(tokenA, 'remove', 'state/products.json', 'POST')).status, 403);
  // Listing its own folder never shows anything else, even with a prefix that would match more in the bucket.
  const names: string[] = ((await (await call(tokenA, 'list', 'jobs/u1/')).json()) as any).names;
  assert.deepEqual(names, ['jobs/u1/spec.json']);
  assert.equal(objects.get('o/org-bbbb/jobs/u1/spec.json')!.toString(), '{"secret of B":1}', "B's objects untouched");
});

test('tokens: org B\'s run can\'t be claimed with A\'s key; forged, expired and missing tokens are refused', async () => {
  // A compromised cell A signing a token that names org B, with its own key: the control plane checks B's key.
  const forged = J.runToken('org-bbbb', 'u1', K.deriveKey('broker', 'org-aaaa'));
  assert.equal(J.readRunToken(forged), null);
  assert.equal((await call(forged, 'read', 'jobs/u1/spec.json')).status, 401);
  const [body, sig] = tokenA.split('.');
  const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), org: 'org-bbbb' })).toString('base64url');
  assert.equal((await call(`${swapped}.${sig}`, 'read', 'jobs/u1/spec.json')).status, 401);
  assert.equal(J.readRunToken(tokenA, Date.now() + 7 * 3600_000), null, 'expired after 6 hours');
  assert.equal((await call('', 'read', 'jobs/u1/spec.json')).status, 401);
  assert.deepEqual(J.readRunToken(tokenA), { org: 'org-aaaa', unit: 'u1' });
});

test('a cell starts its runs with a run token and the broker, not the bucket', async () => {
  process.env.STUDIO_ORG = 'org-aaaa';
  process.env.STUDIO_CONTROL_URL = 'https://studio.hawkesgen.ai/';
  process.env.STUDIO_BROKER_KEY = K.deriveKey('broker', 'org-aaaa');
  const { brokerEnv } = await import('../src/cloudjob.ts');
  const env = brokerEnv('u9');
  assert.equal(env.STUDIO_BROKER_URL, 'https://studio.hawkesgen.ai/api/cells/broker');
  assert.deepEqual(J.readRunToken(env.STUDIO_RUN_TOKEN), { org: 'org-aaaa', unit: 'u9' });
  delete process.env.STUDIO_ORG;
  assert.deepEqual(brokerEnv('u9'), {}, "J's Studio: none (its job reads its own bucket)");
});
