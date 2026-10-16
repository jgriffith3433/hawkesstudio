// Background operations (ops.ts): the queue (one per product, two in all, accepted at once), resuming after a restart,
// git that doesn't block (beta.ts gitAsync, listed while it runs), and the event-loop monitor catching a block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ops-'));
const ops = await import('../src/ops.ts');
const { db } = await import('../src/db.ts');
const { gitAsync } = await import('../src/beta.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

test('the queue: a burst is accepted at once; one per product, two in all; each gets its result', async () => {
  let running = 0;
  let most = 0;
  const perProduct = new Map<string, number>();
  ops.registerOp('test-live', async (p: { product: string; n: number }, ctx) => {
    running++;
    most = Math.max(most, running);
    perProduct.set(p.product, (perProduct.get(p.product) ?? 0) + 1);
    assert.ok(perProduct.get(p.product)! <= 1, `two at once for ${p.product}`);
    ctx.step(`working on ${p.n}`);
    await sleep(150);
    perProduct.set(p.product, perProduct.get(p.product)! - 1);
    running--;
    return { n: p.n };
  });
  const t0 = Date.now();
  const queued = ['a', 'a', 'b', 'c', 'c'].map((product, n) => ops.enqueue('test-live', { product, title: `test ${product} ${n}`, payload: { product, n } }));
  assert.ok(Date.now() - t0 < 200, 'accepting five took too long');
  await until(() => queued.every((q) => ops.getOp(q.id)!.status === 'done'));
  assert.ok(most <= 2, `ran ${most} at once`);
  assert.deepEqual(queued.map((q) => ops.getOp(q.id)!.result.n), [0, 1, 2, 3, 4]);
  assert.match(ops.getOp(queued[0].id)!.log.join('\n'), /working on 0/);
  // The same request again while one is queued or running is the same operation, not a second go.
  const x = ops.enqueue('test-live', { product: 'd', title: 'x', payload: { product: 'd', n: 9 } });
  assert.equal(ops.enqueue('test-live', { product: 'd', title: 'x', payload: { product: 'd', n: 9 } }).id, x.id);
  await until(() => ops.getOp(x.id)!.status === 'done');
});

test('a failure is recorded with its reason; a restart puts a running one back, and gives up after 3 attempts', async () => {
  ops.registerOp('test-fail', async () => { throw new Error('the push was refused'); });
  const f = ops.enqueue('test-fail', { product: 'e', title: 'failing', payload: {} });
  await until(() => ops.getOp(f.id)!.status === 'failed');
  assert.match(ops.getOp(f.id)!.error!, /push was refused/);

  // As if Studio restarted mid-run: attempt 1 goes back in the queue and finishes; attempt 3 is given up.
  const now = Date.now();
  db.prepare(`INSERT INTO ops (id, kind, product, title, status, payload, created, started, attempts, log) VALUES ('op_resume00001', 'test-live', 'f', 'resumed', 'running', '{"product":"f","n":7}', ?, ?, 1, '[]')`).run(now, now);
  db.prepare(`INSERT INTO ops (id, kind, product, title, status, payload, created, started, attempts, log) VALUES ('op_resume00002', 'test-live', 'g', 'too many', 'running', '{"product":"g","n":8}', ?, ?, 3, '[]')`).run(now, now);
  assert.equal(ops.resumeOps(), 2);
  assert.equal(ops.getOp('op_resume00002')!.status, 'failed');
  await until(() => ops.getOp('op_resume00001')!.status === 'done');
  assert.equal(ops.getOp('op_resume00001')!.attempts, 2);
});

test('gitAsync: listed while it runs, Studio keeps ticking, and the answer is right', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ops-git-'));
  spawnSync('git', ['init', '-q', dir]);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const p = gitAsync(dir, ['status', '--porcelain']);
  assert.ok(ops.runningCommands().some((c) => /git status/.test(c.cmd)), 'not listed while running');
  const r = await p;
  clearInterval(timer);
  assert.equal(r.ok, true);
  assert.ok(ticks > 0, 'the event loop never ran while git did');
  assert.ok(!ops.runningCommands().some((c) => /git status/.test(c.cmd)), 'still listed after it ended');
  const bad = await gitAsync(dir, ['rev-parse', '--verify', 'no-such-ref']);
  assert.equal(bad.ok, false);
});

test('the event-loop monitor records a block over a second, with what was running', async () => {
  ops.startLoopMonitor();
  await sleep(600);
  const end = Date.now() + 1600;
  while (Date.now() < end) { /* hold the event loop, as a synchronous push once did */ }
  await sleep(700);
  const h = ops.loopHealth();
  assert.ok(h.blocks.length >= 1, 'no block recorded');
  assert.ok(h.blocks[0].ms >= 1000);
});
