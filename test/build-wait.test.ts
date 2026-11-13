// A beta run behind a build that is still publishing waits for it (buildwait.ts; J, 2026-11-13: three beta runs failed
// "Stale verdict ... 120 s" while one 25-minute publish ran). Waiting is not failing; the build's end plays beta once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildwait-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [] }));

const { db, newId } = await import('../src/db.ts');
const W = await import('../src/buildwait.ts');
const { ensurePublishedCurrent } = await import('../src/servedpage.ts');

const run = (kind: string, status: string, options: Record<string, unknown> = {}) => {
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, status, 'x', JSON.stringify(['bwgame']), JSON.stringify(options), Date.now());
  return id;
};
const tip = '3544fa3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('build running: the check starts no republish and says waiting, not stale', async () => {
  let republished = 0;
  const r = await ensurePublishedCurrent({ tip, published: () => 'a6c1dff', republish: async () => { republished++; }, building: () => 'r_build1' });
  assert.equal(republished, 0);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.waiting, true); assert.match(r.why, /Waiting for build r_build1/); assert.doesNotMatch(r.why, /Stale verdict/); }
  // No build going: the old path (republish) still runs; current site: nothing at all.
  let pub = 'a6c1dff';
  const ok = await ensurePublishedCurrent({ tip, published: () => pub, republish: async () => { republished++; pub = '3544fa3'; }, building: () => null });
  assert.equal(ok.ok, true);
  assert.equal(republished, 1);
  assert.equal((await ensurePublishedCurrent({ tip, published: () => '3544fa3', republish: async () => {}, building: () => 'r_x' })).ok, true);
});

test('a wait is open while the build goes; the build ending plays beta once, for what the held run was for', () => {
  const build = run('build', 'running');
  assert.equal(W.runningBuildOf('bwgame'), build);
  const held = run('beta', 'cancelled', { play: 'milestone', plays: [{ scenario: 'smoke', criteria: ['c'] }], playtest: true });
  W.holdForBuild(held, 'bwgame', build);
  W.holdForBuild(held, 'bwgame', build); // once per run
  assert.equal(W.heldForBuild(held), true);
  assert.equal(W.heldForBuild(run('beta', 'done')), false);
  assert.equal(W.waitingOnBuild('bwgame')?.buildRun, build, 'a beta run asked for now would wait (startBeta guard)');
  const calls: any[] = [];
  const start = (p: string, o: any) => { calls.push([p, o]); return { id: 'r_new' }; };
  // Still building: nothing starts.
  assert.deepEqual(W.resumeAfterBuild(start, 'bwgame'), []);
  assert.equal(calls.length, 0);
  // The build ends: one run, with the held run's play.
  db.prepare("UPDATE runs SET status = 'done', finished = ? WHERE id = ?").run(Date.now(), build);
  assert.equal(W.waitingOnBuild('bwgame'), null, 'no build going: a new beta run is not held');
  assert.deepEqual(W.resumeAfterBuild(start, 'bwgame'), ['r_new']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].play, 'milestone');
  assert.equal(calls[0][1].plays.length, 1);
  assert.match(calls[0][1].focus, new RegExp(build));
  // Never twice.
  assert.deepEqual(W.resumeAfterBuild(start, 'bwgame'), []);
  assert.deepEqual(W.resumeAfterBuild(start), []);
  assert.equal(calls.length, 1);
});

test('several waiting runs of a product play once; a second build keeps them waiting', () => {
  const b1 = run('build', 'running');
  const b2 = run('build', 'running');
  W.holdForBuild(run('beta', 'cancelled', {}), 'bwgame', b1);
  W.holdForBuild(run('beta', 'cancelled', {}), 'bwgame', b1);
  const calls: string[] = [];
  const start = () => { calls.push('x'); return { id: 'r_n' }; };
  db.prepare("UPDATE runs SET status = 'done' WHERE id = ?").run(b1);
  assert.deepEqual(W.resumeAfterBuild(start, 'bwgame'), [], 'the other build still goes');
  db.prepare("UPDATE runs SET status = 'done' WHERE id = ?").run(b2);
  assert.equal(W.resumeAfterBuild(start).length, 1);
  assert.equal(calls.length, 1);
});
