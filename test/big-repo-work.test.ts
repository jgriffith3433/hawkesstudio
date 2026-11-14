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

const { applyWorkspace, packFiles, readPack, replayCommit } = await import('../src/cloudjob.ts');
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

test('a loose edit outside the sparse cone is invisible until applyWorkspace marks it', async () => {
  const dir = sparseRepo('studio');
  assert.ok(!fs.existsSync(path.join(dir, 'Assets/Scripts/Video.cs')));
  const pack = readPack(packFiles([{ p: 'Assets/Scripts/Video.cs', file: path.join(TMP, 'new.cs') }].filter(() => (fs.writeFileSync(path.join(TMP, 'new.cs'), 'new\n'), true))));
  await applyWorkspace(dir, { head: git(dir, 'rev-parse', 'HEAD'), bundle: null, pack });
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

test('a job commit editing a file outside the cone of a blobless sparse clone stages without fetching blobs', async () => {
  // Origin with a crlf rule (git add would read the index's old blob to check it) and a file outside the cone.
  const origin = path.join(TMP, 'origin');
  fs.mkdirSync(path.join(origin, 'Assets/Scripts'), { recursive: true });
  git(origin, 'init', '-q');
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  fs.writeFileSync(path.join(origin, '.gitattributes'), '* text=auto\n');
  fs.writeFileSync(path.join(origin, 'README.md'), 'hi\n');
  fs.writeFileSync(path.join(origin, 'Assets/Scripts/Video.cs'), 'old\n');
  fs.writeFileSync(path.join(origin, 'Assets/Scripts/Gone.cs'), 'bye\n');
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base');
  const dir = path.join(TMP, 'blobless');
  git(TMP, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, dir);
  git(dir, 'sparse-checkout', 'set', '--cone');
  git(dir, 'checkout', '-q', 'main');
  // No credentials: the promisor remote can no longer be reached.
  git(dir, 'remote', 'set-url', 'origin', path.join(TMP, 'nowhere'));
  const a = path.join(TMP, 'a.cs');
  fs.writeFileSync(a, 'new\r\nlines\r\n');
  const commit = { message: 'agent: edit', files: [{ p: 'Assets/Scripts/Video.cs', d: fs.readFileSync(a).toString('base64') }, { p: 'Assets/Scripts/New.cs', d: Buffer.from('n\n').toString('base64') }], deleted: ['Assets/Scripts/Gone.cs'] };
  assert.equal(await replayCommit(dir, commit as any), true);
  assert.equal(git(dir, 'show', '--name-status', '--format=', '--no-renames', 'HEAD').split('\n').sort().join('|'), 'A\tAssets/Scripts/New.cs|D\tAssets/Scripts/Gone.cs|M\tAssets/Scripts/Video.cs');
});

// Bringing a finished job's work back ran every git command synchronously in Studio's server (fetch, reset, clean, one
// hash-object per file): Studio froze for 1.1 s at a time and couldn't answer (studio_ops, 2026-11-14 04:54 UTC).
test("a job's commit of many files comes back as one commit while Studio keeps answering", async () => {
  const dir = sparseRepo('many');
  const files = Array.from({ length: 60 }, (_, i) => ({ p: `Assets/Scripts/F${i}.cs`, d: Buffer.from(`class F${i} {}\n`).toString('base64') }));
  let turns = 0;
  const t = setInterval(() => { turns++; }, 0);
  try {
    const done = replayCommit(dir, { message: 'agent: many', files, deleted: [] });
    assert.ok(done instanceof Promise, 'replayCommit hands the loop back while git runs');
    assert.equal(await done, true);
  } finally {
    clearInterval(t);
  }
  assert.ok(turns > 0, 'timers ran while the commit was made');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').length, 60);
  assert.equal(git(dir, 'show', 'HEAD:Assets/Scripts/F42.cs'), 'class F42 {}');
});

test("Studio's own git calls in cloudjob.ts are all async: the sync one is the job's (cloudjob-run.ts)", () => {
  const src = fs.readFileSync(new URL('../src/cloudjob.ts', import.meta.url), 'utf8');
  const sync = src.split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => /(^|[^\w.])git\(cwd/.test(l) && !/await git\(|gitAsync\(/.test(l));
  // dirtyState is the job's (cloudjob-run.ts collect); Studio uses dirtyStateAsync.
  assert.deepEqual(sync.map((x) => x.l.trim().slice(0, 60)), ["const list = (args: string[]) => git(cwd, ['ls-files', '-z',"]);
  for (const fn of ['applyWorkspace', 'replayCommit', 'showSparse', 'jobSparsePatterns']) {
    assert.match(src, new RegExp(`export async function ${fn}\\(`), `${fn} is async`);
  }
});
