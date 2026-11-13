// One file's PUT to the beta sites store tries again on a transient answer (sitestore.ts workerStore), and a failure that
// stays is Studio's own (buildfail.ts), never an agent's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-retry-'));
process.env.STUDIO_MAIL = 'off';
const S = await import('../src/sitestore.ts');
const { classify } = await import('../src/buildfail.ts');

const store = (answers: Array<[number, string]>, calls: string[]) => S.workerStore('https://sites.example', {
  lane: 'beta', waits: [0, 0, 0], sign: () => 'sig',
  fetcher: (async (u: any) => {
    calls.push(String(u));
    const [status, body] = answers[Math.min(calls.length - 1, answers.length - 1)];
    return new Response(body, { status });
  }) as typeof fetch,
});
const KEY = 'o/x/b/web/154/PlaceDepartment/StreamingAssets/Music/ch3_score.mp3';

test('a 400 "internal error, try again" (10001) once, then ok: the file is put', async () => {
  const calls: string[] = [];
  await store([[400, '{"error":"put: We encountered an internal error. Please try again. (10001)"}'], [200, 'ok']], calls).put(KEY, Buffer.from('x'), 'audio/mpeg');
  assert.equal(calls.length, 2);
});

test('503 on every try: fails naming the file, the status and the tries, as infrastructure', async () => {
  const calls: string[] = [];
  const err: any = await store([[503, 'down']], calls).put(KEY, Buffer.from('x'), 'audio/mpeg').then(() => null, (e) => e);
  assert.equal(calls.length, 4);
  assert.match(err.message, /ch3_score\.mp3/);
  assert.match(err.message, /503/);
  assert.match(err.message, /4 tries/);
  assert.equal(classify(err.message).kind, 'infrastructure');
});

test('403 and other 400s fail at once with no retry', async () => {
  for (const [status, body] of [[403, 'forbidden'], [400, 'bad key'], [401, 'no'], [413, 'big']] as Array<[number, string]>) {
    const calls: string[] = [];
    await assert.rejects(store([[status, body]], calls).put(KEY, Buffer.from('x'), 'audio/mpeg'), new RegExp(String(status)));
    assert.equal(calls.length, 1, `${status}: one try`);
  }
});
