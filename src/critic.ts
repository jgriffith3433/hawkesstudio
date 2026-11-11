// The critic (the critic role, .claude/agents/critic.md): every game is judged the way a demanding first-time player or
// a Steam reviewer would, so the work that makes it better gets found and filed. Modelled on fun-review.ts: Claude
// through llm.ts with a structured schema, never throws, and "unjudged" is never a pass (a run with no frames is
// unjudged and shows no scores).
//
// When: when any run of the game ends (pipeline.ts closeRun and the daily run's end: an event, never a timer), at most
// once per game per 7 days, and on every milestone beta run. Which part: each weekly run reviews a different scenario
// (chapter, level or story) of the ones the run played or the contract listed, the least recently reviewed first, so
// every part is reviewed within a month. The result is a `critic` step on the run: report.ts renders it.

import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './llm.ts';
import { parseAgentFile, PLUGIN_DIR } from './roles.ts';
import { isGame } from './quality.ts';
import { worldBibleOf } from './fun-review.ts';
import { paths, getProduct, type Product } from './config.ts';
import { db, rowToStep, parse } from './db.ts';
import { knownScenarios } from './scenarios.ts';

export const DIMENSIONS = [
  'fun', 'feel', 'clarity', 'first five minutes', 'menus and UI', 'sound', 'art cohesion', 'story through play', 'phone', 'reasons to come back',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** One game gets one critic run per this long (a milestone beta run is the exception). */
export const CRITIC_EVERY_MS = 7 * 86_400_000;

export type CriticScore = {
  dimension: Dimension;
  /** 1-10, or null when this dimension couldn't be judged (no evidence: said so, never guessed). */
  score: number | null;
  /** The reference game it is compared with (one of the product's `references`). */
  reference: string;
  /** The frame (Gen asset id) and/or the clip time ("t=42s") behind the score. */
  frame: string | null;
  at: string;
  why: string;
  /** The one fix that moves this dimension most. */
  fix: string;
};
export type Critic = {
  verdict: 'judged' | 'unjudged';
  scores: CriticScore[];
  /** The scenario (chapter, level, story) this review played, and the ones it hasn't reviewed yet. */
  scenario: string | null;
  next: string[];
  references: Reference[];
  summary: string;
};
export type Reference = { game: string; best: string };

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scores', 'summary'],
  properties: {
    summary: { type: 'string', description: 'The review in two sentences, the way a Steam review opens.' },
    scores: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['dimension', 'score', 'reference', 'frame', 'at', 'why', 'fix'],
        properties: {
          dimension: { type: 'string', enum: [...DIMENSIONS] },
          score: { type: 'number', minimum: 1, maximum: 10 },
          reference: { type: 'string', description: 'The reference game compared, by name, from the list given.' },
          frame: { type: 'string', description: 'The attached frame (its number, e.g. "3") or the asset id the score rests on; "" for none.' },
          at: { type: 'string', description: 'The clip time of that moment, like "t=42s"; "" when unknown.' },
          why: { type: 'string', description: 'One or two sentences: what the frame shows against the reference.' },
          fix: { type: 'string', description: 'The ONE fix that moves this dimension most, concrete: where, what the player sees, hears or does.' },
        },
      },
    },
  },
};

// ── references ─────────────────────────────────────────────────────────────────────────────────────────────────────

const refsFile = () => path.join(path.dirname(paths.db), 'critic-references.json');
const readDrafted = (): Record<string, Reference[]> => { try { return JSON.parse(fs.readFileSync(refsFile(), 'utf8')); } catch { return {}; } };

/** Normalises the references field (2-3 games, each with what it does best); anything else is dropped. */
export function cleanReferences(input: unknown): Reference[] {
  return (Array.isArray(input) ? input : []).map((r: any) => ({ game: String(r?.game ?? '').trim().slice(0, 80), best: String(r?.best ?? '').trim().slice(0, 300) }))
    .filter((r) => r.game).slice(0, 3);
}

/** A game's references: the ones set in its project (products.json, studio_project), else the ones drafted once from its pitch. */
export function referencesOf(p: { id: string; references?: Reference[] }): Reference[] {
  const own = cleanReferences(p.references);
  return own.length ? own : cleanReferences(readDrafted()[p.id]);
}

const REF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['references'],
  properties: { references: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['game', 'best'], properties: { game: { type: 'string' }, best: { type: 'string' } } } } },
};

/** When a game has no references, the PM drafts them once from its pitch (kept in .data; the owner's own, set on the project, always win). */
export async function ensureReferences(p: Product, deps: { ask?: typeof askClaude } = {}): Promise<Reference[]> {
  const have = referencesOf(p);
  if (have.length) return have;
  try {
    const j: any = await (deps.ask ?? askClaude)({
      prompt: `You are the PM of a game studio. Name the 2 or 3 published games that ${p.name} most resembles or wants to be measured against, from its pitch, and for each the one thing it does best (a few words a player would say).\n\nPITCH: ${p.about ?? ''}\n${p.quality ? `QUALITY BAR: ${p.quality}\n` : ''}Real, well-known games only.`,
      schema: REF_SCHEMA, model: process.env.STUDIO_REVIEW_MODEL ?? 'claude-sonnet-5-5', effort: 'low', maxTokens: 800, timeoutMs: 3 * 60_000, purpose: 'critic-references',
    } as any);
    const refs = j?.status === 'done' ? cleanReferences(j.result?.value?.references) : [];
    if (refs.length >= 2) {
      const all = readDrafted();
      all[p.id] = refs;
      fs.mkdirSync(path.dirname(refsFile()), { recursive: true });
      fs.writeFileSync(refsFile(), JSON.stringify(all, null, 2));
      return refs;
    }
  } catch { /* the critic runs on the genre then */ }
  return [];
}

/** The critic's standing instructions: its role file in the plugin Studio runs. */
export function criticBrief() {
  try {
    return parseAgentFile(fs.readFileSync(path.join(PLUGIN_DIR(), 'agents', 'critic.md'), 'utf8')).body;
  } catch {
    return 'You are the critic: score a game the way a demanding first-time player or Steam reviewer would, against the hits it resembles.';
  }
}

// ── when, and which part ───────────────────────────────────────────────────────────────────────────────────────────

type CriticStep = { at: number; scenario: string | null; verdict: string };
/** The game's earlier critic runs, newest first. */
export function criticHistory(product: string, limit = 40): CriticStep[] {
  const rows = db.prepare(`SELECT * FROM steps WHERE product = ? AND kind = 'critic' AND status = 'done' ORDER BY started DESC LIMIT ?`).all(product, limit) as any[];
  return rows.map(rowToStep).map((s) => ({ at: s.started, scenario: s.data?.scenario ?? null, verdict: s.data?.verdict ?? 'unjudged' }));
}

/** Whether the critic is due for this game now: no judged run in the last 7 days, or the run is a milestone's. */
export function criticDue(product: string, opts: { milestone?: boolean; now?: number } = {}) {
  if (opts.milestone) return true;
  const last = criticHistory(product).find((h) => h.verdict === 'judged');
  return !last || (opts.now ?? Date.now()) - last.at >= CRITIC_EVERY_MS;
}

/**
 * The scenario this critic run reviews: of the candidates (what the run played, then what the contract listed), the one
 * reviewed longest ago (never, first), so two weekly runs never review the same one while another waits. `next` is what
 * has not been reviewed since this one.
 */
export function pickScenario(candidates: string[], history: { scenario: string | null }[]) {
  const names = [...new Set(candidates.filter(Boolean))];
  if (!names.length) return { scenario: null as string | null, next: [] as string[] };
  const lastAt = (n: string) => { const i = history.findIndex((h) => h.scenario === n); return i < 0 ? Infinity : i; };
  const ranked = names.map((n, i) => ({ n, i, age: lastAt(n) })).sort((a, b) => b.age - a.age || a.i - b.i);
  const scenario = ranked[0].n;
  return { scenario, next: ranked.slice(1).filter((r) => r.age === Infinity || r.age > 0).map((r) => r.n).slice(0, 5) };
}

const baseScenario = (name: string) => name.replace(/[:@].*$/, '');

// ── judging ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Evidence = { frames: { asset: string; t?: number; scene?: string; reason?: string; phone: boolean; scenario: string }[]; metrics: Record<string, unknown>; phoneMetrics: Record<string, unknown>; summaries: string[]; scenarios: string[]; phone: boolean };

const asImage = (x: string) => (/^(asset|blob):/.test(x) ? x : `asset:${x}`);

/** A short audio timeline for the sound axis (judges can't hear the tape). */
function audioBlock(ev: Evidence): string {
  const m = { ...ev.metrics, ...ev.phoneMetrics };
  const keys = ['audio.lufsIntegrated', 'audio.truePeakDb', 'audio.longestSilenceS', 'audio.silentActions', 'audio.identicalRepeats60s', 'audio.voiceDuckDb'];
  if (!keys.some((k) => m[k] != null)) return '';
  const line = keys.filter((k) => m[k] != null).map((k) => `${k}=${m[k]}`).join(', ');
  return `Audio (you cannot hear the recording; score "sound" from these readings and the frames' implied moments): ${line}\n`;
}

/** The frames, metrics and review text of the playtests a run played (its review steps; the phone run's are marked). */
export function evidenceOf(run: string, product: string, scenario?: string | null): Evidence {
  const steps = (db.prepare(`SELECT * FROM steps WHERE run = ? AND product = ? ORDER BY started`).all(run, product) as any[]).map(rowToStep);
  const ev: Evidence = { frames: [], metrics: {}, phoneMetrics: {}, summaries: [], scenarios: [], phone: false };
  for (const s of steps) {
    if (!['review', 'playtest'].includes(s.kind) || s.status !== 'done') continue;
    const phone = /:phone\b/.test(s.name);
    const base = baseScenario(s.name);
    if (scenario && base !== scenario) continue;
    if (s.kind === 'playtest') {
      Object.assign(phone ? ev.phoneMetrics : ev.metrics, s.data?.metrics ?? {});
      if (!phone && base && !ev.scenarios.includes(base)) ev.scenarios.push(base);
      continue;
    }
    if (phone) ev.phone = true;
    if (s.data?.summary) ev.summaries.push(`${s.name}: ${String(s.data.summary).slice(0, 800)}`);
    for (const f of (s.data?.frames ?? []) as any[]) if (f?.asset) ev.frames.push({ asset: f.asset, t: f.t, scene: f.scene, reason: f.reason, phone, scenario: base });
  }
  return ev;
}

/** The scenarios a run played (for choosing which part to review). */
export function scenariosPlayed(run: string, product: string) {
  return evidenceOf(run, product).scenarios;
}

/**
 * The critic's review of one game. Never throws: no frames, or a review that couldn't run, is "unjudged" (no scores,
 * never a pass). `scenario` limits the evidence to that chapter or level.
 */
export async function critic(p: Product, a: { run: string; scenario?: string | null; history?: { scenario: string | null }[]; dir?: string | null; candidates?: string[] }, deps: { ask?: typeof askClaude } = {}): Promise<Critic | null> {
  if (!isGame(p)) return null;
  const references = await ensureReferences(p, deps).catch(() => [] as Reference[]);
  const played = scenariosPlayed(a.run, p.id);
  const chosen = a.scenario !== undefined
    ? { scenario: a.scenario, next: [] as string[] }
    : pickScenario([...played, ...(a.candidates ?? [])], a.history ?? criticHistory(p.id));
  // Evidence from the chosen scenario's play; when it wasn't played in this run (picked from the contract's list), the
  // run's whole footage stands in and the report says which one was meant.
  let ev = evidenceOf(a.run, p.id, chosen.scenario && played.includes(chosen.scenario) ? chosen.scenario : null);
  if (!played.includes(chosen.scenario ?? '')) chosen.scenario = played.find((n) => !(a.history ?? criticHistory(p.id)).some((h) => h.scenario === n)) ?? played[0] ?? chosen.scenario;
  const unjudged = (why: string): Critic => ({ verdict: 'unjudged', scores: [], scenario: chosen.scenario, next: chosen.next, references, summary: why });
  if (!ev.frames.length) return unjudged('the critic had no frames to look at, so nothing was scored');
  const refs = references.length ? references.map((r) => `- ${r.game}: ${r.best}`).join('\n') : `(none given: compare with the best-known games of ${p.name}'s genre, naming them)`;
  const picked = [...ev.frames.filter((f) => !f.phone).slice(0, 12), ...ev.frames.filter((f) => f.phone).slice(0, 4)];
  const legend = picked.map((f, i) => `[${i + 1}] ${f.phone ? 'PHONE 390x844 ' : ''}${f.scenario}${f.t != null ? ` t=${f.t}s` : ''}${f.reason ? ` ${f.reason}` : ''}${f.scene ? ` (${f.scene})` : ''} asset ${f.asset}`).join('\n');
  const bible = worldBibleOf(a.dir);
  const prompt = `${criticBrief()}

THE GAME: ${p.name}. ${p.about ?? ''}
REFERENCE GAMES (compare with these, by name):
${refs}
WORLD BIBLE: ${bible ? `\n${bible}` : 'none yet (say so under story through play).'}

THIS REVIEW PLAYED: ${chosen.scenario ?? 'the run\'s scenarios'}.
Metrics (desktop): ${JSON.stringify(ev.metrics).slice(0, 1500)}
${ev.phone || Object.keys(ev.phoneMetrics).length ? `Metrics (phone run): ${JSON.stringify(ev.phoneMetrics).slice(0, 800)}\n` : 'There was no phone run: score "phone" only from what the desktop frames show about touch, and say so.\n'}${audioBlock(ev)}The reviewers' summaries:
${ev.summaries.join('\n').slice(0, 3000)}

THE ATTACHED FRAMES, in order:
${legend}

Score all ten dimensions: ${DIMENSIONS.join(', ')}. Each needs a score 1-10, the reference game compared, the frame number and clip time behind it, and the one fix that moves it most. A dimension with no evidence gets no invented score: give it 1 and say "no evidence" in why.`;
  const ask = deps.ask ?? askClaude;
  const params = { prompt, schema: SCHEMA, model: process.env.STUDIO_REVIEW_MODEL ?? 'claude-sonnet-5-5', effort: 'medium', maxTokens: 5000, timeoutMs: 10 * 60_000, purpose: 'critic', images: picked.map((f) => asImage(f.asset)) };
  try {
    const j: any = await ask(params as any);
    if (j?.status !== 'done') return unjudged("the critic's review couldn't run");
    const v = j.result?.value ?? {};
    const scores: CriticScore[] = [];
    for (const d of DIMENSIONS) {
      const s = (v.scores ?? []).find((x: any) => x?.dimension === d);
      if (!s || !Number.isFinite(Number(s.score))) continue;
      const frameRef = String(s.frame ?? '').trim();
      const n = Number(frameRef.replace(/\D/g, ''));
      const fromLegend = /^\d+$/.test(frameRef) && n >= 1 && n <= picked.length ? picked[n - 1] : null;
      scores.push({
        dimension: d, score: Math.max(1, Math.min(10, Math.round(Number(s.score)))), reference: String(s.reference ?? '').slice(0, 80) || references[0]?.game || 'its genre',
        frame: fromLegend?.asset ?? (frameRef || null), at: String(s.at ?? '').slice(0, 20) || (fromLegend?.t != null ? `t=${fromLegend.t}s` : ''),
        why: String(s.why ?? '').slice(0, 400), fix: String(s.fix ?? '').slice(0, 400),
      });
    }
    // Ten scores or nothing: a partial answer is not a verdict.
    if (scores.length < DIMENSIONS.length) return unjudged(`the critic scored only ${scores.length} of ${DIMENSIONS.length} dimensions`);
    return { verdict: 'judged', scores, scenario: chosen.scenario, next: chosen.next, references, summary: String(v.summary ?? '').slice(0, 600) };
  } catch {
    return unjudged("the critic's review couldn't run");
  }
}

/**
 * A run of a game ended: the critic runs on it when it is due (no judged run in 7 days, or a milestone beta run), as a
 * `critic` step on that run. Never throws; the report is written again so it shows the section.
 */
export async function afterRun(run: string, deps: { ask?: typeof askClaude } = {}) {
  try {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(run) as any;
    if (!r || r.status === 'cancelled' || r.kind === 'build' || r.kind === 'test') return [];
    const options = (parse(r.options) as any) ?? {};
    const milestone = r.kind === 'beta' && options.play === 'milestone';
    const out: string[] = [];
    for (const id of (parse(r.products) as string[]) ?? []) {
      let p: Product;
      try { p = getProduct(id); } catch { continue; }
      if (!isGame(p) || !criticDue(id, { milestone })) continue;
      // Nothing played in this run: nothing to judge, and no step (the next run that plays counts).
      if (!evidenceOf(run, id).frames.length && !db.prepare(`SELECT 1 FROM steps WHERE run = ? AND product = ? AND kind = 'playtest' LIMIT 1`).get(run, id)) continue;
      const { startStep, updateStep } = await import('./pipeline.ts');
      const s = startStep(run, id, 'critic', 'critic');
      const dir = await import('./beta.ts').then((b) => b.repoDirs(p).source).catch(() => null);
      const candidates = (knownScenarios(id, null) ?? []).concat((p.playtests ?? []).map((t: any) => t.scenario).filter(Boolean));
      const c = await critic(p, { run, dir, candidates }, deps);
      if (!c) { updateStep(s, { status: 'skipped', detail: 'not a game', finished: true }); continue; }
      const mean = c.scores.length ? Math.round((c.scores.reduce((n, x) => n + (x.score ?? 0), 0) / c.scores.length) * 10) / 10 : null;
      updateStep(s, { status: 'done', detail: c.verdict === 'judged' ? `critic: ${mean}/10 on ${c.scenario ?? 'the run'}` : `unjudged: ${c.summary}`, data: c, finished: true });
      out.push(s);
    }
    if (out.length) { const { writeReport } = await import('./report.ts'); writeReport(run); }
    return out;
  } catch (e: any) {
    console.warn(`[studio] critic after ${run}: ${e?.message ?? e}`);
    return [];
  }
}
