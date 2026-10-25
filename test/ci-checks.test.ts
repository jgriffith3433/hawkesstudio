// CI on a branch fires twice (push + pull_request), both named "test". Walk-away must not stay red
// when the older push flaked and the newer PR check is green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ci-checks-'));
const { latestChecks, failureFromLog } = await import('../src/agents.ts');

test('latestChecks keeps the newest run per name and drops Tell the server', () => {
  const runs = latestChecks([
    { name: 'Tell the server', status: 'completed', conclusion: 'skipped', completed_at: '2026-10-20T02:22:25Z' },
    { name: 'test', status: 'completed', conclusion: 'failure', completed_at: '2026-10-20T02:22:21Z', html_url: 'https://ci/push' },
    { name: 'test', status: 'completed', conclusion: 'success', completed_at: '2026-10-20T02:22:25Z', html_url: 'https://ci/pr' },
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, 'success');
  assert.equal(runs[0].html_url, 'https://ci/pr');
});

test('latestChecks prefers a later failure too (a re-run that went red)', () => {
  const runs = latestChecks([
    { name: 'test', status: 'completed', conclusion: 'success', completed_at: '2026-10-20T01:00:00Z' },
    { name: 'test', status: 'completed', conclusion: 'failure', completed_at: '2026-10-20T02:00:00Z' },
  ]);
  assert.equal(runs[0].conclusion, 'failure');
});

test('failureFromLog pulls the failing tests and error lines out of a CI job log', () => {
  const log = [
    '2026-10-25T05:00:00.1234567Z ✔ fine (1.2ms)',
    '2026-10-25T05:00:01.1234567Z ✖ a thing that broke (12ms)',
    '2026-10-25T05:00:02.1234567Z ℹ tests 3',
    '2026-10-25T05:00:03.1234567Z ✖ failing tests:',
    '2026-10-25T05:00:03.1234567Z',
    '2026-10-25T05:00:03.1234567Z test/x.test.ts:9:1',
    '2026-10-25T05:00:03.1234567Z ✖ a thing that broke (12ms)',
    '2026-10-25T05:00:03.1234567Z   AssertionError: 1 !== 2',
    '2026-10-25T05:00:04.1234567Z ##[error]Process completed with exit code 1.',
  ].join('\n');
  const out = failureFromLog(log);
  assert.match(out, /failing tests:/);
  assert.match(out, /AssertionError: 1 !== 2/);
  assert.match(out, /Process completed with exit code 1/);
  assert.ok(!/2026-10-25T/.test(out), 'timestamps are stripped');
  assert.equal(failureFromLog('all good'), '');
});
