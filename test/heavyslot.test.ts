// One heavy job (a build's output download, a beta site's publish) at a time in a Studio on Cloud Run: on 2026-11-01
// several products publishing at once went over a customer's Studio's 2 GiB and it was killed for memory again and again.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.STUDIO_HEAVY_SLOTS = '1';
const { heavy, heavySlot, heavyState } = await import('../src/heavyslot.ts');

test('heavy jobs run one at a time, in order, and a failed one hands its slot on', async () => {
  const log: string[] = [];
  let running = 0, most = 0;
  const job = (name: string, fail = false) => heavy(async () => {
    running++; most = Math.max(most, running); log.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, 15));
    log.push(`end ${name}`); running--;
    if (fail) throw new Error(name);
    return name;
  });
  const waits: string[] = [];
  const r = await Promise.allSettled([job('a'), job('b', true), job('c'), heavy(async () => 'x', (s) => waits.push(s))]);
  assert.equal(most, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(waits.length, 1, 'a job that has to wait says so');
  assert.deepEqual(heavyState(), { used: 0, waiting: 0, limit: 1 });
});

test('a release called twice frees one slot only', async () => {
  const a = await heavySlot();
  a(); a();
  assert.equal(heavyState().used, 0);
  const b = await heavySlot();
  let cGot = false;
  const c = heavySlot().then((rel) => { cGot = true; return rel; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cGot, false);
  b(); b();
  (await c)();
  assert.deepEqual(heavyState(), { used: 0, waiting: 0, limit: 1 });
});

test('off Cloud Run with no setting there is no limit; on Cloud Run it is one', async () => {
  const was = { s: process.env.STUDIO_HEAVY_SLOTS, k: process.env.K_SERVICE };
  delete process.env.STUDIO_HEAVY_SLOTS; delete process.env.K_SERVICE;
  assert.equal(heavyState().limit, Infinity);
  process.env.K_SERVICE = 'studio-o-x';
  assert.equal(heavyState().limit, 1);
  process.env.STUDIO_HEAVY_SLOTS = '3';
  assert.equal(heavyState().limit, 3);
  if (was.s === undefined) delete process.env.STUDIO_HEAVY_SLOTS; else process.env.STUDIO_HEAVY_SLOTS = was.s;
  if (was.k === undefined) delete process.env.K_SERVICE; else process.env.K_SERVICE = was.k;
});
