// A separate run judges the builder's work (acceptance.ts; the owner's gaps list, 2026-11-08): Gen's review and Studio's
// own judge must both say yes, either "no" is a no, and the judge never sees the builder's account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-judge-'));
const { judgeCriteria, combine } = await import('../src/acceptance.ts');

const c = (met: any, evidence = 'e') => ({ criterion: 'x', met, evidence });

test('combine: yes only when both say yes', () => {
  assert.equal(combine(c('yes'), c('yes')), 'yes');
  assert.equal(combine(c('yes'), c('unclear')), 'unclear');
  assert.equal(combine(c('unclear'), c('no')), 'no');
  assert.equal(combine(c('yes'), c('no')), 'no');
  assert.equal(combine(undefined, c('yes')), 'yes');
});

test("judgeCriteria runs the separate judge even when the review judged, and combines", async () => {
  const crit = ['The shop opens', 'Prices show'];
  const seen: any[] = [];
  const judge = async (k: string[], review: any, playtest: any) => {
    seen.push({ k, review, playtest });
    return [{ criterion: k[0], met: 'yes' as const, evidence: 'shop panel at 12s' }, { criterion: k[1], met: 'unclear' as const, evidence: 'never opened the list' }];
  };
  const review = { criteria: [{ criterion: crit[0], met: 'yes', evidence: 'frame 3' }, { criterion: crit[1], met: 'yes', evidence: 'frame 5' }] };
  const r = await judgeCriteria(crit, review, { outcome: 'passed' }, judge);
  assert.equal(seen.length, 1, 'the separate judge always runs');
  assert.deepEqual(r.map((x) => x.met), ['yes', 'unclear']);
  assert.match(r[1].evidence!, /review: yes.*separate judge: unclear/);
  // Without the review's own answer, the separate judge's stands.
  const alone = await judgeCriteria(crit, {}, {}, judge);
  assert.deepEqual(alone.map((x) => x.met), ['yes', 'unclear']);
});
