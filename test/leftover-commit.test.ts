// The job's "commit the agent's leftover changes" step committed files the agent never touched (c_2d931adecba5, Sick of It,
// 2026-11-03: two shader files a partial clone showed as modified were merged into beta). Only what the agent changed is
// committed; a no-change summary drops Studio's own leftover commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-leftover-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.com', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim();
const { commitLeftovers, dirtyBaseline, realChanges, LEFTOVER_MARK } = await import('../src/cloudjob-run.ts');
const { onlyStudioCommits, saysNoChange, decidedNoChange } = await import('../src/agents.ts');

let n = 0;
function repo() {
  const dir = path.join(TMP, `r${++n}`);
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  sh(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'Assets/A.shader'), 'line1\nline2\n');
  fs.writeFileSync(path.join(dir, 'Assets/B.shader'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'old\n');
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo\n', { mode: 0o755 });
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base');
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n.hawkes/\n');
  return dir;
}

test('files dirty before the agent starts are never committed as its work', () => {
  const dir = repo();
  // The checkout shows two shaders as modified before the agent runs.
  fs.writeFileSync(path.join(dir, 'Assets/A.shader'), 'changed by the checkout\n');
  fs.writeFileSync(path.join(dir, 'Assets/B.shader'), 'also\n');
  const baseline = dirtyBaseline(dir);
  assert.equal(baseline.size, 2);
  const start = sh(dir, 'rev-parse', 'HEAD');
  assert.equal(commitLeftovers(dir, () => {}, undefined, baseline), false, 'the agent changed nothing');
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), start);
  // It then edits one real file (and one of the dirty ones further): only those are committed.
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'new\n');
  fs.writeFileSync(path.join(dir, 'Assets/B.shader'), 'the agent edited this one\n');
  assert.equal(commitLeftovers(dir, () => {}, undefined, baseline), true);
  assert.deepEqual(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['Assets/B.shader', 'Assets/V.cs']);
  assert.match(sh(dir, 'log', '-1', '--format=%B'), new RegExp(LEFTOVER_MARK));
  assert.equal(sh(dir, 'status', '--porcelain'), 'M Assets/A.shader'); // still dirty, never committed (sh trims)
});

test('line-ending, trailing-space and mode-only diffs are not changes', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'Assets/A.shader'), 'line1\r\nline2\r\n'); // CRLF only
  fs.writeFileSync(path.join(dir, 'Assets/B.shader'), 'one  \ntwo\n'); // trailing space only
  fs.chmodSync(path.join(dir, 'run.sh'), 0o644); // mode only
  assert.deepEqual(realChanges(dir), []);
  const start = sh(dir, 'rev-parse', 'HEAD');
  assert.equal(commitLeftovers(dir, () => {}), false);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), start);
  // A real edit in the same file still counts.
  fs.writeFileSync(path.join(dir, 'Assets/A.shader'), 'line1\r\nline2 edited\r\n');
  assert.deepEqual(realChanges(dir), ['Assets/A.shader']);
});

test('a deleted file and a new file are the agent\'s when they were not there at the start', () => {
  const dir = repo();
  const baseline = dirtyBaseline(dir);
  fs.rmSync(path.join(dir, 'Assets/V.cs'));
  fs.writeFileSync(path.join(dir, 'Assets/New.cs'), 'x\n');
  assert.deepEqual(realChanges(dir, baseline).sort(), ['Assets/New.cs', 'Assets/V.cs']);
  assert.equal(commitLeftovers(dir, () => {}, undefined, baseline), true);
});

test('Studio\'s own commits are told from the agent\'s; no-change summaries are recognised', () => {
  const dir = repo();
  const base = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'update-ref', 'refs/remotes/origin/beta', base);
  assert.equal(onlyStudioCommits(dir, 'beta'), false, 'no commits');
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'studio\n');
  assert.equal(commitLeftovers(dir, () => {}), true); // the job's own commit (Studio's identity and trailer)
  assert.equal(onlyStudioCommits(dir, 'beta'), true);
  // The agent amends it (even --no-edit keeps the trailer, but the committer is no longer Studio): its work, never dropped.
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'amended by the agent\n');
  sh(dir, 'commit', '-qa', '--amend', '--no-edit');
  assert.equal(onlyStudioCommits(dir, 'beta'), false, 'an amended Studio commit is the agent\'s');
  sh(dir, 'reset', '-q', '--hard', base);
  // An agent's message that merely quotes the trailer, or has it mid-message, is not Studio's.
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'x\n');
  sh(dir, 'commit', '-qam', `Fix: beta load checks\n\n${LEFTOVER_MARK}: the agent left these changes uncommitted.\n\nMore of the agent's own notes.`);
  assert.equal(onlyStudioCommits(dir, 'beta'), false, 'trailer not last');
  sh(dir, 'reset', '-q', '--hard', base);
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'studio\n');
  sh(dir, 'commit', '-qam', `Work from the agent's pass\n\n${LEFTOVER_MARK}: the agent left these changes uncommitted.`);
  assert.equal(onlyStudioCommits(dir, 'beta'), false, 'the trailer typed by someone else (t@t.com)');
  sh(dir, 'reset', '-q', '--hard', base);
  assert.equal(onlyStudioCommits(dir, 'beta'), false, 'no commits');
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'studio\n');
  assert.equal(commitLeftovers(dir, () => {}), true);
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'agent\n');
  sh(dir, 'commit', '-qam', 'Fix: the real one');
  assert.equal(onlyStudioCommits(dir, 'beta'), false, 'one commit is the agent\'s own');
  assert.ok(saysNoChange('I made no change: 2 shader files already showed as modified before I started.'));
  assert.ok(saysNoChange('Nothing to change here.'));
  assert.ok(!saysNoChange('Fixed the shader and added a test.'));
  assert.ok(decidedNoChange("J already decided this is won't fix, so I changed nothing."));
});
