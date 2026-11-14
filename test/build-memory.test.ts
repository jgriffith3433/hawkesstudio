// A Studio npm build's memory: memoryMiB reaches the job's per-run limit, and nothing else changes (J, 2026-11-14, q_47ed113b805c).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-memtest-'));
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { runBody } = await import('../src/gcp.ts');
const { buildMemoryMiB } = await import('../src/builds.ts');
const { checkMemoryMiB } = await import('../src/config.ts');

test('a build with memoryMiB 1024 starts its job with a 1 GiB memory limit', () => {
  const c = runBody({ env: { A: 'b' }, timeoutSeconds: 60, memoryMiB: 1024 }).overrides.containerOverrides[0] as any;
  assert.deepEqual(c.resources, { limits: { memory: '1024Mi' } });
  assert.equal(1024 / 1024, 1, '1024 MiB is 1 GiB');
});

test('a build without memoryMiB keeps the job\'s own limit', () => {
  const c = runBody({ env: {}, timeoutSeconds: 60 }).overrides.containerOverrides[0] as any;
  assert.equal('resources' in c, false);
  assert.equal(buildMemoryMiB({ id: 'other' }, { tool: 'npm' }), undefined);
  assert.equal(buildMemoryMiB({ id: 'dose-of-destruction' }, { tool: 'static' }), undefined);
});

test('the build\'s own setting wins, and dose-of-destruction\'s npm build is 1024 MiB', () => {
  assert.equal(buildMemoryMiB({ id: 'dose-of-destruction' }, { tool: 'npm' }), 1024);
  assert.equal(buildMemoryMiB({ id: 'dose-of-destruction' }, { tool: 'npm', memoryMiB: 2048 }), 2048);
  assert.equal(buildMemoryMiB({ id: 'x' }, { tool: 'npm', memoryMiB: 768 }), 768);
});

test('memoryMiB is checked', () => {
  assert.equal(checkMemoryMiB(1024), 1024);
  assert.throws(() => checkMemoryMiB(100), /512 to 8192/);
  assert.throws(() => checkMemoryMiB('lots'), /512 to 8192/);
});

test('runCloudBuild hands memoryMiB to the runner\'s start, and only when set', async () => {
  const J = await import('../src/cloudjob.ts');
  const seen: unknown[] = [];
  J.setJobRunner(() => ({
    put: async () => {}, get: async () => null, list: async () => [], remove: async () => {},
    start: async (_u: string, o?: { memoryMiB?: number }) => { seen.push(o); throw new Error('stop here'); },
    state: async () => null, cancel: async () => {},
  } as any));
  try {
    for (const memoryMiB of [1024, undefined]) {
      await assert.rejects(J.runCloudBuild(`mem-${memoryMiB}`, { remote: 'https://github.com/a/b.git', head: 'abc', cwd: '/tmp/build/x', command: 'true', outputs: ['dist'], ...(memoryMiB ? { memoryMiB } : {}) }), /stop here/);
    }
  } finally { J.setJobRunner(null); }
  assert.deepEqual(seen, [{ memoryMiB: 1024 }, undefined]);
});
