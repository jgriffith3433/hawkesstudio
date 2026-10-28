// A page left open on an older Unity beta build keeps working when beta moves on (J's iPhone on Game/v54 after v55
// landed): the beta site keeps publishing the previous build's Game/v<n> next to the new one (older ones for a day),
// beta pages can ask which build beta serves now, and an auto-caught 404 under an older Game/v<n> is a "stale page"
// (won't-fix, never an agent), not a game bug. Scratch folders and database; nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stalepage-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PREVIEWS = path.join(tmp, 'previews');
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ previews: { yl: 'ylgame' }, products: [{
  id: 'ylgame', name: 'Stale test', framing: 'test', engine: 'unity', repo: 'ylgame-unity', site: 'ylgame-site', live: 'http://127.0.0.1:9/',
  build: { project: 'ylgame-unity', site: 'ylgame-site', method: 'Deploy.Full' },
  local: { serve: 'static', dir: 'ylgame-site', port: 8797, path: '/' }, playtests: [], story: [], about: 'A fixture.',
}] }));

const previews = await import('../src/previews.ts');
const beta = await import('../src/beta.ts');
const br = await import('../src/bugreport.ts');
const { getProduct } = await import('../src/config.ts');
const { db } = await import('../src/db.ts');

const p = getProduct('ylgame');
const copy = beta.betaSiteFolder(p);
const published = path.join(process.env.STUDIO_PREVIEWS, 'ylgame', 'beta');
const DAY = previews.KEEP_OLD_BUILD_MS;

/** A beta build landing in the beta website copy (only its own Game/v<n>, as the build server leaves it), then published. */
async function land(v: number, sha: string) {
  fs.rmSync(path.join(copy, 'Game'), { recursive: true, force: true });
  const bundles = path.join(copy, 'Game', `v${v}`, 'YoobaLand', 'StreamingAssets', 'aa', 'WebGL');
  fs.mkdirSync(bundles, { recursive: true });
  fs.writeFileSync(path.join(bundles, 'loading_scene_scenes_all_a7df.bundle'), `bundle of v${v}`);
  fs.writeFileSync(path.join(copy, 'Game', `v${v}`, 'index.html'), `<html><head></head><body>v${v}</body></html>`);
  fs.writeFileSync(path.join(copy, 'index.html'), `<html><head></head><body><script src="Game/v${v}/loader.js"></script></body></html>`);
  beta.saveBetaBuild(p, { sha, base: 'b', ok: true, at: Date.now(), version: String(v) });
  const r = await previews.buildPreview('ylgame');
  assert.equal(r?.status, 'ready', r?.detail);
}
const versions = () => beta.gameVersions(published).sort((a, b) => a - b);
const state = () => JSON.parse(fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'previews.json'), 'utf8'));

test('which old builds stay: always the one before the current, older ones for a day', () => {
  const now = 10 * DAY;
  assert.deepEqual(previews.keptGameVersions([55], [54], {}, now), { 54: now }, 'the previous build stays, old from now');
  assert.deepEqual(previews.keptGameVersions([56], [55, 54], { 54: now - 1000 }, now), { 55: now, 54: now - 1000 }, 'both within the day');
  assert.deepEqual(previews.keptGameVersions([56], [55, 54], { 55: now - 2 * DAY, 54: now - 3 * DAY }, now), { 55: now - 2 * DAY }, 'after a day only the previous one is left');
  assert.deepEqual(previews.keptGameVersions([55], [55], {}, now), {}, 'nothing old');
  assert.deepEqual(previews.keptGameVersions([55], [60], {}, now), {}, 'never a newer one');
  assert.deepEqual(previews.keptGameVersions([], [54], {}, now), {}, 'nothing published: nothing to keep next to');
  assert.deepEqual(previews.keptGameVersions([191], [190, 189, 10], {}, now), { 190: now }, 'versions with no recorded time are not leased a fresh day');
});

test('a new beta build keeps the previous build published, cleaned after a day', async () => {
  fs.mkdirSync(copy, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: copy });
  await land(54, 'aaaaaaa1');
  assert.deepEqual(versions(), [54]);
  assert.equal(previews.betaNow('ylgame')?.version, '54');

  await land(55, 'bbbbbbb2');
  assert.deepEqual(versions(), [54, 55], 'the open v54 page still finds its files');
  assert.equal(fs.readFileSync(path.join(published, 'Game', 'v54', 'YoobaLand', 'StreamingAssets', 'aa', 'WebGL', 'loading_scene_scenes_all_a7df.bundle'), 'utf8'), 'bundle of v54');
  const oldPage = fs.readFileSync(path.join(published, 'Game', 'v54', 'index.html'), 'utf8');
  assert.equal(oldPage.split('data-hawkes-report').length - 1, 1, 'the kept page keeps its one report button (its own build in it)');
  assert.match(oldPage, /&quot;version&quot;:&quot;54&quot;|"version":"54"/);
  assert.match(fs.readFileSync(path.join(published, 'index.html'), 'utf8'), /"version":"55"/, 'new pages know their build');
  assert.deepEqual(previews.betaNow('ylgame'), { sha: 'bbbbbbb', version: '55', at: previews.betaNow('ylgame')!.at });

  await land(56, 'ccccccc3');
  assert.deepEqual(versions(), [54, 55, 56], 'within a day both older builds stay');

  // A day later: v54 goes, v55 (the one before the current) stays.
  const s = state();
  s.ylgame.kept = { 54: Date.now() - 2 * DAY, 55: Date.now() - 2 * DAY };
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'previews.json'), JSON.stringify(s));
  await land(57, 'ddddddd4');
  assert.deepEqual(versions(), [56, 57], 'v54 and v55 were old for more than a day; v56, the one before the current, stays');
  await land(58, 'eeeeeee5');
  assert.deepEqual(versions(), [56, 57, 58], 'v56 has been old for less than a day');
});

test('a 404 under an older Game/v<n> is a stale page, not a game bug', async () => {
  const msg = 'RemoteProviderException : Unable to load asset bundle from : https://yl.hawkesgen.ai/Game/v54/YoobaLand/StreamingAssets/aa/WebGL/loading_scene_scenes_all_a7df.bundle';
  assert.deepEqual(br.stalePage(msg, 55), { version: 54, current: 55 });
  assert.equal(br.stalePage(msg, 54), null, "beta's current build: a real problem");
  assert.equal(br.stalePage(msg, null), null, 'no Unity build published');
  assert.equal(br.stalePage('TypeError: boss is undefined at https://yl.hawkesgen.ai/Game/v54/Build/x.js', 55), null, 'not a load failure');
  assert.deepEqual(br.stalePage('GET https://yl.hawkesgen.ai/Game/v53/Build/x.data 404 (Not Found)', 58), { version: 53, current: 58 });

  // beta serves v58 now (the test above).
  const page = { url: 'https://yl.hawkesgen.ai/', device: { ua: 'iPhone', touch: true }, build: { product: 'ylgame', sha: 'aaaaaaa', ref: 'beta (build Game/v54)', version: '54' } };
  const r1: any = await br.fileAutoError('ylgame', { ...page, error: { kind: 'console', message: msg.replace('v54', 'v53') } }, '10.1.0.1');
  assert.equal(r1.stale, true);
  const r2: any = await br.fileAutoError('ylgame', { ...page, error: { kind: 'console', message: msg } }, '10.1.0.2');
  assert.equal(r2.id, r1.id, 'one stale-page finding per product; seen again');
  const f = db.prepare('SELECT * FROM findings WHERE id = ?').get(r1.id) as any;
  assert.equal(f.status, 'wontfix', 'never starts an agent');
  assert.equal(f.area, 'stale page');
  assert.equal(f.seen, 2);
  assert.match(f.note, /Stale page, not a game bug.*Game\/v54.*Game\/v58/);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE severity IN ('bug', 'blocker')`).get() as any).n, 0, 'no game bug filed');

  // A change's own preview is its build, not beta's: a real error there.
  const r3: any = await br.fileAutoError('ylgame', { ...page, build: { ...page.build, change: 'c_1234' }, error: { kind: 'console', message: msg } }, '10.1.0.3');
  assert.ok(!r3.stale);

  // One filed before stale pages were told apart: the PM loop sees it for what it is.
  const old = db.prepare('SELECT * FROM findings WHERE id = ?').get(r3.id) as any;
  assert.equal(await br.staleReport(old), null, "the change's own error stays a bug");
  assert.deepEqual(await br.staleReport({ ...old, report: JSON.stringify({ ...JSON.parse(old.report), build: page.build }) }), { version: 54, current: 58 });
  assert.equal(await br.staleReport({ ...old, source: 'J' }), null, "J's own reports are his words, never reclassified");
});
