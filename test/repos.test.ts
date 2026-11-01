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

const sync = () => syncRepo('site', 'test/site', 'main', 'beta');
const status = () => git(dir, 'status', '--porcelain');
const tarList = (f: string) => spawnSync('tar', ['-tzf', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
// A `git` ahead on PATH that refuses `stash` (and passes everything else on) makes the stash fail like a locked index would.
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const fakeBin = path.join(tmp, 'fakebin');
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = stash ]; then echo "fatal: unable to write new index file" >&2; exit 128; fi; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
const blockStash = () => { process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`; };
const unblockStash = () => { process.env.PATH = process.env.PATH!.replace(`${fakeBin}${path.delimiter}`, ''); };
const quiet = async <T>(f: () => Promise<T>) => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
  try { return { r: await f(), warned }; } finally { console.warn = warn; }
};

test('dirty tracked file: set aside in a stash, the checkout follows beta', async () => {
  push('src/a.ts', 'a1');
  write(dir, 'src/main.ts', 'edited by hand');
  const r = await sync();
  assert.equal(r.action, 'updated', r.detail);
  assert.ok(r.setAside?.stash && !r.setAside.backup);
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  assert.match(git(dir, 'stash', 'list'), /studio: set aside before following beta/);
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v1');
});

test('untracked files (.claude/launch.json, .cursor/mcp.json): stashed, the checkout follows beta', async () => {
  push('src/b.ts', 'b1');
  write(dir, '.claude/launch.json', '{}');
  write(dir, '.cursor/mcp.json', '{}');
  const r = await sync();
  assert.equal(r.action, 'updated', r.detail);
  assert.deepEqual([...r.setAside!.files].sort(), ['.claude/launch.json', '.cursor/mcp.json']);
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
});

test('stash fails: files backed up to a tar in the data folder, then the checkout follows beta; the reason is logged', async () => {
  push('src/c.ts', 'c1');
  write(dir, 'src/main.ts', 'edited again');
  write(dir, '.claude/launch.json', '{"x":1}');
  blockStash();
  const { r, warned } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.ok(r.setAside?.backup, 'a backup');
  assert.match(r.detail, /git stash failed \(.+\); backed up/);
  assert.ok(warned.some((l) => /git stash failed \(.+\)/.test(l)), warned.join('\n'));
  assert.ok(r.setAside!.backup!.startsWith(path.join(process.env.STUDIO_DATA!, 'backups', 'repos')));
  assert.deepEqual(tarList(r.setAside!.backup!).sort(), ['.claude/launch.json', 'src/main.ts']);
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  assert.ok(notices.some((n) => /backed up/.test(n.title)));
});

test('stash and tar both fail: nothing is touched and both reasons are in the detail', async () => {
  push('src/d.ts', 'd1');
  write(dir, 'src/main.ts', 'precious');
  blockStash();
  const repos = path.join(process.env.STUDIO_DATA!, 'backups', 'repos');
  fs.rmSync(repos, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(repos), { recursive: true });
  fs.writeFileSync(repos, 'a file where the backup folder should be');
  const before = head();
  const { r } = await quiet(sync).finally(unblockStash);
  fs.rmSync(repos, { force: true });
  assert.equal(r.action, 'kept');
  assert.match(r.detail, /git stash: .+; tar backup: .+/);
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'precious');
  assert.equal(head(), before);
});
