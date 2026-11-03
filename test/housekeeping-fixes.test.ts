// 2026-11-03 "make Studio run with little oversight": studio_changes pages, the __studio/build noise, the GPU breaker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-housekeeping-'));
const { slimChange, pageParams, CHANGES_DEFAULT_LIMIT, CHANGES_MAX_LIMIT } = await import('../src/changes-slim.ts');
const { absorb, isToolingNoise, listFindings } = await import('../src/backlog.ts');
const B = await import('../src/gpu-breaker.ts');
const { isRepoPage } = await import('../src/pipeline.ts');
const { saveProduct, getProduct } = await import('../src/config.ts');

test('studio_changes: default 20, capped at 100, offsets never negative', () => {
  assert.deepEqual(pageParams(), { limit: CHANGES_DEFAULT_LIMIT, offset: 0 });
  assert.deepEqual(pageParams(5000, -3), { limit: CHANGES_MAX_LIMIT, offset: 0 });
  assert.deepEqual(pageParams('7', '14'), { limit: 7, offset: 14 });
});

test('studio_changes: a change is trimmed to a small summary', () => {
  const big = 'x'.repeat(50_000);
  const c = slimChange({ id: 'c_1', product: 'p', status: 'ready', request: big, summary: big, detail: big, log: Array(500).fill(big), notes: [1, 2, 3], verify: { verdict: 'pass', blob: big }, findings: Array(20).fill('f'), commits: ['a'], criteria: [big], links: { change: 'https://s/c_1' }, worktree: '/w' });
  const text = JSON.stringify(c);
  assert.ok(text.length < 3000, `slim change is ${text.length} characters`);
  assert.equal(c.notes, 3);
  assert.equal(c.verdict, 'pass');
  assert.equal(c.findings.length, 5);
  assert.equal(c.link, 'https://s/c_1');
  assert.equal('log' in c, false);
});

test('a console 404 on the widget\'s __studio/build is tooling noise, never a finding', () => {
  assert.equal(isToolingNoise({ title: 'Console error: 404 on /dev/__studio/build' }), true);
  assert.equal(isToolingNoise({ title: 'Console error', detail: 'Failed to load resource: the server responded with a status of 404 (https://x/dev/__studio/build)' }), true);
  assert.equal(isToolingNoise({ title: 'Boss never spawns', detail: 'see /dev/__studio/build' }), false);
  const r = absorb('noise', 'r_1', 'smoke@local', [{ severity: 'bug', title: 'Resource 404 at /dev/__studio/build' }, { severity: 'bug', title: 'Jump is broken' }]);
  assert.equal(r.added.length, 1);
  assert.equal(listFindings({ product: 'noise' }).length, 1);
});

test('GPU breaker: a provider that failed is skipped for a while, then tried again; told once', () => {
  B.reset();
  assert.equal(B.providerOf('RunPod out of credit'), 'runpod');
  assert.equal(B.providerOf('Modal timed out after 300s'), 'modal');
  assert.equal(B.providerOf('no GPU server was free'), null);
  assert.equal(B.trip('no GPU server was free'), null);
  const t0 = 1_000_000;
  assert.deepEqual(B.trip('RunPod out of credit', t0), { provider: 'runpod', fresh: true });
  assert.deepEqual(B.trip('RunPod out of credit', t0 + 1000), { provider: 'runpod', fresh: false });
  assert.deepEqual(B.down(t0 + 2000), ['runpod']);
  assert.deepEqual(B.reorder(['runpod', 'modal'], t0 + 2000), ['modal', 'runpod']);
  assert.deepEqual(B.down(t0 + B.OPEN_MS() + 5000), []);
  assert.equal(B.trip('RunPod out of credit', t0 + B.OPEN_MS() + 5000)!.fresh, true);
  B.reset();
});

test('a software playtest is reviewed when the game is not GPU-bound', () => {
  assert.equal(B.reviewableInSoftware({ engine: 'web' }, { fps: { average: 30 } }), true);
  assert.equal(B.reviewableInSoftware({ engine: 'web' }, { fps: { average: 4 } }), false);
  assert.equal(B.reviewableInSoftware({ engine: 'unity' }, { fps: { average: 40 } }), false);
  assert.equal(B.reviewableInSoftware({ engine: 'unity', gpuBound: false }, { fps: { average: 2 } }), true);
  assert.equal(B.reviewableInSoftware({ engine: 'web', gpuBound: true }, { fps: { average: 60 } }), false);
});

test('a library with a beta demo and only a repo page plays the demo', () => {
  assert.equal(isRepoPage('https://github.com/jgriffith3433/hawkes-analytics'), true);
  assert.equal(isRepoPage(undefined), true);
  assert.equal(isRepoPage('https://hawkesgen.ai/'), false);
  const lib = saveProduct({ id: 'libdemo', name: 'Lib Demo', engine: 'web', live: 'https://github.com/o/lib', beta: 'https://lib-demo.example.com/' } as any);
  assert.equal(lib.playtests[0].where, 'local');
  assert.equal(getProduct('libdemo').playtests[0].where, 'local');
  const site = saveProduct({ id: 'sitedemo', name: 'Site Demo', engine: 'web', live: 'https://real.example.com/', beta: 'https://beta.example.com/' } as any);
  assert.equal(site.playtests[0].where, 'live');
});
