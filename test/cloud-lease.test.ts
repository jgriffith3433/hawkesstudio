// One writer of Studio's database at a time (cloudlease.ts; 2026-10-31: a deploy's old instance kept writing its own copy
// and J's new game, its agent change and his Approve cards were lost). A stand-in for Cloud Storage; no Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lease-'));
process.env.STUDIO_DATA = tmp;
process.env.STUDIO_STATE_BUCKET = 'lease-test';
process.env.STUDIO_STATE_PREFIX = '';
process.env.STUDIO_LEASE_ID_FILE = path.join(tmp, 'lease-id');
process.env.STUDIO_LEASE_GEN_FILE = path.join(tmp, 'restore-generation');
process.env.STUDIO_LITESTREAM_GEN_FILE = path.join(tmp, 'litestream-generation');

const { setGcpFetch } = await import('../src/gcp.ts');
const L = await import('../src/cloudlease.ts');

const objects = new Map<string, Buffer>();
setGcpFetch((async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  let m = /upload\/storage\/v1\/b\/[^/]+\/o\?uploadType=media&name=([^&]+)/.exec(url);
  if (m) { objects.set(decodeURIComponent(m[1]), Buffer.from(init.body)); return json(200, {}); }
  m = /storage\/v1\/b\/[^/]+\/o\/([^?]+)\?alt=media$/.exec(url);
  if (m) { const b = objects.get(decodeURIComponent(m[1])); return b ? new Response(new Uint8Array(b)) : json(404, {}); }
  m = /storage\/v1\/b\/[^/]+\/o\/([^?]+)$/.exec(url);
  if (m && method === 'DELETE') { objects.delete(decodeURIComponent(m[1])); return json(200, {}); }
  return json(404, { error: { message: `no stand-in for ${method} ${url}` } });
}) as typeof fetch, 'test-token');

test('the first instance takes the lease at once', async () => {
  const r: any = await L.claim();
  assert.equal(r.how, 'first');
  assert.equal(L.myLeaseId(), r.id);
  assert.equal(JSON.parse(objects.get('db/lease.json')!.toString()).id, r.id);
  assert.ok(objects.has(`db/alive-${r.id}`));
});

test('a deploy: the new instance waits for the old one to stop and restores exactly the generation it wrote', async () => {
  const old = L.myLeaseId()!;
  // The old instance notices the newer claim on its next check, stops, and (after Litestream's last sync) releases.
  let lostTo: string | null = null;
  const stop = L.watchLease((by) => { lostTo = by.id; }, { everyMs: 20 });
  fs.writeFileSync(process.env.STUDIO_LITESTREAM_GEN_FILE!, '5ee59909c639c135\n');
  const claiming = L.claim({ pollMs: 10, waitMs: 5000 });
  const released = (async () => {
    while (!lostTo) await new Promise((r) => setTimeout(r, 10));
    await L.release(old);
  })();
  const [r]: any[] = await Promise.all([claiming, released]);
  stop();
  assert.equal(r.previous, old);
  assert.equal(r.how, 'released');
  assert.equal(r.generation, '5ee59909c639c135');
  assert.equal(fs.readFileSync(process.env.STUDIO_LEASE_GEN_FILE!, 'utf8'), '5ee59909c639c135', 'entrypoint.sh restores this generation');
  assert.equal(lostTo, r.id, 'the old instance learned who took over');
  assert.ok(!objects.has(`db/alive-${old}`), 'its heartbeat is gone');
});

test("a crashed holder (no heartbeat) doesn't hold a new instance up", async () => {
  fs.rmSync(process.env.STUDIO_LEASE_GEN_FILE!, { force: true });
  const dead = L.myLeaseId()!;
  objects.set(`db/alive-${dead}`, Buffer.from(String(Date.now() - 60_000)));
  const r: any = await L.claim({ pollMs: 10, staleMs: 15_000 });
  assert.equal(r.how, 'quiet');
  assert.ok(r.waited < 1000);
  assert.equal(fs.existsSync(process.env.STUDIO_LEASE_GEN_FILE!), false, 'no generation named: restore takes the newest');
});
