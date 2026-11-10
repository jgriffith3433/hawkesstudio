// A queued agent change follows its roadmap task (2026-11-10: a roadmap prune dropped or rewrote about 160 tasks and left
// about 20 queued changes holding the old text, cancelled by hand). A change copies its task's request and criteria when
// the PM queues it; until an agent has started on it, the task is what counts:
//   - refreshFromTask: the one check at the moment a queued change starts (the agents.ts queue), and again whenever its
//     task is edited (roadmap.ts updateTask: refreshTaskChanges). A task rewritten since the change was queued gives it
//     the new request and criteria (its brief is written from them when the agent starts), with a line on its log. A task
//     that is gone (dropped, back to idea, done, deleted) closes the change then and there: it never starts, and nothing
//     else has to come looking for it.
// A change an agent has started on (working, verifying, revising, or queued again to carry on: a revision, an answer, a
// harness hold, its Gen jobs, a resume) is never touched. Event-driven: it runs when something happens, never on a timer.

import { db, J, parse } from './db.ts';

/** Closes a never-started change whose task is gone (once; agents.ts close also removes its worktree). Tests replace it. */
const closing = new Set<string>();
export const followHooks = {
  close: (id: string, why: string) => import('./agents.ts').then(async (a) => {
    a.changeLog(id, `closed before it started: ${why}`);
    await a.close(id, 'Studio');
  }),
};
function closeGone(id: string, why: string) {
  if (closing.has(id)) return;
  closing.add(id);
  void Promise.resolve(followHooks.close(id, why))
    .catch((e) => console.warn(`[queue-follow] closing ${id}: ${e?.message ?? e}`))
    .finally(() => closing.delete(id));
}

/** Task statuses with nothing for a not-yet-started change to do. */
export const TASK_GONE = ['dropped', 'idea', 'done'];
/** What the PM adds to a task's request for another attempt (pm.ts startTaskChange): kept when the request is refreshed. */
const PM_NOTE = '\n\nFrom the PM (an earlier attempt):';

type Row = { id: string; status: string; task: string | null; request: string | null; criteria: string | null; detail: string | null; session: string | null; pr: number | null; commits: string | null; phase: string | null; log: string | null };
const COLS = 'id, status, task, request, criteria, detail, session, pr, commits, phase, log';
const rowOf = (id: string) => db.prepare(`SELECT ${COLS} FROM changes WHERE id = ?`).get(id) as Row | undefined;

/** Queued and never started: no agent session, no phase (where a started pass is), no commits, no pull request. */
export function neverStarted(r: Pick<Row, 'status' | 'session' | 'pr' | 'commits' | 'phase'>) {
  return r.status === 'queued' && !r.session && !r.pr && !(parse(r.commits) ?? []).length && !parse(r.phase);
}

/**
 * Called as a queued change is about to start (agents.ts pumpPass) and when its task is edited. Returns whether it may
 * start. A change with no task, or one an agent has started on, starts as it is. A task that is gone (dropped, idea,
 * done, deleted): it doesn't start, and it is closed. A task whose request or criteria changed since the change was queued: the change takes
 * the new ones (and the task's title), logged on the change, before its agent's brief is written from them.
 */
export function refreshFromTask(change: string | { id: string }): boolean {
  const r = rowOf(typeof change === 'string' ? change : change.id);
  if (!r || !r.task || !neverStarted(r)) return true;
  const t = db.prepare('SELECT status, title, request, criteria FROM tasks WHERE id = ?').get(r.task) as { status: string; title: string; request: string; criteria: string } | undefined;
  if (!t || TASK_GONE.includes(t.status)) {
    const detail = `queued: won't start, its task ${r.task} is ${t ? t.status : 'gone'}`;
    if (r.detail !== detail) db.prepare('UPDATE changes SET detail = ? WHERE id = ?').run(detail, r.id);
    closeGone(r.id, `its task ${r.task} is ${t ? t.status : 'gone'}`);
    return false;
  }
  const cur = String(r.request ?? '');
  const at = cur.indexOf(PM_NOTE);
  const base = at >= 0 ? cur.slice(0, at) : cur;
  const request = base.trim() === t.request.trim() ? cur : `${t.request}${at >= 0 ? cur.slice(at) : ''}`;
  const criteria: string[] = parse(t.criteria) ?? [];
  const sameCriteria = J(criteria) === J(parse(r.criteria) ?? []);
  if (request === cur && sameCriteria) return true;
  const what = [request !== cur ? 'request' : '', sameCriteria ? '' : 'criteria'].filter(Boolean).join(' and ');
  const log = [...(parse(r.log) ?? []), `${new Date().toISOString().slice(11, 19)} its task ${r.task} was rewritten while it was queued: it starts with the task's new ${what}`].slice(-400);
  const title = (t.title || request.split('\n')[0]).slice(0, 120);
  db.prepare('UPDATE changes SET request = ?, criteria = ?, title = ?, log = ?, updated = ? WHERE id = ?').run(request, J(criteria), title, J(log), Date.now(), r.id);
  return true;
}

/** A task was edited (roadmap.ts updateTask): its queued, never-started changes take the edit now. Returns the ones looked at. */
export function refreshTaskChanges(taskId: string): string[] {
  const rows = db.prepare(`SELECT ${COLS} FROM changes WHERE task = ? AND status = 'queued'`).all(taskId) as Row[];
  const ids = rows.filter(neverStarted).map((r) => r.id);
  for (const id of ids) refreshFromTask(id);
  return ids;
}
