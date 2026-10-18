// The canon check: content and story changes (dialogue, lore, levels, characters, names) are checked against the
// canon in the shared memory (memory.ts, kind "canon": characters, places, rules like "slimes are villagers, never
// enemies"). Reviews get the canon with the story (review.ts); an agent's content change gets this check of its diff
// (Sonnet through Hawkes Gen's llm.json, about a cent), and a contradiction fails the merge gate (acceptance.ts).
//
// It blocks only on clear contradictions (J, 2026-10-18, after five misreads in eight hours blocked Sick Of It: an
// ambiguous "his", tinted placeholder art, an empty drops list read as a drop, a feature the task asked for). The
// model is given the task's request and criteria and J's decisions (what the task asked for is never a conflict), and
// each finding must quote the canon entry and the exact added diff line, with a confidence. sortConflicts() then
// keeps as blocking only high-confidence contradictions whose quote and line check out; the rest (low or medium
// confidence, ambiguous, requested, placeholder or stand-in art, off the story path: retired or arcade levels, a line
// that isn't in the diff, an empty value) become notes on the change, which never block a merge.

import { askClaude } from './llm.ts';
import { canonLines, kindLines, markUsed } from './memory.ts';
import { jobModel } from './roles.ts';

const KINDS = ['contradiction', 'requested', 'placeholder', 'off-path', 'ambiguous'] as const;
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok', 'conflicts', 'summary'],
  properties: {
    ok: { type: 'boolean', description: 'false only when the change clearly contradicts a canon entry' },
    summary: { type: 'string' },
    conflicts: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['entry', 'quote', 'line', 'why', 'confidence', 'kind'],
        properties: {
          entry: { type: 'string', description: 'The canon entry id (m_...)' },
          quote: { type: 'string', description: "The canon entry's own words that the change contradicts, copied exactly" },
          line: { type: 'string', description: 'The exact added line of the diff (a "+" line) that contradicts it, copied exactly' },
          why: { type: 'string', description: 'Why that line contradicts that entry, in one sentence' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high: no other reading is possible' },
          kind: { type: 'string', enum: [...KINDS], description: 'contradiction: a real one; requested: the task asked for it; placeholder: stand-in or tinted art; off-path: a retired or arcade level, not the story; ambiguous: it can be read either way' },
        },
      },
    },
  },
};

export type CanonConflict = { entry: string; why: string; quote?: string; line?: string; confidence?: string; kind?: string; note?: string };
/** conflicts: what blocks the merge (ok is false when there are any); notes: what was flagged but doesn't block. */
export type CanonCheck = { ok: boolean; summary: string; conflicts: CanonConflict[]; notes?: CanonConflict[]; checked: number; skipped?: string };
export type CanonContext = { request?: string | null; criteria?: string[] };

/** Content-like files: data, docs, scenes, scripts with text. Code-only diffs skip the check. */
export const CONTENTISH = /\.(json|md|txt|ya?ml|csv|html|cs|ts|js|mjs|tsx|jsx)$/i;

const norm = (s: string) => String(s ?? '').toLowerCase().replace(/^[+-]\s*/, '').replace(/\s+/g, ' ').trim();
const wordsOf = (s: string) => new Set(norm(s).split(/[^a-z0-9']+/).filter((w) => w.length > 2));
/** Stand-in art (J's rule: placeholders and tints are not canon). */
const PLACEHOLDER = /\b(placeholders?|stand-?ins?|tint(ed)?|temp(orary)?|mock-?ups?|dummy|wip)\b/i;
/** Off the story path: retired or arcade levels. */
const OFF_PATH = /(^|[/_.-])(arcade|retired|legacy|old|unused|deprecated|sandbox|test)([/_.-]|$)/i;
/** A value that adds nothing ("drops": [] is no drop). */
const EMPTY_VALUE = /^[\s"'\w.-]*[:=]\s*(\[\s*\]|\{\s*\}|""|''|null|none)\s*,?\s*$/i;

/** The added lines of a unified diff, with their file. */
export function addedLines(diff: string) {
  const out: { file: string; text: string }[] = [];
  let file = '';
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, '').trim(); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) out.push({ file, text: l.slice(1) });
  }
  return out;
}

/**
 * Splits the model's findings into what blocks (a high-confidence contradiction that quotes a canon entry and an
 * added line actually in the diff, on the story path, not placeholder art, not an empty value) and notes (the rest,
 * each with why it doesn't block). `canon` is the canon text the model saw (its quote must come from there).
 */
export function sortConflicts(raw: any[], diff: string, canon = '') {
  const added = addedLines(diff);
  const canonText = norm(canon);
  const blocking: CanonConflict[] = [];
  const notes: CanonConflict[] = [];
  for (const c of (Array.isArray(raw) ? raw : []).slice(0, 10)) {
    const k: CanonConflict = {
      entry: String(c?.entry ?? ''), why: String(c?.why ?? '').slice(0, 500), quote: String(c?.quote ?? '').slice(0, 300),
      line: String(c?.line ?? '').slice(0, 300), confidence: String(c?.confidence ?? 'low'), kind: String(c?.kind ?? 'ambiguous'),
    };
    const line = norm(k.line!);
    const hit = line.length >= 3 ? added.find((a) => { const t = norm(a.text); return t === line || (line.length >= 12 && (t.includes(line) || (t.length >= 12 && line.includes(t)))); }) : undefined;
    const q = norm(k.quote!);
    const qw = wordsOf(k.quote!);
    const quoted = q.length >= 8 && (!canonText || canonText.includes(q) || (qw.size > 0 && [...qw].filter((w) => canonText.includes(w)).length / qw.size >= 0.6));
    const why =
      k.kind !== 'contradiction' ? (k.kind === 'requested' ? 'the task asked for it' : k.kind === 'placeholder' ? 'placeholder or stand-in art' : k.kind === 'off-path' ? 'off the story path' : 'it can be read either way')
      : k.confidence !== 'high' ? `${k.confidence} confidence`
      : !/^m_[0-9a-f]{12}$/.test(k.entry) ? 'no canon entry named'
      : !quoted ? "the canon entry isn't quoted"
      : !hit ? "the quoted line isn't one the change added"
      : PLACEHOLDER.test(`${hit.file} ${hit.text}`) ? 'placeholder or stand-in art'
      : OFF_PATH.test(hit.file) ? `off the story path (${hit.file})`
      : EMPTY_VALUE.test(hit.text) ? 'an empty value adds nothing'
      : null;
    if (why) notes.push({ ...k, note: why });
    else blocking.push(k);
  }
  return { blocking, notes };
}

/** The question the model is asked (exported for tests). */
export function canonPrompt(canon: string, diff: string, what: string, ctx: CanonContext = {}, decisions = '') {
  const asked = [ctx.request?.trim() ? `REQUEST:\n${ctx.request.trim().slice(0, 4000)}` : '', ctx.criteria?.length ? `ACCEPTANCE CRITERIA:\n${ctx.criteria.map((k) => `- ${k}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
  return `You check changes to a game against its CANON (story and IP facts that must hold across every Hawkes product).
Report a conflict only when an added line of the change clearly contradicts a canon entry (a character acting against
a stated rule, a renamed character, a wrong place or relationship, an enemy that canon says is never an enemy).
These are NOT contradictions, never report them as kind "contradiction":
- anything the task below asked for, or J's decisions allow (kind "requested");
- placeholder, stand-in or tinted art, temporary assets (kind "placeholder");
- retired or arcade levels and anything else off the story path (kind "off-path");
- a line that can be read either way, like an ambiguous pronoun (kind "ambiguous");
- empty values (an empty list adds nothing), new content canon doesn't cover, code without story meaning (don't report).
For each conflict copy the canon entry's words exactly (quote), copy the exact "+" line of the diff (line), and say how
sure you are: "high" only when no other reading is possible. When in doubt, report nothing.

CANON:
${canon}
${decisions ? `\nJ'S DECISIONS (they stand: what they allow is not a conflict):\n${decisions}\n` : ''}${asked ? `\nWHAT THE TASK ASKED FOR (never a conflict):\n${asked}\n` : ''}
THE CHANGE (${what}), as a unified diff (trimmed):
${diff.slice(0, 40_000)}`;
}

export async function canonCheck(product: string, diff: string, what: string, ctx: CanonContext = {}): Promise<CanonCheck> {
  const canon = canonLines(product, 8000);
  if (!canon.text) return { ok: true, summary: 'no canon recorded for this product yet', conflicts: [], checked: 0, skipped: 'no canon' };
  if (!diff.trim()) return { ok: true, summary: 'nothing to check', conflicts: [], checked: 0, skipped: 'empty diff' };
  const prompt = canonPrompt(canon.text, diff, what, ctx, kindLines(product, 'decision', 3000).text);
  const job = await askClaude({ prompt, schema: SCHEMA, model: process.env.STUDIO_CANON_MODEL ?? jobModel('canon'), effort: 'low', maxTokens: 3000, timeoutMs: 5 * 60_000, purpose: 'canon', product });
  if (job.status !== 'done') return { ok: true, summary: `couldn't check: ${String(job.error ?? job.detail ?? 'failed').slice(0, 200)}`, conflicts: [], checked: canon.ids.length, skipped: 'error' };
  const v = job.result?.value ?? {};
  const { blocking, notes } = sortConflicts(v.conflicts, diff, canon.text);
  markUsed([...blocking, ...notes].map((c) => c.entry).filter((x) => /^m_[0-9a-f]{12}$/.test(x)));
  return { ok: !blocking.length, summary: String(v.summary ?? '').slice(0, 600), conflicts: blocking, notes, checked: canon.ids.length };
}
