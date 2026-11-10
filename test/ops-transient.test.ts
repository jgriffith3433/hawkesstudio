// An operation that fails on something that passes by itself (GitHub not answering, a 5xx) waits and tries again by
// itself instead of failing: 2026-11-10 21:26, one GitHub timeout failed Hawkes Studio's own go live outright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ops-transient-'));
const ops = await import('../src/ops.ts');
const { db } = await import('../src/db.ts');
const { causeOf } = await import('../src/causes.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}
const TIMEOUT = "GitHub: GitHub didn't answer GET /repos/jgriffith3433/hawkesstudio/compare/main...beta: The operation was aborted due to timeout";

test("gh()'s timeout reads as a network failure", () => {
  assert.equal(causeOf(TIMEOUT)?.key, 'network');
  assert.equal(causeOf('TimeoutError: The operation was aborted due to timeout')?.key, 'network');
});

test('a GitHub timeout makes the operation wait and try again by itself, then it finishes', async () => {
  ops.opRetry.waits = [50, 50, 50];
  let tries = 0;
  ops.registerOp('test-gh-slow', async () => {
    tries++;
    if (tries === 1) throw new Error(TIMEOUT);
    return { ok: true };
  });
  const op = ops.enqueue('test-gh-slow', { product: 'a', title: 'going live', payload: {} });
  await until(() => ops.getOp(op.id)!.status === 'waiting');
  const w = ops.getOp(op.id)!;
  assert.equal(w.wait?.retries, 1);
  assert.match(w.step!, /trying again by itself/);
  await until(() => ops.getOp(op.id)!.status === 'done');
  assert.equal(tries, 2);
});

test('it gives up only after every wait, with the real reason', async () => {
  ops.opRetry.waits = [20, 20, 20];
  let tries = 0;
  ops.registerOp('test-gh-down', async () => { tries++; throw new Error('GitHub answered 503 Service Unavailable'); });
  const op = ops.enqueue('test-gh-down', { product: 'b', title: 'going live', payload: {} });
  await until(() => ops.getOp(op.id)!.status === 'failed');
  assert.equal(tries, 4);
  assert.match(ops.getOp(op.id)!.error!, /503/);
});

test('a failure that would not pass by itself fails at once', async () => {
  let tries = 0;
  ops.registerOp('test-refused', async () => { tries++; throw new Error('Not going live: beta has no build yet'); });
  const op = ops.enqueue('test-refused', { product: 'c', title: 'going live', payload: {} });
  await until(() => ops.getOp(op.id)!.status === 'failed');
  assert.equal(tries, 1);
});

test('after a restart, a waiting retry is re-armed from its due time', async () => {
  ops.registerOp('test-rearm', async () => ({ ok: true }));
  const wait = JSON.stringify({ on: null, why: 'GitHub timed out', rounds: 0, since: Date.now(), retries: 1, due: Date.now() + 50 });
  db.prepare(`INSERT INTO ops (id, kind, product, title, status, payload, created, attempts, log, wait) VALUES ('op_rearm000001', 'test-rearm', 'd', 'rearm', 'waiting', '{}', ?, 0, '[]', ?)`).run(Date.now(), wait);
  ops.resumeOps();
  assert.equal(ops.getOp('op_rearm000001')!.status, 'waiting');
  await until(() => ops.getOp('op_rearm000001')!.status === 'done');
});
