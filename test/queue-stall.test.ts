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
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 3 }));
const { queueStalled, queueHeldBy: heldBy, queueHealth } = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');
const { queueAttention } = await import('../src/resources.ts');

const min = 60_000;
const now = 1_000 * min;
const base = { queued: 60, free: 5, lastStartAt: now - 120 * min, oldestQueuedAt: now - 120 * min, now, memLow: false, held: false, stallMs: 20 * min };

test('free slots, a queue, and no start for longer than the stall time: stalled, and says so', () => {
  assert.equal(queueStalled(base), '60 queued and 5 slot(s) free, but nothing started for 120 min');
  assert.match(String(queueStalled({ ...base, memLow: true })), /memory is low/);
});

test('not stalled: nothing queued, no free slot, a recent start, or a fresh queue', () => {
  assert.equal(queueStalled({ ...base, queued: 0 }), null);
  assert.equal(queueStalled({ ...base, free: 0 }), null);
  assert.equal(queueStalled({ ...base, lastStartAt: now - 5 * min }), null);
  assert.equal(queueStalled({ ...base, oldestQueuedAt: now - 5 * min }), null);
});

test('a hold that lasts past the stall time is reported too, never silent', () => {
  assert.match(String(queueStalled({ ...base, held: true })), /held: a deploy is pending or no provider is ready/);
});

test("the pump says why it started nothing, and the watchdog logs it", () => {
  const src = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const pump = src.slice(src.indexOf('async function pumpPass()'), src.indexOf('/** Pushes a change'));
  for (const ret of pump.match(/\n  (if \([^\n]*\) )?return[^\n]*/g) ?? []) assert.match(ret, /pumpNote/, `every early return records why: ${ret.trim()}`);
  assert.match(src, /queue stalled: \$\{why\}; the pump's last look: \$\{pumpNote\}/);
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

test('a revision waits its turn in the queue instead of starting on the spot past the cap', async () => {
  const src = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function revise('), src.indexOf('export function answerChange('));
  assert.ok(body.includes('reviseNotes.set(id, note)'), 'the note is kept for the pump');
  assert.ok(!/\bvoid work\(/.test(body), 'revise never starts a pass itself (2026-11-10: 13 passes on a cap of 6)');
});

test('a verifying change (waiting on a Gen build or playtest) holds no agent slot; working and revising do', () => {
  const add = (id: string, status: string, updated: number) => db.prepare('INSERT INTO changes (id, product, findings, status, title, created, updated, request) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'qs', '[]', status, id, updated, updated, 'test');
  const t = Date.now();
  add('c_qs_verify1', 'verifying', t);
  add('c_qs_verify2', 'verifying', t);
  add('c_qs_verify3', 'verifying', t);
  add('c_qs_work', 'working', t);
  add('c_qs_queued', 'queued', t - 60 * min);
  const q = queueHealth(t);
  assert.equal(q.max, 3);
  assert.equal(q.free, 2, 'three verifying and one working leave two of three slots free');
  assert.equal(q.queued, 1);
  db.prepare("UPDATE changes SET status = 'revising' WHERE id = 'c_qs_verify1'").run();
  assert.equal(queueHealth(t).free, 1);
});

test('the Resources page warns while the queue sits with free slots, and says nothing otherwise', () => {
  assert.equal(queueAttention(null), null);
  assert.equal(queueAttention({ stalled: null, heldBy: null }), null);
  const a = queueAttention({ stalled: '5 queued and 2 slot(s) free, but nothing started for 14 min', heldBy: '5x queued by the PM' });
  assert.equal(a?.level, 'warn');
  assert.match(String(a?.text), /isn't moving: 5 queued .* Held by: 5x queued by the PM/);
});
