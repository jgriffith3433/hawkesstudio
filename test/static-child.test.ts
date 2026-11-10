// Static sites are served for playtests by Node (src/static-child.mjs), not python3, which Studio's cloud image doesn't
// have (2026-11-10: "spawn python3 ENOENT", every static site's change playtest failed to start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'static-child.mjs');
const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

test('serves index.html for a folder, files with their type, 404 for missing, nothing outside the folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-child-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  fs.mkdirSync(path.join(dir, 'Game'));
  fs.writeFileSync(path.join(dir, 'Game', 'index.html'), 'game');
  fs.writeFileSync(path.join(dir, 'Game', 'a.wasm'), Buffer.from([0, 97, 115, 109]));
  const port = await freePort();
  const child = spawn(process.execPath, [CHILD, String(port)], { cwd: dir, stdio: 'ignore' });
  try {
    let r: Response | null = null;
    for (let i = 0; i < 50 && !r; i++) { r = await fetch(`http://127.0.0.1:${port}/`).catch(() => null); if (!r) await new Promise((x) => setTimeout(x, 100)); }
    assert.equal(r!.status, 200);
    assert.equal(await r!.text(), '<h1>hi</h1>');
    assert.match(r!.headers.get('content-type')!, /text\/html/);
    const g = await fetch(`http://127.0.0.1:${port}/Game/`);
    assert.equal(await g.text(), 'game');
    const redirect = await fetch(`http://127.0.0.1:${port}/Game`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal((await fetch(`http://127.0.0.1:${port}/Game/a.wasm`)).headers.get('content-type'), 'application/wasm');
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404);
    assert.notEqual((await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`)).status, 200);
  } finally {
    child.kill();
  }
});

test('local.ts never starts python for a static site', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'local.ts'), 'utf8');
  assert.ok(!/spawn\(PYTHON|'http\.server'/.test(src));
});
