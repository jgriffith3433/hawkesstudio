// The Build / Build again buttons (J, 2026-11-03: Gen refused "github.refresh" in 0 s, shown as "Cause unclear"; the
// button state reverted; the Inbox card vanished and came straight back). Pinned here: the exact request Gen takes, the
// refusal named as the cause, the going state, and the Inbox card answered by the rebuild and not filed again for the
// same failure. No Gen, no GitHub: stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildbtn-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: true, server: 'http://notify.test', topic: 'hawkes-test' }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'bbgame', name: 'Button Game', framing: 'test', engine: 'web', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/', github: 'acme/bbgame',
  local: { serve: 'static', dir: 'site', port: 8798, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  builds: [{ id: 'web', tool: 'unity', target: 'web', path: 'Game', method: 'Deploy.Run' }],
}] }));
const pushes: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).startsWith('http://notify.test')) { pushes.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
  return realFetch(url, init);
}) as any;

const { db } = await import('../src/db.ts');
const B = await import('../src/builds.ts');
const F = await import('../src/buildfail.ts');
const ib = await import('../src/inbox.ts');
const { getProduct } = await import('../src/config.ts');

const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
let n = 0;
const row = (o: Record<string, unknown> = {}) => {
  const r = { id: `b_${(++n + 0x500).toString(16).padStart(12, '0')}`, product: 'bbgame', build: 'web', version: n, status: 'building', sha: SHA, ref: 'beta', runner: 'gen', target: 'web', started: Date.now() - 60_000 + n, ...o };
  db.prepare(`INSERT INTO builds (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as any[]);
  return r.id as string;
};
const REFUSED = 'the Unity build failed: customer builds take github { repo, commit, token, ref? } (not refresh): the output comes back as an asset, nothing is pushed';

test('the build request is exactly what Gen takes: github { repo, commit, token, ref }, nothing else', () => {
  const b = getProduct('bbgame').builds![0];
  const params = B.genBuildParams(b, 'acme/bbgame', SHA, 'beta', 'ghs_abc', 'b_1') as any;
  assert.deepEqual(Object.keys(params.github).sort(), ['commit', 'ref', 'repo', 'token']);
  assert.deepEqual(params.github, { repo: 'acme/bbgame', commit: SHA, token: 'ghs_abc', ref: 'beta' });
  assert.equal(params.out, 'artifact');
  assert.equal(params.target, 'web');
  assert.equal(params.path, 'Game');
  assert.equal(params.method, 'Deploy.Run');
  assert.ok(!('refresh' in params.github), 'github.refresh is what Gen refused');
  // Even with the row's key at hand, the refresh object does not ride unless it is switched on.
  process.env.STUDIO_BUILD_KEY = 'k';
  assert.ok(!('refresh' in (B.githubFor('a/b', 'c', 't', 'beta', 'b_1') as any)));
  // Switched on by hand, the helper can still carry it for a Gen that takes it.
  const on = B.githubFor('a/b', SHA, 't', 'beta', 'b_1', true) as any;
  assert.ok(on.refresh);
});

test("Gen's rejection is the cause, in its own words, not 'Cause unclear'", () => {
  const c = F.classify(REFUSED, { stage: 'build' });
  assert.equal(c.class, 'rejected');
  assert.notEqual(c.kind, 'unknown');
  assert.match(c.plain, /Hawkes Gen refused the build request: customer builds take github \{ repo, commit, token, ref\? \} \(not refresh\)/);
  assert.doesNotMatch(c.plain, /Not recognised/);
  assert.equal(F.genRefusal('github.commit must be the full commit sha, 40 hex characters'), 'github.commit must be the full commit sha, 40 hex characters');
  assert.equal(F.genRefusal('path isn\'t for customer builds (github with a token, out "artifact")') !== null, true);
  assert.equal(F.genRefusal('the Unity build failed: error CS0246'), null);
  // A compile error that happens to mention a github key is still the project's.
  assert.equal(F.classify('boom', { log: 'Foo.cs(1,1): error CS0103' }).class, 'compile');
});

test('a build that was just pressed is "starting", then "building", never a stale red badge', () => {
  const failed = row({ status: 'failed', finished: Date.now() - 5000 });
  F.recordFailure(failed, REFUSED, { stage: 'build' });
  assert.equal(F.failingBuilds('bbgame').length, 1);
  assert.equal(F.buildsRunning('bbgame').length, 0);
  // The run exists, the build's row doesn't yet.
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run('r_btn1', 'build', 'running', 'build bbgame', JSON.stringify(['bbgame']), JSON.stringify({ builds: ['web'] }), Date.now());
  assert.deepEqual(F.buildsRunning('bbgame').map((x) => [x.build, x.state]), [['web', 'starting']]);
  assert.equal(F.failingBuilds('bbgame').length, 0, 'the old failure is not shown while the new build starts');
  row({ run: 'r_btn1' });
  assert.deepEqual(F.buildsRunning('bbgame').map((x) => [x.build, x.state]), [['web', 'building']]);
  // It ends: failed again, the badge is back with the Gen message as the cause.
  const last = db.prepare("SELECT id FROM builds WHERE run = 'r_btn1'").get() as any;
  F.recordFailure(last.id, REFUSED, { stage: 'build' });
  db.prepare("UPDATE runs SET status = 'failed' WHERE id = 'r_btn1'").run();
  assert.equal(F.buildsRunning('bbgame').length, 0);
  const f = F.failingBuilds('bbgame')[0];
  assert.equal(f.class, 'rejected');
  assert.match(f.plain, /customer builds take github/);
});

test('Build again answers the card, and the same failure is not filed again; a new reason is', async () => {
  pushes.length = 0;
  db.prepare("DELETE FROM builds").run();
  db.prepare('DELETE FROM inbox_acks').run();
  const first = row({ status: 'failed', finished: Date.now() - 20_000 });
  F.recordFailure(first, REFUSED, { stage: 'build' });
  await F.announce(first);
  assert.equal(pushes.length, 1);
  const card = () => ib.inbox().then((l) => l.filter((x) => x.kind === 'build'));
  assert.equal((await card()).length, 1);

  // Build is pressed from Go live: the card is resolved at once, before the new build has a row.
  await ib.resolveBuildCards('bbgame', ['web'], 'J');
  assert.equal((await card()).length, 0, 'the card goes when the rebuild starts');

  // The rebuild fails the same way: no card, no second push.
  const second = row({ status: 'failed', finished: Date.now() });
  F.recordFailure(second, REFUSED.replace('(not refresh)', '(not  refresh)'), { stage: 'build' });
  await F.announce(second);
  assert.equal((await card()).length, 0, 'same failure: not re-filed');
  assert.equal(pushes.length, 1, 'same failure: not told twice');

  // A different reason is a new card and a new push.
  const third = row({ status: 'failed', finished: Date.now() });
  F.recordFailure(third, 'the Unity build failed: error CS0246: type not found', { stage: 'build' });
  await F.announce(third);
  const now = await card();
  assert.equal(now.length, 1);
  assert.equal(now[0].id, `build:${third}`);
  assert.equal(pushes.length, 2);
});

test('building hides the same id\'s failure only; a different id keeps its failure; done shows after success', () => {
  db.prepare('DELETE FROM builds').run();
  db.prepare("DELETE FROM runs").run();
  const webFail = row({ status: 'failed', finished: Date.now() - 5000 });
  F.recordFailure(webFail, REFUSED, { stage: 'build' });
  // A running build of an id the project doesn't have must not hide web's failure.
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run('r_btn2', 'build', 'running', 'build bbgame', JSON.stringify(['bbgame']), JSON.stringify({ builds: ['other'] }), Date.now());
  assert.equal(F.failingBuilds('bbgame').length, 1, 'a running build of another id leaves this failure');
  db.prepare("UPDATE runs SET options = ? WHERE id = 'r_btn2'").run(JSON.stringify({ builds: ['web'] }));
  assert.equal(F.failingBuilds('bbgame').length, 0, 'the same id running hides its failure');
  assert.equal(F.buildsDone('bbgame').length, 0);
  // It succeeds: no failure, a Done entry.
  const ok = row({ status: 'ready', finished: Date.now() });
  db.prepare("UPDATE runs SET status = 'done' WHERE id = 'r_btn2'").run();
  assert.equal(F.failingBuilds('bbgame').length, 0);
  assert.deepEqual(F.buildsDone('bbgame').map((d) => d.id), [ok]);
});

test('the dashboard button states: Starting, disabled while running, Retry build, Done card', async () => {
  const src = fs.readFileSync(new URL('../dashboard/buildfail.js', import.meta.url), 'utf8');
  assert.match(src, /Starting…/);
  assert.match(src, /Retry build/);
  assert.match(src, /const done = /);
  assert.match(src, /role="status"/);
  const app = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /data-build-now\$\{r\.running\?\.length \? ' disabled'/);
});
