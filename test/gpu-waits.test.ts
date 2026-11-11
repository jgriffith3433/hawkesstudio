// GPU tasks finishing by themselves (J, 2026-10-18, "do all of those suggestions"): follow-ups of GPU work keep its GPU
// items (so the under-$5 auto approval budgets them), and a change that merged stand-ins leaves its task "waiting for
// GPU" (not done) until a run with a GPU server makes the real art, not counted as a try. Scratch database; Gen's fleet
// and Studio's server starts are faked (no AWS, no agents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gpuwait-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_TASK_BAR = 'off'; // these tests start tasks written in a line (the task bar has its own: taskbar.test.ts)
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
// Never a real GPU start from a test: startWork does nothing without a GitHub token.
delete process.env.GITHUB_TOKEN;
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const product = (id: string) => ({ id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: id, port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [product('gwart'), product('gwother')], repos: { gwart: 'x/gwart', gwother: 'x/gwother' } }));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const agents = await import('../src/agents.ts');
const { db } = await import('../src/db.ts');
fs.mkdirSync(process.env.STUDIO_DATA!, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'notify.json'), JSON.stringify({ enabled: false, server: 'http://127.0.0.1:9', topic: 'test' }));

const ITEMS = [{ tool: 'video.i2v', params: { seconds: 3 }, count: 9, label: 'hero clips' }];
const change = (id: string, task: string, status: string, verify: any = null, product = 'gwart') => db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, verify, notes, log, created, updated, task, gpu_budget)
  VALUES (?, ?, '[]', ?, ?, ?, ?, ?, 'beta', ?, 'art', ?, '[]', '[]', ?, ?, ?, '1.10')`)
  .run(id, product, status, status, product, `x/${product}`, `task/${id}`, path.join(tmp, 'none', id), verify ? JSON.stringify(verify) : null, Date.now(), Date.now(), task);

test('a follow-up added without GPU items keeps those of the GPU work it follows up (through a chain of follow-ups)', async () => {
  const it = rm.addItem({ product: 'gwart', title: 'Portal scene', size: 'M', status: 'planned' });
  const art = rm.addTask({ item: it.id, request: 'Portal and beam art (GPU)', gpu: ITEMS });
  rm.setTask(art.id, { status: 'merged', change: 'c_aaaaaaaaaaa1', changes: ['c_aaaaaaaaaaa1'] });
  // Like k_80f6d7505b6a: "Follow-up to PR #28 (c_5df464e2bcfc)", added by the PM with no gpu.
  const f1 = rm.addTask({ item: it.id, request: 'Follow-up to PR #28 (c_aaaaaaaaaaa1). Make the real Hawkes Gen art.' });
  assert.deepEqual(f1.gpu?.items, ITEMS);
  assert.ok(rm.listDecisions({ action: 'gpu inherit' }).some((d) => d.subject === f1.id && d.detail!.includes(art.id)));
  // Like k_d0f27799972d: depends on a follow-up that (before this fix) had no items itself.
  db.prepare('UPDATE tasks SET gpu = NULL WHERE id = ?').run(f1.id);
  const f2 = rm.addTask({ item: it.id, request: 'PR #33 got the pipeline ready: run the Gen pass and bake it', depends: [f1.id] });
  assert.deepEqual(f2.gpu?.items, ITEMS);
  // Its own items win; a task naming nothing GPU gets none; another product's GPU task is never the source.
  assert.equal(rm.addTask({ item: it.id, request: `Own (${art.id})`, gpu: [{ tool: 'image.edit', count: 1 }] }).gpu?.items?.[0].tool, 'image.edit');
  assert.equal(rm.addTask({ item: it.id, request: 'Tune the beam timing' }).gpu, null);
  // A task that depends on GPU work not started yet waits for its assets; it never copies (and pays for) its GPU list.
  const sea = rm.addTask({ item: it.id, request: 'Make the sea (GPU)', gpu: ITEMS });
  assert.equal(rm.addTask({ item: it.id, request: 'Fishing at the shore, using the sea', depends: [sea.id] }).gpu, null);
  assert.equal(rm.addTask({ item: it.id, request: `After ${sea.id}: the boats` }).gpu, null);
  const other = rm.addItem({ product: 'gwother', title: 'Other', size: 'S', status: 'planned' });
  assert.equal(rm.addTask({ item: other.id, request: `Like ${art.id}` }).gpu, null);
});

test('backfill: planned GPU follow-ups from before get their items and a price', async () => {
  const it = rm.addItem({ product: 'gwart', title: 'Gloob', size: 'S', status: 'planned' });
  const art = rm.addTask({ item: it.id, request: 'Gloob portrait (GPU)', gpu: ITEMS });
  rm.setTask(art.id, { status: 'merged', change: 'c_aaaaaaaaaaa2', changes: ['c_aaaaaaaaaaa2'] });
  const f = rm.addTask({ item: it.id, request: 'Follow-up to PR #39 (c_aaaaaaaaaaa2): the painted loops' });
  db.prepare('UPDATE tasks SET gpu = NULL WHERE id = ?').run(f.id);
  assert.ok((await rm.backfillGpu()).includes(f.id));
  const t = rm.getTask(f.id)!;
  assert.deepEqual(t.gpu?.items, ITEMS);
  assert.ok(t.gpu?.estimate, 'priced (or the pricing error recorded) for its budget');
  assert.ok(!(await rm.backfillGpu()).includes(f.id), 'once');
});

test('stand-ins are told by the marker file, or a summary saying no GPU server ran', () => {
  const wt = fs.mkdtempSync(path.join(tmp, 'wt-'));
  assert.equal(agents.pendingGpuOf(wt, 'Added the hero clips from Hawkes Gen.'), null);
  assert.match(agents.pendingGpuOf(wt, 'Shipped interim art: no GPU server was running, so the clips are still queued.')!, /summary says/);
  assert.equal(agents.pendingGpuOf(wt, 'Keep the interim art for any piece whose Gen take judges worse.'), null);
  fs.mkdirSync(path.join(wt, '.hawkes'));
  fs.writeFileSync(path.join(wt, agents.PENDING_GPU), 'hero Shout clip: video.i2v, j_123\n');
  assert.equal(agents.pendingGpuOf(wt, 'all done'), 'hero Shout clip: video.i2v, j_123');
});

test('a merge of stand-ins leaves the task waiting for GPU; a GPU server up runs it again (not a try); a failed run waits again', async () => {
  const it = rm.addItem({ product: 'gwart', title: 'Hero animation', size: 'M', status: 'planned' });
  let t = rm.addTask({ item: it.id, request: 'Hero animation clips (GPU)', gpu: ITEMS });
  rm.approveGpu(t.id, 1.1, 'J');
  change('c_bbbbbbbbbbb1', t.id, 'merged', { pendingGpu: 'Shout clip: j_1\nTumble clip: j_2' });
  rm.setTask(t.id, { status: 'working', change: 'c_bbbbbbbbbbb1', changes: ['c_bbbbbbbbbbb1'], tries: 1 });
  await pm.syncTasks();
  t = rm.getTask(t.id)!;
  assert.equal(t.status, rm.GPU_WAIT);
  const p = rm.itemProgress(rm.getItem(it.id)!);
  assert.equal(p.state, 'waiting for GPU');
  assert.equal(p.merged, 0, "stand-ins don't count as merged");
  assert.match(p.tasks[0].waits!, /GPU server/);
  assert.equal(rm.landed(t), false);
  assert.ok(rm.listDecisions({ action: 'gpu-wait' }).some((d) => d.subject === t.id && /Shout clip/.test(d.detail ?? '')));
  assert.equal(pm.startBlocked(t.id), null, 'it may run again');

  // No GPU server running: Studio starts a stopped one for it (gpustart, faked here), starting no agent.
  const ensured: any[] = [];
  assert.deepEqual(await pm.rerunGpuWaits(2, new Set(), { running: async () => false, ensure: async (c) => { ensured.push(c); return 'started GPU server i-1'; } }), []);
  assert.equal(ensured.length, 1);
  assert.equal(ensured[0].task, t.id);
  assert.equal(Number(ensured[0].gpu_budget), 1.1);
  assert.equal(await ensured[0].stillNeeds(), true);

  // A server is up: a new change for the real art, the stand-ins' list in its request, not a try.
  const [id] = await pm.rerunGpuWaits(2, new Set(), { running: async () => true });
  assert.ok(id);
  t = rm.getTask(t.id)!;
  assert.equal(t.status, 'working');
  assert.equal(t.tries, 1, 'not counted as a try');
  const c = agents.getChange(id)!;
  assert.match(c.request!, /stand-ins[\s\S]*Tumble clip: j_2/);
  assert.equal(c.gpu_budget, '1.1');
  assert.ok(rm.listDecisions({ action: 'gpu-rerun' }).some((d) => d.subject === t.id && d.detail!.includes(id)));

  // That run fails (no art after all): the task waits for GPU again, still not a try, said once.
  db.prepare(`UPDATE changes SET status = 'failed', detail = 'the agent made no commit' WHERE id = ?`).run(id);
  await pm.syncTasks();
  await pm.syncTasks();
  t = rm.getTask(t.id)!;
  assert.equal(t.status, rm.GPU_WAIT);
  assert.equal(t.tries, 1);
  assert.equal(rm.listDecisions({ action: 'gpu-wait' }).filter((d) => d.subject === t.id && d.detail!.includes(id)).length, 1);

  // After its runs are used up, J decides; "keep the stand-ins" counts it as merged.
  for (let i = 0; i < pm.MAX_GPU_RERUNS; i++) rm.logDecision('gpu-rerun', t.id, 'gwart', `run c_fake${i}`);
  await pm.rerunGpuWaits(2, new Set(), { running: async () => true });
  const q = rm.listQuestions().find((x) => x.subject === t.id)!;
  assert.ok(q && q.options?.includes('keep the stand-ins'));
  await pm.answerQuestion(q.id, 'keep the stand-ins', 'J');
  assert.equal(rm.getTask(t.id)!.status, 'merged');
});

test('a merge without a GPU budget, or without stand-ins, is merged as before', () => {
  const it = rm.addItem({ product: 'gwart', title: 'Plain', size: 'S', status: 'planned' });
  const plain = rm.addTask({ item: it.id, request: 'Code only' });
  assert.equal(pm.mergedStatus(plain, { verify: { pendingGpu: 'x' } }), 'merged');
  const gpu = rm.approveGpu(rm.addTask({ item: it.id, request: 'Art', gpu: ITEMS }).id, 2, 'J');
  assert.equal(pm.mergedStatus(gpu, { verify: {} }), 'merged');
  assert.equal(pm.mergedStatus(gpu, { verify: { pendingGpu: 'x' } }), rm.GPU_WAIT);
});

test('gpuReruns ignores STUDIO_FAILED_SQL runs, and answerQuestion("try again") resets the round and ensuredAt', async () => {
  const it = rm.addItem({ product: 'gwart', title: 'Wallit', size: 'M', status: 'planned' });
  const t = rm.approveGpu(rm.addTask({ item: it.id, request: 'Wallit 3D character (GPU)', gpu: ITEMS }).id, 1.5, 'J');
  change('c_wallit000001', t.id, 'merged', { pendingGpu: 'Wallit mesh: j_w1' });
  rm.setTask(t.id, { status: rm.GPU_WAIT, change: 'c_wallit000001', changes: ['c_wallit000001'], tries: 1 });

  // Runs that died with STUDIO_FAILED_SQL (e.g. harness/billing error) do not burn MAX_GPU_RERUNS slots.
  for (let i = 0; i < pm.MAX_GPU_RERUNS; i++) {
    const cid = `c_wfail000000${i}`;
    change(cid, t.id, 'failed');
    // Hours ago: Studio's own failures hold the task back for a while (infraHoldOf), long over by now.
    db.prepare(`UPDATE changes SET phase = ?, created = ?, updated = ? WHERE id = ?`).run(JSON.stringify({ step: 'agent', failed: true }), Date.now() - 6 * 3600_000 + i, Date.now() - 6 * 3600_000 + i, cid);
    rm.logDecision('gpu-rerun', t.id, 'gwart', `run ${cid}`);
  }
  assert.equal(pm.gpuReruns(t.id), 0);

  // First ensure call records ensuredAt for t.id; then 3 real gpu-rerun attempts burn MAX_GPU_RERUNS and ask J.
  const ensured: any[] = [];
  await pm.rerunGpuWaits(2, new Set(), { running: async () => false, ensure: async (c) => { ensured.push(c); return 'started GPU server i-1'; } });
  assert.equal(ensured.length, 1);
  for (let i = 0; i < pm.MAX_GPU_RERUNS; i++) rm.logDecision('gpu-rerun', t.id, 'gwart', `run c_wreal${i}`);
  assert.equal(pm.gpuReruns(t.id), pm.MAX_GPU_RERUNS);
  assert.deepEqual(await pm.rerunGpuWaits(2, new Set(), { running: async () => true }), []);
  const q = rm.listQuestions().find((x) => x.subject === t.id)!;
  assert.ok(q, 'asked J after MAX_GPU_RERUNS');

  // J answers "try again": gpuReruns resets to 0, ensuredAt is cleared so a stopped server starts if needed, and a new rerun starts once running.
  await pm.answerQuestion(q.id, 'try again', 'J');
  assert.equal(pm.gpuReruns(t.id), 0);
  await pm.rerunGpuWaits(2, new Set(), { running: async () => false, ensure: async (c) => { ensured.push(c); return 'started GPU server i-1'; } });
  assert.equal(ensured.length, 2, 'ensuredAt cleared so a stopped GPU server is started');

  const [rerunId] = await pm.rerunGpuWaits(2, new Set(), { running: async () => true });
  assert.ok(rerunId, 'starts a fresh gpu-rerun change after try again');
  assert.equal(pm.gpuReruns(t.id), 1);
});

test('a criterion keeps its own leading number; only list markers come off', () => {
  const it = rm.addItem({ product: 'gwart', title: 'Numbers', size: 'S', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Numbers stay', criteria: ['0 console errors in a 5 min play', '60 fps on desktop', '- a bullet', '2. a numbered line', '3) another'] });
  assert.deepEqual(t.criteria, ['0 console errors in a 5 min play', '60 fps on desktop', 'a bullet', 'a numbered line', 'another']);
});
