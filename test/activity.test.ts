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
