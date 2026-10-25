// A harness that refuses to run (Cursor's unpaid invoice, a usage cap) never fails an agent change or spends its try
// (J, 2026-10-20: "every time I hit usage limits the agents all get canceled out and I lose work and they never start
// again ... It should just recover itself"). The change parks with its worktree and session, the harness is held so the
// next change doesn't start into it, and once a probe answers the parked change resumes its own session and finishes.
// A real Studio on a scratch data folder, with test/fixture/fake-claude.mjs (FAKE_LIMIT) as the harness.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-harnesspark-'));
const projects = path.join(tmp, 'Projects');
const claudeLog = path.join(tmp, 'claude.jsonl');
const limitFile = path.join(tmp, 'limited');
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
    local: { serve: 'static', dir: 'gamesite', port: 8798, path: '/' }, build: { project: 'game', site: 'gamesite', method: 'Deploy.Build' },
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
  // A minute of the hold's backoff is 5 ms here, and the hold is looked at every 200 ms.
  STUDIO_HARNESS_MINUTE_MS: '5', STUDIO_HARNESS_POLL_MS: '200', FAKE_LIMIT_FILE: limitFile,
  // No other harness stands in for the held one: on a machine with Cursor, Copilot or Antigravity set up (the server)
  // a real stand-in would take the parked change and it would start a new session instead of resuming its own.
  STUDIO_HARNESS_FAILOVER: 'off',
};
for (const k of ['STUDIO_SERVER', 'HAWKESGEN_KEY', 'STUDIO_BETA_LANE', 'NTFY_TOPIC', 'CURSOR_API_KEY', 'COPILOT_GITHUB_TOKEN', 'GEMINI_API_KEY', 'HAWKES_BRAIN']) delete env[k];

let studio: ChildProcess | null = null;
let output = '';
async function startStudio() {
  studio = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  studio.stdout!.on('data', (d) => (output += d));
  studio.stderr!.on('data', (d) => (output += d));
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false)), 30_000, 'Studio to start');
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

/** A failed wait with what the change says. */
const why = (e: Error, c: any) => [e.message, `${c?.status}: ${c?.detail}`, ...(c?.log ?? []).slice(-25)].join('\n');

await startStudio();

test('a harness stop parks the change (not failed, not a try), holds the queue, and the change resumes its own session', { timeout: 120_000 }, async () => {
  fs.writeFileSync(limitFile, 'unpaid');
  const { change } = await api('/api/changes', { product: 'game', request: 'Make the start button bigger FAKE_LIMIT' });
  let c: any = null;
  await until(async () => (c = await api(`/api/changes/${change}`)).status === 'queued' && /^waiting for Claude billing/.test(c.detail ?? ''), 60_000, 'it to park')
    .catch((e) => { throw new Error(why(e, c)); });
  assert.ok(c.log.some((l: string) => /Claude stopped the agent \(billing\).*Parked with its worktree and session: not a try/.test(l)));
  assert.equal(passes(change).length, 1);
  const pmState = await api('/api/pm');
  assert.equal(pmState.hold?.held, true, 'studio_pm status shows the hold');
  assert.equal(pmState.hold.holds[0].kind, 'billing');
  assert.deepEqual(pmState.hold.parked.map((x: any) => x.id), [change]);

  // The queue is held: a second change waits instead of starting into the same wall.
  const { change: second } = await api('/api/changes', { product: 'game', request: 'Another small fix' });
  await sleep(1500);
  assert.equal((await api(`/api/changes/${second}`)).status, 'queued');
  assert.equal(passes(second).length, 0, 'no agent started for it while the harness is held');

  // Paid: the next probe answers, the hold lifts, the parked change carries on in its own session and finishes.
  fs.rmSync(limitFile);
  await until(async () => (c = await api(`/api/changes/${change}`)).status === 'ready', 60_000, 'it to resume and finish')
    .catch((e) => { throw new Error(why(e, c)); });
  const p = passes(change);
  assert.deepEqual(p.map((x) => x.resumed), [false, true], 'its own session, resumed once');
  assert.match(p[1].prompt, /cut off because the AI harness stopped answering/);
  assert.ok(!c.log.some((l: string) => /failed/.test(l)), 'never failed');
  assert.match(c.diffstat ?? '', /2 files changed/, 'the half-done work.txt is kept and committed with the fix');
  assert.ok(logged().some((l) => 'probeRefused' in l), 'the probe was refused while the invoice was unpaid');
  await until(async () => (await api(`/api/changes/${second}`)).status === 'ready', 60_000, 'the held change to start and finish');
  assert.equal((await api('/api/pm')).hold, null, 'all clear');
});
