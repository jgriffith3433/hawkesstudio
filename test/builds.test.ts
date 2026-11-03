// Builds (builds.ts, docs/builds.md) in a customer's Studio, end to end against stand-ins: GitHub (its API and an
// Actions artifact), Hawkes Gen (unity.build customer mode), the control plane (the plan), and the real beta-sites Worker
// over an in-memory R2. A build is a run, published once under its version, made beta by a pointer, mounted into another
// project's site, never built twice for one commit, and rolled back by moving the pointer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-builds-'));
Object.assign(process.env, {
  STUDIO_DATA: path.join(TMP, 'data'), STUDIO_MAIL: 'off', K_SERVICE: 'studio-o-acme-1a2b', STUDIO_ORG: 'acme-1a2b', STUDIO_SIGNUP: 'owner',
  STUDIO_CONTROL_URL: 'https://control.test', STUDIO_CELL_KEY: 'cell-key', STUDIO_SITES_SEED: 'acme-sites-seed', STUDIO_SITES_URL: 'https://sites.test',
  STUDIO_PUBLIC_URL: 'https://studio.hawkesgen.ai/o/acme-1a2b', HAWKESGEN_URL: 'https://gen.test', HAWKESGEN_KEY: 'hg_cell', STUDIO_BUILDS_KEEP: '2', STUDIO_METER_GEN: '0',
});
fs.mkdirSync(process.env.STUDIO_DATA!, { recursive: true });
delete process.env.STUDIO_PRODUCTS;
delete process.env.GITHUB_TOKEN;

const K = await import('../src/sitekeys.ts');
const W = await import('../server/beta-sites/src/index.ts');
const keys = K.siteKeys()!;

// ---- an in-memory R2 and the real Worker
const objects = new Map<string, { data: Uint8Array; type?: string }>();
const r2: any = {
  async get(k: string) { const v = objects.get(k); return v ? { size: v.data.length, httpEtag: `"${crypto.createHash('md5').update(v.data).digest('hex')}"`, httpMetadata: { contentType: v.type }, body: new Response(v.data as any).body } : null; },
  async head(k: string) { const v = objects.get(k); return v ? { size: v.data.length, httpEtag: '"x"', httpMetadata: { contentType: v.type } } : null; },
  async put(k: string, value: any, o: any) { const data = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value ?? new ArrayBuffer(0)); objects.set(k, { data, type: o?.httpMetadata?.contentType }); },
  async delete(ks: string | string[]) { for (const k of Array.isArray(ks) ? ks : [ks]) objects.delete(k); },
};
const env: any = { SITES: r2, DOMAIN: 'hawkesgen.ai', STUDIO_ORIGIN_LIVE: 'https://studio-live.run.app', STUDIO_PUBLIC_LIVE: 'https://studio.hawkesgen.ai', CELLS_PROJECT_NUMBER: '123' };
const text = (s: string) => new TextEncoder().encode(s);

// ---- the repos on "GitHub"
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40), SHA4 = 'd'.repeat(40);
const blobs = new Map<string, Uint8Array>();
const tree = (files: Record<string, string>) => Object.entries(files).map(([p, c]) => { const d = text(c); const sha = crypto.createHash('sha1').update(d).digest('hex'); blobs.set(sha, d); return { path: p, type: 'blob', mode: '100644', sha, size: d.length }; });
const repos: Record<string, Record<string, ReturnType<typeof tree>>> = {
  'acme/site': { [SHA1]: tree({ 'index.html': '<!doctype html><html><head><meta charset="utf-8"></head><body>site v1</body></html>', 'a.js': 'a1' }), [SHA2]: tree({ 'index.html': '<!doctype html><html><head><meta charset="utf-8"></head><body>site v2</body></html>', 'a.js': 'a2' }), [SHA3]: tree({ 'index.html': '<!doctype html><html><head><meta charset="utf-8"></head><body>site v3</body></html>' }), [SHA4]: tree({ 'index.html': '<!doctype html><html><head><meta charset="utf-8"></head><body>site v4</body></html>' }) },
  'acme/game': { [SHA1]: tree({ 'Game/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.7f1' }) },
};
let betaOf: Record<string, string> = { 'acme/site': SHA1, 'acme/game': SHA1 };
const ghAuth: string[] = [];
// Files the stand-in serves from a repo's contents API, keyed `repo:ref:path` (a website's Game/build.json).
const pinFiles: Record<string, string> = {};

// A Unity build's output (what Gen hands back) and an Actions artifact (a zip), made once here.
const unityOut = path.join(TMP, 'unity-out');
fs.mkdirSync(path.join(unityOut, 'Build'), { recursive: true });
fs.writeFileSync(path.join(unityOut, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>unity</body></html>');
fs.writeFileSync(path.join(unityOut, 'Build', 'game.wasm.br'), 'compressed');
const unityTar = spawnSync('tar', ['-czf', '-', '.'], { cwd: unityOut }).stdout as Buffer;
const zipOf = (dir: string) => {
  const zip = path.join(TMP, `${path.basename(dir)}.zip`);
  for (const py of ['python3', 'python', 'py']) if (spawnSync(py, ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', zip, dir]).status === 0) break;
  return fs.readFileSync(zip);
};
const actionsOut = path.join(TMP, 'actions-out');
fs.mkdirSync(actionsOut, { recursive: true });
fs.writeFileSync(path.join(actionsOut, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>godot</body></html>');
const artifactZip = zipOf(actionsOut);

const genCalls: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const u = new URL(url);
  const auth = new Headers(init.headers ?? {}).get('authorization');
  if (u.host === 'api.github.com') {
    ghAuth.push(auth ?? '');
    let m: RegExpExecArray | null;
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(u.pathname))) return betaOf[m[1]] && m[2] === 'beta' ? new Response(betaOf[m[1]]) : new Response('', { status: 404 });
    if (/\/contents\/.*package\.json$/.test(u.pathname)) return new Response('', { status: 404 });
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(u.pathname)) && pinFiles[`${m[1]}:${u.searchParams.get('ref')}:${decodeURIComponent(m[2])}`]) return new Response(pinFiles[`${m[1]}:${u.searchParams.get('ref')}:${decodeURIComponent(m[2])}`]);
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([0-9a-f]+)$/.exec(u.pathname))) return Response.json({ tree: repos[m[1]]?.[m[2]] ?? [] });
    if ((m = /\/git\/blobs\/([0-9a-f]+)$/.exec(u.pathname))) return new Response(blobs.get(m[1]) as any);
    if (/\/actions\/runs\/77\/artifacts$/.test(u.pathname)) return Response.json({ artifacts: [{ name: 'web', expired: false, archive_download_url: 'https://api.github.com/artifact/77.zip' }] });
    if (u.pathname === '/artifact/77.zip') return new Response(artifactZip as any);
    return new Response('stand-in has no ' + u.pathname, { status: 404 });
  }
  if (u.host === 'sites.test') return W.handle(new Request(url, { ...init, duplex: 'half' } as any), env);
  if (u.host.endsWith('.run.app') && u.pathname === '/auth/sites-key') return Response.json({ lane: 'live', alg: 'Ed25519', key: keys.publicKey });
  if (u.host === 'control.test') return Response.json({ org: 'acme-1a2b', plan: 'studio_studio', status: 'active', maxGames: 30, credits: 0 });
  if (u.host === 'gen.test') {
    if (u.pathname === '/v1/jobs' && init.method === 'POST') { genCalls.push(JSON.parse(String(init.body))); return Response.json({ jobs: [{ id: 'j_unity', status: 'queued' }] }); }
    if (u.pathname === '/v1/jobs/j_unity') return Response.json({ id: 'j_unity', status: 'done', result: { artifact: { asset: 'a_out', bytes: unityTar.length }, unity: '6000.3.7f1' } });
    if (u.pathname === '/v1/files/a_out') return new Response(unityTar as any);
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

// The repo token comes from the control plane (cellside.ts), like a real customer's Studio.
const GT = await import('../src/ghtoken.ts');
const tokenFor = GT.repoToken;
(GT as any).forgetRepoTokens();
const cellside = await import('../src/cellside.ts');
(cellside as any).cellGithubToken; // loaded
globalThis.fetch = ((orig) => (async (input: any, init: any = {}) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.host === 'control.test' && u.pathname === '/api/cells/self/github-token') return Response.json({ token: 'ghs_acme', expires: Date.now() + 3600_000 });
  return orig(input, init);
}))(globalThis.fetch) as typeof fetch;

const C = await import('../src/config.ts');
const B = await import('../src/builds.ts');
const pass = K.makePass('u_owner', { lane: 'live', keys });
const page = async (p: string) => { const r = await W.handle(new Request(`https://sites.hawkesgen.ai${p}`, { headers: { cookie: `hawkes_opass=${pass}`, 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } }), env); return { status: r.status, body: await r.text(), r }; };
const runOf = async (id: string) => (await import('../src/pipeline.ts')).getRun(id)!;

test('builds are checked: tools, targets, paths, links; a customer\'s old "build" is its source, never J\'s Unity block', () => {
  assert.deepEqual(C.checkBuilds([{ id: 'web', tool: 'unity', path: 'Game' }]), [{ id: 'web', tool: 'unity', target: 'web', path: 'Game' }]);
  assert.throws(() => C.checkBuilds([{ id: 'x', tool: 'unity', target: 'windows' }]), /tool "actions"/);
  assert.throws(() => C.checkBuilds([{ id: 'x', tool: 'make' }]), /tool:/);
  assert.throws(() => C.checkBuilds([{ id: 'x', tool: 'static', path: '../etc' }]), /path/);
  assert.throws(() => C.checkBuilds([{ id: 'x', tool: 'static' }, { id: 'x', tool: 'npm' }]), /unique/);
  assert.deepEqual(C.checkBuilds([{ id: 'w', tool: 'unity', publish: { project: 'site', path: '/Game' } }])[0].publish, { project: 'site', path: 'Game/' });
  const g = C.asCustomerGame({ id: 'd', name: 'D', engine: 'desktop', build: { source: 'url', target: 'windows' } } as any);
  assert.equal((g as any).build, undefined, 'never read as a Unity build');
  assert.deepEqual((g as any).source, { source: 'url', target: 'windows' });
});

test('a static site builds as a run, is published once under its version, and beta points at it', async () => {
  C.saveProduct({ id: 'site', name: 'Site', engine: 'web', repo: 'acme/site', builds: [{ id: 'web', tool: 'static' }] } as any);
  const r = (await B.startBuild('site', { trigger: 'beta' }))!;
  await r.done;
  const run = await runOf(r.id);
  assert.equal(run.kind, 'build');
  assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
  assert.ok(ghAuth.includes('Bearer ghs_acme'), "GitHub is asked with the repo's own token");
  assert.ok(objects.has('live/o/acme-1a2b/site/b/web/1/index.html'));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(objects.get('live/o/acme-1a2b/site/beta.json')!.data)).version, 1);
  const beta = await page('/o/acme-1a2b/site/');
  assert.equal(beta.status, 200);
  assert.match(beta.body, /site v1/);
  assert.match(beta.body, /r\/widget\.js/, 'its own 🐞 widget');
  assert.match((await page('/o/acme-1a2b/site/b/web/1/')).body, /site v1/);
  const hist = B.buildHistory('site');
  assert.equal(hist[0].status, 'ready');
  assert.equal(hist[0].url, 'https://sites.hawkesgen.ai/o/acme-1a2b/site/b/web/1/');
});

test("a published build's widget root is the project's site, where /dev/__studio/build is served (no 404 in the console)", async () => {
  assert.equal(B.widgetRoot('https://sites.hawkesgen.ai/o/acme-1a2b/site/'), '/o/acme-1a2b/site');
  assert.equal(B.widgetRoot('https://x.hawkesgen.ai/'), '');
  const built = (await page('/o/acme-1a2b/site/b/web/1/')).body;
  const info = JSON.parse(/data-hawkes='([^']*)'/.exec(built)![1].replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  assert.equal(info.root, '/o/acme-1a2b/site', 'not the build folder /b/web/1');
  const r = await W.handle(new Request(`https://sites.hawkesgen.ai${info.root}/dev/__studio/build`, { headers: { cookie: `hawkes_opass=${pass}` } }), env);
  assert.equal(r.status, 200);
});

test('the same commit is never built twice; a new one is version 2; beta rolls back by its pointer', async () => {
  const again = (await B.startBuild('site', { trigger: 'beta' }))!;
  await again.done;
  assert.match((await runOf(again.id)).steps[0].detail, /built already/);
  betaOf['acme/site'] = SHA2;
  const two = (await B.startBuild('site', { trigger: 'beta' }))!;
  await two.done;
  W.resetSmall(); // the Worker keeps a pointer for 10 seconds
  assert.match((await page('/o/acme-1a2b/site/')).body, /site v2/);
  W.resetSmall();
  await B.setBeta('site', 'web', 1);
  W.resetSmall();
  assert.match((await page('/o/acme-1a2b/site/')).body, /site v1/, 'rolled back');
  assert.match((await page('/o/acme-1a2b/site/b/web/2/')).body, /site v2/, 'every version stays playable');
});

test('a Unity build in Hawkes Gen with the repo\'s own token, mounted into its website\'s Game/', async () => {
  C.saveProduct({ id: 'game', name: 'Game', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', publish: { project: 'site', path: 'Game/' }, playtest: false }] } as any);
  const r = (await B.startBuild('game', {}))!;
  await r.done;
  const run = await runOf(r.id);
  assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
  const sent = genCalls.at(-1);
  assert.equal(sent.tool, 'unity.build');
  assert.deepEqual(sent.params.github, { repo: 'acme/game', commit: SHA1, token: 'ghs_acme', ref: 'beta' }, 'Gen takes only repo, commit, token and ref');
  assert.equal(sent.params.out, 'artifact');
  assert.equal(sent.params.path, 'Game');
  W.resetSmall();
  assert.match((await page('/o/acme-1a2b/game/')).body, /unity/, 'its own beta site: no website needed');
  assert.match((await page('/o/acme-1a2b/site/Game/')).body, /unity/, 'and in the website\'s Game/');
  const wasm = await W.handle(new Request('https://sites.hawkesgen.ai/o/acme-1a2b/site/Game/Build/game.wasm.br', { headers: { cookie: `hawkes_opass=${pass}` } }), env);
  assert.equal(wasm.headers.get('content-encoding'), 'br');
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
});

test("an Actions build: the workflow's artifact is published when its run reports in (the hook)", async () => {
  C.saveProduct({ id: 'godot', name: 'Godot', engine: 'godot', repo: 'acme/site', builds: [{ id: 'web', tool: 'actions', artifact: 'web', playtest: false }] } as any);
  betaOf['acme/site'] = SHA1; // the run built beta's newest commit
  const res = await B.onRepoHook({ repository: 'acme/site', ref: 'refs/heads/beta', sha: SHA1, run_id: '77' }, { kind: 'build', build: 'web', artifact: 'web' });
  assert.ok(res?.runs?.godot);
  const run = await runOf(res!.runs.godot);
  for (let i = 0; i < 100 && run.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 50)); Object.assign(run, await runOf(res!.runs.godot)); }
  assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
  W.resetSmall();
  assert.match((await page('/o/acme-1a2b/godot/')).body, /godot/);
  // A beta push starts the builds it triggers; an Actions build starts itself (its own workflow), so not from here.
  const push = await B.onRepoHook({ repository: 'acme/site', ref: 'refs/heads/beta', sha: SHA1 }, {});
  assert.ok(push && 'site' in push.runs && !('godot' in push.runs));
});

test("a site's _headers: Godot's cross-origin isolation, from a safe list", () => {
  const rules = W.parseHeaders('/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Set-Cookie: no=1\n');
  assert.equal(rules[0].headers.length, 2, 'Set-Cookie is never taken');
  assert.ok(rules[0].pattern.test('/index.html'));
});

test('old versions are pruned to keep storage cheap: the newest stay, and the one beta points at always does', async () => {
  // Beta was rolled back to 1 above; 2 builds are kept here (STUDIO_BUILDS_KEEP).
  for (const sha of [SHA3, SHA4]) { betaOf['acme/site'] = sha; const r = (await B.startBuild('site', { trigger: 'beta' }))!; await r.done; }
  const byVersion = Object.fromEntries(B.buildHistory('site').filter((h) => h.build === 'web').map((h) => [h.version, h.status]));
  assert.deepEqual(byVersion, { 1: 'pruned', 2: 'pruned', 3: 'ready', 4: 'ready' });
  assert.ok(!objects.has('live/o/acme-1a2b/site/b/web/2/index.html'), 'its files are gone from R2');
  assert.ok(objects.has('live/o/acme-1a2b/site/b/web/4/index.html'));
  await assert.rejects(B.setBeta('site', 'web', 2), /no finished build/);
});

test("beta only moves forward: a build of an older commit is published at its own address and beta stays", async () => {
  betaOf['acme/site'] = SHA2;
  const r = (await B.startBuild('site', { sha: SHA1, ref: 'beta' }))!;
  await r.done;
  const last = B.buildHistory('site', 1)[0];
  assert.equal(last.status, 'ready');
  const pointer = await (await W.handle(new Request('https://sites.hawkesgen.ai/.hawkes-sites/o/live/o/acme-1a2b/site/beta.json', { headers: { authorization: 'Bearer x' } }), env)).text().catch(() => '');
  assert.ok(!pointer.includes(`"version":${last.version}`), `beta didn't move to the older commit's build (${pointer.slice(0, 80)})`);
  assert.throws(() => C.saveProduct({ id: 'loop', name: 'Loop', engine: 'unity', repo: 'acme/loop', builds: [{ id: 'web', tool: 'unity', publish: { project: 'loop', path: 'Game/', commit: true } }] } as any), /own repository/);
});

test("a build too big for git: its big folder stays on the public builds address and the committed pages point there", () => {
  const files = [
    { path: 'index.html', size: 2000 }, { path: 'TemplateData/style.css', size: 900 }, { path: 'TemplateData/logo.png', size: 30000 },
    { path: 'Build/game.loader.js', size: 30000 }, { path: 'Build/game.data.unityweb', size: 90 * 1024 * 1024 }, { path: 'Build/game.wasm.unityweb', size: 30 * 1024 * 1024 },
  ];
  const pub = 'https://sites.hawkesgen.ai/builds/o/acme-1a2b/game/b/web/7/';
  const s = B.splitForGit(files, pub);
  assert.deepEqual(s.commit, ['index.html', 'TemplateData/style.css', 'TemplateData/logo.png'], 'the Build folder is not committed');
  assert.equal(s.external, `${pub}Build/`);
  const page = '<script src="Build/game.loader.js"></script><script>var buildUrl = "Build"; var c = { dataUrl: buildUrl + "/game.data.unityweb" };</script><img src="TemplateData/logo.png">';
  const out = s.rewrite('index.html', page);
  assert.match(out, /src="https:\/\/sites\.hawkesgen\.ai\/builds\/o\/acme-1a2b\/game\/b\/web\/7\/Build\/game\.loader\.js"/);
  assert.match(out, /buildUrl = "https:\/\/sites\.hawkesgen\.ai\/builds\/o\/acme-1a2b\/game\/b\/web\/7\/Build"/);
  assert.match(out, /src="TemplateData\/logo\.png"/, 'other paths untouched');
  assert.equal(s.rewrite('TemplateData/logo.png', 'binary'), 'binary', 'non-text files are never rewritten');
  assert.deepEqual(B.splitForGit([{ path: 'a.js', size: 10 }], pub).commit, ['a.js'], 'a small build commits as it is');
  assert.throws(() => B.splitForGit([{ path: 'huge.bin', size: 60 * 1024 * 1024 }], pub), /aren't all in one folder/);
});

test('publish.page "site": the website keeps its own game page and is only pointed at the build', () => {
  C.saveProduct({ id: 'gamep', name: 'GameP', engine: 'unity', repo: 'acme/gamep', builds: [{ id: 'web', tool: 'unity', method: 'Acme.Build.Cloud', publish: { project: 'site', path: 'Game/', commit: true, page: 'site' } }] } as any);
  const b = (C.loadProducts().find((x: any) => x.id === 'gamep') as any).builds[0];
  assert.deepEqual(b.publish, { project: 'site', path: 'Game/', commit: true, page: 'site' });
  assert.equal(b.method, 'Acme.Build.Cloud');
  assert.throws(() => C.saveProduct({ id: 'gamep', name: 'GameP', engine: 'unity', repo: 'acme/gamep', builds: [{ id: 'web', tool: 'unity', publish: { project: 'site', path: 'Game/', page: 'site' } }] } as any), /needs commit: true/);
  assert.throws(() => C.saveProduct({ id: 'gamep', name: 'GameP', engine: 'unity', repo: 'acme/gamep', builds: [{ id: 'web', tool: 'unity', publish: { project: 'site', path: 'Game/', commit: true, page: 'odd' } }] } as any), /publish\.page/);
  const url = 'https://sites.hawkesgen.ai/builds/o/acme/gamep/b/web/3/';
  const fresh = B.pointPage('<html>\n<head lang="en">\n  <script src="x.js"></script>\n</head></html>', url);
  assert.match(fresh, /<head lang="en">\n  <script>window\.HAWKES_BUILD_URL = "https:\/\/sites\.hawkesgen\.ai\/builds\/o\/acme\/gamep\/b\/web\/3\/";<\/script>\n  <script src="x\.js">/, 'first in <head>, before the page\'s own scripts');
  const again = B.pointPage(fresh, url.replace('/3/', '/4/'));
  assert.equal((again.match(/HAWKES_BUILD_URL/g) ?? []).length, 1, 'replaced, never added twice');
  assert.match(again, /b\/web\/4\//);
  assert.match(B.pointPage('<p>no head</p>', url), /^<script>window\.HAWKES_BUILD_URL/);
});

test('publish.page "site" guard 1: no Unity loader the page can reach, no pointer on the site\'s beta', async () => {
  const f = (...ps: string[]) => ps.map((path) => ({ path }));
  assert.doesNotThrow(() => B.assertLoader(f('PlaceDepartment/index.html', 'PlaceDepartment/Build/PlaceDepartment.loader.js'), 'web', 6));
  assert.doesNotThrow(() => B.assertLoader(f('Build/x.loader.js'), 'web', 6));
  assert.throws(() => B.assertLoader(f('index.html', 'PlaceDepartment/Build/x.data'), 'web', 6), /no Unity loader/);
  assert.throws(() => B.assertLoader(f('a/b/Build/x.loader.js'), 'web', 6), /no Unity loader/, 'too deep for the page');
  assert.throws(() => B.assertLoader(f('TemplateData/Build.loader.js'), 'web', 6), /no Unity loader/);
});

test('publish.page "site" guard 2: the build\'s single folder is kept; any other build still unwraps it', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'wrap-'));
  fs.mkdirSync(path.join(dir, 'PlaceDepartment', 'Build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PlaceDepartment', 'Build', 'PlaceDepartment.loader.js'), 'x');
  const kept = await B.folderOutput(dir, dir, true);
  assert.deepEqual(kept.files.map((x: any) => x.path), ['PlaceDepartment/Build/PlaceDepartment.loader.js']);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'PlaceDepartment', 'Build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PlaceDepartment', 'Build', 'PlaceDepartment.loader.js'), 'x');
  const unwrapped = await B.folderOutput(dir, dir);
  assert.deepEqual(unwrapped.files.map((x: any) => x.path), ['Build/PlaceDepartment.loader.js']);
  unwrapped.cleanup();
});

test('publish.page "site" guard 3: prune never deletes a version the site\'s main or beta build.json names', async () => {
  const { db } = await import('../src/db.ts');
  const pr = C.getProduct('gamep');
  const sub = 'o/acme-1a2b/gamep';
  for (let v = 1; v <= 5; v++) {
    db.prepare("INSERT INTO builds (id, product, build, version, status, runner, target, started) VALUES (?, 'gamep', 'web', ?, 'ready', 'gen', 'web', ?)").run(`b_pin${v}`, v, v);
    objects.set(`live/${sub}/b/web/${v}/index.html`, { data: text('x') });
  }
  pinFiles['acme/site:main:Game/build.json'] = JSON.stringify({ version: 1, build: 'web' });
  pinFiles['acme/site:beta:Game/build.json'] = JSON.stringify({ version: 2, build: 'web' });
  assert.deepEqual([...(await B.pinnedVersions(pr, 'web'))].sort(), [1, 2]);
  await B.prune(pr, 'web', sub);
  const status = Object.fromEntries(B.buildHistory('gamep').map((h) => [h.version, h.status]));
  assert.deepEqual(status, { 1: 'ready', 2: 'ready', 3: 'pruned', 4: 'ready', 5: 'ready' }, 'live (1) and beta (2) stay; the newest 2 stay; the rest go');
  assert.ok(objects.has(`live/${sub}/b/web/1/index.html`), 'the live version\'s files stay');
  // A page file that can't be read prunes nothing (not even what no page uses).
  pinFiles['acme/site:main:Game/build.json'] = 'not json';
  db.prepare("UPDATE builds SET status = 'ready' WHERE product = 'gamep'").run();
  await assert.rejects(B.prune(pr, 'web', sub), /isn't JSON/);
  assert.equal(B.buildHistory('gamep').filter((h) => h.status === 'pruned').length, 0);
});

test('an app with a beta server of its own still has its own builds published (Hawkes Net: its SDK files)', async () => {
  C.saveProduct({ id: 'svc', name: 'Svc', engine: 'web', kind: 'app', beta: 'https://beta.svc.test', repo: 'acme/site', builds: [{ id: 'release', tool: 'static', playtest: false }] } as any);
  const r = (await B.startBuild('svc', { trigger: 'beta' }))!;
  await r.done;
  const run = await runOf(r.id);
  assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
  const row = B.buildHistory('svc')[0];
  assert.equal(row.status, 'ready');
  assert.equal(row.url, 'https://sites.hawkesgen.ai/o/acme-1a2b/svc/b/release/1/');
  W.resetSmall();
  assert.equal((await page('/o/acme-1a2b/svc/b/release/1/')).status, 200);
});

test('a build row left "building" by a run that ended (stopped after restarts) never blocks a new build of that commit', async () => {
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'stuck', name: 'Stuck', engine: 'web', repo: 'acme/site', builds: [{ id: 'web', tool: 'static', playtest: false }] } as any);
  const sha = betaOf['acme/site'];
  db.prepare("INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES ('r_dead', 'build', 'failed', 'stopped', '[\"stuck\"]', '{}', ?)").run(Date.now());
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, started) VALUES ('b_dead', 'stuck', 'web', 1, 'building', ?, 'beta', 'studio', 'web', 'r_dead', ?)").run(sha, Date.now());
  const r = (await B.startBuild('stuck', {}))!;
  await r.done;
  const run = await runOf(r.id);
  assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
  assert.doesNotMatch(run.steps[0].detail ?? '', /already building/);
  assert.equal(B.buildHistory('stuck')[0].status, 'ready');
});

test('a build archive is unpacked as it downloads, and a broken one says so', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-src-'));
  fs.mkdirSync(path.join(src, 'Game', 'StreamingAssets', 'aa'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Game', 'StreamingAssets', 'aa', 'catalog.json'), '{"ok":true}');
  const tgz = spawnSync('tar', ['-czf', '-', '-C', src, '.']).stdout;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-out-'));
  await B.untarStream(new Response(tgz), out);
  assert.equal(fs.readFileSync(path.join(out, 'Game', 'StreamingAssets', 'aa', 'catalog.json'), 'utf8'), '{"ok":true}');
  await assert.rejects(B.untarStream(new Response(Buffer.from('not a tarball')), fs.mkdtempSync(path.join(os.tmpdir(), 'tar-bad-'))), /unpacking the build/);
});

test("Gen's \"token for this build is gone\" counts as a lost token (sick-of-it-unity v3, v4 failed on it)", () => {
  assert.ok(B.tokenLost('The GitHub token for this build is gone (Gen restarted, or it expired): submit the build again with a fresh token'));
  assert.ok(B.tokenLost('the token expired'));
  assert.ok(B.tokenLost('GitHub refused the clone: Bad credentials'));
  assert.equal(B.tokenLost('Unity exited with code 1: compile errors'), false);
  assert.equal(B.tokenLost(undefined), false);
});

test('a Unity build whose token Gen lost is submitted again once with a fresh token, and is ready', async () => {
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'game-token', name: 'Game token', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', playtest: false }] } as any);
  const before = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs' && init.method === 'POST' && posts++ === 0) { genCalls.push(JSON.parse(String(init.body))); return Response.json({ jobs: [{ id: 'j_gone', status: 'queued' }] }); }
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs/j_gone') return Response.json({ id: 'j_gone', status: 'failed', error: 'The GitHub token for this build is gone (Gen restarted, or it expired): submit the build again with a fresh token' });
    return before(input, init);
  }) as typeof fetch;
  try {
    const r = (await B.startBuild('game-token', {}))!;
    await r.done;
    const run = await runOf(r.id);
    assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
    assert.equal(posts, 2, 'submitted twice: the lost token, then a fresh one');
    const row = db.prepare("SELECT status, gen_job, gen_done FROM builds WHERE product = 'game-token'").get() as any;
    assert.equal(row.status, 'ready');
    assert.equal(row.gen_job, 'j_unity', 'the step follows the new job');
    assert.ok(row.gen_done, 'the Gen job is marked done before the download');
  } finally {
    globalThis.fetch = before;
  }
});

test('a Unity build\'s machine size: checked, sent to Gen; when Gen built it a size up, that size is saved as the build\'s own', async () => {
  // Checked like the rest of a build (docs/builds.md): a size name or { cpu, memoryGiB } Cloud Run runs, Unity only.
  assert.equal(C.checkBuilds([{ id: 'web', tool: 'unity', machine: 'S' }])[0].machine, 's');
  assert.deepEqual(C.checkBuilds([{ id: 'web', tool: 'unity', machine: { cpu: 4, memoryGiB: 12 } }])[0].machine, { cpu: 4, memoryGiB: 12 });
  assert.throws(() => C.checkBuilds([{ id: 'web', tool: 'unity', machine: { cpu: 2, memoryGiB: 16 } }]), /2 vCPU takes 1 to 8 GiB/);
  assert.throws(() => C.checkBuilds([{ id: 'web', tool: 'npm', machine: 's' }]), /only Unity builds/);
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'game-size', name: 'Game size', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', machine: 's', playtest: false }] } as any);
  assert.equal(C.getProduct('game-size').builds![0].machine, 's', 'kept by saveProduct');
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs/j_unity') return Response.json({ id: 'j_unity', status: 'done', result: { ok: true, artifact: { asset: 'a_out', bytes: unityTar.length }, unity: '6000.3.7f1',
      machine: { name: 'm', cpu: 4, memoryGiB: 16 }, machineAsked: 's', retried: { reason: 'out of memory', from: 's', to: 'm' } } });
    return before(input, init);
  }) as typeof fetch;
  try {
    const r = (await B.startBuild('game-size', {}))!;
    await r.done;
    assert.equal((await runOf(r.id)).status, 'done');
    assert.equal(genCalls.at(-1).params.machine, 's', 'the size it asked for');
    // Saved where the project's builds are kept (this cell's products file), so the next build starts on m.
    assert.equal(C.getProduct('game-size').builds![0].machine, 'm');
    const row = db.prepare("SELECT detail FROM builds WHERE product = 'game-size' ORDER BY started DESC").get() as any;
    assert.match(row.detail, /Unity 6000\.3\.7f1; on m \(4 vCPU, 16 GiB\); ran on m after s ran out of memory; saved m as this build's size/);
    assert.equal(B.buildsOf(C.getProduct('game-size'))[0].machine, 'm', 'the builds list (studio_project builds / get) shows it');
  } finally {
    globalThis.fetch = before;
  }
  // A build that ran on the size it asked for changes nothing.
  assert.equal(B.learnMachine('game-size', { id: 'web', tool: 'unity' }, { ok: true, machine: { name: 'm', cpu: 4, memoryGiB: 16 } }), null);
});

test("a build waiting on its Gen job survives Studio's restarts: not counted, and the resume polls the same job", async () => {
  const { db } = await import('../src/db.ts');
  const P = await import('../src/pipeline.ts');
  C.saveProduct({ id: 'game-restart', name: 'Game restart', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', playtest: false }] } as any);
  const now = Date.now();
  // Three restarts in the last 30 minutes and three in a row at its build step: before, the fourth stopped it.
  const options = { builds: ['web'], ref: 'beta', resumes: [now - 60_000, now - 40_000, now - 20_000], restarts: { step: 'game-restart/build/web', n: 3, at: now - 20_000 } };
  db.prepare("INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES ('r_gen', 'build', 'running', '', '[\"game-restart\"]', ?, ?)").run(JSON.stringify(options), now - 30 * 60_000);
  db.prepare("INSERT INTO steps (id, run, product, kind, name, status, started) VALUES ('s_gen', 'r_gen', 'game-restart', 'build', 'web', 'running', ?)").run(now - 30 * 60_000);
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, gen_job, started) VALUES ('b_gen', 'game-restart', 'web', 1, 'building', ?, 'beta', 'gen', 'web', 'r_gen', 'j_unity', ?)").run(SHA1, now - 30 * 60_000);
  assert.equal(P.waitingInGen('r_gen'), true);
  const posted = genCalls.length;
  process.env.STUDIO_RESUME_GAP_MS = '0';
  P.resumeRuns();
  const opts = JSON.parse((db.prepare("SELECT options FROM runs WHERE id = 'r_gen'").get() as any).options);
  assert.equal(opts.resumes.length, 3, 'a restart while Gen builds is not counted');
  for (let i = 0; i < 100 && (await runOf('r_gen')).status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  const run = await runOf('r_gen');
  assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
  assert.equal(genCalls.length, posted, 'no second Unity build: the same job was polled');
  assert.equal(B.buildHistory('game-restart')[0].status, 'ready');
  // Once Gen is done, the download and publish are Studio's own work: restarts count again.
  db.prepare("UPDATE builds SET status = 'building', gen_done = ? WHERE id = 'b_gen'").run(Date.now());
  assert.equal(P.waitingInGen('r_gen'), false);
});

const GONE = 'The GitHub token for this build is gone (Gen restarted, or it expired): submit the build again with a fresh token';

test('a Unity build that loses its token twice is submitted again each time with a fresh one, and is ready on the third', async () => {
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'game-token2', name: 'Game token 2', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', playtest: false }] } as any);
  const before = globalThis.fetch;
  let posts = 0;
  const tokens: string[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs' && init.method === 'POST' && posts < 2) {
      const body = JSON.parse(String(init.body)); genCalls.push(body); tokens.push(JSON.stringify(body));
      return Response.json({ jobs: [{ id: `j_gone${++posts}`, status: 'queued' }] });
    }
    if (u.host === 'gen.test' && /^\/v1\/jobs\/j_gone\d$/.test(u.pathname)) return Response.json({ id: u.pathname.split('/').pop(), status: 'failed', error: GONE });
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs' && init.method === 'POST') posts++;
    return before(input, init);
  }) as typeof fetch;
  try {
    const r = (await B.startBuild('game-token2', {}))!;
    await r.done;
    const run = await runOf(r.id);
    assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
    assert.equal(posts, 3, 'submitted three times: two lost tokens, then a good one');
    assert.equal((db.prepare("SELECT status FROM builds WHERE product = 'game-token2'").get() as any).status, 'ready');
  } finally {
    globalThis.fetch = before;
  }
});

test('a Unity build whose token keeps getting lost stops after TOKEN_RETRIES resubmits, with the reason', async () => {
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'game-token3', name: 'Game token 3', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', playtest: false }] } as any);
  const before = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs' && init.method === 'POST') return Response.json({ jobs: [{ id: `j_never${++posts}`, status: 'queued' }] });
    if (u.host === 'gen.test' && /^\/v1\/jobs\/j_never\d$/.test(u.pathname)) return Response.json({ id: u.pathname.split('/').pop(), status: 'failed', error: GONE });
    return before(input, init);
  }) as typeof fetch;
  try {
    const r = (await B.startBuild('game-token3', {}))!;
    await r.done;
    assert.equal(posts, B.TOKEN_RETRIES + 1);
    const row = db.prepare("SELECT status, detail FROM builds WHERE product = 'game-token3'").get() as any;
    assert.equal(row.status, 'failed');
    assert.match(row.detail, /token for this build is gone/);
  } finally {
    globalThis.fetch = before;
  }
});

test('a build left "building" with its run gone is settled from Gen\'s word on the job; one with a live run is left alone', async () => {
  const { db } = await import('../src/db.ts');
  const now = Date.now();
  const run = (id: string, status: string) => db.prepare("INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, 'build', ?, '', '[\"game-rec\"]', '{}', ?)").run(id, status, now - 20 * 3600_000);
  const row = (id: string, version: number, runId: string, job: string | null, started = now - 12 * 3600_000) => db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, gen_job, started) VALUES (?, 'game-rec', 'web', ?, 'building', ?, 'beta', 'gen', 'web', ?, ?, ?)").run(id, version, SHA1, runId, job, started);
  run('r_rec_stopped', 'failed'); run('r_rec_live', 'running');
  row('b_rec_failed', 1, 'r_rec_stopped', 'j_rec_failed');
  row('b_rec_done', 2, 'r_rec_stopped', 'j_rec_done');
  row('b_rec_going', 3, 'r_rec_stopped', 'j_rec_going', now - 3600_000);
  row('b_rec_nojob', 4, 'r_rec_stopped', null);
  row('b_rec_gone', 5, 'r_rec_stopped', 'j_rec_gone');
  row('b_rec_down', 6, 'r_rec_stopped', 'j_rec_down');
  row('b_rec_live', 7, 'r_rec_live', 'j_rec_live', now - 60_000);
  row('b_rec_waiting', 8, 'r_rec_live', 'j_rec_waiting', now - 60_000);
  const cancelled: string[] = [];
  const jobs: Record<string, any> = { j_rec_failed: { status: 'failed', error: 'Unity exited with code 1' }, j_rec_done: { status: 'done' }, j_rec_going: { status: 'running' } };
  const settled = await B.reconcileBuilds({
    product: 'game-rec', now,
    job: async (id) => { if (id === 'j_rec_gone') throw Object.assign(new Error('Not found'), { status: 404 }); if (id === 'j_rec_down') throw new Error('fetch failed'); return jobs[id]; },
    cancel: async (id) => { cancelled.push(id); },
  });
  const st = (id: string) => db.prepare('SELECT status, detail, finished, gen_done FROM builds WHERE id = ?').get(id) as any;
  assert.equal(st('b_rec_failed').status, 'failed');
  assert.match(st('b_rec_failed').detail, /Unity build failed: Unity exited with code 1/);
  assert.match(st('b_rec_done').detail, /finished job j_rec_done, but Studio stopped before publishing/);
  assert.ok(st('b_rec_done').gen_done);
  assert.match(st('b_rec_going').detail, /cancelled Gen job j_rec_going/);
  assert.deepEqual(cancelled, ['j_rec_going']);
  assert.match(st('b_rec_nojob').detail, /no Gen job to wait for/);
  assert.match(st('b_rec_gone').detail, /doesn't know job j_rec_gone/);
  assert.equal(st('b_rec_down').status, 'building', "Gen unreachable: left for the next look, not failed");
  assert.equal(st('b_rec_live').status, 'building', 'its run is going: that run is waiting on the job');
  assert.equal(st('b_rec_waiting').status, 'building');
  assert.equal(settled.length, 5);
});

test('a build "building" past the maximum is timed out and its Gen job cancelled, even when its run says it is running', async () => {
  const { db } = await import('../src/db.ts');
  const now = Date.now();
  db.prepare("INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES ('r_old', 'build', 'running', '', '[\"game-old\"]', '{}', ?)").run(now - 13 * 3600_000);
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, gen_job, started) VALUES ('b_83380d6285d9', 'game-old', 'web', 1, 'building', ?, 'beta', 'gen', 'web', 'r_old', 'j_4de531be674c', ?)").run(SHA1, now - 13 * 3600_000);
  const cancelled: string[] = [];
  const settled = await B.reconcileBuilds({ now, only: 'j_4de531be674c', job: async () => ({ status: 'running' }), cancel: async (id) => { cancelled.push(id); } });
  assert.equal(settled.length, 1);
  const r = db.prepare("SELECT status, detail, finished FROM builds WHERE id = 'b_83380d6285d9'").get() as any;
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /timed out after 13 h in Hawkes Gen/);
  assert.ok(r.finished);
  assert.deepEqual(cancelled, ['j_4de531be674c']);
  // Settled once: nothing left to do.
  assert.equal((await B.reconcileBuilds({ now, job: async () => { throw new Error('asked again'); } })).filter((x) => x.job === 'j_4de531be674c').length, 0);
});

test('starting a build settles a stuck row of the same project first, so it never stands in its way', async () => {
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'game-stuck', name: 'Game stuck', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', playtest: false }] } as any);
  db.prepare("INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES ('r_s', 'build', 'interrupted', '', '[\"game-stuck\"]', '{}', ?)").run(Date.now() - 3600_000);
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, started) VALUES ('b_s', 'game-stuck', 'web', 1, 'building', ?, 'beta', 'gen', 'web', 'r_s', ?)").run(SHA1, Date.now() - 3600_000);
  const r = (await B.startBuild('game-stuck', {}))!;
  await r.done;
  assert.match((db.prepare("SELECT detail FROM builds WHERE id = 'b_s'").get() as any).detail, /stopped: its run interrupted/);
  assert.equal((await runOf(r.id)).status, 'done');
});

test('infrastructure losses are retried by Studio itself; a Unity compile error never is', () => {
  assert.ok(B.infraLost(GONE));
  assert.ok(B.infraLost('Hawkes Gen restarted while the build was queued'));
  assert.ok(B.infraLost('worker lost: the instance was preempted'));
  assert.ok(B.infraLost('fetch failed: 503'));
  assert.equal(B.infraLost('Assets/Foo.cs(3,1): error CS1002: ; expected'), false);
  assert.equal(B.infraLost('Unity exited with code 1: compile errors'), false);
  assert.equal(B.infraLost('Unity ran out of memory'), false);
  assert.equal(B.infraLost(undefined), false);
  assert.ok(B.TOKEN_RETRIES >= 3);
});

test('a Unity build Gen lost to a restart is resubmitted by itself, and the run says so', async () => {
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'game-infra', name: 'Game infra', engine: 'unity', repo: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', playtest: false }] } as any);
  const before = globalThis.fetch;
  let posts = 0;
  const sent: any[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs' && init.method === 'POST' && posts++ === 0) { sent.push(JSON.parse(String(init.body))); return Response.json({ jobs: [{ id: 'j_rs', status: 'queued' }] }); }
    if (u.host === 'gen.test' && u.pathname === '/v1/jobs/j_rs') return Response.json({ id: 'j_rs', status: 'failed', error: 'Hawkes Gen restarted while the build was queued' });
    return before(input, init);
  }) as typeof fetch;
  try {
    const r = (await B.startBuild('game-infra', {}))!;
    await r.done;
    const run = await runOf(r.id);
    assert.equal(run.status, 'done', JSON.stringify(run.steps.map((s: any) => s.detail)));
    assert.equal(posts, 2);
    const row = db.prepare("SELECT id, status, token_sent FROM builds WHERE product = 'game-infra'").get() as any;
    assert.equal(row.status, 'ready');
    assert.ok(row.token_sent, 'when the token was sent is recorded');
    const g = sent[0].params.github;
    assert.deepEqual(Object.keys(g).sort(), ['commit', 'ref', 'repo', 'token'], 'no github.refresh: Gen rejects it');
    // The flag-on shape, for when Gen accepts refresh.
    const on = B.githubFor('a/b', 'c', 't', 'beta', row.id, true) as any;
    assert.equal(on.refresh.build, row.id);
    assert.match(on.refresh.url, /\/api\/builds\/gen-token$/);
    assert.equal(on.refresh.key, B.refreshKey(row.id));
  } finally {
    globalThis.fetch = before;
  }
});

test('Gen asks Studio for a fresh token: only with the build\'s own key, only while it is building, for its repo alone', async () => {
  const { db } = await import('../src/db.ts');
  C.saveProduct({ id: 'game-tok', name: 'Game tok', engine: 'unity', repo: 'acme/game', github: 'acme/game', builds: [{ id: 'web', tool: 'unity', path: 'Game', playtest: false }] } as any);
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, gen_job, started) VALUES ('b_tok', 'game-tok', 'web', 1, 'building', ?, 'beta', 'gen', 'web', 'j_tok', ?)").run(SHA1, Date.now());
  const minted: string[] = [];
  const mint = async (slug: string) => { minted.push(slug); return 'ghs_fresh'; };
  assert.equal((await B.genTokenFor({ build: 'b_tok', job: 'j_tok', key: 'f'.repeat(64) }, mint)).status, 401);
  assert.equal((await B.genTokenFor({ build: 'b_tok', key: 'short' }, mint)).status, 401);
  const ok = await B.genTokenFor({ build: 'b_tok', job: 'j_tok', key: B.refreshKey('b_tok') }, mint);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.token, 'ghs_fresh');
  assert.equal(ok.body.repo, 'acme/game');
  assert.equal(ok.body.commit, SHA1);
  assert.deepEqual(minted, ['acme/game']);
  assert.ok((db.prepare("SELECT token_at FROM builds WHERE id = 'b_tok'").get() as any).token_at);
  assert.equal((await B.genTokenFor({ build: 'b_tok', job: 'j_other', key: B.refreshKey('b_tok') }, mint)).status, 409, 'another job');
  db.prepare("UPDATE builds SET status = 'ready' WHERE id = 'b_tok'").run();
  assert.equal((await B.genTokenFor({ build: 'b_tok', job: 'j_tok', key: B.refreshKey('b_tok') }, mint)).status, 409, 'finished builds get none');
});

test('what builds a project is told the truth for that project (tag-only builds are not built by a push)', () => {
  const tagOnly = { id: 'g', name: 'G', engine: 'unity', builds: [{ id: 'web', tool: 'unity', on: ['tag'] }] } as any;
  assert.match(B.buildHint(tagOnly), /build-\* tag builds web/);
  assert.doesNotMatch(B.buildHint(tagOnly), /push to beta builds/);
  assert.match(B.buildHint({ ...tagOnly, builds: [{ id: 'web', tool: 'npm' }] }), /push to beta builds web/);
});

test('a Gen build with no job id yet still counts as waiting in Gen (restarts do not stop it)', async () => {
  const { db } = await import('../src/db.ts');
  const P = await import('../src/pipeline.ts');
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, started) VALUES ('b_nojob', 'game-restart', 'web', 9, 'building', ?, 'beta', 'gen', 'web', 'r_nojob', ?)").run(SHA1, Date.now());
  assert.equal(P.waitingInGen('r_nojob'), true);
});
