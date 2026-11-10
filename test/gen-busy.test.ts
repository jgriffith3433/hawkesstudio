// Studio paces itself when Hawkes Gen is busy (src/genpace.ts; 2026-11-10: Cloud Run had no room for Gen live for 11
// minutes, answered 429 and 503, and Yooba Land's build failed on the first busy answer to its submit). A busy submit is
// sent again after a calm window instead of failing the build, Retry-After is honoured, the window grows while busy
// answers keep coming, and the busy answers show where Studio's health is read. Fake fetch: no Gen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genbusy-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
process.env.HAWKESGEN_URL = 'http://gen.test';
process.env.STUDIO_GEN_CALM_MS = '20';

const P = await import('../src/genpace.ts');
const { retryAfterOf, HawkesGenError } = await import('../src/hawkesgen.mjs' as any);
const G = await import('../src/gen.ts');

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('Retry-After: seconds, an HTTP date, or Gen\'s own retryAfter', () => {
  assert.equal(retryAfterOf(res(429, {}, { 'retry-after': '7' })), 7);
  const at = new Date(Date.now() + 30_000).toUTCString();
  const d = retryAfterOf(res(429, {}, { 'retry-after': at }));
  assert.ok(d >= 28 && d <= 31, String(d));
  assert.equal(retryAfterOf(res(429, {}), { retryAfter: 12 }), 12);
  assert.equal(retryAfterOf(res(500, {}), {}), undefined);
});

test('a busy answer opens a calm window; more in a row double it; Retry-After wins; each error counts once', () => {
  P.resetGenPace();
  const now = 1_000_000;
  const a = new HawkesGenError('busy', { status: 429 });
  assert.equal(P.noteGenBusy(a, '/jobs', now), now + 20);
  assert.equal(P.noteGenBusy(a, '/jobs', now), now + 20, 'the same error again changes nothing');
  assert.equal(P.noteGenBusy(new HawkesGenError('busy', { status: 503 }), '/jobs', now + 10), now + 10 + 40);
  assert.equal(P.noteGenBusy(new HawkesGenError('busy', { status: 429, retryAfter: 90 }), '/jobs', now + 20), now + 20 + 90_000);
  assert.equal(P.noteGenBusy(new HawkesGenError('no', { status: 500 }), '/jobs', now + 30), now + 20 + 90_000, 'a 500 is not busy');
  assert.equal(P.genBusy(now + 40).lastHour, 3);
  P.resetGenPace();
});

test('genRun: a submit answered 429 then 503 is sent again and the build goes on; the busy answers show on the Resources page', async () => {
  P.resetGenPace();
  const real = globalThis.fetch;
  const calls: string[] = [];
  let submits = 0;
  globalThis.fetch = (async (url: any, o: any = {}) => {
    const u = new URL(String(url));
    calls.push(`${o.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/jobs' && o.method === 'POST') {
      submits++;
      if (submits === 1) return res(429, { error: 'Rate limit exceeded' }, { 'retry-after': '0' });
      if (submits === 2) return res(503, { error: 'Service Unavailable' });
      return res(200, { jobs: [{ id: 'j_busy1', status: 'queued' }] });
    }
    if (u.pathname === '/v1/jobs/j_busy1') return res(200, { id: 'j_busy1', status: 'done', outputs: [] });
    return res(404, { error: 'not here' });
  }) as any;
  try {
    const job: any = await G.genRun('unity.build', 'yoobaland', { ref: 'beta' });
    assert.equal(job.status, 'done');
    assert.equal(submits, 3, calls.join(', '));
    const b = P.genBusy();
    assert.equal(b.lastHour, 2);
    const att = P.genBusyAttention(b);
    assert.ok(att && /busy 2 times/.test(att.text), att?.text);
  } finally {
    globalThis.fetch = real;
    P.resetGenPace();
  }
});

test('genRun: a submit Gen keeps answering busy past STUDIO_GEN_BUSY_MS fails with that answer', async () => {
  P.resetGenPace();
  process.env.STUDIO_GEN_BUSY_MS = '60';
  const real = globalThis.fetch;
  globalThis.fetch = (async () => res(429, { error: 'Rate limit exceeded' })) as any;
  try {
    await assert.rejects(G.genRun('unity.build', 'yoobaland', {}), (e: any) => e.status === 429);
  } finally {
    globalThis.fetch = real;
    delete process.env.STUDIO_GEN_BUSY_MS;
    P.resetGenPace();
  }
});

test('nothing busy: no Resources sentence', () => {
  P.resetGenPace();
  assert.equal(P.genBusyAttention(), null);
});
