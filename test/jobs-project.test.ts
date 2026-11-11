import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobCopy, jobsProject, jobsApart, startInJobsProject, copyJob, jobsHooks, resetJobsProject } from '../src/jobsproject.ts';
import { cellsConfig, cellEnv, withJobsEnv } from '../src/cellrun.ts';
import { RESERVE_VCPU } from '../src/cpuroom.ts';

process.env.STUDIO_CELLS_MASTER ||= 'm'.repeat(40);

const withEnv = async (vars: Record<string, string | undefined>, fn: () => unknown) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) if (v == null) delete process.env[k]; else process.env[k] = v; resetJobsProject(); }
};

test('the jobs project: its own when named, the server\'s otherwise', () => {
  assert.equal(jobsProject({ STUDIO_GCP_PROJECT: 'staging' }), 'staging');
  assert.equal(jobsApart({ STUDIO_GCP_PROJECT: 'staging' }), false);
  assert.equal(jobsProject({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'jobs' }), 'jobs');
  assert.equal(jobsApart({ STUDIO_GCP_PROJECT: 'staging', STUDIO_CELLS_JOBS_PROJECT: 'jobs' }), true);
  assert.equal(jobsApart({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'staging' }), false);
});

test('a copied job: output-only fields go, short secret names get their full path in the old project', () => {
  const j = {
    name: 'projects/staging/locations/us-east4/jobs/studio-cell-agent', uid: 'u', etag: 'e', generation: '3', labels: { a: 'b' },
    template: { taskCount: 1, template: {
      serviceAccount: 'sa@staging.iam.gserviceaccount.com', timeout: '14400s',
      containers: [{ image: 'img', resources: { limits: { cpu: '2' } }, env: [
        { name: 'A', value: '1' },
        { name: 'K', valueSource: { secretKeyRef: { secret: 'anthropic-key', version: 'latest' } } },
        { name: 'F', valueSource: { secretKeyRef: { secret: 'projects/9/secrets/other', version: '2' } } },
      ] }],
      volumes: [{ name: 'v', secret: { secret: 'cfg' } }],
    } },
  };
  const c = jobCopy(j, '123');
  for (const k of ['name', 'uid', 'etag', 'generation']) assert.equal(k in c, false, k);
  assert.deepEqual(c.labels, { a: 'b' });
  const t = c.template.template;
  assert.equal(t.serviceAccount, 'sa@staging.iam.gserviceaccount.com');
  assert.equal(t.containers[0].image, 'img');
  assert.deepEqual(t.containers[0].env.map((v: any) => v.value ?? v.valueSource.secretKeyRef.secret), ['1', 'projects/123/secrets/anthropic-key', 'projects/9/secrets/other']);
  assert.equal(t.volumes[0].secret.secret, 'projects/123/secrets/cfg');
  assert.equal(j.template.template.containers[0].env[1].valueSource!.secretKeyRef.secret, 'anthropic-key', 'the original is left alone');
});

test('a start runs in the jobs project, making the job there first when it is missing', async () => {
  const made: string[] = [];
  const have = new Set(['staging/studio-agent']);
  jobsHooks.gapi = async (url: string, o: any = {}) => {
    const m = /projects\/([^/]+)\/locations\/[^/]+\/jobs(?:\/([^/:?]+))?/.exec(url)!;
    const [, p, job] = m;
    if (url.includes('?jobId=')) { made.push(`${p}/${new URL(url).searchParams.get('jobId')}`); have.add(`${p}/studio-agent`); return {}; }
    if (url.endsWith(':getIamPolicy')) return { bindings: [{ role: 'roles/run.viewer', members: ['serviceAccount:c@x'] }] };
    if (url.endsWith(':setIamPolicy')) { made.push(`iam ${p}`); return {}; }
    if (have.has(`${p}/${job}`)) return { template: { template: { containers: [{ image: 'i' }] } } };
    if (o.missingOk) return null;
    throw new Error(`Google Cloud answered 404 for ${url}: not found`);
  };
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'jobs' }, async () => {
    jobsHooks.gapi = jobsHooks.gapi; // kept across withEnv's reset below
    const ran: string[] = [];
    const start = async (p: string) => { if (!have.has(`${p}/studio-agent`)) throw new Error('Google Cloud answered 404 for x: Resource not found'); ran.push(p); return p; };
    assert.equal(await startInJobsProject({ region: 'us-east4', job: 'studio-agent' }, start), 'jobs');
    assert.deepEqual(made, ['jobs/studio-agent', 'iam jobs']);
    assert.deepEqual(ran, ['jobs']);
  });
});

test('a start whose job cannot be made in the jobs project runs in the server\'s, as before', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'jobs' }, async () => {
    jobsHooks.gapi = async () => { throw new Error('Google Cloud answered 403 for x: PERMISSION_DENIED'); };
    const ran: string[] = [];
    const start = async (p: string) => { if (p === 'jobs') throw new Error('Google Cloud answered 403 for x: PERMISSION_DENIED'); ran.push(p); return p; };
    assert.equal(await startInJobsProject({ region: 'us-east4', job: 'studio-cell-agent' }, start), 'staging');
    assert.deepEqual(ran, ['staging']);
  });
});

test('a start fails as before for a reason that is not the job\'s place', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'jobs' }, async () => {
    await assert.rejects(startInJobsProject({ region: 'r', job: 'j' }, async () => { throw new Error('Google Cloud answered 429: quota'); }), /429/);
  });
});

test('no jobs project: a start runs where it always did, nothing copied', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: undefined, STUDIO_CELLS_JOBS_PROJECT: undefined }, async () => {
    jobsHooks.gapi = async () => { throw new Error('should not be called'); };
    assert.equal(await startInJobsProject({ region: 'r', job: 'j' }, async (p) => p), 'staging');
  });
});

test('copyJob leaves a job that is already there alone', async () => {
  let posts = 0;
  jobsHooks.gapi = async (_url: string, o: any = {}) => { if (o.body) posts++; return {}; };
  assert.equal(await copyJob({ from: 'staging', to: 'jobs', region: 'r', job: 'j' }), 'there');
  assert.equal(posts, 0);
  resetJobsProject();
});

test('cells are told the jobs project only when it differs, and a roll brings an older cell onto it', () => {
  const base = { STUDIO_CELLS_PROJECT: 'staging', STUDIO_CELLS_PROJECT_NUMBER: '1', STUDIO_CELLS_SA: 'sa', STUDIO_CELLS_BUCKET: 'b' };
  const same = cellsConfig(base as any);
  const apart = cellsConfig({ ...base, STUDIO_CELLS_JOBS_PROJECT: 'jobs' } as any);
  const owner = { sub: 's', email: 'e@x' };
  assert.equal(same.jobsProject, 'staging');
  assert.equal('STUDIO_JOBS_PROJECT' in cellEnv('org-one', owner, same), false);
  assert.equal(cellEnv('org-one', owner, apart).STUDIO_JOBS_PROJECT, 'jobs');
  assert.equal(cellEnv('org-one', owner, apart).STUDIO_GCP_PROJECT, 'staging', 'the cell itself stays where it is');
  const old = [{ name: 'A', value: '1' }];
  assert.deepEqual(withJobsEnv(old, apart), [{ name: 'A', value: '1' }, { name: 'STUDIO_JOBS_PROJECT', value: 'jobs' }]);
  assert.deepEqual(withJobsEnv([...old, { name: 'STUDIO_JOBS_PROJECT', value: 'jobs' }], same), old, 'moved back: the cell is told so');
});

test('with the jobs apart, nothing is kept back from their quota for the server', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'jobs', STUDIO_CPU_RESERVE: undefined }, () => assert.equal(RESERVE_VCPU(), 0));
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: undefined, STUDIO_CELLS_JOBS_PROJECT: undefined, STUDIO_CPU_RESERVE: undefined }, () => assert.equal(RESERVE_VCPU(), 8));
});
