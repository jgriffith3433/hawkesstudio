import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRITIC_DIMENSIONS } from '../src/config.ts';
import {
  compareCritics, milestoneCriticGate, touchedDimensions, REGRESSION_DROP, isCriticBlocker, snapOf,
} from '../src/critic-gate.ts';

const scores = (n: number | Record<string, number>, why = 'the critic said so') =>
  CRITIC_DIMENSIONS.map((dimension) => ({
    dimension,
    score: typeof n === 'number' ? n : (n[dimension] ?? 8),
    why: `${why} (${dimension})`,
    fix: `fix ${dimension}`,
    reference: 'Hades',
  }));

const snap = (n: number | Record<string, number>, why?: string) => ({
  judged: true as const,
  sha: 'abc',
  at: 1,
  scenario: 'smoke',
  summary: 's',
  scores: scores(n, why),
});

test('no critic review is a warning, never a blocker or a pass', () => {
  const c = compareCritics({ beta: null, live: null, floor: 6, milestoneGoLive: false });
  assert.deepEqual(c.blockers, []);
  assert.ok(c.warnings.includes('Critic: not judged'));
});

test('a drop of 2 or more points against live holds go-live with both scores and the critic sentence', () => {
  const c = compareCritics({
    beta: snap({ fun: 6, feel: 8 }),
    live: snap({ fun: 8, feel: 8 }),
    floor: 6,
    milestoneGoLive: false,
  });
  assert.equal(c.blockers.length, 1);
  assert.match(c.blockers[0], /fun dropped 2 points/);
  assert.match(c.blockers[0], /beta 6\/10/);
  assert.match(c.blockers[0], /live 8\/10/);
  assert.match(c.blockers[0], /the critic said so \(fun\)/);
  assert.equal(c.warnings.includes('Critic: not judged'), false);
  assert.ok(c.lines.some((l) => /fun: beta 6\/10 · live 8\/10/.test(l)));
});

test('a one-point drop does not hold', () => {
  const c = compareCritics({
    beta: snap({ fun: 7 }),
    live: snap({ fun: 8 }),
    floor: 6,
    milestoneGoLive: false,
  });
  assert.deepEqual(c.blockers, []);
});

test('milestone go-live holds a dimension under the release floor', () => {
  const c = compareCritics({
    beta: snap({ sound: 5 }),
    live: snap({ sound: 5 }),
    floor: 6,
    milestoneGoLive: true,
  });
  assert.ok(c.blockers.some((b) => /sound is 5\/10, under the release floor 6/.test(b)));
  assert.ok(c.blockers.some((b) => /the critic said so \(sound\)/.test(b)));
});

test('release floor does not hold a normal (non-milestone) go-live', () => {
  const c = compareCritics({
    beta: snap({ sound: 5 }),
    live: snap({ sound: 5 }),
    floor: 6,
    milestoneGoLive: false,
  });
  assert.deepEqual(c.blockers, []);
});

test('critic blockers are held lines; "not judged" is not a critic blocker', () => {
  assert.equal(isCriticBlocker('Critic: fun dropped 2 points against live (beta 5/10, live 8/10).'), true);
  assert.equal(isCriticBlocker('Critic: sound is 5/10, under the release floor 6.'), true);
  assert.equal(isCriticBlocker('Critic: not judged'), false);
  assert.equal(REGRESSION_DROP, 2);
});

test('touched dimensions follow the task axes (all ten when every axis is used)', () => {
  assert.deepEqual(touchedDimensions(['sound', 'phone']), ['sound', 'phone']);
  assert.ok(touchedDimensions(['core-loop']).includes('fun'));
  assert.ok(touchedDimensions(['core-loop']).includes('clarity'));
  assert.equal(touchedDimensions([null, undefined]).length, 0);
});

test('a milestone waits for the critic until every touched dimension meets its target', () => {
  const waiting = milestoneCriticGate({
    dimensions: ['fun', 'sound'],
    critic: null,
    targets: { fun: 7, sound: 7 },
  });
  assert.equal(waiting.ready, false);
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.line, 'waiting for the critic');

  const under = milestoneCriticGate({
    dimensions: ['fun', 'sound'],
    critic: snap({ fun: 8, sound: 5 }),
    targets: { fun: 7, sound: 7 },
  });
  assert.equal(under.ready, false);
  assert.match(under.line, /waiting for the critic/);
  assert.match(under.line, /sound 5\/7/);

  const ok = milestoneCriticGate({
    dimensions: ['fun', 'sound'],
    critic: snap({ fun: 8, sound: 7 }),
    targets: { fun: 7, sound: 7 },
  });
  assert.equal(ok.ready, true);
  assert.equal(ok.waiting, false);

  const none = milestoneCriticGate({ dimensions: [], critic: null, targets: {} });
  assert.equal(none.ready, true);
  assert.equal(none.waiting, false);
});

test('snapOf refuses a partial or unjudged review', () => {
  assert.equal(snapOf({ verdict: 'unjudged', scores: [] }, 'a', 1), null);
  assert.equal(snapOf({ verdict: 'judged', scores: [{ dimension: 'fun', score: 5 }] }, 'a', 1), null);
  assert.ok(snapOf({ verdict: 'judged', scores: scores(7), summary: 'ok', scenario: 's' }, 'abc', 9)?.judged);
});
