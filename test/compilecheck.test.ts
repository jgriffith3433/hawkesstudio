import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-compile-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
const { compileParams, compileResultOf, parseCompilerLog, compileFixPrompt, compileCheckOn } = await import('../src/compilecheck.ts');

const LOG = `Assets/Scripts/Player.cs(42,17): error CS1503: Argument 1: cannot convert from 'string' to 'int'
Assets/Scripts/Player.cs(42,17): error CS1503: Argument 1: cannot convert from 'string' to 'int'
Assets/Scripts/Ok.cs(3,1): warning CS0168: unused`;

test('the log parser finds each compiler error once, with file and line', () => {
  const i = parseCompilerLog(LOG);
  assert.equal(i.length, 1);
  assert.deepEqual([i[0].file, i[0].line, i[0].col, i[0].code], ['Assets/Scripts/Player.cs', 42, 17, 'CS1503']);
});

test('a CS1503 from Gen fails the check with the error shown, and the agent is told where', () => {
  const r = compileResultOf({ id: 'j_1', status: 'failed', error: 'compile', result: { ok: false, seconds: 240, cost: 0.12, unity: '6000.3.7f1', errors: [{ file: 'Assets/A.cs', line: 9, col: 4, code: 'CS1503', message: 'cannot convert' }] } }, 'a'.repeat(40));
  assert.equal(r.outcome, 'failed');
  assert.equal(r.ok, false);
  assert.match(r.summary, /FAILED.*4\.0 min.*\$0\.12.*Assets\/A\.cs:9 CS1503/);
  assert.match(compileFixPrompt(r), /Assets\/A\.cs:9:4 error CS1503/);
});

test('errors only in the log tail are parsed too', () => {
  const r = compileResultOf({ status: 'failed', result: { ok: false, logTail: LOG } }, 'b'.repeat(40));
  assert.equal(r.outcome, 'failed');
  assert.equal(r.issues[0].line, 42);
});

test('a compiling branch passes and reports time and cost', () => {
  const r = compileResultOf({ status: 'done', result: { ok: true, seconds: 180, cost: 0.2, unity: '6000.3.7f1', machine: { name: 'm' } } }, 'c'.repeat(40));
  assert.equal(r.outcome, 'compiled');
  assert.equal(r.ok, true);
  assert.match(r.summary, /passed.*3\.0 min.*\$0\.20/);
});

test('a job that failed for another reason is unavailable, never a block', () => {
  const r = compileResultOf({ status: 'failed', error: 'the GitHub token is gone' }, 'd'.repeat(40));
  assert.equal(r.outcome, 'unavailable');
  assert.equal(r.ok, true);
});

test('params are the customer shape plus check, nothing under github but repo, commit, token, ref', () => {
  const p: any = compileParams({ slug: 'o/r', sha: 'e'.repeat(40), ref: 'refs/heads/x', token: 't' });
  assert.equal(p.check, true);
  assert.deepEqual(Object.keys(p.github).sort(), ['commit', 'ref', 'repo', 'token']);
});

test('a setting, on by default, read at run time; the env var is only an operator override', async () => {
  const { buildsSettings, saveBuildsSettings } = await import('../src/compilecheck.ts');
  const was = process.env.STUDIO_UNITY_COMPILE;
  delete process.env.STUDIO_UNITY_COMPILE;
  assert.deepEqual(buildsSettings(), { unityCompile: true, unityCompileMaxCost: 3, handleFailures: true });
  assert.equal(compileCheckOn(), true);
  saveBuildsSettings({ unityCompile: false });
  assert.equal(compileCheckOn(), false);
  process.env.STUDIO_UNITY_COMPILE = 'on';
  assert.equal(compileCheckOn(), true);
  saveBuildsSettings({ unityCompile: true });
  process.env.STUDIO_UNITY_COMPILE = 'off';
  assert.equal(compileCheckOn(), false);
  if (was === undefined) delete process.env.STUDIO_UNITY_COMPILE; else process.env.STUDIO_UNITY_COMPILE = was;
  assert.throws(() => saveBuildsSettings({ unityCompileMaxCost: 0 }), /0\.10 to 100/);
  assert.throws(() => saveBuildsSettings({ nope: 1 }), /not a setting/);
});

test('the gate degrades: no compile mode in Gen skips with a note, a cost over the limit skips', async () => {
  const { compileGate, saveBuildsSettings, forgetGenCompileMode, recordCompile } = await import('../src/compilecheck.ts');
  delete process.env.STUDIO_UNITY_COMPILE;
  saveBuildsSettings({ unityCompile: true, unityCompileMaxCost: 3 });
  forgetGenCompileMode();
  const { gen } = await import('../src/gen.ts');
  const tool = (gen as any).tool;
  (gen as any).tool = async () => ({ params: { project: {}, target: {} } });
  let g = await compileGate();
  assert.equal(g.run, false);
  assert.match(g.why ?? '', /no compile-only `check` mode yet/);
  forgetGenCompileMode();
  (gen as any).tool = async () => { throw new Error('down'); };
  g = await compileGate();
  assert.equal(g.run, false);
  assert.match(g.why ?? '', /couldn't be asked/, 'a Gen that cannot be reached is named, not "not live yet"');
  forgetGenCompileMode();
  (gen as any).tool = async () => { throw Object.assign(new Error('Tool unity.build is internal-only and not available for user accounts'), { status: 403 }); };
  assert.equal((await compileGate()).run, true, 'a customer key cannot read the tool card but may submit a check: the gate runs');
  forgetGenCompileMode();
  (gen as any).tool = async () => ({ params: { check: { type: 'boolean' } } });
  assert.equal((await compileGate()).run, true);
  recordCompile('c_x', 'p', { outcome: 'compiled', ok: true, sha: 'a', issues: [], seconds: 100, cost: 5, summary: '' });
  g = await compileGate();
  assert.equal(g.run, false);
  assert.match(g.why ?? '', /averages \$5\.00.*\$3\.00/);
  saveBuildsSettings({ unityCompileMaxCost: 10 });
  assert.equal((await compileGate()).run, true);
  saveBuildsSettings({ unityCompile: false });
  g = await compileGate();
  assert.equal(g.run, false);
  assert.match(g.why ?? '', /switched off \(Settings → Builds\)/, 'off is said too, not silent');
  (gen as any).tool = tool;
});

test('a skipped gate is said on the change: the ready line carries why nothing compiled the branch', async () => {
  const { skippedCompile } = await import('../src/compilecheck.ts');
  const { readyDetail } = await import('../src/agents.ts');
  const s = skippedCompile("Compile check skipped: Hawkes Gen's unity.build has no compile-only `check` mode yet, so the change goes on to beta's own build", 'abc1234');
  assert.equal(s.outcome, 'skipped');
  assert.equal(s.ok, true, 'a skipped gate never blocks');
  assert.match(readyDetail({ compileCheck: s }), /Compile check skipped: .* no compile-only `check` mode yet/);
});

const NOTHING = 'the build wrote nothing to HAWKES_OUT: a build method of your own must build into the folder in env HAWKES_OUT: Exiting batchmode successfully now!';

test('j_65b4f615ffa7: Unity exited cleanly, nothing in HAWKES_OUT, no CS errors = compile passed', () => {
  const r = compileResultOf({ id: 'j_65b4f615ffa7', status: 'failed', error: NOTHING, result: { ok: false, seconds: 302, cost: 0.058 } }, 'e'.repeat(40));
  assert.equal(r.outcome, 'compiled');
  assert.equal(r.ok, true);
  assert.match(r.summary, /passed.*\$0\.06/);
});

test('an error CS line beside the empty HAWKES_OUT still fails, first error file:line in the summary', () => {
  const r = compileResultOf({ status: 'failed', error: NOTHING, result: { ok: false, logTail: LOG + '\nExiting batchmode successfully now!' } }, 'f'.repeat(40));
  assert.equal(r.outcome, 'failed');
  assert.equal(r.ok, false);
  assert.match(r.summary, /Assets\/Scripts\/Player\.cs:42 CS1503/);
});

test('"Scripts have compiler errors" without a parsable line still fails', () => {
  const r = compileResultOf({ status: 'failed', error: 'Scripts have compiler errors.' }, '1'.repeat(40));
  assert.equal(r.outcome, 'failed');
});

test('infra failures stay unavailable: 5xx, timeout, refusal, nothing-written without a clean exit', () => {
  for (const error of ['Hawkes Gen 503 Service Unavailable', 'timed out after 1800 s', 'refused: plan does not include cloud builds', 'the build wrote nothing to HAWKES_OUT: Unity crashed']) {
    const r = compileResultOf({ status: 'failed', error }, '2'.repeat(40));
    assert.equal(r.outcome, 'unavailable', error);
    assert.equal(r.ok, true);
  }
});
