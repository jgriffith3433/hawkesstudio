import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusedModelOf, markModelUnavailable, modelUnavailable, clearUnavailable } from '../src/models.ts';
import { recordPass, ledgerSummary } from '../src/ledger.ts';

test('a refused model is parsed, remembered once, and cleared', () => {
  assert.equal(refusedModelOf('Error: Model "claude-opus-5.5" from --model flag is not available.'), 'claude-opus-5.5');
  assert.equal(refusedModelOf('all good'), null);
  clearUnavailable('copilot');
  assert.equal(markModelUnavailable('copilot', 'claude-opus-5.5'), true);
  assert.equal(markModelUnavailable('copilot', 'claude-opus-5.5'), false);
  assert.equal(modelUnavailable('copilot', 'claude-opus-5.5'), true);
  clearUnavailable('copilot');
  assert.equal(modelUnavailable('copilot', 'claude-opus-5.5'), false);
});

test('the ledger groups passes by role, harness and model', () => {
  const base = { change: 'c_ledgertest', role: 'tester-role', harness: 'copilot', model: 'm1', tier: 'standard', effort: 'medium', retry: 1, ms: 60000, cost: 1 };
  recordPass({ ...base, outcome: 'done' });
  recordPass({ ...base, outcome: 'harness-stop' });
  const row = ledgerSummary(1).find((r) => r.role === 'tester-role');
  assert.ok(row);
  assert.equal(row.passes, 2);
  assert.equal(row.harnessStops, 1);
  assert.equal(row.cost, 2);
});
