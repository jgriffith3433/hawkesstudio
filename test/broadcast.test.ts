import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLine, buildLabel, composeBroadcast, type ReelSource } from '../src/broadcast.ts';

test('on-screen text drops paths and keys', () => {
  const line = safeLine('hopping to the castle C:\\keys\\secret.pem and sk-abc123456789 plus /home/ubuntu/.ssh/id_ed25519 token=hg_live_secret');
  assert.match(line, /hopping to the castle/);
  assert.doesNotMatch(line, /secret\.pem|sk-|\/home\/|hg_live|token=/);
});

test('a build label keeps the host and drops the query', () => {
  assert.equal(buildLabel('https://beta.example.com/v112/3f2a1c9/play?key=sekret'), 'beta.example.com · build v112 · 3f2a1c9');
  assert.equal(buildLabel(''), 'beta');
});

test('a live take beats a replay, and a lock stays on that product', () => {
  const playing = [{ job: 'j_aaa', ctx: { product: 'yoobaland', productName: 'Yooba Land', name: 'Castle' }, step: 'hop', url: 'https://yooba.example/v3/', players: [{ state: { note: 'at the waystone' } }] }];
  const finished = [{ job: 'j_bbb', ctx: { product: 'dod', productName: 'DoD' }, outcome: 'won', url: 'https://dod.example/' }];
  const open = composeBroadcast({ playing, finished, now: 1_000 });
  assert.equal(open.focus?.product, 'yoobaland');
  assert.equal(open.focus?.stream, '/api/gen/v1/jobs/j_aaa/live.mjpeg?player=0&fps=8');
  assert.match(open.host, /Yooba here/);
  assert.match(open.host, /waystone/);
  const locked = composeBroadcast({ playing, finished, product: 'dod', now: 1_000 });
  assert.equal(locked.focus?.product, 'dod');
  assert.equal(locked.focus?.phase, 'finished');
});

test('the frame never includes a log, a diff or a query string', () => {
  const frame = composeBroadcast({
    playing: [{
      job: 'j_ccc', ctx: { product: 'yoobaland', productName: 'Yooba Land' },
      url: 'https://yooba.example/play?api_key=sekret',
      step: 'see /srv/hawkes/gen.env',
      log: 'AWS_SECRET=should-not-leak',
      players: [{ state: { note: 'fine' } }],
    }],
    changes: [{ id: 'c_1', product: 'yoobaland', title: 'fix the fence', status: 'merged', updated: 1_000, detail: 'diff --git /home/ubuntu/x', log: ['secret'] }],
    now: 5_000,
  });
  const blob = JSON.stringify(frame);
  assert.doesNotMatch(blob, /sekret|AWS_SECRET|diff --git|gen\.env|should-not-leak/);
  assert.equal(frame.ticker[0].kind, 'merged');
  assert.equal(frame.flash?.kind, 'MERGED');
});

const library = [
  { asset: 'a_1111111111111111', tool: 'mesh.rig', title: 'turntable', kind: 'video', created: 100, project: 'yoobaland', projectName: 'Yooba Land', entity: 'yoobaland/yooba', entityName: 'Yooba', slot: 'preview/turntable', status: 'take', prompt: 'SECRETPROMPT do not show', path: '/srv/hawkes/library/turn.mp4' },
  { asset: 'a_aaaaaaaaaaaaaaaa', tool: 'mesh.rig', title: 'walk', kind: 'video', created: 500, project: 'yoobaland', projectName: 'Yooba Land', entity: 'yoobaland/yooba', entityName: 'Yooba', slot: 'preview/turntable', status: 'current' },
  { asset: 'a_2222222222222222', tool: 'mesh.rig', title: 'turntable', kind: 'video', created: 900, project: 'yoobaland', projectName: 'Yooba Land', entity: 'yoobaland/fixture', entityName: 'Fixture', slot: 'test/turntable', status: 'current', prompt: 'test slot prompt' },
  { asset: 'a_3333333333333333', tool: 'video.animate', title: 'walk_takes.mp4', kind: 'video', created: 400, project: 'phorigins', projectName: 'PH Origins', entity: 'phorigins/pierce', entityName: 'Pierce', slot: 'anims/_takes/walk', status: 'current' },
  { asset: 'a_4444444444444444', tool: 'playtest.run', title: 'Playtest video', kind: 'video', created: 950, project: 'yoobaland', projectName: 'Yooba Land', entityName: 'Yooba', status: 'current', prompt: 'playtest prompt' },
  { asset: 'a_5555555555555555', tool: 'video.i2v', title: 'clip (33 frames)', kind: 'video', created: 150, project: 'doseofdestruction', projectName: 'Dose Of Destruction', entity: 'doseofdestruction/break', entityName: 'Break', slot: 'clip/jab', status: 'current', prompt: 'ZQXPROMPT a punch' },
  { asset: 'a_6666666666666666', tool: 'video.i2v', title: 'clip (33 frames)', kind: 'video', created: 800, project: 'doseofdestruction', projectName: 'Dose Of Destruction', entity: 'doseofdestruction/break', entityName: 'Break', slot: 'clip/jab', status: 'take', prompt: 'rejected take' },
  { asset: 'a_7777777777777777', tool: 'mesh.rig', title: 'preview/Wave', kind: 'video', created: 120, project: 'phorigins', projectName: 'PH Origins', entity: 'phorigins/susan', entityName: 'Susan /home/ubuntu/secret sk-abc123456789', slot: 'preview/wave', status: 'current', path: 'C:\\keys\\secret.pem' },
  { asset: 'a_8888888888888888', tool: 'video.i2v', title: 'jab again', kind: 'video', created: 300, project: 'doseofdestruction', projectName: 'Dose Of Destruction', entity: 'doseofdestruction/break', entityName: 'Break', slot: 'anim/jab', status: 'current' },
  { asset: 'a_9999999999999999', tool: 'mesh.rig', title: 'turntable', kind: 'image', created: 990, project: 'yoobaland', projectName: 'Yooba Land', entityName: 'Still', slot: 'preview/turntable', status: 'current' },
];

test('a waiting take beats the reel', () => {
  const frame = composeBroadcast({
    waiting: [{ ctx: { product: 'yoobaland', productName: 'Yooba Land', name: 'Castle' } }],
    library,
    now: 1_000,
  });
  assert.equal(frame.focus?.phase, 'waiting');
  assert.match(frame.host, /waiting for a browser/);
  assert.doesNotMatch(frame.host, /On screen/);
});

test('a live take beats the reel', () => {
  const playing = [{ job: 'j_aaa', ctx: { product: 'yoobaland', productName: 'Yooba Land', name: 'Castle' }, step: 'hop', url: 'https://yooba.example/v3/', players: [{ state: { note: 'at the waystone' } }] }];
  const frame = composeBroadcast({ playing, library, now: 1_000 });
  assert.equal(frame.focus?.phase, 'playing');
  assert.equal(frame.focus?.product, 'yoobaland');
  assert.match(frame.host, /on camera/);
  assert.doesNotMatch(frame.host, /On screen/);
  assert.ok(frame.reel.length > 0);
  assert.equal(frame.reel[0].what, 'turntable');
});

test('the reel is newest turntables, then one current clip, and stays safe', () => {
  const frame = composeBroadcast({ library, now: 1_000 });
  assert.equal(frame.focus, null);
  assert.match(frame.host, /between takes/);
  assert.match(frame.host, /On screen/);
  assert.match(frame.host, /turntable/);
  const ids = frame.reel.map((r) => r.asset);
  assert.deepEqual(ids, ['a_aaaaaaaaaaaaaaaa', 'a_8888888888888888', 'a_7777777777777777']);
  assert.deepEqual(frame.reel.map((r) => r.what), ['turntable', 'jab', 'wave']);
  assert.equal(frame.reel[0].src, '/api/gen/v1/files/a_aaaaaaaaaaaaaaaa');
  assert.equal(frame.reel[0].label, 'Yooba Land · Yooba · turntable');
  assert.equal(frame.reel[1].label, 'Dose Of Destruction · Break · jab');
  assert.equal(frame.reel[2].name, 'Susan');
  assert.equal(frame.reel[2].label, 'PH Origins · Susan · wave');
  const blob = JSON.stringify(frame.reel);
  assert.doesNotMatch(blob, /SECRETPROMPT|ZQXPROMPT|rejected take|test slot|secret\.pem|sk-|\/srv\/|\/home\/|_takes|playtest|a_1111111111111111|a_2222222222222222|a_3333333333333333|a_4444444444444444|a_5555555555555555|a_6666666666666666|a_9999999999999999/);
  assert.equal(frame.reel.length <= 12, true);
});

test('the reel stops at about 12, turntables before clips', () => {
  const many: ReelSource[] = [];
  for (let i = 0; i < 14; i++) {
    const n = i.toString(16).padStart(16, '0');
    many.push({ asset: `a_${n}`, tool: 'mesh.rig', title: 'turntable', kind: 'video', created: 1000 + i, project: 'yoobaland', projectName: 'Yooba Land', entity: `yoobaland/m${i}`, entityName: `Model ${i}`, slot: 'preview/turntable', status: 'take' });
  }
  many.push({ asset: 'a_ffffffffffffffff', tool: 'video.i2v', title: 'clip', kind: 'video', created: 5000, project: 'yoobaland', projectName: 'Yooba Land', entity: 'yoobaland/yooba', entityName: 'Yooba', slot: 'clip/wave', status: 'current' });
  const frame = composeBroadcast({ library: many, now: 1 });
  assert.equal(frame.reel.length, 12);
  assert.ok(frame.reel.every((r) => r.what === 'turntable'));
  assert.equal(frame.reel[0].name, 'Model 13');
});

test('an empty library keeps the quiet line', () => {
  const frame = composeBroadcast({ library: [], now: 1 });
  assert.deepEqual(frame.reel, []);
  assert.match(frame.host, /between takes/);
  assert.doesNotMatch(frame.host, /On screen/);
});

test('roadmap bars come from the open milestone', () => {
  const frame = composeBroadcast({
    milestones: [{ product: 'yoobaland', title: 'Castle stands', done: 1, total: 3, items: [
      { title: 'Waystone', state: 'on beta', display: 'on beta' },
      { title: 'Carrot field', state: 'working', display: 'working (1 of 4 merged)' },
    ] }],
    now: 1,
  });
  assert.equal(frame.milestone?.title, 'Castle stands');
  assert.equal(frame.bars[0].pct, 1);
  assert.ok(frame.bars[1].pct > 0 && frame.bars[1].pct < 1);
  assert.match(frame.host, /between takes/);
});
