// Auth walls (authwall.ts; finding f_b3bf8e33e26c): a playtest that landed on Studio's sign-in card or Google's sign-in
// is failed with an "auth wall" problem, and the first five minutes still carry a beta site's pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authWallOf, failedByAuthWall } from '../src/authwall.ts';

test("Studio's sign-in card ends the run failed with an auth wall problem and the screenshot", () => {
  const r = { outcome: 'done', problems: [], shots: [{ asset: 'a_1' }, { asset: 'a_card' }], events: [{ t: 2, type: 'wall', detail: JSON.stringify({ kind: 'sign-in', label: 'Sign in', text: 'Sign in Hawkes Studio, Gen and the beta sites.' }) }] };
  const w = authWallOf(r)!;
  assert.equal(w.kind, 'studio-signin');
  const f = failedByAuthWall(r, w);
  assert.equal(f.outcome, 'failed');
  assert.match(f.problems[0].message, /auth wall/);
  assert.equal(f.problems[0].shot, 'a_card');
});

test('a navigation to accounts.google.com is an auth wall', () => {
  assert.equal(authWallOf({ outcome: 'done', finalUrl: 'https://accounts.google.com/signin/oauth/error?x=1' })?.kind, 'google');
  assert.equal(authWallOf({ outcome: 'done', navigations: ['https://sites.hawkesgen.ai/g/', { url: 'https://accounts.google.com/o/oauth2/v2/auth' }] })?.kind, 'google');
  assert.equal(authWallOf({ events: [{ type: 'navigate', detail: 'https://accounts.google.com/x' }] })?.kind, 'google');
});

test('a game that loads Google frames or shows its own sign-in is not an auth wall', () => {
  const r = { outcome: 'done', finalUrl: 'https://sites.hawkesgen.ai/o/j/yoobalandgame/Game/', events: [{ type: 'wall', detail: JSON.stringify({ kind: 'sign-in', label: 'Sign in with Google' }) }], requests: ['https://accounts.google.com/gsi/client'] };
  assert.equal(authWallOf(r), null);
  assert.equal(authWallOf({ outcome: 'done' }), null);
  assert.equal(authWallOf(null), null);
});

test('a blocked play stuck on the sign-in card is an auth wall, whatever the outcome', () => {
  const r = { outcome: 'blocked', stuck: 'no input changed the page: "Sign in with Google. Hawkes Studio, Gen and the beta sites."', events: [{ t: 3, type: 'milestone', detail: 'loaded' }], shots: [{ asset: 'a_card' }], ftue: { taps: 0 } };
  const w = authWallOf(r)!;
  assert.equal(w.kind, 'studio-signin');
  assert.equal(failedByAuthWall(r, w).outcome, 'failed');
  assert.equal(authWallOf({ outcome: 'blocked', events: [{ type: 'tap', detail: 'start' }] }), null);
});
