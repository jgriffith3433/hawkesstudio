// A queued agent change follows its roadmap task (2026-11-10: a roadmap prune dropped or rewrote about 160 tasks and left
// about 20 queued changes that would have run the old text, or worked on a task that no longer existed; they were
// cancelled by hand). A change copies its task's request and criteria when the PM queues it; until an agent has started
// on it, the task is what counts:
//   - cancelDropped: the task was dropped (or put back to idea, or marked done) in roadmap.ts updateTask: its changes that
//     are still queued and never started are cancelled at once, through the cancel path (agents.ts cancelChange: logged,
//     who and why kept, resumable), and the PM's decision log says so.
//   - refreshFromTask: the one check at the moment a queued change starts (the agents.ts queue): a task that is gone
//     cancels it as above and it doesn't start; a task rewritten since it was queued gives it the new request and criteria
//     (its brief is written from them when the agent starts), with a line on its log.
// A change an agent has started on (working, verifying, revising, or queued again to carry on: a revision, an answer, a
// harness hold, its Gen jobs, a resume) is never touched. Event-driven: both run when something happens, never on a timer.

import { db, J, parse } from './db.ts';

/** Task statuses with nothing for a not-yet-started change to do. */
export const TASK_GONE = ['dropped', 'idea', 'done'];
export const DROPPED_NOTE = 'task dropped before start';
/** What the PM adds to a task's request for another attempt (pm.ts startTaskChange): kept when the request is refreshed. */
const PM_NOTE = '\n\nFrom the PM (an earlier attempt):';

type Row = { id: string; product: string; status: string; task: string | null; request: string | null; criteria: string | null; title: string | null; session: string | null; pr: number | null; commits: string | null; phase: string | null; log: string | null };
const rowOf = (id: string) => db.prepare('SELECT id, product, status, task, request, criteria, title, session, pr, commits, phase, log FROM changes WHERE id = ?').get(id) as Row | undefined;

/** Queued and never started: no agent session, no phase (where a started pass is), no commits, no pull request. */
export function neverStarted(r: Pick<Row, 'status' | 'session' | 'pr' | 'commits' | 'phase'>) {
  return r.status === 'queued' && !r.session && !r.pr && !(parse(r.commits) ?? []).length && !parse(r.phase);
}

/** Cancels made but not finished yet: a pass that sees the change still queued doesn't cancel it twice. */
const cancelling = new Map<string, Promise<boolean>>();

async function cancelQueued(id: string, why: string): Promise<boolean> {
  const was = cancelling.get(id);
  if (was) return was;
  const p = (async () => {
    try {
      const { cancelChange } = await import('./agents.ts');
      // Read again after the await: an agent may have started on it meanwhile, and then it is left alone.
      const r = rowOf(id);
      if (!r || !neverStarted(r)) return false;
      await cancelChange(id, 'Studio', why);
      const { logDecision } = await import('./roadmap.ts');
      logDecision('cancelled', r.task ?? id, r.product, `Studio cancelled agent change ${id}: ${why}`);
      return true;
    } catch (e: any) {
      console.warn(`[queue-follow] cancelling ${id} failed: ${e?.message ?? e}`);
      return false;
    } finally {
      cancelling.delete(id);
    }
  })();
  cancelling.set(id, p);
  return p;
}

const goneWhy = (status: string | null) => (status === 'dropped' ? DROPPED_NOTE : `${DROPPED_NOTE} (its task is ${status ?? 'gone'})`);

/** A task was dropped (or put back to idea, or marked done): its changes still queued and never started are cancelled. Returns the ones cancelled. */
export async function cancelDropped(taskId: string): Promise<string[]> {
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
  if (t && !TASK_GONE.includes(t.status)) return [];
  const rows = db.prepare(`SELECT id, product, status, task, request, criteria, title, session, pr, commits, phase, log FROM changes WHERE task = ? AND status = 'queued'`).all(taskId) as Row[];
  const out: string[] = [];
  for (const r of rows.filter(neverStarted)) if (await cancelQueued(r.id, goneWhy(t?.status ?? null))) out.push(r.id);
  return out;
}

/**
 * Called once as a queued change is about to start. Returns whether it may start. A change with no task, or one an agent
 * has started on, starts as it is. A task that is gone (dropped, idea, done, deleted): the change is cancelled (DROPPED_NOTE)
 * and doesn't start. A task whose request or criteria changed since the change was queued: the change takes the new ones
 * (and the task's title), logged on the change, before its agent's brief is written from them.
 */
export function refreshFromTask(change: string | { id: string }): boolean {
  const r = rowOf(typeof change === 'string' ? change : change.id);
  if (!r || !r.task || !neverStarted(r)) return true;
  if (cancelling.has(r.id)) return false;
  const t = db.prepare('SELECT status, title, request, criteria FROM tasks WHERE id = ?').get(r.task) as { status: string; title: string; request: string; criteria: string } | undefined;
  if (!t || TASK_GONE.includes(t.status)) {
    void cancelQueued(r.id, goneWhy(t?.status ?? null));
    return false;
  }
  const cur = String(r.request ?? '');
  const at = cur.indexOf(PM_NOTE);
  const base = at >= 0 ? cur.slice(0, at) : cur;
  const request = base.trim() === t.request.trim() ? cur : `${t.request}${at >= 0 ? cur.slice(at) : ''}`;
  const criteria: string[] = parse(t.criteria) ?? [];
  const was: string[] = parse(r.criteria) ?? [];
  const sameCriteria = J(criteria) === J(was);
  if (request === cur && sameCriteria) return true;
  const what = [request !== cur ? 'request' : '', sameCriteria ? '' : 'criteria'].filter(Boolean).join(' and ');
  const log = [...(parse(r.log) ?? []), `${new Date().toISOString().slice(11, 19)} its task ${r.task} was rewritten while it was queued: it starts with the task's new ${what}`].slice(-400);
  const title = (t.title || request.split('\n')[0]).slice(0, 120);
  db.prepare('UPDATE changes SET request = ?, criteria = ?, title = ?, log = ?, updated = ? WHERE id = ?').run(request, J(criteria), title, J(log), Date.now(), r.id);
  return true;
}

/** Resolves when the cancels under way have finished (for tests and callers that need the outcome). */
export const followSettled = () => Promise.all([...cancelling.values()]).then(() => undefined);
