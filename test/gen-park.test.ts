// A GPU agent doesn't burn its session waiting on Gen jobs (J, 2026-10-18, q_dda086e2af58: "okay fix it"). It queues
// them, commits its non-GPU work, lists them in .hawkes/waiting-jobs.txt and ends; the change is "waiting on Gen" (not
// failed, no try, no product slot: another change of the product runs meanwhile), Studio polls the jobs (a fake Gen
// here), tells Talk once when they wait too long, survives a restart, and resumes the agent's own session with the
// results once every job has finished. A real Studio on a scratch data folder, with test/fixture/fake-claude.mjs.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genpark-'));
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
const genServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  await body(req);
  if (url.pathname === '/v1/health') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/v1/tools/')) return json(res, 200, { id: url.pathname.slice(10), version: 1 });
  if (url.pathname === '/v1/jobs') return json(res, 200, { jobs: [] });
  const jm = /^\/v1\/jobs\/([\w-]+)$/.exec(url.pathname);
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
  // Parked jobs are polled every 300 ms here, and Talk hears of a wait after 1.5 s.
  STUDIO_GEN_POLL_MS: '300', STUDIO_GEN_WAIT_MS: '1500',
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
  genServer.close();
  githubServer.close();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

/** Starts a change and waits until it's ready or failed. */
async function settle(request: string, during?: (change: string) => Promise<void>) {
  const { change } = await api('/api/changes', { product: 'game', request });
  assert.match(change, /^c_/);
  await during?.(change);
  let c: any = null;
  await until(async () => ['ready', 'failed'].includes((c = await api(`/api/changes/${change}`)).status), 60_000, `${change} to finish`)
    .catch((e) => { throw new Error(`${e.message}\n--- the change ---\n${c?.status}: ${c?.detail}\n${c?.log?.slice(-25).join('\n')}`); });
  return c;
}

await startStudio();

test('an agent parks on its Gen jobs, holds no slot, survives a restart, and its session resumes with the results', { timeout: 120_000 }, async () => {
  jobs.j_park1 = { id: 'j_park1', status: 'queued', outputs: [] };
  jobs.j_park2 = { id: 'j_park2', status: 'running', outputs: [] };
  const { change } = await api('/api/changes', { product: 'game', request: 'Portal open and loop clips FAKE_PARK' });
  let c: any = null;
  await until(async () => (c = await api(`/api/changes/${change}`)).status === 'waiting on Gen', 60_000, 'it to park');
  assert.match(c.detail, /^waiting for GPU jobs \(0 of 2 done\)$/);
  assert.equal(c.commits.length, 1, 'its non-GPU work is committed');
  assert.ok(c.log.some((l: string) => /parked: waiting on 2 Gen job\(s\) \(j_park1, j_park2\)/.test(l)));
  assert.equal(passes(change).length, 1);

  // The product's slot is free: another change runs to ready while this one waits.
  const other = await settle('Make the start button bigger');
  assert.equal(other.status, 'ready', `${other.detail}\n${other.log.join('\n')}`);

  // One job done: still waiting, and the count says so; waiting past the limit tells Talk once.
  jobs.j_park1 = { id: 'j_park1', status: 'done', outputs: [{ asset: 'a_open1' }, { asset: 'a_open2' }] };
  await until(async () => /1 of 2 done/.test((c = await api(`/api/changes/${change}`)).detail), 30_000, 'the count to move');
  await until(async () => (c = await api(`/api/changes/${change}`)).log.some((l: string) => /told Talk: waited/.test(l)), 30_000, 'Talk to be told');
  await sleep(1500);
  c = await api(`/api/changes/${change}`);
  assert.equal(c.log.filter((l: string) => /told Talk: waited/.test(l)).length, 1, 'told once');
  assert.equal(c.status, 'waiting on Gen', "a long wait doesn't fail it");

  await restartStudio();
  assert.equal((await api(`/api/changes/${change}`)).status, 'waiting on Gen', 'still parked after a restart');
  jobs.j_park2 = { id: 'j_park2', status: 'failed', outputs: [], error: 'out of memory' };
  await until(async () => ['ready', 'failed'].includes((c = await api(`/api/changes/${change}`)).status), 60_000, 'it to resume and finish')
    .catch((e) => { throw new Error(`${e.message}\n${c?.status}: ${c?.detail}\n${c?.log?.slice(-25).join('\n')}`); });
  assert.equal(c.status, 'ready', `${c.detail}\n${c.log.join('\n')}`);
  const p = passes(change);
  assert.deepEqual(p.map((x) => x.resumed), [false, true], 'its own session, resumed once');
  assert.match(p[1].prompt, /Your Gen jobs finished/);
  assert.match(p[1].prompt, /`j_park1`: done, assets `a_open1`, `a_open2`\. Your note: portal open clip: judge, then bake/);
  assert.match(p[1].prompt, /`j_park2`: failed \(out of memory\)/);
  assert.equal(c.commits.length, 2, 'the spec, then the baked outputs, on the same branch');
  assert.ok(c.log.some((l: string) => /agent resumed its session with its finished Gen jobs/.test(l)));
});
