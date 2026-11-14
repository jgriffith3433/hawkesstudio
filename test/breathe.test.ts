// A pass over many items lets Studio answer in between (2026-11-14: the PM's pass over ~200 tasks ran as one
// synchronous stretch, 1-5 s at a time, because `await` on work with no real I/O never lets a request or a timer in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { breather, forEachBreathing, BREATH_MS } from '../src/breathe.ts';

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

test('breather lets a timer in once BREATH_MS of work has gone by, and costs no turn before that', async () => {
  const breath = breather();
  let fired = false;
  setImmediate(() => { fired = true; });
  await breath();
  assert.equal(fired, false, 'no work yet: it handed nothing back');
  busy(BREATH_MS + 5);
  await breath();
  assert.equal(fired, true, 'after BREATH_MS of work, queued callbacks ran');
});

test("the PM's tick, its build follow-up and its starts let Studio answer between their steps", () => {
  const src = fs.readFileSync(new URL('../src/pm.ts', import.meta.url), 'utf8');
  const fn = (name: string) => { const i = src.indexOf(name); return src.slice(i, src.indexOf('\n}\n', i)); };
  const tick = fn('export async function tick()');
  assert.ok((tick.match(/await breath\(\);/g) ?? []).length >= 8, 'every phase of the tick is followed by a breath');
  assert.match(tick, /await breath\(\);\n\s+const startedNow = await startWork\(\);\n\s+await breath\(\);/);
  const follow = fn('export async function followBuilds(');
  assert.match(follow, /for \(const \[product, list\] of byProduct\) \{\n\s+await breath\(\);/);
  assert.match(follow, /await forEachBreathing\(db\.prepare\(`SELECT id, status, detail, started, finished FROM runs/);
  const start = fn('export async function startWork()');
  for (const loop of ['for (const f of reports) {', 'for (const t of waiting) {', 'for (const f of bugs) {']) {
    assert.match(start, new RegExp(loop.replace(/[()[\]{}]/g, '\\$&') + '\\n\\s+await breath\\(\\);'), loop);
  }
});
