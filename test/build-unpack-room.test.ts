// A finished Unity build bigger than Studio's working space (builds.ts unpackBuild): sick-of-it-unity web 146 (run
// r_136e182c12ed, 2026-11-13) was 1.05 GB from Gen and tar stopped with "Wrote only 5120 of 10240 bytes". Files now go to
// disk while there is room and to the site store past it, and publishSite copies them where they go; with nowhere left the
// error names the bytes needed and free, and it is infrastructure (no agent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unpack-room-'));
Object.assign(process.env, { STUDIO_DATA: path.join(TMP, 'data'), STUDIO_MAIL: 'off' });
fs.mkdirSync(process.env.STUDIO_DATA!, { recursive: true });

const B = await import('../src/builds.ts');
const S = await import('../src/sitestore.ts');
const { classify } = await import('../src/buildfail.ts');
const { isBuilderLoss } = await import('../src/outcomes.ts');
const { failType } = await import('../src/buildaccess.ts');

const MB = 1024 * 1024;
const LONG = `ServerData/WebGL_ASTC/level3_group_assets_level3_background1_part9_8367f777aba20f250504d612df602b97${'x'.repeat(40)}.bundle`;

/** A build folder like Unity's (a long Addressables name, nested folders), packed as Gen packs it (tar -czf from inside it). */
function archive(format: 'gnu' | 'pax' = 'gnu') {
  const src = fs.mkdtempSync(path.join(TMP, 'src-'));
  const files: Record<string, Buffer> = {
    'index.html': Buffer.from('<html><body>game</body></html>'),
    'Build/game.loader.js': Buffer.from('loader();'),
    'Build/game.data': crypto.randomBytes(300_000),
    [LONG]: crypto.randomBytes(200_000),
    'ServerData/WebGL_ASTC/catalog.json': Buffer.from('{"ok":true}'),
    'empty.txt': Buffer.alloc(0),
  };
  for (const [p, d] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true }); fs.writeFileSync(path.join(src, p), d); }
  const tgz = spawnSync('tar', [`--format=${format}`, '-czf', '-', '.'], { cwd: src, maxBuffer: 64 * MB }).stdout as Buffer;
  return { files, tgz };
}

/** An in-memory site store that counts what it was asked. */
function memStore() {
  const objects = new Map<string, { data: Buffer; type: string }>();
  const calls = { put: 0, copy: 0, remove: 0 };
  return {
    objects, calls,
    store: {
      async get(k: string) { return objects.get(k)?.data ?? null; },
      async put(k: string, data: Buffer, type: string) { calls.put++; objects.set(k, { data, type }); },
      async copy(from: string, to: string) { calls.copy++; const o = objects.get(from); if (!o) throw new Error(`no ${from}`); objects.set(to, o); },
      async remove(keys: string[]) { calls.remove++; for (const k of keys) objects.delete(k); },
    },
  };
}

const plenty = async () => ({ free: 50_000 * MB, room: 40_000 * MB });

test('a build archive unpacks file by file, long Addressables names and pax headers included, with git ids that match', async () => {
  for (const format of ['gnu', 'pax'] as const) {
    const { files, tgz } = archive(format);
    const dir = fs.mkdtempSync(path.join(TMP, 'out-'));
    const u = await B.unpackBuild(new Response(tgz), dir, { room: plenty });
    assert.equal(u.staged, 0);
    assert.deepEqual(u.files.map((f) => f.path).sort(), Object.keys(files).sort(), format);
    for (const f of u.files) {
      assert.equal(f.oid, S.gitOid(files[f.path]), f.path);
      assert.equal(f.size, files[f.path].length);
      assert.deepEqual(fs.readFileSync(path.join(dir, f.path)), files[f.path]);
    }
    const out = B.unpackedOutput(u, dir);
    assert.equal((await out.files.find((f) => f.path === LONG)!.read()).length, 200_000);
    out.cleanup();
    assert.equal(fs.existsSync(dir), false, 'cleanup removes the unpacked folder');
  }
});

test('an archive that is one folder is unwrapped like folderOutput, and kept for a site with its own page', async () => {
  const src = fs.mkdtempSync(path.join(TMP, 'wrap-'));
  fs.mkdirSync(path.join(src, 'Game', 'Build'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Game', 'Build', 'Game.loader.js'), 'x');
  const tgz = spawnSync('tar', ['-czf', '-', '.'], { cwd: src }).stdout as Buffer;
  const a = await B.unpackBuild(new Response(tgz), fs.mkdtempSync(path.join(TMP, 'w1-')), { room: plenty });
  assert.deepEqual(B.unpackedOutput(a, TMP + '/none').files.map((f) => f.path), ['Build/Game.loader.js']);
  assert.deepEqual(B.unpackedOutput(a, TMP + '/none', true).files.map((f) => f.path), ['Game/Build/Game.loader.js']);
});

test('past the room on the working volume, the rest of the build goes to the site store and is published by copying it there', async () => {
  const { files, tgz } = archive();
  const dir = fs.mkdtempSync(path.join(TMP, 'tight-'));
  const m = memStore();
  // Room for the small files only: the 300 KB .data and the 200 KB bundle don't fit.
  const room = async () => ({ free: 150_000, room: 100_000 });
  const keys: string[] = [];
  let dropped = 0;
  const stage = {
    async put(rel: string, data: Buffer) { const k = `game/.studio/stage/b_1/${rel}`; await m.store.put(k, data, S.typeOf(rel)); keys.push(k); return k; },
    async drop() { dropped++; await m.store.remove(keys.splice(0)); },
  };
  const said: string[] = [];
  const u = await B.unpackBuild(new Response(tgz), dir, { room, stage, say: (s) => said.push(s) });
  assert.equal(u.staged, 2, 'the two big files are staged');
  assert.ok(u.files.find((f) => f.path === 'Build/game.data')!.at);
  assert.ok(u.files.find((f) => f.path === LONG)!.at);
  assert.equal(fs.existsSync(path.join(dir, 'Build', 'game.data')), false, 'nothing past the room is written to the volume');
  assert.ok(fs.existsSync(path.join(dir, 'index.html')));
  assert.match(said[0], /working space is full .* site store/);
  assert.match(said.at(-1)!, /2 of them .* staged in the site store/);
  // Published: staged files are copied (no bytes through Studio), the rest sent; every file ends where it belongs.
  const out = B.unpackedOutput(u, dir, false, stage, async () => m.store as any);
  assert.deepEqual(await out.files.find((f) => f.path === LONG)!.read(), files[LONG], 'a staged file still reads (commits into a repo use it)');
  const r = await S.publishSite(m.store, 'game/b/web/7', out.files);
  assert.equal(r.copied, 2);
  assert.equal(r.sent, Object.keys(files).length - 2);
  for (const [p, d] of Object.entries(files)) assert.deepEqual(m.objects.get(`game/b/web/7/${p}`)?.data, d, p);
  assert.equal(m.objects.get(`game/b/web/7/${LONG}`)?.type, 'application/octet-stream');
  out.cleanup();
  await new Promise((r) => setImmediate(r));
  assert.equal(dropped, 1);
  assert.equal([...m.objects.keys()].some((k) => k.includes('/.studio/stage/')), false, 'the stage is removed after the publish');
});

test('with no room and nowhere else to put it, the unpack fails naming the bytes needed and free: infrastructure, never an agent', async () => {
  const { tgz } = archive();
  const dir = fs.mkdtempSync(path.join(TMP, 'full-'));
  const room = async () => ({ free: 5 * MB + 123, room: 1000 });
  const e: any = await B.unpackBuild(new Response(tgz), dir, { room, archive: 1_049_494_780 }).catch((x) => x);
  assert.ok(e instanceof B.NoRoom, String(e));
  assert.match(e.message, new RegExp(`^${B.NO_ROOM_PREFIX}`));
  assert.match(e.message, /needs about [\d,]+ MB \(\d+ bytes\) and 5 MB \(5243003 bytes\) is free in /);
  assert.ok(e.need > 0 && e.free === 5 * MB + 123);
  assert.match(e.message, /the archive is 1,001 MB/);
  // Not a download hiccup to try again, and not the game's code.
  assert.equal(B.downloadTransient(e), false);
  const c = classify(e.message);
  assert.equal(c.kind, 'infrastructure');
  assert.match(c.plain, /no room to unpack it .*needs about .* is free/);
  assert.match(c.plain, /nothing is sent to an agent/);
  assert.equal(isBuilderLoss(`the build of beta 148d07a failed (web 146): ${e.message}`), true, 'the PM reads it as the builder\'s loss: nothing goes back to a task');
  assert.notEqual(failType(e.message, { kind: c.kind }), 'code');
  // Even with "error CS" somewhere in the words, it stays infrastructure.
  assert.equal(classify(`${e.message} error CS0103`).kind, 'infrastructure');
});

test('when the site store refuses the rest too, the unpack fails as no room, says why, and drops what it staged', async () => {
  const { tgz } = archive();
  // The store refuses: NoRoom, with its reason, and what was staged is dropped.
  let dropped = 0;
  const refusing = { async put() { throw new Error('R2 said 507'); }, async drop() { dropped++; } };
  const e: any = await B.unpackBuild(new Response(tgz), fs.mkdtempSync(path.join(TMP, 'refuse-')), { room: async () => ({ free: 0, room: 0 }), stage: refusing }).catch((x) => x);
  assert.ok(e instanceof B.NoRoom);
  assert.match(e.message, /site store couldn't take the rest either \(R2 said 507\)/);
  assert.equal(dropped, 1);
});

test('a cut-short or broken archive still reads as before (retried as truncated, or refused as not a tarball)', async () => {
  const { tgz } = archive();
  const cut = tgz.subarray(0, Math.floor(tgz.length / 2));
  const e: any = await B.unpackBuild(new Response(cut), fs.mkdtempSync(path.join(TMP, 'cut-')), { room: plenty }).catch((x) => x);
  assert.match(e.message, /^unpacking the build: /);
  assert.equal(B.downloadTransient(e), true, `cut short is tried again: ${e.message}`);
  assert.match(e.message, B.TRUNCATED);
  const bad: any = await B.unpackBuild(new Response(Buffer.from('not a tarball')), fs.mkdtempSync(path.join(TMP, 'bad-')), { room: plenty }).catch((x) => x);
  assert.match(bad.message, /^unpacking the build: /);
  assert.equal(B.downloadTransient(bad), false);
});

test('a path that would leave the build folder is refused', async () => {
  const src = fs.mkdtempSync(path.join(TMP, 'evil-'));
  fs.writeFileSync(path.join(src, 'a.txt'), 'x');
  const tgz = spawnSync('tar', ['-czf', '-', '--transform', 's,a.txt,../escape.txt,', 'a.txt'], { cwd: src }).stdout as Buffer;
  const dir = fs.mkdtempSync(path.join(TMP, 'evil-out-'));
  const e: any = await B.unpackBuild(new Response(tgz), dir, { room: plenty }).catch((x) => x);
  assert.match(String(e?.message), /outside its folder/);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'escape.txt')), false);
});

test('room is made before a download Gen says won\'t fit, and not otherwise', async () => {
  let swept = 0;
  let free = 100 * MB;
  const room = async () => ({ free, room: free - 10 * MB });
  const sweep = async () => { swept++; free += 2000 * MB; };
  const said: string[] = [];
  assert.equal(await B.makeRoomFor(50 * MB, () => {}, { room, sweep }), false);
  assert.equal(swept, 0);
  assert.equal(await B.makeRoomFor(1_049_494_780, (s) => said.push(s), { room, sweep }), true);
  assert.equal(swept, 1);
  assert.match(said[0], /about 1,001 MB and 90 MB is free/);
  assert.match(said[1], /2,090 MB free for it now$/);
  assert.equal(await B.makeRoomFor(null, () => {}, { room, sweep }), false);
});
