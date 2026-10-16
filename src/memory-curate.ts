// The shared memory's first pass of curation, on Haiku (roles.ts jobModel "dedupe", through Gen's llm.json, a fraction
// of a cent): each candidate an agent or scout left is compared with the entries nearest to it. A duplicate folds into
// the entry it repeats (which counts as seen again); a note that isn't knowledge fades; a contradiction of J's
// decisions or the canon is disputed and asked of J. What's left is for the PM to confirm (memory_curate). Daily on
// the server, and on demand (POST /api/memory/curate, memory_curate auto).

import { db } from './db.ts';
import { genRun } from './gen.ts';
import { jobModel } from './roles.ts';
import { getMemory, mergeMemories, updateMemory, ftsQuery, type Memory, type Caller } from './memory.ts';

const STUDIO: Caller = { who: 'studio', name: 'Studio (curation)' };

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['id', 'action', 'of', 'why'],
        properties: {
          id: { type: 'string', description: 'The candidate (m_...)' },
          action: { type: 'string', enum: ['keep', 'duplicate', 'contradicts', 'drop'] },
          of: { type: 'string', description: 'For duplicate or contradicts: the existing entry id; else ""' },
          why: { type: 'string', description: 'One short line' },
        },
      },
    },
  },
};

const near = (c: Memory) => {
  const q = ftsQuery(`${c.title} ${c.body}`, 16);
  if (!q) return [] as Memory[];
  return (db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND m.id != ?
    AND m.status IN ('active', 'disputed', 'candidate') AND (m.product IS NULL OR m.product = ?) ORDER BY bm25(memories_fts) LIMIT 5`).all(q, c.id, c.product ?? '') as any[])
    .map((r) => getMemory(r.id)!).filter(Boolean);
};

export async function autoCurate({ limit = 20 } = {}) {
  const candidates = (db.prepare(`SELECT id FROM memories WHERE status = 'candidate' AND (note IS NULL OR note NOT LIKE 'kept by curation%') ORDER BY created LIMIT ?`).all(limit) as { id: string }[]).map((r) => getMemory(r.id)!).filter(Boolean);
  if (!candidates.length) return { looked: 0, merged: 0, faded: 0, disputed: 0, kept: 0 };
  const items = candidates.map((c) => ({ c, near: near(c) }));
  const show = (m: Memory) => `${m.id} [${m.kind}${m.status !== 'active' ? `, ${m.status}` : ''}${m.product ? `, ${m.product}` : ''}] ${m.title}${m.body ? `: ${m.body.slice(0, 300)}` : ''}`;
  const prompt = `You curate a shared memory that AI agents working on a game studio's products read before every task.
Each CANDIDATE below is a note an agent left for the next agent. For each one, decide:
- duplicate: it says the same thing as one of the EXISTING entries listed under it (give that id in "of")
- contradicts: it conflicts with one of the EXISTING entries listed under it, especially a [decision] (the owner J's
  word) or [canon] (story facts) (give that id)
- drop: it isn't durable knowledge (a status update, a one-off detail of that task, vague advice, something any agent
  would know)
- keep: a specific, true-sounding lesson or convention worth keeping
Be conservative: "keep" when unsure.

${items.map(({ c, near: n }) => `CANDIDATE ${show(c)}\nEXISTING:\n${n.length ? n.map((m) => `  - ${show(m)}`).join('\n') : '  (none close)'}`).join('\n\n')}`;
  const job = await genRun('llm.json', 'hawkesstudio', { prompt, schema: SCHEMA, model: jobModel('dedupe'), effort: 'low', maxTokens: 3000 }, undefined, 5 * 60_000);
  if (job.status !== 'done') throw new Error(`curation: ${job.error ?? job.detail ?? 'failed'}`);
  const out = { looked: candidates.length, merged: 0, faded: 0, disputed: 0, kept: 0 };
  for (const v of (job.result?.value?.verdicts ?? []) as { id: string; action: string; of: string; why: string }[]) {
    const it = items.find((x) => x.c.id === v.id);
    if (!it) continue;
    const of = it.near.find((m) => m.id === v.of) ?? null;
    try {
      if (v.action === 'duplicate' && of && of.kind === it.c.kind) {
        mergeMemories(of.id, it.c.id, STUDIO);
        out.merged++;
      } else if (v.action === 'contradicts' && of) {
        updateMemory(it.c.id, { status: 'disputed', note: `contradicts ${of.id}: ${v.why}`.slice(0, 500) }, STUDIO);
        out.disputed++;
        // J's decisions and the canon are his to keep or change.
        if (of.kind === 'decision' || of.kind === 'canon') {
          const pm: any = await import('./pm.ts');
          pm.askJ?.(`An agent's note in the shared memory contradicts ${of.kind === 'decision' ? 'one of your decisions' : 'the canon'}.\n\nYours (${of.id}): ${of.title}${of.body ? ` — ${of.body.slice(0, 300)}` : ''}\nThe note (${it.c.id}, ${it.c.by}): ${it.c.title}${it.c.body ? ` — ${it.c.body.slice(0, 300)}` : ''}\n\nWhich holds?`, { subject: it.c.id, product: it.c.product, options: ['mine holds (drop the note)', 'the note is right (update mine)'], from: 'memory curation' });
        }
      } else if (v.action === 'drop') {
        updateMemory(it.c.id, { status: 'faded', note: `faded by curation: ${v.why}`.slice(0, 500) }, STUDIO);
        out.faded++;
      } else {
        updateMemory(it.c.id, { note: `kept by curation: ${v.why}`.slice(0, 500) }, STUDIO);
        out.kept++;
      }
    } catch (e: any) {
      console.warn(`[memory] curation of ${v.id}: ${e.message}`);
    }
  }
  return out;
}
