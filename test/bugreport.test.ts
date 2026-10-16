// J's "report a bug" button on the beta sites: the page injection, a report becoming a source-J finding linked to the
// milestone he is testing, the screenshot kept, Talk told, and the PM loop's order. Scratch database; Gen is pointed at
// a closed port (the library import fails and the local copy is used), and no agent or Claude runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bugreport-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ previews: { brt: 'brtest' }, products: [{
  id: 'brtest', name: 'Report test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
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

test('a report becomes a top-priority finding for the milestone being tested', async () => {
  const it = rm.addItem({ product: 'brtest', title: 'Controls', criteria: ['jump works'], status: 'planned' });
  const ms = rm.addMilestone({ product: 'brtest', title: 'Controls done', items: [it.id] });
  // Not ready to test yet (nothing on beta): the roadmap.
  assert.equal(br.testing('brtest'), null);
  db.prepare(`UPDATE items SET status = 'on beta' WHERE id = ?`).run(it.id);
  rm.markReached(ms.id);
  assert.deepEqual(br.testing('brtest'), { milestone: ms.id, title: 'Controls done', origin: null, item: it.id });

  const r = await br.fileReport('brtest', {
    text: 'Jump does nothing on the second level. It worked on the first.', url: 'https://brt.hawkesgen.com/Game/', shot: PNG,
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
