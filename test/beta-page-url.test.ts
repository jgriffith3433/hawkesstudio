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

// 2026-11-03: yoobaland's smoke@local failed every time: site "YoobaLand" equals its repo, so betaPageUrl returned the
// beta root, and with publish.page "site" that root has no game page. The game is the published-into project's page.
const yoobaland = {
  site: 'YoobaLand', repo: 'YoobaLand', github: 'jgriffith3433/YoobaLand',
  builds: [{ id: 'web', tool: 'unity', target: 'web', publish: { project: 'yoobalandgame', path: 'Game/', commit: true, page: 'site' as const } }],
};
const gameRoot = 'https://sites.hawkesgen.ai/o/j-studio-4f12/yoobalandgame/';

test('a build that keeps the website\'s own page is played at the website\'s beta page', async () => {
  const { siteBuildPublish, pagePathUrl } = await import('../src/pipeline.ts');
  const into = siteBuildPublish(yoobaland.builds as any);
  assert.deepEqual(into, { project: 'yoobalandgame', path: 'Game/' });
  assert.equal(pagePathUrl(gameRoot, into!.path), `${gameRoot}Game/`);
  assert.equal(pagePathUrl(gameRoot.slice(0, -1), '/Game'), `${gameRoot}Game/`);
  assert.equal(pagePathUrl(gameRoot, ''), gameRoot);
});

test('other builds have no page of their own to play elsewhere', async () => {
  const { siteBuildPublish } = await import('../src/pipeline.ts');
  assert.equal(siteBuildPublish(undefined), null);
  assert.equal(siteBuildPublish([]), null);
  // mounted (no page "site"), or committed without keeping the site's page: the project's own beta root is the page
  assert.equal(siteBuildPublish([{ id: 'web', publish: { project: 'site', path: 'Game/' } }] as any), null);
  assert.equal(siteBuildPublish([{ id: 'web', publish: { project: 'site', path: 'Game/', commit: true } }] as any), null);
});

// 2026-11-08: ph-origins (live https://phorigins.com/play/game.html) played its beta root, the lore site, whose
// contract has only smoke, so every other scenario skipped. The game page is the live path under the beta root.
test("an added game is played at its live page's path under the beta root", async () => {
  const { betaPageUrl } = await import('../src/pipeline.ts');
  const phroot = 'https://sites.hawkesgen.ai/o/j-studio-4f12/ph-origins/';
  const ph = { site: 'phoriginswebsite', repo: 'phoriginswebsite', github: 'jgriffith3433/phoriginswebsite', live: 'https://phorigins.com/play/game.html' };
  assert.equal(betaPageUrl(phroot, ph), `${phroot}play/game.html`);
  // GitHub Pages' project page: the repo's name is the beta root itself
  assert.equal(betaPageUrl(root, { github: 'acme/yooba', live: 'https://acme.github.io/yooba/' }), root);
  assert.equal(betaPageUrl(root, { github: 'acme/yooba', live: 'https://acme.github.io/yooba/play/' }), `${root}play/`);
  assert.equal(betaPageUrl(root, { github: 'acme/yooba', live: 'https://yooba.com/' }), root);
  assert.equal(betaPageUrl(root, { github: 'acme/yooba', live: 'not a url' }), root);
});
