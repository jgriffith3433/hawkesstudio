// Updating a beta source checkout on the server (repos.ts syncRepo) when it has uncommitted changes: changes only in
// generated build output (a leftover build) are discarded, named and the checkout follows beta; anything else keeps it
// where it is, untouched. Throwaway repos in a temp "Projects" folder with a bare origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-repos-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_SERVER = '1';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'site', name: 'Site', framing: 'test', engine: 'web', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [], story: [], about: 'A fixture.',
  deploy: { prebuild: 'npm run build' },
}], repos: { site: 'test/site' } }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const dir = path.join(process.env.STUDIO_PROJECTS, 'site');
const other = path.join(tmp, 'other');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, other);
const write = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const push = (file: string, text: string) => {
  write(other, file, text);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', `change ${file}`);
  git(other, 'push', '--quiet', 'origin', 'HEAD:beta');
};
git(other, 'checkout', '--quiet', '-b', 'beta');
write(other, 'src/main.ts', 'v1');
write(other, 'play/assets/textures/office-plaster.webp', 'built v1');
write(other, 'play/index.html', 'built v1');
git(other, 'add', '-A');
git(other, 'commit', '--quiet', '-m', 'First');
git(other, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:beta');
git(tmp, 'clone', '--quiet', '-b', 'beta', origin, dir);

const { syncRepo, buildOutputs } = await import('../src/repos.ts');
const head = () => git(dir, 'rev-parse', 'HEAD');

test('build output: play/, dist/, Game/v<n> and deploy.output, nothing else', () => {
  const out = buildOutputs('site');
  for (const f of ['play/index.html', 'play/assets/textures/office-plaster.webp', 'dist/a.js', 'Game/v12/Build/x.data']) assert.ok(out(f), f);
  for (const f of ['src/main.ts', 'package.json', 'playground/x', 'Game/Shared/x', 'notes/play/x']) assert.ok(!out(f), f);
  assert.ok(!buildOutputs('elsewhere')('play/index.html'));
});

test('a checkout dirty only in build output is cleaned, logged and follows beta', async () => {
  write(dir, 'play/assets/textures/office-plaster.webp', 'stray rebuild'); // modified, tracked
  write(dir, 'play/assets/new-chunk.js', 'stray'); // untracked
  write(dir, 'dist/staged.js', 'staged');
  git(dir, 'add', 'dist/staged.js'); // staged, not in HEAD
  push('src/main.ts', 'v2');
  const r = await syncRepo('site', 'test/site', 'main', 'beta');
  assert.equal(r.action, 'updated', r.detail);
  assert.deepEqual([...r.discarded!].sort(), ['dist/staged.js', 'play/assets/new-chunk.js', 'play/assets/textures/office-plaster.webp']);
  assert.match(r.detail, /discarded uncommitted build output \(.*office-plaster\.webp/);
  assert.equal(r.dirty, undefined);
  assert.equal(head(), git(origin, 'rev-parse', 'beta'));
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(dir, 'play/assets/textures/office-plaster.webp'), 'utf8'), 'built v1');
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v2');
});

test('changes outside build output keep the refusal and touch nothing', async () => {
  write(dir, 'src/main.ts', 'work in progress');
  write(dir, 'play/index.html', 'stray rebuild');
  push('src/other.ts', 'v3');
  const before = head();
  const r = await syncRepo('site', 'test/site', 'main', 'beta');
  assert.equal(r.action, 'kept');
  assert.match(r.detail, /uncommitted changes .* not updated/);
  assert.deepEqual([...r.dirty!].sort(), ['play/index.html', 'src/main.ts']);
  assert.equal(r.discarded, undefined);
  assert.equal(head(), before);
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'work in progress');
  assert.equal(fs.readFileSync(path.join(dir, 'play/index.html'), 'utf8'), 'stray rebuild');
});

test('off the beta lane (no wanted branch) build output is kept too', async () => {
  git(dir, 'checkout', '--quiet', '--', 'src/main.ts');
  const r = await syncRepo('site', 'test/site', 'main');
  assert.equal(r.action, 'kept');
  assert.deepEqual(r.dirty, ['play/index.html']);
  assert.equal(fs.readFileSync(path.join(dir, 'play/index.html'), 'utf8'), 'stray rebuild');
});
