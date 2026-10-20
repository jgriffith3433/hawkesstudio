// The Google Antigravity harness in front of Studio's Claude Code arguments (the same idea as copilot-agent.mjs and
// gemini-agent.mjs). Talk, agents, scouts and the probes keep passing `claude -p` flags and reading Claude's
// stream-json. This process runs the Antigravity CLI (`agy -p --output-format stream-json`, signed in with the Google
// AI Pro/Ultra account) and rewrites its events (init, step_update, result) into that stream.
//
// The event shapes below were recorded from real agy 1.4.3 runs (see test/antigravity-agent.test.ts): text arrives as
// `text_delta` on agent_response steps; a tool is one `step_type: "tool"` step, ACTIVE with its parameters and DONE with
// its output (or error); the turn ends with a `result` whose status is SUCCESS or an error.
//
// One-shot: the prompt is the -p argument. A call keeps this process up and writes one stream-json user message per
// turn on stdin; each turn is an `agy` run on the same conversation (the id agy gave on the first turn, --conversation).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseClaudeArgs, promptWith } from './copilot-agent.mjs';

export { parseClaudeArgs, promptWith };

export function agyBin() {
  const home = process.env.HOME || os.homedir();
  const found = [process.env.AGY_BIN, '/usr/local/bin/agy', '/usr/bin/agy', path.join(home, '.local', 'bin', 'agy'), '/home/hawkes/.local/bin/agy',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')].find((p) => p && fs.existsSync(p));
  return found || 'agy';
}

/** `agy models` slugs look like gemini-4-argon-medium or claude-sonnet-5-5-high; Claude Code's own ids (claude-sonnet-5-5) have no level and mean nothing here. */
const SLUG = /^(gemini|claude|gpt)-[\w.-]*-(low|medium|high)$/i;
export function agyModel(model, env = process.env) {
  for (const m of [model, env.AGY_MODEL]) if (m && SLUG.test(String(m).trim())) return String(m).trim();
  return '';
}

export function agyArgs(parsed, prompt, conversation) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
  if (conversation) args.push('--conversation', conversation);
  const model = agyModel(parsed.model);
  if (model) args.push('--model', model);
  return args;
}

/** Claude's MCP config ({mcpServers: {name: {type, url, headers | command, args, env}}}) in agy's shape (serverUrl for remote servers). */
export function agyMcpServers(config) {
  const out = {};
  for (const [name, s] of Object.entries(config?.mcpServers ?? {})) {
    if (!s || typeof s !== 'object') continue;
    if (s.url) out[name] = { serverUrl: s.url, ...(s.headers ? { headers: s.headers } : {}) };
    else if (s.command) out[name] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) };
  }
  return out;
}

const TOOL_NAMES = {
  run_command: 'Bash', send_command_input: 'Bash', command_status: 'Bash',
  view_file: 'Read', read_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit', sed_file: 'Edit',
  grep_search: 'Grep', find_by_name: 'Glob', list_dir: 'Glob', read_url_content: 'WebFetch', search_web: 'WebSearch',
};
/** agy's tool names (and its call_mcp_tool wrapper) in Claude Code's (the dashboard and the gen-usage check read these). */
export function toolName(name, parameters) {
  const n = String(name ?? 'tool');
  if (n === 'call_mcp_tool' && parameters?.ServerName && parameters?.ToolName) return `mcp__${parameters.ServerName}__${parameters.ToolName}`;
  return TOOL_NAMES[n] ?? n;
}
const toolInput = (name, p = {}) => (name === 'call_mcp_tool' && p.Arguments && typeof p.Arguments === 'object' ? p.Arguments : p);

/** One agy event in, zero or more Claude Code events out. Unknown events are ignored. */
export function translate(state, event) {
  const out = [];
  const kind = String(event?.event ?? '');
  const init = () => {
    if (state.inited) return;
    state.inited = true;
    out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: state.model });
  };
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
  if (kind === 'init') {
    if (event.conversation_id) state.session = String(event.conversation_id);
    state.model = event.init?.model ?? state.model;
    init();
    return out;
  }
  init();
  if (kind === 'step_update') {
    const s = event.step_update ?? {};
    if (s.conversation_id && !state.session) state.session = String(s.conversation_id);
    if (s.step_type === 'agent_response' && typeof s.text_delta === 'string' && s.text_delta) {
      if (!state.started) {
        out.push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
        state.started = true;
      }
      state.text += s.text_delta;
      out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: s.text_delta } } });
    } else if (s.step_type === 'tool') {
      const info = s.tool_info ?? {};
      const id = `agy-${s.conversation_id ?? state.session}-${s.step_index}`;
      const raw = info.name ?? s.tool_name;
      if (!state.seen.has(id)) {
        state.seen.add(id);
        flush();
        out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName(raw, info.parameters), input: toolInput(raw, info.parameters) }] } });
      }
      if (s.state === 'DONE') {
        const failed = Boolean(info.error);
        const body = failed ? (info.error.message ?? JSON.stringify(info.error)) : (info.output ?? '');
        out.push({ type: 'user', session_id: state.session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: String(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 4000) }] } });
      }
    }
    return out;
  }
  if (kind === 'result') {
    const r = event.result ?? {};
    if (r.conversation_id && !state.session) state.session = String(r.conversation_id);
    if (r.status && r.status !== 'SUCCESS') state.error = String(r.error || `agy ${r.status}`).slice(0, 600);
    else if (r.error) state.error = String(r.error).slice(0, 600);
    if (r.response && !state.text && !state.last) state.last = String(r.response);
    if (r.usage) state.usage = r.usage;
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
  const result = failed ? [state.error, tail].filter(Boolean).join('\n') || `agy exited with ${code}` : (state.last || '');
  const usage = state.usage ? { input_tokens: state.usage.input_tokens ?? 0, output_tokens: state.usage.output_tokens ?? 0, cache_read_input_tokens: state.usage.cache_read_tokens ?? 0 } : undefined;
  out.push({ type: 'result', subtype: state.capped ? 'error_max_turns' : failed ? 'error' : 'success', is_error: failed, result: String(result).slice(0, 4000), session_id: state.session, duration_ms: Date.now() - state.began, total_cost_usd: 0, ...(usage ? { usage } : {}) });
  return out;
}

let current = null;
const written = [];

/**
 * agy reads MCP servers from <workspace>/.agents/mcp_config.json (checked against a real MCP call). The file holds Gen's
 * and Studio's keys, so it is kept out of git (info/exclude) and removed when the run ends.
 */
function writeMcp(parsed) {
  if (!parsed.mcp || !fs.existsSync(parsed.mcp)) return;
  let servers;
  try { servers = agyMcpServers(JSON.parse(fs.readFileSync(parsed.mcp, 'utf8'))); } catch { return; }
  if (!Object.keys(servers).length) return;
  const dir = path.join(process.cwd(), '.agents');
  const file = path.join(dir, 'mcp_config.json');
  const had = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const madeDir = !fs.existsSync(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    try {
      const ex = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const exFile = path.resolve(process.cwd(), ex);
      const cur = fs.existsSync(exFile) ? fs.readFileSync(exFile, 'utf8') : '';
      if (!cur.includes('.agents/mcp_config.json')) { fs.mkdirSync(path.dirname(exFile), { recursive: true }); fs.appendFileSync(exFile, `${cur && !cur.endsWith('\n') ? '\n' : ''}.agents/mcp_config.json\n`); }
    } catch { /* not a git folder */ }
  } catch { return; }
  written.push({ file, dir, had, madeDir });
}
function cleanup() {
  for (const w of written.splice(0)) {
    try { if (w.had) fs.writeFileSync(w.file, w.had); else fs.unlinkSync(w.file); } catch { /* already gone */ }
    try { if (w.madeDir) fs.rmdirSync(w.dir); } catch { /* not empty */ }
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { current?.kill('SIGTERM'); cleanup(); process.exit(143); });

function runAgent(parsed, prompt, conversation, fresh) {
  const state = { session: conversation || '', text: '', started: false, began: Date.now(), error: '', turns: 0, capped: false, seen: new Set() };
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      writeMcp(parsed);
      child = spawn(agyBin(), agyArgs(parsed, promptWith(parsed, prompt, fresh), conversation), {
        cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      for (const ev of finish(state, 1, `couldn't start agy: ${e.message}`)) process.stdout.write(`${JSON.stringify(ev)}\n`);
      return resolve({ code: 1, session: state.session });
    }
    current = child;
    let buf = '';
    const feed = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      // The role's turn cap (--max-turns): one tool step is a turn. Claude Code ends such a run with error_max_turns.
      const s = ev?.step_update;
      if (s?.step_type === 'tool' && s.state === 'ACTIVE' && parsed.maxTurns > 0 && ++state.turns > parsed.maxTurns && !state.capped) {
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
    child.on('error', (e) => { stderr += `couldn't start agy: ${e.message}`; });
    child.on('close', (code) => {
      feed(buf);
      current = null;
      if (!state.inited) process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session })}\n`);
      for (const o of finish(state, code ?? 1, stderr)) process.stdout.write(`${JSON.stringify(o)}\n`);
      resolve({ code: code ?? 1, session: state.session });
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
    const { code } = await runAgent(parsed, parsed.prompt, parsed.resume || '', !parsed.resume);
    process.exit(code);
  }
  let conversation = parsed.resume || '';
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
    const r = await runAgent(parsed, prompt, conversation, fresh);
    if (r.session) conversation = r.session;
    fresh = false;
  }
}

function fileURL(u) { return new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURL(import.meta.url));
if (isMain) main();
