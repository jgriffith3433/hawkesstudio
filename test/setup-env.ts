// Loaded before every test (package.json "test": --import). J's Studio runs no products of its own since 2026-11-02
// (products.json is empty: they moved to his customer Studio), so the tests that read J's products get the list they
// had from test/fixture/j-products.json. A test that sets STUDIO_PRODUCTS, or runs as a customer's Studio, still wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Infra targets (Studio, Gen) still live in the real products.json and change there: the fixture takes them from it, so
// a test of an infra setting reads what Studio runs (the fixture's own copy drifted: Gen's checkEnv, 2026-11-11).
if (!process.env.STUDIO_J_PRODUCTS) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixture', 'j-products.json'), 'utf8'));
  fixture.infra = JSON.parse(fs.readFileSync(path.join(here, '..', 'products.json'), 'utf8')).infra ?? [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-j-products-'));
  fs.writeFileSync(path.join(dir, 'j-products.json'), JSON.stringify(fixture, null, 2));
  process.env.STUDIO_J_PRODUCTS = path.join(dir, 'j-products.json');
}
// The memory gate (src/memgate.ts) reads the test machine's free memory; tests that count starts or checkouts would
// depend on it. test/memgate.test.ts turns it back on with a memory source of its own.
process.env.STUDIO_MEM_GATE ||= 'off';
// The PM's starts-today memo (pm.ts) is off for tests that write pm_log and changes directly; test/pm-memo.test.ts turns it on.
process.env.STUDIO_PM_MEMO ||= 'off';
// The in-memory disk guard (src/disksweep.ts) reads the test machine's disk against its memory: a dev box with a few GB
// used refuses every build as "in-memory disk is full". test/disksweep.test.ts turns it on for itself.
process.env.STUDIO_CPU_ROOM ??= 'off'; // cpuroom.ts's own tests turn it on
process.env.STUDIO_DISK_SWEEP ||= 'off';
// Agent job starts are spaced by 10 s in Studio (src/genpace.ts); tests that start jobs don't wait.
process.env.STUDIO_JOB_START_GAP_MS ||= '0';
process.env.STUDIO_GEN_SUBMIT_GAP_MS ||= '0';
