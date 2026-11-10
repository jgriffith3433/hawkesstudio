// Why a restart happened must be readable afterwards (crashlog.ts): a previous instance that never marked a clean stop is
// reported as killed, with its memory and what it was running; a clean one is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-crashlog-'));
const { verdictOn, memoryNow, whatIsRunning } = await import('../src/crashlog.ts');

test('a boot file without clean is a kill, with the memory and work it died with', () => {
  const v = verdictOn({ lastSeen: Date.now() - 5000, rssMb: 7900, heapMb: 400, uptimeS: 600, running: 'changes c_1,c_2; jobs followed 2' }, Date.now())!;
  assert.match(v, /WITHOUT a clean stop/);
  assert.match(v, /rss 7900 MB/);
  assert.match(v, /c_1,c_2/);
});

test('a clean stop and a first start say the right thing', () => {
  assert.match(verdictOn({ clean: true, reason: 'SIGTERM' })!, /stopped cleanly \(SIGTERM\)/);
  assert.equal(verdictOn(null), null);
});

test('memory and the running line are readable', async () => {
  assert.ok(memoryNow().rssMb > 0);
  assert.equal(typeof (await whatIsRunning()), 'string');
});

test('an unhandled rejection is logged and survived; the log file keeps it', async () => {
  const { installCrashLog } = await import('../src/crashlog.ts');
  installCrashLog();
  const orig = console.error; let said = '';
  console.error = (m: string) => { said += m; };
  // The test runner has its own rejection handler: call ours (the last one added) directly.
  const ours = process.listeners('unhandledRejection').at(-1) as (e: unknown) => void;
  ours(new Error('boom-test'));
  console.error = orig;
  assert.match(said, /unhandled rejection \(kept running\).*boom-test/s);
  assert.match(fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'restarts.jsonl'), 'utf8'), /unhandledRejection/);
});

test('the heartbeat says what the whole machine holds, and the verdict repeats it', async () => {
  const { systemNow } = await import('../src/crashlog.ts');
  const s = systemNow();
  assert.ok(s.limitMb! > 0 && s.freeMb! >= 0);
  if (process.platform === 'linux') assert.match(s.top ?? '', /\d/);
  assert.match(verdictOn({ lastSeen: Date.now() - 5000, rssMb: 300, system: 'free 120 of 4096 MB; biggest: git 2900 MB' })!, /machine: free 120 of 4096 MB; biggest: git 2900/);
});
