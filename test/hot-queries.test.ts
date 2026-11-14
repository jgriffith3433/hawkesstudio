// Studio's checks stay quick however much history piles up (2026-11-14: 50 event-loop freezes an hour of 2-5 s; the CPU
// profiles named buildInProgress, betaPart, listDecisions and lastBuilds, each reading whole tables on every PM pass and
// page). The lookups the PM and the pages make on every pass search an index, never scan runs, steps, builds, pm_log or
// tasks, and a look at what is building reads only what is building, not every finished run since a failure.
// Scratch database, no GitHub, agents or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hot-queries-'));
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
  repos: { hq: 'x/hq' },
  products: [{ id: 'hq', name: 'Hot Query Game', framing: 'test', engine: 'static', repo: 'hq', site: 'hq', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'hq', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' }],
  infra: [],
}));

const rm = await import('../src/roadmap.ts');
const { buildInProgress } = await import('../src/betabuild.ts');
const { betaPart } = await import('../src/change-rail.ts');
const { lastBuilds } = await import('../src/buildfail.ts');
const { buildCancelled } = await import('../src/cancel.ts');
const { db, J } = await import('../src/db.ts');
await import('../src/agents.ts');
await import('../src/builds.ts');

// A Studio that has been busy for weeks: thousands of finished beta runs with their steps and builds, a long PM log.
const now = Date.now();
const N = 3000;
const insRun = db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished, report) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`);
const insStep = db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, 'hq', ?, ?, ?, 'x', ?, ?, ?)`);
const insBuild = db.prepare(`INSERT INTO builds (id, product, build, version, status, sha, runner, target, run, started, finished) VALUES (?, 'hq', 'web', ?, 'done', ?, 'gen', 'web', ?, ?, ?)`);
const insLog = db.prepare(`INSERT INTO pm_log (id, at, action, subject, product, detail) VALUES (?, ?, ?, ?, 'hq', 'x')`);
db.exec('BEGIN');
for (let i = 0; i < N; i++) {
  const at = now - (N - i) * 60_000;
  insRun.run(`r_${i}`, i % 3 ? 'beta' : 'daily', i % 7 ? 'done' : 'failed', J(['hq']), at, at + 30_000, 'r'.repeat(2000));
  insStep.run(`s_${i}_b`, `r_${i}`, 'build', 'web', i % 7 ? 'done' : 'failed', J({ built: { sha: 'a'.repeat(40) } }), at, at + 10_000);
  insStep.run(`s_${i}_p`, `r_${i}`, 'playtest', 'smoke', 'done', '{}', at + 10_000, at + 20_000);
  insBuild.run(`b_${i}`, i, 'b'.repeat(40), `r_${i}`, at, at + 10_000);
  insLog.run(`d_${i}`, at, i % 2 ? 'beta-check' : 'replan', `t_${i % 50}`);
}
insRun.run('r_going', 'beta', 'running', J(['hq']), now, null, null);
insStep.run('s_going_b', 'r_going', 'build', 'web', 'running', J({ sha: 'c'.repeat(40) }), now, null);
db.exec('COMMIT');

// Every statement the hot path prepares, with how often.
function capture(fn: () => unknown) {
  const seen: string[] = [];
  const real = (db as any).prepare;
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { fn(); } finally { (db as any).prepare = real; }
  return seen;
}
const HOT = /^SCAN (runs|steps|builds|pm_log|tasks)\b/;
function scans(sqls: string[]) {
  const out: string[] = [];
  for (const sql of new Set(sqls)) {
    if (!/^\s*SELECT/i.test(sql)) continue;
    const params = (sql.match(/\?/g) ?? []).length;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(params).fill(null)) as { detail: string }[];
    for (const p of plan) if (HOT.test(p.detail)) out.push(`${p.detail}  <-  ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return out;
}

test('what is building reads only the running and queued beta runs, not every finished run since the failure', () => {
  const sqls = capture(() => {
    assert.deepEqual(buildInProgress('hq', 'r_1'), { run: 'r_going', sha: 'c'.repeat(40) });
    assert.deepEqual(buildInProgress('hq', null), { run: 'r_going', sha: 'c'.repeat(40) });
  });
  assert.ok(sqls.length <= 12, `buildInProgress made ${sqls.length} queries over ${N} finished runs; it must not grow with history`);
  assert.deepEqual(scans(sqls), []);
});

test('nothing building: the failure stands, and the look is still a handful of indexed queries', () => {
  db.prepare("UPDATE runs SET status = 'done' WHERE id = 'r_going'").run();
  try {
    const sqls = capture(() => assert.equal(buildInProgress('hq', 'r_1'), null));
    assert.ok(sqls.length <= 3, `${sqls.length} queries`);
    assert.deepEqual(scans(sqls), []);
  } finally { db.prepare("UPDATE runs SET status = 'running' WHERE id = 'r_going'").run(); }
});

test("the PM's and the pages' per-pass lookups search an index, never scan the big tables", () => {
  const sqls = capture(() => {
    betaPart('hq', now - 30 * 60_000);
    lastBuilds('hq');
    buildCancelled('r_5', 'hq');
    rm.listDecisions({ since: now - 6 * 3600_000, action: 'beta-check' });
    rm.taskWaits({ id: 't_1', status: 'failed', product: 'hq', change: null } as any, new Set());
  });
  // The running beta run of a product (pm.ts checkOnBeta) and a run's builds, as the PM asks for them.
  sqls.push(`SELECT id FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ?`);
  sqls.push("SELECT sha FROM builds WHERE run = ? AND product = ? AND sha IS NOT NULL ORDER BY started DESC LIMIT 1");
  sqls.push(`SELECT id, options, started FROM runs WHERE kind = 'build' AND status = 'running' AND products LIKE ? ORDER BY started DESC`);
  assert.deepEqual(scans(sqls), []);
});

test("one subject's decisions are searched in SQLite, not picked out of every decision of the action", () => {
  const sqls = capture(() => {
    const mine = rm.listDecisions({ since: 0, action: 'replan', limit: 10_000, subject: 't_4' });
    assert.ok(mine.length > 0 && mine.every((d) => d.subject === 't_4' && d.action === 'replan'));
    assert.equal(rm.listDecisions({ since: 0, action: 'replan', subject: 'nobody' }).length, 0);
    assert.equal(rm.listDecisions({ since: 0, action: 'replan', subject: null as any }).length, 0, 'no subject matches nothing, never everything');
  });
  assert.deepEqual(scans(sqls), []);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sqls.find((s) => /subject = \?/.test(s))}`).all(0, 'replan', 't_4', 100) as { detail: string }[]).map((p) => p.detail).join(' | ');
  assert.match(plan, /USING INDEX pm_log_(subject|action)/, plan);
});

test("what is building is read once per product until runs, steps or builds are written", () => {
  db.prepare("UPDATE runs SET status = 'running' WHERE id = 'r_going'").run();
  assert.deepEqual(buildInProgress('hq', 'r_2'), { run: 'r_going', sha: 'c'.repeat(40) });
  const again = capture(() => { for (let i = 0; i < 200; i++) buildInProgress('hq', 'r_2'); });
  assert.equal(again.length, 0, 'two hundred merged tasks of one product: no query after the first');
  // A write moves it (a prepared statement, or db.exec).
  db.exec("UPDATE runs SET status = 'done' WHERE id = 'r_going'");
  assert.equal(buildInProgress('hq', 'r_2'), null, 'db.exec writes are seen');
  db.prepare("UPDATE runs SET status = 'running' WHERE id = 'r_going'").run();
  assert.deepEqual(buildInProgress('hq', 'r_2'), { run: 'r_going', sha: 'c'.repeat(40) });
});
