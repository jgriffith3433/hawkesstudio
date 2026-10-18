// A failed beta build goes back to ONE change, the right one (2026-10-18: one failed Sick Of It build sent three agents
// after the same one-line GameConfig error, all to whichever change merged last, though the error was in another
// change's file and a later merge had fixed it). Beta moved since the failed build: nothing is sent back, the newer
// commit's build decides. The build's errors name a file: the change that touched it goes back, with the error lines.
// One send-back per failed build, and none while an earlier send-back is still fixing beta's build. Scratch database,
// GitHub standing in, no agents or Claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-blame-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
const ids = ['bbfile', 'bbmoved'];
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: Object.fromEntries(ids.map((id) => [id, `x/${id}`])),
  products: ids.map((id) => ({
    id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: id, port: 8794, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  })),
  infra: [],
}));

// GitHub, standing in: the files each pull request touched.
const prFiles: Record<string, string[]> = {
  '/repos/x/bbfile/pulls/1/files': ['Assets/GameConfig/levels/Level2.json', 'Assets/GameConfig/game.json'],
  '/repos/x/bbfile/pulls/2/files': ['Assets/Scripts/Shop.cs'],
};
const github = http.createServer((req, res) => {
  const files = prFiles[new URL(req.url!, 'http://x').pathname];
  res.writeHead(files ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(files ? files.map((filename) => ({ filename })) : { message: 'Not Found' }));
});
await new Promise<void>((r) => github.listen(0, '127.0.0.1', () => r()));
process.env.STUDIO_GITHUB_API = `http://127.0.0.1:${(github.address() as any).port}`;
const token = process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN = 'test';
after(() => {
  github.close();
  if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token;
});

const blame = await import('../src/buildblame.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const { db, J } = await import('../src/db.ts');
await import('../src/agents.ts'); // the changes table

const LOG = [
  '[Hawkes] Step 2: importing the game config',
  'Game config import FAILED: 1 error(s), 0 warning(s). Full report: Logs/GameConfig.log',
  'ERROR   levels/Level2.json:14 @script[3].line - Unknown speaker "Bob".',
  'UnityEngine.Debug:LogError (object)',
  'Exiting batchmode with code 1',
].join('\n');

let n = 0;
const change = (product: string, task: string, pr: number, merged_at: number) => {
  const id = `c_bb0${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, verify, merged_at, pr, pr_url)
    VALUES (?, ?, '[]', 'merged', ?, ?, 'task/x', 'beta', ?, 'A change', '[]', '[]', ?, ?, ?, '{}', ?, ?, ?)`)
    .run(id, product, product, `x/${product}`, path.join(tmp, 'none', id), Date.now(), Date.now(), task, merged_at, pr, `https://github.test/x/${product}/pull/${pr}`);
  return id;
};
const run = (product: string, status: string, started: number, build?: { data: Record<string, any> }) => {
  const id = `r_bb0${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, 'beta', ?, ?, ?, ?, ?)`).run(id, status, `beta ${product}`, J([product]), started, status === 'running' ? null : started + 1000);
  if (build) db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, ?, 'build', 'unity', 'failed', ?, ?, ?)`)
    .run(`s_${id.slice(2)}`, id, product, 'failed: Unity exited with code 1', J(build.data), started);
  return id;
};
const mergedTask = (product: string, title: string, pr: number, at: number) => {
  const it = rm.addItem({ product, title, status: 'planned' });
  const t = rm.addTask({ item: it.id, request: title });
  const c = change(product, t.id, pr, at);
  rm.setTask(t.id, { status: 'merged', change: c, changes: [c], tries: 1, merged_at: at + 2000 });
  return t.id;
};
const sendbacks = (task: string) => rm.listDecisions({ action: 'build-sendback', limit: 10_000 }).filter((d) => d.subject === task).length;

test('the error lines and the files they name come out of a Unity log', () => {
  const e = blame.buildErrors(`${LOG}\nAssets/Scripts/Shop.cs(12,5): error CS1002: ; expected\nAssets/Scripts/Shop.cs(12,5): error CS1002: ; expected`);
  assert.deepEqual(e.files, ['levels/Level2.json', 'Assets/Scripts/Shop.cs']);
  assert.equal(e.lines.length, 3, 'each line once');
  assert.match(e.lines[1], /Unknown speaker "Bob"/);
  // GameConfig's paths are relative to Assets/GameConfig: the change touching the longer path matches.
  assert.deepEqual(blame.touches(['Assets/GameConfig/levels/Level2.json', 'README.md'], ['levels/Level2.json']), ['Assets/GameConfig/levels/Level2.json']);
  assert.deepEqual(blame.touches(['Assets/GameConfig/levels/Level20.json'], ['levels/Level2.json']), []);
  const pick = blame.pickCulprit([{ id: 'a', at: 1, files: ['Assets/GameConfig/levels/Level2.json'] }, { id: 'b', at: 2, files: ['x.cs'] }], e.files);
  assert.equal(pick.culprit.id, 'a');
  assert.equal(blame.pickCulprit([{ id: 'a', at: 1, files: [] }, { id: 'b', at: 2, files: [] }], e.files).culprit.id, 'b', 'no match: the latest');
});

test("an error in a file goes back to the change that touched it, with the error lines; once per failed build, and not again while it's being fixed", async () => {
  const s = pm.pmSettings();
  try {
    const t0 = Date.now() - 60_000;
    const a = mergedTask('bbfile', 'Level 2 dialogue', 1, t0);
    const b = mergedTask('bbfile', 'Shop prices', 2, t0 + 5000);
    const bad = run('bbfile', 'failed', t0 + 10_000, { data: { error: 'Unity exited with code 1', errors: [], logTail: LOG } });
    await pm.followBuilds();
    assert.equal(rm.getTask(a)!.status, 'working', 'the change that touched levels/Level2.json goes back');
    assert.equal(rm.getTask(b)!.status, 'merged', 'the one merged last stays');
    const req = (db.prepare('SELECT request FROM changes WHERE id = ?').get(rm.getTask(a)!.change) as any).request as string;
    assert.match(req, /Unknown speaker "Bob"/, 'the error lines are in the brief');
    assert.match(req, /Assets\/GameConfig\/levels\/Level2\.json/);
    assert.ok(rm.listDecisions({ action: 'build-failed' }).some((d) => d.subject === bad && /touched/.test(d.detail ?? "")));
    // The same failed build isn't decided twice.
    await pm.followBuilds();
    assert.equal(sendbacks(a), 1);
    assert.equal(sendbacks(b), 0);
    // Beta fails again (same commit, another run) while that fix is still being worked on: nothing more goes back.
    const again = run('bbfile', 'failed', t0 + 20_000, { data: { errors: [], logTail: LOG } });
    await pm.followBuilds();
    assert.equal(rm.getTask(b)!.status, 'merged');
    assert.equal(sendbacks(b), 0, 'no second agent on the same error');
    assert.ok(rm.listDecisions({ action: 'build-failed' }).some((d) => d.subject === again));
  } finally {
    pm.savePmSettings({ enabled: s.enabled });
  }
});

test('beta moved since the failed build: nothing goes back; the newer commit decides', async () => {
  // The product's source checkout: origin/beta is a newer commit than the one the failed build built.
  const dir = path.join(process.env.STUDIO_PROJECTS!, 'bbmoved');
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  const c = (m: string) => { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m); return git('rev-parse', 'HEAD'); };
  const built = c('the broken one');
  const fixed = c('the fix (#30)');
  git('update-ref', `refs/remotes/origin/beta`, fixed);
  const t0 = Date.now() - 60_000;
  const a = mergedTask('bbmoved', 'Broke it', 3, t0);
  const bad = run('bbmoved', 'failed', t0 + 10_000, { data: { beta: built, errors: [], logTail: LOG } });
  const newer = run('bbmoved', 'running', t0 + 20_000);
  await pm.followBuilds();
  assert.equal(rm.getTask(a)!.status, 'merged', 'not sent back');
  assert.equal(sendbacks(a), 0);
  const d = rm.listDecisions({ action: 'build-failed' }).find((x) => x.subject === bad);
  assert.ok(d, 'decided once');
  assert.match(d.detail!, /moved/);
  assert.match(d.detail!, new RegExp(newer));
  await pm.followBuilds();
  assert.equal(sendbacks(a), 0);
});

test("a fetch race in the beta run's repo step isn't a failed build (nothing goes back for it)", () => {
  const run = 'r_fetchrace';
  db.prepare("INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES (?, 'beta', 'failed', 'beta bbfile', '[]', '{}', ?, ?)").run(run, Date.now(), Date.now());
  const step = (id: string, kind: string, status: string, detail: string) => db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, run, 'bbfile', kind, kind, status, detail, Date.now(), Date.now());
  step('s_fr1', 'repo', 'failed', "fetch failed: error: cannot lock ref 'refs/remotes/origin/beta': is at 1111 but expected 2222");
  step('s_fr2', 'build', 'done', 'v153');
  assert.equal(pm.buildOf('bbfile', { id: run, status: 'failed' }).ok, true);
  step('s_fr3', 'repo', 'failed', 'fetch failed: fatal: could not read from remote repository');
  assert.equal(pm.buildOf('bbfile', { id: run, status: 'failed' }).ok, false);
});
