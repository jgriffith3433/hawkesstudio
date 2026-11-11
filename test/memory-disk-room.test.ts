// PH Origins' site builds failed "in-memory disk is full" for hours on 2026-11-11: the cell's working disk was a 2.5 GB
// memory volume (no real disk: Google's ephemeral-disk quota), and it held the 446 MB PH Origins clone at 906 MB (its
// .git and a full checkout of its videos), each of its agents' worktrees at 548 MB, and npm's cache at 540 MB, which no
// sweep cleared. Two root fixes: on a memory disk a repo over 15% of the disk is cloned light (repos.ts cloneMaxMb), and
// a hard sweep there clears npm's cache when no npm is running (disksweep.ts sweepNpmCache).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-memdisk-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
process.env.STUDIO_DISK_SWEEP = 'on';
process.env.npm_config_cache = path.join(tmp, 'npm');

const D = await import('../src/disksweep.ts');
const R = await import('../src/repos.ts');
const { setMemSource } = await import('../src/memgate.ts');
const MB = 1024 * 1024;
const GB = 1024 * MB;

after(() => { D.setDiskSource(null); D.setRealDiskSource(null); delete process.env.K_SERVICE; delete process.env.npm_config_cache; });

const github = (kb: number) => (async () => new Response(JSON.stringify({ size: kb }), { status: 200 })) as unknown as typeof fetch;
const PH_ORIGINS_KB = 445_747; // GitHub's size of jgriffith3433/phoriginswebsite that day

test('the clone line: 600 MB on a real disk, 15% of a disk in memory, the setting still caps both', () => {
  assert.equal(R.cloneMaxMb({ size: 10 * 1024 * MB, real: true }), 600);
  assert.equal(R.cloneMaxMb({ size: 2560 * MB, real: false }), 384, "the cell's 2.5 GB memory volume");
  assert.equal(R.cloneMaxMb({ size: 0, real: false }), 600, 'an unknown size keeps the setting');
  process.env.STUDIO_CLONE_MAX_MB = '300';
  try {
    assert.equal(R.cloneMaxMb({ size: 2560 * MB, real: false }), 300);
    assert.equal(R.cloneMaxMb({ size: 10 * 1024 * MB, real: true }), 300);
  } finally { delete process.env.STUDIO_CLONE_MAX_MB; }
});

test('PH Origins is cloned light on a memory disk, and in full on a real one', async () => {
  process.env.K_SERVICE = 'studio-test';
  try {
    D.setDiskSource(() => ({ used: 1.2 * GB, free: 1.3 * GB, size: 2560 * MB, pct: 47, path: '/disk' }));
    D.setRealDiskSource(() => false);
    R.forgetRepoSizes();
    assert.match((await R.bigRepo('jgriffith3433/phoriginswebsite', github(PH_ORIGINS_KB)))!, /about 435 MB \(over 384 MB\)/);
    D.setDiskSource(() => ({ used: 2 * GB, free: 8 * GB, size: 10 * 1024 * MB, pct: 20, path: '/disk' }));
    D.setRealDiskSource(() => true);
    R.forgetRepoSizes();
    assert.equal(await R.bigRepo('jgriffith3433/phoriginswebsite', github(PH_ORIGINS_KB)), null);
  } finally {
    delete process.env.K_SERVICE;
    D.setDiskSource(null); D.setRealDiskSource(null);
  }
});

function npmCache(mb: number) {
  const dir = D.npmCacheDir();
  fs.mkdirSync(path.join(dir, 'content-v2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'content-v2', 'blob'), Buffer.alloc(mb * MB));
  return dir;
}

test("a hard sweep on a memory disk clears npm's cache; never on a real disk or while an npm runs", async () => {
  let used = 2.3 * GB;
  D.setDiskSource(() => ({ used, free: 2560 * MB - used, size: 2560 * MB, pct: Math.round((used / (2560 * MB)) * 100), path: '/disk' }));
  setMemSource(() => ({ limit: 3916 * MB, used: 3.6 * GB, free: 0.3 * GB } as any));
  try {
    // An npm install is running: its cache stays.
    D.setRealDiskSource(() => false);
    const dir = npmCache(3);
    D.setNpmRunning(() => true);
    assert.deepEqual(D.sweepNpmCache(), { bytes: 0, skipped: 'an npm is running' });
    assert.ok(fs.existsSync(dir));
    // A real disk: a cache is worth its room there.
    D.setNpmRunning(() => false);
    D.setRealDiskSource(() => true);
    assert.equal(D.sweepNpmCache().skipped, 'a real disk');
    assert.ok(fs.existsSync(dir));
    // In memory, no npm running: the hard sweep takes it.
    D.setRealDiskSource(() => false);
    const r = await D.sweepDisk({ hard: true });
    assert.ok(!fs.existsSync(dir), 'cleared');
    assert.ok(r.detail.some((d) => /npm cache -3 MB/.test(d)), r.detail.join('; '));
    // A soft sweep never does.
    npmCache(1);
    await D.sweepDisk({ soft: true });
    assert.ok(fs.existsSync(dir), 'a soft sweep leaves it');
  } finally {
    D.setNpmRunning(() => false);
    used = 0;
  }
});

test("the running-npm check reads this machine's processes", () => {
  const real = fs.readFileSync(new URL('../src/disksweep.ts', import.meta.url), 'utf8');
  assert.match(real, /\/proc\/\$\{pid\}\/cmdline/);
  assert.ok(/(^|\/)(npm|npx|npm-cli\.js|npx-cli\.js)(\s|$)/.test('node /usr/local/bin/npm ci --no-audit'));
  assert.ok(!/(^|\/)(npm|npx|npm-cli\.js|npx-cli\.js)(\s|$)/.test('node src/server.ts --npm-like'));
});
