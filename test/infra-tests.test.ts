// Gen's test check in Studio (J, 2026-11-08): failing tests read from node's output, compared with beta's own result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingTests, compareFailures, describeTests } from '../src/infra-tests.ts';
import { getInfra } from '../src/config.ts';

const spec = `✔ fine (1ms)
✖ cancelling closes the request (12ms)
✖ new break (3ms)
ℹ fail 2

✖ failing tests:

✖ cancelling closes the request (12ms)
  Error: x`;

test('failing tests are read from spec and TAP output', () => {
  assert.deepEqual(failingTests(spec), ['cancelling closes the request', 'new break']);
  assert.deepEqual(failingTests('ok 1 - a\nnot ok 2 - b\n'), ['b']);
});

test('only failures beta lacks are new; known ones stay visible', () => {
  const c = compareFailures(['cancelling closes the request', 'new break'], ['cancelling closes the request', 'gone']);
  assert.deepEqual(c.fresh, ['new break']);
  assert.deepEqual(c.known, ['cancelling closes the request']);
  assert.deepEqual(c.fixed, ['gone']);
  assert.match(describeTests(c, 90, false), /FAILED in 90 s .*new failing test: "new break".*already failing on beta/);
  assert.match(describeTests(compareFailures(['a'], ['a']), 5, true), /passed in 5 s .*already failing on beta \(not blocking\): "a"/);
});

test('Gen runs offline with provider mocks', () => {
  const g = getInfra('hawkesgen');
  assert.equal(g.checkEnv?.HAWKESGEN_MOCK_PROVIDERS, '1');
  assert.equal(g.baselineCheck, 'npm test');
});
