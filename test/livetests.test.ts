// The Playtests page's finished tiles (src/livetests.ts): a finished playtest.run job becomes its outcome, counts and video.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishedTile } from '../src/livetests.ts';

test('livetests: a finished job is its outcome, problems, console errors and video', () => {
  const t: any = finishedTile({
    id: 'j_1', project: 'doseofdestruction', status: 'done', started: 1000, finished: 61_000, params: { scenario: 'match', url: 'http://x/' },
    outputs: [{ asset: 'a_shot', mime: 'image/jpeg' }, { asset: 'a_vid', mime: 'video/mp4' }],
    result: { outcome: 'won', seconds: 58, device: 'desktop', fps: { average: 59.2 }, problems: [{ severity: 'bug', message: 'fell through' }], console: { errors: 2 } },
  });
  assert.equal(t.outcome, 'won');
  assert.equal(t.video, 'a_vid');
  assert.equal(t.problems.count, 1);
  assert.equal(t.console.errors, 2);
  assert.equal(t.live, false);
  assert.equal(t.scenario.id, 'match');
  const f: any = finishedTile({ id: 'j_2', project: 'p', status: 'failed', error: 'no browser', created: 5, params: {}, outputs: [], result: null });
  assert.equal(f.outcome, 'error');
  assert.equal(f.step, 'no browser');
  assert.equal(f.video, null);
});
