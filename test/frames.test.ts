// A playtest's screenshots as frames for the Activity run card's player (src/frames.ts): Gen's live shots route when it
// answers (images through Studio), the finished job's filed screenshots when it doesn't (404), and nothing while a
// playtest without the live route still runs. Gen is stubbed: no jobs, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-frames-'));
const { db } = await import('../src/db.ts');
const { gen } = await import('../src/gen.ts');
const F = await import('../src/frames.ts');

const step = (id: string, status: string, job: string | null) =>
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, job, started) VALUES (?, 'r_1', 'sickofit', 'playtest', 'smoke@local', ?, ?, 1)`).run(id, status, job);
const notFound = () => Object.assign(new Error('not found'), { status: 404 });

test('Gen\'s live shots become frames with Studio\'s image links and the progress line', () => {
  const f = F.liveFrames('s_1', { running: true, progress: { text: 'Walking to the door' }, shots: [{ i: 0, t: 1.5, reason: 'start', scene: 'Menu' }, { i: 1, t: 4, reason: 'every 3s', peer: 'b' }, { t: 9 }] });
  assert.equal(f.live, true);
  assert.equal(f.running, true);
  assert.equal(f.progress, 'Walking to the door');
  assert.deepEqual(f.frames.map((x) => x.src), ['/api/frames/s_1/0', '/api/frames/s_1/1']);
  assert.equal(f.frames[1].peer, 'b');
  assert.equal(F.liveFrames('s_1', { running: false, progress: 'done', shots: [] }).progress, 'done');
});

test('filed screenshots: the result\'s own list, else the library\'s shot assets in time order', () => {
  assert.deepEqual(F.filedFrames({ shots: [{ t: 1, reason: 'a', asset: 'a_1' }, { t: 2 }] }, []).map((x) => [x.i, x.asset]), [[0, 'a_1']]);
  const items = [{ id: 'a_9', meta: { playtest: 'shot', t: 9, reason: 'late' } }, { id: 'a_d', meta: { playtest: 'diff' } }, { id: 'a_2', meta: { playtest: 'shot', t: 2, reason: 'early' } }];
  assert.deepEqual(F.filedFrames({}, items).map((x) => [x.i, x.asset, x.reason]), [[0, 'a_2', 'early'], [1, 'a_9', 'late']]);
});

test('stepFrames: live route, then the fallback to filed screenshots, and none while it runs without the route', async () => {
  const calls: string[] = [];
  let live = true;
  (gen as any).request = async (p: string) => {
    calls.push(p);
    if (!live) throw notFound();
    return { running: true, progress: 'fighting', shots: [{ i: 3, t: 10 }] };
  };
  (gen as any).job = async () => ({ status: 'done', result: {} });
  (gen as any).assets = async () => ({ items: [{ id: 'a_1', meta: { playtest: 'shot', t: 1 } }] });

  step('s_aa', 'running', 'j_1');
  const a = await F.stepFrames('s_aa', 2);
  assert.equal(a!.live, true);
  assert.equal(calls.at(-1), '/jobs/j_1/shots?since=2');
  assert.deepEqual(a!.frames.map((x) => x.i), [3]);

  live = false;
  const b = await F.stepFrames('s_aa');
  assert.deepEqual(b, { live: false, running: true, progress: null, frames: [] });

  step('s_bb', 'done', 'j_2');
  const c = await F.stepFrames('s_bb');
  assert.equal(c!.live, false);
  assert.equal(c!.running, false);
  assert.deepEqual(c!.frames.map((x) => x.asset), ['a_1']);
  // Kept: a finished playtest's frames aren't asked of Gen again.
  const n = calls.length;
  assert.deepEqual((await F.stepFrames('s_bb'))!.frames.length, 1);
  assert.equal(calls.length, n);

  step('s_cc', 'running', null);
  assert.deepEqual(await F.stepFrames('s_cc'), { live: false, running: true, progress: null, frames: [] });
  assert.equal(await F.stepFrames('s_nope'), null);

  // Gen down is an error, not an empty player.
  (gen as any).request = async () => { throw Object.assign(new Error("Can't reach Hawkes Gen"), { status: 0 }); };
  await assert.rejects(F.stepFrames('s_aa'), /reach/);
});

test('frameImage proxies Gen\'s JPEG, and a missing frame is null', async () => {
  (gen as any).request = async (p: string, o: any) => {
    assert.equal(o.raw, true);
    if (p.endsWith('/7')) throw notFound();
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
  };
  step('s_dd', 'running', 'j_4');
  const img = await F.frameImage('s_dd', 0);
  assert.equal(img!.type, 'image/jpeg');
  assert.equal(img!.body.length, 3);
  assert.equal(await F.frameImage('s_dd', 7), null);
  assert.equal(await F.frameImage('s_nope', 0), null);
});
