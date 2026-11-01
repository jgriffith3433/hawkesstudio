// A Unity project whose build publishes into a sub-folder (site "YoobaLand", publish.page "site") is played at that
// folder on its beta site: the root has no game page, so the playtest waited 150 s for window.hawkesPlaytest
// (2026-11-01, yoobaland city@local).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-beta-page-'));
process.env.STUDIO_MAIL = 'off';

const root = 'https://sites.hawkesgen.ai/o/j-studio-4f12/yoobaland/';

test("the resolved playtest URL includes the project's site sub-path", async () => {
  const { betaPageUrl } = await import('../src/pipeline.ts');
  assert.equal(betaPageUrl(root, { site: 'YoobaLand', repo: 'acme/yooba', github: 'acme/yooba' }), `${root}YoobaLand/`);
  assert.equal(betaPageUrl(root.slice(0, -1), { site: 'YoobaLand/' }), `${root}YoobaLand/`);
});

test('a site that is just the repo is not a sub-folder', async () => {
  const { betaPageUrl } = await import('../src/pipeline.ts');
  for (const p of [{ site: 'acme/yooba', github: 'acme/yooba' }, { site: 'yooba', github: 'acme/yooba' }, { site: 'hawkesgen', repo: 'hawkesgen' }, {}, { site: '.' }]) {
    assert.equal(betaPageUrl(root, p), root, JSON.stringify(p));
  }
});
