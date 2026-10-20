import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain ESM
import { agyModel, agyArgs, agyMcpServers, toolName, translate, finish, seedCreds } from '../bin/antigravity-agent.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('AGY_CREDS seeds the login file, keeps agy\'s refreshed one, and replaces it after a new sign-in', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  const creds = Buffer.from(JSON.stringify({ token: { refresh_token: 'r' } })).toString('base64');
  assert.equal(seedCreds({ AGY_CREDS: creds }, home), true);
  const file = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  assert.match(fs.readFileSync(file, 'utf8'), /refresh_token/);
  assert.equal(seedCreds({ AGY_CREDS: creds }, home), false);
  // agy refreshed its access token: same refresh token, kept.
  fs.writeFileSync(file, JSON.stringify({ token: { refresh_token: 'r', access_token: 'newer' } }));
  assert.equal(seedCreds({ AGY_CREDS: creds }, home), false);
  assert.match(fs.readFileSync(file, 'utf8'), /newer/);
  // J signed in again: a new refresh token replaces it.
  assert.equal(seedCreds({ AGY_CREDS: Buffer.from(JSON.stringify({ token: { refresh_token: 'r2' } })).toString('base64') }, home), true);
  assert.match(fs.readFileSync(file, 'utf8'), /r2/);
  assert.equal(seedCreds({ AGY_CREDS: 'bm90anNvbg==' }, fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'))), false);
  assert.equal(seedCreds({}, home), false);
});

const fresh = () => ({ seen: new Set(), text: '', last: '', began: Date.now() });
const run = (events: any[]) => {
  const s: any = fresh();
  const out: any[] = [];
  for (const e of events) out.push(...translate(s, e));
  out.push(...finish(s, 0, ''));
  return { s, out };
};

test('agyModel keeps agy slugs and drops Claude Code ids', () => {
  assert.equal(agyModel('gemini-4-argon-high', {}), 'gemini-4-argon-high');
  assert.equal(agyModel('claude-sonnet-5-5', {}), '');
  assert.equal(agyModel('claude-sonnet-5-5', { AGY_MODEL: 'claude-opus-5-5-low' }), 'claude-opus-5-5-low');
});

test('agyArgs is headless, auto-approving and resumes a conversation', () => {
  const a = agyArgs({ model: 'gemini-3.8-flash-low' }, 'hi', 'c1');
  assert.deepEqual(a.slice(0, 2), ['-p', 'hi']);
  assert.ok(a.includes('--dangerously-skip-permissions'));
  assert.equal(a[a.indexOf('--conversation') + 1], 'c1');
  assert.equal(a[a.indexOf('--model') + 1], 'gemini-3.8-flash-low');
});

test('MCP config converts to agy shape', () => {
  const m = agyMcpServers({ mcpServers: { g: { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } }, s: { command: 'node', args: ['a.js'], env: { K: 'v' } } } });
  assert.deepEqual(m.g, { serverUrl: 'https://x/mcp', headers: { A: 'b' } });
  assert.deepEqual(m.s, { command: 'node', args: ['a.js'], env: { K: 'v' } });
});

test('tool names map to Claude Code names', () => {
  assert.equal(toolName('run_command'), 'Bash');
  assert.equal(toolName('read_file'), 'Read');
  assert.equal(toolName('call_mcp_tool', { ServerName: 'hawkesgen', ToolName: 'hawkesgen_run' }), 'mcp__hawkesgen__hawkesgen_run');
});

test('a plain reply streams text and ends in success', () => {
  const { out } = run([
    { event: 'init', conversation_id: 'c', init: {} },
    { event: 'step_update', step_update: { conversation_id: 'c', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'pong' } },
    { event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'pong\n', usage: { input_tokens: 5, output_tokens: 1 } } },
  ]);
  const r = out.at(-1);
  assert.equal(r.subtype, 'success');
  assert.equal(r.result, 'pong');
  assert.equal(r.session_id, 'c');
});

test('tool steps become tool_use then tool_result, once each', () => {
  const step = (state: string, extra: any) => ({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 2, step_type: 'tool', state, ...extra } });
  const { out } = run([
    { event: 'init', conversation_id: 'c', init: {} },
    step('ACTIVE', { tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } } }),
    step('DONE', { tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi' } }),
    { event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'done' } },
  ]);
  const uses = out.filter((e) => e.message?.content?.[0]?.type === 'tool_use');
  const results = out.filter((e) => e.message?.content?.[0]?.type === 'tool_result');
  assert.equal(uses.length, 1);
  assert.equal(uses[0].message.content[0].name, 'Bash');
  assert.equal(results.length, 1);
  assert.equal(results[0].message.content[0].is_error, false);
});

test('an agy error result carries the message so the harness stop can read it', () => {
  const { out } = run([{ event: 'result', result: { status: 'ERROR', error: 'authentication failed or timed out' } }]);
  const r = out.at(-1);
  assert.equal(r.is_error, true);
  assert.match(r.result, /authentication failed or timed out/);
});
