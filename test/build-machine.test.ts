// A Unity build's machine size learned from Hawkes Gen in J's Studio (config.ts setBuildMachine): a game added here keeps
// it in its own builds (games.json), a products.json project as an override in Studio's data that loadProducts applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-machine-'));
const products = path.join(TMP, 'products.json');
fs.writeFileSync(products, JSON.stringify({ products: [
  { id: 'jgame', name: 'J game', engine: 'unity', repo: 'jgriffith3433/jgame', builds: [{ id: 'web', tool: 'unity' }, { id: 'other', tool: 'unity' }], playtests: [], story: [] },
] }));
for (const k of ['STUDIO_ORG', 'K_SERVICE', 'STUDIO_CUSTOMER']) delete process.env[k];
Object.assign(process.env, { STUDIO_DATA: path.join(TMP, 'data'), STUDIO_PRODUCTS: products, STUDIO_GAMES: path.join(TMP, 'data', 'games.json'), STUDIO_BUILD_OVERRIDES: path.join(TMP, 'data', 'build-overrides.json') });
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
const C = await import('../src/config.ts');
const B = await import('../src/builds.ts');

test("products.json's build: the size Gen had to use is an override in Studio's data, products.json untouched", () => {
  const before = fs.readFileSync(products, 'utf8');
  const note = B.learnMachine('jgame', { id: 'web', tool: 'unity' }, { ok: true, unity: '6000.3.7f1', machine: { name: 'l', cpu: 6, memoryGiB: 24 }, retried: { reason: 'out of memory', from: 'm', to: 'l' } });
  assert.equal(note, "ran on l after m ran out of memory; saved l as this build's size");
  assert.equal(fs.readFileSync(products, 'utf8'), before);
  const p = C.loadProducts().find((x) => x.id === 'jgame')!;
  assert.equal(p.builds![0].machine, 'l');
  assert.equal(p.builds![1].machine, undefined, 'only that build');
  // A size Gen made up from numbers is kept as numbers.
  C.setBuildMachine('jgame', 'other', { cpu: 4, memoryGiB: 12 });
  assert.deepEqual(C.loadProducts().find((x) => x.id === 'jgame')!.builds![1].machine, { cpu: 4, memoryGiB: 12 });
});

test('a game added here: saved into its own builds; an unknown build changes nothing', () => {
  C.saveProduct({ id: 'added', name: 'Added', engine: 'unity', repo: 'acme/added', builds: [{ id: 'web', tool: 'unity', machine: 's' }] } as any);
  assert.equal(C.setBuildMachine('added', 'web', 'm'), 'project');
  assert.equal(C.addedGames().find((x) => x.id === 'added')!.builds![0].machine, 'm');
  assert.equal(C.setBuildMachine('added', 'nope', 'm'), 'none');
  assert.equal(C.setBuildMachine('jgame', 'nope', 'm'), 'none');
  assert.throws(() => C.setBuildMachine('added', 'web', { cpu: 8, memoryGiB: 64 }), /8 vCPU takes 4 to 32 GiB/);
});
