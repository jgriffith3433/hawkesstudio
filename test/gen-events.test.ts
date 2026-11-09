// Studio hears of Gen job changes by push, not by polling (J, 2026-11-01: "Please stop implementing polling if at all
// possible it causes all the problems"). genevents.ts keeps one GET /v1/events stream; a wait on a job (runGenJob's
// watchGenJob, gen.ts genWait, hawkesgen.mjs wait) wakes on that job's event, asks Gen again after a reconnect, keeps its
// limits on one timer set to the next deadline, and falls back to asking on its timer when the stream is down or Gen
// has no /v1/events. A stand-in Gen over HTTP; nothing real is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen-events-'));

const { GenEvents, nextLook } = await import('../src/genevents.ts');
const { runGenJob } = await import('../src/playtests.ts');
const { genWait } = await import('../src/gen.ts');
// @ts-ignore: plain JS client
const { HawkesGen } = await import('../src/hawkesgen.mjs');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 5000, what = 'it') {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A stand-in Gen: jobs (set by the test), GET counts, an SSE stream that can be pushed to, dropped, or missing (404). */
async function fakeGen({ events = true }: { events?: boolean } = {}) {
  const jobs: Record<string, any> = {};
  const gets: Record<string, number> = {};
  const cancels: string[] = [];
  const clients = new Set<http.ServerResponse>();
  let connects = 0;
  const auth: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/v1/events') {
      auth.push(String(req.headers.authorization ?? ''));
      if (!events) return json(404, { error: 'Not found' });
      connects++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    let m = /^\/v1\/jobs\/([\w-]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      gets[m[1]] = (gets[m[1]] ?? 0) + 1;
      return jobs[m[1]] ? json(200, { ...jobs[m[1]], log: ['line 1', 'line 2'] }) : json(404, { error: 'no such job' });
    }
    m = /^\/v1\/jobs\/([\w-]+)\/cancel$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      cancels.push(m[1]);
      if (jobs[m[1]]) jobs[m[1]].status = 'cancelled';
      return json(200, jobs[m[1]] ?? {});
    }
    json(404, { error: `no ${url.pathname}` });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return {
    url, jobs, gets, cancels, auth, clients,
    get connects() { return connects; },
    /** Sets a job's state and pushes it as Gen does (event: job, the job without its log). */
    push(job: any) {
      jobs[job.id] = { ...jobs[job.id], ...job };
      for (const c of clients) c.write(`event: job\ndata: ${JSON.stringify({ ...jobs[job.id], log: undefined, logLines: 2 })}\n\n`);
    },
    /** The connection drops (a deploy, a network blip). */
    drop() { for (const c of clients) c.socket?.destroy(); clients.clear(); },
    close() { for (const c of clients) c.socket?.destroy(); server.closeAllConnections?.(); server.close(); },
  };
}
const cleanups: (() => unknown)[] = [];
after(async () => { for (const c of cleanups) await c(); });

async function setup(opts: { events?: boolean; hold?: boolean } = {}) {
  const g = await fakeGen(opts);
  const client = new HawkesGen({ url: g.url, key: 'hg_test_key' });
  const hub = new GenEvents(client, { backoffMs: [50], stallMs: 3000, unsupportedRetryMs: 60_000, lingerMs: 150 });
  hub.start();
  // Open from the start (as a parked change holds it), so each test begins with the stream live.
  if (opts.hold !== false) hub.hold('test');
  cleanups.push(() => hub.stop(), () => g.close());
  // runGenJob's api: submit is ours, job and cancel go to the stand-in over HTTP.
  let n = 0;
  const api = {
    submit: async () => { const id = `j_${++n}`; g.jobs[id] = { id, status: 'queued', detail: 'queued' }; return { id, status: 'queued' }; },
    job: (id: string) => client.job(id),
    cancel: (id: string) => client.cancel(id),
  };
  return { g, client, hub, api };
}

test('a job event wakes the wait at once: the playtest ends the moment Gen says so, not at the next poll', async () => {
  const { g, hub, api } = await setup();
  await until(() => hub.live(), 3000, 'the stream to open');
  assert.equal(g.auth[0], 'Bearer hg_test_key', 'the same key as every other call to Gen');
  const details: string[] = [];
  const t0 = Date.now();
  // pollMs a minute: only an event can end this wait within the test.
  const run = runGenJob('playtest.run', 'p', { url: 'u' }, (j) => details.push(`${j.status}:${j.detail}`), { api, events: hub, pollMs: 60_000, runMs: 600_000 });
  await until(() => g.gets.j_1 === 1, 3000, 'the first look');
  g.push({ id: 'j_1', status: 'running', detail: 'playing level 1', started: Date.now() });
  await until(() => details.includes('running:playing level 1'), 2000, 'the running event');
  g.push({ id: 'j_1', status: 'done', detail: 'done', result: { outcome: 'pass' } });
  const j = await run;
  assert.equal(j.status, 'done');
  assert.ok(Date.now() - t0 < 3000, `ended in ${Date.now() - t0} ms`);
  assert.deepEqual(j.log, ['line 1', 'line 2'], 'the whole job (its log) once it ends: one GET');
  assert.equal(g.gets.j_1, 2, 'asked Gen only at the start and for the whole finished job');
});

test('the stream drops and comes back: the jobs waited on are asked for once, so a change missed meanwhile is caught', async () => {
  const { g, hub } = await setup();
  await until(() => hub.live(), 3000, 'the stream to open');
  g.jobs.j_x = { id: 'j_x', status: 'running', detail: 'working' };
  const f = hub.follow('j_x');
  cleanups.push(() => f.close());
  const before = hub.stats.refetches;
  // It finishes while nobody hears: no event, the connection gone.
  g.jobs.j_x.status = 'done';
  g.drop();
  let got: any = null;
  const t0 = Date.now();
  while (!got && Date.now() - t0 < 3000) got = await f.next(3000);
  assert.equal(got?.status, 'done', 'the reconnect asked Gen for it');
  assert.equal(g.connects, 2);
  assert.equal(hub.stats.refetches - before, 1, 'one GET per job waited on');
  assert.equal(g.gets.j_x, 1);
  assert.ok(hub.live());
});

test('a wait across a drop: the stream going down makes it ask Gen at once, and it ends with the job', async () => {
  const { g, hub, api } = await setup();
  await until(() => hub.live(), 3000, 'the stream to open');
  const t0 = Date.now();
  const run = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, { api, events: hub, pollMs: 60_000, runMs: 600_000 });
  await until(() => g.gets.j_1 === 1, 3000, 'the first look');
  g.jobs.j_1 = { ...g.jobs.j_1, status: 'done', detail: 'done' };
  g.drop();
  const j = await run;
  assert.equal(j.status, 'done');
  assert.ok(Date.now() - t0 < 3000, `ended in ${Date.now() - t0} ms`);
});

test('an old Gen without /v1/events: no stream, and every wait asks on its timer as before', async () => {
  const { g, hub, api } = await setup({ events: false });
  await until(() => hub.stats.unsupported, 3000, 'the 404');
  assert.equal(hub.live(), false);
  const run = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, { api, events: hub, pollMs: 20, runMs: 600_000 });
  await until(() => (g.gets.j_1 ?? 0) >= 3, 3000, 'it to poll');
  g.jobs.j_1.status = 'done';
  assert.equal((await run).status, 'done');
  // gen.ts genWait and hawkesgen.mjs wait the same way.
  g.jobs.g_1 = { id: 'g_1', status: 'running' };
  const w = genWait('g_1', undefined, 60_000, undefined, { api, events: hub, pollMs: 20 });
  await until(() => (g.gets.g_1 ?? 0) >= 3, 3000, 'genWait to poll');
  g.jobs.g_1.status = 'done';
  assert.equal((await w).status, 'done');
});

test('limits on one timer: with the stream open and no event, a playtest standing still is cancelled at its idle deadline', async () => {
  const { g, hub, api } = await setup();
  await until(() => hub.live(), 3000, 'the stream to open');
  const t0 = Date.now();
  const run = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, { api, events: hub, pollMs: 60_000, runMs: 600_000, idleMs: 400 });
  await until(() => g.gets.j_1 === 1, 3000, 'the first look');
  g.push({ id: 'j_1', status: 'running', detail: 'on the ledge', started: Date.now() });
  const j = await run;
  const took = Date.now() - t0;
  assert.equal(j.status, 'failed');
  assert.match(j.error, /^stuck: no progress for \d+ min/);
  assert.deepEqual(j.stuckLog, ['line 1', 'line 2'], 'Gen asked once before cancelling: its log is in the finding');
  assert.ok(took >= 400 && took < 2500, `cancelled after ${took} ms`);
  assert.deepEqual(g.cancels, ['j_1']);
  assert.equal(g.gets.j_1, 2, 'no poll between: the first look and the one before cancelling');
});

test('a cancelled run halts its wait at the old pace, from Studio’s own records, without asking Gen', async () => {
  const { g, hub, api } = await setup();
  await until(() => hub.live(), 3000, 'the stream to open');
  let halted: string | null = null;
  const run = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, { api, events: hub, pollMs: 50, runMs: 600_000, halt: () => halted });
  await until(() => g.gets.j_1 === 1, 3000, 'the first look');
  await sleep(300);
  assert.equal(g.gets.j_1, 1, 'the stream is open: the 50 ms checks are local, not GETs');
  halted = 'run cancelled by J';
  const j = await run;
  assert.equal(j.halted, true);
  assert.deepEqual(g.cancels, ['j_1']);
});

test('gen.ts genWait and hawkesgen.mjs wait wake on the event too', async () => {
  const { g, hub, client, api } = await setup();
  await until(() => hub.live(), 3000, 'the stream to open');
  g.jobs.w_1 = { id: 'w_1', status: 'running' };
  const t0 = Date.now();
  const a = genWait('w_1', undefined, 600_000, undefined, { api, events: hub, pollMs: 60_000 });
  await until(() => g.gets.w_1 === 1, 3000, 'the first look');
  g.push({ id: 'w_1', status: 'done', outputs: [{ asset: 'a_1' }] });
  assert.equal((await a).status, 'done');

  client.follow = (id: string) => hub.follow(id);
  g.jobs.w_2 = { id: 'w_2', status: 'running', tool: 'image.edit' };
  const b = client.wait('w_2', { pollMs: 60_000 });
  await until(() => g.gets.w_2 === 1, 3000, 'the first look');
  g.push({ id: 'w_2', status: 'done', outputs: [{ asset: 'a_2' }] });
  const j = await b;
  assert.equal(j.status, 'done');
  assert.equal(j.outputs[0].asset, 'a_2');
  assert.ok(Date.now() - t0 < 3000, `both in ${Date.now() - t0} ms`);
  assert.equal(g.gets.w_2, 2);

  // A failed job still throws, and the timeout still holds (one timer, not a poll).
  g.jobs.w_3 = { id: 'w_3', status: 'running', tool: 'image.edit' };
  const c = client.wait('w_3', { pollMs: 60_000 });
  await until(() => g.gets.w_3 === 1, 3000, 'the first look');
  g.push({ id: 'w_3', status: 'failed', error: 'out of memory' });
  await assert.rejects(c, /image\.edit failed: out of memory/);
  g.jobs.w_4 = { id: 'w_4', status: 'running', tool: 'image.edit' };
  await assert.rejects(client.wait('w_4', { pollMs: 60_000, timeoutMs: 300 }), /Timed out waiting for job w_4/);
});

test('the stream is open only while something waits on Gen, and closes a moment after the last wait ends', async () => {
  const { g, hub, api } = await setup({ hold: false });
  await sleep(200);
  assert.equal(g.connects, 0, 'nothing waits: no stream (Gen on Cloud Run may sleep)');
  const run = runGenJob('playtest.run', 'p', { url: 'u' }, () => {}, { api, events: hub, pollMs: 60_000, runMs: 600_000 });
  await until(() => hub.live(), 3000, 'the wait to open it');
  assert.equal(g.connects, 1);
  // It opened after the wait's first look: the open asked for the job once more, so nothing between was missed.
  await until(() => g.gets.j_1 === 2, 3000, 'the look on connect');
  g.push({ id: 'j_1', status: 'done' });
  assert.equal((await run).status, 'done');
  assert.equal(hub.live(), true, 'it lingers');
  await until(() => !hub.live() && g.clients.size === 0, 3000, 'it to close');
  assert.equal(g.connects, 1);
});

test('nextLook: the next deadline (or the 5-minute safety check) while live, pollMs while down; local checks keep their pace', () => {
  const now = 1_000_000;
  assert.deepEqual(nextLook(false, { now, pollMs: 2000, heard: now, deadlines: [now + 60_000] }), { due: now + 2000, ms: 2000 });
  assert.deepEqual(nextLook(true, { now, pollMs: 2000, heard: now, deadlines: [now + 60_000] }), { due: now + 60_000, ms: 60_000 });
  assert.deepEqual(nextLook(true, { now, pollMs: 2000, heard: now, deadlines: [now + 3600_000] }), { due: now + 300_000, ms: 300_000 });
  assert.deepEqual(nextLook(true, { now, pollMs: 2000, heard: now, deadlines: [now + 60_000], localMs: 2000 }), { due: now + 60_000, ms: 2000 });
});

test('a wait on a job Gen no longer knows (404) ends at once as lost, not after its timeout', async () => {
  const G = await import('../src/gen.ts');
  const { noEvents } = await import('../src/genevents.ts');
  let asked = 0;
  const api = { job: async () => { asked++; throw Object.assign(new Error('No such job'), { status: 404 }); }, cancel: async () => ({}) };
  const t0 = Date.now();
  const j: any = await G.genWait('j_gone', undefined, 3600_000, undefined, { api, events: noEvents, pollMs: 10 });
  assert.equal(j.status, 'failed');
  assert.equal(j.lost, true);
  assert.match(j.error, /Hawkes Gen lost job j_gone/);
  assert.equal(asked, 1);
  assert.ok(Date.now() - t0 < 1000);
});

test('a wait past its deadline says it timed out, with where Gen last was', async () => {
  const G = await import('../src/gen.ts');
  const { noEvents } = await import('../src/genevents.ts');
  const api = { job: async () => ({ id: 'j_slow', status: 'running', detail: 'Unity: compiling shaders' }), cancel: async () => ({}) };
  const j: any = await G.genWait('j_slow', undefined, 50, undefined, { api, events: noEvents, pollMs: 10 });
  assert.equal(j.timedOut, true);
  assert.equal(j.lastDetail, 'Unity: compiling shaders');
});
