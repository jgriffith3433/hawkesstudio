// I Can Be AI (2026-11-08): its saved `beta` was the address Studio itself publishes at, so it counted as "a beta of its
// own": no build, no site, missing from the previews list, and its playtests read an old publish's scenario list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hosted-beta-'));
process.env.STUDIO_MAIL = 'off';

test("Studio's own publish address is not a beta of the project's own", async () => {
  const { studioSiteAddress, hasOwnBeta, hostedBeta } = await import('../src/config.ts');
  const { buildsOf } = await import('../src/builds.ts');
  const hosted = 'https://sites.hawkesgen.ai/o/j-studio-4f12/i-can-be-ai/';
  assert.ok(studioSiteAddress(hosted));
  assert.ok(studioSiteAddress('https://sites.hawkesgen.ai/b/star-skipper'));
  assert.ok(!studioSiteAddress('https://studio-beta.hawkesgen.ai'));
  assert.ok(!studioSiteAddress('https://beta.example.com/'));
  assert.equal(hasOwnBeta({ beta: hosted }), false);
  assert.equal(hasOwnBeta({ beta: 'https://beta.example.com/' }), true);
  assert.equal(hostedBeta({ engine: 'web', beta: hosted } as any), true);
  assert.equal(hostedBeta({ engine: 'web', beta: 'https://beta.example.com/' } as any), false);
  const p = { id: 'i-can-be-ai', engine: 'web', github: 'a/b', beta: hosted } as any;
  assert.equal(buildsOf(p).length, 1);
  assert.equal(buildsOf({ ...p, beta: 'https://beta.example.com/' }).length, 0);
});

test('a beta published again forgets the scenario lists seen for that product', async () => {
  const S = await import('../src/scenarios.ts');
  S.forgetScenarios();
  S.noteScenarios('i-can-be-ai', 'a730f90', ['smoke', 'day'], 'https://x.test/a/');
  S.noteScenarios('other', 'a730f90', ['smoke'], 'https://x.test/a/');
  assert.deepEqual(S.knownScenarios('i-can-be-ai', 'a730f90', 'https://x.test/a/'), ['smoke', 'day']);
  S.forgetProductScenarios('i-can-be-ai');
  assert.equal(S.knownScenarios('i-can-be-ai', 'a730f90', 'https://x.test/a/'), null);
  assert.deepEqual(S.knownScenarios('other', 'a730f90', 'https://x.test/a/'), ['smoke']);
});

test('recording a ready beta clears the product\'s scenario lists', async () => {
  const S = await import('../src/scenarios.ts');
  const P = await import('../src/previews.ts');
  S.noteScenarios('some-game', 'abc1234', ['smoke'], 'https://x.test/');
  P.noteBeta('some-game', { status: 'ready', at: Date.now(), sha: 'def5678' });
  assert.equal(S.knownScenarios('some-game', 'abc1234', 'https://x.test/'), null);
});
