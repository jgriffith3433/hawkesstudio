// Tasks blocked by a task that is an idea or failed sat in "Planned" for days with no agent working (J, 2026-11-03: Yooba
// Land k_b14454bbe903, k_1e22e77e1fb3, k_881cfd303c31 behind k_49f909a23801, an idea whose agents failed on Studio's own
// checkout). The PM plans the dependency again when Studio caused it, asks J once about an idea nobody is planning, and the
// task says who it waits on and why. Scratch database, no agents, GitHub or Claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bdep-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.TALK_CLAUDE = 'no-such-claude-here';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { bdep: 'x/bdep' },
  products: [{
    id: 'bdep', name: 'BDep', framing: 'test', engine: 'static', repo: 'bdep', site: 'bdep', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'bdep', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }],
  infra: [],
}));
const token = process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN = 'test';
after(() => { if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token; fs.rmSync(tmp, { recursive: true, force: true }); });

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const { db, J } = await import('../src/db.ts');
await import('../src/agents.ts'); // makes the changes table
pm.savePmSettings({ maxConcurrent: 50, maxStartsPerDay: 1000 });

const old = Date.now() - 3 * 3600_000;
let n = 0;
const change = (task: string, o: { status: string; detail: string; phase?: any }) => {
  const id = `c_5c1${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, summary, repo, slug, branch, base, worktree, title, notes, log, commits, phase, created, updated, task)
    VALUES (?, 'bdep', '[]', ?, ?, '', 'bdep', 'x/bdep', 'task/x', 'beta', ?, 'A change', '[]', '[]', '[]', ?, ?, ?, ?)`)
    .run(id, o.status, o.detail, path.join(tmp, 'none', id), o.phase ? J(o.phase) : null, old + n, old + n, task);
  return id;
};

test('a task blocked by an idea says who it waits on and why, in words', () => {
  const it = rm.addItem({ product: 'bdep', title: 'Yooba cutscenes', status: 'planned' });
  const dep = rm.addTask({ item: it.id, request: 'Read the camera code' });
  const next = rm.addTask({ item: it.id, request: 'Use it', depends: [dep.id] });
  rm.setTask(dep.id, { status: 'idea', note: 'agents never got the source' });
  const text = rm.waitingOn(rm.getTask(next.id)!);
  assert.match(text, /^waiting on "Read the camera code"/);
  assert.ok(text.includes(dep.id) && /an idea nobody is working on: agents never got the source/.test(text), text);
  assert.equal(rm.taskWaits(rm.getTask(next.id)!), text, 'the roadmap page shows it');
  assert.match(pm.stallReasons().find((r) => r.task === next.id)!.why, /^blocked by "Read the camera code".*never got the source/, 'the stall watch keeps its prefix and gains the reason');
  rm.setTask(dep.id, { status: 'failed', note: 'out of tries' });
  assert.match(rm.waitingOn(rm.getTask(next.id)!), /which failed: out of tries; it won't start until that is fixed/);
  rm.setTask(dep.id, { status: 'working' });
  assert.match(rm.waitingOn(rm.getTask(next.id)!), /\(k_\w+, working\) first/, 'a dependency that is moving is just waited for');
});

test("a dependency Studio failed to run (no source, a clone) is planned again, tries given back; its dependents start after it", () => {
  const it = rm.addItem({ product: 'bdep', title: 'Voice', status: 'planned' });
  const dep = rm.addTask({ item: it.id, request: 'Wire the scene voice' });
  const a = rm.addTask({ item: it.id, request: 'Voice A', depends: [dep.id] });
  const b = rm.addTask({ item: it.id, request: 'Voice B', depends: [dep.id] });
  const c1 = change(dep.id, { status: 'failed', detail: 'the agent made no commit' });
  const c2 = change(dep.id, { status: 'failed', detail: 'source missing: 400 tracked files, but YoobaLand/Assets/X.cs is not on disk (the worktree; not counted as a try)', phase: { step: 'prepare', failed: true } });
  rm.setTask(dep.id, { status: 'idea', tries: 2, change: c2, changes: [c1, c2], note: 'parked' });
  assert.deepEqual(pm.unblockDependencies(), [dep.id]);
  const now = rm.getTask(dep.id)!;
  assert.equal(now.status, 'planned');
  assert.equal(now.tries, 1, 'the agent\'s own failure counts, Studio\'s does not');
  assert.match(now.note!, /Studio could not run its agent/);
  const d = rm.listDecisions({ action: 'unblock' }).find((x) => x.subject === dep.id)!;
  assert.match(d.detail!, /holds up "Voice A".*"Voice B"/);
  assert.ok(d.undo, 'undoable from the PM log');
  assert.ok(rm.blockedBy(rm.getTask(a.id)!).length && rm.blockedBy(rm.getTask(b.id)!).length, 'still waiting for it to merge, now for a task that will run');
  assert.deepEqual(pm.unblockDependencies(), [], 'once');
  assert.equal(rm.listQuestions().length, 0, 'nobody is asked about Studio\'s own failure');
});

test('a dependency whose agent really failed is left to the failed-task path; an idea nobody is planning is one question for J, once', () => {
  const it = rm.addItem({ product: 'bdep', title: 'Camera', status: 'planned' });
  const failed = rm.addTask({ item: it.id, request: 'Camera rig' });
  const after1 = rm.addTask({ item: it.id, request: 'Camera tuning', depends: [failed.id] });
  const c = change(failed.id, { status: 'failed', detail: 'the agent made no commit' });
  rm.setTask(failed.id, { status: 'failed', tries: 3, change: c, changes: [c], note: 'failed 3 times' });
  assert.deepEqual(pm.unblockDependencies(), [], 'the agent\'s own failure is not planned again by the dependents\' pass');
  assert.equal(rm.getTask(failed.id)!.status, 'failed');
  assert.equal(rm.listQuestions().length, 0, 'sweepFailed asks about a failed task, not this pass');

  const idea = rm.addTask({ item: it.id, request: 'Cinemachine setup' });
  const waiting = rm.addTask({ item: it.id, request: 'Cinemachine shots', depends: [idea.id] });
  rm.setTask(idea.id, { status: 'idea', note: 'needs a decision on the rig' });
  pm.unblockDependencies();
  const qs = rm.listQuestions().filter((q) => q.topic === 'stall');
  assert.equal(qs.length, 1);
  assert.ok(qs[0].text.includes(idea.id) && qs[0].text.includes(waiting.id) && /needs a decision on the rig/.test(qs[0].text), qs[0].text);
  pm.unblockDependencies();
  assert.equal(rm.listQuestions().filter((q) => q.topic === 'stall').length, 1, 'filed once, not every tick');
  void after1;
});

test('an idea held for other work is releaseHeldIdeas\'s, and a dependency that no longer exists is taken off', () => {
  const it = rm.addItem({ product: 'bdep', title: 'Held', status: 'planned' });
  const held = rm.addTask({ item: it.id, request: 'Held work' });
  const behind = rm.addTask({ item: it.id, request: 'Behind held', depends: [held.id] });
  rm.setTask(held.id, { status: 'idea', note: 'held until i_000000000000 is on beta' });
  const before = rm.listQuestions().length;
  pm.unblockDependencies();
  assert.equal(rm.listQuestions().length, before, 'no question for a held idea');
  const ghost = rm.addTask({ item: it.id, request: 'Ghost dep' });
  db.prepare('UPDATE tasks SET depends = ? WHERE id = ?').run(J(['k_000000000000']), ghost.id); // a dependency deleted since
  assert.ok(pm.unblockDependencies().includes(ghost.id));
  assert.deepEqual(rm.getTask(ghost.id)!.depends, []);
  void behind;
});
