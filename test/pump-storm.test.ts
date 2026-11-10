// The queue pump never piles up (agents.ts pump, pumpAt). On 2026-11-10 about 200 changes parked by a provider's usage
// limit each set their own pump timer on every pass; the timers came due together and ran thousands of passes back to
// back, each reading every queued change and every provider's hold. The event loop was blocked for 224 s, Cloud Run
// answered 429 to claude.ai's token refreshes, and Studio's connector was signed out. Now calls coalesce into one pass
// (plus one after it), a resume wait keeps a single timer, and a pass looks at the providers once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pump-storm-'));
const A = await import('../src/agents.ts');

test('a burst of pump calls runs one pass and at most one more, never one per call', async () => {
  await A.pumpNow();
  const before = A.pumpPasses;
  const calls = Array.from({ length: 500 }, () => A.pumpNow());
  await Promise.all(calls);
  const ran = A.pumpPasses - before;
  assert.ok(ran >= 1 && ran <= 2, `500 calls ran ${ran} passes`);
});

test('resume waits keep one timer, for the earliest wake', () => {
  const now = Date.now();
  for (let i = 0; i < 300; i++) A.pumpAt(now + 60_000 + i * 1000);
  assert.equal(A.pumpWakeAt(), now + 60_000);
  A.pumpAt(now + 30_000);
  assert.equal(A.pumpWakeAt(), now + 30_000, 'an earlier wake replaces it');
  A.pumpAt(now + 90_000);
  assert.equal(A.pumpWakeAt(), now + 30_000, 'a later one waits for the pass that the earlier wake runs');
});

test('a pass looks at the providers once, and no parked change sets a timer of its own', () => {
  const src = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const resume = src.slice(src.indexOf('function resumeAllowed('), src.indexOf('/** Runs queued changes'));
  assert.doesNotMatch(resume, /setTimeout\(/, 'resumeAllowed sets no timer of its own');
  assert.doesNotMatch(resume, /pickHarness\(/, 'resumeAllowed asks the pass for the free provider');
  const pass = src.slice(src.indexOf('async function pumpPass()'), src.indexOf('/** Pushes a change'));
  assert.match(pass, /resumeAllowed\(c, freeOnce\)/);
  assert.match(pass, /overlapWith\(shape\(c\), beside\.map\(shape\)/, 'shapes (git and task reads) once per pass');
});
