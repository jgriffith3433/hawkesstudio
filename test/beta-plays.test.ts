// J (2026-10-19): "Play beta failed: No scenario "gloob" ... No scenario "music" (We renamed glob to Yooba)".
// 1. Renamed scenarios: an older task's name maps through the product's alias table, a name the build doesn't have is
//    skipped (never a failed step), and the stored names on changes are renamed once.
// 2. One build per run: a run holds the beta website copy while it plays, a new build (which resets the copy) waits for
//    it, and a playtest refuses to play a copy that no longer holds the run's build.
// A scratch database; no repo, Gen or browser is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-betaplays-'));
process.env.STUDIO_DATA = tmp;
process.env.STUDIO_BETA_TICK_MS = '10';

const { db, newId, J, parse } = await import('../src/db.ts');
const { resolveScenario, missingScenario, noteScenarios, knownScenarios, forgetScenarios, migrateScenarioAliases } = await import('../src/scenarios.ts');
const { holdBeta, betaPlayers, waitForBetaPlays, serveBeta, runBetaBuild, servedMismatch } = await import('../src/betaplay.ts');

const sick = { id: 'sickofit', scenarioAliases: { gloob: 'yooba', 'gloob-shop': 'yooba-shop' } };

test("Sick Of It's alias table maps the old Gloob scenarios to Yooba's", () => {
  const real = JSON.parse(fs.readFileSync(new URL('./fixture/j-products.json', import.meta.url), 'utf8')).products.find((p: any) => p.id === 'sickofit');
  assert.deepEqual(real.scenarioAliases, sick.scenarioAliases);
  assert.equal(resolveScenario(sick, 'gloob'), 'yooba');
  assert.equal(resolveScenario(sick, 'gloob-shop'), 'yooba-shop');
  assert.equal(resolveScenario(sick, 'music'), 'music');
  assert.equal(resolveScenario({}, 'gloob'), 'gloob');
  assert.equal(resolveScenario({ scenarioAliases: { a: 'b', b: 'a' } }, 'a'), 'b', 'a loop stops');
});

test("Gen's missing-scenario error gives the name and the game's own list", () => {
  const e = 'No scenario "music". This game has: smoke, level-1, level-2, imp-death, full, menus, layout, site';
  assert.deepEqual(missingScenario(e), { scenario: 'music', has: ['smoke', 'level-1', 'level-2', 'imp-death', 'full', 'menus', 'layout', 'site'] });
  assert.deepEqual(missingScenario('No scenario "x" (peer 1). This game has: none'), { scenario: 'x', has: [] });
  assert.equal(missingScenario('timed out after 300 s'), null);
});

test('a build\'s scenario list is kept per build, so the next playtest of it skips a name it lacks', () => {
  noteScenarios('sickofit', '169', [{ id: 'smoke' }, { id: 'yooba' }, { id: 'music' }]);
  noteScenarios('sickofit', '168', ['smoke', 'level-1']);
  assert.deepEqual(knownScenarios('sickofit', '169'), ['smoke', 'yooba', 'music']);
  assert.deepEqual(knownScenarios('sickofit', '168'), ['smoke', 'level-1']);
  assert.equal(knownScenarios('sickofit', '170'), null);
  assert.equal(knownScenarios('sickofit', null), null);
  // a list seen at one page of a build never speaks for another page (ph-origins' lore site root had only smoke)
  forgetScenarios();
  noteScenarios('phorigins', '4253899', ['smoke'], 'https://sites.x/ph/?playtest');
  assert.deepEqual(knownScenarios('phorigins', '4253899', 'https://sites.x/ph/'), ['smoke']);
  assert.equal(knownScenarios('phorigins', '4253899', 'https://sites.x/ph/play/game.html'), null);
});

test('the stored scenario names on changes are renamed once', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, product TEXT NOT NULL, findings TEXT NOT NULL, status TEXT NOT NULL, verify TEXT, created INTEGER NOT NULL)`);
  const add = (product: string, verify: unknown) => {
    const id = newId('c');
    db.prepare('INSERT INTO changes (id, product, findings, status, verify, created) VALUES (?, ?, ?, ?, ?, ?)').run(id, product, '[]', 'merged', verify ? J(verify) : null, Date.now());
    return id;
  };
  const a = add('sickofit', { scenario: 'gloob', sha: 'abc', options: { floor: 3 } });
  const b = add('sickofit', { scenario: 'gloob-shop' });
  const c = add('sickofit', { scenario: 'music' });
  const d = add('dod', { scenario: 'gloob' });
  const e = add('sickofit', null);
  const renamed = migrateScenarioAliases([sick, { id: 'dod' }]);
  assert.deepEqual(renamed.map((r) => [r.id, r.from, r.to]).sort(), [[a, 'gloob', 'yooba'], [b, 'gloob-shop', 'yooba-shop']].sort());
  const v = (id: string) => parse((db.prepare('SELECT verify FROM changes WHERE id = ?').get(id) as any).verify);
  assert.deepEqual(v(a), { scenario: 'yooba', sha: 'abc', options: { floor: 3 } });
  assert.equal(v(b).scenario, 'yooba-shop');
  assert.equal(v(c).scenario, 'music');
  assert.equal(v(d).scenario, 'gloob', 'another product keeps its names');
  assert.equal(v(e), null);
  assert.deepEqual(migrateScenarioAliases([sick]), [], 'idempotent');
});

test('a new beta build waits for the runs still playing the beta copy', async () => {
  const release = holdBeta('sickofit', 'r_old');
  const again = holdBeta('sickofit', 'r_old');
  assert.deepEqual(betaPlayers('sickofit', 'r_new'), ['r_old']);
  assert.deepEqual(betaPlayers('sickofit', 'r_old'), [], 'a run never waits for itself');
  const waits: string[] = [];
  let done = false;
  const w = waitForBetaPlays('sickofit', 'r_new', (d) => waits.push(d)).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false);
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false, 'nested holds: still held');
  again();
  assert.deepEqual(await w, ['r_old']);
  assert.match(waits[0], /r_old/);
  assert.deepEqual(await waitForBetaPlays('sickofit', 'r_new'), [], 'nothing playing: no wait');
});

test('playtests of the beta copy take turns (one port)', async () => {
  const order = [] as string[];
  const first = await serveBeta('sickofit');
  const second = serveBeta('sickofit').then((rel) => { order.push('second'); return rel; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(order.length, 0);
  order.push('first done');
  first();
  (await second)();
  assert.deepEqual(order, ['first done', 'second']);
  (await serveBeta('sickofit'))();
});

test("a playtest plays only the build its run built or kept, and says so loudly otherwise", () => {
  const run = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(run, 'beta', 'running', 'beta sickofit', J(['sickofit']), J({}), Date.now());
  assert.equal(runBetaBuild(run, 'sickofit'), null);
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('s'), run, 'sickofit', 'build', 'unity', 'skipped', 'no changes since the last build (Game/v169)', J({ version: 169, served: { sha: 'a'.repeat(40), version: '169' } }), Date.now());
  const expected = runBetaBuild(run, 'sickofit');
  assert.deepEqual(expected, { sha: 'a'.repeat(40), version: '169' });
  const v169 = { branch: 'beta', sha: 'a'.repeat(40), build: '169' };
  assert.equal(servedMismatch(expected, v169, [169]), null);
  assert.equal(servedMismatch(expected, v169, []), null, 'no Game folder to look at: the build record decides');
  assert.match(servedMismatch(expected, null, [])!, /has no beta build now/);
  assert.match(servedMismatch(expected, { branch: 'beta', sha: 'b'.repeat(40), build: '170' }, [170])!, /Game\/v169 of beta aaaaaaa.*now holds Game\/v170 of beta bbbbbbb/);
  assert.match(servedMismatch(null, v169, [112])!, /Game\/v169, but the served folder only has Game\/v112/);
  assert.equal(servedMismatch(null, null, []), null, 'no build at all: the playtest\'s own "isn\'t built yet"');
});
