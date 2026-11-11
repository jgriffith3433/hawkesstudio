// A queued change that asks for work already merged (J, 2026-11-11: c_d24c7d05df35 asked for the owner cell to bypass
// plan gates, which c_cdf61c02ad2f, PR #337, had already merged into beta).
//
// Before a never-started change starts, its request is compared with the changes merged into the same product in the
// last 7 days: keyword overlap first (free), and a small model only when the overlap is high. If the model says the work
// is already there, the change is closed as "already done by <id>" before it starts, with a note in the decision log and
// an undo that queues it again. A model that can't answer never closes anything.
//
// Event-driven: it runs when the pump looks at a queued change. A change waiting for the model's answer is held out of
// that pass; the answer pumps again.
import { db, parse } from './db.ts';
import { neverStarted } from './queue-follow.ts';
import { jobModel } from './roles.ts';

export const DUP_WINDOW_MS = 7 * 24 * 3600_000;
/** Share of the smaller request's keywords found in a merged change's: from here the model is asked. */
export const DUP_OVERLAP = 0.5;
/** Fewer keywords than this in either text is too little to compare. */
const MIN_WORDS = 6;

const STOP = new Set('this that with from have will should when then them they their there what which into only also been being were does done make made need needs each every than more most such about after before while where whose your ours just like else onto over under again still never always change changes studio agent agents request task'.split(' '));
export const keywords = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9_.-]{4,}/g) ?? []).map((w) => w.replace(/^[._-]+|[._-]+$/g, '')).filter((w) => w.length >= 4 && !STOP.has(w)));

/** How much of the smaller keyword set is shared (0..1). */
export function overlap(a: string, b: string): number {
  const x = keywords(a), y = keywords(b);
  if (x.size < MIN_WORDS || y.size < MIN_WORDS) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

type Row = { id: string; product: string; task: string | null; title: string | null; request: string | null };
const text = (r: Row) => `${r.title ?? ''}\n${r.request ?? ''}`;

/** The change merged into the same product in the last 7 days that overlaps this one most, when the overlap is high. */
export function likelyDuplicate(id: string, now = Date.now()): { id: string; title: string | null; score: number } | null {
  const c = db.prepare('SELECT id, product, task, title, request FROM changes WHERE id = ?').get(id) as Row | undefined;
  if (!c) return null;
  const merged = db.prepare(`SELECT id, product, task, title, request FROM changes WHERE status = 'merged' AND product = ? AND id != ? AND merged_at >= ?`).all(c.product, id, now - DUP_WINDOW_MS) as Row[];
  let best: { id: string; title: string | null; score: number } | null = null;
  for (const m of merged) {
    if (c.task && m.task === c.task) continue; // the same task's earlier attempt is the PM's to judge (revisions), not a duplicate
    const score = overlap(text(c), text(m));
    if (score >= DUP_OVERLAP && (!best || score > best.score)) best = { id: m.id, title: m.title, score };
  }
  return best;
}

/** What the model is asked: is the queued request already done by the merged change. Tests replace it. */
export const dupHooks = {
  judge: async (queued: Row, merged: Row): Promise<boolean> => {
    const { askClaude } = await import('./llm.ts');
    const model = process.env.STUDIO_DUP_MODEL ?? jobModel('canon');
    const clip = (s: string | null) => String(s ?? '').slice(0, 2500);
    const job = await askClaude({
      prompt: `A queued change is about to start. Is the work it asks for ALREADY DONE by the change that was merged into the same branch?\n\nQUEUED (${queued.id}): ${queued.title}\n${clip(queued.request)}\n\nMERGED (${merged.id}): ${merged.title}\n${clip(merged.request)}\n\nAnswer duplicate=true only when the merged change delivers what the queued one asks for (a part or a related topic is not enough).`,
      schema: { type: 'object', properties: { duplicate: { type: 'boolean' }, reason: { type: 'string' } }, required: ['duplicate'] },
      model, effort: 'low', maxTokens: 400, timeoutMs: 2 * 60_000, purpose: 'duplicate-check', product: queued.product,
    });
    return job?.status === 'done' && job.value?.duplicate === true;
  },
  /** Closes the change (agents.ts close); tests replace it. */
  close: async (id: string, by: string) => (await import('./agents.ts')).close(id, by),
  pump: () => import('./agents.ts').then((a) => a.pumpNow()),
};

/** Verdicts by change and merged change: true = duplicate and closed, false = looked at, not a duplicate. */
const verdicts = new Map<string, boolean>();
const asking = new Set<string>();

/**
 * Called as the pump looks at a queued change. Returns false while the change should not start in this pass (a model is
 * judging it, or it is a duplicate being closed); true when it may start. Never throws.
 */
export function duplicateHold(id: string): boolean {
  try {
    const r = db.prepare('SELECT id, status, session, pr, commits, phase FROM changes WHERE id = ?').get(id) as any;
    if (!r || !neverStarted(r)) return true;
    const dup = likelyDuplicate(id);
    if (!dup) return true;
    const key = `${id}>${dup.id}`;
    const v = verdicts.get(key);
    if (v === false) return true;
    if (asking.has(key) || v === true) return false;
    asking.add(key);
    void judgeAndClose(id, dup, key);
    return false;
  } catch (e: any) {
    console.warn(`[dup-merged] ${id}: ${e?.message ?? e}`);
    return true;
  }
}

async function judgeAndClose(id: string, dup: { id: string; title: string | null; score: number }, key: string) {
  let isDup = false;
  try {
    const q = db.prepare('SELECT id, product, task, title, request FROM changes WHERE id = ?').get(id) as Row;
    const m = db.prepare('SELECT id, product, task, title, request FROM changes WHERE id = ?').get(dup.id) as Row;
    isDup = await dupHooks.judge(q, m);
    verdicts.set(key, isDup);
    if (isDup) {
      const { changeLog } = await import('./agents.ts');
      changeLog(id, `already done by ${dup.id} (merged into beta; keyword overlap ${Math.round(dup.score * 100)}%): closed before it started`);
      await dupHooks.close(id, 'Studio');
      db.prepare('UPDATE changes SET detail = ? WHERE id = ?').run(`closed: already done by ${dup.id}`, id);
      const { logDecision } = await import('./roadmap.ts');
      logDecision('duplicate-closed', id, q.product, `"${q.title ?? id}" (${id}) closed before it started: already done by ${dup.id} ("${dup.title ?? ''}"), merged into ${q.product}'s beta in the last 7 days. Undo this to queue it again.`, { kind: 'dup-closed', change: id, by: dup.id });
    }
  } catch (e: any) {
    console.warn(`[dup-merged] ${id}: ${e?.message ?? e}`);
    verdicts.set(key, false); // a model that can't answer closes nothing
  } finally {
    asking.delete(key);
    void dupHooks.pump().catch(() => {});
  }
}

/** The undo of a duplicate closure (pm.ts undoDecision, kind "dup-closed"): the change is queued again and starts as any other. */
export function reopenDuplicate(id: string, by = 'J'): string {
  const c = db.prepare('SELECT status, notes, log FROM changes WHERE id = ?').get(id) as any;
  if (!c) throw new Error(`No change ${id}`);
  if (c.status !== 'closed') return `${id} is ${c.status}, not closed`;
  for (const [k] of verdicts) if (k.startsWith(`${id}>`)) verdicts.set(k, false);
  const notes = [...(parse(c.notes) ?? []), { at: Date.now(), by, text: 'queued again after being closed as a duplicate' }];
  db.prepare(`UPDATE changes SET status = 'queued', detail = ?, notes = ?, updated = ? WHERE id = ?`).run('queued (again: it was closed as a duplicate, then undone)', JSON.stringify(notes), Date.now(), id);
  void dupHooks.pump().catch(() => {});
  return `${id} queued again`;
}
