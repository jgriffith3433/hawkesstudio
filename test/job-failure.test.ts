// A Cloud Run agent job that dies before the agent starts (J, 2026-11-03: every Yooba Land change "made no commit" after
// ~2 minutes): its real failure (exit code, error, last output) now reaches the change's detail as Studio's failure, which is
// not a try and backs off. The job's checkout in a big repo is sparse, so the whole tree never lands in the job's memory disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-jobfail-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(process.env.STUDIO_DATA, 'detached'), { recursive: true });

const { jobFailureLine, jobSparsePatterns } = await import('../src/cloudjob.ts');
const { machineryFailure } = await import('../src/agents.ts');
const { infraFailed } = await import('../src/infra-failure.ts');
const { UNITY_SOURCE_PATTERNS } = await import('../src/source-ready.ts');

test('a job that ended without its result becomes a Studio failure naming exit code and last output', () => {
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'detached', 'u1.err'), '[job] workspace x at abc1234\ncheckout: Killed\n');
  const line = jobFailureLine('u1', { code: null, signal: null, error: 'the Cloud Run job ended without its result: Container called exit(137).' });
  assert.match(line, /exit code none/);
  assert.match(line, /exit\(137\)/);
  assert.match(line, /checkout: Killed/);
  const why = machineryFailure(line + '\n');
  assert.ok(why && /Cloud Run job failed/.test(why));
  assert.ok(infraFailed({ status: 'failed', detail: `${why} (the agent made no commit; not counted as a try)` }));
});

test('a job that printed nothing says so', () => {
  assert.match(jobFailureLine('none', { code: 1, signal: null, error: 'boom' }), /it printed nothing/);
});

test('the job checks out the source patterns of a Unity worktree', () => {
  const d = path.join(TMP, 'w');
  fs.mkdirSync(path.join(d, 'Assets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'Assets/a.cs'), 'x');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('add', '.');
  assert.deepEqual(jobSparsePatterns(d), UNITY_SOURCE_PATTERNS);
});
