// The first five minutes (ftue.ts; J, 2026-11-11): the numbers read from a first-five play's events, the rubric's
// "first-five-minutes" checks, the walls met and developer UI with their evidence, and the report lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ftue-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(path.join(process.env.STUDIO_PROJECTS, 'fgame'), { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'fgame', name: 'First Game', framing: 'test', engine: 'web', repo: 'fgame', site: 'fgame', live: 'https://fgame.example/', hub: true,
  local: { serve: 'static', dir: 'fgame', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const F = await import('../src/ftue.ts');
const q = await import('../src/quality.ts');
const game = { id: 'fgame', engine: 'web', kind: undefined } as any;

const slow = {
  seconds: 300, video: 'a_clip', metrics: { 'ftue.wordsMinuteOne': 120 },
  events: [
    { t: 3, type: 'wall', detail: JSON.stringify({ kind: 'terms', label: 'Terms of service', seconds: 6.5 }) },
    { t: 9, type: 'tap' }, { t: 14, type: 'tap' }, { t: 22, type: 'tap' },
    { t: 30, type: 'wall', detail: JSON.stringify({ kind: 'sign-in', label: 'Sign in with Google', seconds: 12 }) },
    { t: 41, type: 'milestone', detail: 'gameplay' },
    { t: 44, type: 'milestone', detail: 'first-input-accepted' },
    { t: 70, type: 'milestone', detail: 'first-success' },
    { t: 75, type: 'milestone', detail: 'tutorial-step:move' },
    { t: 80, type: 'tap' },
    { t: 12, type: 'dev-ui', detail: JSON.stringify({ what: 'FPS counter and level picker', shot: 'a_shot' }) },
  ],
};

test('seconds to gameplay, input and success, taps to play, words and walls are read from the events', () => {
  const f = F.ftueOf(slow, 'phone');
  assert.equal(f.device, 'phone');
  assert.equal(f.secondsToGameplay, 41);
  assert.equal(f.secondsToFirstInput, 44);
  assert.equal(f.secondsToFirstSuccess, 70);
  assert.equal(f.tapsToPlay, 3, 'taps after gameplay began are not counted');
  assert.equal(f.wordsMinuteOne, 120);
  assert.deepEqual(f.walls.map((w) => [w.kind, w.seconds]), [['terms', 6.5], ['sign-in', 12]]);
  assert.equal(f.wallSeconds, 18.5);
  assert.equal(f.devUi[0].shot, 'a_shot');
  assert.deepEqual(f.tutorialSteps, [{ step: 'move', at: 75 }]);
  assert.deepEqual(f.clip, { asset: 'a_clip', from: 0, to: 41 });
});

test('a milestone the game reports itself (t.milestone) counts, by the page clock', () => {
  const f = F.ftueOf({ seconds: 60, metrics: { 'milestone.gameplay': 4.2, 'milestone.first-success': 18 }, events: [{ t: 0.5, type: 'milestone', detail: 'gameplay' }] });
  assert.equal(f.secondsToGameplay, 4.2);
  assert.equal(f.secondsToFirstSuccess, 18);
  assert.equal(f.secondsToFirstInput, null);
});

test('a first-five play over a limit fails the first-five-minutes rule with its time, and a game that never starts fails too', () => {
  const r = F.enrichFtue(slow, 'first-five', 'desktop');
  assert.ok(r.ftue);
  assert.equal(r.metrics!['ftue.secondsToGameplay'], 41);
  const g = q.qualityGate(game, { metrics: r.metrics });
  const ids = g.fails.map((x) => x.check).sort();
  assert.deepEqual(ids, ['first-five-dev-ui', 'first-five-gameplay', 'first-five-input', 'first-five-success', 'first-five-taps', 'first-five-words'].sort());
  assert.ok(g.fails.find((x) => x.check === 'first-five-gameplay')!.evidence.includes('ftue.secondsToGameplay = 41'));
  assert.equal(g.fails.filter((x) => x.check === 'first-five-dev-ui').length, 1);
  const never = F.enrichFtue({ seconds: 300, events: [] }, 'first-five');
  assert.equal(never.metrics!['ftue.secondsToGameplay'], 300);
  assert.ok(q.qualityGate(game, { metrics: never.metrics }).fails.some((x) => x.check === 'first-five-gameplay'));
});

test('a quick clean first five passes, and other scenarios are not judged by it', () => {
  const good = F.enrichFtue({ seconds: 300, metrics: { 'ftue.wordsMinuteOne': 18 }, events: [{ t: 2, type: 'tap' }, { t: 6, type: 'milestone', detail: 'gameplay' }, { t: 7, type: 'milestone', detail: 'first-input-accepted' }, { t: 25, type: 'milestone', detail: 'first-success' }] }, 'first-five');
  assert.equal(q.qualityGate(game, { metrics: good.metrics }).fails.length, 0);
  const smoke = F.enrichFtue({ metrics: {} }, 'smoke');
  assert.equal((smoke as any).ftue, undefined);
  assert.equal(q.qualityGate(game, { metrics: {} }).fails.length, 0, 'the checks are optional: no first-five reading is not unmeasured in other plays');
  assert.deepEqual(q.qualityGate(game, { metrics: {} }).unmeasured.filter((x) => x.startsWith('first-five')), []);
});

test('a game can move a limit with tuning', () => {
  const g = q.qualityGate({ ...game, tuning: { 'ftue.secondsToGameplay': { max: 45 } } }, { metrics: { 'ftue.secondsToGameplay': 41 } });
  assert.equal(g.fails.length, 0);
});

test('the report lines name the time, the clip, every wall and the developer UI', () => {
  const lines = F.ftueLines(F.ftueOf(slow, 'desktop')).join('\n');
  assert.match(lines, /gameplay 41 s \(limit 20 s\)/);
  assert.match(lines, /Clip: /);
  assert.match(lines, /Terms of service \(terms, 6\.5 s/);
  assert.match(lines, /Sign in with Google \(sign-in, 12 s/);
  assert.match(lines, /Developer UI visible to the public/);
  assert.match(lines, /screenshot/);
});

test('the first-five play is cold: its params carry no hint or setup, and a hub game is played from its hub too', () => {
  const p = F.firstFiveParams('https://fgame.example/', 'phone');
  assert.equal(p.fresh, true);
  assert.equal(p.scenario, 'first-five');
  assert.equal(p.mobile, true);
  assert.equal(p.options, undefined);
  const tests = F.firstFivePlaytests({ live: 'https://fgame.example/', hub: true });
  assert.deepEqual(tests.map((t) => `${t.scenario}:${t.device}`), ['first-five:desktop', 'first-five:phone', 'first-five-hub:desktop', 'first-five-hub:phone']);
  assert.ok(tests.every((t) => t.where === 'live'));
  assert.equal(F.firstFivePlaytests({ live: 'https://x.example/' }).length, 2);
});

test('it is due once a week per game', () => {
  assert.equal(F.firstFiveDue('fgame'), true);
  assert.equal(F.firstFiveDue('nope'), false);
});
