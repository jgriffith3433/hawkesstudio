// A go-live's `git add -A` on a Unity site copy met index.lock held by Studio's own status polls and failed (Sick Of It,
// 2026-10-26). Studio's git runs with no optional locks (a status never takes the lock), a write that meets another git's
// lock waits and tries again, and a lock left for 10+ minutes by a git that died is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-indexlock-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [], repos: {} }));
const { gitAsync } = await import('../src/beta.ts');

const dir = path.join(tmp, 'repo');
spawnSync('git', ['init', '--quiet', '-b', 'main', dir]);
const lock = path.join(dir, '.git', 'index.lock');

test('git status takes no index.lock', async () => {
  fs.writeFileSync(lock, '');
  const r = await gitAsync(dir, ['status', '--porcelain']);
  assert.ok(r.ok, r.err);
  fs.rmSync(lock);
});

test('git add waits for a held index.lock, then succeeds', async () => {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(lock, '');
  setTimeout(() => fs.rmSync(lock, { force: true }), 1_000);
  const r = await gitAsync(dir, ['add', '-A']);
  assert.ok(r.ok, r.err);
});

test('a stale index.lock (10+ min) is removed', async () => {
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(lock, old, old);
  const r = await gitAsync(dir, ['add', '-A']);
  assert.ok(r.ok, r.err);
  assert.ok(!fs.existsSync(lock));
});
