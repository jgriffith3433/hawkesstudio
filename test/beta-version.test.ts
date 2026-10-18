// Unity beta builds never reuse a Game/v<n>: the beta website copy is reset to live's site before every build, so
// a deploy method's "latest + 1" alone would pick live + 1 each time and the browser would play its cached old build.
// Two beta builds in a row of the same product must land in different folders. No real repo or database is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-betaversion-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const unity = (id: string, versionEnv?: string) => ({
  id, name: id, framing: 'test', engine: 'unity', repo: `${id}-unity`, site: `${id}-site`, live: 'http://127.0.0.1:9/Game/',
  build: { project: `${id}-unity`, site: `${id}-site`, method: 'Deploy.Full', ...(versionEnv ? { versionEnv } : {}) },
  local: { serve: 'static', dir: `${id}-site`, port: 8799, path: '/Game/' }, playtests: [], story: [], about: 'A fixture.',
});
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [unity('envgame', 'BUILD_VERSION'), unity('placegame')] }));

const { pinBetaVersion, pruneGameVersions, gameVersions } = await import('../src/beta.ts');
const { getProduct } = await import('../src/config.ts');
const { db, newId, J } = await import('../src/db.ts');

/** The beta copy as resetBetaSite leaves it: live's site, Game/v112 and the template folder. */
function liveCopy(id: string) {
  const folder = path.join(tmp, 'copies', id);
  fs.rmSync(folder, { recursive: true, force: true });
  for (const v of ['v112', 'v0000000']) fs.mkdirSync(path.join(folder, 'Game', v, 'Build'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Game', 'index.html'), '<script>window.GAME_BUILD = "v112"</script>');
  return folder;
}
/** A finished beta build step, as pipeline.ts finishBuild records it. */
const built = (product: string, version: number) => db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started, finished) VALUES (?, 'r_test', ?, 'build', 'unity', 'done', ?, ?, ?)`)
  .run(newId('s'), product, J({ version: String(version), beta: 'abc' }), Date.now(), Date.now());

test('a deploy method that reads the number gets a new one on every beta build', () => {
  const p = getProduct('envgame');
  const first = pinBetaVersion(p, liveCopy(p.id));
  assert.deepEqual(first, { version: 113, env: { BUILD_VERSION: '113' } });
  built(p.id, 113);
  const second = pinBetaVersion(p, liveCopy(p.id));
  assert.deepEqual(second, { version: 114, env: { BUILD_VERSION: '114' } });
  assert.deepEqual(gameVersions(liveCopy(p.id)), [112], 'no placeholder when the method takes the number');
});

test('a deploy method that picks latest + 1 itself is steered there by a placeholder', () => {
  const p = getProduct('placegame');
  const a = liveCopy(p.id);
  assert.deepEqual(pinBetaVersion(p, a), { version: 113 }, 'the first build is live + 1 anyway');
  assert.deepEqual(gameVersions(a), [112]);
  built(p.id, 113);

  const b = liveCopy(p.id);
  const second = pinBetaVersion(p, b);
  assert.deepEqual(second, { version: 114, placeholder: true });
  assert.equal(Math.max(...gameVersions(b)) + 1, 114, "the method's latest + 1 is the pinned number");
  // The method builds v114 and deletes "the old version" (the placeholder); Studio then removes live's folder.
  fs.rmSync(path.join(b, 'Game', 'v113'), { recursive: true });
  fs.mkdirSync(path.join(b, 'Game', 'v114', 'Build'), { recursive: true });
  pruneGameVersions(b, 114);
  assert.deepEqual(gameVersions(b), [114]);
  assert.ok(fs.existsSync(path.join(b, 'Game', 'v0000000')), 'template folders stay');
  built(p.id, 114);
  assert.equal(pinBetaVersion(p, liveCopy(p.id)).version, 115);
});

test('a live site ahead of every beta build wins', () => {
  const p = getProduct('envgame');
  const folder = liveCopy(p.id);
  fs.mkdirSync(path.join(folder, 'Game', 'v130'));
  assert.equal(pinBetaVersion(p, folder).version, 131);
});
