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

test('signFileLinks re-signs links that already carry a signature, and keeps them when signing fails', async () => {
  clearSignedFileUrls();
  const old = `${fileUrl('a_aa11')}?exp=1&sig=old`;
  const fresh = { request: async () => ({ url: `${fileUrl('a_aa11')}?exp=2&sig=new` }) };
  assert.equal(await signFileLinks(`see [Video](${old}) and ${old}.`, { api: fresh }), `see [Video](${fileUrl('a_aa11')}?exp=2&sig=new) and ${fileUrl('a_aa11')}?exp=2&sig=new.`);
  clearSignedFileUrls();
  const down = { request: async () => { throw new Error('offline'); } };
  assert.equal(await signFileLinks(`(${old})`, { api: down }), `(${old})`);
});

test('Talk renders a bare signed Gen link whole, with trailing punctuation outside it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dashboard/talk.js', import.meta.url), 'utf8');
  const body = /function md\(text\) \{[\s\S]*?\n  \}\n/.exec(src)![0];
  const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  const md = new Function('esc', `${body}\nreturn md;`)(esc) as (t: string) => string;
  const u = 'https://hawkesgen.ai/v1/files/a_0f1e?exp=1700000000&sig=AbC_-123';
  const bare = md(`Video: ${u}.`);
  assert.ok(bare.includes('href="https://hawkesgen.ai/v1/files/a_0f1e?exp=1700000000&amp;sig=AbC_-123"'), bare);
  assert.ok(bare.includes('</a>.'), 'the full stop is outside the link');
  assert.ok(md(`(see ${u})`).includes('sig=AbC_-123" target'), 'a closing bracket is not part of the link');
  const named = md(`[Video](${u})`);
  assert.ok(named.includes('sig=AbC_-123" target') && named.includes('>Video</a>'), named);
  assert.ok(md('https://hawkesgen.ai/v1/files/a_0f1e').includes('href="https://hawkesgen.ai/v1/files/a_0f1e"'));
});
