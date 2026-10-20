// Studio's own Claude calls (acceptance checks, canon checks, release notes, memory curation, playtest reviews): Hawkes
// Gen first (llm.json / llm.text, billed to the API key), and Claude Code on J's Max plan when Gen can't (J, 2026-10-18:
// "For the anthropic credits can you work around it for now (don't let it block you)").
//
// - A Gen call that fails on credit, billing or the key (isBillingError) is run again through `claude -p` (claudeEnv:
//   the subscription token), with the same model, prompt, system and schema; images as files in a temp folder the
//   session may only Read. The failure is remembered for 10 minutes, so the next calls go straight to Claude Code
//   instead of waiting on Gen first; after that Gen is tried again, so they go back to Gen by themselves.
// - STUDIO_LLM_VIA=claude-code always uses Claude Code; STUDIO_LLM_VIA=gen never falls back.
// - At most 2 Claude Code calls at once (STUDIO_LLM_CC_MAX), so they don't starve the agents; a timeout each.
// - Each fallback call is a row in llm_fallbacks (costs.ts: "Max plan (not billed)", not dollars).
//
// The answer looks like a Gen job, so callers keep reading job.status and job.result.value / .text; a fallback one has
// via "claude-code", billing "Max plan (not billed)" and cost 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gen, genRun, genWait } from './gen.ts';
import { db, newId } from './db.ts';
import { claudeEnv, usingSubscription } from './claude.ts';
import { claudeCommand } from './sandbox.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS llm_fallbacks (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, purpose TEXT, product TEXT, model TEXT, ok INTEGER NOT NULL,
    usage REAL DEFAULT 0, billing TEXT, seconds REAL, error TEXT
  );
`);

export const MAX_PLAN = 'Max plan (not billed)';

export type AskParams = {
  prompt: string;
  system?: string;
  /** JSON Schema: llm.json (result.value); without one, llm.text (result.text). */
  schema?: Record<string, unknown>;
  model: string;
  effort?: string;
  maxTokens?: number;
  /** Gen inputs: "asset:<id>" (the library), "blob:<sha>" or file paths. */
  images?: string[];
  timeoutMs?: number;
  /** What it's for (acceptance, canon, release, curation, review): the fallback log and the cost lines. */
  purpose: string;
  product?: string;
};

// ------------------------------------------------------------ when Gen can't

/** Gen's (or Claude's) error for an empty credit balance, billing, or a missing or rejected API key. */
export function isBillingError(e: unknown) {
  const kind = (e as any)?.kind;
  const msg = typeof e === 'string' ? e : String((e as any)?.message ?? (e as any)?.error ?? e ?? '');
  // Any "the provider won't serve us right now" (J, 2026-10-20: recover from these states): credit, billing, an unpaid
  // invoice (Cursor's ActionRequiredError), a usage or quota limit, overloaded, a rejected key.
  return kind === 'auth' || /credit balance|billing|payment required|unpaid invoice|ActionRequiredError|usage limit|quota|rate.?limit|overloaded|ANTHROPIC_API_KEY|key .*was rejected|authentication_error|invalid x-api-key/i.test(msg);
}

const DOWN_MS = 10 * 60_000;
let downUntil = 0;
let downWhy = '';
/** Gen's Claude failed on credit or the key: skip it for 10 minutes. */
export function markGenDown(why: string) {
  downUntil = Date.now() + DOWN_MS;
  downWhy = why.slice(0, 300);
  console.warn(`[studio] Hawkes Gen's Claude calls fail (${downWhy}); using Claude Code on the Max plan for 10 minutes`);
}
/** Tests: forget it. */
export function resetLlmState() {
  downUntil = 0;
  downWhy = '';
}

/** Where the next call goes first: "gen", or "claude-code" (forced, or Gen failed on credit in the last 10 minutes). */
export function llmVia(): 'gen' | 'claude-code' {
  const v = process.env.STUDIO_LLM_VIA;
  if (v === 'claude-code') return 'claude-code';
  if (v === 'gen') return 'gen';
  return Date.now() < downUntil ? 'claude-code' : 'gen';
}
export const llmState = () => ({ via: llmVia(), genDownUntil: downUntil > Date.now() ? downUntil : null, why: downUntil > Date.now() ? downWhy : null });
const fallbackOn = () => process.env.STUDIO_LLM_VIA !== 'gen';

// ------------------------------------------------------------ the one way in

/** Gen first (unless it failed on credit lately), then Claude Code. Never throws: a failed call is status "failed". */
export async function askClaude(p: AskParams, deps: { viaGen?: (p: AskParams) => Promise<any> } = {}): Promise<any> {
  if (llmVia() === 'claude-code') return askClaudeCode(p);
  let job: any;
  try {
    job = await (deps.viaGen ?? askGen)(p);
  } catch (e: any) {
    job = { status: 'failed', error: String(e?.message ?? e), kind: e?.kind };
  }
  if (job?.status === 'done' || !fallbackOn() || !isBillingError(job)) return job;
  markGenDown(String(job.error ?? job.detail ?? 'credit'));
  return askClaudeCode(p);
}

async function askGen(p: AskParams) {
  const tool = p.schema ? 'llm.json' : 'llm.text';
  const params = { prompt: p.prompt, model: p.model, ...(p.system ? { system: p.system } : {}), ...(p.schema ? { schema: p.schema } : {}), ...(p.effort ? { effort: p.effort } : {}), ...(p.maxTokens ? { maxTokens: p.maxTokens } : {}) };
  const timeout = p.timeoutMs ?? 10 * 60_000;
  if (!p.images?.length) return genRun(tool, 'hawkesstudio', params, undefined, timeout);
  const s: any = await gen.submit(tool, { project: 'hawkesstudio', params, inputs: { images: p.images } });
  return genWait(s.id, undefined, timeout);
}

// ------------------------------------------------------------ Claude Code

let running = 0;
const waiting: (() => void)[] = [];
const ccMax = () => Math.max(1, Number(process.env.STUDIO_LLM_CC_MAX) || 2);
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (running >= ccMax()) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await f();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** The images as files in dir (frame-00.png, ...), in order; ones that can't be fetched are left out. */
async function imageFiles(images: string[], dir: string) {
  const files: string[] = [];
  for (const [i, src] of images.entries()) {
    try {
      const m = /^asset:(.+)$/.exec(src);
      let ext = '.png';
      if (m) {
        const a: any = await gen.request(`/assets/${m[1]}`).catch(() => null);
        ext = path.extname(a?.path ?? '') || (a?.mime === 'image/jpeg' ? '.jpg' : a?.mime === 'image/webp' ? '.webp' : '.png');
      } else if (!src.startsWith('blob:')) ext = path.extname(src) || '.png';
      const dest = path.join(dir, `frame-${String(i).padStart(2, '0')}${ext}`);
      if (m) await gen.download(m[1], dest);
      else if (src.startsWith('blob:')) continue;
      else fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o644);
      files.push(path.basename(dest));
    } catch (e: any) {
      console.warn(`[studio] llm fallback: couldn't fetch image ${src}: ${e.message}`);
    }
  }
  return files;
}

/** Small JSON Schema check: types, required, enums (what Studio's schemas use). The first problem, or null. */
export function schemaProblem(v: any, s: any, at = 'answer'): string | null {
  if (!s || typeof s !== 'object') return null;
  const t = s.type;
  if (t === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} is not an object`;
    for (const k of s.required ?? []) if (!(k in v)) return `${at}.${k} is missing`;
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v) { const w = schemaProblem(v[k], sub, `${at}.${k}`); if (w) return w; }
  } else if (t === 'array') {
    if (!Array.isArray(v)) return `${at} is not a list`;
    for (const [i, x] of v.entries()) { const w = schemaProblem(x, s.items, `${at}[${i}]`); if (w) return w; }
  } else if (t === 'string' && typeof v !== 'string') return `${at} is not text`;
  else if ((t === 'integer' || t === 'number') && typeof v !== 'number') return `${at} is not a number`;
  else if (t === 'boolean' && typeof v !== 'boolean') return `${at} is not true/false`;
  if (Array.isArray(s.enum) && !s.enum.includes(v)) return `${at} is not one of ${s.enum.join(', ')}`;
  return null;
}

/** The JSON in a text answer (a bare object, or one in a ```json fence). */
export function jsonIn(text: string) {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fence ? fence[1] : t.slice(Math.max(0, t.indexOf('{')), t.lastIndexOf('}') + 1);
  return JSON.parse(body);
}

/** One `claude -p` run: { ok, text, structured, usage, error }. The prompt goes in on stdin (prompts can be long). */
function runClaude(args: string[], input: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; text: string; structured: unknown; usage: number; error?: string }> {
  return new Promise((resolve) => {
    const c = claudeCommand(args, { cwd, env: claudeEnv(), brain: 'claude' });
    const child = spawn(c.file, c.args, { cwd: c.cwd, env: c.env, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: '', structured: undefined, usage: 0, error: `couldn't start Claude Code: ${e.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let m: any = null;
      try {
        m = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '');
      } catch { /* not JSON */ }
      if (signal) return resolve({ ok: false, text: '', structured: undefined, usage: 0, error: `Claude Code timed out after ${Math.round(timeoutMs / 60000)} min` });
      if (!m || m.is_error) return resolve({ ok: false, text: String(m?.result ?? ''), structured: undefined, usage: Number(m?.total_cost_usd) || 0, error: `Claude Code: ${String(m?.result ?? err ?? `exit ${code}`).trim().slice(0, 300) || `exit ${code}`}` });
      resolve({ ok: true, text: String(m.result ?? ''), structured: m.structured_output, usage: Number(m.total_cost_usd) || 0 });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** The same request through Claude Code on the Max plan. Looks like a finished Gen job; never throws. */
export async function askClaudeCode(p: AskParams): Promise<any> {
  return slot(async () => {
    const started = Date.now();
    const id = newId('cc');
    // A temp folder outside the projects (no CLAUDE.md above it), readable by the sandbox user.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-llm-'));
    fs.chmodSync(dir, 0o755);
    let usage = 0;
    let error = '';
    let value: unknown;
    let text = '';
    try {
      const files = p.images?.length ? await imageFiles(p.images, dir) : [];
      const pics = files.length ? `\n\nATTACHED IMAGES: ${files.length} files in the current folder, in this order: ${files.join(', ')}. Read every one of them (the Read tool) before you answer; refer to them by their index (0 = ${files[0]}).` : '';
      const shape = p.schema ? `\n\nAnswer only with one JSON object matching this JSON Schema (no prose, no code fence):\n${JSON.stringify(p.schema)}` : '';
      const args = ['-p', '--output-format', 'json', '--model', p.model, '--no-session-persistence', '--strict-mcp-config',
        '--tools', files.length ? 'Read' : '', ...(files.length ? ['--allowedTools', 'Read'] : []),
        ...(p.effort ? ['--effort', p.effort] : []), ...(p.system ? ['--system-prompt', p.system] : []),
        ...(p.schema ? ['--json-schema', JSON.stringify(p.schema)] : [])];
      const timeout = p.timeoutMs ?? 10 * 60_000;
      for (let attempt = 0; attempt < 2; attempt++) {
        const again = attempt && text ? `\n\nYour previous answer was not valid (${error}). Answer again with JSON only.` : '';
        const r = await runClaude(args, `${p.prompt}${pics}${shape}${again}`, dir, timeout);
        usage += r.usage;
        if (!r.ok) {
          error = r.error ?? 'failed';
          // Structured output itself failed: once more without --json-schema (the prompt asks for JSON only).
          const k = args.indexOf('--json-schema');
          if (attempt || k < 0 || /timed out/.test(error)) break;
          args.splice(k, 2);
          continue;
        }
        text = r.text;
        if (!p.schema) { error = ''; break; }
        try {
          value = r.structured ?? jsonIn(r.text);
          const bad = schemaProblem(value, p.schema);
          if (!bad) { error = ''; break; }
          error = bad;
        } catch {
          error = 'not JSON';
        }
        value = undefined;
      }
    } catch (e: any) {
      error = String(e?.message ?? e);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const billing = usingSubscription() ? MAX_PLAN : 'API (per token)';
    const ok = !error;
    try {
      db.prepare('INSERT INTO llm_fallbacks (id, at, purpose, product, model, ok, usage, billing, seconds, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, started, p.purpose, p.product ?? null, p.model, ok ? 1 : 0, usage, billing, (Date.now() - started) / 1000, error || null);
    } catch { /* the log is a nicety */ }
    return ok
      ? { id, status: 'done', via: 'claude-code', billing, cost: 0, usage, result: { ...(p.schema ? { value } : {}), text, model: p.model } }
      : { id, status: 'failed', via: 'claude-code', billing, cost: 0, usage, error: `${error} (Claude Code fallback, Gen: ${downWhy || 'skipped'})` };
  });
}

/** The fallback calls in a period, for the cost lines: calls, failures, usage at API prices (not billed on the Max plan). */
export function fallbackUsage(start: number, end: number) {
  try {
    const r = db.prepare('SELECT COUNT(*) AS calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, COALESCE(SUM(usage), 0) AS usage, COALESCE(SUM(CASE WHEN billing = ? THEN 0 ELSE usage END), 0) AS billed FROM llm_fallbacks WHERE at >= ? AND at < ?').get(MAX_PLAN, start, end) as any;
    return { calls: Number(r.calls) || 0, failed: Number(r.failed) || 0, usage: Math.round((Number(r.usage) || 0) * 100) / 100, billed: Math.round((Number(r.billed) || 0) * 100) / 100 };
  } catch {
    return { calls: 0, failed: 0, usage: 0, billed: 0 };
  }
}
