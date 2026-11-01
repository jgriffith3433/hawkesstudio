// A game Gen played in software is inconclusive; the step says Gen's own reason (why no GPU browser played it), so the
// fix (e.g. RunPod's balance) is on the card instead of a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-software-'));
const { softwareDetail } = await import('../src/pipeline.ts');

test('the inconclusive line carries Gen\'s reason, and falls back when Gen gives none', () => {
  const why = 'no GPU browser (RunPod skipped: RunPod is out of credit (balance $-0.01): add funds at runpod.io (Billing)), so it played on the Cloud Run CPU service';
  assert.equal(softwareDetail({ fps: { average: 2 }, softwareBecause: why }), `inconclusive: the browser ran in software (2 fps): ${why}; not reviewed`);
  assert.equal(softwareDetail({ fps: null }), 'inconclusive: the browser ran in software (? fps): no GPU server was free; not reviewed');
  assert.ok(softwareDetail({ softwareBecause: 'x'.repeat(5000) }).length < 400);
});
