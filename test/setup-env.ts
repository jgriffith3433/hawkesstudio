// Loaded before every test (package.json "test": --import). J's Studio runs no products of its own since 2026-11-02
// (products.json is empty: they moved to his customer Studio), so the tests that read J's products get the list they
// had from test/fixture/j-products.json. A test that sets STUDIO_PRODUCTS, or runs as a customer's Studio, still wins.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STUDIO_J_PRODUCTS ||= path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture', 'j-products.json');
// The memory gate (src/memgate.ts) reads the test machine's free memory; tests that count starts or checkouts would
// depend on it. test/memgate.test.ts turns it back on with a memory source of its own.
process.env.STUDIO_MEM_GATE ||= 'off';
// The PM's starts-today memo (pm.ts) is off for tests that write pm_log and changes directly; test/pm-memo.test.ts turns it on.
process.env.STUDIO_PM_MEMO ||= 'off';
