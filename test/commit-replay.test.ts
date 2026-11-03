// An agent's commit on a big (light-cloned) repo reaches Studio (J, 2026-11-03: ~12 Unity changes ended "the agent made no
// commit" even when the agent said it committed). The job's bundle is a thin pack against blobs Studio's light clone does
// not have ("pack has 1 unresolved delta"), so the commits also travel as plain files (cloudjob-run.ts replayOf) and
// applyWorkspace makes the commit from them. LFS pointer files a no-LFS clone lists as modified are never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-replay-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });

const { applyWorkspace, readPack } = await import('../src/cloudjob.ts');
const { collect, commitLeftovers, replayOf } = await import('../src/cloudjob-run.ts');
const { machineryFailure, earlierAttempts, studioFailed, attemptOf } = await import('../src/agents.ts');
const { infraFailed } = await import('../src/infra-failure.ts');

const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.com', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim();
const lines = (tag: string, n = 300) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n') + '\n';

/** An origin with a Unity-like tree, and two blobless clones of it: the job's (full checkout) and Studio's (root files only, no remote). */
let n = 0;
function setup() {
  const base = path.join(TMP, `s${++n}`);
  fs.mkdirSync(base);
  const origin = path.join(base, 'origin');
  fs.mkdirSync(path.join(origin, 'Assets/S'), { recursive: true });
  sh(origin, 'init', '-q');
  sh(origin, 'config', 'uploadpack.allowFilter', 'true');
  sh(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(origin, `Assets/S/${f}.cs`), lines(f));
  fs.writeFileSync(path.join(origin, 'README.md'), 'hi\n');
  sh(origin, 'add', '.'); sh(origin, 'commit', '-qm', 'base');
  const studio = path.join(base, 'studio');
  const job = path.join(base, 'job');
  sh(base, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, studio);
  sh(studio, 'sparse-checkout', 'set', '--no-cone', '/*', '!/*/');
  sh(studio, 'checkout', '-q', 'main');
  sh(base, 'clone', '-q', '--filter=blob:none', `file://${origin}`, job);
  // Studio has no credentials for a lazy fetch (the sandbox / the service's plain git): the promisor remote is unreachable.
  sh(studio, 'remote', 'set-url', 'origin', 'file:///nonexistent/unreachable.git');
  sh(job, 'remote', 'set-url', 'origin', 'file:///nonexistent/unreachable.git');
  return { studio, job };
}

test('the job\'s commit reaches a light Studio worktree even when its bundle cannot be applied there', () => {
  const { studio, job } = setup();
  const start = sh(job, 'rev-parse', 'HEAD');
  // The agent edits a file Studio never checked out, adds one and deletes one, and commits.
  fs.appendFileSync(path.join(job, 'Assets/S/a.cs'), 'a changed line\n');
  fs.writeFileSync(path.join(job, 'Assets/S/new.cs'), lines('new', 50));
  fs.rmSync(path.join(job, 'Assets/S/c.cs'));
  sh(job, 'add', '-A'); sh(job, 'commit', '-qm', 'Fix the intro video');
  fs.mkdirSync(path.join(job, '.hawkes'), { recursive: true });
  fs.writeFileSync(path.join(job, '.hawkes/summary.md'), 'done');

  const out = collect({ cwd: job, sessions: path.join(TMP, 'sessions'), git: { head: start, branch: 'main', remote: '', bundle: false, token: null } } as any, start, fs.mkdtempSync(path.join(TMP, 't-')));
  assert.ok(out.bundle && out.replay, 'the commits travel as a bundle and as files');
  const pack = readPack(out.pack);
  assert.deepEqual(pack.commit?.deleted, ['Assets/S/c.cs']);
  assert.ok(pack.commit?.files.some((f) => f.p === 'Assets/S/a.cs'));

  // The old way, alone: git cannot index the thin pack here.
  const bare = readPack(out.pack); delete bare.commit;
  const probe = path.join(TMP, 'studio-old');
  fs.cpSync(studio, probe, { recursive: true });
  assert.throws(() => applyWorkspace(probe, { head: out.git!.head, bundle: out.bundle, pack: bare }), /couldn't read the job's commits/);

  fs.appendFileSync(path.join(studio, '.git/info/exclude'), '\n.hawkes/\n'); // as in Studio's worktrees
  // With the files: a commit on top of Studio's HEAD, with the agent's message, the edits, and the notes.
  applyWorkspace(studio, { head: out.git!.head, bundle: out.bundle, pack });
  assert.equal(sh(studio, 'rev-list', '--count', `${start}..HEAD`), '1');
  assert.match(sh(studio, 'log', '-1', '--format=%B'), /Fix the intro video/);
  assert.equal(sh(studio, 'diff', '--name-status', start, 'HEAD').split('\n').sort().join(','), 'A\tAssets/S/new.cs,D\tAssets/S/c.cs,M\tAssets/S/a.cs');
  assert.equal(sh(studio, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(studio, '.hawkes/summary.md'), 'utf8'), 'done');
});

test('a bundle that cannot be made no longer fails the pass when the files can travel', () => {
  const { job } = setup();
  const start = sh(job, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(job, 'Assets/S/b.cs'), 'x\n');
  sh(job, 'commit', '-qam', 'edit b');
  const out = collect({ cwd: job, sessions: path.join(TMP, 'sessions'), git: { head: start, branch: 'main', remote: '', bundle: false, token: null } } as any, start, fs.mkdtempSync(path.join(TMP, 't-')));
  assert.ok(out.replay);
  assert.equal(replayOf(job, '1'.repeat(40), sh(job, 'rev-parse', 'HEAD')), null, 'an unknown start sends nothing');
});

test('LFS pointer files are not the agent\'s edits: never committed, never sent as loose files', () => {
  const dir = path.join(TMP, 'lfs');
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  sh(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'old\n');
  fs.writeFileSync(path.join(dir, 'Assets/art.png'), 'real bytes\n');
  sh(dir, 'add', '.'); sh(dir, 'commit', '-qm', 'base');
  const start = sh(dir, 'rev-parse', 'HEAD');
  // A no-LFS clone shows the art as pointer text that git lists as modified.
  fs.writeFileSync(path.join(dir, 'Assets/art.png'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 11\n');
  assert.equal(commitLeftovers(dir, () => {}), false, 'only pointer noise: nothing to commit');
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), start);
  fs.writeFileSync(path.join(dir, 'Assets/V.cs'), 'fixed\n');
  assert.equal(commitLeftovers(dir, () => {}), true);
  assert.equal(sh(dir, 'show', '--name-only', '--format=', 'HEAD'), 'Assets/V.cs');
  const out = collect({ cwd: dir, sessions: path.join(TMP, 'sessions'), git: { head: start, branch: 'main', remote: '', bundle: false, token: null } } as any, start, fs.mkdtempSync(path.join(TMP, 't-')));
  assert.ok(!readPack(out.pack).files.some((f) => f.p === 'Assets/art.png'));
});

test('a "no commit" with a failing job step is Studio\'s failure, not a try', () => {
  assert.equal(machineryFailure('[job] workspace x at abc1234 (main, partial clone)\n[job] source check: 120 tracked files, read Assets/A.cs'), null);
  assert.equal(machineryFailure('[job] jgriffith3433/YoobaLand not copied: fatal'), null);
  const why = machineryFailure("[studio] bringing the job's work back: couldn't read the job's commits: pack has 1 unresolved delta");
  assert.match(why ?? '', /^Studio's studio step: bringing the job's work back/);
  const detail = `${why} (the agent made no commit; not counted as a try)`;
  assert.equal(infraFailed({ status: 'failed', detail, phase: null }), true);
  assert.equal(infraFailed({ status: 'failed', detail: 'the agent made no commit', phase: null }), false);
});

test('attempts Studio failed to run do not climb the model route', async () => {
  const { db } = await import('../src/db.ts');
  const ins = (id: string, detail: string, phase: string | null, created: number) => db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, phase) VALUES (?, 'yoobaland', '["f_x1"]', 'failed', ?, 'r', 's', 'b', 'beta', '/w', 't', '[]', '[]', ?, ?)`).run(id, detail, created, phase);
  ins('c_old1', 'the agent made no commit', null, 1);
  ins('c_old2', "Studio's job step: x (the agent made no commit; not counted as a try)", '{"step":"publish","failed":true}', 2);
  ins('c_old3', "Studio's job step: y (the agent made no commit; not counted as a try)", '{"step":"publish","failed":true}', 3);
  const prior = earlierAttempts({ id: 'c_new', task: null, findings: ['f_x1'] }, 10);
  assert.equal(prior.length, 3);
  assert.equal(prior.filter((x) => !studioFailed(x)).length, 1);
  void attemptOf;
});
