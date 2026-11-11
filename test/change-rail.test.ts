// A change's progress rail (src/change-rail.ts railState, dashboard/rail.js): which step is current, where a failure shows
// and its reason, the beta lane's part, and the markup at 390px (one column, no fixed widths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rail-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const { railState } = await import('../src/change-rail.ts');

const ctx: any = {};
vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'rail.js'), 'utf8'), ctx);
const row = (c: any, beta: any = null, infra = false) => railState({ created: 1000, ...c }, {}, beta, infra).map((s) => `${s.key}:${s.state}`).join(' ');
const J = JSON.stringify;
const edit = '10:00:00 tool: Edit {"file_path":"a.ts"}';

test('a running change has one current step and later ones tick in', () => {
  assert.equal(row({ status: 'queued' }), 'started:now reading:todo editing:todo checks:todo pr:todo merged:todo built:todo played:todo');
  assert.equal(row({ status: 'working', phase: J({ step: 'agent' }), log: J([]) }), 'started:done reading:now editing:todo checks:todo pr:todo merged:todo built:todo played:todo');
  assert.equal(row({ status: 'working', phase: J({ step: 'agent' }), log: J([edit]) }), 'started:done reading:done editing:now checks:todo pr:todo merged:todo built:todo played:todo');
  assert.equal(row({ status: 'verifying', phase: J({ step: 'verify' }), log: J([edit]), pr: 5 }), 'started:done reading:done editing:done checks:now pr:todo merged:todo built:todo played:todo');
  assert.equal(row({ status: 'ready', pr: 5, log: J([edit]) }), 'started:done reading:done editing:done checks:done pr:done merged:now built:todo played:todo');
});

test('a failed step is red with the plain reason', () => {
  const r = railState({ created: 1, status: 'failed', detail: 'npm run typecheck failed: src/a.ts(3,1): error TS2304\nmore', phase: J({ step: 'verify', failed: true }), log: J([edit]), pr: 7 }, {}, null, false);
  const f = r.find((s) => s.state === 'failed')!;
  assert.equal(f.key, 'checks');
  assert.equal(f.detail, 'npm run typecheck failed: src/a.ts(3,1): error TS2304');
  assert.deepEqual(r.filter((s) => s.state === 'now').length, 0);
  const g = railState({ created: 1, status: 'failed', detail: 'the agent made no commit', phase: null, log: J([]) }, {}, null, false);
  assert.equal(g.find((s) => s.state === 'failed')!.key, 'editing');
  const v = railState({ created: 1, status: 'ready', pr: 9, verify: J({ outcome: 'failed', summary: 'x' }), detail: 'failed: playtest' }, {}, null, false);
  assert.equal(v.find((s) => s.state === 'failed')!.key, 'checks');
});

test('after the merge the beta lane decides built and playtested', () => {
  const m = { status: 'merged', pr: 5, merged_at: 5000, detail: 'merged into beta by Studio: abc1234 (not live yet)', log: J([edit]) };
  assert.match(row(m), /merged:done built:now played:todo$/);
  assert.match(row(m, { built: { state: 'done', at: 6000, detail: 'built' }, played: null }), /built:done played:now$/);
  assert.match(row(m, { built: { state: 'done', at: 6000, detail: 'built' }, played: { state: 'failed', at: 7000, detail: 'smoke: the page never loaded' } }), /built:done played:failed$/);
  assert.match(row(m, { built: { state: 'failed', at: 6000, detail: 'compile error' }, played: null }), /built:failed played:todo$/);
});

test('a Studio change has no beta steps and merges to main', () => {
  const r = railState({ created: 1, status: 'ready', pr: 3, log: J([edit]) }, {}, null, true);
  assert.deepEqual(r.map((s) => s.key), ['started', 'reading', 'editing', 'checks', 'pr', 'merged']);
  assert.equal(r[5].label, 'Merged to main');
});

test('the markup: current step marked, failure red, text escaped, no fixed widths', () => {
  const html = ctx.ChangeRail.html('c_1', [
    { key: 'checks', label: 'Checks', state: 'failed', at: null, detail: '<b>typecheck</b> failed' },
    { key: 'pr', label: 'Pull request', state: 'now', at: null, detail: '#5', href: 'https://x/pull/5' },
  ]);
  assert.match(html, /class="rs failed"/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /&lt;b&gt;typecheck&lt;\/b&gt; failed/);
  assert.ok(!/width|px/.test(html));
});
