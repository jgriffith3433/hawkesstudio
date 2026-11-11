// The queue never stays stuck (J, 2026-11-11: "Make it so agents never get stuck. Ever"). On 2026-11-10 to 11, 59 of 72
// changes sat for hours as "waits for disk room (1.87 GB used of 4.00 GB; budget 1.72 GB; 0.07 GB of memory free)": the
// disk at rest was already over the budget, so with nothing running every change was refused, and only a pass ending
// (none was running) or a sweep that found room (there was nothing to sweep) could ever let one go. A Studio fix queued
// "behind" one of those waited with it, and a change that kept failing was parked until Studio restarted.
//
// Every wait now has an exit that comes by itself: the events that free what it waits for, and for the disk (whose room
// can free without any event Studio sees) one deadline of its own. With nothing running, the gates always let one start;
// the disk budget sits above what Studio holds at rest; Studio's own work has its own lane. None of this polls: the
// queue below drains with no timer at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-never-stuck-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-never-stuck-projects-'));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 2, perProduct: 1 }));
const A = await import('../src/agents.ts');
const D = await import('../src/disksweep.ts');
const M = await import('../src/memgate.ts');
const { diskWaits } = await import('../src/diskwait.ts');
const { providerDeps } = await import('../src/providers.ts');
const { db } = await import('../src/db.ts');

const MB = 1024 * 1024;
const GB = 1024 * MB;
// Every provider can take work (the test machine has none signed in).
Object.assign(providerDeps, { configured: () => true, installed: () => true, held: () => null });

let t0 = 1_000_000;
function add(id: string, product: string, status = 'queued') {
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, base, worktree, title, request, notes, log, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, product, '[]', status, 'queued (J asked)', `${product}repo`, 'beta', path.join(process.env.STUDIO_PROJECTS!, '.work', id), `Title ${id}`, `Request ${id}`, '[]', '[]', (t0 += 1000), null);
}
const close = (ids: string[]) => { for (const id of ids) db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(id); };
/** Lets every promise and immediate already queued run (no timers). */
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A stand-in for a change's pass: it is started (recorded), and ends when the test says (or at once). */
function passes({ endAtOnce = false } = {}) {
  const started: string[] = [];
  const enders = new Map<string, () => void>();
  A.passInternals.setRunPass(async (id: string) => {
    started.push(id);
    db.prepare(`UPDATE changes SET status = 'working' WHERE id = ?`).run(id);
    if (endAtOnce) await new Promise((r) => setImmediate(r));
    else await new Promise<void>((r) => enders.set(id, r));
    // The pass ends as passes do: its status moves on (merged, or ready), through the change's own update.
    A.patchChange(id, { status: 'merged', detail: 'merged (test)' });
  });
  return { started, end: (id: string) => enders.get(id)?.() };
}

function inMemoryDisk(used: number, memFree: number) {
  // The incident's machine: the in-memory filesystem (4 GiB, unbounded by a volume) under a 3.82 GiB memory limit.
  D.setRealDiskSource(() => false);
  D.setDiskSource(() => ({ used, free: 4 * GB - used, size: 4 * GB, pct: Math.round((used / (4 * GB)) * 1000) / 10, path: '/projects' }));
  M.setMemSource(() => ({ limit: 3.82 * GB, available: memFree }));
}
function restoreDisk() {
  D.setDiskSource(null); D.setRealDiskSource(null); M.setMemSource(null); D.resetDiskBaseline();
  process.env.STUDIO_DISK_SWEEP = 'off';
}

test('the incident: Studio at rest over the old budget with nothing running, and a change still gets its worktree', async () => {
  process.env.STUDIO_DISK_SWEEP = 'on';
  add('c_disk00000001', 'nsa');
  try {
    // 1.87 GB at rest, 0.2 GB of memory free (below the 384 MB floor, above the 100 MB a worktree takes).
    inMemoryDisk(1.87 * GB, 0.2 * GB);
    assert.ok(D.diskBudget() < 1.87 * GB, 'with nothing measured, the old budget is below the disk at rest');
    assert.equal(D.diskHigh(100 * MB) && D.diskFull(100 * MB), true, 'and the old gate refuses');
    // Alone (no other change at work, no other checkout): only a write that can't fit refuses it.
    assert.equal(await A.diskRoomForCheckouts('c_disk00000001', 1, 0), null, 'nothing running: it goes ahead');
    // Beside other work, the gate still holds it (that work ends, and its end wakes the wait).
    assert.match(String(await A.diskRoomForCheckouts('c_disk00000001', 1, 1)), /disk is full/);
    // Measured at rest, the budget sits above the baseline: idle Studio never uses up the room for its work.
    D.noteDiskBaseline();
    assert.ok(D.diskBudget() > 1.87 * GB, `budget ${D.diskBudget() / GB} GB is above the 1.87 GB at rest`);
    assert.equal(D.diskHigh(100 * MB), false, 'at rest: not even a sweep');
    assert.match(D.diskSummary(), /at rest 1\.87 GB/);
    // A baseline measured on another volume doesn't apply to this one.
    D.setDiskSource(() => ({ used: 1.87 * GB, free: 8 * GB, size: 10 * GB, pct: 19, path: '/disk' }));
    assert.equal(D.diskBaseline(), 0);
    // Real exhaustion still refuses even the only work: the write can't fit at all.
    D.resetDiskBaseline();
    inMemoryDisk(1.87 * GB, 0.05 * GB);
    assert.match(String(await A.diskRoomForCheckouts('c_disk00000001', 1, 0)), /disk is full/, 'less memory free than the write itself');
  } finally {
    restoreDisk();
    close(['c_disk00000001']);
  }
});

test('a disk wait ends by an event, or by its own one deadline when room frees where Studio sees no event', async () => {
  const wakes: string[] = [];
  const w = diskWaits((why) => wakes.push(why), { deadlineMs: () => 40 });
  w.hold('c_a'); w.hold('c_b');
  const at = w.deadline()!;
  assert.ok(at > Date.now(), 'the wait carries its deadline');
  w.hold('c_c');
  assert.equal(w.deadline(), at, 'one deadline for the wait, not one per change');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(wakes.length, 1, 'the deadline woke the queue once');
  assert.match(wakes[0], /deadline/);
  assert.equal(w.holds('c_a') || w.holds('c_b') || w.holds('c_c'), false, 'every waiting change looks again');
  assert.equal(w.deadline(), null);
  // An event first: the deadline is cleared with the wait (nothing fires later).
  w.hold('c_a');
  assert.equal(w.freed('a pass ended'), true);
  assert.equal(w.deadline(), null);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(wakes.length, 2, 'only the event woke it');
});

test('with free slots and nothing running, the queue starts work even when memory reads low', async () => {
  const gate = process.env.STUDIO_MEM_GATE;
  process.env.STUDIO_MEM_GATE = 'on';
  M.setMemSource(() => ({ limit: 4 * GB, available: 0.07 * GB }));
  const p = passes();
  add('c_low00000001', 'nsb');
  add('c_low00000002', 'nsc');
  try {
    assert.equal(M.memLow(), true);
    await A.pumpNow();
    assert.deepEqual(p.started, ['c_low00000001'], 'one starts: refusing it would wait on work that is not running');
    assert.match(String(A.getChange('c_low00000002')!.detail), /waits for memory/, 'the other waits beside running work');
    // The running one ends: memory and its slot free, and the queue looks again by itself (no timer).
    p.end('c_low00000001');
    await settle();
    assert.deepEqual(p.started, ['c_low00000001', 'c_low00000002']);
    p.end('c_low00000002');
    await settle();
  } finally {
    M.setMemSource(null);
    process.env.STUDIO_MEM_GATE = gate;
    A.passInternals.setRunPass(null);
    close(['c_low00000001', 'c_low00000002']);
  }
});

test("Studio's own fix has its own lane: it starts while product work fills every slot", async () => {
  const p = passes();
  add('c_prod00000001', 'nsd');
  add('c_prod00000002', 'nse');
  add('c_prod00000003', 'nsf');
  try {
    await A.pumpNow();
    await settle();
    assert.deepEqual(p.started, ['c_prod00000001', 'c_prod00000002'], 'both of the 2 product slots taken');
    assert.equal(A.queueHealth().free, 0);
    add('c_self00000001', 'hawkes-studio');
    await A.pumpNow();
    await settle();
    assert.deepEqual(p.started.slice(2), ['c_self00000001'], "Studio's own fix doesn't queue behind product work");
    assert.equal(A.studioOwn('hawkesstudio'), true, 'Studio as an infra target is its own work too');
    assert.equal(A.studioOwn('nsd'), false);
    for (const id of ['c_prod00000001', 'c_prod00000002', 'c_self00000001']) p.end(id);
    await settle();
    assert.ok(p.started.includes('c_prod00000003'), 'the product queue carries on as slots free');
    p.end('c_prod00000003');
    await settle();
  } finally {
    A.passInternals.setRunPass(null);
    close(['c_prod00000001', 'c_prod00000002', 'c_prod00000003', 'c_self00000001']);
  }
});

test('"behind X" never names a change that holds nothing, and X ending lets its dependents go at once', async () => {
  const p = passes();
  add('c_head00000002', 'phorigins');
  try {
    // X waits for disk room: the pump passes it by, so a new change of its product is not "behind" it.
    A.passInternals.waitForDisk('c_head00000002', 'in-memory disk is full (test)');
    const id = A.startTask('phorigins', 'a fix that must not wait behind a held change');
    assert.doesNotMatch(String(A.getChange(id)!.detail), /behind/);
    await settle();
    assert.ok(p.started.includes(id), 'it starts while X waits');
    p.end(id);
    await settle();
    // X running, a new one behind it: X's pass ending lets it go at once.
    A.passInternals.diskWait().freed('test');
    await A.pumpNow();
    await settle();
    assert.ok(p.started.includes('c_head00000002'));
    add('c_dep00000001', 'phorigins');
    await A.pumpNow();
    assert.ok(!p.started.includes('c_dep00000001'), 'one at a time for the product');
    p.end('c_head00000002');
    await settle();
    assert.ok(p.started.includes('c_dep00000001'), "X's pass ended: its dependent started without anything polling");
    p.end('c_dep00000001');
    await settle();
    // X stuck in a running status with no pass behind it (an orphan): its cancel, from outside any pass, lets the next go.
    add('c_orph00000001', 'phorigins', 'working');
    add('c_dep00000002', 'phorigins');
    await A.pumpNow();
    assert.ok(!p.started.includes('c_dep00000002'));
    A.patchChange('c_orph00000001', { status: 'cancelled', detail: 'cancelled (test)' });
    await settle();
    assert.ok(p.started.includes('c_dep00000002'), 'the cancel woke the queue');
    p.end('c_dep00000002');
    await settle();
    close([id]);
  } finally {
    A.passInternals.setRunPass(null);
    close(['c_head00000002', 'c_dep00000001', 'c_orph00000001', 'c_dep00000002']);
  }
});

test('a pass started outside the pump (an answer, a resume) wakes the queue when it lands', async () => {
  const p = passes();
  // Both product slots taken by passes the pump didn't start.
  const land1 = A.passInternals.claim('c_other0000001');
  const land2 = A.passInternals.claim('c_other0000002');
  add('c_wait00000001', 'nsh');
  try {
    await A.pumpNow();
    await settle();
    assert.ok(!p.started.includes('c_wait00000001'), 'no slot free');
    land1();
    await settle();
    assert.ok(p.started.includes('c_wait00000001'), 'its landing freed a slot and the queue took it');
    land2();
    p.end('c_wait00000001');
    await settle();
  } finally {
    A.passInternals.setRunPass(null);
    close(['c_wait00000001']);
  }
});

test('no change stays queued while a slot is free: a queue of 9 across 3 products drains on events alone', async () => {
  const p = passes({ endAtOnce: true });
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) { const id = `c_drain000000${i}`; ids.push(id); add(id, ['nsx', 'nsy', 'nsz'][i % 3]); }
  try {
    await A.pumpNow();
    for (let i = 0; i < 200 && A.listChanges({ status: 'queued', limit: 500 }).some((c) => ids.includes(c.id)); i++) {
      // The invariant at every turn: if a change is queued, no slot is free (or one just started and is settling).
      await settle(1);
    }
    assert.deepEqual([...p.started].sort(), [...ids].sort(), 'every change started');
    assert.equal(A.listChanges({ status: 'queued', limit: 500 }).filter((c) => ids.includes(c.id)).length, 0);
    assert.equal(A.pumpWakeAt(), null, 'the queue drained with no pump timer armed');
    assert.equal(A.passInternals.diskWait().deadline(), null, 'and no disk wait');
  } finally {
    A.passInternals.setRunPass(null);
    close(ids);
  }
});

test('nothing re-runs the queue on an interval; the stall check only reports', () => {
  const src = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setInterval\(\(\) => void pump\(\)/, 'no interval pump');
  const check = src.slice(src.indexOf('export function checkQueue('), src.indexOf('/** The provider new work would go to now'));
  assert.doesNotMatch(check, /pump\(\)|diskWait\.clear\(\)|clearStaleDeployFlag/, 'the stall check rescues nothing');
  // Every exit is wired where the wait ends.
  assert.match(src, /queueIdle\(\);\n    void pump\(\);\n  \};/, 'a landing pass wakes the queue');
  assert.match(src, /memFreed\(\); void pump\(\);/, 'memory let go wakes the queue');
  assert.match(src, /removeChangeDirs\(c\.worktree\) > 0\) diskWait\.freed/, 'a removed worktree wakes disk waits');
  assert.match(src, /wakesQueue\(cur\.status, String\(patch\.status\)\)\) void pump\(\)/, 'a status that frees a slot wakes the queue');
  assert.equal(A.wakesQueue('working', 'failed'), true);
  assert.equal(A.wakesQueue('queued', 'cancelled'), true);
  assert.equal(A.wakesQueue('working', 'verifying'), true);
  assert.equal(A.wakesQueue('queued', 'working'), false, "the pump's own start");
  assert.equal(A.wakesQueue('ready', 'merged'), false);
});

// 2026-11-11 05:06 (J's cell): "the Cloud Run job never started in 15 min (Cloud Run had no room for it): starting it
// again", over and over for about 7 passes and a Talk job with agents paused, each start one more execution in the same
// full region (12 open, none running). A job that finds no room now sends its change back through the queue.
test('an agent job Cloud Run had no room for goes back through the queue with its cause, never straight into the same full place', async () => {
  const line = '[studio] the Cloud Run job never started in 15 min (Cloud Run had no room for it): starting it again';
  assert.ok(fs.readFileSync(new URL('../src/cloudjob.ts', import.meta.url), 'utf8').includes('never started in ${Math.round((Date.now() - since) / 60_000)} min (Cloud Run had no room for it)'), "cloudjob.ts still says it this way");
  assert.equal(A.noRoomOf(`some output\n${line}\n`), line.replace('[studio] ', ''));
  assert.equal(A.noRoomOf('[studio] the Cloud Run job sent nothing for 61 min: stopped and started again'), null, 'a silent job is another matter');
  // The pass returns instead of starting another job on the spot.
  const src = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const raw = src.slice(src.indexOf('async function agentPassRaw('), src.indexOf('async function agentPassRaw(') + 5000);
  assert.ok(raw.indexOf('noRoomOf(first.stderr)') < raw.indexOf('starting the pass again`);\n    save({ proc: undefined });\n    const second = await runAgent('), 'checked before the second job');
  assert.ok(raw.includes('noRoomOf(second.stderr)'), 'and a second job lost for want of room waits for room too, never counted as a try');
  assert.equal((src.match(/if \(r\.noRoom\) return waitForJobRoom\(id, ph, r\.noRoom\);/g) ?? []).length, 2, 'both kinds of pass (products, Studio/Gen) send it back');

  add('c_room00000001', 'nsr', 'working');
  try {
    const ph = { step: 'agent' as const, proc: { rec: { unit: 'u' } } as any };
    await A.passInternals.waitForJobRoom('c_room00000001', ph, line);
    let c = A.getChange('c_room00000001')!;
    assert.equal(c.status, 'queued', 'back in the queue, holding no slot');
    assert.match(String(c.detail), /^queued: Cloud Run had no room for its agent job in .*it starts again through the queue after \d\d:\d\d UTC \(1 of 3\)/);
    const p1 = A.phaseOf('c_room00000001')!;
    assert.equal(p1.proc, undefined, 'no execution kept');
    assert.equal(p1.noRoom?.n, 1);
    assert.ok(p1.notBefore! > Date.now() + 14 * 60_000, 'not before its wait: the queue (maxConcurrent, the CPU gate) starts it then');
    assert.equal(A.jobRoomWaitMs(2), 30 * 60_000);
    assert.equal(A.jobRoomWaitMs(9), 2 * 3600_000);
    // The third time in a row: the attempt ends with that cause, as Studio's failure (planned again, not a try).
    await A.passInternals.waitForJobRoom('c_room00000001', { ...p1, noRoom: { n: A.JOB_ROOM_TRIES, at: Date.now() } }, line);
    c = A.getChange('c_room00000001')!;
    assert.equal(c.status, 'failed');
    assert.match(String(c.detail), /no room for its agent job .* 3 times in a row .*planned again with that cause/);
    assert.equal(A.phaseOf('c_room00000001')?.failed, true);
  } finally {
    close(['c_room00000001']);
  }
});

test('agents paused (maxConcurrent 0) pause every lane, Studio\'s own included', async () => {
  const file = path.join(process.env.STUDIO_DATA!, 'agents.json');
  const was = fs.readFileSync(file, 'utf8');
  const p = passes();
  fs.writeFileSync(file, JSON.stringify({ maxConcurrent: 0, perProduct: 1 }));
  add('c_paus00000001', 'hawkes-studio');
  add('c_paus00000002', 'nsp');
  try {
    await A.pumpNow();
    await settle();
    assert.deepEqual(p.started.filter((x) => x.startsWith('c_paus')), []);
  } finally {
    fs.writeFileSync(file, was);
    A.passInternals.setRunPass(null);
    close(['c_paus00000001', 'c_paus00000002']);
  }
});

test('the baseline says what it is made of', async () => {
  const lines: string[] = [];
  const line = await D.logBaselineMakeup((s) => lines.push(s));
  assert.ok(line === null || /baseline is made of: .* MB/.test(line));
  assert.equal(lines.length, line ? 1 : 0);
});
