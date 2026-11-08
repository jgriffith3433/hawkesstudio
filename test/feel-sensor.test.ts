import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain JS client helper
import { createFeelCore, parseSpot } from '../clients/web/hawkes-feel.js';

const fwd = (yawDeg: number) => ({ x: Math.sin((yawDeg * Math.PI) / 180), y: 0, z: Math.cos((yawDeg * Math.PI) / 180) });

function run(frames: any[], thresholds = {}) {
  const got: any[] = [];
  const core = createFeelCore({ emit: (f: any) => got.push(f), seed: 42, scene: () => 'Town', thresholds });
  for (const f of frames) core.sample(f);
  return { got, core };
}

/** n frames at 60 fps from t0, built by make(i, t). */
function frames(n: number, make: (i: number, t: number) => any, t0 = 0, dt = 1 / 60) {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * dt, dt, ...make(i, t0 + i * dt) }));
}

test('a smooth walk raises nothing', () => {
  const { got } = run(frames(300, (i, t) => ({ player: { x: t * 4, y: 0, z: 0 }, cam: { pos: { x: t * 4 - 5, y: 2, z: 0 }, fwd: fwd(90 + Math.sin(t) * 10) }, input: 1, floorBelow: true, surfaceAbove: null })));
  assert.deepEqual(got, []);
});

test('a camera snap is flagged once with position, seed and scene', () => {
  const { got } = run(frames(60, (i) => ({ player: { x: 1, y: 0, z: 2 }, cam: { pos: { x: 0, y: 2, z: -3 }, fwd: fwd(i < 30 ? 0 : 120) } })));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'camera-snap');
  assert.equal(got[0].severity, 'polish');
  assert.deepEqual(got[0].pos, [1, 0, 2]);
  assert.equal(got[0].seed, 42);
  assert.equal(got[0].scene, 'Town');
  assert.equal(got[0].cam.yaw, 120);
});

test('an intended cut silences the camera checks', () => {
  const got: any[] = [];
  const core = createFeelCore({ emit: (f: any) => got.push(f) });
  for (const f of frames(30, () => ({ cam: { pos: { x: 0, y: 2, z: 0 }, fwd: fwd(0) } }))) core.sample(f);
  core.cut();
  for (const f of frames(30, () => ({ cam: { pos: { x: 50, y: 2, z: 0 }, fwd: fwd(180) } }), 0.5)) core.sample(f);
  assert.deepEqual(got, []);
});

test('a camera jump without the player moving is flagged', () => {
  const { got } = run(frames(20, (i) => ({ player: { x: 0, y: 0, z: 0 }, cam: { pos: { x: i === 10 ? 8 : 0, y: 2, z: -4 }, fwd: fwd(0) } })));
  assert.ok(got.some((f) => f.kind === 'camera-jump'));
});

test('falling through the floor: under a surface with nothing below', () => {
  const { got } = run(frames(60, (i, t) => ({ player: { x: 0, y: i < 20 ? 0 : -1.5, z: 0 }, floorBelow: i < 20, surfaceAbove: i < 20 ? null : 0 })));
  const f = got.find((x) => x.kind === 'below-ground');
  assert.ok(f);
  assert.equal(f.severity, 'bug');
});

test('falling with no floor anywhere becomes fell-out', () => {
  const { got } = run(frames(200, (i, t) => ({ player: { x: 0, y: -t * 5, z: 0 }, floorBelow: false, surfaceAbove: null })));
  assert.ok(got.some((f) => f.kind === 'fell-out'));
});

test('stuck: input held, no ground covered', () => {
  const { got } = run(frames(150, () => ({ player: { x: 3, y: 0, z: 3 }, input: 1, floorBelow: true, surfaceAbove: null })));
  const f = got.find((x) => x.kind === 'stuck');
  assert.ok(f);
  assert.equal(got.filter((x) => x.kind === 'stuck').length, 1, 'repeats merge into one flag');
});

test('standing still without input is not stuck', () => {
  const { got } = run(frames(150, () => ({ player: { x: 3, y: 0, z: 3 }, input: 0 })));
  assert.deepEqual(got, []);
});

test('a collision pop and jitter are flagged', () => {
  const pop = run(frames(40, (i, t) => ({ player: { x: t * 2 + (i >= 20 ? 3 : 0), y: 0, z: 0 } })));
  assert.ok(pop.got.some((f) => f.kind === 'collision-pop'));
  const jit = run(frames(60, (i) => ({ player: { x: i % 2 ? 0.05 : 0, y: 0, z: 0 } })));
  assert.ok(jit.got.some((f) => f.kind === 'jitter'));
});

test('a frame hitch against steady frames', () => {
  const fr = frames(60, () => ({}));
  fr[40] = { ...fr[40], dt: 0.25 };
  const { got } = run(fr);
  const f = got.find((x) => x.kind === 'hitch');
  assert.ok(f);
  assert.equal(f.value, 250);
});

test('camera blocked for a while', () => {
  const { got } = run(frames(60, () => ({ player: { x: 0, y: 0, z: 0 }, cameraBlocked: true })));
  assert.ok(got.some((f) => f.kind === 'camera-blocked'));
});

test('flags() returns what was raised without internal fields', () => {
  const { core } = run(frames(150, () => ({ player: { x: 3, y: 0, z: 3 }, input: 1 })));
  const list = core.flags();
  assert.equal(list.length, 1);
  assert.equal((list[0] as any).lastT, undefined);
  assert.ok(list[0].count > 1);
});

test('parseSpot reads x,y,z[,yaw] and objects', () => {
  assert.deepEqual(parseSpot('1, 2.5, -3'), { x: 1, y: 2.5, z: -3 });
  assert.deepEqual(parseSpot('1,2,3,90'), { x: 1, y: 2, z: 3, yaw: 90 });
  assert.deepEqual(parseSpot({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 });
  assert.equal(parseSpot('nope'), null);
  assert.equal(parseSpot(''), null);
});

test('foot sliding: the body moves while the feet idle', () => {
  const { got } = run(frames(60, (i, t) => ({ player: { x: t * 3, y: 0, z: 0 }, grounded: true, animSpeed: 0 })));
  assert.ok(got.some((f) => f.kind === 'foot-sliding'));
  const ok = run(frames(60, (i, t) => ({ player: { x: t * 3, y: 0, z: 0 }, grounded: true, animSpeed: 3 })));
  assert.deepEqual(ok.got, []);
});

test('slope landing: lands, then slides off with no input', () => {
  const { got } = run(frames(60, (i, t) => ({ player: { x: i < 20 ? 0 : (i - 20) * 0.08, y: 0, z: 0 }, grounded: i >= 20, input: 0 })));
  assert.ok(got.some((f) => f.kind === 'slope-slide'));
  const walk = run(frames(60, (i) => ({ player: { x: i < 20 ? 0 : (i - 20) * 0.08, y: 0, z: 0 }, grounded: i >= 20, input: 1 })));
  assert.ok(!walk.got.some((f) => f.kind === 'slope-slide'));
});
