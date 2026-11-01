// Talk answers pushed, not polled (J, 2026-11-01: "Please stop implementing polling if at all possible"). A detached
// turn's output is read the moment its files change (fs.watch) and a Cloud Run job's the moment its runner nudges Studio
// (POST /api/cloudjobs/<unit>/nudge), not on a 250 ms or 2 s timer; studio_talk's read is held until the turn's idle
// event; and a result's own turn starts within seconds, not a minute later. The timers that stay are safety nets: these
// tests set them to a minute, so only a push can make them pass in time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talk-push-'));
process.env.STUDIO_DATA = scratch;
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talk-push-projects-'));
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.TALK_CLAUDE = process.execPath;
process.env.TALK_CLAUDE_ARGS = JSON.stringify([path.join(import.meta.dirname, 'fixture', 'fake-claude.mjs')]);
// The safety nets: a minute, longer than any of these tests waits.
process.env.STUDIO_DETACH_POLL_MS = '60000';
process.env.STUDIO_JOB_POLL_MS = '60000';
for (const k of ['HAWKES_BRAIN', 'TALK_MODEL', 'STUDIO_SERVER', 'TALK_FOLLOWUP_BATCH_MS', 'STUDIO_JOB_SAFETY_MS']) delete process.env[k];

const T = await import('../src/talk.ts');
const { saveBrain } = await import('../src/brains.ts');
const CJ = await import('../src/cloudjob.ts');
const { runUnit, httpNudge } = await import('../src/cloudjob-run.ts');
saveBrain({ harness: 'claude', model: '' }, 'test');

const until = async (f: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const idle = (id: string) => T.getConversation(id)!.status === 'idle';

test('a detached turn streams and ends on pushed file changes, not the safety look', { timeout: 30_000 }, async () => {
  process.env.STUDIO_DETACH = 'process';
  const c = T.startConversation('Detached');
  const t0 = Date.now();
  T.say(c.id, 'How did the trial go?');
  await until(() => idle(c.id), 10_000);
  assert.ok(Date.now() - t0 < 10_000, 'well before the minute-long safety look');
  assert.equal(T.getConversation(c.id)!.messages.at(-1)!.text, 'Sure. The trial found two bugs.');
});

test('a Cloud Run turn: the runner uploads as it writes and nudges Studio, which reads at once', { timeout: 30_000 }, async () => {
  process.env.STUDIO_DETACH = 'cloudrun';
  const bucket = new Map<string, Buffer>();
  const store = {
    put: async (k: string, d: Buffer | string) => void bucket.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)),
    get: async (k: string) => bucket.get(k) ?? null,
    list: async (p: string) => [...bucket.keys()].filter((k) => k.startsWith(p)),
    remove: async (k: string) => void bucket.delete(k),
  };
  const done = new Set<string>();
  const specs: any[] = [];
  let nudges = 0;
  CJ.setJobRunner(() => ({
    ...store,
    start: async (unit: string) => {
      specs.push(JSON.parse(bucket.get(`jobs/${unit}/spec.json`)!.toString('utf8')));
      // The job, with the job side's own timer at a minute too: only output-driven uploads and nudges are left.
      void runUnit(unit, store, { every: 60_000, nudge: () => async () => { nudges++; CJ.kickCloudJob(unit); } }).then(() => done.add(unit));
      return `executions/${unit}`;
    },
    state: async (e: string) => ({ done: done.has(e.slice('executions/'.length)), message: '' }),
    cancel: async () => {},
  }));
  try {
    const c = T.startConversation('Cloud');
    const seen: string[] = [];
    T.talkEvents.on(c.id, (e: any) => { if (e.type === 'delta') seen.push(e.text); });
    const t0 = Date.now();
    T.say(c.id, 'How did the trial go?');
    await until(() => idle(c.id), 10_000);
    assert.ok(Date.now() - t0 < 10_000, 'well before the minute-long timers');
    assert.equal(specs[0].flushMs, 250, "Talk's job uploads its output as it comes");
    assert.ok(nudges >= 2, 'nudged for the output and for the exit');
    assert.equal(seen.join(''), 'Sure. The trial found two bugs.', 'every line arrived, in order');
    assert.equal(T.getConversation(c.id)!.messages.at(-1)!.text, 'Sure. The trial found two bugs.');
    assert.equal(CJ.kickCloudJob('hawkes-nobody-1'), false, 'a nudge for a job Studio does not follow does nothing');
  } finally {
    CJ.setJobRunner(null);
    process.env.STUDIO_DETACH = 'process';
  }
});

test("the runner's nudge: Studio's address and the agents' key from the pass's environment, nothing else", async () => {
  assert.equal(httpNudge('u1')({}), null, 'no address or key: no nudge');
  assert.equal(httpNudge('u1')({ STUDIO_URL: 'http://127.0.0.1:1' }), null, 'no key: no nudge');
  const got: { url?: string; method?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as any).port;
    await httpNudge('hawkes-talk-t_1-abc')({ STUDIO_URL: `http://127.0.0.1:${port}/`, STUDIO_AGENT_KEY: 'agents-key' })!();
    assert.deepEqual(got, [{ url: '/api/cloudjobs/hawkes-talk-t_1-abc/nudge', method: 'POST', auth: 'Bearer agents-key', body: '' }]);
    // Studio down: the nudge just doesn't land (the safety look finds the output).
    await httpNudge('u1')({ STUDIO_URL: 'http://127.0.0.1:1', STUDIO_AGENT_KEY: 'k' })!();
  } finally {
    server.close();
  }
});

test('untilIdle: true at the turn\'s end, false when the wait runs out or the caller goes', { timeout: 30_000 }, async () => {
  process.env.STUDIO_DETACH = 'off';
  const c = T.startConversation('Waiting');
  assert.equal(await T.untilIdle(c.id, 1000), true, 'not answering: at once');
  process.env.FAKE_CLAUDE_SLOW_MS = '300';
  T.say(c.id, 'a slow answer please');
  assert.equal(await T.untilIdle(c.id, 50), false, 'still answering when the wait ran out');
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  assert.equal(await T.untilIdle(c.id, 10_000, abort.signal), false, 'the caller went away');
  const t0 = Date.now();
  assert.equal(await T.untilIdle(c.id, 20_000), true);
  assert.ok(Date.now() - t0 < 10_000, 'answered when the turn ended, not when the wait ran out');
  assert.equal(T.getConversation(c.id)!.status, 'idle');
  delete process.env.FAKE_CLAUDE_SLOW_MS;
});

test("a result's own turn starts within seconds, and results together share it", { timeout: 30_000 }, async () => {
  process.env.STUDIO_DETACH = 'off';
  const c = T.startConversation('Results');
  const turns: number[] = [];
  const t0 = Date.now();
  T.talkEvents.on(c.id, (e: any) => { if (e.type === 'turn' && e.auto) turns.push(Date.now() - t0); });
  T.studioSays(c.id, 'Agent change c1 is ready.');
  T.studioSays(c.id, 'Beta run r1 finished.');
  await until(() => turns.length > 0 && idle(c.id), 15_000);
  assert.ok(turns[0] < 10_000, `started after ${turns[0]} ms, not a minute`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(turns.length, 1, 'both results in one turn');
});
