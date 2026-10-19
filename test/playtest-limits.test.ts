// How long a playtest may hold the queue (J, 2026-10-19: beta runs "backed up" behind two playtests past their limit).
// runGenJob counts the run time from the job's earliest start (a Studio restart or a Gen restart never extends it),
// cancels a playtest whose progress stands still, and stops for a newer beta build (betaqueue.ts supersedingBuild).
// A scratch database and a stand-in for Hawkes Gen; nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playtest-limits-'));
process.env.STUDIO_DATA = tmp;

const { db, newId, J } = await import('../src/db.ts');
const { runGenJob } = await import('../src/playtests.ts');
const { supersedingBuild } = await import('../src/betaqueue.ts');

/** A stand-in for Gen: one job whose state each poll comes from next(), and every cancel asked for. */
function fakeGen(next: (polls: number) => any) {
  const cancels: string[] = [];
  let polls = 0;
  let cancelled = false;
  return {
    cancels,
    submit: async () => ({ id: 'j_new', status: 'queued' }),
    job: async (id: string) => (cancelled ? { id, status: 'cancelled' } : { id, ...next(++polls) }),
    cancel: async (id: string) => { cancels.push(id); cancelled = true; return { id, status: 'cancelled' }; },
  };
}
const fast = { pollMs: 5 };

test('a Studio restart never restarts the clock: the run time counts from the step\'s first start', async () => {
  // Gen says it started just now (it was picked up again after a Gen restart); the step first ran 10 s ago.
  const g = fakeGen(() => ({ status: 'running', started: Date.now(), detail: 'Level 1 50% (the portcullis goes down)' }));
  const j = await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: g, job: 'j_old', runMs: 5_000, since: Date.now() - 10_000 });
  assert.equal(j.status, 'failed');
  assert.match(j.error, /^stuck: ran for over .* counted across restarts/);
  assert.deepEqual(g.cancels, ['j_old']);
});

test('the run time counts from Gen\'s own start, not from when Studio first saw the job running', async () => {
  const started = Date.now() - 10_000;
  const at: number[] = [];
  const g = fakeGen(() => ({ status: 'running', started, detail: 'playing' }));
  const j = await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: g, job: 'j_old', runMs: 5_000, onStart: (t) => at.push(t) });
  assert.equal(j.status, 'failed');
  assert.match(j.error, /ran for over/);
  assert.deepEqual(at, [started], 'the start is recorded for the next restart');
});

test('a playtest within its limit finishes untouched', async () => {
  const g = fakeGen((n) => (n < 4 ? { status: 'running', started: Date.now(), detail: `level ${n}` } : { status: 'done', result: { outcome: 'pass' } }));
  const j = await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: g, runMs: 60_000, idleMs: 60_000, since: Date.now() - 1000 });
  assert.equal(j.status, 'done');
  assert.deepEqual(g.cancels, []);
});

test('no progress for the idle limit while it plays: cancelled as stuck, with where it stood', async () => {
  const g = fakeGen(() => ({ status: 'running', started: Date.now(), detail: 'story2: Level 1 50% (the portcullis goes down)' }));
  const j = await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: g, runMs: 60_000, idleMs: 60 });
  assert.equal(j.status, 'failed');
  assert.match(j.error, /^stuck: no progress for \d+ min \(still at "story2: Level 1 50% \(the portcullis goes down\)"\), so it was cancelled$/);
  assert.equal(g.cancels.length, 1);
});

test('progress keeps it going, and quiet phases (a browser slot, the video) are not stuck', async () => {
  const moving = fakeGen((n) => (n < 30 ? { status: 'running', started: Date.now(), detail: `level ${n}` } : { status: 'done' }));
  assert.equal((await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: moving, runMs: 60_000, idleMs: 60 })).status, 'done');
  const encoding = fakeGen((n) => (n < 30 ? { status: 'running', started: Date.now(), detail: 'encoding the video' } : { status: 'done' }));
  assert.equal((await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: encoding, runMs: 60_000, idleMs: 30 })).status, 'done');
  // Back in Gen's line after a Gen restart: queued is not "no progress".
  const queued = fakeGen((n) => (n < 30 ? { status: 'queued', detail: 'picked up again after a restart' } : { status: 'done' }));
  assert.equal((await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: queued, runMs: 60_000, idleMs: 30 })).status, 'done');
  assert.deepEqual([...moving.cancels, ...encoding.cancels, ...queued.cancels], []);
});

test('abandon: cancelled (not failed) with the reason', async () => {
  let ask = false;
  const g = fakeGen((n) => { if (n > 2) ask = true; return { status: 'running', started: Date.now(), detail: `level ${n}` }; });
  const j = await runGenJob('playtest.run', 'p', {}, () => {}, { ...fast, api: g, runMs: 60_000, abandon: () => (ask ? 'superseded by r_new' : null) });
  assert.equal(j.status, 'cancelled');
  assert.equal(j.abandoned, true);
  assert.equal(j.error, 'superseded by r_new');
  assert.equal(g.cancels.length, 1);
});

let n = 0;
function run(product: string, kind = 'beta') {
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', `${kind} ${product}`, J([product]), J({}), Date.now() + n++);
  return id;
}
function step(r: string, product: string, kind: string, name: string, status = 'running') {
  const id = newId('s');
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, r, product, kind, name, status, Date.now());
  return id;
}

test('an old beta run stops playing only when a newer beta run of the product waits to build', () => {
  const old = run('yoobaland');
  assert.equal(supersedingBuild(old, 'yoobaland'), null);
  const newer = run('yoobaland');
  step(newer, 'yoobaland', 'beta', 'queue');
  assert.equal(supersedingBuild(old, 'yoobaland'), null, 'still in its quiet time: nothing waits yet');
  const b = step(newer, 'yoobaland', 'build', 'unity');
  assert.equal(supersedingBuild(old, 'yoobaland'), newer);
  assert.equal(supersedingBuild(newer, 'yoobaland'), null, 'a run is never superseded by an older one');
  assert.equal(supersedingBuild(old, 'sickofit'), null, 'another product');
  db.prepare(`UPDATE steps SET status = 'done' WHERE id = ?`).run(b);
  assert.equal(supersedingBuild(old, 'yoobaland'), null, 'built already: nothing waits');
  const daily = run('yoobaland', 'daily');
  step(daily, 'yoobaland', 'build', 'unity');
  assert.equal(supersedingBuild(old, 'yoobaland'), null, 'daily runs never cut a beta check short');
});
