// The list of beta sites covers every project and every agent change, on the thread that answers the browser. Asking
// for the projects per change held a customer's one CPU full and Cloud Run stopped sending it requests (2026-11-06).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-preview-cost-'));
process.env.STUDIO_DATA = dir;
process.env.STUDIO_ORG = 'acme-1a2b';
process.env.STUDIO_CONTROL_URL = 'http://127.0.0.1:9';
process.env.STUDIO_CUSTOMER = '1';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_SITES_SEED = 'test seed';
process.env.STUDIO_PRODUCTS = path.join(dir, 'products.json');

const project = (n: number) => ({ id: `game-${n}`, name: `Game ${n}`, engine: 'web', repo: `acme/game-${n}`, live: `https://game-${n}.example/` });
const write = (n: number) => fs.writeFileSync(process.env.STUDIO_PRODUCTS!, JSON.stringify({ products: Array.from({ length: n }, (_, i) => project(i)) }));
write(30);
const changes = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`c_${i}`, { status: 'ready', at: 1 }]));
fs.writeFileSync(path.join(dir, 'previews.json'), JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`game-${i}`, { changes }]))));

const { listPreviews } = await import('../src/previews.ts');
const { loadProducts } = await import('../src/config.ts');

const productReads = (f: () => void) => {
  const read = fs.readFileSync;
  let n = 0;
  (fs as any).readFileSync = (file: any, ...rest: any[]) => { if (String(file) === process.env.STUDIO_PRODUCTS) n++; return (read as any)(file, ...rest); };
  try { f(); } finally { (fs as any).readFileSync = read; }
  return n;
};

test('a customer with many projects and changes: the projects file is read a few times, not per change', () => {
  let list: any[] = [];
  const reads = productReads(() => { list = listPreviews(); });
  assert.equal(list.length, 30);
  assert.equal(list[0].changes.length, 400);
  assert.equal(list[0].changes[7].url, `https://sites.hawkesgen.ai/o/acme-1a2b/game-0/c/c_7/`);
  assert.ok(reads <= 3, `read ${reads} times`);
});

test('a project added later shows at once', () => {
  assert.equal(loadProducts().length, 30);
  write(31);
  assert.equal(loadProducts().length, 31);
  assert.equal(listPreviews().length, 31);
});

test("a caller changing what it was given doesn't change the next caller's project", () => {
  (loadProducts()[0] as any).name = 'Changed';
  assert.equal(loadProducts()[0].name, 'Game 0');
});
