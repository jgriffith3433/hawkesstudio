// J's "report a bug" button on the beta sites: the page injection, a report becoming a source-J finding linked to the
// milestone he is testing, the screenshot kept, Talk told, and the PM loop's order; and the errors pages report by
// themselves (signatures, noise, dedupe, the endpoint and its rate limit). Scratch database; Gen is pointed at
// a closed port (the library import fails and the local copy is used), and no agent or Claude runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';

// Test files run in parallel (CI): the front door gets a free port of its own, not a fixed one.
const FRONT = await new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bugreport-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ previews: { brt: 'brtest' }, products: [{
  id: 'brtest', name: 'Report test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8796, path: '/' }, dev: { front: FRONT }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}], infra: [{ id: 'hawkesgen', name: 'Hawkes Gen', repo: 'hawkesgen' }] }));

const br = await import('../src/bugreport.ts');
const rm = await import('../src/roadmap.ts');
const talk = await import('../src/talk.ts');
const { db } = await import('../src/db.ts');

// 1x1 red JPEG-ish PNG (any bytes do: the server only stores them).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

test('the button goes into whole pages only, once', () => {
  const info = { product: 'brtest', sha: 'abc1234', ref: 'beta (build Game/v12)' };
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><canvas></canvas></body></html>';
  const out = br.injectReport(page, info);
  assert.ok(out.indexOf('window.__hawkesLog') > out.indexOf('<meta charset="utf-8">'), 'the console hook comes after <meta charset>');
  assert.ok(out.indexOf('window.__hawkesLog') < out.indexOf('<title>'), 'and before anything else in <head>');
  assert.ok(/<script data-hawkes-loader>[^]*"\/dev\/__studio\/report\.js"[^]*Game\/v12[^]*<\/script><\/body>/.test(out), 'the widget loader sits before </body> with the build');
  assert.ok(!/<script src="[^"]*report\.js"/.test(out), 'the widget is no script tag the load event waits on');
  assert.equal(br.injectReport(out, info), out, 'injected once');
  assert.equal(br.injectReport('<div>a fragment</div>', info), '<div>a fragment</div>', 'fragments stay as they are');
  assert.ok(br.injectReport('<p>no head', info) === '<p>no head', 'not a document');
  const quotes = br.injectReport('<html><body></body></html>', { product: 'brtest', ref: "it's <b>" });
  assert.ok(!quotes.includes('<b>') && quotes.includes('it\'s \\u003cb>'), 'the info is a JSON string with < escaped, so it cannot end the script');
  assert.ok(fs.existsSync(br.WIDGET), 'the widget file is there');
});

test('the widget is added after the page loads, so it cannot hold the load event', () => {
  const out = br.injectReport('<html><head></head><body></body></html>', { product: 'brtest', src: 'https://studio.example/o/x/r/widget.js' });
  const code = /<script data-hawkes-loader>([\s\S]*?)<\/script>/.exec(out)![1];
  const added: any[] = [];
  const listeners: Record<string, () => void> = {};
  const timers: (() => void)[] = [];
  const ctx: any = { document: { readyState: 'loading', body: { appendChild: (e: any) => added.push(e) }, createElement: () => ({ attrs: {} as any, setAttribute(k: string, v: string) { this.attrs[k] = v; } }) }, addEventListener: (n: string, f: () => void) => { listeners[n] = f; }, setTimeout: (f: () => void) => timers.push(f) };
  vm.runInNewContext(code, ctx);
  assert.equal(added.length, 0, 'nothing is requested while the page loads');
  listeners.load(); timers.forEach((f) => f());
  assert.equal(added.length, 1);
  assert.equal(added[0].src, 'https://studio.example/o/x/r/widget.js');
  assert.equal(JSON.parse(added[0].attrs['data-hawkes']).product, 'brtest');
});

test('beta pages name beta Hawkes Net before any game code runs, and a page that names its own keeps it', () => {
  assert.equal(br.BETA_NET, 'https://hawkesnet.hawkesgen.ai');
  const out = br.injectReport('<html><head><script src="game.js"></script></head><body></body></html>', { product: 'brtest' });
  assert.ok(out.indexOf('HAWKES_NET_ENDPOINT') < out.indexOf('game.js'), 'set before the game loads');
  const code = /<script data-hawkes-report>([\s\S]*?)<\/script>/.exec(out)![1];
  const run = (start: any) => {
    const ctx: any = { console: { error() {}, warn() {} }, addEventListener() {}, Object, JSON, Date, HAWKES_NET_ENDPOINT: start };
    ctx.window = ctx;
    vm.runInNewContext(code, ctx);
    return ctx.HAWKES_NET_ENDPOINT;
  };
  assert.equal(run(undefined), 'https://hawkesnet.hawkesgen.ai');
  assert.equal(run('http://127.0.0.1:8786'), 'http://127.0.0.1:8786');
});

test('the early hook makes WebGL keep its drawing buffer (screenshots on phones)', () => {
  const out = br.injectReport('<html><head></head><body></body></html>', { product: 'brtest' });
  const code = /<script data-hawkes-report>([\s\S]*?)<\/script>/.exec(out)![1];
  const calls: any[] = [];
  // Attributes as JSON: the hook's objects come from the vm's realm.
  class HTMLCanvasElement { getContext(type: string, attrs?: any) { calls.push({ type, attrs: attrs && JSON.parse(JSON.stringify(attrs)) }); return { type }; } }
  const ctx: any = { HTMLCanvasElement, console: { error() {}, warn() {} }, addEventListener() {}, Object, JSON, Date };
  ctx.window = ctx;
  vm.runInNewContext(code, ctx);
  vm.runInNewContext(code, ctx); // twice (a second copy of the hook): patched once
  const c = new HTMLCanvasElement();
  const unity = { alpha: false, preserveDrawingBuffer: false };
  assert.deepEqual(c.getContext('webgl2', unity), { type: 'webgl2' });
  assert.deepEqual(calls[0].attrs, { alpha: false, preserveDrawingBuffer: true }, "forced on, even when the loader asks for false (Unity)");
  assert.equal(unity.preserveDrawingBuffer, false, "the game's own object is left as it was");
  c.getContext('webgl');
  assert.deepEqual(calls[1].attrs, { preserveDrawingBuffer: true });
  c.getContext('2d', { alpha: false });
  assert.deepEqual(calls[2].attrs, { alpha: false }, '2d canvases are left alone');
  assert.equal(calls.length, 3, 'one call through per getContext');
});

test('a report becomes a top-priority finding for the milestone being tested', async () => {
  const it = rm.addItem({ product: 'brtest', title: 'Controls', criteria: ['jump works'], status: 'planned' });
  const ms = rm.addMilestone({ product: 'brtest', title: 'Controls done', items: [it.id] });
  // Not ready to test yet (nothing on beta): the roadmap.
  assert.equal(br.testing('brtest'), null);
  db.prepare(`UPDATE items SET status = 'on beta' WHERE id = ?`).run(it.id);
  rm.markReached(ms.id);
  assert.deepEqual(br.testing('brtest'), { milestone: ms.id, title: 'Controls done', origin: null, item: it.id });

  const r = await br.fileReport('brtest', {
    text: 'Jump does nothing on the second level. It worked on the first.', url: 'https://brt.hawkesgen.ai/Game/', shot: PNG, shotNote: "game frame couldn't be captured",
    viewport: { w: 390, h: 844, dpr: 3 }, device: { ua: 'Mobile Safari', touch: true, platform: 'iPhone' },
    console: [{ level: 'error', text: 'TypeError: x is undefined' }], state: '{"scene":"level2"}', build: { product: 'brtest', sha: 'abc1234', ref: 'beta' },
  });
  assert.equal(r.message, 'Got it: becomes a task for the milestone "Controls done".');
  const f = db.prepare('SELECT * FROM findings WHERE id = ?').get(r.id) as any;
  assert.equal(f.source, 'J');
  assert.equal(f.status, 'open');
  assert.equal(f.severity, 'bug');
  assert.equal(f.milestone, ms.id);
  assert.equal(f.item, it.id);
  assert.equal(f.title, 'Jump does nothing on the second level.');
  assert.match(f.detail, /TypeError: x is undefined/);
  assert.match(f.detail, /390x844 @3x · touch/);
  assert.match(f.detail, /"scene":"level2"/);
  assert.match(f.detail, /Screenshot note: game frame couldn't be captured/, 'the agent hears the picture has no game frame');
  const shot = br.reportShot(r.id);
  assert.ok(shot && fs.readFileSync(shot).length > 0, 'the screenshot is kept');
  // Talk: a "Playtest:" conversation (the milestone has no conversation of its own) with the notice.
  const c = talk.getConversation(r.conversation!)!;
  assert.match(c.title ?? '', /^Playtest: Controls done/);
  assert.match(c.messages.at(-1)!.text, new RegExp(r.id));
  assert.match(c.messages.at(-1)!.text, /!\[screenshot\]\(.*\/api\/bugreports\/f_[0-9a-f]+\/shot\)/);
  // Listed for the milestone (Ready to test).
  const list = br.listReports({ milestone: ms.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].errors, 1);
  assert.equal(list[0].shot, `/api/bugreports/${r.id}/shot`);
  // A second report the same day goes to the same conversation; a blocker stays a blocker.
  const r2 = await br.fileReport('brtest', { text: 'Game freezes after the boss', blocker: true });
  assert.equal(r2.conversation, r.conversation);
  assert.equal((db.prepare('SELECT severity FROM findings WHERE id = ?').get(r2.id) as any).severity, 'blocker');
  await assert.rejects(br.fileReport('brtest', { text: '  ' }), /Say what is wrong/);
});

test('Talk hears when a report is fixed', async () => {
  const [f] = br.listReports({ product: 'brtest' });
  db.prepare(`UPDATE findings SET status = 'fixed' WHERE id = ?`).run(f.id);
  await br.reportFollowups();
  const c = talk.getConversation(f.conversation!)!;
  assert.match(c.messages.at(-1)!.text, new RegExp(`${f.id}.*is fixed`));
  const n = c.messages.length;
  await br.reportFollowups();
  assert.equal(talk.getConversation(f.conversation!)!.messages.length, n, 'told once');
});

test('error signatures: same error, same signature; noise is dropped', () => {
  const a = br.errorSignature("TypeError: Cannot read properties of undefined (reading 'hp')", "TypeError: x\n    at Fighter.hit (https://brt.hawkesgen.ai/assets/index-a1b2c3d4.js?v=17:120:33)\n    at loop (https://brt.hawkesgen.ai/assets/index-a1b2c3d4.js:9:1)");
  const b = br.errorSignature("Uncaught TypeError: Cannot read properties of undefined (reading 'hp')", "TypeError: x\n    at Fighter.hit (https://brt.hawkesgen.ai/c/c_0123abcd/assets/index-ffee9988.js:121:7)");
  assert.equal(a, b, 'line numbers, bundle hashes, hosts, change paths and "Uncaught" don\'t matter');
  assert.match(a, /reading 'hp'.*Fighter\.hit/);
  assert.notEqual(a, br.errorSignature("TypeError: Cannot read properties of undefined (reading 'mp')", 'at Fighter.hit (https://x/assets/index.js:1:1)'));
  assert.notEqual(a, br.errorSignature("TypeError: Cannot read properties of undefined (reading 'hp')", 'at Enemy.hit (https://x/assets/index.js:1:1)'), 'another place');
  assert.equal(br.errorSignature('Level 12 failed for player 8f3a9c21', ''), br.errorSignature('Level 3 failed for player 77b0e1d4', ''), 'numbers and ids stripped');
  // Firefox/Safari frames; the widget's own frames skipped.
  assert.match(br.errorSignature('boom', 'at x (https://b/dev/__studio/report.js:1:1)\nhit@https://b/assets/game.js:4:2'), /boom \| hit@\/assets\/game\.js:#:#/);
  assert.ok(br.isNoise('ResizeObserver loop completed with undelivered notifications.'));
  assert.ok(br.isNoise('Script error.', ''), 'opaque cross-origin error');
  assert.ok(br.isNoise('TypeError: a is null', 'at f (chrome-extension://abcdef/content.js:1:2)'), 'an extension');
  assert.ok(br.isNoise('x', '', 'moz-extension://abc/inject.js'));
  assert.ok(br.isNoise("Uncaught (in promise) DOMException: The play() request was interrupted by a call to pause()."));
  assert.ok(br.isNoise(''));
  assert.ok(!br.isNoise('TypeError: a is null', 'at f (https://brt.hawkesgen.ai/assets/game.js:1:2)'));
});

test('an error the page catches becomes one source-auto finding; again only counts', async () => {
  const err = (over: any = {}) => ({ error: { kind: 'error', message: 'TypeError: boss is undefined', stack: 'TypeError: boss is undefined\n    at Arena.tick (https://brt.hawkesgen.ai/assets/game-9f8e7d6c.js:40:9)', ...over },
    url: 'https://brt.hawkesgen.ai/', viewport: { w: 390, h: 844 }, device: { ua: 'Mobile Safari', touch: true, platform: 'iPhone' }, shot: PNG,
    console: [{ level: 'error', text: 'TypeError: boss is undefined' }], state: '{"scene":"arena"}', build: { product: 'brtest', sha: 'def5678', ref: 'beta' } });
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM findings`).get() as any).n;
  const r1: any = await br.fileAutoError('brtest', err(), '10.0.0.1');
  const f = db.prepare('SELECT * FROM findings WHERE id = ?').get(r1.id) as any;
  assert.equal(f.source, 'auto');
  assert.equal(f.scenario, 'auto-error');
  assert.equal(f.severity, 'bug');
  assert.equal(f.status, 'open');
  assert.equal(f.milestone, null, "not linked to J's milestone");
  assert.match(f.title, /^Error on beta: TypeError: boss is undefined/);
  assert.match(f.detail, /Arena\.tick/);
  assert.match(f.detail, /390x844 · touch · iPhone/);
  assert.match(f.detail, /"scene":"arena"/);
  assert.ok(br.reportShot(r1.id), 'its screenshot is kept');
  // Another load, another line number and bundle: the same finding, seen twice, the latest sample kept.
  const r2: any = await br.fileAutoError('brtest', err({ stack: 'TypeError: boss is undefined\n    at Arena.tick (https://brt.hawkesgen.ai/assets/game-0a1b2c3d.js:41:2)' , }), '10.0.0.2');
  assert.equal(r2.id, r1.id);
  assert.equal(r2.seen, true);
  const g = db.prepare('SELECT * FROM findings WHERE id = ?').get(r1.id) as any;
  assert.equal(g.seen, 2);
  assert.match(g.detail, /game-0a1b2c3d\.js:41/, 'the latest sample');
  assert.ok(br.reportShot(r1.id), 'the first screenshot stays');
  assert.deepEqual(await br.fileAutoError('brtest', err({ message: 'ResizeObserver loop limit exceeded', stack: '' }), '10.0.0.1'), { ok: true, ignored: true });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM findings`).get() as any).n, n + 1, 'one finding');
  // Not J's lane: J's reports list leaves it out.
  assert.ok(!br.listReports({ product: 'brtest' }).some((x) => x.id === r1.id));
  // Fixed and seen again: it comes back.
  db.prepare(`UPDATE findings SET status = 'fixed' WHERE id = ?`).run(r1.id);
  const r3: any = await br.fileAutoError('brtest', err(), '10.0.0.3');
  assert.equal(r3.id, r1.id);
  assert.equal((db.prepare('SELECT status FROM findings WHERE id = ?').get(r1.id) as any).status, 'open');
});

test('the /dev/__studio/error endpoint: same-origin JSON, rate-limited per IP', async () => {
  const { startFronts, stopFronts } = await import('../src/dev-front.ts');
  startFronts();
  try {
    const url = `http://127.0.0.1:${FRONT}/dev/__studio/error`;
    // startFronts doesn't wait for listen: wait until the front door answers.
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${FRONT}/dev/__studio/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const post = (body: any, ip: string, headers: any = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `${ip}, 10.9.9.9`, ...headers }, body: JSON.stringify(body) });
    const body = { error: { kind: 'rejection', message: 'Error: save failed 503', stack: 'Error: save failed\n    at save (https://brt.hawkesgen.ai/assets/save.js:3:3)' }, url: 'https://brt.hawkesgen.ai/' };
    let r = await post(body, '192.0.2.7');
    assert.equal(r.status, 200);
    const out: any = await r.json();
    assert.match(out.id, /^f_/);
    assert.equal((db.prepare('SELECT source FROM findings WHERE id = ?').get(out.id) as any).source, 'auto');
    assert.equal((await post(body, '192.0.2.7', { Origin: 'https://evil.example' })).status, 403, 'other origins are refused');
    for (let i = 1; i < 20; i++) assert.equal((await post(body, '192.0.2.7')).status, 200);
    r = await post(body, '192.0.2.7');
    assert.equal(r.status, 429, 'the 21st in 10 minutes from one IP');
    assert.equal((await post(body, '192.0.2.8')).status, 200, 'another IP still gets through');
    assert.equal((db.prepare('SELECT seen FROM findings WHERE id = ?').get(out.id) as any).seen, 21, 'one finding, seen each time');
  } finally { stopFronts(); }
});

test('the early hook hands caught errors to the widget, and queues them before it loads', () => {
  const out = br.injectReport('<html><head></head><body></body></html>', { product: 'brtest' });
  const code = /<script data-hawkes-report>([\s\S]*?)<\/script>/.exec(out)![1];
  const on: Record<string, Function> = {};
  const ctx: any = { console: { error() {}, warn() {} }, addEventListener: (t: string, f: Function) => { on[t] = f; }, Object, JSON, Date, String, Error };
  ctx.window = ctx;
  vm.runInNewContext(code, ctx);
  vm.runInNewContext('console.error("bad thing", new Error("inner"))', ctx);
  on.error({ message: 'Uncaught TypeError: z', error: { message: 'z', stack: 'TypeError: z\n at f (a.js:1:1)' }, filename: 'a.js', lineno: 1, colno: 1 });
  assert.equal(ctx.__hawkesErrs.length, 2, 'queued until the widget is there');
  assert.equal(ctx.__hawkesErrs[0].kind, 'console');
  assert.match(ctx.__hawkesErrs[0].message, /bad thing.*inner/);
  assert.match(ctx.__hawkesErrs[1].stack, /at f/);
  const got: any[] = [];
  ctx.__hawkesOnError = (x: any) => got.push(x);
  on.unhandledrejection({ reason: 'nope' });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'rejection');
  assert.equal(got[0].message, 'nope');
  assert.equal(ctx.__hawkesLog.length, 3, 'the console log still has all three');
});

test('hawkes-perf diagnoses Babylon scenes, leaks, passes and root-cause suspects, and hooks hawkes-playtest + bugreport', async () => {
  const g = globalThis as any;
  const saved = { window: g.window, location: g.location, addEventListener: g.addEventListener, requestAnimationFrame: g.requestAnimationFrame };
  try {
    const sharedMat = { name: 'RockMat', isFrozen: false, markAsDirty() {} };
    const bossMesh = {
      name: 'BossMesh',
      getTotalIndices: () => 60_000 * 3,
      getTotalVertices: () => 45_000,
      skeleton: { bones: new Array(64).fill({}) },
      numBoneInfluencers: 4,
      thinInstanceCount: 0,
      isWorldMatrixFrozen: false,
      isEnabled: () => true,
      isVisible: true,
    };
    const grassThin = {
      name: 'GrassPatch',
      getTotalIndices: () => 100 * 3,
      getTotalVertices: () => 200,
      thinInstanceCount: 500,
      isWorldMatrixFrozen: true,
      isEnabled: () => true,
      isVisible: true,
    };
    const rocks = Array.from({ length: 12 }, (_, i) => ({
      name: `Rock_${i}`,
      getTotalIndices: () => 500 * 3,
      getTotalVertices: () => 400,
      material: sharedMat,
      isWorldMatrixFrozen: false,
      isEnabled: () => true,
      isVisible: true,
    }));
    const meshes: any[] = [bossMesh, grassThin, ...rocks];
    const shadowGen = {
      id: 'SunShadows',
      getShadowMap: () => ({ getSize: () => ({ width: 2048, height: 2048 }), renderList: [bossMesh] }),
    };
    const lights = [
      { name: 'Sun', isEnabled: () => true, intensity: 1.2, getShadowGenerator: () => shadowGen },
      { name: 'Fill1', isEnabled: () => true, intensity: 0.5 },
      { name: 'Fill2', isEnabled: () => true, intensity: 0.4 },
      { name: 'Fill3', isEnabled: () => true, intensity: 0.3 },
      { name: 'UnusedZeroLight', isEnabled: () => true, intensity: 0 },
    ];
    const textures: any[] = [
      { uniqueId: 1, getSize: () => ({ width: 2048, height: 2048 }) },
      { name: 'MirrorRT', isRenderTarget: true, mirrorPlane: {}, getSize: () => ({ width: 1024, height: 1024 }), renderList: null },
    ];
    const mockEngine = {
      getFps: () => 34,
      getDeltaTime: () => 29.4,
      _drawCalls: { current: 185 },
      scenes: [] as any[],
    };
    const mockScene: any = {
      getEngine: () => mockEngine,
      meshes,
      materials: [sharedMat],
      geometries: [{}, {}],
      textures,
      lights,
      effectLayers: [{ name: 'MainGlow', getClassName: () => 'GlowLayer', _includedOnlyMeshes: [] }],
      customRenderTargets: [],
      animationGroups: [{}],
      skeletons: [bossMesh.skeleton],
      particleSystems: [],
      transformNodes: [{}],
      getActiveMeshes: () => meshes,
      imageProcessingConfiguration: { onUpdateParameters: { add() { return {}; }, remove() {} } },
      onBeforeRenderObservable: { observers: [{}], add() { return {}; }, remove() {} },
    };
    mockEngine.scenes.push(mockScene);

    g.window = { BABYLON: { Engine: { Instances: [mockEngine] } } };
    g.location = { search: '' };
    g.addEventListener = () => {};
    g.requestAnimationFrame = () => 0;

    const { installPerfMonitor } = await import('../clients/web/hawkes-perf.js' as string);
    const perf = installPerfMonitor( null, { forceNew: true });
    assert.equal(g.window.hawkesPerf, perf);

    // Dirty material several times to trigger dirty/sec tracking
    for (let i = 0; i < 15; i++) sharedMat.markAsDirty();
    perf.mark('before-spawn');

    // Simulate a mesh & texture leak after baseline/mark
    for (let i = 0; i < 30; i++) {
      meshes.push({ name: `Leaked_${i}`, getTotalIndices: () => 300, getTotalVertices: () => 100, isEnabled: () => true });
    }

    const snap = perf.snapshot();
    assert.equal(snap.sceneAttached, true);
    assert.equal(snap.fps.current, 34);
    assert.equal(snap.drawCalls, 185);
    assert.equal(snap.skinnedMeshes, 1);
    assert.equal(snap.activeBones, 64);
    assert.equal(snap.thinInstanceMeshes, 1);
    assert.equal(snap.thinInstancesTotal, 500);
    assert.equal(snap.topHeavyMeshes[0].name, 'BossMesh');
    assert.equal(snap.topHeavyMeshes[0].tris, 60_000);
    assert.equal(snap.topHeavyMeshes[0].castsShadow, true);
    assert.equal(snap.unmergedMaterialGroups[0].material, 'RockMat');
    assert.equal(snap.unmergedMaterialGroups[0].meshCount, 12);
    assert.equal(snap.enabledLights, 5);
    assert.equal(snap.zeroIntensityEnabledLights, 1);
    assert.equal(snap.resources.delta.meshes, 30);
    assert.equal(snap.leaks.leaked, true);
    assert.ok(snap.renderPasses.some((p: any) => p.kind === 'GlowLayer' && p.fullScene));
    assert.ok(snap.renderPasses.some((p: any) => p.kind === 'MirrorTexture' && p.fullScene));
    assert.ok(snap.suspects.some((s: string) => /Low FPS/.test(s)));
    assert.ok(snap.suspects.some((s: string) => /BossMesh/.test(s)));
    assert.ok(snap.suspects.some((s: string) => /Full-scene GlowLayer/.test(s)));
    assert.ok(snap.suspects.some((s: string) => /Unmerged static meshes/.test(s)));
    assert.ok(snap.suspects.some((s: string) => /Mesh leak: \+30 meshes/.test(s)));

    // Verify hawkes-playtest.js attaches perf automatically on state() and report()
    const { installPlaytest } = await import('../clients/web/hawkes-playtest.js' as string);
    const pt = installPlaytest({
      product: 'brtest',
      scenarios: [{ id: 'smoke', title: 'Smoke', seconds: 10 }],
      start: async (_id: string, _o: any, t: any) => { t.finish('done'); },
    });
    assert.equal((pt.state() as any).perf.drawCalls, 185);
    await pt.start('smoke');
    assert.equal((pt.report() as any).perf.topHeavyMeshes[0].name, 'BossMesh');

    // Verify fileReport and fileAutoError format Performance & scene diagnostics into finding detail
    const rep = await br.fileReport('brtest', {
      text: 'Frame rate drops hard during the boss fight.',
      perf: snap,
    });
    const f = db.prepare('SELECT * FROM findings WHERE id = ?').get(rep.id) as any;
    assert.match(f.detail, /Performance & scene diagnostics:/);
    assert.match(f.detail, /FPS: 34 current/);
    assert.match(f.detail, /185 draw calls/);
    assert.match(f.detail, /BossMesh \(60000 tris/);
    assert.match(f.detail, /Leak deltas.*meshes \+30/);
    assert.match(f.detail, /Root-cause suspects:/);
    assert.match(f.detail, /Full-scene GlowLayer/);
  } finally {
    Object.assign(g, saved);
  }
});

test('the widget keeps typing in its fields from the page: capture-phase key guard and Unity keyboard capture off', () => {
  const src = fs.readFileSync(br.WIDGET, 'utf8');
  assert.match(src, /for \(const t of \['keydown', 'keyup', 'keypress'[^\]]*\]\) \{\s*addEventListener\(t, [^\n]*, true\);/, 'window capture listeners for keys');
  assert.match(src, /composedPath/, 'finds the modal through the shadow root');
  assert.match(src, /captureAllKeyboardInput = false/, 'Unity WebGL keyboard capture is switched off while open');
  assert.match(src, /unityCapture\(false\)[\s\S]*unityCapture\(true\)/, 'off on open, restored on close');
});

test("Hawkes Gen's beta app (beta.<domain>) has the button: its reports file against Gen, with the page's own context", async () => {
  const front = await import('../src/dev-front.ts');
  const call = (route: string, method: string, body?: unknown, host = 'beta.hawkesgen.ai') => {
    const data = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req: any = (async function* () { yield* data; })();
    req.method = method;
    req.headers = { 'x-forwarded-host': host, origin: 'https://' + host, 'content-type': 'application/json' };
    req.socket = { remoteAddress: '203.0.113.9' };
    const res: any = { status: 0, body: '' };
    res.writeHead = (st: number) => { res.status = st; return res; };
    res.setHeader = () => {};
    res.end = (b?: any) => { res.body += b ? String(b) : ''; };
    return { req, res };
  };
  const w = call('/dev/__studio/report.js', 'GET');
  assert.equal(front.appHostWidget(w.req, w.res, '/dev/__studio/report.js', 'hawkesgen.ai', 'live'), true);
  assert.equal(w.res.status, 200);
  assert.match(w.res.body, /hawkesReportContext/, 'the widget, which reads the page context');
  const other = call('/dev/__studio/report.js', 'GET', undefined, 'phorigins.hawkesgen.ai');
  assert.equal(front.appHostWidget(other.req, other.res, '/dev/__studio/report.js', 'hawkesgen.ai', 'live'), false, 'only the apps listed');
  const context = { account: { id: 'u_abc', email: 'j@example.com' }, scene: { id: 'sc_123', kind: 'video', title: 'Intro' }, tabs: ['sc_123', 'sc_456'] };
  const r = call('/dev/__studio/report', 'POST', { text: 'The AI took over my preview.', url: 'https://beta.hawkesgen.ai/', shot: PNG, state: JSON.stringify(context), build: { product: 'hawkesgen', ref: 'Gen beta' } });
  assert.equal(await front.betaHostReport(r.req, r.res, '/dev/__studio/report', 'hawkesgen.ai', 'live'), true);
  assert.equal(r.res.status, 200, r.res.body);
  const f = db.prepare("SELECT * FROM findings WHERE product = 'hawkesgen' ORDER BY first_seen DESC LIMIT 1").get() as any;
  assert.equal(f.title, 'The AI took over my preview.');
  const rep = JSON.parse(f.report);
  assert.match(rep.state, /sc_123/);
  assert.match(rep.state, /u_abc/);
  assert.ok(rep.shot, 'the screenshot is kept');
});

test('the 🐞 widget hides under Studio playtests (web and Unity WebGL, ?playtest= or runner flags), shows on normal beta visits and ?report=1, and keeps checkBuild / data-hawkes working', async () => {
  const { servedSha } = await import('../src/servedpage.ts');
  const { withPlaytestHint } = await import('../src/pipeline.ts');
  const widgetCode = fs.readFileSync(br.WIDGET, 'utf8');

  const runPage = async (opts: { search?: string; globals?: Record<string, any>; webdriver?: boolean; info?: any; buildReply?: any } = {}) => {
    const info = opts.info ?? { product: 'place-department-unity', sha: 'abc1234', ref: 'beta (build Game/v12)', version: '12' };
    const html = br.injectReport('<!doctype html><html><head><meta charset="utf-8"></head><body><canvas></canvas></body></html>', info);
    const loaderCode = /<script data-hawkes-loader>([\s\S]*?)<\/script>/.exec(html)![1];

    const makeEl = (tag: string): any => {
      const classes = new Set<string>();
      const attrs: Record<string, string> = {};
      const children: any[] = [];
      const listeners: Record<string, Function[]> = {};
      const el: any = {
        tagName: tag.toUpperCase(),
        hidden: false,
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        dataset: {} as Record<string, string>,
        style: { cssText: '', display: '', top: '' },
        children,
        parentNode: null as any,
        classList: {
          add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
          remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
          toggle: (c: string, on?: boolean) => {
            const want = on === undefined ? !classes.has(c) : Boolean(on);
            if (want) classes.add(c); else classes.delete(c);
            return want;
          },
          contains: (c: string) => classes.has(c),
        },
        setAttribute: (k: string, v: string) => { attrs[k] = String(v); },
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
        hasAttribute: (k: string) => k in attrs,
        removeAttribute: (k: string) => { delete attrs[k]; },
        appendChild: (c: any) => { c.parentNode = el; children.push(c); return c; },
        removeChild: (c: any) => { const i = children.indexOf(c); if (i >= 0) { children.splice(i, 1); c.parentNode = null; } return c; },
        remove: () => { if (el.parentNode) el.parentNode.removeChild(el); },
        addEventListener: (t: string, fn: Function) => { (listeners[t] ||= []).push(fn); },
        setPointerCapture: () => {},
        focus: () => {},
        blur: () => {},
        attachShadow: () => {
          const bySel = new Map<string, any>();
          const root: any = {
            innerHTML: '',
            querySelector: (s: string) => {
              if (!bySel.has(s)) {
                const sub = makeEl(s.startsWith('.') ? 'div' : s);
                if (s === '.dot') sub.textContent = '🐞';
                bySel.set(s, sub);
              }
              return bySel.get(s);
            },
          };
          el.shadowRoot = root;
          return root;
        },
      };
      return el;
    };

    const body = makeEl('body');
    const docEl = makeEl('html');
    const timers: { fn: Function; ms: number }[] = [];
    const winListeners: Record<string, Function[]> = {};
    const fetched: string[] = [];
    let hostCreated: any = null;
    let scriptEl: any = null;

    const ctx: any = {
      ...(opts.globals ?? {}),
      console: { error() {}, warn() {} },
      location: {
        href: `https://sb-placedept.hawkesgen.ai/${opts.search ?? ''}`,
        hostname: 'sb-placedept.hawkesgen.ai',
        search: opts.search ?? '',
        reload: () => {},
      },
      navigator: { webdriver: Boolean(opts.webdriver), userAgent: 'TestBrowser', language: 'en-US', platform: 'Linux' },
      localStorage: { getItem: () => null, setItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      matchMedia: () => ({ matches: false }),
      URLSearchParams,
      Object, JSON, Date, String, Number, Boolean, Array, Map, Set, WeakSet, RegExp, Error, Math, Promise,
      performance: { now: () => 0 },
      requestAnimationFrame: () => 0,
      setTimeout: (fn: Function, ms = 0) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: (t: string, fn: Function) => { (winListeners[t] ||= []).push(fn); },
      fetch: async (u: string) => {
        fetched.push(u);
        return opts.buildReply ? { ok: true, status: 200, json: async () => opts.buildReply } : { ok: false, status: 404, json: async () => ({}) };
      },
      document: {
        readyState: 'complete',
        visibilityState: 'visible',
        title: 'Place Department',
        body,
        documentElement: docEl,
        head: makeEl('head'),
        currentScript: null as any,
        activeElement: body,
        createElement: (tag: string) => {
          const e = makeEl(tag);
          if (tag === 'div' && !hostCreated) hostCreated = e;
          if (tag === 'script') scriptEl = e;
          return e;
        },
        querySelectorAll: () => [],
        addEventListener: (t: string, fn: Function) => { (winListeners[`doc:${t}`] ||= []).push(fn); },
      },
    };
    ctx.window = ctx;
    ctx.top = ctx;

    // 1. Run the loader snippet injected into the page and flush its load timer to append <script data-hawkes=...>.
    vm.runInNewContext(loaderCode, ctx);
    for (const t of timers.splice(0)) t.fn();
    assert.ok(scriptEl, 'the loader creates the report.js script element');
    ctx.document.currentScript = scriptEl;

    // 2. Run dashboard/report-widget.js with that script element as document.currentScript.
    vm.runInNewContext(widgetCode, ctx);

    // 3. Run the 3000 ms checkBuild timer if scheduled.
    for (const t of timers.filter((x) => x.ms === 3000)) await t.fn();

    const mountedReportEls = body.children.filter((c: any) => c.hasAttribute('data-hawkes-report'));
    const dot = hostCreated?.shadowRoot?.querySelector('.dot');
    const panel = hostCreated?.shadowRoot?.querySelector('.panel');
    const fresh = hostCreated?.shadowRoot?.querySelector('.fresh');
    return { html, sha: servedSha(html), mountedReportEls, host: hostCreated, dot, panel, fresh, fetched, winListeners };
  };

  // (1) Beta playtests of web or Unity WebGL projects: ?playtest= (from withPlaytestHint), ?playtest=<scenario>, or runner flags before navigation.
  const unityPlaytestUrl = new URL(withPlaytestHint('https://sb-placedept.hawkesgen.ai/'));
  assert.equal(unityPlaytestUrl.search, '?playtest=', 'withPlaytestHint adds ?playtest= to beta playtest URLs');

  for (const c of [
    { label: 'empty ?playtest= (withPlaytestHint)', search: unityPlaytestUrl.search },
    { label: '?playtest=smoke scenario param', search: '?playtest=smoke' },
    { label: 'runner __hawkesRunnerFps flag before navigation', globals: { __hawkesRunnerFps: { samples: [] } } },
    { label: 'runner __hawkesPlaytestPush binding before navigation', globals: { __hawkesPlaytestPush: () => {} } },
    { label: 'runner HAWKES_PLAYTEST flag before navigation', globals: { HAWKES_PLAYTEST: '1' } },
    { label: 'navigator.webdriver automation flag', webdriver: true },
  ]) {
    const r = await runPage({ ...c, buildReply: { sha: 'new9999', version: '13' } });
    assert.equal(r.mountedReportEls.length, 0, `${c.label}: no [data-hawkes-report] element is mounted in document.body`);
    assert.equal(r.host.style.display, 'none', `${c.label}: host is hidden`);
    assert.equal(r.dot.style.display, 'none', `${c.label}: 🐞 button is hidden`);
    assert.equal(r.panel.style.display, 'none', `${c.label}: panel is hidden`);
    assert.equal(r.sha, 'abc1234', `${c.label}: servedpage.ts still reads the sha from data-hawkes`);
    assert.ok(r.fetched.includes('/dev/__studio/build'), `${c.label}: checkBuild still runs`);
    assert.equal(r.fresh.dataset.build, 'new9999/13', `${c.label}: checkBuild still records the newer build`);
  }

  // (2) Opening a beta page without the playtest parameter still shows the 🐞 button.
  const normal = await runPage({ search: '', buildReply: { sha: 'new9999', version: '13' } });
  assert.equal(normal.mountedReportEls.length, 1, 'normal beta visit mounts [data-hawkes-report] in document.body');
  assert.notEqual(normal.host.style.display, 'none', 'normal beta visit keeps host visible');
  assert.notEqual(normal.dot.style.display, 'none', 'normal beta visit shows the 🐞 button');
  assert.equal(normal.dot.textContent, '🐞');
  assert.equal(normal.sha, 'abc1234', 'servedpage.ts reads the sha from data-hawkes');
  assert.equal(normal.fresh.classList.contains('on'), true, 'checkBuild shows the newer-build pill on normal visits');

  // (3) ?report=1 forces the 🐞 button on, even when ?playtest= or runner flags are present.
  const forced = await runPage({ search: '?playtest=smoke&report=1', globals: { __hawkesRunnerFps: { samples: [] } }, webdriver: true });
  assert.equal(forced.mountedReportEls.length, 1, '?report=1 forces [data-hawkes-report] to mount');
  assert.notEqual(forced.host.style.display, 'none');
  assert.notEqual(forced.dot.style.display, 'none', '?report=1 forces the 🐞 button to show');
});
