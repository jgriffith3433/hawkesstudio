// Studio's working disk (cellrun.ts CELL_DISK, disksweep.ts onRealDisk, agents.ts rebaseWorktrees). On 2026-11-10 the
// working files lived in the instance's memory, filled it within about an hour of a restart, and the memory gate held
// half the agents (5.7 idle slot-hours). Cells now mount a Cloud Run ephemeral disk and keep those files there; a
// refusal of the disk never fails a deploy; on a real disk the disk's own room counts, not memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-disk-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-disk-projects-'));
delete process.env.STUDIO_CELLS_DRY_RUN;
process.env.STUDIO_CELLS = 'on';
process.env.STUDIO_CELLS_MASTER = 'm'.repeat(40);
process.env.STUDIO_CELLS_PROJECT = 'hawkes-test';
process.env.STUDIO_CELLS_PROJECT_NUMBER = '123456';
process.env.STUDIO_CELLS_REGION = 'us-east4';
process.env.STUDIO_CELLS_SA = 'studio-cells@hawkes-test.iam.gserviceaccount.com';
process.env.STUDIO_CELLS_BUCKET = 'hawkes-test-studio-cells';

const R = await import('../src/cellrun.ts');
const D = await import('../src/disksweep.ts');
const M = await import('../src/memgate.ts');
const { setGcpFetch } = await import('../src/gcp.ts');
const cfg = { project: 'p', projectNumber: '1', region: 'us-east4', serviceAccount: 'sa@x', bucket: 'b', agentJob: 'j', lane: 'live', publicUrl: 'https://x', controlUrl: 'https://x' } as any;
const GB = 1024 ** 3;

test('a new cell mounts the working disk at /disk (gen2, launch stage BETA)', () => {
  const s: any = R.cellService('acme', { sub: 's', email: 'a@b.c' }, 'r/i:1', cfg);
  assert.equal(s.launchStage, 'BETA');
  assert.equal(s.template.executionEnvironment, 'EXECUTION_ENVIRONMENT_GEN2');
  assert.deepEqual(s.template.volumes, [{ name: 'studio-work', emptyDir: { medium: 'DISK', sizeLimit: '10Gi' } }]);
  assert.deepEqual(s.template.containers[0].volumeMounts, [{ name: 'studio-work', mountPath: '/disk' }]);
  const plain: any = R.withoutDisk(s);
  assert.equal(plain.launchStage, undefined);
  assert.equal(plain.template.volumes, undefined);
  assert.equal(plain.template.containers[0].volumeMounts, undefined);
  assert.deepEqual(plain.template.containers[0].resources, s.template.containers[0].resources, 'nothing else changes');
});

test('the disk is added once, beside a cell\'s other volumes', () => {
  assert.deepEqual(R.withDiskVolume([{ name: 'secrets', secret: {} }, { name: 'studio-work', emptyDir: { medium: 'MEMORY' } }]).map((v: any) => v.name), ['secrets', 'studio-work']);
  assert.deepEqual(R.withDiskMount([{ name: 'secrets', mountPath: '/s' }, { name: 'studio-work', mountPath: '/disk' }]), [{ name: 'secrets', mountPath: '/s' }, { name: 'studio-work', mountPath: '/disk' }]);
});

function fakeGoogle(refuseDisk: boolean) {
  const calls: { method: string; url: string; body: any }[] = [];
  const svc: any = { name: 'studio-o-acme', template: { containers: [{ image: 'old', resources: { limits: { cpu: '2', memory: '4Gi' } } }] } };
  setGcpFetch((async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
    if (/oauth2|metadata|token/.test(url)) return json(200, { access_token: 't', expires_in: 3600 });
    if (method === 'GET') return json(200, svc);
    if (method === 'PATCH') {
      if (refuseDisk && (body?.template?.volumes ?? []).some((v: any) => v?.emptyDir?.medium === 'DISK')) return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Ephemeral disk is not available for this project' } });
      Object.assign(svc.template, body.template);
      if (body.launchStage) svc.launchStage = body.launchStage;
      return json(200, {});
    }
    return json(404, {});
  }) as any);
  return { calls, svc };
}

test('a deploy\'s roll puts each cell on the working disk; a refusal of the disk never fails the deploy', async () => {
  const ok = fakeGoogle(false);
  await R.setImage('studio-o-acme', 'v2', {}, cfg);
  assert.equal(ok.svc.template.containers[0].image, 'v2');
  assert.deepEqual(ok.svc.template.containers[0].volumeMounts, [{ name: 'studio-work', mountPath: '/disk' }]);
  assert.equal(ok.svc.template.volumes[0].emptyDir.medium, 'DISK');
  assert.match(ok.calls.find((c) => c.method === 'PATCH')!.url, /updateMask=launchStage,template\.containers,template\.volumes/);

  const no = fakeGoogle(true);
  await R.setImage('studio-o-acme', 'v3', {}, cfg);
  assert.equal(no.svc.template.containers[0].image, 'v3', 'the image still went out');
  assert.equal(no.svc.template.containers[0].volumeMounts, undefined);
  assert.equal(no.calls.filter((c) => c.method === 'PATCH').length, 2);
});

test('on a real disk, room is the disk\'s own; in memory, memory decides as before', () => {
  const sweep = process.env.STUDIO_DISK_SWEEP;
  delete process.env.STUDIO_DISK_SWEEP;
  M.setMemSource(() => ({ limit: 4 * GB, available: 0.3 * GB }));
  D.setDiskSource(() => ({ used: 3 * GB, free: 7 * GB, size: 10 * GB, pct: 30, path: '/disk/projects' }));
  try {
    D.setRealDiskSource(() => true);
    assert.equal(D.diskFull(100 * 1024 * 1024), false, 'low memory no longer refuses a worktree on the disk');
    assert.equal(D.diskHigh(), false, '3 GB of a 10 GB disk is fine');
    assert.match(D.diskSummary(), /on disk/);
    D.setDiskSource(() => ({ used: 9.7 * GB, free: 0.3 * GB, size: 10 * GB, pct: 97, path: '/disk/projects' }));
    assert.equal(D.diskFull(100 * 1024 * 1024), true, 'a full disk still refuses');
    D.setRealDiskSource(() => false);
    D.setDiskSource(() => ({ used: 3 * GB, free: 7 * GB, size: 10 * GB, pct: 30, path: '/tmp/projects' }));
    assert.equal(D.diskFull(100 * 1024 * 1024), true, 'in memory: memory decides');
    assert.match(D.diskSummary(), /in memory/);
  } finally {
    D.setRealDiskSource(null);
    D.setDiskSource(null);
    M.setMemSource(null);
    if (sweep !== undefined) process.env.STUDIO_DISK_SWEEP = sweep;
  }
});

test("a change's stored worktree moves with the working folder (no worktree made again in memory)", async () => {
  const A = await import('../src/agents.ts');
  const { db } = await import('../src/db.ts');
  const work = path.join(process.env.STUDIO_PROJECTS!, '.work');
  const add = (id: string, wt: string) => db.prepare("INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created) VALUES (?, 'p', '[]', 'working', '', 'r', 'o/r', 'b', 'beta', ?, 't', '[]', '[]', 1)").run(id, wt);
  add('c_old', '/tmp/projects/.work/c_old');
  add('c_here', path.join(work, 'c_here'));
  add('c_scout', '/tmp/projects/.work/scout-1/sub');
  assert.equal(A.rebaseWorktrees(work), 2);
  const wt = (id: string) => (db.prepare('SELECT worktree FROM changes WHERE id = ?').get(id) as any).worktree;
  assert.equal(wt('c_old'), path.join(work, 'c_old'));
  assert.equal(wt('c_here'), path.join(work, 'c_here'));
  assert.equal(wt('c_scout'), path.join(work, 'scout-1', 'sub'));
  assert.equal(A.rebaseWorktrees(work), 0, 'once');
});

test('the entrypoint moves the working files onto /disk only when it is mounted', () => {
  const sh = fs.readFileSync(new URL('../server/studio-cloudrun/entrypoint.sh', import.meta.url), 'utf8');
  const i = sh.indexOf('mountpoint -q /disk');
  assert.ok(i > 0 && i < sh.indexOf('mkdir -p /data "$STUDIO_PROJECTS"'));
  assert.match(sh, /export STUDIO_PROJECTS=\/disk\/projects TMPDIR=\/disk\/tmp STUDIO_NPM_CACHE=\/disk\/npm-cache/);
});

// 2026-11-10 22:41: main went live, but J's Studio cell refused the new revision: "Quota exceeded for total allowable
// ephemeral disk allocation per project per region". Google takes the update and refuses the revision when it starts,
// so the PATCH fallback above never ran, the roll put the old image back, and every fix stayed off the cell.
test('a revision refused for its working disk rolls the same image out without the disk, never back to the old image', async () => {
  const g = fakeGoogle(false);
  g.svc.labels = { 'hawkes-studio-cell': '1', 'hawkes-org': 'acme', 'hawkes-lane': 'live' };
  const realGet = g.svc;
  // listCells reads the services list: the fake answers every GET with the service, so give it a list shape too.
  (realGet as any).services = [{ ...realGet, name: 'projects/p/locations/us-east4/services/studio-o-acme' }];
  const seen: boolean[] = [];
  const outcome = async () => {
    const hasDisk = (g.svc.template.volumes ?? []).some((v: any) => v.name === 'studio-work');
    seen.push(hasDisk);
    return hasDisk ? { ok: false, why: 'Revision studio-o-acme-00096 is not ready: Quota exceeded for total allowable ephemeral disk allocation per project per region.' } : { ok: true, why: null };
  };
  const lines: string[] = [];
  const r = await R.rollCells('v9', { health: async () => true, log: (s) => lines.push(s), outcome }, cfg);
  assert.equal(r.failed, null, lines.join('\n'));
  assert.deepEqual(r.done, ['studio-o-acme']);
  assert.equal(g.svc.template.containers[0].image, 'v9', 'the new image is what runs');
  assert.deepEqual(seen, [true, false], 'tried with the disk, then without it');
  assert.equal((g.svc.template.volumes ?? []).some((v: any) => v.name === 'studio-work'), false);
  assert.match(lines.join('\n'), /refused the new revision's working disk/);
});

test('a revision that fails for its image (not the disk) still goes back to the old image', async () => {
  const g = fakeGoogle(false);
  g.svc.labels = { 'hawkes-studio-cell': '1', 'hawkes-org': 'acme', 'hawkes-lane': 'live' };
  (g.svc as any).services = [{ ...g.svc, name: 'projects/p/locations/us-east4/services/studio-o-acme' }];
  const r = await R.rollCells('bad', { health: async () => true, log: () => {}, outcome: async () => ({ ok: false, why: 'Container failed to start and listen on the port' }) }, cfg);
  assert.equal(r.failed, 'studio-o-acme');
  assert.equal(g.svc.template.containers[0].image, 'old');
});

test('diskFailure tells a disk refusal from an image failure', () => {
  assert.equal(R.diskFailure('Quota exceeded for total allowable ephemeral disk allocation per project per region.'), true);
  assert.equal(R.diskFailure('Container failed to start and listen on the port defined by PORT'), false);
  assert.equal(R.diskFailure(null), false);
});
