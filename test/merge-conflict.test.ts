// Merge conflicts resolve themselves (J, 2026-10-18: four Sick Of It tasks finished, then hit "Pull request has merge
// conflicts" because another task merged into beta first, and each was sent back by hand, using up tries). Before a
// ready change merges, Studio brings its branch up to date with beta: a clean merge is pushed and merged with no agent;
// a real conflict resumes the change's own agent (a conflict pass: not a try); after two passes that still conflict, J
// decides. Real git (a bare origin with main and beta), GitHub faked over HTTP, Claude Code faked (fixture/fake-claude.mjs).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-conflict-'));
const projects = path.join(tmp, 'Projects');
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
const origin = path.join(tmp, 'game.git');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
const repoDir = path.join(projects, 'game');
git(tmp, 'clone', '--quiet', origin, repoDir);
fs.writeFileSync(path.join(repoDir, 'menu.txt'), 'Start\n');
fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'A fixture game.\n');
git(repoDir, 'add', '-A');
git(repoDir, 'commit', '--quiet', '-m', 'First');
git(repoDir, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:beta');
git(repoDir, 'fetch', '--quiet', 'origin');

// A second clone: "another task" landing on beta.
const other = path.join(tmp, 'other');
git(tmp, 'clone', '--quiet', '-b', 'beta', origin, other);
function betaMoves(file: string, text: string) {
  git(other, 'pull', '--quiet', 'origin', 'beta');
  fs.mkdirSync(path.dirname(path.join(other, file)), { recursive: true });
  fs.writeFileSync(path.join(other, file), text);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', `Another task: ${file}`);
  git(other, 'push', '--quiet', 'origin', 'HEAD:beta');
}

// GitHub: one open pull request per branch, its head what origin has; merging squashes nothing, it just says merged.
const merges: string[] = [];
const mergeTries: string[] = [];
const prBranch = new Map<number, string>();
const dirty = new Map<number, string>();
const refuse = new Map<number, string>();
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
  const m = /^\/repos\/x\/game\/pulls\/(\d+)(\/merge|\/files)?$/.exec(url.pathname);
  if (m) {
    const branch = prBranch.get(Number(m[1]))!;
    if (m[2] === '/files') return json(200, [{ filename: 'menu.txt' }]);
    const sha = spawnSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: origin, encoding: 'utf8' }).stdout.trim();
    // A pull request GitHub calls conflicting until its branch moves (dirty: the head it was dirty at).
    const isDirty = dirty.get(Number(m[1])) === sha;
    if (m[2] === '/merge' && req.method === 'PUT') {
      mergeTries.push(branch);
      if (refuse.has(Number(m[1]))) return json(422, { message: refuse.get(Number(m[1])) });
      if (isDirty) return json(405, { message: 'Pull Request is not mergeable' });
      merges.push(branch);
      return json(200, { merged: true, sha: 'f'.repeat(40) });
    }
    return json(200, { number: Number(m[1]), state: 'open', merged: false, head: { sha, ref: branch }, mergeable: !isDirty, mergeable_state: isDirty ? 'dirty' : 'clean' });
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
// No phone notifications from a test.
fs.writeFileSync(path.join(tmp, 'data', 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(tmp, 'data', 'agents.json'), JSON.stringify({ autoMergeBeta: true, maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { game: 'x/game' },
  products: [{
    id: 'game', name: 'Game', framing: 'test', engine: 'static', repo: 'game', site: 'game', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'game', port: 8795, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture game.',
  }],
  infra: [],
}));

const { db, J } = await import('../src/db.ts');
const agents = await import('../src/agents.ts');
const rm = await import('../src/roadmap.ts');
const { getChange, updateFromBase, autoMergeBeta, CONFLICT_PASSES } = agents;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 60_000, what = 'it') {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

let n = 0;
/** A ready change of a roadmap task: its agent changed menu.txt on its own branch from beta, pushed, pull request open. */
function readyChange(text: string, request = 'Rename the start button') {
  n++;
  const id = `c_c0f1000000${String(n).padStart(2, '0')}`;
  const branch = `task/${id}`;
  const wt = path.join(projects, '.work', id);
  git(repoDir, 'fetch', '--quiet', 'origin');
  git(repoDir, 'worktree', 'add', '--quiet', '-b', branch, wt, 'origin/beta');
  fs.writeFileSync(path.join(wt, 'menu.txt'), text);
  git(wt, 'add', '-A');
  git(wt, 'commit', '--quiet', '-m', `Task ${n}`);
  git(wt, 'push', '--quiet', 'origin', `HEAD:${branch}`);
  prBranch.set(n, branch);
  const it = rm.addItem({ product: 'game', title: `Item ${n}`, status: 'planned' });
  const t = rm.addTask({ item: it.id, request });
  rm.setTask(t.id, { status: 'review', change: id, changes: [id], tries: 1 });
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, request, pr, pr_url, title, verify, notes, log, created, task, session, criteria)
    VALUES (?, 'game', '[]', 'ready', 'ready', 'game', 'x/game', ?, 'beta', ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, 'fake-agent-session', '[]')`)
    .run(id, branch, wt, request, n, `https://github.test/x/game/pull/${n}`, `Task ${n}`, J({ sha: git(wt, 'rev-parse', 'HEAD') }), Date.now(), t.id);
  return { id, wt, task: t.id, branch };
}

test('beta moved without touching the same lines: Studio merges it into the branch, pushes, and that commit is what merges', async () => {
  const c = readyChange('Start game\n');
  betaMoves('credits.txt', 'Thanks\n');
  const r = await updateFromBase(c.id);
  assert.equal(r.state, 'merged');
  git(repoDir, 'fetch', '--quiet', 'origin');
  const pushed = git(repoDir, 'rev-parse', `origin/${c.branch}`);
  assert.equal(pushed, r.sha, 'pushed to the pull request branch');
  assert.equal(getChange(c.id)!.verify.sha, r.sha, 'the merge commit is the one to merge');
  assert.ok(fs.existsSync(path.join(c.wt, 'credits.txt')) && fs.readFileSync(path.join(c.wt, 'menu.txt'), 'utf8') === 'Start game\n', 'both sides');
  assert.equal((await updateFromBase(c.id)).state, 'current', 'up to date now');
  // The automatic merge goes through, no agent involved.
  await autoMergeBeta(c.id);
  assert.equal(getChange(c.id)!.status, 'merged');
  assert.ok(getChange(c.id)!.merged_at, 'when it merged is recorded (beta builds after it are its)');
  assert.ok(merges.includes(c.branch));
});

test('a real conflict is not merged: aborted, the files named, the branch as it was', async () => {
  const c = readyChange('Play\n');
  betaMoves('menu.txt', 'Begin\n');
  const head = git(c.wt, 'rev-parse', 'HEAD');
  const r = await updateFromBase(c.id);
  assert.equal(r.state, 'conflict');
  assert.deepEqual(r.files, ['menu.txt']);
  assert.equal(git(c.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(git(c.wt, 'status', '--porcelain', '--', '.', ':(exclude).hawkes'), '', 'nothing left half-merged');
  assert.ok(!merges.includes(c.branch));
  // A person's merge meets it too: its own agent resolves it (J, 2026-11-04: "it should be able to deal with the merge
  // conflicts"), not a notice saying it stopped; once resolved it merges by itself.
  await assert.rejects(agents.approve(c.id, { confirm: `MERGE ${c.id}` }), (e: any) => /moved and the branch conflicts with it in menu\.txt: its agent is resolving the conflicts \(conflict pass 1 of 2/.test(e.message) && e.resolving === true);
  assert.equal(getChange(c.id)!.status, 'revising');
  await until(() => getChange(c.id)!.status === 'merged', 60_000, 'the conflict pass and the merge');
  assert.ok(merges.includes(c.branch));
});

test('GitHub says it conflicts and there is no worktree here (a big repo on Cloud Run): its agent resolves it, no "Merge stopped" over and over', async () => {
  const talk = await import('../src/talk.ts');
  const stopped = () => talk.listConversations().filter((x: any) => /^Merge stopped/.test(x.title ?? '')).length;
  const before = stopped();
  const c = readyChange('Ready\n');
  betaMoves('menu.txt', 'Set\n');
  // The service has no checkout of it (Yoobaland, 2026-11-04): Studio can't bring the branch up to date itself.
  git(repoDir, 'worktree', 'remove', '--force', c.wt);
  dirty.set(n, git(repoDir, 'rev-parse', `refs/heads/${c.branch}`));
  const tries = mergeTries.length;
  await assert.rejects(agents.approve(c.id, { confirm: `MERGE ${c.id}` }), (e: any) => /its agent is resolving the conflicts/.test(e.message) && e.resolving === true);
  assert.equal(mergeTries.length, tries + 1, 'asked GitHub once');
  assert.equal(stopped(), before, 'no "Merge stopped" conversation: it is being dealt with');
  assert.equal(getChange(c.id)!.conflicts, 1);
  await until(() => getChange(c.id)!.status === 'merged', 60_000, 'the worktree made again, the conflict pass and the merge');
  assert.ok(merges.includes(c.branch));
  assert.equal(fs.readFileSync(path.join(c.wt, 'menu.txt'), 'utf8').replace(/\r\n/g, '\n'), 'Ready\n', "the agent kept its side, in a worktree made again from the branch");
});

test('a merge that fails for another reason: Talk hears it once, and it is not asked of GitHub again for a minute', async () => {
  const talk = await import('../src/talk.ts');
  const stopped = () => talk.listConversations().filter((x: any) => /^Merge stopped/.test(x.title ?? '')).length;
  const c = readyChange('Onward\n');
  // GitHub refuses for a reason that isn't a conflict (a required check, say).
  refuse.set(n, 'Required status check "build" is failing.');
  const before = stopped(), tries = mergeTries.length;
  await assert.rejects(agents.approve(c.id, { confirm: `MERGE ${c.id}` }));
  assert.equal(stopped(), before + 1, 'one "Merge stopped"');
  for (let i = 0; i < 5; i++) await assert.rejects(agents.approve(c.id, { confirm: `MERGE ${c.id}` }), /failed \d+ s ago/);
  assert.equal(stopped(), before + 1, 'still one');
  assert.equal(mergeTries.length, tries + 1, 'GitHub asked once');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(c.id);
});

test("agents' notes committed on both sides: Studio takes them out of git and merges, the branch's notes kept on disk", async () => {
  // Beta already has notes in git from an earlier change (Dose Of Destruction, 2026-10-22), and this branch wrote its own.
  betaMoves('.hawkes/summary.md', 'Another change\n');
  const c = readyChange('Begin game\n');
  fs.writeFileSync(path.join(c.wt, '.hawkes', 'summary.md'), 'This change\n');
  fs.writeFileSync(path.join(c.wt, '.hawkes', 'video.json'), '{"asset":"a_1"}\n');
  git(c.wt, 'add', '-f', '.hawkes');
  git(c.wt, 'commit', '--quiet', '-m', 'Notes committed by mistake');
  git(c.wt, 'push', '--quiet', 'origin', `HEAD:${c.branch}`);
  betaMoves('.hawkes/summary.md', 'Yet another change\n');
  const r = await updateFromBase(c.id);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(git(c.wt, 'ls-files', '--', '.hawkes'), '', 'no notes in git');
  assert.equal(fs.readFileSync(path.join(c.wt, '.hawkes', 'summary.md'), 'utf8'), 'This change\n', "the branch's own notes on disk");
  assert.ok(fs.existsSync(path.join(c.wt, '.hawkes', 'video.json')));
  assert.equal(fs.readFileSync(path.join(c.wt, 'menu.txt'), 'utf8'), 'Begin game\n');
  git(repoDir, 'fetch', '--quiet', 'origin');
  assert.equal(git(repoDir, 'rev-parse', `origin/${c.branch}`), r.sha, 'pushed');
  assert.equal(git(repoDir, 'ls-tree', '-r', '--name-only', r.sha!, '--', '.hawkes'), '', 'merging it takes the notes off beta too');
  assert.equal((await updateFromBase(c.id)).state, 'current');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(c.id);
});

test('notes in git on an up-to-date branch: taken out and pushed', async () => {
  const c = readyChange('Start!\n');
  fs.mkdirSync(path.join(c.wt, '.hawkes'), { recursive: true });
  fs.writeFileSync(path.join(c.wt, '.hawkes', 'try.md'), 'Open the menu\n');
  git(c.wt, 'add', '-f', '.hawkes');
  git(c.wt, 'commit', '--quiet', '-m', 'Notes committed by mistake');
  git(c.wt, 'push', '--quiet', 'origin', `HEAD:${c.branch}`);
  git(c.wt, 'fetch', '--quiet', 'origin');
  git(c.wt, 'merge', '--quiet', '--no-edit', 'origin/beta');
  const r = await updateFromBase(c.id);
  assert.equal(r.state, 'merged', JSON.stringify(r));
  assert.equal(git(c.wt, 'ls-files', '--', '.hawkes'), '');
  assert.equal(fs.readFileSync(path.join(c.wt, '.hawkes', 'try.md'), 'utf8'), 'Open the menu\n');
  assert.equal(getChange(c.id)!.verify.sha, r.sha);
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(c.id);
});

test("a conflict goes back to the change's own agent (not a try), and once resolved it merges by itself", async () => {
  const c = readyChange('Go!\n');
  betaMoves('menu.txt', 'Start now\n');
  await autoMergeBeta(c.id);
  const mid = getChange(c.id)!;
  assert.equal(mid.conflicts, 1);
  assert.equal(mid.status, 'revising', 'its agent is on it (holds the slot like a revision)');
  assert.ok(mid.log.some((l) => /conflict pass 1 of 2/.test(l)));
  await until(() => getChange(c.id)!.status === 'merged', 60_000, 'the conflict pass and the merge');
  const done = getChange(c.id)!;
  assert.ok(done.log.some((l) => /agent resumed its session to resolve the conflicts with beta/.test(l)), done.log.join('\n'));
  assert.ok(merges.includes(c.branch));
  assert.equal(done.conflicts ?? null, null, 'the count starts over after a merge');
  // The task's tries are untouched: a conflict pass isn't a try.
  const pm = await import('../src/pm.ts');
  await pm.syncTasks();
  const t = rm.getTask(c.task)!;
  assert.equal(t.status, 'merged');
  assert.equal(t.tries, 1);
});

test('an agent that fails twice on the same conflict: stuck, and only then J is asked', async () => {
  const c = readyChange('Launch\n', 'Rename the start button FAKE_NOTHING');
  betaMoves('menu.txt', 'Off we go\n');
  await autoMergeBeta(c.id);
  await until(() => {
    const x = getChange(c.id)!;
    return x.status === 'ready' && /^failed/.test(x.auto_merge ?? '');
  }, 60_000, `${CONFLICT_PASSES} conflict passes, then giving up`);
  const x = getChange(c.id)!;
  assert.equal(x.conflicts, CONFLICT_PASSES, x.log.join('\n'));
  assert.match(x.auto_merge!, /still conflicts with beta after 2 conflict passes/);
  const q = rm.listQuestions('asked J').find((y) => y.subject === c.task);
  assert.ok(q, 'J decides now');
  assert.match(q!.text, /tried 2 times to resolve the conflicts/);
  assert.equal(rm.getTask(c.task)!.tries, 1, 'still not a try');
});

test("the PM's minute check meets a conflict GitHub reports: its agent takes it; with the passes used up J is asked once and the PM stops trying", async () => {
  const pm = await import('../src/pm.ts');
  // Yoobaland, 2026-11-04: the PM's default review merged PR #454 every minute and each one said "Merge stopped".
  const c = readyChange('Hello\n');
  betaMoves('menu.txt', 'Howdy\n');
  git(repoDir, 'worktree', 'remove', '--force', c.wt);
  dirty.set(n, git(repoDir, 'rev-parse', `refs/heads/${c.branch}`));
  await pm.pmMerge(c.id);
  assert.equal(getChange(c.id)!.status, 'revising', 'its agent is resolving it');
  assert.equal(pm.reviewable(getChange(c.id)), false, "not the PM's to merge while it does");
  await until(() => getChange(c.id)!.status === 'merged', 60_000, 'the conflict pass and the merge');

  // Passes used up: one question for J, and the PM leaves it alone after that.
  const d = readyChange('Hi there\n');
  betaMoves('menu.txt', 'Greetings\n');
  dirty.set(n, git(repoDir, 'rev-parse', `refs/heads/${d.branch}`));
  db.prepare('UPDATE changes SET conflicts = ? WHERE id = ?').run(CONFLICT_PASSES, d.id);
  const tries = mergeTries.length;
  await assert.rejects(pm.pmMerge(d.id), /already had 2 conflict passes/);
  await until(() => rm.listQuestions('asked J').some((q) => q.subject === d.task), 10_000, 'the question for J');
  assert.equal(pm.reviewable(getChange(d.id)), false, 'the PM waits for J');
  assert.ok(mergeTries.length <= tries + 1, 'GitHub asked at most once');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(d.id);
});
