// 2026-11-11 06:48-07:57: J's Studio cell failed seven rolls in a row and stayed on old code. Two causes, both here:
//   1. The roll judged its new revision by the SERVICE's conditions, which still held an older revision's "startup
//      probes timed out after 10m": each roll called itself failed 20-60 s in, went back, and left the revision
//      retrying for good (three at once by 07:55).
//   2. Every roll and every rollback asked for the 10 GiB working disk again. Google had refused it, then stopped saying
//      so: it took each revision and never started an instance (no output, the probe ran out).
// Now a roll judges only the revision it made, a cell refused the disk stays in memory (and so does its rollback), a
// silent refusal falls back to memory in the same roll, and revisions that never started are deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rollstuck-'));
delete process.env.STUDIO_CELLS_DRY_RUN;
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_MASTER = 'm'.repeat(40);

const R = await import('../src/cellrun.ts');
const { setGcpFetch } = await import('../src/gcp.ts');
const cfg = { project: 'p', projectNumber: '1', region: 'us-east4', serviceAccount: 'sa@x', bucket: 'b', agentJob: 'studio-cell-agent', lane: 'live', publicUrl: 'https://x', controlUrl: 'https://x' } as any;
const P = 'projects/p/locations/us-east4/services/studio-o-acme/revisions/';
const MEM = { name: 'studio-work', emptyDir: { medium: 'MEMORY', sizeLimit: '2560Mi' } };
const STALE = 'Container failed to become healthy. Startup probes timed out after 10m (60 attempts with a period of 10s each).';

/**
 * A Cloud Run that behaves like us-east4 on 2026-11-11: the cell serves r-00127 in memory; the service still carries an
 * older revision's failure; a revision with the working disk is accepted but never starts; one without it starts after
 * `startPolls` looks.
 */
function cloudRun(o: { servingEnv?: any[]; startPolls?: number; imageBad?: boolean } = {}) {
  let n = 127;
  const revs: Record<string, any> = {
    'r-00127': { name: P + 'r-00127', containers: [{ image: 'old', env: o.servingEnv ?? [] }], volumes: [MEM], conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }] },
  };
  const svc: any = {
    name: 'projects/p/locations/us-east4/services/studio-o-acme', labels: { 'hawkes-studio-cell': '1', 'hawkes-org': 'acme', 'hawkes-lane': 'live' },
    template: { containers: [{ image: 'old', resources: { limits: { cpu: '2', memory: '4Gi' } } }], volumes: [MEM] },
    latestReadyRevision: P + 'r-00127', latestCreatedRevision: P + 'r-00127', trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
    // The leftover: an older revision's failure, still on the service.
    terminalCondition: { type: 'Ready', state: 'CONDITION_FAILED', message: STALE },
    conditions: [{ type: 'RoutesReady', state: 'CONDITION_FAILED', message: STALE }],
  };
  const polls: Record<string, number> = {};
  let lagged: string | null = null;
  const made: { name: string; disk: string; image: string }[] = [];
  const deleted: string[] = [];
  const tick = (name: string) => {
    const r = revs[name];
    if (!r || r.conditions[0].state !== 'CONDITION_PENDING') return;
    polls[name] = (polls[name] ?? 0) + 1;
    const disk = r.volumes?.some((v: any) => v.emptyDir?.medium === 'DISK');
    // With the disk: never starts, and Google says nothing until the probe runs out (later than any roll waits here).
    if (disk) return;
    if (r.containers[0].image === 'bad' || o.imageBad) { if (polls[name] >= 2) { r.conditions = [{ type: 'Ready', state: 'CONDITION_FAILED', message: 'Container failed to start and listen on the port' }]; svc.reconciling = false; svc.terminalCondition = { type: 'Ready', state: 'CONDITION_FAILED', message: 'Container failed to start and listen on the port' }; } return; }
    if (polls[name] >= (o.startPolls ?? 2)) { r.conditions = [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }]; svc.latestReadyRevision = P + name; svc.reconciling = false; svc.terminalCondition = { type: 'Ready', state: 'CONDITION_SUCCEEDED' }; }
  };
  setGcpFetch((async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (/oauth2|metadata|token/.test(url)) return json({ access_token: 't', expires_in: 3600 });
    if (method === 'GET' && /\/services\?/.test(url)) return json({ services: [svc] });
    if (method === 'GET' && /\/revisions\?/.test(url)) return json({ revisions: Object.values(revs) });
    const one = /\/revisions\/([^/?]+)$/.exec(url);
    if (method === 'GET' && one) { tick(one[1]); return revs[one[1]] ? json(revs[one[1]]) : new Response('{}', { status: 404 }); }
    if (method === 'DELETE' && one) { deleted.push(one[1]); delete revs[one[1]]; return json({}); }
    if (method === 'GET' && /\/jobs/.test(url)) return json({});
    if (method === 'GET') {
      // Right after a change Google still shows the service as it was, old failure included and not reconciling (what
      // the roll misread); from the next look the new revision is there and the service reconciles until it settles.
      if (lagged) { const view = { ...svc, latestCreatedRevision: lagged, reconciling: false, terminalCondition: { type: 'Ready', state: 'CONDITION_FAILED', message: STALE } }; lagged = null; return json(view); }
      return json(svc);
    }
    if (method === 'PATCH') {
      const b = JSON.parse(init.body);
      Object.assign(svc.template, b.template);
      const name = `r-00${++n}`;
      revs[name] = { name: P + name, createTime: new Date().toISOString(), containers: structuredClone(svc.template.containers), volumes: structuredClone(svc.template.volumes ?? []), conditions: [{ type: 'Ready', state: 'CONDITION_PENDING' }] };
      lagged = svc.latestCreatedRevision;
      svc.latestCreatedRevision = P + name;
      svc.reconciling = true;
      svc.terminalCondition = { type: 'Ready', state: 'CONDITION_PENDING', message: 'Provisioning revision instances to receive traffic.' };
      made.push({ name, disk: (svc.template.volumes ?? []).find((v: any) => v.name === 'studio-work')?.emptyDir?.medium ?? 'none', image: svc.template.containers[0].image });
      return json({});
    }
    return new Response('{}', { status: 404 });
  }) as any);
  return { svc, revs, made, deleted };
}

// The roll's own wait, without the 5 s sleeps: the real newRevisionOutcome with a short window.
const quick = (ms = 400) => (service: string, image: string, c: any, _w?: number, since?: string | null) => R.newRevisionOutcome(service, image, c, ms, since);
const env = (ms: number) => [{ name: R.DISK_REFUSED_ENV, value: String(ms) }];

test('an older revision\'s leftover failure on the service no longer fails the new revision', async () => {
  const g = cloudRun();
  try {
    // Patch first (as a roll does), then judge: the new revision starts on the second look and serves.
    const since = await R.createdRevision('studio-o-acme', cfg);
    await R.setImage('studio-o-acme', 'v2', { disk: false }, cfg);
    const r = await R.newRevisionOutcome('studio-o-acme', 'v2', cfg, 30_000, since);
    assert.deepEqual(r, { ok: true, why: null }, 'the stale "startup probes timed out" on the service was not read as this revision\'s');
  } finally { setGcpFetch(null); }
});

test('a cell Google refused the disk stays in memory: no roll asks for it again, and the roll lands', async () => {
  const g = cloudRun({ servingEnv: env(Date.now() - 60_000) });
  const lines: string[] = [];
  try {
    const r = await R.rollCells('v2', { health: async () => true, log: (s) => lines.push(s), outcome: quick(30_000), shortOfCpu: async () => false }, cfg);
    assert.equal(r.failed, null, lines.join('\n'));
    assert.deepEqual(g.made.map((m) => m.disk), ['MEMORY'], 'one revision, in memory');
    assert.match(lines.join('\n'), /stays off the working disk/);
    assert.ok(g.svc.template.containers[0].env.some((v: any) => v.name === R.DISK_REFUSED_ENV), 'the refusal\'s time goes with it');
  } finally { setGcpFetch(null); }
});

test('the disk refused without a word: the same image goes out in memory in the same roll', async () => {
  // No refusal on record and no volume: the roll asks for the disk, which never starts.
  const g = cloudRun();
  g.revs['r-00127'].volumes = [];
  g.svc.template.volumes = [];
  const lines: string[] = [];
  try {
    // The disk try gets a short window here (its probe would run 10 minutes); the in-memory one a normal one.
    const outcome = (service: string, image: string, c: any, w?: number, since?: string | null) => (g.svc.template.volumes.some((v: any) => v.emptyDir?.medium === 'DISK') ? quick(300) : quick(30_000))(service, image, c, w, since);
    const r = await R.rollCells('v3', { health: async () => true, log: (s) => lines.push(s), outcome, shortOfCpu: async () => false }, cfg);
    assert.equal(r.failed, null, lines.join('\n'));
    assert.deepEqual(g.made.map((m) => [m.disk, m.image]), [['DISK', 'v3'], ['MEMORY', 'v3']]);
    assert.match(lines.join('\n'), /with the working disk didn't start/);
    assert.ok(g.svc.template.containers[0].env.some((v: any) => v.name === R.DISK_REFUSED_ENV), 'the next roll knows');
  } finally { setGcpFetch(null); }
});

test('a bad image goes back on the volume the cell was serving with, never asking for the refused disk', async () => {
  const g = cloudRun({ servingEnv: env(Date.now() - 60_000) });
  try {
    const r = await R.rollCells('bad', { health: async () => true, log: () => {}, outcome: quick(30_000), shortOfCpu: async () => false }, cfg);
    assert.equal(r.failed, 'studio-o-acme');
    assert.deepEqual(g.made.map((m) => [m.disk, m.image]), [['MEMORY', 'bad'], ['MEMORY', 'old']], 'the rollback is in memory, so it can start');
  } finally { setGcpFetch(null); }
});

test('the disk is tried again once the refusal is old (a raise may have been granted)', () => {
  const now = Date.now();
  assert.deepEqual(R.wantsDisk({ mode: 'memory', refusedAt: now - R.diskRetryMs() - 1 }, now).disk, true);
  assert.deepEqual(R.wantsDisk({ mode: 'memory', refusedAt: now - 60_000 }, now).disk, false);
  assert.deepEqual(R.wantsDisk({ mode: 'memory', refusedAt: null }, now), { disk: false, refusedAt: now }, 'a refusal from before this was kept counts from now');
  assert.deepEqual(R.wantsDisk({ mode: 'disk', refusedAt: null }, now).disk, true);
  assert.deepEqual(R.wantsDisk({ mode: 'none', refusedAt: null }, now).disk, true, 'a cell that never had a working volume gets the disk');
  assert.deepEqual(R.wantsDisk(null, now).disk, true);
});

test('revisions that never started go, the one still starting stays', async () => {
  const g = cloudRun();
  const old = new Date(Date.now() - R.STARTUP_WINDOW_MS - 60_000).toISOString();
  const pending = (name: string, createTime: string) => ({ name: P + name, createTime, containers: [{ image: 'x' }], conditions: [{ type: 'Ready', state: 'CONDITION_UNKNOWN', message: 'Retrying container health check; still waiting to become healthy.' }] });
  g.revs['r-00140'] = pending('r-00140', old);
  g.revs['r-00141'] = pending('r-00141', old);
  g.revs['r-00142'] = pending('r-00142', new Date().toISOString());
  g.svc.latestCreatedRevision = P + 'r-00142';
  try {
    const out = await R.dropFailedRevisions('studio-o-acme', { log: () => {} }, cfg);
    assert.deepEqual(out.sort(), ['r-00140', 'r-00141']);
    assert.ok(g.revs['r-00127'] && g.revs['r-00142'], 'the serving one and the one still in its window stay');
  } finally { setGcpFetch(null); }
});

test('startTimedOut tells a start that never answered from a crash', () => {
  assert.equal(R.startTimedOut(STALE), true);
  assert.equal(R.startTimedOut("the new revision wasn't serving in time"), true);
  assert.equal(R.startTimedOut('Container failed to start and listen on the port'), false);
});
