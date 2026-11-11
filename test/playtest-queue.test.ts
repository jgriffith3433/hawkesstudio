// The playtest queue's cap measures a stalled queue, not a busy one (J, 2026-11-10: a deep queue of healthy playtests was
// cut at 45 minutes). A deep queue that keeps moving is never cut; a frozen one is cut after 20 minutes of nothing ahead
// moving; a cut from the queue is tried once more by itself. A scratch database and a stand-in for Hawkes Gen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playqueue-'));
const { runGenJob } = await import('../src/playtests.ts');
const F = await import('../src/playtest-finish.ts');
const C = await import('../src/playtest-capacity.ts');
const { db, newId, J } = await import('../src/db.ts');

/** A stand-in for Gen's job: `queued` while `place()` is above 0, then running for `runPolls` looks, then done. */
function fakeGen(place: () => number, runPolls = 3) {
  const cancels: string[] = [];
  let polls = 0;
  let cancelled = false;
  return {
    cancels,
    api: {
      submit: async () => ({ id: 'j_unused', status: 'queued' }),
      job: async (id: string) => {
        polls++;
        if (cancelled) return { id, status: 'cancelled' };
        if (place() > 0) return { id, status: 'queued', detail: 'queued' };
        if (polls > runPolls * 3) return { id, status: 'done', result: { outcome: 'pass' } };
        return { id, status: 'running', started: Date.now(), detail: `level ${polls}` };
      },
      cancel: async (id: string) => { cancels.push(id); cancelled = true; return { id, status: 'cancelled' }; },
    },
  };
}

test('a deep queue that keeps moving is not cut, however long it takes', async () => {
  // 6 places ahead; every look at Gen's line finds one fewer ahead, so the queue moves every 20 ms (the stall window).
  // The job starts once the place reaches 0 at the fifth look after the first, so five windows pass while it waits.
  let ahead = 6;
  let looks = 0;
  const g = fakeGen(() => ahead);
  const started = Date.now();
  const job = await runGenJob('playtest.run', 'p', {}, () => {}, {
    api: g.api, job: 'j_deep', runMs: 60_000, pollMs: 5, queueMs: 60_000, queueStallMs: 20,
    queuePosition: async () => { looks++; const now = ahead; ahead = Math.max(0, ahead - 1); return now; },
  });
  assert.equal(job.status, 'done', `not cut: ${job.error ?? ''}`);
  assert.deepEqual(g.cancels, []);
  assert.ok(looks >= 5, 'it looked at the queue at each stall window');
  assert.ok(Date.now() - started >= 5 * 20 - 5, 'it really waited past several stall windows');
});

test('a frozen queue is cut once nothing ahead of it moved for the stall window', async () => {
  const g = fakeGen(() => 3);
  const started = Date.now();
  const job = await runGenJob('playtest.run', 'p', {}, () => {}, {
    api: g.api, job: 'j_frozen', runMs: 60_000, pollMs: 5, queueMs: 60_000, queueStallMs: 60,
    queuePosition: async () => 3,
  });
  const waited = Date.now() - started;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /^stuck: the playtest queue didn't move for \d+ min \(3 ahead\), so it was cancelled$/);
  assert.deepEqual(g.cancels, ['j_frozen']);
  assert.ok(waited >= 60 - 5, 'not before the stall window');
  assert.ok(waited < 5_000, 'and not long after it');
  assert.equal(F.classifyFailure(job)?.kind, 'queue', 'the cut is one a second try is made for');
});

test('a queue Gen cannot read falls back to the ceiling from submit', async () => {
  const g = fakeGen(() => 2);
  const job = await runGenJob('playtest.run', 'p', {}, () => {}, {
    api: g.api, job: 'j_blind', runMs: 60_000, pollMs: 5, queueMs: 120, queueStallMs: 30,
    queuePosition: async () => null,
  });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /^stuck: waited in the queue for over/);
  assert.equal(F.classifyFailure(job)?.kind, 'queue');
});

test('a queue cut is tried once more by itself, on the same params and with no provider blamed', () => {
  const cut = { status: 'failed', error: "stuck: the playtest queue didn't move for 20 min (4 ahead), so it was cancelled", stuckAt: 'waiting for RunPod worker' };
  const c = F.classifyFailure(cut);
  assert.deepEqual(c, { kind: 'queue', provider: null }, 'a busy-looking detail never trips the GPU breaker');
  const params = { url: 'u', scenario: 'smoke', skipProviders: ['modal'] };
  assert.deepEqual(F.retryParams(params, c!), { url: 'u', scenario: 'smoke' });
  assert.match(F.plainWhy(cut, null), /^The playtest could not finish because it waited in Hawkes Gen’s queue and nothing ahead of it moved\.$/);
  assert.equal(F.classifyFailure({ status: 'failed', error: 'stuck: waited in the queue for over 45 min, so it was cancelled' })?.kind, 'queue');
});

test('the stall window is 20 minutes, the ceiling 45', () => {
  assert.equal(F.PLAYTEST_QUEUE_STALL_MS(), 20 * 60_000);
  assert.equal(F.PLAYTEST_QUEUE_MS(), 45 * 60_000);
});

test('the wait sentence says how long, from the last finished playtests (none without history)', () => {
  assert.equal(C.expectedWaitText(3, 4), '', 'no history yet: nothing to say');
  const run = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, started) VALUES (?, ?, ?, ?, ?, ?)').run(run, 'daily', 'running', 'x', J([]), Date.now());
  for (let i = 0; i < 5; i++) {
    const at = Date.now() - i * 1000;
    db.prepare("INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, 'p', 'playtest', 'smoke@local', 'done', '', ?, ?, ?)")
      .run(newId('s'), run, J({ runningSince: at - 10 * 60_000 }), at - 10 * 60_000, at);
  }
  // Ten minutes a playtest; 4 ahead on 2 tabs: 5 turns of 10 minutes over 2 tabs = 25 minutes.
  assert.equal(C.expectedWaitText(4, 2), ', about 25 min to go');
});
