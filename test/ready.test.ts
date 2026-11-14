// "Is this Studio up?" (2026-11-14: J sat on the router's "Opening your studio" page while Studio froze for 2-5 s at a
// time; the page asked /api/health, which asks Gen and reads the agent queue, every 2 s). A cell answers /api/ready
// first: no sign-in, no database, no network, with its X-Studio-Cell header, so the router (server/studio-edge) lets
// people in however busy Studio is. A real Studio (src/server.ts) on a scratch data folder in Cloud Run mode, asked as
// from outside, so the gate applies to everything else.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ready-'));
const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_DATA: tmp, STUDIO_PORT: String(port), STUDIO_CLOUD: '1', STUDIO_SMOKE: '1', STUDIO_MAIL: 'off', STUDIO_SIGNUP: 'owner', STUDIO_PM: 'off', STUDIO_ORG: 'acme-1a2b' };
for (const k of ['STUDIO_SERVER', 'K_SERVICE', 'PORT', 'HAWKESGEN_KEY']) delete env[k];
let studio: ChildProcess | null = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
after(() => { studio?.kill(); studio = null; });
const outside = { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'studio.hawkesgen.ai' };
const end = Date.now() + 30_000;
while (!(await fetch(`http://127.0.0.1:${port}/api/ready`).then((r) => r.ok).catch(() => false))) {
  if (Date.now() > end) throw new Error('Studio did not start');
  await new Promise((r) => setTimeout(r, 200));
}

test('/api/ready answers anyone at once with the cell header and nothing else; the rest still asks for a sign-in', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/ready`, { headers: outside });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-studio-cell'), 'acme-1a2b');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { ok: true }, 'no queue, Gen or loop readout: nothing that reads the database or the network');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: outside })).status, 401);
});

test('it is answered before anything that could wait: the first route the server checks', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf8');
  const body = src.slice(src.indexOf('const server = http.createServer('));
  const ready = body.indexOf("route === '/api/ready'");
  assert.ok(ready > 0, 'server.ts answers /api/ready');
  const firstAwait = body.indexOf('await ');
  assert.ok(ready < firstAwait, 'no await, import or sign-in check runs before /api/ready is answered');
});
