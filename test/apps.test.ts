// Server apps (products.json "app", src/apps.ts): a product whose beta site is a running server, not files. A tiny
// fixture server in a throwaway repo stands in for the customer portal: beta's commit runs behind the front door, the
// page gets the report button, /c/<change>/ switches this browser to the change's own server, Studio's session cookie
// never reaches the app, and a new beta commit restarts it. No Gen (the fixture has no "gen"), nothing real touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-apps-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(port));
  });
});
const front = await freePort();
const local = await freePort();

fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  products: [{
    id: 'app', name: 'App', framing: 'test', engine: 'web', repo: 'apprepo', site: 'apprepo', live: 'http://127.0.0.1:9/',
    local: { serve: 'app', dir: 'apprepo', port: local, path: '/' }, playtests: [], story: [], about: 'A fixture.',
    dev: { front },
    app: { start: 'node server.mjs', health: '/health', portEnv: 'APP_PORT', dataEnv: 'APP_DATA', urlEnv: 'APP_URL', env: { APP_FLAVOR: 'beta' }, open: '^/play/' },
  }],
  previews: { app: 'app' },
}));

// What the fixture answers: which commit it runs, the env it got, and the cookies it was sent.
const SERVER = (version: string) => `import http from 'node:http';
import fs from 'node:fs';
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  fs.writeFileSync(process.env.APP_DATA + '/seen.txt', req.url);
  if (req.url === '/info') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ version: '${version}', cookie: req.headers.cookie ?? '', url: process.env.APP_URL, flavor: process.env.APP_FLAVOR, key: process.env.HAWKESGEN_KEY ?? null, data: process.env.APP_DATA })); }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><title>t</title></head><body>${version}</body></html>');
}).listen(Number(process.env.APP_PORT), '127.0.0.1');
`;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'apprepo.git');
const dir = path.join(process.env.STUDIO_PROJECTS, 'apprepo');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, dir);
fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER('v1'));
git(dir, 'add', '-A');
git(dir, 'commit', '--quiet', '-m', 'v1');
git(dir, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:beta');

const { buildPreview, listPreviews } = await import('../src/previews.ts');
const { startFronts, stopFronts } = await import('../src/dev-front.ts');
const apps = await import('../src/apps.ts');
const { db } = await import('../src/db.ts');
startFronts();
after(async () => {
  stopFronts();
  for (const a of apps.listApps()) await apps.stopApp(a.product, a.lane);
});

const base = `http://127.0.0.1:${front}`;
const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers: { 'X-Forwarded-Host': 'app.example.com', ...headers }, redirect: 'manual' });

test('beta: the front door runs beta\'s commit, injects the report button, and keeps Studio\'s cookie from the app', async () => {
  const v = await buildPreview('app');
  assert.equal(v?.status, 'ready', v?.detail);
  const page = await (await get('/', { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' })).text();
  assert.match(page, /v1/);
  assert.match(page, /data-hawkes-report/);
  const info = await (await get('/info', { Cookie: 'hawkes_session=secret; mine=1' })).json();
  assert.equal(info.version, 'v1');
  assert.equal(info.cookie, 'mine=1', 'Studio\'s session cookie is stripped');
  assert.equal(info.flavor, 'beta');
  assert.equal(info.key, null, 'no Gen key unless the app asks for one, and never Studio\'s');
  assert.ok(fs.existsSync(info.data), 'its own data folder');
  assert.ok(!info.data.startsWith(path.join(tmp, 'Projects', 'apprepo')), 'outside the checkout');
});

test('a new beta commit restarts it; the old one never answers again', async () => {
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER('v2'));
  git(dir, 'commit', '--quiet', '-am', 'v2');
  git(dir, 'push', '--quiet', 'origin', 'HEAD:beta');
  const v = await buildPreview('app');
  assert.equal(v?.status, 'ready', v?.detail);
  assert.equal((await (await get('/info')).json()).version, 'v2');
  assert.equal(listPreviews()[0].beta?.sha, git(dir, 'rev-parse', '--short=7', 'HEAD'));
});

test('/c/<change>/ switches this browser to the change\'s own server; /c/beta/ goes back', async () => {
  git(dir, 'checkout', '--quiet', '-b', 'task/one');
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER('change'));
  git(dir, 'commit', '--quiet', '-am', 'change');
  git(dir, 'push', '--quiet', 'origin', 'task/one');
  db.prepare('CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, worktree TEXT, branch TEXT, repo TEXT)').run();
  try { db.prepare('INSERT INTO changes (id, worktree, branch, repo) VALUES (?, ?, ?, ?)').run('c_abc123', null, 'task/one', 'apprepo'); } catch (e: any) { assert.fail(`the changes table: ${e.message}`); }
  const v = await buildPreview('app', { change: 'c_abc123' });
  assert.equal(v?.status, 'ready', v?.detail);
  const sw = await get('/c/c_abc123/info');
  assert.equal(sw.status, 302);
  assert.equal(sw.headers.get('location'), '/info');
  const cookie = sw.headers.get('set-cookie')!.split(';')[0];
  assert.equal(cookie, 'hs_lane=c_abc123');
  const on = await (await get('/info', { Cookie: cookie })).json();
  assert.equal(on.version, 'change');
  assert.equal(on.cookie, '', 'the lane cookie stays with Studio');
  const html = await (await get('/', { Cookie: cookie, Accept: 'text/html' })).text();
  assert.match(html, /back to beta/);
  assert.equal((await (await get('/info')).json()).version, 'v2', 'beta still serves everyone else');
  const back = await get('/c/beta/');
  assert.match(back.headers.get('set-cookie')!, /hs_lane=;.*Max-Age=0/);
  assert.equal((await get('/c/c_999/')).status, 404);
});

test('change servers stop when idle; beta keeps running', async () => {
  const stopped = apps.sweepApps(Date.now() + apps.APP_IDLE_MS + 60_000);
  assert.deepEqual(stopped, ['app/c_abc123']);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(apps.appStatus('app', 'beta')?.status, 'running');
  // Opened again: it starts again by itself.
  const again = await (await get('/info', { Cookie: 'hs_lane=c_abc123' })).json();
  assert.equal(again.version, 'change');
});
