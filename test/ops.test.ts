// Background operations (ops.ts): the queue (one per product, two in all, accepted at once), resuming after a restart,
// git that doesn't block (beta.ts gitAsync, listed while it runs), and the event-loop monitor catching a block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ops-'));
const ops = await import('../src/ops.ts');
const { db } = await import('../src/db.ts');
const { gitAsync } = await import('../src/beta.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

test('the queue: a burst is accepted at once; one per product, two in all; each gets its result', async () => {
  let running = 0;
  let most = 0;
  const perProduct = new Map<string, number>();
  ops.registerOp('test-live', async (p: { product: string; n: number }, ctx) => {
    running++;
    most = Math.max(most, running);
    perProduct.set(p.product, (perProduct.get(p.product) ?? 0) + 1);
    assert.ok(perProduct.get(p.product)! <= 1, `two at once for ${p.product}`);
    ctx.step(`working on ${p.n}`);
    await sleep(150);
    perProduct.set(p.product, perProduct.get(p.product)! - 1);
    running--;
    return { n: p.n };
  });
  const t0 = Date.now();
  const queued = ['a', 'a', 'b', 'c', 'c'].map((product, n) => ops.enqueue('test-live', { product, title: `test ${product} ${n}`, payload: { product, n } }));
  assert.ok(Date.now() - t0 < 200, 'accepting five took too long');
  await until(() => queued.every((q) => ops.getOp(q.id)!.status === 'done'));
  assert.ok(most <= 2, `ran ${most} at once`);
  assert.deepEqual(queued.map((q) => ops.getOp(q.id)!.result.n), [0, 1, 2, 3, 4]);
  assert.match(ops.getOp(queued[0].id)!.log.join('\n'), /working on 0/);
  // The same request again while one is queued or running is the same operation, not a second go.
  const x = ops.enqueue('test-live', { product: 'd', title: 'x', payload: { product: 'd', n: 9 } });
  assert.equal(ops.enqueue('test-live', { product: 'd', title: 'x', payload: { product: 'd', n: 9 } }).id, x.id);
  await until(() => ops.getOp(x.id)!.status === 'done');
});

test('a failure is recorded with its reason; a restart puts a running one back, and gives up after 3 attempts', async () => {
  ops.registerOp('test-fail', async () => { throw new Error('the push was refused'); });
  const f = ops.enqueue('test-fail', { product: 'e', title: 'failing', payload: {} });
  await until(() => ops.getOp(f.id)!.status === 'failed');
  assert.match(ops.getOp(f.id)!.error!, /push was refused/);

  // As if Studio restarted mid-run: attempt 1 goes back in the queue and finishes; attempt 3 is given up.
  const now = Date.now();
  db.prepare(`INSERT INTO ops (id, kind, product, title, status, payload, created, started, attempts, log) VALUES ('op_resume00001', 'test-live', 'f', 'resumed', 'running', '{"product":"f","n":7}', ?, ?, 1, '[]')`).run(now, now);
  db.prepare(`INSERT INTO ops (id, kind, product, title, status, payload, created, started, attempts, log) VALUES ('op_resume00002', 'test-live', 'g', 'too many', 'running', '{"product":"g","n":8}', ?, ?, 3, '[]')`).run(now, now);
  assert.equal(ops.resumeOps(), 2);
  assert.equal(ops.getOp('op_resume00002')!.status, 'failed');
  await until(() => ops.getOp('op_resume00001')!.status === 'done');
  assert.equal(ops.getOp('op_resume00001')!.attempts, 2);
});

test('gitAsync: listed while it runs, Studio keeps ticking, and the answer is right', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ops-git-'));
  spawnSync('git', ['init', '-q', dir]);
  // No timing (a fast machine, CI, can finish `git status` before a 1 ms timer fires): what shows it doesn't block is
  // that the call returns with git still running, listed and not answered yet (a synchronous git would be done).
  let answered = false;
  const p = gitAsync(dir, ['status', '--porcelain']).then((r) => { answered = true; return r; });
  assert.ok(ops.runningCommands().some((c) => /git status/.test(c.cmd)), 'not listed while running');
  assert.equal(answered, false, 'it answered before returning: it blocked');
  const r = await p;
  assert.equal(r.ok, true);
  assert.ok(!ops.runningCommands().some((c) => /git status/.test(c.cmd)), 'still listed after it ended');
  const bad = await gitAsync(dir, ['rev-parse', '--verify', 'no-such-ref']);
  assert.equal(bad.ok, false);
});

test('the event-loop monitor records a block over a second, with what was running', async () => {
  ops.startLoopMonitor();
  await sleep(600);
  const end = Date.now() + 1600;
  while (Date.now() < end) { /* hold the event loop, as a synchronous push once did */ }
  await sleep(700);
  const h = ops.loopHealth();
  assert.ok(h.blocks.length >= 1, 'no block recorded');
  assert.ok(h.blocks[0].ms >= 1000);
});

/** A named function that holds the event loop, so the profile has something of ours to find. */
function holdTheLoop(ms: number) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}

test('a block names the code it was in (the rolling CPU profile), and its profile is kept on disk, capped', async () => {
  const { PROFILE_DIR } = await import('../src/loopprof.ts');
  ops.startLoopMonitor();
  // An old profile beyond the cap goes when a new one is kept.
  fs.mkdirSync(PROFILE_DIR(), { recursive: true });
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(PROFILE_DIR(), `block-2000-01-01T00-00-${String(i).padStart(2, '0')}-000Z-1000ms.cpuprofile`), '{}');
  await sleep(600);
  const t0 = Date.now();
  holdTheLoop(1500);
  const mine = () => ops.loopHealth().blocks.find((x: any) => x.at > t0 && x.where) as any;
  await until(() => Boolean(mine()), 5000);
  const b = mine();
  assert.match(b.where, /holdTheLoop \(test\/ops\.test\.ts:\d+\)/, b.where);
  assert.ok(b.cause.samples > 50, `samples: ${b.cause.samples}`);
  assert.ok(b.cause.profile, 'its profile was kept');
  const kept = fs.readdirSync(PROFILE_DIR());
  assert.ok(kept.includes(b.cause.profile));
  assert.ok(kept.length <= 20, `${kept.length} profiles kept`);
  assert.equal(kept.includes('block-2000-01-01T00-00-00-000Z-1000ms.cpuprofile'), false, 'the oldest went');
  const profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR(), b.cause.profile), 'utf8'));
  assert.ok(Array.isArray(profile.nodes) && profile.samples.length > 0, 'a real .cpuprofile');
});

test("a profile's tail: self time and the deepest Studio frame, idle left out", async () => {
  const { analyze, describe } = await import('../src/loopprof.ts');
  const { ROOT } = await import('../src/config.ts');
  const frame = (functionName: string, url: string, lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0 });
  const profile = {
    nodes: [
      { id: 1, callFrame: frame('(root)', ''), children: [2, 5] },
      { id: 2, callFrame: frame('work', `file://${ROOT}/src/agents.ts`, 1136), children: [3] },
      { id: 3, callFrame: frame('warmDeps', `file://${ROOT}/src/warm.ts`, 179), children: [4] },
      { id: 4, callFrame: frame('spawnSync', 'node:child_process', 800) },
      { id: 5, callFrame: frame('(idle)', '') },
    ],
    // 10 ms apart: 100 idle samples long ago, then 200 in spawnSync (the block), then 5 idle.
    startTime: 0, endTime: 3_050_000,
    samples: [...Array(100).fill(5), ...Array(200).fill(4), ...Array(5).fill(5)],
    timeDeltas: Array(305).fill(10_000),
  };
  const c = analyze(profile, 2000, { slackMs: 100 });
  assert.equal(c.samples, 200);
  assert.deepEqual(c.top[0], { fn: 'spawnSync', file: 'node:child_process', line: 801, ms: 2000 });
  assert.deepEqual(c.studio[0], { fn: 'warmDeps', file: 'src/warm.ts', line: 180, ms: 2000 });
  assert.match(describe(c), /^in warmDeps \(src\/warm\.ts:180\) 2000 ms; top: spawnSync \(node:child_process:801\)/);
});
