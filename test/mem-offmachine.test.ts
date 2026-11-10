// A pass whose agent runs as a Cloud Run job on another machine holds no memory here while it waits (agents.ts
// offMachine), so it doesn't hold the memory gate shut. On 2026-11-10 memory was low at rest (the in-memory disk and
// Studio itself left ~0.5 GB of the 1 GiB a start needs), memRoom lets a start go only when nothing is in flight, and
// passes waiting an hour on their cloud agents counted as in flight: 84 changes queued, 2-4 of 6 slots used, no start for
// 40 minutes. The drain flag a dead deploy leaves behind goes too (drain.ts clearStaleDeployFlag).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-offmachine-'));
const { passInternals: P } = await import('../src/agents.ts');
const { clearStaleDeployFlag, deployPending } = await import('../src/drain.ts');
const { DATA } = await import('../src/config.ts');

test('on Cloud Run a pass is off the memory count while its agent job runs, and back on after', async () => {
  const was = process.env.STUDIO_DETACH;
  process.env.STUDIO_DETACH = 'cloudrun';
  try {
    const land = P.claim('c_off1', { flight: true });
    assert.equal(P.inFlight(), 1);
    let during = -1;
    await P.offMachine('c_off1', async () => { during = P.inFlight(); });
    assert.equal(during, 0, 'not counted while the agent works elsewhere');
    assert.equal(P.inFlight(), 1, 'counted again for its local steps');
    land();
    assert.equal(P.inFlight(), 0);
    // An agent step that throws still gives the count back; landing twice never goes below zero.
    const land2 = P.claim('c_off2', { flight: true });
    await assert.rejects(P.offMachine('c_off2', async () => { throw new Error('boom'); }));
    assert.equal(P.inFlight(), 1);
    land2(); land2();
    assert.equal(P.inFlight(), 0);
  } finally {
    if (was === undefined) delete process.env.STUDIO_DETACH; else process.env.STUDIO_DETACH = was;
  }
});

test('a pass given up on while its agent ran elsewhere does not take the count back', async () => {
  process.env.STUDIO_DETACH = 'cloudrun';
  try {
    P.claim('c_off3', { flight: true });
    await P.offMachine('c_off3', async () => { P.abandonPass('c_off3'); });
    assert.equal(P.inFlight(), 0);
  } finally {
    delete process.env.STUDIO_DETACH;
  }
});

test('off Cloud Run (the agent runs on this machine) the pass stays counted', async () => {
  process.env.STUDIO_DETACH = 'off';
  try {
    const land = P.claim('c_off4', { flight: true });
    await P.offMachine('c_off4', async () => assert.equal(P.inFlight(), 1));
    land();
    assert.equal(P.inFlight(), 0);
  } finally {
    delete process.env.STUDIO_DETACH;
  }
});

test('a drain flag older than 20 minutes is removed; a fresh one stays', () => {
  const flag = path.join(DATA, 'deploy-pending');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(flag, '');
  assert.equal(clearStaleDeployFlag(20 * 60_000, Date.now()), null);
  assert.ok(deployPending());
  assert.match(String(clearStaleDeployFlag(20 * 60_000, Date.now() + 25 * 60_000)), /removed a deploy drain flag left for 25 min/);
  assert.ok(!deployPending());
});
