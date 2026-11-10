// Several AI providers at once (J, 2026-11-09: "have studio constantly working and able to easily switch between providers
// or even use multiple providers at once ... the studio should be able to use the multiple providers almost seamlessly").
//
// Settings → AI providers keeps (settings key "providers"):
//   mode   "spread": every signed-in provider that answers takes agent passes and scouts, each new pass on the least busy
//          one (a resumed pass stays on the provider that holds its session while that one answers);
//          "one": everything on the harness chosen in Settings → Harness, as before, and the next provider in the order
//          stands in while it is held (harness-hold.ts failover).
//   order  the order providers are tried in (failover's chain and spread's tie-break).
//   off    providers J switched off: never used, even as a stand-in.
//   roles  a provider per role (builder on Codex, scouts on Cursor...): used while it answers, else the spread picks.
//   caps   the most passes each provider runs at once (J, 2026-11-10: "use multiple providers at once as to not get
//          throttled by any one provider"). Code work (builder, fixer, content, reviewer) goes to the best provider in J's
//          order that has room under its cap and wasn't throttled in the last minutes, so Claude takes the deep work
//          first and the rest overflows to the others; scouts and unnamed work go to the least busy. A provider that
//          throttles (a hold) loses only its own slots, and gets them back by itself when it answers.
// A provider is ready when it is set up here (a sign-in or key: brains.ts harnessConfigured), its CLI is installed, J
// hasn't switched it off and no hold is on it (harness-hold.ts: a usage limit, billing, a lost sign-in, an outage).
// Talk and Hawkes Gen's calls stay on the chosen harness (and its stand-in): one voice in Talk.

import fs from 'node:fs';
import path from 'node:path';
import { db, J, parse } from './db.ts';
import { StudioError } from './config.ts';
import { DEFAULT_ORDER, HARNESSES, HARNESS_IDS, brainId, brainSettings, harnessConfigured, isHarness, setOrderSource, type Harness } from './brains.ts';
import { activeHold, activeHolds, getHold, LABEL, needsJ, setSpreadOthers, type Hold } from './harness-hold.ts';
import { TUNED_ROLES, type TunedRole } from './tuning.ts';
// @ts-ignore: plain .mjs adapters, no types
import { agentBin } from '../bin/cursor-agent.mjs';
// @ts-ignore
import { copilotBin } from '../bin/copilot-agent.mjs';
// @ts-ignore
import { codexBin } from '../bin/codex-agent.mjs';
// @ts-ignore
import { agyBin } from '../bin/antigravity-agent.mjs';
// @ts-ignore
import { geminiBin } from '../bin/gemini-agent.mjs';

export type ProviderMode = 'spread' | 'one';
export type ProviderSettings = { mode: ProviderMode; order: Harness[]; off: Harness[]; roles: Partial<Record<TunedRole, Harness>>; caps: Record<Harness, number> };
/** How many passes each provider runs at once unless J sets it (Copilot counts premium requests, so it runs few). */
export const DEFAULT_CAPS: Record<Harness, number> = { claude: 4, codex: 3, cursor: 6, copilot: 2, antigravity: 3, gemini: 3 };
const capsOf = (v: unknown): Record<Harness, number> => {
  const out = { ...DEFAULT_CAPS };
  for (const [h, n] of Object.entries((v && typeof v === 'object' ? v : {}) as Record<string, unknown>)) if (isHarness(h) && Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 50) out[h] = n as number;
  return out;
};
/** Roles whose work is code that quality matters most for: they go to the best provider with room, not the least busy. */
const QUALITY_ROLES = new Set(['builder', 'fixer', 'content', 'reviewer', 'pm']);
/** A provider whose hold lifted this recently is tried after the others (it may still be throttling). */
const COOL_MS = () => (Number(process.env.STUDIO_PROVIDER_COOL_MS) >= 0 && process.env.STUDIO_PROVIDER_COOL_MS ? Number(process.env.STUDIO_PROVIDER_COOL_MS) : 15 * 60_000);
const KEY = 'providers';
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);

const fullOrder = (o: unknown): Harness[] => [...new Set([...(Array.isArray(o) ? o.filter(isHarness) : []), ...DEFAULT_ORDER, ...HARNESS_IDS])];

export function providerSettings(): ProviderSettings & { saved: number | null } {
  const row = db.prepare('SELECT value, updated FROM settings WHERE key = ?').get(KEY) as { value: string; updated: number } | undefined;
  const v = (row ? parse(row.value) : null) as Partial<ProviderSettings> | null;
  const roles: ProviderSettings['roles'] = {};
  for (const [r, h] of Object.entries(v?.roles ?? {})) if (TUNED_ROLES.includes(r as TunedRole) && isHarness(h)) roles[r as TunedRole] = h;
  const envMode = process.env.STUDIO_PROVIDERS_MODE;
  return {
    mode: envMode === 'one' || envMode === 'spread' ? envMode : v?.mode === 'one' ? 'one' : 'spread',
    order: fullOrder(v?.order ?? (process.env.STUDIO_HARNESS_ORDER ?? '').split(',').map((s) => s.trim())),
    off: (Array.isArray(v?.off) ? v!.off : []).filter(isHarness),
    roles, caps: capsOf(v?.caps), saved: row?.updated ?? null,
  };
}
// The failover chain (brains.ts fallbackChain) follows J's order, without the providers he switched off.
setOrderSource(() => {
  try {
    const s = providerSettings();
    return s.saved ? s.order.filter((h) => !s.off.includes(h)) : null;
  } catch {
    return null;
  }
});

export function saveProviders(patch: Record<string, any>, by = 'J') {
  const cur = providerSettings();
  const next: ProviderSettings = { mode: cur.mode, order: cur.order, off: cur.off, roles: { ...cur.roles }, caps: { ...cur.caps } };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'mode') {
      if (v !== 'spread' && v !== 'one') throw new StudioError('providers.mode: spread | one');
      next.mode = v;
    } else if (k === 'order') {
      if (!Array.isArray(v) || v.some((h) => !isHarness(h))) throw new StudioError(`providers.order: a list of ${HARNESS_IDS.join(', ')}`);
      next.order = fullOrder(v);
    } else if (k === 'off') {
      if (!Array.isArray(v) || v.some((h) => !isHarness(h))) throw new StudioError(`providers.off: a list of ${HARNESS_IDS.join(', ')}`);
      next.off = [...new Set(v as Harness[])];
    } else if (k === 'use') {
      // { use: { codex: false } }: one provider on or off.
      for (const [h, on] of Object.entries(v ?? {})) {
        if (!isHarness(h)) throw new StudioError(`providers.use.${h}: ${HARNESS_IDS.join(' | ')}`);
        next.off = on ? next.off.filter((x) => x !== h) : [...new Set([...next.off, h])];
      }
    } else if (k === 'roles') {
      for (const [r, h] of Object.entries(v ?? {})) {
        if (!TUNED_ROLES.includes(r as TunedRole)) throw new StudioError(`providers.roles.${r}: ${TUNED_ROLES.join(' | ')}`);
        if (h === '' || h === null) delete next.roles[r as TunedRole];
        else if (isHarness(h)) next.roles[r as TunedRole] = h;
        else throw new StudioError(`providers.roles.${r}: ${HARNESS_IDS.join(' | ')} (or empty: any)`);
      }
    } else if (k === 'caps') {
      // { caps: { claude: 6 } }: the most passes a provider runs at once (1 to 50).
      for (const [h, n] of Object.entries(v ?? {})) {
        if (!isHarness(h)) throw new StudioError(`providers.caps.${h}: ${HARNESS_IDS.join(' | ')}`);
        if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 50) throw new StudioError(`providers.caps.${h}: a whole number, 1 to 50`);
        next.caps[h] = n as number;
      }
    } else throw new StudioError(`providers.${k}: not a setting (mode, order, off, use, roles, caps)`);
  }
  if (next.off.length >= HARNESS_IDS.length) throw new StudioError('Leave at least one provider on.');
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(KEY, J(next), Date.now(), by);
  void import('./stream.ts').then((s) => s.changed('ai-logins')).catch(() => {});
  // A provider back on (or the spread turned on) may let parked work go now.
  void import('./harness-hold.ts').then((h) => h.resumeNow()).catch(() => {});
  return providerSettings();
}

// ---------------------------------------------------------------- ready or not

const BINS: Partial<Record<Harness, () => string>> = {
  cursor: () => String(agentBin()), copilot: () => String(copilotBin()), codex: () => String(codexBin()), antigravity: () => String(agyBin()), gemini: () => String(geminiBin()),
};
const lookPath = (bin: string) => (path.isAbsolute(bin) ? fs.existsSync(bin) : (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin))));
// A CLI is installed or not for minutes at a time: one look at the disk per 30 s, not one per call (the picker runs often).
const pathSeen = new Map<string, { at: number; on: boolean }>();
const onPath = (bin: string) => {
  const seen = pathSeen.get(bin);
  if (seen && Date.now() - seen.at < 30_000) return seen.on;
  const on = lookPath(bin);
  pathSeen.set(bin, { at: Date.now(), on });
  return on;
};

/** What the picker reads (tests replace them). */
export const providerDeps = {
  /** Whether the provider's CLI can be started here (Claude Code: always; it is Studio's own). */
  installed: (h: Harness) => (h === 'claude' ? true : onPath(BINS[h]?.() ?? h)),
  configured: (h: Harness) => harnessConfigured(h),
  held: (h: Harness): Hold | null => activeHold(h),
  /** When the provider's last hold lifted (null: never held, or still held). */
  lifted: (h: Harness): number | null => getHold(h)?.lifted ?? null,
};

/** Why a provider can't take work now, or null when it can. */
export function notReady(h: Harness, s: ProviderSettings = providerSettings()): string | null {
  if (s.off.includes(h)) return 'switched off in Settings';
  if (!providerDeps.configured(h)) return 'not signed in here';
  if (!providerDeps.installed(h)) return "its CLI isn't installed on this server";
  const hold = providerDeps.held(h);
  if (hold) return hold.why;
  return null;
}
/** The providers that can take work now, in J's order. */
export const readyHarnesses = (s: ProviderSettings = providerSettings()) => s.order.filter((h) => !notReady(h, s));

// Passes running on each provider (this process): the spread puts the next one on the least busy.
const load = new Map<Harness, number>();
/** Counts a pass on a provider until the returned function is called. */
export function using(h: Harness) {
  load.set(h, (load.get(h) ?? 0) + 1);
  let done = false;
  return () => { if (!done) { done = true; load.set(h, Math.max(0, (load.get(h) ?? 1) - 1)); } };
}
export const busyOn = (h: Harness) => load.get(h) ?? 0;

/**
 * The provider a new agent pass or scout runs on. "one": the harness in use (J's choice, or its stand-in). "spread": the
 * provider holding its session (prefer) while it answers, else the role's own provider, else the least busy ready one.
 * Nothing ready: the harness in use (it is held, so the work parks and waits, as before).
 */
export function pickHarness({ role, prefer }: { role?: string | null; prefer?: Harness | null } = {}, s: ProviderSettings = providerSettings(), now = Date.now()): Harness {
  if (s.mode === 'one') return brainId();
  const ready = readyHarnesses(s);
  if (!ready.length) return brainId();
  if (prefer && ready.includes(prefer)) return prefer;
  const pin = role ? s.roles[role as TunedRole] : undefined;
  if (pin && ready.includes(pin)) return pin;
  const room = (h: Harness) => busyOn(h) < (s.caps[h] ?? DEFAULT_CAPS[h]);
  const cool = (h: Harness) => { const l = providerDeps.lifted(h); return l !== null && now - l < COOL_MS(); };
  // Code work: the best provider in J's order with room, one that just throttled after the rest.
  if (role && QUALITY_ROLES.has(role)) {
    const best = [...ready.filter((h) => room(h) && !cool(h)), ...ready.filter((h) => room(h) && cool(h))][0];
    if (best) return best;
  }
  // Otherwise (and when every provider is at its cap): the least busy for its cap, J's order on a tie.
  const fill = (h: Harness) => busyOn(h) / (s.caps[h] ?? DEFAULT_CAPS[h]);
  return [...ready].sort((a, b) => Number(room(b)) - Number(room(a)) || fill(a) - fill(b) || ready.indexOf(a) - ready.indexOf(b))[0];
}

// A hold's Talk line names the providers that carry on (harness-hold.ts announce).
setSpreadOthers((h) => {
  try {
    const s = providerSettings();
    return s.mode === 'spread' ? readyHarnesses(s).filter((x) => x !== h) : [];
  } catch {
    return [];
  }
});

/** Whether no new work can start on any provider (the pump, the PM and scouts wait). */
export function noProviderFree(s: ProviderSettings = providerSettings()) {
  if (s.mode === 'one') return Boolean(providerDeps.held(brainId()));
  return readyHarnesses(s).length === 0;
}

// ---------------------------------------------------------------- what Settings and the Inbox show

/** Each provider: set up, installed, held, busy, on or off, and where it is in the order. */
export function providerStatus() {
  const s = providerSettings();
  const b = brainSettings();
  return {
    mode: s.mode, order: s.order, off: s.off, roles: s.roles, caps: s.caps, saved: s.saved, chosen: b.chosen, inUse: b.harness,
    providers: s.order.map((h) => {
      const hold = providerDeps.held(h);
      return {
        id: h, label: HARNESSES.find((x) => x.id === h)?.label ?? h, configured: providerDeps.configured(h), installed: providerDeps.installed(h),
        on: !s.off.includes(h), ready: !notReady(h, s), why: notReady(h, s), busy: busyOn(h), cap: s.caps[h],
        hold: hold ? { kind: hold.kind, why: hold.why, line: hold.line, until: hold.until, resets: hold.reset, needsYou: needsJ(hold.kind) } : null,
      };
    }),
  };
}

/**
 * What only J can fix now, for the Inbox's one AI card (inbox.ts): providers he uses that are signed out or need
 * billing, and whether nothing at all can take work. Null: Studio is healing it by itself (or nothing is wrong).
 */
export function providerTrouble(): { lines: string[]; stuck: boolean; holds: Hold[]; since: number; others: Harness[] } | null {
  const s = providerSettings();
  const inUse = s.mode === 'one' ? [brainSettings().chosen, brainId()] : s.order.filter((h) => !s.off.includes(h) && providerDeps.configured(h));
  const holds = activeHolds().filter((h) => inUse.includes(h.harness) && !s.off.includes(h.harness));
  const needs = holds.filter((h) => needsJ(h.kind));
  const stuck = noProviderFree(s);
  if (!needs.length && !stuck) return null;
  const lines = (stuck ? holds : needs).map((h) => `${LABEL[h.harness]}: ${h.why}${h.line ? ` (${h.line.slice(0, 160)})` : ''}`);
  if (stuck && !lines.length) lines.push('No AI provider is signed in and answering.');
  const others = HARNESS_IDS.filter((h) => !s.off.includes(h) && !holds.some((x) => x.harness === h) && providerDeps.configured(h) && providerDeps.installed(h));
  return { lines, stuck, holds: stuck ? holds : needs, since: Math.min(...(stuck ? holds : needs).map((h) => h.since), Date.now()), others };
}
