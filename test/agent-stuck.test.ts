// The agents' watchdog (agents.ts stuckWhy): an agent quiet for the idle time whose processes only sleep is stuck; one
// that is working (CPU, a running process) or waiting on a Gen job is never ended. And an agent's verify playtest
// (verifyPlaytest) has the pipeline's limits: a stuck browser is a failed verify, not an agent held for hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stuck-'));
const { stuckWhy, agentSettings, verifyPlaytest, VERIFY_PRIORITY } = await import('../src/agents.ts');

const min = 60_000;
const sleeping = [{ state: 'S', comm: 'claude' }, { state: 'S', comm: 'bash' }, { state: 'S', comm: 'sleep' }];
const base = { quietMs: 21 * min, idleMs: 20 * min, cpuMs: 2_000, overMs: 20 * min, procs: sleeping, genBusy: false };

test('quiet for the idle time with only sleeping processes: stuck, with what it left running', () => {
  assert.equal(stuckWhy(base), 'no new output for 21 minutes and its processes only waiting (bash, sleep)');
});

test('never stuck while it works, waits on a GPU job, or before the idle time', () => {
  assert.equal(stuckWhy({ ...base, quietMs: 19 * min }), null, 'not quiet long enough');
  assert.equal(stuckWhy({ ...base, overMs: 5 * min }), null, 'not watched long enough');
  assert.equal(stuckWhy({ ...base, cpuMs: 60_000 }), null, 'an encoder using CPU');
  assert.equal(stuckWhy({ ...base, procs: [...sleeping, { state: 'R', comm: 'ffmpeg' }] }), null, 'a process running');
  assert.equal(stuckWhy({ ...base, procs: [...sleeping, { state: 'D', comm: 'git' }] }), null, 'a process waiting on disk');
  assert.equal(stuckWhy({ ...base, genBusy: true }), null, 'a Gen job queued or running');
  assert.equal(stuckWhy({ ...base, idleMs: 0 }), null, 'the watchdog off');
});

test('the idle time is a setting, 20 minutes by default', () => {
  assert.equal(agentSettings().idleMinutes, 20);
});

/** A stand-in for Gen: one job whose state each poll comes from next(), what was submitted, and every cancel asked for. */
function fakeGen(next: (polls: number) => any) {
  const submits: any[] = [];
  const cancels: string[] = [];
  let polls = 0;
  let cancelled = false;
  return {
    submits, cancels,
    submit: async (tool: string, body: any) => { submits.push({ tool, ...body }); return { id: 'j_verify', status: 'queued' }; },
    job: async (id: string) => (cancelled ? { id, status: 'cancelled' } : { id, ...next(++polls) }),
    cancel: async (id: string) => { cancels.push(id); cancelled = true; return { id, status: 'cancelled' }; },
  };
}
const memo = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { map: m, get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v) };
};

test('a verify playtest whose browser stops making progress is cancelled and comes back failed (stuck)', async () => {
  process.env.STUDIO_PLAYTEST_IDLE_MS = '60';
  try {
    const g = fakeGen(() => ({ status: 'running', started: Date.now(), detail: 'Level 2 40% (waiting for the door)' }));
    const jobs = memo({ review: 'j_old_review' });
    const run = await verifyPlaytest('mygame', { url: 'http://127.0.0.1:8801/', scenario: 'smoke' }, { jobs, api: g, pollMs: 5 });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /^stuck: no progress for \d+ min \(still at "Level 2 40% \(waiting for the door\)"\), so it was cancelled$/);
    assert.deepEqual(g.cancels, ['j_verify']);
    assert.equal(run.id, 'j_verify', 'the result names the job, as genRun\'s did');
    // Recorded as soon as Gen gave it (a restart waits on it again), and its review starts afresh.
    assert.equal(jobs.get('playtest'), 'j_verify');
    assert.equal(jobs.get('review'), '');
    // Ahead of daily plays, behind the go-live smoke; never a shared job (its page is on the change's own port).
    assert.equal(g.submits.length, 1);
    assert.equal(g.submits[0].priority, VERIFY_PRIORITY);
    assert.ok(VERIFY_PRIORITY > 0 && VERIFY_PRIORITY < 5);
    assert.equal(g.submits[0].params.url, 'http://127.0.0.1:8801/');
  } finally {
    delete process.env.STUDIO_PLAYTEST_IDLE_MS;
  }
});

test('a verify playtest from before a restart is waited on again, not submitted; a finished one is returned as it was', async () => {
  const g = fakeGen((n) => (n < 3 ? { status: 'running', started: Date.now(), detail: `level ${n}` } : { status: 'done', result: { outcome: 'pass' }, outputs: [{ kind: 'video', asset: 'a1' }] }));
  const jobs = memo({ playtest: 'j_prior', review: 'j_review' });
  const run = await verifyPlaytest('mygame', { url: 'x' }, { prior: 'j_prior', jobs, api: g, pollMs: 5 });
  assert.equal(run.status, 'done');
  assert.equal(run.id, 'j_prior');
  assert.equal(run.result.outcome, 'pass');
  assert.equal(run.outputs[0].asset, 'a1');
  assert.deepEqual(g.submits, [], 'not submitted again');
  assert.deepEqual(g.cancels, []);
  assert.equal(jobs.get('review'), 'j_review', 'its review is kept');
});
