// A Studio npm build's memory: memoryMiB runs a job whose template has that memory (created or patched from the base job),
// while jobs:run bodies never carry a resources field and builds without memoryMiB send the exact same request as before #494.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-memtest-'));
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { runBody, runJob, setGcpFetch, memoryLimit, memoryJobName, withJobMemory } = await import('../src/gcp.ts');
const { buildMemoryMiB } = await import('../src/builds.ts');
const { checkMemoryMiB } = await import('../src/config.ts');

/** The exact jobs.run body shape from before PR #494. */
const pre494RunBody = (o: { args?: string[]; env?: Record<string, string>; timeoutSeconds: number }) => ({
  overrides: {
    containerOverrides: [{ ...(o.args ? { args: o.args } : {}), env: Object.entries(o.env ?? {}).map(([name, value]) => ({ name, value })) }],
    taskCount: 1,
    timeout: `${o.timeoutSeconds}s`,
  },
});

test('a build without memoryMiB sends a jobs:run body identical to before #494, and no jobs:run body ever contains resources', async () => {
  const cases: { args?: string[]; env?: Record<string, string>; timeoutSeconds: number }[] = [
    { env: { STUDIO_JOB_UNIT: 'u1' }, timeoutSeconds: 14400 },
    { args: ['--x'], env: { A: 'b', C: 'd' }, timeoutSeconds: 60 },
  ];
  for (const o of cases) {
    const b = runBody(o);
    assert.deepEqual(b, pre494RunBody(o));
    assert.equal('resources' in (b.overrides.containerOverrides[0] as any), false);
    assert.equal(JSON.stringify(b).includes('resources'), false);
  }
  const withMem = runBody({ env: { A: 'b' }, timeoutSeconds: 60, memoryMiB: 1024 } as any);
  assert.deepEqual(withMem, pre494RunBody({ env: { A: 'b' }, timeoutSeconds: 60 }));
  assert.equal('resources' in (withMem.overrides.containerOverrides[0] as any), false);
  assert.equal(JSON.stringify(withMem).includes('resources'), false);

  // Full runJob without memoryMiB: one POST to jobs/<base>:run with the exact pre-#494 body and no extra requests.
  const calls: { method: string; url: string; body: any }[] = [];
  setGcpFetch((async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    return new Response(JSON.stringify({ metadata: { name: 'projects/hawkes-staging/locations/us-west1/jobs/studio-cell-agent/executions/e1' } }), { status: 200 });
  }) as typeof fetch, 'test-token');
  try {
    const exec = await runJob({ project: 'hawkes-staging', region: 'us-west1', job: 'studio-cell-agent' }, { env: { STUDIO_JOB_UNIT: 'u1' }, timeoutSeconds: 14400 });
    assert.equal(exec, 'projects/hawkes-staging/locations/us-west1/jobs/studio-cell-agent/executions/e1');
    assert.deepEqual(calls, [{
      method: 'POST',
      url: 'https://run.googleapis.com/v2/projects/hawkes-staging/locations/us-west1/jobs/studio-cell-agent:run',
      body: pre494RunBody({ env: { STUDIO_JOB_UNIT: 'u1' }, timeoutSeconds: 14400 }),
    }]);
  } finally {
    setGcpFetch(null);
  }
  assert.equal(buildMemoryMiB({ id: 'other' }, { tool: 'npm' }), undefined);
  assert.equal(buildMemoryMiB({ id: 'dose-of-destruction' }, { tool: 'static' }), undefined);
});

test('a build with memoryMiB 1024 creates, patches or runs a job whose template memory is 1Gi', async () => {
  assert.equal(memoryLimit(1024), '1Gi');
  assert.equal(memoryLimit(2048), '2Gi');
  assert.equal(memoryLimit(768), '768Mi');
  assert.equal(memoryJobName('studio-cell-agent', 1024), 'studio-cell-agent-1g');
  assert.equal(memoryJobName('studio-cell-agent', undefined), 'studio-cell-agent');

  const baseJob = {
    name: 'projects/hawkes-staging/locations/us-west1/jobs/studio-cell-agent',
    uid: 'u-base',
    etag: 'e-base',
    createTime: '2026-11-01T00:00:00Z',
    labels: { 'hawkes-studio': '1' },
    template: {
      taskCount: 1,
      template: {
        serviceAccount: 'studio-cell-runner@hawkes-staging.iam.gserviceaccount.com',
        timeout: '14400s',
        containers: [{
          image: 'us-east4-docker.pkg.dev/hawkes-staging/studio/studio:v1',
          env: [{ name: 'KEEP', value: '1' }],
          resources: { limits: { cpu: '2', memory: '512Mi' } },
        }],
      },
    },
  };
  const shaped = withJobMemory(baseJob, 1024);
  assert.equal('name' in shaped, false);
  assert.equal('uid' in shaped, false);
  assert.equal('etag' in shaped, false);
  assert.deepEqual(shaped.template.template.containers[0].resources.limits, { cpu: '2', memory: '1Gi' });
  assert.equal(baseJob.template.template.containers[0].resources.limits.memory, '512Mi', 'base job not mutated');

  const jobs = new Map<string, any>([['studio-cell-agent', structuredClone(baseJob)]]);
  const policies = new Map<string, any>([['studio-cell-agent', { bindings: [{ role: 'roles/run.jobsExecutorWithOverrides', members: ['serviceAccount:cell@x'] }] }]]);
  const calls: { method: string; url: string; body: any }[] = [];

  setGcpFetch((async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
    // Reject any jobs:run body that contains a resources field, just as Cloud Run does.
    const runMatch = /\/jobs\/([^/:?]+):run$/.exec(url);
    if (runMatch && method === 'POST') {
      if (JSON.stringify(body).includes('resources')) return json(400, { error: { message: 'Invalid JSON payload received. Unknown name "resources"' } });
      const job = jobs.get(runMatch[1]);
      if (!job) return json(404, { error: { message: 'not found' } });
      return json(200, { metadata: { name: `projects/hawkes-staging/locations/us-west1/jobs/${runMatch[1]}/executions/exec-1` } });
    }
    const createMatch = /\/jobs\?jobId=([^&]+)$/.exec(url);
    if (createMatch && method === 'POST') {
      const id = decodeURIComponent(createMatch[1]);
      jobs.set(id, body);
      return json(200, { name: `operations/${id}`, done: true });
    }
    const iamMatch = /\/jobs\/([^/:?]+):(getIamPolicy|setIamPolicy)$/.exec(url);
    if (iamMatch) {
      if (iamMatch[2] === 'setIamPolicy') { policies.set(iamMatch[1], body.policy); return json(200, body.policy); }
      return json(200, policies.get(iamMatch[1]) ?? {});
    }
    const jobMatch = /\/jobs\/([^/:?]+)$/.exec(url);
    if (jobMatch) {
      if (method === 'PATCH') { jobs.set(jobMatch[1], body); return json(200, body); }
      const j = jobs.get(jobMatch[1]);
      return j ? json(200, j) : json(404, { error: { message: 'not found' } });
    }
    return json(404, { error: { message: `unexpected ${method} ${url}` } });
  }) as typeof fetch, 'test-token');

  try {
    // 1. Missing studio-cell-agent-1g: created from studio-cell-agent with 1Gi memory, IAM copied, then run.
    const target = { project: 'hawkes-staging', region: 'us-west1', job: 'studio-cell-agent' };
    const exec1 = await runJob(target, { env: { STUDIO_JOB_UNIT: 'u1' }, timeoutSeconds: 1800, memoryMiB: 1024 });
    assert.equal(exec1, 'projects/hawkes-staging/locations/us-west1/jobs/studio-cell-agent-1g/executions/exec-1');
    assert.equal(jobs.get('studio-cell-agent-1g')?.template?.template?.containers?.[0]?.resources?.limits?.memory, '1Gi');
    assert.equal(jobs.get('studio-cell-agent-1g')?.template?.template?.containers?.[0]?.resources?.limits?.cpu, '2');
    assert.deepEqual(policies.get('studio-cell-agent-1g'), policies.get('studio-cell-agent'));
    const runCall1 = calls.find((c) => c.url.endsWith(':run'))!;
    assert.equal(runCall1.url, 'https://run.googleapis.com/v2/projects/hawkes-staging/locations/us-west1/jobs/studio-cell-agent-1g:run');
    assert.deepEqual(runCall1.body, pre494RunBody({ env: { STUDIO_JOB_UNIT: 'u1' }, timeoutSeconds: 1800 }));
    assert.equal(JSON.stringify(runCall1.body).includes('resources'), false);

    // 2. Existing studio-cell-agent-1g with wrong memory (512Mi): patched to 1Gi before running.
    calls.length = 0;
    jobs.get('studio-cell-agent-1g').template.template.containers[0].resources.limits.memory = '512Mi';
    await runJob(target, { env: { STUDIO_JOB_UNIT: 'u2' }, timeoutSeconds: 1800, memoryMiB: 1024 });
    assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/jobs/studio-cell-agent-1g')), 'patched the existing job');
    assert.equal(jobs.get('studio-cell-agent-1g')?.template?.template?.containers?.[0]?.resources?.limits?.memory, '1Gi');

    // 3. Existing studio-cell-agent-1g already at 1Gi and current image: run directly without POST create or PATCH.
    calls.length = 0;
    await runJob(target, { env: { STUDIO_JOB_UNIT: 'u3' }, timeoutSeconds: 1800, memoryMiB: 1024 });
    assert.equal(calls.some((c) => (c.method === 'POST' && c.url.includes('?jobId=')) || c.method === 'PATCH'), false);
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/jobs/studio-cell-agent-1g:run')));
  } finally {
    setGcpFetch(null);
  }
});

test('the build\'s own setting wins, and dose-of-destruction\'s npm build is 1024 MiB', () => {
  assert.equal(buildMemoryMiB({ id: 'dose-of-destruction' }, { tool: 'npm' }), 1024);
  assert.equal(buildMemoryMiB({ id: 'dose-of-destruction' }, { tool: 'npm', memoryMiB: 2048 }), 2048);
  assert.equal(buildMemoryMiB({ id: 'x' }, { tool: 'npm', memoryMiB: 768 }), 768);
});

test('memoryMiB is checked', () => {
  assert.equal(checkMemoryMiB(1024), 1024);
  assert.throws(() => checkMemoryMiB(100), /512 to 8192/);
  assert.throws(() => checkMemoryMiB('lots'), /512 to 8192/);
});

test('runCloudBuild hands memoryMiB to the runner\'s start, and only when set', async () => {
  const J = await import('../src/cloudjob.ts');
  const seen: unknown[] = [];
  J.setJobRunner(() => ({
    put: async () => {}, get: async () => null, list: async () => [], remove: async () => {},
    start: async (_u: string, o?: { memoryMiB?: number }) => { seen.push(o); throw new Error('stop here'); },
    state: async () => null, cancel: async () => {},
  } as any));
  try {
    for (const memoryMiB of [1024, undefined]) {
      await assert.rejects(J.runCloudBuild(`mem-${memoryMiB}`, { remote: 'https://github.com/a/b.git', head: 'abc', cwd: '/tmp/build/x', command: 'true', outputs: ['dist'], ...(memoryMiB ? { memoryMiB } : {}) }), /stop here/);
    }
  } finally { J.setJobRunner(null); }
  assert.deepEqual(seen, [{ memoryMiB: 1024 }, undefined]);
});
