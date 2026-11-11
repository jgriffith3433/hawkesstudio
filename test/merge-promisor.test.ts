// A light clone's merge of beta that can't fetch the other side's file contents (Sick of It PR #328, 2026-11-11: Studio's
// `git merge origin/beta` in the worktree died with "could not fetch <blob> from promisor remote" before comparing any
// file, GitHub said the branch conflicted, and the change sat "ready, couldn't merge into beta" for good). Studio now
// fetches what the merge needs itself, with the repo's credentials, and merges once more; the promisor remote's lazy
// fetch is made to fail once here (a wrapper upload-pack, as a lazy fetch with no credentials fails on GitHub).
// Real git (a bare origin that serves partial clones), GitHub faked over HTTP.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-promisor-'));
const projects = path.join(tmp, 'Projects');
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
const origin = path.join(tmp, 'game.git');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// The origin, seeded from a full clone; it serves partial clones (GitHub does).
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(origin, 'config', 'uploadpack.allowFilter', 'true');
git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
const other = path.join(tmp, 'other');
git(tmp, 'clone', '--quiet', origin, other);
fs.writeFileSync(path.join(other, 'menu.txt'), 'Start\n');
fs.writeFileSync(path.join(other, 'level.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
fs.writeFileSync(path.join(other, 'AGENTS.md'), 'A fixture game.\n');
git(other, 'add', '-A');
git(other, 'commit', '--quiet', '-m', 'First');
git(other, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:beta');
git(other, 'checkout', '--quiet', '-b', 'beta', 'origin/beta');

// Studio's checkout of the game is a light clone (repos.ts cloneArgs: `--filter=blob:none`), served through a wrapper
// that can be told to refuse one upload-pack call: what a lazy fetch with no credentials meets on GitHub.
const calls = path.join(tmp, 'upload-calls');
const failAt = path.join(tmp, 'upload-fail-at');
const failed = path.join(tmp, 'upload-failed');
const wrapper = path.join(tmp, 'upload-pack.sh');
fs.writeFileSync(wrapper, `#!/bin/sh
n=$(cat '${calls}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${calls}'
if [ -f '${failAt}' ] && [ "$(cat '${failAt}')" = "$n" ]; then echo "remote: Invalid username or token" >&2; echo $n >> '${failed}'; exit 128; fi
exec git-upload-pack "$@"
`, { mode: 0o755 });
const repoDir = path.join(projects, 'game');
git(tmp, 'clone', '--quiet', '--filter=blob:none', `file://${origin}`, repoDir);
git(repoDir, 'config', 'remote.origin.uploadpack', wrapper);
const uploads = () => Number(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim() : 0);
/** The lazy fetch of the next merge fails once: upload-pack call 1 is updateFromBase's fetch, call 2 the merge's lazy one. */
const failNextLazyFetch = () => fs.writeFileSync(failAt, String(uploads() + 2));

function betaMoves(file: string, text: string) {
  git(other, 'pull', '--quiet', 'origin', 'beta');
  fs.writeFileSync(path.join(other, file), text);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', `Another task: ${file}`);
  git(other, 'push', '--quiet', 'origin', 'HEAD:beta');
}

// GitHub: a pull request per branch, its head what origin has; it merges whatever it is asked to.
const merges: string[] = [];
const prBranch = new Map<number, string>();
const listen = async (server: http.Server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
};
const github = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const url = new URL(req.url!, 'http://x');
  const m = /^\/repos\/x\/game\/pulls\/(\d+)(\/merge|\/files)?$/.exec(url.pathname);
  if (m) {
    const branch = prBranch.get(Number(m[1]))!;
    if (m[2] === '/files') return json(200, [{ filename: 'menu.txt' }]);
    const sha = spawnSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: origin, encoding: 'utf8' }).stdout.trim();
    if (m[2] === '/merge' && req.method === 'PUT') { merges.push(branch); return json(200, { merged: true, sha: 'f'.repeat(40) }); }
    return json(200, { number: Number(m[1]), state: 'open', merged: false, head: { sha, ref: branch }, mergeable: true, mergeable_state: 'clean' });
  }
  if (/^\/repos\/x\/game\/pulls$/.test(url.pathname)) return json(200, []);
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
process.env.STUDIO_MERGE_RETRY_MS = '10';
for (const k of ['STUDIO_SERVER', 'HAWKESGEN_KEY', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.writeFileSync(path.join(tmp, 'data', 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(tmp, 'data', 'agents.json'), JSON.stringify({ autoMergeBeta: true, maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { game: 'x/game' },
  products: [{
    id: 'game', name: 'Game', framing: 'test', engine: 'static', repo: 'game', site: 'game', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'game', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture game.',
  }],
  infra: [],
}));

const { db, J } = await import('../src/db.ts');
const agents = await import('../src/agents.ts');
const { getChange, updateFromBase, autoMergeBeta, fetchMergeObjects } = agents;

let n = 0;
/** A ready change: its agent edited `file` on its own branch from beta (in the light clone's worktree), pushed, PR open. */
function readyChange(file: string, text: string) {
  n++;
  const id = `c_9f0a100000${String(n).padStart(2, '0')}`;
  const branch = `task/${id}`;
  const wt = path.join(projects, '.work', id);
  git(repoDir, 'fetch', '--quiet', 'origin');
  git(repoDir, 'worktree', 'add', '--quiet', '-b', branch, wt, 'origin/beta');
  fs.writeFileSync(path.join(wt, file), text);
  git(wt, 'add', '-A');
  git(wt, 'commit', '--quiet', '-m', `Task ${n}`);
  git(wt, 'push', '--quiet', 'origin', `HEAD:${branch}`);
  prBranch.set(n, branch);
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, request, pr, pr_url, title, verify, notes, log, created, session, criteria)
    VALUES (?, 'game', '[]', 'ready', 'ready', 'game', 'x/game', ?, 'beta', ?, 'A task', ?, ?, ?, ?, '[]', '[]', ?, 'fake-agent-session', '[]')`)
    .run(id, branch, wt, n, `https://github.test/x/game/pull/${n}`, `Task ${n}`, J({ sha: git(wt, 'rev-parse', 'HEAD') }), Date.now());
  return { id, wt, branch };
}
const missingIn = (wt: string) => git(wt, 'rev-list', '--objects', '--missing=print', '--no-walk', 'HEAD', 'origin/beta').split('\n').filter((l) => l.startsWith('?')).length;

test("a light clone's merge whose promisor fetch fails: Studio fetches what it needs and the merge goes through", async () => {
  const c = readyChange('menu.txt', 'Start game\n');
  betaMoves('credits.txt', 'Thanks\n');
  betaMoves('level.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven, beta\n');
  git(repoDir, 'fetch', '--quiet', 'origin');
  assert.ok(missingIn(c.wt) > 0, "the light clone doesn't have beta's new file contents yet");
  failNextLazyFetch();
  const r = await updateFromBase(c.id);
  assert.equal(r.state, 'merged', `${JSON.stringify(r)}\n${getChange(c.id)!.log.join('\n')}`);
  assert.ok(fs.existsSync(failed), "the merge's own lazy fetch was refused (the case being reproduced)");
  const log = getChange(c.id)!.log.join('\n');
  assert.match(log, /couldn't fetch file contents from the remote .*Studio fetched the \d+ the merge needs and merges again/);
  assert.doesNotMatch(log, /not a conflict/);
  assert.equal(fs.readFileSync(path.join(c.wt, 'credits.txt'), 'utf8'), 'Thanks\n', "beta's side is in");
  assert.equal(fs.readFileSync(path.join(c.wt, 'menu.txt'), 'utf8'), 'Start game\n', "the change's side is kept");
  git(repoDir, 'fetch', '--quiet', 'origin');
  assert.equal(git(repoDir, 'rev-parse', `origin/${c.branch}`), r.sha, 'the merge is pushed');
  assert.equal(getChange(c.id)!.verify.sha, r.sha, 'and is what merges');
  // ...and it merges into beta by itself: no dead end.
  await autoMergeBeta(c.id);
  assert.equal(getChange(c.id)!.status, 'merged', getChange(c.id)!.log.join('\n'));
  assert.ok(merges.includes(c.branch));
});

test('both sides changed the same file (different lines): the merge base\'s contents are fetched too, and it merges cleanly', async () => {
  fs.rmSync(failed, { force: true });
  const c = readyChange('level.txt', 'one, branch\ntwo\nthree\nfour\nfive\nsix\nseven, beta\n');
  betaMoves('level.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven, beta again\n');
  git(repoDir, 'fetch', '--quiet', 'origin');
  failNextLazyFetch();
  const r = await updateFromBase(c.id);
  assert.equal(r.state, 'merged', `${JSON.stringify(r)}\n${getChange(c.id)!.log.join('\n')}`);
  assert.ok(fs.existsSync(failed));
  assert.equal(fs.readFileSync(path.join(c.wt, 'level.txt'), 'utf8'), 'one, branch\ntwo\nthree\nfour\nfive\nsix\nseven, beta again\n', 'both edits');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(c.id);
});

test('fetchMergeObjects fetches only what is missing, and nothing once it is all there', async () => {
  const c = readyChange('menu.txt', 'Begin\n');
  betaMoves('extra.txt', 'More\n');
  git(repoDir, 'fetch', '--quiet', 'origin');
  const before = missingIn(c.wt);
  assert.ok(before > 0);
  const first = await fetchMergeObjects(c.wt, 'origin/beta');
  assert.equal(first.ok, true, first.why);
  assert.ok(first.count >= before, `fetched ${first.count}, ${before} missing in the two tips`);
  assert.equal(missingIn(c.wt), 0, 'nothing missing now');
  const calls0 = uploads();
  const again = await fetchMergeObjects(c.wt, 'origin/beta');
  assert.deepEqual(again, { ok: true, count: 0 });
  assert.equal(uploads(), calls0, 'no fetch when nothing is missing');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(c.id);
});

test('git commands that read file contents in a light clone carry the repo credentials, past -c options', async () => {
  const { gitNeedsAuth, gitCommandOf } = await import('../src/beta.ts');
  assert.equal(gitCommandOf(['-c', 'user.name=Hawkes Studio', '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', 'origin/beta']), 'merge');
  for (const a of [['-c', 'user.name=x', 'merge', 'origin/beta'], ['merge', '--abort'], ['reset', '--hard', 'abc'], ['-C', '/x', 'rebase', 'origin/beta'], ['cherry-pick', 'abc']]) assert.equal(gitNeedsAuth(a), true, a.join(' '));
  for (const a of [['-c', 'user.name=x', 'commit', '-m', 'x'], ['status'], ['rev-list', '--objects', '--missing=print', 'HEAD']]) assert.equal(gitNeedsAuth(a), false, a.join(' '));
});
