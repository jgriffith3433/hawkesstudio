// Studio itself was the process the out-of-memory killer took, ten times in 40 minutes (2026-11-10). Commands it starts
// must be the likelier victims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { installOomGuard, readAdj, CHILD_ADJ, guardStats } from '../src/oomguard.ts';

test('commands Studio starts are likelier out-of-memory victims than Studio', { skip: process.platform !== 'linux' }, async () => {
  const before = readAdj();
  installOomGuard();
  // Lowering may not be allowed here (no privilege): it never goes up.
  assert.ok((readAdj() ?? 0) <= (before ?? 0));
  const c = spawn('sleep', ['5']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(readAdj(c.pid!), CHILD_ADJ);
  c.kill();
  // execFile goes through the same path.
  const e = execFile('sleep', ['5']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(readAdj(e.pid!), CHILD_ADJ);
  e.kill();
  assert.ok(guardStats.children >= 2);
  // Installing twice wraps once.
  installOomGuard();
});
