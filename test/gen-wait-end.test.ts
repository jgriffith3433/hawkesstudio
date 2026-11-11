// A wait on Gen has an end (stall-paths.md, 2026-11-11): past it, the jobs still unfinished are "timed out" and the
// agent goes on without them, as it does for a failed job. Before, a job Gen lost track of held its change for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen-end-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9'; // Gen doesn't answer
process.env.STUDIO_GEN_WAIT_END_MS = String(3600_000);
process.env.STUDIO_PM = 'off';
const { db, J } = await import('../src/db.ts');
const A = await import('../src/agents.ts');
A.saveAgentSettings({ maxConcurrent: 0 }); // nothing starts: only the wait is under test

test('past the end of the wait, unfinished Gen jobs time out and the change goes back to its agent', async () => {
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt);
  spawnSync('git', ['init', '-q', wt]);
  spawnSync('git', ['-C', wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const mk = (id: string, since: number) => db.prepare('INSERT INTO changes (id, product, findings, status, created, worktree, phase) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'game', '[]', 'waiting on Gen', Date.now(), wt, J({ step: 'agent', since, gen: { since, jobs: [{ id: 'j_done1', status: 'done', assets: [] }, { id: 'j_lost1', status: 'running' }] } }));
  mk('c_genend00001', Date.now() - 2 * 3600_000);
  mk('c_genend00002', Date.now() - 10 * 60_000);
  await A.pollGenWaits({ force: true });
  const over = A.getChange('c_genend00001')!;
  assert.equal(over.status, 'queued', 'over its end: back to the agent');
  const ph = A.phaseOf('c_genend00001')!;
  assert.equal(ph.gen!.jobs.find((j) => j.id === 'j_lost1')!.status, 'timed out');
  assert.match(String(ph.genDone), /j_lost1`: timed out/, 'the agent is told which job never came');
  assert.equal(A.getChange('c_genend00002')!.status, 'waiting on Gen', 'a young wait still waits');
});
