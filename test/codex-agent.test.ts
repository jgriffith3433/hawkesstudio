// The OpenAI Codex adapter (bin/codex-agent.mjs): Claude Code's argv in, `codex exec --json` flags out, Codex's JSONL
// events back as Claude's stream-json; and Codex's own limit and sign-in wordings hold the provider (brains.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: a plain .mjs
import { parseClaudeArgs, codexArgs, codexModel, mcpToml, promptWith, translate, finish } from '../bin/codex-agent.mjs';
import { harnessStopOf } from '../src/brains.ts';

const fresh = (o = {}) => ({ session: '', text: '', began: Date.now(), error: '', warning: '', turns: 0, capped: false, announced: new Set(), partial: false, inited: false, last: '', usage: null, model: '', ...o });

test('models: Claude ids drop, "<model>:<effort>" splits, the role effort fills in', () => {
  delete process.env.CODEX_MODEL;
  assert.deepEqual(codexModel('claude-opus-5-5', 'high'), { model: '', effort: 'high' });
  assert.deepEqual(codexModel('opus', ''), { model: '', effort: '' });
  assert.deepEqual(codexModel(':low', 'high'), { model: '', effort: 'low' }, "the tier's effort wins over the role's");
  assert.deepEqual(codexModel('gpt-5.5:xhigh', ''), { model: 'gpt-5.5', effort: 'xhigh' });
  assert.deepEqual(codexModel('', 'max'), { model: '', effort: 'xhigh' }, 'max is Codex\'s xhigh');
});

test('argv: a fresh exec or a resume, the prompt on stdin, never a sandbox prompt', () => {
  const p = parseClaudeArgs(['node', 'x', '-p', 'fix it', '--model', 'gpt-5.5:high', '--append-system-prompt', 'You are the fixer.', '--max-turns', '40', '--allowedTools', 'Read']);
  assert.equal(p.prompt, 'fix it');
  assert.equal(p.maxTurns, 40);
  const a = codexArgs(p);
  assert.deepEqual(a.slice(0, 2), ['exec', '--json']);
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox') && a.includes('--skip-git-repo-check'));
  assert.deepEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2), ['-m', 'gpt-5.5']);
  assert.ok(a.includes('model_reasoning_effort="high"'));
  assert.equal(a.at(-1), '-');
  const r = codexArgs(p, { resume: 'th_1', profile: 'studio-1' });
  assert.deepEqual(r.slice(0, 3), ['exec', 'resume', 'th_1']);
  assert.deepEqual(r.slice(r.indexOf('-p'), r.indexOf('-p') + 2), ['-p', 'studio-1']);
  assert.match(promptWith(p, 'fix it', true), /^You are the fixer\.\n\n---\n\nfix it$/);
  assert.equal(promptWith(p, 'go on', false), 'go on', 'a resumed thread has the role already');
});

test("Claude's MCP servers become Codex's config tables", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-')), 'mcp.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { studio: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } }, 'gen-tools': { command: 'node', args: ['gen.mjs'], env: { A: '1' } } } }));
  const t = mcpToml(f);
  assert.match(t, /\[mcp_servers\.studio\]\nurl = "http:\/\/127\.0\.0\.1:1\/mcp"\nhttp_headers = \{ Authorization = "Bearer x" \}/);
  assert.match(t, /\[mcp_servers\.gen-tools\]\ncommand = "node"\nargs = \["gen\.mjs"\]\nenv = \{ A = "1" \}/);
  assert.equal(mcpToml(path.join(path.dirname(f), 'none.json')), '');
});

test('events: a command, a file edit, the answer and usage come back as Claude Code stream-json', () => {
  const s = fresh();
  const out = [
    { type: 'thread.started', thread_id: 'th_9' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Fixed the button.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } },
  ].flatMap((e) => translate(s, e));
  assert.equal(out[0].type, 'system');
  assert.equal(out[0].session_id, 'th_9');
  const uses = out.filter((m) => m.type === 'assistant' && m.message.content[0].type === 'tool_use').map((m) => m.message.content[0].name);
  assert.deepEqual(uses, ['Bash', 'Edit'], 'one tool_use per item, not one per event');
  assert.equal(out.filter((m) => m.type === 'user').length, 2);
  const [res] = finish(s, 0, '');
  assert.equal(res.subtype, 'success');
  assert.equal(res.result, 'Fixed the button.');
  assert.equal(res.session_id, 'th_9');
  assert.equal(res.usage.output_tokens, 3);
});

test('a usage limit or a lost sign-in ends as an error result the hold reads', () => {
  const s = fresh();
  translate(s, { type: 'thread.started', thread_id: 'th_2' });
  translate(s, { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 3 hours 20 minutes." } });
  const [res] = finish(s, 1, '');
  assert.equal(res.is_error, true);
  const now = Date.now();
  const stop = harnessStopOf(res.result, { now });
  assert.equal(stop?.kind, 'usage');
  assert.equal(stop?.resetsAt, now + 200 * 60_000);
  assert.equal(harnessStopOf('try again at 3:45 PM after you hit your usage limit')?.kind, 'usage');
  assert.equal(harnessStopOf('Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.')?.kind, 'auth');
  // A game's own OpenAI API key is not Codex stopping.
  assert.equal(harnessStopOf("The game's OpenAI API key hit its usage limit"), null);
});
