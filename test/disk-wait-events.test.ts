// A change waiting for disk room tries again when room may have freed (a pass ended, a sweep freed space), never on a
// timer (diskwait.ts; J, 2026-11-10: "Please stop implementing polling"). 2026-11-10 23:03: 104 changes waited for disk
// room, each tried again every 5 minutes whether anything had freed or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diskWaits } from '../src/diskwait.ts';
import { onDiskFreed, diskFreed } from '../src/disksweep.ts';

test('a waiting change stays held however long it waits, until room may have freed; then the queue wakes once', async () => {
  const wakes: string[] = [];
  const w = diskWaits((why) => wakes.push(why));
  w.hold('c_a'); w.hold('c_b');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.holds('c_a'), true, 'time alone frees nothing');
  assert.equal(w.freed('c_x\'s pass ended'), true);
  assert.deepEqual(wakes, ["c_x's pass ended"]);
  assert.equal(w.holds('c_a'), false);
  assert.equal(w.holds('c_b'), false);
  // Tried, and still no room: held again until the next freeing.
  w.hold('c_a');
  assert.equal(w.holds('c_a'), true);
});

test('nothing waiting: freeing room wakes nothing (no empty queue passes)', () => {
  let wakes = 0;
  const w = diskWaits(() => wakes++);
  assert.equal(w.freed(), false);
  assert.equal(wakes, 0);
});

test("a sweep that freed space tells whoever listens", () => {
  const heard: string[] = [];
  const off = onDiskFreed((why) => heard.push(why));
  diskFreed('a hard sweep freed ~300 MB');
  off();
  diskFreed('again');
  assert.deepEqual(heard, ['a hard sweep freed ~300 MB']);
});

test('the queue holds no timer per waiting change any more', () => {
  const src = fs.readFileSync('src/agents.ts', 'utf8');
  const waitFn = src.slice(src.indexOf('function waitForDisk('), src.indexOf("/** A revision's note"));
  assert.doesNotMatch(waitFn, /setTimeout|DISK_WAIT_MS/);
  assert.doesNotMatch(src, /STUDIO_DISK_WAIT_MS/);
});

// 2026-11-11 ~01:00-01:35: a change with no disk room went back to wait, its pass ended, the ending freed every hold
// (its own included) and woke the queue, which picked it again: round and round, Studio's CPU and database went to the
// loop and every request was turned away as busy. A pass that only went back to wait frees nothing.
test("a pass that ended by going back to wait for disk room wakes no one, and the queue settles", () => {
  let wakes = 0;
  const w = diskWaits(() => wakes++);
  // The queue: picks every change not held; each finds no room, waits, and its pass ends.
  const queue = ['c_a', 'c_b'];
  let tries = 0;
  const pump = () => {
    for (const id of queue.filter((c) => !w.holds(c))) {
      if (++tries > 50) throw new Error('the queue loops');
      w.hold(id); // no room: back to wait
      if (!w.passEnded(id)) continue;
      pump();
    }
  };
  pump();
  assert.equal(tries, 2, 'each tried once');
  assert.equal(wakes, 0);
  assert.equal(w.holds('c_a') && w.holds('c_b'), true, 'both wait for real room');
  // A pass that held room (it ran) ending frees them, once.
  assert.equal(w.passEnded('c_ran'), true);
  assert.equal(wakes, 1);
  assert.equal(w.holds('c_a'), false);
});

test('a sweep that leaves the disk full tells no one; the queue is told only when there is room for a worktree', async () => {
  const src = fs.readFileSync('src/disksweep.ts', 'utf8');
  const tell = src.split('\n').find((l) => l.includes('diskFreed(`a '))!;
  assert.match(tell, /roomForAWorktree\(\)/);
  const agents = fs.readFileSync('src/agents.ts', 'utf8');
  assert.match(agents, /diskWait\.passEnded\(c\.id/);
  assert.doesNotMatch(agents, /diskWait\.freed\(`\$\{c\.id\}'s pass ended`\)/);
});
