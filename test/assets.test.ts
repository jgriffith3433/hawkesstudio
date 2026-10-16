// Asset manifests end to end, with free local tools only. Needs Hawkes Gen running (skipped otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.STUDIO_PRODUCTS = path.join(here, 'fixture', 'products.json');
const dir = path.join(here, 'fixture', 'selftest');
const { assetStatus, makeAsset } = await import('../src/assets.ts');
const { genUp } = await import('../src/gen.ts');

test('asset manifest: missing -> made -> current -> edited -> changed', { skip: !(await genUp()) && 'Hawkes Gen is not running' }, async () => {
  fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'hawkes.assets.lock.json'), { force: true });
  assert.equal(assetStatus('selftest').assets[0].status, 'missing');

  const r: any = await makeAsset('selftest', 'sign-material');
  assert.deepEqual(r.files.sort(), ['out/sign_albedo.png', 'out/sign_normal.png']);
  assert.ok(fs.statSync(path.join(dir, 'out', 'sign_normal.png')).size > 1000);
  assert.equal(assetStatus('selftest').assets[0].status, 'current');

  // A hand edit is kept.
  fs.appendFileSync(path.join(dir, 'out', 'sign_albedo.png'), Buffer.from([0]));
  assert.equal(assetStatus('selftest').assets[0].status, 'edited');
  assert.equal(((await makeAsset('selftest', 'sign-material')) as any).skipped, 'edited by hand');

  // A recipe change reads as changed.
  const mf = path.join(dir, 'hawkes.assets.json');
  const orig = fs.readFileSync(mf, 'utf8');
  try {
    const m = JSON.parse(orig);
    m.assets[0].steps[1].params = { strength: 2 };
    fs.writeFileSync(mf, JSON.stringify(m));
    assert.equal(assetStatus('selftest').assets[0].status, 'changed');
  } finally {
    fs.writeFileSync(mf, orig);
  }
  fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'hawkes.assets.lock.json'), { force: true });
});
