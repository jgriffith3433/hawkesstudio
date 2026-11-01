// 2026-11-01: projects whose saved playtests were all @live (The Place Department, Dose Of Destruction, Hawkes Games)
// had nothing to play on beta, so beta runs and the go-live page's "Playtest this commit" played nothing and every
// go-live stayed blocked on "beta hasn't been playtested". A beta run now plays the first desktop @live playtest on beta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-betaplaytestof-'));
const { betaPlaytestOf } = await import('../src/pipeline.ts');

test("a project's own @local desktop playtest is what beta plays", () => {
  const p: any = { playtests: [{ scenario: 'smoke', where: 'live' }, { scenario: 'smoke', where: 'local', device: 'phone' }, { scenario: 'match', where: 'local' }] };
  assert.deepEqual(betaPlaytestOf(p), { scenario: 'match', where: 'local' });
});

test('a project with only @live playtests plays its first desktop one on beta', () => {
  const p: any = { playtests: [{ scenario: 'smoke', where: 'live', device: 'phone' }, { mode: 'site', where: 'live', timeout: 300 }] };
  assert.deepEqual(betaPlaytestOf(p), { mode: 'site', where: 'local', timeout: 300 });
  assert.equal(p.playtests[1].where, 'live', 'the saved playtest is left as it is');
});

test('a project with no desktop playtest plays nothing', () => {
  assert.equal(betaPlaytestOf({ playtests: [{ scenario: 'smoke', where: 'live', device: 'phone' }] } as any), undefined);
  assert.equal(betaPlaytestOf({ playtests: [] } as any), undefined);
});
