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
const { brainSettings, saveBrain } = await import('../src/brains.ts');
const { saveSettings, allSettings } = await import('../src/settings.ts');
const { parseClaudeArgs, cursorArgs, translate } = await import('../bin/cursor-agent.mjs');

test('Cursor launches cursor-agent, and Settings stores the harness and the model', async () => {
  process.env.HAWKES_BRAIN = 'cursor';
  assert.equal(brainSettings().harness, 'cursor');
  assert.equal(brainSettings().model, 'grok-4.7');
  const c = claudeCommand(['-p', 'hi', '--model', 'claude-opus-5-5', '--output-format', 'stream-json'], { cwd: process.cwd(), env: process.env });
  assert.equal(c.file, process.execPath);
  assert.match(String(c.args[0]), /cursor-agent\.mjs$/);
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'grok-4.7');
  delete process.env.HAWKES_BRAIN;
  assert.equal((await allSettings()).brain.harness, 'claude');
  const saved = await saveSettings('brain', { harness: 'cursor', model: 'composer-2.5' }, { conversation: null });
  assert.equal(saved.harness, 'cursor');
  assert.equal(saved.model, 'composer-2.5');
  assert.equal(saveBrain('claude').harness, 'claude');
  await assert.rejects(saveSettings('brain', { harness: 'gpt' }, { conversation: null }), /claude \| cursor/);
});

test('an old grok setting is the Cursor harness on Grok 4.7', () => {
  saveBrain({ id: 'grok', model: '' });
  assert.equal(brainSettings().harness, 'cursor');
  assert.equal(brainSettings().model, 'grok-4.7');
  saveBrain('claude');
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
