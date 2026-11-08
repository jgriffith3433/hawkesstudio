// A content change that adds an LFS file in a big repo's partial clone reaches GitHub with its LFS object
// (2026-11-08, Sick of It c_8cc679606350: 71 mp3s committed in the Cloud Run job came back as pointers, and the push failed
// "Unable to find source for object"; c_4a5b5f2c05bc's blobless clone had no credentials for the promisor remote).
// The remote is a local bare repo; the LFS server is a small stand-in speaking the batch API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-job-lfs-'));
const J = await import('../src/cloudjob-run.ts');
const C = await import('../src/cloudjob.ts');
const L = await import('../src/lfs.ts');

const haveLfs = spawnSync('git', ['lfs', 'version']).status === 0;

function lfsServer() {
  const stored = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const base = `http://127.0.0.1:${(server.address() as any).port}`;
      if (req.method === 'POST' && req.url?.endsWith('/objects/batch')) {
        const j = JSON.parse(body.toString());
        const objects = j.objects.map((o: any) => ({ oid: o.oid, size: o.size, ...(j.operation === 'upload' && !stored.has(o.oid) ? { actions: { upload: { href: `${base}/obj/${o.oid}` } } } : {}) }));
        res.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' }).end(JSON.stringify({ transfer: 'basic', objects }));
      } else if (req.method === 'PUT' && req.url?.startsWith('/obj/')) {
        stored.set(req.url.slice(5), body);
        res.writeHead(200).end();
      } else res.writeHead(404).end();
    });
  });
  return new Promise<{ url: string; stored: Map<string, Buffer>; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, stored, close: () => server.close() })));
}

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

test('an LFS mp3 added in a partial clone reaches the remote with its LFS object', { skip: !haveLfs && 'git-lfs is not installed' }, async () => {
  const lfs = await lfsServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-lfs-'));
  try {
    // "GitHub": a bare repo that allows partial clones, with a repo that tracks mp3 in LFS.
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed);
    g(seed, 'init', '--quiet', '-b', 'beta');
    fs.writeFileSync(path.join(seed, '.gitattributes'), '*.mp3 filter=lfs diff=lfs merge=lfs -text\n');
    fs.writeFileSync(path.join(seed, 'readme.txt'), 'hello\n');
    g(seed, 'add', '.');
    g(seed, 'commit', '--quiet', '-m', 'seed');
    const remote = path.join(root, 'origin.git');
    g(root, 'clone', '--quiet', '--bare', seed, remote);
    g(remote, 'config', 'uploadpack.allowFilter', 'true');
    g(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const head = g(remote, 'rev-parse', 'beta');

    // Both the job and Studio talk to the stand-in LFS server (GIT_CONFIG_* reaches git-lfs's own `git config`).
    const lfsEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'lfs.url', GIT_CONFIG_VALUE_0: `${lfs.url}/lfs` };
    Object.assign(process.env, lfsEnv);

    // The job: partial clone, then the "agent" adds a (random, so the hash is new) mp3 and commits it.
    const cwd = path.join(root, 'job', 'work', 'game');
    const mp3 = crypto.randomBytes(5000);
    fs.mkdirSync(path.join(root, 'job'), { recursive: true });
    const objects = new Map<string, Buffer>();
    const store = {
      get: async (k: string) => objects.get(k) ?? null,
      put: async (k: string, d: Buffer | string) => void objects.set(k, Buffer.from(d)),
      list: async (p: string) => [...objects.keys()].filter((k) => k.startsWith(p)),
      remove: async (k: string) => void objects.delete(k),
    } as any;
    const script = `mkdir -p Assets/Audio && cp ${path.join(root, 'new.mp3')} Assets/Audio/line1.mp3 && git add Assets && git commit -q -m 'Add line1.mp3'`;
    fs.writeFileSync(path.join(root, 'new.mp3'), mp3);
    const spec = {
      file: 'sh', args: ['-c', script], cwd, sessions: path.join(root, 'job', 'sessions'),
      env: { ...lfsEnv, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' },
      git: { head, branch: 'agent/x', remote: `file://${remote}`, bundle: false, token: null },
    };
    fs.mkdirSync(spec.sessions, { recursive: true });
    const unit = 'u-lfs';
    objects.set(`jobs/${unit}/spec.json`, Buffer.from(JSON.stringify(spec)));
    assert.equal(await J.runUnit(unit, store), 0, Buffer.concat([...objects].filter(([k]) => k.includes('/out/err')).map(([, v]) => v)).toString());

    // The job's clone is partial and set to store LFS files; the commit holds a pointer, the object went into the store.
    assert.equal(g(cwd, 'config', '--get', 'remote.origin.promisor'), 'true');
    const oid = crypto.createHash('sha256').update(mp3).digest('hex');
    assert.ok(objects.has(`jobs/${unit}/out/lfs/${oid}`), 'the LFS object comes back with the commits');
    const out = JSON.parse(objects.get(`jobs/${unit}/out/exit.json`)!.toString());
    assert.equal(out.error, undefined);

    // Studio: a light (partial, no LFS) checkout of the same branch; the job's work is brought back into it.
    const studio = path.join(root, 'studio');
    g(root, 'clone', '--quiet', '--no-checkout', '--filter=blob:none', `file://${remote}`, studio);
    g(studio, 'checkout', '--quiet', '-B', 'agent/x', head);
    const pack = C.readPack(objects.get(`jobs/${unit}/out/out.pack`)!);
    assert.deepEqual(pack.lfs?.map((r) => r.oid), [oid]);
    await C.bringLfs(store, unit, studio, pack.lfs!);
    C.applyWorkspace(studio, { head: out.git.head, bundle: null, pack: { files: pack.files.filter((f) => !path.isAbsolute(f.p)), deleted: pack.deleted, commit: pack.commit } });
    assert.match(g(studio, 'show', 'HEAD:Assets/Audio/line1.mp3'), /^version https:\/\/git-lfs\.github\.com\/spec/, 'committed as a pointer');
    assert.equal(L.pendingLfs(studio).length, 1);

    // The push: LFS objects first, then the branch (what agents.ts publish does).
    // Async: the stand-in LFS server lives in this process and must keep answering while git-lfs talks to it.
    const run = (d: string, args: string[]) => new Promise<{ ok: boolean; err: string }>((resolve) => execFile('git', args, { cwd: d }, (e, _o, err) => resolve({ ok: !e, err: String(err) })));
    assert.equal(await L.pushPendingLfs(studio, run), 1);
    assert.deepEqual(lfs.stored.get(oid), mp3, 'GitHub has the LFS object');
    assert.equal((await run(studio, ['push', '--quiet', 'origin', 'HEAD:agent/x'])).ok, true);
    assert.match(g(remote, 'show', 'agent/x:Assets/Audio/line1.mp3'), new RegExp(`oid sha256:${oid}`));
    assert.equal(L.pendingLfs(studio).length, 0, 'nothing left to upload');
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k];
    lfs.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pointer is read, and a damaged LFS file is refused', async () => {
  const oid = 'a'.repeat(64);
  assert.deepEqual(L.parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12\n`), { oid, size: 12 });
  assert.equal(L.parsePointer('just text'), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-lfs-bad-'));
  try {
    g(root, 'init', '--quiet', 'w');
    const store = { get: async () => Buffer.from('short'), list: async () => [oid] } as any;
    await assert.rejects(C.bringLfs(store, 'u', path.join(root, 'w'), [{ oid, size: 99 }]), /damaged/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
