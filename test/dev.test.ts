// Developing on beta end to end on throwaway git repos (a temp "Projects" folder with bare origins) and a tiny fake dev
// server: the beta working copy, the /dev/ front door (start page, shim, proxy, HMR websocket), saves auto-committed and
// pushed to beta (never main), a conflict with beta (stopped, told in Talk, kept beta's version), flush before and pull
// after an agent merge, at most N dev servers, and the Unity page. Nothing here touches a real repo or Studio's database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dev-'));
const PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PROJECTS = PROJECTS;
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_DEV_QUIET_MS = '300';
process.env.STUDIO_DEV_WATCH_MS = '3600000'; // the test runs the watcher by hand (devTick)
process.env.STUDIO_DEV_MAX = '1';
process.env.DEV_GEN_KEY = 'hg_test_dev_key';
process.env.SOME_API_KEY = 'must-not-reach-the-dev-server';
fs.mkdirSync(PROJECTS, { recursive: true });

const base = 47100 + Math.floor(Math.random() * 400) * 2;
const product = (id: string, i: number) => ({
  id, name: `Dev ${id}`, framing: 'test', engine: 'web', repo: id, site: id, live: 'http://127.0.0.1:9/',
  local: { serve: 'npm', dir: id, port: base + 900 + i, path: '/' }, playtests: [], story: [], about: 'A fixture.',
  dev: { front: base + i * 2, port: base + i * 2 + 1, path: '/devtools.html' },
});
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [
  product('deva', 0), product('devb', 1),
  { ...product('devunity', 2), engine: 'unity', build: { project: 'devunity', site: 'devunity', method: 'X.Y' }, dev: { front: base + 4 } },
] }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// The fake dev server: serves pages, saves POST /api/save into content/data.json, answers Vite's ping, echoes a websocket.
const SERVER = `import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const s = http.createServer((req, res) => {
  if (req.headers.accept === 'text/x-vite-ping') { res.writeHead(204); return res.end(); }
  if (req.url === '/api/env') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ gen: process.env.HAWKESGEN_URL, key: process.env.HAWKESGEN_KEY ?? null, leaked: process.env.SOME_API_KEY ?? null, host: req.headers.host })); }
  if (req.url === '/api/save' && req.method === 'POST') {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { fs.mkdirSync('content', { recursive: true }); fs.writeFileSync('content/data.json', b); res.writeHead(200); res.end('saved'); });
    return;
  }
  if (req.url === '/Game') { res.writeHead(301, { Location: '/Game/' }); return res.end(); }
  if (req.url === '/devtools.html' || req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><html><head><title>t</title></head><body>devtools</body></html>'); }
  res.writeHead(404); res.end('nope');
});
s.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\nhello ' + req.url); });
s.listen(port, '127.0.0.1');
`;

const origins: Record<string, string> = {};
for (const id of ['deva', 'devb', 'devunity']) {
  const origin = path.join(tmp, `${id}.git`);
  const dir = path.join(PROJECTS, id);
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '--quiet', origin, dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, private: true, type: 'module', scripts: { dev: 'node server.mjs' } }));
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER);
  fs.mkdirSync(path.join(dir, 'content'));
  fs.writeFileSync(path.join(dir, 'content', 'data.json'), '{"v":1}');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'First');
  git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
  origins[id] = origin;
}
const remote = (id: string, ref: string) => git(origins[id], 'rev-parse', ref);
const remoteFile = (id: string, ref: string, file: string) => git(origins[id], 'show', `${ref}:${file}`);

const dev = await import('../src/dev.ts');
const { startFronts, stopFronts } = await import('../src/dev-front.ts');
const { getProduct } = await import('../src/config.ts');
const { db } = await import('../src/db.ts');
startFronts();
const front = (i: number) => `http://127.0.0.1:${base + i * 2}`;
/** A browser page load (fetch can't send Sec-Fetch-Mode: navigate). */
const page = (url: string) => new Promise<string>((resolve, reject) => {
  http.get(url, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve(b));
  }).on('error', reject);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Runs the watcher until the working copy has been quiet long enough to commit. */
const settle = async () => {
  await dev.devTick();
  await sleep(400);
  await dev.devTick();
};

after(async () => {
  await dev.stopDevService();
  stopFronts();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows: the test's database is still open; the temp folder goes with the next temp cleanup.
  }
});

test('the /dev/ front door, the working copy and saves committed to beta', async () => {
  // Opening /dev/ is the start page (it installs the service worker and starts the server).
  assert.match(await page(`${front(0)}/dev/`), /__studio\/sw\.js/);
  let r = await fetch(`${front(0)}/dev/__studio/sw.js`);
  assert.equal(r.headers.get('service-worker-allowed'), '/dev/');
  // Not running yet: subresources get a 503, pages the start page.
  assert.equal((await fetch(`${front(0)}/dev/api/env`)).status, 503);

  const s = await dev.startDev('deva');
  assert.equal(s.status, 'running');
  const wc = path.join(PROJECTS, '.work', 'beta-deva');
  assert.ok(fs.existsSync(path.join(wc, 'server.mjs')), 'the working copy is a checkout of beta');
  assert.equal(git(wc, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev-beta');
  assert.equal(remote('deva', 'beta'), remote('deva', 'main'), 'beta was made from main');

  // Pages get the shim; the dev server sees its own host, Gen and the dev key, and no other keys.
  const html = await page(`${front(0)}/dev/devtools.html`);
  assert.match(html, /<head><script src="\/dev\/__studio\/shim\.js"><\/script>/);
  const env = await (await fetch(`${front(0)}/dev/api/env`)).json();
  assert.equal(env.key, 'hg_test_dev_key');
  assert.equal(env.leaked, null);
  assert.equal(env.host, `127.0.0.1:${base + 1}`);
  assert.match(env.gen, /^http:\/\/127\.0\.0\.1:8790|^http/);
  // The dev-<sub> host (no service worker): the dev server at the root, with the status pill only.
  const rootPage = await new Promise<string>((resolve, reject) => {
    http.get(`${front(0)}/devtools.html`, { headers: { Host: 'dev-deva.localhost', 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  assert.match(rootPage, /shim\.js\?root=1/);
  // Redirects stay inside /dev/; Vite's ping is answered; the HMR websocket reaches the dev server.
  r = await fetch(`${front(0)}/dev/Game`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/dev/Game/');
  assert.equal((await fetch(`${front(0)}/`, { headers: { Accept: 'text/x-vite-ping' } })).status, 204);
  const ws = await new Promise<string>((resolve, reject) => {
    const c = net.connect(base, '127.0.0.1', () => c.write('GET /?token=t HTTP/1.1\r\nHost: deva.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: vite-hmr\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    let got = '';
    c.on('data', (d) => { got += d; if (got.includes('hello')) { c.destroy(); resolve(got); } });
    c.on('error', reject);
    setTimeout(() => reject(new Error(`no websocket answer: ${got}`)), 5000);
  });
  assert.match(ws, /101 Switching Protocols[\s\S]*hello \/\?token=t/);

  // A devtools save lands in the working copy and, after the quiet period, is committed and pushed to beta.
  r = await fetch(`${front(0)}/dev/api/save`, { method: 'POST', body: '{"v":2}' });
  assert.equal(await r.text(), 'saved');
  assert.equal(fs.readFileSync(path.join(wc, 'content', 'data.json'), 'utf8'), '{"v":2}');
  await dev.devTick();
  assert.equal(remoteFile('deva', 'beta', 'content/data.json'), '{"v":1}', 'not committed before the quiet period');
  await sleep(400);
  await dev.devTick();
  assert.equal(remoteFile('deva', 'beta', 'content/data.json'), '{"v":2}');
  assert.equal(git(origins.deva, 'log', '-1', '--format=%s', 'beta'), 'devtools: content/data.json');
  assert.equal(remoteFile('deva', 'main', 'content/data.json'), '{"v":1}', 'main never moves');
  const st = dev.devStatus('deva');
  assert.equal(st.copy?.uncommitted, 0);
  assert.equal(st.copy?.unpushed, 0);
  assert.equal(st.lastCommit?.message, 'devtools: content/data.json');

  // Edits by hand (Talk, J) are committed the same way.
  fs.writeFileSync(path.join(wc, 'notes.md'), 'hi');
  await settle();
  assert.equal(remoteFile('deva', 'beta', 'notes.md'), 'hi');

  // Beta vs live for Talk.
  const since = dev.sinceLive('deva');
  assert.deepEqual(since.commits.map((c) => c.title), ['devtools: notes.md', 'devtools: content/data.json']);
});

test('an agent merge: the working copy is flushed first and pulls after', async () => {
  const wc = path.join(PROJECTS, '.work', 'beta-deva');
  fs.writeFileSync(path.join(wc, 'content', 'data.json'), '{"v":3}');
  const flushed: any = await dev.flushDev('deva', 'before merging c_test');
  assert.ok(flushed.pushed, 'unsaved devtools work is pushed before the merge');
  assert.equal(remoteFile('deva', 'beta', 'content/data.json'), '{"v":3}');
  // The "merge": another clone pushes to beta.
  const other = path.join(tmp, 'other-deva');
  git(tmp, 'clone', '--quiet', '-b', 'beta', origins.deva, other);
  fs.writeFileSync(path.join(other, 'agent.txt'), 'fixed');
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', 'Fix: something (#1)');
  git(other, 'push', '--quiet', 'origin', 'beta');
  const pulled: any = await dev.pullDev('deva', 'after merging c_test');
  assert.equal(pulled.pulled, 1);
  assert.equal(fs.readFileSync(path.join(wc, 'agent.txt'), 'utf8'), 'fixed');
});

test('a conflict with beta stops auto-commit and the dev server, tells J, and keep-beta saves the work', async () => {
  const wc = path.join(PROJECTS, '.work', 'beta-deva');
  const other = path.join(tmp, 'other-deva');
  git(other, 'pull', '--quiet', 'origin', 'beta');
  fs.writeFileSync(path.join(other, 'content', 'data.json'), '{"v":"agent"}');
  git(other, 'commit', '--quiet', '-am', 'Agent changes data');
  git(other, 'push', '--quiet', 'origin', 'beta');
  fs.writeFileSync(path.join(wc, 'content', 'data.json'), '{"v":"devtools"}');
  await settle();
  const st = dev.devStatus('deva');
  assert.deepEqual(st.conflict?.files, ['content/data.json']);
  assert.equal(st.server?.status, 'stopped');
  assert.equal(remoteFile('deva', 'beta', 'content/data.json'), '{"v":"agent"}');
  const notice = db.prepare(`SELECT title, messages FROM conversations WHERE title LIKE 'Beta conflict%'`).get() as any;
  assert.ok(notice, 'J is told in Talk');
  assert.match(notice.messages, /content\/data\.json/);
  await assert.rejects(async () => dev.startDev('deva'), /conflict/);
  await assert.rejects(() => dev.flushDev('deva'), /conflict/);

  const r: any = await dev.resolveDev('deva', 'keep-beta');
  assert.match(r.saved, /^devtools-conflict-\d+$/);
  assert.equal(remoteFile('deva', r.saved, 'content/data.json'), '{"v":"devtools"}', 'the devtools work is kept on a branch');
  assert.equal(fs.readFileSync(path.join(wc, 'content', 'data.json'), 'utf8'), '{"v":"agent"}');
  assert.equal(dev.devStatus('deva').conflict, null);
});

test('at most N dev servers: opening another stops the least recently used', async () => {
  await dev.startDev('deva');
  assert.equal(dev.devStatus('deva').server?.status, 'running');
  await dev.startDev('devb');
  assert.equal(dev.devStatus('devb').server?.status, 'running');
  assert.equal(dev.devStatus('deva').server?.status, 'stopped');
  assert.match(dev.devStatus('deva').server?.detail ?? '', /needed the room/);
  await dev.stopDev('devb');
  assert.equal(dev.devStatus('devb').server?.status, 'stopped');
});

test('Unity products: /dev/ explains the build server', async () => {
  const html = await page(`${front(2)}/dev/`);
  assert.match(html, /build server/);
  assert.match(html, /builder rdp/);
  assert.match(html, /0\.77/);
  await assert.rejects(async () => dev.startDev('devunity'), /Unity/);
  assert.equal(dev.devStatus('devunity').unity, true);
  void getProduct;
});
