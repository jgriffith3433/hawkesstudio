// Settings: one API for everything J can set (the dashboard's ⚙ Settings tab and Talk's studio_settings tool), stored
// in Studio so they follow J from his laptop to his phone.
//
//   call     how calls sound and listen (this file's `settings` table; dashboard/call.js reads it)
//   agents   agent limits (agents.ts, .data/agents.json)
//   pm       the PM loop (pm.ts, .data/pm.json)
//   notify   phone notifications (notify.ts; the topic and server are the dashboard's only)
//   costs    the budget and alert limits (costs.ts)
//
// Changes that can raise what Studio spends (more agents or starts, higher limits or budget, the paid voice) need J's
// own yes when they come from Talk: the request quotes his words and Studio checks they are in his messages there.

import { db, J, parse } from './db.ts';
import { StudioError } from './config.ts';

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);

export type CallEngine = 'kokoro' | 'browser' | 'eleven';
export type CallMode = 'push' | 'hands-free';
export type CallSettings = {
  /**
   * The voice: the browser's own (free, instant: the default), Kokoro running in the browser (free, more natural, but
   * measured too slow on J's laptop's integrated graphics: 1.2-2.5 s for a short sentence on WebGPU, 5-14 s on the CPU),
   * or ElevenLabs Flash through Gen (paid).
   */
  engine: CallEngine;
  /** Kokoro's voice (kokoro-js voice id). */
  kokoroVoice: string;
  /** ElevenLabs voice id (engine eleven). */
  elevenVoice: string;
  /** Speaking speed, 0.8–1.4. */
  rate: number;
  /** Listening per kind of device: push to talk (hold the button or Space) or hands-free (a pause sends). */
  mode: { computer: CallMode; phone: CallMode };
  /** Hands-free: the mic stays on while Talk speaks, so talking interrupts it (only with headphones: else it hears itself). */
  bargeIn: boolean;
  /** Hands-free: ms of silence that ends J's turn. */
  pause: number;
};
export const CALL_DEFAULTS: CallSettings = {
  engine: 'browser', kokoroVoice: 'af_heart', elevenVoice: '', rate: 1.05,
  mode: { computer: 'push', phone: 'hands-free' }, bargeIn: false, pause: 800,
};
/** ElevenLabs Flash: about 900 characters a spoken minute at half the standard voices' credits ($0.30 per 1,000). */
export const ELEVEN_PER_MIN = (900 / 1000) * 0.3 * 0.5;

function getRow(key: string) {
  const r = db.prepare('SELECT value, updated, by FROM settings WHERE key = ?').get(key) as { value: string; updated: number; by: string | null } | undefined;
  return r ? { value: parse(r.value), updated: r.updated, by: r.by } : null;
}

export function callSettings(): CallSettings & { saved: number | null } {
  const r = getRow('call');
  const v = (r?.value ?? {}) as Partial<CallSettings>;
  return { ...CALL_DEFAULTS, ...v, mode: { ...CALL_DEFAULTS.mode, ...(v.mode ?? {}) }, saved: r?.updated ?? null };
}

function cleanCall(patch: any, cur: CallSettings): CallSettings {
  const next: CallSettings = { ...cur, mode: { ...cur.mode } };
  if (patch.engine !== undefined) {
    if (!['kokoro', 'browser', 'eleven'].includes(patch.engine)) throw new StudioError('call.engine: kokoro | browser | eleven');
    next.engine = patch.engine;
  }
  if (patch.kokoroVoice !== undefined) {
    if (!/^[a-z]{2}_[a-z]+$/.test(String(patch.kokoroVoice))) throw new StudioError('call.kokoroVoice: a Kokoro voice id like af_heart');
    next.kokoroVoice = String(patch.kokoroVoice);
  }
  if (patch.elevenVoice !== undefined) next.elevenVoice = String(patch.elevenVoice).slice(0, 64);
  if (patch.rate !== undefined) {
    const r = Number(patch.rate);
    if (!(r >= 0.8 && r <= 1.4)) throw new StudioError('call.rate: 0.8 to 1.4');
    next.rate = Math.round(r * 100) / 100;
  }
  if (patch.mode !== undefined) {
    const m = typeof patch.mode === 'string' ? { computer: patch.mode, phone: patch.mode } : patch.mode;
    for (const k of ['computer', 'phone'] as const) {
      if (m?.[k] === undefined) continue;
      if (m[k] !== 'push' && m[k] !== 'hands-free') throw new StudioError(`call.mode.${k}: push | hands-free`);
      next.mode[k] = m[k];
    }
  }
  if (patch.bargeIn !== undefined) next.bargeIn = patch.bargeIn === true;
  if (patch.pause !== undefined) {
    const p = Number(patch.pause);
    if (!(p >= 300 && p <= 3000)) throw new StudioError('call.pause: 300 to 3000 ms');
    next.pause = Math.round(p);
  }
  return next;
}

// ------------------------------------------------------------ all of them

const agentsMod = () => import('./agents.ts');
const pmMod = () => import('./pm.ts');
const notifyMod = () => import('./notify.ts');
const costsMod = () => import('./costs.ts');

export const SECTIONS = ['call', 'agents', 'pm', 'notify', 'costs'] as const;
export type Section = (typeof SECTIONS)[number];

/** Everything, for the Settings tab and Talk. */
export async function allSettings() {
  const { agentSettings } = await agentsMod();
  const { pmSettings } = await pmMod();
  const { notifyInfo } = await notifyMod();
  const { costSettings } = await costsMod();
  return {
    call: callSettings(),
    agents: agentSettings(),
    pm: pmSettings(),
    notify: notifyInfo(),
    costs: costSettings(),
    prices: { elevenPerMinute: Math.round(ELEVEN_PER_MIN * 100) / 100 },
  };
}

/** Numbers that spend more when they go up, and switches that spend more when they go on (per section). */
const RAISES: Record<Section, { up?: string[]; on?: string[]; off?: string[]; any?: string[] }> = {
  call: {},
  agents: { up: ['maxConcurrent', 'maxPerDay', 'maxCostPerDay', 'maxTurns'], on: ['enabled', 'autoFix'], any: ['model', 'severities'] },
  pm: { up: ['maxStartsPerDay', 'maxConcurrent', 'maxTries'], on: ['enabled', 'fixBugs'] },
  notify: {},
  costs: { up: ['budget', 'gpuHours', 'builderHours', 'playtesterHours'], off: ['alerts'] },
};

/** What in this patch could raise costs (empty: nothing). */
export function costRaising(section: Section, patch: Record<string, any>, cur: Record<string, any>): string[] {
  const r = RAISES[section];
  const out: string[] = [];
  for (const k of r.up ?? []) if (patch[k] !== undefined && Number(patch[k]) > Number(cur[k])) out.push(`${k} ${cur[k]} → ${patch[k]}`);
  for (const k of r.on ?? []) if (patch[k] === true && cur[k] !== true) out.push(`${k} on`);
  for (const k of r.off ?? []) if (patch[k] === false && cur[k] !== false) out.push(`${k} off`);
  for (const k of r.any ?? []) if (patch[k] !== undefined && J(patch[k]) !== J(cur[k])) out.push(`${k} → ${J(patch[k])}`);
  if (section === 'call' && patch.engine === 'eleven' && cur.engine !== 'eleven') out.push(`the ElevenLabs voice (about $${ELEVEN_PER_MIN.toFixed(2)} a minute Talk speaks)`);
  return out;
}

export type SaveFrom = {
  /** The Talk conversation the request comes from (X-Talk-Conversation), or null from the dashboard. */
  conversation: string | null;
  /** J's own words approving it (Talk passes them; checked against his messages in that conversation). */
  quote?: string | null;
  by?: string;
};

/** Changes one section. From Talk, cost-raising changes need J's quoted yes; notifications' topic is the dashboard's. */
export async function saveSettings(section: string, patch: Record<string, any>, from: SaveFrom): Promise<Record<string, any>> {
  if (!SECTIONS.includes(section as Section)) throw new StudioError(`section: ${SECTIONS.join(' | ')}`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StudioError('patch: the fields to change');
  const s = section as Section;
  const all = await allSettings();
  const cur = all[s] as Record<string, any>;
  const by = from.by ?? (from.conversation ? 'Talk' : 'J');
  if (from.conversation) {
    const raising = costRaising(s, patch, cur);
    if (raising.length) {
      const { jSaid } = await import('./memory.ts');
      if (!jSaid(from.conversation, from.quote)) {
        throw new StudioError(`This can raise costs (${raising.join(', ')}): ask J, and pass his own yes as quote (his exact words from this conversation).`, 403);
      }
    }
    if (s === 'notify' && (patch.rotate || patch.server !== undefined)) throw new StudioError('The notification topic and server are changed on the dashboard (Settings), not from Talk.', 403);
  }
  if (s === 'call') {
    const next = cleanCall(patch, callSettings());
    db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
      .run('call', J(next), Date.now(), by);
    return callSettings();
  }
  if (s === 'agents') {
    const { saveAgentSettings, agentSettings } = await agentsMod();
    const known = agentSettings() as Record<string, any>;
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in known)) throw new StudioError(`agents.${k}: not a setting (${Object.keys(known).join(', ')})`);
      if (k === 'severities') { if (!Array.isArray(v)) throw new StudioError('agents.severities: a list'); clean[k] = v.map(String); continue; }
      if (typeof v !== typeof known[k]) throw new StudioError(`agents.${k} must be a ${typeof known[k]}`);
      if (typeof v === 'number' && !(v >= 0)) throw new StudioError(`agents.${k}: 0 or more`);
      clean[k] = v;
    }
    return saveAgentSettings(clean);
  }
  if (s === 'pm') return (await pmMod()).savePmSettings(patch, by);
  if (s === 'notify') {
    const { saveNotifySettings } = await notifyMod();
    return saveNotifySettings({ enabled: typeof patch.enabled === 'boolean' ? patch.enabled : undefined, server: patch.server, rotate: patch.rotate === true });
  }
  return (await costsMod()).saveCostSettings(patch);
}
