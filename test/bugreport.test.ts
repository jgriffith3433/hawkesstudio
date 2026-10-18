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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bugreport-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ previews: { brt: 'brtest' }, products: [{
  id: 'brtest', name: 'Report test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8796, path: '/' }, dev: { front: 8797 }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

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
  assert.ok(/<script src="\/dev\/__studio\/report\.js" data-hawkes='[^']*Game\/v12[^']*' defer><\/script><\/body>/.test(out), 'the widget sits before </body> with the build');
  assert.equal(br.injectReport(out, info), out, 'injected once');
  assert.equal(br.injectReport('<div>a fragment</div>', info), '<div>a fragment</div>', 'fragments stay as they are');
  assert.ok(br.injectReport('<p>no head', info) === '<p>no head', 'not a document');
  const quotes = br.injectReport('<html><body></body></html>', { product: 'brtest', ref: "it's <b>" });
  assert.ok(!quotes.includes("it's") && !quotes.includes('<b>'), 'the data attribute is escaped');
  assert.ok(fs.existsSync(br.WIDGET), 'the widget file is there');
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
    text: 'Jump does nothing on the second level. It worked on the first.', url: 'https://brt.hawkesgen.com/Game/', shot: PNG, shotNote: "game frame couldn't be captured",
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
  const a = br.errorSignature("TypeError: Cannot read properties of undefined (reading 'hp')", "TypeError: x\n    at Fighter.hit (https://brt.hawkesgen.com/assets/index-a1b2c3d4.js?v=17:120:33)\n    at loop (https://brt.hawkesgen.com/assets/index-a1b2c3d4.js:9:1)");
  const b = br.errorSignature("Uncaught TypeError: Cannot read properties of undefined (reading 'hp')", "TypeError: x\n    at Fighter.hit (https://brt.hawkesgen.com/c/c_0123abcd/assets/index-ffee9988.js:121:7)");
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
  assert.ok(!br.isNoise('TypeError: a is null', 'at f (https://brt.hawkesgen.com/assets/game.js:1:2)'));
});

test('an error the page catches becomes one source-auto finding; again only counts', async () => {
  const err = (over: any = {}) => ({ error: { kind: 'error', message: 'TypeError: boss is undefined', stack: 'TypeError: boss is undefined\n    at Arena.tick (https://brt.hawkesgen.com/assets/game-9f8e7d6c.js:40:9)', ...over },
    url: 'https://brt.hawkesgen.com/', viewport: { w: 390, h: 844 }, device: { ua: 'Mobile Safari', touch: true, platform: 'iPhone' }, shot: PNG,
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
  const r2: any = await br.fileAutoError('brtest', err({ stack: 'TypeError: boss is undefined\n    at Arena.tick (https://brt.hawkesgen.com/assets/game-0a1b2c3d.js:41:2)' , }), '10.0.0.2');
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
    const url = 'http://127.0.0.1:8797/dev/__studio/error';
    const post = (body: any, ip: string, headers: any = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `${ip}, 10.9.9.9`, ...headers }, body: JSON.stringify(body) });
    const body = { error: { kind: 'rejection', message: 'Error: save failed 503', stack: 'Error: save failed\n    at save (https://brt.hawkesgen.com/assets/save.js:3:3)' }, url: 'https://brt.hawkesgen.com/' };
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
