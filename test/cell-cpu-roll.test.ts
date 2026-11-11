// 2026-11-11 00:07: J's Studio's new revision (00098) never got an instance while about 26 Unity build and agent job
// executions held us-east4's Cloud Run CPU quota; the roll went back to the old image and the old revision then lost its
// instance too, so studio.hawkesgen.ai was down. Now the roll itself frees the room (cellrun.ts rollCells): the jobs give
// way, Unity builds first, and the same image is tried again as a new revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cpuroll-'));
delete process.env.STUDIO_CELLS_DRY_RUN;
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_MASTER = 'm'.repeat(40);

const R = await import('../src/cellrun.ts');
const { setGcpFetch } = await import('../src/gcp.ts');
const cfg = { project: 'p', projectNumber: '1', region: 'us-east4', serviceAccount: 'sa@x', bucket: 'b', agentJob: 'studio-cell-agent', lane: 'live', publicUrl: 'https://x', controlUrl: 'https://x' } as any;

/** Google with one cell, the yielding jobs and their open executions; records cancels in order. */
function fakeGoogle() {
  const svc: any = { name: 'projects/p/locations/us-east4/services/studio-o-acme', labels: { 'hawkes-studio-cell': '1', 'hawkes-org': 'acme', 'hawkes-lane': 'live' }, template: { containers: [{ image: 'old', resources: { limits: { cpu: '2', memory: '4Gi' } } }] } };
  const open: Record<string, string[]> = { 'hawkes-unity-build': ['u1', 'u2'], 'hawkes-unity-build-customer': ['u3'], 'studio-cell-agent': ['a1'], 'gen-other': ['g1'] };
  const cancelled: string[] = [];
  const patches: any[] = [];
  setGcpFetch((async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (/oauth2|metadata|token/.test(url)) return json({ access_token: 't', expires_in: 3600 });
    const ex = /jobs\/([^/?]+)\/executions/.exec(url);
    if (method === 'GET' && ex && ex[1] !== '-') return json({ executions: (open[ex[1]] ?? []).map((e) => ({ name: `projects/p/locations/us-east4/jobs/${ex[1]}/executions/${e}`, createTime: '2026-11-11T00:00:00Z' })) });
    if (method === 'GET' && /\/jobs\?/.test(url)) return json({ jobs: Object.keys(open).map((j) => ({ name: `projects/p/locations/us-east4/jobs/${j}` })) });
    if (method === 'GET' && /\/services\?/.test(url)) return json({ services: [svc] });
    if (method === 'GET') return json(svc);
    if (method === 'POST' && url.endsWith(':cancel')) { cancelled.push(url.split('/executions/')[1].replace(':cancel', '')); return json({}); }
    if (method === 'PATCH') { const b = JSON.parse(init.body); patches.push(b); Object.assign(svc.template, b.template); return json({}); }
    return new Response('{}', { status: 404 });
  }) as any);
  return { svc, cancelled, patches };
}

test('a cell revision with no CPU: the jobs give way (Unity builds first), the same image goes out again and lands', async () => {
  const g = fakeGoogle();
  const tries: string[] = [];
  const outcome = async () => { tries.push(g.svc.template.containers[0].image); return tries.length === 1 ? { ok: false, why: 'Revision is not ready and cannot serve traffic. The user-provided container failed the configured startup probe checks.' } : { ok: true, why: null }; };
  const lines: string[] = [];
  try {
    const r = await R.rollCells('v2', { health: async () => true, log: (s) => lines.push(s), outcome, shortOfCpu: async () => true }, cfg);
    assert.equal(r.failed, null, lines.join('\n'));
    assert.deepEqual(r.done, ['studio-o-acme']);
    assert.deepEqual(g.cancelled, ['u1', 'u2', 'u3', 'a1'], 'Unity builds first, then the agents; nothing else');
    assert.equal(g.svc.template.containers[0].image, 'v2');
    assert.ok(g.svc.template.containers[0].env.some((v: any) => v.name === 'STUDIO_ROLL_TRY'), 'a new revision, not the same template');
    assert.match(lines.join('\n'), /got no CPU/);
  } finally { setGcpFetch(null); }
});

test("an image that fails with CPU to spare stops no job and goes back", async () => {
  const g = fakeGoogle();
  try {
    const r = await R.rollCells('bad', { health: async () => true, log: () => {}, outcome: async () => ({ ok: false, why: 'Container failed to start and listen on the port' }), shortOfCpu: async () => false }, cfg);
    assert.equal(r.failed, 'studio-o-acme');
    assert.deepEqual(g.cancelled, []);
    assert.equal(g.svc.template.containers[0].image, 'old');
  } finally { setGcpFetch(null); }
});

test("Google's own CPU-quota words are enough, without reading the region", async () => {
  const g = fakeGoogle();
  let n = 0;
  try {
    const r = await R.rollCells('v3', { health: async () => true, log: () => {}, outcome: async () => (++n === 1 ? { ok: false, why: 'Quota exceeded for total allowable CPU per project per region.' } : { ok: true, why: null }), shortOfCpu: async () => { throw new Error('not asked'); } }, cfg);
    assert.equal(r.failed, null);
    assert.equal(g.cancelled.length, 4);
  } finally { setGcpFetch(null); }
});

test('cpuFailure', () => {
  assert.equal(R.cpuFailure('Quota exceeded for total allowable CPU per project per region.'), true);
  assert.equal(R.cpuFailure('aborted after waiting too long for an available instance: no available instance'), true);
  assert.equal(R.cpuFailure('Quota exceeded for total allowable ephemeral disk allocation per project per region.'), false);
  assert.equal(R.cpuFailure('Container failed to start and listen on the port'), false);
});
