// Studio starting a stopped GPU server for a change with an approved budget (gpustart.ts): which server, never a
// launch, the cap and US regions, one start per need, and a failed start said in Talk. Gen is faked: no AWS involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickGpuServer, ensureGpuFor, needsGpu, retryDelay, GIVE_UP_MINUTES, generatorRunning } = await import('../src/gpustart.ts');

const srv = (id: string, o: Record<string, any> = {}) => ({ id, region: 'us-east-1', state: 'stopped', launched: '2026-10-01T00:00:00Z', ...o });

test('picks a stopped US server, preferring a finished install, a kept disk, the cheapest region', () => {
  const pick = pickGpuServer([
    srv('i-eu', { region: 'eu-north-1' }),
    srv('i-half', { region: 'us-west-2', unfinished: { resumable: true } }),
    srv('i-east'),
    srv('i-west', { region: 'us-west-2' }),
    srv('i-disp', { region: 'us-west-2', disposable: true }),
    srv('i-play', { region: 'us-west-2', purpose: 'playtester' }),
  ]);
  assert.equal(pick.action, 'start');
  assert.equal(pick.action === 'start' && pick.server.id, 'i-west');
});

test('nothing to do when a generator is up; blocked at the cap, outside the US, or with nothing stopped', () => {
  assert.equal(pickGpuServer([srv('i-a', { state: 'pending' }), srv('i-b')]).action, 'none');
  // The playtester running doesn't count as a generator, but does count toward the cap.
  assert.equal(pickGpuServer([srv('i-p', { state: 'running', purpose: 'playtester' }), srv('i-b')]).action, 'start');
  const full = [1, 2, 3, 4].map((n) => srv(`i-p${n}`, { state: 'running', purpose: 'playtester' }));
  assert.match((pickGpuServer([...full, srv('i-b')]) as any).why, /cap is 4/);
  assert.equal(pickGpuServer([srv('i-p', { state: 'running', purpose: 'x' }), srv('i-b')], 1).action, 'blocked');
  assert.equal(pickGpuServer([srv('i-eu', { region: 'eu-central-1' })]).action, 'blocked');
  assert.equal(pickGpuServer([srv('i-old', { unfinished: { resumable: false } }), srv('i-img', { imageSource: 'ami-1' })]).action, 'blocked');
  assert.equal(pickGpuServer([]).action, 'blocked');
});

function fake(servers: any[], startFails?: string | ((id: string) => any)) {
  const calls = { starts: [] as string[], logs: [] as string[], told: [] as string[], waits: 0, waited: [] as number[] };
  return {
    calls,
    deps: {
      fleet: async () => ({ servers }),
      start: async (id: string) => {
        calls.starts.push(id);
        const fail = typeof startFails === 'function' ? startFails(id) : startFails && new Error(startFails);
        if (fail) throw fail;
        servers.find((s) => s.id === id).state = 'pending';
        return { id, region: 'us-east-1', was: 'stopped' };
      },
      log: (action: string, subject: string | null, _p: string | null, detail: string) => { calls.logs.push(`${action} ${subject}: ${detail}`); },
      tell: (_t: string, text: string) => { calls.told.push(text); },
      wait: async (ms: number) => { calls.waits++; calls.waited.push(ms); },
      stillNeeds: () => true,
    },
  };
}

test('starts one server for a budgeted change, once, and logs it in the PM log and Talk', async () => {
  const f = fake([srv('i-1'), srv('i-2')]);
  const a = { id: 'c_gpu1', product: 'dod', task: 'k_abc', gpu_budget: '2.50' };
  const b = { id: 'c_gpu2', product: 'dod', task: 'k_def', gpu_budget: '1' };
  const [ra, rb] = await Promise.all([ensureGpuFor(a, f.deps), ensureGpuFor(b, f.deps)]);
  assert.match(ra, /started GPU server i-\d \(us-east-1\) for k_abc/);
  assert.match(rb, /already pending/);
  assert.equal(f.calls.starts.length, 1, 'one start for two needs at once');
  assert.match(f.calls.logs[0], /^gpu-start k_abc: started GPU server/);
  assert.equal(f.calls.told.length, 1);
  // The same change again (a revision soon after) doesn't start another.
  assert.equal(await ensureGpuFor(a, f.deps), 'already handled for this change');
});

test('a failed start moves on to the next server; no budget starts nothing', async () => {
  const f = fake([srv('i-1'), srv('i-2', { region: 'us-east-2' })], (id) => id === 'i-1' ? new Error('i-1 is shutting-down; wait for it to finish') : null);
  const r = await ensureGpuFor({ id: 'c_gpu3', product: 'dod', task: 'k_x', gpu_budget: '3' }, f.deps);
  assert.deepEqual(f.calls.starts, ['i-1', 'i-2']);
  assert.match(r, /started GPU server i-2 \(us-east-2\)/);
  assert.match(f.calls.logs[0], /^gpu-start k_x: .*before it: i-1 .*shutting-down/);
  assert.equal(f.calls.told.length, 1);

  const g = fake([srv('i-1')]);
  assert.equal(needsGpu({ gpu_budget: '0' }), false);
  assert.equal(needsGpu({ gpu_budget: null }), false);
  assert.equal(await ensureGpuFor({ id: 'c_gpu4', product: 'dod', gpu_budget: null }, g.deps), 'no GPU budget');
  assert.equal(g.calls.starts.length, 0);
});

const noCapacity = (id: string) => Object.assign(new Error(`AWS has no g6e.xlarge free in us-east-1c right now (${id})`), { kind: 'capacity' });

test('2026-10-18: all three stopped, the first zone full: the next stopped server starts, with the budget in Talk', async () => {
  const servers = [srv('i-east'), srv('i-west', { region: 'us-west-2' }), srv('i-east2', { region: 'us-east-2' })];
  const f = fake(servers, (id) => id === 'i-west' ? noCapacity(id) : null);
  const r = await ensureGpuFor({ id: 'c_gpu5', product: 'sickofit', task: 'k_057303d75697', gpu_budget: '0.45' }, f.deps);
  assert.deepEqual(f.calls.starts, ['i-west', 'i-east']);
  assert.match(r, /started GPU server i-east \(us-east-1\) for k_057303d75697 \(c_gpu5\), GPU budget \$0\.45/);
  assert.equal(f.calls.told.length, 1);
  assert.match(f.calls.told[0], /^Studio started GPU server i-east .*c_gpu5.*\$0\.45/);
  assert.equal(servers.find((s) => s.id === 'i-east')!.state, 'pending');
});

test('no capacity anywhere: tries again with backoff (a PM-log line per round, Talk only at the end), never launches', async () => {
  let full = true;
  const f = fake([srv('i-1'), srv('i-2', { region: 'us-west-2' })], (id) => full ? noCapacity(id) : null);
  f.deps.wait = async (ms: number) => { f.calls.waits++; f.calls.waited.push(ms); if (f.calls.waits === 2) full = false; };
  const r = await ensureGpuFor({ id: 'c_gpu6', product: 'sickofit', task: 'k_58cc15a7f709', gpu_budget: '1.98' }, f.deps);
  assert.equal(f.calls.waits, 2);
  assert.deepEqual(f.calls.waited, [retryDelay(1) * 60_000, retryDelay(2) * 60_000]);
  assert.ok(retryDelay(2) > retryDelay(1), 'backoff');
  assert.match(r, /started GPU server i-2 .*\$1\.98/);
  assert.deepEqual(f.calls.starts, ['i-2', 'i-1', 'i-2', 'i-1', 'i-2']);
  assert.deepEqual(f.calls.logs.map((l) => l.split(' ')[0]), ['gpu-start-waiting', 'gpu-start-waiting', 'gpu-start']);
  assert.match(f.calls.logs[0], /round 1: .*i-2 .*i-1/);
  assert.equal(f.calls.told.length, 1, 'Talk hears the start only');
  assert.match(f.calls.told[0], /^Studio started GPU server i-2/);

  // The change finished meanwhile: no more tries.
  const g = fake([srv('i-1')], noCapacity);
  g.deps.stillNeeds = () => false;
  assert.match(await ensureGpuFor({ id: 'c_gpu7', product: 'dod', gpu_budget: '1' }, g.deps), /stopped trying/);
  assert.deepEqual(g.calls.starts, ['i-1']);

  // Never free: gives up after about 45 minutes of tries and says so once in Talk.
  const h = fake([srv('i-1')], noCapacity);
  assert.match(await ensureGpuFor({ id: 'c_gpu8', product: 'dod', gpu_budget: '1' }, h.deps), /gave up: .* rounds over \d+ minutes/);
  const minutes = h.calls.waited.reduce((a, b) => a + b, 0) / 60_000;
  assert.ok(minutes >= GIVE_UP_MINUTES && minutes < GIVE_UP_MINUTES + 10, `waited ${minutes} minutes`);
  assert.equal(h.calls.starts.length, h.calls.waits + 1);
  assert.equal(h.calls.logs.filter((l) => l.startsWith('gpu-start-waiting')).length, h.calls.waits, 'one PM-log line per round');
  assert.equal(h.calls.told.length, 1);
  assert.match(h.calls.told[0], /gave up.*Nothing was launched/);
});

test('2026-10-18 again: a full zone and a full quota send the next try to another zone or region', async () => {
  const servers = [
    srv('i-0504c22c8d49e2ad9', { zone: 'us-east-1c', launched: '2026-10-10T00:00:00Z' }),
    srv('i-east1c-b', { zone: 'us-east-1c', launched: '2026-10-09T00:00:00Z' }),
    srv('i-east1a', { zone: 'us-east-1a', launched: '2026-10-08T00:00:00Z' }),
    srv('i-045c7d231d6dadef6', { region: 'us-east-2', zone: 'us-east-2b' }),
  ];
  // us-east-1c is full: the other region next (its quota is full: its other servers wait), then another us-east-1 zone
  // before the second us-east-1c server.
  const f = fake(servers, (id) => id === 'i-0504c22c8d49e2ad9' ? noCapacity(id)
    : id === 'i-045c7d231d6dadef6' ? Object.assign(new Error('us-east-2 has no GPU quota free for another running server.'), { kind: 'quota' }) : null);
  const r = await ensureGpuFor({ id: 'c_gpu10', product: 'sickofit', task: 'k_d0f27799972d', gpu_budget: '1.10' }, f.deps);
  assert.deepEqual(f.calls.starts, ['i-0504c22c8d49e2ad9', 'i-045c7d231d6dadef6', 'i-east1a']);
  assert.match(r, /started GPU server i-east1a \(us-east-1\)/);
  assert.match(f.calls.logs[0], /no GPU quota free in us-east-2/);
  assert.equal(f.calls.waits, 0);

  // A full quota skips the region's other servers for that round.
  const g = fake([srv('i-q1'), srv('i-q2', { zone: 'us-east-1b' })], (id) => Object.assign(new Error('us-east-1 has no GPU quota free'), { kind: 'quota' }));
  g.deps.stillNeeds = () => false;
  await ensureGpuFor({ id: 'c_gpu11', product: 'dod', gpu_budget: '1' }, g.deps);
  assert.equal(g.calls.starts.length, 1);
});

test('a running generator counts as up for tasks waiting for GPU; a pending one or the playtester does not', () => {
  assert.equal(generatorRunning([srv('i-a', { state: 'running' })]), true);
  assert.equal(generatorRunning([srv('i-a', { state: 'pending' }), srv('i-p', { state: 'running', purpose: 'playtester' })]), false);
});

test('a fleet at its cap starts nothing', async () => {
  const f = fake([...[1, 2, 3, 4].map((n) => srv(`i-p${n}`, { state: 'running', purpose: 'playtester' })), srv('i-b')]);
  const r = await ensureGpuFor({ id: 'c_gpu9', product: 'dod', task: 'k_cap', gpu_budget: '2' }, f.deps);
  assert.match(r, /cap is 4/);
  assert.equal(f.calls.starts.length, 0);
  assert.match(f.calls.told[0], /nothing was launched/);
});

test('the real start is always called with the id and confirm (a start never becomes a launch)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/gpustart.ts', import.meta.url), 'utf8');
  assert.match(src, /fleetAction\('start', \{ id, confirm: true \}\)/);
});
