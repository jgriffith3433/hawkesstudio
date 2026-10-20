// The Gemini adapter: Claude Code's argv in, Gemini CLI flags out, Gemini's stream-json back as Claude's stream-json.
// Events are fixtures from the CLI's documented schema, not a recorded run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeArgs, geminiArgs, geminiModel, geminiMcpServers, systemSettings, translate, finish, toolName } from '../bin/gemini-agent.mjs';
import { harnessStopOf, resetTime } from '../src/brains.ts';

const fresh = () => ({ session: 's1', sessionLocked: true, text: '', started: false, began: Date.now(), error: '' });

test('Claude argv becomes Gemini flags', () => {
  const p = parseClaudeArgs(['node', 'x', '-p', 'do it', '--model', 'claude-opus-5-5', '--max-turns', '9']);
  const first = geminiArgs(p, 'do it', 'sid', true);
  assert.deepEqual(first.slice(0, 4), ['-p', 'do it', '-o', 'stream-json']);
  for (const f of ['--approval-mode', 'yolo', '--session-id', 'sid']) assert.ok(first.includes(f), f);
  assert.ok(!first.includes('-m'), 'a Claude model id is not sent to Gemini');
  const again = geminiArgs(p, 'more', 'sid', false);
  assert.ok(again.includes('--resume') && !again.includes('--session-id'));
});

test('model ids: Gemini names pass, Claude ids drop', () => {
  delete process.env.GEMINI_MODEL;
  assert.equal(geminiModel('flash'), 'flash');
  assert.equal(geminiModel('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(geminiModel('sonnet'), '');
  assert.equal(geminiModel('claude-sonnet-5-5'), '');
});

test('MCP servers and auth go into a system settings file', () => {
  const servers = geminiMcpServers({ mcpServers: { hawkesgen: { type: 'http', url: 'http://x/mcp', headers: { A: 'b' } }, local: { command: 'node', args: ['a'] } } });
  assert.equal(servers.hawkesgen.httpUrl, 'http://x/mcp');
  assert.equal(servers.local.command, 'node');
  assert.equal(systemSettings({ mcp: '' }, { GEMINI_API_KEY: 'k' } as any).security.auth.selectedType, 'gemini-api-key');
  assert.equal(systemSettings({ mcp: '' }, {} as any).security.auth.selectedType, 'oauth-personal');
});

test('tool names are Claude Code\'s', () => {
  assert.equal(toolName('read_file'), 'Read');
  assert.equal(toolName('run_shell_command'), 'Bash');
  assert.equal(toolName('mcp_hawkesgen_hawkesgen_run'), 'mcp__hawkesgen__hawkesgen_run');
});

test('a text turn with a tool call translates to Claude events', () => {
  const s = fresh();
  const out: any[] = [];
  for (const e of [
    { type: 'init', session_id: 'x', model: 'gemini-3-pro' },
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'message', role: 'assistant', content: 'Look', delta: true },
    { type: 'message', role: 'assistant', content: 'ing', delta: true },
    { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: 'a' } },
    { type: 'tool_result', tool_id: 't1', status: 'success', output: 'ok' },
    { type: 'message', role: 'assistant', content: 'Done', delta: true },
    { type: 'result', status: 'success', stats: { input_tokens: 5, output_tokens: 2 } },
  ]) out.push(...translate(s, e));
  out.push(...finish(s, 0, ''));
  assert.equal(out[0].subtype, 'init');
  const assistants = out.filter((o) => o.type === 'assistant');
  assert.equal(assistants[0].message.content[0].text, 'Looking');
  assert.equal(assistants[1].message.content[0].name, 'Read');
  const result = out.at(-1);
  assert.equal(result.subtype, 'success');
  assert.equal(result.result, 'Done');
  assert.equal(result.usage.input_tokens, 5);
});

test('errors reach the result so the hold classifier reads them', () => {
  const s = fresh();
  translate(s, { type: 'error', severity: 'warning', message: 'retrying' });
  translate(s, { type: 'result', status: 'error', error: { type: 'ApiError', message: 'RESOURCE_EXHAUSTED: You have exhausted your capacity. Your quota will reset after 3h45m12s.' } });
  const result = finish(s, 1, '').at(-1) as any;
  assert.equal(result.is_error, true);
  assert.equal(harnessStopOf(result.result)?.kind, 'usage');
  const auth = finish(fresh(), 41, '').at(-1) as any;
  assert.equal(harnessStopOf(auth.result)?.kind, 'auth');
});

test('a relative reset ("reset after 3h45m12s") is a wait from now', () => {
  const now = 1_000_000;
  assert.equal(resetTime('Your quota will reset after 3h45m12s.', now), now + (3 * 3600 + 45 * 60 + 12) * 1000);
  assert.equal(resetTime('quota will reset after 30s', now), now + 30_000);
});
