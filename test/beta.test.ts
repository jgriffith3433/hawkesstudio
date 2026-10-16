// The beta lane end to end on throwaway git repos (a temp "Projects" folder with a bare origin): beta made from main,
// the go-live plan, going live only for a playtested beta, rollback as a new commit, and main merged back into beta.
// Nothing here touches a real repo or Studio's own database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-beta-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'betatest', name: 'Beta test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8798, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const dir = path.join(process.env.STUDIO_PROJECTS, 'site');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, dir);
const commit = (file: string, text: string, msg: string) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', msg);
};
commit('index.html', 'v1', 'First');
git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
const remote = (ref: string) => git(origin, 'rev-parse', ref);

const beta = await import('../src/beta.ts');
const { deployPlan, deploy, rollbackPlan, rollback } = await import('../src/deploy.ts');
const { db, newId, J } = await import('../src/db.ts');
const played = (sha: string, outcome = 'won') => db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(newId('s'), newId('r'), 'betatest', 'playtest', 'smoke@local', 'done', outcome, J({ outcome, played: { branch: 'beta', sha } }), Date.now(), Date.now());

test('beta lane: plan, go live, rollback, merge main back', async () => {
  // No beta yet: the plan says so; ensureBeta makes it from main.
  assert.equal((await beta.compareBeta(dir)).beta, null);
  assert.match((await deployPlan('betatest')).blockers.join(' '), /no beta branch yet/);
  const made = await beta.ensureBeta(dir);
  assert.ok(made.created);
  assert.equal(remote('beta'), remote('main'));
  assert.match((await deployPlan('betatest')).blockers.join(' '), /Nothing to go live/);

  // Two approved changes land on beta.
  git(dir, 'checkout', '--quiet', '-b', 'beta', 'origin/beta');
  commit('index.html', 'v2', 'Fix: the title');
  commit('about.html', 'about', 'Add an about page');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  let plan = await deployPlan('betatest');
  assert.deepEqual(plan.commits.map((c) => c!.title), ['Add an about page', 'Fix: the title']);
  assert.equal(plan.commits[0]!.author, 'Test');
  assert.equal(plan.beta!.sha, remote('beta'));
  assert.equal(plan.canDeploy, false);
  assert.match(plan.blockers.join(' '), /hasn't been playtested/);

  // An older playtest doesn't count; the playtest of the exact beta commit does.
  played(remote('main'));
  assert.match((await deployPlan('betatest')).blockers.join(' '), /hasn't been playtested at/);
  played(remote('beta'), 'won');
  plan = await deployPlan('betatest');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.tested.playtests[0].name, 'smoke@local');
  assert.match(plan.warnings.join(' '), /no review/);

  // Going live needs J's exact words; then main is fast-forwarded to the tested beta.
  await assert.rejects(deploy('betatest', { confirm: 'yes' }), /DEPLOY betatest/);
  const before = remote('main');
  const r = await deploy('betatest', { confirm: 'DEPLOY betatest', by: 'test' });
  assert.equal(remote('main'), remote('beta'));
  assert.equal(r.main, remote('main').slice(0, 7));
  assert.match((await deployPlan('betatest')).blockers.join(' '), /Nothing to go live/);

  // Beta moves again but isn't played: refused.
  commit('index.html', 'v3', 'Fix: a typo');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  await assert.rejects(deploy('betatest', { confirm: 'DEPLOY betatest' }), /hasn't been playtested at/);

  // Rollback: a new commit on main with the files from before the go live (no force push).
  const rp = await rollbackPlan('betatest');
  assert.equal(rp.to!.sha, before);
  assert.deepEqual(rp.undo.map((c) => c!.title), ['Add an about page', 'Fix: the title']);
  await assert.rejects(rollback('betatest', { confirm: 'ROLLBACK' }), /ROLLBACK betatest/);
  const liveBefore = remote('main');
  await rollback('betatest', { confirm: 'ROLLBACK betatest', by: 'test' });
  assert.equal(git(origin, 'rev-parse', 'main~1'), liveBefore);
  assert.equal(git(origin, 'show', 'main:index.html'), 'v1');
  assert.throws(() => git(origin, 'show', 'main:about.html'));
  assert.match((await rollbackPlan('betatest')).blockers.join(' '), /No go live/);

  // main now has a rollback beta lacks: going live is blocked until main is merged into beta, which keeps beta's files.
  played(remote('beta'));
  assert.match((await deployPlan('betatest')).blockers.join(' '), /merge-main/);
  const m = await deploy('betatest', { mergeMain: true, by: 'test' }) as any;
  assert.ok(m.keptBeta);
  assert.equal(git(origin, 'show', 'beta:index.html'), 'v3');
  assert.equal(git(origin, 'show', 'beta:about.html'), 'about');
  plan = await deployPlan('betatest');
  assert.deepEqual(plan.mainOnly, []);
  assert.match(plan.blockers.join(' '), /hasn't been playtested at/);
  played(remote('beta'));
  await deploy('betatest', { confirm: 'DEPLOY betatest', by: 'test' });
  assert.equal(git(origin, 'show', 'main:index.html'), 'v3');
  assert.equal(beta.listDeploys('betatest').length, 3);
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});
