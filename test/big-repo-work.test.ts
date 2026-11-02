// Agent work on a big repo (2026-11-02: every Unity agent change failed "the agent made no commit"). Studio's worktree of a
// big repo is a light, sparse one (repos.ts syncGit); files outside its cone are skip-worktree, so a pass's loose edits
// there were invisible to git status / add. The job now commits leftovers itself (cloudjob-run.ts commitLeftovers), and
// applyWorkspace marks what a pass touched (cloudjob.ts showSparse) so even loose files show up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bigwork-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim();

const { applyWorkspace, packFiles, readPack } = await import('../src/cloudjob.ts');
const { commitLeftovers } = await import('../src/cloudjob-run.ts');
const { uncommitted } = await import('../src/agents.ts');

function sparseRepo(name: string) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'Assets/Scripts'), { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  fs.writeFileSync(path.join(dir, 'Assets/Scripts/Video.cs'), 'old\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'sparse-checkout', 'set', '--cone');
  return dir;
}

test('a loose edit outside the sparse cone is invisible until applyWorkspace marks it', () => {
  const dir = sparseRepo('studio');
  assert.ok(!fs.existsSync(path.join(dir, 'Assets/Scripts/Video.cs')));
  const pack = readPack(packFiles([{ p: 'Assets/Scripts/Video.cs', file: path.join(TMP, 'new.cs') }].filter(() => (fs.writeFileSync(path.join(TMP, 'new.cs'), 'new\n'), true))));
  applyWorkspace(dir, { head: git(dir, 'rev-parse', 'HEAD'), bundle: null, pack });
  assert.match(uncommitted(dir), /Assets\/Scripts\/Video\.cs/);
  // Studio's own safety-net commit (agents.ts commitForAgent) adds with --sparse: plain `add -A` skips paths outside the cone.
  git(dir, 'add', '-A');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  git(dir, 'add', '--sparse', '-A');
  assert.match(git(dir, 'diff', '--cached', '--name-only'), /Video\.cs/);
});

test('the job commits an agent\'s leftover edits (and not its .hawkes notes)', () => {
  const dir = path.join(TMP, 'job');
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'old\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n.hawkes/\n');
  const start = git(dir, 'rev-parse', 'HEAD');
  assert.equal(commitLeftovers(dir, () => {}), false); // nothing to commit
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'fixed\n');
  fs.mkdirSync(path.join(dir, '.hawkes')); fs.writeFileSync(path.join(dir, '.hawkes/summary.md'), 'done');
  assert.equal(commitLeftovers(dir, () => {}), true);
  assert.notEqual(git(dir, 'rev-parse', 'HEAD'), start);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'Assets/V.cs');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});
