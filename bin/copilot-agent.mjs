// The GitHub Copilot harness in front of Studio's Claude Code arguments (the same idea as cursor-agent.mjs). Talk,
// agents, scouts and the probes keep passing `claude -p` flags and reading Claude's stream-json. This process runs the
// Copilot CLI (`copilot -p`, the Copilot plan's premium requests, COPILOT_GITHUB_TOKEN or a `copilot login`) and
// rewrites its JSONL events into that stream.
//
// One-shot: the prompt is the -p argument. A call keeps this process up and writes one stream-json user message per
// turn on stdin; each turn is a `copilot` run on the same session id (we choose it: --session-id resumes or creates).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { seedLogin } from './ai-login-seed.mjs';
import { pluginBridge } from './plugin-bridge.mjs';

export function copilotBin() {
  const home = process.env.HOME || os.homedir();
  const found = [process.env.COPILOT_BIN, '/usr/local/bin/copilot', '/usr/bin/copilot', path.join(home, '.local', 'bin', 'copilot'), '/home/hawkes/.local/bin/copilot']
    .find((p) => p && fs.existsSync(p));
  return unshim(found || 'copilot');
}

/** On Windows npm installs a copilot.cmd shim, which can't take a prompt as an argument safely: run its loader with node. */
export function unshim(bin) {
  if (process.platform !== 'win32') return bin;
  const dirs = /[\\/]/.test(bin) ? [path.dirname(bin)] : String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const loader = path.join(d, 'node_modules', '@github', 'copilot', 'npm-loader.js');
    if (fs.existsSync(loader) && (/[\\/]/.test(bin) ? /\.(cmd|bat|ps1)$/i.test(bin) : fs.existsSync(path.join(d, 'copilot.cmd')))) return loader;
  }
  return bin;
}

/** Claude Code's argv, as Studio builds it, reduced to what Copilot needs. */
export function parseClaudeArgs(argv) {
  const out = { prompt: '', model: '', resume: '', system: '', plugins: [], mcp: '', streamIn: false, partial: false, effort: '' };
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

/**
 * Claude Code's own model ids and aliases (claude-opus-5-5, sonnet) mean nothing to Copilot, whose ids use dots
 * (claude-sonnet-4.5, gpt-5.4): those are dropped so Copilot's default (or COPILOT_MODEL) answers.
 */
export function copilotModel(model) {
  const m = String(model || process.env.COPILOT_MODEL || '').trim();
  if (!m || /^(opus|sonnet|haiku)$/i.test(m) || /^claude-[a-z]+-\d+-\d+(-\d+)?$/i.test(m)) return process.env.COPILOT_MODEL || '';
  return m;
}

export function copilotArgs(parsed, prompt, session) {
  const args = ['-p', prompt, '--output-format', 'json', '--allow-all', '--no-ask-user', '--no-auto-update', '--session-id', session];
  const model = copilotModel(parsed.model);
  if (model && model !== 'auto') args.push('--model', model);
  const effort = parsed.effort || process.env.COPILOT_EFFORT;
  if (effort) args.push('--reasoning-effort', effort);
  const credits = Number(process.env.COPILOT_MAX_CREDITS);
  if (credits >= 30) args.push('--max-ai-credits', String(Math.floor(credits)));
  if (process.env.COPILOT_CONTEXT === 'long_context') args.push('--context', 'long_context');
  if (parsed.stream !== false) args.push('--stream', 'on');
  if (parsed.mcp && fs.existsSync(parsed.mcp)) args.push('--additional-mcp-config', `@${parsed.mcp}`);
  return args;
}

/**
 * The prompt text: the role's instructions go in front of the first turn of a session (Copilot has no append flag),
 * with Studio's skills and reviewers as files to read (plugin-bridge.mjs: these harnesses can't load the plugin).
 */
export const promptWith = (parsed, prompt, fresh) => {
  if (!fresh) return prompt;
  const front = [parsed.system, pluginBridge(parsed.plugins)].filter(Boolean).join('\n\n');
  return front ? `${front}\n\n---\n\n${prompt}` : prompt;
};

const dataOf = (e) => (e && typeof e.data === 'object' && e.data ? e.data : e ?? {});

/** Names Copilot uses for its tools, in Claude Code's (the dashboard and the gen-usage check read these). */
const TOOL_NAMES = { view: 'Read', read: 'Read', create: 'Write', write: 'Write', edit: 'Edit', str_replace_editor: 'Edit', bash: 'Bash', powershell: 'Bash', shell: 'Bash', grep: 'Grep', glob: 'Glob', rg: 'Grep', web_fetch: 'WebFetch', web_search: 'WebSearch' };
export function toolName(d) {
  if (d.mcpServerName && d.mcpToolName) return `mcp__${d.mcpServerName}__${d.mcpToolName}`;
  const n = String(d.toolName ?? d.name ?? 'tool');
  return TOOL_NAMES[n.toLowerCase()] ?? n;
}

/**
 * One Copilot event in, zero or more Claude Code events out. Defensive: the envelope is {type, data} but a bare
 * object is read too, and unknown events are ignored. `state` carries the text so far.
 */
export function translate(state, event) {
  const out = [];
  const type = String(event?.type ?? '');
  const d = dataOf(event);
  const sid = d.sessionId || event?.sessionId;
  if (sid && !state.sessionLocked) state.session = String(sid);
  if (!state.inited && type !== 'result') {
    state.inited = true;
    out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: d.selectedModel ?? d.model });
  }
  const closeText = () => {
    if (state.started) out.push({ type: 'stream_event', event: { type: 'content_block_stop' } });
    state.started = false;
  };
  const flush = () => {
    if (!state.text) return closeText();
    closeText();
    out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'text', text: state.text }] } });
    state.last = state.text;
    state.text = '';
  };
  if (type === 'session.start' || type === 'session.resume') {
    if (!state.inited) {
      state.inited = true;
      out.push({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: state.session, model: d.selectedModel ?? d.model });
    }
    return out;
  }
  if (type === 'assistant.message_delta') {
    const text = d.deltaContent ?? '';
    if (!text) return out;
    if (!state.started) {
      out.push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
      state.started = true;
    }
    state.text += text;
    state.deltas = true;
    out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    return out;
  }
  if (type === 'assistant.message') {
    // Without streamed deltas the whole message is the text.
    if (!state.deltas && d.content && !d.parentToolCallId) {
      state.text = String(d.content);
      if (state.text) {
        out.push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
        out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: state.text } } });
        state.started = true;
      }
    }
    state.deltas = false;
    flush();
    for (const r of d.toolRequests ?? []) {
      if (r?.toolCallId) state.announced.add(r.toolCallId);
      out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'tool_use', id: r?.toolCallId, name: toolName(r ?? {}), input: r?.arguments ?? {} }] } });
    }
    return out;
  }
  if (type === 'tool.execution_start') {
    if (d.toolCallId && state.announced.has(d.toolCallId)) return out;
    flush();
    out.push({ type: 'assistant', session_id: state.session, message: { role: 'assistant', content: [{ type: 'tool_use', id: d.toolCallId, name: toolName(d), input: d.arguments ?? {} }] } });
    return out;
  }
  if (type === 'assistant.usage') {
    state.model = d.model ?? state.model;
    return out;
  }
  if (type === 'session.error' || type === 'error') {
    state.error = [d.errorType, d.statusCode, d.errorCode, d.message].filter(Boolean).join(' ') || JSON.stringify(d).slice(0, 400);
    return out;
  }
  if (type === 'result') {
    state.exitCode = d.exitCode ?? event.exitCode ?? state.exitCode;
    if (event.sessionId) state.session = String(event.sessionId);
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
  const result = failed ? (state.error || tail || `copilot exited with ${code}`) : (state.last || '');
  out.push({ type: 'result', subtype: state.capped ? 'error_max_turns' : failed ? 'error' : 'success', is_error: failed, result: String(result).slice(0, 4000), session_id: state.session, duration_ms: Date.now() - state.began, total_cost_usd: 0 });
  return out;
}

/**
 * The environment the Copilot CLI starts with. Copilot reads COPILOT_GITHUB_TOKEN, then GH_TOKEN, then GITHUB_TOKEN, and
 * only then its own login: Studio's server has GITHUB_TOKEN (its repo push token, often a classic ghp_ one) for git, so
 * Copilot took that and refused it ("Classic Personal Access Tokens (ghp_) are not supported"), even with J signed in.
 * The repo tokens are never Copilot's; a classic COPILOT_GITHUB_TOKEN is dropped too when there is a login to use instead.
 */
export function copilotEnv(env = process.env, home = env.HOME || os.homedir()) {
  const out = { ...env, NO_COLOR: '1' };
  delete out.GH_TOKEN;
  delete out.GITHUB_TOKEN;
  const copilotHome = env.COPILOT_HOME || path.join(home, '.copilot');
  const login = Boolean(env.COPILOT_CREDS) || ['config.json', 'hosts.json', 'apps.json'].some((f) => {
    try { return /oauth|token|login|user/i.test(fs.readFileSync(path.join(copilotHome, f), 'utf8').slice(0, 4000)); } catch { return false; }
  });
  if (/^ghp_/.test(String(out.COPILOT_GITHUB_TOKEN ?? '').trim()) && login) delete out.COPILOT_GITHUB_TOKEN;
  return out;
}

let current = null;
function runAgent(parsed, prompt, session, fresh) {
  const state = { session, sessionLocked: true, text: '', started: false, deltas: false, announced: new Set(), began: Date.now(), error: '', turns: 0, capped: false };
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      const bin = copilotBin();
      const script = /\.(mjs|cjs|js)$/i.test(bin);
      const argv = copilotArgs(parsed, promptWith(parsed, prompt, fresh), session);
      child = spawn(script ? process.execPath : bin, [...(script ? [bin] : []), ...argv], {
        cwd: process.cwd(), env: copilotEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      for (const ev of finish(state, 1, `couldn't start copilot: ${e.message}`)) process.stdout.write(`${JSON.stringify(ev)}\n`);
      return resolve({ code: 1, session });
    }
    current = child;
    let buf = '';
    const feed = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      // The role's turn cap (--max-turns): one assistant message is a turn. Claude Code ends such a run with error_max_turns.
      if (ev?.type === 'assistant.message' && parsed.maxTurns > 0 && ++state.turns > parsed.maxTurns && !state.capped) {
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
    child.on('error', (e) => { stderr += `couldn't start copilot: ${e.message}`; });
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
  // The Copilot sign-in Studio keeps (COPILOT_CREDS: src/cli-signin.ts), into this home unless it has the same or a newer one.
  seedLogin('COPILOT_CREDS');
  const parsed = parseClaudeArgs(process.argv);
  if (!parsed.streamIn) {
    const { code } = await runAgent(parsed, parsed.prompt, parsed.resume || randomUUID(), !parsed.resume);
    process.exit(code);
  }
  let session = parsed.resume || randomUUID();
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
