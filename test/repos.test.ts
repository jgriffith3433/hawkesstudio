// Updating a beta source checkout on the server (repos.ts syncRepo) when it has uncommitted changes: changes only in
// generated build output (a leftover build) are discarded, named and the checkout follows beta; anything else is set
// aside in a git stash (never deleted, Talk told how to get it back) and the checkout follows beta, unless the stash
// fails (then it stays where it is, untouched). Off the beta lane nothing is touched. And asset making waits while an
// agent works in the repo (it would write into this checkout). Throwaway repos in a temp "Projects" folder with a bare origin.
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

const { syncRepo, buildOutputs, repoNotices } = await import('../src/repos.ts');
const notices: { title: string; text: string }[] = [];
repoNotices.post = (title, text) => { notices.push({ title, text }); };
const head = () => git(dir, 'rev-parse', 'HEAD');

test('build output: play/, dist/, Game/v<n> and deploy.output, nothing else', () => {
  const out = buildOutputs('site');
  for (const f of ['play/index.html', 'play/assets/textures/office-plaster.webp', 'dist/a.js', 'Game/v12/Build/x.data']) assert.ok(out(f), f);
  for (const f of ['src/main.ts', 'package.json', 'playground/x', 'Game/Shared/x', 'notes/play/x']) assert.ok(!out(f), f);
  assert.ok(!buildOutputs('elsewhere')('play/index.html'));
});
