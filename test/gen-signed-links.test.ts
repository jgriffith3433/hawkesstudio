import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const src = readFileSync(new URL('../dashboard/talk.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const refTitle'), src.indexOf('// After a draw'));
  const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  const md = new Function('esc', `${body}\nreturn { md, refTitle, mediaKind };`)(esc).md as (t: string) => string;
  const u = 'https://hawkesgen.ai/v1/files/a_0f1e?exp=1700000000&sig=AbC_-123';
  const bare = md(`Video: ${u}.`);
  assert.ok(bare.includes('href="https://hawkesgen.ai/v1/files/a_0f1e?exp=1700000000&amp;sig=AbC_-123"'), bare);
  assert.ok(bare.includes('</a>.'), 'the full stop is outside the link');
  assert.ok(md(`(see ${u})`).includes('sig=AbC_-123" target'), 'a closing bracket is not part of the link');
  const named = md(`[Video](${u})`);
  assert.ok(named.includes('sig=AbC_-123" target') && named.includes('>Video</a>'), named);
  assert.ok(md('https://hawkesgen.ai/v1/files/a_0f1e').includes('href="https://hawkesgen.ai/v1/files/a_0f1e"'));
});

function loadMd() {
  const src = readFileSync(new URL('../dashboard/talk.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const refTitle'), src.indexOf('// After a draw'));
  const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  return new Function('esc', `${body}\nreturn { md, refTitle, mediaKind };`)(esc) as { md: (t: string) => string; refTitle: any; mediaKind: any };
}

test('Talk renders tables and code blocks in their own scrolling box, code with a Copy button', () => {
  const { md } = loadMd();
  const t = md('| a | b |\n|---|:--:|\n| 1 | `x` |\n| 2 | **y** |\n\nafter');
  assert.ok(t.startsWith('<div class="talk-scroll"><table'), t);
  assert.equal((t.match(/<tr>/g) ?? []).length, 3);
  assert.ok(t.includes('<td><code>x</code></td>') && t.includes('<th>a</th>') && t.endsWith('<p>after</p>'), t);
  const c = md('before\n```js\nif (a < b) {\n  go();\n}\n```\nafter');
  assert.ok(c.includes('<div class="talk-scroll talk-code"><button type="button" class="talk-copy" data-copy>Copy</button><pre><code>if (a &lt; b) {\n  go();\n}</code></pre></div>'), c);
  assert.ok(md('```\nstill streaming').includes('data-copy'), 'an unclosed block (mid-stream) is still a block');
  assert.ok(!md('| not | a table |').includes('<table'), 'a lone pipe row is text');
});

test('Talk shows Gen images and videos inline once their type is known, as a link before', () => {
  const { md, mediaKind } = loadMd();
  const u = 'https://hawkesgen.ai/v1/files/a_0f1e?exp=1&sig=ab';
  assert.ok(md(`see ${u}`).includes('data-embed="a_0f1e"'), 'unknown type: the link, which hydrate resolves');
  mediaKind.a_0f1e = 'video';
  const v = md(`see ${u}.`);
  assert.ok(v.includes('<video class="talk-video" src="https://hawkesgen.ai/v1/files/a_0f1e?exp=1&amp;sig=ab" controls'), v);
  mediaKind.a_0f1e = 'image';
  assert.ok(md(`[shot](${u})`).includes('<img class="talk-img" src="https://hawkesgen.ai/v1/files/a_0f1e?exp=1&amp;sig=ab"'), 'the signed query stays intact');
  assert.ok(md('![x](https://hawkesgen.ai/v1/files/a_0f1e)').includes('<img'), 'markdown image');
  mediaKind.a_0f1e = 'other';
  assert.ok(md(u).includes('data-media='), 'other files stay a link');
});

test('Talk turns item, task, change and finding ids into chips with their titles', () => {
  const { md, refTitle } = loadMd();
  const h = md('Item i_0123456789ab and k_abcdef012345, c_1234567890ab; f_deadbeef01.');
  for (const id of ['i_0123456789ab', 'k_abcdef012345', 'c_1234567890ab', 'f_deadbeef01']) assert.ok(h.includes(`data-ref="${id}"`), id);
  refTitle.c_1234567890ab = { title: 'Fix <b>it' };
  assert.ok(md('c_1234567890ab').includes('>Fix &lt;b&gt;it</span>'), 'the title shows, escaped');
  assert.ok(!md('[x](https://e.com/c_1234567890ab)').includes('data-ref'), 'ids inside a link address stay put');
  assert.ok(!md('abc_0123456789ab and a_0f1e0f1e0f1e').includes('data-ref'), 'only i_ k_ c_ f_');
});
