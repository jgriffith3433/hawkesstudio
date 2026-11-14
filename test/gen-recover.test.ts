// Shared Gen-job recovery (gen-recover.ts): unknown jobs and ghost-queued jobs (still queued past a bound while Gen's
// lane shows free room) are resubmitted once from the look Studio already does; a job Gen still knows behind real work
// is never cancelled for the queue wait alone; a second loss is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noEvents } from '../src/genevents.ts';
import {
  ghostQueued, jobUnknown, laneJobs, lostResult, QUEUED_GHOST_MS, recoverOnce, stillQueued,
} from '../src/gen-recover.ts';

test('jobUnknown: Gen\'s 404 and "No such job" wording', () => {
  assert.equal(jobUnknown(Object.assign(new Error('No such job'), { status: 404 })), true);
  assert.equal(jobUnknown({ status: 404, message: 'gone' }), true);
  assert.equal(jobUnknown(new Error('No such job')), true);
  assert.equal(jobUnknown(Object.assign(new Error('busy'), { status: 503 })), false);
  assert.equal(jobUnknown(new Error('Unity exited with code 1')), false);
});

test('stillQueued: queued, or waiting for a builder; not a real running build', () => {
  assert.equal(stillQueued({ status: 'queued' }), true);
  assert.equal(stillQueued({ status: 'running', detail: 'waiting for the cloud machine' }), true);
  assert.equal(stillQueued({ status: 'running', progress: { step: 'Unity: compiling' }, detail: 'Unity: compiling' }), false);
  assert.equal(stillQueued({ status: 'done' }), false);
});

test('ghostQueued: past the bound with free room or missing from Gen\'s list; never while something is running ahead', () => {
  const now = 1_000_000;
  const bound = 60_000;
  const job = { id: 'j_1', status: 'queued' };
  assert.equal(ghostQueued(job, [], now - bound + 1, now, bound), false, 'too young');
  assert.equal(ghostQueued(job, null, now - bound - 1, now, bound), false, 'Gen could not say');
  assert.equal(ghostQueued(job, [], now - bound - 1, now, bound), true, 'empty lane past the bound');
  assert.equal(ghostQueued(job, [{ id: 'j_other', status: 'queued' }], now - bound - 1, now, bound), true, 'our job gone from the list');
  assert.equal(ghostQueued(job, [{ id: 'j_1', status: 'queued' }, { id: 'j_2', status: 'running' }], now - bound - 1, now, bound), false, 'real work ahead');
  assert.equal(ghostQueued(job, [{ id: 'j_1', status: 'queued' }], now - bound - 1, now, bound), true, 'only us, nothing running');
});

test('recoverOnce: resubmits a lost job once; a second loss is reported', async () => {
  let n = 0;
  const first = lostResult('j_a', 'no such job');
  const out = await recoverOnce({
    first,
    resubmit: async () => ({ id: 'j_b' }),
    wait: async (id) => {
      n++;
      assert.equal(id, 'j_b');
      return { id, status: 'done', result: { ok: true } };
    },
  });
  assert.equal(n, 1);
  assert.equal(out.status, 'done');
  assert.equal(out.retried, true);
  assert.equal(out.id, 'j_b');

  const reported = await recoverOnce({
    first: lostResult('j_c', 'no such job'),
    resubmit: async () => ({ id: 'j_d' }),
    wait: async () => lostResult('j_d', 'no such job'),
  });
  assert.equal(reported.lost, true);
  assert.equal(reported.reported, true);
  assert.equal(reported.retried, true);
  assert.match(String(reported.error), /already resubmitted once/);

  const again = await recoverOnce({ first: reported, resubmit: async () => ({ id: 'j_e' }), wait: async () => ({ status: 'done' }) });
  assert.equal(again, reported, 'already reported: no third submit');
});

test('genWait: Gen answering No such job ends at once as lost (shared path)', async () => {
  const G = await import('../src/gen.ts');
  const api = { job: async () => { throw Object.assign(new Error('No such job'), { status: 404 }); }, cancel: async () => ({}), jobs: async () => [] };
  const j: any = await G.genWait('j_gone', undefined, 60_000, undefined, { api, events: noEvents, pollMs: 10, tool: 'unity.build' });
  assert.equal(j.lost, true);
  assert.match(j.error, /Hawkes Gen lost job j_gone/);
});

test('genWait: Gen answering 503 on the job does not hold a wait past Studio\'s own reason to stop (a compile\'s deadline)', async () => {
  const G = await import('../src/gen.ts');
  let cancelled = 0, stop: string | null = null;
  const api = { job: async () => { throw Object.assign(new Error('503 /builder unavailable'), { status: 503 }); }, cancel: async () => { cancelled++; return {}; }, jobs: async () => [] };
  setTimeout(() => { stop = 'the compile never started'; }, 30);
  const t = Date.now();
  const j: any = await G.genWait('j_503', undefined, 60_000, () => stop, { api, events: noEvents, pollMs: 10, tool: 'unity.build' });
  assert.equal(j.halted, true);
  assert.equal(j.status, 'cancelled');
  assert.equal(cancelled, 1, 'the job is not left behind');
  assert.ok(Date.now() - t < 5000, 'it did not run through its 60 misses first');
});

test('genWait: a still-queued job Gen knows with work ahead is never timed out as lost (fromStart / free-room rule)', async () => {
  process.env.STUDIO_GEN_QUEUED_GHOST_MS = '40';
  try {
    const G = await import('../src/gen.ts');
    let looks = 0;
    let phase: 'queued' | 'done' = 'queued';
    const api = {
      job: async () => {
        looks++;
        if (phase === 'done') return { id: 'j_wait', status: 'done', tool: 'unity.build', detail: 'done' };
        return { id: 'j_wait', status: 'queued', tool: 'unity.build', detail: 'waiting: 1 builder-cloud jobs already running' };
      },
      jobs: async ({ status }: { status: string }) => (status === 'running'
        ? [{ id: 'j_other', status: 'running', tool: 'unity.build' }]
        : [{ id: 'j_wait', status: 'queued', tool: 'unity.build' }, { id: 'j_other', status: 'running', tool: 'unity.build' }]),
      cancel: async () => ({}),
    };
    const p = G.genWait('j_wait', undefined, 80, undefined, { api, events: noEvents, pollMs: 10, fromStart: true, tool: 'unity.build' });
    await new Promise((r) => setTimeout(r, 90));
    // Still waiting: flip to done so the wait can end (never marked lost while work was ahead).
    phase = 'done';
    const j: any = await p;
    assert.equal(j.lost, undefined);
    assert.equal(j.status, 'done');
    assert.ok(looks >= 1);
  } finally {
    delete process.env.STUDIO_GEN_QUEUED_GHOST_MS;
  }
});

test('genWait: queued past the bound while Gen\'s lane is empty ends as lost', async () => {
  process.env.STUDIO_GEN_QUEUED_GHOST_MS = '30';
  try {
    const G = await import('../src/gen.ts');
    const api = {
      job: async () => ({ id: 'j_ghost', status: 'queued', tool: 'unity.build', detail: 'waiting for the cloud machine' }),
      jobs: async () => [],
      cancel: async () => ({}),
    };
    const j: any = await G.genWait('j_ghost', undefined, 60_000, undefined, { api, events: noEvents, pollMs: 10, fromStart: true, tool: 'unity.build' });
    assert.equal(j.lost, true);
    assert.match(j.error, /still queued while Gen's lane is free|no longer in Gen's queue/);
  } finally {
    delete process.env.STUDIO_GEN_QUEUED_GHOST_MS;
  }
});

test('genRun: a lost queued unity.build is submitted again once and the run moves', async () => {
  process.env.STUDIO_GEN_QUEUED_GHOST_MS = '20';
  const U = await import('../src/unityslot.ts');
  U.resetUnitySlots();
  try {
    const G = await import('../src/gen.ts');
    const posted: string[] = [];
    const state = new Map<string, any>();
    const api = {
      submit: async (_t: string, body: any) => {
        const id = `j_${posted.length + 1}`;
        posted.push(id);
        state.set(id, { id, status: 'queued', tool: 'unity.build', project: body.project, params: body.params });
        return { id, status: 'queued' };
      },
      job: async (id: string) => {
        const j = state.get(id);
        if (!j) throw Object.assign(new Error('No such job'), { status: 404 });
        return { ...j };
      },
      jobs: async ({ status }: { status: string }) => [...state.values()].filter((j) => j.status === status),
      cancel: async (id: string) => { state.delete(id); },
    };
    // First job vanishes from Gen after submit (Studio still thinks it is queued).
    const run = G.genRun('unity.build', 'p', { path: 'Game', github: { repo: 'a/b', commit: 'a'.repeat(40), token: 't' } }, undefined, 60_000, {
      api: api as any, events: noEvents, pollMs: 10, fromStart: true,
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(posted.length, 1);
    state.delete('j_1'); // Gen lost it
    // Recovery submits j_2; make it finish.
    const tick = setInterval(() => {
      const j = state.get('j_2');
      if (j && j.status === 'queued') state.set('j_2', { ...j, status: 'done', result: { ok: true } });
    }, 5);
    const out: any = await run;
    clearInterval(tick);
    assert.equal(out.status, 'done', JSON.stringify(out));
    assert.equal(out.retried, true);
    assert.equal(posted.length, 2);
  } finally {
    delete process.env.STUDIO_GEN_QUEUED_GHOST_MS;
    U.resetUnitySlots();
  }
});

test('laneJobs: merges queued and running; null when Gen cannot answer', async () => {
  const api = {
    jobs: async ({ status }: { status: string }) => (status === 'queued' ? [{ id: 'a', status: 'queued' }] : [{ id: 'b', status: 'running' }]),
  };
  const listed = await laneJobs(api, 'unity.build');
  assert.deepEqual(listed?.map((x) => x.id).sort(), ['a', 'b']);
  assert.equal(await laneJobs({ jobs: async () => { throw new Error('down'); } }, 'unity.build'), null);
  assert.equal(QUEUED_GHOST_MS() > 0, true);
});
