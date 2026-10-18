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

test('other uncommitted changes are set aside in a stash, Talk is told, and the checkout follows beta', async () => {
  write(dir, 'src/main.ts', 'work in progress'); // modified, tracked
  write(dir, 'play/index.html', 'stray rebuild'); // build output, alongside
  write(dir, 'hawkes.assets.lock.json', '{}'); // untracked, like the asset left in imaginelivetvwebsite
  push('src/other.ts', 'v3');
  notices.length = 0;
  const r = await syncRepo('site', 'test/site', 'main', 'beta');
  assert.equal(r.action, 'updated', r.detail);
  assert.match(r.detail, /^set aside uncommitted changes in stash [0-9a-f]{7} \(.*src\/main\.ts.*\); beta: 1 new commits/);
  assert.deepEqual([...r.setAside!.files].sort(), ['hawkes.assets.lock.json', 'play/index.html', 'src/main.ts']);
  assert.match(r.setAside!.label, /^studio: set aside before following beta [0-9a-f]{7,} \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.equal(r.dirty, undefined);
  assert.equal(head(), git(origin, 'rev-parse', 'beta'));
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(dir, 'src/other.ts'), 'utf8'), 'v3');
  assert.equal(git(dir, 'rev-parse', 'stash@{0}'), r.setAside!.stash);
  assert.match(git(dir, 'stash', 'list'), new RegExp(r.setAside!.label));
  // One notice: the files, the stash, how to get them back.
  assert.equal(notices.length, 1);
  const [n] = notices;
  assert.match(n.title, /site: stray files set aside/);
  for (const want of ['src/main.ts', 'hawkes.assets.lock.json', r.setAside!.stash.slice(0, 7), r.setAside!.label, `git -C ${dir} stash list`, 'stash show -p', 'stash pop', 'follows beta again']) assert.ok(n.text.includes(want), want);
  // Nothing was lost: popping it brings the work back on top of the new beta.
  git(dir, 'stash', 'pop', '--quiet');
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'work in progress');
  assert.equal(fs.readFileSync(path.join(dir, 'hawkes.assets.lock.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(dir, 'play/index.html'), 'utf8'), 'stray rebuild');
});

test('a stash that fails keeps the refusal, touches nothing and posts no notice', async () => {
  push('src/third.ts', 'v4');
  const before = head();
  notices.length = 0;
  const lock = path.join(dir, '.git', 'index.lock'); // another git holds the index: stash push can't run
  fs.writeFileSync(lock, '');
  try {
    const r = await syncRepo('site', 'test/site', 'main', 'beta');
    assert.equal(r.action, 'kept');
    assert.match(r.detail, /uncommitted changes .* not updated; setting them aside failed/);
    assert.deepEqual([...r.dirty!].sort(), ['hawkes.assets.lock.json', 'play/index.html', 'src/main.ts']);
    assert.equal(r.setAside, undefined);
  } finally {
    fs.rmSync(lock);
  }
  assert.equal(head(), before);
  assert.equal(notices.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'work in progress');
  assert.equal(git(dir, 'stash', 'list'), '');
});

test('off the beta lane (no wanted branch) build output is kept too', async () => {
  git(dir, 'checkout', '--quiet', '--', 'src/main.ts');
  fs.rmSync(path.join(dir, 'hawkes.assets.lock.json'));
  const r = await syncRepo('site', 'test/site', 'main');
  assert.equal(r.action, 'kept');
  assert.deepEqual(r.dirty, ['play/index.html']);
  assert.equal(fs.readFileSync(path.join(dir, 'play/index.html'), 'utf8'), 'stray rebuild');
});

test('asset making waits while an agent works in the repo, and says why', async () => {
  const { db } = await import('../src/db.ts');
  await import('../src/agents.ts'); // the changes table
  const { startAssets } = await import('../src/pipeline.ts');
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, notes, log, created) VALUES ('c_test1', 'site', '[]', 'working', 'site', 'test/site', 'task/x', 'beta', '/tmp/wt-c_test1', '[]', '[]', ?)`).run(Date.now());
  assert.throws(() => startAssets('site'), /an agent is working on site \(change c_test1, working\).*\/tmp\/wt-c_test1/);
  db.prepare(`UPDATE changes SET status = 'ready' WHERE id = 'c_test1'`).run();
  assert.throws(() => startAssets('site'), /has no hawkes\.assets\.json/); // past the guard
});
