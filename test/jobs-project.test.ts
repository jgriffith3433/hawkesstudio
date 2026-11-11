import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobCopy, jobsProject, jobsRegion, jobsApart, startInJobsPlace, copyJob, jobsHooks, resetJobsProject } from '../src/jobsproject.ts';
import { cellsConfig, cellEnv, withJobsEnv } from '../src/cellrun.ts';
import { RESERVE_VCPU } from '../src/cpuroom.ts';

process.env.STUDIO_CELLS_MASTER ||= 'm'.repeat(40);

const withEnv = async (vars: Record<string, string | undefined>, fn: () => unknown) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) if (v == null) delete process.env[k]; else process.env[k] = v; resetJobsProject(); }
};

test('the jobs\' place: another region of the same project by default, or what is named', () => {
  const live = { STUDIO_GCP_PROJECT: 'staging', STUDIO_GCP_REGION: 'us-east4' };
  assert.equal(jobsProject(live), 'staging');
  assert.equal(jobsRegion(live), 'us-east1');
  assert.equal(jobsApart(live), true, 'the default keeps them off the server\'s regional CPU quota');
  assert.equal(jobsRegion({ ...live, STUDIO_GCP_REGION: 'us-east1' }), 'us-east4', 'a server already in the away region sends them to us-east4');
  assert.equal(jobsRegion({ ...live, STUDIO_JOBS_REGION: 'us-south1' }), 'us-south1');
  assert.equal(jobsApart({ ...live, STUDIO_JOBS_REGION: 'same' }), false, '"same" keeps them beside the server');
  assert.equal(jobsApart({ ...live, STUDIO_JOBS_REGION: 'same', STUDIO_JOBS_PROJECT: 'jobs' }), true);
  assert.equal(jobsApart({ STUDIO_GCP_REGION: 'us-east4' }), false, 'no project: not on Google Cloud');
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

test('a start runs in the jobs\' region, making the job there first when it is missing', async () => {
  const made: string[] = [];
  const have = new Set(['staging@us-east4/studio-agent']);
  const hook = async (url: string, o: any = {}) => {
    const m = /projects\/([^/]+)\/locations\/([^/]+)\/jobs(?:\/([^/:?]+))?/.exec(url)!;
    const [, proj, reg, job] = m;
    const p = `${proj}@${reg}`;
    if (url.includes('?jobId=')) { made.push(`${p}/${new URL(url).searchParams.get('jobId')}`); have.add(`${p}/studio-agent`); return {}; }
    if (url.endsWith(':getIamPolicy')) return { bindings: [{ role: 'roles/run.viewer', members: ['serviceAccount:c@x'] }] };
    if (url.endsWith(':setIamPolicy')) { made.push(`iam ${p}`); return {}; }
    if (have.has(`${p}/${job}`)) return { template: { template: { containers: [{ image: 'i' }] } } };
    if (o.missingOk) return null;
    throw new Error(`Google Cloud answered 404 for ${url}: not found`);
  };
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_GCP_REGION: 'us-east4', STUDIO_JOBS_REGION: undefined, STUDIO_JOBS_PROJECT: undefined }, async () => {
    jobsHooks.gapi = hook;
    const ran: string[] = [];
    const start = async (p: { project: string; region: string }) => { if (!have.has(`${p.project}@${p.region}/studio-agent`)) throw new Error('Google Cloud answered 404 for x: Resource not found'); ran.push(`${p.project}@${p.region}`); return p.region; };
    assert.equal(await startInJobsPlace('studio-agent', start), 'us-east1');
    assert.deepEqual(made, ['staging@us-east1/studio-agent', 'iam staging@us-east1']);
    assert.deepEqual(ran, ['staging@us-east1']);
  });
});

test('a start whose job cannot be made or run in the jobs\' place runs beside the server, as before', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_GCP_REGION: 'us-east4', STUDIO_JOBS_PROJECT: 'jobs' }, async () => {
    jobsHooks.gapi = async () => { throw new Error('Google Cloud answered 403 for x: PERMISSION_DENIED'); };
    const ran: string[] = [];
    const start = async (p: { project: string; region: string }) => { if (p.project === 'jobs') throw new Error('Google Cloud answered 403 for x: PERMISSION_DENIED'); ran.push(`${p.project}@${p.region}`); return p.project; };
    assert.equal(await startInJobsPlace('studio-cell-agent', start), 'staging');
    assert.deepEqual(ran, ['staging@us-east4']);
  });
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_GCP_REGION: 'us-east4', STUDIO_JOBS_PROJECT: undefined, STUDIO_JOBS_REGION: undefined }, async () => {
    // A region the job can't be made in (a network only the server's region has): Google answers 400; it runs at home.
    jobsHooks.gapi = async (url: string, o: any = {}) => { if (o.missingOk) return null; if (o.body) throw new Error('Google Cloud answered 400 for x: connector not in region'); return { template: { template: {} } }; };
    const ran: string[] = [];
    const start = async (p: { project: string; region: string }) => { if (p.region === 'us-east1') throw new Error('Google Cloud answered 404 for x: not found'); ran.push(p.region); return p.region; };
    assert.equal(await startInJobsPlace('studio-agent', start), 'us-east4');
    assert.deepEqual(ran, ['us-east4']);
  });
});

test('a start fails as before for a reason that is not the job\'s place', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'jobs' }, async () => {
    await assert.rejects(startInJobsPlace('j', async () => { throw new Error('Google Cloud answered 429: quota'); }), /429/);
  });
});

test('"same": a start runs where it always did, nothing copied', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_GCP_REGION: 'us-east4', STUDIO_JOBS_REGION: 'same', STUDIO_JOBS_PROJECT: undefined, STUDIO_CELLS_JOBS_PROJECT: undefined }, async () => {
    jobsHooks.gapi = async () => { throw new Error('should not be called'); };
    assert.equal(await startInJobsPlace('j', async (p) => `${p.project}@${p.region}`), 'staging@us-east4');
  });
});

test('copyJob leaves a job that is already there alone', async () => {
  let posts = 0;
  jobsHooks.gapi = async (_url: string, o: any = {}) => { if (o.body) posts++; return {}; };
  assert.equal(await copyJob({ from: { project: 'staging', region: 'us-east4' }, to: { project: 'staging', region: 'us-east1' }, job: 'j' }), 'there');
  assert.equal(posts, 0);
  resetJobsProject();
});

test('cells\' jobs go to another region by default; cells are told a named place, and a roll brings an older cell onto it', () => {
  const base = { STUDIO_CELLS_PROJECT: 'staging', STUDIO_CELLS_PROJECT_NUMBER: '1', STUDIO_CELLS_SA: 'sa', STUDIO_CELLS_BUCKET: 'b', STUDIO_CELLS_REGION: 'us-east4' };
  const byDefault = cellsConfig(base as any);
  const same = cellsConfig({ ...base, STUDIO_CELLS_JOBS_REGION: 'same' } as any);
  const apart = cellsConfig({ ...base, STUDIO_CELLS_JOBS_PROJECT: 'jobs', STUDIO_CELLS_JOBS_REGION: 'us-south1' } as any);
  const owner = { sub: 's', email: 'e@x' };
  assert.deepEqual([byDefault.jobsProject, byDefault.jobsRegion], ['staging', 'us-east1']);
  assert.equal(cellEnv('org-one', owner, byDefault).STUDIO_JOBS_REGION, 'us-east1');
  assert.equal('STUDIO_JOBS_PROJECT' in cellEnv('org-one', owner, byDefault), false);
  assert.equal('STUDIO_JOBS_REGION' in cellEnv('org-one', owner, same), false);
  assert.equal(cellEnv('org-one', owner, apart).STUDIO_JOBS_PROJECT, 'jobs');
  assert.equal(cellEnv('org-one', owner, apart).STUDIO_GCP_PROJECT, 'staging', 'the cell itself stays where it is');
  assert.equal(cellEnv('org-one', owner, apart).STUDIO_GCP_REGION, 'us-east4');
  const old = [{ name: 'A', value: '1' }];
  assert.deepEqual(withJobsEnv(old, byDefault), [{ name: 'A', value: '1' }, { name: 'STUDIO_JOBS_REGION', value: 'us-east1' }]);
  assert.deepEqual(withJobsEnv([...old, { name: 'STUDIO_JOBS_PROJECT', value: 'jobs' }, { name: 'STUDIO_JOBS_REGION', value: 'x' }], same), old, 'moved back: the cell is told so');
});

test('with the jobs apart, nothing is kept back from their quota for the server', async () => {
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: 'jobs', STUDIO_CPU_RESERVE: undefined }, () => assert.equal(RESERVE_VCPU(), 0));
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: undefined, STUDIO_JOBS_REGION: undefined, STUDIO_CPU_RESERVE: undefined }, () => assert.equal(RESERVE_VCPU(), 0, 'another region by default'));
  await withEnv({ STUDIO_GCP_PROJECT: 'staging', STUDIO_JOBS_PROJECT: undefined, STUDIO_CELLS_JOBS_PROJECT: undefined, STUDIO_JOBS_REGION: 'same', STUDIO_CPU_RESERVE: undefined }, () => assert.equal(RESERVE_VCPU(), 8));
});
