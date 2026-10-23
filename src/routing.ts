// Model routing (J, 2026-10-23: "send each task to the cheapest model likely to finish it, escalate on failure", and
// "only use the highest tier models upon request of the user to prevent high bills and usage limits being hit").
//
// - Every agent change is classified into a category (lookups and small edits, tests from a spec, scoped features, bugs
//   with a repro, refactors, far-from-symptom bugs, systems work, long runs...) by its words, its role and its size: free
//   rules, no model call. The category gives the default tier (fast: Haiku, standard: Sonnet, deep: Opus) and effort.
// - Escalation: each failed attempt moves the next one up one tier, at most `maxEscalations` times, never above
//   `ceiling` (deep). Where the tier can't go up, the effort does. A change past its escalations is told to re-scope.
// - Premium on request only: the max tier (Fable) is never picked by a rule, a retry or a preset. J asks for it ("use
//   Fable", "plan this on Opus") in his own words; Talk passes them as the quote and Studio checks them (memory.ts
//   jSaid). A grant is per subject (a change, a task, a Talk turn).
// - Spend guards: automatic deep passes per day (`deepPerDay`), and conserve mode for `conserveHours` after the harness
//   hit a usage limit: automatic routes then stay on standard with more effort. J's premium asks aren't capped.
// - Talk: turns Studio starts to explain results run on the fast tier (`autoTurnsFast`); J's turns on the role's tier,
//   or the premium tier his message asks for.
// The share of usage per tier (agents, Talk, scouts) against the targets is routingUsage(), shown in Settings.

import { db, J, parse } from './db.ts';
import { StudioError } from './config.ts';
import { TIERS, type Tier, type Effort } from './tuning.ts';

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS routing_premium (subject TEXT PRIMARY KEY, tier TEXT NOT NULL, by TEXT, words TEXT, at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`);

const UP: Record<Tier, number> = { fast: 0, standard: 1, deep: 2, max: 3 };
const EFFORT_UP: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const higherEffort = (a: Effort, b: Effort): Effort => (EFFORT_UP.indexOf(a || 'medium') >= EFFORT_UP.indexOf(b || 'medium') ? a || 'medium' : b || 'medium');
const nextEffort = (e: Effort): Effort => EFFORT_UP[Math.min(EFFORT_UP.length - 1, EFFORT_UP.indexOf(e || 'medium') + 1)];

// ------------------------------------------------------------ categories

export const CATEGORIES = ['lookup_or_explain', 'small_isolated_edit', 'tests_from_spec', 'scoped_feature', 'bug_with_repro', 'multi_file_refactor', 'far_from_symptom_bug', 'systems_work', 'long_agentic_run', 'content', 'planning'] as const;
export type Category = (typeof CATEGORIES)[number];

export type Rule = { id: Category; label: string; tier: Tier; effort: Effort; re: RegExp | null; escalate: string };
/** In the order they are tried: the expensive kinds first, so "fix the race in the WebGL build" isn't a small edit. */
export const RULES: Rule[] = [
  { id: 'systems_work', label: 'Systems work (netcode, render pipeline, build pipeline, migrations)', tier: 'deep', effort: 'high', escalate: 'deep, more effort',
    re: /\b(netcode|state sync|multiplayer sync|URP|HDRP|render pipeline|shader graph|Unity 6 migration|WebGL build (fails|broken|error)|build pipeline|addressables|IL2CPP|asset pipeline|save (system|format) migration|migrat(e|ion) (to|from|the)|upgrade (unity|babylon|vite|node)|physics engine|rollback netcode)\b/i },
  { id: 'far_from_symptom_bug', label: 'Far-from-symptom bug (intermittent, only in the build, races)', tier: 'deep', effort: 'high', escalate: 'deep, more effort',
    // Strong signals only: "sometimes" or "on phone" are everyday playtest words, and each false hit is an Opus pass.
    re: /\b(intermittent(ly)?|flaky|no clear cause|only (happens )?(in|on) (the )?(build|webgl build|production build|live build)|race condition|memory leak|desync(s|ed)?|heisenbug|can'?t reproduce|cannot reproduce|hard to reproduce|works locally but)\b/i },
  { id: 'long_agentic_run', label: 'Long run (build and test until it works)', tier: 'deep', effort: 'medium', escalate: 'deep, more effort',
    re: /\b(build and test until|iterate until|keep (going|iterating) until|until (it|they|all) (passes?|works?|is green)|overnight|end[- ]to[- ]end overhaul|whole (game|codebase|pipeline))\b/i },
  { id: 'multi_file_refactor', label: 'Refactor across files', tier: 'standard', effort: 'high', escalate: 'deep',
    re: /\b(refactor|restructur|rename .{1,40} across|across (all|every|the) (files|modules|scripts|scenes|products)|extract (a|an|the) \w+ (module|class|component|system)|split .{1,40} into|consolidate|deduplicate|rewrite (the|a) \w+ system)\b/i },
  { id: 'bug_with_repro', label: 'Bug with a repro (steps, stack trace, a failing scenario)', tier: 'standard', effort: 'medium', escalate: 'deep',
    re: /\b(repro|steps to reproduce|stack ?trace|fails when|crash(es|ed)? (when|on|after)|throws|exception|TypeError|ReferenceError|NullReference|null reference|undefined is not|cannot read propert|console error|error:|softlock|stuck (on|at|in)|freez(e|es) (when|on|after)|blocks? (the|progress))\b/i },
  { id: 'tests_from_spec', label: 'Tests from a spec', tier: 'fast', effort: 'medium', escalate: 'standard',
    re: /\b(write (unit |more )?tests|add (unit |more )?tests|test coverage|cover (the |these |all )?(cases|edge cases)|playtest scenario for)\b/i },
  { id: 'small_isolated_edit', label: 'Small isolated edit (typo, wording, a value, one file)', tier: 'fast', effort: 'low', escalate: 'standard',
    re: /\b(typo|spelling|misspel|wording|reword|copy change|change the (text|label|title|wording|colou?r|font|link)|rename (the|a|this) \w+$|one[- ]line|single file|bump (the )?version|tweak (the )?(colou?r|size|padding|margin|speed|value|number)|(colou?r|font size|padding|margin|z-index) of|broken link|alt text|favicon)\b/i },
  { id: 'lookup_or_explain', label: 'Lookup or explanation', tier: 'fast', effort: 'low', escalate: 'standard',
    re: /^\s*(what does|explain|which api|where (is|does)|why does|how does|what is)\b/i },
  { id: 'planning', label: 'Planning or design (scope, architecture, trade-offs)', tier: 'standard', effort: 'high', escalate: 'deep',
    re: /\b(plan (out|the)|scope (out|the)|architecture|design (doc|the system)|how should we|trade-?offs?|not sure whether|options for)\b/i },
  { id: 'content', label: 'Content (story, lines, levels, characters) checked against canon', tier: 'standard', effort: 'medium', escalate: 'deep', re: null },
  { id: 'scoped_feature', label: 'Scoped feature (1-3 files, design decided)', tier: 'standard', effort: 'medium', escalate: 'deep', re: null },
];
const RULE = Object.fromEntries(RULES.map((r) => [r.id, r])) as Record<Category, Rule>;

export type ClassifyInput = {
  text: string;
  /** The agent role (agents.ts roleOf): content work stays standard or above, Studio/Gen changes too. */
  role?: 'fixer' | 'builder' | 'content' | 'infra' | 'talk' | 'scout' | null;
  /** How many acceptance criteria (more criteria: more work). */
  criteria?: number;
  /** The worst finding's severity (a fix). */
  severity?: string | null;
};
export type Classified = { category: Category; tier: Tier; effort: Effort; signals: string[]; why: string };

/** The category, default tier and effort for a piece of work, from its words, role and size. */
export function classify(input: ClassifyInput): Classified {
  const text = String(input.text ?? '');
  const signals: string[] = [];
  let rule: Rule | null = null;
  for (const r of RULES) {
    if (!r.re) continue;
    const m = r.re.exec(text);
    if (m) {
      rule = r;
      signals.push(`"${m[0].trim().slice(0, 40)}"`);
      break;
    }
  }
  if (!rule) rule = input.role === 'content' ? RULE.content : RULE.scoped_feature;
  let tier = rule.tier;
  let effort = rule.effort;
  const why: string[] = [rule.label];
  // Size: a long request or many criteria is never a small edit.
  const big = text.length > 1200 || (input.criteria ?? 0) > 3;
  if (big && UP[tier] < UP.standard) {
    tier = 'standard';
    why.push(text.length > 1200 ? 'a long request' : `${input.criteria} criteria`);
  }
  // Content is judged against canon, and Studio or Gen changes run the cockpit: never on the smallest model.
  if ((input.role === 'content' || input.role === 'infra') && UP[tier] < UP.standard) {
    tier = 'standard';
    why.push(input.role === 'content' ? 'content work (canon)' : 'a Studio or Gen change');
  }
  // A blocker is fixed carefully, but on the mid tier with more effort before anything bigger.
  if (input.severity === 'blocker' && UP[tier] < UP.standard) {
    tier = 'standard';
    why.push('a blocker');
  }
  if (input.severity === 'blocker') effort = higherEffort(effort, 'high');
  return { category: rule.id, tier, effort, signals, why: why.join('; ') };
}

// ------------------------------------------------------------ settings

export type RoutingSettings = {
  /** Route agent changes by category (off: every role on its tuned tier, retries one tier up: tuning.ts). */
  enabled: boolean;
  /** Tiers a failing change may climb (one per failed attempt). */
  maxEscalations: number;
  /** The highest tier a route reaches by itself (never max: J asks for that). */
  ceiling: 'standard' | 'deep';
  /** Automatic deep passes a day; past it, routes stay on standard with more effort. 0: no automatic deep at all. */
  deepPerDay: number;
  /** Hours after the harness hit a usage limit that automatic routes stay on standard or below. 0: off. */
  conserveHours: number;
  /** Turns Studio starts in Talk (explaining finished work) run on the fast tier. */
  autoTurnsFast: boolean;
};
export const ROUTING_DEFAULTS: RoutingSettings = { enabled: true, maxEscalations: 2, ceiling: 'deep', deepPerDay: 6, conserveHours: 6, autoTurnsFast: true };
/** The share of usage each tier should take when routing works (the research J brought, 2026-10-23); shown, not enforced. */
export const TARGETS: Record<Tier, [number, number]> = { fast: [10, 15], standard: [50, 60], deep: [20, 30], max: [5, 10] };

const KEY = 'routing';
export function routingSettings(): RoutingSettings & { saved: number | null } {
  const r = db.prepare('SELECT value, updated FROM settings WHERE key = ?').get(KEY) as { value: string; updated: number } | undefined;
  return { ...ROUTING_DEFAULTS, ...((r ? parse(r.value) : null) ?? {}), saved: r?.updated ?? null };
}

export function cleanRouting(patch: Record<string, any>, cur: RoutingSettings): RoutingSettings {
  const next: RoutingSettings = { ...ROUTING_DEFAULTS, ...cur };
  delete (next as any).saved;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'enabled' || k === 'autoTurnsFast') {
      if (typeof v !== 'boolean') throw new StudioError(`routing.${k}: true | false`);
      next[k] = v;
    } else if (k === 'maxEscalations' || k === 'deepPerDay' || k === 'conserveHours') {
      const n = Number(v);
      const max = k === 'maxEscalations' ? 3 : k === 'deepPerDay' ? 100 : 72;
      if (!Number.isInteger(n) || n < 0 || n > max) throw new StudioError(`routing.${k}: a whole number from 0 to ${max}`);
      next[k] = n;
    } else if (k === 'ceiling') {
      if (v !== 'standard' && v !== 'deep') throw new StudioError('routing.ceiling: standard | deep (max is only on J\'s request)');
      next.ceiling = v;
    } else {
      throw new StudioError(`routing.${k}: not a setting (${Object.keys(ROUTING_DEFAULTS).join(', ')})`);
    }
  }
  return next;
}

export function saveRouting(patch: Record<string, any>, by = 'J') {
  const next = cleanRouting(patch, routingSettings());
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(KEY, J(next), Date.now(), by);
  return routingSettings();
}

/** What in a patch would let routes spend more (so a Talk request needs J's yes). */
export function routingRaises(patch: Record<string, any>, cur: RoutingSettings): string[] {
  let next: RoutingSettings;
  try { next = cleanRouting(patch, cur); } catch { return []; }
  const out: string[] = [];
  if (!next.enabled && cur.enabled) out.push('routing off (every role on its tuned tier)');
  if (next.maxEscalations > cur.maxEscalations) out.push(`escalations ${cur.maxEscalations} → ${next.maxEscalations}`);
  if (next.ceiling === 'deep' && cur.ceiling !== 'deep') out.push('ceiling → deep');
  if (next.deepPerDay > cur.deepPerDay) out.push(`deep passes a day ${cur.deepPerDay} → ${next.deepPerDay}`);
  if (next.conserveHours < cur.conserveHours) out.push(`conserve after a usage limit ${cur.conserveHours} → ${next.conserveHours} h`);
  if (!next.autoTurnsFast && cur.autoTurnsFast) out.push('Studio\'s Talk turns off the fast tier');
  return out;
}

// ------------------------------------------------------------ premium (J's request only)

/**
 * J asking for a bigger model in his own words: "use Fable", "on opus", "plan this with fable", "highest tier", "best
 * model". max (Fable) or deep (Opus); null when he didn't ask. Never read from anything but J's own words.
 */
export function premiumAsked(text: string | null | undefined): 'deep' | 'max' | null {
  const t = String(text ?? '');
  // An ask, not a mention: "use Fable", "with opus", "on the highest tier", "put opus on it", "/fable". "Why did opus
  // run?" is a question about a model, not a request for one.
  const ask = String.raw`(?:use|using|with|on|via|switch(?:ed)?\s+to|try|run\s+(?:it|this|that)?\s*on|put|give\s+(?:it|this|that)|let|get|have)\s+(?:the\s+|a\s+)?`;
  const max = String.raw`(?:claude[- ])?fable|(?:highest|top|best|strongest|biggest|smartest|max(?:imum)?)(?:[- ](?:possible|tier))?[- ](?:tier|model)`;
  const deep = String.raw`(?:claude[- ])?opus|(?:deep|deeper|bigger)[- ](?:tier|model)`;
  if (new RegExp(String.raw`\b${ask}(?:${max})\b|(?:^|\s)/fable\b|\b(?:claude[- ])?fable\s+(?:for|on)\s+(?:this|it|that)\b`, 'i').test(t)) return 'max';
  if (new RegExp(String.raw`\b${ask}(?:${deep})\b|(?:^|\s)/opus\b|\b(?:claude[- ])?opus\s+(?:for|on)\s+(?:this|it|that)\b`, 'i').test(t)) return 'deep';
  return null;
}

export type Premium = { subject: string; tier: 'deep' | 'max'; by: string; words: string | null; at: number; used: number };

/** Grants a premium tier to a subject (a change c_..., a task k_..., a Talk turn). The caller has checked it was J. */
export function grantPremium(subject: string, tier: 'deep' | 'max', by: string, words: string | null = null, now = Date.now()) {
  if (tier !== 'deep' && tier !== 'max') throw new StudioError('premium tier: deep (Opus) | max (Fable)');
  if (!/^J\b/.test(by)) throw new StudioError('Only J asks for a premium model (Opus or Fable): ask him, and pass his own words.', 403);
  db.prepare('INSERT INTO routing_premium (subject, tier, by, words, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET tier = excluded.tier, by = excluded.by, words = excluded.words, at = excluded.at')
    .run(subject, tier, by, words ? words.slice(0, 500) : null, now);
  return premiumFor(subject)!;
}
/** A requested model name as a premium tier: opus/deep → deep, fable/max → max; anything else null. */
export function premiumTierOf(model: unknown): 'deep' | 'max' | null {
  const m = String(model ?? '').trim().toLowerCase();
  if (/^(fable|max|claude-fable[\w.-]*)$/.test(m)) return 'max';
  if (/^(opus|deep|claude-opus[\w.-]*)$/.test(m)) return 'deep';
  return null;
}

/**
 * Whether a request for a premium model is J's (the API's side of "only upon J's request"): J on the dashboard, or a
 * Talk conversation where J's newest message asks for it, or his quoted words there do (memory.ts jSaid). Returns the
 * tier, who asked and his words; null when no premium model was asked for; throws (403) when it isn't J's.
 */
export async function premiumRequest(req: import('node:http').IncomingMessage, b: { model?: unknown; quote?: unknown; by?: unknown }): Promise<{ tier: 'deep' | 'max'; by: string; words: string | null } | null> {
  if (b.model === undefined || b.model === null || b.model === '') return null;
  const asked = premiumTierOf(b.model);
  if (!asked) throw new StudioError('model: opus or fable (J\'s ask only); leave it out for the routed model');
  const conv = String(req.headers['x-talk-conversation'] ?? '');
  if (/^t_[0-9a-f]{6,32}$/.test(conv)) {
    const { lastJMessage } = await import('./guards.ts');
    const { jSaid } = await import('./memory.ts');
    const last = lastJMessage(conv)?.text ?? '';
    const quote = typeof b.quote === 'string' ? b.quote : '';
    const said = premiumAsked(last) ? last : quote && jSaid(conv, quote) && premiumAsked(quote) ? quote : null;
    if (!said) throw new StudioError(`${asked === 'max' ? 'Fable' : 'Opus'} is only on J's request: his own message has to ask for it ("use ${asked === 'max' ? 'Fable' : 'Opus'}"). Leave model out to use the routed model, or ask him and pass his words as quote.`, 403);
    // He asked for Opus: that is what he gets, even if Talk wrote fable.
    const tier = premiumAsked(said) === 'deep' ? 'deep' : asked;
    return { tier, by: 'J (via Talk)', words: said.slice(0, 300) };
  }
  const { actor } = await import('./inbox.ts');
  const by = await actor(req, b.by);
  if (!/^J\b/.test(by)) throw new StudioError('A premium model (Opus or Fable) is J\'s ask only.', 403);
  return { tier: asked, by, words: null };
}

export function premiumFor(...subjects: (string | null | undefined)[]): Premium | null {
  for (const s of subjects) {
    if (!s) continue;
    const r = db.prepare('SELECT * FROM routing_premium WHERE subject = ?').get(s) as Premium | undefined;
    if (r) return r;
  }
  return null;
}
export function clearPremium(subject: string) {
  db.prepare('DELETE FROM routing_premium WHERE subject = ?').run(subject);
}
const markUsed = (subject: string) => db.prepare('UPDATE routing_premium SET used = used + 1 WHERE subject = ?').run(subject);
export function premiumGrants(limit = 20): Premium[] {
  return db.prepare('SELECT * FROM routing_premium ORDER BY at DESC LIMIT ?').all(limit) as Premium[];
}

// ------------------------------------------------------------ the route

export type Route = {
  category: Category; signals: string[]; why: string;
  /** The category's tier, before escalation and caps. */
  base: Tier;
  tier: Tier; effort: Effort;
  /** 1 = first attempt. */
  attempt: number;
  /** Tiers climbed for earlier failures. */
  escalations: number;
  /** Past its escalations: the brief asks it to re-scope. */
  exhausted: boolean;
  /** J's premium ask that set the tier, if any. */
  premium: 'deep' | 'max' | null;
  /** Why the tier was held down (the deep budget, conserve mode, the ceiling), if it was. */
  capped: string | null;
};

export type RouteInput = ClassifyInput & {
  attempt?: number;
  premium?: 'deep' | 'max' | null;
  /** Automatic deep passes so far today (default: the pass ledger's). */
  deepToday?: number;
  /** Conserve mode (default: a usage limit in the last conserveHours). */
  conserve?: boolean;
};

/** The tier and effort a piece of work runs on now. Pure given its input (the defaults read the ledger and the holds). */
export function routeFor(input: RouteInput, s: RoutingSettings = routingSettings()): Route {
  const c = classify(input);
  const attempt = Math.max(1, Math.floor(input.attempt ?? 1));
  if (input.premium) {
    // J asked: his tier, with real effort, no caps, no climbing past it.
    return { category: c.category, signals: c.signals, why: `${c.why}; J asked for ${input.premium === 'max' ? 'Fable' : 'Opus'}`, base: c.tier, tier: input.premium, effort: higherEffort(c.effort, 'high'), attempt, escalations: 0, exhausted: false, premium: input.premium, capped: null };
  }
  let tier = c.tier;
  let effort = c.effort;
  const ceiling = UP[s.ceiling] ?? UP.deep;
  const climbs = Math.min(s.maxEscalations, attempt - 1);
  let escalations = 0;
  for (let i = 0; i < climbs; i++) {
    if (UP[tier] < ceiling) {
      tier = TIERS[UP[tier] + 1];
      escalations++;
    } else effort = nextEffort(effort);
  }
  // Never max on its own, whatever a setting says.
  if (UP[tier] > ceiling) tier = TIERS[ceiling];
  let capped: string | null = null;
  if (tier === 'deep') {
    const conserve = input.conserve ?? conserving(s);
    const deepToday = input.deepToday ?? deepPassesToday();
    if (conserve) capped = `conserving usage (a usage limit in the last ${s.conserveHours} h)`;
    else if (deepToday >= s.deepPerDay) capped = `the day's ${s.deepPerDay} automatic deep passes are used`;
    if (capped) {
      tier = 'standard';
      effort = higherEffort(effort, 'high');
    }
  }
  return { category: c.category, signals: c.signals, why: c.why, base: c.tier, tier, effort, attempt, escalations, exhausted: attempt - 1 > s.maxEscalations, premium: null, capped };
}

/** A route in one line, for logs and the change's page. */
export const routeLine = (r: Route, model?: string) =>
  `${r.category} → ${r.tier}${model ? ` (${model})` : ''}${r.effort ? `, ${r.effort} effort` : ''}${r.attempt > 1 ? `, attempt ${r.attempt}${r.escalations ? ` (+${r.escalations} tier)` : ''}` : ''}${r.premium ? `, J asked for ${r.premium === 'max' ? 'Fable' : 'Opus'}` : ''}${r.capped ? `; held on standard: ${r.capped}` : ''}`;

/** Uses a premium grant (counted, for the Settings list). */
export function usePremium(...subjects: (string | null | undefined)[]) {
  const p = premiumFor(...subjects);
  if (p) markUsed(p.subject);
  return p;
}

// ------------------------------------------------------------ spend guards and usage

const dayStart = (now = Date.now()) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Automatic (not J's premium) deep passes today, from the pass ledger. */
export function deepPassesToday(now = Date.now()) {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM pass_ledger WHERE at >= ? AND tier = 'deep' AND (premium IS NULL OR premium = '')`).get(dayStart(now)) as { n: number };
    return r.n;
  } catch {
    return 0;
  }
}

/** The last usage limit the harness hit (harness-hold.ts), if it is within conserveHours. */
export function lastUsageStop(s: RoutingSettings = routingSettings(), now = Date.now()): number | null {
  if (!(s.conserveHours > 0)) return null;
  try {
    const r = db.prepare(`SELECT MAX(since) AS at FROM harness_holds WHERE kind = 'usage'`).get() as { at: number | null };
    return r.at && now - r.at < s.conserveHours * 3600_000 ? r.at : null;
  } catch {
    return null;
  }
}
export const conserving = (s: RoutingSettings = routingSettings(), now = Date.now()) => lastUsageStop(s, now) !== null;

/** Talk's turn: the tier for Studio's own turns, and J's premium ask. null: the role's tuned tier. */
export function talkTier({ auto, pm, text }: { auto: boolean; pm: boolean; text?: string | null }, s: RoutingSettings = routingSettings()): { tier: Tier; why: string } | null {
  if (!s.enabled) return null;
  if (auto) return !pm && s.autoTurnsFast ? { tier: 'fast', why: 'Studio\'s turn explaining finished work' } : null;
  const asked = premiumAsked(text);
  if (asked) return { tier: asked, why: `J asked for ${asked === 'max' ? 'Fable' : 'Opus'}` };
  return null;
}

export type TierUsage = { tier: Tier; usage: number; share: number; target: [number, number]; passes: number; turns: number; status: 'under' | 'ok' | 'over' };

/**
 * The usage share of each tier over `days`: agents' passes (the ledger), Talk's turns (their model) and scouts. Claude
 * Code reports a cost even on the Max plan (not billed), so it is the measure of how fast the plan's limits fill.
 */
export function routingUsage(days = 7, now = Date.now(), tierOf: (m: string) => Tier | null = defaultTierOf) {
  const since = now - days * 86400_000;
  const by: Record<Tier, { usage: number; passes: number; turns: number }> = { fast: { usage: 0, passes: 0, turns: 0 }, standard: { usage: 0, passes: 0, turns: 0 }, deep: { usage: 0, passes: 0, turns: 0 }, max: { usage: 0, passes: 0, turns: 0 } };
  const add = (t: Tier | null, usage: number, kind: 'passes' | 'turns') => {
    const k = t ?? 'standard';
    by[k].usage += Number(usage) || 0;
    by[k][kind]++;
  };
  try {
    for (const r of db.prepare('SELECT tier, model, cost FROM pass_ledger WHERE at >= ?').all(since) as any[]) add((TIERS as readonly string[]).includes(r.tier) ? r.tier : tierOf(r.model), r.cost, 'passes');
  } catch { /* no ledger yet */ }
  try {
    for (const c of db.prepare('SELECT messages FROM conversations WHERE COALESCE(updated, created) >= ?').all(since) as any[]) {
      for (const m of (parse(c.messages) ?? []) as any[]) if (m?.turn && m.at >= since) add(tierOf(m.turn.model ?? ''), m.turn.cost, 'turns');
    }
  } catch { /* no conversations yet */ }
  try {
    for (const r of db.prepare('SELECT cost, model FROM scouts WHERE created >= ?').all(since) as any[]) add(tierOf(r.model ?? '') ?? 'fast', r.cost, 'passes');
  } catch {
    try { for (const r of db.prepare('SELECT cost FROM scouts WHERE created >= ?').all(since) as any[]) add('fast', r.cost, 'passes'); } catch { /* no scouts yet */ }
  }
  const total = Object.values(by).reduce((n, v) => n + v.usage, 0);
  const tiers: TierUsage[] = TIERS.map((t) => {
    const share = total ? Math.round((by[t].usage / total) * 1000) / 10 : 0;
    const [lo, hi] = TARGETS[t];
    return { tier: t, usage: Math.round(by[t].usage * 100) / 100, share, target: TARGETS[t], passes: by[t].passes, turns: by[t].turns, status: !total ? 'ok' : share > hi ? 'over' : share < lo && t !== 'max' ? 'under' : 'ok' };
  });
  return { days, total: Math.round(total * 100) / 100, tiers };
}
function defaultTierOf(model: string): Tier | null {
  const m = String(model ?? '').toLowerCase();
  if (!m) return null;
  if (/fable/.test(m)) return 'max';
  if (/opus|argon-high|\bpro\b/.test(m)) return 'deep';
  if (/sonnet|argon/.test(m)) return 'standard';
  if (/haiku|flash/.test(m)) return 'fast';
  return null;
}

/** Everything the Settings tab and Talk show about routing. */
export function routingStatus(now = Date.now()) {
  const s = routingSettings();
  const stop = lastUsageStop(s, now);
  return {
    settings: s,
    rules: RULES.map((r) => ({ id: r.id, label: r.label, tier: r.tier, effort: r.effort, escalate: r.escalate })),
    deepToday: deepPassesToday(now),
    conserve: stop ? { since: stop, until: stop + s.conserveHours * 3600_000 } : null,
    usage: routingUsage(7, now),
    premium: premiumGrants(10),
  };
}
