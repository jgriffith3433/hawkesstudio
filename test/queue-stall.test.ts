// The queue watchdog (agents.ts queueStalled, heldBy): a queue with free slots where nothing has started for a while is
// stalled, and says what holds it. On 2026-11-10 a disk budget below the disk's size at rest held every change as
// "waits for disk room" for hours with five of six slots free, and nothing noticed (J: "the goal shouldn't be to have
// to watch studio").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-queue-stall-'));
const { queueStalled, queueHeldBy: heldBy } = await import('../src/agents.ts');

const min = 60_000;
const now = 1_000 * min;
const base = { queued: 60, free: 5, lastStartAt: now - 120 * min, oldestQueuedAt: now - 120 * min, now, memLow: false, held: false, stallMs: 20 * min };

test('free slots, a queue, and no start for longer than the stall time: stalled, and says so', () => {
  assert.equal(queueStalled(base), '60 queued and 5 slot(s) free, but nothing started for 120 min');
  assert.match(String(queueStalled({ ...base, memLow: true })), /memory is low/);
});

test('not stalled: nothing queued, no free slot, a recent start, a fresh queue, or a hold that is meant (deploy, no provider)', () => {
  assert.equal(queueStalled({ ...base, queued: 0 }), null);
  assert.equal(queueStalled({ ...base, free: 0 }), null);
  assert.equal(queueStalled({ ...base, lastStartAt: now - 5 * min }), null);
  assert.equal(queueStalled({ ...base, oldestQueuedAt: now - 5 * min }), null);
  assert.equal(queueStalled({ ...base, held: true }), null);
});

test('what holds the queue, counted by reason, most first', () => {
  const d = [
    'queued: waits for disk room (the disk is full (2.08 GB used of 4.00 GB))',
    'queued: waits for disk room (the disk is full (2.06 GB used of 4.00 GB))',
    'queued by the PM (a roadmap task)',
    'queued: waits for c_62c0424853ba (both change js/sim.ts)',
    'queued: waits for disk room (the disk is full (2.05 GB used))',
    null,
  ];
  assert.equal(heldBy(d), '3x queued: waits for disk room; 1x queued by the PM; 1x queued: waits for another change; 1x queued');
});
