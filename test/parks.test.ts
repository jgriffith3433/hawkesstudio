// A park that names an outside condition comes back by itself (J, 2026-11-13: DoD's portraits task parked "until Gen credits
// are topped up" sat a day and held two tasks; Hawkes Games' k_21faea83012b sat "waiting for GPU" after its change ended
// "already done"; k_1989d9a3f696 after "No GPU" twice). One test per path: (a) condition recorded as data and re-checked on
// events, (b) an idea that holds others up, (c) "already done" on a GPU task, (d) GPU waits retried at the next GPU-capable
// moment, and the deadline fallback. Scratch database; Gen's fleet is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-parks-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_TASK_BAR = 'off';
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
delete process.env.GITHUB_TOKEN;
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const product = (id: string) => ({ id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: id, port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [product('pkart')], repos: { pkart: 'x/pkart' } }));
fs.mkdirSync(process.env.STUDIO_DATA!, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'notify.json'), JSON.stringify({ enabled: false, server: 'http://127.0.0.1:9', topic: 'test' }));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
await import('../src/agents.ts');
const P = await import('../src/parks.ts');
const E = await import('../src/parkevents.ts');
const W = await import('../src/waits.ts');
const { db } = await import('../src/db.ts');

const ITEMS = [{ tool: 'image.generate', params: {}, count: 4, label: 'portraits' }];
const item = rm.addItem({ product: 'pkart', title: 'Portraits', size: 'M', status: 'planned' });
const change = (id: string, task: string, status: string, o: { detail?: string; summary?: string; verify?: any } = {}) => db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, verify, summary, commits, notes, log, created, updated, task, gpu_budget)
  VALUES (?, 'pkart', '[]', ?, ?, 'pkart', ?, ?, 'beta', ?, 'art', ?, ?, '[]', '[]', '[]', ?, ?, ?, '1.10')`)
  .run(id, status, o.detail ?? status, `x/${id}`, `task/${id}`, path.join(tmp, 'none', id), o.verify ? JSON.stringify(o.verify) : null, o.summary ?? '', Date.now(), Date.now(), task);
const open = () => true;

test('(a) a park naming Gen credits is recorded as data and the task is planned again once credits are back', async () => {
  const t = rm.addTask({ item: item.id, request: 'Portraits' });
  rm.setTask(t.id, { status: 'idea', note: 'Parked by PM until Gen credits are topped up. Set planned again after a top-up.' });
  assert.deepEqual(P.adoptParks(), [t.id]);
  assert.deepEqual(P.adoptParks(), [], 'once');
  const park = P.parkOf(t.id)!;
  assert.equal(park.kind, 'credits');
  assert.match(park.detail, /Gen credits/);
  assert.equal(W.waitOf('park-condition', t.id)?.state, 'pending', 'it has a deadline in the waits table');
  // Studio still sees no credits: it stays parked (and the adopted first look is spent).
  assert.deepEqual(await P.releaseParks({ credits: () => false }), []);
  assert.equal(rm.getTask(t.id)!.status, 'idea');
  // Credits are added (the event Studio already gets): released and planned, with a log line.
  E.parkEvent('credits-added');
  assert.deepEqual(await P.releaseParks({ credits: () => true }), [t.id]);
  assert.equal(rm.getTask(t.id)!.status, 'planned');
  assert.equal(P.parkOf(t.id), null);
  assert.equal(W.waitOf('park-condition', t.id)?.how, 'event');
  assert.ok(rm.listDecisions({ action: 'unpark' }).some((d) => d.subject === t.id && /credits/.test(d.detail ?? '')));
});

test('(a) an event of another kind does not release; notes that name other work or a person are not conditions', async () => {
  assert.equal(P.conditionOf('held until i_0123456789ab is on beta'), null);
  assert.equal(P.conditionOf("parked on J's answer to q_1"), null);
  assert.equal(P.conditionOf('no credits yet'), null, 'a note with no wait in it is no park');
  assert.equal(P.conditionOf('waiting until a GPU server is up')!.kind, 'gpu');
  assert.equal(P.conditionOf('parked until the AI provider usage limit resets')!.kind, 'provider');
  const t = rm.addTask({ item: item.id, request: 'Voices' });
  rm.setTask(t.id, { status: 'idea' });
  P.parkTask(t.id, 'gpu', 'a GPU server is up');
  assert.equal(rm.getTask(t.id)!.status, 'idea');
  await new Promise((r) => setTimeout(r, 5));
  E.parkEvent('provider-back');
  assert.deepEqual(await P.releaseParks({ gpu: open }), [], 'a provider coming back is not a GPU');
  E.parkEvent('gen-job-done');
  assert.deepEqual(await P.releaseParks({ gpu: open }), [t.id], 'a finished Gen job is');
});

test('(a) the park deadline plans the task again whatever Studio sees', async () => {
  const t = rm.addTask({ item: item.id, request: 'Sky' });
  rm.setTask(t.id, { status: 'idea' });
  P.parkTask(t.id, 'credits', 'Gen credits are added');
  await W.fireDue(Date.now() + 7 * 3600_000);
  assert.equal(rm.getTask(t.id)!.status, 'planned');
  assert.equal(P.parkOf(t.id), null);
  assert.equal(W.waitOf('park-condition', t.id)?.how, 'deadline');
});

test('(a) a park whose task moved on is forgotten', async () => {
  const t = rm.addTask({ item: item.id, request: 'Moved on' });
  rm.setTask(t.id, { status: 'idea' });
  P.parkTask(t.id, 'credits', 'Gen credits are added');
  rm.setTask(t.id, { status: 'dropped' });
  await P.releaseParks({});
  assert.equal(P.parkOf(t.id), null);
});

test('(b) a task behind a parked idea starts once the park clears; an idea held for nothing nameable is one Inbox question', async () => {
  const dep = rm.addTask({ item: item.id, request: 'Dependency' });
  rm.setTask(dep.id, { status: 'idea', note: 'Parked until a GPU server is up.' });
  const after = rm.addTask({ item: item.id, request: 'After it', depends: [dep.id] });
  P.adoptParks();
  assert.deepEqual(pm.unblockDependencies(), [], 'a recorded park is released by its condition or deadline, not asked about');
  assert.ok(!rm.startableTasks().some((x) => x.id === after.id), 'blocked while parked');
  E.parkEvent('gpu-up');
  await P.releaseParks({ gpu: open });
  assert.equal(rm.getTask(dep.id)!.status, 'planned');
  rm.setTask(dep.id, { status: 'merged' });
  assert.ok(rm.startableTasks().some((x) => x.id === after.id), 'proceeds');

  // Held, but for nothing Studio can name (no work, no condition): it would wait for ever, so J gets ONE card saying what clears it.
  const odd = rm.addTask({ item: item.id, request: 'Odd hold' });
  rm.setTask(odd.id, { status: 'idea', note: 'Hold until the moon is right.' });
  rm.addTask({ item: item.id, request: 'Behind odd', depends: [odd.id] });
  assert.equal(P.adoptParks().includes(odd.id), false);
  pm.unblockDependencies();
  pm.unblockDependencies();
  const cards = rm.listQuestions().filter((q) => q.topic === 'stall' && q.text.includes(odd.id));
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /moon is right/, 'it says what the hold was');
});

test('(c) a GPU task whose change ended "already done" is checked against its outcome: done when it is, planned again when not', async () => {
  const ok = rm.addTask({ item: item.id, request: 'Clips', gpu: ITEMS });
  change('c_cccccccccc01', ok.id, 'merged', { verify: { pendingGpu: 'clip: j_1' } });
  change('c_cccccccccc02', ok.id, 'failed', { detail: 'nothing to do: already done (the agent made no commit)', summary: 'Everything is already done.' });
  rm.setTask(ok.id, { status: rm.GPU_WAIT, change: 'c_cccccccccc02', changes: ['c_cccccccccc01', 'c_cccccccccc02'] });
  const dependent = rm.addTask({ item: item.id, request: 'Uses clips', depends: [ok.id] });
  await pm.syncTasks();
  const t = rm.getTask(ok.id)!;
  assert.equal(t.status, 'merged', 'its own merged change proves it: not waiting for GPU');
  assert.ok(rm.landed(t) || t.status === 'merged');
  assert.equal(rm.blockedBy(rm.getTask(dependent.id)!).length, 0, 'the dependent is no longer blocked');
  assert.ok(rm.listDecisions({ action: 'already-done' }).some((d) => d.subject === ok.id));

  // Nothing merged to show it: planned again (not waiting, not failed).
  const no = rm.addTask({ item: item.id, request: 'More clips', gpu: ITEMS });
  change('c_cccccccccc03', no.id, 'failed', { detail: 'nothing to do: already done (the agent made no commit)', summary: 'Already done.' });
  rm.setTask(no.id, { status: rm.GPU_WAIT, change: 'c_cccccccccc03', changes: ['c_cccccccccc03'] });
  await pm.syncTasks();
  assert.equal(rm.getTask(no.id)!.status, 'planned');
});

test('(d) a GPU run that found no GPU waits for the next GPU-capable moment, not a count; a GPU event lets it run', async () => {
  const t = rm.addTask({ item: item.id, request: 'Hero clips', gpu: ITEMS });
  rm.approveGpu(t.id, 1.1, 'J');
  change('c_dddddddddd01', t.id, 'merged', { verify: { pendingGpu: 'clip: j_1' } });
  rm.setTask(t.id, { status: rm.GPU_WAIT, change: 'c_dddddddddd01', changes: ['c_dddddddddd01'], merged_at: Date.now() });
  const [id] = await pm.rerunGpuWaits(2, new Set(), { running: async () => true });
  assert.ok(id, 'a first run starts');
  db.prepare(`UPDATE changes SET status = 'failed', detail = 'No GPU could take the job' WHERE id = ?`).run(id);
  await pm.syncTasks();
  assert.equal(rm.getTask(t.id)!.status, rm.GPU_WAIT);
  assert.equal(P.gpuHeld(t.id), true, 'the condition is recorded');
  assert.equal(pm.gpuReruns(t.id), 0, 'a run that found no GPU is not counted against the three');
  assert.deepEqual(await pm.rerunGpuWaits(2, new Set(), { running: async () => true }), [], 'held: no new run on every pass');
  await new Promise((r) => setTimeout(r, 5));
  E.parkEvent('gpu-up');
  assert.deepEqual(await P.releaseParks({ gpu: open }), [t.id]);
  const [again] = await pm.rerunGpuWaits(2, new Set(), { running: async () => true });
  assert.ok(again, 'it runs again at the next GPU-capable moment');
});

// (e) One verdict on GPU work (gpuverdict.ts): AWS unconfigured is not "GPU down"; low Gen credits park, once.
const V = await import('../src/gpuverdict.ts');
const AWS_OFF = { error: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not in hawkesgen/.env', servers: [] };
const noProviders = async () => { throw new Error('403'); };
const gpuTask = (credits?: number) => {
  const t = rm.addTask({ item: item.id, request: 'Enemy roster art', gpu: ITEMS });
  db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(JSON.stringify({ items: ITEMS, estimate: { gpuHours: 1, cost: 1, withIdleTail: 1, servers: 1, wallMinutes: 10, at: Date.now(), ...(credits ? { credits } : {}) }, budget: 2 }), t.id);
  rm.setTask(t.id, { status: 'planned' });
  return rm.getTask(t.id)!;
};

test('(e) Gen can run via RunPod/Modal and AWS is unconfigured: the task starts, and its brief says GPU is available', async () => {
  V.forgetGpuVerdict();
  const t = gpuTask(500);
  const held = await pm.holdGpuTask(t, { providers: noProviders, fleet: async () => AWS_OFF, balance: async () => 5000 });
  assert.equal(held, false, 'not held: an agent may start');
  assert.equal(P.parkOf(t.id), null);
  const v = V.lastGpuVerdict()!;
  assert.equal(v.running, true);
  assert.equal(v.via, 'no-aws');
  const { gpuBrief } = await import('../src/agents.ts');
  const brief = gpuBrief({ gpu_budget: '2' } as any);
  assert.match(brief, /GPU work can run now/);
  assert.match(brief, /AWS isn't set up/);
  assert.match(brief, /not a\s+decision by J|not a decision by J/);
});

test('(e) credits below the estimate: no agent, parked on credits, one Inbox card; the credits event releases it and it starts', async () => {
  V.forgetGpuVerdict();
  const a = gpuTask(500);
  const b = gpuTask(500);
  const deps = { providers: noProviders, fleet: async () => AWS_OFF, balance: async () => 1 };
  assert.equal(await pm.holdGpuTask(a, deps), true);
  assert.equal(await pm.holdGpuTask(b, deps), true);
  for (const t of [a, b]) {
    assert.equal(P.parkOf(t.id)?.kind, 'credits');
    assert.equal(rm.getTask(t.id)!.status, 'idea', 'parked, never started');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE task = ?`).get(t.id)!.n, 0, 'no agent change');
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE subject = 'gen-credits' AND status IN ('open', 'asked J')`).get()!.n, 1, 'ONE card for J');
  // Still short: the event releases nothing.
  E.parkEvent('credits-added');
  const view = (balance: number) => ({ credits: async (p: any) => !(await V.gpuVerdict(rm.getTask(p.task)!, { ...deps, balance: async () => balance })).short });
  assert.deepEqual(await P.releaseParks(view(1)), []);
  // Credits arrive: both are planned again, and holdGpuTask lets them start.
  V.forgetGpuVerdict();
  E.parkEvent('credits-added');
  assert.deepEqual((await P.releaseParks(view(5000))).sort(), [a.id, b.id].sort());
  assert.equal(rm.getTask(a.id)!.status, 'planned');
  assert.equal(await pm.holdGpuTask(rm.getTask(a.id)!, { ...deps, balance: async () => 5000 }), false);
});
