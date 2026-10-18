// A GPU agent parks on its Gen jobs instead of waiting in its session (J, 2026-10-18, q_dda086e2af58): the file it
// writes, the prompt that resumes it, and what the roadmap and the PM make of a change "waiting on Gen": the task is
// working with its jobs counted, the item reads "waiting for GPU jobs (n of m done)", no second attempt starts, and
// the product's slot is free. Scratch database, no agents, Gen, GitHub or Claude (test/gen-park.test.ts runs the flow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genwait-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { gw: 'x/gw' },
  products: [{
    id: 'gw', name: 'gw', framing: 'test', engine: 'static', repo: 'gw', site: 'gw', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'gw', port: 8794, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }],
  infra: [],
}));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const agents = await import('../src/agents.ts');
const { db, J } = await import('../src/db.ts');

test('waiting-jobs.txt: one job id per line with its note; bullets, backticks, comments and repeats are fine', () => {
  const jobs = agents.parseWaitingJobs('# my jobs\n- `j_abc123` portal open clip: judge, bake into Art/Portal\nj_def456: scorch decal\n\nj_ghi789 - loop clip\nj_abc123 again\nj_solo\n');
  assert.deepEqual(jobs.map((j) => j.id), ['j_abc123', 'j_def456', 'j_ghi789', 'j_solo']);
  assert.equal(jobs[0].note, 'portal open clip: judge, bake into Art/Portal');
  assert.equal(jobs[1].note, 'scorch decal');
  assert.equal(jobs[2].note, 'loop clip');
  assert.equal(jobs[3].note, '');
  assert.deepEqual(agents.parseWaitingJobs(''), []);
});

test('the resume prompt carries each job: id, status, asset ids, error and the agent\'s own note', () => {
  const p = agents.genDonePrompt({ jobs: [{ id: 'j_1', note: 'bake it', status: 'done', assets: ['a_1', 'a_2'] }, { id: 'j_2', note: 'loop', status: 'failed', error: 'OOM' }] });
  assert.match(p, /Your Gen jobs finished/);
  assert.match(p, /`j_1`: done, assets `a_1`, `a_2`\. Your note: bake it/);
  assert.match(p, /`j_2`: failed \(OOM\)/);
  assert.match(p, /judge the outputs, bake/);
  assert.equal(agents.genProgress({ jobs: [{ id: 'a', note: '', status: 'done' }, { id: 'b', note: '', status: 'running' }, { id: 'c', note: '', status: 'cancelled' }] }), '2 of 3 done');
});

test('a task whose change waits on Gen: working, its jobs counted, no second attempt, and the slot is free', async () => {
  const it = rm.addItem({ product: 'gw', title: "Gloob's portrait loops", status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Portrait loops' });
  const id = 'c_9e0000000001';
  const phase = { step: 'gen', gen: { since: Date.now(), jobs: [{ id: 'j_1', note: '', status: 'done' }, { id: 'j_2', note: '', status: 'running' }, { id: 'j_3', note: '' }] } };
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, phase)
    VALUES (?, 'gw', '[]', ?, 'gw', 'x/gw', 'task/x', 'beta', ?, 'Portrait loops', '[]', '[]', ?, ?, ?, ?)`)
    .run(id, agents.WAITING_GEN, path.join(tmp, 'none'), Date.now(), Date.now(), t.id, J(phase));
  rm.setTask(t.id, { status: 'review', change: id, changes: [id] });
  await pm.syncTasks();
  assert.equal(rm.getTask(t.id)!.status, 'working', 'a parked change is still working (not failed, not ready)');
  const view = rm.listItems({ product: 'gw' }).find((x) => x.id === it.id)!.progress;
  assert.equal(view.label, 'waiting for GPU jobs (1 of 3 done)');
  assert.match(view.tasks[0].waits!, /^GPU jobs \(1 of 3 done/);
  assert.match(pm.startBlocked(t.id) ?? '', /is waiting on Gen/, 'no second attempt while it waits');
  assert.equal(pm.slotHeld('gw'), false, "it doesn't hold the product's slot");
  assert.equal(pm.capacity().active, 0, "nor an agent's");
});
