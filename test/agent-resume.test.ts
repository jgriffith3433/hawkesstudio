// An agent session that ends with its work uncommitted isn't a failed change (J, 2026-10-18: twice that night an agent
// waiting on a long GPU batch was stopped at Studio's hour limit, and its change failed with "the agent made no commit"
// although the work sat in its worktree). Studio resumes the same session to commit it, at most twice; only an agent
// that changed nothing, or still left it uncommitted after that, fails. A real Studio (src/server.ts) on a scratch data
// folder, with stand-ins for Claude Code (test/fixture/fake-claude.mjs: a word in the request picks how it behaves),
// Hawkes Gen and GitHub; one test restarts Studio while the agent waits, and the time limit still stops it.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-nudge-'));
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

// Hawkes Gen and GitHub, standing in: no jobs are needed here, one pull request per change.
const genServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  await body(req);
  if (url.pathname === '/v1/health') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/v1/tools/')) return json(res, 200, { id: url.pathname.slice(10), version: 1 });
  if (url.pathname === '/v1/jobs') return json(res, 200, { jobs: [] });
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

test('an agent cut off with its work uncommitted is resumed in its own session, commits, and the change is ready', { timeout: 90_000 }, async () => {
  const c = await settle('Make the start button bigger FAKE_STOP');
  assert.equal(c.status, 'ready', `${c.detail}\n${c.log.join('\n')}`);
  const p = passes(c.id);
  assert.equal(p.length, 2, 'the first pass and one resume');
  assert.equal(p[0].resumed, false);
  assert.equal(p[1].resumed, true, 'the same session (claude --resume)');
  assert.match(p[1].prompt, /You stopped before committing/);
  assert.ok(c.log.some((l: string) => /resuming its session to commit it and finish \(1 of 2\)/.test(l)), 'the log says why');
  assert.equal(c.commits.length, 1);
  assert.equal(git(path.join(tmp, 'game.git'), 'show', `${c.branch}:work.txt`).split('\n').length, 1, 'the first pass\'s work is what was committed');
  assert.equal(prs.length, 1, 'one pull request');
});

test('an agent that changed nothing fails as before, with no resume', { timeout: 60_000 }, async () => {
  const c = await settle('Make the start button bigger FAKE_NOTHING');
  assert.equal(c.status, 'failed');
  assert.equal(c.detail, 'the agent made no commit');
  assert.equal(passes(c.id).length, 1, 'never resumed');
  assert.ok(!c.log.some((l: string) => /resuming its session/.test(l)));
});

test('an agent that still leaves its work uncommitted after two resumes fails with a clear reason', { timeout: 90_000 }, async () => {
  const c = await settle('Make the start button bigger FAKE_NEVER');
  assert.equal(c.status, 'failed');
  assert.match(c.detail, /^the agent made no commit: resumed 2× to commit, it still left its work uncommitted \(it is still in the worktree/);
  const p = passes(c.id);
  assert.deepEqual(p.map((x) => x.resumed), [false, true, true], 'the first pass and two resumes, no more');
  assert.ok(fs.existsSync(path.join(projects, '.work', c.id, 'work.txt')), 'the work stays in the worktree');
});

test('a restart while the agent waits: Studio reattaches, its time limit still stops it, and it is resumed to commit', { timeout: 120_000 }, async () => {
  const c = await settle('Make the start button bigger FAKE_HANG', async (change) => {
    await until(() => passes(change).length === 1, 30_000, 'the agent to start');
    await restartStudio();
  });
  assert.equal(c.status, 'ready', `${c.detail}\n${c.log.join('\n')}`);
  const p = passes(c.id);
  assert.deepEqual(p.map((x) => x.resumed), [false, true], 'not started again by the restart; resumed once after the limit');
  assert.ok(c.log.some((l: string) => /reattached to hawkes-agent-/.test(l)), 'it reattached after the restart');
  assert.ok(c.log.some((l: string) => /stopped at its .+ limit for one pass/.test(l)), 'the limit is in the log');
  assert.ok(c.log.some((l: string) => /reached Studio's time limit for one pass, with its work uncommitted/.test(l)));
  assert.equal(c.commits.length, 1);
});

test('an agent that finished but whose background process keeps its session open is ended, and the change carries on', { timeout: 120_000 }, async () => {
  const c = await settle('Make the start button bigger FAKE_LINGER');
  assert.equal(c.status, 'ready', `${c.detail}\n${c.log.join('\n')}`);
  assert.ok(c.log.some((l: string) => /finished, but its session was still open 1 s after its final result/.test(l)), 'the log says why');
  assert.equal(passes(c.id).length, 1, 'not resumed: it had finished');
  assert.equal(c.commits.length, 1);
  const pid = Number(fs.readFileSync(path.join(projects, '.work', c.id, '.hawkes', 'linger.pid'), 'utf8'));
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 30_000, 'its background process to be ended too');
});
