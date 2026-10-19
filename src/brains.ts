// Which harness runs Talk, the agents, scouts and (through Hawkes Gen) reviews and JSON calls, and which model it uses.
// "claude" is Claude Code, as before. "cursor" is Cursor's `agent` on the Cursor plan (bin/cursor-agent.mjs,
// CURSOR_API_KEY). An older saved "grok" meant the xAI API; it now means the Cursor harness on Grok 4.7.
// The choice is in Studio's settings table and shown on the Settings tab. On the server, a Studio that has never
// chosen runs on Cursor when the Cursor key is present.

import { db, J, parse } from './db.ts';
import { GEN_URL, ROOT } from './config.ts';
import path from 'node:path';

export type Harness = 'claude' | 'cursor';
export const CURSOR_MODEL = 'grok-4.7';
export const CURSOR_AGENT = path.join(ROOT, 'bin', 'cursor-agent.mjs');

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);

export const HARNESSES: { id: Harness; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
];
export const CURSOR_MODELS = [CURSOR_MODEL, 'composer-2.5'];
export const CLAUDE_MODELS = ['', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function row() {
  const r = db.prepare('SELECT value, updated, by FROM settings WHERE key = ?').get('brain') as { value: string; updated: number; by: string | null } | undefined;
  return r ? { value: parse(r.value) as { id?: string; harness?: string; model?: string }, updated: r.updated, by: r.by } : null;
}

function normalize(value: { id?: string; harness?: string; model?: string } | null | undefined): { harness: Harness; model: string } {
  const raw = value?.harness ?? value?.id ?? 'claude';
  const harness: Harness = raw === 'cursor' || raw === 'grok' ? 'cursor' : 'claude';
  const model = typeof value?.model === 'string' ? value.model : (harness === 'cursor' ? CURSOR_MODEL : '');
  return { harness, model: harness === 'cursor' && !model ? CURSOR_MODEL : model };
}

export function brainSettings(): { harness: Harness; model: string; id: Harness; saved: number | null; key: boolean } {
  const env = process.env.HAWKES_BRAIN;
  const saved = row();
  const base = env === 'cursor' || env === 'grok' || env === 'claude'
    ? { harness: (env === 'claude' ? 'claude' : 'cursor') as Harness, model: env === 'claude' ? '' : (saved?.value?.model || CURSOR_MODEL) }
    : normalize(saved?.value);
  return { ...base, id: base.harness, saved: saved?.updated ?? null, key: Boolean(process.env.CURSOR_API_KEY) };
}

export const brainId = (): Harness => brainSettings().harness;
export const brainLabel = () => (brainId() === 'cursor' ? 'Cursor' : 'Claude');

/**
 * The harness refused to run: a usage cap or no login. That is not a diagnosis and not the agent's try
 * (a scout report that is only this must not be pasted into the next brief).
 */
export function harnessBlocked(text: string) {
  return /weekly limit|Authentication required|agent login|CURSOR_API_KEY|hit your (usage|rate) limit/i.test(String(text ?? ''));
}

export function saveBrain(patch: string | { harness?: string; model?: string; id?: string }, by = 'J') {
  const asked = typeof patch === 'string' ? patch : (patch.harness ?? patch.id);
  if (asked !== undefined && asked !== 'claude' && asked !== 'cursor' && asked !== 'grok') throw new Error('harness: claude | cursor');
  const cur = normalize(row()?.value);
  const next = typeof patch === 'string' ? normalize({ ...cur, id: patch, harness: patch }) : normalize({ ...cur, ...patch, harness: patch.harness ?? patch.id ?? cur.harness });
  if (next.harness !== 'claude' && next.harness !== 'cursor') throw new Error('harness: claude | cursor');
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('brain', J({ harness: next.harness, model: next.model }), Date.now(), by);
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
    console.log('[studio] Harness set to Cursor, model Grok 4.7. Claude usage is out.');
  }
  const s = brainSettings();
  if (s.harness === 'cursor' && !s.key) console.warn('[studio] Harness is Cursor but CURSOR_API_KEY is not in the environment. Add it to the hawkes/cursor secret and restart hawkes-secrets, hawkes-gen and hawkes-studio.');
  return s;
}

/** chooseBrain, then tell Hawkes Gen. */
export async function ensureBrain() {
  const chosen = chooseBrain();
  const ok = await syncBrain(chosen.harness);
  if (!ok && process.env.STUDIO_SERVER === '1') console.warn(`[studio] Could not tell Hawkes Gen to use ${chosen.harness}. Gen keeps its own brain until it answers.`);
  return chosen;
}
