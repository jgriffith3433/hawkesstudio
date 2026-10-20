// Agent tuning (Settings → Tuning): how much brain each job gets, so cost, speed and quality can be traded on purpose.
//
// - Tiers: fast, standard, deep. Each harness maps a tier to a model (Claude: Haiku, Sonnet, Opus; Copilot: the same
//   families under Copilot's ids; Cursor: its own default model unless set).
// - Roles: each role (fixer, builder, scout...) has a tier, a reasoning effort and a turn cap.
// - Presets: economy, balanced (the default) and quality set all of the above at once; changing a field makes it "custom".
// - Copilot bills a premium request per prompt times the model's multiplier (tool calls inside a run are free), so on
//   Copilot the tier and the number of resumed passes matter, and the turn cap is only a runaway guard.
// - Pass limits: how long one agent pass may run.
// Env STUDIO_MODEL_<ROLE> still wins over everything here (tests and emergencies).

import { db, J, parse } from './db.ts';
import { StudioError } from './config.ts';
import { brainId, type Harness } from './brains.ts';

export const TIERS = ['fast', 'standard', 'deep'] as const;
export type Tier = (typeof TIERS)[number];
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const TUNED_ROLES = ['talk', 'pm', 'fixer', 'builder', 'content', 'scout', 'reviewer'] as const;
export type TunedRole = (typeof TUNED_ROLES)[number];
export const PRESETS = ['economy', 'balanced', 'quality'] as const;
export type Preset = (typeof PRESETS)[number] | 'custom';

export type RoleTune = { tier: Tier; effort: Effort; /** 0: the role file's own cap. */ maxTurns: number };
export type Tuning = {
  preset: Preset;
  roles: Record<TunedRole, RoleTune>;
  /** Model per harness and tier; '' means that harness's own default model. */
  models: Record<Harness, Record<Tier, string>>;
  /** Small model calls Studio makes through Gen (triage, dedupe, reviews...): the tier each uses. */
  jobs: Record<string, Tier>;
  copilot: {
    /** --max-ai-credits per run (Copilot CLI's own spend stop; the CLI's minimum is 30). 0: no cap. */
    maxCredits: number;
    /** Context window tier: long_context costs more per prompt. */
    contextTier: 'default' | 'long_context';
  };
  /** Minutes one agent pass may run before Studio stops it (it is resumed, not failed). */
  passMinutes: { standard: number; content: number };
  /** A retried change (second try on) uses the next tier up: cheap first, deeper only when it didn't land. */
  escalateOnRetry: boolean;
};

export const MODELS: Tuning['models'] = {
  claude: { fast: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
  copilot: { fast: 'claude-haiku-5.5', standard: 'claude-sonnet-5.5', deep: 'claude-sonnet-5.5' },
  cursor: { fast: '', standard: '', deep: '' },
};

const r = (tier: Tier, effort: Effort, maxTurns: number): RoleTune => ({ tier, effort, maxTurns });
const ROLE_PRESETS: Record<(typeof PRESETS)[number], Record<TunedRole, RoleTune>> = {
  // Least spend: small model where it can do the job, low effort, tight turn caps.
  economy: {
    talk: r('standard', 'low', 0), pm: r('fast', 'low', 0), scout: r('fast', 'low', 20), reviewer: r('fast', 'medium', 20),
    fixer: r('standard', 'low', 50), builder: r('standard', 'medium', 80), content: r('standard', 'low', 80),
  },
  // The default: the mid model nearly everywhere, the deep one only where a mistake is expensive (the plan and the review).
  balanced: {
    talk: r('standard', 'medium', 0), pm: r('standard', 'medium', 0), scout: r('fast', 'medium', 30), reviewer: r('standard', 'high', 30),
    fixer: r('standard', 'medium', 60), builder: r('standard', 'high', 100), content: r('standard', 'medium', 100),
  },
  // Best results: the deep model for building and judging, high effort.
  quality: {
    talk: r('standard', 'high', 0), pm: r('deep', 'high', 0), scout: r('standard', 'high', 40), reviewer: r('deep', 'high', 40),
    fixer: r('deep', 'high', 80), builder: r('deep', 'high', 120), content: r('standard', 'high', 120),
  },
};
const JOB_TIERS: Record<(typeof PRESETS)[number], Record<string, Tier>> = {
  economy: { triage: 'fast', dedupe: 'fast', summary: 'fast', host: 'fast', canon: 'fast', review: 'standard', criteria: 'fast' },
  balanced: { triage: 'fast', dedupe: 'fast', summary: 'fast', host: 'fast', canon: 'standard', review: 'standard', criteria: 'standard' },
  quality: { triage: 'fast', dedupe: 'fast', summary: 'fast', host: 'fast', canon: 'standard', review: 'deep', criteria: 'standard' },
};
const COPILOT_PRESETS = { economy: { maxCredits: 60, contextTier: 'default' }, balanced: { maxCredits: 150, contextTier: 'default' }, quality: { maxCredits: 400, contextTier: 'default' } } as const;
const PASS_PRESETS = { economy: { standard: 30, content: 90 }, balanced: { standard: 60, content: 180 }, quality: { standard: 90, content: 240 } } as const;

export function presetTuning(p: (typeof PRESETS)[number]): Tuning {
  return {
    preset: p, roles: structuredClone(ROLE_PRESETS[p]), models: structuredClone(MODELS), jobs: { ...JOB_TIERS[p] },
    copilot: { ...COPILOT_PRESETS[p] }, passMinutes: { ...PASS_PRESETS[p] }, escalateOnRetry: p !== 'economy',
  };
}
export const TUNING_DEFAULTS = presetTuning('balanced');

const KEY = 'tuning';
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);

function merged(v: any): Tuning {
  const base = presetTuning(PRESETS.includes(v?.preset) ? v.preset : 'balanced');
  if (!v || typeof v !== 'object') return base;
  const out: Tuning = { ...base, preset: PRESETS.includes(v.preset) || v.preset === 'custom' ? v.preset : base.preset };
  for (const n of TUNED_ROLES) out.roles[n] = { ...base.roles[n], ...(v.roles?.[n] ?? {}) };
  for (const h of Object.keys(base.models) as Harness[]) out.models[h] = { ...base.models[h], ...(v.models?.[h] ?? {}) };
  out.jobs = { ...base.jobs, ...(v.jobs ?? {}) };
  out.copilot = { ...base.copilot, ...(v.copilot ?? {}) };
  out.passMinutes = { ...base.passMinutes, ...(v.passMinutes ?? {}) };
  if (typeof v.escalateOnRetry === 'boolean') out.escalateOnRetry = v.escalateOnRetry;
  return out;
}

export function tuningSettings(): Tuning & { saved: number | null } {
  const row = db.prepare('SELECT value, updated FROM settings WHERE key = ?').get(KEY) as { value: string; updated: number } | undefined;
  return { ...merged(row ? parse(row.value) : null), saved: row?.updated ?? null };
}

const oneOf = <T extends string>(what: string, v: any, list: readonly T[]): T => {
  if (!list.includes(v)) throw new StudioError(`${what}: ${list.filter(Boolean).join(' | ')}${list.includes('' as T) ? ' (or empty)' : ''}`);
  return v;
};
const int = (what: string, v: any, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new StudioError(`${what}: a whole number from ${min} to ${max}`);
  return n;
};

/** Validates a patch against the current tuning. A preset replaces everything; other fields change it to "custom". */
export function cleanTuning(patch: Record<string, any>, cur: Tuning): Tuning {
  let next: Tuning = structuredClone({ ...cur, saved: undefined }) as Tuning;
  let custom = false;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'preset') {
      if (v === 'custom') continue;
      next = presetTuning(oneOf('tuning.preset', v, PRESETS));
      custom = false;
    } else if (k === 'roles') {
      if (!v || typeof v !== 'object') throw new StudioError('tuning.roles: { role: { tier, effort, maxTurns } }');
      for (const [name, t] of Object.entries(v as Record<string, any>)) {
        if (!TUNED_ROLES.includes(name as TunedRole)) throw new StudioError(`tuning.roles.${name}: ${TUNED_ROLES.join(' | ')}`);
        const cur = next.roles[name as TunedRole];
        if (t.tier !== undefined) cur.tier = oneOf(`tuning.roles.${name}.tier`, t.tier, TIERS);
        if (t.effort !== undefined) cur.effort = oneOf(`tuning.roles.${name}.effort`, t.effort, EFFORTS);
        if (t.maxTurns !== undefined) cur.maxTurns = int(`tuning.roles.${name}.maxTurns`, t.maxTurns, 0, 500);
      }
      custom = true;
    } else if (k === 'models') {
      if (!v || typeof v !== 'object') throw new StudioError('tuning.models: { harness: { tier: model } }');
      for (const [h, tiers] of Object.entries(v as Record<string, any>)) {
        if (!(h in next.models)) throw new StudioError(`tuning.models.${h}: ${Object.keys(next.models).join(' | ')}`);
        for (const [tier, model] of Object.entries(tiers as Record<string, any>)) {
          oneOf(`tuning.models.${h}`, tier, TIERS);
          if (typeof model !== 'string' || !/^[\w.:/-]{0,80}$/.test(model)) throw new StudioError(`tuning.models.${h}.${tier}: a model id (or empty for the harness default)`);
          next.models[h as Harness][tier as Tier] = model;
        }
      }
      custom = true;
    } else if (k === 'jobs') {
      if (!v || typeof v !== 'object') throw new StudioError('tuning.jobs: { job: tier }');
      for (const [job, tier] of Object.entries(v as Record<string, any>)) next.jobs[job] = oneOf(`tuning.jobs.${job}`, tier, TIERS);
      custom = true;
    } else if (k === 'copilot') {
      if (!v || typeof v !== 'object') throw new StudioError('tuning.copilot: { maxCredits, contextTier }');
      if (v.maxCredits !== undefined) {
        const n = int('tuning.copilot.maxCredits', v.maxCredits, 0, 5000);
        if (n !== 0 && n < 30) throw new StudioError('tuning.copilot.maxCredits: 0 (no cap) or 30 or more (the CLI\'s minimum)');
        next.copilot.maxCredits = n;
      }
      if (v.contextTier !== undefined) next.copilot.contextTier = oneOf('tuning.copilot.contextTier', v.contextTier, ['default', 'long_context'] as const);
      custom = true;
    } else if (k === 'passMinutes') {
      if (!v || typeof v !== 'object') throw new StudioError('tuning.passMinutes: { standard, content }');
      if (v.standard !== undefined) next.passMinutes.standard = int('tuning.passMinutes.standard', v.standard, 5, 600);
      if (v.content !== undefined) next.passMinutes.content = int('tuning.passMinutes.content', v.content, 5, 720);
      custom = true;
    } else if (k === 'escalateOnRetry') {
      if (typeof v !== 'boolean') throw new StudioError('tuning.escalateOnRetry: true | false');
      next.escalateOnRetry = v;
      custom = true;
    } else {
      throw new StudioError(`tuning.${k}: not a setting (preset, roles, models, jobs, copilot, passMinutes, escalateOnRetry)`);
    }
  }
  if (custom) next.preset = 'custom';
  return next;
}

export function saveTuning(patch: Record<string, any>, by = 'J') {
  const next = cleanTuning(patch, tuningSettings());
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(KEY, J(next), Date.now(), by);
  return tuningSettings();
}

const UP: Record<Tier, number> = { fast: 0, standard: 1, deep: 2 };
const EF: Record<string, number> = { '': 1, low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/** What in a patch would make agents spend more than today (so a Talk request needs J's yes); empty: nothing. */
export function tuningRaises(patch: Record<string, any>, cur: Tuning): string[] {
  const out: string[] = [];
  let next: Tuning;
  try { next = cleanTuning(patch, cur); } catch { return []; }
  for (const n of TUNED_ROLES) {
    const a = cur.roles[n], b = next.roles[n];
    if (UP[b.tier] > UP[a.tier]) out.push(`${n} tier ${a.tier} → ${b.tier}`);
    if ((EF[b.effort] ?? 1) > (EF[a.effort] ?? 1)) out.push(`${n} effort ${a.effort || 'default'} → ${b.effort}`);
    if (b.maxTurns > a.maxTurns && a.maxTurns > 0) out.push(`${n} turns ${a.maxTurns} → ${b.maxTurns}`);
  }
  for (const [job, tier] of Object.entries(next.jobs)) if (UP[tier] > UP[cur.jobs[job] ?? 'standard']) out.push(`job ${job} → ${tier}`);
  for (const h of Object.keys(next.models) as Harness[]) for (const t of TIERS) if (next.models[h][t] !== cur.models[h][t]) out.push(`${h} ${t} model → ${next.models[h][t] || 'default'}`);
  if (next.copilot.maxCredits === 0 && cur.copilot.maxCredits !== 0 || next.copilot.maxCredits > cur.copilot.maxCredits && cur.copilot.maxCredits !== 0) out.push(`copilot credits ${cur.copilot.maxCredits} → ${next.copilot.maxCredits}`);
  if (next.copilot.contextTier === 'long_context' && cur.copilot.contextTier !== 'long_context') out.push('copilot long context');
  if (next.passMinutes.standard > cur.passMinutes.standard || next.passMinutes.content > cur.passMinutes.content) out.push('longer passes');
  if (next.escalateOnRetry && !cur.escalateOnRetry) out.push('escalate on retry');
  return out;
}

// ------------------------------------------------------------ what the runs use

/** The model, effort and turn cap for a role on a harness now; `retry` is the change's try number (1 = first). */
export function roleTune(role: string, { harness = brainId(), retry = 1 }: { harness?: Harness; retry?: number } = {}) {
  const t = tuningSettings();
  const base = t.roles[role as TunedRole];
  if (!base) return { tier: 'standard' as Tier, model: '', effort: '' as Effort, maxTurns: 0 };
  let tier = base.tier;
  if (t.escalateOnRetry && retry >= 2 && tier !== 'deep' && role !== 'talk') tier = TIERS[Math.min(2, TIERS.indexOf(tier) + 1)];
  return { tier, model: t.models[harness]?.[tier] ?? '', effort: base.effort, maxTurns: base.maxTurns };
}

/** The model for one of Studio's small model calls through Gen (triage, dedupe...). */
export function jobTune(job: string): { tier: Tier; model: string } {
  const t = tuningSettings();
  const tier = t.jobs[job] ?? 'standard';
  return { tier, model: t.models.claude[tier] };
}

/** How long one agent pass of this kind may run. */
export const passLimitMs = (content: boolean) => (content ? tuningSettings().passMinutes.content : tuningSettings().passMinutes.standard) * 60_000;

/** The Copilot CLI's spend and context settings, as the adapter's environment. */
export function copilotEnv(): Record<string, string> {
  const c = tuningSettings().copilot;
  return { ...(c.maxCredits ? { COPILOT_MAX_CREDITS: String(c.maxCredits) } : {}), COPILOT_CONTEXT: c.contextTier };
}
