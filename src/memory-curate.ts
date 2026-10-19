// The shared memory's first pass of curation, on Haiku (roles.ts jobModel "dedupe", through Gen's llm.json, a fraction
// of a cent): each candidate an agent or scout left is compared with the entries nearest to it. A duplicate folds into
// the entry it repeats (which counts as seen again); a note that isn't knowledge fades; a contradiction of J's
// decisions or the canon is disputed and asked of J. What's left is for the PM to confirm (memory_curate). Daily on
// the server, and on demand (POST /api/memory/curate, memory_curate auto).

import { db } from './db.ts';
import { askClaude } from './llm.ts';
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
  const job = await askClaude({ prompt, schema: SCHEMA, model: jobModel('dedupe'), effort: 'low', maxTokens: 3000, timeoutMs: 5 * 60_000, purpose: 'curation' });
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
        if (of.kind === 'decision' || of.kind === 'canon') await askContradiction(it.c, of);
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

// ------------------------------------------------- contradictions for J

/** Who wrote an entry, in J's words: "J's decision" only when it really is his; an agent by its change and pull request. */
export function authorOf(m: Pick<Memory, 'by' | 'kind' | 'source'>) {
  if (/^J\b/.test(m.by)) return `J's ${m.kind}`;
  const pr = /\/pull\/(\d+)/.exec(m.source ?? '')?.[1];
  const who = /^(agent|scout) (\S+)/.exec(m.by);
  if (who) return `${who[1]} ${who[2]}${pr ? ` (PR #${pr})` : ''}`;
  if (m.by === 'seed') return `the seed${m.source ? ` (${m.source})` : ''}`;
  return m.by;
}

const PAIR = 'memory-contradiction:';
/** The unordered pair two contradicting entries make: one question per pair, whichever side curation saw first. */
export const pairTopic = (a: string, b: string) => PAIR + [a, b].sort().join('+');

/** The pair a question asks about: its topic, or (cards filed before the topic) the two ids in curation's text. */
export function pairOf(q: { topic?: string | null; text: string; asked_by?: string | null }): [string, string] | null {
  if (q.topic?.startsWith(PAIR)) {
    const [a, b] = q.topic.slice(PAIR.length).split('+');
    return a && b ? [a, b] : null;
  }
  if (!/memory curation/.test(q.asked_by ?? '')) return null;
  const ids = [...new Set([...q.text.matchAll(/\((m_[0-9a-f]+)/g)].map((x) => x[1]))].sort();
  return ids.length === 2 ? [ids[0], ids[1]] : null;
}

const clipTitle = (s: string) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);

/** Asks J which of two contradicting entries holds, once per pair; options name the entries. Null when already asked. */
export async function askContradiction(note: Memory, of: Memory) {
  const topic = pairTopic(note.id, of.id);
  const asked = (db.prepare(`SELECT id, topic, text, asked_by FROM questions WHERE topic = ? OR (topic IS NULL AND asked_by LIKE '%memory curation%')`).all(topic) as any[])
    .some((q) => q.topic === topic || (!q.topic && pairOf(q)?.join('+') === [note.id, of.id].sort().join('+')));
  if (asked) return null;
  const line = (m: Memory) => `${authorOf(m)} (${m.id}): ${m.title}${m.body ? ` — ${m.body.slice(0, 300)}` : ''}`;
  const keep = (m: Memory, other: Memory) => `Keep: ${clipTitle(m.title)}${m.title === other.title ? ` (${m.id})` : ''}`;
  const what = of.kind === 'decision' && /^J\b/.test(of.by) ? 'one of your decisions' : of.kind === 'canon' ? 'the canon' : `a ${of.kind}`;
  const text = `Two entries in the shared memory contradict each other (${what}).\n\n${line(of)}\n${line(note)}\n\nWhich holds? The other one is dropped.`;
  const pm: any = await import('./pm.ts');
  return pm.askJ?.(text, { subject: note.id, product: note.product, options: [keep(of, note), keep(note, of)], from: 'memory curation', topic }) ?? null;
}

/**
 * Why a contradiction card has nothing left to decide, or '' when it still waits: one side was deleted (or merged
 * away) or faded, neither side is disputed any more (settled by hand), or its twin on the same pair was answered.
 */
export function contradictionSettled(q: { id: string; topic?: string | null; text: string; asked_by?: string | null }) {
  const pair = pairOf(q);
  if (!pair) return '';
  const [a, b] = pair.map((id) => getMemory(id));
  for (const [id, m] of [[pair[0], a], [pair[1], b]] as const) {
    if (!m) return `${id} was deleted`;
    if (m.status === 'faded') return `${id} faded`;
  }
  if (a!.status !== 'disputed' && b!.status !== 'disputed') return 'neither entry is disputed now';
  const key = pair.join('+');
  const twin = (db.prepare(`SELECT id, topic, text, asked_by FROM questions WHERE id != ? AND status = 'answered' AND (topic LIKE '${PAIR}%' OR asked_by LIKE '%memory curation%')`).all(q.id) as any[])
    .find((x) => pairOf(x)?.join('+') === key);
  return twin ? `the same pair was answered in ${twin.id}` : '';
}
