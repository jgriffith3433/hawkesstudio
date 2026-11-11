// The task bar (J, Nov 10: "higher quality roadmap items and even higher quality tasks and faster iteration"): what a
// roadmap task must carry before an agent is started on it.
//
//   A game or site task: a player goal (what the player feels or can do after it ships), a reference (a best-in-class game
//   and the exact moment matched; a site may say "none"), a critic axis (AXES), a phone line (how it behaves at 390x844
//   touch) and 2 to 5 criteria a playtest can see or measure, at least one "[phone] ..." criterion.
//   An infra or library task (Studio, Gen, apps and libraries): an outcome (a visible or measurable result) and 1 to 5 criteria.
//
// checkTask is the pure rule. gateTask runs from pm.ts startWork before a task's agent starts: a task that meets the bar
// starts; one that doesn't gets ONE cheap rewrite (Haiku) into the shape, keeping its intent and scope; one that can't be
// made to meet it is parked as an idea with its reason, never handed to an agent. Each version of a task (its request and
// criteria, hashed) is judged once; re-plans, scenario fixes and GPU reruns (tries > 0) are never gated. A model failure
// leaves the task planned (gated again on the next pass); the third failure parks it. No timer: it runs when a task would start.

import crypto from 'node:crypto';
import { db } from './db.ts';
import { askClaude } from './llm.ts';
import { loadProducts, isInfra, type Product } from './config.ts';
import { modelId } from './roles.ts';
import { isGame } from './quality.ts';
import { libraryProject } from './verdictwork.ts';
import { worldBibleOf } from './fun-review.ts';
import { repoDirs } from './beta.ts';
import { AXES, BAR_FIELDS, barOf, getItem, getTask, listDecisions, logDecision, setBar, updateTask, type Bar, type Task } from './roadmap.ts';

export { AXES, barOf } from './roadmap.ts';
export type BarKind = 'game' | 'site' | 'infra';
export type BarCheck = { ok: boolean; missing: string[]; vague: string[]; kind: BarKind };
type Shaped = Pick<Task, 'request' | 'criteria'> & { title?: string; bar?: Bar | null };

/** Which bar a product's tasks meet: Studio, Gen, apps and libraries need an outcome; games and sites a player goal. */
export function barKindOf(productId: string): BarKind {
  if (isInfra(productId)) return 'infra';
  const p = loadProducts().find((x) => x.id === productId);
  if (!p) return 'infra';
  if (libraryProject(p) || p.kind === 'app') return 'infra';
  return isGame(p) && p.engine !== 'static' ? 'game' : 'site';
}

export const PHONE = /^\s*\[phone\]\s*\S/i;
/** Words that say nothing a playtest can see ("feels better", "is polished", "code is clean"). */
const VAGUE = /\b(feels?\s+(?:better|good|nicer|great|right|smoother)|is\s+polished|polished|is\s+fun|more\s+fun|fun\s+to|looks?\s+(?:nice|good|better|great|polished)|code\s+is\s+clean|clean\s+code|cleaner|improved?|improvements?|better|nicer)\b/i;
/** Something observable or numeric in the criterion: a number, or a measured or seen thing. */
const MEASURED = /\d|\b(within|at least|at most|no more than|fewer|exactly|per second|never|exists?|contains?|appears?|visible|shows?|plays?|displays?|reaches?|ends?|logs?|retries|returns?|opens?|closes?|spawns?|drops?)\b/i;
const UNBOUNDED = /^\W*(?:to\s+)?(audit|explore|investigate|consider|improve|look\s+into|survey|research|review|polish|refine)\b/i;
const HEAD = /^\s*(?:(?:[-*#>+]+|\d+[.)])\s*)?[*_`]*\s*(?:player\s+goal|reference|critic\s+axis|phone|outcome|original\s+request)\s*[*_`]*\s*[:：]/i;

/** A criterion that is vague: a vague phrase with nothing observable or numeric beside it. */
export const vagueCriterion = (k: string) => VAGUE.test(k) && !/\d/.test(k) && !/\b(within|at least|at most|no more than|fewer|exactly|per second)\b/i.test(k);

/** The work itself in a request: its first line that is not one of the bar's headings (or their continuation). */
export function workLine(request: string): string {
  let inHead = false;
  for (const line of String(request ?? '').split('\n')) {
    if (HEAD.test(line)) { inHead = true; if (/^\s*original request\s*:/i.test(line)) return ''; continue; }
    if (!line.trim()) { inHead = false; continue; }
    if (inHead) continue;
    return line.trim();
  }
  return '';
}

/** The pure bar check. missing: what the task lacks; vague: what is there but says nothing a playtest can see. */
export function checkTask(t: Shaped, kind: BarKind = 'game'): BarCheck {
  const missing: string[] = [];
  const vague: string[] = [];
  const bar = t.bar ?? {};
  const crit = t.criteria ?? [];
  if (kind === 'infra') {
    if (!bar.outcome?.trim()) missing.push('an outcome (a user-visible or measurable result)');
    if (crit.length < 1) missing.push('1 to 5 criteria a playtest or check can see');
  } else {
    if (!bar.goal || bar.goal.trim().split(/\s+/).length < 3) missing.push('a player goal (one sentence: what the player feels or can do after it ships)');
    if (!bar.reference?.trim()) missing.push(kind === 'site' ? 'a reference (a best-in-class example, or "none")' : 'a reference (a best-in-class game and the exact moment matched)');
    if (!bar.axis || !AXES.includes(bar.axis)) missing.push(`a critic axis (one of ${AXES.join(', ')})`);
    if (!bar.phone?.trim()) missing.push('a phone line (how it behaves at 390x844 touch)');
    if (crit.length < 2) missing.push('2 to 5 criteria a playtest can see or measure');
    // A phone line of "n/a: ..." (a document) needs no phone criterion.
    if (!/^n\/a\b/i.test(bar.phone ?? '') && !crit.some((k) => PHONE.test(k))) missing.push('a "[phone] ..." criterion (judged on a 390x844 touch playtest)');
  }
  if (crit.length > 5) vague.push(`${crit.length} criteria: at most 5 (split the task)`);
  for (const k of crit) if (vagueCriterion(k)) vague.push(`criterion "${k.slice(0, 80)}" has nothing observable or numeric`);
  if (crit.length && !crit.some((k) => !vagueCriterion(k) && MEASURED.test(k))) vague.push('no criterion a playtest can verify');
  const work = workLine(t.request);
  if (UNBOUNDED.test(work) && !crit.some((k) => /\d/.test(k))) vague.push(`the work "${work.slice(0, 80)}" is unbounded: it has no measurable end`);
  return { ok: !missing.length && !vague.length, missing, vague, kind };
}

export const hashOf = (t: Pick<Task, 'request' | 'criteria'>) => crypto.createHash('sha1').update(JSON.stringify([t.request, t.criteria])).digest('hex').slice(0, 16);

/** Short reasons for a note: what is missing without its explanation, then what is vague. */
const reasonsOf = (c: BarCheck) => [...c.missing.map((m) => `no ${m.replace(/\s*\(.*$/, '').replace(/^an? /, '')}`), ...c.vague];

// ------------------------------------------------------------------ the rewrite

const SCHEMA = {
  type: 'object',
  properties: {
    shapeable: { type: 'boolean', description: 'true when the task can be shaped to the bar (the usual case); false only when the work itself is unbounded or unclear.' },
    cannot: { type: 'string', description: 'Only when shapeable is false: why the work itself is unbounded or unclear. Otherwise the empty string "", never a word like "Empty" or "none".' },
    goal: { type: 'string' }, reference: { type: 'string' }, axis: { type: 'string', enum: AXES }, phone: { type: 'string' }, outcome: { type: 'string' },
    work: { type: 'string', description: 'The task\'s work in the same scope, in a few sentences.' },
    criteria: { type: 'array', items: { type: 'string' } },
  },
  required: ['shapeable', 'cannot', 'goal', 'reference', 'axis', 'phone', 'outcome', 'work', 'criteria'],
};

export const BAR_TEXT = `A game or site task carries: a player goal (one sentence on what the player feels or can do after it ships); a reference
(a best-in-class game and the exact moment matched; a site may say "none"); a critic axis (one of ${AXES.join(', ')}); a
phone line (how it behaves at 390x844 touch); and 2 to 5 criteria a playtest can see or measure, at least one starting
with "[phone] ". An infra or library task carries an outcome (a user-visible or measurable result: a count, a time, a
state a run ends in) and 1 to 5 criteria. Vague: criteria like "feels better", "is polished", "is fun", "looks nice",
"code is clean" or "improved" with nothing observable or numeric; work that is an unbounded audit, explore or investigate
with no measurable end.`;

type Ask = typeof askClaude;
/** Tests replace the model call. */
let askOverride: Ask | null = null;
export const setTaskBarAsk = (f: Ask | null) => { askOverride = f; };

function productContext(productId: string) {
  const p: Product | undefined = loadProducts().find((x) => x.id === productId);
  if (!p) return `PRODUCT: ${productId}`;
  let dir: string | null = null;
  try { dir = repoDirs(p).source; } catch { /* no checkout */ }
  const bible = worldBibleOf(dir, 3000);
  return `PRODUCT: ${p.name}. ${p.about ?? ''}\nITS QUALITY BAR: ${p.quality ?? '(none set)'}\nWORLD BIBLE (excerpt): ${bible ?? 'none'}`;
}

/** The request after a rewrite: the shape, the work, then the original kept whole. */
export function composeRequest(kind: BarKind, a: { goal?: string; reference?: string; axis?: string; phone?: string; outcome?: string; work: string }, original: string) {
  const head = kind === 'infra'
    ? [`Outcome: ${a.outcome}`]
    : [`Player goal: ${a.goal}`, `Reference: ${a.reference}`, `Critic axis: ${a.axis}`, `Phone: ${a.phone}`];
  const orig = original.includes('\nOriginal request:\n') ? original.split('\nOriginal request:\n').pop()! : original;
  return `${head.join('\n')}\n\n${a.work.trim()}\n\nOriginal request:\n${orig.trim()}`;
}

/** The gate's decision on a task that would start: 'ok' (start it), 'wait' (the model failed: try again next pass) or 'parked'. */
export type GateResult = 'ok' | 'wait' | 'parked';
const failures = new Map<string, number>();
const MAX_FAILS = 3;

const gateOf = (verdict: NonNullable<Bar['gate']>['verdict'], reasons: string[], hash: string): NonNullable<Bar['gate']> => ({ verdict, reasons: reasons.slice(0, 8), at: Date.now(), hash });
const snapshot = (t: Task) => ({ kind: 'task-bar', task: t.id, request: t.request, criteria: t.criteria, bar: t.bar });

class EmptyShape extends Error {}
/** Text that says something: not blank, not only quotes, brackets, dashes or "none"/"n/a"/"null". */
const meaningful = (v: unknown) => { const s = String(v ?? '').replace(/["'`“”‘’()\[\]{}\s.\-–—_*]/g, ''); return !!s && !/^(none|n\/?a|null|undefined|no|empty)$/i.test(s); };
/** A shaper answer with no goal, outcome, work or criteria and no real reason to refuse: the call failed, it didn't judge. */
/**
 * A "cannot" that says the task CAN be shaped. Nov 11: the shaper filled "cannot" with "Empty: the work is bounded. It
 * names ..." (it read the schema's "Empty when the task can be shaped" as the word to write), and every such answer parked
 * a well-formed task (11 of Hawkes Games', 7 of I Can Be AI's, 12 of Dose of Destruction's). Such text is the shaper
 * saying "nothing stops this", never a refusal.
 */
export const saysShapeable = (v: unknown) => {
  const s = String(v ?? '').trim().replace(/^["'`“”‘’*_\s]+/, '');
  if (/\b(unbounded|unclear|open[- ]ended|no measurable|cannot tell|can't tell)\b/i.test(s)) return false;
  return /^(empty|none|n\/?a|null|nothing|no reason|not applicable)\b/i.test(s)
    || /\b(can be shaped|is shapeable|(?:work|task) is bounded|is well[- ]?(?:formed|bounded|scoped)|is bounded)\b/i.test(s);
};
/** The shaper refuses the task: shapeable false (when it says), and a reason that is a reason, not "Empty: it's fine". */
export const refuses = (o: any) => o?.shapeable !== true && meaningful(o?.cannot) && !saysShapeable(o?.cannot);
const emptyAnswer = (o: any) => !o || (!refuses(o) && !['goal', 'reference', 'outcome', 'work', 'phone'].some((k) => meaningful(o[k])) && !(Array.isArray(o.criteria) && o.criteria.some(meaningful)));
/** The stored bar, completed from the request's own headings (stored fields win). */
export function effectiveBar(t: Pick<Task, 'request' | 'bar'>): Bar | null {
  const read = barOf(t.request);
  const stored = Object.fromEntries(Object.entries(t.bar ?? {}).filter(([k, v]) => k === 'gate' || (typeof v === 'string' && v.trim())));
  const out = { ...(read ?? {}), ...stored } as Bar;
  return Object.keys(out).length ? out : null;
}

function park(t: Task, reasons: string[]): GateResult {
  const why = reasons.join('; ').slice(0, 600);
  setBar(t.id, { ...(t.bar ?? {}), gate: gateOf('parked', reasons, hashOf(t)) });
  // Back to planned by J without an edit starts it (the same hash is not judged again); the undo does that.
  logDecision('task-bar park', t.id, t.product, `"${t.title}" parked as an idea by the task bar: ${why}`, { kind: 'tasks', change: null, tasks: [{ id: t.id, status: 'planned', tries: t.tries, note: t.note, checks: t.checks }] });
  updateTask(t.id, { status: 'idea', note: `parked by the task bar: ${why}`.slice(0, 500) });
  return 'parked';
}

export async function gateTask(task: Task, deps: { ask?: Ask } = {}): Promise<GateResult> {
  if (process.env.STUDIO_TASK_BAR === 'off') return 'ok';
  const t = getTask(task.id);
  // Only a task about to start for the first time; working, merged, verified and live tasks are never touched.
  if (!t || t.status !== 'planned' || t.tries > 0 || t.kind === 'video') return 'ok';
  const hash = hashOf(t);
  if (t.bar?.gate?.hash === hash) return 'ok';
  const kind = barKindOf(t.product);
  // The bar's fields come from the stored bar, else from the headings in the request itself (a task made without them
  // stored, or edited since): a request that carries the headings passes without a model call.
  const read = effectiveBar(t);
  const c = checkTask({ ...t, bar: read }, kind);
  if (c.ok) {
    if (!t.bar?.gate || t.bar.gate.verdict === 'parked') logDecision('task-bar pass', t.id, t.product, `"${t.title}" meets the task bar`);
    setBar(t.id, { ...read, gate: gateOf(t.bar?.gate?.verdict === 'rewritten' ? 'rewritten' : 'pass', [], hash) });
    return 'ok';
  }
  const reasons = reasonsOf(c);
  const words = t.request.trim().split(/\s+/).length;
  if (words < 40 && !t.criteria.length) return park(t, [...reasons, 'its request has too little to shape (under 40 words, no criteria): say what the player should see']);

  const key = `${t.id}:${hash}`;
  let out: any;
  try {
    const item = getItem(t.item);
    const prompt = `You shape a roadmap task so it meets the studio's task bar, before an agent builds it.

THE BAR
${BAR_TEXT}

${productContext(t.product)}
THE ITEM'S GOAL: ${item?.goal ?? item?.title ?? '(none)'}
KIND OF TASK: ${kind === 'infra' ? 'infra or library (fill outcome; goal, reference and phone may be empty)' : kind === 'site' ? 'site (fill goal, reference (or "none"), axis, phone, and criteria with at least one "[phone] ")' : 'game (fill goal, reference, axis, phone, and criteria with at least one "[phone] ")'}

THE TASK: ${t.title}
${t.request.slice(0, 6000)}
CURRENT CRITERIA: ${JSON.stringify(t.criteria)}
WHAT IS MISSING: ${reasons.join('; ')}

Keep the task's intent and scope: never widen it, never add features. Write the fields and 1 to 5 criteria (2 to 5 for a game
or site) that a playtest can see or measure, each with something observable or a number; reuse its own criteria where they are good.
Set "shapeable" to true and "cannot" to "" whenever the task can be shaped (almost always).
Only if the work itself is an unbounded audit or explore with no measurable end, or you cannot tell what it should deliver,
set "shapeable" to false, "cannot" to why, and leave the rest empty.`;
    const j: any = await (deps.ask ?? askOverride ?? askClaude)({ prompt, schema: SCHEMA, model: modelId('haiku'), maxTokens: 1500, purpose: 'task-bar', product: t.product, timeoutMs: 120_000 });
    if (j?.status !== 'done' || !j.result?.value) throw new Error(String(j?.error ?? j?.detail ?? 'no answer').slice(0, 200));
    out = j.result.value;
    // An answer with nothing in it (every field empty, or only a "cannot" made of quotes) is a failed call, never a verdict.
    if (emptyAnswer(out)) throw new EmptyShape('the shaper returned an empty answer');
  } catch (e: any) {
    if (e instanceof EmptyShape) {
      // Never parked for it: the task stays planned and is shaped again on the next pass that already runs.
      console.warn(`[taskbar] ${t.id}: ${e.message}; it stays planned and is checked on the next pass`);
      return 'wait';
    }
    const n = (failures.get(key) ?? 0) + 1;
    failures.set(key, n);
    if (n >= MAX_FAILS) return park(t, [`the task bar couldn't check it (${n} tries: ${String(e.message ?? e).slice(0, 120)})`]);
    console.warn(`[taskbar] ${t.id}: ${e.message ?? e} (try ${n} of ${MAX_FAILS}); it stays planned and is checked on the next pass`);
    return 'wait';
  }
  failures.delete(key);
  if (refuses(out)) return park(t, [`cannot be shaped: ${String(out.cannot).trim().slice(0, 240)}`, ...reasons]);
  const shape = Object.fromEntries(BAR_FIELDS.map((k) => [k, String(out?.[k] ?? '').trim()]));
  const criteria = (Array.isArray(out?.criteria) ? out.criteria : []).map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 8);
  const request = composeRequest(kind, { ...shape, work: String(out?.work ?? '').trim() || workLine(t.request) || t.title }, t.request);
  const again = checkTask({ request, criteria, bar: { ...shape, axis: shape.axis } }, kind);
  if (!again.ok) return park(t, [...reasons, `the rewrite still misses it: ${reasonsOf(again).join('; ')}`]);

  const before = snapshot(t);
  updateTask(t.id, { request, criteria, ...(kind === 'infra' ? { outcome: shape.outcome } : { goal: shape.goal, reference: shape.reference, axis: shape.axis, phone: shape.phone }) });
  const now = getTask(t.id)!;
  setBar(t.id, { ...(now.bar ?? {}), gate: gateOf('rewritten', reasons, hashOf(now)) });
  logDecision('task-bar rewrite', t.id, t.product, `"${t.title}" was rewritten to the task bar (${reasons.join('; ')}): ${kind === 'infra' ? `outcome "${shape.outcome}"` : `goal "${shape.goal}", axis ${shape.axis}`}, ${criteria.length} criteria. The original request is kept at its end.`, { ...before, bar: { ...(before.bar ?? {}), gate: gateOf('pass', ['undone'], hashOf(t)) } });
  return 'ok';
}

// ------------------------------------------------------------------ into beta's check

/** A scenario's criteria as plays: the "[phone]" ones on a 390x844 touch play, the others on desktop (same scenario and options). */
export function splitPlays(scenario: string | undefined, options: Record<string, unknown> | undefined, criteria: string[]) {
  const base = { ...(scenario ? { scenario } : {}), ...(options ? { options } : {}) };
  const out: { scenario?: string; options?: Record<string, unknown>; device?: 'phone'; criteria: string[] }[] = [];
  const desk = criteria.filter((k) => !PHONE.test(k));
  const phone = criteria.filter((k) => PHONE.test(k));
  if (desk.length) out.push({ ...base, criteria: desk });
  if (phone.length) out.push({ ...base, device: 'phone', criteria: phone });
  return out;
}

/** A beta run's focus with each task's player goal (or outcome), so the review knows what the player should see. */
export function focusWithGoals(focus: string, tasks: Task[]) {
  const goals = tasks.map((t) => {
    const g = t.bar?.goal ?? t.bar?.outcome;
    return g ? `"${t.title.slice(0, 80)}": ${g.slice(0, 200)}` : '';
  }).filter(Boolean).slice(0, 8);
  return goals.length ? `${focus} What each should do for the player: ${goals.join(' | ')}` : focus;
}

// ------------------------------------------------------------------ the counts

const WEEK = 7 * 24 * 3600_000;
export type TaskBarCounts = { passed: number; rewritten: number; parked: number; last7days: { passed: number; rewritten: number; parked: number }; parkedTasks: { id: string; title: string; reason: string }[] };

/** The task bar's decisions per product, from pm_log, and each product's parked tasks with their reason. */
export function taskBarCounts(productId: string, now = Date.now()): TaskBarCounts {
  const out: TaskBarCounts = { passed: 0, rewritten: 0, parked: 0, last7days: { passed: 0, rewritten: 0, parked: 0 }, parkedTasks: [] };
  const key = { 'task-bar pass': 'passed', 'task-bar rewrite': 'rewritten', 'task-bar park': 'parked' } as const;
  for (const [action, k] of Object.entries(key)) {
    for (const d of listDecisions({ since: 0, action, limit: 10_000 })) {
      if (d.product !== productId || d.undone) continue;
      out[k]++;
      if (now - d.at <= WEEK) out.last7days[k]++;
    }
  }
  return out;
}

/** Tasks the bar parked that are still ideas, with the reason it gave. */
export function parkedTasks(tasks: Task[]) {
  return tasks.filter((t) => t.status === 'idea' && t.bar?.gate?.verdict === 'parked').map((t) => ({ id: t.id, title: t.title, reason: String(t.note ?? t.bar?.gate?.reasons.join('; ') ?? '').replace(/^parked by the task bar:\s*/, '') }));
}

// ------------------------------------------------------------------ the re-check on deploy

/** A park whose "cannot be shaped" reason said nothing (empty, or only quotes): the shaper's call failed, the task was never judged. */
const EMPTY_PARK = /cannot be shaped:\s*(?:["'`“”‘’]*\s*)(?:[;.]|$)/;
/** The "cannot be shaped" reason of a park note (up to the next "; no ..." reason the gate appended). */
const parkReason = (note: string) => /cannot be shaped:\s*(.*?)(?:;\s*(?:no |the rewrite|its request)|$)/s.exec(note)?.[1] ?? '';
/** Parked on a non-answer: an empty reason, or one that says the task can be shaped ("Empty: the work is bounded..."). */
const wronglyParked = (note: string) => EMPTY_PARK.test(note) || (/cannot be shaped:/.test(note) && saysShapeable(parkReason(note)));

/**
 * Once at start-up (server.ts): every task the bar parked with an empty "cannot be shaped", or one that said the task could
 * be shaped ("Empty: the work is bounded"), is put back to planned, so the
 * gate judges it again on the next PM pass (headings in the request now count; an empty shaper answer waits instead of parking).
 * A task that now passes the pure check goes back with its pass recorded. Idempotent; returns the ids restored.
 */
export function recheckEmptyParks(): string[] {
  const rows = db.prepare(`SELECT id FROM tasks WHERE status = 'idea' AND note LIKE 'parked by the task bar:%cannot be shaped:%'`).all() as { id: string }[];
  const restored: string[] = [];
  for (const { id } of rows) {
    const t = getTask(id);
    if (!t || t.status !== 'idea' || t.bar?.gate?.verdict !== 'parked' || !wronglyParked(String(t.note ?? ''))) continue;
    const read = effectiveBar(t);
    const ok = checkTask({ ...t, bar: read }, barKindOf(t.product)).ok;
    // Passing: record the pass for this version. Otherwise drop the old verdict so the gate shapes it again.
    setBar(id, ok ? { ...read, gate: gateOf('pass', [], hashOf(t)) } : (() => { const { gate: _g, ...rest } = { ...(read ?? {}) } as Bar; return rest; })());
    updateTask(id, { status: 'planned', note: ok ? 'back to planned: it meets the task bar (re-checked after an empty shaper answer)' : 'back to planned: the task bar parked it on a shaper non-answer and checks it again' });
    logDecision('task-bar recheck', id, t.product, `"${t.title}" was parked by an empty shaper answer; back to planned${ok ? ' (it meets the bar)' : ' to be shaped again'}`);
    restored.push(id);
  }
  return restored;
}
