// Two queue root causes (2026-11-11): a memory-starved change that failed doesn't take the one start memory allows
// from the changes that can use it, and a queued change duplicating merged work is closed before it starts (undoable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dupmem-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dupmem-projects-'));
const A = await import('../src/agents.ts');
const D = await import('../src/dup-merged.ts');
const { db } = await import('../src/db.ts');
const { listDecisions } = await import('../src/roadmap.ts');
const { undoDecision } = await import('../src/pm.ts');

let t = 1_000_000;
function add(id: string, o: { status?: string; log?: string[]; title?: string; request?: string; merged_at?: number | null; product?: string } = {}) {
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, base, worktree, title, request, notes, log, created, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, o.product ?? 'phorigins', '[]', o.status ?? 'queued', 'queued', 'phoriginsrepo', 'beta', path.join(os.tmpdir(), 'none', id), o.title ?? `Title ${id}`, o.request ?? `Request ${id}`, '[]', JSON.stringify(o.log ?? []), t += 1000, o.merged_at ?? null);
}

test('a change that failed waiting for memory goes behind the others while memory is low', () => {
  add('c_starved0001', { log: ['10:00:00 error: push failed', '10:01:00 waiting for memory before carrying on (0.7 GB free of 3.8 GB)'] });
  add('c_small000001');
  assert.equal(A.memoryStarved(A.getChange('c_starved0001')!), true);
  assert.equal(A.memoryStarved(A.getChange('c_small000001')!), false);
  const queued = A.listChanges({ status: 'queued', limit: 50 }).reverse();
  assert.equal(queued[0].id, 'c_starved0001', 'oldest first without the gate');
  queued.sort((a, b) => Number(A.memoryStarved(a)) - Number(A.memoryStarved(b)));
  assert.deepEqual(A.pickQueued(queued.map((c) => ({ id: c.id, product: c.product })), [], 1), ['c_small000001'], 'the one start goes to the change that fits');
  assert.deepEqual(A.pickQueued(queued.map((c) => ({ id: c.id, product: c.product })), [], 2, { limit: () => 2, fit: () => true }).length, 2, 'and the starved one still starts when there is room');
});

const words = 'owner cell bypass plan gates entitlement feature requireFeature upgradeRefusal customer cells billing';
test('a queued change duplicating merged work is closed before it starts, and can be undone', async () => {
  const now = Date.now();
  add('c_merged00001', { status: 'merged', title: 'Owner cell bypasses plan gates', request: `Make the ${words}`, merged_at: now - 3600_000 });
  add('c_dupe0000001', { title: 'Owner cell bypasses plan gates', request: `Ask: ${words} please` });
  add('c_other000001', { title: 'Unrelated sound work', request: 'Layered island ambience loops with wind and waves for the beach level' });
  add('c_old00000001', { status: 'merged', title: 'Owner cell bypasses plan gates', request: words, merged_at: now - 30 * 24 * 3600_000 });
  assert.equal(D.likelyDuplicate('c_dupe0000001')?.id, 'c_merged00001', 'merged in the last 7 days only');
  assert.equal(D.likelyDuplicate('c_other000001'), null, 'low overlap: no model call');
  const asked: string[] = [];
  const closed: string[] = [];
  D.dupHooks.judge = async (q, m) => { asked.push(`${q.id}>${m.id}`); return true; };
  D.dupHooks.close = async (id, _by) => { closed.push(id); db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(id); return null; };
  D.dupHooks.pump = async () => {};
  assert.equal(D.duplicateHold('c_other000001'), true);
  assert.equal(D.duplicateHold('c_dupe0000001'), false, 'held while the model judges');
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['c_dupe0000001>c_merged00001']);
  assert.deepEqual(closed, ['c_dupe0000001']);
  assert.equal(A.getChange('c_dupe0000001')!.detail, 'closed: already done by c_merged00001');
  const d = listDecisions({ action: 'duplicate-closed' })[0];
  assert.match(d.detail ?? '', /already done by c_merged00001/);
  await undoDecision(d.id, 'J');
  assert.equal(A.getChange('c_dupe0000001')!.status, 'queued');
  assert.equal(D.duplicateHold('c_dupe0000001'), true, 'once undone it starts as any other');
});

test('a model that cannot answer closes nothing', async () => {
  add('c_merged00002', { status: 'merged', title: 'Alpha beta gamma delta', request: 'alpha beta gamma delta epsilon zeta theta', merged_at: Date.now() });
  add('c_dupe0000002', { title: 'Alpha beta gamma delta', request: 'alpha beta gamma delta epsilon zeta theta' });
  D.dupHooks.judge = async () => { throw new Error('no model'); };
  assert.equal(D.duplicateHold('c_dupe0000002'), false);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(A.getChange('c_dupe0000002')!.status, 'queued');
  assert.equal(D.duplicateHold('c_dupe0000002'), true);
});
