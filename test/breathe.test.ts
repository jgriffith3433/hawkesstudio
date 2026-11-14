// A pass over many items lets Studio answer in between (2026-11-14: the PM's pass over ~200 tasks ran as one
// synchronous stretch, 1-5 s at a time, because `await` on work with no real I/O never lets a request or a timer in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { forEachBreathing, BREATH_MS } from '../src/breathe.ts';

const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* work */ } };

test('a timer due during the loop runs long before the loop ends, and no stretch of work runs much past BREATH_MS', async () => {
  let longest = 0, last = Date.now(), firedAt = 0, done = 0;
  const gap = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 1);
  setTimeout(() => { firedAt = Date.now(); }, 0);
  const start = Date.now();
  await forEachBreathing(Array.from({ length: 40 }, (_, i) => i), async () => { busy(5); done++; });
  clearInterval(gap);
  assert.equal(done, 40, 'every item ran, in one pass');
  assert.ok(firedAt > 0 && firedAt - start < 60, `the timer ran ${firedAt - start} ms in, not after the 200 ms of work`);
  assert.ok(longest < BREATH_MS + 30, `the longest stretch without a turn for timers was ${longest} ms`);
});

test("the PM's pass over every task and a milestone's task sync go through forEachBreathing", () => {
  const src = fs.readFileSync(new URL('../src/pm.ts', import.meta.url), 'utf8');
  const sync = src.slice(src.indexOf('export async function syncTasks()'), src.indexOf('await followBuilds()'));
  assert.match(sync, /await forEachBreathing\(ids,/);
  assert.doesNotMatch(sync, /for \(const t of .*\) \{\s*\/\/ One task/);
  assert.match(src, /await forEachBreathing\(tasks, \(t\) => syncTask\(/);
});
