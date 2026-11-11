// A Cloud Run job stopped from outside Studio is taken away, not failed (2026-11-11 ~00:35: the executions cancelled in
// Cloud Shell to free the region's CPU ended c_88cdeb289512 and others as "the Cloud Run job ended without its result:
// Cancelled by user", failed changes that had done nothing wrong). It now reads as gone with no result (DetachedChild.lost),
// so the agent's pass starts again with a new job, not as a try. A job that ended by itself without a result still fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stopped-outside-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_JOB_POLL_MS = '20';
process.env.STUDIO_JOB_SAFETY_MS = '20';
process.env.STUDIO_JOB_GONE_MS = '40';
process.env.STUDIO_JOB_START_MS = '600000';
process.env.STUDIO_JOB_SILENT_MS = '600000';
process.env.STUDIO_STATE_BUCKET = 'test-bucket';
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const { setJobRunner, reattachCloudJob, stoppedOutside } = await import('../src/cloudjob.ts');
const { DetachedChild } = await import('../src/detach.ts');

function runnerWith(state: { done: boolean; message: string; started?: boolean } | null) {
  const bucket = new Map<string, Buffer>();
  const cancelled: string[] = [];
  setJobRunner(() => ({
    put: async (k: string, d: Buffer | string) => { bucket.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)); },
    get: async (k: string) => bucket.get(k) ?? null,
    list: async (p: string) => [...bucket.keys()].filter((k) => k.startsWith(p)),
    remove: async (k: string) => { bucket.delete(k); },
    start: async () => 'projects/p/locations/r/jobs/studio-agent/executions/e1',
    state: async () => state,
    cancel: async (e: string) => { cancelled.push(e); },
  }));
  return { bucket, cancelled };
}

async function follow(unit: string, state: { done: boolean; message: string; started?: boolean } | null) {
  const r = runnerWith(state);
  r.bucket.set(`jobs/${unit}/execution.txt`, Buffer.from('projects/p/locations/r/jobs/studio-agent/executions/e1'));
  r.bucket.set(`jobs/${unit}/out/log-000001`, Buffer.from('working\n'));
  reattachCloudJob(unit, TMP);
  const child = new DetachedChild({ unit, mode: 'cloudrun', started: Date.now() - 60_000 });
  let err = '';
  child.stderr.on('data', (d: string) => { err += d; });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, code, err };
}

test('cancelled in the console or Cloud Shell: the pass starts again with a new job (lost), not failed', async () => {
  const { child, err } = await follow('hawkes-agent-c_0000cancel-a', { done: true, message: 'Cancelled by user.', started: true });
  assert.equal(child.lost, true);
  assert.match(err, /cancelled outside Studio/);
});

test('deleted (Cloud Run no longer knows it): the same', async () => {
  const { child, err } = await follow('hawkes-agent-c_0000delete-b', null);
  assert.equal(child.lost, true);
  assert.match(err, /deleted outside Studio/);
});

test('a job that ended by itself without its result (a crash) still fails, saying why', async () => {
  const { child, err } = await follow('hawkes-agent-c_00000crash-c', { done: true, message: 'Task hawkes-agent-x-0 failed: The container exited with an error (137).', started: true });
  assert.equal(child.lost, false);
  assert.match(err, /ended without its result: Task .*137/);
});

test("Studio's own stop (the change was cancelled) is not from outside", () => {
  assert.equal(stoppedOutside({ done: true, message: 'Cancelled by user.' }, { stopAsked: Date.now() }), null);
  assert.equal(stoppedOutside({ done: true, message: 'Cancelled by user.' }, {}), 'cancelled');
  assert.equal(stoppedOutside({ done: true, message: 'Execution was cancelled' }, {}), 'cancelled');
  assert.equal(stoppedOutside({ done: true, message: 'Task failed: exit 1' }, {}), null);
});
