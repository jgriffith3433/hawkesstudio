// A merged task waiting on beta's build says what is happening (J, 2026-11-11: Sick of It's 25 merged tasks said "broken
// build: beta's build failed (run r_cf94...)" every 30 minutes while the build fix's run was building): a newer beta run
// that is going reads as `waiting` (outcomes.ts buildOutcome), and the reason names that run and its commit, never the
// older failure. With nothing building, the failure stands. Scratch database, no GitHub, agents or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stale-build-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { sbr: 'x/sbr' },
  products: [{ id: 'sbr', name: 'Stale Build Game', framing: 'test', engine: 'static', repo: 'sbr', site: 'sbr', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'sbr', port: 8795, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' }],
  infra: [],
}));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const { buildInProgress } = await import('../src/betabuild.ts');
const { db, J } = await import('../src/db.ts');
await import('../src/agents.ts');
await import('../src/builds.ts'); // the builds table

const now = Date.now();
const run = (id: string, status: string, started: number, finished: number | null = null) =>
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, 'beta', ?, 'beta', ?, ?, ?)`).run(id, status, J(['sbr']), started, finished);

test('a merged task waiting on a build in progress says so: the run and the commit, not the older failure', () => {
  const it = rm.addItem({ product: 'sbr', title: 'Work', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Something' });
  run('r_sbr_old', 'failed', now - 3 * 3600_000, now - 2 * 3600_000);
  rm.setTask(t.id, { status: 'merged', merged_at: now - 4 * 3600_000, build: { ok: false, run: 'r_sbr_old', at: now - 2 * 3600_000, unity: true, detail: "beta's build failed (run r_sbr_old): build of beta 595222d" } });
  // Nothing is building: the failure stands.
  assert.equal(buildInProgress('sbr', 'r_sbr_old'), null);
  assert.match(rm.taskWaits(rm.getTask(t.id)!)!, /a fix: beta's build failed/);
  assert.ok(pm.stallReasons().some((r) => r.task === t.id && /^broken build/.test(r.why)));

  // The fix's build is running now, of a commit.
  run('r_sbr_new', 'running', now - 10 * 60_000);
  db.prepare(`INSERT INTO builds (id, product, build, version, status, sha, runner, target, run, started) VALUES ('b_sbr1', 'sbr', 'unity', 1, 'building', 'a784d68aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'gen', 'beta', 'r_sbr_new', ?)`).run(now - 9 * 60_000);
  assert.deepEqual(buildInProgress('sbr', 'r_sbr_old'), { run: 'r_sbr_new', sha: 'a784d68aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const waits = rm.taskWaits(rm.getTask(t.id)!)!;
  assert.match(waits, /a784d68/);
  assert.match(waits, /r_sbr_new/);
  assert.match(waits, /building now/);
  assert.doesNotMatch(waits, /a fix: beta's build failed/);
  const why = pm.stallReasons().find((r) => r.task === t.id)!.why;
  assert.match(why, /r_sbr_new.*a784d68|a784d68.*r_sbr_new/);
  assert.doesNotMatch(why, /broken build/, 'a reason that reads like a stall while work is moving');

  // A run that was cancelled, or held, or older than the failure, is not a build in progress.
  db.prepare(`UPDATE runs SET status = 'cancelled' WHERE id = 'r_sbr_new'`).run();
  assert.equal(buildInProgress('sbr', 'r_sbr_old'), null);
  db.prepare(`UPDATE runs SET status = 'running', started = ? WHERE id = 'r_sbr_new'`).run(now - 4 * 3600_000);
  assert.equal(buildInProgress('sbr', 'r_sbr_old'), null, 'started before the failed run: not a newer build');
});
