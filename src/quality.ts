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
/**
 * A check. `metric` with `max` / `min`: a playtest metric outside fails it (a product's `tuning` can move the limit for
 * its own game). `hard`: one sighting of the kind fails, whatever its severity (the camera clipping, snapping). `optional`:
 * a metric only some games report (coyote time in a game with no jumping), not listed as unmeasured when missing.
 * `world: "3d"`: only for a game with a 3D world (hasWorld3d). `advisory`: a reading over its limit is a note, never a
 * fail (the recording's stutters: the recorder can stall on its own).
 */
export type RubricCheck = { id: string; kind: CheckKind; what: string; problem?: string; metric?: string; max?: number; min?: number; hard?: boolean; optional?: boolean; world?: '3d'; advisory?: boolean };
/** A game's own limits for measured checks, by metric: products.json `tuning`, e.g. { "feel.inputLatencyMs": { "max": 120 } }. */
export type QualityTuning = Record<string, { max?: number; min?: number }>;
export type RubricRule = { id: string; title: string; why: string; build: string[]; checks: RubricCheck[] };
/** A line the owner added from feedback: an instruction (and, with `problem`, a code that fails a playtest). */
export type RubricLine = { id: string; product: string | null; rule: string; text: string; words: string | null; problem: string | null; by: string; source: string; at: number };
/**
 * seen: how the break was found. 'measured': the game or the browser reported it (a problem code, a console error, the
 * feel sensor's flag, a metric over its limit). 'vision': an AI looked at frames or the recording and judged it (the
 * polish pass's hits, the review's findings, the fun review). deploy.ts holdsGoLive never holds going live on a vision
 * sighting when the review of that play says ship: the judge sees new things every replay, so it never converges.
 */
export type QualityFail = { check: string; rule: string; title: string; evidence: string; kind?: CheckKind; seen?: 'measured' | 'vision' };

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

/**
 * A game's quality bar never accepts prototype work (the owner's gaps list, 2026-11-08: "quality bars stop accepting
 * prototype art or sparse content"): sentences of products.json `quality` that accept prototype, placeholder, temporary
 * or grey-box art, stub UI or sparse content are left out, and GAME_FLOOR is added. Other projects keep their bar as is.
 */
export const GAME_FLOOR = 'Floor for every game (above anything else in this bar): no prototype, placeholder or grey-box art, no stub or programmer UI, no sparse or empty areas. Every area is dressed and alive, and the camera and controls feel right (the game quality rules).';
const ACCEPTS_LESS = /\b(prototype|placeholder|programmer|temp(orary)?|grey-?box|gray-?box|blockout|stub|sparse|rough|unfinished|basic shapes?|primitives?)\b[^.!?]*\b(accept(ed|able)?|fine|ok(ay)?|allowed|is enough|are enough|will do|for now)\b|\b(accept(ed|able)?|fine|ok(ay)?|allowed)\b[^.!?]*\b(prototype|placeholder|programmer|grey-?box|gray-?box|blockout|stub|sparse)\b/i;
export function effectiveBar(p: Pick<Product, 'engine' | 'kind' | 'quality'>): string | undefined {
  if (!isGame(p)) return p.quality?.trim() || undefined;
  const kept = String(p.quality ?? '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x && !ACCEPTS_LESS.test(x)).join(' ');
  return [kept, GAME_FLOOR].filter(Boolean).join('\n');
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
  [/^camera-blocked$|^camera-(inside|clip)/, 'camera-clip'],
  [/^camera-(snap|jump|shake)/, 'camera-snap'],
  [/^jitter$|^collision-pop$/, 'movement-jitter'],
  [/^foot-slid/, 'foot-slide'],
  [/^slope-slide$/, 'stuck-airborne'],
  [/^inside-geometry$|clip/, 'clipping'],
  [/z-?fight|flicker/, 'z-flicker'],
  [/inside-?out|backface|normals/, 'inside-out'],
  [/backwards|mirror|text/, 'text-mirrored'],
  [/float|sunk|buried|hover/, 'floating-sunk'],
  [/empty|bare|barren/, 'empty-area'],
  [/^silent-action/, 'silent-actions'],
  [/^identical-repeat/, 'identical-repeats'],
];
function feelCheck(kind: string, checks: ReturnType<typeof rubricChecks>) {
  const k = kind.trim().toLowerCase();
  const own = checks.find((c) => c.id === k || c.problem === k || c.problem === `quality.${k}`);
  if (own) return own;
  const hit = FEEL_KINDS.find(([re]) => re.test(k));
  return hit ? checks.find((c) => c.id === hit[1]) ?? null : null;
}

/** A loading, title or menu screen: a long frame there is load stutter, not a hitch in play. */
export const LOADING_SCENE = /\b(load(ing)?|title|main menu|menu|splash|intro|boot|lobby|start screen|press start)\b/i;
/** A scene's first seconds (its first frames, shader warm-up) count as loading too. */
export const LOAD_SECONDS = 3;

/** A hitch flag in play, not on a loading screen or in a scene's first seconds (or the run's). */
export function inPlayHitch(f: { scene?: string | null; t?: number; st?: number }) {
  if (f.scene && LOADING_SCENE.test(f.scene)) return false;
  const since = Number.isFinite(Number(f.st)) ? Number(f.st) : Number(f.t);
  return !(Number.isFinite(since) && since < LOAD_SECONDS);
}

const CAMERA_KINDS = /^(camera-|below-ground|fell-out|stuck|collision-pop|jitter|foot-sliding|slope-slide|inside-geometry)/;
/**
 * Whether a played game has a 3D world: its `world` setting when set, else a Unity game, or a playtest whose feel
 * sensor watched a camera or a moving player (camera readings, input latency, explore cells, or a camera or player flag).
 */
export function hasWorld3d(p: { engine?: string; world?: string }, data: { metrics?: Record<string, unknown> | null; feel?: any[] | null }) {
  if (p.world) return p.world === '3d';
  if (p.engine === 'unity') return true;
  const m = data.metrics ?? {};
  if (['feel.maxCameraDegPerSec', 'feel.cameraClipSeconds', 'feel.inputLatencyMs', 'explore.coverage'].some((k) => Number.isFinite(Number(m[k])) && m[k] !== null)) return true;
  return (Array.isArray(data.feel) ? data.feel : []).some((f) => CAMERA_KINDS.test(String(f?.kind ?? '')));
}

export function qualityGate(p: Pick<Product, 'id' | 'engine' | 'kind'> & { tuning?: QualityTuning; world?: Product['world'] }, data: { problems?: any[]; metrics?: Record<string, unknown> | null; findings?: any[]; fun?: { verdict?: string; why?: string } | null; feel?: any[] | null; polish?: any[] | null; motion?: { worstHitchMs?: number | null } | null; software?: boolean }) {
  if (!isGame(p)) return { fails: [] as QualityFail[], unmeasured: [] as string[], notes: [] as string[] };
  const world3d = hasWorld3d(p, data);
  const checks = rubricChecks(p.id).filter((c) => world3d || c.world !== '3d');
  const notes: string[] = [];
  const fails: QualityFail[] = [];
  const seen = new Set<string>();
  const add = (c: (typeof checks)[number], evidence: string, how: 'measured' | 'vision' = 'measured') => {
    const key = `${c.id}:${evidence.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    fails.push({ check: c.id, rule: c.rule, title: c.ruleTitle, evidence: evidence.slice(0, 400), kind: c.kind, seen: how === 'vision' || c.kind === 'vision' || c.kind === 'review' ? 'vision' : 'measured' });
  };
  for (const pr of data.problems ?? []) {
    const c = named(pr, checks);
    if (c) add(c, String(pr.message ?? pr.title ?? c.what));
  }
  // The feel layer: sensor flags and vision hits of a kind a rule names. The rule is broken by a bug-severity one, by
  // any sighting of a hard check's kind (the camera clipping or snapping), or by the same kind seen twice or more (one
  // polish sighting can be a fluke of the run). Hitches say nothing on a browser without a GPU.
  const feel = [...(Array.isArray(data.feel) ? data.feel : []), ...(Array.isArray(data.polish) ? data.polish.map((f: any) => (f && typeof f === 'object' ? { ...f, __vision: true } : f)) : [])].filter((f) => f?.kind && !(data.software && f.kind === 'hitch'));
  const seenKind = new Map<string, number>();
  for (const f of feel) seenKind.set(String(f.kind), (seenKind.get(String(f.kind)) ?? 0) + Math.max(1, Number(f.count) || 1));
  for (const f of feel) {
    const c = feelCheck(String(f.kind), checks);
    if (!c || (f.severity !== 'bug' && !c.hard && (seenKind.get(String(f.kind)) ?? 0) < 2)) continue;
    // A measured check is decided by its reading (a 120 ms hitch is under the 250 ms limit), unless it is a hard limit.
    if (c.metric && !c.hard) continue;
    if (c) add(c, `${f.title ?? f.kind}${f.scene ? ` in ${f.scene}` : ''}${f.where ? ` (${f.where})` : ''}: ${String(f.detail ?? '').slice(0, 200)}`, f.__vision ? 'vision' : 'measured');
  }
  for (const f of data.findings ?? []) {
    const c = named(f, checks);
    if (c) add(c, `${String(f.title ?? '').replace(TAG, '').trim()}${f.detail ? `: ${String(f.detail).slice(0, 200)}` : ''}`, 'vision');
  }
  const unmeasured: string[] = [];
  const metrics = { ...(data.metrics ?? {}) } as Record<string, unknown>;
  // The review's own hitch measure (Hawkes Gen's motion pass on the recording).
  if (Number.isFinite(Number(data.motion?.worstHitchMs)) && metrics['video.worstHitchMs'] === undefined) metrics['video.worstHitchMs'] = Number(data.motion!.worstHitchMs);
  if (data.software) for (const k of ['feel.worstHitchMs', 'video.worstHitchMs', 'feel.inputLatencyMs', 'phone.fpsP5', 'phone.fpsDipAt']) delete metrics[k];
  // The worst frame in play: with the sensor's flags, the worst hitch outside loading screens and a scene's first
  // seconds (loading ones are load stutter, a note). Every frame of 100 ms and over (4x the usual) is flagged.
  if (Array.isArray(data.feel) && Number.isFinite(Number(metrics['feel.worstHitchMs']))) {
    const hitches = data.feel.filter((f) => f?.kind === 'hitch' && Number.isFinite(Number(f.value)));
    const load = hitches.filter((f) => !inPlayHitch(f));
    const play = hitches.filter((f) => inPlayHitch(f));
    const worstPlay = play.reduce((m, f) => Math.max(m, Number(f.value)), 0);
    if (load.length) {
      const worstLoad = load.reduce((m, f) => Math.max(m, Number(f.value)), 0);
      notes.push(`Load stutter (not counted as a hitch): up to ${Math.round(worstLoad)} ms on ${[...new Set(load.map((f) => f.scene || 'the first seconds'))].slice(0, 3).join(', ')}.`);
    }
    if (Number(metrics['feel.worstHitchMs']) > worstPlay) metrics['feel.worstHitchMs'] = Math.round(worstPlay);
  }
  for (const c of checks) {
    if (!c.metric) continue;
    const v = Number(metrics[c.metric]);
    if (metrics[c.metric] === undefined || metrics[c.metric] === null || !Number.isFinite(v)) {
      if (!c.optional && !fails.some((f) => f.check === c.id)) unmeasured.push(`${c.id} (${c.metric})`);
      continue;
    }
    const own = p.tuning?.[c.metric];
    const max = own?.max ?? c.max;
    const min = own?.min ?? c.min;
    const over = max !== undefined && v > max ? `${c.metric} = ${v}, over ${max}` : min !== undefined && v < min ? `${c.metric} = ${v}, under ${min}` : null;
    if (!over) continue;
    if (c.advisory) notes.push(`${over} (${c.id}, a note: ${c.what.split('. Advisory')[0]})`);
    else add(c, `${over}: ${c.what}`);
  }
  if (data.fun?.verdict === 'demo') {
    const c = checks.find((x) => x.id === 'fun-review');
    if (c) add(c, `the fun review calls it a demo, not a living world${data.fun.why ? `: ${data.fun.why}` : ''}`, 'vision');
  }
  return { fails, unmeasured, notes };
}

const LIMIT_FIX: Record<string, string> = {
  hitch: 'Find what stalls the frame at that moment (a synchronous load, shader compile, garbage collection spike, a big allocation or a physics burst) and move it off the frame: preload or stream it, warm shaders during loading, pool objects. Loading screens are exempt; play is not.',
  'input-latency': 'Read input in the same frame it moves the player (no extra frame of buffering, no smoothing on the first frame of movement), and keep the frame time low.',
  'camera-clip': 'Keep the camera out of walls: a collision probe or spring arm that pulls it in front of geometry, and fade what still blocks the view.',
  'explore-falls': 'Close the holes the explore bot fell through: collision on every walkable surface, no gaps at seams, a kill floor that respawns.',
  'explore-stuck': 'Smooth the collision where the explore bot got stuck: step offsets, no thin lips or snag edges, slide along walls.',
  loudness: 'Mix to about -18 LUFS integrated (±3): lower the master or add a limiter, then re-measure.',
  'true-peak': 'True peak at most -1 dBTP: limit or reduce peaks so the mix never clips.',
  'silent-actions': 'Play a one-shot SFX on that action within 150 ms (jump, attack, confirm, UI click).',
  'identical-repeats': 'Use a small sample pool so the same buffer+rate never plays twice within 60 s.',
  'voice-duck': 'When voice plays, duck the music bus by at least 6 dB and restore it after.',
  'first-five-gameplay': 'Get a stranger into play sooner: no terms, sign-in or menu chain before the game (ask later, when saving), preload what play needs, and start the first weapon, obstacle or goal on its own.',
  'first-five-input': 'Accept the first input at once: no intro that eats keys or taps, no loading that hides a live game, input bound before the first frame.',
  'first-five-success': 'Make the first success come inside a minute: a first target that cannot be missed, a first reward that fires on its own.',
  'first-five-taps': 'At most 2 taps from the first screen to play: fold the menu chain into one Play button, remove modal walls.',
  'first-five-words': 'Teach by doing, not by paragraphs: cut the first minute to 40 words or fewer.',
  'first-five-dev-ui': 'Hide developer panels and debug controls behind a flag that is off in the public build (FPS counters, level pickers, cheat menus).',
  'small-targets': 'Make each named control at least 44x44 px (padding or a larger hit area; the picture can stay small) with 8 px between neighbours, at 390x844 and 844x390.',
  'inset-overlaps': 'Keep controls out of the notch and home-bar areas: env(safe-area-inset-*) padding with viewport-fit=cover, or Screen.safeArea in Unity.',
  'offscreen-controls': 'Bring every control on screen at 390x844 and 844x390: wrap or scroll the layout and size with vw/vh.',
  'dead-presses': 'Answer each press on the frame it arrives: a pressed state, then the result, within 100 ms.',
  'silent-presses': 'Play a UI click through the WebAudio context within 150 ms of each press (tag it __hawkesSampleId = "ui-click").',
  'silence-in-play': 'Fill quiet gaps in play with ambient, footsteps or reactive SFX (menus and loading excluded).',
  'phone-load-mb': 'Cut what loads before gameplay to at most 20 MB transferred on a mid-range phone (CrazyGames bar): defer non-critical assets, compress, code-split.',
  'phone-load-time': 'Reach gameplay in at most 20 s under 4x CPU and Slow 4G: fewer blocking requests, smaller first paint, start play before secondary downloads finish.',
  'phone-fps-p5': 'Raise fps p5 to at least 30 on a throttled phone: lower draw calls and overdraw, smaller textures, fewer per-frame allocations; watch the clip at the dip time.',
};

/** A first-five finding's evidence: where the clip is, and what stood in the way (ftue.ts puts both on the result). */
function firstFiveEvidence(check: string, r: any): string {
  const f = r?.ftue;
  if (!f || !check.startsWith('first-five')) return '';
  const clip = f.clip ? ` Clip: Gen asset ${f.clip.asset}, 0:00 to ${f.clip.to} s.` : '';
  const walls = f.walls?.length ? ` Walls met: ${f.walls.map((w: any) => `${w.label} (${w.seconds} s)`).join(', ')}.` : '';
  const dev = check === 'first-five-dev-ui' && f.devUi?.length ? ` Seen: ${f.devUi.map((d: any) => d.what).join('; ')}.` : '';
  return `${clip}${walls}${dev}`;
}

/**
 * A played build's broken measured limits (a hitch in play over 250 ms, input latency over 100 ms), one finding each
 * with a title that stays the same run to run, filed as bugs so agents fix them on beta (pipeline.ts fileFeel).
 * Flag-based fails are filed by the feel layer already; advisory readings are notes, never findings.
 */
/** Asset list / dip time on a phone.* miss (keeps quality.ts free of a phoneperf import; pipeline files phonePerfFindings too). */
function phoneEvidence(check: string, r: any): string {
  const f = r?.phone;
  if (!f || !check.startsWith('phone-')) return '';
  if ((check === 'phone-load-mb' || check === 'phone-load-time') && Array.isArray(f.assets) && f.assets.length) {
    const top = f.assets.slice(0, 5).map((a: any) => {
      const path = String(a.path ?? a.url ?? '').slice(0, 80);
      const mb = Math.round((Number(a.bytes) || 0) / 1e5) / 10;
      return `${path} (${mb} MB)`;
    });
    return ` Five largest pre-gameplay assets: ${top.join('; ')}.`;
  }
  if (check === 'phone-fps-p5' && Number.isFinite(Number(f.fpsDipAt))) return ` Dip at ${Number(f.fpsDipAt)} s in the recording.`;
  return '';
}

export function qualityFindings(p: Pick<Product, 'id' | 'engine' | 'kind'> & { tuning?: QualityTuning; world?: Product['world'] }, r: any, scenario: string) {
  if (!r) return [];
  // Phone fps means nothing in software (same as hitch / input latency).
  const metrics = { ...(r.metrics ?? {}) };
  if (r.software) for (const k of ['phone.fpsP5', 'phone.fpsDipAt']) delete metrics[k];
  const g = qualityGate(p, { metrics, feel: r.feel, polish: r.polish?.hits, software: Boolean(r.software) });
  const checks = rubricChecks(p.id);
  return g.fails.flatMap((f) => {
    const c = checks.find((x) => x.id === f.check);
    if (!c?.metric || !f.evidence.startsWith(`${c.metric} = `)) return [];
    // phone-load misses are filed by phonePerfFindings (names the five largest assets / the fps dip time).
    if (c.rule === 'phone-load') return [];
    return [{
      title: `Quality limit broken: ${c.id} (${f.title})`,
      severity: 'bug', area: c.id.startsWith('first-five') ? 'onboarding' : c.id === 'hitch' ? 'performance' : c.id.startsWith('camera') ? 'camera' : (c.rule === 'sound-design' || c.id.startsWith('audio') || ['loudness', 'true-peak', 'silent-actions', 'identical-repeats', 'voice-duck', 'silence-in-play'].includes(c.id) ? 'audio' : c.rule === 'menus-and-ui' ? 'mobile' : 'gameplay'),
      detail: `The ${scenario} playtest measured ${f.evidence.split(':')[0]}. ${c.what}${firstFiveEvidence(c.id, r)}${phoneEvidence(c.id, r)}${g.notes.length ? `\nNotes: ${g.notes.join(' ')}` : ''}`.slice(0, 1500),
      shots: c.id === 'first-five-dev-ui' ? (r.ftue?.devUi ?? []).map((d: any) => d.shot).filter(Boolean) : [],
      fix: LIMIT_FIX[c.id] ?? `Bring ${c.metric} inside its limit, then play the scenario again.`,
    }];
  });
}

/** One line per failure, for a gate's reasons, a blocker or a log. */
export const failLine = (f: QualityFail) => `quality rule "${f.title}" broken (${f.check}): ${f.evidence}`;
