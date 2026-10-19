// The website lane of a Unity game on throwaway git repos: the source repo and its separate website repo (home page,
// blog, the game page) each get a beta; a page change merged into the website's beta reaches the beta website copy
// without a new build; going live carries that page change and the beta build to the website's main together (and
// lists both in the plan); rollback undoes both; main merged back into the website's beta keeps beta's pages.
// Nothing here touches a real repo or Studio's own database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-website-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'webgame', name: 'Web game', framing: 'test', engine: 'unity', repo: 'game', site: 'gamesite', live: 'http://127.0.0.1:9/',
  build: { project: 'game', site: 'gamesite', method: 'Build.Run' },
  local: { serve: 'static', dir: 'gamesite', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}, {
  id: 'plainweb', name: 'Plain web', framing: 'test', engine: 'static', repo: 'plain', site: 'plain', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'plain', port: 8796, path: '/' }, playtests: [], story: [], about: 'A fixture.',
}], repos: { game: 'test/game', gamesite: 'test/gamesite', plain: 'test/plain' } }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A repo under Projects with a bare origin and one commit on main. */
function repo(name: string, files: Record<string, string>) {
  const origin = path.join(tmp, `${name}.git`);
  const dir = path.join(process.env.STUDIO_PROJECTS!, name);
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '--quiet', origin, dir);
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'First');
  git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
  return { origin, dir, remote: (ref: string) => git(origin, 'rev-parse', ref), show: (ref: string) => git(origin, 'show', ref) };
}
const game = repo('game', { 'Assets/level.json': 'level 1' });
const site = repo('gamesite', { 'index.html': 'home v1', 'Game/v1/game.js': 'build 1' });

const beta = await import('../src/beta.ts');
const { deployPlan, deploy, rollbackPlan, rollback, blockerFix } = await import('../src/deploy.ts');
const { db, newId, J } = await import('../src/db.ts');
const { getProduct } = await import('../src/config.ts');
const { siteRepoFor, isSiteChange } = await import('../src/agents.ts');
const played = (sha: string) => db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(newId('s'), newId('r'), 'webgame', 'playtest', 'smoke@local', 'done', 'won', J({ outcome: 'won', played: { branch: 'beta', sha } }), Date.now(), Date.now());

test('a Unity game\'s website repo is a change target; a plain web product has none', () => {
  const p = getProduct('webgame');
  assert.deepEqual(siteRepoFor(p), { top: 'gamesite', slug: 'test/gamesite', sub: '' });
  assert.equal(siteRepoFor(getProduct('plainweb')), null);
  assert.ok(isSiteChange({ repo: 'gamesite' }, p));
  assert.ok(!isSiteChange({ repo: 'game' }, p));
});

test('website lane: a page change and a build go live together; rollback undoes both', async () => {
  const p = getProduct('webgame');
  // An agent's game change on the source repo's beta.
  await beta.ensureBeta(game.dir);
  git(game.dir, 'checkout', '--quiet', '-b', 'beta', 'origin/beta');
  fs.writeFileSync(path.join(game.dir, 'Assets/level.json'), 'level 2');
  git(game.dir, 'commit', '--quiet', '-am', 'Add level 2');
  git(game.dir, 'push', '--quiet', 'origin', 'beta');
  const sourceBeta = game.remote('beta');

  // The beta build: the website copy is made at the website's beta (made from main the first time), the build lands in it.
  assert.equal(beta.hasBeta(site.dir), false);
  const copy = await beta.resetBetaSite(p);
  assert.equal(site.remote('beta'), site.remote('main'));
  fs.rmSync(path.join(copy.folder, 'Game/v1'), { recursive: true });
  fs.mkdirSync(path.join(copy.folder, 'Game/v2'), { recursive: true });
  fs.writeFileSync(path.join(copy.folder, 'Game/v2/game.js'), 'build 2');
  beta.saveBetaBuild(p, { sha: sourceBeta, base: copy.base, ok: true, at: Date.now(), version: '2' });

  // An agent's website change (a blog post) merges into the website's beta.
  const wt = path.join(tmp, 'site-change');
  git(site.dir, 'fetch', '--quiet', 'origin');
  git(site.dir, 'worktree', 'add', '--quiet', '-b', 'task/blog', wt, 'origin/beta');
  fs.writeFileSync(path.join(wt, 'blog.html'), 'a new post');
  git(wt, 'add', '-A');
  git(wt, 'commit', '--quiet', '-m', 'Blog: a new post');
  git(wt, 'push', '--quiet', 'origin', 'HEAD:beta');
  await beta.fetchOrigin(site.dir);

  // The plan sees the copy is behind the website's beta; the beta run moves it there, keeping the build.
  played(sourceBeta);
  let plan = await deployPlan('webgame');
  const behind = plan.blockers.find((b) => /The beta website copy sits on/.test(b));
  assert.ok(behind, plan.blockers.join(' | '));
  assert.equal(blockerFix(behind!), 'beta');
  const moved = await beta.refreshBetaSite(p);
  assert.ok(moved.moved, moved.why);
  assert.equal(fs.readFileSync(path.join(copy.folder, 'blog.html'), 'utf8'), 'a new post');
  assert.equal(fs.readFileSync(path.join(copy.folder, 'Game/v2/game.js'), 'utf8'), 'build 2');
  assert.equal(beta.betaBuild(p)!.base, site.remote('beta'));

  // The plan lists the game's commit and the website's, and goes live with both.
  plan = await deployPlan('webgame');
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.commits.map((c) => c!.title), ['Add level 2']);
  assert.deepEqual(plan.siteCommits.map((c) => c!.title), ['Blog: a new post']);
  assert.match(plan.what, /1 website commit\(s\)/);
  const liveBefore = site.remote('main');
  const r = await deploy('webgame', { confirm: 'DEPLOY webgame', by: 'test' }) as any;
  assert.equal(site.show('main:blog.html'), 'a new post');
  assert.equal(site.show('main:Game/v2/game.js'), 'build 2');
  assert.throws(() => site.show('main:Game/v1/game.js'));
  assert.equal(game.remote('main'), sourceBeta);
  // The website's beta follows the go live, so its main has nothing beta lacks.
  assert.equal(site.remote('beta'), site.remote('main'), r.log.join(' | '));
  plan = await deployPlan('webgame');
  assert.deepEqual(plan.siteMainOnly, []);
  assert.match(plan.blockers.join(' '), /Nothing to go live/);
  assert.match(beta.listDeploys('webgame')[0].detail ?? '', /website 1 commit\(s\): Blog: a new post/);

  // Rollback: the website's main gets the files from before (no blog post, the old build).
  const rp = await rollbackPlan('webgame');
  assert.deepEqual(rp.undo.map((c) => c!.title).sort(), ['Blog: a new post', rp.undo.find((c) => /^Go live/.test(c!.title))!.title].sort());
  await rollback('webgame', { confirm: 'ROLLBACK webgame', by: 'test' });
  assert.equal(git(site.origin, 'rev-parse', 'main~1'), site.remote('beta'));
  assert.throws(() => site.show('main:blog.html'));
  assert.equal(site.show('main:Game/v1/game.js'), 'build 1');
  assert.notEqual(site.remote('main'), liveBefore);

  // The website's main now has a rollback its beta lacks: blocked until merged back, which keeps beta's pages.
  plan = await deployPlan('webgame');
  const lacks = plan.blockers.find((b) => b.startsWith('gamesite'));
  assert.ok(lacks, plan.blockers.join(' | '));
  assert.equal(blockerFix(lacks!), 'merge-main');
  assert.equal(plan.siteMainOnly.length, 1);
  const m = await deploy('webgame', { mergeMain: true, by: 'test' }) as any;
  assert.ok(m.merged);
  assert.ok(m.site.keptBeta);
  assert.equal(site.show('beta:blog.html'), 'a new post');
  assert.deepEqual((await deployPlan('webgame')).siteMainOnly, []);
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});
