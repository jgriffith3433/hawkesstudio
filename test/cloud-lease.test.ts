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
/** Heartbeat writes hang (until their request's deadline aborts them), as on a busy server on 2026-11-11. */
let hangBeats = false;
setGcpFetch((async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  if (hangBeats && /uploadType=media&name=db%2Falive-/.test(url)) {
    return new Promise((_, no) => init.signal?.addEventListener('abort', () => no(new Error('aborted'))));
  }
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
  const claiming = L.claim({ pollMs: 10, waitMs: 5000, confirmMs: 50 });
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

test("a stray instance of an older revision never takes the database from a newer one (it stays down)", async () => {
  assert.equal(L.revNumber('studio-beta-00043-9r2'), 43);
  assert.equal(L.revNumber('studio-beta-o-acme-1a2b-00007-x1y'), 7);
  assert.equal(L.revNumber(null), 0);
  const newer: any = await L.claim({ rev: 'studio-beta-00043-9r2', pollMs: 10, staleMs: 0, confirmMs: 50 });
  assert.equal(newer.claimed, true);
  const before = objects.get('db/lease.json')!.toString();
  const old: any = await L.claim({ rev: 'studio-beta-00042-fxq', confirmMs: 50 });
  assert.equal(old.claimed, false);
  assert.equal(old.how, 'newer holds it');
  assert.equal(objects.get('db/lease.json')!.toString(), before, 'the lease is untouched');
  // The same revision restarting (a crash, a new instance) takes it as usual.
  objects.set(`db/released-${newer.id}`, Buffer.from('{}'));
  const again: any = await L.claim({ rev: 'studio-beta-00043-9r2', pollMs: 10, confirmMs: 50 });
  assert.equal(again.claimed, true);
});

test("a holder that is shutting down gets its time; only one already silent before the claim is skipped", async () => {
  const holder = L.myLeaseId()!;
  objects.set(`db/alive-${holder}`, Buffer.from(String(Date.now())));
  const r: any = await L.claim({ rev: 'studio-beta-00044-a1b', pollMs: 10, staleMs: 15_000, waitMs: 300, confirmMs: 50 });
  assert.equal(r.how, 'timed out', 'alive at the claim: waited for its release (here, until the test limit)');
});

test("a crashed holder (no heartbeat) doesn't hold a new instance up, and its last heartbeat names what to restore", async () => {
  fs.rmSync(process.env.STUDIO_LEASE_GEN_FILE!, { force: true });
  const dead = L.myLeaseId()!;
  objects.set(`db/alive-${dead}`, Buffer.from(JSON.stringify({ at: Date.now() - 60_000, generation: '062800f778d554ed' })));
  const r: any = await L.claim({ rev: 'studio-beta-00045-c2d', pollMs: 10, staleMs: 15_000, confirmMs: 50 });
  assert.equal(r.how, 'quiet');
  assert.ok(r.waited < 1000);
  assert.equal(r.generation, '062800f778d554ed');
  assert.equal(fs.readFileSync(process.env.STUDIO_LEASE_GEN_FILE!, 'utf8'), '062800f778d554ed', 'restored by name, never a guess');
  // An old heartbeat (the time alone) still reads.
  objects.set(`db/alive-${r.id}`, Buffer.from(String(Date.now() - 60_000)));
  fs.rmSync(process.env.STUDIO_LEASE_GEN_FILE!, { force: true });
  const r2: any = await L.claim({ rev: 'studio-beta-00046-e3f', pollMs: 10, staleMs: 15_000, confirmMs: 50 });
  assert.equal(r2.how, 'quiet');
  assert.equal(r2.generation, null);
});

test("a second instance of the same revision stays down while the holder is alive; it takes over once the holder is quiet", async () => {
  const holder: any = await L.claim({ rev: 'studio-beta-00090-6wd', pollMs: 10, staleMs: 0, confirmMs: 50 });
  assert.equal(holder.claimed, true);
  const before = objects.get('db/lease.json')!.toString();
  const stray: any = await L.claim({ rev: 'studio-beta-00090-6wd', confirmMs: 50 });
  assert.equal(stray.claimed, false, 'Cloud Run started it under load: the working instance keeps the database');
  assert.equal(stray.how, 'same revision holds it');
  assert.equal(objects.get('db/lease.json')!.toString(), before, 'the lease is untouched');
  // A holder that died (no heartbeat for staleMs) is replaced by the next instance of its revision.
  objects.set(`db/alive-${holder.id}`, Buffer.from(JSON.stringify({ at: Date.now() - 60_000 })));
  const next: any = await L.claim({ rev: 'studio-beta-00090-6wd', pollMs: 10, confirmMs: 50 });
  assert.equal(next.claimed, true);
  assert.equal(next.how, 'quiet');
});

test("a Studio woken after hibernation starts: the lease's newer revision belonged to the deleted service and is silent", async () => {
  const gone: any = await L.claim({ rev: 'studio-o-acme-1a2b-00004-xyz', pollMs: 10, staleMs: 0, olderSilentMs: 0, confirmMs: 50 });
  assert.equal(gone.claimed, true);
  objects.delete(`db/alive-${gone.id}`);
  objects.set(`db/released-${gone.id}`, Buffer.from('{}'));
  const woken: any = await L.claim({ rev: 'studio-o-acme-1a2b-00001-abc', pollMs: 10, waitMs: 300, confirmMs: 50 });
  assert.equal(woken.claimed, true, `took it (${woken.how})`);
});

test("a holder Cloud Run stopped sending requests to is replaced by the next instance of its revision; a working one isn't", async () => {
  const holder: any = await L.claim({ rev: 'studio-o-acme-1a2b-00022-g9p', pollMs: 10, staleMs: 0, olderSilentMs: 0, confirmMs: 50 });
  assert.equal(holder.claimed, true);
  const beat = (servedAgo: number) => objects.set(`db/alive-${holder.id}`, Buffer.from(JSON.stringify({ at: Date.now(), servedAt: Date.now() - servedAgo })));
  // Alive, and answered a request a moment ago: Cloud Run started the stray under load. It stays down.
  beat(1000);
  const busy: any = await L.claim({ rev: 'studio-o-acme-1a2b-00022-g9p', pollMs: 10, confirmMs: 50 });
  assert.equal(busy.how, 'same revision holds it');
  // Idle for a while, then a burst: it answers while the stray watches, so the stray stays down.
  beat(60_000);
  setTimeout(() => beat(0), 20);
  const burst: any = await L.claim({ rev: 'studio-o-acme-1a2b-00022-g9p', pollMs: 10, confirmMs: 200 });
  assert.equal(burst.how, 'same revision holds it');
  // A heartbeat without servedAt (an older image): kept, as before.
  objects.set(`db/alive-${holder.id}`, Buffer.from(JSON.stringify({ at: Date.now() })));
  const old: any = await L.claim({ rev: 'studio-o-acme-1a2b-00022-g9p', pollMs: 10, confirmMs: 50 });
  assert.equal(old.how, 'same revision holds it');
  // Alive but answering nothing (2026-11-01: a customer's Studio was unreachable for half an hour): the stray takes the
  // lease, the holder sees it, stops and releases, and the stray restores what it wrote.
  beat(60_000);
  let lost = false;
  const watcher = setInterval(() => {
    const lease = JSON.parse(objects.get('db/lease.json')!.toString());
    if (!lost && lease.id !== holder.id) { lost = true; void L.release(holder.id); }
  }, 10);
  const next: any = await L.claim({ rev: 'studio-o-acme-1a2b-00022-g9p', pollMs: 10, confirmMs: 50, waitMs: 2000 });
  clearInterval(watcher);
  assert.equal(next.claimed, true);
  assert.equal(next.how, 'released');
  assert.equal(next.took, 'the holder answered nothing');
  assert.ok(lost, 'the holder learned it was replaced');
});

test("a stray doesn't call a holder gone on one old heartbeat: a late write that lands inside the confirm window keeps the database", async () => {
  const holder: any = await L.claim({ rev: 'studio-beta-00120-aaa', pollMs: 10, staleMs: 0, confirmMs: 50 });
  objects.set(`db/alive-${holder.id}`, Buffer.from(JSON.stringify({ at: Date.now() - 60_000 })));
  const before = objects.get('db/lease.json')!.toString();
  setTimeout(() => objects.set(`db/alive-${holder.id}`, Buffer.from(JSON.stringify({ at: Date.now() }))), 100);
  const stray: any = await L.claim({ rev: 'studio-beta-00120-aaa', pollMs: 20, confirmMs: 500 });
  assert.equal(stray.claimed, false);
  assert.equal(stray.how, 'same revision holds it');
  assert.equal(objects.get('db/lease.json')!.toString(), before);
});

test("2026-11-09 02:33-02:35: a newer holder still restoring is not taken from by a fresh instance of the older revision", async () => {
  const newer: any = await L.claim({ rev: 'studio-o-j-studio-4f12-00301-h77', pollMs: 10, staleMs: 0, confirmMs: 50 });
  assert.equal(newer.claimed, true);
  const body = () => objects.get('db/lease.json')!.toString();
  const before = body();
  // Restore and start-up: the claim's one heartbeat goes 35 s old, past staleMs (15 s).
  objects.set(`db/alive-${newer.id}`, Buffer.from(JSON.stringify({ at: Date.now() - 35_000, starting: true })));
  for (let i = 0; i < 3; i++) {
    const old: any = await L.claim({ rev: 'studio-o-j-studio-4f12-00300-47b', pollMs: 10, confirmMs: 50 });
    assert.equal(old.claimed, false, `try ${i}: stays down`);
    assert.equal(old.how, 'newer holds it');
    assert.equal(body(), before, 'the lease is untouched');
  }
  // Silent for minutes AND not moving through the confirm window: only then is it gone.
  objects.set(`db/alive-${newer.id}`, Buffer.from(JSON.stringify({ at: Date.now() - 300_000 })));
  setTimeout(() => objects.set(`db/alive-${newer.id}`, Buffer.from(JSON.stringify({ at: Date.now() }))), 20);
  const late: any = await L.claim({ rev: 'studio-o-j-studio-4f12-00300-47b', pollMs: 10, confirmMs: 200 });
  assert.equal(late.claimed, false, 'it beat inside the confirm window');
  objects.set(`db/alive-${newer.id}`, Buffer.from(JSON.stringify({ at: Date.now() - 300_000 })));
  const gone: any = await L.claim({ rev: 'studio-o-j-studio-4f12-00300-47b', pollMs: 10, confirmMs: 50 });
  assert.equal(gone.claimed, true);
  assert.equal(gone.how, 'quiet');
});

test("the startup heartbeat keeps a claim alive through restore, and ends when the server beats", async () => {
  const claimed: any = await L.claim({ rev: 'studio-o-j-studio-4f12-00310-aaa', pollMs: 10, staleMs: 0, confirmMs: 50 });
  assert.equal(claimed.claimed, true);
  assert.equal(JSON.parse(objects.get(`db/alive-${claimed.id}`)!.toString()).starting, true);
  objects.set(`db/alive-${claimed.id}`, Buffer.from(JSON.stringify({ at: Date.now() - 60_000 })));
  const ending = L.startupBeat({ everyMs: 10, maxMs: 5000 });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(Date.now() - JSON.parse(objects.get(`db/alive-${claimed.id}`)!.toString()).at < 1000, 'the heartbeat is fresh while the server starts');
  const stop = L.watchLease(() => {}, { everyMs: 10 });
  assert.equal(await ending, 'server beating');
  stop();
});

test("a quiet takeover by a newer revision also waits out the confirm window", async () => {
  const holder: any = await L.claim({ rev: 'studio-beta-00320-aaa', pollMs: 10, staleMs: 0, confirmMs: 50 });
  objects.set(`db/alive-${holder.id}`, Buffer.from(JSON.stringify({ at: Date.now() - 60_000 })));
  const before = objects.get('db/lease.json')!.toString();
  setTimeout(() => objects.set(`db/alive-${holder.id}`, Buffer.from(JSON.stringify({ at: Date.now() }))), 50);
  const next: any = await L.claim({ rev: 'studio-beta-00321-bbb', pollMs: 20, confirmMs: 500 });
  assert.equal(next.claimed, false);
  assert.equal(next.how, 'holder still beating');
  assert.equal(objects.get('db/lease.json')!.toString(), before);
});

test("a holder whose heartbeat hangs still sees a takeover and stops (no two writers)", async () => {
  const holder: any = await L.claim({ rev: 'studio-o-j-studio-4f12-00101-ztm', pollMs: 10, staleMs: 0, confirmMs: 50 });
  let lostTo: string | null = null;
  hangBeats = true;
  const stop = L.watchLease((by) => { lostTo = by.id; }, { everyMs: 10, deadlineMs: 50 });
  // Its heartbeat hangs; the heartbeat goes quiet and a newer instance takes the database.
  await new Promise((r) => setTimeout(r, 60));
  objects.set('db/lease.json', Buffer.from(JSON.stringify({ id: 'l_newer', rev: 'studio-o-j-studio-4f12-00103-dtp', at: Date.now(), how: 'quiet' })));
  const until = Date.now() + 2000;
  while (!lostTo && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  stop();
  hangBeats = false;
  assert.equal(lostTo, 'l_newer', `the old holder (${holder.id}) learned it lost the database despite its hung heartbeat`);
});

// 2026-11-14: a go-live's new instance pulled 11,871 state files (75 s) only after the old one had stopped, and Cloud Run
// turned every page away meanwhile. Now what doesn't need the database is done before the lease is asked for.
test('a go-live prepares first: its state files come down while the holder still serves, then it asks for the lease', async () => {
  objects.clear();
  const first: any = await L.claim();
  assert.equal(first.how, 'first');
  const holder = first.id;
  let lostTo: string | null = null;
  const order: string[] = [];
  const stop = L.watchLease((by) => { lostTo = by.id; order.push('holder stops'); }, { everyMs: 20 });
  const prepare = async () => {
    await new Promise((r) => setTimeout(r, 120)); // several of the holder's checks: it must not stop while this runs
    assert.equal(JSON.parse(objects.get('db/lease.json')!.toString()).id, holder, 'the lease still names the holder');
    assert.equal(lostTo, null, 'the holder still serves while the new instance prepares');
    order.push('prepared');
  };
  const claiming = L.claim({ pollMs: 10, waitMs: 5000, confirmMs: 50, prepare });
  const released = (async () => { while (!lostTo) await new Promise((r) => setTimeout(r, 10)); await L.release(holder); })();
  const [r]: any[] = await Promise.all([claiming, released]);
  stop();
  assert.equal(r.how, 'released');
  assert.equal(r.previous, holder);
  assert.deepEqual(order, ['prepared', 'holder stops']);
});

test('the lease moved while preparing: the claim decides again from the new holder and prepares only once', async () => {
  const holder = L.myLeaseId()!;
  let prepared = 0;
  const other = 'l_0123456789ab';
  const prepare = async () => {
    prepared++;
    // Another instance took the lease meanwhile and is alive.
    objects.set('db/lease.json', Buffer.from(JSON.stringify({ id: other, rev: null, at: Date.now() })));
    objects.set(`db/alive-${other}`, Buffer.from(JSON.stringify({ at: Date.now(), generation: null, servedAt: Date.now() })));
  };
  const r: any = await L.claim({ pollMs: 10, waitMs: 200, confirmMs: 50, prepare });
  assert.equal(prepared, 1);
  assert.equal(r.previous, other, `decided from the new holder, not ${holder}`);
});
