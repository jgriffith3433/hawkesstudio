// A pass that can't carry on ends through one step (agents.ts endPass), owned by the pass itself: it frees its worktree
// and its slot, and either goes back in the queue to try again at a set time (the queue's own timer starts it) or ends
// failed with why. Before, three of the five ways a pass ended (the stuck watch, a restart loop, a resume that couldn't
// carry on) left the worktree on disk, and a checkout failure waited out its retry inside the pass, holding its slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-endpass-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const A = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');

const HOUR = 3600_000;
function seed(id: string, phase: Record<string, unknown> | null, o: { status?: string; updated?: number } = {}) {
  const wt = path.join(process.env.STUDIO_PROJECTS!, '.work', id);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'big.bin'), 'x'.repeat(1024));
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, base, branch, worktree, log, notes, created, updated, phase) VALUES (?, 'nope', '[]', ?, 'working', 'nope', 'beta', ?, ?, '[]', '[]', ?, ?, ?)`)
    .run(id, o.status ?? 'working', `task/${id}`, wt, Date.now() - 20 * HOUR, o.updated ?? Date.now() - 12 * HOUR, phase ? JSON.stringify(phase) : null);
  return wt;
}
async function until(f: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a pass that ends failed frees its worktree', async () => {
  const wt = seed('c_fail00000001', { step: 'agent', since: 1 });
  await A.endPass('c_fail00000001', { detail: 'the agent crashed', phase: { step: 'agent', since: 1, failed: true } as any });
  assert.equal(A.getChange('c_fail00000001')!.status, 'failed');
  assert.equal(A.getChange('c_fail00000001')!.detail, 'the agent crashed');
  assert.ok(!fs.existsSync(wt), 'its worktree is gone from disk');
});

test('the stuck watch giving up frees the worktree too (it used to stay on disk)', async () => {
  const wt = seed('c_stuck0000001', { step: 'prepare', since: 1, watch: { step: 'prepare', n: A.WATCH_TRIES, at: Date.now() - HOUR } });
  A.checkStuck();
  assert.equal(A.getChange('c_stuck0000001')!.status, 'failed');
  await until(() => !fs.existsSync(wt));
});

test('a restart loop stopping a change frees its worktree too', async () => {
  const wt = seed('c_loop00000001', { step: 'agent', since: 1, restarts: { step: 'agent', n: 3, at: Date.now() - 1000 } });
  A.resumeChanges();
  assert.match(String(A.getChange('c_loop00000001')!.detail), /^stopped: Studio restarted 3 times/);
  await until(() => !fs.existsSync(wt));
});

test('a retry goes back in the queue, holding no slot, and the queue wakes itself at its time', async () => {
  const wt = seed('c_retry0000001', { step: 'prepare', since: 1 });
  const at = Date.now() + 60_000;
  await A.endPass('c_retry0000001', { detail: "queued: Studio's checkout failed; it tries the run again by itself (1 of 2)", phase: { step: 'prepare', since: Date.now(), autoRetry: 1 } as any, retryAt: at });
  const c = A.getChange('c_retry0000001')!;
  assert.equal(c.status, 'queued', 'not a running pass sleeping in its slot');
  assert.ok(!A.listChanges({ status: 'working,revising', limit: 50 }).some((x) => x.id === 'c_retry0000001'), 'it holds no slot');
  const ph = JSON.parse((db.prepare(`SELECT phase FROM changes WHERE id = 'c_retry0000001'`).get() as any).phase);
  assert.equal(ph.notBefore, at);
  assert.equal(ph.autoRetry, 1);
  assert.ok((A.pumpWakeAt() ?? Infinity) <= at, 'the queue has a wake set for it');
  assert.ok(!fs.existsSync(wt));
});

test('a change that was cancelled meanwhile is left as it is', async () => {
  seed('c_cancel000001', { step: 'agent', since: 1 }, { status: 'cancelled' });
  await A.endPass('c_cancel000001', { detail: 'late failure', phase: null });
  assert.equal(A.getChange('c_cancel000001')!.status, 'cancelled');
});
