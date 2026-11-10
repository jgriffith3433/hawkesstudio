// A Google read answered 429/5xx is asked again before it fails (2026-11-10: one Cloud Run 503 while a build followed
// its job ended hawkes-games' Firebase deploy). Writes aren't repeated. No Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { setGcpFetch, gapi } = await import('../src/gcp.ts');

test('a GET that gets 503 then 200 succeeds', async () => {
  let n = 0;
  setGcpFetch(async () => (++n < 2 ? new Response('upstream', { status: 503 }) : new Response('{"ok":1}', { status: 200 })), 't');
  assert.deepEqual(await gapi('https://run.googleapis.com/v2/x'), { ok: 1 });
  assert.equal(n, 2);
});

test('a GET that keeps getting 503 fails after three tries', async () => {
  let n = 0;
  setGcpFetch(async () => { n++; return new Response('upstream', { status: 503 }); }, 't');
  await assert.rejects(gapi('https://run.googleapis.com/v2/x'), /answered 503/);
  assert.equal(n, 3);
});

test('a GET whose connection drops is asked again; one that keeps dropping fails', async () => {
  let n = 0;
  setGcpFetch(async () => { if (++n < 2) throw new TypeError('fetch failed'); return new Response('{"ok":1}', { status: 200 }); }, 't');
  assert.deepEqual(await gapi('https://run.googleapis.com/v2/x'), { ok: 1 });
  assert.equal(n, 2);
  n = 0;
  setGcpFetch(async () => { n++; throw new TypeError('fetch failed'); }, 't');
  await assert.rejects(gapi('https://run.googleapis.com/v2/x'), /fetch failed/);
  assert.equal(n, 3);
});

test('a 403 and a POST are not repeated', async () => {
  let n = 0;
  setGcpFetch(async () => { n++; return new Response('no', { status: 403 }); }, 't');
  await assert.rejects(gapi('https://run.googleapis.com/v2/x'), /answered 403/);
  assert.equal(n, 1);
  n = 0;
  setGcpFetch(async () => { n++; return new Response('upstream', { status: 503 }); }, 't');
  await assert.rejects(gapi('https://run.googleapis.com/v2/x', { body: {} }), /answered 503/);
  assert.equal(n, 1);
  setGcpFetch(null);
});
