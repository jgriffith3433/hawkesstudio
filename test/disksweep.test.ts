// Caps and sweeps for Cloud Run's in-memory disk (disksweep.ts): profiles by count and size, stale tmp, ended
// worktrees, and a write refused past a safe share of memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-disksweep-data-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-disksweep-proj-'));
process.env.STUDIO_DISK_SWEEP = 'on';

const {
  capByCountAndSize, sweepProfiles, sweepTmp, sweepWorktrees, liveWorkNames, sweepDisk, ensureDiskRoom,
  setDiskSource, diskHigh, diskFull, diskBudget, PROFILE_KEEP, removeChangeDirs, TMP_MAX_AGE_MS,
} = await import('../src/disksweep.ts');
const { setMemSource } = await import('../src/memgate.ts');

test('capByCountAndSize keeps the newest under both caps', () => {
  const files = [
    { name: 'a', size: 10, mtime: 3 },
    { name: 'b', size: 10, mtime: 2 },
    { name: 'c', size: 10, mtime: 1 },
    { name: 'd', size: 50, mtime: 4 },
  ];
  assert.deepEqual(capByCountAndSize(files, 2, 25), ['a', 'b'], 'newest first, size stops before d+a');
  assert.deepEqual(capByCountAndSize(files, 10, 15), ['a'], 'one file fills the byte budget after the newest that fits');
  assert.deepEqual(capByCountAndSize(files, 1, 1000), ['d'], 'count alone');
});

test('sweepProfiles drops oldest past keep and past max bytes', () => {
  const dir = path.join(process.env.STUDIO_DATA!, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, kb: number, ageSec: number) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(kb * 1024, 1));
    const t = (Date.now() - ageSec * 1000) / 1000;
    fs.utimesSync(p, t, t);
  };
  write('old.cpuprofile', 20, 300);
  write('mid.cpuprofile', 20, 200);
  write('new.cpuprofile', 20, 10);
  const r = sweepProfiles(dir, 2, 50 * 1024);
  assert.equal(r.removed, 1);
  assert.ok(fs.existsSync(path.join(dir, 'new.cpuprofile')));
  assert.ok(fs.existsSync(path.join(dir, 'mid.cpuprofile')));
  assert.ok(!fs.existsSync(path.join(dir, 'old.cpuprofile')));
  // Byte cap alone: three small newest would be 60 KB > 40 KB → keep only two that fit.
  write('extra.cpuprofile', 20, 5);
  const r2 = sweepProfiles(dir, 10, 40 * 1024);
  assert.ok(r2.removed >= 1);
  assert.ok(PROFILE_KEEP() >= 1);
});

test('sweepTmp removes Studio scratch older than the age, leaves fresh ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmp-'));
  const old = path.join(root, 'hs-build-old');
  const fresh = path.join(root, 'hs-build-fresh');
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'x'), 'y');
  fs.mkdirSync(fresh); fs.writeFileSync(path.join(fresh, 'x'), 'y');
  const longAgo = (Date.now() - TMP_MAX_AGE_MS() - 60_000) / 1000;
  fs.utimesSync(old, longAgo, longAgo);
  const r = sweepTmp(root, Date.now(), TMP_MAX_AGE_MS());
  assert.equal(r.removed, 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  fs.rmSync(root, { recursive: true, force: true });
});

test('sweepWorktrees keeps live change folders and clears ended ones', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-work-'));
  for (const n of ['c_live', 'c_dead', 'scout-x1', 'c_live-site', 'other']) fs.mkdirSync(path.join(work, n));
  const keep = liveWorkNames([
    { id: 'c_live', worktree: path.join(work, 'c_live'), status: 'working' },
    { id: 'c_dead', worktree: path.join(work, 'c_dead'), status: 'failed' },
    { id: 'c_ready', worktree: path.join(work, 'c_ready'), status: 'ready' },
  ]);
  assert.ok(keep.has('c_live') && keep.has('c_live-site') && keep.has('c_ready'));
  assert.ok(!keep.has('c_dead'));
  const soft = sweepWorktrees(work, keep, false);
  assert.ok(soft.removed >= 2, 'ended change and scout scratch go');
  assert.ok(fs.existsSync(path.join(work, 'c_live')));
  assert.ok(fs.existsSync(path.join(work, 'c_live-site')));
  assert.ok(!fs.existsSync(path.join(work, 'c_dead')));
  assert.ok(!fs.existsSync(path.join(work, 'scout-x1')));
  assert.ok(fs.existsSync(path.join(work, 'other')), 'soft leaves unrelated names');
  const hard = sweepWorktrees(work, keep, true);
  assert.ok(hard.removed >= 1);
  assert.ok(!fs.existsSync(path.join(work, 'other')));
  fs.rmSync(work, { recursive: true, force: true });
});

test('ensureDiskRoom sweeps then refuses when still over the budget', async () => {
  setMemSource(() => ({ limit: 1000 * 1024 * 1024, available: 100 * 1024 * 1024 }));
  // 600 MB used on a 45% budget of 1000 MB (= 450 MB): high.
  setDiskSource(() => ({ used: 600 * 1024 * 1024, free: 400 * 1024 * 1024, size: 1000 * 1024 * 1024, pct: 60, path: '/' }));
  assert.equal(diskHigh(), true);
  assert.ok(diskBudget() < 600 * 1024 * 1024);
  const work = path.join(process.env.STUDIO_PROJECTS!, '.work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(work, 'c_gone'));
  fs.writeFileSync(path.join(work, 'c_gone', 'blob'), Buffer.alloc(1024));
  const said: string[] = [];
  // Soft/hard sweep clears the ended folder, but the mocked disk stays high → refuse.
  await assert.rejects(
    () => ensureDiskRoom(10 * 1024 * 1024, { keep: new Set(['c_keep']), say: (s) => said.push(s) }),
    /in-memory disk is full/,
  );
  assert.ok(said.some((s) => /disk high/.test(s)));
  assert.ok(!fs.existsSync(path.join(work, 'c_gone')));
  setDiskSource(null);
  setMemSource(null);
});

test('over the share budget with memory to spare: sweeps, then lets the write through (no hold on a disk at rest)', async () => {
  // 2026-11-10: 2.05 GB at rest on a 1.72 GB budget with ~1 GB of memory free held every change for hours.
  setMemSource(() => ({ limit: 4000 * 1024 * 1024, available: 1000 * 1024 * 1024 }));
  setDiskSource(() => ({ used: 2050 * 1024 * 1024, free: 1950 * 1024 * 1024, size: 4000 * 1024 * 1024, pct: 51, path: '/' }));
  assert.equal(diskHigh(100 * 1024 * 1024), true, 'over the budget: it sweeps');
  assert.equal(diskFull(100 * 1024 * 1024), false, 'but memory holds the write');
  const said: string[] = [];
  const r = await ensureDiskRoom(100 * 1024 * 1024, { keep: new Set(), say: (s) => said.push(s) });
  assert.match(String(r), /GB of memory free/);
  assert.ok(!said.some((s) => /hard/.test(s)), 'no hard sweep while memory has room');
  // Memory short: refused, with the reason.
  setMemSource(() => ({ limit: 4000 * 1024 * 1024, available: 450 * 1024 * 1024 }));
  assert.equal(diskFull(100 * 1024 * 1024), true);
  await assert.rejects(() => ensureDiskRoom(100 * 1024 * 1024, { keep: new Set() }), /in-memory disk is full/);
  setDiskSource(null);
  setMemSource(null);
});

test('sweepDisk soft clears profiles and reports', async () => {
  setDiskSource(() => ({ used: 10 * 1024 * 1024, free: 90 * 1024 * 1024, size: 100 * 1024 * 1024, pct: 10, path: '/' }));
  const dir = path.join(process.env.STUDIO_DATA!, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i++) {
    const p = path.join(dir, `block-${i}.cpuprofile`);
    fs.writeFileSync(p, Buffer.alloc(1024, i));
    fs.utimesSync(p, (Date.now() - i * 1000) / 1000, (Date.now() - i * 1000) / 1000);
  }
  const r = await sweepDisk({ soft: true, keep: new Set() });
  assert.ok(r.profiles >= 1);
  setDiskSource(null);
});

test('removeChangeDirs only deletes under .work and takes siblings', () => {
  const work = path.join(process.env.STUDIO_PROJECTS!, '.work');
  fs.mkdirSync(path.join(work, 'c_x'), { recursive: true });
  fs.mkdirSync(path.join(work, 'c_x-site'), { recursive: true });
  fs.mkdirSync(path.join(work, 'c_x.repos'), { recursive: true });
  fs.writeFileSync(path.join(work, 'c_x-site.json'), '{}');
  const n = removeChangeDirs(path.join(work, 'c_x'));
  assert.ok(n >= 0);
  assert.ok(!fs.existsSync(path.join(work, 'c_x')));
  assert.ok(!fs.existsSync(path.join(work, 'c_x-site')));
  assert.ok(!fs.existsSync(path.join(work, 'c_x.repos')));
  assert.equal(removeChangeDirs('/tmp/not-under-work'), 0);
});
