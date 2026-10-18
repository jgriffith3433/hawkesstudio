// Packages follow the lockfile (repos.ts installAfterSync, warm.ts): a sync that brings in a new package-lock.json or
// package.json runs npm ci in that web checkout and logs it with its time; a failed install fails the sync with npm's
// error; at start, a checkout whose install stamp is missing or for another lockfile is reinstalled; and an agent
// worktree's warm start copies node_modules only from a checkout installed for the same lockfile, else npm ci.
// Dose Of Destruction's PR #12 (2026-10-18) added packages and beta's checkout kept serving the old node_modules.
// A fake npm on PATH (writes node_modules, logs its calls, fails on demand), throwaway repos with a bare origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const posix = process.platform !== 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-npm-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_SERVER = '1';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'game', name: 'Game', framing: 'test', engine: 'web', repo: 'game', site: 'game', live: 'http://127.0.0.1:9/',
  local: { serve: 'npm', dir: 'game', port: 8798, path: '/' }, playtests: [], story: [], about: 'A fixture.',
}], repos: { game: 'test/game' } }));

// The fake npm: "npm ci" puts the lockfile's text in node_modules/installed.txt; fails while $FAKE_NPM_FAIL exists.
const bin = path.join(tmp, 'bin');
const calls = path.join(tmp, 'npm-calls.log');
const fail = path.join(tmp, 'npm-fail');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$PWD $*" >> ${calls}
if [ -e ${fail} ]; then echo "npm ERR! code ETARGET" >&2; echo "npm ERR! notarget No matching version for @noble/curves" >&2; exit 1; fi
rm -rf node_modules && mkdir -p node_modules && cp package-lock.json node_modules/installed.txt
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const npmCalls = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const dir = path.join(process.env.STUDIO_PROJECTS, 'game');
const other = path.join(tmp, 'other');
const write = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const push = (files: Record<string, string>) => {
  for (const [f, t] of Object.entries(files)) write(other, f, t);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', `change ${Object.keys(files).join(', ')}`);
  git(other, 'push', '--quiet', 'origin', 'HEAD:beta');
};
if (posix) {
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '--quiet', origin, other);
  git(other, 'checkout', '--quiet', '-b', 'beta');
  write(other, '.gitignore', 'node_modules/\n');
  write(other, 'package.json', '{"name":"game"}');
  write(other, 'package-lock.json', '{"lock":1}');
  write(other, 'src/main.ts', 'v1');
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', 'First');
  git(other, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:beta');
  git(tmp, 'clone', '--quiet', '-b', 'beta', origin, dir);
}

const { syncRepo, reinstallStale } = await import('../src/repos.ts');
const { warmDeps, installCold, coldDirs, installedFor, lockHash, INSTALLED } = await import('../src/warm.ts');
const installed = () => fs.readFileSync(path.join(dir, 'node_modules', 'installed.txt'), 'utf8');

test('at start, a checkout with old packages and no install stamp is reinstalled; a stamped one is left alone', { skip: !posix }, async () => {
  // Like the server's Dose Of Destruction checkout: node_modules from before, no stamp.
  write(dir, 'node_modules/old.txt', 'stale');
  const [r] = await reinstallStale();
  assert.equal(r.dir, 'game');
  assert.ok(r.ok, r.error);
  assert.equal(r.why, 'no record of an install for this package-lock.json');
  assert.equal(installed(), '{"lock":1}');
  assert.equal(installedFor(dir), lockHash(dir));
  assert.match(npmCalls()[0], /game ci --no-audit --no-fund$/);
  assert.deepEqual(await reinstallStale(), [], 'installed for this lockfile: nothing to do');
  assert.equal(npmCalls().length, 1);
});

test('a sync that changes only code installs nothing', { skip: !posix }, async () => {
  push({ 'src/main.ts': 'v2' });
  const r = await syncRepo('game', 'test/game', 'main', 'beta');
  assert.equal(r.action, 'updated', r.detail);
  assert.equal(r.install, undefined);
  assert.equal(npmCalls().length, 1);
});

test('a sync that brings a new package-lock.json runs npm ci and logs it with its time', { skip: !posix }, async () => {
  push({ 'package.json': '{"name":"game","dependencies":{"@noble/curves":"1"}}', 'package-lock.json': '{"lock":2}' });
  const r = await syncRepo('game', 'test/game', 'main', 'beta');
  assert.equal(r.action, 'updated', r.detail);
  assert.equal(r.install?.length, 1);
  assert.ok(r.install![0].ok);
  assert.equal(r.install![0].why, 'package-lock.json changed');
  assert.match(r.detail, /beta: 1 new commits; dependencies changed: npm ci in game \(package-lock\.json changed\): \d+ s$/);
  assert.equal(installed(), '{"lock":2}');
  assert.equal(installedFor(dir), lockHash(dir));
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the install leaves the checkout clean');
});

test('package.json alone changing reinstalls too', { skip: !posix }, async () => {
  push({ 'package.json': '{"name":"game","scripts":{"postinstall":"true"}}' });
  const r = await syncRepo('game', 'test/game', 'main', 'beta');
  assert.equal(r.install?.[0]?.why, 'package.json changed');
  assert.ok(r.install![0].ok);
});

test('a failed install fails the sync with npm\'s error, and is not retried until the lockfile changes', { skip: !posix }, async () => {
  fs.writeFileSync(fail, '');
  try {
    push({ 'package-lock.json': '{"lock":3}' });
    const n = npmCalls().length;
    const r = await syncRepo('game', 'test/game', 'main', 'beta');
    assert.equal(r.action, 'failed');
    assert.equal(r.install?.[0]?.ok, false);
    assert.match(r.detail, /npm ci in game failed \(package-lock\.json changed\): .*No matching version for @noble\/curves/s);
    assert.notEqual(installedFor(dir), lockHash(dir), 'no stamp for a failed install');
    assert.equal(npmCalls().length, n + 1);
    // The next sync (a playtest's) reports the same failure without running npm again.
    const again = await syncRepo('game', 'test/game', 'main', 'beta');
    assert.equal(again.action, 'failed');
    assert.match(again.detail, /No matching version.*failed 0 min ago/s);
    assert.equal(npmCalls().length, n + 1);
  } finally {
    fs.rmSync(fail);
  }
  // Fixed on beta: a new lockfile installs again.
  push({ 'package-lock.json': '{"lock":4}' });
  const r = await syncRepo('game', 'test/game', 'main', 'beta');
  assert.equal(r.action, 'updated', r.detail);
  assert.equal(installed(), '{"lock":4}');
});

/** An agent worktree of game at `name`, with the checkout's lockfile. */
function worktree(name: string, lock = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')) {
  const wt = path.join(process.env.STUDIO_PROJECTS!, '.work', name);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(dir, '.git', 'worktrees', name)}\n`);
  fs.writeFileSync(path.join(wt, 'package-lock.json'), lock);
  return wt;
}

test('warm start: node_modules is copied from a checkout installed for the same lockfile', { skip: !posix }, () => {
  const wt = worktree('c_same');
  assert.deepEqual(warmDeps(wt, 'game'), ['.']);
  assert.equal(fs.readFileSync(path.join(wt, 'node_modules', 'installed.txt'), 'utf8'), '{"lock":4}');
  assert.equal(installedFor(wt), lockHash(wt), 'the copy carries the install stamp');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('warm start: a donor with the lockfile but no install stamp is not copied; npm ci runs in the worktree', { skip: !posix }, async () => {
  // The checkout's lockfile moved on without an install (the stale case): same lockfile, old packages, no stamp.
  fs.rmSync(path.join(dir, 'node_modules', INSTALLED));
  for (const s of ['.studio-lock', '.hawkes-lock']) fs.rmSync(path.join(dir, 'node_modules', s), { force: true });
  const wt = worktree('c_stale');
  const logs: string[] = [];
  assert.deepEqual(warmDeps(wt, 'game', (s) => logs.push(s)), []);
  assert.match(logs.join('\n'), /no checkout has node_modules installed for the package-lock\.json; npm ci instead/);
  assert.deepEqual(coldDirs(wt), ['']);
  const ran: string[] = [];
  await installCold(wt, async (d, cmd) => {
    ran.push(cmd);
    const r = spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`, ms: 1200 };
  }, (s) => logs.push(s));
  assert.equal(ran.length, 1);
  assert.match(logs.at(-1)!, /^npm ci \(1 s\)$/);
  assert.equal(fs.readFileSync(path.join(wt, 'node_modules', 'installed.txt'), 'utf8'), '{"lock":4}');
  assert.equal(installedFor(wt), lockHash(wt), 'stamped, so it can be a donor next time');
  for (const s of ['.studio-lock', '.hawkes-lock']) assert.equal(fs.readFileSync(path.join(wt, 'node_modules', s), 'utf8'), lockHash(wt));
  assert.deepEqual(coldDirs(wt), []);
});

test('warm start: a donor installed for another lockfile is not copied', { skip: !posix }, () => {
  fs.writeFileSync(path.join(dir, 'node_modules', INSTALLED), 'some-older-hash');
  const wt = worktree('c_other', '{"lock":99}');
  fs.rmSync(path.join(process.env.STUDIO_PROJECTS!, '.work', 'c_stale'), { recursive: true, force: true });
  assert.deepEqual(warmDeps(wt, 'game'), []);
  assert.ok(!fs.existsSync(path.join(wt, 'node_modules')));
});
