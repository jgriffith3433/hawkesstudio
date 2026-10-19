#!/usr/bin/env node
// Grok 4.7 as a coding agent (xAI Responses API). Studio launches this instead of `claude` when the brain
// is Grok. Stdout is the same stream-json Claude Code speaks, so Talk, agents and scouts don't change:
//   {"type":"system","subtype":"init","session_id","apiKeySource":"xai"}
//   {"type":"assistant","message":{"content":[{type:"text"|"tool_use", ...}]}}
//   {"type":"result","result","is_error","total_cost_usd","session_id"}
//
// One shot:  -p "prompt"  (or the prompt on stdin)  then exit.
// A call:    -p --input-format stream-json   and one {"type":"user",...} line per turn, process stays up.
// GROK_FAKE_FILE: a JSON array of API responses, for tests. No network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const GROK_MODEL = 'grok-4.7';
const FLAGS = new Set(['--resume', '--output-format', '--model', '--append-system-prompt', '--system-prompt', '--allowedTools', '--disallowedTools', '--max-turns', '--plugin-dir', '--mcp-config', '--permission-mode', '--input-format', '--tools', '--json-schema', '--effort']);
const BOOLS = new Set(['--verbose', '--include-partial-messages', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']);

export function parseArgs(argv) {
  const opt = {
    prompt: '', resume: '', model: GROK_MODEL, system: '', append: '', inputFormat: '',
    outputFormat: 'stream-json', maxTurns: 80, pluginDir: '', mcpConfig: '',
    allowed: [], disallowed: [], toolsFlag: null, schema: null, partial: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p') {
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) opt.prompt = argv[++i];
      continue;
    }
    if (BOOLS.has(a)) {
      if (a === '--include-partial-messages') opt.partial = true;
      continue;
    }
    if (!FLAGS.has(a)) continue;
    const v = argv[++i] ?? '';
    if (a === '--resume') opt.resume = v;
    else if (a === '--model') opt.model = v.startsWith('grok-') ? v : GROK_MODEL;
    else if (a === '--system-prompt') opt.system = v;
    else if (a === '--append-system-prompt') opt.append = v;
    else if (a === '--input-format') opt.inputFormat = v;
    else if (a === '--output-format') opt.outputFormat = v;
    else if (a === '--max-turns') opt.maxTurns = Math.max(1, Number(v) || 80);
    else if (a === '--plugin-dir') opt.pluginDir = v;
    else if (a === '--mcp-config') opt.mcpConfig = v;
    else if (a === '--allowedTools') opt.allowed = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--disallowedTools') opt.disallowed = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--tools') opt.toolsFlag = v;
    else if (a === '--json-schema') { try { opt.schema = JSON.parse(v); } catch { opt.schema = null; } }
  }
  return opt;
}

const sessionDir = () => process.env.GROK_SESSION_DIR || path.join(os.homedir(), '.grok', 'sessions');

function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir(), `${id}.json`), 'utf8')); } catch { return null; }
}
function saveSession(s) {
  fs.mkdirSync(sessionDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionDir(), `${s.id}.json`), JSON.stringify({ id: s.id, responseId: s.responseId, cost: s.cost }));
}

function emit(m) {
  process.stdout.write(`${JSON.stringify(m)}\n`);
}

function costOf(usage) {
  const inn = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const out = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const cached = Number(usage?.cache_read_input_tokens ?? usage?.cached_tokens ?? 0);
  return (Math.max(0, inn - cached) * 2 + cached * 0.5 + out * 6) / 1e6;
}

function clip(s, n = 40_000) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} characters cut)` : s;
}

export function applyEdit(file, oldStr, newStr) {
  const text = fs.readFileSync(file, 'utf8');
  const n = text.split(oldStr).length - 1;
  if (!oldStr) return 'old_string is empty';
  if (n === 0) return 'old_string was not found';
  if (n > 1) return `old_string matched ${n} times; include more context so it matches once`;
  fs.writeFileSync(file, text.replace(oldStr, newStr));
  return 'ok';
}

function resolvePath(cwd, p) {
  const abs = path.resolve(cwd, p);
  const base = path.basename(abs).toLowerCase();
  if (base === '.env' || base.endsWith('.pem') || base.includes('credential')) throw new Error('refusing to touch a secrets file');
  return abs;
}

function localTools(opt) {
  const all = [
    { name: 'Read', description: 'Read a text file. Optional offset and limit are line numbers.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
    { name: 'Write', description: 'Create or overwrite a text file.', parameters: { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path', 'contents'] } },
    { name: 'Edit', description: 'Replace one exact occurrence of old_string with new_string.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
    { name: 'Glob', description: 'List files matching a glob, relative to the working directory.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    { name: 'Grep', description: 'Search file contents. pattern is a regular expression.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    { name: 'Bash', description: 'Run a shell command in the working directory. Do not read secrets.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'Skill', description: 'Load one skill from the plugin (its SKILL.md) by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    { name: 'TodoWrite', description: 'Replace the task list. todos: [{content, status}] status is pending, in_progress or completed.', parameters: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] } },
  ];
  if (opt.toolsFlag === '') return [];
  const named = opt.toolsFlag ? opt.toolsFlag.split(/[,\s]+/).filter(Boolean) : null;
  return all.filter((t) => {
    if (named && !named.includes(t.name)) return false;
    if (opt.disallowed.some((d) => d === t.name || d.startsWith(`${t.name}(`))) return false;
    if (!opt.allowed.length) return true;
    return opt.allowed.some((a) => a === t.name || a.startsWith(`${t.name}(`) || a.startsWith(`${t.name},`));
  });
}

function skillList(pluginDir) {
  const dir = path.join(pluginDir, 'skills');
  if (!pluginDir || !fs.existsSync(dir)) return '';
  const names = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md')));
  return names.length ? `\n\nSkills you can load with the Skill tool: ${names.join(', ')}.` : '';
}

async function runLocal(name, input, ctx) {
  const cwd = ctx.cwd;
  if (name === 'Read') {
    const file = resolvePath(cwd, input.path);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const start = Math.max(0, (Number(input.offset) || 1) - 1);
    const lim = Number(input.limit) || lines.length;
    return clip(lines.slice(start, start + lim).map((l, i) => `${start + i + 1}|${l}`).join('\n'));
  }
  if (name === 'Write') {
    const file = resolvePath(cwd, input.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(input.contents ?? ''));
    return `wrote ${file}`;
  }
  if (name === 'Edit') return applyEdit(resolvePath(cwd, input.path), String(input.old_string ?? ''), String(input.new_string ?? ''));
  if (name === 'Glob') {
    const root = input.path ? resolvePath(cwd, input.path) : cwd;
    const hits = fs.globSync(input.pattern, { cwd: root });
    return clip(hits.slice(0, 200).join('\n') || '(no matches)');
  }
  if (name === 'Grep') {
    const root = input.path ? resolvePath(cwd, input.path) : cwd;
    return clip(await shellOut(process.platform === 'win32' ? 'rg' : 'rg', ['-n', '--max-count', '40', '-g', '!.git', String(input.pattern ?? ''), root], cwd, 30_000));
  }
  if (name === 'Bash') return clip(await shellOut(process.platform === 'win32' ? 'powershell' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-Command', String(input.command ?? '')] : ['-c', String(input.command ?? '')], cwd, 120_000));
  if (name === 'Skill') {
    const file = path.join(ctx.pluginDir, 'skills', path.basename(String(input.name ?? '')), 'SKILL.md');
    if (!fs.existsSync(file)) return `no skill ${input.name}`;
    return clip(fs.readFileSync(file, 'utf8'), 20_000);
  }
  if (name === 'TodoWrite') {
    ctx.todos = Array.isArray(input.todos) ? input.todos : [];
    return `todos: ${ctx.todos.length}`;
  }
  return `unknown tool ${name}`;
}

function shellOut(file, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|AWS_/i.test(k)) delete env[k];
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    let out = '';
    const take = (d) => { if (out.length < 50_000) out += d; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve(e.message); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code && code !== 0 ? `${out}\n(exit ${code})` : out || '(no output)'); });
  });
}

class Mcp {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.tools = [];
    this.next = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.child = null;
  }
  start() {
    const env = { ...process.env, ...(this.spec.env ?? {}) };
    this.child = spawn(this.spec.command, this.spec.args ?? [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => {});
    this.child.on('close', () => { for (const [, p] of this.pending) p.reject(new Error(`${this.name} closed`)); this.pending.clear(); });
    return this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hawkes-grok', version: '1' } })
      .then(() => { this.notify('notifications/initialized', {}); return this.request('tools/list', {}); })
      .then((r) => { this.tools = r?.tools ?? []; });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const head = this.buf.slice(0, sep).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(head);
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.slice(start, start + len).toString('utf8');
      this.buf = this.buf.slice(start + len);
      try {
        const msg = JSON.parse(body);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? 'mcp error'));
          else p.resolve(msg.result);
        }
      } catch { /* not a message */ }
    }
  }
  send(msg) {
    const json = JSON.stringify(msg);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params) {
    const id = this.next++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} ${method} timed out`)); }, 20_000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }
  async call(tool, args) {
    const r = await this.request('tools/call', { name: tool, arguments: args ?? {} });
    const text = (r?.content ?? []).map((c) => c.text ?? '').filter(Boolean).join('\n');
    return clip(text || JSON.stringify(r ?? {}).slice(0, 8000));
  }
  stop() { try { this.child?.kill(); } catch { /* gone */ } }
}

function allowedMcp(opt, full) {
  if (opt.disallowed.some((d) => full === d || full.startsWith(d))) return false;
  if (!opt.allowed.length) return true;
  return opt.allowed.some((a) => full === a || full.startsWith(`${a}__`) || full.startsWith(a));
}

async function connectMcp(opt) {
  if (!opt.mcpConfig || !fs.existsSync(opt.mcpConfig)) return [];
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(opt.mcpConfig, 'utf8')); } catch { return []; }
  const servers = [];
  for (const [name, spec] of Object.entries(cfg.mcpServers ?? {})) {
    const mcp = new Mcp(name, spec);
    try {
      await mcp.start();
      servers.push(mcp);
    } catch (e) {
      process.stderr.write(`mcp ${name}: ${e.message ?? e}\n`);
      mcp.stop();
    }
  }
  return servers;
}

function toolDefs(local, servers, opt) {
  const defs = local.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  for (const mcp of servers) {
    for (const t of mcp.tools) {
      const name = `mcp__${mcp.name}__${t.name}`;
      if (!allowedMcp(opt, name)) continue;
      const parameters = t.inputSchema?.type === 'object' ? t.inputSchema : { type: 'object', properties: t.inputSchema?.properties ?? {}, required: t.inputSchema?.required };
      defs.push({ type: 'function', name, description: t.description ?? t.name, parameters });
    }
  }
  return defs;
}

let fakeQueue = null;
function nextFake() {
  if (!process.env.GROK_FAKE_FILE) return null;
  if (!fakeQueue) fakeQueue = JSON.parse(fs.readFileSync(process.env.GROK_FAKE_FILE, 'utf8'));
  return fakeQueue.shift() ?? { output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }] };
}

async function complete(body) {
  const fake = nextFake();
  if (fake) return fake;
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY is not set. Add it to hawkesgen/.env and the hawkes/gen secret (AWS Secrets Manager), then restart Gen and Studio.');
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status >= 500) {
      last = data?.error?.message ?? `HTTP ${r.status}`;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`Grok API ${r.status}: ${data?.error?.message ?? r.statusText}`);
    return data;
  }
  throw new Error(`Grok API kept failing: ${last}`);
}

function callsOf(data) {
  const calls = [];
  let text = typeof data?.output_text === 'string' ? data.output_text : '';
  for (const item of data?.output ?? []) {
    if (item?.type === 'function_call') {
      let args = item.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = {}; } }
      calls.push({ name: item.name, args: args ?? {}, call_id: item.call_id });
    } else if (item?.type === 'message') {
      text += (item.content ?? []).map((c) => c.text ?? '').join('');
    }
  }
  return { calls, text };
}

async function execute(call, ctx, servers) {
  try {
    const mcp = /^mcp__([^_].*?)__(.+)$/.exec(call.name);
    if (mcp) {
      const server = servers.find((s) => s.name === mcp[1]);
      if (!server) return `no MCP server ${mcp[1]}`;
      return await server.call(mcp[2], call.args);
    }
    return await runLocal(call.name, call.args, ctx);
  } catch (e) {
    return `error: ${e.message ?? e}`;
  }
}

/**
 * One turn. Returns { ok, text, cost }. Emits assistant and result lines.
 */
export async function runTurn({ opt, prompt, session, servers, defs, started }) {
  const ctx = { cwd: process.cwd(), pluginDir: opt.pluginDir, todos: [] };
  const instructions = `${opt.system}\n\n${opt.append}`.trim() + skillList(opt.pluginDir)
    + '\n\nYou are Grok 4.7, running as the brain of Hawkes Studio. Use the tools to do the task. When you are finished, say what you did in plain text.';
  let previous = session.responseId || undefined;
  let input = [{ role: 'user', content: prompt }];
  let text = '';
  let cost = 0;
  for (let turn = 0; turn < opt.maxTurns; turn++) {
    const data = await complete({
      model: opt.model || GROK_MODEL,
      instructions,
      input,
      ...(defs.length ? { tools: defs } : {}),
      ...(previous ? { previous_response_id: previous } : {}),
      ...(opt.schema && !defs.length ? { text: { format: { type: 'json_schema', name: 'result', strict: true, schema: opt.schema } } } : {}),
    });
    previous = data.id || previous;
    session.responseId = previous;
    cost += costOf(data.usage);
    session.cost = (session.cost ?? 0) + costOf(data.usage);
    const { calls, text: said } = callsOf(data);
    if (said.trim()) {
      text = said;
      if (opt.partial) {
        emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
        emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: said } } });
        emit({ type: 'stream_event', event: { type: 'content_block_stop' } });
      }
    }
    const content = [];
    if (said.trim()) content.push({ type: 'text', text: said });
    for (const c of calls) content.push({ type: 'tool_use', name: c.name, input: c.args });
    if (content.length) emit({ type: 'assistant', message: { content } });
    if (!calls.length) {
      saveSession(session);
      emit({ type: 'result', subtype: 'success', result: text, is_error: false, total_cost_usd: cost, session_id: session.id, duration_ms: Date.now() - started });
      return { ok: true, text, cost };
    }
    const outputs = [];
    for (const c of calls) {
      const result = await execute(c, ctx, servers);
      outputs.push({ type: 'function_call_output', call_id: c.call_id, output: result });
    }
    input = outputs;
  }
  saveSession(session);
  emit({ type: 'result', subtype: 'error_max_turns', result: text || 'stopped at the turn limit', is_error: true, total_cost_usd: cost, session_id: session.id, duration_ms: Date.now() - started });
  return { ok: false, text, cost };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const resumed = opt.resume ? loadSession(opt.resume) : null;
  const session = { id: resumed?.id || crypto.randomUUID(), responseId: resumed?.responseId || '', cost: resumed?.cost || 0 };
  saveSession(session);
  emit({ type: 'system', subtype: 'init', session_id: session.id, apiKeySource: 'xai' });
  const local = localTools(opt);
  const servers = await connectMcp(opt);
  const defs = toolDefs(local, servers, opt);
  const finish = (code) => { for (const s of servers) s.stop(); process.exit(code); };
  try {
    if (opt.inputFormat === 'stream-json') {
      const rl = readline.createInterface({ input: process.stdin });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const content = msg?.message?.content ?? msg?.content ?? '';
        const prompt = typeof content === 'string' ? content : (content.find?.((c) => c.type === 'text')?.text ?? '');
        if (!prompt) continue;
        await runTurn({ opt, prompt, session, servers, defs, started: Date.now() });
      }
      finish(0);
    } else {
      let prompt = opt.prompt;
      if (!prompt) prompt = fs.readFileSync(0, 'utf8');
      const r = await runTurn({ opt, prompt, session, servers, defs, started: Date.now() });
      finish(r.ok ? 0 : 1);
    }
  } catch (e) {
    emit({ type: 'result', subtype: 'error', result: e.message ?? String(e), is_error: true, total_cost_usd: 0, session_id: session.id });
    finish(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURL(import.meta.url));
function fileURL(u) { return new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }
if (isMain) main();
