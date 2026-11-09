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
