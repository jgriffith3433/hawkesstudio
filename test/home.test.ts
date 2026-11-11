// The Home tab (src/home.ts, dashboard/home.js): per-game counts of needs-you, running and ready-to-ship, refreshed by
// the push stream and never by a timer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-home-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'hometest', name: 'Home test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8798, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const { home } = await import('../src/home.ts');
const { loadProducts } = await import('../src/config.ts');
const { db } = await import('../src/db.ts');

test('home counts per game and totals', async () => {
  const p = loadProducts()[0];
  db.prepare(`INSERT INTO tasks (id, item, product, title, request, status, created) VALUES ('t_home1', 'i_x', ?, 'Shipped soon', 'r', 'verified', ?)`).run(p.id, Date.now());
  const h = await home();
  const g = h.games.find((x) => x.id === p.id)!;
  assert.equal(g.ready, 1);
  assert.deepEqual(g.readyList, ['Shipped soon']);
  assert.equal(g.running, 0);
  assert.equal(h.games.length, loadProducts().length);
  assert.ok(h.totals.ready >= 1);
});

test('the page refreshes from the stream and has no timer or poll', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'home.js'), 'utf8');
  assert.match(src, /studioStream\.on\(\[[^\]]*'inbox'/);
  assert.ok(!/setInterval|setTimeout/.test(src));
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'style.css'), 'utf8');
  assert.match(css, /@media \(max-width: 480px\) \{ \.home-games/);
});

test('an inbox item with no game gets a Studio card, so the total always has a list', async () => {
  const h = await home();
  const studio = h.games.find((x) => x.id === 'studio');
  assert.equal(h.totals.needs, h.games.reduce((n, g) => n + g.needs, 0));
  if (h.loose) { assert.ok(studio); assert.equal(studio!.needs, h.loose); } else assert.equal(studio, undefined);
});

test('Home counts visible changes on beta with no capture; docs, test and server-only changes are never counted', async () => {
  const { isVisibleChange } = await import('../src/agents.ts');
  assert.equal(isVisibleChange(['src/ui/menu.tsx', 'public/hero.png']), true);
  assert.equal(isVisibleChange(['docs/a.md', 'test/a.test.ts']), false);
  assert.equal(isVisibleChange(['server/routes.ts', 'api/user.js']), false);
  assert.equal(isVisibleChange(['src/server.ts']), true, 'only server folders are excluded, not any file named server');
  assert.equal(isVisibleChange(['Assets/Scenes/Main.unity'], { unity: true }), true);
  assert.equal(isVisibleChange(['Assets/Editor/Tool.cs', 'Assets/Tests/A.cs'], { unity: true }), false);
  assert.equal(isVisibleChange(['src/ui/menu.tsx'], { infra: true }), false);
  const p = loadProducts()[0];
  const mk = (id: string, verify: any, status = 'merged') => db.prepare(`INSERT INTO changes (id, product, findings, status, title, verify, created, merged_at) VALUES (?, ?, '[]', ?, ?, ?, ?, ?)`).run(id, p.id, status, id, JSON.stringify(verify), Date.now(), Date.now() - 1000);
  mk('c_vis1', { visible: true });
  mk('c_vis2', { visible: true });
  mk('c_docs', { visible: false });
  mk('c_old', {});
  mk('c_open', { visible: true }, 'ready');
  const g = (await home()).games.find((x) => x.id === p.id)!;
  assert.equal(g.uncaptured, 2);
  assert.deepEqual(g.uncapturedList.sort(), ['c_vis1', 'c_vis2']);
});

test('a milestone play attaches its shots and clip to each visible change it covered, and the count drops', async () => {
  const { attachMilestoneCapture, getChange } = await import('../src/agents.ts');
  const { captureOfSteps } = await import('../src/pipeline.ts');
  const p = loadProducts()[0];
  const steps = [
    { kind: 'playtest', name: 'smoke@local', status: 'done', job: 'j1' },
    { kind: 'review', name: 'smoke@local', status: 'done', data: { frames: [{ asset: 'a_desk1', t: 3, reason: 'menu' }], motion: { sheets: [{ asset: 'a_sheet', start: 1, end: 4, reason: 'walk' }] } } },
    { kind: 'review', name: 'smoke@local:phone', status: 'done', data: { frames: [{ asset: 'a_phone1', t: 2 }] } },
  ];
  const cap = captureOfSteps('r_x', steps, 'a_clip')!;
  assert.equal(cap.phone, true);
  assert.equal(cap.video, 'a_clip');
  assert.equal(cap.shots.length, 2);
  assert.ok(cap.shots[1].reason?.includes('390x844') && cap.shots[1].phone);
  assert.equal(captureOfSteps('r_y', [{ kind: 'playtest', name: 's', status: 'done' }], null), null, 'no shots and no clip: nothing attached');
  assert.deepEqual(await attachMilestoneCapture({ ...cap, shots: [], video: null }, p.id), []);
  const ids = (await attachMilestoneCapture(cap, p.id)).sort();
  assert.deepEqual(ids, ['c_vis1', 'c_vis2']);
  const v = getChange('c_vis1')!.verify;
  assert.equal(v.capture.run, 'r_x');
  assert.equal(v.capture.phone, true);
  assert.equal(getChange('c_docs')!.verify.capture, undefined);
  assert.equal(getChange('c_open')!.verify.capture, undefined, 'unmerged changes are untouched');
  assert.equal((await home()).games.find((x) => x.id === p.id)!.uncaptured, 0);
  assert.deepEqual(await attachMilestoneCapture(cap, p.id), [], 'a change already captured is not attached again');
});
