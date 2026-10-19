// Which brain runs Talk, the agents, scouts and (through Hawkes Gen) reviews and JSON calls.
// "claude" is Claude Code, as before. "grok" is Grok 4.7 on xAI (bin/grok-agent.mjs), because Claude usage ran out
// (J, 2026-10-19). The choice is in Studio's settings table and shown on the Settings tab. On the server, the first
// boot after this ships sets Grok when nobody has chosen, and tells Gen the same.

import { db, J, parse } from './db.ts';
import { GEN_URL, ROOT } from './config.ts';
import path from 'node:path';

export type BrainId = 'claude' | 'grok';
export const GROK_MODEL = 'grok-4.7';
export const GROK_AGENT = path.join(ROOT, 'bin', 'grok-agent.mjs');

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);

export const BRAINS: { id: BrainId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'grok', label: 'Grok 4.7' },
];

function row() {
  const r = db.prepare('SELECT value, updated, by FROM settings WHERE key = ?').get('brain') as { value: string; updated: number; by: string | null } | undefined;
  return r ? { value: parse(r.value) as { id?: string }, updated: r.updated, by: r.by } : null;
}

export function brainSettings(): { id: BrainId; model: string; saved: number | null; key: boolean } {
  const env = process.env.HAWKES_BRAIN;
  const saved = row();
  const id: BrainId = env === 'grok' || env === 'claude' ? env : saved?.value?.id === 'grok' ? 'grok' : 'claude';
  return { id, model: id === 'grok' ? GROK_MODEL : 'claude', saved: saved?.updated ?? null, key: Boolean(process.env.XAI_API_KEY) };
}

export const brainId = (): BrainId => brainSettings().id;
export const brainLabel = () => (brainId() === 'grok' ? 'Grok' : 'Claude');

export function saveBrain(id: string, by = 'J') {
  if (id !== 'claude' && id !== 'grok') throw new Error('brain.id: claude | grok');
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('brain', J({ id }), Date.now(), by);
  return brainSettings();
}

/** Tells the local Hawkes Gen to use the same brain (its settings.brain). Best effort. */
export async function syncBrain(id: BrainId = brainId()): Promise<boolean> {
  try {
    const r = await fetch(`${GEN_URL}/v1/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: id }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * On the control server, a Studio that has never stored a brain runs on Grok (Claude usage is out).
 * Call this before agents are reattached, so a pass that was on Claude starts again on Grok.
 */
export function chooseBrain() {
  if (process.env.STUDIO_SERVER !== '1' || process.env.HAWKES_BRAIN) return brainSettings();
  if (!row()) {
    saveBrain('grok', 'Studio');
    console.log('[studio] Brain set to Grok 4.7. Claude usage is out; Talk and the agents run on xAI.');
  }
  const id = brainId();
  if (id === 'grok' && !process.env.XAI_API_KEY) console.warn('[studio] Brain is Grok but XAI_API_KEY is not in the environment. Add it to the hawkes/gen secret and restart hawkes-secrets, hawkes-gen and hawkes-studio.');
  return brainSettings();
}

/** chooseBrain, then tell Hawkes Gen. Gen's own settings file also moves to Grok the first time it is read. */
export async function ensureBrain() {
  const chosen = chooseBrain();
  const ok = await syncBrain(chosen.id);
  if (!ok && process.env.STUDIO_SERVER === '1') console.warn(`[studio] Could not tell Hawkes Gen to use ${chosen.id}. Gen keeps its own brain until it answers.`);
  return chosen;
}
