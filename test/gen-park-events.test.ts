// A parked agent change resumes the moment Gen says its jobs ended (genevents.ts: Gen's GET /v1/events stream), not at
// Studio's next look (it was up to 30 s, and up to 3 minutes for a long wait). Here Studio asks Gen for parked jobs only
// every 10 minutes, so only an event can resume it: one job's end comes as an event, the other ends while the stream is
// down and is caught by the look Studio takes when it reconnects. A real Studio on a scratch data folder, with
// test/fixture/fake-claude.mjs and a stand-in Gen that streams its job events.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genpark-events-'));
const projects = path.join(tmp, 'Projects');
const claudeLog = path.join(tmp, 'claude.jsonl');
fs.mkdirSync(projects, { recursive: true });

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function repo(name: string, files: Record<string, string>) {
  const origin = path.join(tmp, `${name}.git`);
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  const dir = path.join(projects, name);
  git(tmp, 'clone', '--quiet', origin, dir);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'First');
  git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
}
repo('game', { 'README.md': '# Game\n', 'AGENTS.md': 'A fixture game.\n' });
repo('gamesite', { 'index.html': '<h1>Game</h1>\n' });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'data', 'agents.json'), JSON.stringify({ autoMergeBeta: false }));
const productsFile = path.join(tmp, 'products.json');
fs.writeFileSync(productsFile, JSON.stringify({
  repos: { game: 'x/game', gamesite: 'x/gamesite' },
  products: [{
    id: 'game', name: 'Game', framing: 'test', engine: 'unity', repo: 'game', site: 'gamesite', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'gamesite', port: 8796, path: '/' }, build: { project: 'game', site: 'gamesite', method: 'Deploy.Build' },
    playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture game.',
  }],
  infra: [],
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 30_000, what = 'it') {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- Studio's output ---\n${output.slice(-4000)}`);
    await sleep(150);
  }
}
const listen = async (server: http.Server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
};
const body = async (req: http.IncomingMessage) => {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
};
const json = (res: http.ServerResponse, code: number, o: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(o));
};

// Hawkes Gen and GitHub, standing in: Gen knows the parked jobs (their status set by the test), one pull request per change.
const jobs: Record<string, any> = {};
const gets: Record<string, number> = {};
const streams = new Set<http.ServerResponse>();
let connects = 0;
/** Gen's own push: the job's new state to every open stream (GET /v1/events). */
const push = (job: any) => {
  jobs[job.id] = job;
  for (const s of streams) s.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
};
const genServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (url.pathname === '/v1/events') {
    connects++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(': hello\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  await body(req);
  if (url.pathname === '/v1/health') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/v1/tools/')) return json(res, 200, { id: url.pathname.slice(10), version: 1 });
  if (url.pathname === '/v1/jobs') return json(res, 200, { jobs: [] });
  const jm = /^\/v1\/jobs\/([\w-]+)$/.exec(url.pathname);
  if (jm) gets[jm[1]] = (gets[jm[1]] ?? 0) + 1;
  if (jm) return jobs[jm[1]] ? json(res, 200, jobs[jm[1]]) : json(res, 404, { error: 'no such job' });
  json(res, 404, { error: `no ${url.pathname}` });
});
const prs: { number: number; html_url: string; state: string; head: { ref: string } }[] = [];
const githubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const b = await body(req);
  if (/^\/repos\/x\/\w+\/pulls$/.test(url.pathname)) {
    if (req.method === 'POST') {
      const pr = { number: prs.length + 1, html_url: `https://github.test/x/game/pull/${prs.length + 1}`, state: 'open', head: { ref: b.head } };
      prs.push(pr);
      return json(res, 201, pr);
    }
    return json(res, 200, prs.filter((p) => p.state === 'open' && url.searchParams.get('head')?.endsWith(`:${p.head.ref}`)));
  }
  const m = /^\/repos\/x\/\w+\/pulls\/(\d+)$/.exec(url.pathname);
  const pr = m && prs.find((p) => p.number === Number(m[1]));
  if (pr) return json(res, 200, pr);
  json(res, 404, { message: 'Not Found' });
});

const genPort = await listen(genServer);
const githubPort = await listen(githubServer);
const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const env: NodeJS.ProcessEnv = {
  ...process.env,
  STUDIO_PROJECTS: projects, STUDIO_DATA: path.join(tmp, 'data'), STUDIO_PRODUCTS: productsFile, STUDIO_PORT: String(port),
  HAWKESGEN_URL: `http://127.0.0.1:${genPort}`, GEN_PUBLIC_URL: `http://127.0.0.1:${genPort}`, STUDIO_GITHUB_API: `http://127.0.0.1:${githubPort}`, GITHUB_TOKEN: 'test',
  STUDIO_DETACH: 'process', TALK_CLAUDE: process.execPath, TALK_CLAUDE_ARGS: JSON.stringify([path.join(ROOT, 'test', 'fixture', 'fake-claude.mjs')]),
  // One pass may run 5 s here (the floor of the limit): FAKE_HANG's agent is stopped by it.
  FAKE_CLAUDE_LOG: claudeLog, FAKE_AGENT_MS: '200', STUDIO_AGENT_LIMIT_MS: '4000', STUDIO_PM: 'off',
  // A session still open this long after its result is ended (FAKE_LINGER).
  STUDIO_AGENT_GRACE_MS: '1000',
  // Asking Gen for parked jobs is every 10 minutes here: within the test only Gen's events (or the reconnect's look)
  // can resume a change. Talk would hear of a wait after an hour.
  STUDIO_GEN_POLL_MS: '600000', STUDIO_GEN_WAIT_MS: '3600000',
};
for (const k of ['STUDIO_SERVER', 'HAWKESGEN_KEY', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete env[k];

let studio: ChildProcess | null = null;
let output = '';
async function startStudio() {
  studio = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  studio.stdout!.on('data', (d) => (output += d));
  studio.stderr!.on('data', (d) => (output += d));
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false)), 30_000, 'Studio to start');
}
async function restartStudio() {
  const s = studio!;
  s.kill('SIGKILL');
  if (s.exitCode === null) await once(s, 'exit');
  await startStudio();
}
const api = async (route: string, post?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, post === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
  return r.json() as Promise<any>;
};
const logged = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The agent passes Claude Code started for a change (its worktree is .work/<id>). */
const passes = (change: string) => logged().filter((l) => typeof l.agent === 'string' && l.agent.endsWith(change));

after(async () => {
  studio?.kill('SIGKILL');
  for (const s of streams) s.socket?.destroy();
  genServer.closeAllConnections?.();
  genServer.close();
  githubServer.close();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

await startStudio();

test('parked on Gen jobs: an event moves it at once, a reconnect catches what the dropped stream missed, and its session resumes', { timeout: 120_000 }, async () => {
  jobs.j_park1 = { id: 'j_park1', status: 'queued', outputs: [] };
  jobs.j_park2 = { id: 'j_park2', status: 'running', outputs: [] };
  const { change } = await api('/api/changes', { product: 'game', request: 'Portal open and loop clips FAKE_PARK' });
  let c: any = null;
  await until(async () => (c = await api(`/api/changes/${change}`)).status === 'waiting on Gen', 60_000, 'it to park');
  const parkedAt = Date.now();
  // Parked: Studio opens Gen's event stream for it (nothing else waits on Gen here, so it wasn't open before).
  await until(() => streams.size === 1, 30_000, 'Studio to open the event stream');
  // The look when the stream opened: one GET per job. After that only events (the look 5 s after parking finds it done).
  await until(() => (gets.j_park1 ?? 0) >= 1 && (gets.j_park2 ?? 0) >= 1, 30_000, 'the first look');
  await sleep(Math.max(300, parkedAt + 6000 - Date.now()));
  const asked = { ...gets };

  let t0 = Date.now();
  push({ id: 'j_park1', status: 'done', outputs: [{ asset: 'a_open1' }, { asset: 'a_open2' }] });
  await until(async () => /1 of 2 done/.test((c = await api(`/api/changes/${change}`)).detail), 5000, 'the event to count');
  assert.ok(Date.now() - t0 < 5000, `counted in ${Date.now() - t0} ms`);
  assert.deepEqual({ ...gets }, asked, 'from the event itself: no GET');

  // The stream drops; the last job ends while nobody hears. Studio reconnects and asks for its parked jobs once.
  for (const s of streams) s.socket?.destroy();
  jobs.j_park2 = { id: 'j_park2', status: 'failed', outputs: [], error: 'out of memory' };
  t0 = Date.now();
  await until(async () => ['ready', 'failed'].includes((c = await api(`/api/changes/${change}`)).status), 60_000, 'it to resume and finish')
    .catch((e) => { throw new Error(`${e.message}\n${c?.status}: ${c?.detail}\n${c?.log?.slice(-25).join('\n')}`); });
  assert.ok(connects >= 2, 'reconnected');
  assert.equal(c.status, 'ready', `${c.detail}\n${c.log.join('\n')}`);
  assert.ok(c.log.some((l: string) => /Gen jobs finished: j_park1 done \(2 assets\), j_park2 failed/.test(l)), c.log.join('\n'));
  const p = passes(change);
  assert.deepEqual(p.map((x) => x.resumed), [false, true], 'its own session, resumed once');
  assert.match(p[1].prompt, /`j_park1`: done, assets `a_open1`, `a_open2`/);
  assert.match(p[1].prompt, /`j_park2`: failed \(out of memory\)/);
});
