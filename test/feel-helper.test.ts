import { test } from 'node:test';
import assert from 'node:assert/strict';

// A bare browser for the plain-JS helper: no Babylon scene, so the frame-only sensor runs.
const pushed: any[] = [];
const g = globalThis as any;
g.window = g;
g.location = { search: '' };
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.dispatchEvent = () => true;
g.CustomEvent ??= class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } };
let frameCb: ((t: number) => void)[] = [];
g.requestAnimationFrame = (cb: any) => { frameCb.push(cb); return frameCb.length; };
g.__hawkesPlaytestPush = (m: any) => pushed.push(m);

function frames(times: number[]) {
  for (const t of times) { const cbs = frameCb; frameCb = []; for (const cb of cbs) cb(t); }
}

test('a run starts the feel sensor, pushes flags to the runner and puts them in the report', async () => {
  // @ts-ignore: plain JS
  const { installPlaytest } = await import('../clients/web/hawkes-playtest.js');
  let release!: () => void;
  const api = installPlaytest({
    product: 'demo',
    scenarios: [{ id: 'smoke', title: 'Smoke', seconds: 10 }],
    start: (_id: string, _o: any, t: any) => { assert.deepEqual(t.spot, { x: 1, y: 2, z: 3 }); return new Promise<void>((r) => { release = r; }); },
  });
  const done = api.start('smoke', { seed: 9, spot: '1,2,3' });
  const t0 = performance.now();
  const ts: number[] = [];
  for (let i = 1; i <= 40; i++) ts.push(t0 + i * 16);
  ts.push(t0 + 40 * 16 + 300); // a 300 ms hitch
  for (let i = 1; i <= 5; i++) ts.push(t0 + 40 * 16 + 300 + i * 16);
  frames(ts);
  const feel = pushed.filter((m) => m.type === 'feel');
  assert.equal(feel.length, 1);
  assert.equal(feel[0].flag.kind, 'hitch');
  assert.equal(feel[0].flag.seed, 9);
  release();
  await done;
  const rep: any = api.report();
  assert.equal(rep.feel.length, 1);
  assert.ok(rep.events.some((e: any) => e.type === 'feel'));
});
