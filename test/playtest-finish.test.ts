import { test } from 'node:test';
import assert from 'node:assert/strict';
const F = await import('../src/playtest-finish.ts');

test('a provider hang, a full disk and restarts are retryable; a game failure is not', () => {
  assert.deepEqual(F.classifyFailure({ status: 'failed', error: 'stuck: ran for over 30 min', stuckAt: 'waiting for RunPod worker' }), { kind: 'provider', provider: 'runpod' });
  assert.equal(F.classifyFailure({ status: 'failed', error: 'RunPod: no space left on device' })?.kind, 'disk');
  assert.equal(F.classifyFailure({ status: 'failed', error: 'Hawkes Gen stopped answering: x' })?.kind, 'restart');
  assert.equal(F.classifyFailure({ status: 'failed', error: 'page.goto: net::ERR_CONNECTION_REFUSED' })?.kind, 'beta-restart');
  assert.equal(F.classifyFailure({ status: 'failed', error: 'the bot never found the exit' }), null);
  assert.equal(F.classifyFailure({ status: 'done' }), null);
});

test('the retry carries no provider hint (Gen rejects unknown params) and the reason is one sentence', () => {
  assert.deepEqual(F.retryParams({ url: 'u', skipProviders: ['modal'] }, { provider: 'runpod' }), { url: 'u' });
  const c = { kind: 'provider' as const, provider: 'runpod' };
  const s = F.plainWhy({ error: 'x' }, c);
  assert.match(s, /no free worker \(runpod\).*second try/);
  assert.equal(s.split('. ').length, 1);
});

test('no playtest runs past 30 minutes', () => {
  assert.equal(F.cappedRunMs(45 * 60_000), 30 * 60_000);
  assert.equal(F.cappedRunMs(10 * 60_000), 10 * 60_000);
});
