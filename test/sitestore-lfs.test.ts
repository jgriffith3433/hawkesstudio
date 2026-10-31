// A static site's file kept in Git LFS is published as the file, not as its pointer (sitestore.ts githubFiles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const S = await import('../src/sitestore.ts');

test('an LFS pointer is replaced by the file from GitHub\'s media address; ordinary files are read as they are', async () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n';
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(String(url));
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ path: 'Game/big.data', type: 'blob', sha: 'b1', size: pointer.length }, { path: 'index.html', type: 'blob', sha: 'b2', size: 5 }] }));
    if (u.endsWith('/git/blobs/b1')) return new Response(pointer);
    if (u.endsWith('/git/blobs/b2')) return new Response('<p/>');
    if (u.startsWith('https://media.githubusercontent.com/media/acme/site/c0ffee/Game/big.data')) return new Response('real-data');
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const files = await S.githubFiles('acme/site', 'c0ffee', { fetcher });
  const by = Object.fromEntries(await Promise.all(files.map(async (f) => [f.path, (await f.read()).toString('utf8')])));
  assert.equal(by['Game/big.data'], 'real-data');
  assert.equal(by['index.html'], '<p/>');
});
