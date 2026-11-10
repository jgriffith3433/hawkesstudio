// The task-speed metric (src/speed.ts): each phase's time from a change's status and step changes, and a task's start to
// beta and to a playtested beta, so "make it faster" is judged by measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-speed-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const S = await import('../src/speed.ts');
await import('../src/agents.ts');
await import('../src/roadmap.ts');
const { db } = await import('../src/db.ts');
const { recordPass } = await import('../src/ledger.ts');

const M = 60_000;

test('each moment of a change counts toward one phase', () => {
  assert.equal(S.phaseOf('queued', null), 'queued');
  assert.equal(S.phaseOf('working', 'prepare'), 'prepare');
  assert.equal(S.phaseOf('working', 'agent'), 'agent');
  assert.equal(S.phaseOf('revising', 'agent'), 'agent');
  assert.equal(S.phaseOf('waiting on Gen', 'agent'), 'gen');
  assert.equal(S.phaseOf('verifying', 'verify'), 'checks');
  assert.equal(S.phaseOf('working', 'publish'), 'publish');
  assert.equal(S.phaseOf('ready', null), 'ready');
  for (const s of ['merged', 'failed', 'cancelled', 'closed']) assert.equal(S.phaseOf(s, 'agent'), null);
  const t = S.phaseTimes([
    { at: 0, status: 'queued', step: null },
    { at: 10 * M, status: 'working', step: 'prepare' },
    { at: 12 * M, status: 'working', step: 'agent' },
    { at: 30 * M, status: 'verifying', step: 'verify' },
    { at: 40 * M, status: 'ready', step: null },
  ], 45 * M);
  assert.deepEqual(t, { queued: 10 * M, prepare: 2 * M, agent: 18 * M, gen: 0, checks: 10 * M, publish: 0, ready: 5 * M });
});

test('the report: medians per phase, a task from its first change to beta and to playtested beta, and the slowest phase', () => {
  const now = Date.now();
  const start = now - 3 * 3600_000;
  for (const [i, agentMin] of [[1, 20], [2, 40], [3, 30]] as const) {
    const id = `c_speed${i}`;
    db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created) VALUES (?, 'game', '[]', 'merged', '', 'game', 's', 'b', 'beta', '/x', 't', '[]', '[]', ?)`).run(id, start);
    db.prepare('UPDATE changes SET task = ?, merged_at = ? WHERE id = ?').run(`t_speed${i}`, start + (15 + agentMin + 10) * M, id);
    S.noteTimeline(id, 'queued', null, start);
    S.noteTimeline(id, 'working', 'prepare', start + 10 * M);
    S.noteTimeline(id, 'working', 'agent', start + 15 * M);
    S.noteTimeline(id, 'verifying', 'verify', start + (15 + agentMin) * M);
    recordPass({ change: id, product: 'game', role: 'builder', harness: 'claude', model: 'sonnet', tier: 'standard', effort: 'medium', retry: 1, ms: agentMin * M, cost: 0, outcome: 'done' });
    db.prepare(`INSERT INTO tasks (id, item, product, title, request, merged_at, verified_at, created) VALUES (?, 'i', 'game', 't', 'r', ?, ?, ?)`)
      .run(`t_speed${i}`, start + (15 + agentMin + 10) * M, i === 3 ? null : start + (15 + agentMin + 40) * M, start - 3600_000);
  }
  const r = S.speedReport(7, now);
  assert.equal(r.tasks.count, 3);
  assert.equal(r.tasks.toBetaMin, 55, 'median of 45, 65, 55 minutes from the first change to beta');
  assert.equal(r.tasks.playtested, 2);
  assert.equal(r.changes.count, 3);
  assert.equal(r.changes.phases.agent, 30);
  assert.equal(r.changes.phases.queued, 10);
  assert.equal(r.changes.phases.checks, 10);
  assert.equal(r.changes.agentMin, 30);
  assert.equal(r.changes.passes, 1);
  assert.equal(r.slowest, 'agent');
  assert.match(S.speedLine(r), /a task takes 55 min from its start to beta \(median of 3/);
  assert.match(S.speedLine(r), /Most of a change's time goes to agent \(30 min median\)/);
});
