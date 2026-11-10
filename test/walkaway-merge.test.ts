// These tests fake GitHub's check runs: the CI wait is on for them (ciChecks reads it per call).
process.env.STUDIO_GITHUB_CI = '1';
// Walk-away mode (J, 2026-10-18: "I'm tired of going into the inbox and approving merges.. just merge okay?"): a ready
// Studio/Gen change whose checks passed merges into main by itself once CI is green; red CI never merges (its agent gets
// a fix pass, then J); a change touching protected files waits for J; with walk-away off nothing merges by itself.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-walkaway-merge-'));
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
const redAll = new Set<string>();
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
    const red = branch && (redAll.has(branch) || (redCi.has(branch) && agentSha.get(branch) !== checks[1]));
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
// One slot: a fix pass (a revision) waits its turn in the queue like any other pass (2026-11-10), so the pump needs room to start it.
fs.writeFileSync(path.join(tmp, 'data', 'agents.json'), JSON.stringify({ maxConcurrent: 1 }));
// Walk-away mode on (the default), and no counted tries: one free fix pass, then J.
fs.writeFileSync(path.join(tmp, 'data', 'pm.json'), JSON.stringify({ walkAway: true, maxTries: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { tool: 'x/tool' },
  products: [],
  infra: [{
    id: 'tool', name: 'Tool', repo: 'tool', slug: 'x/tool', about: 'A fixture service.', checks: ['node -e 0'],
    smoke: { start: 'server.mjs', portEnv: 'TOOL_PORT', dataEnv: 'TOOL_DATA', health: '/health', scripts: 'dashboard' },
  }],
}));

const { db, J } = await import('../src/db.ts');
const causes = await import('../src/causes.ts');
const agents = await import('../src/agents.ts');
const { getChange, walkAwayMerge } = agents;
const pm = await import('../src/pm.ts');
const ib = await import('../src/inbox.ts');
const ap = await import('../src/approvals.ts');
const rm = await import('../src/roadmap.ts');

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
function readyChange(text: string, file = 'menu.txt') {
  n++;
  const id = `c_1f7a0000000${n}`;
  const branch = `task/${id}`;
  const wt = path.join(projects, '.work', id);
  git(repoDir, 'fetch', '--quiet', 'origin');
  git(repoDir, 'worktree', 'add', '--quiet', '-b', branch, wt, 'origin/main');
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), text);
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
    .run(id, branch, wt, `Change the menu ${n}`, n, `https://github.test/x/tool/pull/${n}`, `Change ${n}`, J({ kind: 'infra', sha, outcome: 'passed', summary: 'CI green', ci: { state: 'success' }, checks: [{ cmd: 'node -e 0', ok: true, seconds: 0 }], smoke: { ok: true, detail: 'health ok' } }), Date.now());
  return { id, wt, branch };
}
const merged = (branch: string) => merges.find((x) => x.branch === branch);
const setWalk = (on: boolean) => fs.writeFileSync(path.join(tmp, 'data', 'pm.json'), JSON.stringify({ walkAway: on, maxTries: 0 }));

test('walk-away: a green Studio change merges into main by itself, with one line in Talk, and leaves no card for J', async () => {
  const c = readyChange('Begin\n');
  // A card asked for before (the stale merge cards in J's Inbox): it settles, it isn't J's to tap any more.
  db.prepare(`INSERT INTO approvals (id, kind, target, params, bind, token, card, status, created, expires) VALUES ('a_walk00000001', 'merge', ?, '{}', '[]', 't', ?, 'pending', ?, ?)`)
    .run(c.id, J({ title: 'Merge?', lines: [], blockers: [], warnings: [], links: [], approve: 'Approve', deny: 'Deny' }), Date.now(), Date.now() + 600_000);
  assert.ok(!(await ib.inbox()).some((x) => x.subject === c.id), 'no merge card in the Inbox');
  assert.equal(ap.getApproval('a_walk00000001')!.status, 'stale');
  await assert.rejects(ap.requestApproval('merge', c.id), /walk-away mode/);
  const r = await walkAwayMerge(c.id);
  assert.equal(r!.status, 'merged');
  assert.equal(merged(c.branch)?.sha, agentSha.get(c.branch));
  const done = getChange(c.id)!;
  assert.equal(done.auto_merge, 'merged');
  assert.match(done.detail!, /merged into main by Studio \(walk-away\)/);
  assert.ok(db.prepare(`SELECT 1 FROM conversations WHERE messages LIKE ?`).get(`%${c.id}%merged into main by itself (walk-away mode)%`), 'one line in Talk');
  assert.ok(rm.listDecisions({ action: 'walk-away' }).some((d) => d.subject === c.id && /merged/.test(d.detail ?? '')), 'in the PM log');
});

test('walk-away: main moved: brought up to date, it merges once CI on the updated head is green', async () => {
  const c = readyChange('Start now\n');
  mainMoves('credits.txt', 'Thanks\n');
  const r = await walkAwayMerge(c.id);
  assert.equal(r!.status, 'ready', 'not before CI on the updated branch');
  await until(() => getChange(c.id)!.auto_merge === 'merged', 30_000, 'the merge once CI is green');
  assert.equal(getChange(c.id)!.status, 'merged');
  assert.notEqual(merged(c.branch)!.sha, agentSha.get(c.branch), 'what merged has main in it');
  assert.ok(db.prepare(`SELECT 1 FROM conversations WHERE messages LIKE ?`).get(`%${c.id}%by itself (walk-away mode)%`));
});

test('walk-away: red CI never merges: its agent gets a fix pass (not a try), and after its tries J decides', { timeout: 120_000 }, async () => {
  const c = readyChange('Go\n');
  // The PM already answered "try again" for it as often as the gate allows in a week (causes.ts AUTO_ANSWERS): J's now.
  for (let i = 0; i < causes.AUTO_ANSWERS; i++) causes.logCause(causes.causeFromKey('recommended'), { product: 'hawkesstudio', kind: 'answered', subject: c.id, ref: `pre${i}`, dedup: `pre:${c.id}:${i}` });
  redAll.add(c.branch);
  await walkAwayMerge(c.id);
  assert.ok(!merged(c.branch), 'nothing merged into main');
  const x = getChange(c.id)!;
  assert.equal(x.auto_fixes, 1);
  assert.ok(x.log.some((l) => /walk-away: fix pass 1 \(not counted as a try\)/.test(l)), x.log.join('\n'));
  // The fix pass runs (its agent commits), CI is red again: no merge; out of tries (maxTries 0), J's Inbox.
  await until(() => String(getChange(c.id)!.auto_merge ?? '').startsWith('held'), 90_000, 'the fix pass and its checks');
  assert.ok(!merged(c.branch), 'still nothing merged');
  assert.equal(getChange(c.id)!.status, 'ready');
  assert.ok(rm.listQuestions().some((q) => q.subject === c.id && /couldn't merge into main by itself/.test(q.text)), 'J is asked once');
  assert.ok((await ib.inbox()).some((x) => x.id === `merge:${c.id}`), 'its merge card is J\'s now');
});

test('walk-away: a change touching protected files waits for J', async () => {
  const c = readyChange('name: ci\n', '.github/workflows/ci.yml');
  assert.equal(await walkAwayMerge(c.id), null);
  assert.ok(!merged(c.branch));
  assert.match(getChange(c.id)!.auto_merge!, /^held: it changes protected files \(\.github\/workflows\/ci\.yml\)/);
  const card = (await ib.inbox()).find((x) => x.id === `merge:${c.id}`);
  assert.ok(card, 'J\'s card');
  assert.match(card!.context!, /protected files/);
});

test('walk-away off: nothing merges by itself, the card is J\'s as before', async () => {
  setWalk(false);
  try {
    const c = readyChange('Off\n');
    assert.equal(await walkAwayMerge(c.id), null);
    assert.ok(!merged(c.branch));
    assert.equal(getChange(c.id)!.status, 'ready');
    assert.ok((await ib.inbox()).some((x) => x.id === `merge:${c.id}`), 'his merge card');
  } finally {
    setWalk(true);
  }
});
