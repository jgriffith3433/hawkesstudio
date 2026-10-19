// The Cursor harness in front of Studio's Claude Code arguments. Talk, agents and scouts keep passing
// `claude -p` flags and reading Claude's stream-json. This process runs Cursor's `agent` (the Cursor plan,
// CURSOR_API_KEY) and rewrites its events into that stream. It is not the xAI API.
//
// One-shot: the prompt is the -p argument. A call keeps this process up and writes one stream-json user
// message per turn on stdin; each turn is an `agent` run, resumed on the session the previous turn returned.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const TOOLS = {
  readToolCall: 'Read', writeToolCall: 'Write', editToolCall: 'Edit', grepToolCall: 'Grep', globToolCall: 'Glob',
  shellToolCall: 'Bash', deleteToolCall: 'Delete', lsToolCall: 'Glob',
};

export function agentBin() {
  const home = process.env.HOME || os.homedir();
  const found = [process.env.CURSOR_AGENT, '/usr/local/bin/agent', path.join(home, '.local', 'bin', 'agent'), '/home/hawkes/.local/bin/agent']
    .find((p) => p && fs.existsSync(p));
  return found || 'agent';
}

/** Claude Code's argv, as Studio builds it, reduced to what Cursor needs. */
export function parseClaudeArgs(argv) {
  const out = { prompt: '', model: '', resume: '', system: '', plugins: [], mcp: '', streamIn: false, partial: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i] ?? '';
    if (a === '-p' || a === '--print') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) out.prompt = next();
    } else if (a === '--model') out.model = next();
    else if (a === '--resume') out.resume = next();
    else if (a === '--append-system-prompt' || a === '--system-prompt') out.system = next();
    else if (a === '--plugin-dir') out.plugins.push(next());
    else if (a === '--mcp-config') out.mcp = next();
    else if (a === '--input-format') out.streamIn = next() === 'stream-json';
    else if (a === '--include-partial-messages') out.partial = true;
    else if (a === '--output-format') next();
  }
  return out;
}

export function cursorArgs(parsed, prompt, resume) {
  const args = ['-p', '--output-format', 'stream-json', '--force', '--trust', '--approve-mcps'];
  if (parsed.partial) args.push('--stream-partial-output');
  if (parsed.model) args.push('--model', parsed.model);
  if (resume) args.push('--resume', resume);
  for (const dir of parsed.plugins) if (dir && fs.existsSync(dir)) args.push('--plugin-dir', dir);
  const text = parsed.system && !resume ? `${parsed.system}\n\n${prompt}` : prompt;
  args.push(text);
  return args;
}

function toolOf(call) {
  if (!call || typeof call !== 'object') return null;
  for (const [key, name] of Object.entries(TOOLS)) {
    if (call[key]) return { name, input: call[key].args ?? {} };
  }
  const fn = call.function;
  if (fn?.name) {
    let input = fn.arguments ?? {};
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { arguments: input }; } }
    return { name: fn.name, input };
  }
  return null;
}

function textOf(message) {
  return (message?.content ?? []).filter((p) => p?.type === 'text' && p.text).map((p) => p.text).join('');
}

/**
 * One Cursor event in, zero or more Claude Code events out. `state` carries the text of the current
 * message so a tool call and the final result close it.
 */
export function translate(state, event) {
  const out = [];
  const sid = event?.session_id || state.session || undefined;
  if (sid) state.session = sid;
  const emitText = () => {
    if (!state.text) return;
    if (state.started) out.push({ type: 'stream_event', event: { type: 'content_block_stop' } });
    out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'text', text: state.text }] } });
    state.text = '';
    state.started = false;
  };
  if (event?.type === 'system' && event.subtype === 'init') {
    out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: event.model });
    return out;
  }
  if (event?.type === 'assistant') {
    const delta = event.timestamp_ms != null && event.model_call_id == null;
    if (!delta) return out;
    const text = textOf(event.message);
    if (!text) return out;
    if (!state.started) {
      out.push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
      state.started = true;
    }
    state.text += text;
    out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    return out;
  }
  if (event?.type === 'tool_call' && event.subtype === 'started') {
    emitText();
    const tool = toolOf(event.tool_call);
    if (tool) out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'tool_use', name: tool.name, input: tool.input }] } });
    return out;
  }
  if (event?.type === 'result') {
    emitText();
    out.push({
      type: 'result', subtype: event.subtype ?? (event.is_error ? 'error' : 'success'), is_error: Boolean(event.is_error),
      result: event.result ?? '', session_id: state.session, duration_ms: event.duration_ms, total_cost_usd: 0,
    });
  }
  return out;
}

function mcpEnv(file) {
  if (!file || !fs.existsSync(file)) return {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-cursor-'));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.copyFileSync(file, path.join(home, '.cursor', 'mcp.json'));
  return { HOME: home };
}

let current = null;
function runAgent(parsed, prompt, resume) {
  const state = { session: resume || '', text: '', started: false };
  return new Promise((resolve) => {
    const child = spawn(agentBin(), cursorArgs(parsed, prompt, resume), {
      cwd: process.cwd(), env: { ...process.env, ...mcpEnv(parsed.mcp) }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    });
    current = child;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          for (const ev of translate(state, JSON.parse(line))) process.stdout.write(`${JSON.stringify(ev)}\n`);
        } catch { /* a banner line is not an event */ }
      }
    });
    child.on('close', (code) => resolve({ code: code ?? 1, session: state.session }));
  });
}

function userText(message) {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
  return '';
}

async function main() {
  const parsed = parseClaudeArgs(process.argv);
  if (!parsed.streamIn) {
    const { code } = await runAgent(parsed, parsed.prompt, parsed.resume);
    process.exit(code);
  }
  let resume = parsed.resume;
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type === 'control_request') {
      current?.kill('SIGTERM');
      continue;
    }
    if (message.type !== 'user') continue;
    const prompt = userText(message);
    if (!prompt) continue;
    const { session } = await runAgent(parsed, prompt, resume);
    if (session) resume = session;
  }
}

function fileURL(u) { return new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURL(import.meta.url));
if (isMain) main();
