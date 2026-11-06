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
