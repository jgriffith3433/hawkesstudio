// The reclaim ladder (diskreclaim.ts): frees what Studio can reclaim in order, never a live change's worktree or a clone
// in use, keeps the database's reserve, logs what it freed, and a change's disk wait ends (J, 2026-11-13).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-reclaim-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DISK_SWEEP = 'on';
process.env.npm_config_cache = path.join(tmp, 'npm');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });

const D = await import('../src/disksweep.ts');
const R = await import('../src/diskreclaim.ts');
const { setMemSource } = await import('../src/memgate.ts');
const { diskWaits } = await import('../src/diskwait.ts');
const MB = 1024 * 1024;
const GB = 1024 * MB;
const PROJECTS = process.env.STUDIO_PROJECTS!;
const WORK = path.join(PROJECTS, '.work');

after(() => { D.setDiskSource(null); D.setRealDiskSource(null); D.resetDiskBaseline(); setMemSource(null); });

const put = (p: string, mb: number) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(mb * 1024)); };
/** A fake 2.5 GB volume whose "used" is what the test says plus the real files under PROJECTS counted as ×1000. */
const volume = (usedMb: () => number) => D.setDiskSource(() => {
  const size = 2.5 * GB, used = Math.min(size, usedMb() * MB);
  return { used, free: size - used, size, pct: Math.round((used / size) * 1000) / 10, path: PROJECTS };
});
const filesMb = () => {
  const sz = (p: string): number => { try { const st = fs.lstatSync(p); return st.isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + sz(path.join(p, f)), 0) : st.size; } catch { return 0; } };
  return sz(PROJECTS) / 1024; // each test file KB stands for a MB
};

test('the ladder frees ended worktrees, then unused clones, and never a live worktree or a clone in use', async () => {
  R.resetReclaimLog();
  D.resetDiskBaseline();
  setMemSource(() => ({ limit: 4 * GB, available: 3 * GB }));
  put(path.join(WORK, 'c_ended1', 'a.bin'), 300);
  put(path.join(WORK, 'c_live1', 'a.bin'), 300);
  put(path.join(PROJECTS, 'unused', '.git', 'pack'), 500);
  put(path.join(PROJECTS, 'inuse', '.git', 'pack'), 400);
  volume(() => 2400 - 0 + (filesMb() - 1500) * 0 + (filesMb() - 1500)); // 2400 MB while all 1500 MB sit there, less as they go
  const res = await R.reclaim({ workDir: WORK, projects: PROJECTS, tmpDirs: [], protect: { work: new Set(['c_live1']), clones: new Set(['inuse']) }, why: 'test' });
  assert.ok(!fs.existsSync(path.join(WORK, 'c_ended1')), 'the ended change goes');
  assert.ok(fs.existsSync(path.join(WORK, 'c_live1', 'a.bin')), "a live change's worktree stays");
  assert.ok(fs.existsSync(path.join(PROJECTS, 'inuse', '.git', 'pack')), 'a clone in use stays');
  assert.ok(!fs.existsSync(path.join(PROJECTS, 'unused')), 'an unused clone goes');
  assert.ok(res.freed >= 700 * MB);
  assert.ok(res.room, 'a worktree fits afterwards');
});

test('it logs each rung with its path and MB for studio_ops', () => {
  const log = R.reclaimLog();
  const rungs = log.map((s) => s.rung);
  assert.ok(rungs.includes('ended worktree') && rungs.includes('unused clone'));
  const clone = log.find((s) => s.rung === 'unused clone')!;
  assert.match(clone.path, /unused$/);
  assert.ok(clone.mb >= 0.4, 'its size is logged (the test files are KB standing for MB)');
});

test('the database folder is never touched', async () => {
  const db = path.join(process.env.STUDIO_DATA!, 'studio.db');
  put(db, 5);
  put(path.join(WORK, 'c_ended2', 'x'), 50);
  volume(() => 2450);
  await R.reclaim({ workDir: WORK, projects: PROJECTS, tmpDirs: [], protect: { work: new Set(), clones: new Set() }, all: true });
  assert.ok(fs.existsSync(db));
});

test('the database keeps a reserve an agent prepare cannot use', () => {
  setMemSource(() => ({ limit: 4 * GB, available: 3 * GB }));
  D.setDiskSource(() => ({ used: 2.5 * GB - 250 * MB, free: 250 * MB, size: 2.5 * GB, pct: 90, path: PROJECTS }));
  assert.equal(R.dbReserve(), 200 * MB);
  assert.equal(D.diskExhausted(40 * MB), false, '250 MB free: a 40 MB write leaves the reserve');
  assert.equal(D.diskExhausted(100 * MB), true, 'a 100 MB write would eat into the reserve');
  assert.equal(D.diskFull(0), true, 'under the floor and reserve nothing starts');
});

test('the baseline counts only what Studio cannot reclaim, and never starves the budget', () => {
  setMemSource(() => ({ limit: 4 * GB, available: 3 * GB }));
  const d = { used: 2.5 * GB, free: 0, size: 2.5 * GB, pct: 100, path: PROJECTS };
  D.setDiskSource(() => d);
  D.setRealDiskSource(() => false);
  D.noteDiskBaseline(d, Date.now(), 1.8 * GB);
  assert.equal(Math.round(D.diskBaseline(d) / MB), 700 * 1.0 | 0 ? Math.round((2.5 * GB - 1.8 * GB) / MB) : 0);
  D.noteDiskBaseline(d, Date.now(), 0);
  assert.ok(D.diskBudget() <= 2.5 * GB * 0.95, 'a baseline equal to the whole disk still leaves a budget under it');
  assert.ok(D.diskBudget() < d.used, 'so a full disk is over budget and sweeps');
  D.resetDiskBaseline();
});

test('the ladder starts at 80% of the volume', () => {
  assert.equal(R.ladderDue({ used: 1.9 * GB, free: 0.6 * GB, size: 2.5 * GB, pct: 76, path: '' }), false);
  assert.equal(R.ladderDue({ used: 2.05 * GB, free: 0.45 * GB, size: 2.5 * GB, pct: 82, path: '' }), true);
});

test('a freed ladder wakes the waiting changes at once, by event', async () => {
  let woke = 0;
  const w = diskWaits(() => woke++);
  w.hold('c_1'); w.hold('c_2');
  const off = D.onDiskFreed((why) => w.freed(why));
  put(path.join(WORK, 'c_ended3', 'x'), 200);
  setMemSource(() => ({ limit: 4 * GB, available: 3 * GB }));
  let used = 2450;
  volume(() => used);
  await R.reclaim({ workDir: WORK, projects: PROJECTS, tmpDirs: [], protect: { work: new Set(), clones: new Set() }, why: 'wake' }).then(() => {});
  used = 1000; // statfs now shows room: the next freeing event wakes them
  D.diskFreed('test');
  off();
  assert.equal(woke, 1);
  assert.equal(w.holds('c_1'), false);
});
