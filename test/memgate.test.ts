// Studio's cloud server was killed for memory seven times in 20 minutes at 12 agents (2026-11-10): every change started
// or resumed at once whatever memory was left. memgate.ts holds new work while too little is free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.STUDIO_MEM_GATE = 'on';
import { memInfo, memLow, memNeeded, memRoom, memFreed, memWaiting, setMemSource } from '../src/memgate.ts';

const GB = 1024 ** 3;

test('reads a real limit and free memory', () => {
  setMemSource(null);
  const m = memInfo(Date.now() + 10_000);
  assert.ok(m.limit > 0 && m.available >= 0 && m.available <= m.limit);
});

test('a 4 GiB server needs 1 GiB free to start more', () => {
  assert.equal(memNeeded(4 * GB), 1 * GB);
  assert.equal(memNeeded(16 * GB), 4 * GB);
  assert.equal(memNeeded(1 * GB), 0.5 * GB);
  setMemSource(() => ({ limit: 4 * GB, available: 0.8 * GB }));
  assert.equal(memLow(), true);
  setMemSource(() => ({ limit: 4 * GB, available: 1.5 * GB }));
  assert.equal(memLow(), false);
  setMemSource(null);
});

test('memRoom waits while memory is low and work runs, and goes once work ends and frees it', async () => {
  let free = 0.5 * GB;
  setMemSource(() => ({ limit: 4 * GB, available: free }));
  let busy = 2;
  let waited = 0;
  let done = false;
  const p = memRoom(() => busy, () => waited++).then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  assert.equal(waited, 1);
  assert.equal(memWaiting(), 1);
  // One finishes but memory is still short: it keeps waiting.
  busy = 1;
  memFreed();
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  // The next frees enough.
  free = 2 * GB;
  memFreed();
  await p;
  assert.equal(done, true);
  assert.equal(waited, 1);
  setMemSource(null);
});

test('memRoom never holds the only work', async () => {
  setMemSource(() => ({ limit: 4 * GB, available: 0.1 * GB }));
  await memRoom(() => 0);
  setMemSource(null);
});
