// The explore bot (clients/web/hawkes-explore.js) and its heatmap (src/explore.ts; the owner's gaps list,
// 2026-11-08): it hugs walls, jumps edges and maps where the player got stuck or fell out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExploreMap, runExplore, seededRandom } from '../clients/web/hawkes-explore.js';
import { exploreOf, heatmapSvg } from '../src/explore.ts';

test('the map counts cells, stuck and fall spots, and the longest dead stretch', () => {
  const m = createExploreMap({ cell: 2 });
  m.visit({ x: 0.5, y: 0, z: 0.5 }, 0, 0.1);
  m.visit({ x: 1.5, y: 0, z: 1.5 }, 1, 0.1);   // same cell
  m.visit({ x: 3, y: 0, z: 0 }, 2, 0.1);       // new cell after 2 s
  m.visit({ x: 3, y: 0, z: 0 }, 40, 0.1);
  m.visit([-5, 0, 7], 45, 0.1);                // new cell after 43 s
  m.mark('stuck', { x: 3, z: 0 });
  m.mark('fall', [-5, -10, 7]);
  const s = m.summary(45);
  assert.equal(s.coverage, 3);
  assert.equal(s.deadSeconds, 43);
  assert.deepEqual(s.stuck, [[1, 0, 1]]);
  assert.deepEqual(s.falls, [[-3, 3, 1]]);
});

// A fake world: a wall at x = 5 stops the player; pressing left/right slides along it; jumps are counted.
function world() {
  const p = { x: 0, y: 0, z: 0 };
  const held = new Set<string>();
  let jumps = 0;
  const keyboard = {
    hold(n: string) { held.add(n); },
    release(n: string) { held.delete(n); },
    tap(n: string) { if (n === 'jump') jumps++; },
    releaseAll() { held.clear(); },
    held: () => [...held],
  };
  let clock = 0;
  const step = () => {
    const v = 0.4;
    if (held.has('forward')) p.x = Math.min(5, p.x + v);
    if (held.has('back')) p.x -= v;
    if (held.has('left')) p.z -= v;
    if (held.has('right')) p.z += v;
  };
  return {
    p, keyboard, get jumps() { return jumps; }, held,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms / 1000; step(); },
  };
}

test('the bot runs forward, slides along the wall and jumps on a beat', async () => {
  const w = world();
  const s = await runExplore({ player: () => w.p, keyboard: w.keyboard as any, seconds: 20, seed: 3, now: w.now, sleep: w.sleep });
  assert.ok(w.p.x >= 4.9, 'reached the wall');
  assert.ok(Math.abs(w.p.z) > 1, 'slid along it');
  assert.ok(w.jumps >= 3, 'jumped');
  assert.ok(s.coverage >= 4);
  assert.equal(w.held.size, 0, 'every key released at the end');
});

test('a corner it cannot leave is a stuck spot', async () => {
  const w = world();
  const s = await runExplore({ player: () => ({ x: 0, y: 0, z: 0 }), keyboard: w.keyboard as any, seconds: 12, now: w.now, sleep: w.sleep });
  assert.deepEqual(s.stuck, [[0, 0, 1]]);
  assert.equal(s.coverage, 1);
});

test('seededRandom repeats with its seed', () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('exploreOf reads the last explore-map event and drops bad cells', () => {
  assert.equal(exploreOf(null), null);
  assert.equal(exploreOf([{ type: 'finish', detail: 'done' }]), null);
  assert.equal(exploreOf([{ type: 'explore-map', detail: '{not json' }]), null);
  const m = exploreOf([
    { type: 'explore-map', detail: JSON.stringify({ cell: 2, coverage: 1, visited: [[0, 0, 1]] }) },
    { type: 'explore-map', detail: JSON.stringify({ cell: 2, coverage: 2, deadSeconds: 31, visited: [[0, 0, 1], [1, 0, 2], ['x', 1, 1]], stuck: [[1, 0, 1]], falls: [] }) },
  ])!;
  assert.equal(m.coverage, 2);
  assert.equal(m.deadSeconds, 31);
  assert.equal(m.visited.length, 2);
  assert.deepEqual(m.stuck, [[1, 0, 1]]);
});

test('heatmapSvg draws visited, stuck and fall cells', () => {
  const svg = heatmapSvg({ cell: 2, coverage: 3, deadSeconds: 12, visited: [[0, 0, 1], [1, 0, 4], [1, 1, 2]], stuck: [[1, 0, 1]], falls: [[0, 1, 1]] }, 'game <smoke>');
  assert.match(svg, /^<svg/);
  assert.match(svg, /game &lt;smoke&gt;: 3 cells of 2 m, 1 stuck, 1 fall,/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 1 + 3 + 1 + 1);
  assert.match(heatmapSvg({ cell: 2, coverage: 0, deadSeconds: 0, visited: [], stuck: [], falls: [] }), /no positions/);
});
