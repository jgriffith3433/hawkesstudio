// The stuck-work watchdog (agents.ts checkStuck, 2026-11-10): changes that said "building the branch in the cloud" or
// "pushing and opening the pull request" for hours with nothing behind them are carried on by Studio itself, and a
// pass that hangs is given up on so it can't hold a slot, memory or the change any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stuckwatch-'));
const { checkStuck, getChange, changeLog, passInternals, PassAbandoned, WATCH_TRIES, STALL_MS } = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');
await import('../src/builds.ts');

const HOUR = 3600_000;
function seed(id: string, phase: Record<string, unknown> | null, o: { status?: string; updated?: number; pr?: number } = {}) {
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, log, created, updated, phase, pr) VALUES (?, 'nope', '[]', ?, 'building the branch in the cloud', '[]', ?, ?, ?, ?)`)
    .run(id, o.status ?? 'verifying', Date.now() - 20 * HOUR, o.updated ?? Date.now() - 12 * HOUR, phase ? JSON.stringify(phase) : null, o.pr ?? null);
}

test('a change that just moved, or whose build is going elsewhere, is left alone', () => {
  seed('c_fresh', { step: 'verify', since: 1, tip: 'abc' }, { updated: Date.now() - 60_000 });
  seed('c_build', { step: 'verify', since: 1, tip: 'abc' });
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES ('r_b', 'build', 'running', 'x', '[]', '{}', ?)`).run(Date.now());
  db.prepare(`INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, change, started) VALUES ('b_1', 'nope', 'web', 0, 'building', 'abc', 'x', 'studio', 'web', 'r_b', 'c_build', ?)`).run(Date.now() - HOUR);
  const did = checkStuck();
  assert.ok(!did.some((d) => d.id === 'c_fresh' || d.id === 'c_build'), JSON.stringify(did));
  assert.equal(getChange('c_build')!.status, 'verifying');
});

test('nothing working on a change for hours: it carries on from its step, counted', () => {
  seed('c_orphan', { step: 'verify', since: 1, tip: 'abc', showcase: true }, { pr: 533 });
  const did = checkStuck();
  const d = did.find((x) => x.id === 'c_orphan');
  assert.deepEqual(d && { was: d.was, did: d.did, step: d.step }, { was: 'orphan', did: 'resumed', step: 'verify' });
  const ph = JSON.parse((db.prepare(`SELECT phase FROM changes WHERE id = 'c_orphan'`).get() as any).phase);
  assert.equal(ph.watch.n, 1);
  assert.match(getChange('c_orphan')!.log.join('\n'), /watchdog: nothing working on it for \d+ min at the verify step/);
});

test('stuck again at the same step with its pull request open: ready as it stands', () => {
  seed('c_again', { step: 'finish', since: 1, tip: 'def5678', watch: { step: 'finish', n: WATCH_TRIES, at: Date.now() - HOUR } }, { status: 'working', pr: 31 });
  const did = checkStuck();
  assert.equal(did.find((x) => x.id === 'c_again')?.did, 'ready');
  const c = getChange('c_again')!;
  assert.equal(c.status, 'ready');
  assert.equal(c.verify.sha, 'def5678');
  assert.match(c.log.join('\n'), /watchdog: stuck at the finish step 2 times, but its pull request #31 is open/);
});

test('stuck again before a pull request: failed with why, for the PM to start again', () => {
  seed('c_nopr', { step: 'prepare', since: 1, watch: { step: 'prepare', n: WATCH_TRIES, at: Date.now() - HOUR } }, { status: 'working' });
  checkStuck();
  const c = getChange('c_nopr')!;
  assert.equal(c.status, 'failed');
  assert.match(c.detail!, /stuck: it hung at the prepare step 2 times/);
});

test('working with no step to carry on from: back in the queue', () => {
  seed('c_nostep', null, { status: 'working' });
  checkStuck();
  assert.equal(getChange('c_nostep')!.status, 'queued');
});

test('a pass in this process with no sign of life past its step limit is given up on and can write no more', async () => {
  seed('c_hung', { step: 'finish', since: 1, tip: 'aaa1111' }, { status: 'working', updated: Date.now() - STALL_MS.finish - 60_000, pr: 9 });
  const land = passInternals.claim('c_hung', { flight: true });
  const before = passInternals.inFlight();
  // The hung pass: it waits on something nobody ends, then tries to write.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const pass = passInternals.asPass('c_hung', async () => { await gate; changeLog('c_hung', 'the old pass woke up'); });
  const did = checkStuck();
  assert.equal(did.find((x) => x.id === 'c_hung')?.was, 'stalled');
  assert.equal(passInternals.inFlight(), before - 1, 'its memory count is freed');
  release();
  await assert.rejects(pass, PassAbandoned);
  assert.ok(!getChange('c_hung')!.log.join('\n').includes('the old pass woke up'));
  // Its own release later does nothing to the pass that took over.
  land();
  assert.equal(passInternals.inFlight(), before - 1);
});

test('the heavy slot is passed on when its holder keeps it too long', async () => {
  process.env.STUDIO_HEAVY_SLOTS = '1';
  process.env.STUDIO_HEAVY_MAX_MS = '50';
  const { heavySlot, heavyState } = await import('../src/heavyslot.ts');
  await heavySlot(); // a holder that never releases
  const t0 = Date.now();
  const keep = setTimeout(() => {}, 2000); // the slot's own timer doesn't hold the process open
  const next = await heavySlot();
  clearTimeout(keep);
  assert.ok(Date.now() - t0 >= 40);
  next();
  assert.equal(heavyState().used, 0);
  delete process.env.STUDIO_HEAVY_SLOTS;
  delete process.env.STUDIO_HEAVY_MAX_MS;
});

test('an agent pass whose Cloud Run job is in line for CPU room is waiting, not hung (2026-11-11)', async () => {
  const C = await import('../src/cpuroom.ts');
  const saved = { ...process.env };
  delete process.env.STUDIO_CPU_ROOM;
  process.env.STUDIO_CPU_WAIT_MS = '60000';
  C.roomHooks.limit = async () => 100;
  C.roomHooks.used = async () => 100;
  try {
    const unit = 'hawkes-agent-c_cpu-x1';
    seed('c_cpu', { step: 'agent', since: 1, proc: { rec: { unit, mode: 'cloudrun', started: 1 }, offset: 0 } }, { status: 'working', updated: Date.now() - STALL_MS.agent - 60_000 });
    const land = passInternals.claim('c_cpu', { flight: true });
    const turn = C.cpuTurn(2, unit);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(C.cpuWaiting(unit), true);
    assert.ok(!checkStuck().some((d) => d.id === 'c_cpu'), 'in line for room: left alone');
    C.roomHooks.used = async () => 0; C.cpuFreed();
    await turn;
    assert.equal(C.cpuWaiting(unit), false);
    assert.equal(checkStuck().find((d) => d.id === 'c_cpu')?.was, 'stalled', 'out of the line and still silent: hung after all');
    land();
  } finally { C.resetCpuRoom(); process.env = saved; }
});
