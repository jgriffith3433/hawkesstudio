// One way packages are brought up to date (warm.ts ensureInstalled), used by local servers (local.ts ensureServer),
// beta's builds and dev servers (beta.ts ensureDeps) and syncs (repos.ts): an install stamp for another lockfile
// reinstalls, a matching one skips, concurrent calls install once, no lockfile means npm install. Dose Of
// Destruction's beta playtests broke (2026-10-18) because a checkout kept node_modules from before PR #12.
// A fake npm on PATH (logs its calls, writes node_modules), throwaway folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const posix = process.platform !== 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-deps-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
const PORT = 8797;
fs.mkdirSync(path.join(process.env.STUDIO_PROJECTS, 'game'), { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'game', name: 'Game', framing: 'test', engine: 'web', repo: 'game', site: 'game', live: 'http://127.0.0.1:9/',
  local: { serve: 'npm', dir: 'game', port: PORT, path: '/' }, playtests: [], story: [], about: 'A fixture.',
}], repos: {} }));

// The fake npm: copies the lockfile (else package.json) into node_modules/installed.txt, a little slowly.
const bin = path.join(tmp, 'bin');
const calls = path.join(tmp, 'npm-calls.log');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$PWD $*" >> ${calls}
sleep 0.2
rm -rf node_modules && mkdir -p node_modules && (cp package-lock.json node_modules/installed.txt 2>/dev/null || cp package.json node_modules/installed.txt)
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const npmCalls = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

const { ensureInstalled, staleDeps, installedFor, depsHash, INSTALLED } = await import('../src/warm.ts');
const { ensureDeps } = await import('../src/beta.ts');
const { ensureServer } = await import('../src/local.ts');
const { getProduct } = await import('../src/config.ts');

const folder = (name: string, files: Record<string, string>) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(d, f), text);
  return d;
};

test('a stamp for another lockfile installs (and logs it); a matching stamp skips', { skip: !posix }, async () => {
  const d = folder('a', { 'package.json': '{}', 'package-lock.json': '{"lock":2}' });
  // Old packages, stamped for the lockfile before (the checkout kept node_modules from Oct 16).
  fs.mkdirSync(path.join(d, 'node_modules'));
  fs.writeFileSync(path.join(d, 'node_modules', INSTALLED), 'the-old-lockfile');
  assert.equal(staleDeps(d), 'installed for another package-lock.json');
  const logs: string[] = [];
  const n = npmCalls().length;
  const r = await ensureInstalled(d, { log: (s) => logs.push(s) });
  assert.ok(r.ok && r.installed, r.error);
  assert.equal(npmCalls().length, n + 1);
  assert.match(npmCalls().at(-1)!, / ci --no-audit --no-fund$/);
  assert.equal(logs[0], 'dependencies changed: npm ci (installed for another package-lock.json)');
  assert.equal(fs.readFileSync(path.join(d, 'node_modules', 'installed.txt'), 'utf8'), '{"lock":2}');
  assert.equal(installedFor(d), depsHash(d));
  assert.equal(staleDeps(d), null);
  const again = await ensureInstalled(d);
  assert.deepEqual([again.ok, again.installed], [true, false]);
  assert.equal(npmCalls().length, n + 1, 'matching stamp: nothing installs');
});

test('concurrent calls on one folder install once', { skip: !posix }, async () => {
  const d = folder('b', { 'package.json': '{}', 'package-lock.json': '{"lock":3}' });
  const n = npmCalls().length;
  const rs = await Promise.all([ensureInstalled(d), ensureDeps(d).then(() => null), ensureInstalled(d)]);
  assert.equal(npmCalls().length, n + 1);
  assert.deepEqual(rs.filter((r) => r?.installed).length, 1);
});

test('no lockfile: npm install (writing no lockfile), stamped for package.json', { skip: !posix }, async () => {
  const d = folder('c', { 'package.json': '{"name":"c"}' });
  const r = await ensureInstalled(d);
  assert.ok(r.installed);
  assert.match(npmCalls().at(-1)!, / install --no-save --no-package-lock --no-audit --no-fund$/);
  assert.ok(!fs.existsSync(path.join(d, 'package-lock.json')));
  assert.equal(staleDeps(d), null);
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"c","dependencies":{"x":"1"}}');
  assert.equal(staleDeps(d), 'installed for another package.json');
});

test('a failed install is reported and not stamped', { skip: !posix }, async () => {
  const d = folder('d', { 'package.json': '{}', 'package-lock.json': '{"lock":5}' });
  const r = await ensureInstalled(d, { run: async () => ({ ok: false, out: 'npm ERR! notarget No matching version for @noble/curves', ms: 10 }) });
  assert.deepEqual([r.ok, r.installed], [false, false]);
  assert.match(r.error!, /@noble\/curves/);
  assert.equal(installedFor(d), null);
});

test('ensureServer reinstalls a stale checkout before serving it, and logs it', { skip: !posix }, async () => {
  const d = path.join(process.env.STUDIO_PROJECTS!, 'game');
  fs.writeFileSync(path.join(d, 'package.json'), '{}');
  fs.writeFileSync(path.join(d, 'package-lock.json'), '{"lock":"noble"}');
  fs.mkdirSync(path.join(d, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', 'old.txt'), 'from before PR #12');
  // Something already serves the port (not a server Studio started: it isn't stopped).
  const srv = http.createServer((_q, res) => res.end('ok')).listen(PORT, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const logs: string[] = [];
    const n = npmCalls().length;
    const url = await ensureServer(getProduct('game'), (s) => logs.push(s));
    assert.equal(url, `http://localhost:${PORT}/`);
    assert.equal(npmCalls().length, n + 1);
    assert.equal(logs[0], 'game: dependencies changed: npm ci (no record of an install for this package-lock.json)');
    assert.ok(!fs.existsSync(path.join(d, 'node_modules', 'old.txt')));
    await ensureServer(getProduct('game'));
    assert.equal(npmCalls().length, n + 1, 'stamped: the next playtest installs nothing');
  } finally {
    srv.close();
  }
});
