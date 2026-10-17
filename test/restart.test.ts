// A Studio restart (a deploy) ends nothing. A real Studio (src/server.ts) on a scratch data folder, with stand-ins for
// Claude Code (test/fixture/fake-claude.mjs), Hawkes Gen and GitHub, is killed and started again: while an agent works,
// while its change waits on a Unity build job, while a run waits on its playtest, and while Talk answers. Each one
// finishes, and nothing is done twice (one agent pass, one build, one playtest, one review, one answer).
//
// STUDIO_DETACH=process: the agent's and Talk's Claude Code run as detached processes (on the server: systemd units of
// the hawkes user), which is what lets them outlive the Studio that started them.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-restart-'));
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
const productsFile = path.join(tmp, 'products.json');
const LIVE = 'http://127.0.0.1:9/';
fs.writeFileSync(productsFile, JSON.stringify({
  repos: { game: 'x/game', gamesite: 'x/gamesite' },
  products: [{
    id: 'game', name: 'Game', framing: 'test', engine: 'unity', repo: 'game', site: 'gamesite', live: LIVE,
    local: { serve: 'static', dir: 'gamesite', port: 8797, path: '/' }, build: { project: 'game', site: 'gamesite', method: 'Deploy.Build' },
    playtests: [{ scenario: 'smoke', where: 'local' }, { scenario: 'smoke', where: 'live' }], story: [], about: 'A fixture game.',
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

// ------------------------------------------------------------ Hawkes Gen, standing in

type Job = { id: string; tool: string; project: string; params: any; status: string; detail: string; result: any; outputs: any[]; cost: number };
const jobs: Job[] = [];
/** Tools whose jobs stay running until released (a Unity build, a playtest that takes a while). */
const held = new Set<string>();
const resultOf = (tool: string, params: any) => ({
  'unity.build': { version: 2, seconds: 120, site: { folder: params.siteDir }, cost: 0 },
  'playtest.run': { outcome: 'passed', seconds: 30, problems: [], fps: { average: 60 } },
  'playtest.review': { verdict: 'ship', summary: 'Works.', findings: [], known: [], scores: {} },
} as Record<string, any>)[tool] ?? {};
const genServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const b = await body(req);
  if (url.pathname === '/v1/health') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/v1/tools/')) return json(res, 200, { id: url.pathname.slice(10), version: 1 });
  if (url.pathname === '/v1/jobs' && req.method === 'POST') {
    const j: Job = { id: `j_${jobs.length + 1}`, tool: b.tool, project: b.project, params: b.params, status: held.has(b.tool) ? 'running' : 'done', detail: '', result: resultOf(b.tool, b.params), outputs: [], cost: 0 };
    jobs.push(j);
    return json(res, 200, { jobs: [j] });
  }
  if (url.pathname === '/v1/jobs') return json(res, 200, { jobs: jobs.filter((j) => j.status === 'running') });
  const m = /^\/v1\/jobs\/(j_\d+)(\/cancel)?$/.exec(url.pathname);
  const j = m && jobs.find((x) => x.id === m[1]);
  if (j && m[2]) j.status = 'cancelled';
  if (j) return json(res, 200, j);
  json(res, 404, { error: `no ${url.pathname}` });
});
const jobsOf = (tool: string) => jobs.filter((j) => j.tool === tool);
const release = (tool: string) => {
  held.delete(tool);
  for (const j of jobsOf(tool)) if (j.status === 'running') j.status = 'done';
};

// ------------------------------------------------------------ GitHub, standing in

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

// ------------------------------------------------------------ Studio, started and killed

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
  FAKE_CLAUDE_LOG: claudeLog, FAKE_AGENT_MS: '5000', FAKE_CLAUDE_SLOW_MS: '900', STUDIO_PM: 'off',
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
/** A restart as a deploy does it, but harder: the process is killed outright. */
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

after(async () => {
  studio?.kill('SIGKILL');
  genServer.close();
  githubServer.close();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

await startStudio();

test('an agent change carries on through restarts: its agent keeps working; a playtest asked for waits for the same build', { timeout: 150_000 }, async () => {
  held.add('unity.build');
  const { change } = await api('/api/changes', { product: 'game', request: 'Make the start button bigger' });
  assert.match(change, /^c_/);
  await until(() => logged().some((l) => l.agent), 30_000, 'the agent to start');
  // What hawkes-pull.mjs asks before a deploy: nothing it has to wait for (the agent survives a restart), one change carried.
  const { busy } = await api('/api/self-deploys?limit=0');
  assert.deepEqual({ run: busy.run, agents: busy.agents, talk: busy.talk, critical: busy.critical }, { run: null, agents: 0, talk: 0, critical: [] });
  assert.equal(busy.carrying.agents, 1);

  // Restart while the agent works (it takes 5 s): it isn't started again; its result is read when it ends.
  await restartStudio();
  let last: any = null;
  const ready = (what: string) => until(async () => (last = await api(`/api/changes/${change}`)).status === 'ready', 60_000, what)
    .catch((e) => { throw new Error(`${e.message}\n--- the change ---\n${last?.status}: ${last?.detail}\n${last?.log?.slice(-25).join('\n')}`); });
  // Ready on the agent's own checks and its pull request: no build, playtest or review unless asked for.
  await ready('the change to be ready without a playtest');
  let c = await api(`/api/changes/${change}`);
  assert.equal(logged().filter((l) => l.agent).length, 1, 'the agent ran once');
  assert.equal(logged().filter((l) => l.agentDone).length, 1);
  assert.equal(prs.length, 1, 'one pull request');
  assert.ok(c.log.some((l: string) => /reattached to hawkes-agent-/.test(l)), 'it says it reattached');
  assert.equal(c.cost, 0.25, 'the pass is counted once');
  assert.equal(jobsOf('unity.build').length, 0, 'not built');
  assert.equal(jobsOf('playtest.run').length, 0, 'not playtested');
  assert.match(c.detail, /not playtested/);
  assert.ok(c.verify.sha, 'the checked commit is on record (approve merges exactly it)');

  // J asks for a playtest: the branch is built (Unity), then played and reviewed.
  const asked = await api(`/api/changes/${change}/playtest`, { by: 'J' });
  assert.equal(asked.status, 'verifying');
  await until(() => jobsOf('unity.build').length === 1, 30_000, 'the build to be submitted');
  // Restart while the change waits on its build: the same Gen job is waited for, not a second build.
  await restartStudio();
  await sleep(2000);
  assert.equal((await api(`/api/changes/${change}`)).status, 'verifying');
  assert.equal(jobsOf('unity.build').length, 1, 'not built again');
  release('unity.build');
  await ready('the change to be ready after its playtest');
  c = await api(`/api/changes/${change}`);
  assert.equal(jobsOf('unity.build').length, 1);
  assert.equal(jobsOf('playtest.run').length, 1, 'one playtest');
  assert.equal(jobsOf('playtest.review').length, 1, 'one review');
  assert.equal(c.verify.outcome, 'passed');
  assert.equal(c.verify.verdict, 'ship');
  assert.equal(c.cost, 0.25);
  assert.equal(prs.length, 1);
  assert.equal(git(path.join(tmp, 'game.git'), 'log', '-1', '--format=%s', c.branch), 'Fix: the start button', 'the branch was pushed');
});

test('a run waiting on its playtest carries on: the same job, its review, no step twice', { timeout: 60_000 }, async () => {
  held.add('playtest.run');
  const before = jobsOf('playtest.run').length;
  const { run } = await api('/api/playtest', { product: 'game', scenario: 'smoke', where: 'live' });
  await until(() => jobsOf('playtest.run').length === before + 1, 20_000, 'the playtest job');
  await until(async () => (await api(`/api/runs/${run}`)).steps?.some((s: any) => s.kind === 'playtest' && s.job), 20_000, 'the step to record its job');

  await restartStudio();
  await sleep(1500);
  assert.equal((await api(`/api/runs/${run}`)).status, 'running', 'still running, not interrupted');
  release('playtest.run');
  await until(async () => (await api(`/api/runs/${run}`)).status !== 'running', 30_000, 'the run to finish');
  const r = await api(`/api/runs/${run}`);
  assert.equal(r.status, 'done');
  assert.equal(jobsOf('playtest.run').length, before + 1, 'played once');
  assert.deepEqual(r.steps.map((s: any) => `${s.kind}:${s.status}`), ['playtest:done', 'review:done']);
});

test('a Talk answer keeps streaming into its conversation after a restart', { timeout: 60_000 }, async () => {
  const c = await api('/api/talk', { message: 'Count slowly please' });
  await until(async () => ((await api(`/api/talk/${c.id}`)).partial ?? '').includes('Two'), 20_000, 'the answer to start');

  await restartStudio();
  await until(async () => (await api(`/api/talk/${c.id}`)).status === 'idle', 30_000, 'the answer to finish');
  const conv = await api(`/api/talk/${c.id}`);
  assert.deepEqual(conv.messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(conv.messages[1].text, 'One. Two. Three. Four. Five. ');
  assert.equal(conv.messages[1].turn?.cost, 0.01);
  assert.equal(conv.session, 'fake-session');
  assert.equal(logged().filter((l) => l.message === 'Count slowly please' || (l.start && l.start.includes('Count slowly please'))).filter((l) => l.start).length, 1, 'Claude Code started once');
});
