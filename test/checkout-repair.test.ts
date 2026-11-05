// Checkouts that repair themselves (J, 2026-11-05: "these checkout problems are so frequent it's making the agents almost
// unreliable"): healSource's ladder, addWorktree's retry on signal 9 and its half-made marker, the checkout limit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { healSource, repairedError, type Probe } from '../src/source-ready.ts';
import { addWorktree, beginMaking, discardIfHalfMade, isHalfMade, type GitRun } from '../src/worktree.ts';
import { isInfraText } from '../src/infra-failure.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-repair-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const real = async (cwd: string, args: string[]) => sh(cwd, args);
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
sh(repo, ['init', '-q', '-b', 'main']);
fs.mkdirSync(path.join(repo, 'Assets'));
fs.writeFileSync(path.join(repo, 'Assets', 'A.cs'), 'class A {}');
sh(repo, ['add', '.']);
sh(repo, ['commit', '-q', '-m', 'one']);
const nosleep = async () => {};

const bad: Probe = { ok: false, tracked: 1467, reason: 'source missing: 1467 tracked files, but Assets/Editor/BuildArena.cs are not on disk (a sparse checkout that never got the source)' };
const good: Probe = { ok: true, tracked: 1467, sample: 'Assets/A.cs' };

test('a worktree missing its files is repaired by checking them out again, and says what was done', async () => {
  const wt = path.join(tmp, 'wt-missing');
  assert.ok(sh(repo, ['worktree', 'add', '--detach', wt, 'main']).ok);
  fs.rmSync(path.join(wt, 'Assets'), { recursive: true });
  const logs: string[] = [];
  const r = await healSource(wt, real, {
    unity: false, light: false, log: (m) => logs.push(m), sleep: nosleep,
    probe: (d) => (fs.existsSync(path.join(d, 'Assets', 'A.cs')) ? good : bad),
  });
  assert.ok(r.probe.ok);
  assert.ok(fs.existsSync(path.join(wt, 'Assets', 'A.cs')));
  assert.equal(r.attempts.length, 1);
  assert.ok(logs.some((l) => /repairing: sparse-checkout reapply/.test(l)));
});

test('the ladder goes on to a fresh worktree when the checkout stays bad, with backoff between attempts', async () => {
  const waits: number[] = [];
  let rebuilt = 0;
  const r = await healSource(tmp, async () => ({ ok: true, out: '', err: '' }), {
    unity: true, light: false, sleep: async (ms) => { waits.push(ms); },
    rebuild: async () => { rebuilt++; },
    probe: () => (rebuilt ? good : bad),
  });
  assert.ok(r.probe.ok);
  assert.equal(rebuilt, 1);
  assert.equal(r.attempts.length, 3); // reapply, a full checkout, then fresh
  assert.deepEqual(waits, [5_000, 20_000, 60_000]);
});

test('a light Unity checkout is never fully checked out (it killed the job for memory): it goes straight to a fresh one', async () => {
  const seen: string[][] = [];
  const r = await healSource(tmp, async (_c, a) => { seen.push(a); return { ok: true, out: '', err: '' }; }, {
    unity: true, light: true, sleep: nosleep, rebuild: async () => {}, probe: () => bad, git: () => ({ ok: true, out: '', err: '' }),
  });
  assert.ok(!r.probe.ok);
  assert.ok(!seen.some((a) => a[0] === 'sparse-checkout' && a[1] === 'disable'));
  assert.match(r.attempts.join(' | '), /deleted and made again/);
});

test('still bad after every attempt: the error carries the exact finding and what was tried, as an infra failure', async () => {
  const r = await healSource(tmp, async () => ({ ok: true, out: '', err: '' }), { unity: false, light: false, sleep: nosleep, rebuild: async () => {}, probe: () => bad });
  assert.ok(!r.probe.ok);
  const msg = repairedError('the worktree x', r);
  assert.match(msg, /BuildArena\.cs/);
  assert.match(msg, /tried: sparse-checkout reapply.*then a full checkout.*then the worktree deleted/);
  assert.ok(isInfraText(msg));
});

test('a source that is fine is not touched', async () => {
  let calls = 0;
  const r = await healSource(tmp, async () => { calls++; return { ok: true, out: '', err: '' }; }, { unity: false, light: false, sleep: nosleep, probe: () => good });
  assert.ok(r.probe.ok);
  assert.equal(calls, 0);
  assert.deepEqual(r.attempts, []);
});

test('worktree add killed by signal 9 is retried, lowers the checkouts running at once, and succeeds', async () => {
  let n = 0;
  let lowered = 0;
  const killed: GitRun = (cwd, args) => (args[1] === 'add' && n++ < 2 ? { ok: false, out: '', err: 'error: git was killed by signal 9' } : sh(cwd, args));
  const wt = path.join(tmp, 'wt-killed');
  const waits: number[] = [];
  const r = await addWorktree(repo, wt, ['--detach', wt, 'main'], killed, { onKilled: () => lowered++, sleep: async (ms) => { waits.push(ms); } });
  assert.ok(r.ok, r.err);
  assert.equal(n, 3);
  assert.equal(lowered, 2);
  assert.deepEqual(waits, [5_000, 20_000]);
  assert.ok(!isHalfMade(repo, wt));
});

test('a try that left half a checkout behind does not leave it for the next', async () => {
  let n = 0;
  const wt = path.join(tmp, 'wt-half');
  const run: GitRun = (cwd, args) => {
    if (args[1] === 'add' && n++ === 0) { fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, 'half'), 'x'); return { ok: false, out: '', err: 'fatal: killed' }; }
    return sh(cwd, args);
  };
  const r = await addWorktree(repo, wt, ['--detach', wt, 'main'], run, { sleep: nosleep });
  assert.ok(r.ok, r.err);
  assert.ok(!fs.existsSync(path.join(wt, 'half')));
});

test('three failed tries give git\'s words and leave no marker or folder', async () => {
  const wt = path.join(tmp, 'wt-never');
  const r = await addWorktree(repo, wt, ['--detach', wt, 'nope'], real, { sleep: nosleep });
  assert.ok(!r.ok);
  assert.match(r.err, /worktree add wt-never failed/);
  assert.ok(!isHalfMade(repo, wt));
  assert.ok(!fs.existsSync(wt));
});

test('a worktree whose making was cut off (marker still there) is discarded, never reused', async () => {
  const wt = path.join(tmp, 'wt-cut');
  assert.ok(sh(repo, ['worktree', 'add', '--detach', wt, 'main']).ok);
  beginMaking(repo, wt); // the restart came before finishMaking
  assert.ok(isHalfMade(repo, wt));
  const logs: string[] = [];
  assert.equal(await discardIfHalfMade(repo, wt, real, (m) => logs.push(m)), true);
  assert.ok(!fs.existsSync(wt));
  assert.ok(!isHalfMade(repo, wt));
  assert.match(logs[0], /half-made worktree/);
  // One made without a marker (before this existed) is kept.
  const old = path.join(tmp, 'wt-old');
  assert.ok(sh(repo, ['worktree', 'add', '--detach', old, 'main']).ok);
  assert.equal(await discardIfHalfMade(repo, old, real), false);
  assert.ok(fs.existsSync(old));
});
