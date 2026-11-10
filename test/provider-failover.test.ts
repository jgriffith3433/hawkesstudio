// Several AI providers at once (J, 2026-11-09: "make sure that it is able to properly fallback to other providers ... the
// studio should be able to use the multiple providers almost seamlessly"). A real Studio with two providers signed in,
// Claude and Codex, both played by test/fixture/fake-claude.mjs; only Claude is limited. A change whose pass hits the
// limit on Claude parks, moves to Codex at once (no waiting for Claude's reset) and finishes there. Claude's billing stop
// is the one thing J must fix, so the Inbox has ONE AI card for it, with a way forward; it goes away by itself once a
// probe answers, and Claude takes work again.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-failover-'));
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
    local: { serve: 'static', dir: 'gamesite', port: 8799, path: '/' }, build: { project: 'game', site: 'gamesite', method: 'Deploy.Build' },
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
  STUDIO_HARNESS_RESUME_GAP_MS: "2000",
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
  // Only Claude is limited: the pass on Claude refuses, the one on Codex works (fake-claude.mjs FAKE_LIMIT_HARNESS).
  FAKE_LIMIT_HARNESS: 'claude',
  // Codex signed in (a kept login, as Settings' sign-in leaves it) and its CLI there (any file: the stand-in runs instead).
  CODEX_CREDS: Buffer.from(JSON.stringify({ '.codex/auth.json': '{"tokens":{}}' })).toString('base64'), CODEX_BIN: process.execPath,
  // The one-harness stand-in is off: what moves the work here is the spread across providers (providers.ts), nothing else.
  STUDIO_HARNESS_FAILOVER: 'off', HOME: path.join(tmp, 'home'),
};
fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
for (const k of ['STUDIO_SERVER', 'HAWKESGEN_KEY', 'STUDIO_BETA_LANE', 'NTFY_TOPIC', 'CURSOR_API_KEY', 'CURSOR_CREDS', 'COPILOT_GITHUB_TOKEN', 'COPILOT_CREDS', 'GEMINI_API_KEY', 'HAWKES_BRAIN', 'STUDIO_PROVIDERS_MODE', 'STUDIO_HARNESS_ORDER', 'CODEX_HOME']) delete env[k];

let studio: ChildProcess | null = null;
let output = '';
async function startStudio() {
  studio = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  studio.stdout!.on('data', (d) => (output += d));
  studio.stderr!.on('data', (d) => (output += d));
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false)), 30_000, 'Studio to start');
}
const api = async (route: string, post?: unknown, click = false) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(click ? { 'X-Studio-Click': '1', 'Sec-Fetch-Site': 'same-origin' } : {}) };
  const r = await fetch(`http://127.0.0.1:${port}${route}`, post === undefined ? undefined : { method: 'POST', headers, body: JSON.stringify(post) });
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

test('a provider that hits its limit hands the work to the next signed-in one, and the Inbox card heals by itself', { timeout: 150_000 }, async () => {
  // Settings → AI providers: Claude first, then Codex; the others switched off (this machine may have them set up).
  const saved = await api('/api/ai/providers', { mode: 'spread', order: ['claude', 'codex'], off: ['cursor', 'copilot', 'antigravity', 'gemini'] }, true);
  assert.equal(saved.mode, 'spread', JSON.stringify(saved));
  let pv = await api('/api/ai/providers');
  assert.deepEqual(pv.providers.filter((x: any) => x.ready).map((x: any) => x.id), ['claude', 'codex'], JSON.stringify(pv.providers));
  // Not J's click (the agent sandbox, Talk, an API key): refused.
  assert.match((await api('/api/ai/providers', { mode: 'one' })).error ?? '', /J's own click/);

  fs.writeFileSync(limitFile, 'unpaid');
  const { change } = await api('/api/changes', { product: 'game', request: 'Make the start button bigger FAKE_LIMIT' });
  let c: any = null;
  await until(async () => (c = await api(`/api/changes/${change}`)).status === 'ready' && passes(change).length >= 2, 90_000, 'it to move to Codex and finish')
    .catch((e) => { throw new Error(why(e, c)); });
  const p = passes(change);
  assert.equal(p[0].harness, 'claude', 'the first pass ran on Claude (first in the order)');
  assert.ok(p.slice(1).every((x) => x.harness === 'codex'), `then Codex took it: ${p.map((x) => x.harness).join(', ')}`);
  assert.equal(p[1].resumed, false, "a new session on Codex: Claude's session can't move between providers");
  assert.ok(logged().some((l) => l.agentLimited && !l.resumed), 'Claude refused the first pass');
  assert.ok(c.log.some((l: string) => /Claude stopped the agent \(billing\)/.test(l)), c.log.join('\n'));
  assert.ok(!c.log.some((l: string) => /failed/.test(l)), 'never failed');
  // What the change shows (J, 2026-11-10: "visualize what model and providers each run and agent is using"): the
  // provider and the model Codex itself reported, and its history: Claude, the park with why, the switch with why.
  assert.equal(c.harness, 'codex');
  assert.equal(c.model, 'codex-fake-model');
  assert.equal(c.model_reported, true);
  const kinds = c.brains.map((e: any) => `${e.kind}:${e.harness}`);
  assert.deepEqual(kinds.slice(0, 5), ['start:claude', 'model:claude', 'park:claude', 'switch:codex', 'model:codex'], kinds.join(' '));
  assert.match(c.brains.find((e: any) => e.kind === 'park').why, /^billing: /);
  assert.match(c.brains.find((e: any) => e.kind === 'switch').why, /^Claude: /, 'the switch says why: Claude is held');
  assert.equal(c.brains.find((e: any) => e.kind === 'model' && e.harness === 'codex').model, 'codex-fake-model');
  // Mid-task recovery: Codex's new session was pointed at where Claude's pass got to.
  assert.match(p[1].prompt, /First read \.hawkes\/handoff\.md/, p[1].prompt);
  // Resources: nothing running now, and no change showing another provider than its job.
  const rs = await api('/api/resources');
  assert.deepEqual(rs.work.mismatches, []);
  assert.ok(Array.isArray(rs.work.runs) && Array.isArray(rs.work.providers));
  pv = await api('/api/ai/providers');
  assert.equal(pv.providers.find((x: any) => x.id === 'claude').ready, false, 'Claude is held');
  assert.equal(pv.providers.find((x: any) => x.id === 'codex').ready, true, 'Codex carries on');

  // Billing is J's to fix: ONE AI card, saying the others carry on, with a way forward (never a dead end).
  let ib = await api('/api/inbox');
  const cards = ib.items.filter((x: any) => x.kind === 'ai');
  assert.equal(cards.length, 1, JSON.stringify(ib.items.map((x: any) => x.id)));
  assert.match(cards[0].title, /^Claude needs you/);
  assert.match(cards[0].text, /Nothing stopped: Codex carries the work/);
  assert.ok(cards[0].options.includes('Check again') && cards[0].options.includes('Stop using Claude'), cards[0].options.join(' | '));
  assert.ok(cards[0].links.some((l: any) => l.url === '#settings/ai'));
  // Still unpaid: Check again says so, and the card stays.
  const still = await api('/api/inbox/answer', { id: 'ai:providers', answer: 'Check again', by: 'J' });
  assert.match(still.error ?? '', /Still stopped/);

  // Paid: Check again probes now, the hold lifts and the card is gone; Claude takes new work again.
  fs.rmSync(limitFile);
  const ok = await api('/api/inbox/answer', { id: 'ai:providers', answer: 'Check again', by: 'J' });
  assert.equal(ok.resolved, true, JSON.stringify(ok));
  ib = await api('/api/inbox');
  assert.equal(ib.items.filter((x: any) => x.kind === 'ai').length, 0, 'healed: the card withdrew');
  pv = await api('/api/ai/providers');
  assert.equal(pv.providers.find((x: any) => x.id === 'claude').ready, true);
  assert.equal((await api('/api/pm')).hold, null, 'all clear');
});
