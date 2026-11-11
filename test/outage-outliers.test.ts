// Outliers behind the 2026-11-10/11 pile-up, each fixed where it happens (architecture.md section 14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-outliers-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{ id: 'yl', name: 'yl', framing: 'test', engine: 'static', repo: 'yl', site: 'yl', live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: 'yl', port: 8798, path: '/' }, playtests: [], story: [], about: 'A fixture.' }], repos: { yl: 'x/yl' } }));

const agents = await import('../src/agents.ts');
const { contextRefused, modelUnavailable } = await import('../src/models.ts');
const { db } = await import('../src/db.ts');
const MB = 1024 * 1024;

// c_cad9c740157e (Yooba Land, Copilot with claude-sonnet-5.5) failed as "the agent made no commit" when the provider had
// refused the pass: its whole answer was this line. It is the model being out for that provider, not a try.
const REFUSAL = "No response was returned because static system messages and tool definitions exceed this model's context budget.";

test("a provider's \"exceeds this model's context budget\" answer is a refused model, not a failed pass", () => {
  assert.equal(contextRefused(REFUSAL), true);
  assert.equal(contextRefused('Error: prompt is too long for this model'), true);
  assert.equal(contextRefused('context_length_exceeded'), true);
  assert.equal(contextRefused('Done: the ambience crossfades by position.'), false);
  // An agent's long summary that mentions context is its own analysis, not the provider's refusal.
  assert.equal(contextRefused(`${'Checked every clip. '.repeat(40)}The tool definitions exceed this model's context sometimes.`), false);

  const gone = agents.modelRefused({ ok: true, sawResult: true, result: REFUSAL, harness: 'copilot' as any }, { step: 'agent' } as any, 'claude-sonnet-5.5');
  assert.deepEqual(gone, { model: 'claude-sonnet-5.5', harness: 'copilot', why: 'context' });
  assert.equal(modelUnavailable('copilot' as any, 'claude-sonnet-5.5'), true, 'skipped on that provider from now on');
  // Known already: no requeue loop on the same model.
  assert.equal(agents.modelRefused({ ok: true, sawResult: true, result: REFUSAL, harness: 'copilot' as any }, { step: 'agent' } as any, 'claude-sonnet-5.5'), null);
  // A clean pass with a real answer is left alone.
  assert.equal(agents.modelRefused({ ok: true, sawResult: true, result: 'Added the beach bed.', harness: 'copilot' as any }, { step: 'agent' } as any, 'claude-haiku-5'), null);
});

test('the disk room for a worktree counts every checkout under way, so two can never both take the last room', async () => {
  process.env.STUDIO_DISK_SWEEP = 'on';
  const { setDiskSource, setRealDiskSource } = await import('../src/disksweep.ts');
  const { setMemSource } = await import('../src/memgate.ts');
  // A sized in-memory volume of 2.5 GB (cellrun.ts, when Google refuses the disk) with 1.85 GB used: room for one
  // worktree (100 MB) above the volume's floor (256 MB), not two.
  const size = 2560 * MB, used = 2560 * MB - 450 * MB;
  setRealDiskSource(() => false);
  setDiskSource(() => ({ used, free: size - used, size, pct: Math.round((used / size) * 100), path: '/disk' }));
  setMemSource(() => ({ limit: 8192 * MB, available: 4096 * MB }));
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created) VALUES ('c_disk0000001', 'yl', '[]', 'working', '', 'yl', 'x/yl', 'task/d', 'beta', ?, 't', '[]', '[]', ?)`).run(path.join(tmp, 'w1'), Date.now());
  try {
    assert.equal(await agents.diskRoomForCheckouts('c_disk0000001', 1), null, 'alone: room for it');
    assert.match(String(await agents.diskRoomForCheckouts('c_disk0000001', 2)), /disk is full/, 'beside another checkout under way: it waits');
  } finally {
    setDiskSource(null); setRealDiskSource(null); setMemSource(null);
    process.env.STUDIO_DISK_SWEEP = 'off';
  }
  // And the room is checked inside the checkout's turn, not before it.
  const src = fs.readFileSync('src/agents.ts', 'utf8');
  assert.ok(src.includes("await checkoutSlot(() => critical(`making the worktree of ${id}`, async () => {\n          full = await diskRoomForCheckouts(id);"), 'prepare checks the room inside checkoutSlot');
});

test('a write that changes nothing writes nothing (the same status and detail set over and over)', async () => {
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, updated) VALUES ('c_same00000001', 'yl', '[]', 'queued', 'queued: waits for disk room', 'yl', 'x/yl', 'task/s', 'beta', ?, 't', '[]', '[]', 1, 1)`).run(path.join(tmp, 'w2'));
  agents.patchChange('c_same00000001', { status: 'queued', detail: 'queued: waits for disk room' });
  assert.equal((db.prepare('SELECT updated FROM changes WHERE id = ?').get('c_same00000001') as any).updated, 1, 'not rewritten');
  agents.patchChange('c_same00000001', { detail: 'queued: waits for memory to free up' });
  assert.ok((db.prepare('SELECT updated FROM changes WHERE id = ?').get('c_same00000001') as any).updated > 1, 'a real change is written');
});

// c_b866cdd91dca (Nov 8 04:21): its job saved the branch to GitHub (3effdfd), Studio restarted, and the resumed publish
// step failed "worktree missing after restart". A resumed later step now makes the worktree again from the saved branch
// first (worktreeForLaterSteps, 69b9a2b); this replays that case end to end on a local "GitHub".
test('a resumed publish with its worktree gone makes it again from the branch saved on GitHub', async () => {
  const { execFileSync } = await import('node:child_process');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim();
  const origin = path.join(tmp, 'origin-yl.git');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = path.join(process.env.STUDIO_PROJECTS!, 'yl');
  g(tmp, 'clone', '-q', origin, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'base'); g(repo, 'push', '-q', 'origin', 'HEAD:main'); g(repo, 'push', '-q', 'origin', 'HEAD:beta');
  // The job's work, saved on GitHub only (the instance that had the worktree is gone).
  const branch = 'task/b866cdd91dca-climb-kit';
  const elsewhere = path.join(tmp, 'job-machine');
  g(tmp, 'clone', '-q', origin, elsewhere);
  g(elsewhere, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(elsewhere, 'recipes.json'), '{"climb": 12}\n');
  g(elsewhere, 'add', '.'); g(elsewhere, 'commit', '-qm', 'Climb art recipes'); g(elsewhere, 'push', '-q', 'origin', `HEAD:${branch}`);
  const saved = g(elsewhere, 'rev-parse', 'HEAD');
  const worktree = path.join(process.env.STUDIO_PROJECTS!, '.work', 'c_b866cdd91dca');
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, phase) VALUES ('c_b866cdd91dca', 'yl', '[]', 'working', '', 'yl', 'x/yl', ?, 'beta', ?, 'Climb kit', '[]', '[]', ?, ?)`)
    .run(branch, worktree, Date.now(), JSON.stringify({ step: 'publish' }));
  assert.equal(fs.existsSync(worktree), false, 'gone with the old instance');
  assert.equal(await agents.remakeWorktree('c_b866cdd91dca'), true);
  assert.equal(g(worktree, 'rev-parse', 'HEAD'), saved, "made again at the job's saved commit");
  assert.equal(fs.readFileSync(path.join(worktree, 'recipes.json'), 'utf8'), '{"climb": 12}\n');
  // And a resumed publish, verify or finish step does that before the step runs.
  const src = fs.readFileSync('src/agents.ts', 'utf8');
  const body = src.slice(src.indexOf('async function workPass('));
  assert.ok(body.indexOf('await worktreeForLaterSteps(id, ph)') < body.indexOf("if (ph.step === 'publish')"));
});
