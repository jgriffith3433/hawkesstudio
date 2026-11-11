// The one rule every wait follows (src/waits.ts): what it waits on, a deadline in the database, the event that ends it,
// the fallback that carries on when the event never comes, and every pending wait armed again at start-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-waits-'));
const W = await import('../src/waits.ts');
const { pointOf } = await import('../src/waitpoints.ts');
const { db } = await import('../src/db.ts');
const keep = setInterval(() => {}, 1000); // the one timer is unref'd (it never holds Studio open): this test's process needs something that does

test('a wait records what it waits on and its deadline; beginning it again keeps the first deadline', () => {
  const a = W.beginWait('gen-wait', 'c_one', { waitsOn: 'Gen job j_1', deadlineMs: 60_000 });
  assert.equal(a.state, 'pending');
  assert.equal(a.waits_on, 'Gen job j_1');
  assert.ok(a.deadline - a.started === 60_000);
  const b = W.beginWait('gen-wait', 'c_one', { waitsOn: 'Gen job j_1', deadlineMs: 3_600_000 });
  assert.equal(b.deadline, a.deadline, 'asked again on every pass: the deadline is never pushed back');
  W.endWait('gen-wait', 'c_one', 'event');
});

test('a deadline longer than the point allows is clamped to its maximum; a point nobody listed throws', () => {
  const max = pointOf('checkout-turn')!.maxMs;
  const w = W.beginWait('checkout-turn', 'turn-x', { waitsOn: 'x', deadlineMs: max * 50 });
  assert.equal(w.deadline - w.started, max);
  assert.equal(W.within('checkout-turn', max * 5), max);
  assert.throws(() => W.beginWait('a-gate-nobody-listed', 's', { waitsOn: 'x', deadlineMs: 1 }), /unknown wait point/);
  assert.throws(() => W.beginWait('gen-wait', 's', { waitsOn: 'x', deadlineAt: NaN }), /no deadline/);
  W.endWait('checkout-turn', 'turn-x');
});

test('the deadline ends the wait and runs the point\'s fallback once; the event ends it before that', async () => {
  const ran: string[] = [];
  W.onDeadline('gen-wait', (w) => { ran.push(w.subject); });
  W.beginWait('gen-wait', 'c_late', { waitsOn: 'a job that never comes', deadlineMs: 10_000, since: Date.now() - 20_000 });
  W.beginWait('gen-wait', 'c_early', { waitsOn: 'a job that comes', deadlineMs: 10_000 });
  W.endWait('gen-wait', 'c_early', 'event');
  assert.equal(await W.fireDue(), 1);
  assert.deepEqual(ran, ['c_late']);
  assert.equal(W.waitOf('gen-wait', 'c_late')!.how, 'deadline');
  assert.equal(W.waitOf('gen-wait', 'c_early')!.how, 'event');
  assert.equal(await W.fireDue(), 0, 'a wait ended once never runs its fallback twice');
  // The same wait (it began at the same time) is not opened again by a gate that asks on every pass.
  const again = W.beginWait('gen-wait', 'c_late', { waitsOn: 'a job that never comes', deadlineMs: 10_000, since: W.waitOf('gen-wait', 'c_late')!.started });
  assert.equal(again.state, 'ended');
  assert.equal(W.lateWait('gen-wait', 'c_late'), true);
});

test('one timer, set for the earliest pending deadline and armed again as waits begin and end (no interval)', () => {
  for (const w of W.pendingWaits()) W.endWait(w.point, w.subject, 'cancelled');
  assert.equal(W.nextWakeAt(), null, 'nothing pending: no timer');
  const first = W.beginWait('milestone-recheck', 'n_1', { waitsOn: "beta's next build", deadlineMs: 5_000_000 });
  assert.equal(W.nextWakeAt(), first.deadline);
  const sooner = W.beginWait('milestone-recheck', 'n_2', { waitsOn: "beta's next build", deadlineMs: 1_000_000 });
  assert.equal(W.nextWakeAt(), sooner.deadline, 'the earlier deadline takes the timer');
  W.endWait('milestone-recheck', 'n_2', 'event');
  assert.equal(W.nextWakeAt(), first.deadline, 'ending it hands the timer back');
  W.endWait('milestone-recheck', 'n_1', 'event');
  assert.equal(W.nextWakeAt(), null);
});

test('a crash loses nothing: start-up arms every pending wait again and ends the ones that came due while Studio was down', async () => {
  const ran: string[] = [];
  W.onDeadline('unity-hold', (w) => { ran.push(w.subject); });
  // What the old process left in the database: one past its deadline, one still to come, one that lived in that process only.
  const now = Date.now();
  const put = (point: string, subject: string, deadline: number) => db.prepare(`INSERT OR REPLACE INTO waits (point, subject, product, waits_on, started, deadline, state) VALUES (?, ?, NULL, 'x', ?, ?, 'pending')`).run(point, subject, now - 3600_000, deadline);
  put('unity-hold', 'ancient', now - 60_000);
  put('unity-hold', 'later', now + 3_000_000);
  put('cpu-turn', 'start-lost', now + 3_000_000);
  const r = await W.rearmWaits();
  assert.equal(r.overdue, 1);
  assert.deepEqual(ran, ['ancient'], 'the one that came due while Studio was away ends through its fallback');
  assert.equal(W.waitOf('unity-hold', 'later')!.state, 'pending', 'the other is armed again');
  assert.equal(W.nextWakeAt(), W.waitOf('unity-hold', 'later')!.deadline);
  assert.equal(W.waitOf('cpu-turn', 'start-lost')!.how, 'restart', 'a turn that lived in the old process is ended, its change is resumed by its owner');
  W.endWait('unity-hold', 'later');
});

test('raceDeadline: the event wins, or the deadline does, and the wait is recorded either way', async () => {
  const won = await W.raceDeadline('gen-wait', 'race-a', Promise.resolve(7), { waitsOn: 'a promise', deadlineMs: 5_000 });
  assert.deepEqual(won, { timedOut: false, value: 7 });
  assert.equal(W.waitOf('gen-wait', 'race-a')!.how, 'event');
  const slow = await W.raceDeadline('gen-wait', 'race-b', new Promise(() => {}), { waitsOn: 'a promise that never settles', deadlineMs: 20 });
  assert.equal(slow.timedOut, true);
  assert.equal(W.waitOf('gen-wait', 'race-b')!.how, 'deadline');
  clearInterval(keep);
});
