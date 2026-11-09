// Cursor as a harness: the setting, and that Cursor launches cursor-agent instead of claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-brain-'));
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
delete process.env.TALK_CLAUDE;
delete process.env.TALK_CLAUDE_ARGS;
delete process.env.HAWKES_BRAIN;

const { claudeCommand } = await import('../src/sandbox.ts');
const { brainSettings, brainLabel, saveBrain, harnessBlocked, fallbackChain } = await import('../src/brains.ts');
const { saveSettings, allSettings } = await import('../src/settings.ts');
const { talkInfo } = await import('../src/talk.ts');
const { brainOfChange } = await import('../src/agents.ts');
const { recordPass } = await import('../src/ledger.ts');
const { parseClaudeArgs, cursorArgs, translate } = await import('../bin/cursor-agent.mjs');

test('Cursor launches cursor-agent, and Settings stores the harness and the model', async () => {
  process.env.HAWKES_BRAIN = 'cursor';
  assert.equal(brainSettings().harness, 'cursor');
  assert.equal(brainSettings().model, 'auto');
  const c = claudeCommand(['-p', 'hi', '--model', 'claude-opus-5-5', '--output-format', 'stream-json'], { cwd: process.cwd(), env: process.env });
  assert.equal(c.file, process.execPath);
  assert.match(String(c.args[0]), /cursor-agent\.mjs$/);
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'auto');
  delete process.env.HAWKES_BRAIN;
  assert.equal((await allSettings()).brain.harness, 'claude');
  const saved = await saveSettings('brain', { harness: 'cursor', model: 'auto' }, { conversation: null });
  assert.equal(saved.harness, 'cursor');
  assert.equal(saved.model, 'auto');
  assert.equal(saveBrain('claude').harness, 'claude');
  await assert.rejects(saveSettings('brain', { harness: 'gpt' }, { conversation: null }), /claude \| cursor/);
});

test('an old grok setting is the Cursor harness on Auto', () => {
  saveBrain({ id: 'grok', model: '' });
  assert.equal(brainSettings().harness, 'cursor');
  assert.equal(brainSettings().model, 'auto');
  saveBrain('claude');
});

test('Copilot is a third harness: it launches copilot-agent, and the fallback chain skips the one that failed', async () => {
  process.env.HAWKES_BRAIN = 'copilot';
  assert.equal(brainSettings().harness, 'copilot');
  const c = claudeCommand(['-p', 'hi', '--model', 'claude-opus-5-5', '--output-format', 'stream-json'], { cwd: process.cwd(), env: process.env });
  assert.equal(c.file, process.execPath);
  assert.match(String(c.args[0]), /copilot-agent\.mjs$/);
  delete process.env.HAWKES_BRAIN;
  assert.equal(saveBrain('copilot').harness, 'copilot');
  assert.equal(saveBrain('claude').harness, 'claude');
  // Codex (the ChatGPT plan) comes right after Claude: the next subscription plan before the others.
  assert.deepEqual(fallbackChain('claude'), ['codex', 'cursor', 'copilot', 'antigravity', 'gemini']);
  assert.deepEqual(fallbackChain('cursor'), ['claude', 'codex', 'copilot', 'antigravity', 'gemini']);
  assert.deepEqual(fallbackChain('copilot'), ['claude', 'codex', 'cursor', 'antigravity', 'gemini']);
  assert.deepEqual(fallbackChain('antigravity'), ['claude', 'codex', 'cursor', 'copilot', 'gemini']);
  assert.deepEqual(fallbackChain('gemini'), ['claude', 'codex', 'cursor', 'copilot', 'antigravity']);
  assert.deepEqual(fallbackChain('codex'), ['claude', 'cursor', 'copilot', 'antigravity', 'gemini']);
  process.env.HAWKES_BRAIN = 'antigravity';
  const a = claudeCommand(['-p', 'hi'], { cwd: process.cwd(), env: process.env });
  assert.match(String(a.args[0]), /antigravity-agent\.mjs$/);
  process.env.HAWKES_BRAIN = 'gemini';
  const g = claudeCommand(['-p', 'hi'], { cwd: process.cwd(), env: process.env });
  assert.match(String(g.args[0]), /gemini-agent\.mjs$/);
  delete process.env.HAWKES_BRAIN;
});

test('Gemini quota and login errors are harness stops', () => {
  assert.equal(harnessBlocked('RESOURCE_EXHAUSTED: You have exhausted your capacity on this model.'), true);
  assert.equal(harnessBlocked('Please set an Auth method in your settings.json or specify one of: GEMINI_API_KEY'), true);
});

test('Copilot quota, billing and login errors are harness stops', () => {
  assert.equal(harnessBlocked('You have no premium requests remaining'), true);
  assert.equal(harnessBlocked('No authentication information found. Set COPILOT_GITHUB_TOKEN'), true);
  assert.equal(harnessBlocked('Quota exceeded for this month'), true);
});

test('a usage cap or a missing login is a harness stop, not a diagnosis', () => {
  assert.equal(harnessBlocked("You've hit your weekly limit · resets Oct 23, 1pm (UTC)"), true);
  assert.equal(harnessBlocked('Error: Authentication required. Please run \'agent login\' or set CURSOR_API_KEY'), true);
  assert.equal(harnessBlocked('The bridge cutscene is already on beta and the boss scenario covers it.'), false);
});

test('Cursor events become Claude Code events', () => {
  const parsed = parseClaudeArgs(['node', 'cursor-agent.mjs', '-p', 'fix it', '--model', 'grok-4.7', '--append-system-prompt', 'be careful', '--include-partial-messages']);
  assert.equal(parsed.prompt, 'fix it');
  assert.equal(parsed.system, 'be careful');
  assert.ok(cursorArgs(parsed, 'fix it', '').includes('--force'));
  const state = { session: '', text: '', started: false };
  const init = translate(state, { type: 'system', subtype: 'init', session_id: 's1', model: 'Grok 4.7', apiKeySource: 'env' });
  assert.equal(init[0].apiKeySource, 'none');
  assert.equal(state.session, 's1');
  const delta = translate(state, { type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'On it' }] }, session_id: 's1' });
  assert.equal(delta[0].type, 'stream_event');
  const tool = translate(state, { type: 'tool_call', subtype: 'started', session_id: 's1', tool_call: { readToolCall: { args: { path: 'a.ts' } } } });
  assert.equal(tool.at(-1).message.content[0].type, 'tool_use');
  assert.equal(tool.at(-1).message.content[0].name, 'Read');
  const done = translate(state, { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1', duration_ms: 10 });
  assert.equal(done.at(-1).total_cost_usd, 0);
  assert.equal(done.at(-1).result, 'done');
});

test('talkInfo and brainOfChange report the active harness, model and billing across brains', () => {
  saveBrain({ harness: 'antigravity', model: '' });
  let info = talkInfo();
  assert.equal(info.harness, 'antigravity');
  assert.equal(info.label, 'Antigravity');
  assert.equal(info.billing, 'Google AI plan');
  assert.equal(info.model, 'gemini-4-argon-medium');

  const queued = brainOfChange({ id: 'c_braintest_q', product: 'sickofit', status: 'queued', request: 'Add a pause button' });
  assert.equal(queued.harness, 'antigravity');
  assert.equal(queued.harness_label, 'Antigravity');
  assert.equal(queued.model, 'gemini-4-argon-medium');
  assert.equal(queued.role, 'builder');

  recordPass({ change: 'c_braintest_done', product: 'sickofit', role: 'fixer', harness: 'copilot', model: 'claude-sonnet-5.5', tier: 'standard', effort: 'medium', retry: 1, ms: 5000, cost: 0, outcome: 'done' });
  const finished = brainOfChange({ id: 'c_braintest_done', product: 'sickofit', status: 'ready', findings: ['f_1'], title: 'Fix shop' });
  assert.equal(finished.harness, 'copilot');
  assert.equal(finished.harness_label, 'Copilot');
  assert.equal(finished.model, 'claude-sonnet-5.5');
  assert.equal(finished.role, 'fixer');

  assert.equal(brainLabel('antigravity'), 'Antigravity');
  assert.equal(brainLabel('copilot'), 'Copilot');
  assert.equal(brainLabel('cursor'), 'Cursor');
  assert.equal(brainLabel('gemini'), 'Gemini');
  assert.equal(brainLabel('claude'), 'Claude');
  saveBrain('claude');
});
