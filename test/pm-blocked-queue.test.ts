// A queued change that waits on a sibling holds no agent slot (J, 2026-11-13: "6 of 6 used" with 3 working and 3
// blocked sick-of-it changes while 17 tasks of other products waited). Scratch database, no agents run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-blocked-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ repos: {}, products: [], infra: [] }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 6 }));

await import('../src/agents.ts');
const pm = await import('../src/pm.ts');
const { db } = await import('../src/db.ts');

const ins = db.prepare("INSERT INTO changes (id, product, findings, status, detail, created, updated) VALUES (?, ?, '[]', ?, ?, 1, 1)");

test('waitsOnSibling reads the pump\'s own wait texts', () => {
  assert.ok(pm.waitsOnSibling('queued: waits for c_41a17d745086 (both touch Assets/GameConfig/audio.json)'));
  assert.ok(pm.waitsOnSibling('queued behind c_41a17d745086'));
  assert.ok(!pm.waitsOnSibling('queued: waits for a free agent slot'));
  assert.ok(!pm.waitsOnSibling('queued'));
  assert.ok(!pm.waitsOnSibling(null));
});

test('2 working + 3 blocked in product A leave 4 of 6 slots free for product B', () => {
  pm.savePmSettings({ maxConcurrent: 6, maxStartsPerDay: 1000 });
  for (let i = 0; i < 2; i++) ins.run(`c_a_run${i}`, 'a', 'working', '');
  ins.run('c_a_q0', 'a', 'queued', 'queued: waits for c_a_run0 (both touch Assets/GameConfig/audio.json)');
  ins.run('c_a_q1', 'a', 'queued', 'queued behind c_a_run0');
  ins.run('c_a_q2', 'a', 'queued', 'queued: waits for c_a_run1 (both touch x.json)');
  const cap = pm.capacity();
  assert.equal(cap.active, 2);
  assert.equal(cap.queued, 0);
  assert.equal(cap.blocked, 3);
  assert.equal(cap.free, 4);
  // Product B starts up to the ceiling: 4 more running makes 6.
  for (let i = 0; i < 4; i++) ins.run(`c_b_run${i}`, 'b', 'working', '');
  const full = pm.capacity();
  assert.equal(full.active, 6);
  assert.equal(full.free, 0);
});

test('the wait reason and the limit text report running agents, not blocked ones', () => {
  const why = pm.startWaitReason();
  assert.match(why ?? '', /all 6 agent slots are busy \(6 working\)/);
  assert.doesNotMatch(why ?? '', /queued/);
});

test('a blocker finishing frees its blocked change\'s product line: capacity counts it as queued once its wait text clears', () => {
  db.prepare("UPDATE changes SET status = 'merged' WHERE id = 'c_a_run0'").run();
  db.prepare("UPDATE changes SET detail = 'queued: waits for a free agent slot' WHERE id = 'c_a_q0'").run();
  const cap = pm.capacity();
  assert.equal(cap.active, 5);
  assert.equal(cap.queued, 1);
  assert.equal(cap.blocked, 2);
});
