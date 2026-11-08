import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feelFindings, replayOf, feelSeverity, feelLine } from '../src/feel.ts';

const flag = (o: any) => ({ id: 'feel-' + Math.random(), severity: 'polish', t: 1, pos: [1, 2, 3], detail: 'x', count: 1, seed: 4, ...o });

test('flags group by kind and scene, bugs first, with places and a replay', () => {
  const r = {
    feel: [
      flag({ kind: 'camera-snap', scene: 'City', count: 1 }),
      flag({ kind: 'below-ground', severity: 'bug', scene: 'City', pos: [10.4, -2, 5], spot: '10.4,-2,5,90', count: 2, shot: 'a_shot1', clip: 'a_clip1' }),
      flag({ kind: 'below-ground', severity: 'bug', scene: 'City', pos: [40, -1, 5], spot: '40,-1,5' }),
      flag({ kind: 'hitch', scene: 'City' }),
    ],
  };
  const list = feelFindings(r, { scenario: 'city' });
  assert.equal(list[0].title, 'Player falls through the floor in City');
  assert.equal(list[0].severity, 'bug');
  assert.deepEqual(list[0].replay, { scenario: 'city', options: { seed: 4, spot: '10.4,-2,5,90' } });
  assert.deepEqual(list[0].shots, ['a_shot1']);
  assert.match(list[0].detail, /\(10, -2, 5\)/);
  assert.match(list[0].detail, /clip a_clip1/);
  assert.equal(list.length, 3);
  assert.deepEqual(replayOf(list[0].detail), list[0].replay);
});

test('outside the daily run only bugs are filed; software runs drop hitches', () => {
  const r = { software: true, feel: [flag({ kind: 'camera-snap' }), flag({ kind: 'hitch', count: 50 }), flag({ kind: 'stuck', severity: 'bug' })], polish: { hits: [{ kind: 'z-fighting', title: 'Z-fighting (surfaces flicker through each other)', severity: 'polish', where: 'wall', detail: 'flicker', t: 3, asset: 'a1' }] } };
  assert.deepEqual(feelFindings(r, { scenario: 's', mode: 'verify' }).map((f) => f.title), ['Player gets stuck on geometry']);
  const full = feelFindings(r, { scenario: 's' });
  assert.ok(!full.some((f) => /hitch/i.test(f.title)));
  assert.ok(full.some((f) => /Z-fighting/.test(f.title) && f.area === 'art' && f.shots[0] === 'a1'));
});

test('repeated camera snaps become a bug', () => {
  assert.equal(feelSeverity('camera-snap', 'polish', 1), 'polish');
  assert.equal(feelSeverity('camera-snap', 'polish', 2), 'bug');
  assert.equal(feelSeverity('hitch', 'polish', 99), 'polish');
});

test('replayOf refuses bad lines', () => {
  assert.equal(replayOf('nothing'), null);
  assert.equal(replayOf('Replay: {"scenario":"a b"}'), null);
  assert.deepEqual(replayOf('x\nReplay: {"scenario":"a","options":{"spot":"1,2,3;rm","seed":"5"}}'), { scenario: 'a', options: { seed: 5 } });
});

test('feelLine', () => {
  assert.equal(feelLine({}), '');
  assert.equal(feelLine({ feel: [{}], polish: { score: 6.5 } }), 'feel: 1 flag, polish 6.5/10');
});
