// A cancelled run starts nothing new (J, 2026-10-26: r_3f577f8f1f33 started road-bestiary after its cancel). Fake Gen API; scratch database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cancel-'));
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
  repos: { gw: 'x/gw' },
  products: [{
    id: 'gw', name: 'gw', framing: 'test', engine: 'static', repo: 'gw', site: 'gw', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'gw', port: 8794, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }],
  infra: [],
}));


const C = await import('../src/cancel.ts');
const P = await import('../src/pipeline.ts');
const { runGenJob } = await import('../src/playtests.ts');
const { betaTurn } = await import('../src/betaqueue.ts');
const { db, J } = await import('../src/db.ts');

let n = 0;
function run(status = 'running', kind = 'beta') {
  const id = `r_d0${String(++n).padStart(10, '0')}`;
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, started) VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, status, 'x', J(['gw']), Date.now() - 60_000);
  return id;
}
function fakeGen(opts: { onSubmit?: () => void } = {}) {
  const calls = { submit: 0, cancel: [] as string[], job: 0 };
  return {
    calls,
    api: {
      async submit() { calls.submit++; opts.onSubmit?.(); return { id: `j_${calls.submit}`, status: 'queued' }; },
      async job(id: string) { calls.job++; return { id, status: calls.cancel.includes(id) ? 'cancelled' : 'running', detail: 'x' }; },
      async cancel(id: string) { calls.cancel.push(id); return { id, status: 'cancelled' }; },
    },
  };
}
const opts = (r: string, g: ReturnType<typeof fakeGen>) => ({ runMs: 60_000, pollMs: 5, api: g.api, halt: C.haltOf(r) });

test('a run cancelled before a Gen job is submitted submits nothing', async () => {
  const r = run();
  C.noteCancel(`run:${r}`, 'Talk', 'test');
  const g = fakeGen();
  const job = await runGenJob('playtest.run', 'gw', {}, () => {}, opts(r, g));
  assert.equal(g.calls.submit, 0);
  assert.equal(job.status, 'cancelled');
  assert.match(C.jobCancelDetail(job), /run cancelled by Talk/);
});

test('a cancel that lands while the job is being submitted cancels the new job at once', async () => {
  const r = run();
  const g = fakeGen({ onSubmit: () => C.noteCancel(`run:${r}`, 'J', 'raced') });
  const job = await runGenJob('playtest.run', 'gw', {}, () => {}, opts(r, g));
  assert.equal(g.calls.submit, 1);
  assert.deepEqual(g.calls.cancel, ['j_1']);
  assert.equal(job.status, 'cancelled');
  assert.equal(g.calls.job, 0, 'not even polled');
});

test('a cancel while the job runs cancels it on the next poll', async () => {
  const r = run();
  const g = fakeGen();
  setTimeout(() => C.noteCancel(`run:${r}`, 'Talk'), 30);
  const job = await runGenJob('playtest.run', 'gw', {}, () => {}, opts(r, g));
  assert.deepEqual(g.calls.cancel, ['j_1']);
  assert.equal(job.status, 'cancelled');
});

test('a mid-loop cancel: the next scenario starts no step and no Gen job', async () => {
  const r = run();
  const before = (db.prepare('SELECT COUNT(*) AS n FROM steps').get() as any).n;
  C.noteCancel(`run:${r}`, 'Talk', 'stop');
  const p = (await import('../src/config.ts')).getProduct('gw');
  const res = await P.playtestProduct(r, p, { scenario: 'road-bestiary', where: 'local' }, { review: false });
  assert.equal(res, null);
  const steps = db.prepare('SELECT status, job, detail FROM steps WHERE run = ?').all(r) as any[];
  assert.ok(steps.every((s) => s.status === 'cancelled' && !s.job), 'only cancelled steps without a job');
  assert.match(steps[0].detail, /cancelled before it started/);
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM steps').get() as any).n >= before);
});

test('a queued beta run that is cancelled leaves the queue instead of waiting for its turn', async () => {
  const r = run();
  C.noteCancel(`run:${r}`, 'J');
  const turn = await betaTurn(r, 'gw', { quiet: 60_000, halt: C.haltOf(r) });
  assert.ok('cancelled' in turn);
});

test('a cancelled run is not resumed after a restart: it ends cancelled with its running step cancelled', () => {
  const r = run();
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, started) VALUES (?, ?, 'gw', 'playtest', 'road-bestiary@local', 'running', 'x', ?)`).run(`s_d0${r.slice(-8)}`, r, Date.now());
  C.noteCancel(`run:${r}`, 'Talk', 'before restart');
  const resumed = P.resumeRuns();
  assert.ok(!resumed.includes(r));
  const row = db.prepare('SELECT status, detail FROM runs WHERE id = ?').get(r) as any;
  assert.equal(row.status, 'cancelled');
  assert.match(row.detail, /cancelled by Talk/);
  assert.equal((db.prepare('SELECT status FROM steps WHERE run = ?').get(r) as any).status, 'cancelled');
});

test('the cancel route answers with the run\'s real state', async () => {
  const r = run();
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, started) VALUES (?, ?, 'gw', 'build', 'unity', 'running', 'queued', ?)`).run(`s_d1${r.slice(-8)}`, r, Date.now());
  const a: any = await C.cancelRun(r, 'Talk', 'x');
  assert.equal(a.cancelled, true);
  assert.equal(a.runningSteps, 1);
  assert.equal(a.status, 'cancelling', 'a step is still winding down');
  const idle = run();
  const b: any = await C.cancelRun(idle, 'Talk');
  assert.equal(b.status, 'cancelling', 'still running until its body reaches the next check');
  assert.equal(b.runStatus, 'running');
});
