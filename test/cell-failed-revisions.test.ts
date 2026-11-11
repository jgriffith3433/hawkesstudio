// 2026-11-11: twelve of J's cell revisions (00106 to 00118) had failed to start for want of CPU in us-east4, and Cloud
// Run kept retrying each of them about once a minute, competing with the new one for the same room. A roll now deletes
// the failed revisions that serve no traffic (cellrun.ts dropFailedRevisions), before it starts and when it gives up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-failedrev-'));
delete process.env.STUDIO_CELLS_DRY_RUN;
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_MASTER = 'm'.repeat(40);

const R = await import('../src/cellrun.ts');
const { setGcpFetch } = await import('../src/gcp.ts');
const cfg = { project: 'p', projectNumber: '1', region: 'us-east4', serviceAccount: 'sa@x', bucket: 'b', agentJob: 'studio-cell-agent', lane: 'live', publicUrl: 'https://x', controlUrl: 'https://x' } as any;
const P = 'projects/p/locations/us-east4/services/studio-o-acme/revisions/';

function fakeGoogle(revs: any[], svcExtra: any = {}) {
  const svc: any = { name: 'projects/p/locations/us-east4/services/studio-o-acme', labels: { 'hawkes-studio-cell': '1', 'hawkes-org': 'acme', 'hawkes-lane': 'live' }, template: { containers: [{ image: 'old', resources: { limits: { cpu: '2', memory: '4Gi' } } }] }, latestReadyRevision: `${P}r-00105`, latestCreatedRevision: `${P}r-00119`, trafficStatuses: [{ revision: 'r-00105', percent: 100 }], ...svcExtra };
  const deleted: string[] = [];
  setGcpFetch((async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (/oauth2|metadata|token/.test(url)) return json({ access_token: 't', expires_in: 3600 });
    if (method === 'GET' && /\/revisions\?/.test(url)) return json({ revisions: revs });
    if (method === 'DELETE') { deleted.push(url.split('/revisions/')[1]); return json({}); }
    if (method === 'GET' && /\/services\?/.test(url)) return json({ services: [svc] });
    if (method === 'GET' && /\/jobs/.test(url)) return json({});
    if (method === 'GET') return json(svc);
    if (method === 'PATCH') { const b = JSON.parse(init.body); Object.assign(svc.template, b.template); return json({}); }
    return new Response('{}', { status: 404 });
  }) as any);
  return { svc, deleted };
}

const failed = (n: string) => ({ name: P + n, conditions: [{ type: 'Ready', state: 'CONDITION_FAILED', message: 'Container failed to become healthy.' }] });

test('failed revisions with no traffic go; the serving, the newest and the starting ones stay', async () => {
  const g = fakeGoogle([
    { name: P + 'r-00105', conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }] },
    failed('r-00110'),
    failed('r-00118'),
    { name: P + 'r-00117', reconciling: true, conditions: [{ type: 'Ready', state: 'CONDITION_RECONCILING' }] },
    { ...failed('r-00119') },
    { name: P + 'r-00100', terminalCondition: { state: 'CONDITION_FAILED', message: 'x' } },
  ]);
  try {
    const out = await R.dropFailedRevisions('studio-o-acme', { log: () => {} }, cfg);
    assert.deepEqual(out.sort(), ['r-00100', 'r-00110', 'r-00118']);
    assert.deepEqual(g.deleted.sort(), ['r-00100', 'r-00110', 'r-00118']);
  } finally { setGcpFetch(null); }
});

test('a failed revision that still has traffic stays', async () => {
  const g = fakeGoogle([failed('r-00105'), failed('r-00110')], { latestReadyRevision: `${P}r-00099`, trafficStatuses: [{ revision: `${P}r-00110`, percent: 100 }] });
  try {
    assert.deepEqual(await R.dropFailedRevisions('studio-o-acme', { log: () => {} }, cfg), ['r-00105']);
    assert.deepEqual(g.deleted, ['r-00105']);
  } finally { setGcpFetch(null); }
});

test('a roll clears failed revisions before it starts and again when it gives up', async () => {
  fakeGoogle([]);
  const calls: string[] = [];
  try {
    const r = await R.rollCells('bad', { health: async () => true, log: () => {}, outcome: async () => { calls.push('outcome'); return { ok: false, why: 'Container failed to start and listen on the port' }; }, shortOfCpu: async () => false, dropFailed: async () => { calls.push('drop'); return []; } }, cfg);
    assert.equal(r.failed, 'studio-o-acme');
    assert.deepEqual(calls, ['drop', 'outcome', 'drop']);
  } finally { setGcpFetch(null); }
});
