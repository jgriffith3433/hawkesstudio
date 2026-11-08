// Every visible change ships with shots and a walk-through clip (agents.ts showcaseFor, showcaseSection,
// withShowcase; the owner's gaps list, 2026-11-08). A game change a player would see is played by itself, and its
// pull request carries the shots, motion sheets and video from that run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-showcase-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [] }));

const { visibleFiles, showcaseFor, showcaseSection, withShowcase } = await import('../src/agents.ts');

test('visibleFiles keeps what a player sees', () => {
  const files = ['src/game.js', 'index.html', 'assets/hero.glb', 'README.md', 'test/game.test.js', 'docs/plan.md',
    'package.json', 'public/hawkes-feel.js', 'Assets/Scripts/Player.cs', '.github/workflows/ci.yml', 'types.d.ts'];
  assert.deepEqual(visibleFiles(files), ['src/game.js', 'index.html', 'assets/hero.glb', 'Assets/Scripts/Player.cs']);
});

test('showcaseFor is off for non-games, off mode and infra', () => {
  const c = { worktree: '/nope', base: 'beta', repo: '/nope', task: 'Make the jump feel better' } as any;
  assert.equal(showcaseFor(c, { engine: 'static', kind: 'site', repo: 'Site' } as any, 'web'), null);
  assert.equal(showcaseFor(c, { engine: 'three', repo: 'G' } as any, 'off'), null);
  assert.equal(showcaseFor({ ...c, infra: true }, { engine: 'three', repo: 'G' } as any, 'all'), null);
  assert.equal(showcaseFor(c, { engine: 'unity', repo: 'MyGame', site: 'MyGameSite', build: 'x' } as any, 'web'), null);
});

test('showcaseSection lists shots, sheets and the video', () => {
  assert.equal(showcaseSection(null), null);
  assert.equal(showcaseSection({ outcome: 'not played' }), null);
  const s = showcaseSection({
    outcome: 'pass', verdict: 'pass', scenario: 'jump-gap', video: 'vid1',
    shots: [{ asset: 'a1', t: 2, reason: 'landing' }], sheets: [{ asset: 'm1', start: 1, end: 2.2, reason: 'jump' }],
    criteria: [{ met: 'yes' }, { met: 'unclear' }],
  })!;
  assert.match(s, /## From the built game/);
  assert.match(s, /criteria 1\/2 met/);
  assert.match(s, /\/v1\/files\/vid1/);
  assert.match(s, /motion 1s to 2\.2s \(jump\)/);
  assert.match(s, /!\[landing at 2s\]/);
});

test('withShowcase replaces an earlier section instead of stacking', () => {
  const s1 = showcaseSection({ outcome: 'pass', video: 'v1' })!;
  const s2 = showcaseSection({ outcome: 'pass', video: 'v2' })!;
  const once = withShowcase('Before: x\n\nAfter: y', s1);
  const twice = withShowcase(once, s2);
  assert.match(twice, /^Before: x\n\nAfter: y\n\n/);
  assert.doesNotMatch(twice, /\/v1\/files\/v1\)/);
  assert.equal(twice.split('## From the built game').length, 2);
});
