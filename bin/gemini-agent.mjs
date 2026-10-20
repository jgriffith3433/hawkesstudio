// The Google Gemini harness in front of Studio's Claude Code arguments (the same idea as copilot-agent.mjs). Talk,
// agents, scouts and the probes keep passing `claude -p` flags and reading Claude's stream-json. This process runs the
// Gemini CLI (`gemini -p -o stream-json`: a Google AI Ultra/Pro sign-in cached in ~/.gemini/oauth_creds.json, or
// GEMINI_API_KEY) and rewrites its JSONL events into that stream.
//
// The event schema is the CLI's documented one (init, message, tool_use, tool_result, error, result). It is covered by
// fixtures in test/gemini-agent.test.ts, not yet by a recorded real run.
//
// One-shot: the prompt is the -p argument. A call keeps this process up and writes one stream-json user message per
// turn on stdin; each turn is a `gemini` run on the same session id (first --session-id, then --resume).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { unshim as unshimCopilot, parseClaudeArgs, promptWith } from './copilot-agent.mjs';

export { parseClaudeArgs, promptWith };

export function geminiBin() {
  const home = process.env.HOME || os.homedir();
  const found = [process.env.GEMINI_BIN, '/usr/local/bin/gemini', '/usr/bin/gemini', path.join(home, '.local', 'bin', 'gemini'), '/home/hawkes/.local/bin/gemini']
    .find((p) => p && fs.existsSync(p));
  return unshim(found || 'gemini');
}

/** On Windows npm installs a gemini.cmd shim: run the package's bundled loader with node instead. */
export function unshim(bin) {
  if (process.platform !== 'win32') return bin;
  const dirs = /[\\/]/.test(bin) ? [path.dirname(bin)] : String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const loader = path.join(d, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    if (fs.existsSync(loader) && (/[\\/]/.test(bin) ? /\.(cmd|bat|ps1)$/i.test(bin) : fs.existsSync(path.join(d, 'gemini.cmd')))) return loader;
  }
  return unshimCopilot(bin);
}

/**
 * Claude Code's model ids and aliases mean nothing to Gemini. Its own names (gemini-2.5-pro, pro, flash, flash-lite)
 * pass through; anything else is dropped so the CLI's Auto routing (or GEMINI_MODEL) answers.
 */
export function geminiModel(model) {
  const m = String(model || process.env.GEMINI_MODEL || '').trim();
  if (/^(auto|pro|flash|flash-lite)$/i.test(m) || /^(gemini|auto-gemini)-/i.test(m)) return m;
  const env = String(process.env.GEMINI_MODEL || '').trim();
  return /^(auto|pro|flash|flash-lite)$/i.test(env) || /^(gemini|auto-gemini)-/i.test(env) ? env : '';
}

export function geminiArgs(parsed, prompt, session, fresh) {
  const args = ['-p', prompt, '-o', 'stream-json', '--approval-mode', 'yolo', '--skip-trust', ...(fresh ? ['--session-id', session] : ['--resume', session])];
  const model = geminiModel(parsed.model);
  if (model && model !== 'auto') args.push('-m', model);
  return args;
}

/** Claude's MCP config ({mcpServers: {name: {type, url, headers | command, args, env}}}) in Gemini's settings shape. */
export function geminiMcpServers(config) {
  const out = {};
  for (const [name, s] of Object.entries(config?.mcpServers ?? {})) {
    if (!s || typeof s !== 'object') continue;
    if (s.url) out[name] = { [/sse/i.test(String(s.type)) ? 'url' : 'httpUrl']: s.url, ...(s.headers ? { headers: s.headers } : {}), trust: true };
    else if (s.command) out[name] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}), trust: true };
  }
  return out;
}

/**
 * A system settings file for this run (GEMINI_CLI_SYSTEM_SETTINGS_PATH outranks the user's and the project's):
 * the MCP servers Studio asked for, AGENTS.md as context, and the auth type, so a headless run never asks.
 */
export function systemSettings(parsed, env = process.env) {
  let mcpServers = {};
  if (parsed.mcp && fs.existsSync(parsed.mcp)) {
    try { mcpServers = geminiMcpServers(JSON.parse(fs.readFileSync(parsed.mcp, 'utf8'))); } catch { /* an unreadable config means no MCP */ }
  }
  const type = env.GEMINI_API_KEY ? 'gemini-api-key' : env.GOOGLE_GENAI_USE_VERTEXAI ? 'vertex-ai' : 'oauth-personal';
  return { security: { auth: { selectedType: type } }, context: { fileName: ['AGENTS.md', 'GEMINI.md'] }, mcpServers, general: { enableAutoUpdate: false } };
}

/** A headless server has no browser to sign in with: GEMINI_OAUTH_CREDS holds the oauth_creds.json text, as base64 (env files and JSON quotes don't mix). */
export function seedCreds(env = process.env) {
  if (!env.GEMINI_OAUTH_CREDS) return;
  const raw = env.GEMINI_OAUTH_CREDS.trim();
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const dir = path.join(env.GEMINI_CLI_HOME || env.HOME || os.homedir(), '.gemini');
  const file = path.join(dir, 'oauth_creds.json');
  if (fs.existsSync(file)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  } catch { /* the run reports the missing sign-in itself */ }
}

const TOOL_NAMES = {
  read_file: 'Read', read_many_files: 'Read', list_directory: 'Glob', glob: 'Glob', write_file: 'Write', replace: 'Edit',
  run_shell_command: 'Bash', search_file_content: 'Grep', grep_search: 'Grep', web_fetch: 'WebFetch', google_web_search: 'WebSearch',
};
/** Gemini's tool names in Claude Code's (the dashboard and the gen-usage check read these). */
export function toolName(name) {
  const n = String(name ?? 'tool');
  if (TOOL_NAMES[n]) return TOOL_NAMES[n];
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(n);
  if (mcp) return `mcp__${mcp[1]}__${mcp[2]}`;
  const dbl = /^([^_.:]+)(?:__|\.|:)(.+)$/.exec(n);
  return dbl ? `mcp__${dbl[1]}__${dbl[2]}` : n;
}

/** One Gemini event in, zero or more Claude Code events out. Unknown events are ignored. */
export function translate(state, event) {
  const out = [];
  const type = String(event?.type ?? '');
  const closeText = () => {
    if (state.started) out.push({ type: 'stream_event', event: { type: 'content_block_stop' } });
    state.started = false;
  };
  const flush = () => {
    closeText();
    if (!state.text) return;
    out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'text', text: state.text }] } });
    state.last = state.text;
    state.text = '';
  };
  if (type === 'init') {
    if (event.session_id && !state.sessionLocked) state.session = String(event.session_id);
    state.model = event.model ?? state.model;
    if (!state.inited) {
      state.inited = true;
      out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: state.model });
    }
    return out;
  }
  if (!state.inited) {
    state.inited = true;
    out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: state.model });
  }
  if (type === 'message') {
    if (event.role !== 'assistant') return out;
    const text = String(event.content ?? '');
    if (!text) return out;
    if (!state.started) {
      out.push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
      state.started = true;
    }
    state.text += text;
    out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    return out;
  }
  if (type === 'tool_use') {
    flush();
    out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'tool_use', id: event.tool_id, name: toolName(event.tool_name), input: event.parameters ?? {} }] } });
    return out;
  }
  if (type === 'tool_result') {
    const failed = event.status === 'error';
    const content = failed ? (event.error?.message ?? event.error ?? 'error') : (event.output ?? '');
    out.push({ type: 'user', session_id: state.session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: event.tool_id, is_error: failed, content: String(typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 4000) }] } });
    return out;
  }
  if (type === 'error') {
    // Warnings (a retry, a loop notice) are noise; an error is what the run died of.
    if (event.severity !== 'warning') state.error = String(event.message ?? JSON.stringify(event)).slice(0, 600);
    return out;
  }
  if (type === 'result') {
    if (event.status === 'error') state.error = [event.error?.type, event.error?.message].filter(Boolean).join(' ') || state.error || 'gemini failed';
    if (event.stats) state.stats = event.stats;
    state.done = true;
    return out;
  }
  return out;
}

/** The closing `result` Claude Code's stream ends with: the last text, or the error (so harnessStopOf can classify it). */
export function finish(state, code, stderr) {
  const out = [];
  if (state.text) {
    if (state.started) out.push({ type: 'stream_event', event: { type: 'content_block_stop' } });
    out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'text', text: state.text }] } });
    state.last = state.text;
  }
  const failed = Boolean(state.error) || (code !== 0 && !state.capped);
  const tail = String(stderr || '').trim().split('\n').slice(-12).join('\n');
  // Exit 41 is "no auth method": the message is on stderr and the hold classifier reads it from here.
  const result = failed ? [state.error, tail || (code === 41 ? 'Please set an Auth method (gemini: sign in with Google, or set GEMINI_API_KEY)' : '')].filter(Boolean).join('\n') || `gemini exited with ${code}` : (state.last || '');
  const usage = state.stats ? { input_tokens: state.stats.input_tokens ?? state.stats.input ?? 0, output_tokens: state.stats.output_tokens ?? 0 } : undefined;
  out.push({ type: 'result', subtype: state.capped ? 'error_max_turns' : failed ? 'error' : 'success', is_error: failed, result: String(result).slice(0, 4000), session_id: state.session, duration_ms: Date.now() - state.began, total_cost_usd: 0, ...(usage ? { usage } : {}) });
  return out;
}

let current = null;
let settingsFile = '';
function settingsPath(parsed) {
  if (!settingsFile) {
    settingsFile = path.join(os.tmpdir(), `gemini-settings-${process.pid}-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(settingsFile, JSON.stringify(systemSettings(parsed)), { mode: 0o600 });
    process.on('exit', () => { try { fs.unlinkSync(settingsFile); } catch { /* already gone */ } });
  }
  return settingsFile;
}

function runAgent(parsed, prompt, session, fresh) {
  const state = { session, sessionLocked: true, text: '', started: false, began: Date.now(), error: '', turns: 0, capped: false };
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      seedCreds();
      const bin = geminiBin();
      const script = /\.(mjs|cjs|js)$/i.test(bin);
      const argv = geminiArgs(parsed, promptWith(parsed, prompt, fresh), session, fresh);
      child = spawn(script ? process.execPath : bin, [...(script ? [bin] : []), ...argv], {
        cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1', GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath(parsed) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      for (const ev of finish(state, 1, `couldn't start gemini: ${e.message}`)) process.stdout.write(`${JSON.stringify(ev)}\n`);
      return resolve({ code: 1, session });
    }
    current = child;
    let buf = '';
    const feed = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      // The role's turn cap (--max-turns): one assistant tool round is a turn. Claude Code ends such a run with error_max_turns.
      if (ev?.type === 'tool_use' && parsed.maxTurns > 0 && ++state.turns > parsed.maxTurns && !state.capped) {
        state.capped = true;
        child.kill('SIGTERM');
      }
      if (state.capped) return;
      for (const o of translate(state, ev)) process.stdout.write(`${JSON.stringify(o)}\n`);
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('error', (e) => { stderr += `couldn't start gemini: ${e.message}`; });
    child.on('close', (code) => {
      feed(buf);
      current = null;
      if (!state.inited) process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: session })}\n`);
      for (const o of finish(state, code ?? 1, stderr)) process.stdout.write(`${JSON.stringify(o)}\n`);
      resolve({ code: code ?? 1, session });
    });
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
    const { code } = await runAgent(parsed, parsed.prompt, parsed.resume || randomUUID(), !parsed.resume);
    process.exit(code);
  }
  const session = parsed.resume || randomUUID();
  let fresh = !parsed.resume;
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
    await runAgent(parsed, prompt, session, fresh);
    fresh = false;
  }
}

function fileURL(u) { return new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURL(import.meta.url));
if (isMain) main();
