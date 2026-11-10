// A Cloud Run job that Cloud Run never starts (no room in the region), or that goes silent, was followed forever: its
// change sat at "Cursor is working on it" with nothing behind it (J, 2026-11-10: "are you sure it's not just working
// and you don't know?"). cloudjob.ts gives such a job up: its execution is cancelled and it reads as gone with no
// result (DetachedChild.lost), so the agent's pass starts again with a new job instead of waiting on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-never-started-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_JOB_POLL_MS = '20';
process.env.STUDIO_JOB_SAFETY_MS = '20';
process.env.STUDIO_STATE_BUCKET = 'test-bucket';
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const { setJobRunner, reattachCloudJob, cloudJobAlive } = await import('../src/cloudjob.ts');
const { DetachedChild } = await import('../src/detach.ts');

function fakeRunner(o: { started: boolean; output?: boolean }) {
  const bucket = new Map<string, Buffer>();
  const cancelled: string[] = [];
  return {
    bucket, cancelled,
    runner: () => ({
      put: async (k: string, d: Buffer | string) => { bucket.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)); },
      get: async (k: string) => bucket.get(k) ?? null,
      list: async (p: string) => [...bucket.keys()].filter((k) => k.startsWith(p)),
      remove: async (k: string) => { bucket.delete(k); },
      start: async () => 'projects/p/locations/r/jobs/studio-agent/executions/e1',
      state: async () => ({ done: false, message: '', started: o.started }),
      cancel: async (e: string) => { cancelled.push(e); },
    }),
  };
}

async function follow(unit: string) {
  reattachCloudJob(unit, TMP);
  const child = new DetachedChild({ unit, mode: 'cloudrun', started: Date.now() - 60_000 });
  let err = '';
  child.stderr.on('data', (d: string) => { err += d; });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, code, err };
}

test('a job Cloud Run never starts is given up on: cancelled, and read as lost so the pass starts again', async () => {
  process.env.STUDIO_JOB_START_MS = '150';
  process.env.STUDIO_JOB_SILENT_MS = '600000';
  const f = fakeRunner({ started: false });
  setJobRunner(f.runner);
  const unit = 'hawkes-agent-c_000000never-a';
  f.bucket.set(`jobs/${unit}/execution.txt`, Buffer.from('projects/p/locations/r/jobs/studio-agent/executions/e1'));
  const { child, err } = await follow(unit);
  assert.equal(child.lost, true, 'gone with no result: the agent pass starts again');
  assert.match(err, /never started/);
  assert.deepEqual(f.cancelled, ['projects/p/locations/r/jobs/studio-agent/executions/e1']);
  assert.equal(cloudJobAlive(unit), false);
  reattachCloudJob(unit, TMP);
  assert.equal(cloudJobAlive(unit), false, 'a dropped job is never followed again');
});

test('a started job that sends nothing for too long is stopped and started again', async () => {
  process.env.STUDIO_JOB_START_MS = '600000';
  process.env.STUDIO_JOB_SILENT_MS = '150';
  const f = fakeRunner({ started: true });
  setJobRunner(f.runner);
  const unit = 'hawkes-agent-c_000000silent-b';
  f.bucket.set(`jobs/${unit}/execution.txt`, Buffer.from('projects/p/locations/r/jobs/studio-agent/executions/e1'));
  const { child, err } = await follow(unit);
  assert.equal(child.lost, true);
  assert.match(err, /sent nothing for/);
  assert.equal(f.cancelled.length, 1);
});

test('a started job that keeps sending output is left alone', async () => {
  process.env.STUDIO_JOB_START_MS = '100';
  process.env.STUDIO_JOB_SILENT_MS = '200';
  const f = fakeRunner({ started: true });
  setJobRunner(f.runner);
  const unit = 'hawkes-agent-c_000000talks-c';
  f.bucket.set(`jobs/${unit}/execution.txt`, Buffer.from('projects/p/locations/r/jobs/studio-agent/executions/e1'));
  reattachCloudJob(unit, TMP);
  for (let i = 1; i <= 8; i++) {
    f.bucket.set(`jobs/${unit}/out/log-${String(i).padStart(6, '0')}`, Buffer.from(`line ${i}\n`));
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.equal(cloudJobAlive(unit), true, 'still followed after 480 ms with output every 60 ms');
  assert.equal(f.cancelled.length, 0);
  f.bucket.set(`jobs/${unit}/out/exit.json`, Buffer.from('{}'));
});
