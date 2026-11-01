// A project saved back in its mapped form (repo the folder, github the owner/name) is still a repo agents work on: on
// 2026-11-01 Hawkes Gen's project in J's Studio was stored that way and every agent change failed before it started
// with "products.json has no GitHub repo for hawkesgen" (agents.ts repoFor, repos.ts repoMap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-added-game-slug-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
delete process.env.STUDIO_PRODUCTS;
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'products.json'), JSON.stringify({ products: [
  { id: 'hawkes-gen', name: 'Hawkes Gen', engine: 'web', kind: 'app', live: 'https://hawkesgen.ai', repo: 'hawkesgen', github: 'jgriffith3433/hawkesgen', site: 'hawkesgen', checksCmd: 'npm test', about: 'Gen.', contract: false, playtests: [], story: [] },
  { id: 'space-game', name: 'Space Game', engine: 'web', live: 'https://acme.github.io/space-game/', repo: 'acme/space-game', about: 'A game.', contract: false, playtests: [], story: [] },
  { id: 'old-site', name: 'Old Site', engine: 'web', live: 'https://old.example/', about: 'No repo.', contract: false, playtests: [], story: [] },
] }));

test('a project stored with repo as its folder and github as owner/name keeps its repo', async () => {
  const C = await import('../src/config.ts');
  const { repoMap } = await import('../src/repos.ts');
  assert.equal(C.repoSlugOf({ repo: 'hawkesgen', github: 'jgriffith3433/hawkesgen' }), 'jgriffith3433/hawkesgen');
  assert.equal(C.repoSlugOf({ repo: 'acme/space-game' }), 'acme/space-game');
  assert.equal(C.repoSlugOf({ repo: 'old-site' } as any), null);
  assert.deepEqual(C.addedRepoFolders(), { hawkesgen: 'jgriffith3433/hawkesgen', 'space-game': 'acme/space-game' });
  assert.equal(repoMap().hawkesgen, 'jgriffith3433/hawkesgen');
  const gen = C.getProduct('hawkes-gen');
  assert.equal(gen.repo, 'hawkesgen');
  assert.equal(gen.github, 'jgriffith3433/hawkesgen');
  assert.deepEqual(gen.checks, [{ dir: 'hawkesgen', cmd: 'npm test' }]);
});
