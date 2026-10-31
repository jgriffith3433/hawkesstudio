// One writer of Studio's database at a time (2026-10-31: studio-beta lost J's new game, its agent change and his Approve
// cards on a deploy). Cloud Run's max-instances 1 is per revision: during a deploy, and for up to ~40 minutes after,
// the old revision's instance keeps running and Litestream keeps streaming its copy as its own generation. The new
// instance restored a different, older generation, and everything the old one wrote after that was on a copy nobody read.
//
// The lease lives in the state bucket beside the database (<prefix>db/):
//   lease.json        {id, rev, at}: who holds it. Only a starting instance writes it (claim).
//   alive-<id>        the holder's heartbeat, every 5 s.
//   released-<id>     the holder has stopped writing and Litestream made its last sync (written after it exits), with
//                     the Litestream generation it wrote: the next instance restores exactly that one, never a guess.
// A starting instance claims before it restores (entrypoint.sh: node src/cloudlease.ts claim), then waits for the
// previous holder's released-<id>, or until its heartbeat is 15 s old (crashed, or already gone). The holder checks the
// lease every 5 s (watchLease); when another instance claimed it, it saves its state files and exits, Litestream syncs
// one last time, and entrypoint.sh writes released-<id> (node src/cloudlease.ts release). Then the new instance restores
// from the generation that has everything.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { gcsDelete, gcsRead, gcsWrite } from './gcp.ts';
import { statePrefix, stateBucket } from './cloudhost.ts';

const ID_FILE = process.env.STUDIO_LEASE_ID_FILE || '/tmp/hawkes-lease-id';
// The generation to restore (entrypoint.sh passes it to litestream restore -generation), when the last holder named one.
const GEN_FILE = process.env.STUDIO_LEASE_GEN_FILE || '/tmp/hawkes-restore-generation';
// Litestream's own record of the generation this instance streams (beside the database).
const LOCAL_GEN = process.env.STUDIO_LITESTREAM_GEN_FILE || '/data/.studio.db-litestream/generation';
const GEN = /^[0-9a-f]{16}$/;
const key = (name: string) => `${statePrefix()}db/${name}`;
export type Lease = { id: string; rev: string | null; at: number };

const readJsonObj = async <T>(bucket: string, name: string): Promise<T | null> => {
  const b = await gcsRead(bucket, key(name)).catch(() => null);
  if (!b) return null;
  try { return JSON.parse(b.toString('utf8')) as T; } catch { return null; }
};

/** This instance's lease id (written by claim, read by the server and by release). */
export const myLeaseId = () => { try { return fs.readFileSync(ID_FILE, 'utf8').trim() || null; } catch { return null; } };

/**
 * Takes the lease and waits until the previous holder has stopped writing: its released-<id>, or its heartbeat going
 * quiet (`staleMs`), at most `waitMs`. Returns what happened, for the log.
 */
export async function claim(o: { waitMs?: number; staleMs?: number; pollMs?: number; now?: () => number } = {}) {
  const bucket = stateBucket();
  if (!bucket) return { claimed: false, why: 'no state bucket' };
  const now = o.now ?? Date.now;
  const waitMs = o.waitMs ?? 30_000, staleMs = o.staleMs ?? 15_000, pollMs = o.pollMs ?? 1000;
  const prev = await readJsonObj<Lease>(bucket, 'lease.json');
  const mine: Lease = { id: `l_${crypto.randomBytes(6).toString('hex')}`, rev: process.env.K_REVISION ?? null, at: now() };
  await gcsWrite(bucket, key('lease.json'), Buffer.from(JSON.stringify(mine)), 'application/json');
  fs.writeFileSync(ID_FILE, mine.id);
  await gcsWrite(bucket, key(`alive-${mine.id}`), Buffer.from(String(now())), 'text/plain');
  if (!prev) return { claimed: true, id: mine.id, previous: null, waited: 0, how: 'first' };
  const start = now();
  for (;;) {
    const rel = await readJsonObj<{ generation?: string }>(bucket, `released-${prev.id}`);
    if (rel) {
      const generation = GEN.test(String(rel.generation ?? '')) ? rel.generation! : null;
      if (generation) fs.writeFileSync(GEN_FILE, generation);
      return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'released', generation };
    }
    const beat = Number((await gcsRead(bucket, key(`alive-${prev.id}`)).catch(() => null))?.toString() ?? 0);
    if (now() - beat > staleMs) return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'quiet' };
    if (now() - start >= waitMs) return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'timed out' };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Written once this instance's Litestream has made its last sync: the next holder may restore. */
export async function release(id = myLeaseId()) {
  const bucket = stateBucket();
  if (!bucket || !id) return false;
  let generation: string | null = null;
  try { generation = fs.readFileSync(LOCAL_GEN, 'utf8').trim(); } catch { /* never streamed */ }
  await gcsWrite(bucket, key(`released-${id}`), Buffer.from(JSON.stringify({ at: Date.now(), generation: generation && GEN.test(generation) ? generation : null })), 'application/json');
  await gcsDelete(bucket, key(`alive-${id}`)).catch(() => {});
  return true;
}

/**
 * The holder's side: a heartbeat every `everyMs`, and `onLost` once another instance has claimed the lease (it then saves
 * its state and exits, so its database stops changing). Returns a stop function (tests).
 */
export function watchLease(onLost: (by: Lease) => void, o: { everyMs?: number } = {}) {
  const bucket = stateBucket();
  const id = myLeaseId();
  if (!bucket || !id) return () => {};
  let lost = false;
  const tick = async () => {
    if (lost) return;
    const lease = await readJsonObj<Lease>(bucket, 'lease.json');
    if (lease && lease.id !== id) {
      lost = true;
      onLost(lease);
      return;
    }
    await gcsWrite(bucket, key(`alive-${id}`), Buffer.from(String(Date.now())), 'text/plain').catch(() => {});
  };
  const t = setInterval(() => void tick().catch(() => {}), o.everyMs ?? 5000);
  t.unref();
  return () => clearInterval(t);
}

// entrypoint.sh: node src/cloudlease.ts claim | release
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cloudlease.ts')) {
  const what = process.argv[2];
  if (what === 'claim') console.log(`[lease] ${JSON.stringify(await claim().catch((e) => ({ claimed: false, why: String(e.message ?? e) })))}`);
  else if (what === 'release') console.log(`[lease] released ${await release().catch(() => false)}`);
}
