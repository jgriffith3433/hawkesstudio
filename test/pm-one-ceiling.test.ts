// One ceiling for agents at once (J, 2026-11-10: PM status "6 of 4 used"): the PM's own limit is never lower than
// Settings → Agents → At once. Scratch database, no agents run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ceiling-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ repos: {}, products: [], infra: [] }));
const agentsFile = path.join(process.env.STUDIO_DATA, 'agents.json');

await import('../src/agents.ts');
const pm = await import('../src/pm.ts');
const { db } = await import('../src/db.ts');

test('agents 6 and PM 4: the PM ceiling is 6, and 4 running leave free capacity', () => {
  fs.writeFileSync(agentsFile, JSON.stringify({ maxConcurrent: 6 }));
  pm.savePmSettings({ maxConcurrent: 4, maxStartsPerDay: 1000 });
  assert.equal(pm.pmSettings().maxConcurrent, 6);
  const ins = db.prepare("INSERT INTO changes (id, product, findings, status, created, updated) VALUES (?, 'x', '[]', 'queued', 1, 1)");
  const upd = db.prepare('UPDATE changes SET status = ? WHERE id = ?');
  for (let i = 0; i < 4; i++) { ins.run(`c_ceil${i}`); upd.run('working', `c_ceil${i}`); }
  const cap = pm.capacity();
  assert.equal(cap.active, 4);
  assert.equal(cap.maxConcurrent, 6);
  assert.equal(cap.free, 2);
  for (let i = 4; i < 6; i++) { ins.run(`c_ceil${i}`); upd.run('verifying', `c_ceil${i}`); }
  const full = pm.capacity();
  assert.equal(full.active, 6);
  assert.equal(full.free, 0);
  assert.ok(full.active <= full.maxConcurrent, 'never over capacity because Agents allows more');
});

test('a PM limit above Agents stays; saving does not store the raised value', () => {
  fs.writeFileSync(agentsFile, JSON.stringify({ maxConcurrent: 2 }));
  pm.savePmSettings({ maxConcurrent: 5 });
  assert.equal(pm.pmSettings().maxConcurrent, 5);
  fs.writeFileSync(agentsFile, JSON.stringify({ maxConcurrent: 3 }));
  pm.savePmSettings({ maxConcurrent: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'pm.json'), 'utf8')).maxConcurrent, 1);
  assert.equal(pm.pmSettings().maxConcurrent, 3);
});
