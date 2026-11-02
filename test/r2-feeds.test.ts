// The beta sites written straight to R2's S3 API (src/r2.ts: Signature V4, the Worker's own keys), the store a publish
// picks (sitestore.ts siteStore), and the pushed feeds (src/feeds.ts) that replaced the Playtests and On Air pages' polls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { signV4, r2Store, r2Config, s3Encode } from '../src/r2.ts';
import { serveFeed, feedClients } from '../src/feeds.ts';

test('Signature V4 matches AWS\'s worked example (GET Object)', () => {
  const h = signV4({
    method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('S3 encoding keeps only the unreserved characters', () => {
  assert.equal(s3Encode("a b/c!'()*~"), 'a%20b%2Fc%21%27%28%29%2A~');
  assert.equal(s3Encode('a b/c', true), 'a%20b/c');
  assert.equal(s3Encode(''), '');
});

test('r2Store writes the Worker\'s keys (<lane>/<key>) and only with keys set up', async () => {
  assert.equal(r2Config({}), null);
  const c = r2Config({ STUDIO_R2_ACCOUNT_ID: 'acct', STUDIO_R2_ACCESS_KEY_ID: 'id', STUDIO_R2_SECRET_ACCESS_KEY: 'secret' })!;
  assert.equal(c.endpoint, 'https://acct.r2.cloudflarestorage.com');
  assert.equal(c.bucket, 'hawkes-beta-sites');
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  const fake = (async (url: any, init: any) => {
    calls.push({ method: init.method, url: String(url), headers: init.headers, body: init.body ? Buffer.from(init.body).toString() : undefined });
    if (init.method === 'GET') return new Response('missing', { status: 404 });
    return new Response('');
  }) as typeof fetch;
  const s = r2Store(c, 'live', fake);
  assert.equal(await s.get('dod/beta/index.html'), null);
  await s.put('dod/beta/a b.html', Buffer.from('hi'), 'text/html');
  await s.copy('dod/beta/x.js', 'dod/c/ch_1/x.js');
  await s.remove(['dod/c/ch_1/x.js', 'dod/c/ch_1/<y>']);
  assert.equal(calls[0].url, 'https://acct.r2.cloudflarestorage.com/hawkes-beta-sites/live/dod/beta/index.html');
  assert.equal(calls[1].url, 'https://acct.r2.cloudflarestorage.com/hawkes-beta-sites/live/dod/beta/a%20b.html');
  assert.equal(calls[1].headers['content-type'], 'text/html');
  assert.match(calls[1].headers.authorization, /^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/auto\/s3\/aws4_request/);
  assert.equal(calls[2].headers['x-amz-copy-source'], '/hawkes-beta-sites/live/dod/beta/x.js');
  assert.equal(calls[3].url, 'https://acct.r2.cloudflarestorage.com/hawkes-beta-sites?delete=');
  assert.match(calls[3].body!, /<Key>live\/dod\/c\/ch_1\/x\.js<\/Key>.*<Key>live\/dod\/c\/ch_1\/&lt;y&gt;<\/Key>/);
  assert.ok(calls[3].headers['content-md5']);
  for (const k of calls) assert.ok(!('host' in k.headers));
});

test('with R2 keys, J\'s Studio (no org) publishes straight to R2, not through the Worker', async () => {
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { STUDIO_R2_ACCOUNT_ID: 'acct', STUDIO_R2_ACCESS_KEY_ID: 'id', STUDIO_R2_SECRET_ACCESS_KEY: 'secret' });
    const { siteStore } = await import('../src/sitestore.ts');
    const { siteOrg } = await import('../src/sitekeys.ts');
    // Here (no org): R2 straight. The Worker store's put is a different function; tell them apart by a failing fetch.
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (u: any) => { seen.push(String(u)); return new Response('', { status: 200 }); }) as typeof fetch;
    try {
      if (!siteOrg()) {
        await (await siteStore('hawkesgen.ai')).put('dod/beta/a.txt', Buffer.from('x'), 'text/plain');
        assert.match(seen.at(-1)!, /^https:\/\/acct\.r2\.cloudflarestorage\.com\//);
      }
    } finally {
      globalThis.fetch = real;
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  }
});

test('a feed is read once for every page watching it, sent only when it changed, and stops with its last page', async () => {
  let reads = 0;
  let value = { n: 1, at: 0 };
  const server = http.createServer((req, res) => serveFeed(req, res, 'test', { everyMs: 30, read: async () => { reads++; return { ...value, at: Date.now() }; } }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const open = () => new Promise<{ got: any[]; close: () => void }>((resolve) => {
    const got: any[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { for (const m of chunk.matchAll(/^data: (.+)$/gm)) got.push(JSON.parse(m[1])); });
      resolve({ got, close: () => req.destroy() });
    });
  });
  const a = await open();
  const b = await open();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(feedClients('test'), 2);
  assert.equal(a.got.length, 1, 'unchanged payloads (only `at` moved) are not sent again');
  assert.equal(b.got.length, 1, 'a page that joins gets what the others have at once');
  const before = reads;
  assert.ok(before >= 3 && before < 15, `one read per tick for both pages (${before})`);
  value = { n: 2, at: 0 };
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual([a.got.at(-1).n, b.got.at(-1).n], [2, 2]);
  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(feedClients('test'), 0);
  const after = reads;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(reads, after, 'no reads once nobody watches');
  server.close();
});

test('studio-beta calls gen-beta at its run.app address; browsers keep the public name', async () => {
  const { routeGenDirect } = await import('../src/gendirect.ts');
  const beta: NodeJS.ProcessEnv = { HAWKESGEN_URL: 'https://beta.hawkesgen.ai', GEN_PUBLIC_URL: 'https://beta.hawkesgen.ai' };
  assert.equal(routeGenDirect(beta), 'https://gen-beta-388576319982.us-central1.run.app');
  assert.equal(beta.HAWKESGEN_URL, 'https://gen-beta-388576319982.us-central1.run.app');
  assert.equal(beta.GEN_PUBLIC_URL, 'https://beta.hawkesgen.ai');
  const unset: NodeJS.ProcessEnv = { HAWKESGEN_URL: 'https://beta.hawkesgen.ai/' };
  routeGenDirect(unset);
  assert.equal(unset.GEN_PUBLIC_URL, 'https://beta.hawkesgen.ai');
  const live: NodeJS.ProcessEnv = { HAWKESGEN_URL: 'https://hawkesgen.ai' };
  assert.equal(routeGenDirect(live), null, 'live is J\'s call (deploy.mjs --gen-direct)');
  assert.equal(live.HAWKESGEN_URL, 'https://hawkesgen.ai');
  const off: NodeJS.ProcessEnv = { HAWKESGEN_URL: 'https://beta.hawkesgen.ai', STUDIO_GEN_DIRECT: '0' };
  assert.equal(routeGenDirect(off), null);
  const local: NodeJS.ProcessEnv = { HAWKESGEN_URL: 'http://127.0.0.1:8790' };
  assert.equal(routeGenDirect(local), null);
});
