// One roadmap task, one change on its way; and the PM queues only what the agents can take (2026-11-10/11 pile-up).
//
// 16:37-16:39 UTC: "Layered island sound" (k_d9e3d07e803e), waiting for GPU after stand-ins, got 42 changes, one every
// 3 s (the PM's kick). Each failed at once on "in-memory disk is full", a failure of Studio's own that neither counts as
// a GPU rerun nor holds the task back, so the next PM pass made another. Several of the failed ones were later revised
// beside each other and four merged into beta for the same task. Meanwhile the PM, which counted only running changes as
// taken, queued about 20 changes at a time while nothing could start; the queue reached 111.
// Scratch database; no agents run (agents.json maxConcurrent 0) and Gen's fleet is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-onechange-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
delete process.env.GITHUB_TOKEN;
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const product = (id: string) => ({ id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: id, port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: ['isle', 'other', 'third'].map(product), repos: { isle: 'x/isle', other: 'x/other', third: 'x/third' } }));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const agents = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');
fs.mkdirSync(process.env.STUDIO_DATA!, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'notify.json'), JSON.stringify({ enabled: false, server: 'http://127.0.0.1:9', topic: 'test' }));
pm.savePmSettings({ maxConcurrent: 50, maxStartsPerDay: 1000 });

const ITEMS = [{ tool: 'audio.sfx', params: {}, count: 12, label: 'island sounds' }];
const changeRow = (id: string, task: string | null, status: string, o: { verify?: any; product?: string; at?: number } = {}) => db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, verify, notes, log, created, updated, task, gpu_budget)
  VALUES (?, ?, '[]', ?, ?, ?, ?, ?, 'beta', ?, 'sound', ?, '[]', '[]', ?, ?, ?, '0.28')`)
  .run(id, o.product ?? 'isle', status, status, o.product ?? 'isle', `x/${o.product ?? 'isle'}`, `task/${id}`, path.join(tmp, 'none', id), o.verify ? JSON.stringify(o.verify) : null, o.at ?? Date.now(), o.at ?? Date.now(), task);
const ofTask = (task: string) => (db.prepare('SELECT id, status FROM changes WHERE task = ? ORDER BY created').all(task) as { id: string; status: string }[]);
/** What prepare did at 16:37: "in-memory disk is full", a failure of Studio's own (phase failed). */
const failOnDisk = (id: string) => db.prepare(`UPDATE changes SET status = 'failed', detail = 'error: in-memory disk is full (1.83 GB used of 4.00 GB); need 100 MB more', phase = ? WHERE id = ?`).run(JSON.stringify({ step: 'prepare', failed: true }), id);

test('a GPU server up, and every run for the real art failing on a full disk: one change, not one per PM pass', async () => {
  const it = rm.addItem({ product: 'isle', title: 'Island audio', size: 'M', status: 'planned' });
  let t = rm.addTask({ item: it.id, request: 'Layered island sound (GPU)', gpu: ITEMS });
  rm.approveGpu(t.id, 0.28, 'J');
  changeRow('c_isle00merged', t.id, 'merged', { verify: { pendingGpu: 'beach bed: j_1' }, at: Date.now() - 3600_000 });
  rm.setTask(t.id, { status: 'working', change: 'c_isle00merged', changes: ['c_isle00merged'], tries: 1 });
  await pm.syncTasks();
  assert.equal(rm.getTask(t.id)!.status, rm.GPU_WAIT);

  // The PM's pass fires again and again (every 3 s on the 10th); each run fails on the disk the moment it starts.
  for (let i = 0; i < 20; i++) {
    for (const id of await pm.rerunGpuWaits(5, new Set(), { running: async () => true })) failOnDisk(id);
    await pm.syncTasks();
  }
  const made = ofTask(t.id).filter((c) => c.id !== 'c_isle00merged');
  assert.equal(made.length, 1, `one run for the art, not ${made.length}`);
  t = rm.getTask(t.id)!;
  assert.equal(t.status, rm.GPU_WAIT, 'it still waits for GPU (its stand-ins are on beta)');
  assert.ok(pm.infraHoldOf(t.id, Date.now(), { firstWaits: true }), 'and waits out Studio\'s failure before the next run');

  // Once the wait is over (10 minutes after the failure), it runs once more.
  db.prepare('UPDATE changes SET updated = ? WHERE id = ?').run(Date.now() - 11 * 60_000, made[0].id);
  assert.equal((await pm.rerunGpuWaits(5, new Set(), { running: async () => true })).length, 1);
  assert.equal((await pm.rerunGpuWaits(5, new Set(), { running: async () => true })).length, 0, 'its new change is on its way: no second');
  assert.equal(ofTask(t.id).filter((c) => c.status === 'queued').length, 1);
});

test('a task never has two changes on its way: starting a second or reviving an older failed one is refused', () => {
  const it = rm.addItem({ product: 'other', title: 'Docks', size: 'S', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Dock planks creak' });
  const first = agents.startTask('other', 'Dock planks creak', { task: t.id });
  assert.throws(() => agents.startTask('other', 'Dock planks creak (again)', { task: t.id }), /already has change/);
  assert.equal(agents.liveChangeOfTask(t.id)?.id, first);
  // An older attempt that failed can't be revised back to life beside the one on its way.
  changeRow('c_docks0failed', t.id, 'failed', { product: 'other', at: Date.now() - 60_000 });
  assert.throws(() => agents.revise('c_docks0failed', 'try again'), /already has change/);
  // The one on its way ended: the older one may be revised again (and then nothing else may start).
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(first);
  assert.equal(agents.revise('c_docks0failed', 'try again')?.status, 'queued');
  assert.throws(() => agents.startTask('other', 'Dock planks creak', { task: t.id }), /c_docks0failed/);
  // Requests that aren't a roadmap task's are untouched.
  assert.ok(agents.startTask('other', 'A tweak J asked for'));
});

test("the PM's free agents count the queued changes too: nothing new is queued while the queue can't start", () => {
  db.prepare(`UPDATE changes SET status = 'closed' WHERE status IN ('queued', 'working', 'verifying', 'revising')`).run();
  pm.savePmSettings({ maxConcurrent: 3, maxStartsPerDay: 1000 });
  assert.equal(pm.capacity().free, 3);
  changeRow('c_q00000000001', null, 'queued', { product: 'third' });
  changeRow('c_q00000000002', null, 'queued', { product: 'third' });
  const cap = pm.capacity();
  assert.equal(cap.queued, 2);
  assert.equal(cap.free, 1, 'two places are taken by changes still waiting to start');
  changeRow('c_w00000000003', null, 'working', { product: 'third' });
  assert.equal(pm.capacity().free, 0);
  assert.match(pm.startWaitReason({ id: 'k_none', product: 'third' }) ?? '', /2 queued/);
  pm.savePmSettings({ maxConcurrent: 50, maxStartsPerDay: 1000 });
});
