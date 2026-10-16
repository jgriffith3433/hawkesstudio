// Studio and Gen as agent targets: the guard rails on what a change may touch, and the smoke check (this Studio,
// started on a spare port with a scratch data folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A scratch database: agents.ts requeues interrupted changes when it loads.
process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-infra-'));
const { guardFiles, smokeCheck } = await import('../src/agents.ts');
const { getInfra, isInfra } = await import('../src/config.ts');

test('infra targets are Studio and Gen, not products', () => {
  assert.ok(isInfra('hawkesstudio') && isInfra('hawkesgen'));
  assert.ok(!isInfra('doseofdestruction'));
  assert.equal(getInfra('hawkesgen').smoke.health, '/v1/health');
});

test('guard rails: forbidden files always, guarded ones only when J names them', () => {
  const files = ['src/talk.ts', 'docs/cloud.md', 'deploy/hawkes-pull.mjs', '.github/workflows/ci.yml', '.data/studio.db', 'deploy/.keys/web-password.txt', '.env'];
  const bad = guardFiles('hawkesstudio', files, 'Make Talk friendlier');
  assert.deepEqual(bad.map((b) => `${b.file}:${b.why}`), [
    'deploy/hawkes-pull.mjs:guarded', '.github/workflows/ci.yml:guarded', '.data/studio.db:forbidden', 'deploy/.keys/web-password.txt:forbidden', '.env:forbidden',
  ]);
  // Naming the file (path or name) allows a guarded one, never a forbidden one.
  const named = guardFiles('hawkesstudio', files, 'Change hawkes-pull.mjs to wait 10 minutes, and .github/workflows/ci.yml too. Also .env');
  assert.deepEqual(named.map((b) => b.file), ['.data/studio.db', 'deploy/.keys/web-password.txt', '.env']);
  assert.deepEqual(guardFiles('hawkesgen', ['src/auth.ts', 'src/jobs.ts'], 'faster queue').map((b) => b.file), ['src/auth.ts']);
});

test('smoke check: the service starts on a spare port, health ok, dashboard loads, scripts parse', { timeout: 90_000 }, async () => {
  const r: any = await smokeCheck(root, getInfra('hawkesstudio'));
  assert.ok(r.ok, `${r.detail}\n${r.log ?? ''}`);
  assert.ok(r.port !== 8791);
  assert.ok(r.scripts.some((s: any) => s.file === 'dashboard/app.js'));
});
