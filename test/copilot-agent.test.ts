// The Copilot adapter: Claude Code's argv in, Copilot CLI flags out, Copilot's JSONL back as Claude's stream-json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseClaudeArgs, copilotArgs, copilotModel, translate, finish, toolName } from '../bin/copilot-agent.mjs';

const fresh = () => ({ session: 's1', sessionLocked: true, text: '', started: false, deltas: false, announced: new Set(), began: Date.now(), error: '' });

test('Claude argv is reduced to what Copilot needs', () => {
  const p = parseClaudeArgs(['node', 'x', '-p', 'do it', '--model', 'claude-opus-5-5', '--append-system-prompt', 'be brief', '--max-turns', '9', '--allowedTools', 'Read', '--effort', 'high']);
  assert.equal(p.prompt, 'do it');
  assert.equal(p.system, 'be brief');
  assert.equal(p.effort, 'high');
  const args = copilotArgs(p, 'do it', 'sid');
  assert.deepEqual(args.slice(0, 2), ['-p', 'do it']);
  for (const f of ['--allow-all', '--no-ask-user', '--session-id', 'sid', '--reasoning-effort']) assert.ok(args.includes(f), f);
  assert.ok(!args.includes('--model'), 'a Claude model id is not sent to Copilot');
});

test('model ids: Claude ids and aliases drop, Copilot ids pass', () => {
  delete process.env.COPILOT_MODEL;
  assert.equal(copilotModel('opus'), '');
  assert.equal(copilotModel('claude-sonnet-5-5'), '');
  assert.equal(copilotModel('gpt-5.4'), 'gpt-5.4');
  assert.equal(copilotModel('claude-sonnet-4.5'), 'claude-sonnet-4.5');
});

test('tools are named the way Claude Code names them', () => {
  assert.equal(toolName({ toolName: 'view' }), 'Read');
  assert.equal(toolName({ toolName: 'bash' }), 'Bash');
  assert.equal(toolName({ mcpServerName: 'hawkesgen', mcpToolName: 'run' }), 'mcp__hawkesgen__run');
});

test('a Copilot turn becomes init, text, a tool call and a successful result', () => {
  const s = fresh();
  const out = [
    { type: 'session.start', data: {} },
    { type: 'assistant.message_delta', data: { deltaContent: 'Hello ' } },
    { type: 'assistant.message_delta', data: { deltaContent: 'world' } },
    { type: 'assistant.message', data: { content: 'Hello world', toolRequests: [{ toolCallId: 't1', toolName: 'view', arguments: { path: 'a' } }] } },
  ].flatMap((e) => translate(s, e)).concat(finish(s, 0, ''));
  assert.equal(out[0].subtype, 'init');
  assert.ok(out.some((e) => e.type === 'assistant' && e.message.content[0].text === 'Hello world'));
  assert.ok(out.some((e) => e.type === 'assistant' && e.message.content[0].name === 'Read'));
  const r = out.at(-1);
  assert.equal(r.type, 'result');
  assert.equal(r.is_error, false);
});

test('a Copilot error becomes an error result the harness-stop patterns can read', () => {
  const s = fresh();
  translate(s, { type: 'session.error', data: { errorType: 'quota', message: 'You have no premium requests remaining' } });
  const r = finish(s, 1, '').at(-1);
  assert.equal(r.is_error, true);
  assert.match(r.result, /no premium requests/);
});

test('end to end against a stand-in copilot binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cop-'));
  const fake = path.join(dir, 'fake.mjs');
  fs.writeFileSync(fake, `const o=(type,data)=>console.log(JSON.stringify({type,data}));o('session.start',{});o('assistant.message',{content:'done',toolRequests:[]});`);
  const r = spawnSync(process.execPath, [path.resolve('bin/copilot-agent.mjs'), '-p', 'hi', '--output-format', 'stream-json'], { env: { ...process.env, COPILOT_BIN: fake }, encoding: 'utf8', shell: false });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).type, 'result');
  assert.equal(lines.at(-1).result, 'done');
  assert.equal(lines.at(-1).is_error, false);
});
