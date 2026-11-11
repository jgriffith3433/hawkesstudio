// Imagine Live TV (2026-11-09): "played beta d269309" while the page was from before #121. The page a beta playtest
// opens carries the commit it was published from; a run whose commit differs says so instead of judging.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const page = (sha: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/dev/__studio/report.js" data-hawkes='${JSON.stringify({ product: 'imaginelivetv', sha, ref: 'beta' })}' defer></script></body></html>`;

test('the commit a published page says it was built from', async () => {
  const { servedSha } = await import('../src/servedpage.ts');
  assert.equal(servedSha(page('0cac1b7')), '0cac1b7');
  assert.equal(servedSha('<html><body>no widget</body></html>'), null);
  assert.equal(servedSha(`<script data-hawkes='{"sha":"zz"}'></script>`), null);
});

test("the page Studio injects today says its commit (the loader since #369), so a stale page is caught, not judged", async () => {
  // The suite was red for days: the injector moved to a loader script, the reader still looked for the old attribute,
  // and every served page read as "unknown", so the check never fired.
  const { servedSha, servedMismatch, pageInfoOf } = await import('../src/servedpage.ts');
  const { injectReport } = await import('../src/bugreport.ts');
  const html = injectReport('<!doctype html><html><head><meta charset="utf-8"></head><body>game</body></html>', { product: 'p', sha: '0cac1b7', ref: 'beta', root: "/o/a'b<c" });
  assert.equal(servedSha(html), '0cac1b7');
  assert.equal(pageInfoOf(html)!.root, "/o/a'b<c", 'quotes and < round-trip');
  assert.match(servedMismatch(html, { sha: 'd269309' }, 'https://x/')!, /published from 0cac1b7/);
  assert.equal(servedSha(injectReport('<html><body>x</body></html>', { product: 'p' })), null);
});

test('a page published from another commit than the run reports is not judged', async () => {
  const { servedMismatch, sameCommit } = await import('../src/servedpage.ts');
  const played = { branch: 'beta', sha: 'd2693091234567890abcdef1234567890abcdef1' };
  assert.ok(sameCommit('d269309', played.sha));
  assert.equal(servedMismatch(page('d269309'), played, 'https://x/'), null);
  const why = servedMismatch(page('0cac1b7'), played, 'https://x/');
  assert.match(why!, /published from 0cac1b7/);
  assert.match(why!, /d269309/);
  // Unknown is not a failure: a local server's page, or no commit to compare.
  assert.equal(servedMismatch('<html></html>', played, 'https://x/'), null);
  assert.equal(servedMismatch(page('0cac1b7'), null, 'https://x/'), null);
});

test('checkServedPage reads the page once and never fails on one it cannot read', async () => {
  const { checkServedPage } = await import('../src/servedpage.ts');
  const played = { branch: 'beta', sha: 'd269309' };
  const ok = (body: string, type = 'text/html') => (async () => new Response(body, { headers: { 'content-type': type } })) as typeof fetch;
  assert.match((await checkServedPage('https://x/', played, ok(page('0cac1b7'))))!, /0cac1b7/);
  assert.equal(await checkServedPage('https://x/', played, ok(page('d269309'))), null);
  assert.equal(await checkServedPage('https://x/', played, ok(page('0cac1b7'), 'application/json')), null);
  assert.equal(await checkServedPage('https://x/', played, (async () => { throw new Error('down'); }) as typeof fetch), null);
});

// PH Origins (2026-11-11): the published beta site stayed at #165 while beta had moved to #170; two runs judged it.
test('a published site behind beta is published again and played; still behind, the verdict is stale', async () => {
  const { ensurePublishedCurrent } = await import('../src/servedpage.ts');
  const tip = '3544fa3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  // Current: nothing to do.
  let calls = 0;
  assert.deepEqual(await ensurePublishedCurrent({ tip, published: () => '3544fa3', republish: async () => { calls++; } }), { ok: true, republished: false });
  assert.equal(calls, 0);
  // Unknown is never a failure.
  assert.equal((await ensurePublishedCurrent({ tip: null, published: () => 'a6c1dff', republish: async () => { calls++; } })).ok, true);
  assert.equal((await ensurePublishedCurrent({ tip, published: () => null, republish: async () => { calls++; } })).ok, true);
  assert.equal(calls, 0);
  // Behind, and republishing catches up.
  let pub = 'a6c1dff';
  const r = await ensurePublishedCurrent({ tip, published: () => pub, republish: async () => { calls++; pub = '3544fa3'; } });
  assert.equal(r.ok && r.republished, true);
  assert.equal(calls, 1);
  // Behind, and still behind (or the republish throws): stale, with the sentence that says so.
  const s = await ensurePublishedCurrent({ tip, published: () => 'a6c1dff', republish: async () => { throw new Error('build failed'); } });
  assert.equal(s.ok, false);
  if (!s.ok) { assert.match(s.why, /Stale verdict/); assert.match(s.why, /a6c1dff/); assert.match(s.why, /3544fa3/); assert.equal(s.published, 'a6c1dff'); }
});

test('the check waits for the republish: caught up within the wait, or stale after the timeout', async () => {
  const { ensurePublishedCurrent, publishWaitMs } = await import('../src/servedpage.ts');
  const tip = '3544fa3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  // The republish finishes later than the call that started it: the check waits for it and reads the site again.
  let pub = 'a6c1dff';
  const r = await ensurePublishedCurrent({ tip, published: () => pub, timeoutMs: 5000, republish: () => new Promise((res) => setTimeout(() => { pub = '3544fa3'; res(null); }, 30)) });
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.republished, true); assert.equal(r.waited?.before, 'a6c1dff'); assert.equal(r.waited?.after, '3544fa3'); assert.equal(typeof r.waited?.seconds, 'number'); }
  // A republish that outlasts the timeout is stale, with no wait beyond the timeout.
  const t0 = Date.now();
  const s = await ensurePublishedCurrent({ tip, published: () => 'a6c1dff', timeoutMs: 40, republish: () => new Promise(() => {}) });
  assert.equal(s.ok, false);
  if (!s.ok) { assert.match(s.why, /Stale verdict/); assert.equal(s.waited?.timedOut, true); }
  assert.ok(Date.now() - t0 < 2000);
  // Sized to the last publish: 2 to 10 minutes.
  assert.equal(publishWaitMs(null), 120_000);
  assert.equal(publishWaitMs(100_000), 300_000);
  assert.equal(publishWaitMs(900_000), 600_000);
});

test('buildsSettled resolves with no build running', async () => {
  const { buildsSettled } = await import('../src/builds.ts');
  await buildsSettled('nothing');
});

test('a build of an older commit leaves beta\'s newest to be built', async () => {
  process.env.STUDIO_DATA = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'studio-catchup-'));
  const { needsCatchUp } = await import('../src/builds.ts');
  const base = { change: null, movesBeta: false, newer: false, head: '3544fa3', sha: 'a6c1dff', ref: 'beta', tool: 'npm' };
  assert.equal(needsCatchUp(base), true);
  assert.equal(needsCatchUp({ ...base, movesBeta: true }), false);
  assert.equal(needsCatchUp({ ...base, head: 'a6c1dff' }), false);
  assert.equal(needsCatchUp({ ...base, head: null }), false);
  assert.equal(needsCatchUp({ ...base, change: 'c_1' }), false);
  assert.equal(needsCatchUp({ ...base, ref: 'build-x' }), false);
  assert.equal(needsCatchUp({ ...base, tool: 'unity' }), false);
  assert.equal(needsCatchUp({ ...base, newer: true }), false);
});
