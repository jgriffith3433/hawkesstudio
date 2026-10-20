import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-broadcast-'));
const {
  safeLine, buildLabel, composeBroadcast, selectReel,
  deskFrom, patchDesk, applyDesk, cueLine, voiceCacheKey,
  defaultPriority, normalizePriority, priorityIndex, DESK_DEFAULT,
} = await import('../src/broadcast.ts');

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
  const many: import('../src/broadcast.ts').ReelSource[] = [];
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

const PRODUCTS = ['doseofdestruction', 'phorigins', 'yoobaland', 'sickofit'];

test('default priority puts yoobaland first', () => {
  assert.deepEqual(defaultPriority(PRODUCTS)[0], 'yoobaland');
  assert.equal(defaultPriority(PRODUCTS).length, PRODUCTS.length);
  assert.equal(priorityIndex(['yoobaland', 'dod'], 'yoobaland'), 0);
  assert.equal(priorityIndex(['yoobaland', 'dod'], 'missing'), 3);
});

test('deskFrom and patchDesk round-trip, reset and priority moves', () => {
  const d = deskFrom({}, PRODUCTS);
  assert.equal(d.product, null);
  assert.equal(d.voice, true);
  assert.deepEqual(d.priority[0], 'yoobaland');
  const locked = patchDesk(d, { product: 'yoobaland', screen: 'reel' }, PRODUCTS);
  assert.equal(locked.product, 'yoobaland');
  assert.equal(locked.screen, 'reel');
  const moved = patchDesk(locked, { movePriority: { id: 'yoobaland', dir: 1 } }, PRODUCTS);
  assert.notEqual(moved.priority[0], 'yoobaland');
  assert.equal(moved.priority[1], 'yoobaland');
  const reset = patchDesk(moved, { reset: true }, PRODUCTS);
  assert.deepEqual(reset.priority[0], 'yoobaland');
  assert.equal(reset.voice, true);
  assert.equal(reset.screen, 'auto');
});

test('cueLine prefixes Yooba and strips paths', () => {
  assert.match(cueLine('hopping to the castle'), /^Yooba here\. hopping/);
  assert.match(cueLine('Yooba here. already'), /^Yooba here\. already/);
  assert.doesNotMatch(cueLine('see /srv/hawkes/secret.pem sk-abc123456789'), /\/srv\/|sk-/);
  assert.equal(cueLine(''), '');
});

test('voiceCacheKey is stable per exact sentence', () => {
  assert.equal(voiceCacheKey('Yooba here. Hi.'), voiceCacheKey('Yooba here. Hi.'));
  assert.notEqual(voiceCacheKey('Yooba here. Hi.'), voiceCacheKey('Yooba here. Bye.'));
  assert.match(voiceCacheKey('x'), /^[a-f0-9]{24}$/);
});

test('applyDesk forces quiet, reel rotate, cue and overlay flags', () => {
  const base = composeBroadcast({ library, now: 1_000 });
  assert.ok(base.reel.length > 0);
  const desk = deskFrom({ screen: 'quiet', showPips: false, showFlash: false, cue: 'Cut to black.' }, PRODUCTS);
  const quiet = applyDesk(base, desk, PRODUCTS.map((id) => ({ id, name: id })));
  assert.equal(quiet.picture, 'quiet');
  assert.equal(quiet.focus, null);
  assert.deepEqual(quiet.reel, []);
  assert.match(quiet.host, /Cut to black/);
  assert.deepEqual(quiet.also, []);
  const reelDesk = deskFrom({
    screen: 'reel',
    clip: base.reel[1]?.asset || base.reel[0].asset,
    priority: defaultPriority(PRODUCTS),
  }, PRODUCTS);
  const held = applyDesk(base, reelDesk);
  assert.equal(held.picture, 'reel');
  assert.equal(held.focus, null);
  assert.equal(held.reel[0].asset, reelDesk.clip);
  assert.match(held.status || '', /Reel/);
});

test('priority orders live takes and biases the reel', () => {
  const playing = [
    { job: 'j_aaa', ctx: { product: 'doseofdestruction', productName: 'DoD', name: 'Match' }, step: 'fight', url: 'https://dod.example/', players: [{ state: { note: 'round 1' } }] },
    { job: 'j_bbb', ctx: { product: 'yoobaland', productName: 'Yooba Land', name: 'Castle' }, step: 'hop', url: 'https://yooba.example/', players: [{ state: { note: 'waystone' } }] },
  ];
  const yoobaFirst = composeBroadcast({ playing, priority: ['yoobaland', 'doseofdestruction'], now: 1_000 });
  assert.equal(yoobaFirst.focus?.product, 'yoobaland');
  const dodFirst = composeBroadcast({ playing, priority: ['doseofdestruction', 'yoobaland'], now: 1_000 });
  assert.equal(dodFirst.focus?.product, 'doseofdestruction');

  const reel = selectReel(library, { priority: ['phorigins', 'yoobaland', 'doseofdestruction'] });
  assert.ok(reel.length >= 2);
  // PH Origins wave is older but higher priority than DoD jab when both are clips; turntables still lead.
  assert.equal(reel[0].what, 'turntable');
  assert.equal(reel[0].product, 'Yooba Land');
  const clipProducts = reel.filter((r) => r.what !== 'turntable').map((r) => r.product);
  assert.ok(clipProducts.indexOf('PH Origins') < clipProducts.indexOf('Dose Of Destruction'));
});

test('patchDesk next/previous advances the reel without looping the same clip first', () => {
  const pool = [{ asset: 'a_aaaaaaaaaaaaaaaa' }, { asset: 'a_8888888888888888' }, { asset: 'a_7777777777777777' }];
  const desk = deskFrom({ screen: 'reel', clip: pool[0].asset, reelAt: 0 }, PRODUCTS);
  const next = patchDesk(desk, { nudge: 1 }, PRODUCTS, pool);
  assert.equal(next.clip, pool[1].asset);
  assert.equal(next.reelAt, 1);
  assert.equal(next.paused, false);
  const prev = patchDesk(next, { nudge: -1 }, PRODUCTS, pool);
  assert.equal(prev.clip, pool[0].asset);
  const advanced = patchDesk(next, { advance: true, from: 1 }, PRODUCTS, pool);
  assert.equal(advanced.reelAt, 2);
  assert.equal(advanced.clip, pool[2].asset);
});

test('normalizePriority drops unknown ids and fills the rest', () => {
  assert.deepEqual(normalizePriority(['yoobaland', 'nope', 'phorigins'], PRODUCTS).slice(0, 2), ['yoobaland', 'phorigins']);
  assert.ok(normalizePriority(null, PRODUCTS).includes('sickofit'));
  assert.equal(DESK_DEFAULT.voice, true);
});

// Twitch black-frame + white X: ffmpeg x11grab draws the X11 mouse by default (-draw_mouse 1).
// On a black On Air stage the cursor lands as a small X on the RTMP send while the desk browser
// still looks full. Keep -draw_mouse 0 on the grab and cursor:none on body.clean as a belt-and-braces.
test('the Twitch capture path never draws the X11 mouse cursor', () => {
  const streamSrc = fs.readFileSync(new URL('../bin/broadcast-stream.mjs', import.meta.url), 'utf8');
  assert.match(streamSrc, /-draw_mouse['"\s,]+0/);
  assert.match(streamSrc, /x11grab/);
  const css = fs.readFileSync(new URL('../dashboard/broadcast.css', import.meta.url), 'utf8');
  assert.match(css, /body\.clean\s*\{\s*cursor:\s*none/);
});

test('the encoder never prints the stream key (ffmpeg banner off)', () => {
  const src = fs.readFileSync(new URL('../bin/broadcast-stream.mjs', import.meta.url), 'utf8');
  for (const m of src.matchAll(/spawn\(ffmpeg, \[([\s\S]*?)rtmp:\/\/live\.twitch\.tv/g)) {
    assert.match(m[1], /'-hide_banner', '-loglevel', 'warning'/);
  }
});

test('the encoder\'s prerequisites live in code: one setup module that deploys import fresh, and the encoder\'s browser list', async () => {
  const unit = await import('../deploy/broadcast-unit.mjs');
  assert.match(unit.BROADCAST_UNIT, /ExecStart=\/usr\/bin\/node bin\/broadcast-stream\.mjs --go/);
  assert.match(unit.BROADCAST_UNIT, /Restart=always/);
  for (const p of ['xvfb', 'ffmpeg']) assert.ok(unit.BROADCAST_APT.includes(p), p);
  assert.ok(unit.BROADCAST_CHROMIUM.includes('/snap/bin/chromium'));
  assert.equal(typeof unit.ensureBroadcast, 'function');
  const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.match(read('../bin/broadcast-stream.mjs'), /import \{ BROADCAST_CHROMIUM \} from '\.\.\/deploy\/broadcast-unit\.mjs'/);
  // hawkes-pull is in memory before it pulls: the work must come from the freshly imported module, not its own code.
  const pull = read('../deploy/hawkes-pull.mjs');
  assert.match(pull, /ensureBroadcast: ensure \} = await import\(.*broadcast-unit\.mjs.*\?v=\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(pull, /BROADCAST_UNIT/);
  assert.match(read('../deploy/deploy.mjs'), /sudo node deploy\/broadcast-unit\.mjs/);
  assert.match(read('../deploy/cloud-init.sh'), /xvfb[\s\S]*snap install chromium/);
});

test('the desk keeps the ladder, the showcase kinds, segment lengths and line variety;reset brings them back', () => {
  const d = deskFrom({}, PRODUCTS);
  assert.deepEqual(d.ladder, ['playtest', 'work', 'roadmap', 'showcase']);
  const next = patchDesk(d, { ladder: ['roadmap', 'bogus', 'roadmap', 'showcase'], showcaseKinds: ['song'], dwell: { roadmap: 60, work: 2 }, variety: 1 }, PRODUCTS);
  assert.deepEqual(next.ladder, ['roadmap', 'showcase']);
  assert.deepEqual(next.showcaseKinds, ['song']);
  assert.equal(next.dwell.roadmap, 60);
  assert.equal(next.dwell.work, 35, 'under 5 s is ignored');
  assert.equal(next.variety, 1);
  assert.deepEqual(deskFrom(JSON.parse(JSON.stringify(next)), PRODUCTS).ladder, ['roadmap', 'showcase']);
  assert.deepEqual(patchDesk(next, { ladder: [] }, PRODUCTS).ladder, []);
  assert.throws(() => patchDesk(d, { variety: 20 }, PRODUCTS), /variety/);
  assert.throws(() => patchDesk(d, { ladder: 'roadmap' }, PRODUCTS), /ladder/);
  assert.deepEqual(patchDesk(next, { reset: true }, PRODUCTS).ladder, ['playtest', 'work', 'roadmap', 'showcase']);
});
