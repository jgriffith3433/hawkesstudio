// Which harness runs Talk, the agents, scouts and (through Hawkes Gen) reviews and JSON calls, and which model it uses.
// "claude" is Claude Code, as before. "cursor" is Cursor's `agent` on the Cursor plan (bin/cursor-agent.mjs,
// CURSOR_API_KEY). An older saved "grok" meant the xAI API; it now means the Cursor harness on Grok 4.7.
// The choice is in Studio's settings table and shown on the Settings tab. On the server, a Studio that has never
// chosen runs on Cursor when the Cursor key is present.

import { db, J, parse } from './db.ts';
import { GEN_URL, ROOT } from './config.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Harness = 'claude' | 'cursor' | 'copilot' | 'gemini' | 'antigravity';
/** Default Cursor model when none is saved. `auto` is Cursor's router (the "Switch to Auto" pool when premium usage is out). */
export const CURSOR_MODEL = 'auto';
/** Default Copilot model: none, so the Copilot CLI picks its own default for the plan. */
export const COPILOT_MODEL = '';
export const CURSOR_AGENT = path.join(ROOT, 'bin', 'cursor-agent.mjs');
export const COPILOT_AGENT = path.join(ROOT, 'bin', 'copilot-agent.mjs');
/** Default Gemini model: none, so Gemini CLI's Auto routing (Pro for hard work, Flash for easy) answers. */
export const GEMINI_MODEL = '';
export const GEMINI_AGENT = path.join(ROOT, 'bin', 'gemini-agent.mjs');
/** Antigravity CLI (`agy`): what Google AI Pro/Ultra sign-ins use now. No model saved means its own default. */
export const ANTIGRAVITY_MODEL = '';
export const ANTIGRAVITY_AGENT = path.join(ROOT, 'bin', 'antigravity-agent.mjs');

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);

export const HARNESSES: { id: Harness; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'gemini', label: 'Gemini API key' },
  { id: 'antigravity', label: 'Google Antigravity' },
];
export const HARNESS_IDS: Harness[] = HARNESSES.map((h) => h.id);
export const isHarness = (v: unknown): v is Harness => HARNESS_IDS.includes(v as Harness);
export const CURSOR_MODELS = ['auto', 'grok-4.7', 'composer-2.5'];
export const COPILOT_MODELS = ['', 'claude-sonnet-4.5', 'claude-haiku-4.5', 'gpt-5.4'];
/** '' is Auto; the aliases are Gemini CLI's own (pro, flash, flash-lite). */
export const GEMINI_MODELS = ['', 'pro', 'flash', 'flash-lite'];
/** Slugs from `agy models`; '' is the CLI's default. Claude models are in the list too, on the same plan quota. */
export const ANTIGRAVITY_MODELS = ['', 'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-medium', 'claude-sonnet-5-5-medium'];

/** Where the Google CLIs keep their config and sign-in. */
export const geminiHome = () => process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(process.env.HOME || os.homedir(), '.gemini');

/**
 * Whether `agy` has a Google sign-in here. On Windows and macOS it sits in the system keychain, which a file check can't
 * see, so ~/.gemini/google_accounts.json (written at sign-in, `active` set) stands in; the first run reports a bad one.
 */
export function antigravitySignedIn(): boolean {
  if (process.env.AGY_CREDS) return true;
  // Linux keeps the login in a file; Windows and macOS keep it in the keychain and only record the account.
  if (fs.existsSync(path.join(geminiHome(), 'antigravity-cli', 'antigravity-oauth-token'))) return true;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(geminiHome(), 'google_accounts.json'), 'utf8')) as { active?: unknown };
    return Boolean(j.active);
  } catch {
    return false;
  }
}

/**
 * Whether a harness can run here at all: Claude Code always (its login is in the service's home), Cursor with its API
 * key, Copilot with COPILOT_GITHUB_TOKEN (a fine-grained PAT with "Copilot Requests" or an OAuth token; never the
 * repo-push GH_TOKEN, which agents don't get) or a `copilot login` in COPILOT_HOME (~/.copilot).
 */
export function harnessConfigured(h: Harness): boolean {
  if (h === 'cursor') return Boolean(process.env.CURSOR_API_KEY);
  if (h === 'copilot') {
    if (process.env.COPILOT_GITHUB_TOKEN) return true;
    const home = process.env.COPILOT_HOME || path.join(process.env.HOME || os.homedir(), '.copilot');
    return ['config.json', 'apps.json', 'hosts.json'].some((f) => fs.existsSync(path.join(home, f)) && /oauth|token|login|user/i.test(fs.readFileSync(path.join(home, f), 'utf8').slice(0, 4000)));
  }
  if (h === 'gemini') {
    // Gemini CLI no longer takes personal Google sign-ins (Pro/Ultra: that is Antigravity): a paid API key or Vertex only.
    return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI);
  }
  if (h === 'antigravity') return antigravitySignedIn();
  return true;
}

/** The harnesses to try, in order, when `from` can't run: the others, Claude Code first, then Cursor, Copilot, Antigravity, Gemini. */
export const fallbackChain = (from: Harness): Harness[] => {
  const order = (process.env.STUDIO_HARNESS_ORDER ?? 'claude,cursor,copilot,antigravity,gemini').split(',').map((s) => s.trim()).filter(isHarness);
  return [...new Set([...order, ...HARNESS_IDS])].filter((h) => h !== from);
};

/** The model a harness uses when none is chosen. */
export const defaultModel = (h: Harness) => (h === 'cursor' ? CURSOR_MODEL : h === 'copilot' ? COPILOT_MODEL : h === 'gemini' ? GEMINI_MODEL : h === 'antigravity' ? ANTIGRAVITY_MODEL : '');
export const CLAUDE_MODELS = ['', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function row() {
  const r = db.prepare('SELECT value, updated, by FROM settings WHERE key = ?').get('brain') as { value: string; updated: number; by: string | null } | undefined;
  return r ? { value: parse(r.value) as { id?: string; harness?: string; model?: string }, updated: r.updated, by: r.by } : null;
}

function normalize(value: { id?: string; harness?: string; model?: string } | null | undefined): { harness: Harness; model: string } {
  const raw = value?.harness ?? value?.id ?? 'claude';
  const harness: Harness = raw === 'cursor' || raw === 'grok' ? 'cursor' : raw === 'copilot' ? 'copilot' : raw === 'gemini' ? 'gemini' : raw === 'antigravity' ? 'antigravity' : 'claude';
  const model = typeof value?.model === 'string' ? value.model : defaultModel(harness);
  return { harness, model: harness === 'cursor' && !model ? CURSOR_MODEL : model };
}

/**
 * The harness standing in while the chosen one is held (harness-hold.ts: J's chosen harness ran out of usage, needs
 * billing or a login, and the other one answers). J's choice stays saved; this is cleared when it answers again.
 */
export type Failover = { harness: Harness; from: Harness; since: number; why: string };
export function failover(): Failover | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('brain.failover') as { value: string } | undefined;
  const v = r ? (parse(r.value) as Failover | null) : null;
  return v && isHarness(v.harness) && isHarness(v.from) ? v : null;
}
export function setFailover(f: Failover | null) {
  if (!f) return void db.prepare('DELETE FROM settings WHERE key = ?').run('brain.failover');
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('brain.failover', J(f), Date.now(), 'Studio');
}

/**
 * The harness in use: J's choice (Settings, or HAWKES_BRAIN), or the failover standing in for it. `chosen` is J's
 * choice either way; `model` is the chosen model, or the stand-in's default (Claude: each role's own; Cursor: Auto).
 */
export function brainSettings(): { harness: Harness; model: string; id: Harness; saved: number | null; key: boolean; copilot: boolean; gemini: boolean; antigravity: boolean; chosen: Harness; failover: Failover | null } {
  const env = process.env.HAWKES_BRAIN;
  const saved = row();
  const forced: Harness | null = env === 'grok' ? 'cursor' : isHarness(env) ? env : null;
  const base = forced
    ? { harness: forced, model: forced === 'claude' ? '' : (saved?.value?.model || defaultModel(forced)) }
    : normalize(saved?.value);
  const f = failover();
  const stand = f && f.from === base.harness && f.harness !== base.harness ? f : null;
  const eff = stand ? { harness: stand.harness, model: defaultModel(stand.harness) } : base;
  return { ...eff, id: eff.harness, saved: saved?.updated ?? null, key: Boolean(process.env.CURSOR_API_KEY), copilot: harnessConfigured('copilot'), gemini: harnessConfigured('gemini'), antigravity: harnessConfigured('antigravity'), chosen: base.harness, failover: stand };
}

export const brainId = (): Harness => brainSettings().harness;
export const brainLabel = () => { const id = brainId(); return id === 'cursor' ? 'Cursor' : id === 'copilot' ? 'Copilot' : id === 'gemini' ? 'Gemini' : id === 'antigravity' ? 'Antigravity' : 'Claude'; };

/**
 * The harness refused to run: a usage cap or no login. That is not a diagnosis and not the agent's try
 * (a scout report that is only this must not be pasted into the next brief).
 */
export function harnessBlocked(text: string) {
  return Boolean(harnessStopOf(text, { kinds: ['usage', 'billing', 'auth'] }));
}

/**
 * Why the harness (not the agent) stopped: `usage` (a usage or rate cap that resets), `billing` (an unpaid invoice, no
 * credit: J has to pay), `auth` (no login: J has to sign in), `transient` (overloaded, a 5xx, a 429: it passes by itself).
 * `line`: the line that says so; `resetsAt`: when the text says the cap resets ("resets 8:40am (UTC)", "resets Oct 23,
 * 1pm (UTC)"), else null.
 */
export type HarnessKind = 'usage' | 'billing' | 'auth' | 'transient';
export type HarnessStop = { kind: HarnessKind; line: string; resetsAt: number | null };
const STOPS: [HarnessKind, RegExp][] = [
  ['billing', /unpaid invoice|pay your (unpaid )?invoice|credit balance is too low|insufficient (credit|credits|balance|funds)|billing (issue|error|problem)|payment (required|failed)|\b402\b.{0,40}(payment|billing)|ActionRequiredError|no (remaining )?premium requests|Copilot (subscription|license|plan).{0,40}(expired|inactive|suspended|not active|required)|(no|don'?t have (an )?active) Copilot (access|subscription|license|seat)/i],
  ['auth', /Authentication required|agent login|run [`'"]?(claude|agent) login|CURSOR_API_KEY|not logged in|please log ?in|invalid (api key|x-api-key|bearer token)|OAuth token (has )?(expired|revoked)|authentication_error|\b401\b.{0,30}(unauthori[sz]ed|auth)|No authentication information found|Classic Personal Access Tokens?|COPILOT_GITHUB_TOKEN|copilot[` '"]*\/?login  |not authenticated|Bad credentials|Please set an Auth method|GEMINI_API_KEY|GOOGLE_GENAI_USE_|gemini[` '"]*\/?(auth|login)|Failed to login|API key not valid|authentication failed or timed out/i],
    ['usage', /weekly limit|hit your (\w+ )?limit|out of usage|usage limits? (will )?resets?|usage limit|limit to continue|Switch to Auto|(usage|rate) limit (reached|exceeded)|resets (at )?\d{1,2}(:\d\d)?\s*(am|pm)|Claude AI usage limit|quota (has been )?(exceeded|exhausted|reached)|premium requests?.{0,40}(limit|quota|exhausted|exceeded)|exceeded your .{0,30}(quota|limit|allowance)|exhausted your (capacity|quota)|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|quota will reset after/i],
  // Only a harness's own error wording: an agent's summary about rate limiting in a game is not this.
  ['transient', /overloaded_error|"type":\s*"overloaded|\bOverloaded\b|rate_limit_error|API Error:?\s*(429|5\d\d)|\b(429|500|502|503|504|529)\b\s*(Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|overloaded)|Internal server error|Service Unavailable|ECONNRESET|socket hang up|fetch failed|Request timed out|api_error/i],
];

/**
 * `kinds`: which kinds to look for. The harness's own output (the result, stderr) is read for all of them; an agent's
 * own words (its summary) only for usage and billing, so a summary about a game's login screen or its fetch errors
 * isn't taken for one.
 */
export function harnessStopOf(text: string, { now = Date.now(), kinds }: { now?: number; kinds?: HarnessKind[] } = {}): HarnessStop | null {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const [kind, re] of STOPS) {
    if (kinds && !kinds.includes(kind)) continue;
    const line = lines.find((l) => re.test(l));
    if (!line) continue;
    const all = lines.join('\n');
    return { kind, line: line.slice(0, 300), resetsAt: kind === 'usage' || kind === 'transient' ? resetTime(all, now) : null };
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Minutes a time zone is ahead of UTC at `at` (UTC/GMT or unknown: 0). */
function zoneOffset(zone: string, at: number) {
  if (!zone || /^(utc|gmt|z)$/i.test(zone)) return 0;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at).map((p) => [p.type, p.value]));
    return Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - Math.floor(at / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}
/** "resets 8:40am (UTC)", "resets Oct 23, 1pm (UTC)", "resets at 13:00 (Europe/London)": the next such moment after `now`. */
export function resetTime(text: string, now = Date.now()): number | null {
  // Gemini: "Your quota will reset after 3h45m12s" (a wait, not a clock time).
  const rel = /reset(?:s)? after\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i.exec(String(text ?? ''));
  if (rel && (rel[1] || rel[2] || rel[3])) return now + Math.ceil(((Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 1000);
  const m = /resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\)|([A-Z]{2,4})\b)?/i.exec(String(text ?? ''));
  if (!m) return null;
  const month = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
  if (m[1] && month < 0) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const ampm = m[5]?.toLowerCase();
  if (!ampm && m[4] === undefined) return null; // "resets 3" is not a time
  if (hour > 23 || minute > 59 || (ampm && (hour < 1 || hour > 12))) return null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const zone = (m[6] ?? m[7] ?? 'UTC').trim();
  const off = zoneOffset(zone, now);
  const d = new Date(now + off * 60_000);
  let y = d.getUTCFullYear();
  let at = Date.UTC(y, month >= 0 ? month : d.getUTCMonth(), month >= 0 ? Number(m[2]) : d.getUTCDate(), hour, minute) - off * 60_000;
  if (month >= 0) {
    if (at <= now - 86_400_000) at = Date.UTC(++y, month, Number(m[2]), hour, minute) - off * 60_000;
  } else if (at <= now) at += 86_400_000;
  return at;
}

export function saveBrain(patch: string | { harness?: string; model?: string; id?: string }, by = 'J') {
  const asked = typeof patch === 'string' ? patch : (patch.harness ?? patch.id);
  if (asked !== undefined && asked !== 'grok' && !isHarness(asked)) throw new Error('harness: claude | cursor | copilot | gemini | antigravity');
  const cur = normalize(row()?.value);
  const next = typeof patch === 'string' ? normalize({ ...cur, id: patch, harness: patch }) : normalize({ ...cur, ...patch, harness: patch.harness ?? patch.id ?? cur.harness });
  if (!isHarness(next.harness)) throw new Error('harness: claude | cursor | copilot | gemini | antigravity');
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('brain', J({ harness: next.harness, model: next.model }), Date.now(), by);
  // A harness picked on purpose ends any stand-in (harness-hold.ts holds it again if it can't run).
  setFailover(null);
  return brainSettings();
}

/** Tells Hawkes Gen to use the same harness (its settings.brain). Best effort. Gen requires the owner key. */
export async function syncBrain(harness: Harness = brainId()): Promise<boolean> {
  try {
    const key = process.env.HAWKESGEN_KEY || process.env.DEV_GEN_KEY || '';
    const r = await fetch(`${GEN_URL}/v1/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ brain: harness, model: brainSettings().model || undefined }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.warn(`[studio] Gen did not take the harness (HTTP ${r.status}).`);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * On the control server, a Studio that has never stored a brain runs on Cursor when the Cursor key is present
 * (Claude usage is out). Call this before agents are reattached.
 */
export function chooseBrain() {
  if (process.env.STUDIO_SERVER !== '1' || process.env.HAWKES_BRAIN) return brainSettings();
  if (!row() && process.env.CURSOR_API_KEY) {
    saveBrain({ harness: 'cursor', model: CURSOR_MODEL }, 'Studio');
    console.log('[studio] Harness set to Cursor, model Auto. Claude usage is out.');
  } else if (!row() && harnessConfigured('copilot')) {
    saveBrain({ harness: 'copilot', model: COPILOT_MODEL }, 'Studio');
    console.log('[studio] Harness set to GitHub Copilot. Claude usage is out and there is no Cursor key.');
  }
  const s = brainSettings();
  if (s.harness === 'cursor' && !s.key) console.warn('[studio] Harness is Cursor but CURSOR_API_KEY is not in the environment. Add it to the hawkes/cursor secret and restart hawkes-secrets, hawkes-gen and hawkes-studio.');
  if (s.harness === 'copilot' && !harnessConfigured('copilot')) console.warn('[studio] Harness is Copilot but there is no COPILOT_GITHUB_TOKEN (a fine-grained PAT with "Copilot Requests") or copilot login. See docs/copilot.md.');
  if (s.harness === 'gemini' && !harnessConfigured('gemini')) console.warn('[studio] Harness is Gemini API key but there is no GEMINI_API_KEY. See docs/gemini.md.');
  if (s.harness === 'antigravity' && !harnessConfigured('antigravity')) console.warn('[studio] Harness is Antigravity but `agy` has no Google sign-in here. See docs/gemini.md.');
  return s;
}

/** chooseBrain, then tell Hawkes Gen. */
export async function ensureBrain() {
  const chosen = chooseBrain();
  const ok = await syncBrain(chosen.harness);
  if (!ok && process.env.STUDIO_SERVER === '1') console.warn(`[studio] Could not tell Hawkes Gen to use ${chosen.harness}. Gen keeps its own brain until it answers.`);
  return chosen;
}
