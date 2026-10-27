// How each web product's beta site is built (previews.ts RECIPES) matches how its GitHub Pages publishes it: I Can Be
// moved to Babylon 9 from npm with Vite (#6), so like Dose Of Destruction its beta site is the Vite build in dist/ and
// nothing else (its pages.yml uploads dist/ alone). Scratch folders only; nothing real is built or touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-recipes-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PREVIEWS = path.join(tmp, 'previews');
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });

const { recipeOf, collect } = await import('../src/previews.ts');

test('recipes: the Vite products build, and each publishes what its Pages does', () => {
  assert.deepEqual(recipeOf('icanbe'), { build: 'npm run build', site: 'none', out: { from: 'dist', to: '' } });
  assert.equal(recipeOf('doseofdestruction').build, 'npm run build');
  assert.deepEqual(recipeOf('doseofdestruction').out, { from: 'dist', to: '' });
  assert.deepEqual(recipeOf('phorigins'), { build: 'npm run build', site: 'tracked', out: { from: 'play', to: 'play' } });
  // Not listed: the repo as committed, no build.
  assert.deepEqual(recipeOf('corporate'), { site: 'tracked' });
});

test("I Can Be's beta site is dist/ at the root, never the unbuilt source", async () => {
  const dir = path.join(tmp, 'icanbe');
  const put = (rel: string, s = rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
  // The source: index.html's module script imports '@babylonjs/core', which a browser can't resolve.
  for (const f of ['index.html', 'js/app.js', 'day.config.js', 'package.json', 'node_modules/@babylonjs/core/index.js']) put(f);
  // What `vite build` leaves (vite.config.js copies the static pages, releases.json and the CNAME in).
  for (const f of ['dist/index.html', 'dist/assets/index-abc.js', 'dist/assets/HavokPhysics-x.wasm', 'dist/whatsnew.html', 'dist/privacy.html', 'dist/releases.json', 'dist/CNAME', 'dist/css/site.css']) put(f, `built ${f}`);
  const files = await collect(dir, recipeOf('icanbe'));
  assert.deepEqual([...files.keys()].sort(), ['CNAME', 'assets/HavokPhysics-x.wasm', 'assets/index-abc.js', 'css/site.css', 'index.html', 'privacy.html', 'releases.json', 'whatsnew.html']);
  assert.equal(fs.readFileSync(files.get('index.html')!.src, 'utf8'), 'built dist/index.html');
  assert.ok([...files.values()].every((f) => !f.link), 'build output is copied, not hard-linked');
  // No build output: a failed preview that says so, not the raw source.
  fs.rmSync(path.join(dir, 'dist'), { recursive: true });
  await assert.rejects(collect(dir, recipeOf('icanbe')), /no dist\//);
});

test('a Unity site whose file list passes 1 MB is published whole (Sick Of It v262 lost Game/ to a cut list)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-big-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const deep = path.join(dir, 'Game', 'v262', 'ServerData', 'WebGL');
  fs.mkdirSync(deep, { recursive: true });
  const name = (i: number) => `playerdata_${String(i).padStart(5, '0')}_assets_all_521fa1481d82b1d33ee13aba7c5d675b.bundle`;
  const n = 12000; // about 1.3 MB of names with their folders
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(deep, name(i)), '');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  const files = await collect(dir, { site: 'tracked' } as any);
  assert.ok(files.has('index.html'));
  assert.ok(files.has(`Game/v262/ServerData/WebGL/${name(0)}`), 'the start of the list is kept');
  assert.equal([...files.keys()].filter((k) => k.startsWith('Game/')).length, n);
  fs.rmSync(dir, { recursive: true, force: true });
});
