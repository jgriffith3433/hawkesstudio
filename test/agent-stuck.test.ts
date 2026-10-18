// The agents' watchdog (agents.ts stuckWhy): an agent quiet for the idle time whose processes only sleep is stuck; one
// that is working (CPU, a running process) or waiting on a Gen job is never ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stuck-'));
const { stuckWhy, agentSettings } = await import('../src/agents.ts');

const min = 60_000;
const sleeping = [{ state: 'S', comm: 'claude' }, { state: 'S', comm: 'bash' }, { state: 'S', comm: 'sleep' }];
const base = { quietMs: 21 * min, idleMs: 20 * min, cpuMs: 2_000, overMs: 20 * min, procs: sleeping, genBusy: false };

test('quiet for the idle time with only sleeping processes: stuck, with what it left running', () => {
  assert.equal(stuckWhy(base), 'no new output for 21 minutes and its processes only waiting (bash, sleep)');
});

test('never stuck while it works, waits on a GPU job, or before the idle time', () => {
  assert.equal(stuckWhy({ ...base, quietMs: 19 * min }), null, 'not quiet long enough');
  assert.equal(stuckWhy({ ...base, overMs: 5 * min }), null, 'not watched long enough');
  assert.equal(stuckWhy({ ...base, cpuMs: 60_000 }), null, 'an encoder using CPU');
  assert.equal(stuckWhy({ ...base, procs: [...sleeping, { state: 'R', comm: 'ffmpeg' }] }), null, 'a process running');
  assert.equal(stuckWhy({ ...base, procs: [...sleeping, { state: 'D', comm: 'git' }] }), null, 'a process waiting on disk');
  assert.equal(stuckWhy({ ...base, genBusy: true }), null, 'a Gen job queued or running');
  assert.equal(stuckWhy({ ...base, idleMs: 0 }), null, 'the watchdog off');
});

test('the idle time is a setting, 20 minutes by default', () => {
  assert.equal(agentSettings().idleMinutes, 20);
});
