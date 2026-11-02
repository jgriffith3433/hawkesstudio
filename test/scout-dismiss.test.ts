// Dismissing scouts in Activity: one, all failed, and the 24 h auto-hide (src/scout.ts, src/activity.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scout-dismiss-'));
const { db } = await import('../src/db.ts');
const { dismissScout, restoreScout, clearFailedScouts } = await import('../src/scout.ts');
const { activity, hiddenScouts } = await import('../src/activity.ts');

const now = Date.now();
const add = (id: string, status: string, finished: number | null) =>
  db.prepare('INSERT INTO scouts (id, product, question, status, created, finished) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'nope', 'q ' + id, status, (finished ?? now) - 1000, finished);
const shown = async () => (await activity()).scouts.map((x: any) => x.id).sort();

test('dismiss hides a finished scout, keeps it under hidden, and restore brings it back', async () => {
  add('x_a1', 'failed', now - 60_000);
  add('x_a2', 'done', now - 60_000);
  assert.deepEqual(await shown(), ['x_a1', 'x_a2']);
  dismissScout('x_a1');
  assert.deepEqual(await shown(), ['x_a2']);
  assert.deepEqual(hiddenScouts().map((x: any) => x.id), ['x_a1']);
  assert.equal((await activity()).hiddenScoutCount, 1);
  restoreScout('x_a1');
  assert.deepEqual(await shown(), ['x_a1', 'x_a2']);
});

test('a running scout can never be dismissed', async () => {
  add('x_r1', 'running', null);
  assert.throws(() => dismissScout('x_r1'), /still running/);
  assert.ok((await shown()).includes('x_r1'));
});

test('clear failed dismisses only failed scouts', async () => {
  add('x_f1', 'failed', now - 5000);
  add('x_f2', 'failed', now - 6000);
  const ids = clearFailedScouts();
  assert.ok(ids.includes('x_f1') && ids.includes('x_f2') && ids.includes('x_a1') && !ids.includes('x_a2') && !ids.includes('x_r1'));
  const s = await shown();
  assert.ok(s.includes('x_a2') && s.includes('x_r1') && !s.includes('x_f1'));
  assert.ok(hiddenScouts().some((x: any) => x.id === 'x_f2'));
});

test('failed scouts older than 24 h drop out by themselves but stay reachable', async () => {
  add('x_old', 'failed', now - 25 * 3_600_000);
  assert.ok(!(await shown()).includes('x_old'));
  assert.ok(hiddenScouts().some((x: any) => x.id === 'x_old'));
});
