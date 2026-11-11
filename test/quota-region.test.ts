// The CPU quota card asks for the region the agent job actually waited in (quota.ts askCpuForJobs). 2026-11-11: the
// jobs' configured region (us-east1) refused them, they waited beside the server in us-east4, and the card asked for
// us-east1, which the project can't use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { executionRegion } = await import('../src/quota.ts');

test('the region comes from the execution that waited', () => {
  assert.equal(executionRegion('projects/hawkes-staging/locations/us-east4/jobs/studio-cell-agent/executions/studio-cell-agent-7wv5j'), 'us-east4');
  assert.equal(executionRegion('projects/p/locations/us-west1/jobs/j/executions/e'), 'us-west1');
  assert.equal(executionRegion(null), null);
  assert.equal(executionRegion('studio-cell-agent-7wv5j'), null, 'a short name says nothing: the caller falls back to where starts land');
});

test('the job watcher hands its execution to the card', () => {
  const src = fs.readFileSync(new URL('../src/cloudjob.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('askCpuForJobs(Math.round((Date.now() - since) / 60_000), st.message, f.execution)'));
  const q = fs.readFileSync(new URL('../src/quota.ts', import.meta.url), 'utf8');
  assert.match(q, /executionRegion\(execution\) \?\? \(await import\('\.\/jobsproject\.ts'\)\)\.startPlace\(\)\.region/);
});
