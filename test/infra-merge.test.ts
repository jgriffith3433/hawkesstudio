// These tests fake GitHub's check runs: the CI wait is on for them (ciChecks reads it per call).
process.env.STUDIO_GITHUB_CI = '1';
// Studio/Gen merges into main when main moved (J, 2026-10-18: a Studio change failed with "405 Pull Request has merge
// conflicts" because PR #42 merged first, and J had to ask for a revise). On J's approval the branch is brought up to
// date with main first: a clean merge is pushed and merges once CI on it is green (his approval stands meanwhile); red
// CI never merges; a real conflict resumes the change's agent (a conflict pass, not a try), then it merges once green.
// Real git (a bare origin with main), GitHub faked over HTTP (pull requests, merges, check runs), Claude Code faked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-infra-merge-'));
const projects = path.join(tmp, 'Projects');
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
const origin = path.join(tmp, 'tool.git');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
const repoDir = path.join(projects, 'tool');
git(tmp, 'clone', '--quiet', origin, repoDir);
fs.writeFileSync(path.join(repoDir, 'menu.txt'), 'Start\n');
fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'A fixture service.\n');
fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
// What the smoke check starts: health ok, a dashboard page, one script.
fs.writeFileSync(path.join(repoDir, 'server.mjs'), `import http from 'node:http';
http.createServer((q, s) => q.url === '/health' ? s.end('{"ok":true}') : s.end('<html>tool</html>')).listen(Number(process.env.TOOL_PORT), '127.0.0.1');
`);
fs.mkdirSync(path.join(repoDir, 'dashboard'));
fs.writeFileSync(path.join(repoDir, 'dashboard', 'app.js'), 'export const ok = 1;\n');
git(repoDir, 'add', '-A');
git(repoDir, 'commit', '--quiet', '-m', 'First');
git(repoDir, 'push', '--quiet', 'origin', 'HEAD:main');

// A second clone: "another Studio change" landing on main.
const other = path.join(tmp, 'other');
git(tmp, 'clone', '--quiet', '-b', 'main', origin, other);
function mainMoves(file: string, text: string) {
  git(other, 'pull', '--quiet', 'origin', 'main');
  fs.writeFileSync(path.join(other, file), text);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', `Another change: ${file}`);
  git(other, 'push', '--quiet', 'origin', 'HEAD:main');
}

// GitHub: one open pull request per branch, its head what origin has. CI on a commit is green unless its branch is in
// `redCi` and the commit isn't the agent's own (the merge of main Studio pushed). A merge refuses a head it wasn't given.
const merges: { branch: string; sha: string }[] = [];
const prBranch = new Map<number, string>();
const redCi = new Set<string>();
const agentSha = new Map<string, string>();
const tip = (branch: string) => spawnSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: origin, encoding: 'utf8' }).stdout.trim();
const listen = async (server: http.Server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
};
const github = http.createServer(async (req, res) => {
  let s = '';
  for await (const c of req) s += c;
  const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const url = new URL(req.url!, 'http://x');
  const checks = /^\/repos\/x\/tool\/commits\/([0-9a-f]+)\/check-runs$/.exec(url.pathname);
  if (checks) {
    const branch = [...prBranch.values()].find((b) => tip(b) === checks[1]);
    const red = branch && redCi.has(branch) && agentSha.get(branch) !== checks[1];
    return json(200, { check_runs: [{ name: 'test', status: 'completed', conclusion: red ? 'failure' : 'success', html_url: 'https://ci.test' }] });
  }
  const m = /^\/repos\/x\/tool\/pulls\/(\d+)(\/merge)?$/.exec(url.pathname);
  if (m) {
    const n = Number(m[1]);
    const branch = prBranch.get(n)!;
    const head = tip(branch);
    if (m[2] === '/merge' && req.method === 'PUT') {
      const body = JSON.parse(s);
      if (body.sha !== head) return json(409, { message: 'Head branch was modified' });
      // GitHub's own refusal when main moved under the branch and it conflicts.
      if (spawnSync('git', ['merge-base', '--is-ancestor', 'refs/heads/main', head], { cwd: origin }).status !== 0) return json(405, { message: 'Pull Request has merge conflicts' });
      merges.push({ branch, sha: head });
      return json(200, { merged: true, sha: 'f'.repeat(40) });
    }
    if (req.method === 'PATCH') return json(200, { number: n });
    return json(200, { number: n, state: 'open', merged: false, head: { sha: head, ref: branch }, html_url: `https://github.test/x/tool/pull/${n}` });
  }
  if (/^\/repos\/x\/tool\/pulls$/.test(url.pathname)) {
    const head = url.searchParams.get('head')?.split(':')[1];
    const n = [...prBranch].find(([, b]) => b === head)?.[0];
    return json(200, n ? [{ number: n, html_url: `https://github.test/x/tool/pull/${n}` }] : []);
  }
  if (req.method === 'DELETE') return json(204, {});
  json(404, { message: 'not faked' });
});
const githubPort = await listen(github);
after(() => github.close());

process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = projects;
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_GITHUB_API = `http://127.0.0.1:${githubPort}`;
process.env.GITHUB_TOKEN = 'test';
process.env.STUDIO_DETACH = 'process';
process.env.TALK_CLAUDE = process.execPath;
process.env.TALK_CLAUDE_ARGS = JSON.stringify([path.join(ROOT, 'test', 'fixture', 'fake-claude.mjs')]);
process.env.FAKE_AGENT_MS = '50';
process.env.STUDIO_PM = 'off';
for (const k of ['STUDIO_SERVER', 'HAWKESGEN_KEY', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.writeFileSync(path.join(tmp, 'data', 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(tmp, 'data', 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { tool: 'x/tool' },
  products: [],
  infra: [{
    id: 'tool', name: 'Tool', repo: 'tool', slug: 'x/tool', about: 'A fixture service.', checks: ['node -e 0'],
    smoke: { start: 'server.mjs', portEnv: 'TOOL_PORT', dataEnv: 'TOOL_DATA', health: '/health', scripts: 'dashboard' },
  }],
}));

const { db, J } = await import('../src/db.ts');
const agents = await import('../src/agents.ts');
const { getChange, approve } = agents;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 60_000, what = 'it') {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

let n = 0;
/** A ready Studio change: its agent changed menu.txt on its own branch from main, pushed, pull request open, CI green. */
function readyChange(text: string) {
  n++;
  const id = `c_1f7a0000000${n}`;
  const branch = `task/${id}`;
  const wt = path.join(projects, '.work', id);
  git(repoDir, 'fetch', '--quiet', 'origin');
  git(repoDir, 'worktree', 'add', '--quiet', '-b', branch, wt, 'origin/main');
  fs.writeFileSync(path.join(wt, 'menu.txt'), text);
  git(wt, 'add', '-A');
  git(wt, 'commit', '--quiet', '-m', `Change ${n}`);
  git(wt, 'push', '--quiet', 'origin', `HEAD:${branch}`);
  // Packages are installed already (npmCi: no lockfile here).
  fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules', '.hawkes-lock'), 'none');
  prBranch.set(n, branch);
  const sha = git(wt, 'rev-parse', 'HEAD');
  agentSha.set(branch, sha);
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, request, pr, pr_url, title, verify, notes, log, created, session)
    VALUES (?, 'tool', '[]', 'ready', 'passed', 'tool', 'x/tool', ?, 'main', ?, ?, ?, ?, ?, ?, '[]', '[]', ?, 'fake-agent-session')`)
    .run(id, branch, wt, `Change the menu ${n}`, n, `https://github.test/x/tool/pull/${n}`, `Change ${n}`, J({ kind: 'infra', sha, outcome: 'passed', summary: 'CI green', ci: { state: 'success' } }), Date.now());
  return { id, wt, branch };
}
const merged = (branch: string) => merges.find((x) => x.branch === branch);

test('main up to date: approving merges at once, as before', async () => {
  const c = readyChange('Begin\n');
  const r = await approve(c.id, { confirm: `MERGE ${c.id}`, by: 'J' });
  assert.equal(r!.status, 'merged');
  assert.equal(merged(c.branch)?.sha, agentSha.get(c.branch));
});

test('main moved without touching the same files: brought up to date, and it merges on J\'s approval once CI is green', async () => {
  const c = readyChange('Start now\n');
  mainMoves('credits.txt', 'Thanks\n');
  const r = await approve(c.id, { confirm: `MERGE ${c.id}`, by: 'J' });
  assert.equal(r!.status, 'ready', 'not merged before CI on the updated branch');
  assert.match(r!.detail!, /main moved: merged it into the branch \(no conflicts\); merging into main once CI/);
  assert.ok(getChange(c.id)!.approved, 'J\'s approval stands meanwhile');
  await until(() => getChange(c.id)!.log.some((l) => /merged into main on J's approval once CI was green/.test(l)), 30_000, 'the merge once CI is green');
  assert.equal(getChange(c.id)!.status, 'merged');
  const m = merged(c.branch)!;
  assert.notEqual(m.sha, agentSha.get(c.branch), 'what merged is the branch with main in it');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', 'refs/heads/main', m.sha], { cwd: origin }).status, 0);
  assert.equal(getChange(c.id)!.approved ?? null, null);
  const told = db.prepare(`SELECT 1 FROM conversations WHERE messages LIKE ?`).get(`%${c.id}%merged into main on your approval%`);
  assert.ok(told, 'one line in Talk');
});

test('red CI on the updated branch never merges: the approval is dropped and J hears why', async () => {
  const c = readyChange('Go\n');
  redCi.add(c.branch);
  mainMoves('about.txt', 'About\n');
  const r = await approve(c.id, { confirm: `MERGE ${c.id}`, by: 'J' });
  assert.equal(r!.status, 'ready');
  await until(() => !getChange(c.id)!.approved, 30_000, 'CI to fail');
  const x = getChange(c.id)!;
  assert.equal(x.status, 'ready');
  assert.match(x.detail!, /isn't green .*red CI never merges/);
  assert.ok(!merged(c.branch), 'nothing merged into main');
  const told = db.prepare(`SELECT 1 FROM conversations WHERE messages LIKE ?`).get(`%${c.id}%didn't merge into main%`);
  assert.ok(told, 'one line in Talk');
});

test("a real conflict with main: its agent resolves it (not a try), and it merges once that is checked and green", { timeout: 120_000 }, async () => {
  const c = readyChange('Play\n');
  mainMoves('menu.txt', 'Launch\n');
  const r = await approve(c.id, { confirm: `MERGE ${c.id}`, by: 'J' });
  assert.equal(r!.status, 'revising', 'its agent is on it');
  assert.equal(r!.conflicts, 1);
  assert.ok(getChange(c.id)!.approved, 'J\'s approval stands through the conflict pass');
  await until(() => getChange(c.id)!.status === 'merged', 90_000, 'the conflict pass, its checks and the merge');
  const done = getChange(c.id)!;
  assert.ok(done.log.some((l) => /agent resumed to resolve the conflicts with main/.test(l)), done.log.join('\n'));
  assert.ok(done.log.some((l) => /smoke: ok/.test(l)), 'checked again after the conflict pass');
  const m = merged(c.branch)!;
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', 'refs/heads/main', m.sha], { cwd: origin }).status, 0, 'main is in what merged');
  assert.equal(done.conflicts ?? null, null, 'the count starts over after a merge');
});
