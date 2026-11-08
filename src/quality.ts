// The game quality rubric (docs/quality.md; the owner, 2026-11-08: "If we really want studio to be able to make games,
// it has to understand that a game isn't just a little demo"). One rubric, three uses:
//   1. what every game's agents are told: the brief's "Game quality rules" (rubricBrief), the reviews' bar
//      (rubricReviewText) and the fun reviewer's (fun-review.ts);
//   2. the build gate: Studio's own scan of what a change touched (quality-scan.ts), before its pull request opens; a
//      failure sends the agent back (QUALITY_FIXES passes), then fails the change;
//   3. the playtest gate (qualityGate): a playtest problem, a review finding or a metric that breaks a check fails the
//      playtested change (acceptance.ts gate) and blocks going live (deploy.ts).
// The rules themselves are data: quality/game-rubric.json (the approved set), plus lines the owner adds from feedback
// (studio_rubric add in Talk, or a 🐞 report that starts with "Rule:"), kept in the quality_lines table and loaded with it.
//
// What fails a playtest is named, never guessed: a problem whose `code` (or a message starting "[quality:<check>]" or
// "quality.<name>") is a check's `problem`, a review finding whose `rule` (or title "[quality:<check>]") names a check,
// or a metric over a check's `max`. The playtest feel layer (window.hawkesPlaytest sensors, the vision polish rubric)
// reports those codes; a game's own probes may too (docs/quality.md "Reporting a rule break").

import fs from 'node:fs';
import path from 'node:path';
import { db, newId } from './db.ts';
import { ROOT, StudioError, type Product } from './config.ts';

export type CheckKind = 'scan' | 'playtest' | 'vision' | 'review';
export type RubricCheck = { id: string; kind: CheckKind; what: string; problem?: string; metric?: string; max?: number };
export type RubricRule = { id: string; title: string; why: string; build: string[]; checks: RubricCheck[] };
/** A line the owner added from feedback: an instruction (and, with `problem`, a code that fails a playtest). */
export type RubricLine = { id: string; product: string | null; rule: string; text: string; words: string | null; problem: string | null; by: string; source: string; at: number };
export type QualityFail = { check: string; rule: string; title: string; evidence: string };

db.exec(`CREATE TABLE IF NOT EXISTS quality_lines (
  id TEXT PRIMARY KEY, product TEXT, rule TEXT NOT NULL, text TEXT NOT NULL, words TEXT, problem TEXT,
  by TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, removed INTEGER
)`);

/** The rule an owner's line goes under when it names none. */
export const OWNER_RULE = 'owner-feedback';

export const RUBRIC_FILE = () => process.env.STUDIO_RUBRIC_FILE ?? path.join(ROOT, 'quality', 'game-rubric.json');
let cached: { mtime: number; rules: RubricRule[] } | null = null;
/** The approved rules (quality/game-rubric.json), read once per change of the file. */
export function baseRules(): RubricRule[] {
  const file = RUBRIC_FILE();
  const st = fs.statSync(file);
  if (cached && cached.mtime === st.mtimeMs) return cached.rules;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rules = (j.rules ?? []) as RubricRule[];
  cached = { mtime: st.mtimeMs, rules };
  return rules;
}

/** A game is a project of kind game (the default) that isn't a static site: the rubric is for it. */
export function isGame(p: Pick<Product, 'engine' | 'kind'> | null | undefined) {
  return Boolean(p) && (p!.kind ?? 'game') === 'game' && p!.engine !== 'static';
}

const rowLine = (r: any): RubricLine => ({ id: r.id, product: r.product ?? null, rule: r.rule, text: r.text, words: r.words ?? null, problem: r.problem ?? null, by: r.by, source: r.source, at: r.at });

/** The owner's lines for a product: studio-wide ones and the product's own. */
export function rubricLines(product?: string | null): RubricLine[] {
  const rows = product
    ? db.prepare('SELECT * FROM quality_lines WHERE removed IS NULL AND (product IS NULL OR product = ?) ORDER BY at').all(product)
    : db.prepare('SELECT * FROM quality_lines WHERE removed IS NULL ORDER BY at').all();
  return (rows as any[]).map(rowLine);
}

/** The whole rubric for a product: the approved rules with the owner's lines under theirs (and a rule for the rest). */
export function rubricFor(product?: string | null): RubricRule[] {
  const lines = rubricLines(product);
  const rules = baseRules().map((r) => ({ ...r, build: [...r.build], checks: [...r.checks] }));
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const l of lines) {
    let r = byId.get(l.rule);
    if (!r) {
      r = { id: OWNER_RULE, title: "From the owner's playtest feedback", why: 'Things the owner saw and asked every game to get right.', build: [], checks: [] };
      if (!byId.has(OWNER_RULE)) { rules.push(r); byId.set(OWNER_RULE, r); } else r = byId.get(OWNER_RULE)!;
    }
    r.build.push(l.text);
    if (l.problem) r.checks.push({ id: l.id, kind: 'playtest', what: l.text, problem: l.problem });
  }
  return rules;
}

/** Every check, with its rule. */
export function rubricChecks(product?: string | null) {
  return rubricFor(product).flatMap((r) => r.checks.map((c) => ({ ...c, rule: r.id, ruleTitle: r.title })));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const CODE = /^quality\.[a-z0-9][a-z0-9-]*$/;

/**
 * Adds a line to the rubric from the owner's feedback. `words` are their words as they said them (Talk passes them on,
 * a 🐞 report is them); `text` the rule as agents read it (their words when no rewording is needed). A line already
 * there (same text) isn't added twice. `problem`: a playtest code (quality.<name>) that fails the playtest.
 */
export function addRubricLine(a: { product?: string | null; rule?: string | null; text: string; words?: string | null; problem?: string | null; by: string; source: string }): RubricLine {
  const text = String(a.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 600);
  if (text.length < 8) throw new StudioError('A rubric line needs the rule in a sentence', 400);
  const rule = a.rule && baseRules().some((r) => r.id === a.rule) ? a.rule : OWNER_RULE;
  const problem = a.problem ? String(a.problem).trim().toLowerCase() : null;
  if (problem && !CODE.test(problem)) throw new StudioError('problem: a code like quality.camera-snap', 400);
  const same = rubricLines(a.product ?? null).find((l) => norm(l.text) === norm(text));
  if (same) return same;
  const id = newId('ql');
  db.prepare('INSERT INTO quality_lines (id, product, rule, text, words, problem, by, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, a.product ?? null, rule, text, a.words ? String(a.words).slice(0, 2000) : null, problem, a.by, a.source, Date.now());
  return rowLine(db.prepare('SELECT * FROM quality_lines WHERE id = ?').get(id));
}

export function removeRubricLine(id: string) {
  const r = db.prepare('UPDATE quality_lines SET removed = ? WHERE id = ? AND removed IS NULL').run(Date.now(), id);
  if (!Number(r.changes)) throw new StudioError(`No rubric line ${id}`, 404);
  return { removed: id };
}

/** The 🐞 report text that is a rule, not a bug: "Rule: ..." (also "New rule:", "Always ...:", "Never ...:"). */
export function ruleFromReport(text: string | null | undefined): string | null {
  const m = /^\s*(?:new\s+)?rule\s*[:\-–]\s*([\s\S]{8,})$/i.exec(String(text ?? ''));
  return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 600) : null;
}

// ------------------------------------------------------------------ what agents and reviews read

/** The brief's section for a game: every rule, its build rules and how it is checked. Empty for non-games. */
export function rubricBrief(p: Product, plugin = 'hawkes') {
  if (!isGame(p)) return '';
  const rules = rubricFor(p.id);
  const lines = rules.map((r, i) => `${i + 1}. **${r.title}.** ${r.why}\n${r.build.map((b) => `   - ${b}`).join('\n')}\n   - Checked by: ${r.checks.map((c) => `${c.what} (${c.kind === 'scan' ? "Studio's scan, before your pull request" : c.kind === 'review' ? 'the fun review of a played build' : 'the playtest'})`).join(' ')}`).join('\n');
  return `
## Game quality rules (every game, every change)

These hold for every change to a game, whatever the task says. Breaking one fails the change: Studio scans what you
touched before your pull request opens and sends you back with what it found, and a playtest that shows a broken rule
fails, so the change doesn't merge and the game doesn't go live. The full guide, with probes and fixes for Unity and
the web, is the game-quality skill (load it before building anything a player sees).

${lines}

Before feature or content work: read \`docs/world-bible.md\` and build to it (add to it when your work adds an area, a
character or a story beat). No world bible yet and your task adds areas, characters or story: write it first (the
game-quality skill has the template), commit it, then build. Before you finish work a player will see, ask the
${plugin}:fun-reviewer subagent to look at what you made against these rules, and fix what it calls a demo.
`;
}

/** The rubric for a review (playtest.review's bar): each check to judge, and how to tag a finding that breaks one. */
export function rubricReviewText(p: Product) {
  if (!isGame(p)) return '';
  const checks = rubricChecks(p.id).filter((c) => c.kind === 'vision' || c.kind === 'playtest' || c.kind === 'review');
  return `Game quality rules: a finding that breaks one starts its title with the check in brackets, e.g. "[quality:ground-contact] The fountain floats above the square", and is at least a bug. ${checks.map((c) => `[quality:${c.id}] ${c.what}`).join(' ')}`;
}

// ------------------------------------------------------------------ the playtest gate

const TAG = /^\s*\[quality:([a-z0-9_-]+)\]/i;
const CODED = /^\s*(quality\.[a-z0-9-]+)\b/i;

/** The check an item names: its code / rule field, a "[quality:<check>]" tag, or a "quality.<name>" code up front. */
function named(item: any, checks: ReturnType<typeof rubricChecks>) {
  const fields = [item?.code, item?.rule, item?.check].filter((x) => typeof x === 'string').map((x: string) => x.trim().toLowerCase());
  const text = String(item?.message ?? item?.title ?? '');
  const tag = TAG.exec(text)?.[1]?.toLowerCase();
  const coded = CODED.exec(text)?.[1]?.toLowerCase();
  for (const k of [...fields, tag, coded].filter(Boolean) as string[]) {
    const c = checks.find((x) => x.id === k || x.problem === k || `quality:${x.id}` === k || (k.startsWith('quality.') && x.problem === k));
    if (c) return c;
  }
  // A rule's id ("[quality:text-facing]"): its first check a played build can show (vision, playtest, review).
  for (const k of [...fields, tag].filter(Boolean) as string[]) {
    const of = checks.filter((x) => x.rule === k);
    const c = of.find((x) => x.kind !== 'scan') ?? of[0];
    if (c) return c;
  }
  return null;
}

/**
 * The quality gate on a played build: what broke a rule (each fails it), and the measured checks that weren't measured
 * (the game doesn't report them yet: said, never a pass). `data`: a playtest's result or step data (problems, metrics)
 * and its review (findings, or the review's own data); `fun`: the fun review (fun-review.ts).
 */
/**
 * The playtest feel layer's kinds (feel.ts: the game's sensor flags in result.feel, the vision pass's hits in
 * result.polish.hits) that break a rubric rule, by the check they count as. A kind that is itself a check id or a
 * quality.* code (a line of the owner's sent as playtest.run's rubric) counts as that check.
 */
const FEEL_KINDS: [RegExp, string][] = [
  [/^foot-slid/, 'foot-slide'],
  [/^slope-slide$/, 'stuck-airborne'],
  [/^inside-geometry$|clip/, 'clipping'],
  [/z-?fight|flicker/, 'z-flicker'],
  [/inside-?out|backface|normals/, 'inside-out'],
  [/backwards|mirror|text/, 'text-mirrored'],
  [/float|sunk|buried|hover/, 'floating-sunk'],
  [/empty|bare|barren/, 'empty-area'],
];
function feelCheck(kind: string, checks: ReturnType<typeof rubricChecks>) {
  const k = kind.trim().toLowerCase();
  const own = checks.find((c) => c.id === k || c.problem === k || c.problem === `quality.${k}`);
  if (own) return own;
  const hit = FEEL_KINDS.find(([re]) => re.test(k));
  return hit ? checks.find((c) => c.id === hit[1]) ?? null : null;
}

export function qualityGate(p: Pick<Product, 'id' | 'engine' | 'kind'>, data: { problems?: any[]; metrics?: Record<string, unknown> | null; findings?: any[]; fun?: { verdict?: string; why?: string } | null; feel?: any[] | null; polish?: any[] | null }) {
  if (!isGame(p)) return { fails: [] as QualityFail[], unmeasured: [] as string[] };
  const checks = rubricChecks(p.id);
  const fails: QualityFail[] = [];
  const seen = new Set<string>();
  const add = (c: (typeof checks)[number], evidence: string) => {
    const key = `${c.id}:${evidence.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    fails.push({ check: c.id, rule: c.rule, title: c.ruleTitle, evidence: evidence.slice(0, 400) });
  };
  for (const pr of data.problems ?? []) {
    const c = named(pr, checks);
    if (c) add(c, String(pr.message ?? pr.title ?? c.what));
  }
  // The feel layer: sensor flags and vision hits of a kind a rule names. The rule is broken by a bug-severity one, or
  // by the same kind seen twice or more (one polish sighting can be a fluke of the run).
  const feel = [...(Array.isArray(data.feel) ? data.feel : []), ...(Array.isArray(data.polish) ? data.polish : [])].filter((f) => f?.kind);
  const seenKind = new Map<string, number>();
  for (const f of feel) seenKind.set(String(f.kind), (seenKind.get(String(f.kind)) ?? 0) + Math.max(1, Number(f.count) || 1));
  for (const f of feel) {
    if (f.severity !== 'bug' && (seenKind.get(String(f.kind)) ?? 0) < 2) continue;
    const c = feelCheck(String(f.kind), checks);
    if (c) add(c, `${f.title ?? f.kind}${f.scene ? ` in ${f.scene}` : ''}${f.where ? ` (${f.where})` : ''}: ${String(f.detail ?? '').slice(0, 200)}`);
  }
  for (const f of data.findings ?? []) {
    const c = named(f, checks);
    if (c) add(c, `${String(f.title ?? '').replace(TAG, '').trim()}${f.detail ? `: ${String(f.detail).slice(0, 200)}` : ''}`);
  }
  const unmeasured: string[] = [];
  const metrics = (data.metrics ?? {}) as Record<string, unknown>;
  for (const c of checks) {
    if (!c.metric) continue;
    const v = Number(metrics[c.metric]);
    if (metrics[c.metric] === undefined || metrics[c.metric] === null || !Number.isFinite(v)) {
      if (!fails.some((f) => f.check === c.id)) unmeasured.push(`${c.id} (${c.metric})`);
      continue;
    }
    if (c.max !== undefined && v > c.max) add(c, `${c.metric} = ${v}, over ${c.max}: ${c.what}`);
  }
  if (data.fun?.verdict === 'demo') {
    const c = checks.find((x) => x.id === 'fun-review');
    if (c) add(c, `the fun review calls it a demo, not a living world${data.fun.why ? `: ${data.fun.why}` : ''}`);
  }
  return { fails, unmeasured };
}

/** One line per failure, for a gate's reasons, a blocker or a log. */
export const failLine = (f: QualityFail) => `quality rule "${f.title}" broken (${f.check}): ${f.evidence}`;
