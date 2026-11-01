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

// A half-written checkout (a clone or switch cut off partway: PH Origins, 2026-11-01, ~1,300 "changes" on main). Studio
// clones from https://github.com/<slug>.git: git's insteadOf points that at the test's bare origin.
const gitConfig = path.join(tmp, 'gitconfig');
fs.writeFileSync(gitConfig, `[url "${origin}"]\n\tinsteadOf = https://github.com/test/site.git\n`);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
const tracked = () => git(dir, 'ls-files').split('\n').filter(Boolean);

test('half-written checkout (tracked files missing), stash fails silently: nothing to back up, restored, follows beta', async () => {
  push('src/e.ts', 'e1');
  for (const f of tracked()) fs.rmSync(path.join(dir, f));
  blockStash([], true);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.match(r.detail, /git exited without saying why/);
  assert.match(r.detail, /none of the \d+ files were there to back up/);
  assert.equal(r.setAside?.backup, undefined);
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  assert.ok(notices.some((n) => /cleared to follow beta/.test(n.title) && /half-written/.test(n.text)));
});

test("can't clear it in place either: what's there is backed up, the checkout is cloned again on beta", async () => {
  push('src/f.ts', 'f1');
  write(dir, 'src/main.ts', 'kept in the backup');
  fs.rmSync(path.join(dir, 'play/index.html'));
  blockStash(['restore']);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.match(r.detail, /so it was cloned again/);
  assert.ok(r.setAside?.recloned && r.setAside.backup);
  assert.deepEqual(tarList(r.setAside!.backup!), ['src/main.ts']);
  assert.equal(status(), '');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'beta');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  assert.equal(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8'), 'v1');
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
  assert.match(r.detail, /checking out beta failed: git exited without saying why .*removed the half-made clone/);
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

// ------------------------------------------- backups: only what GitHub lacks, off the instance's memory, a few kept
// A cell's half-written checkout of PH Origins (2026-11-01) was its whole beta tree, 1,256 files: the stash died and the
// fallback tarred all of it (~518 MiB) to /data, which on Cloud Run is the instance's memory. Files exactly as they are
// on GitHub hold nothing to lose and are left out; on Cloud Run the tar streams to the state bucket instead of /data.
const { backupFiles, sameAsGit, KEEP_BACKUPS, restoreSteps } = await import('../src/repos.ts');
const G = await import('../src/gcp.ts');
const H = await import('../src/cloudhost.ts');

test('half-written checkout (index lost), every file as on GitHub: nothing backed up, restored, follows beta', async () => {
  push('src/h.ts', 'h1');
  fs.rmSync(path.join(dir, '.git', 'index'));
  const localBackups = () => { try { return fs.readdirSync(path.join(process.env.STUDIO_DATA!, 'backups', 'repos')).length; } catch { return 0; } };
  const before = localBackups();
  blockStash([], true);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.match(r.detail, /unchanged from GitHub \(HEAD or origin\/beta\), nothing to back up/);
  assert.equal(r.setAside?.backup, undefined);
  assert.ok((r.setAside?.unchanged ?? 0) >= 3, String(r.setAside?.unchanged));
  assert.equal(localBackups(), before, 'no tar made');
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
  assert.ok(notices.some((n) => /cleared to follow beta/.test(n.title) && /exactly as they are on GitHub/.test(n.text)));
});

test('half-written checkout with one real edit: only that file is in the backup, the rest are counted as left out', async () => {
  push('src/i.ts', 'i1');
  fs.rmSync(path.join(dir, '.git', 'index'));
  write(dir, 'src/main.ts', 'mine, not on GitHub');
  write(dir, 'notes/new.md', 'also mine');
  blockStash([], true);
  const { r } = await quiet(sync).finally(unblockStash);
  assert.equal(r.action, 'updated', r.detail);
  assert.ok(r.setAside?.backup, r.detail);
  assert.deepEqual(tarList(r.setAside!.backup!).sort(), ['notes/new.md', 'src/main.ts']);
  assert.ok((r.setAside!.unchanged ?? 0) >= 3);
  assert.match(r.detail, /unchanged from GitHub left out/);
  assert.equal(status(), '');
  assert.equal(head(), git(dir, 'rev-parse', 'origin/beta'));
});

test('sameAsGit: same bytes as HEAD or the other branch count; edits, new files and folders do not', async () => {
  write(dir, 'src/main.ts', 'edited');
  write(dir, 'brand-new.txt', 'x');
  const same = await sameAsGit(dir, ['src/main.ts', 'src/a.ts', 'play/index.html', 'brand-new.txt', 'src', 'missing.txt'], ['HEAD', 'origin/beta', 'no-such-ref']);
  assert.deepEqual([...same].sort(), ['play/index.html', 'src/a.ts']);
  git(dir, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'src/main.ts');
  fs.rmSync(path.join(dir, 'brand-new.txt'));
});

test('local backups: only the newest few of a folder are kept, another folder with the same start is not touched', async () => {
  const root = path.join(process.env.STUDIO_DATA!, 'backups', 'repos');
  fs.mkdirSync(root, { recursive: true });
  for (const n of fs.readdirSync(root)) fs.rmSync(path.join(root, n));
  fs.writeFileSync(path.join(root, 'site-two-2026-01-01T00-00-00-000Z.tar.gz'), 'other folder');
  for (let i = 0; i < KEEP_BACKUPS + 2; i++) {
    const b = await backupFiles(dir, 'site', ['src/main.ts']);
    assert.ok(b.ok, b.ok ? '' : b.error);
    await new Promise((r) => setTimeout(r, 3));
  }
  const left = fs.readdirSync(root).sort();
  assert.equal(left.filter((n) => /^site-\d/.test(n)).length, KEEP_BACKUPS, left.join(', '));
  assert.ok(left.includes('site-two-2026-01-01T00-00-00-000Z.tar.gz'));
  assert.ok(!H.synced('backups/repos/site-2026-01-01T00-00-00-000Z.tar.gz'), 'never synced to the state bucket');
});

/** Cloud Storage with resumable uploads (a session per upload, pieces checked in order), listing and deleting. */
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const sessions = new Map<string, { key: string; parts: Buffer[] }>();
  const puts: string[] = [];
  const state = { failPutAt: 0, cancelled: 0 };
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? 'GET';
    if (u.pathname.startsWith('/upload/storage/') && u.searchParams.get('uploadType') === 'resumable') {
      const id = `s${sessions.size + state.cancelled}`;
      sessions.set(id, { key: `${u.pathname.split('/')[5]}/${u.searchParams.get('name')}`, parts: [] });
      return new Response('', { status: 200, headers: { location: `https://storage.googleapis.com/upload/session/${id}` } });
    }
    const s = /^\/upload\/session\/(\w+)$/.exec(u.pathname);
    if (s) {
      const sess = sessions.get(s[1]);
      if (!sess) return new Response('no session', { status: 404 });
      if (method === 'DELETE') { sessions.delete(s[1]); state.cancelled++; return new Response('', { status: 499 }); }
      const range = String(init.headers['Content-Range']);
      puts.push(range);
      if (state.failPutAt && puts.length === state.failPutAt) return new Response('backend error', { status: 503 });
      const body = Buffer.from(init.body);
      const had = sess.parts.reduce((n, b) => n + b.length, 0);
      const m = /^bytes (?:(\d+)-(\d+)|\*)\/(\*|\d+)$/.exec(range);
      assert.ok(m, range);
      if (m![1] !== undefined) { assert.equal(Number(m![1]), had); assert.equal(Number(m![2]) - Number(m![1]) + 1, body.length); }
      sess.parts.push(body);
      if (m![3] === '*') { assert.equal(body.length % (256 * 1024), 0); return new Response('', { status: 308 }); }
      const all = Buffer.concat(sess.parts);
      assert.equal(all.length, Number(m![3]));
      objects.set(sess.key, all);
      sessions.delete(s[1]);
      return new Response('{}', { status: 200 });
    }
    const o = /\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(u.pathname);
    if (o && !o[2] && method === 'GET') {
      const prefix = `${o[1]}/${u.searchParams.get('prefix') ?? ''}`;
      const items = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k.slice(o[1].length + 1), size: objects.get(k)!.length, updated: '' }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (o && o[2] && method === 'DELETE') { objects.delete(`${o[1]}/${decodeURIComponent(o[2])}`); return new Response(null, { status: 204 }); }
    return new Response(`unexpected ${method} ${u.pathname}`, { status: 500 });
  }) as typeof fetch;
  return { objects, sessions, puts, state, fetch: f };
}

async function* pieces(data: Buffer, size: number) { for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size); }

test('gcsUploadStream: pieces of 256 KiB multiples in order, the last one names the total; a failure cancels the upload', async () => {
  const store = fakeBucket();
  G.setGcpFetch(store.fetch, 'test-token');
  try {
    const data = Buffer.alloc(700 * 1024, 7);
    for (let i = 0; i < data.length; i += 997) data[i] = i % 251;
    const n = await G.gcsUploadStream('bkt', 'a/b.bin', pieces(data, 100 * 1024), 'application/gzip', 256 * 1024);
    assert.equal(n, data.length);
    assert.ok(store.objects.get('bkt/a/b.bin')!.equals(data));
    assert.deepEqual(store.puts, ['bytes 0-262143/*', 'bytes 262144-524287/*', `bytes 524288-${data.length - 1}/${data.length}`]);
    // A size that is an exact multiple: the last request carries no bytes, only the total.
    store.puts.length = 0;
    await G.gcsUploadStream('bkt', 'a/c.bin', pieces(Buffer.alloc(512 * 1024, 1), 64 * 1024), undefined, 256 * 1024);
    assert.deepEqual(store.puts, ['bytes 0-262143/*', 'bytes 262144-524287/*', 'bytes */524288']);
    assert.equal(store.objects.get('bkt/a/c.bin')!.length, 512 * 1024);
    // The second piece fails: the session is cancelled and nothing is left.
    store.puts.length = 0;
    store.state.failPutAt = 2;
    await assert.rejects(G.gcsUploadStream('bkt', 'a/d.bin', pieces(data, 100 * 1024), undefined, 256 * 1024), /failed at byte 262144 \(503/);
    assert.equal(store.objects.has('bkt/a/d.bin'), false);
    assert.equal(store.sessions.size, 0);
    assert.equal(store.state.cancelled, 1);
    await assert.rejects(G.gcsUploadStream('bkt', 'x', pieces(data, 1), undefined, 1000), /multiple of 256 KiB/);
  } finally { G.setGcpFetch(null); }
});

test('on Cloud Run (a state bucket): the backup streams to <prefix>backups/repos/, never /data; newest few kept; restore from gs://', async () => {
  const store = fakeBucket();
  G.setGcpFetch(store.fetch, 'test-token');
  process.env.STUDIO_STATE_BUCKET = 'cells-bucket';
  process.env.STUDIO_STATE_PREFIX = 'o/acme/';
  const root = path.join(process.env.STUDIO_DATA!, 'backups', 'repos');
  fs.rmSync(root, { recursive: true, force: true });
  try {
    write(dir, 'src/main.ts', 'kept in the bucket');
    const b = await backupFiles(dir, 'site', ['src/main.ts', 'play/index.html', 'gone.txt']);
    assert.ok(b.ok, b.ok ? '' : b.error);
    const key = b.ok ? b.file.replace('gs://cells-bucket/', '') : '';
    assert.match(key, /^o\/acme\/backups\/repos\/site-\d{4}-\d\d-\d\dT[\d-]+Z\.tar\.gz$/);
    assert.ok(!fs.existsSync(root), 'nothing written under the data folder');
    const tgz = store.objects.get(`cells-bucket/${key}`)!;
    assert.equal(b.ok && b.bytes, tgz.length);
    const listed = spawnSync('tar', ['-tzf', '-'], { input: tgz, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(listed, ['play/index.html', 'src/main.ts']);
    const out = fs.mkdtempSync(path.join(tmp, 'restore-'));
    spawnSync('tar', ['-xzf', '-', '-C', out], { input: tgz });
    assert.equal(fs.readFileSync(path.join(out, 'src/main.ts'), 'utf8'), 'kept in the bucket');
    assert.match(restoreSteps(b.ok ? b.file : '', dir), /gcloud storage cat gs:\/\/cells-bucket\/o\/acme\/backups\/repos\/site-.+ \| tar -xzf - -C <your checkout>/);
    assert.match(restoreSteps('/data/backups/repos/x.tar.gz', dir), /tar -xzf \/data\/backups\/repos\/x\.tar\.gz -C /);

    // Retention: a folder keeps its newest KEEP_BACKUPS; another folder, and objects outside backups/, stay.
    store.objects.set('cells-bucket/o/acme/backups/repos/site-two-2026-01-01T00-00-00-000Z.tar.gz', Buffer.from('x'));
    store.objects.set('cells-bucket/o/acme/state/settings.json', Buffer.from('{}'));
    for (let i = 0; i < KEEP_BACKUPS + 1; i++) {
      assert.ok((await backupFiles(dir, 'site', ['src/main.ts'])).ok);
      await new Promise((r) => setTimeout(r, 3));
    }
    const names = [...store.objects.keys()];
    assert.equal(names.filter((n) => /\/repos\/site-\d/.test(n)).length, KEEP_BACKUPS, names.join('\n'));
    assert.ok(names.includes('cells-bucket/o/acme/backups/repos/site-two-2026-01-01T00-00-00-000Z.tar.gz'));
    assert.ok(names.includes('cells-bucket/o/acme/state/settings.json'));

    // The upload fails: an error, no object, nothing on /data.
    const before = store.objects.size;
    store.puts.length = 0;
    store.state.failPutAt = 1;
    const f = await backupFiles(dir, 'site', ['src/main.ts']);
    store.state.failPutAt = 0;
    assert.equal(f.ok, false);
    assert.match(f.ok ? '' : f.error, /503/);
    assert.equal(store.objects.size, before);
    assert.ok(!fs.existsSync(root));
  } finally {
    G.setGcpFetch(null);
    delete process.env.STUDIO_STATE_BUCKET;
    delete process.env.STUDIO_STATE_PREFIX;
    git(dir, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'src/main.ts');
  }
});
