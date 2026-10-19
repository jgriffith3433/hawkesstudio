// grok-agent: argument parsing, an edit, and one turn against a fake xAI response (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const agent = path.resolve('bin/grok-agent.mjs');
const { parseArgs, applyEdit } = await import('../bin/grok-agent.mjs');

test('parseArgs reads the prompt, the model and a call that stays on stdin', () => {
  const one = parseArgs(['-p', 'fix the bug', '--model', 'claude-sonnet-5-5', '--max-turns', '12', '--append-system-prompt', 'be brief']);
  assert.equal(one.prompt, 'fix the bug');
  assert.equal(one.model, 'grok-4.7');
  assert.equal(one.maxTurns, 12);
  assert.equal(one.append, 'be brief');
  const call = parseArgs(['-p', '--input-format', 'stream-json', '--include-partial-messages']);
  assert.equal(call.prompt, '');
  assert.equal(call.inputFormat, 'stream-json');
  assert.equal(call.partial, true);
});

test('applyEdit replaces one exact match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-edit-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'one two two');
  assert.equal(applyEdit(file, 'two', 'THREE'), 'old_string matched 2 times; include more context so it matches once');
  assert.equal(applyEdit(file, 'one two', 'one THREE'), 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one THREE two');
});

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [agent, ...args], { cwd, env, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('a fake turn reads a file and finishes with a result line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-turn-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello from the file');
  const fake = path.join(dir, 'fake.json');
  fs.writeFileSync(fake, JSON.stringify([
    { id: 'resp_1', output: [{ type: 'function_call', name: 'Read', call_id: 'c1', arguments: JSON.stringify({ path: 'note.txt' }) }], usage: { input_tokens: 100, output_tokens: 20 } },
    { id: 'resp_2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'The note says hello.' }] }], usage: { input_tokens: 50, output_tokens: 10 } },
  ]));
  const r = await run(['-p', 'read note.txt', '--tools', 'Read', '--output-format', 'stream-json'], { ...process.env, GROK_FAKE_FILE: fake, GROK_SESSION_DIR: path.join(dir, 'sessions') }, dir);
  assert.equal(r.err, '', r.err);
  const lines = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'system');
  assert.equal(lines[0].apiKeySource, 'xai');
  assert.ok(lines.some((m) => m.type === 'assistant' && m.message.content.some((p: any) => p.type === 'tool_use' && p.name === 'Read')));
  const last = lines.at(-1);
  assert.equal(last.type, 'result');
  assert.equal(last.is_error, false);
  assert.equal(last.result, 'The note says hello.');
  assert.ok(last.total_cost_usd > 0);
  assert.equal(r.code, 0);
});
