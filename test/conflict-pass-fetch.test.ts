// The conflict pass in a blobless job clone (J, 2026-11-08: Yooba Land #509 and #510 sat "conflicting" though beta touched
// none of their files): the job brings beta's side in with its token before the agent merges, a fetch or credentials
// failure is never reported as a conflict, and a real conflict names the files both sides changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-conflict-fetch-'));
const J = await import('../src/cloudjob-run.ts');
const A = await import('../src/agents.ts');
const C = await import('../src/cloudjob.ts');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

/** An origin with beta and a feature branch forked from it, and a blobless clone of it on the feature branch. */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  sh(origin, 'init', '-q', '-b', 'beta');
  sh(origin, 'config', 'uploadpack.allowFilter', 'true');
  sh(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  write(origin, 'a.txt', 'a\n'); write(origin, 'b.txt', 'b\n');
  sh(origin, 'add', '.'); sh(origin, 'commit', '-qm', 'base');
  sh(origin, 'checkout', '-q', '-b', 'feature');
  write(origin, 'art/one.png', 'png one\n'); write(origin, 'art/two.png', 'png two\n');
  sh(origin, 'add', '.'); sh(origin, 'commit', '-qm', 'art');
  sh(origin, 'checkout', '-q', 'beta');
  const clone = path.join(root, 'job');
  sh(root, 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${origin}`, clone);
  sh(clone, 'checkout', '-q', '-B', 'feature', 'origin/feature');
  return { origin, clone };
}

test('beta moved in other files: the job pre-merge is clean, with beta fetched and nothing left half-merged', () => {
  const { origin, clone } = setup();
  write(origin, 'b.txt', 'b changed on beta\n'); write(origin, 'new-on-beta.txt', 'x\n');
  sh(origin, 'add', '.'); sh(origin, 'commit', '-qm', 'beta moves');
  const before = sh(clone, 'rev-parse', 'HEAD');
  const r = J.premerge(clone, 'beta', null, () => {});
  assert.equal(r.state, 'clean');
  assert.equal(sh(clone, 'rev-parse', 'HEAD'), before, 'the branch is where it was: the agent makes the real merge');
  assert.equal(fs.existsSync(path.join(clone, '.git', 'MERGE_HEAD')), false);
  // The agent's own merge now works with beta's blobs already here (the remote is no longer needed for it).
  sh(clone, 'remote', 'set-url', 'origin', 'file:///nowhere');
  sh(clone, 'merge', '--no-edit', 'origin/beta');
  assert.equal(fs.readFileSync(path.join(clone, 'b.txt'), 'utf8'), 'b changed on beta\n');
});

test('a branch that already has beta is current', () => {
  const { clone } = setup();
  assert.equal(J.premerge(clone, 'beta', null, () => {}).state, 'current');
});

test('both sides changed the same file: a conflict that names it, and the clone is left clean', () => {
  const { origin, clone } = setup();
  write(origin, 'a.txt', 'beta a\n'); sh(origin, 'add', '.'); sh(origin, 'commit', '-qm', 'beta a');
  write(clone, 'a.txt', 'feature a\n'); sh(clone, 'add', '.'); sh(clone, 'commit', '-qm', 'feature a');
  const lines: string[] = [];
  const r = J.premerge(clone, 'beta', null, (s) => lines.push(s));
  assert.equal(r.state, 'conflict');
  assert.deepEqual(r.files, ['a.txt']);
  assert.match(lines.join('\n'), /conflicts with the branch in a\.txt/);
  assert.equal(fs.existsSync(path.join(clone, '.git', 'MERGE_HEAD')), false);
});

test('a fetch that GitHub refuses is a failure with its reason, never a conflict', () => {
  const { clone } = setup();
  const r = J.premerge(clone, 'beta', null, () => {}, () => ({ status: 128, ok: false, err: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }));
  assert.equal(r.state, 'failed');
  assert.deepEqual(r.files, []);
  assert.match(r.err!, /fetch of origin\/beta/);
  assert.ok(J.authFailed(r.err!), 'so the job asks for a fresh token and tries again');
});

test('a merge that cannot read the other side (no file conflicted) is a failure, not a conflict', () => {
  const { origin, clone } = setup();
  write(origin, 'b.txt', 'moved\n'); sh(origin, 'add', '.'); sh(origin, 'commit', '-qm', 'beta moves');
  let n = 0;
  // The fetch works; the merge dies on a blob the promisor remote would not hand over.
  const run = ((cwd: string, args: string[], token: string | null) => (n++ === 0
    ? { status: 0, ok: true, err: '' }
    : { status: 128, ok: false, err: 'error: could not fetch abc123 from promisor remote\nfatal: could not read Username for \'https://github.com\'' })) as any;
  // The first call pretends to fetch; make beta's commit really present so the ancestry check says "behind".
  sh(clone, 'fetch', '-q', 'origin');
  const r = J.premerge(clone, 'beta', null, () => {}, run);
  assert.equal(r.state, 'failed');
  assert.match(r.err!, /merge of origin\/beta/);
});

test('the base a conflict pass names is read back only when it is a plain branch name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'));
  assert.equal(C.readMergeBase(dir), null);
  write(dir, C.MERGE_BASE_FILE, 'beta\n');
  assert.equal(C.readMergeBase(dir), 'beta');
  write(dir, C.MERGE_BASE_FILE, '--upload-pack=evil\n');
  assert.equal(C.readMergeBase(dir), null);
  write(dir, C.MERGE_BASE_FILE, 'a/../b\n');
  assert.equal(C.readMergeBase(dir), null);
});

test('the conflicting files are the ones both sides changed, not everything the branch touches', () => {
  const branch = Array.from({ length: 15 }, (_, i) => `art/${i}.png`);
  assert.deepEqual(A.overlapOf(branch, ['src/other.ts', 'README.md']), []);
  assert.deepEqual(A.overlapOf([...branch, 'a.txt'], ['b.txt', 'a.txt']), ['a.txt']);
});
