// One playtest for two asks (2026-11-01: a beta run and a Talk walk-away each queued Hawkes Studio's smoke@local, and
// both waited for one of Gen's four browser tabs). runGenJob's share joins the same job (tool, project, params) another
// caller submitted while Gen still has it queued; a job that already started is never joined (it may have opened an
// older page). Gen cancels a shared job only once every caller has let go of it.
// A stand-in for Hawkes Gen; nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playtest-share-'));
process.env.STUDIO_TASK_BAR = 'off'; // these tests start tasks written in a line (the task bar has its own: taskbar.test.ts)

const { runGenJob, shareKey, sharedJobs } = await import('../src/playtests.ts');

/** A stand-in for Gen: jobs that stay queued until start(), then finish after a few polls; every submit and cancel kept. */
function fakeGen() {
  const jobs = new Map<string, { status: string; polls: number }>();
  const submits: any[] = [];
  const cancels: string[] = [];
  let n = 0;
  return {
    submits, cancels, jobs,
    start: (id: string) => { jobs.get(id)!.status = 'running'; },
    submit: async (tool: string, body: any) => {
      const id = `j_${++n}`;
      submits.push({ tool, ...body });
      jobs.set(id, { status: 'queued', polls: 0 });
      return { id, status: 'queued' };
    },
    job: async (id: string) => {
      const j = jobs.get(id)!;
      if (j.status === 'running' && ++j.polls > 3) j.status = 'done';
      return { id, status: j.status, started: j.status === 'queued' ? null : Date.now(), detail: j.status, result: j.status === 'done' ? { outcome: 'pass' } : undefined };
    },
    cancel: async (id: string) => { cancels.push(id); jobs.get(id)!.status = 'cancelled'; return { id, status: 'cancelled' }; },
  };
}
const opts = (g: any, more: Record<string, unknown> = {}) => ({ api: g, pollMs: 5, runMs: 60_000, share: true, ...more });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('the same playtest asked twice while it waits for a browser: one Gen job, both callers get its result', async () => {
  const g = fakeGen();
  const params = { url: 'https://beta.example/', mode: 'contract', scenario: 'smoke' };
  const details: string[] = [];
  const a = runGenJob('playtest.run', 'hawkes-studio', params, () => {}, opts(g));
  await tick();
  const b = runGenJob('playtest.run', 'hawkes-studio', { scenario: 'smoke', mode: 'contract', url: 'https://beta.example/' }, (j) => details.push(j.detail), opts(g));
  await tick();
  assert.equal(g.submits.length, 1, 'joined, not queued again (whatever order the params came in)');
  assert.deepEqual(sharedJobs(g), [{ id: 'j_1', subs: 2 }]);
  g.start('j_1');
  const [ja, jb] = await Promise.all([a, b]);
  assert.equal(ja.status, 'done');
  assert.equal(jb.status, 'done');
  assert.equal(jb.id, 'j_1');
  assert.match(details[0], /one job plays it for both/);
  assert.deepEqual(g.cancels, []);
  assert.deepEqual(sharedJobs(g), [], 'forgotten once both have it');
});

test('a playtest that already started is never joined: the later ask gets its own job', async () => {
  const g = fakeGen();
  const a = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(g));
  await tick();
  g.start('j_1');
  const b = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(g));
  await tick();
  assert.equal(g.submits.length, 2);
  g.start('j_2');
  const [ja, jb] = await Promise.all([a, b]);
  assert.equal(ja.id, 'j_1');
  assert.equal(jb.id, 'j_2');
});

test('another scenario, device or page, or no share asked: separate jobs as before', async () => {
  const g = fakeGen();
  const runs = [
    runGenJob('playtest.run', 'p', { url: 'u', scenario: 'smoke' }, () => {}, opts(g)),
    runGenJob('playtest.run', 'p', { url: 'u', scenario: 'smoke', mobile: true }, () => {}, opts(g)),
    runGenJob('playtest.run', 'p', { url: 'u', scenario: 'full' }, () => {}, opts(g)),
    runGenJob('playtest.run', 'q', { url: 'u', scenario: 'smoke' }, () => {}, opts(g)),
    runGenJob('playtest.run', 'p', { url: 'u', scenario: 'smoke' }, () => {}, opts(g, { share: false })),
  ];
  await tick();
  assert.equal(g.submits.length, 5);
  for (const id of g.jobs.keys()) g.start(id);
  assert.deepEqual((await Promise.all(runs)).map((j) => j.status), ['done', 'done', 'done', 'done', 'done']);
  assert.notEqual(shareKey('t', 'p', { a: 1, b: [1, { c: 2, d: 3 }] }), shareKey('t', 'p', { a: 1, b: [1, { c: 2 }] }));
  assert.equal(shareKey('t', 'p', { b: [1, { d: 3, c: 2 }], a: 1 }), shareKey('t', 'p', { a: 1, b: [1, { c: 2, d: 3 }] }));
});

test('one caller cancelled (its run halted, or a newer beta build): the shared job plays on for the other; cancelled when both let go', async () => {
  const g = fakeGen();
  let haltA: string | null = null;
  const a = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(g, { halt: () => haltA }));
  await tick();
  const b = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(g));
  await tick();
  haltA = 'run cancelled by J';
  const ja = await a;
  assert.equal(ja.status, 'cancelled');
  assert.equal(ja.halted, true);
  assert.deepEqual(g.cancels, [], 'the other caller still waits on it');
  g.start('j_1');
  assert.equal((await b).status, 'done');
  assert.deepEqual(g.cancels, []);

  // Both let go: Gen cancels it once.
  const h = fakeGen();
  let stop: string | null = null;
  const c = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(h, { halt: () => stop }));
  await tick();
  const d = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(h, { abandon: () => stop }));
  await tick();
  stop = 'stop';
  const [jc, jd] = await Promise.all([c, d]);
  assert.equal(jc.status, 'cancelled');
  assert.equal(jd.abandoned, true);
  assert.deepEqual(h.cancels, ['j_1']);
  assert.equal(h.submits.length, 1);
});

test('a caller that joined and then found it started lets go without cancelling what the first caller still plays', async () => {
  const g = fakeGen();
  const a = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(g));
  await tick();
  g.start('j_1');
  const b = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, opts(g));
  await tick();
  g.start('j_2');
  await Promise.all([a, b]);
  assert.deepEqual(g.cancels, []);
  assert.deepEqual(sharedJobs(g), []);
});
