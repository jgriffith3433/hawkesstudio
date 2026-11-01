// Unity beta builds collapse (betaqueue.ts): a burst of pushes makes one build, a newer beta run takes over from one
// still waiting (skipped, never failed), a build running on the build server is never cancelled, an older beta build
// still queued in Gen is cancelled only when Gen says it never started, and go-live and daily builds are left alone.
// A scratch database and a stand-in for Hawkes Gen; no real repo, build server or Gen is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-betaqueue-'));
process.env.STUDIO_DATA = tmp;
process.env.STUDIO_BETA_TICK_MS = '10';

const { db, newId, J } = await import('../src/db.ts');
const { betaTurn, supersede, absorbed, cancelIfQueued, waitingBetaRun, olderBuilds, notePush, mergesInFlight } = await import('../src/betaqueue.ts');
const { runNotice } = await import('../src/followup.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
/** A running run of a product, as startBeta (kind beta) or golive.ts (kind live) inserts it. */
function run(product: string, kind = 'beta', options: Record<string, unknown> = {}) {
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', `${kind} ${product}`, J([product]), J(options), Date.now() + n++);
  return id;
}
function step(r: string, product: string, kind: string, name: string, status = 'running', job: string | null = null) {
  const id = newId('s');
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, job, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, r, product, kind, name, status, job, Date.now());
  return id;
}
const setStep = (id: string, status: string) => db.prepare('UPDATE steps SET status = ?, finished = ? WHERE id = ?').run(status, Date.now(), id);
const runRow = (id: string) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any;

/** A stand-in for Gen's queue: job states, the running list, and every cancel asked for. */
function fakeGen(jobs: Record<string, any>) {
  const cancels: string[] = [];
  return {
    cancels,
    job: async (id: string) => ({ id, ...jobs[id] }),
    jobs: async (q: Record<string, string>) => Object.entries(jobs).filter(([, j]) => j.status === q.status).map(([id, j]) => ({ id, ...j })),
    cancel: async (id: string) => {
      cancels.push(id);
      if (jobs[id].status === 'queued' && !jobs[id].raced) Object.assign(jobs[id], { status: 'cancelled' });
      else if (jobs[id].raced) Object.assign(jobs[id], { status: 'running', started: Date.now() });
      return { id, ...jobs[id] };
    },
  };
}

/** What betaBody does for a Unity product on the beta lane, with a stand-in build. */
async function betaRun(product: string, builds: string[], gen: any, quiet = 60) {
  const id = run(product);
  const q = step(id, product, 'beta', 'queue');
  const turn = await betaTurn(id, product, { quiet, gen, onGo: () => setStep(q, 'done') });
  if ('superseded' in turn) return supersede(id, product, turn.superseded, 'abc1234def');
  const b = step(id, product, 'build', 'unity');
  builds.push(id);
  await sleep(20);
  setStep(b, 'done');
  db.prepare(`UPDATE runs SET status = 'done', finished = ? WHERE id = ?`).run(Date.now(), id);
  return id;
}

test('a burst of 3 pushes makes 1 build, of the newest run; the others are skipped as superseded', async () => {
  const builds: string[] = [];
  const gen = fakeGen({});
  // A quiet time well past the gaps: on a loaded CI runner a 15 ms sleep can last longer than 60 ms, and the first run
  // then builds before the others arrive (flaky on GitHub, 2026-10-18).
  const done = [betaRun('burst', builds, gen, 300)];
  await sleep(15);
  done.push(betaRun('burst', builds, gen, 300));
  await sleep(15);
  done.push(betaRun('burst', builds, gen, 300));
  const results = await Promise.all(done);
  assert.equal(builds.length, 1, 'one build');
  const runs = db.prepare(`SELECT id, status, detail FROM runs WHERE products LIKE '%"burst"%' ORDER BY rowid`).all() as any[];
  assert.deepEqual(runs.map((r) => r.status), ['skipped', 'skipped', 'done']);
  assert.equal(builds[0], runs[2].id, 'the newest run builds');
  for (const r of runs.slice(0, 2)) assert.match(r.detail, /^skipped: superseded by r_[0-9a-f]+ \(beta abc1234\)$/);
  assert.match(String(results[0]), /superseded/);
  // Their steps are skipped, not failed, and what they asked for comes along to the newest run.
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run IN (?, ?) AND status = 'failed'`).get(runs[0].id, runs[1].id) as any).n, 0);
  assert.equal(absorbed(runs[2].id).length, 2, 'the newest run absorbs both, through the chain');
  assert.equal(gen.cancels.length, 0);
});

test('each push restarts the quiet time of the run that is waiting', async () => {
  // A quiet time well past the sleep: on a loaded CI runner a 50 ms sleep can outlast an 80 ms quiet time, and the run
  // then goes before the push.
  const id = run('pushy');
  const p = betaTurn(id, 'pushy', { quiet: 400, gen: fakeGen({}) });
  await sleep(50);
  const pushed = Date.now();
  notePush('pushy');
  assert.equal(waitingBetaRun('pushy'), id, 'a push finds the waiting run (no new run needed)');
  assert.deepEqual(await p, { go: true });
  assert.ok(Date.now() - pushed >= 390, 'waited the quiet time after the push, not after the start');
});

test('a build running on the build server is never cancelled; the newer run waits for it', async () => {
  const gen = fakeGen({ j_run: { status: 'running', tool: 'unity.build', started: Date.now() } });
  const old = run('busy');
  step(old, 'busy', 'beta', 'queue', 'done');
  const b = step(old, 'busy', 'build', 'unity', 'running', 'j_run');
  const neu = run('busy');
  let went = false;
  const p = betaTurn(neu, 'busy', { quiet: 0, gen }).then((t) => { went = true; return t; });
  await sleep(80);
  assert.equal(went, false, 'waits while the older build runs');
  assert.deepEqual(gen.cancels, [], 'never cancels a running build');
  setStep(b, 'done');
  assert.deepEqual(await p, { go: true });
  assert.equal(runRow(old).status, 'running', 'the older run carries on');
});

test('an older beta build still queued behind another build is cancelled, only if Gen says it never started', async () => {
  // Another product's build has the build server: the queued one can't start this instant.
  const jobs: Record<string, any> = { j_other: { status: 'running', tool: 'unity.build', started: Date.now() }, j_q: { status: 'queued', tool: 'unity.build' } };
  const gen = fakeGen(jobs);
  const old = run('queued');
  step(old, 'queued', 'beta', 'queue', 'done');
  const b = step(old, 'queued', 'build', 'unity', 'running', 'j_q');
  const neu = run('queued');
  const p = betaTurn(neu, 'queued', { quiet: 0, gen });
  // Waited for, not timed: a loaded CI runner may take longer than a fixed sleep to get there.
  for (let i = 0; i < 500 && !gen.cancels.length; i++) await sleep(10);
  assert.deepEqual(gen.cancels, ['j_q']);
  assert.equal(jobs.j_q.status, 'cancelled');
  // Its own run sees the cancel (pipeline.ts finishBuild) and ends superseded; then the newer run builds.
  supersede(old, 'queued', neu, null);
  assert.equal(runRow(old).status, 'skipped');
  assert.equal((db.prepare('SELECT status FROM steps WHERE id = ?').get(b) as any).status, 'skipped');
  assert.deepEqual(await p, { go: true });
});

test('a queued job is left alone when the build server is free or the cancel raced its start', async () => {
  const free = fakeGen({ j_free: { status: 'queued', tool: 'unity.build' } });
  assert.equal(await cancelIfQueued('j_free', free), false);
  assert.deepEqual(free.cancels, [], 'the build server is free: it may start any moment');
  const raced = fakeGen({ j_busy: { status: 'running', tool: 'unity.build' }, j_race: { status: 'queued', tool: 'unity.build', raced: true } });
  assert.equal(await cancelIfQueued('j_race', raced), false, 'a job that started is reported as not cancelled');
  const running = fakeGen({ j_r: { status: 'running', tool: 'unity.build', started: 1 } });
  assert.equal(await cancelIfQueued('j_r', running), false);
  assert.deepEqual(running.cancels, []);
});

test('go-live builds are never waited on or cancelled; daily builds are waited on, never cancelled', async () => {
  const jobs: Record<string, any> = { j_live: { status: 'queued', tool: 'unity.build' }, j_daily: { status: 'queued', tool: 'unity.build' }, j_x: { status: 'running', tool: 'unity.build' } };
  const gen = fakeGen(jobs);
  const live = run('golive', 'live');
  step(live, 'golive', 'build', 'unity', 'running', 'j_live');
  const neu = run('golive');
  assert.deepEqual(await betaTurn(neu, 'golive', { quiet: 0, gen }), { go: true }, 'a go-live build is no beta build');
  assert.equal(runRow(live).status, 'running');

  const daily = run('day', 'daily');
  const d = step(daily, 'day', 'build', 'unity', 'running', 'j_daily');
  const after = run('day');
  assert.deepEqual(olderBuilds(after, 'day').map((o) => o.run), [daily]);
  const p = betaTurn(after, 'day', { quiet: 0, gen });
  await sleep(50);
  setStep(d, 'done');
  assert.deepEqual(await p, { go: true });
  assert.deepEqual(gen.cancels, [], 'neither the go-live nor the daily build was cancelled');
  assert.equal(jobs.j_live.status, 'queued');
});

test('a superseded run is reported as skipped and fine, not failed', () => {
  const old = run('told', 'beta', { focus: 'Just merged into beta: a fix.', criteria: ['The door opens'], playtest: true });
  const neu = run('told');
  supersede(old, 'told', neu, 'fedcba9876');
  const r = runRow(old);
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail, `skipped: superseded by ${neu} (beta fedcba9)`);
  const notice = runNotice(r);
  assert.match(notice, new RegExp(`superseded by ${neu}`));
  assert.match(notice, /Nothing failed/);
  assert.doesNotMatch(notice.replace('Nothing failed', ''), /fail/i);
  assert.deepEqual(absorbed(neu).map((o) => o.criteria), [['The door opens']], 'its criteria carry over');
  assert.equal(waitingBetaRun('told'), neu);
});

// After an agent change's merge (agents.ts approve: startBeta's merge), the quiet time is only worth it when another
// change of the product is on its way into beta (J, 2026-11-01: 2 min after every merge, for nothing).
test('after a merge, a Unity beta run builds at once when no other change of the product is on its way in', async () => {
  // No changes table here (agents.ts not loaded): unknown counts as something in flight, and the wait is kept.
  assert.deepEqual(mergesInFlight('lone', 0), ['(unknown)']);
  db.exec('CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, product TEXT NOT NULL, findings TEXT NOT NULL DEFAULT \'[]\', status TEXT NOT NULL, auto_merge TEXT, merged_at INTEGER, created INTEGER NOT NULL)');
  const change = (product: string, status: string, o: { auto_merge?: string | null; merged_at?: number | null } = {}) => {
    const id = newId('c');
    db.prepare('INSERT INTO changes (id, product, status, auto_merge, merged_at, created) VALUES (?, ?, ?, ?, ?, ?)').run(id, product, status, o.auto_merge ?? null, o.merged_at ?? null, Date.now());
    return id;
  };
  // Its own change merged just before the run started; others are elsewhere, waiting for a person, or another product's.
  change('lone', 'merged', { auto_merge: 'merged', merged_at: Date.now() - 1000 });
  change('lone', 'ready', { auto_merge: 'failed: a canon conflict' });
  change('lone', 'working');
  change('other', 'ready', { auto_merge: 'trying' });
  const id = run('lone');
  const t0 = Date.now();
  assert.deepEqual(await betaTurn(id, 'lone', { quiet: 60_000, gen: fakeGen({}), afterMerge: true }), { go: true });
  assert.ok(Date.now() - t0 < 5_000, 'no quiet time');
  // Not after a merge (a push from J's PC, the fast lane): the quiet time as before.
  const pushed = run('lone');
  const t1 = Date.now();
  assert.deepEqual(await betaTurn(pushed, 'lone', { quiet: 300, gen: fakeGen({}) }), { go: true });
  assert.ok(Date.now() - t1 >= 290, 'waited the quiet time');
});

test('after a merge, another change of the product ready to merge (or merged since) keeps the wait, and its run takes over', async () => {
  db.exec('CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, product TEXT NOT NULL, findings TEXT NOT NULL DEFAULT \'[]\', status TEXT NOT NULL, auto_merge TEXT, merged_at INTEGER, created INTEGER NOT NULL)');
  const other = newId('c');
  db.prepare('INSERT INTO changes (id, product, status, auto_merge, created) VALUES (?, ?, ?, ?, ?)').run(other, 'pair', 'ready', 'trying', Date.now());
  const first = run('pair');
  const said: string[] = [];
  let went = false;
  const p = betaTurn(first, 'pair', { quiet: 60_000, gen: fakeGen({}), afterMerge: true, onWait: (d) => said.push(d) }).then((t) => { went = true; return t; });
  await sleep(80);
  assert.equal(went, false, 'waits while the other change merges');
  assert.match(said[0], new RegExp(`waiting \\d+ s for more pushes .*: ${other} is on its way into beta too`));
  // It merged (approve: merged_at, then status), and its beta run hasn't started yet: still waiting.
  db.prepare(`UPDATE changes SET status = 'merged', auto_merge = 'merged', merged_at = ? WHERE id = ?`).run(Date.now(), other);
  assert.deepEqual(mergesInFlight('pair', runRow(first).started), [other], 'merged after this run started');
  await sleep(50);
  assert.equal(went, false);
  // Its beta run starts: the waiting one steps aside, and the newer one (nothing else coming) builds at once.
  const second = run('pair');
  assert.deepEqual(await p, { superseded: second });
  assert.deepEqual(mergesInFlight('pair', runRow(second).started), []);
  assert.deepEqual(await betaTurn(second, 'pair', { quiet: 60_000, gen: fakeGen({}), afterMerge: true }), { go: true });
});
