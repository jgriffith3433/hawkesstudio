// Beta sites on Cloudflare (docs/studio-cloudrun.md, "Beta sites"): Studio's keys and passes (sitekeys.ts), the
// publisher (sitestore.ts) against the real Worker code (server/beta-sites/src/index.ts) over an in-memory R2, the
// sign-in handshake, both lanes kept apart, previews-cloud.ts from a fake GitHub (static, Unity and built sites, a
// change's preview), and the job runner's build mode (cloudjob-run.ts) end to end with runCloudBuild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sites-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
process.env.STUDIO_MAIL = 'off';
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });

const K = await import('../src/sitekeys.ts');
const S = await import('../src/sitestore.ts');
const W = await import('../server/beta-sites/src/index.ts');
type R2Like = import('../server/beta-sites/src/index.ts').R2Like;
type Env = import('../server/beta-sites/src/index.ts').Env;

const LIVE = { STUDIO_OWNER_KEY: 'live-owner-key-0123456789' } as NodeJS.ProcessEnv;
const BETA = { STUDIO_OWNER_KEY: 'beta-owner-key-0123456789', STUDIO_LANE: 'beta' } as NodeJS.ProcessEnv;
const liveKeys = K.siteKeys(LIVE)!;
const betaKeys = K.siteKeys(BETA)!;

/** An in-memory R2 bucket with what the Worker uses. */
function memR2() {
  const m = new Map<string, { data: Uint8Array; type?: string; enc?: string }>();
  const obj = (k: string, v: { data: Uint8Array; type?: string; enc?: string }, body: boolean, range?: { offset: number; length: number }) => {
    const data = range ? v.data.slice(range.offset, range.offset + range.length) : v.data;
    return {
      size: v.data.length, httpEtag: `"${crypto.createHash('md5').update(v.data).digest('hex')}"`, httpMetadata: { contentType: v.type, ...(v.enc ? { contentEncoding: v.enc } : {}) },
      body: body ? new Response(data as Uint8Array<ArrayBuffer>).body : null, ...(range ? { range } : {}), key: k,
    };
  };
  const r2: R2Like & { m: typeof m } = {
    m,
    async get(k, o) {
      const v = m.get(k);
      if (!v) return null;
      const etag = `"${crypto.createHash('md5').update(v.data).digest('hex')}"`;
      if (o?.onlyIf?.get('If-None-Match') === etag) return obj(k, v, false);
      const rh = /^bytes=(\d+)-(\d*)$/.exec(o?.range?.get('Range') ?? '');
      if (rh) {
        const start = Number(rh[1]);
        const end = rh[2] ? Number(rh[2]) : v.data.length - 1;
        return obj(k, v, true, { offset: start, length: end - start + 1 });
      }
      return obj(k, v, true);
    },
    async head(k) { const v = m.get(k); return v ? obj(k, v, false) : null; },
    async put(k, value, o) {
      const data = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value ?? new ArrayBuffer(0));
      m.set(k, { data, type: o?.httpMetadata?.contentType, enc: o?.httpMetadata?.contentEncoding });
    },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k); },
  };
  return r2;
}

const r2 = memR2();
const env: Env = {
  SITES: r2, DOMAIN: 'hawkesgen.ai',
  STUDIO_ORIGIN_LIVE: 'https://studio-live.run.app', STUDIO_ORIGIN_BETA: 'https://studio-beta.run.app',
  STUDIO_PUBLIC_LIVE: 'https://studio.hawkesgen.ai', STUDIO_PUBLIC_BETA: 'https://studio-beta.hawkesgen.ai',
};
// The Worker asks each lane's Studio for its public key; the 🐞 posts go there too.
const studioCalls: Request[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const req = new Request(input, init);
  const u = new URL(req.url);
  if (u.pathname === '/auth/sites-key') {
    const lane = u.host.startsWith('studio-beta') ? 'beta' : 'live';
    return Response.json({ lane, alg: 'Ed25519', key: (lane === 'beta' ? betaKeys : liveKeys).publicKey });
  }
  if (u.pathname.startsWith('/dev/__studio/')) { studioCalls.push(req); return Response.json({ ok: true, id: 'f_1' }); }
  return realFetch(input, init);
}) as typeof fetch;

/** Studio's store, calling the Worker directly. */
const storeFor = (lane: 'live' | 'beta', keys = lane === 'beta' ? betaKeys : liveKeys) => S.workerStore('https://sites.hawkesgen.ai', {
  lane, fetcher: (async (u: any, init: any) => W.handle(new Request(u, init), env)) as typeof fetch,
  sign: (l, m, p, b) => K.signPublish(l, m, p, b, { keys }),
});
const browse = (url: string, o: { pass?: string | null; cookie?: string; page?: boolean; headers?: Record<string, string>; method?: string; body?: string } = {}) => W.handle(new Request(url, {
  method: o.method ?? 'GET', body: o.body,
  headers: { ...(o.page ?? true ? { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } : {}), ...(o.cookie ? { Cookie: o.cookie } : {}), ...(o.headers ?? {}) },
}), env);
const file = (p: string, text: string): import('../src/sitestore.ts').SiteFile => { const d = Buffer.from(text); return { path: p, oid: S.gitOid(d), size: d.length, read: async () => d }; };

test('keys: a pass made by Studio is accepted by the Worker for its lane only, until it expires', async () => {
  W.resetKeys();
  const pass = K.makePass('u_j', { lane: 'live', keys: liveKeys });
  assert.equal(await W.checkPass(env, 'live', pass), 'u_j');
  assert.equal(await W.checkPass(env, 'beta', pass), null, 'a live pass is no good on studio-beta\'s hosts');
  const forged = K.makePass('u_j', { lane: 'live', keys: betaKeys });
  assert.equal(await W.checkPass(env, 'live', forged), null, 'signed with the other lane\'s key');
  const old = K.makePass('u_j', { lane: 'live', keys: liveKeys, now: Date.now() - K.PASS_MS - 60_000 });
  assert.equal(await W.checkPass(env, 'live', old), null, 'expired');
  assert.equal(S.gitOid(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', 'the same id git gives a blob');
  assert.notEqual(liveKeys.publicKey, betaKeys.publicKey);
  assert.equal(K.siteKeys({} as NodeJS.ProcessEnv), null, 'no secret, no key (a local Studio)');
});

test('keys: /auth/pass only sends the browser back to a beta host of its own lane', () => {
  assert.match(K.passReturn('https://dod.hawkesgen.ai/Game/?x=1', 'hawkesgen.ai', 'live')!, /^https:\/\/dod\.hawkesgen\.ai\/Game\/\?x=1&__hawkes_pass=1$/);
  for (const bad of ['https://evil.com/', 'http://dod.hawkesgen.ai/', 'https://studio.hawkesgen.ai/', 'https://a.b.hawkesgen.ai/', 'https://sb-dod.hawkesgen.ai/', 'javascript:alert(1)']) {
    assert.equal(K.passReturn(bad, 'hawkesgen.ai', 'live'), null, bad);
  }
  assert.ok(K.passReturn('https://sb-dod.hawkesgen.ai/', 'hawkesgen.ai', 'beta'));
  assert.equal(K.passReturn('https://dod.hawkesgen.ai/', 'hawkesgen.ai', 'beta'), null);
  assert.equal(K.siteHost('dod', 'hawkesgen.ai', 'beta'), 'sb-dod.hawkesgen.ai');
  assert.match(K.passSetCookie('v', 'hawkesgen.ai', 'beta'), /^hawkes_pass_beta=v; .*Domain=hawkesgen\.ai/);
});

test('publish: incremental, pages get the widget, removed files go, writes are signed per lane', async () => {
  W.resetKeys();
  const live = storeFor('live');
  const v1 = [file('index.html', '<!doctype html><html><head><meta charset="utf-8"></head><body>hi</body></html>'), file('a.js', 'a1'), file('img/b.png', 'b1'), file('old.txt', 'o')];
  const r1 = await S.publishSite(live, 'dod/beta', v1, { page: { product: 'doseofdestruction', sha: 'abc1234' }, build: { sha: 'abc1234' } });
  assert.deepEqual([r1.sent, r1.copied, r1.removed], [4, 0, 0]);
  const html = new TextDecoder().decode(r2.m.get('live/dod/beta/index.html')!.data);
  assert.match(html, /\/dev\/__studio\/report\.js/, 'the 🐞 widget is in the page');
  assert.equal(r2.m.get('live/dod/beta/img/b.png')!.type, 'image/png');
  const v2 = [v1[0], file('a.js', 'a2'), v1[2]];
  const r2b = await S.publishSite(live, 'dod/beta', v2, { page: { product: 'doseofdestruction', sha: 'def5678' } });
  assert.deepEqual([r2b.sent, r2b.copied, r2b.removed], [2, 0, 1], 'only the changed file and the page are sent, old.txt removed');
  assert.ok(!r2.m.has('live/dod/beta/old.txt'));
  // A change's preview copies what beta already has inside R2.
  const r3 = await S.publishSite(live, 'dod/c/c_ab12', [v2[0], v2[1], v2[2], file('new.js', 'n')], { copyFrom: ['dod/beta'] });
  assert.deepEqual([r3.sent, r3.copied], [2, 2]);
  assert.equal(new TextDecoder().decode(r2.m.get('live/dod/c/c_ab12/a.js')!.data), 'a2');
  // studio-beta writes under beta/, never live/; and can't write with live's prefix by signing with its own key as live.
  const beta = storeFor('beta');
  await S.publishSite(beta, 'dod/beta', [file('index.html', '<html><body>sb</body></html>')]);
  assert.ok(r2.m.has('beta/dod/beta/index.html'));
  assert.match(new TextDecoder().decode(r2.m.get('live/dod/beta/index.html')!.data), /hi/, 'live untouched');
  const impostor = storeFor('live', betaKeys);
  await assert.rejects(impostor.put('dod/beta/index.html', Buffer.from('x'), 'text/html'), /403/);
  // A key outside the lane is refused.
  await assert.rejects(live.copy('dod/beta/a.js', '../beta/dod/beta/a.js'), /bad key/);
  // Removing the change's preview.
  assert.ok((await S.removeSite(live, 'dod/c/c_ab12')) >= 4);
  assert.ok(![...r2.m.keys()].some((k) => k.startsWith('live/dod/c/c_ab12/')));
});

test('serve: signed in with a pass, or sent to Studio for one; the widget, build info and 🐞 posts', async () => {
  W.resetKeys();
  const pass = K.makePass('u_j', { lane: 'live', keys: liveKeys });
  const cookie = `hawkes_session=s; hawkes_pass=${pass}`;
  // No pass: a page goes to Studio's /auth/pass, anything else is 401.
  let r = await browse('https://dod.hawkesgen.ai/a.js?x=1');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), `https://studio.hawkesgen.ai/auth/pass?next=${encodeURIComponent('https://dod.hawkesgen.ai/a.js?x=1')}`);
  r = await browse('https://dod.hawkesgen.ai/a.js', { page: false });
  assert.equal(r.status, 401);
  // Back from /auth/pass without the cookie kept: a page that says so, not a loop.
  r = await browse('https://dod.hawkesgen.ai/?__hawkes_pass=1');
  assert.equal(r.status, 403);
  // With it: the marker is dropped, then the files.
  r = await browse('https://dod.hawkesgen.ai/?__hawkes_pass=1', { cookie });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/');
  r = await browse('https://dod.hawkesgen.ai/', { cookie });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /hi/);
  r = await browse('https://dod.hawkesgen.ai/a.js', { cookie, page: false });
  assert.equal(await r.text(), 'a2');
  const etag = r.headers.get('ETag')!;
  r = await browse('https://dod.hawkesgen.ai/a.js', { cookie, page: false, headers: { 'If-None-Match': etag } });
  assert.equal(r.status, 304);
  r = await browse('https://dod.hawkesgen.ai/img/b.png', { cookie, page: false, headers: { Range: 'bytes=1-1' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 1-1/2');
  r = await browse('https://dod.hawkesgen.ai/img', { cookie });
  assert.equal(r.status, 404, 'no img/index.html');
  r = await browse('https://dod.hawkesgen.ai/.studio/manifest.json', { cookie, page: false });
  assert.equal(r.status, 404, 'Studio\'s own files are never served');
  r = await browse('https://dod.hawkesgen.ai/dev/__studio/build', { cookie, page: false });
  assert.deepEqual(await r.json(), { sha: 'abc1234' });
  await S.publishWidget(storeFor('live'), path.join(import.meta.dirname, '..', 'dashboard', 'report-widget.js'));
  r = await browse('https://dod.hawkesgen.ai/dev/__studio/report.js', { cookie, page: false });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type')!, /javascript/);
  // A 🐞 report goes to the lane's Studio with the beta host and the session cookie.
  r = await browse('https://dod.hawkesgen.ai/dev/__studio/report', { cookie, page: false, method: 'POST', body: '{"text":"x"}', headers: { 'Content-Type': 'application/json', Origin: 'https://dod.hawkesgen.ai' } });
  assert.equal(r.status, 200);
  const sent = studioCalls.at(-1)!;
  assert.equal(new URL(sent.url).host, 'studio-live.run.app');
  assert.equal(sent.headers.get('X-Forwarded-Host'), 'dod.hawkesgen.ai');
  assert.match(sent.headers.get('Cookie')!, /hawkes_session=s/);
  // The studio-beta lane: its own pass, its own files, its own Studio.
  r = await browse('https://sb-dod.hawkesgen.ai/', { cookie });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('Location')!, /^https:\/\/studio-beta\.hawkesgen\.ai\/auth\/pass\?next=/);
  const bpass = K.makePass('u_j', { lane: 'beta', keys: betaKeys });
  r = await browse('https://sb-dod.hawkesgen.ai/', { cookie: `hawkes_pass_beta=${bpass}` });
  assert.match(await r.text(), /sb/);
  // A stale pass sent before the good one (two cookies of one name) doesn't hide it (2026-10-29: J's beta sites 403'd).
  const stale = K.makePass('u_j', { lane: 'beta', keys: liveKeys });
  r = await browse('https://sb-dod.hawkesgen.ai/', { cookie: `hawkes_pass_beta=${stale}; hawkes_pass_beta=${bpass}` });
  assert.match(await r.text(), /sb/);
  // Read only.
  r = await browse('https://dod.hawkesgen.ai/a.js', { cookie, page: false, method: 'PUT', body: 'x' });
  assert.equal(r.status, 405);
});

test('previews-cloud: static, Unity and built sites from a fake GitHub, and a change from its worktree', async () => {
  const { publishCloud, SiteWaiting, pick } = await import('../src/previews-cloud.ts');
  const { keptGameVersions, skip, recipeOf } = await import('../src/previews.ts');
  const blobs = new Map<string, Buffer>();
  const trees: Record<string, { path: string; text: string }[]> = {
    s1: [{ path: 'index.html', text: '<html><body>corp</body></html>' }, { path: '.github/workflows/x.yml', text: 'x' }, { path: 'css/a.css', text: 'a{}' }],
    u1: [{ path: 'index.html', text: '<html><body>soi</body></html>' }, { path: 'Game/v5/Build/x.data.unityweb', text: 'v5' }],
    u2: [{ path: 'index.html', text: '<html><body>soi</body></html>' }, { path: 'Game/v6/Build/x.data.unityweb', text: 'v6' }],
    d1: [{ path: 'index.html', text: '<html><body>src</body></html>' }, { path: 'characters/a.png', text: 'png' }, { path: 'src/main.ts', text: 'ts' }, { path: 'package.json', text: '{}' }],
  };
  const heads: Record<string, string> = { 'jgriffith3433/hawkesbiomedical': 's1', 'jgriffith3433/sickofitgamewebsite': 'u1', 'jgriffith3433/doseofdestructionwebsite': 'd1' };
  const gh = (async (u: any) => {
    const url = new URL(String(u));
    let m = /^\/repos\/(.+?\/.+?)\/commits\/(.+)$/.exec(url.pathname);
    if (m) return m[2] === 'beta' && heads[m[1]] ? new Response(heads[m[1]]) : new Response('no', { status: 404 });
    m = /^\/repos\/.+?\/.+?\/git\/trees\/(\w+)$/.exec(url.pathname);
    if (m) {
      return Response.json({ truncated: false, tree: trees[m[1]].map((f) => { const d = Buffer.from(f.text); const oid = S.gitOid(d); blobs.set(oid, d); return { path: f.path, type: 'blob', mode: '100644', sha: oid, size: d.length }; }) });
    }
    m = /\/git\/blobs\/(\w+)$/.exec(url.pathname);
    if (m) return new Response(new Uint8Array(blobs.get(m[1])!));
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  const { getProduct } = await import('../src/config.ts');
  const store = storeFor('live');
  const progress: string[] = [];
  // Static: the committed files, nothing hidden.
  const corp = await publishCloud(getProduct('hawkesbiomedical'), 'corporate', {}, (s) => progress.push(s), { store, fetcher: gh, skip, recipe: recipeOf('hawkesbiomedical') });
  assert.equal(corp.sha, 's1');
  assert.ok(r2.m.has('live/corporate/beta/css/a.css'));
  assert.ok(![...r2.m.keys()].some((k) => k.includes('.github')));
  // Unity: the website's beta; the previous Game/v<n> stays while a page may still load it.
  let kept: Record<string, number> = {};
  const deps = { store, fetcher: gh, skip, keptVersions: keptGameVersions, kept: { get: () => kept, set: (v: Record<string, number>) => { kept = v; } } };
  const u1 = await publishCloud(getProduct('sickofit'), 'sickofit', {}, () => {}, deps);
  assert.equal(u1.version, '5');
  heads['jgriffith3433/sickofitgamewebsite'] = 'u2';
  const u2 = await publishCloud(getProduct('sickofit'), 'sickofit', {}, () => {}, deps);
  assert.equal(u2.version, '6');
  assert.ok(r2.m.has('live/sickofit/beta/Game/v5/Build/x.data.unityweb'), 'v5 kept');
  assert.ok('5' in kept);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r2.m.get('live/sickofit/beta/.studio/build.json')!.data)).version, '6');
  await assert.rejects(publishCloud(getProduct('sickofit'), 'sickofit', { change: 'c_1' }, () => {}, { ...deps, changeRow: () => ({ worktree: null, branch: 'x', repo: 'sickofitgame-unity' }) }), SiteWaiting);
  // Built: the recipe's committed parts from GitHub, the build's output from the "job".
  let asked: any = null;
  const build = (async (_unit: string, o: any) => {
    asked = o;
    const dir = fs.mkdtempSync(path.join(TMP, 'out-'));
    fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<html><body>built</body></html>');
    fs.writeFileSync(path.join(dir, 'dist', 'assets', 'game.js'), 'game');
    const tgz = execFileSync('tar', ['-czf', '-', 'dist'], { cwd: dir });
    return { code: 0, log: 'ok', outputs: tgz };
  }) as any;
  const dod = await publishCloud(getProduct('doseofdestruction'), 'dod', {}, () => {}, { store, fetcher: gh, skip, recipe: recipeOf('doseofdestruction'), build });
  assert.equal(dod.sha, 'd1');
  assert.equal(asked.head, 'd1');
  assert.deepEqual(asked.outputs, ['dist']);
  assert.match(asked.command, /npm ci/);
  assert.match(new TextDecoder().decode(r2.m.get('live/dod/beta/index.html')!.data), /built/, 'the build\'s page over the committed one');
  assert.ok(r2.m.has('live/dod/beta/assets/game.js') && r2.m.has('live/dod/beta/characters/a.png'));
  assert.ok(!r2.m.has('live/dod/beta/src/main.ts'), 'not in the recipe');
  assert.deepEqual(pick([file('a/b', ''), file('ab', ''), file('a', '')], ['a']).map((f) => f.path), ['a/b', 'a']);
  // A change: its commit from its worktree, its build, beta's files copied.
  const wt = path.join(TMP, 'wt');
  fs.mkdirSync(path.join(wt, 'characters'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'index.html'), '<html><body>change</body></html>');
  fs.writeFileSync(path.join(wt, 'characters', 'a.png'), 'png');
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: wt });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c'], { cwd: wt });
  const c = await publishCloud(getProduct('doseofdestruction'), 'dod', { change: 'c_9' }, () => {}, { store, fetcher: gh, skip, recipe: recipeOf('doseofdestruction'), build, changeRow: () => ({ worktree: wt, branch: 'task/x', repo: 'doseofdestructionwebsite' }) });
  assert.equal(c.ref, 'change c_9');
  assert.ok(asked.bundle, 'GitHub lacks the commit: it goes to the job as a bundle');
  assert.ok(r2.m.has('live/dod/c/c_9/characters/a.png'));
});

test('the job runner builds one commit shallowly and sends back only its outputs (runCloudBuild end to end)', async () => {
  const { runUnit } = await import('../src/cloudjob-run.ts');
  const J = await import('../src/cloudjob.ts');
  // A "GitHub" repo.
  const remote = path.join(TMP, 'remote');
  fs.mkdirSync(remote);
  fs.writeFileSync(path.join(remote, 'package.json'), '{}');
  execFileSync('git', ['init', '-q', '-b', 'beta'], { cwd: remote });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: remote });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one'], { cwd: remote });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remote, encoding: 'utf8' }).trim();
  const bucket = new Map<string, Buffer>();
  const at = (p: string) => path.join(TMP, 'job', p.replace(/^[A-Za-z]:/, ''));
  let ran: Promise<number> | null = null;
  const store = {
    put: async (k: string, d: Buffer | string) => { bucket.set(k, Buffer.from(d)); },
    get: async (k: string) => bucket.get(k) ?? null,
    list: async (p: string) => [...bucket.keys()].filter((k) => k.startsWith(p)),
    remove: async (k: string) => { bucket.delete(k); },
  };
  J.setJobRunner(() => ({
    ...store,
    start: async (unit) => {
      // /bin/sh isn't on Windows: the same work as node.
      const spec = JSON.parse(bucket.get(`jobs/${unit}/spec.json`)!.toString());
      assert.equal(spec.kind, 'build');
      assert.equal(spec.git.shallow, true);
      spec.file = process.execPath;
      spec.args = ['-e', "require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/i.html','ok');console.log('built in 1s')"];
      bucket.set(`jobs/${unit}/spec.json`, Buffer.from(JSON.stringify(spec)));
      ran = runUnit(unit, store, { every: 50, at });
      return 'exec-1';
    },
    state: async () => ({ done: false, message: '' }),
    cancel: async () => {},
  }));
  const lines: string[] = [];
  const b = await J.runCloudBuild('site-t-1', { remote, head, cwd: '/tmp/build/x', command: 'npm run build', outputs: ['dist', 'missing'], every: 50, onLine: (l) => lines.push(l) });
  await ran;
  J.setJobRunner(null);
  assert.equal(b.code, 0, b.error ?? b.log);
  assert.ok(b.outputs);
  const out = fs.mkdtempSync(path.join(TMP, 'x-'));
  execFileSync('tar', ['-xzf', '-'], { cwd: out, input: b.outputs });
  assert.equal(fs.readFileSync(path.join(out, 'dist', 'i.html'), 'utf8'), 'ok');
  assert.ok(lines.some((l) => /built in/.test(l)));
  assert.equal(J.buildsRunning(), 0);
  assert.ok(!bucket.has('jobs/site-t-1/out/out.pack'), 'no workspace or session comes back from a build');
});

test.after(() => {
  globalThis.fetch = realFetch;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows keeps a handle a moment longer */ }
});

test('a playtest of a beta site gets a pass (Gen playtest.run cookies) the Worker accepts, for an hour', async () => {
  W.resetKeys();
  const saved = { seed: process.env.STUDIO_SITES_SEED, lane: process.env.STUDIO_LANE };
  try {
    process.env.STUDIO_SITES_SEED = BETA.STUDIO_SITES_SEED ?? BETA.STUDIO_OWNER_KEY;
    const [c] = K.playtestCookies('beta');
    assert.equal(c.name, 'hawkes_pass_beta');
    assert.equal(c.domain, '.hawkesgen.ai');
    assert.equal(await W.checkPass(env, 'beta', c.value), 'playtest');
    const exp = Number(c.value.split('.')[2]) * 1000;
    assert.ok(exp > Date.now() + 50 * 60_000 && exp < Date.now() + 61 * 60_000, 'about an hour');
    assert.ok(K.withPass().cookies?.length, 'withPass gives Gen the cookies param');
    delete process.env.STUDIO_SITES_SEED;
    const owner = process.env.STUDIO_OWNER_KEY;
    delete process.env.STUDIO_OWNER_KEY;
    assert.deepEqual(K.playtestCookies('beta'), [], 'no key, no pass');
    if (owner !== undefined) process.env.STUDIO_OWNER_KEY = owner;
  } finally {
    if (saved.seed === undefined) delete process.env.STUDIO_SITES_SEED; else process.env.STUDIO_SITES_SEED = saved.seed;
  }
});

test('Unity builds: public at sites.<domain>/builds/, Brotli files sent with their encoding, cached for good, open CORS', async () => {
  const W = await import('../server/beta-sites/src/index.ts');
  await r2.put('builds/yoobaland/v181/YoobaLand/Build/YoobaLand.wasm.unityweb', new TextEncoder().encode('br-bytes').buffer as ArrayBuffer, { httpMetadata: { contentType: 'application/wasm', contentEncoding: 'br' } });
  await r2.put('builds/yoobaland/v181/sizes.json', '{}', { httpMetadata: { contentType: 'application/json' } });
  const get = (p: string, init?: RequestInit) => W.handle(new Request(`https://sites.hawkesgen.ai${p}`, init), env);
  const wasm = await get('/builds/yoobaland/v181/YoobaLand/Build/YoobaLand.wasm.unityweb');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('Content-Encoding'), 'br');
  assert.equal(wasm.headers.get('Content-Type'), 'application/wasm');
  assert.equal(wasm.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(wasm.headers.get('Cache-Control') ?? '', /immutable/);
  assert.equal(await wasm.text(), 'br-bytes');
  const plain = await get('/builds/yoobaland/v181/sizes.json');
  assert.equal(plain.headers.get('Content-Encoding'), null);
  assert.equal(plain.headers.get('Content-Length'), '2');
  assert.equal((await get('/builds/yoobaland/v181/', { method: 'OPTIONS' })).status, 204);
  for (const bad of ['/builds/yoobaland/v181/../x', '/builds/Yooba/v1/a', '/builds/yoobaland/latest/a', '/builds/yoobaland/v9/missing']) assert.equal((await get(bad)).status, 404, bad);
  // Only that host and path are public: a beta site still wants a pass.
  assert.notEqual((await W.handle(new Request('https://sb-dod.hawkesgen.ai/builds/yoobaland/v181/sizes.json'), env)).status, 200);
});

test("an added game's beta site is a path on sites.<domain>: /g/<game>/ for live Studio, /b/<game>/ for studio-beta", async () => {
  W.resetKeys();
  await r2.put('live/g-orbit-run/beta/index.html', '<p>orbit live</p>', { httpMetadata: { contentType: 'text/html' } });
  await r2.put('live/g-orbit-run/beta/assets/app.js', 'js', { httpMetadata: { contentType: 'text/javascript' } });
  await r2.put('beta/g-orbit-run/beta/index.html', '<p>orbit beta lane</p>', { httpMetadata: { contentType: 'text/html' } });
  const live = `hawkes_pass=${K.makePass('u_j', { lane: 'live', keys: liveKeys })}`;
  const beta = `hawkes_pass_beta=${K.makePass('u_j', { lane: 'beta', keys: betaKeys })}`;
  let r = await browse('https://sites.hawkesgen.ai/g/orbit-run');
  assert.equal(r.status, 301, 'a trailing slash first, so its relative paths resolve');
  assert.equal(r.headers.get('Location'), '/g/orbit-run/');
  r = await browse('https://sites.hawkesgen.ai/g/orbit-run/');
  assert.equal(r.status, 302, 'no pass: sent to Studio for one, like any beta site');
  r = await browse('https://sites.hawkesgen.ai/g/orbit-run/', { cookie: live });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /orbit live/);
  r = await browse('https://sites.hawkesgen.ai/g/orbit-run/assets/app.js', { cookie: live, page: false });
  assert.equal(await r.text(), 'js');
  r = await browse('https://sites.hawkesgen.ai/b/orbit-run/', { cookie: beta });
  assert.match(await r.text(), /orbit beta lane/);
  r = await browse('https://sites.hawkesgen.ai/b/orbit-run/', { cookie: live });
  assert.equal(r.status, 302, "the live lane's pass doesn't open studio-beta's copy");
  // The 🐞 widget under the game's own path, with the game's pass (2026-10-31: it loaded from the host's root and got 401).
  await r2.put('beta/_studio/report.js', '/* widget */', { httpMetadata: { contentType: 'text/javascript' } });
  r = await browse('https://sites.hawkesgen.ai/b/orbit-run/dev/__studio/report.js', { cookie: beta, page: false });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '/* widget */');
  const { injectReport } = await import('../src/bugreport.ts');
  assert.match(injectReport('<html><body></body></html>', { product: 'orbit-run', root: '/b/orbit-run' }), /src="\/b\/orbit-run\/dev\/__studio\/report\.js"/);
  assert.match(injectReport('<html><body></body></html>', { product: 'phorigins' }), /src="\/dev\/__studio\/report\.js"/);
});
