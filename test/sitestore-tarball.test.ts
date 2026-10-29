// Beta sites from one GitHub tarball instead of an API call per file (2026-10-29: a first publish of Sick Of It's site
// spent the hour's 5,000 GitHub API calls). extractWanted reads a .tar.gz (pax headers for long paths, one top folder)
// and keeps only the wanted files; publishSite asks its source to prefetch exactly the files it will read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { extractWanted, publishSite, gitOid } = await import('../src/sitestore.ts');

test('extractWanted: only the wanted files, long (pax) paths, the top folder dropped, bytes intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tarsrc-'));
  const top = path.join(root, 'owner-repo-abc1234');
  const long = `Game/v12/${'very-long-folder-name/'.repeat(5)}data.unityweb`;
  const files: Record<string, Buffer> = {
    'index.html': Buffer.from('<html>hi</html>'),
    [long]: Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256)),
    'skip/me.txt': Buffer.from('not wanted'),
    'empty.txt': Buffer.alloc(0),
  };
  for (const [p, b] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, p)), { recursive: true });
    fs.writeFileSync(path.join(top, p), b);
  }
  const tgz = path.join(root, 'a.tar.gz');
  // Relative paths: Git for Windows' tar reads "C:" as a remote host.
  const r = spawnSync('tar', ['--format', 'pax', '-czf', 'a.tar.gz', 'owner-repo-abc1234'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return void test.skip?.(`no tar here: ${r.stderr}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tarout-'));
  const got = await extractWanted(fs.createReadStream(tgz), new Set(['index.html', long, 'empty.txt']), out);
  assert.deepEqual([...got.keys()].sort(), ['empty.txt', 'index.html', long].sort());
  for (const [p, f] of got) assert.equal(gitOid(fs.readFileSync(f)), gitOid(files[p]), p);
});

test('publishSite prefetches exactly the files it will read: changed assets nothing holds, and every page', async () => {
  const objects = new Map<string, Buffer>();
  const store = {
    get: async (k: string) => objects.get(k) ?? null,
    put: async (k: string, d: Buffer) => void objects.set(k, d),
    copy: async (a: string, b: string) => void objects.set(b, objects.get(a)!),
    remove: async (ks: string[]) => void ks.forEach((k) => objects.delete(k)),
  } as any;
  const make = (p: string, s: string) => ({ path: p, oid: gitOid(Buffer.from(s)), size: s.length, read: async () => Buffer.from(s) });
  const first: any = [make('a.js', 'A'), make('b.js', 'B'), make('index.html', '<p>1</p>')];
  let asked: string[] = [];
  first.prefetch = async (paths: string[]) => { asked = paths; };
  await publishSite(store, 's/beta', first);
  assert.deepEqual(asked.sort(), ['a.js', 'b.js', 'index.html']);
  // Next publish: a.js unchanged, b.js changed, c.js has a.js's bytes (copied in R2, not read), the page again.
  const second: any = [make('a.js', 'A'), make('b.js', 'B2'), make('c.js', 'A'), make('index.html', '<p>2</p>')];
  second.prefetch = async (paths: string[]) => { asked = paths; };
  await publishSite(store, 's/beta', second);
  assert.deepEqual(asked.sort(), ['b.js', 'index.html']);
});
