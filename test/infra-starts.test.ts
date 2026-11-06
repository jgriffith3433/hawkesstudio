// Starts count only when an agent ran (J, 2026-11-02: 8 of 8 daily starts burned by clones killed, sessions gone and
// shells that refused git; every planned task "waited for a free agent"). Scratch database, no agents, GitHub or Claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-infra-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.TALK_CLAUDE = 'no-such-claude-here';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { istart: 'x/istart' },
  products: [{ id: 'istart', name: 'Istart', framing: 'test', engine: 'static', repo: 'istart', site: 'istart', live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: 'istart', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' }],
  infra: [{ id: 'hawkesstudio', name: 'Hawkes Studio', repo: 'hawkesstudio', slug: 'x/hawkesstudio' }],
}));
const token = process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN = 'test';
after(() => { if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token; });

const I = await import('../src/infra-failure.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
await import('../src/agents.ts');
const R = await import('../src/repos.ts');
const RR = await import('../src/repo-read.ts');
const { db, J } = await import('../src/db.ts');
pm.savePmSettings({ maxConcurrent: 5, maxStartsPerDay: 8 });

let n = 0;
const change = (o: { task?: string | null; findings?: string[]; status: string; detail?: string; phase?: any; created?: number }) => {
  const id = `c_1f0${String(++n).padStart(9, '0')}`;
  const at = o.created ?? Date.now();
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, summary, repo, slug, branch, base, worktree, title, notes, log, commits, phase, created, updated, task)
    VALUES (?, 'istart', ?, ?, ?, '', 'istart', 'x/istart', 'task/x', 'beta', ?, 'A change', '[]', '[]', '[]', ?, ?, ?, ?)`)
    .run(id, J(o.findings ?? []), o.status, o.detail ?? o.status, path.join(tmp, 'none', id), o.phase ? J(o.phase) : null, at, at, o.task ?? null);
  return id;
};
const start = (change: string, subject: string | null = null) => rm.logDecision('start', subject, 'istart', `started ${change} for a thing`);

test('infra failures are told apart from the agent\'s own', () => {
  for (const d of ['checking out beta failed: signal SIGKILL', 'git exited by signal SIGKILL', 'No conversation found with session ID: abc', 'fatal: could not read Username for https://github.com', 'ENOSPC: no space left on device', 'git: command not found', 'the agent\'s shell refused git commit', 'prepare failed: npm ci']) assert.ok(I.isInfraText(d), d);
  for (const d of ['the agent changed nothing', 'tests failed: 3 of 10', 'git commit message was too long to read', '']) assert.ok(!I.isInfraText(d), d);
  assert.ok(I.infraFailed({ status: 'failed', phase: J({ failed: true }) }));
  assert.ok(!I.infraFailed({ status: 'failed', detail: 'the review found a bug' }));
  assert.ok(!I.infraFailed({ status: 'ready', detail: 'SIGKILL' }));
});

test('a start counts only when an agent ran: infrastructure failures are given back', () => {
  assert.equal(pm.startsToday(), 0);
  for (let i = 0; i < 5; i++) start(change({ status: 'failed', detail: 'checking out beta failed: signal SIGKILL' }));
  start(change({ status: 'failed', phase: { step: 'prepare', failed: true } }));
  assert.equal(pm.startsToday(), 0, 'six starts, none of them an agent that ran');
  assert.equal(pm.capacity().free, 5);
  start(change({ status: 'ready', detail: 'pull request open' }));
  start(change({ status: 'failed', detail: 'the agent made no commit' }));
  assert.equal(pm.startsToday(), 2);
  assert.equal(pm.capacity().started, 2);
});

test('the count stays quick on a busy day: it runs many times a pass, on the thread that answers the browser', () => {
  // 2026-11-06: 119 starts by morning froze a customer's Studio for up to 61 s at a time, and it stopped loading.
  const log = 'x'.repeat(64 * 1024);
  const add = db.prepare(`INSERT INTO changes (id, product, findings, status, detail, log, created) VALUES (?, 'istart', '[]', ?, ?, ?, ?)`);
  const logged = db.prepare(`INSERT INTO pm_log (id, at, action, subject, product, detail) VALUES (?, ?, 'start', NULL, 'istart', ?)`);
  const before = pm.startsToday();
  const failedByStudio = (i: number) => i % 10 === 0;
  db.exec('BEGIN');
  for (let i = 0; i < 500; i++) {
    const id = `c_busy${String(i).padStart(8, '0')}`;
    add.run(id, failedByStudio(i) ? 'failed' : 'merged', failedByStudio(i) ? 'checking out beta failed: signal SIGKILL' : 'done', log, Date.now());
    logged.run(`d_busy${i}`, Date.now(), `started ${id} for a thing`);
  }
  db.exec('COMMIT');
  const t = performance.now();
  for (let i = 0; i < 20; i++) assert.equal(pm.startsToday(), before + 450, 'the ones Studio failed to run are still given back');
  const each = (performance.now() - t) / 20;
  assert.ok(each < 50, `one count took ${each.toFixed(1)} ms`);
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as any[]).map((r) => r.detail).join(' ');
  assert.match(plan(`SELECT id FROM changes WHERE status = 'failed' AND created >= 0`), /changes_status_created/);
  assert.match(plan(`SELECT 1 FROM changes WHERE task = 'x' ORDER BY created DESC`), /changes_task/);
  db.exec(`DELETE FROM changes WHERE id LIKE 'c_busy%'; DELETE FROM pm_log WHERE id LIKE 'd_busy%'`);
});

test('one finding may use at most 2 starts a day', () => {
  for (let i = 0; i < 3; i++) start(change({ status: 'failed', detail: 'No conversation found with session ID: x' }), 'f_cap');
  assert.equal(pm.findingStartsToday('f_cap'), 0, 'infrastructure failures are not its starts');
  start(change({ status: 'failed', detail: 'no fix' }), 'f_cap');
  assert.equal(pm.findingStartsToday('f_cap'), 1);
  start(change({ status: 'failed', detail: 'no fix' }), 'f_cap');
  assert.ok(pm.findingStartsToday('f_cap') >= I.MAX_FINDING_STARTS_PER_DAY);
});

test('infra failures back off, longer each time; a task says exactly why it waits', () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(I.infraWaitMs), [10, 20, 40, 80, 240].map((m) => m * 60_000));
  const it = rm.addItem({ product: 'istart', title: 'Voice', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Direct the voices' });
  const now = Date.now();
  assert.equal(pm.infraHoldOf(t.id), null);
  change({ task: t.id, status: 'failed', detail: 'clone failed: SIGKILL', created: now - 60_000 });
  assert.equal(pm.infraHoldOf(t.id), null, "a task's first failure retries at once");
  change({ task: t.id, status: 'failed', detail: 'clone failed: SIGKILL', created: now - 30_000 });
  const hold = pm.infraHoldOf(t.id)!;
  assert.equal(hold.n, 2);
  assert.ok(hold.until > now);
  assert.match(pm.startWaitReason(t, now)!, /Studio could not run its agent 2 times in a row.*trying again \d\d:\d\d UTC/);
  assert.match(rm.taskWaits(rm.getTask(t.id)!)!, /could not run its agent 2 times/);
  // A hold that has run out lets it start.
  assert.equal(pm.infraHoldOf(t.id, now + 3 * 3600_000), null);
});

test('the status says when the daily limit is reached, and when it resets, never "a free agent"', () => {
  pm.savePmSettings({ maxConcurrent: 5, maxStartsPerDay: 2 });
  const it = rm.addItem({ product: 'istart', title: 'Menu', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'The menu bible' });
  const why = pm.startWaitReason(t)!;
  assert.match(why, /^daily start limit \d+\/2 reached, resets 00:00 UTC$/);
  assert.equal(rm.taskWaits(rm.getTask(t.id)!), why);
  assert.ok(pm.stallReasons().some((r) => r.task === t.id && r.why === `waits: ${why}`));
  pm.savePmSettings({ maxConcurrent: 1, maxStartsPerDay: 1000 });
  change({ status: 'working' });
  assert.match(pm.startWaitReason(t)!, /all 1 agent slot is busy/);
  pm.savePmSettings({ maxConcurrent: 5, maxStartsPerDay: 1000 });
  db.prepare(`UPDATE changes SET status = 'closed' WHERE status = 'working'`).run();
  assert.equal(pm.startWaitReason(t), null);
  assert.equal(rm.taskWaits(rm.getTask(t.id)!), 'a free agent (it starts by itself)');
});

test('the self-check logs planned work that has not started for 30 minutes, once an hour', () => {
  const logs: string[] = [];
  pm.resetSelfCheck();
  const now = Date.now();
  const reasons = [{ task: 't_1', title: 'A', product: 'istart', status: 'planned', why: 'waits: daily start limit 8/8 reached, resets 00:00 UTC' }];
  assert.equal(pm.stallSelfCheck(reasons, now - 10 * 60_000, now, (m) => logs.push(m)), null, 'only 10 minutes');
  const msg = pm.stallSelfCheck(reasons, now - 45 * 60_000, now, (m) => logs.push(m))!;
  assert.match(msg, /1 planned task\(s\) have not started for 45 min: 1 waits: daily start limit 8\/8/);
  assert.equal(logs.length, 1);
  assert.equal(pm.stallSelfCheck(reasons, now - 45 * 60_000, now + 60_000, (m) => logs.push(m)), null, 'once an hour');
  assert.ok(rm.listDecisions({ action: 'stall-check' }).length >= 1);
});

test('a big clone caps git memory and cleans leftovers first', () => {
  const args = R.cloneArgs('o/n', 'n', true);
  assert.deepEqual(args.slice(0, 8), ['-c', 'pack.threads=1', '-c', 'core.packedGitLimit=128m', '-c', 'core.packedGitWindowSize=32m', '-c', 'core.deltaBaseCacheLimit=64m']);
  assert.ok(args.includes('--filter=blob:none'));
  assert.equal(R.cloneArgs('o/n', 'n', false)[0], 'clone');
  const cfg = Object.fromEntries(R.LIGHT_CONFIG);
  assert.equal(cfg['pack.threads'], '1');
  assert.equal(cfg['core.packedGitLimit'], '128m');
  const proj = path.join(tmp, 'clean');
  fs.mkdirSync(path.join(proj, '.trash', 'old'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'big'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'big', 'half'), 'x');
  fs.mkdirSync(path.join(proj, 'keep', '.git'), { recursive: true });
  const removed = R.cleanBeforeClone(proj, 'big');
  assert.ok(removed.includes(path.join('.trash', 'old')) && removed.includes('big'));
  assert.ok(fs.existsSync(path.join(proj, 'keep')), 'a real checkout is never touched');
  assert.deepEqual(R.cleanBeforeClone(proj, 'keep'), []);
});

test("without a clone, a scout reads the repo through GitHub's tarball (private repo, token, no art)", async () => {
  const src = path.join(tmp, 'tarsrc', 'o-n-abc123');
  fs.mkdirSync(path.join(src, 'Assets', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Assets', 'Scripts', 'Player.cs'), 'class Player {}');
  fs.writeFileSync(path.join(src, 'Assets', 'hero.png'), 'not source');
  fs.writeFileSync(path.join(src, 'AGENTS.md'), '# Agents');
  const tgz = path.join(tmp, 'x.tgz');
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', path.join(tmp, 'tarsrc'), 'o-n-abc123']).status, 0);
  const seen: any[] = [];
  const fetcher = (async (url: string, init: any) => { seen.push({ url, auth: init.headers.Authorization }); return new Response(fs.readFileSync(tgz)); }) as any;
  const dest = path.join(tmp, 'scoutwt');
  const got = await RR.readRepoViaApi('o/n', 'beta', dest, { fetcher, token: 'tok' });
  assert.equal(seen[0].url, 'https://api.github.com/repos/o/n/tarball/beta');
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.ok(fs.existsSync(path.join(dest, 'Assets', 'Scripts', 'Player.cs')), 'the source is there');
  assert.ok(fs.existsSync(path.join(dest, 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(dest, 'Assets', 'hero.png')), 'art is left out');
  assert.equal(got.files, 2);
  await assert.rejects(RR.readRepoViaApi('o/n', 'beta', dest, { fetcher, token: null }), /no GitHub token/);
  await assert.rejects(RR.readRepoViaApi('o/n', 'beta', dest, { fetcher: (async () => new Response('no', { status: 404 })) as any, token: 't' }), /HTTP 404/);
});
