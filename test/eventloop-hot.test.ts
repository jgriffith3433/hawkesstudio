// Studio froze for 1.5-3.6 s at a time once 12 agents ran (2026-11-10). The event-loop profiles named the hot spots:
// SQLite compiling the same SQL again on every db.prepare call, pm-state.json and products.json read and parsed on every
// call (per task, a few hundred tasks a pass), a git rev-parse/config per command run synchronously, and Studio forking
// itself for each git command. These tests fail if any of them comes back.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hot-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [], infra: [{ id: 'studio', name: 'Hawkes Studio', repo: 'hawkesstudio' }] }));

const { db, stmtStats, onDbWrite, STMT_CACHE_MAX } = await import('../src/db.ts');
const config = await import('../src/config.ts');
const lock = await import('../src/gitlock.ts');
const spawner = await import('../src/spawner.ts');

test('db.prepare compiles each SQL text once and reuses it', () => {
  db.exec('CREATE TABLE IF NOT EXISTS hot_t (id TEXT PRIMARY KEY, v INTEGER)');
  const sql = 'SELECT v FROM hot_t WHERE id = ?';
  const first = db.prepare(sql);
  const compiles = stmtStats.compiles;
  for (let i = 0; i < 500; i++) db.prepare(sql).get(`x${i}`);
  assert.equal(stmtStats.compiles, compiles, 'the same SQL was compiled again');
  assert.equal(db.prepare(sql), first);
});

test('a cached write statement still tells the write listeners every time', () => {
  const seen: string[] = [];
  const stop = onDbWrite((t) => seen.push(t));
  for (let i = 0; i < 3; i++) db.prepare('INSERT OR REPLACE INTO hot_t (id, v) VALUES (?, ?)').run(`k${i}`, i);
  stop();
  assert.deepEqual(seen, ['hot_t', 'hot_t', 'hot_t']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hot_t').get() as any).n >= 3, true);
});

test('a reused statement sees a schema change', () => {
  db.exec('CREATE TABLE IF NOT EXISTS hot_s (a TEXT)');
  db.prepare('INSERT INTO hot_s (a) VALUES (?)').run('one');
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM hot_s').get() as any), ['a']);
  db.exec('ALTER TABLE hot_s ADD COLUMN b TEXT');
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM hot_s').get() as any), ['a', 'b']);
});

test('the statement cache is bounded', () => {
  for (let i = 0; i < STMT_CACHE_MAX + 50; i++) db.prepare(`SELECT ${i} AS n`).get();
  // The oldest went: compiling it again costs a compile.
  const before = stmtStats.compiles;
  db.prepare('SELECT 0 AS n').get();
  assert.equal(stmtStats.compiles, before + 1);
});

test('loadInfra and loadProducts read products.json once per version of the file', () => {
  const reads = mock.method(fs, 'readFileSync');
  try {
    config.loadInfra();
    const n = reads.mock.callCount();
    for (let i = 0; i < 300; i++) { config.isInfra('studio'); config.loadInfra(); config.loadProducts(); }
    const perCall = (reads.mock.callCount() - n) / 300;
    assert.ok(perCall < 0.05, `products.json read ${perCall} times per call`);
  } finally {
    reads.mock.restore();
  }
  // A changed file is read again.
  fs.writeFileSync(process.env.STUDIO_PRODUCTS!, JSON.stringify({ products: [], infra: [{ id: 'gen', name: 'Hawkes Gen', repo: 'hawkesgen' }] }));
  assert.equal(config.isInfra('gen'), true);
  assert.equal(config.isInfra('studio'), false);
  // Callers get their own copies.
  config.loadInfra()[0].name = 'changed';
  assert.equal(config.loadInfra()[0].name, 'Hawkes Gen');
});

test('repoKey of a checkout and its worktree runs no git', () => {
  const dir = path.join(process.env.STUDIO_PROJECTS!, 'site');
  const g = (...a: string[]) => assert.equal(spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.com', ...a], { cwd: dir }).status, 0);
  fs.mkdirSync(dir, { recursive: true });
  g('init', '-q', '-b', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'one');
  const wt = path.join(tmp, 'wt');
  g('worktree', 'add', '-q', wt);
  assert.equal(lock.commonDirOf(wt), lock.commonDirOf(dir));
  assert.equal(lock.commonDirOf(path.join(dir, 'nothing-here')), path.join(dir, '.git'));
  const viaGit = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: wt, encoding: 'utf8' }).stdout.trim();
  assert.equal(fs.realpathSync(lock.commonDirOf(wt)!), fs.realpathSync(path.resolve(wt, viaGit)));
  assert.equal(lock.repoKey(wt), lock.repoKey(dir));
});

test('git commands start from the spawner, not from Studio itself', async () => {
  spawner.startSpawner();
  // Wait for it to say it's up (its first message).
  for (let i = 0; i < 100 && spawner.spawnerStats.viaHelper === 0; i++) {
    const r = await new Promise<{ code: number | null; out: string }>((ok) => {
      const c = spawner.spawnLight('git', ['--version']);
      let out = '';
      c.stdout.on('data', (d: Buffer) => { out += d; });
      c.on('close', (code: number | null) => ok({ code, out }));
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /git version/);
    if (spawner.spawnerStats.viaHelper === 0) await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(spawner.spawnerStats.viaHelper > 0, 'nothing ran through the spawner');
  // Output, exit codes and kill come back as from spawn.
  const fail = await new Promise<{ code: number | null; err: string }>((ok) => {
    const c = spawner.spawnLight('git', ['no-such-command']);
    let err = '';
    c.stderr.on('data', (d: Buffer) => { err += d; });
    c.on('close', (code: number | null) => ok({ code, err }));
  });
  assert.notEqual(fail.code, 0);
  assert.match(fail.err, /no-such-command/);
  const killed = await new Promise<string | null>((ok) => {
    const c = spawner.spawnLight('sleep', ['30']);
    c.on('close', (_code: number | null, signal: string | null) => ok(signal));
    setTimeout(() => c.kill('SIGKILL'), 100);
  });
  assert.equal(killed, 'SIGKILL');
  spawner.stopSpawner();
});
