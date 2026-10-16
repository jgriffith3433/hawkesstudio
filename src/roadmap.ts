// The roadmap: what J wants built, per product, as items (a goal with acceptance criteria) and the tasks under them
// (one agent change each). Talk plans it with J (studio_roadmap), the PM loop (pm.ts) works it with the agents, and a
// task is done only when its acceptance criteria pass on beta.
//
//   item  status: idea -> planned -> in progress -> on beta (every task verified on beta) -> live -> done | dropped
//   task  status: idea | planned (starts by itself when its item is planned and what it depends on is on beta)
//                 -> working (an agent change) -> review (the change is ready: the PM checks it against the criteria)
//                 -> merged (into beta; beta's playtest checks the criteria) -> verified (they pass on beta) -> live
//                 | failed (3 tries, then J is asked) | dropped
//
// Also here, because every part of the loop uses them: comment threads (on findings, items, tasks and changes; J, Talk
// and agents write them, agents read them), questions (an agent's question pausing its change, or a decision only J
// can make) and the PM decision log (every merge, won't-fix, start and answer Talk made, with undo where possible).

import { db, newId, J, parse } from './db.ts';
import { loadProducts, isInfra, StudioError } from './config.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, title TEXT NOT NULL, goal TEXT, why TEXT, criteria TEXT NOT NULL DEFAULT '[]',
    size TEXT, status TEXT NOT NULL DEFAULT 'idea', ord REAL NOT NULL DEFAULT 0, origin TEXT, note TEXT, by TEXT,
    created INTEGER NOT NULL, updated INTEGER
  );
  CREATE INDEX IF NOT EXISTS items_product ON items(product, status);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, item TEXT NOT NULL, product TEXT NOT NULL, title TEXT NOT NULL, request TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT '[]', depends TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'planned',
    ord REAL NOT NULL DEFAULT 0, change TEXT, changes TEXT NOT NULL DEFAULT '[]', pr TEXT, tries INTEGER NOT NULL DEFAULT 0,
    checks TEXT, try TEXT, note TEXT, merged_at INTEGER, verified_at INTEGER, live_at INTEGER, created INTEGER NOT NULL, updated INTEGER
  );
  CREATE INDEX IF NOT EXISTS tasks_item ON tasks(item);
  CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, by TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'comment', text TEXT NOT NULL, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_subject ON comments(subject, at);
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT, product TEXT, text TEXT NOT NULL, options TEXT, status TEXT NOT NULL DEFAULT 'open',
    answer TEXT, answered_by TEXT, origin TEXT, at INTEGER NOT NULL, answered_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS pm_log (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, subject TEXT, product TEXT, detail TEXT, undo TEXT, undone INTEGER
  );
  CREATE INDEX IF NOT EXISTS pm_log_at ON pm_log(at);
  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY, product TEXT, title TEXT NOT NULL, goal TEXT, test TEXT, status TEXT NOT NULL DEFAULT 'open',
    ord REAL NOT NULL DEFAULT 0, origin TEXT, by TEXT, reached_at INTEGER, created INTEGER NOT NULL, updated INTEGER
  );
`);
// Findings can belong to a roadmap item; the PM loop marks the runs it has seen. (Changes get their task columns in agents.ts.)
// J's reports from the beta sites (bugreport.ts) are findings with source 'J', the milestone he was testing and the report.
for (const [table, col] of [['runs', 'pm_seen'], ['findings', 'item'], ['items', 'milestone'], ['findings', 'source'], ['findings', 'milestone'], ['findings', 'report'], ['tasks', 'gpu']]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
}

export const ITEM_STATUSES = ['idea', 'planned', 'in progress', 'on beta', 'live', 'done', 'dropped'];
export const TASK_STATUSES = ['idea', 'planned', 'working', 'needs answer', 'review', 'merged', 'verified', 'live', 'failed', 'dropped'];
export const SIZES = ['S', 'M', 'L'];

export type Check = { criterion: string; met: 'yes' | 'no' | 'unclear'; evidence?: string };
export type Task = {
  id: string; item: string; product: string; title: string; request: string; criteria: string[]; depends: string[]; status: string;
  ord: number; change: string | null; changes: string[]; pr: string | null; tries: number;
  /** The latest acceptance results: where they were judged (the change's verification, or beta), per criterion. */
  checks: { where: 'change' | 'beta'; at: number; run?: string; change?: string; video?: string | null; verdict?: string; results: Check[] } | null;
  /** How J can try it (the agent's words). */
  try: string | null; note: string | null; merged_at: number | null; verified_at: number | null; live_at: number | null; created: number; updated: number | null;
  /**
   * Content tasks that generate on the GPU: what they will make (Hawkes Gen estimate items), the estimate, and the
   * budget J approved. A task whose estimate costs money waits until J approves a budget that covers it.
   */
  gpu: TaskGpu | null;
};
export type TaskGpu = { items?: any[]; estimate?: { gpuHours: number; cost: number; withIdleTail: number; servers: number; wallMinutes: number; at: number; error?: string }; budget?: number | null; approvedBy?: string | null; approvedAt?: number | null };
export type Item = {
  id: string; product: string; title: string; goal: string | null; why: string | null; criteria: string[]; size: string | null; status: string;
  ord: number; origin: string | null; note: string | null; by: string | null; milestone?: string | null; created: number; updated: number | null; tasks?: Task[];
};

const toItem = (r: any): Item => ({ ...r, criteria: parse(r.criteria) ?? [] });
const toTask = (r: any): Task => ({ ...r, criteria: parse(r.criteria) ?? [], depends: parse(r.depends) ?? [], changes: parse(r.changes) ?? [], checks: parse(r.checks), gpu: parse(r.gpu) ?? null });
const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split('\n') : []).map((s) => String(s).replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(Boolean).slice(0, 20);
const productId = (id: string) => {
  const p = loadProducts().find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
  if (p) return p.id;
  if (isInfra(id)) return id;
  throw new StudioError(`No product "${id}". Products: ${loadProducts().map((x) => x.id).join(', ')}`, 404);
};

export const getItem = (id: string) => {
  const r = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return r ? { ...toItem(r), tasks: tasksOf(id) } : null;
};
export const getTask = (id: string) => {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return r ? toTask(r) : null;
};
export const tasksOf = (item: string) => (db.prepare('SELECT * FROM tasks WHERE item = ? ORDER BY ord, created').all(item) as any[]).map(toTask);
export const taskOfChange = (change: string) => {
  const r = db.prepare(`SELECT * FROM tasks WHERE change = ? OR changes LIKE ?`).get(change, `%"${change}"%`);
  return r ? toTask(r) : null;
};

/** The roadmap, in order: items (with their tasks) per product. status: a comma list; default everything but dropped. */
export function listItems(q: { product?: string; status?: string } = {}) {
  const where: string[] = [];
  const args: any[] = [];
  if (q.product) { where.push('product = ?'); args.push(productId(q.product)); }
  const st = q.status ? q.status.split(',').map((s) => s.trim()) : ITEM_STATUSES.filter((s) => s !== 'dropped');
  where.push(`status IN (${st.map(() => '?').join(',')})`);
  args.push(...st);
  return (db.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY product, ord, created`).all(...args) as any[]).map((r) => ({ ...toItem(r), tasks: tasksOf(r.id) }));
}

const nextOrd = (table: 'items' | 'tasks', key: string, value: string) => ((db.prepare(`SELECT MAX(ord) AS m FROM ${table} WHERE ${key} = ?`).get(value) as any)?.m ?? 0) + 1;

export function addItem(a: { product: string; title: string; goal?: string; why?: string; criteria?: unknown; size?: string; status?: string; origin?: string | null; by?: string; ord?: number; milestone?: string | null }) {
  if (!a.title?.trim()) throw new StudioError('An item needs a title');
  const product = productId(a.product);
  const status = a.status ?? 'idea';
  if (!ITEM_STATUSES.includes(status)) throw new StudioError(`status must be one of ${ITEM_STATUSES.join(', ')}`);
  if (a.size && !SIZES.includes(a.size)) throw new StudioError('size must be S, M or L');
  const id = newId('i');
  db.prepare('INSERT INTO items (id, product, title, goal, why, criteria, size, status, ord, origin, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, product, a.title.trim().slice(0, 200), a.goal ?? null, a.why ?? null, J(list(a.criteria)), a.size ?? null, status, a.ord ?? nextOrd('items', 'product', product), a.origin ?? null, a.by ?? 'J', Date.now());
  if (a.milestone) setItemMilestone(id, a.milestone);
  return getItem(id)!;
}

export function updateItem(id: string, patch: Partial<{ title: string; goal: string; why: string; criteria: unknown; size: string; status: string; ord: number; note: string; origin: string; milestone: string | null }>) {
  const cur = getItem(id);
  if (!cur) throw new StudioError(`No item ${id}`, 404);
  // in progress, on beta and live follow the tasks (syncItem).
  if (patch.status && !['idea', 'planned', 'done', 'dropped'].includes(patch.status)) throw new StudioError(`An item's status follows its tasks; by hand it can be idea, planned, done or dropped`);
  if (patch.size && !SIZES.includes(patch.size)) throw new StudioError('size must be S, M or L');
  const n = { ...cur, ...patch, criteria: patch.criteria !== undefined ? list(patch.criteria) : cur.criteria };
  db.prepare('UPDATE items SET title = ?, goal = ?, why = ?, criteria = ?, size = ?, status = ?, ord = ?, note = ?, origin = ?, updated = ? WHERE id = ?')
    .run(n.title, n.goal, n.why, J(n.criteria), n.size, n.status, n.ord, n.note, n.origin, Date.now(), id);
  if (patch.milestone !== undefined) setItemMilestone(id, patch.milestone);
  // Dropping an item drops the tasks not started yet.
  if (patch.status === 'dropped') db.prepare(`UPDATE tasks SET status = 'dropped', updated = ? WHERE item = ? AND status IN ('idea', 'planned')`).run(Date.now(), id);
  return getItem(id)!;
}

export function addTask(a: { item: string; title?: string; request: string; criteria?: unknown; depends?: unknown; status?: string; ord?: number; gpu?: unknown }) {
  const item = getItem(a.item);
  if (!item) throw new StudioError(`No item ${a.item}`, 404);
  if (!a.request?.trim()) throw new StudioError('A task needs a request (what the agent should do)');
  const status = a.status ?? 'planned';
  if (!['idea', 'planned'].includes(status)) throw new StudioError('A new task is idea or planned');
  const depends = list(a.depends);
  for (const d of depends) if (!getTask(d)) throw new StudioError(`depends: no task ${d}`);
  const id = newId('k');
  db.prepare('INSERT INTO tasks (id, item, product, title, request, criteria, depends, status, ord, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.id, item.product, (a.title ?? a.request.split('\n')[0]).trim().slice(0, 160), a.request.trim(), J(list(a.criteria)), J(depends), status, a.ord ?? nextOrd('tasks', 'item', item.id), Date.now());
  const gpu = gpuItems(a.gpu);
  if (gpu) db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(J({ items: gpu }), id);
  return getTask(id)!;
}

/** Fields Talk and J may set. Status changes the loop makes (working, review, merged, ...) go through setTask. */
export function updateTask(id: string, patch: Partial<{ title: string; request: string; criteria: unknown; depends: unknown; status: string; ord: number; note: string; gpu: unknown }>) {
  const cur = getTask(id);
  if (!cur) throw new StudioError(`No task ${id}`, 404);
  // working, review, merged, verified and live come from the agents and the checks, never by hand.
  if (patch.status && !['idea', 'planned', 'dropped'].includes(patch.status)) throw new StudioError(`A task's status is set by its work and its checks; by hand it can be idea, planned (start or retry) or dropped`);
  // Back to planned (to try again from scratch) resets the tries and the change.
  const fresh = patch.status === 'planned' && !['idea', 'planned'].includes(cur.status);
  // New GPU items: estimated again by the caller (estimateTask); an approval stays only while it covers the estimate.
  if (patch.gpu !== undefined) {
    const items = gpuItems(patch.gpu);
    db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(items ? J({ ...(cur.gpu ?? {}), items, estimate: undefined }) : null, id);
    delete patch.gpu;
  }
  return setTask(id, {
    ...patch, criteria: patch.criteria !== undefined ? list(patch.criteria) : undefined, depends: patch.depends !== undefined ? list(patch.depends) : undefined,
    ...(fresh ? { tries: 0, change: null, checks: null } : {}),
  });
}

/** Sets task fields (the loop's own updates too) and keeps its item's status current. */
export function setTask(id: string, patch: Record<string, any>) {
  const cur = getTask(id);
  if (!cur) throw new StudioError(`No task ${id}`, 404);
  const n: any = { ...cur };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) n[k] = v;
  db.prepare(`UPDATE tasks SET title = ?, request = ?, criteria = ?, depends = ?, status = ?, ord = ?, change = ?, changes = ?, pr = ?, tries = ?, checks = ?, try = ?, note = ?,
    merged_at = ?, verified_at = ?, live_at = ?, updated = ? WHERE id = ?`)
    .run(n.title, n.request, J(n.criteria), J(n.depends), n.status, n.ord, n.change, J(n.changes), n.pr, n.tries, n.checks ? J(n.checks) : null, n.try, n.note,
      n.merged_at, n.verified_at, n.live_at, Date.now(), id);
  syncItem(cur.item);
  return getTask(id)!;
}

/**
 * An item's status follows its tasks once work started: in progress while any task is underway, on beta when every
 * task is verified on beta (or live), live when all are live. idea, planned, done and dropped are J's (and Talk's).
 */
export function syncItem(id: string) {
  const it = getItem(id);
  if (!it || ['idea', 'done', 'dropped'].includes(it.status)) return it;
  const tasks = (it.tasks ?? []).filter((t) => t.status !== 'dropped' && t.status !== 'idea');
  if (!tasks.length) return it;
  const all = (...s: string[]) => tasks.every((t) => s.includes(t.status));
  const status = all('live') ? 'live' : all('verified', 'live') ? 'on beta' : tasks.some((t) => t.status !== 'planned') ? 'in progress' : it.status;
  if (status !== it.status) db.prepare('UPDATE items SET status = ?, updated = ? WHERE id = ?').run(status, Date.now(), id);
  return getItem(id);
}

/** Tasks that may start now, in roadmap order: planned, in a planned or in-progress item, with what they depend on merged. */
export function startableTasks() {
  const rows = (db.prepare(`SELECT t.* FROM tasks t JOIN items i ON i.id = t.item WHERE t.status = 'planned' AND i.status IN ('planned', 'in progress')
    ORDER BY i.ord, i.created, t.ord, t.created`).all() as any[]).map(toTask);
  const done = (d: string) => ['merged', 'verified', 'live'].includes(getTask(d)?.status ?? '');
  return rows.filter((t) => t.depends.every(done) && gpuCleared(t));
}

// ------------------------------------------------------------- GPU budgets

/** The estimate items a task will generate ([{ tool | preset, params, count, label }]), or null for none. */
function gpuItems(v: unknown): any[] | null {
  let raw: any = v;
  if (typeof v === 'string') {
    try {
      raw = JSON.parse(v);
    } catch {
      raw = null;
    }
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
  if (!items?.length) return null;
  for (const it of items) if (!it || typeof it !== 'object' || (!it.tool && !it.preset)) throw new StudioError('gpu: a list of { tool | preset, params, count, label } (Hawkes Gen estimate items)');
  return items.slice(0, 40);
}

/** A task can start when it generates nothing on the GPU, or J approved a budget that covers its estimate. */
export function gpuCleared(t: Task) {
  const g = t.gpu;
  if (!g?.items?.length) return true;
  if (!g.estimate || g.estimate.error) return false;
  if (g.estimate.cost <= 0) return true;
  return typeof g.budget === 'number' && g.budget >= g.estimate.cost;
}

/** Prices a task's GPU items through Hawkes Gen (its job history) and keeps the estimate on the task. */
export async function estimateTask(id: string) {
  const t = getTask(id);
  if (!t?.gpu?.items?.length) return t;
  const { gen } = await import('./gen.ts');
  let estimate: NonNullable<TaskGpu['estimate']>;
  try {
    const e = await gen.estimate(t.gpu.items, { project: t.product });
    estimate = { gpuHours: e.gpu.hours, cost: e.cost.total, withIdleTail: e.cost.withIdleTail, servers: e.gpu.servers, wallMinutes: e.wallMinutes, at: Date.now() };
  } catch (err: any) {
    estimate = { gpuHours: 0, cost: 0, withIdleTail: 0, servers: 0, wallMinutes: 0, at: Date.now(), error: String(err.message ?? err).slice(0, 300) };
  }
  // A budget J approved stays while it still covers the estimate.
  const keep = typeof t.gpu.budget === 'number' && t.gpu.budget >= estimate.cost;
  db.prepare('UPDATE tasks SET gpu = ?, updated = ? WHERE id = ?')
    .run(J({ ...t.gpu, estimate, ...(keep ? {} : { budget: null, approvedBy: null, approvedAt: null }) }), Date.now(), id);
  return getTask(id);
}

/** J's approval of a GPU budget for a task (dollars). Only on J's own word. */
export function approveGpu(id: string, budget: number, by: string) {
  const t = getTask(id);
  if (!t) throw new StudioError(`No task ${id}`, 404);
  if (!(budget >= 0)) throw new StudioError('budget: dollars, 0 or more');
  db.prepare('UPDATE tasks SET gpu = ?, updated = ? WHERE id = ?').run(J({ ...(t.gpu ?? {}), budget, approvedBy: by, approvedAt: Date.now() }), Date.now(), id);
  return getTask(id)!;
}

/** Planned tasks waiting only on J's GPU approval (the PM asks him once each). */
export function tasksAwaitingGpu() {
  return (db.prepare(`SELECT t.* FROM tasks t JOIN items i ON i.id = t.item WHERE t.status = 'planned' AND t.gpu IS NOT NULL AND i.status IN ('planned', 'in progress')`).all() as any[])
    .map(toTask).filter((t) => t.gpu?.items?.length && !gpuCleared(t));
}

// -------------------------------------------------------------- milestones

/**
 * A milestone: a named point J will playtest himself (e.g. "DoD: controls done"), made of roadmap items. status: open
 * -> reached (every item in it is on beta, its checks passed: pm.ts tells J on his phone and in Talk) -> live (J went
 * live with it) | dropped.
 */
export type Milestone = { id: string; product: string | null; title: string; goal: string | null; test: string | null; status: string; ord: number; origin: string | null; by: string | null; reached_at: number | null; created: number; updated: number | null };
export const MILESTONE_STATUSES = ['open', 'reached', 'live', 'dropped'];
export const getMilestone = (id: string) => (db.prepare('SELECT * FROM milestones WHERE id = ?').get(id) as Milestone | undefined) ?? null;
export function listMilestones(q: { product?: string; status?: string } = {}) {
  const st = (q.status ?? 'open,reached,live').split(',').map((x) => x.trim());
  const rows = db.prepare(`SELECT * FROM milestones WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY ord, created`).all(...st) as Milestone[];
  const pid = q.product ? productId(q.product) : null;
  return rows.filter((m) => !pid || m.product === pid || m.product === null).map((m) => ({ ...m, ...milestoneProgress(m.id) }));
}
/** Its items and how far along they are (items on beta, live or done count as there). */
export function milestoneProgress(id: string) {
  const items = (db.prepare(`SELECT * FROM items WHERE milestone = ? AND status != 'dropped' ORDER BY ord, created`).all(id) as any[]).map(toItem);
  const done = items.filter((i) => ['on beta', 'live', 'done'].includes(i.status));
  return { items: items.map((i) => ({ id: i.id, title: i.title, product: i.product, status: i.status })), done: done.length, total: items.length };
}
export function addMilestone(a: { product?: string | null; title: string; goal?: string; test?: string; items?: unknown; origin?: string | null; by?: string; ord?: number }) {
  if (!a.title?.trim()) throw new StudioError('A milestone needs a title');
  const product = a.product ? productId(a.product) : null;
  const id = newId('n');
  const ord = a.ord ?? (((db.prepare('SELECT MAX(ord) AS m FROM milestones').get() as any)?.m ?? 0) + 1);
  db.prepare('INSERT INTO milestones (id, product, title, goal, test, status, ord, origin, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, product, a.title.trim().slice(0, 200), a.goal ?? null, a.test ?? null, 'open', ord, a.origin ?? null, a.by ?? 'J', Date.now());
  for (const it of list(a.items)) setItemMilestone(it, id);
  return { ...getMilestone(id)!, ...milestoneProgress(id) };
}
export function updateMilestone(id: string, patch: Partial<{ title: string; goal: string; test: string; status: string; ord: number; items: unknown }>) {
  const cur = getMilestone(id);
  if (!cur) throw new StudioError(`No milestone ${id}`, 404);
  // reached comes from its items' checks; by hand a milestone is open, live (J went live with it) or dropped.
  if (patch.status && !['open', 'live', 'dropped'].includes(patch.status)) throw new StudioError('A milestone is reached when its items pass on beta; by hand it can be open, live or dropped');
  const n = { ...cur, ...patch };
  db.prepare('UPDATE milestones SET title = ?, goal = ?, test = ?, status = ?, ord = ?, reached_at = ?, updated = ? WHERE id = ?')
    .run(n.title, n.goal, n.test, n.status, n.ord, patch.status === 'open' ? null : n.reached_at, Date.now(), id);
  if (patch.items !== undefined) {
    db.prepare('UPDATE items SET milestone = NULL WHERE milestone = ?').run(id);
    for (const it of list(patch.items)) setItemMilestone(it, id);
  }
  return { ...getMilestone(id)!, ...milestoneProgress(id) };
}
function setItemMilestone(item: string, milestone: string | null) {
  if (milestone && !getMilestone(milestone)) throw new StudioError(`No milestone ${milestone}`);
  if (!db.prepare('SELECT id FROM items WHERE id = ?').get(item)) throw new StudioError(`No item ${item}`);
  db.prepare('UPDATE items SET milestone = ?, updated = ? WHERE id = ?').run(milestone || null, Date.now(), item);
}
/** Open milestones whose items (at least one) are all on beta: reached now. */
export function milestonesToReach() {
  return (db.prepare(`SELECT * FROM milestones WHERE status = 'open'`).all() as Milestone[]).filter((m) => {
    const p = milestoneProgress(m.id);
    return p.total > 0 && p.done === p.total;
  });
}
export const markReached = (id: string) => db.prepare(`UPDATE milestones SET status = 'reached', reached_at = ?, updated = ? WHERE id = ?`).run(Date.now(), Date.now(), id);

// ---------------------------------------------------------------- comments

export type Comment = { id: string; subject: string; by: string; kind: string; text: string; at: number };
const SUBJECT = /^(f|i|k|c|n)_[0-9a-f]+$/;

export function addComment(subject: string, text: string, by = 'J', kind = 'comment') {
  if (!SUBJECT.test(subject)) throw new StudioError('subject: a finding (f_), item (i_), task (k_) or change (c_) id');
  if (!String(text ?? '').trim()) throw new StudioError('Say something');
  const id = newId('m');
  db.prepare('INSERT INTO comments (id, subject, by, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, subject, String(by).slice(0, 60), kind, String(text).trim().slice(0, 8000), Date.now());
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Comment;
}
export const commentsOn = (...subjects: (string | null | undefined)[]) => {
  const s = subjects.filter(Boolean) as string[];
  if (!s.length) return [] as Comment[];
  return db.prepare(`SELECT * FROM comments WHERE subject IN (${s.map(() => '?').join(',')}) ORDER BY at`).all(...s) as Comment[];
};

/** Everything said about a change's work, for its agent: its task, the task's item, the change itself and its findings. */
export function threadFor(change: { id: string; findings?: string[]; task?: string | null }) {
  const t = change.task ? getTask(change.task) : null;
  return commentsOn(t?.item, t?.id, change.id, ...(change.findings ?? []));
}

// --------------------------------------------------------------- questions

export type Question = {
  id: string; kind: 'agent' | 'decision'; subject: string | null; product: string | null; text: string; options: string[]; status: string;
  answer: string | null; answered_by: string | null; origin: string | null; at: number; answered_at: number | null;
};
const toQuestion = (r: any): Question => ({ ...r, options: parse(r.options) ?? [] });
export const getQuestion = (id: string) => {
  const r = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return r ? toQuestion(r) : null;
};
/**
 * kind agent: an agent asked (its change waits, "needs answer"); Talk answers from what J decided, or asks J
 * (status "asked J"). kind decision: only J can decide (direction, money, something failing after 3 tries, live).
 */
export function addQuestion(a: { kind: 'agent' | 'decision'; subject?: string | null; product?: string | null; text: string; options?: unknown; origin?: string | null }) {
  // The same open question isn't asked twice.
  const dup = db.prepare(`SELECT id FROM questions WHERE status IN ('open', 'asked J') AND kind = ? AND COALESCE(subject, '') = ? AND text = ?`).get(a.kind, a.subject ?? '', a.text) as any;
  if (dup) return getQuestion(dup.id)!;
  const id = newId('q');
  db.prepare('INSERT INTO questions (id, kind, subject, product, text, options, status, origin, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, a.kind, a.subject ?? null, a.product ?? null, a.text.trim().slice(0, 4000), J(list(a.options)), 'open', a.origin ?? null, Date.now());
  return getQuestion(id)!;
}
export function listQuestions(status = 'open,asked J') {
  const st = status.split(',').map((s) => s.trim());
  return (db.prepare(`SELECT * FROM questions WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY at`).all(...st) as any[]).map(toQuestion);
}
export function setQuestion(id: string, patch: Partial<{ status: string; answer: string; answered_by: string }>) {
  const q = getQuestion(id);
  if (!q) throw new StudioError(`No question ${id}`, 404);
  const n = { ...q, ...patch };
  db.prepare('UPDATE questions SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
    .run(n.status, n.answer, n.answered_by, patch.answer ? Date.now() : q.answered_at, id);
  return getQuestion(id)!;
}

// ------------------------------------------------------------- PM decisions

export type LogEntry = { id: string; at: number; action: string; subject: string | null; product: string | null; detail: string | null; undo: any; undone: number | null };
/** Records something the PM (Talk) did. undo: how to take it back (pm.ts undoDecision), or null when it can't be. */
export function logDecision(action: string, subject: string | null, product: string | null, detail: string, undo: unknown = null) {
  const id = newId('d');
  db.prepare('INSERT INTO pm_log (id, at, action, subject, product, detail, undo) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, Date.now(), action, subject, product, detail.slice(0, 2000), undo ? J(undo) : null);
  return id;
}
export function listDecisions(q: { limit?: number; since?: number; action?: string } = {}) {
  const where = ['at >= ?'];
  const args: any[] = [q.since ?? 0];
  if (q.action) { where.push('action = ?'); args.push(q.action); }
  return (db.prepare(`SELECT * FROM pm_log WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`).all(...args, q.limit ?? 100) as any[]).map((r) => ({ ...r, undo: parse(r.undo) })) as LogEntry[];
}
export const getDecision = (id: string) => {
  const r = db.prepare('SELECT * FROM pm_log WHERE id = ?').get(id) as any;
  return r ? ({ ...r, undo: parse(r.undo) } as LogEntry) : null;
};
export const markUndone = (id: string) => db.prepare('UPDATE pm_log SET undone = ? WHERE id = ?').run(Date.now(), id);
export const countToday = (action: string) => {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  return (db.prepare('SELECT COUNT(*) AS n FROM pm_log WHERE action = ? AND at >= ? AND undone IS NULL').get(action, since.getTime()) as any).n as number;
};
