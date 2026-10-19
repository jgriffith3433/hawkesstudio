// Grok as a brain: the setting, and that a Grok brain launches grok-agent instead of claude.
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

test('Grok launches grok-agent, and Settings can store the choice', async () => {
  process.env.HAWKES_BRAIN = 'grok';
  assert.equal(brainSettings().id, 'grok');
  assert.equal(brainSettings().model, 'grok-4.7');
  const c = claudeCommand(['-p', 'hi', '--model', 'claude-opus-5-5', '--output-format', 'stream-json'], { cwd: process.cwd(), env: process.env });
  assert.equal(c.file, process.execPath);
  assert.match(String(c.args[0]), /grok-agent\.mjs$/);
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'grok-4.7');
  delete process.env.HAWKES_BRAIN;
  assert.equal((await allSettings()).brain.id, 'claude');
  const saved = await saveSettings('brain', { id: 'grok' }, { conversation: null });
  assert.equal(saved.id, 'grok');
  assert.equal(saveBrain('claude').id, 'claude');
  await assert.rejects(saveSettings('brain', { id: 'gpt' }, { conversation: null }), /claude \| grok/);
});
