// The canon check: content and story changes (dialogue, lore, levels, characters, names) are checked against the
// canon in the shared memory (memory.ts, kind "canon": characters, places, rules like "slimes are villagers, never
// enemies"). Reviews get the canon with the story (review.ts); an agent's content change gets this check of its diff
// (Sonnet through Hawkes Gen's llm.json, about a cent), and a contradiction fails the merge gate (acceptance.ts).

import { genRun } from './gen.ts';
import { canonLines, markUsed } from './memory.ts';
import { jobModel } from './roles.ts';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok', 'conflicts', 'summary'],
  properties: {
    ok: { type: 'boolean', description: 'false when the change contradicts a canon entry' },
    summary: { type: 'string' },
    conflicts: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['entry', 'why'],
        properties: { entry: { type: 'string', description: 'The canon entry id (m_...)' }, why: { type: 'string', description: 'What in the change contradicts it (quote the line)' } },
      },
    },
  },
};

export type CanonCheck = { ok: boolean; summary: string; conflicts: { entry: string; why: string }[]; checked: number; skipped?: string };

/** Content-like files: data, docs, scenes, scripts with text. Code-only diffs skip the check. */
export const CONTENTISH = /\.(json|md|txt|ya?ml|csv|html|cs|ts|js|mjs|tsx|jsx)$/i;

export async function canonCheck(product: string, diff: string, what: string): Promise<CanonCheck> {
  const canon = canonLines(product, 8000);
  if (!canon.text) return { ok: true, summary: 'no canon recorded for this product yet', conflicts: [], checked: 0, skipped: 'no canon' };
  if (!diff.trim()) return { ok: true, summary: 'nothing to check', conflicts: [], checked: 0, skipped: 'empty diff' };
  const prompt = `You check changes to a game against its CANON (story and IP facts that must hold across every Hawkes product).
Report a conflict only when the change clearly contradicts a canon entry (a character acting against a stated rule, a
renamed character, a wrong place or relationship, an enemy that canon says is never an enemy). New content that canon
doesn't cover is fine. Code changes without story meaning are fine.

CANON:
${canon.text}

THE CHANGE (${what}), as a unified diff (trimmed):
${diff.slice(0, 40_000)}`;
  const job = await genRun('llm.json', 'hawkesstudio', { prompt, schema: SCHEMA, model: process.env.STUDIO_CANON_MODEL ?? jobModel('canon'), effort: 'low', maxTokens: 2000 }, undefined, 5 * 60_000);
  if (job.status !== 'done') return { ok: true, summary: `couldn't check: ${String(job.error ?? job.detail ?? 'failed').slice(0, 200)}`, conflicts: [], checked: canon.ids.length, skipped: 'error' };
  const v = job.result?.value ?? {};
  const conflicts = (Array.isArray(v.conflicts) ? v.conflicts : []).slice(0, 10).map((c: any) => ({ entry: String(c.entry ?? ''), why: String(c.why ?? '').slice(0, 500) }));
  markUsed(conflicts.map((c: any) => c.entry).filter((x: string) => /^m_[0-9a-f]{12}$/.test(x)));
  return { ok: v.ok !== false && !conflicts.length, summary: String(v.summary ?? '').slice(0, 600), conflicts, checked: canon.ids.length };
}
