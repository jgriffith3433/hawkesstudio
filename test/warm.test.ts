// Warm starts and the sandboxed dev server: a worktree's copied node_modules (Vite's cache in it) ends up in the
// worktree's group with group write, whatever the donor's group was, so the sandbox user can rebuild the cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-warm-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });

const { warmDeps } = await import('../src/warm.ts');
const { shareDeps } = await import('../src/local.ts');

const posix = process.platform !== 'win32';
// Another group this user is in (CI runners have several), to stand in for the donor's "hawkes" group.
const other = posix ? process.getgroups!().find((g) => g !== fs.statSync(tmp).gid) : undefined;

/** A node_modules with Vite's cache, group read-only (like a donor made with umask 022). */
function nodeModules(dir: string) {
  const deps = path.join(dir, 'node_modules', '.vite', 'deps');
  fs.mkdirSync(deps, { recursive: true });
  fs.writeFileSync(path.join(deps, 'chunk.js'), '');
  fs.writeFileSync(path.join(dir, 'node_modules', '.hawkes-lock'), '');
  for (const d of [path.join(dir, 'node_modules'), path.join(dir, 'node_modules', '.vite'), deps]) fs.chmodSync(d, 0o755);
  if (other !== undefined) for (const f of [path.join(dir, 'node_modules'), path.join(dir, 'node_modules', '.vite'), deps, path.join(deps, 'chunk.js')]) fs.chownSync(f, process.getuid!(), other);
}

const groupWritable = (dir: string, gid: number) => {
  for (const f of ['node_modules', 'node_modules/.vite', 'node_modules/.vite/deps']) {
    const st = fs.statSync(path.join(dir, f));
    assert.equal(st.mode & 0o070, 0o070, `${f} is group-writable`);
    assert.equal(st.gid, gid, `${f} is in the worktree's group`);
  }
};

test('a warm start gives the copied node_modules to the worktree group, writable', { skip: !posix }, () => {
  const repo = path.join(process.env.STUDIO_PROJECTS!, 'app');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  nodeModules(repo);
  const wt = path.join(process.env.STUDIO_PROJECTS!, '.work', 'c_1');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'c_1')}\n`);
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"lockfileVersion":3}');
  assert.deepEqual(warmDeps(wt, 'app'), ['.']);
  groupWritable(wt, fs.statSync(wt).gid);
});

test('before a sandboxed dev server: an older worktree is fixed, a right one left alone', { skip: !posix }, async () => {
  const wt = path.join(tmp, 'old');
  fs.mkdirSync(wt);
  nodeModules(wt);
  assert.equal(await shareDeps(wt), true);
  groupWritable(wt, fs.statSync(wt).gid);
  assert.equal(await shareDeps(wt), false, 'already right: nothing to do');
  assert.equal(await shareDeps(path.join(tmp, 'none')), false, 'no node_modules: nothing to do');
});
