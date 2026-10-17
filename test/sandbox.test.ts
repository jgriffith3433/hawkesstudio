// The agent sandbox's guards and Talk's fast lane, on throwaway repos and a scratch database: anything live needs J's
// own latest words; the fast lane pushes a small checked change to beta and refuses big, protected or failing ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sandbox-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_FASTLANE_BETA = 'off';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  products: [{
    id: 'fasttest', name: 'Fast test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'site', port: 8796, path: '/' }, playtests: [], story: [], about: 'A fixture.',
    checks: [{ dir: 'site', cmd: 'node check.mjs' }],
  }],
  infra: [{ id: 'hawkesstudio', name: 'Hawkes Studio', repo: 'hawkesstudio', slug: 'x/y', about: 'Studio', checks: [], smoke: {} }],
}));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const repo = path.join(process.env.STUDIO_PROJECTS, 'site');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, repo);
fs.writeFileSync(path.join(repo, 'index.html'), '<h1>Helo</h1>\n');
// The product's check: fails when the page says "broken".
fs.writeFileSync(path.join(repo, 'check.mjs'), "import fs from 'node:fs'; process.exit(fs.readFileSync('index.html', 'utf8').includes('broken') ? 1 : 0);\n");
git(repo, 'add', '-A');
git(repo, 'commit', '--quiet', '-m', 'First');
git(repo, 'push', '--quiet', 'origin', 'HEAD:main');

const { db } = await import('../src/db.ts');
db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, session TEXT, status TEXT NOT NULL DEFAULT 'idle', messages TEXT NOT NULL DEFAULT '[]', cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER, kind TEXT)");
await import('../src/agents.ts');
const { jTyped, guardRoute } = await import('../src/guards.ts');
const fast = await import('../src/fastlane.ts');

const conv = (texts: [string, string][]) => {
  const id = `t_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  db.prepare('INSERT INTO conversations (id, status, messages, created) VALUES (?, ?, ?, ?)').run(id, 'idle', JSON.stringify(texts.map(([role, text], i) => ({ role, text, at: i, ...(role === 'notice' ? { role: 'assistant', notice: true } : {}) }))), Date.now());
  return id;
};

test('anything live needs J\'s own latest words', () => {
  const c1 = conv([['user', 'looks good'], ['assistant', 'Type DEPLOY fasttest to go live.']]);
  assert.match(guardRoute('/api/deploy/fasttest', 'POST', c1)!, /J's call/, "Claude's text doesn't count");
  const c2 = conv([['user', 'DEPLOY fasttest'], ['assistant', 'Going live.']]);
  assert.equal(guardRoute('/api/deploy/fasttest', 'POST', c2), null);
  assert.match(guardRoute('/api/deploy/othergame', 'POST', c2)!, /J's call/, 'the words name the product');
  const c3 = conv([['user', 'DEPLOY fasttest'], ['user', 'actually wait']]);
  assert.match(guardRoute('/api/deploy/fasttest', 'POST', c3)!, /J's call/, 'only his newest message');
  const c4 = conv([['notice', 'DEPLOY fasttest']]);
  assert.match(guardRoute('/api/deploy/fasttest', 'POST', c4)!, /J's call/, "Studio's notices don't count");
  assert.equal(jTyped(conv([['user', 'ok ROLLBACK fasttest please']]), 'ROLLBACK fasttest'), true);
  assert.equal(jTyped(conv([['user', 'DEPLOY fasttest2']]), 'DEPLOY fasttest'), false, 'not inside a longer word');
  assert.match(guardRoute('/api/rollback/fasttest', 'POST', null)!, /J's call/, 'no conversation, no rollback');
  assert.match(guardRoute('/api/agents/settings', 'POST', c2)!, /dashboard/);
  assert.equal(guardRoute('/api/deploy/fasttest', 'GET', null), null, 'plans are fine');
  assert.equal(guardRoute('/api/pm/merge/c_0123456789ab', 'POST', c1), null, 'beta merges stay open');
  db.prepare("INSERT OR REPLACE INTO changes (id, product, findings, status, created) VALUES ('c_00000000aaaa', 'hawkesstudio', '[]', 'ready', 0)").run();
  assert.match(guardRoute('/api/changes/c_00000000aaaa/approve', 'POST', c1)!, /MERGE c_00000000aaaa/, 'Studio and Gen merges deploy: J types it');
  assert.equal(guardRoute('/api/changes/c_00000000aaaa/approve', 'POST', conv([['user', 'MERGE c_00000000aaaa']])), null);
});

test('the fast lane: a small checked change goes to beta, nothing else does', async () => {
  const ws = await fast.workspace('fasttest');
  assert.equal(ws.dir, path.join(process.env.STUDIO_PROJECTS!, '.talk', 'site'));
  await assert.rejects(fast.workspace('hawkesstudio'), /no fast lane/);
  // A typo fix, uncommitted: committed with the message, checked, pushed to beta.
  fs.writeFileSync(path.join(ws.dir, 'index.html'), '<h1>Hello</h1>\n');
  const r = await fast.fastlane('fasttest', 'Fix the title typo');
  assert.equal(r.ok, true, r.why);
  assert.equal(r.checks[0].ok, true);
  assert.equal(git(origin, 'rev-parse', '--short=7', 'beta'), r.pushed);
  assert.notEqual(git(origin, 'rev-parse', 'main'), git(origin, 'rev-parse', 'beta'), 'main never moves');
  // A failing check stops it.
  fs.writeFileSync(path.join(ws.dir, 'index.html'), '<h1>broken</h1>\n');
  const bad = await fast.fastlane('fasttest', 'Break it');
  assert.equal(bad.ok, false);
  assert.match(bad.why!, /check .* failed/);
  git(ws.dir, 'reset', '--quiet', '--hard', 'origin/beta');
  // Protected and generated files are refused.
  fs.mkdirSync(path.join(ws.dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(ws.dir, '.github', 'workflows', 'x.yml'), 'on: push\n');
  const wf = await fast.fastlane('fasttest', 'A workflow');
  assert.match(wf.why!, /never changes: \.github\/workflows\/x\.yml/);
  git(ws.dir, 'reset', '--quiet', '--hard', 'origin/beta');
  // Too big.
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(ws.dir, `f${i}.txt`), 'x\n');
  const big = await fast.fastlane('fasttest', 'Lots of files');
  assert.match(big.why!, /too big/);
  git(ws.dir, 'reset', '--quiet', '--hard', 'origin/beta');
  // Nothing to push.
  assert.match((await fast.fastlane('fasttest', 'Nothing')).why!, /nothing to push/);
  // Beta moved: merge first.
  git(repo, 'fetch', '--quiet', 'origin');
  git(repo, 'checkout', '--quiet', '-B', 'other', 'origin/beta');
  fs.writeFileSync(path.join(repo, 'about.html'), 'about\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'Someone else');
  git(repo, 'push', '--quiet', 'origin', 'HEAD:beta');
  fs.writeFileSync(path.join(ws.dir, 'index.html'), '<h1>Hello!</h1>\n');
  git(ws.dir, 'add', '-A');
  git(ws.dir, 'commit', '--quiet', '-m', 'Exclaim');
  assert.match((await fast.fastlane('fasttest', 'Exclaim')).why!, /beta moved/);
  const w2 = await fast.workspace('fasttest');
  assert.equal(w2.ahead, 1);
  assert.match(w2.note!, /git merge origin\/beta/);
});

test('protected paths', () => {
  const bad = fast.protectedFiles([{ file: 'play/index.html', status: 'M' }, { file: 'Game/v12/a.unityweb', status: 'A' }, { file: 'Assets/x.png.meta', status: 'D' }, { file: 'src/a.ts', status: 'M' }, { file: '.env', status: 'A' }]);
  assert.deepEqual(bad, ['play/index.html', 'Game/v12/a.unityweb', 'Assets/x.png.meta (a deleted .meta)', '.env']);
});

// The server's setup: this user in the agent group (hawkes-work) and the server's git (2.43). GitHub's runner has
// neither (other groups, a newer git that sets worktree permissions its own way), so the test runs on the server only.
const { AGENT_GROUP } = await import('../src/sandbox.ts');
const idOut = (flag: string) => process.platform === 'win32' ? [] : spawnSync('id', [flag], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
const agentGid = idOut('-G')[idOut('-Gn').indexOf(AGENT_GROUP)];
const serverOnly = process.platform === 'win32' ? 'not on Windows'
  : process.env.CI ? 'CI: not the server\'s groups and git'
  : !agentGid ? `not in the agent group ${AGENT_GROUP}` : false;

test("a fresh agent worktree's git folder is the agent group's and group-writable, whatever Studio's umask", { skip: serverOnly }, async () => {
  const { shareRepo, shareWorktree, shareAll } = await import('../src/sandbox.ts');
  const gid = Number(agentGid);
  const r2 = path.join(process.env.STUDIO_PROJECTS!, 'shared');
  git(tmp, 'clone', '--quiet', origin, r2);
  // Studio (umask 022, as before) makes the worktree; nothing calls shareWorktree on it.
  const studio = (cwd: string, cmd: string) => {
    const r = spawnSync('sh', ['-c', `umask 022 && git -c user.name=Test -c user.email=t@example.com ${cmd}`], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
  };
  const shared = (p: string) => {
    const st = fs.statSync(p);
    assert.equal(st.gid, gid, `${p} is the agent group's`);
    assert.ok(st.mode & 0o020, `${p} is group-writable`);
    if (st.isDirectory()) assert.ok(st.mode & 0o2000, `${p} is setgid`);
  };
  shareRepo(r2, String(gid));
  assert.equal(git(r2, 'config', 'core.sharedRepository'), 'group');
  const wt = path.join(process.env.STUDIO_PROJECTS!, '.work', 'c_000000000001');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  studio(r2, `worktree add --quiet -b task/one ${wt} origin/main`);
  const gitDir = path.join(r2, '.git', 'worktrees', 'c_000000000001');
  // git (2.43) makes .git/worktrees/<name> itself 755 even in a shared repo: agents.ts shares it on every pass.
  shared(path.join(r2, '.git', 'worktrees'));
  for (const f of ['index', 'HEAD', 'logs', 'logs/HEAD']) shared(path.join(gitDir, f));
  shareWorktree(wt, String(gid));
  shared(gitDir);
  // Studio's own git there later (a commit: index, HEAD, the reflog) keeps it shared.
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
  studio(wt, 'add -A');
  studio(wt, 'commit --quiet -m A');
  for (const f of ['', 'index', 'HEAD', 'logs/HEAD']) shared(path.join(gitDir, f));
  shared(path.join(r2, '.git', 'logs', 'refs', 'heads', 'task', 'one'));
  // ...and what it didn't (COMMIT_EDITMSG, 644 under umask 022), the next pass's shareWorktree does.
  shareWorktree(wt, String(gid));
  shared(path.join(gitDir, 'COMMIT_EDITMSG'));
  // The last worktree pruned, git deletes .git/worktrees; it comes back the agent group's, group-writable.
  fs.rmSync(wt, { recursive: true, force: true });
  git(r2, 'worktree', 'prune');
  assert.equal(fs.existsSync(path.join(r2, '.git', 'worktrees')), false);
  studio(r2, `worktree add --quiet -b task/two ${wt} origin/main`);
  shared(path.join(r2, '.git', 'worktrees'));
  shareWorktree(wt, String(gid));
  for (const f of ['', 'index', 'HEAD']) shared(path.join(gitDir, f));
  // A worktree made before any of this (a repo never shared): shareWorktree and the start-up sweep fix both.
  const r3 = path.join(process.env.STUDIO_PROJECTS!, 'older');
  git(tmp, 'clone', '--quiet', origin, r3);
  const wt3 = path.join(process.env.STUDIO_PROJECTS!, '.work', 'c_000000000003');
  studio(r3, `worktree add --quiet -b task/three ${wt3} origin/main`);
  fs.chmodSync(path.join(r3, '.git', 'worktrees', 'c_000000000003'), 0o755);
  await shareAll(String(gid));
  for (const f of ['', 'index', 'HEAD']) shared(path.join(r3, '.git', 'worktrees', 'c_000000000003', f));
  assert.equal(git(r3, 'config', 'core.sharedRepository'), 'group');
  shareWorktree(wt3, String(gid));
});

test("the safety net's trigger: what an agent says when its commit was refused, and not any \"permission denied\"", async () => {
  const { COMMIT_DENIED } = await import('../src/agents.ts');
  assert.match("git commit failed: Unable to create '/srv/hawkes/x/.git/worktrees/c_1/index.lock': Permission denied", COMMIT_DENIED);
  assert.match('I couldn\'t commit: Permission denied on the git folder', COMMIT_DENIED);
  assert.doesNotMatch('Playwright: permission denied for /proc/hawkes-no-browsers', COMMIT_DENIED);
});
