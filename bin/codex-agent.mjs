// The OpenAI Codex harness in front of Studio's Claude Code arguments (the same idea as copilot-agent.mjs). Talk, agents,
// scouts and the probes keep passing `claude -p` flags and reading Claude's stream-json. This process runs the Codex CLI
// (`codex exec --json`, on the ChatGPT plan it was signed in with: src/cli-signin.ts, CODEX_CREDS) and rewrites its JSONL
// events into that stream.
//
// One-shot: the prompt is the -p argument. A call keeps this process up and writes one stream-json user message per turn
// on stdin; each turn is a `codex exec` (the first) or `codex exec resume <thread>` (the rest) on the thread Codex named.
// Models: a tier's model may be "<model>", "<model>:<effort>" or ":<effort>" (the plan's default model at that reasoning
// effort: low, medium, high, xhigh), so each tier works on any ChatGPT plan without naming a model it may not have.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { seedLogin } from './ai-login-seed.mjs';
import { pluginBridge } from './plugin-bridge.mjs';

export function codexBin() {
  const home = process.env.HOME || os.homedir();
  const found = [process.env.CODEX_BIN, '/usr/local/bin/codex', '/usr/bin/codex', path.join(home, '.local', 'bin', 'codex')].find((p) => p && fs.existsSync(p));
  return found || 'codex';
}

/** Claude Code's argv, as Studio builds it, reduced to what Codex needs. */
export function parseClaudeArgs(argv) {
  const out = { prompt: '', model: '', resume: '', system: '', plugins: [], mcp: '', streamIn: false, partial: false, effort: '', maxTurns: 0 };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i] ?? '';
    if (a === '-p' || a === '--print') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) out.prompt = next();
    } else if (a === '--model') out.model = next();
    else if (a === '--resume') out.resume = next();
    else if (a === '--append-system-prompt' || a === '--system-prompt') out.system = next();
    else if (a === '--mcp-config') out.mcp = next();
    else if (a === '--input-format') out.streamIn = next() === 'stream-json';
    else if (a === '--include-partial-messages') out.partial = true;
    else if (a === '--effort') out.effort = next();
    else if (a === '--max-turns') out.maxTurns = Number(next()) || 0;
    else if (a === '--plugin-dir') out.plugins.push(next());
    else if (a === '--output-format' || a === '--allowedTools' || a === '--disallowedTools' || a === '--permission-mode' || a === '--tools' || a === '--setting-sources') next();
  }
  return out;
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
/** Claude's ids and aliases mean nothing to Codex: dropped. "<model>:<effort>" splits. Effort: the tier's, else the role's. */
export function codexModel(model, effort) {
  let m = String(model || process.env.CODEX_MODEL || '').trim();
  let e = '';
  const at = m.lastIndexOf(':');
  if (at >= 0) { e = m.slice(at + 1); m = m.slice(0, at); }
  if (/^(opus|sonnet|haiku|fable|auto|default)$/i.test(m) || /^claude-/i.test(m)) m = '';
  const role = String(effort || '').toLowerCase() === 'max' ? 'xhigh' : String(effort || '').toLowerCase();
  const pick = EFFORTS.has(e) ? e : EFFORTS.has(role) ? role : '';
  return { model: m, effort: pick };
}

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlVal = (v) => {
  if (Array.isArray(v)) return `[${v.map(tomlVal).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlVal(x)}`).join(', ')} }`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v ?? ''));
};

/** Claude Code's --mcp-config (its mcpServers) as Codex's config.toml tables. */
export function mcpToml(file) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return ''; }
  const lines = [];
  for (const [name, s] of Object.entries(cfg?.mcpServers ?? {})) {
    if (!s || typeof s !== 'object') continue;
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    if (s.url) {
      lines.push(`url = ${tomlVal(s.url)}`);
      if (s.headers && Object.keys(s.headers).length) lines.push(`http_headers = ${tomlVal(s.headers)}`);
    } else {
      lines.push(`command = ${tomlVal(s.command ?? '')}`);
      if (Array.isArray(s.args)) lines.push(`args = ${tomlVal(s.args)}`);
      if (s.env && Object.keys(s.env).length) lines.push(`env = ${tomlVal(s.env)}`);
    }
    // Past Gen's Cloud Run cold start (~45 s); Claude Code's default MCP connect was 30 s (CONNECT_TIMEOUT).
    lines.push('startup_timeout_sec = 90', 'tool_timeout_sec = 600', '');
  }
  return lines.join('\n');
}

/** Where Codex reads its login and config: CODEX_HOME, else ~/.codex. */
export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');

/** One `codex exec` (or `exec resume`). The prompt goes on stdin (`-`): no length limit, nothing in the process list. */
export function codexArgs(parsed, { resume = '', profile = '' } = {}) {
  const { model, effort } = codexModel(parsed.model, parsed.effort);
  const args = ['exec'];
  if (resume) args.push('resume', resume);
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-c', 'cli_auth_credentials_store="file"');
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (profile) args.push('-p', profile);
  args.push('-');
  return args;
}

/** The role's instructions go in front of the first turn of a thread (Codex has no append flag in exec). */
export const promptWith = (parsed, prompt, fresh) => {
  if (!fresh) return prompt;
  // Studio's skills and reviewers as files to read (plugin-bridge.mjs: Codex can't load the plugin).
  const front = [parsed.system, pluginBridge(parsed.plugins)].filter(Boolean).join('\n\n');
  return front ? `${front}\n\n---\n\n${prompt}` : prompt;
};

/** One Codex item as Claude Code's tool_use (null: not a tool). */
export function toolOf(item) {
  const t = String(item?.type ?? '');
  if (t === 'command_execution') return { name: 'Bash', input: { command: item.command ?? '' } };
  if (t === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return { name: changes.some((c) => c?.kind === 'add') && changes.length === 1 ? 'Write' : 'Edit', input: { file_path: changes[0]?.path ?? '', changes } };
  }
  if (t === 'mcp_tool_call') return { name: `mcp__${item.server ?? 'mcp'}__${item.tool ?? 'tool'}`, input: item.arguments ?? {} };
  if (t === 'web_search') return { name: 'WebSearch', input: { query: item.query ?? '' } };
  if (t === 'todo_list') return { name: 'TodoWrite', input: { todos: item.items ?? [] } };
  if (t === 'collab_tool_call' || t === 'tool_call') return { name: String(item.tool ?? item.name ?? t), input: item.arguments ?? {} };
  return null;
}

/** One Codex event in, zero or more Claude Code events out. Unknown events are ignored. */
export function translate(state, event) {
  const out = [];
  const type = String(event?.type ?? '');
  if (type === 'thread.started') {
    if (event.thread_id) state.session = String(event.thread_id);
    if (!state.inited) {
      state.inited = true;
      out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: state.model || undefined });
    }
    return out;
  }
  if (!state.inited) {
    state.inited = true;
    out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: state.model || undefined });
  }
  const item = event?.item;
  if ((type === 'item.started' || type === 'item.completed') && item) {
    const tool = toolOf(item);
    if (tool) {
      if (!state.announced.has(item.id)) {
        state.announced.add(item.id);
        state.turns++;
        out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'tool_use', id: item.id ?? `tool_${state.turns}`, name: tool.name, input: tool.input }] } });
      }
      if (type === 'item.completed') {
        const text = item.aggregated_output ?? item.result ?? item.error?.message ?? item.status ?? '';
        out.push({ type: 'user', session_id: state.session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.id, content: typeof text === 'string' ? text.slice(0, 4000) : JSON.stringify(text).slice(0, 4000), is_error: item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) }] } });
      }
      return out;
    }
    if (item.type === 'agent_message' && type === 'item.completed') {
      const text = String(item.text ?? '');
      if (!text) return out;
      state.turns++;
      if (state.partial) {
        out.push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
        out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
        out.push({ type: 'stream_event', event: { type: 'content_block_stop' } });
      }
      out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'text', text }] } });
      state.last = text;
      return out;
    }
    if (item.type === 'error' && type === 'item.completed') {
      state.warning = String(item.message ?? '');
      return out;
    }
    return out;
  }
  if (type === 'turn.completed') {
    state.usage = event.usage ?? null;
    return out;
  }
  if (type === 'turn.failed') {
    state.error = String(event.error?.message ?? JSON.stringify(event.error ?? {})).slice(0, 2000);
    return out;
  }
  if (type === 'error') {
    state.error = String(event.message ?? event.error?.message ?? JSON.stringify(event)).slice(0, 2000);
    return out;
  }
  return out;
}

/** The closing `result` Claude Code's stream ends with: the last text, or the error (so harnessStopOf can classify it). */
export function finish(state, code, stderr) {
  const failed = Boolean(state.error) || (code !== 0 && !state.capped);
  const tail = String(stderr || '').trim().split('\n').slice(-12).join('\n');
  const result = failed ? (state.error || tail || `codex exited with ${code}`) : (state.last || '');
  const u = state.usage ?? {};
  return [{
    type: 'result', subtype: state.capped ? 'error_max_turns' : failed ? 'error' : 'success', is_error: failed, result: String(result).slice(0, 4000), session_id: state.session,
    duration_ms: Date.now() - state.began, total_cost_usd: 0, usage: { input_tokens: u.input_tokens ?? 0, cache_read_input_tokens: u.cached_input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 },
  }];
}

let current = null;
/** A thread Codex no longer has (another machine's, or cleaned up): the turn starts a new one instead. */
const LOST = /(no (such )?(session|thread|rollout)|not found|could not find|failed to (load|find) (session|thread|rollout))/i;

function runCodex(parsed, prompt, session, fresh, profile) {
  const state = { session, text: '', began: Date.now(), error: '', warning: '', turns: 0, capped: false, announced: new Set(), partial: parsed.partial, inited: false, last: '', usage: null, model: codexModel(parsed.model, parsed.effort).model };
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      const bin = codexBin();
      child = spawn(bin, codexArgs(parsed, { resume: fresh ? '' : session, profile }), {
        cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      child.stdin.on('error', () => {});
      child.stdin.end(promptWith(parsed, prompt, fresh));
    } catch (e) {
      for (const ev of finish(state, 1, `couldn't start codex: ${e.message}`)) process.stdout.write(`${JSON.stringify(ev)}\n`);
      return resolve({ code: 1, session, lost: false });
    }
    current = child;
    let buf = '';
    let wrote = 0;
    const feed = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (state.capped) return;
      for (const o of translate(state, ev)) { process.stdout.write(`${JSON.stringify(o)}\n`); wrote++; }
      // The role's turn cap (--max-turns): each tool call or message is a turn. Claude Code ends such a run with error_max_turns.
      if (parsed.maxTurns > 0 && state.turns > parsed.maxTurns && !state.capped) {
        state.capped = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 100_000) stderr = stderr.slice(-50_000); process.stderr.write(d); });
    child.on('error', (e) => { stderr += `couldn't start codex: ${e.message}`; });
    child.on('close', (code) => {
      feed(buf);
      current = null;
      // A resume of a thread this home hasn't got: nothing was said yet, so the caller starts a new thread instead.
      if (!fresh && code !== 0 && !state.announced.size && !state.last && LOST.test(`${state.error}\n${stderr}`)) return resolve({ code: code ?? 1, session, lost: true });
      if (!state.inited) process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session })}\n`);
      for (const o of finish(state, code ?? 1, stderr)) process.stdout.write(`${JSON.stringify(o)}\n`);
      resolve({ code: code ?? 1, session: state.session, lost: false, wrote });
    });
  });
}

/** One turn: resume the thread when there is one, else (or when Codex lost it) a new thread. */
async function turn(parsed, prompt, session, fresh, profile) {
  if (!fresh && session) {
    const r = await runCodex(parsed, prompt, session, false, profile);
    if (!r.lost) return r;
  }
  return runCodex(parsed, prompt, session, true, profile);
}

function userText(message) {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
  return '';
}

/** The pass's MCP servers as a Codex profile (CODEX_HOME/<profile>.config.toml), removed when the pass ends. */
function mcpProfile(parsed) {
  if (!parsed.mcp || !fs.existsSync(parsed.mcp)) return { profile: '', done: () => {} };
  const toml = mcpToml(parsed.mcp);
  if (!toml) return { profile: '', done: () => {} };
  const profile = `studio-${process.pid}`;
  const file = path.join(codexHome(), `${profile}.config.toml`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, toml, { mode: 0o600 });
  } catch {
    return { profile: '', done: () => {} };
  }
  const done = () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } };
  process.on('exit', done);
  return { profile, done };
}

async function main() {
  // The ChatGPT sign-in Studio keeps (CODEX_CREDS), into this home unless it has the same or a newer one.
  seedLogin('CODEX_CREDS');
  const parsed = parseClaudeArgs(process.argv);
  const { profile, done } = mcpProfile(parsed);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { current?.kill('SIGTERM'); done(); process.exit(143); });
  if (!parsed.streamIn) {
    const { code } = await turn(parsed, parsed.prompt, parsed.resume, !parsed.resume, profile);
    done();
    process.exit(code);
  }
  let session = parsed.resume || '';
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
    const r = await turn(parsed, prompt, session, fresh, profile);
    session = r.session || session;
    fresh = !session;
  }
  done();
}

function fileURL(u) { return new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURL(import.meta.url));
if (isMain) main();
