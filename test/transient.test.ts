// Transient failures retry by themselves (J, 2026-11-09): a Gen lookup that fails is a 503 the import tool retries (a real
// 404 stays 404); a playtest refused with 429 is played again later; runs and changes Studio's restarts stopped start
// again once Studio is stable; a standalone beta playtest that passed asks for the automatic go-live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transient-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_BETA_LANE = '1';
process.env.STUDIO_RESUME_GAP_MS = '0';
const A = await import('../src/access.ts');
const B = await import('../src/backoff.ts');
const T = await import('../src/transient.ts');
const { db } = await import('../src/db.ts');
const P = await import('../src/pipeline.ts');
const { getChange, reviveRestartStopped } = await import('../src/agents.ts');
await import('../src/builds.ts');

const err = (status: number) => Object.assign(new Error(`Hawkes Gen answered ${status}`), { status });
const noSleep = async () => {};
const asset = { project: 'org_abc.game', title: 't', path: 'x.mp3' };
const base = { asset: 'a_0123456789abcdef', genOrg: 'org_abc', ownerEmails: [], wantOwners: false, bytes: async () => ({ bytes: Buffer.from('x'), mime: 'audio/mpeg' }) };

// ---- 1. Gen lookups
test('a Gen lookup that fails is a 503, not "no access"; Gen\'s 404 and a foreign file stay 404', async () => {
  await assert.rejects(A.controlGenAsset({ ...base, admin: async () => { throw err(502); } }), (e: any) => e.status === 503 && /didn't answer, retrying/.test(e.message));
  await assert.rejects(A.controlGenAsset({ ...base, admin: async () => { throw new Error('fetch failed'); } }), (e: any) => e.status === 503);
  await assert.rejects(A.controlGenAsset({ ...base, admin: async () => { throw err(404); } }), (e: any) => e.status === 404 && /No Gen file/.test(e.message));
  await assert.rejects(A.controlGenAsset({ ...base, admin: async () => ({ ...asset, project: 'org_other.game' }) }), (e: any) => e.status === 404);
  const f = await A.controlGenAsset({ ...base, admin: async () => asset });
  assert.equal(f.via, 'own');
});

test('the owner account search failing is a 503 too', async () => {
  await assert.rejects(A.personalProjectsOf(['a@b.co'], async () => { throw err(500); }), (e: any) => e.status === 503);
  assert.deepEqual([...(await A.personalProjectsOf(['a@b.co'], async () => ({ items: [] })))], []);
});

test('importGenFile: Gen down is 503, an unknown asset 404', async () => {
  const deps = (ownAsset: any) => ({ access: async () => ({ gen: false }) as any, ownOrg: () => null, inCell: () => false, ownAsset, ownBytes: async () => { throw new Error('unused'); }, cellAsset: async () => { throw new Error('unused'); }, ownerProjects: async () => new Set<string>(), copyIn: null, transform: async () => { throw new Error('unused'); } });
  await assert.rejects(A.importGenFile({ asset: 'a_1', product: 'x' }, deps(async () => { throw err(503); }) as any), (e: any) => e.status === 503);
  await assert.rejects(A.importGenFile({ asset: 'a_1', product: 'x' }, deps(async () => { throw err(404); }) as any), (e: any) => e.status === 404);
});

test('the import is retried at 30 s, 2 min, 5 min and succeeds once Gen answers; a 404 is not retried', async () => {
  assert.deepEqual(B.IMPORT_RETRY_MS, [30_000, 120_000, 300_000]);
  let n = 0; const waited: number[] = [];
  const r = await B.retryWithBackoff(async () => { if (++n < 3) throw err(503); return 'imported'; }, { sleep: async (ms) => { waited.push(ms); } });
  assert.equal(r, 'imported');
  assert.deepEqual(waited, [30_000, 120_000]);
  let m = 0;
  await assert.rejects(B.retryWithBackoff(async () => { m++; throw err(404); }, { sleep: noSleep }), (e: any) => e.status === 404);
  assert.equal(m, 1);
  let k = 0;
  await assert.rejects(B.retryWithBackoff(async () => { k++; throw err(503); }, { sleep: noSleep }), (e: any) => e.status === 503);
  assert.equal(k, 4); // the first try and three retries, then the agent sees the error
});

// ---- 2. 429
test('a 429 is rate limiting; other errors are not', () => {
  assert.ok(T.isRateLimited(err(429)));
  assert.ok(T.isRateLimited(new Error('HTTP 429 Too Many Requests')));
  assert.ok(!T.isRateLimited(new Error('port 14290 in use')));
});

test('a playtest refused with 429 is played again, reports to the same origin, waits longer each time, and gives up after the last', async () => {
  const started: any[] = [];
  T.hooks.start = async (kind, product, spec, origin) => { started.push({ kind, product, spec, origin }); return `r_next${started.length}`; };
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started, origin) VALUES ('r_429a', 'playtest', 'cancelled', 'x', '["dod"]', '{}', ?, 't_abc123def')`).run(Date.now());
  const due = T.scheduleRateRetry({ run: 'r_429a', product: 'dod', kind: 'playtest', spec: { scenario: 'smoke', where: 'local' }, why: 'HTTP 429' });
  assert.ok(due && due - Date.now() > 100_000 && due - Date.now() <= 120_000);
  assert.equal(T.rateRetryOf('r_429a')!.state, 'waiting');
  assert.equal(await T.fireRateRetry('r_429a'), 'r_next1');
  assert.deepEqual(started[0], { kind: 'playtest', product: 'dod', spec: { scenario: 'smoke', where: 'local' }, origin: 't_abc123def' });
  assert.equal(await T.fireRateRetry('r_429a'), null); // once
  // the retry run is refused too: the next wait is longer
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES ('r_next1', 'playtest', 'cancelled', 'x', '["dod"]', '{}', ?)`).run(Date.now());
  const due2 = T.scheduleRateRetry({ run: 'r_next1', product: 'dod', kind: 'playtest', spec: {}, why: '429' })!;
  assert.ok(due2 - Date.now() > 4 * 60_000);
  assert.equal(T.rateRetryOf('r_next1')!.attempt, 2);
  // the tries run out
  let run = 'r_next1';
  for (let i = 0; i < 6; i++) {
    const next = `r_chain${i}`;
    db.prepare(`UPDATE rate_retries SET next_run = ? WHERE run = ?`).run(next, run);
    const d = T.scheduleRateRetry({ run: next, product: 'dod', kind: 'playtest', spec: {}, why: '429' });
    if (d === null) { assert.ok(i >= 2); return; }
    run = next;
  }
  assert.fail('should have given up');
});

// ---- 3. restarts
test('runs stopped by restarts start again once, when Studio is stable', async () => {
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started, finished, origin) VALUES ('r_stop1', 'playtest', 'failed', 'stopped: Studio restarted 4 times in 30 minutes while this run was going, so it isn''t resumed again', '["dod"]', '{"scenario":"smoke"}', ?, ?, 't_abc123def')`).run(Date.now() - 1000, Date.now() - 500);
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES ('r_fine', 'playtest', 'failed', 'failed: the game broke', '["dod"]', '{}', ?, ?)`).run(Date.now() - 1000, Date.now() - 500);
  const asked: string[] = [];
  const r = await T.reviveStopped({ startRun: async (run) => { asked.push(run.id); return 'r_again'; }, changes: () => [] });
  assert.deepEqual(asked, ['r_stop1']);
  assert.deepEqual(r.runs, ['r_again']);
  assert.deepEqual((await T.reviveStopped({ startRun: async (run) => { asked.push(run.id); return 'x'; }, changes: () => [] })).runs, []); // not twice
});

test('the revive timer waits for the stable time and fires once', async () => {
  process.env.STUDIO_STABLE_MS = String(process.uptime() * 1000 + 60);
  let fired = 0;
  const left = T.reviveWhenStable(() => { fired++; });
  assert.ok(left > 0 && left <= 60);
  assert.equal(fired, 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, 1);
  delete process.env.STUDIO_STABLE_MS;
});

test('a change stopped by restarts carries on from its step once; one stopped for another reason does not', () => {
  const seed = (id: string, detail: string, phase: object) => db.prepare(`INSERT INTO changes (id, product, findings, status, detail, log, created, phase) VALUES (?, 'nope', '[]', 'failed', ?, '[]', ?, ?)`).run(id, detail, Date.now(), JSON.stringify(phase));
  seed('c_rs1', "stopped: Studio restarted 3 times in a row during its agent step, so it isn't resumed again (start it again once the cause is fixed)", { step: 'agent', failed: true, restarts: { step: 'agent', n: 4, at: Date.now() } });
  seed('c_rs2', 'the agent made no commit', { step: 'agent', failed: true });
  seed('c_rs3', "stopped: Studio restarted 3 times in a row during its agent step, so it isn't resumed again", { step: 'agent', failed: true, revived: true });
  const ids = reviveRestartStopped();
  assert.deepEqual(ids, ['c_rs1']);
  const c = getChange('c_rs1')!;
  assert.equal(c.status, 'working');
  assert.deepEqual(reviveRestartStopped(), []);
  assert.equal(getChange('c_rs2')!.status, 'failed');
  assert.equal(getChange('c_rs3')!.status, 'failed');
});

// ---- 4. go live after a standalone beta playtest
test('a passing standalone beta playtest asks for the automatic go-live; failed, live or other runs do not', async () => {
  const asks: string[] = [];
  const go = async (p: string, why: string) => { asks.push(`${p}: ${why}`); };
  const run = (id: string, status: string) => db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, 'playtest', ?, 'x', '["hs"]', '{}', ?)`).run(id, status, Date.now());
  run('r_ok', 'done'); run('r_bad', 'failed'); run('r_can', 'cancelled');
  assert.equal(await P.goLiveAfterPlaytest('r_ok', 'playtest', 'hs', 'local', go), true);
  assert.deepEqual(asks, ['hs: playtest r_ok']);
  assert.equal(await P.goLiveAfterPlaytest('r_bad', 'playtest', 'hs', 'local', go), false);
  assert.equal(await P.goLiveAfterPlaytest('r_can', 'playtest', 'hs', 'local', go), false);
  assert.equal(await P.goLiveAfterPlaytest('r_ok', 'playtest', 'hs', 'live', go), false);
  assert.equal(await P.goLiveAfterPlaytest('r_ok', 'build', 'hs', 'local', go), false);
  assert.equal(asks.length, 1);
});
