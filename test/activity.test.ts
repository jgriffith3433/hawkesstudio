// The Activity panel's stages of an agent change (dashboard/activity.js ChangeStages): which stage is lit, which are
// done, and where a failed change stopped, from its status and the facts /api/activity sends (src/activity.ts stageOf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// The page's rules, loaded the way the browser does (a classic script), without a DOM.
const ctx: any = {};
vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'activity.js'), 'utf8'), ctx);
const S = ctx.ChangeStages;
/** "coding:done building:now ..." for short asserts. */
const row = (status: string, stage: any = {}) => S.stages(status, stage).map((x: any) => `${x.name}:${x.state}`).join(' ');
const jobs = (o: any = {}) => ({ build: false, playtest: false, review: false, ...o });

test('the stages per kind of change', () => {
  assert.equal(row('queued', { unity: true }), 'coding:todo building:todo playtesting:todo review:todo ready:todo');
  assert.equal(row('queued', {}), 'coding:todo playtesting:todo review:todo ready:todo');
  assert.equal(row('queued', { infra: true }), 'coding:todo checks:todo ready:todo');
});

test('a change being worked on lights its current stage', () => {
  assert.equal(row('working', { step: 'agent', jobs: jobs() }), 'coding:now playtesting:todo review:todo ready:todo');
  assert.equal(row('needs answer', { step: null }), 'coding:now playtesting:todo review:todo ready:todo');
  const u = { unity: true, step: 'verify' };
  assert.equal(row('verifying', { ...u, jobs: jobs() }), 'coding:done building:now playtesting:todo review:todo ready:todo');
  assert.equal(row('verifying', { ...u, jobs: jobs({ build: true }) }), 'coding:done building:now playtesting:todo review:todo ready:todo');
  assert.equal(row('verifying', { ...u, jobs: jobs({ build: true, playtest: true }) }), 'coding:done building:done playtesting:now review:todo ready:todo');
  assert.equal(row('verifying', { ...u, jobs: jobs({ build: true, playtest: true, review: true }) }), 'coding:done building:done playtesting:done review:now ready:todo');
  assert.equal(row('verifying', { step: 'verify', jobs: jobs() }), 'coding:done playtesting:now review:todo ready:todo');
  assert.equal(row('verifying', { step: 'finish', jobs: jobs({ playtest: true, review: true }) }), 'coding:done playtesting:done review:now ready:todo');
  assert.equal(row('revising', { step: 'prepare', unity: true }), 'coding:now building:todo playtesting:todo review:todo ready:todo');
  // Verifying with no step recorded (from before steps were): the first verification stage.
  assert.equal(row('verifying', { unity: true, step: null }), 'coding:done building:now playtesting:todo review:todo ready:todo');
  assert.equal(row('verifying', { infra: true, step: 'verify' }), 'coding:done checks:now ready:todo');
});

test('ready and merged', () => {
  assert.equal(row('ready', { outcome: 'passed' }), 'coding:done playtesting:done review:done ready:now');
  assert.equal(row('ready', { infra: true, outcome: 'passed' }), 'coding:done checks:done ready:now');
  assert.equal(row('merged', { unity: true }), 'coding:done building:done playtesting:done review:done ready:done');
  // Ready, but its verification stopped: that stage is red, ready is still lit (it waits on J).
  assert.equal(row('ready', { unity: true, outcome: 'build failed' }), 'coding:done building:failed playtesting:todo review:todo ready:now');
  assert.equal(row('ready', { outcome: 'failed' }), 'coding:done playtesting:failed review:todo ready:now');
  assert.equal(row('ready', { infra: true, outcome: 'failed' }), 'coding:done checks:failed ready:now');
});

test('a failed change shows the stage it failed at in red', () => {
  // No step kept (the agent made no commit, guard rails, older changes): coding.
  assert.equal(row('failed', {}), 'coding:failed playtesting:todo review:todo ready:todo');
  assert.equal(row('failed', { step: 'agent', failed: true }), 'coding:failed playtesting:todo review:todo ready:todo');
  assert.equal(row('failed', { unity: true, step: 'verify', failed: true, jobs: jobs({ build: true }) }), 'coding:done building:failed playtesting:todo review:todo ready:todo');
  assert.equal(row('failed', { unity: true, step: 'verify', failed: true, jobs: jobs({ build: true, playtest: true, review: true }) }), 'coding:done building:done playtesting:done review:failed ready:todo');
  assert.equal(row('failed', { step: 'finish', failed: true }), 'coding:done playtesting:done review:failed ready:todo');
  assert.equal(row('failed', { infra: true, step: 'verify', failed: true }), 'coding:done checks:failed ready:todo');
});

// The thin progress bar under the stages (ChangeStages.progress): equal parts per stage before ready, creeping within
// coding by elapsed time, green at ready, red where a failed change stopped.
const P = (status: string, stage: any = {}, now = 0) => {
  const p = S.progress(status, stage, now);
  return `${p.pct}:${p.state}:${p.stage}`;
};
const MIN = 60_000;

test('the progress bar fills by stage', () => {
  assert.equal(P('queued', { unity: true }), '0:todo:coding');
  assert.equal(P('closed', {}), '0:todo:coding');
  // A product change has three stages before ready, a Unity one four, Studio and Gen two.
  assert.equal(P('verifying', { step: 'verify', jobs: jobs() }), '50:now:playtesting');
  assert.equal(P('verifying', { step: 'finish', jobs: jobs({ playtest: true, review: true }) }), '83:now:review');
  assert.equal(P('verifying', { unity: true, step: 'verify', jobs: jobs({ build: true }) }), '38:now:building');
  assert.equal(P('verifying', { unity: true, step: 'verify', jobs: jobs({ build: true, playtest: true }) }), '63:now:playtesting');
  assert.equal(P('verifying', { infra: true, step: 'verify' }), '75:now:checks');
  assert.equal(P('ready', { outcome: 'passed' }), '100:ready:ready');
  assert.equal(P('ready', { infra: true, outcome: 'failed' }), '100:ready:ready');
  assert.equal(P('merged', { unity: true }), '100:ready:ready');
});

test('the progress bar creeps through coding as the agent works, never past it', () => {
  const at = (ms: number, extra: any = {}) => S.progress('working', { step: 'agent', since: 0, ...extra }, ms).pct;
  assert.equal(at(0), 2); // just started: a sliver, so the bar is visible
  const steps = [1, 5, 10, 20, 40, 120, 600].map((m) => at(m * MIN));
  for (let k = 1; k < steps.length; k++) assert.ok(steps[k] >= steps[k - 1], `never goes back: ${steps}`);
  assert.ok(steps[3] > 10 && steps[3] < 25, `about halfway through coding after a typical run: ${steps[3]}`);
  assert.ok(steps.at(-1)! <= 30, `stays inside coding (a third of a product change's bar): ${steps.at(-1)}`);
  assert.ok(at(600 * MIN, { infra: true }) <= 45, 'Studio and Gen: inside coding (half the bar)');
  // Pushing the branch: the end of coding.
  assert.equal(at(0, { step: 'publish' }), 32);
  // No start time (needs answer before steps were recorded): the start of coding.
  assert.equal(P('needs answer', { step: null }), '2:now:coding');
  // A clock behind the start time doesn't make it negative.
  assert.equal(at(-5 * MIN), 2);
});

test('the progress bar is red where a failed change stopped', () => {
  assert.equal(P('failed', {}), '17:failed:coding');
  assert.equal(P('failed', { unity: true, step: 'verify', failed: true, jobs: jobs({ build: true }) }), '38:failed:building');
  assert.equal(P('failed', { step: 'finish', failed: true }), '83:failed:review');
  assert.equal(P('failed', { infra: true, step: 'verify', failed: true }), '75:failed:checks');
});

test('the bar html carries its percent and state', () => {
  const h = S.barHtml('failed', { infra: true, step: 'verify', failed: true }, 0);
  assert.match(h, /class="act-bar failed"/);
  assert.match(h, /width:75%/);
  assert.match(h, /stopped at checks/);
});
