// Which provider and model each run is on (src/runs.ts): from what the harness reported, not the settings; a change's
// history of starts, switches (with why), reported models and parks; the Resources tab's per-provider load; and the
// health check that a change never shows another provider than the job running it (J, 2026-11-10: "Super important
// that this is working correctly").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runs-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
for (const k of ['HAWKES_BRAIN', 'STUDIO_PROVIDERS_MODE', 'STUDIO_HARNESS_ORDER', 'STUDIO_HARNESS_FAILOVER', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));

const R = await import('../src/runs.ts');
const P = await import('../src/providers.ts');
const hold = await import('../src/harness-hold.ts');
const { brainOfChange } = await import('../src/agents.ts');
const { recordPass } = await import('../src/ledger.ts');

P.providerDeps.installed = () => true;
P.providerDeps.configured = (h) => ['claude', 'codex', 'cursor'].includes(h);
Object.assign(hold.holdDeps, { talk: async () => {}, phone: async () => {}, probe: async () => ({ ok: false, note: 'no answer' }) });

test('a harness that names its provider instead of a model reads as not reported', () => {
  assert.equal(R.reportedModel('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(R.reportedModel(' gpt-5.1-codex '), 'gpt-5.1-codex');
  for (const x of ['', 'cursor', 'Copilot', 'gemini', 'unknown', null, undefined, 42]) assert.equal(R.reportedModel(x), null, String(x));
});

test("a change's history: start, the model the harness reported, a park, a switch with why, and what it shows now", () => {
  const id = 'c_runs_hist';
  assert.equal(R.currentBrain(id), null, 'nothing before its first pass');
  R.noteBrain(id, { kind: 'start', harness: 'claude', model: 'sonnet', why: 'Claude: first in your order for builder work' }, 1000);
  let now = R.currentBrain(id)!;
  assert.deepEqual([now.harness, now.model, now.reported], ['claude', 'sonnet', false], 'the asked model until the harness says');
  R.noteBrain(id, { kind: 'model', harness: 'claude', model: 'claude-sonnet-5-5', why: null }, 2000);
  now = R.currentBrain(id)!;
  assert.deepEqual([now.harness, now.model, now.reported], ['claude', 'claude-sonnet-5-5', true]);
  R.noteBrain(id, { kind: 'park', harness: 'claude', model: 'claude-sonnet-5-5', why: "usage: You've hit your weekly limit" }, 3000);
  R.noteBrain(id, { kind: 'switch', harness: 'codex', model: 'gpt-5-codex', why: 'Claude: held' }, 4000);
  now = R.currentBrain(id)!;
  // The new pass's provider, and NOT Claude's old reported model: that one belonged to the earlier pass.
  assert.deepEqual([now.harness, now.model, now.reported], ['codex', 'gpt-5-codex', false]);
  R.noteBrain(id, { kind: 'model', harness: 'codex', model: 'gpt-5.1-codex', why: null }, 5000);
  assert.equal(R.currentBrain(id)!.model, 'gpt-5.1-codex');
  assert.equal(R.lastHarness(id), 'codex');
  assert.deepEqual(R.brainHistory(id).map((e) => e.kind), ['start', 'model', 'park', 'switch', 'model'], 'oldest first');
  assert.equal(R.brainHistory(id).find((e) => e.kind === 'switch')!.why, 'Claude: held');
});

test('a change shows the model its harness reported, else the one asked for (marked), and its last pass after it ends', () => {
  const id = 'c_runs_show';
  // Queued with no pass yet: the planned model, not marked as reported.
  const queued = brainOfChange({ id, product: 'sickofit', status: 'queued', request: 'Add a pause button' });
  assert.equal(queued.model_reported, false);
  // Working on Codex (its phase says so) and Codex said which model: that's what shows.
  R.noteBrain(id, { kind: 'start', harness: 'codex', model: 'gpt-5-codex', why: null });
  R.noteBrain(id, { kind: 'model', harness: 'codex', model: 'gpt-5.1-codex-max', why: null });
  const working = brainOfChange({ id, product: 'sickofit', status: 'working', request: 'Add a pause button', phase: JSON.stringify({ step: 'agent', since: 1, before: '', brain: 'codex' }) });
  assert.deepEqual([working.harness, working.model, working.model_reported], ['codex', 'gpt-5.1-codex-max', true]);
  // Finished: the ledger's pass, with the reported model first.
  const done = 'c_runs_done';
  recordPass({ change: done, product: 'sickofit', role: 'builder', harness: 'cursor', model: 'auto', reported: 'claude-4.5-sonnet', tier: 'standard', effort: 'medium', retry: 1, ms: 1000, cost: 0, outcome: 'done' });
  const fin = brainOfChange({ id: done, product: 'sickofit', status: 'ready', request: 'x' });
  assert.deepEqual([fin.harness, fin.model, fin.model_reported], ['cursor', 'claude-4.5-sonnet', true]);
});

test('live runs: per-provider load with models, and the health check flags a change that shows another provider', () => {
  const a = R.runStarted({ id: 'agent:c_live1', kind: 'agent', harness: 'claude', model: null, change: 'c_live1' });
  R.runAsked('agent:c_live1', 'opus');
  const b = R.runStarted({ id: 'agent:c_live2', kind: 'agent', harness: 'codex', model: 'gpt-5-codex', change: 'c_live2' });
  R.runReported('agent:c_live2', 'gpt-5.1-codex');
  const t = R.runStarted({ id: 'talk:x', kind: 'talk', harness: 'claude', model: 'claude-opus-5-5' });
  R.runReported('agent:c_live1', 'claude-opus-5-5');
  R.runAsked('agent:c_live1', 'sonnet'); // a reported model is never replaced by an asked one
  const load = R.loadByProvider();
  const claude = load.find((x) => x.harness === 'claude')!;
  assert.equal(claude.running, 2);
  assert.deepEqual(claude.kinds, { agent: 1, talk: 1 });
  assert.equal(claude.models['claude-opus-5-5'], 1);
  assert.equal(claude.models['claude-opus-5-5 (asked)'], 1, 'Talk asked for it and has not reported yet');
  assert.equal(load.find((x) => x.harness === 'codex')!.models['gpt-5.1-codex'], 1);

  // c_live1 shows Claude (right); c_live2 shows Claude but runs on Codex (wrong).
  const shown: Record<string, string> = { c_live1: 'claude', c_live2: 'claude' };
  const bad = R.liveMismatches((id) => ({ harness: shown[id] }));
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /c_live2 shows claude but its pass runs on codex/);
  a(); b(); t(); t();
  assert.equal(R.liveRuns().length, 0, 'ended runs leave, and ending twice is harmless');
});

test('why a pass runs where it does: held, full, back in order, first choice', () => {
  const s = { ...P.providerSettings(), mode: 'spread' as const, order: ['claude', 'codex', 'cursor'] as any, off: [], caps: { ...P.DEFAULT_CAPS, claude: 1 } };
  assert.match(P.whyHarness(null, 'claude', 'builder', s), /first in your order for builder work/);
  assert.match(P.whyHarness(null, 'codex', 'scout', s), /least busy/);
  const release = P.using('claude');
  assert.match(P.whyHarness('claude', 'codex', 'builder', s), /^Claude was full \(1 of 1 running\)/);
  release();
  assert.match(P.whyHarness('codex', 'claude', 'builder', s), /Claude answers again: back to it/);
  assert.match(P.whyHarness('claude', 'codex', 'builder', { ...s, off: ['claude'] as any }), /^Claude: switched off in Settings/);
  hold.holdHarness({ kind: 'usage', line: "You've hit your weekly limit", resetsAt: Date.now() + 86_400_000 }, { source: 'test', harness: 'claude' });
  assert.match(P.whyHarness('claude', 'codex', 'builder', s), /^Claude: /);
});
