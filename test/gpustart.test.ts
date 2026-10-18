// Studio starting a stopped GPU server for a change with an approved budget (gpustart.ts): which server, never a
// launch, the cap and US regions, one start per need, and a failed start said in Talk. Gen is faked: no AWS involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickGpuServer, ensureGpuFor, needsGpu } = await import('../src/gpustart.ts');

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

function fake(servers: any[], startFails?: string) {
  const calls = { starts: [] as string[], logs: [] as string[], told: [] as string[] };
  return {
    calls,
    deps: {
      fleet: async () => ({ servers }),
      start: async (id: string) => {
        calls.starts.push(id);
        if (startFails) throw new Error(startFails);
        servers.find((s) => s.id === id).state = 'pending';
        return { id, region: 'us-east-1', was: 'stopped' };
      },
      log: (action: string, subject: string | null, _p: string | null, detail: string) => { calls.logs.push(`${action} ${subject}: ${detail}`); },
      tell: (_t: string, text: string) => { calls.told.push(text); },
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

test('a failed start is told in Talk and launches nothing; no budget starts nothing', async () => {
  const f = fake([srv('i-1')], 'AWS has no g6e.xlarge free in us-east-1a right now');
  const r = await ensureGpuFor({ id: 'c_gpu3', product: 'dod', task: 'k_x', gpu_budget: '3' }, f.deps);
  assert.match(r, /no g6e.xlarge free/);
  assert.deepEqual(f.calls.starts, ['i-1']);
  assert.match(f.calls.logs[0], /^gpu-start-failed k_x/);
  assert.match(f.calls.told[0], /nothing was launched/);

  const g = fake([srv('i-1')]);
  assert.equal(needsGpu({ gpu_budget: '0' }), false);
  assert.equal(needsGpu({ gpu_budget: null }), false);
  assert.equal(await ensureGpuFor({ id: 'c_gpu4', product: 'dod', gpu_budget: null }, g.deps), 'no GPU budget');
  assert.equal(g.calls.starts.length, 0);
});
