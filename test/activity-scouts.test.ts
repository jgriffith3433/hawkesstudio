// Scouts in Activity (src/activity.ts scoutRow): one row each with status, partial, a shortened question and the origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-act-scouts-'));
const { scoutRow } = await import('../src/activity.ts');

test('a scout becomes one Activity row', () => {
  const base = { id: 'x_1', product: 'nope', question: 'what\n would   it take? ' + 'a'.repeat(300), cost: 0.4, origin: null, created: 1000, finished: 5000 };
  const run = scoutRow({ ...base, status: 'running', detail: 'reading', finished: null });
  assert.equal(run.status, 'running');
  assert.ok(run.question.length <= 160 && !run.question.includes('\n'));
  assert.equal(scoutRow({ ...base, status: 'done', detail: 'partial report: out of turns', report: 'r' }).status, 'partial');
  const f = scoutRow({ ...base, status: 'failed', detail: 'no report: error_max_turns' });
  assert.equal(f.status, 'failed');
  assert.match(f.detail!, /error_max_turns/);
});
