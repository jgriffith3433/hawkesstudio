// Scouts with no checkout, and stale scouts (sweepScouts): the failure carries git's words, never a bare "worktree: ".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scout-wt-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scout-proj-'));
const { sweepScouts, getScout } = await import('../src/scout.ts');
const { db } = await import('../src/db.ts');
const { PROJECTS } = await import('../src/config.ts');
const { addWorktree } = await import('../src/worktree.ts');

test('a missing checkout fails with git\'s words, not an empty string', async () => {
  const r = await addWorktree(path.join(os.tmpdir(), 'no-such-repo-xyz'), '/tmp/x-wt', ['--detach', '/tmp/x-wt', 'origin/beta'],
    async () => ({ ok: false, out: '', err: '' }), { sleep: async () => {} });
  assert.ok(!r.ok);
  assert.match(r.err, /git ended without a message/);
});

test('sweepScouts fails a scout nobody is running and removes its worktree folder', () => {
  const old = Date.now() - 60 * 60_000;
  db.prepare("INSERT INTO scouts (id, product, question, status, detail, created) VALUES ('x_stale1', 'p', 'q', 'running', 'reading', ?)").run(old);
  const wt = path.join(PROJECTS, '.work', 'scout-x_stale1');
  fs.mkdirSync(wt, { recursive: true });
  assert.deepEqual(sweepScouts(), ['x_stale1']);
  assert.equal(getScout('x_stale1')!.status, 'failed');
  assert.match(getScout('x_stale1')!.detail!, /lost/);
  assert.ok(!fs.existsSync(wt));
});
