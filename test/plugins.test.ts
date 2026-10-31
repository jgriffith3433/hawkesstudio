// Plugins (plugins.ts, docs/plugins.md) against a stand-in GitHub: the catalog validates, installed versions are found
// in Unity manifests (in a subfolder), package.json files and pages across a project's repos, outdated is a version
// compare, plans are exact edits that keep each file's formatting, and applying makes a branch from beta through the Git
// Data API and a pull request into beta. The API routes answer through a real HTTP server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugins-'));
Object.assign(process.env, { STUDIO_DATA: path.join(TMP, 'data'), STUDIO_MAIL: 'off', STUDIO_PRODUCTS: path.join(TMP, 'products.json'), GITHUB_TOKEN: 'ghp_test', STUDIO_PUBLIC_URL: 'https://studio.example' });
for (const k of ['STUDIO_ORG', 'K_SERVICE', 'STUDIO_CUSTOMER', 'STUDIO_PLUGINS_CATALOG', 'HAWKESGEN_PROJECT_PREFIX']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_DATA!, { recursive: true });
const product = (id: string, more: any) => ({ id, name: id, framing: '', engine: 'web', site: more.repo, live: `https://${id}.example`, local: { serve: 'static', dir: more.repo ?? id, port: 0, path: '/' }, playtests: [], story: [], ...more });
fs.writeFileSync(process.env.STUDIO_PRODUCTS!, JSON.stringify({
  repos: { UniGame: 'acme/unigame', UniSite: 'acme/unisite', WebGame: 'acme/webgame' },
  products: [
    product('unigame', { engine: 'unity', repo: 'UniGame/Game', site: 'UniSite' }),
    product('webgame', { repo: 'WebGame' }),
    product('moon', { repo: 'moon', github: 'acme/moon' }),
    product('norepo', { repo: '' }),
  ],
}));

// ---- the repos on "GitHub"
const MANIFEST = '{\n  "dependencies": {\n    "com.hawkes.net": "https://github.com/jgriffith3433/hawkesnet-unity.git?path=/Packages/com.hawkes.net#v0.5.0",\n    "com.unity.inputsystem": "1.11.2",\n    "com.unity.ugui": "2.0.0"\n  }\n}\n';
const PKG = '{\r\n    "name": "webgame",\r\n    "scripts": {\r\n        "dev": "vite"\r\n    },\r\n    "dependencies": {\r\n        "@babylonjs/core": "^7.0.0",\r\n        "vite": "^5.0.0"\r\n    }\r\n}\r\n';
const PAGE = '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8">\n    <title>Web</title>\n  </head>\n  <body></body>\n</html>\n';
const SITE = '<!doctype html><html><head>\n  <script src="https://hawkesgen.ai/sdk/analytics@1.js" data-product="unigame" defer></script>\n</head><body></body></html>\n';
const OLD_PLAYTEST = '// old copy\nexport const CONTRACT_VERSION = 0;\n';
const blobs = new Map<string, string>();
const put = (text: string) => { const sha = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'); blobs.set(sha, text); return sha; };
const repo = (files: Record<string, string>) => Object.entries(files).map(([p, c]) => ({ path: p, type: 'blob', mode: '100644', sha: put(c) }));
const branches: Record<string, Record<string, ReturnType<typeof repo>>> = {
  'acme/unigame': { beta: repo({ 'Game/Packages/manifest.json': MANIFEST, 'Game/Packages/com.other/package.json': '{"name":"com.other","version":"1.0.0"}', 'Game/Assets/WebGLTemplates/x/index.html': PAGE, 'Game/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.7f1' }) },
  'acme/unisite': { main: repo({ 'index.html': SITE, 'Game/v3/index.html': PAGE }) },
  'acme/webgame': { beta: repo({ 'package.json': PKG, 'index.html': PAGE, 'src/main.ts': 'console.log(1)', 'node_modules/x/package.json': '{}' }) },
  'acme/moon': { beta: repo({ 'index.html': PAGE, 'js/hawkes-playtest.js': OLD_PLAYTEST, 'js/game.js': '' }) },
};
const TAGS: Record<string, string[]> = { 'jgriffith3433/hawkesnet-unity': ['v0.5.0', 'v0.5.1', 'v0.6.0', 'build-x'], 'jgriffith3433/hawkesnet-js': ['v1.2.1', 'v1.3.0'], 'jgriffith3433/hawkesnet-babylon': ['v0.1.0', 'v0.1.2'] };

type Call = { method: string; path: string; body?: any; auth: string | null };
const calls: Call[] = [];
let existing = new Set<string>(); // refs made already (a second install of the same version)
let prs: { number: number; html_url: string; head: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.host !== 'api.github.com') return realFetch(input, init);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path: u.pathname + u.search, body, auth: new Headers(init.headers ?? {}).get('authorization') });
  let m: RegExpExecArray | null;
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/tags$/.exec(u.pathname))) return Response.json((TAGS[m[1]] ?? []).map((name) => ({ name })));
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(u.pathname))) return m[2].endsWith('package.json') ? new Response('{"name":"com.hawkes.gen","version":"0.2.1"}') : new Response('', { status: 404 });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
    const t = branches[m[1]]?.[decodeURIComponent(m[2])];
    return t ? Response.json({ tree: t }) : Response.json({ message: 'Not Found' }, { status: 404 });
  }
  if ((m = /\/git\/blobs\/([0-9a-f]{40})$/.exec(u.pathname))) return new Response(blobs.get(m[1]) ?? '');
  if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(u.pathname))) return branches[m[1]] ? Response.json({ default_branch: 'main' }) : new Response('', { status: 404 });
  if ((m = /\/git\/ref\/heads\/(.+)$/.exec(u.pathname))) return Response.json({ ref: `refs/heads/${m[1]}`, object: { sha: 'ba5e'.padEnd(40, '0') } });
  if (/\/git\/commits\/[0-9a-f]+$/.test(u.pathname)) return Response.json({ tree: { sha: '7ee'.padEnd(40, '0') } });
  if (u.pathname.endsWith('/git/blobs') && method === 'POST') return Response.json({ sha: put(Buffer.from(body.content, 'base64').toString('utf8')) });
  if (u.pathname.endsWith('/git/trees') && method === 'POST') return Response.json({ sha: 'e7ee'.padEnd(40, '0') });
  if (u.pathname.endsWith('/git/commits') && method === 'POST') return Response.json({ sha: 'c0'.padEnd(40, '0') });
  if (u.pathname.endsWith('/git/refs') && method === 'POST') {
    if (existing.has(body.ref)) return Response.json({ message: 'Reference already exists' }, { status: 422 });
    existing.add(body.ref);
    return Response.json({ ref: body.ref });
  }
  if (/\/git\/refs\/heads\//.test(u.pathname) && method === 'PATCH') return Response.json({ ok: true });
  if (u.pathname.endsWith('/pulls') && method === 'POST') {
    if (prs.some((p) => p.head === body.head)) return Response.json({ message: 'A pull request already exists' }, { status: 422 });
    const pr = { number: 7 + prs.length, html_url: `https://github.com/${u.pathname.split('/')[2]}/${u.pathname.split('/')[3]}/pull/${7 + prs.length}`, head: body.head };
    prs.push(pr);
    return Response.json(pr, { status: 201 });
  }
  if (u.pathname.endsWith('/pulls') && method === 'GET') return Response.json(prs.filter((p) => u.searchParams.get('head')?.endsWith(`:${p.head}`)));
  return new Response(`stand-in has no ${method} ${u.pathname}`, { status: 404 });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const P = await import('../src/plugins.ts');

test('the catalog loads and validates; a bad entry is refused with the reason', () => {
  const c = P.loadCatalog();
  const ids = c.plugins.map((p) => p.id);
  for (const id of ['hawkes-net', 'playtest', 'hawkes-gen-unity', 'analytics', 'bug-report']) assert.ok(ids.includes(id), id);
  assert.deepEqual(Object.keys(c.plugins.find((p) => p.id === 'hawkes-net')!.engines).sort(), ['babylon', 'unity', 'web']);
  assert.deepEqual(P.validateCatalog(c), []);
  const bad = P.validateCatalog({ plugins: [
    { id: 'x', name: 'X', description: 'd', gives: [], setup: [], engines: { unity: { kind: 'upm-git', versions: { source: 'github-tags', repo: 'a/b' } } } },
    { id: 'x', name: 'X', description: 'd', gives: [], setup: [], engines: { amiga: { kind: 'zip', versions: { source: 'none' } } } },
    { id: 'y', name: 'Y', description: 'd', gives: [], setup: [], engines: { web: { kind: 'script-tag', src: 's', tag: 't', detect: '(', versions: { source: 'fixed', list: [] } } } },
  ] });
  for (const want of [/x unity: upm-git needs package/, /needs git/, /id is used twice/, /amiga: engine is one of/, /kind is one of/, /detect is not a regex/, /versions\.list/]) assert.ok(bad.some((e) => want.test(e)), `${want}: ${bad.join(' | ')}`);
});

test('versions: compared part by part; outdated only for real versions; a dependency spec names its version', () => {
  assert.equal(P.cmpVersion('0.5.1', '0.6.0'), -1);
  assert.equal(P.cmpVersion('1.10.0', '1.9.9'), 1);
  assert.equal(P.cmpVersion('1.2', '1.2.0'), 0);
  assert.ok(P.isOutdated('0.5.0', '0.6.0'));
  assert.ok(!P.isOutdated('0.6.0', '0.6.0'));
  assert.ok(!P.isOutdated('local', '0.6.0'), 'a local path is never outdated');
  assert.ok(P.isOutdated('0', '1'));
  assert.equal(P.versionOfSpec('https://github.com/x/y.git?path=/Packages/z#v0.6.0'), '0.6.0');
  assert.equal(P.versionOfSpec('https://github.com/x/y/archive/refs/tags/v1.3.0.tar.gz'), '1.3.0');
  assert.equal(P.versionOfSpec('^7.0.0'), '7.0.0');
  assert.equal(P.versionOfSpec('file:C:/Projects/hawkesgen/clients/unity/com.hawkes.gen'), 'local');
});

test('JSON edits keep the file as it was: in place, sorted inserts with its own indent and newlines, new sections, removals', () => {
  const up = P.setDep(MANIFEST, 'com.hawkes.net', 'X#v0.6.0');
  assert.equal(up, MANIFEST.replace(/"https:[^"]+#v0\.5\.0"/, '"X#v0.6.0"'), 'only the value changed');
  const ins = P.setDep(MANIFEST, 'com.hawkes.playtest', 'file:../p');
  assert.equal(ins.split('\n')[3], '    "com.hawkes.playtest": "file:../p",', 'in sorted place, with the same indent');
  assert.equal(ins.split('\n').length, MANIFEST.split('\n').length + 1);
  const last = P.setDep(MANIFEST, 'zz.last', '1');
  assert.match(last, /"com\.unity\.ugui": "2\.0\.0",\n {4}"zz\.last": "1"\n {2}\}/);
  const crlf = P.setDep(PKG, '@hawkesgen/net-babylon', 'T');
  assert.match(crlf, /"@babylonjs\/core": "\^7\.0\.0",\r\n {8}"@hawkesgen\/net-babylon": "T",\r\n {8}"vite"/, 'CRLF and four spaces kept');
  assert.ok(!/[^\r]\n/.test(crlf), 'no bare newline');
  const fresh = P.setDep('{\n  "name": "a"\n}\n', '@hawkesgen/net', 'T');
  assert.equal(fresh, '{\n  "name": "a",\n  "dependencies": {\n    "@hawkesgen/net": "T"\n  }\n}\n');
  assert.equal(P.setDep('{\n  "dependencies": {}\n}', 'a', '1'), '{\n  "dependencies": {\n    "a": "1"\n  }\n}');
  assert.equal(P.removeDep(MANIFEST, 'com.unity.ugui'), MANIFEST.replace(',\n    "com.unity.ugui": "2.0.0"', ''), 'the last one: the comma before it goes');
  assert.equal(P.removeDep(MANIFEST, 'com.hawkes.net'), MANIFEST.replace(/ {4}"com\.hawkes\.net": "[^"]+",\n/, ''));
  assert.equal(P.findDep(MANIFEST, 'com.unity.ugui')!.line, 5);
});

test('a script line goes before </head> with the head\'s indent; an upgrade changes only its src', () => {
  const out = P.insertScript(PAGE, '<script src="a.js" defer></script>');
  assert.equal(out, PAGE.replace('  </head>', '    <script src="a.js" defer></script>\n  </head>'));
  const at = SITE.indexOf('https://hawkesgen.ai/sdk/analytics@1.js');
  assert.equal(P.replaceScriptSrc(SITE, at, 'https://hawkesgen.ai/sdk/analytics@2.js'), SITE.replace('@1.js', '@2.js'));
  assert.throws(() => P.insertScript('<p>no head</p>', 'x'), /no <\/head>/);
});

test('detect: versions found across a project\'s repos (a Unity project in a subfolder, its website), latest from tags, outdated', async () => {
  const d = await P.detect('unigame');
  assert.deepEqual(d.repos.map((r: any) => [r.repo, r.role, r.ref]), [['acme/unigame', 'main', 'beta'], ['acme/unisite', 'site', 'main']], 'beta, else main');
  assert.deepEqual(d.repos[0].unity, ['Game/Packages/manifest.json']);
  assert.deepEqual(d.repos[0].packages, [], "a Unity package's own package.json isn't the web project's");
  const net = d.plugins.find((p: any) => p.id === 'hawkes-net')!;
  const unity = net.engines.find((e: any) => e.engine === 'unity')!;
  assert.deepEqual({ installed: unity.installed, version: unity.version, latest: unity.latest, outdated: unity.outdated, action: unity.action }, { installed: true, version: '0.5.0', latest: '0.6.0', outdated: true, action: 'upgrade' });
  assert.deepEqual(unity.where, { repo: 'acme/unigame', path: 'Game/Packages/manifest.json', line: 3 });
  assert.equal(net.engines.find((e: any) => e.engine === 'babylon')!.action, 'n/a');
  const analytics = d.plugins.find((p: any) => p.id === 'analytics')!.engines.find((e: any) => e.engine === 'web')!;
  assert.deepEqual([analytics.installed, analytics.version, analytics.latest, analytics.outdated, analytics.where?.repo, analytics.where?.line], [true, '1', '1', false, 'acme/unisite', 2]);
  const gen = d.plugins.find((p: any) => p.id === 'hawkes-gen-unity')!.engines[0];
  assert.deepEqual([gen.available, gen.action, gen.latest], [false, 'unavailable', '0.2.1'], 'coming soon, its version still read');
  assert.equal(d.plugins.find((p: any) => p.id === 'playtest')!.engines.find((e: any) => e.engine === 'unity')!.action, 'install');
  assert.ok(calls.some((c) => c.path.startsWith('/repos/jgriffith3433/hawkesnet-unity/tags') && c.auth === 'Bearer ghp_test'), "tags read through GitHub's API");

  const w = await P.detect('webgame');
  const wnet = w.plugins.find((p: any) => p.id === 'hawkes-net')!;
  assert.deepEqual(wnet.engines.map((e: any) => [e.engine, e.action]), [['unity', 'n/a'], ['web', 'install'], ['babylon', 'install']]);
  assert.deepEqual(w.repos[0].packages, ['package.json'], 'node_modules skipped');
  const moon = await P.detect('moon');
  const pt = moon.plugins.find((p: any) => p.id === 'playtest')!.engines.find((e: any) => e.engine === 'web')!;
  assert.deepEqual([pt.installed, pt.version, pt.latest, pt.outdated, pt.where?.path], [true, '0', '1', true, 'js/hawkes-playtest.js']);
  const none = await P.detect('norepo');
  assert.equal(none.repos.length, 0);
  assert.match(String(none.note), /no GitHub repository/);
});

test('plans: an upgrade is one line; an install picks Babylon for a Babylon game; embeds and copies; refusals say why', async () => {
  const up = await P.plan('unigame', 'hawkes-net');
  assert.deepEqual([up.engine, up.repo, up.base, up.version, up.from, up.upgrade], ['unity', 'acme/unigame', 'beta', '0.6.0', '0.5.0', true]);
  assert.equal(up.edits.length, 1);
  assert.equal(up.edits[0].content, MANIFEST.replace('#v0.5.0', '#v0.6.0'));
  const pinned = await P.plan('unigame', 'hawkes-net', { version: '0.5.1' });
  assert.match(pinned.edits[0].content!, /#v0\.5\.1"/);
  await assert.rejects(P.plan('unigame', 'hawkes-net', { version: '9.0.0' }), /isn't released/);
  await assert.rejects(P.plan('unigame', 'hawkes-gen-unity'), /Coming soon/);
  await assert.rejects(P.plan('webgame', 'hawkes-net', { engine: 'unity' }), /needs a Unity project/);

  const bab = await P.plan('webgame', 'hawkes-net');
  assert.equal(bab.engine, 'babylon');
  assert.equal(bab.edits[0].path, 'package.json');
  assert.equal(bab.edits[0].content, PKG.replace('"vite": "^5', '"@hawkesgen/net-babylon": "https://github.com/jgriffith3433/hawkesnet-babylon/archive/refs/tags/v0.1.2.tar.gz",\r\n        "vite": "^5'));

  const embed = await P.plan('unigame', 'playtest', { engine: 'unity' });
  const ours = fs.readdirSync(path.join(import.meta.dirname, '..', 'clients', 'unity', 'com.hawkes.playtest'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  assert.equal(embed.edits.length, ours);
  assert.ok(embed.edits.every((e) => e.action === 'create' && e.path.startsWith('Game/Packages/com.hawkes.playtest/')));
  assert.ok(embed.edits.some((e) => e.path === 'Game/Packages/com.hawkes.playtest/package.json'));

  const copy = await P.plan('moon', 'playtest');
  assert.deepEqual(copy.edits.map((e) => [e.path, e.action]), [['js/hawkes-playtest.js', 'update'], ['js/hawkes-playtest.d.ts', 'create']], 'updated where the copy is');
  assert.match(copy.edits[0].content!, /CONTRACT_VERSION = 1/);

  const bug = await P.plan('webgame', 'bug-report');
  assert.match(bug.edits[0].content!, /\n {4}<script src="https:\/\/studio\.example\/r\/webgame\.js\?k=rk_[\w-]+" defer><\/script>\n {2}<\/head>/);
  assert.equal((await P.plan('unigame', 'analytics')).edits.length, 0, 'already there: nothing to change');
});

test('apply: a branch from beta through the Git Data API with the repo\'s token, a pull request into beta, recorded; again reuses both', async () => {
  calls.length = 0;
  const r: any = await P.apply('unigame', 'hawkes-net', { by: 'ada@example.com' });
  assert.equal(r.branch, 'plugin/hawkes-net-0.6.0');
  assert.equal(r.url, 'https://github.com/acme/unigame/pull/7');
  const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(writes, ['POST /repos/acme/unigame/git/blobs', 'POST /repos/acme/unigame/git/trees', 'POST /repos/acme/unigame/git/commits', 'POST /repos/acme/unigame/git/refs', 'POST /repos/acme/unigame/pulls']);
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/repos/acme/unigame/git/ref/heads/beta'), 'cut from beta');
  assert.ok(calls.filter((c) => c.method !== 'GET').every((c) => c.auth === 'Bearer ghp_test'));
  const tree = calls.find((c) => c.path.endsWith('/git/trees'))!.body;
  assert.equal(tree.base_tree, '7ee'.padEnd(40, '0'));
  assert.deepEqual(tree.tree.map((t: any) => t.path), ['Game/Packages/manifest.json']);
  assert.equal(calls.find((c) => c.path.endsWith('/git/refs'))!.body.ref, 'refs/heads/plugin/hawkes-net-0.6.0');
  const pr = calls.find((c) => c.path.endsWith('/pulls'))!.body;
  assert.deepEqual([pr.base, pr.head], ['beta', 'plugin/hawkes-net-0.6.0']);
  assert.match(pr.title, /Upgrade Hawkes Net 0\.6\.0 \(was 0\.5\.0\)/);
  assert.match(pr.body, /net\.hawkesgen\.ai/, 'its setup notes');
  const row = P.installsOf('unigame')[0];
  assert.deepEqual([row.plugin, row.version, row.from_version, row.status, row.pr, row.by], ['hawkes-net', '0.6.0', '0.5.0', 'open', 7, 'ada@example.com']);

  calls.length = 0;
  const again: any = await P.apply('unigame', 'hawkes-net');
  assert.equal(again.pr, 7, 'the open pull request is reused');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path === '/repos/acme/unigame/git/refs/heads/plugin/hawkes-net-0.6.0' && c.body.force), 'its branch moved onto the new commit');

  const embed: any = await P.apply('unigame', 'playtest', { engine: 'unity' });
  assert.equal(embed.branch, 'plugin/playtest-0.2.0');
  assert.equal((await P.apply('unigame', 'analytics') as any).nothing, true, 'nothing to change: no branch');
});

test('the brief for an agent starts from the plugin branch and carries the setup', async () => {
  const pl = await P.plan('webgame', 'hawkes-net');
  const b = P.briefFor(pl, P.getPlugin('hawkes-net'), 'plugin/hawkes-net-0.1.2');
  assert.match(b, /git fetch origin plugin\/hawkes-net-0\.1\.2 && git merge --no-edit FETCH_HEAD/);
  assert.match(b, /multiplayer\(scene/);
  assert.match(b, /net\.hawkesgen\.ai/);
});

test('the API: the catalog, a project\'s status, a plan, an install', async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const readJson = async (r: http.IncomingMessage) => { let s = ''; for await (const c of r) s += c; return s ? JSON.parse(s) : {}; };
    try { if (!(await P.handlePluginRoutes(req, res, url.pathname, req.method!, url, readJson))) { res.writeHead(404); res.end('{}'); } }
    catch (e: any) { res.writeHead(e.status ?? 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const cat = await (await realFetch(`${base}/api/plugins`)).json();
    const net = cat.plugins.find((p: any) => p.id === 'hawkes-net');
    assert.equal(net.engines.web.latest, '1.3.0');
    assert.equal(net.engines.unity.available, true);
    const st = await (await realFetch(`${base}/api/games/webgame/plugins`)).json();
    assert.equal(st.project, 'webgame');
    const plan = await (await realFetch(`${base}/api/projects/unigame/plugins/playtest/plan?engine=unity`)).json();
    assert.ok(plan.edits.length > 3);
    assert.ok(plan.edits.every((e: any) => e.content !== undefined || e.bytes), 'big files as their size');
    const post = await realFetch(`${base}/api/projects/webgame/plugins/hawkes-net`, { method: 'POST', body: JSON.stringify({ engine: 'web' }) });
    const r = await post.json();
    assert.equal(post.status, 200, JSON.stringify(r));
    assert.equal(r.branch, 'plugin/hawkes-net-1.3.0');
    assert.match(r.url, /acme\/webgame\/pull\/\d+/);
    const missing = await realFetch(`${base}/api/projects/webgame/plugins/nope`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
  } finally { server.close(); }
});
