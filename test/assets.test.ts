// Asset manifests end to end, with free local tools only. Needs Hawkes Gen running and letting this process in
// (skipped otherwise: the agent sandbox and Studio's checks of a change reach Gen but have no Gen API key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.STUDIO_PRODUCTS = path.join(here, 'fixture', 'products.json');
// The fixture's paths start with hawkesstudio/: point them at this checkout wherever it lives (an agent's worktree is
// .work/<change>), through a link in a scratch projects folder.
const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-assets-'));
fs.symlinkSync(path.resolve(here, '..'), path.join(projects, 'hawkesstudio'), 'junction');
process.env.STUDIO_PROJECTS = projects;
const dir = path.join(here, 'fixture', 'selftest');
const { assetStatus, makeAsset } = await import('../src/assets.ts');
const { gen, genUp } = await import('../src/gen.ts');

/** Why the test can't run here, or false: Gen down, or Gen up but refusing us (no key, or not this PC's open access). */
async function skipWhy(): Promise<string | false> {
  if (!(await genUp())) return 'Hawkes Gen is not running';
  try {
    await gen.tools();
    return false;
  } catch (e: any) {
    if (e.status === 401 || e.status === 403) return 'no Hawkes Gen API key';
    throw e;
  }
}

test('asset manifest: missing -> made -> current -> edited -> changed', { skip: await skipWhy() }, async () => {
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
