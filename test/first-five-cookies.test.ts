// A gated beta site's first five minutes (J, 2026-11-11, run r_c15560345642): the pass cookie rides every first-five path
// (desktop, phone, persona), and a result that sits on the sign-in card is failed before numbers, persona findings or review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ff-cookies-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const src = fs.readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8');
const start = src.indexOf('async function playScenario(');
const body = src.slice(start);

test('the pass cookie is added after the persona params and kept for first-five, desktop and phone', () => {
  const persona = body.indexOf('Object.assign(params, personaParams())');
  const cookies = body.indexOf('...(cookies ? { cookies } : {})');
  assert.ok(persona > 0 && cookies > persona, 'cookies are assigned after the persona params, so nothing replaces them');
  assert.match(body, /firstFiveParams\(url, isPhone\(t\) \? 'phone' : 'desktop'\)/);
  assert.doesNotMatch(body.slice(persona, cookies), /delete params\.cookies|params\.cookies = undefined/);
});

test('with a pass available, a first-five play of a beta site carries the cookies param', async () => {
  const K = await import('../src/sitekeys.ts');
  const { playtestExtras } = await import('../src/playtests.ts');
  const saved = process.env.STUDIO_SITES_SEED;
  process.env.STUDIO_SITES_SEED = 'test-seed-for-first-five';
  try {
    for (const device of ['desktop', 'phone'] as const) {
      const x: any = playtestExtras('place-department-unity', `first-five@local${device === 'phone' ? ':phone' : ''}`, { scenario: 'first-five', where: 'local', ...(device === 'phone' ? { device } : {}) } as any);
      assert.ok(x.cookies?.length, `${device}: the extras carry the pass`);
      assert.equal(x.cookies[0].name, K.playtestCookies()[0].name);
    }
  } finally { if (saved === undefined) delete process.env.STUDIO_SITES_SEED; else process.env.STUDIO_SITES_SEED = saved; }
});

test('the auth-wall check runs on any result, before the first-five numbers, persona findings and the review', () => {
  const wall = body.indexOf('authWallOf(job.result)');
  assert.ok(wall > 0);
  assert.doesNotMatch(body.slice(wall - 40, wall), /job\.status === 'done'/);
  assert.ok(wall < body.indexOf('enrichFtue(job.result'), 'before enrichFtue');
  assert.ok(wall < body.indexOf('filePersonaFindings(p.id'), 'before persona findings');
});
