// A change whose step keeps ending Studio (a clone too big for Cloud Run's memory disk crashed the customer Studio on
// every restart, 2026-10-31) stops being resumed after RESTART_LOOP quick restarts in a row; restarts far apart (deploys
// during a long agent pass) don't count. And on Cloud Run a repo bigger than Studio can hold isn't cloned at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-restart-loop-'));
const { resumeChanges, getChange, RESTART_LOOP } = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');
const { tooBigToClone, cloneMaxMb } = await import('../src/repos.ts');

function seed(id: string, phase: Record<string, unknown>) {
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, log, created, phase) VALUES (?, 'nope', '[]', 'working', 'preparing the worktree', '[]', ?, ?)`)
    .run(id, Date.now(), JSON.stringify(phase));
}

test('quick restarts at one step stop the change; far-apart ones start counting again', () => {
  seed('c_loop', { step: 'prepare', since: 1, restarts: { step: 'prepare', n: RESTART_LOOP, at: Date.now() - 60_000 } });
  seed('c_apart', { step: 'agent', since: 1, restarts: { step: 'agent', n: RESTART_LOOP, at: Date.now() - 60 * 60_000 } });
  const resumed = resumeChanges();
  const loop = getChange('c_loop')!;
  assert.equal(loop.status, 'failed');
  assert.match(loop.detail!, /restarted 3 times in a row during its prepare step/);
  assert.ok(!resumed.includes('c_loop'));
  assert.ok(resumed.includes('c_apart'));
  const row = db.prepare(`SELECT phase FROM changes WHERE id = 'c_apart'`).get() as { phase: string };
  assert.equal(JSON.parse(row.phase).restarts.n, 1);
});

test("a resumed change whose project is gone fails plainly instead of an unhandled rejection", async () => {
  const end = Date.now() + 5000;
  while (getChange('c_apart')!.status !== 'failed' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.match(getChange('c_apart')!.detail!, /couldn't carry on after the restart: No product "nope"/);
});

test('on Cloud Run a repo over the limit is refused before cloning; off it, or when GitHub has no answer, it clones', async () => {
  const sized = (kb: number) => (async () => new Response(JSON.stringify({ size: kb }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await tooBigToClone('x/big', sized(5_000_000)), null, 'not on Cloud Run: nothing to check');
  process.env.K_SERVICE = 'studio-test';
  try {
    assert.match((await tooBigToClone('x/big', sized(3_000_000)))!, /x\/big is about 2930 MB, more than Studio can clone/);
    assert.equal(await tooBigToClone('x/small', sized((cloneMaxMb() - 10) * 1024)), null);
    assert.equal(await tooBigToClone('x/gone', (async () => new Response('', { status: 404 })) as unknown as typeof fetch), null);
  } finally { delete process.env.K_SERVICE; }
});
