// One writer of Studio's database at a time (2026-10-31: studio-beta lost J's new game, its agent change and his Approve
// cards on a deploy). Cloud Run's max-instances 1 is per revision: during a deploy, and for up to ~40 minutes after,
// the old revision's instance keeps running and Litestream keeps streaming its copy as its own generation. The new
// instance restored a different, older generation, and everything the old one wrote after that was on a copy nobody read.
//
// The lease lives in the state bucket beside the database (<prefix>db/):
//   lease.json        {id, rev, at}: who holds it. Only a starting instance writes it (claim).
//   alive-<id>        the holder's heartbeat, every 5 s, with the generation it streams (for a holder that dies) and
//                     when it last answered a request (servedAt: for a holder Cloud Run stopped sending requests to).
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
import { lastServed } from './served.ts';

const ID_FILE = process.env.STUDIO_LEASE_ID_FILE || '/tmp/hawkes-lease-id';
// The generation to restore (entrypoint.sh passes it to litestream restore -generation), when the last holder named one.
const GEN_FILE = process.env.STUDIO_LEASE_GEN_FILE || '/tmp/hawkes-restore-generation';
// Litestream's own record of the generation this instance streams (beside the database).
const LOCAL_GEN = process.env.STUDIO_LITESTREAM_GEN_FILE || '/data/.studio.db-litestream/generation';
// Written by the server's first heartbeat (watchLease): the startup heartbeat (entrypoint.sh: cloudlease.ts beat) stops then.
const SERVER_FILE = process.env.STUDIO_LEASE_SERVER_FILE || '/tmp/hawkes-lease-server-beating';
const GEN = /^[0-9a-f]{16}$/;
const key = (name: string) => `${statePrefix()}db/${name}`;
/** `how` is why this holder took the database: first, released (the last holder stopped), quiet (its heartbeat stayed silent
 * through the confirm window), idle (it answered nothing), handover. Named in the loser's exit line. */
export type Lease = { id: string; rev: string | null; at: number; how?: string };

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
export async function claim(o: { waitMs?: number; staleMs?: number; pollMs?: number; idleMs?: number; confirmMs?: number; olderSilentMs?: number; now?: () => number; rev?: string | null } = {}) {
  const bucket = stateBucket();
  if (!bucket) return { claimed: false, why: 'no state bucket' };
  const now = o.now ?? Date.now;
  const waitMs = o.waitMs ?? 30_000, staleMs = o.staleMs ?? 15_000, pollMs = o.pollMs ?? 1000;
  const idleMs = o.idleMs ?? 20_000, confirmMs = o.confirmMs ?? 10_000, olderSilentMs = o.olderSilentMs ?? 120_000;
  const prev = await readJsonObj<Lease>(bucket, 'lease.json');
  const mine: Lease = { id: `l_${crypto.randomBytes(6).toString('hex')}`, rev: o.rev !== undefined ? o.rev : process.env.K_REVISION ?? null, at: now() };
  // An older revision never takes the database from a newer one: Cloud Run can start a fresh instance of the old
  // revision during a deploy, and it took the lease back once (2026-10-31). It doesn't start (entrypoint.sh).
  // Whether the holder was already gone before this claim (no heartbeat for staleMs): then nobody hands over. A holder
  // that was alive gets its full time to stop: seeing the claim (5 s), saving state (8 s), Litestream's last sync.
  const beat0 = prev ? await readBeat(bucket, prev.id) : { at: 0, generation: null, servedAt: null };
  const holderAlive = Boolean(prev) && now() - beat0.at <= staleMs && !(await readJsonObj(bucket, `released-${prev!.id}`));
  // ...but only a newer holder that is still alive: a service made again after hibernation numbers its revisions from 1
  // while the lease still names the deleted service's -00004-, and a new revision that crashed must let the old one
  // start again (2026-10-31 review: a woken customer Studio never came up).
  const released = Boolean(prev) && Boolean(await readJsonObj(bucket, `released-${prev!.id}`));
  const newerHolds = Boolean(prev) && !released && revNumber(prev!.rev) > revNumber(mine.rev);
  if (prev && holderAlive && newerHolds) return { claimed: false, id: null, previous: prev.id, how: 'newer holds it', holder: prev.rev };
  // ...and a newer holder that only looks silent is still the newer one: restoring the database and starting the server
  // can take longer than staleMs (2026-11-09: two revisions traded the database every ~20 s through a deploy, each fresh
  // instance of the OLD revision finding the new holder "dead" and taking the lease back). An older revision needs the
  // newer holder silent for olderSilentMs and still silent through the confirm window.
  if (newerHolds && (now() - beat0.at < olderSilentMs || (await beatMoves(bucket, prev!.id, beat0, { confirmMs, pollMs, now })))) return { claimed: false, id: null, previous: prev!.id, how: 'newer holds it', holder: prev!.rev };
  // A second instance of the same revision (Cloud Run starts one under load) never takes the database from a live
  // holder: each took over from the last, five in two minutes, and a beta site's build died with them (2026-10-31). It
  // stays down like an old revision's; a holder that died (no heartbeat) is replaced as before.
  // ...but a holder that is alive and answers nothing has been dropped by Cloud Run: it stopped sending it requests (its
  // event loop blocked for seconds at a time) and started a new instance for each one, while the old one ran on with its
  // heartbeat. Every new instance stayed down and the Studio was unreachable until someone restarted it (a customer's
  // Studio, 2026-11-01). So a stray of the same revision takes over from a holder that answered nothing for idleMs and
  // still answers nothing while it watches (confirmMs): a burst reaching a working, idle holder is answered in
  // milliseconds. A holder too old to report servedAt keeps the database as before.
  let orphaned = false;
  // No instance of any revision calls a holder gone on one old heartbeat: a write that was slow or failed under load
  // looks the same as a dead holder (2026-11-08: the restart loop). It watches the heartbeat for the confirm window and
  // only a holder whose time and last answer both stand still is gone ("quiet" always goes through it).
  const holderGone = Boolean(prev) && !holderAlive && !released;
  if (holderGone && (await beatMoves(bucket, prev!.id, beat0, { confirmMs, pollMs, now }))) {
    return { claimed: false, id: null, previous: prev!.id, how: prev!.rev && prev!.rev === mine.rev ? 'same revision holds it' : 'holder still beating', holder: prev!.rev };
  }
  if (prev?.rev && prev.rev === mine.rev && holderAlive) {
    const idle = beat0.servedAt !== null && now() - beat0.servedAt > idleMs;
    if (!idle || !(await staysIdle(bucket, prev.id, beat0.servedAt!, { confirmMs, pollMs, now }))) return { claimed: false, id: null, previous: prev.id, how: 'same revision holds it', holder: prev.rev };
    orphaned = true;
  }
  mine.how = !prev ? 'first' : orphaned ? 'idle' : holderGone ? 'quiet' : 'handover';
  const took = orphaned ? { took: 'the holder answered nothing' } : {};
  await gcsWrite(bucket, key('lease.json'), Buffer.from(JSON.stringify(mine)), 'application/json');
  fs.writeFileSync(ID_FILE, mine.id);
  await gcsWrite(bucket, key(`alive-${mine.id}`), beatBody(now(), true), 'application/json');
  if (!prev) return { claimed: true, id: mine.id, previous: null, waited: 0, how: 'first' };
  const start = now();
  let lastBeat = start;
  const gone = now() - beat0.at > staleMs;
  for (;;) {
    const rel = await readJsonObj<{ generation?: string }>(bucket, `released-${prev.id}`);
    if (rel) {
      const generation = GEN.test(String(rel.generation ?? '')) ? rel.generation! : null;
      if (generation) fs.writeFileSync(GEN_FILE, generation);
      return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'released', generation, ...took };
    }
    if (gone) {
      // A holder that died: its last heartbeat names the generation it streamed, so even this restore is exact.
      if (beat0.generation) fs.writeFileSync(GEN_FILE, beat0.generation);
      return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'quiet', generation: beat0.generation, ...took };
    }
    if (now() - start >= waitMs) return { claimed: true, id: mine.id, previous: prev.id, waited: now() - start, how: 'timed out', ...took };
    // The wait can outlast staleMs: keep beating, or the previous holder's own strays would call this claim dead.
    if (now() - lastBeat >= 5000) { lastBeat = now(); await gcsWrite(bucket, key(`alive-${mine.id}`), beatBody(now(), true), 'application/json').catch(() => {}); }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** This instance's Litestream generation (null before Litestream has made one). */
const localGeneration = () => { try { const g = fs.readFileSync(LOCAL_GEN, 'utf8').trim(); return GEN.test(g) ? g : null; } catch { return null; } };
/** `starting`: the claim holds the database but the server isn't beating yet (restore and start-up). */
const beatBody = (at: number, starting = false) => Buffer.from(JSON.stringify({ at, generation: localGeneration(), servedAt: lastServed(), ...(starting ? { starting: true } : {}) }));
/** A holder's heartbeat: when, the generation it streams and when it last answered a request (older heartbeats lack the
 * last, or were the time alone). */
async function readBeat(bucket: string, id: string): Promise<{ at: number; generation: string | null; servedAt: number | null }> {
  const t = (await gcsRead(bucket, key(`alive-${id}`)).catch(() => null))?.toString() ?? '';
  try { const j = JSON.parse(t); if (j && typeof j === 'object') return { at: Number(j.at) || 0, generation: GEN.test(String(j.generation ?? '')) ? j.generation : null, servedAt: Number.isFinite(j.servedAt) ? Number(j.servedAt) : null }; } catch { /* the time alone */ }
  return { at: Number(t) || 0, generation: null, servedAt: null };
}

/** Whether the holder's heartbeat or last answer moves within `confirmMs` (it is alive, only its writes were late). */
async function beatMoves(bucket: string, id: string, from: { at: number; servedAt: number | null }, o: { confirmMs: number; pollMs: number; now: () => number }) {
  const start = o.now();
  while (o.now() - start < o.confirmMs) {
    await new Promise((r) => setTimeout(r, o.pollMs));
    const b = await readBeat(bucket, id);
    if (b.at > from.at || (b.servedAt !== null && b.servedAt > (from.servedAt ?? 0))) return true;
    if (await readJsonObj(bucket, `released-${id}`)) return false;
  }
  return false;
}

/** Whether a live holder answers nothing for `confirmMs` more: true unless a heartbeat shows a newer request answered. */
async function staysIdle(bucket: string, id: string, since: number, o: { confirmMs: number; pollMs: number; now: () => number }) {
  const start = o.now();
  while (o.now() - start < o.confirmMs) {
    await new Promise((r) => setTimeout(r, o.pollMs));
    const b = await readBeat(bucket, id);
    if (b.servedAt !== null && b.servedAt > since) return false;
  }
  return true;
}

/** A Cloud Run revision's number (studio-beta-00043-9r2 → 43); 0 when unknown (J's PC, tests). */
export const revNumber = (rev: string | null | undefined) => Number(/-(\d+)-[a-z0-9]+$/.exec(String(rev ?? ''))?.[1] ?? 0);

/** Why this instance exited, kept in the bucket (best effort, short). */
export async function recordExit(path: string, why: string) {
  const bucket = stateBucket();
  if (!bucket) return;
  await Promise.race([
    gcsWrite(bucket, key(`exit-${Date.now()}-${myLeaseId() ?? 'x'}`), Buffer.from(JSON.stringify({ at: Date.now(), path, why, rev: process.env.K_REVISION ?? null })), 'application/json'),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

/** Written once this instance's Litestream has made its last sync: the next holder may restore. */
export async function release(id = myLeaseId()) {
  const bucket = stateBucket();
  if (!bucket || !id) return false;
  await gcsWrite(bucket, key(`released-${id}`), Buffer.from(JSON.stringify({ at: Date.now(), generation: localGeneration() })), 'application/json');
  await gcsDelete(bucket, key(`alive-${id}`)).catch(() => {});
  return true;
}

/**
 * The holder's heartbeat from the moment it claims until the server's own (watchLease) takes over: restoring the database
 * and starting Node take longer than the 15 s a heartbeat may be old (2026-11-09). entrypoint.sh runs this in the
 * background; it ends when the server has beaten once, when another instance took the lease, or after `maxMs`.
 */
export async function startupBeat(o: { everyMs?: number; maxMs?: number } = {}) {
  const bucket = stateBucket();
  const id = myLeaseId();
  if (!bucket || !id) return 'no lease';
  fs.rmSync(SERVER_FILE, { force: true });
  const everyMs = o.everyMs ?? 5000, end = Date.now() + (o.maxMs ?? 15 * 60_000);
  while (Date.now() < end) {
    if (fs.existsSync(SERVER_FILE)) return 'server beating';
    const lease = await readJsonObj<Lease>(bucket, 'lease.json');
    if (lease && lease.id !== id) return 'lease lost';
    if (fs.existsSync(SERVER_FILE)) return 'server beating';
    await gcsWrite(bucket, key(`alive-${id}`), beatBody(Date.now(), true), 'application/json').catch((e) => console.warn(`[lease] startup heartbeat failed: ${e?.message ?? e}`));
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return 'limit';
}

/**
 * The holder's side: a heartbeat every `everyMs`, and `onLost` once another instance has claimed the lease (it then saves
 * its state and exits, so its database stops changing). Returns a stop function (tests).
 */
export function watchLease(onLost: (by: Lease) => void, o: { everyMs?: number } = {}) {
  const bucket = stateBucket();
  const id = myLeaseId();
  if (!bucket || !id) return () => {};
  let lost = false, failures = 0, beating = false;
  const tick = async () => {
    if (lost || beating) return;
    beating = true;
    try {
      const lease = await readJsonObj<Lease>(bucket, 'lease.json');
      if (lease && lease.id !== id) {
        lost = true;
        onLost(lease);
        return;
      }
      // A failed heartbeat is logged and tried again at once: a holder whose writes fail looks dead to a stray.
      for (let i = 0; i < 3; i++) {
        try { await gcsWrite(bucket, key(`alive-${id}`), beatBody(Date.now()), 'application/json'); if (failures) console.warn(`[lease] heartbeat back after ${failures} failure(s)`); failures = 0; try { fs.writeFileSync(SERVER_FILE, String(Date.now())); } catch { /* the startup heartbeat ends by its own limit */ } return; }
        catch (e: any) { failures++; console.warn(`[lease] heartbeat write failed (${failures} in a row): ${e?.message ?? e}`); }
      }
    } finally { beating = false; }
  };
  const t = setInterval(() => void tick().catch(() => {}), o.everyMs ?? 5000);
  t.unref();
  return () => clearInterval(t);
}

// entrypoint.sh: node src/cloudlease.ts claim | release
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cloudlease.ts')) {
  const what = process.argv[2];
  if (what === 'claim') {
    const r: any = await claim().catch((e) => ({ claimed: false, why: String(e.message ?? e) }));
    console.log(`[lease] ${JSON.stringify(r)}`);
    // A newer revision, or a live instance of this one, holds the database: this one must not start (exit 3 tells
    // entrypoint.sh).
    if (r.how === 'newer holds it' || r.how === 'same revision holds it' || r.how === 'holder still beating') { console.error(`[lease] exit via claim: ${r.how}, holder ${r.previous}`); process.exit(3); }
  }
  else if (what === 'beat') console.log(`[lease] startup heartbeat ended: ${await startupBeat().catch((e) => `error ${e?.message ?? e}`)}`);
  else if (what === 'release') console.log(`[lease] released ${await release().catch(() => false)}`);
}
