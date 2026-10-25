// A run's plan (runplan.ts): the scenarios in order with expected time, each one's state and verdict once its review is
// done, a fixed "n of N" that changes only with a line saying why, and Talk told at halfway and on a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runplan-'));
const { db, J } = await import('../src/db.ts');
await import('../src/followup.ts'); // adds runs.origin
const { planRun, notePlaying, planView, planLine, progressCheck } = await import('../src/runplan.ts');
const { startConversation, getConversation } = await import('../src/talk.ts');

const conv = startConversation('plan');
db.prepare('INSERT INTO runs (id, kind, status, options, started, origin) VALUES (?, ?, ?, ?, ?, ?)').run('r_plan', 'playtest', 'running', '{}', Date.now(), conv.id);
let n = 0;
const step = (kind: string, name: string, status: string, data: unknown = null, detail = '') =>
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`s_${++n}`, 'r_plan', 'doseofdestruction', kind, name, status, detail, J(data), Date.now(), status === 'running' ? null : Date.now());

test('the plan lists scenarios in order with the total, and a late one is added with a line', () => {
  planRun('r_plan', ['smoke@local', 'campaign@local', 'phone@local', 'edge@local'].map((name) => ({ product: 'doseofdestruction', name })));
  planRun('r_plan', [{ product: 'doseofdestruction', name: 'ignored@local' }]); // only the first plan counts
  let v = planView('r_plan')!;
  assert.deepEqual(v.items.map((x) => x.name), ['smoke@local', 'campaign@local', 'phone@local', 'edge@local']);
  assert.equal(planLine(v), '0 of 4 scenarios · about 20 min left');
  notePlaying('r_plan', 'doseofdestruction', 'smoke@local', 'x'); // already planned: nothing added
  assert.equal(planView('r_plan')!.total, 4);
  notePlaying('r_plan', 'doseofdestruction', 'extra@local', 'it was not in the starting list');
  v = planView('r_plan')!;
  assert.equal(v.total, 5);
  assert.match(v.notes[0].text, /added extra@local .*not in the starting list/);
});

test('a scenario shows its verdict and findings as soon as its review is done, and Talk hears of halfway and failures once', async () => {
  step('playtest', 'smoke@local', 'done');
  step('review', 'smoke@local', 'done', { verdict: 'ship', findings: [{ severity: 'bug', title: 'Hat clips' }] });
  step('playtest', 'campaign@local', 'done');
  step('review', 'campaign@local', 'running');
  step('playtest', 'phone@local', 'failed', null, 'the page never loaded');
  let v = planView('r_plan')!;
  const by = Object.fromEntries(v.items.map((x) => [x.name, x]));
  assert.equal(by['smoke@local'].state, 'done');
  assert.equal(by['smoke@local'].verdict, 'ship');
  assert.equal(by['smoke@local'].findings[0].title, 'Hat clips');
  assert.equal(by['campaign@local'].state, 'reviewing');
  assert.equal(by['phone@local'].state, 'failed');
  assert.equal(v.finished, 2);
  await progressCheck('r_plan');
  await progressCheck('r_plan');
  const said = getConversation(conv.id)!.messages.map((m: any) => m.text);
  assert.equal(said.filter((t: string) => /phone@local .*failed/.test(t)).length, 1);
  assert.equal(said.filter((t: string) => /past halfway/.test(t)).length, 0, '2 of 5 is not past halfway');
  step('playtest', 'edge@local', 'skipped');
  step('playtest', 'extra@local', 'done');
  step('review', 'extra@local', 'done', { verdict: 'ship', findings: [] });
  await progressCheck('r_plan');
  await progressCheck('r_plan');
  const after = getConversation(conv.id)!.messages.map((m: any) => m.text);
  assert.equal(after.filter((t: string) => /past halfway: 4 of 5/.test(t)).length, 1);
});
