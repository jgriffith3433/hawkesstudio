// A checkout's turn ends on its own: one that hangs passes the turn on after its limit (stall-paths.md, Nov 11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-checkout-turn-'));
process.env.STUDIO_CHECKOUTS = '1';
const A = await import('../src/agents.ts');

test('a checkout that hangs passes its turn on at the limit, and the slot is counted once', async () => {
  assert.equal(A.checkoutLimit(), 1);
  // The turn's timer doesn't hold Studio's process open (unref); this test's process needs something that does.
  const keep = setInterval(() => {}, 1000);
  let finishHung!: () => void;
  let longSaid = 0;
  const hung = A.checkoutSlot(() => new Promise<void>((r) => { finishHung = r; }), { turnMs: 50, onLong: () => longSaid++ });
  const order: string[] = [];
  const next = A.checkoutSlot(async () => { order.push('next'); }, { turnMs: 5000 });
  await next;
  assert.deepEqual(order, ['next'], 'the next checkout ran while the first still hung');
  assert.equal(longSaid, 1);
  assert.equal(A.checkoutsUnderWay(), 0, 'neither holds a turn now');
  finishHung();
  await hung;
  assert.equal(A.checkoutsUnderWay(), 0, 'the late finish does not free the turn a second time');
  // One at a time still holds for checkouts that finish in time.
  let inside = 0, most = 0;
  const one = () => A.checkoutSlot(async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 10)); inside--; }, { turnMs: 5000 });
  await Promise.all([one(), one(), one()]);
  assert.equal(most, 1);
  clearInterval(keep);
});
