import { test } from 'node:test';
import assert from 'node:assert/strict';
const { signedFileUrl, signFileLinks, clearSignedFileUrls, fileUrl } = await import('../src/gen.ts');

const ok = (calls: string[]) => ({ request: async (p: string, o: any) => { calls.push(`${o?.method} ${p}`); return { url: `/v1/files/a_aa11?exp=9&sig=zz` }; } });

test('signing asks Gen for a signed link and caches it', async () => {
  clearSignedFileUrls();
  const calls: string[] = [];
  const u = await signedFileUrl('a_aa11', { api: ok(calls), days: 3 });
  assert.match(u, /\/v1\/files\/a_aa11\?exp=9&sig=zz$/);
  assert.match(u, /^https?:\/\//);
  assert.deepEqual(calls, ['POST /assets/a_aa11?sign=1&ttl=3']);
  await signedFileUrl('a_aa11', { api: ok(calls) });
  assert.equal(calls.length, 1, 'second look is cached');
});

test('a failing or odd sign answer falls back to the bare link', async () => {
  clearSignedFileUrls();
  assert.equal(await signedFileUrl('a_bb22', { api: { request: async () => { throw new Error('404'); } } }), fileUrl('a_bb22'));
  assert.equal(await signedFileUrl('a_cc33', { api: { request: async () => ({}) } }), fileUrl('a_cc33'));
  assert.equal(await signedFileUrl('nope', { api: ok([]) }), fileUrl('nope'));
});

test('signFileLinks replaces bare links in a text and leaves the rest', async () => {
  clearSignedFileUrls();
  const t = `video ${fileUrl('a_aa11')} and ${fileUrl('a_dd44')}) end`;
  const out = await signFileLinks(t, { api: { request: async (p: string) => { if (p.includes('a_dd44')) throw new Error('x'); return { url: `${fileUrl('a_aa11')}?exp=1&sig=s` }; } } });
  assert.ok(out.includes(`${fileUrl('a_aa11')}?exp=1&sig=s and ${fileUrl('a_dd44')})`), out);
});
