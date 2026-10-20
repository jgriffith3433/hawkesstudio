// Agent tuning: presets, validation, what raises cost, and what a run is launched with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tuning-'));
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
delete process.env.HAWKES_BRAIN;
delete process.env.STUDIO_MODEL_FIXER;

const T = await import('../src/tuning.ts');
const { roleArgs } = await import('../src/roles.ts');
const { saveSettings, costRaising } = await import('../src/settings.ts');
const { copilotArgs } = await import('../bin/copilot-agent.mjs');
const { saveBrain } = await import('../src/brains.ts');

const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('the default is balanced, and a preset replaces every field', () => {
  assert.equal(T.tuningSettings().preset, 'balanced');
  T.saveTuning({ preset: 'economy' });
  const e = T.tuningSettings();
  assert.equal(e.roles.scout.tier, 'fast');
  assert.equal(e.copilot.maxCredits, 60);
  T.saveTuning({ preset: 'balanced' });
});

test('editing a field makes it custom; bad values are refused', () => {
  const t = T.saveTuning({ roles: { fixer: { effort: 'low', maxTurns: 40 } } });
  assert.equal(t.preset, 'custom');
  assert.equal(t.roles.fixer.maxTurns, 40);
  assert.throws(() => T.saveTuning({ roles: { fixer: { tier: 'huge' } } }), /tier/);
  assert.throws(() => T.saveTuning({ copilot: { maxCredits: 10 } }), /30/);
  assert.throws(() => T.saveTuning({ nonsense: 1 }), /not a setting/);
  T.saveTuning({ preset: 'balanced' });
});

test('roleArgs carries the tuned model, effort and turn cap for the harness in use', () => {
  saveBrain({ harness: 'claude' }, 'test');
  let a = roleArgs('fixer').args;
  assert.equal(arg(a, '--model'), 'claude-sonnet-5-5');
  assert.equal(arg(a, '--effort'), 'medium');
  assert.equal(arg(a, '--max-turns'), '60');
  saveBrain({ harness: 'copilot' }, 'test');
  a = roleArgs('scout').args;
  assert.equal(arg(a, '--model'), 'claude-haiku-5.5');
  assert.equal(arg(a, '--max-turns'), '30');
});

test('a retry uses the next tier up, except Talk and the deepest', () => {
  saveBrain({ harness: 'claude' }, 'test');
  assert.equal(T.roleTune('fixer', { retry: 1 }).tier, 'standard');
  assert.equal(T.roleTune('fixer', { retry: 2 }).tier, 'deep');
  assert.equal(T.roleTune('talk', { retry: 3 }).tier, 'standard');
  assert.equal(arg(roleArgs('fixer', { retry: 2 }).args, '--model'), 'claude-opus-5-5');
});

test('cost-raising changes are named, lowering ones are not', async () => {
  const cur = T.tuningSettings();
  assert.deepEqual(costRaising('tuning', { roles: { fixer: { tier: 'fast' } } }, cur as any), []);
  assert.ok(costRaising('tuning', { roles: { fixer: { tier: 'deep' } } }, cur as any).length > 0);
  assert.ok(costRaising('tuning', { copilot: { maxCredits: 0 } }, cur as any).length > 0);
  await assert.rejects(saveSettings('tuning', { roles: { builder: { tier: 'deep' } } }, { conversation: 'c_none', quote: 'sure' }), /raise costs/);
  const saved = await saveSettings('tuning', { preset: 'economy' }, { conversation: 'c_none' });
  assert.equal((saved as any).preset, 'economy');
  T.saveTuning({ preset: 'balanced' });
});

test('the Copilot adapter passes the credit cap, context tier and tuned model', () => {
  process.env.COPILOT_MAX_CREDITS = '150';
  process.env.COPILOT_CONTEXT = 'long_context';
  const a = copilotArgs({ model: 'claude-sonnet-5.5', effort: 'high', stream: true }, 'hi', 'sid');
  assert.equal(arg(a, '--max-ai-credits'), '150');
  assert.equal(arg(a, '--context'), 'long_context');
  assert.equal(arg(a, '--model'), 'claude-sonnet-5.5');
  assert.equal(arg(a, '--reasoning-effort'), 'high');
  delete process.env.COPILOT_MAX_CREDITS;
  delete process.env.COPILOT_CONTEXT;
});
