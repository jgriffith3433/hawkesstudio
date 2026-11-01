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
  assert.deepEqual(sent.params.github, { repo: 'acme/game', commit: SHA1, token: 'ghs_acme', ref: 'beta' });
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
