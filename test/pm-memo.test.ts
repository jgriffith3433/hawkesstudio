// The PM's count of today's starts is asked once per task every pass; it is read once until pm_log changes (pm.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-memo-'));
process.env.STUDIO_DATA = path.join(dir, 'data');
process.env.STUDIO_PROJECTS = path.join(dir, 'projects');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const before = process.env.STUDIO_PM_MEMO;
process.env.STUDIO_PM_MEMO = 'on';
after(() => { process.env.STUDIO_PM_MEMO = before; fs.rmSync(dir, { recursive: true, force: true }); });

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
await import('../src/agents.ts');
const { db } = await import('../src/db.ts');

test('starts today: read once until a start or an undo is logged, and never older than 15 s', () => {
  const now = Date.now();
  const n0 = pm.startsToday(now);
  // Written behind the memo's back: the count stays until pm_log changes through Studio, or 15 s pass.
  db.prepare(`INSERT INTO pm_log (id, at, action, subject, product, detail) VALUES ('d_memo_raw', ?, 'start', NULL, 'memo', 'started c_memo_raw for a thing')`).run(now);
  assert.equal(pm.startsToday(now + 1000), n0, 'kept within the 15 s');
  assert.equal(pm.startsToday(now + 16_000), n0 + 1, 'read again after 15 s');
  const id = rm.logDecision('start', null, 'memo', 'started c_memo_two for another thing');
  assert.equal(pm.startsToday(now + 16_500), n0 + 2, 'a start logged through Studio is counted at once');
  rm.markUndone(id as any);
  assert.equal(pm.startsToday(now + 17_000), n0 + 1, 'an undone start is given back at once');
});
