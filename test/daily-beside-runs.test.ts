// The daily run goes beside beta, build and playtest runs (2026-11: POST /api/cloud/daily answered "a run is already
// going" whenever any run was, so the 05:00 call never started one and 0 daily reports existed). Only another daily run,
// or today's finished one, refuses it, and a refusal is a skipped daily run in Activity, never silent. Fake Gen; scratch
// database; no products, so a daily run that starts ends at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-daily-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.STUDIO_MAIL = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC', 'K_SERVICE', 'STUDIO_BRIEF']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ repos: {}, products: [], infra: [] }));

const { gen } = await import('../src/gen.ts');
// Gen answers its health check; anything else it is asked (the playtest capacity) is "offline", at once.
Object.assign(gen as any, {
  health: async () => ({ ok: true }),
  request: async () => { throw Object.assign(new Error('offline in tests'), { status: 0 }); },
});
const P = await import('../src/pipeline.ts');
const { sinceLastReport } = await import('../src/report.ts');
const { db, J } = await import('../src/db.ts');

let n = 0;
function seed(kind: string, status = 'running', started = Date.now() - 60_000) {
  const id = `r_dd${String(++n).padStart(10, '0')}`;
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, status, 'x', J(['gw']), J({}), started);
  return id;
}
const row = (id: string) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any;
const dailies = () => db.prepare(`SELECT * FROM runs WHERE kind = 'daily' ORDER BY started`).all() as any[];
const clear = () => db.prepare('DELETE FROM runs').run();

test('a daily call while beta, build and playtest runs are going starts a daily run beside them', async () => {
  clear();
  const others = [seed('beta'), seed('build'), seed('playtest')];
  assert.ok(P.activeRun(), 'a run is going');
  const d = P.startScheduledDaily();
  assert.equal(d.started, true, `started (${!d.started ? d.why : ''})`);
  if (!d.started) return;
  assert.equal(row(d.id).kind, 'daily');
  assert.equal(row(d.id).status, 'running');
  for (const id of others) assert.equal(row(id).status, 'running', 'the other runs are left going');
  await d.done;
  assert.equal(row(d.id).status, 'done');
  assert.equal(dailies().filter((r) => r.status === 'skipped').length, 0, 'nothing recorded as skipped');
});

test('startRun("daily") itself goes beside other runs; a manual run is still one at a time', async () => {
  clear();
  seed('beta');
  const { id, done } = P.startRun('daily', {});
  assert.equal(row(id).status, 'running');
  await done;
  seed('build');
  assert.throws(() => P.startRun('manual', {}), /already going/);
});

test('a second daily call while a daily run is going is refused, and the refusal is a visible skipped daily run', () => {
  clear();
  seed('beta');
  const going = seed('daily');
  const d = P.startScheduledDaily();
  assert.equal(d.started, false);
  if (d.started) return;
  assert.equal(d.run, going);
  assert.match(d.why, new RegExp(`${going} is still going`));
  const skipped = row(d.id);
  assert.equal(skipped.kind, 'daily');
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.detail, /^daily run not started: the daily run r_dd\d+ is still going/);
  assert.ok(skipped.finished, 'a finished row, so the PM reads it like any ended daily run');
  // In Activity's run list, with its reason.
  assert.ok(P.listRuns(10).some((r: any) => r.id === d.id && r.status === 'skipped'));
  // Only one daily run going: the refused call started nothing.
  assert.equal(dailies().filter((r) => r.status === 'running').length, 1);
});

test("today's finished daily run refuses another; a daily left stale for 6 hours does not", () => {
  clear();
  const ran = seed('daily', 'done', Date.now() - 1000);
  const d = P.startScheduledDaily();
  assert.equal(d.started, false);
  if (!d.started) assert.match(d.why, new RegExp(`today's daily run ${ran} already ran`));

  clear();
  const stale = seed('daily', 'running', Date.now() - 7 * 3600_000);
  assert.equal(P.dailyRefusal(), null, 'a daily run whose process died is replaced');
  const again = P.startScheduledDaily();
  assert.equal(again.started, true);
  assert.equal(row(stale).status, 'abandoned');
  return again.started ? again.done : undefined;
});

test("a skipped daily run isn't the daily before the next report", () => {
  clear();
  const before = seed('daily', 'done', Date.now() - 3 * 3600_000);
  const beta = seed('beta', 'done', Date.now() - 2 * 3600_000);
  P.recordDailySkip('the daily run r_x is still going');
  const next = seed('daily', 'running', Date.now() + 1000);
  assert.ok(before);
  assert.deepEqual(sinceLastReport(next).map((r: any) => r.run), [beta]);
});
