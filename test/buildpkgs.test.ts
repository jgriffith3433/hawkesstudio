// Before a Unity build, the Gen and Studio package checkouts are fetched and the commits the build will use are
// reported (a stale checkout once sent an old compile error into every Unity build). Throwaway repos, a bare origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildpkgs-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [], repos: {} }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const other = path.join(tmp, 'other');
const dir = path.join(process.env.STUDIO_PROJECTS, 'pkgrepo');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, other);
const push = (text: string) => {
  fs.writeFileSync(path.join(other, 'f.txt'), text);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', text);
  git(other, 'push', '--quiet', 'origin', 'HEAD:main');
  return git(other, 'rev-parse', 'HEAD');
};
const first = push('v1');
git(tmp, 'clone', '--quiet', origin, dir);

const { syncBuildPackages } = await import('../src/buildpkgs.ts');

test('a current checkout is reported as current', async () => {
  const logs: string[] = [];
  const r = await syncBuildPackages((s) => logs.push(s), { repos: ['pkgrepo', 'missing'], waitMs: 0 });
  assert.deepEqual(Object.keys(r), ['pkgrepo']);
  assert.equal(r.pkgrepo.sha, first.slice(0, 12));
  assert.equal(r.pkgrepo.behind, 0);
  assert.match(logs.join('\n'), /current/);
});

test('a checkout behind origin/main is fetched and reported as behind (not silently stale)', async () => {
  const second = push('v2');
  const logs: string[] = [];
  const r = await syncBuildPackages((s) => logs.push(s), { repos: ['pkgrepo'], waitMs: 0 });
  assert.equal(r.pkgrepo.sha, first.slice(0, 12));
  assert.equal(r.pkgrepo.behind, 1);
  assert.equal(r.pkgrepo.latest, second.slice(0, 12));
  assert.match(logs.join('\n'), /NOT in this build/);
});
