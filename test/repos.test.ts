// Updating a beta source checkout on the server (repos.ts syncRepo) when it has uncommitted changes: changes only in
// generated build output (a leftover build) are discarded, named and the checkout follows beta; anything else is set
// aside in a git stash (Talk told how to get it back) and the checkout follows beta; when the stash fails, real edits
// are pushed to a claude/rescue/ branch on origin and the files are reset to GitHub with no backup (or it is cloned again). Off the beta lane nothing is touched. And asset making waits while an
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
// A `git` ahead on PATH that refuses `stash` (and passes everything else on) makes the stash fail like a locked index would.
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const fakeBin = path.join(tmp, 'fakebin');
fs.mkdirSync(fakeBin, { recursive: true });
// FAKE_GIT_BLOCK lists the subcommands it refuses (default stash); FAKE_GIT_SILENT makes it die without a word, like a
// git killed by a timeout or the instance's memory.
fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\nfor a in "$@"; do for b in $(echo "\${FAKE_GIT_BLOCK:-stash}" | tr , ' '); do if [ "$a" = "$b" ]; then [ -n "$FAKE_GIT_SILENT" ] || echo "fatal: unable to write new index file" >&2; exit 128; fi; done; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
const blockStash = (also: string[] = [], silent = false) => {
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_GIT_BLOCK = ['stash', ...also].join(',');
  if (silent) process.env.FAKE_GIT_SILENT = '1';
};
const unblockStash = () => {
  process.env.PATH = process.env.PATH!.replace(`${fakeBin}${path.delimiter}`, '');
  delete process.env.FAKE_GIT_BLOCK;
  delete process.env.FAKE_GIT_SILENT;
};
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
  assert.ok(r.setAside?.stash);
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

const noBackups = () => !fs.existsSync(path.join(process.env.STUDIO_DATA!, 'backups'));
const rescues = () => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/claude/rescue/').split('\n').filter(Boolean);
const onOrigin = (branch: string, file: string) => git(origin, 'show', `${branch}:${file}`);
const clearRescues = () => { for (const b of rescues()) git(origin, 'update-ref', '-d', `refs/heads/${b}`); };

test('stash fails: real edits are pushed to a rescue branch on origin, then reset to GitHub with no backup; follows beta', async () => {
  clearRescues();
  push('src/c.ts', 'c1');
  write(dir, 'src/main.ts', 'edited again');
  write(dir, '.claude/launch.json', '{"x":1}');
  blockStash();
  const { r, warned } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.ok(r.setAside && !r.setAside.stash && !r.setAside.recloned);
  assert.deepEqual([...r.setAside!.files].sort(), ['.claude/launch.json', 'src/main.ts']);
  const x = r.setAside!.rescue!;
  assert.ok(x.pushed, x.error);
  assert.match(x.branch, /^claude\/rescue\/site-\d{8}-\d{6}$/);
  assert.deepEqual(rescues(), [x.branch]);
  assert.equal(onOrigin(x.branch, 'src/main.ts'), 'edited again');
  assert.equal(onOrigin(x.branch, '.claude/launch.json'), '{"x":1}');
  assert.match(git(origin, 'log', '-1', '--format=%s', x.branch), /^studio: rescued from the server's beta checkout of site/);
  assert.match(r.detail, /git stash failed \(.+\); edits pushed to claude\/rescue\/site-.+; reset to GitHub, no backup/);
  assert.ok(warned.some((l) => /git stash failed \(.+\)/.test(l)), warned.join('\n'));
  assert.ok(noBackups(), 'no backup made');
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v1');
  assert.ok(!fs.existsSync(path.join(dir, '.claude/launch.json')));
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  const n = notices.find((y) => y.title === `site: stray files pushed to ${x.branch} to follow beta`);
  assert.ok(n && n.text.includes(`pushed the 2 edited files to the branch ${x.branch} on GitHub`) && /reset them to what GitHub has, with no backup/.test(n.text), n?.text);
});

test('stash fails and the push fails: logged, Talk names the failure, the checkout is still reset', async () => {
  clearRescues();
  push('src/c2.ts', 'c2');
  write(dir, 'src/main.ts', 'push will fail');
  blockStash(['push']);
  const { r, warned } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  const x = r.setAside!.rescue!;
  assert.equal(x.pushed, false);
  assert.match(x.error!, /^pushing: /);
  assert.deepEqual(rescues(), []);
  assert.ok(warned.some((l) => l.includes(`rescue branch ${x.branch} failed (pushing:`)), warned.join('\n'));
  // Not on GitHub, but the commit is on a local branch of the checkout until it is cloned again.
  assert.equal(git(dir, 'show', `${x.branch}:src/main.ts`), 'push will fail');
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v1');
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  const n = notices.findLast((y) => /cleared to follow beta/.test(y.title));
  assert.ok(n && /Pushing the 1 edited file to a rescue branch failed \(pushing: .+\), so they were not saved to GitHub/.test(n.text) && n.text.includes(`local branch ${x.branch}`), n?.text);
  git(dir, 'branch', '-D', x.branch);
});

test('rescueEdits: a commit on no remote branch alone is pushed as it is; nothing differing from GitHub: null', async () => {
  clearRescues();
  const { rescueEdits } = await import('../src/repos.ts');
  assert.equal(await rescueEdits(dir, 'site', 'test/site', 'beta', ['src/main.ts', 'gone.txt'], 'test'), null);
  write(dir, 'local.txt', 'only here');
  git(dir, 'add', 'local.txt');
  git(dir, 'commit', '--quiet', '-m', 'local only');
  const local = head();
  const x = await rescueEdits(dir, 'site', 'test/site', 'beta', [], 'test');
  assert.ok(x?.pushed, x?.error);
  assert.equal(x!.commits, 1);
  assert.deepEqual(x!.files, []);
  assert.equal(git(origin, 'rev-parse', x!.branch), local);
  git(dir, 'reset', '--quiet', '--hard', 'origin/beta');
  git(dir, 'branch', '-D', x!.branch);
  clearRescues();
});

// A half-written checkout (a clone or switch cut off partway: PH Origins, 2026-11-01, ~1,300 "changes" on main). Studio
// clones from https://github.com/<slug>.git: git's insteadOf points that at the test's bare origin.
const gitConfig = path.join(tmp, 'gitconfig');
fs.writeFileSync(gitConfig, `[url "${origin}"]\n\tinsteadOf = https://github.com/test/site.git\n`);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
const tracked = () => git(dir, 'ls-files').split('\n').filter(Boolean);

test('half-written checkout (tracked files missing), stash fails silently: no rescue branch, restored, follows beta', async () => {
  clearRescues();
  push('src/e.ts', 'e1');
  for (const f of tracked()) fs.rmSync(path.join(dir, f));
  blockStash([], true);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.match(r.detail, /git exited (without saying why|with code 128)/);
  assert.match(r.detail, /nothing differed from GitHub; reset to GitHub, no backup/);
  assert.equal(r.setAside?.rescue, undefined);
  assert.deepEqual(rescues(), []);
  assert.ok(noBackups());
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v1');
  assert.ok(notices.some((n) => /cleared to follow beta/.test(n.title) && /nothing to rescue/.test(n.text)));
});

test('half-written checkout (index lost), every file as on GitHub: no rescue branch, restored, follows beta', async () => {
  clearRescues();
  push('src/h.ts', 'h1');
  fs.rmSync(path.join(dir, '.git', 'index'));
  blockStash([], true);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.match(r.detail, /nothing differed from GitHub/);
  assert.equal(r.setAside?.rescue, undefined);
  assert.deepEqual(rescues(), []);
  assert.ok(noBackups());
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
});

test('half-written checkout (index lost) with real edits: only those are on the rescue branch, then reset, follows beta', async () => {
  clearRescues();
  push('src/i.ts', 'i1');
  fs.rmSync(path.join(dir, '.git', 'index'));
  write(dir, 'src/main.ts', 'mine, not on GitHub');
  write(dir, 'notes/new.md', 'also mine');
  blockStash([], true);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  const x = r.setAside!.rescue!;
  assert.ok(x.pushed, x.error);
  assert.deepEqual([...x.files].sort(), ['notes/new.md', 'src/main.ts']);
  const changed = git(origin, 'diff', '--name-only', `${x.branch}~1`, x.branch).split('\n').sort();
  assert.deepEqual(changed, ['notes/new.md', 'src/main.ts']);
  assert.equal(onOrigin(x.branch, 'src/main.ts'), 'mine, not on GitHub');
  assert.ok(noBackups());
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v1');
  assert.ok(!fs.existsSync(path.join(dir, 'notes/new.md')));
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
});

test("can't reset it in place either: edits pushed to a rescue branch, the checkout is cloned again on beta", async () => {
  clearRescues();
  push('src/f.ts', 'f1');
  write(dir, 'src/main.ts', 'rescued before the clone');
  fs.rmSync(path.join(dir, 'play/index.html'));
  blockStash(['restore']);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.match(r.detail, /so it was cloned again/);
  assert.ok(r.setAside?.recloned && r.setAside.rescue?.pushed);
  assert.deepEqual(r.setAside!.rescue!.files, ['src/main.ts']);
  assert.equal(onOrigin(r.setAside!.rescue!.branch, 'src/main.ts'), 'rescued before the clone');
  assert.ok(noBackups());
  assert.equal(status(), '');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'beta');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v1');
  assert.ok(notices.some((n) => /cloned the checkout again/.test(n.text)));
  clearRescues();
});

test('sameAsGit: same bytes as HEAD or the other branch count; edits, new files and folders do not', async () => {
  const { sameAsGit } = await import('../src/repos.ts');
  write(dir, 'src/main.ts', 'edited');
  write(dir, 'brand-new.txt', 'x');
  const same = await sameAsGit(dir, ['src/main.ts', 'src/a.ts', 'play/index.html', 'brand-new.txt', 'src', 'missing.txt'], ['HEAD', 'origin/beta', 'no-such-ref']);
  assert.deepEqual([...same].sort(), ['play/index.html', 'src/a.ts']);
  git(dir, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'src/main.ts');
  fs.rmSync(path.join(dir, 'brand-new.txt'));
});

test("not cloned again while a worktree hangs off it: kept, with why", async () => {
  push('src/g.ts', 'g1');
  write(dir, 'src/main.ts', 'agent nearby');
  const wt = path.join(tmp, 'wt');
  git(dir, 'worktree', 'add', '--quiet', '--detach', wt, 'HEAD');
  blockStash(['restore']);
  const before = head();
  const { r } = await quiet(sync).finally(unblockStash);
  git(dir, 'worktree', 'remove', '--force', wt);
  assert.equal(r.action, 'kept');
  assert.match(r.detail, /not cloned again: 1 worktree/);
  assert.equal(head(), before);
  git(dir, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'src/main.ts');
});

test('a clone cut off at its checkout leaves no half-made folder; the next sync clones it on beta', async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  blockStash(['checkout'], true);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /checking out beta failed: git exited (without saying why|with code 128) .*removed the half-made clone/);
  assert.ok(!fs.existsSync(dir));
  const again = await sync();
  assert.equal(again.action, 'cloned', again.detail);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'beta');
  assert.equal(status(), '');
});

test('two syncs at once (a desktop and a phone playtest): one clones, the other waits and finds it clean on beta', async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  const [a, b] = await Promise.all([sync(), sync()]);
  assert.deepEqual([a.action, b.action].sort(), ['cloned', 'current'], `${a.detail} | ${b.detail}`);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'beta');
  assert.equal(status(), '');
  assert.ok(!b.setAside && !a.setAside);
});
