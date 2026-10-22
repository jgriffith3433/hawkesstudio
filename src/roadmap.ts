// The roadmap: what J wants built, per product, as items (a goal with acceptance criteria) and the tasks under them
// (one agent change each). Talk plans it with J (studio_roadmap), the PM loop (pm.ts) works it with the agents, and a
// task is done only when its acceptance criteria pass on beta.
//
//   item  status: idea -> planned -> done (consumed: as soon as it has tasks, J 2026-10-17; its tasks still run) | dropped
//                 (items from before: in progress -> on beta (every task verified on beta) -> live)
//         What J sees is never that stored status but its progress (itemProgress, from its tasks; J 2026-10-18: "road map
//         says it's done even though it's still being worked on"): planned, working (n of m merged), waiting for your GPU
//         budget, needs you, on beta (every task merged and beta built it), verified, live.
//   task  status: idea | planned (starts by itself when its item is planned and what it depends on is on beta)
//                 -> working (an agent change) -> review (the change is ready: the PM checks it against the criteria)
//                 -> merged (into beta; beta's build of it is recorded on the task: build) -> verified (its criteria pass
//                 on beta: the milestone's playtest, or a beta playtest J asked for) -> live
//                 | failed (3 tries, then J is asked) | dropped
//                 | done (already done: its work is on beta from other changes, nothing for an agent to do; counts as on
//                   beta, J 2026-10-19: items whose tasks were all "dropped as already done" showed "planned")
//                 | waiting for GPU (its change merged stand-ins because no GPU server ran: not done; pm.ts runs it again,
//                   not as a try, when a server is up, until the real art lands)
//
// Also here, because every part of the loop uses them: comment threads (on findings, items, tasks and changes; J, Talk
// and agents write them, agents read them), questions (an agent's question pausing its change, or a decision only J
// can make) and the PM decision log (every merge, won't-fix, start and answer Talk made, with undo where possible).

import { db, newId, J, parse } from './db.ts';
import { loadProducts, loadInfra, isInfra, StudioError, betaPlaytestsOn } from './config.ts';
import { walkAwaySettings, type WalkAwaySettings } from './walkaway.ts';

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
// items.consumed: when the item counted as done because its tasks were created (syncItem); its tasks still start.
for (const [table, col] of [['runs', 'pm_seen'], ['findings', 'item'], ['items', 'milestone'], ['findings', 'source'], ['findings', 'milestone'], ['findings', 'report'], ['tasks', 'gpu'], ['items', 'consumed'], ['tasks', 'build'], ['milestones', 'checks']]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
}
// Priorities (high | normal | low): an item's is normal unless set (old rows too); a task's is null until set, and then
// its item's applies (effectivePriority). The PM starts the highest first (pm.ts startWork).
try { db.exec(`ALTER TABLE items ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`); } catch { /* already there */ }
try { db.exec('ALTER TABLE tasks ADD COLUMN priority TEXT'); } catch { /* already there */ }
// The repo a task's agent works in: null (the product's source repo) or 'site' (a Unity game's website repo).
try { db.exec('ALTER TABLE tasks ADD COLUMN target TEXT'); } catch { /* already there */ }
// What kind of work a task is: null (a change judged on beta) or 'video' (videos.ts: J screens each version, his notes
// revise it, his approval finishes it).
try { db.exec('ALTER TABLE tasks ADD COLUMN kind TEXT'); } catch { /* already there */ }
export const TASK_KINDS = ['video'];

export const ITEM_STATUSES = ['idea', 'planned', 'in progress', 'on beta', 'live', 'done', 'dropped'];
export const TASK_STATUSES = ['idea', 'planned', 'working', 'needs answer', 'review', 'merged', 'waiting for GPU', 'verified', 'live', 'failed', 'dropped', 'done'];
/** A task already done (its work is on beta from other changes): terminal, and on beta like a merged one beta built. */
export const DONE = 'done';
/** What a dependency may be for the task after it to start: its work is on beta, or it will never come (dropped). */
export const SATISFIED = ['merged', 'verified', 'live', DONE, 'dropped'];
/** A task whose change merged stand-in art or fallback code because no GPU server ran (J, 2026-10-18): not done. */
export const GPU_WAIT = 'waiting for GPU';
export const SIZES = ['S', 'M', 'L'];
export const PRIORITIES = ['high', 'normal', 'low'];
const RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
/** A task's target from the API: 'site' (only a Unity game with a website repo of its own), or null for the source repo. */
function targetOf(v: unknown, product: string): string | null {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t || t === 'source' || t === 'game') return null;
  if (t !== 'site' && t !== 'website') throw new StudioError(`target is "site" (the website repo) or empty (the game's source repo), not "${v}"`);
  const p = loadProducts().find((x) => x.id === product);
  if (!p?.build || p.site.split('/')[0] === p.repo.split('/')[0]) throw new StudioError(`${p?.name ?? product} has no website repo of its own (leave target empty)`);
  return 'site';
}
/** A priority from the API: one of PRIORITIES; for a task, '' or null clears it (its item's applies). */
function priorityOf(v: unknown, task: boolean) {
  if ((v === null || v === '') && task) return null;
  const p = String(v ?? '').trim().toLowerCase();
  if (!PRIORITIES.includes(p)) throw new StudioError(`priority must be ${PRIORITIES.join(', ')}${task ? " (or empty: the item's)" : ''}`);
  return p;
}

export type Check = { criterion: string; met: 'yes' | 'no' | 'unclear'; evidence?: string };
export type Task = {
  id: string; item: string; product: string; title: string; request: string; criteria: string[]; depends: string[]; status: string;
  /** Its own priority, or null: its item's applies (effective_priority). */
  priority: string | null; effective_priority: string;
  ord: number; change: string | null; changes: string[]; pr: string | null; tries: number;
  /** 'site': its agent works in the Unity game's website repo; null: the source repo. */
  target: string | null;
  /** 'video': a video J screens (videos.ts); null: work judged on beta. */
  kind: string | null;
  /** The latest acceptance results: where they were judged (the change's verification, or beta), per criterion. */
  checks: { where: 'change' | 'beta'; at: number; run?: string; change?: string; video?: string | null; verdict?: string; results: Check[] } | null;
  /** How J can try it (the agent's words). */
  try: string | null; note: string | null; merged_at: number | null; verified_at: number | null; live_at: number | null; created: number; updated: number | null;
  /**
   * Content tasks that generate on the GPU: what they will make (Hawkes Gen estimate items), the estimate, and the
   * budget approved (J's, or Studio's under costs.gpuAutoApprove: autoApproveGpu). A task whose estimate costs money waits until a budget covers it.
   */
  gpu: TaskGpu | null;
  /** Beta's build after it merged (pm.ts followBuilds): did it build (for Unity: did it compile), in which beta run. */
  build: TaskBuild | null;
};
export type TaskBuild = { ok: boolean; run: string; at: number; detail: string; unity?: boolean };
export type TaskGpu = { items?: any[]; estimate?: { gpuHours: number; cost: number; withIdleTail: number; servers: number; wallMinutes: number; at: number; error?: string }; budget?: number | null; approvedBy?: string | null; approvedAt?: number | null };
export type Item = {
  id: string; product: string; title: string; goal: string | null; why: string | null; criteria: string[]; size: string | null; status: string;
  priority: string; ord: number; origin: string | null; note: string | null; by: string | null; milestone?: string | null; consumed?: string | null; created: number; updated: number | null; tasks?: Task[];
};

const toItem = (r: any): Item => ({ ...r, priority: r.priority ?? 'normal', criteria: parse(r.criteria) ?? [] });
// Task rows are read with their item's priority alongside (TASK_SELECT), for the effective priority.
const TASK_SELECT = `SELECT t.*, COALESCE(t.priority, i.priority, 'normal') AS effective_priority FROM tasks t LEFT JOIN items i ON i.id = t.item`;
const toTask = (r: any): Task => ({ ...r, priority: r.priority ?? null, target: r.target ?? null, kind: r.kind ?? null, effective_priority: r.effective_priority ?? r.priority ?? 'normal', criteria: parse(r.criteria) ?? [], depends: parse(r.depends) ?? [], changes: parse(r.changes) ?? [], checks: parse(r.checks), gpu: parse(r.gpu) ?? null, build: parse(r.build) ?? null });
const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split('\n') : []).map((s) => String(s).replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(Boolean).slice(0, 20);
const productId = (id: string) => {
  const p = loadProducts().find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
  if (p) return p.id;
  // Studio and Gen themselves, by id or name ("Hawkes Studio").
  const inf = loadInfra().find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
  if (inf) return inf.id;
  throw new StudioError(`No product "${id}". Products: ${loadProducts().map((x) => x.id).join(', ')}`, 404);
};
/** What roadmap items can be for: the products, then Studio and Gen themselves (products.json infra). */
export const roadmapProducts = () => [...loadProducts(), ...loadInfra()].map((x) => ({ id: x.id, name: x.name, infra: isInfra(x.id) }));

export const getItem = (id: string) => {
  const r = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return r ? { ...toItem(r), tasks: tasksOf(id) } : null;
};
/** An item with its progress (what J sees: itemProgress), for the API and studio_roadmap. */
export const getItemView = (id: string) => {
  const it = getItem(id);
  return it ? { ...it, progress: itemProgress(it) } : null;
};
export const getTask = (id: string) => {
  const r = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
  return r ? toTask(r) : null;
};
export const tasksOf = (item: string) => (db.prepare(`${TASK_SELECT} WHERE t.item = ? ORDER BY t.ord, t.created`).all(item) as any[]).map(toTask);
export const taskOfChange = (change: string) => {
  const r = db.prepare(`${TASK_SELECT} WHERE t.change = ? OR t.changes LIKE ?`).get(change, `%"${change}"%`);
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
  const asked = askedJ();
  return (db.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY product, ord, created`).all(...args) as any[]).map((r) => {
    const it = { ...toItem(r), tasks: tasksOf(r.id).map((t) => ({ ...t, blocked_by: blockedBy(t) })) };
    return { ...it, progress: itemProgress(it, asked) };
  });
}

// ------------------------------------------------------------ progress

/** Subjects (task and change ids) of the questions waiting on J ("asked J"): those tasks need him. */
export function askedJ() {
  const out = new Set<string>();
  for (const r of db.prepare(`SELECT subject FROM questions WHERE status = 'asked J' AND subject IS NOT NULL`).all() as any[]) for (const s of String(r.subject).split(/[\s,]+/)) if (s) out.add(s);
  return out;
}
/** Studio and Gen merge into main (it deploys them): no beta build to wait for. */
const needsBetaBuild = (t: Pick<Task, 'product'>) => !isInfra(t.product);
/** A task is on beta: verified, live or already done, or merged and beta built it (Studio and Gen: merged into main). */
export const landed = (t: Pick<Task, 'status' | 'product' | 'build'>) => ['verified', 'live', DONE].includes(t.status) ||(t.status === 'merged' && (!needsBetaBuild(t) || t.build?.ok === true));

/** A task's change parked on its Gen jobs (agents.ts WAITING_GEN): how many of them are done; null when it isn't. */
export function genWaitOf(change: string | null | undefined): { done: number; total: number } | null {
  if (!change) return null;
  try {
    const r = db.prepare('SELECT status, phase FROM changes WHERE id = ?').get(change) as { status: string; phase: string | null } | undefined;
    if (r?.status !== 'waiting on Gen') return null;
    const jobs: { status?: string }[] = parse(r.phase)?.gen?.jobs ?? [];
    return { done: jobs.filter((j) => ['done', 'failed', 'cancelled', 'missing'].includes(String(j.status))).length, total: jobs.length };
  } catch {
    return null; // no changes table (agents.ts not loaded)
  }
}

/** What a task waits on, in plain words; null when nothing (it's on beta, verified or live). */
export function taskWaits(t: Task, asked: Set<string> = askedJ()): string | null {
  if (asked.has(t.id) || (t.change && asked.has(t.change))) return 'you: a question in your Inbox';
  if (t.status === 'idea') return 'being planned (an idea)';
  if (t.status === 'planned') {
    if (t.gpu?.items?.length && !gpuCleared(t)) return 'your GPU budget';
    const b = blockedBy(t);
    return b.length ? `${b.map((x) => `"${x.title}"`).join(', ')} first` : 'a free agent (it starts by itself)';
  }
  if (t.status === 'working') {
    const g = genWaitOf(t.change);
    return g ? `GPU jobs (${g.done} of ${g.total} done; its agent resumes when they finish)` : 'its agent (working on it)';
  }
  if (t.status === 'needs answer') return "an answer to its agent's question";
  if (t.status === 'review') return 'its merge into beta';
  if (t.status === 'failed') return 'you: it failed after its tries';
  if (t.status === GPU_WAIT) return 'a GPU server: stand-ins are on beta; Studio runs it again for the real art when one is up';
  if (t.status === 'merged' && !landed(t)) return t.build && !t.build.ok ? `a fix: beta's build failed (${t.build.detail.slice(0, 160)})` : "beta's build";
  return null;
}

export type Progress = {
  /** planned | working | waiting for GPU jobs | waiting for your GPU budget | waiting for GPU | needs you | on beta | verified | live (or the item's own: idea, done by hand, dropped). */
  state: string;
  /** What J reads: the state, with "working (n of m merged)". */
  label: string;
  total: number; merged: number; built: number; working: number; waiting: number;
  tasks: { id: string; title: string; status: string; waits: string | null; build: string | null }[];
};

/**
 * Where an item really is, from its tasks (never "done" while its tasks are being worked on): needs you (a question
 * for J, a task failed after its tries) and waiting for your GPU budget first, then live, verified, on beta (every
 * task merged and beta built it), planned (nothing started), else working (n of m merged).
 */
export function itemProgress(it: Item, asked: Set<string> = askedJ()): Progress {
  const all = it.tasks ?? tasksOf(it.id);
  const tasks = all.filter((t) => t.status !== 'dropped' && t.status !== 'idea');
  const merged = tasks.filter((t) => ['merged', 'verified', 'live', DONE].includes(t.status)).length;
  const built = tasks.filter(landed).length;
  const working = tasks.filter((t) => ['working', 'needs answer', 'review'].includes(t.status)).length;
  const waiting = tasks.filter((t) => t.status === 'planned').length;
  const every = (f: (t: Task) => boolean) => tasks.length > 0 && tasks.every(f);
  let state: string;
  if (['idea', 'dropped'].includes(it.status)) state = it.status;
  else if (it.status === 'done' && !it.consumed) state = 'done'; // J's own "done"
  // Every task dropped (none done): nothing to do, never "planned" waiting for ever.
  else if (!tasks.length && all.length && all.every((t) => t.status === 'dropped')) state = 'dropped';
  else if (!tasks.length) state = it.status === 'done' ? 'planned' : it.status;
  else if (tasks.some((t) => t.status === 'failed' || asked.has(t.id) || (t.change && asked.has(t.change)))) state = 'needs you';
  else if (tasks.some((t) => t.status === 'planned' && t.gpu?.items?.length && !gpuCleared(t))) state = 'waiting for your GPU budget';
  // Stand-ins merged for its GPU art: not on beta for real (and not merged in the count) until the art lands.
  else if (tasks.some((t) => t.status === GPU_WAIT)) state = GPU_WAIT;
  else if (every((t) => t.status === 'live')) state = 'live';
  else if (every((t) => ['verified', 'live'].includes(t.status))) state = 'verified';
  else if (every(landed)) state = 'on beta';
  else if (every((t) => t.status === 'planned')) state = 'planned';
  else state = 'working';
  // Working, but every task still being worked on is parked on its Gen jobs: J sees how far those are.
  const gens = tasks.filter((t) => t.status === 'working').map((t) => genWaitOf(t.change));
  const genLabel = state === 'working' && gens.length && gens.every(Boolean)
    ? `waiting for GPU jobs (${gens.reduce((n, g) => n + g!.done, 0)} of ${gens.reduce((n, g) => n + g!.total, 0)} done)` : null;
  if (genLabel) state = 'waiting for GPU jobs';
  return {
    state, label: genLabel ?? (state === 'working' ? `working (${merged} of ${tasks.length} merged)` : state === 'dropped' && it.status !== 'dropped' ? 'dropped (nothing to do)' : state),
    total: tasks.length, merged, built, working, waiting,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, waits: taskWaits(t, asked), build: t.build ? t.build.detail : null })),
  };
}

/**
 * The tasks a task depends on that aren't merged into beta (or verified, live or already done) yet: while any are, it's
 * blocked. A dropped one never blocks (k_e16304d7a504 waited for ever on a dropped task).
 */
export function blockedBy(t: Pick<Task, 'depends'>) {
  return t.depends.map((d) => getTask(d) ?? { id: d, title: d, status: 'missing' }).filter((d) => !SATISFIED.includes(d.status)).map((d) => ({ id: d.id, title: d.title, status: d.status }));
}

const nextOrd = (table: 'items' | 'tasks', key: string, value: string) => ((db.prepare(`SELECT MAX(ord) AS m FROM ${table} WHERE ${key} = ?`).get(value) as any)?.m ?? 0) + 1;

export function addItem(a: { product: string; title: string; goal?: string; why?: string; criteria?: unknown; size?: string; status?: string; priority?: string; origin?: string | null; by?: string; ord?: number; milestone?: string | null }) {
  if (!a.title?.trim()) throw new StudioError('An item needs a title');
  const product = productId(a.product);
  const status = a.status ?? 'idea';
  if (!ITEM_STATUSES.includes(status)) throw new StudioError(`status must be one of ${ITEM_STATUSES.join(', ')}`);
  if (a.size && !SIZES.includes(a.size)) throw new StudioError('size must be S, M or L');
  const priority = a.priority ? priorityOf(a.priority, false) : 'normal';
  const id = newId('i');
  db.prepare('INSERT INTO items (id, product, title, goal, why, criteria, size, status, priority, ord, origin, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, product, a.title.trim().slice(0, 200), a.goal ?? null, a.why ?? null, J(list(a.criteria)), a.size ?? null, status, priority, a.ord ?? nextOrd('items', 'product', product), a.origin ?? null, a.by ?? 'J', Date.now());
  if (a.milestone) setItemMilestone(id, a.milestone);
  return getItem(id)!;
}

export function updateItem(id: string, patch: Partial<{ title: string; goal: string; why: string; criteria: unknown; size: string; status: string; priority: string; ord: number; note: string; origin: string; milestone: string | null }>) {
  const cur = getItem(id);
  if (!cur) throw new StudioError(`No item ${id}`, 404);
  // in progress, on beta and live follow the tasks (syncItem).
  if (patch.status && !['idea', 'planned', 'done', 'dropped'].includes(patch.status)) throw new StudioError(`An item's status follows its tasks; by hand it can be idea, planned, done or dropped`);
  if (patch.size && !SIZES.includes(patch.size)) throw new StudioError('size must be S, M or L');
  const n = { ...cur, ...patch, criteria: patch.criteria !== undefined ? list(patch.criteria) : cur.criteria, priority: patch.priority !== undefined ? priorityOf(patch.priority, false) : cur.priority };
  db.prepare('UPDATE items SET title = ?, goal = ?, why = ?, criteria = ?, size = ?, status = ?, priority = ?, ord = ?, note = ?, origin = ?, updated = ? WHERE id = ?')
    .run(n.title, n.goal, n.why, J(n.criteria), n.size, n.status, n.priority, n.ord, n.note, n.origin, Date.now(), id);
  if (patch.milestone !== undefined) setItemMilestone(id, patch.milestone);
  // Planned again (or for the first time) with tasks: consumed now.
  if (patch.status === 'planned') syncItem(id);
  // Dropping an item drops the tasks not started yet.
  if (patch.status === 'dropped') db.prepare(`UPDATE tasks SET status = 'dropped', updated = ? WHERE item = ? AND status IN ('idea', 'planned')`).run(Date.now(), id);
  return getItem(id)!;
}

export function addTask(a: { item: string; title?: string; request: string; criteria?: unknown; depends?: unknown; status?: string; priority?: string | null; ord?: number; gpu?: unknown; target?: string | null; kind?: string | null }) {
  const item = getItem(a.item);
  if (!item) throw new StudioError(`No item ${a.item}`, 404);
  if (!a.request?.trim()) throw new StudioError('A task needs a request (what the agent should do)');
  const status = a.status ?? 'planned';
  if (!['idea', 'planned'].includes(status)) throw new StudioError('A new task is idea or planned');
  const depends = list(a.depends);
  for (const d of depends) if (!getTask(d)) throw new StudioError(`depends: no task ${d}`);
  const priority = a.priority === undefined ? null : priorityOf(a.priority, true);
  const target = targetOf(a.target, item.product);
  const id = newId('k');
  db.prepare('INSERT INTO tasks (id, item, product, title, request, criteria, depends, status, priority, ord, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.id, item.product, (a.title ?? a.request.split('\n')[0]).trim().slice(0, 160), a.request.trim(), J(list(a.criteria)), J(depends), status, priority, a.ord ?? nextOrd('tasks', 'item', item.id), Date.now());
  if (target) db.prepare('UPDATE tasks SET target = ? WHERE id = ?').run(target, id);
  if (a.kind) {
    if (!TASK_KINDS.includes(String(a.kind))) throw new StudioError(`kind is ${TASK_KINDS.join(' or ')} (or empty)`);
    db.prepare('UPDATE tasks SET kind = ? WHERE id = ?').run(String(a.kind), id);
  }
  const gpu = gpuItems(a.gpu);
  // A follow-up of GPU work added without its own items (the PM's, 2026-10-18: four were added with none, so no budget,
  // no server, and three agents in a row made nothing) keeps the items of the work it follows up.
  const from = gpu ? null : inheritedGpu({ product: item.product, request: a.request, depends });
  if (gpu || from) db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(J({ items: gpu ?? from!.items }), id);
  if (from) logDecision('gpu inherit', id, item.product, `"${(a.title ?? a.request.split('\n')[0]).trim().slice(0, 160)}" was added without GPU items: it keeps ${from.from}'s (${from.items.length}), priced again for its budget`);
  syncItem(item.id);
  return getTask(id)!;
}

/**
 * The GPU items a task added without its own should have: those of the first GPU task it follows up, found from what
 * it depends on and the tasks (k_...) and changes (c_...) its request names, following a chain of follow-ups (each
 * added before this fix without items) back to the task that had them. Same product only. null: none found.
 */
export function inheritedGpu(a: { product: string; request: string; depends?: string[] }): { items: any[]; from: string } | null {
  const refs = (text: string, deps: string[] = []) => {
    const out = [...deps, ...(text.match(/\bk_[0-9a-f]{12}\b/g) ?? [])].map((k) => getTask(k));
    for (const c of text.match(/\bc_[0-9a-f]{12}\b/g) ?? []) out.push(taskOfChange(c));
    return out.filter((t): t is Task => Boolean(t) && t!.product === a.product);
  };
  const queue = refs(a.request, a.depends ?? []);
  const seen = new Set<string>();
  while (queue.length && seen.size < 12) {
    const t = queue.shift()!;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (t.gpu?.items?.length) return { items: t.gpu.items, from: t.id };
    queue.push(...refs(t.request, t.depends));
  }
  return null;
}

/**
 * Planned tasks without GPU items that follow up GPU work (inheritedGpu): given its items and priced (estimateTask: the
 * under-$5 auto approval may then budget them). For the follow-ups added before addTask did this; once after a restart.
 */
export async function backfillGpu() {
  const out: string[] = [];
  // All given their items first (with nothing awaited: none can start unpriced meanwhile), then priced.
  for (const r of db.prepare(`SELECT t.id FROM tasks t JOIN items i ON i.id = t.item WHERE t.status = 'planned' AND t.gpu IS NULL AND ${WORKED}`).all() as any[]) {
    const t = getTask(r.id)!;
    const from = inheritedGpu(t);
    if (!from) continue;
    db.prepare('UPDATE tasks SET gpu = ?, updated = ? WHERE id = ?').run(J({ items: from.items }), Date.now(), t.id);
    logDecision('gpu inherit', t.id, t.product, `"${t.title}" had no GPU items: it keeps ${from.from}'s (${from.items.length}), priced again for its budget`);
    out.push(t.id);
  }
  for (const id of out) await estimateTask(id).catch((e: any) => console.warn(`[roadmap] pricing ${id} failed: ${e.message}`));
  return out;
}

/** Fields Talk and J may set. Status changes the loop makes (working, review, merged, ...) go through setTask. */
export function updateTask(id: string, patch: Partial<{ title: string; request: string; criteria: unknown; depends: unknown; status: string; priority: string | null; ord: number; note: string; gpu: unknown; target: string | null }>) {
  const cur = getTask(id);
  if (!cur) throw new StudioError(`No task ${id}`, 404);
  // working, review, merged, verified and live come from the agents and the checks, never by hand. done: already done
  // (its work is on beta from other changes), which counts as on beta; dropped: stopped, never done.
  if (patch.status && !['idea', 'planned', 'dropped', DONE].includes(patch.status)) throw new StudioError(`A task's status is set by its work and its checks; by hand it can be idea, planned (start or retry), done (already done on beta) or dropped`);
  // Back to planned (to try again from scratch) resets the tries and the change.
  const fresh = patch.status === 'planned' && !['idea', 'planned'].includes(cur.status);
  // New GPU items: estimated again by the caller (estimateTask); an approval stays only while it covers the estimate.
  if (patch.gpu !== undefined) {
    const items = gpuItems(patch.gpu);
    db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(items ? J({ ...(cur.gpu ?? {}), items, estimate: undefined }) : null, id);
    delete patch.gpu;
  }
  if (patch.target !== undefined) {
    db.prepare('UPDATE tasks SET target = ? WHERE id = ?').run(targetOf(patch.target, cur.product), id);
    delete patch.target;
  }
  // Its own priority, or none (null or ''): its item's applies.
  if (patch.priority !== undefined) {
    db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(priorityOf(patch.priority, true), id);
    delete patch.priority;
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
    merged_at = ?, verified_at = ?, live_at = ?, build = ?, updated = ? WHERE id = ?`)
    .run(n.title, n.request, J(n.criteria), J(n.depends), n.status, n.ord, n.change, J(n.changes), n.pr, n.tries, n.checks ? J(n.checks) : null, n.try, n.note,
      n.merged_at, n.verified_at, n.live_at, n.build ? J(n.build) : null, Date.now(), id);
  syncItem(cur.item);
  return getTask(id)!;
}

/**
 * A planned item is consumed (done) as soon as it has tasks (J, 2026-10-17: "consumed as soon as we create tasks for
 * them and assume that it's done afterwards"); its tasks still start and run (startableTasks takes consumed items).
 * Items from before that are in progress, on beta or live follow their tasks: in progress while any task is underway, on
 * beta when every task is verified on beta (or live), live when all are live. idea, planned, done and dropped are J's.
 */
export function syncItem(id: string) {
  const it = getItem(id);
  if (!it || ['idea', 'done', 'dropped'].includes(it.status)) return it;
  const tasks = (it.tasks ?? []).filter((t) => t.status !== 'dropped' && t.status !== 'idea');
  if (!tasks.length) return it;
  if (it.status === 'planned') {
    const now = Date.now();
    db.prepare(`UPDATE items SET status = 'done', consumed = ?, note = COALESCE(note || ' ', '') || ?, updated = ? WHERE id = ?`)
      .run(String(now), `[done: tasks created ${new Date(now).toISOString().slice(0, 10)}]`, now, id);
    return getItem(id);
  }
  const all = (...s: string[]) => tasks.every((t) => s.includes(t.status));
  // With beta playtests on request (config.ts betaPlaytestsOn), a merged task is on beta: nothing will check it there.
  const onBeta = betaPlaytestsOn() ? all('verified', 'live', DONE) : all('merged', 'verified', 'live', DONE);
  const status = all('live') ? 'live' : onBeta ? 'on beta' : tasks.some((t) => t.status !== 'planned') ? 'in progress' : it.status;
  if (status !== it.status) db.prepare('UPDATE items SET status = ?, updated = ? WHERE id = ?').run(status, Date.now(), id);
  return getItem(id);
}

/** Items whose planned tasks start: planned, in progress, or done because its tasks were created (consumed). */
const WORKED = `(i.status IN ('planned', 'in progress') OR (i.status = 'done' AND i.consumed IS NOT NULL))`;

/**
 * Tasks that may start now: planned, in a worked item (WORKED), not blocked (what they depend on is merged) and
 * GPU-cleared. Highest effective priority first (the task's own, else its item's), then roadmap order (item, task).
 */
export function startableTasks() {
  const rows = (db.prepare(`SELECT t.*, COALESCE(t.priority, i.priority, 'normal') AS effective_priority FROM tasks t JOIN items i ON i.id = t.item
    WHERE t.status = 'planned' AND ${WORKED} ORDER BY i.ord, i.created, t.ord, t.created`).all() as any[]).map(toTask);
  // Array sort is stable: equal priorities keep the roadmap order.
  return rows.filter((t) => !blockedBy(t).length && gpuCleared(t)).sort((a, b) => (RANK[a.effective_priority] ?? 1) - (RANK[b.effective_priority] ?? 1));
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
  // Small ones Studio approves itself (J, 2026-10-18: "<5 dollars auto approve").
  await autoApproveGpu(id).catch((e: any) => console.warn(`[roadmap] GPU auto-approval of ${id} failed: ${e.message}`));
  return getTask(id);
}

/** The budget an approval of an estimate sets: the estimate +25%, rounded up to the cent (the Inbox card's amount). */
export const gpuBudgetFor = (cost: number) => Math.ceil(cost * 1.25 * 100) / 100;

/**
 * Studio's own approval of a small GPU budget (J, 2026-10-18): a priced task waiting for a budget whose estimate with
 * the idle tail (else its cost) is under costs.gpuAutoApprove gets the budget J's approval would set, by "Studio (auto,
 * < $X)", with a line in the PM log and Talk (no Inbox card, no phone). Not while this month's spend is over the
 * monthly budget (J is asked, as for anything at or over the threshold). Returns the task when it approved, else null.
 * threshold, spend and tell are for tests.
 */
export async function autoApproveGpu(id: string, opts: { threshold?: number; spend?: () => Promise<{ spent: number; budget: number; over: boolean }>; tell?: boolean; walkAway?: WalkAwaySettings } = {}) {
  const t = getTask(id);
  const e = t?.gpu?.estimate;
  if (!t || !t.gpu?.items?.length || !e || e.error || gpuCleared(t) || ['dropped', 'live'].includes(t.status)) return null;
  const costs = await import('./costs.ts');
  const threshold = opts.threshold ?? costs.costSettings().gpuAutoApprove;
  const price = e.withIdleTail > 0 ? e.withIdleTail : e.cost;
  if (!(threshold > 0) || !(price < threshold)) return null;
  const budget = gpuBudgetFor(e.cost);
  // Walk-away mode: within a daily cap of what Studio approves by itself (the rest is one digest card for J, pm.ts).
  const wa = opts.walkAway ?? walkAwaySettings();
  if (wa.walkAway && gpuAutoApprovedToday() + budget > wa.walkAwayGpuPerDay) {
    logDecision('gpu ask', id, t.product, `"${t.title}": not approved automatically: $${budget.toFixed(2)} would pass walk-away's $${wa.walkAwayGpuPerDay}/day for GPU budgets ($${gpuAutoApprovedToday().toFixed(2)} approved today): J decides.`);
    return null;
  }
  const m = await (opts.spend ?? costs.monthSpend)();
  if (m.over) {
    gpuOverMonth.add(id);
    logDecision('gpu ask', id, t.product, `"${t.title}": not approved automatically ($${price.toFixed(2)} is under $${threshold}, but this month's spend $${m.spent.toFixed(2)} is over the $${m.budget.toFixed(2)} budget): J decides.`);
    return null;
  }
  gpuOverMonth.delete(id);
  const done = approveGpu(id, budget, `Studio (auto, < $${threshold})`);
  const line = `GPU budget $${budget.toFixed(2)} approved automatically for "${t.title}" (${t.product}): about $${price.toFixed(2)} with the idle tail, under your $${threshold} limit.`;
  logDecision('gpu auto-approve', id, t.product, line);
  if (opts.tell !== false) {
    try {
      const talk = await import('./talk.ts');
      const origin = getItem(t.item)?.origin ?? null;
      if (!(origin && talk.studioNote(origin, line))) talk.studioNote(await (await import('./pm.ts')).pmConversation(), line);
    } catch (err: any) {
      console.warn(`[roadmap] telling Talk about ${id}'s GPU budget failed: ${err.message}`);
    }
  }
  return done;
}

/** GPU budgets Studio approved by itself today (dollars): the walk-away daily cap counts these. */
export function gpuAutoApprovedToday() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  let sum = 0;
  for (const r of db.prepare(`SELECT gpu FROM tasks WHERE gpu IS NOT NULL`).all() as any[]) {
    const g = parse(r.gpu);
    if (typeof g?.budget === 'number' && /^Studio/.test(String(g.approvedBy ?? '')) && (g.approvedAt ?? 0) >= since.getTime()) sum += g.budget;
  }
  return Math.round(sum * 100) / 100;
}

/** Tasks already waiting for a GPU budget that Studio may approve itself (once after a restart: a deploy). */
export async function autoApproveWaiting(opts: Parameters<typeof autoApproveGpu>[1] = {}) {
  const out: string[] = [];
  for (const t of tasksAwaitingGpu()) if (await autoApproveGpu(t.id, opts).catch(() => null)) out.push(t.id);
  return out;
}

/** Tasks Studio declined to approve only because this month's spend is over the budget (autoApproveGpu): J's. */
const gpuOverMonth = new Set<string>();
const HOUR_MS = 3600_000;

/**
 * Tasks waiting for a GPU budget that were never priced, or whose pricing failed over an hour ago, are priced again
 * (estimateTask, which also approves what fits Studio's caps). An unpriced task is Studio's to price, not J's to
 * approve: it never goes in the walk-away digest for that alone. Returns the ids it priced.
 */
export async function priceUnpriced(now = Date.now()) {
  const out: string[] = [];
  for (const t of tasksAwaitingGpu()) {
    const e = t.gpu?.estimate;
    if (e && !(e.error && now - (e.at ?? 0) > HOUR_MS)) continue;
    await estimateTask(t.id).then(() => out.push(t.id), (err: any) => console.warn(`[roadmap] pricing ${t.id} failed: ${err.message}`));
  }
  return out;
}

/**
 * Walk-away's GPU digest (J, 2026-10-19: "A $0.00 budget is never above the caps"): the waiting tasks only J can
 * clear. A priced task is in it when its budget passes the per-task threshold (with the idle tail), Studio's own
 * approvals today plus it pass the daily cap, auto approval is off (threshold 0), or the month is over the budget.
 * $0 budgets and what fits the caps are Studio's (autoApproveGpu), never the digest. A task whose pricing kept failing
 * for a day is in it too, as "couldn't be priced" (the one question a stall gets). threshold and walkAway are for tests.
 */
export function gpuDigestTasks(opts: { threshold: number; walkAway?: WalkAwaySettings; now?: number }) {
  const wa = opts.walkAway ?? walkAwaySettings();
  const now = opts.now ?? Date.now();
  let room = wa.walkAwayGpuPerDay - gpuAutoApprovedToday();
  const out: { task: Task; amount: number | null }[] = [];
  for (const t of tasksAwaitingGpu()) {
    const e = t.gpu?.estimate;
    if (!e || e.error) {
      if (e?.error && now - (e.at ?? 0) > 24 * HOUR_MS) out.push({ task: t, amount: null });
      continue;
    }
    const amount = gpuBudgetFor(e.cost);
    if (!(amount > 0)) continue;
    const price = e.withIdleTail > 0 ? e.withIdleTail : e.cost;
    const studios = opts.threshold > 0 && price < opts.threshold && amount <= room + 1e-9 && !gpuOverMonth.has(t.id);
    if (studios) room -= amount;
    else out.push({ task: t, amount });
  }
  return out;
}

/** An approval of a GPU budget for a task (dollars). Only on J's own word, or Studio's under the threshold (autoApproveGpu). */
export function approveGpu(id: string, budget: number, by: string) {
  const t = getTask(id);
  if (!t) throw new StudioError(`No task ${id}`, 404);
  if (!(budget >= 0)) throw new StudioError('budget: dollars, 0 or more');
  db.prepare('UPDATE tasks SET gpu = ?, updated = ? WHERE id = ?').run(J({ ...(t.gpu ?? {}), budget, approvedBy: by, approvedAt: Date.now() }), Date.now(), id);
  return getTask(id)!;
}

/** Planned tasks waiting only on J's GPU approval (the PM asks him once each). */
export function tasksAwaitingGpu() {
  return (db.prepare(`SELECT t.* FROM tasks t JOIN items i ON i.id = t.item WHERE t.status = 'planned' AND t.gpu IS NOT NULL AND ${WORKED}`).all() as any[])
    .map(toTask).filter((t) => t.gpu?.items?.length && !gpuCleared(t));
}

// -------------------------------------------------------------- milestones

/**
 * A milestone: a named point J will playtest himself (e.g. "DoD: controls done"), made of roadmap items. status: open
 * -> reached (every item in it is on beta, its checks passed: pm.ts tells J on his phone and in Talk) -> live (J went
 * live with it) | dropped.
 */
export type Milestone = { id: string; product: string | null; title: string; goal: string | null; test: string | null; status: string; ord: number; origin: string | null; by: string | null; reached_at: number | null; created: number; updated: number | null;
  /** The beta runs playing its tasks' scenarios once every task landed (JSON list of run ids; pm.ts milestoneCheck). */
  checks?: string | null };
export const MILESTONE_STATUSES = ['open', 'reached', 'live', 'dropped'];
export const getMilestone = (id: string) => (db.prepare('SELECT * FROM milestones WHERE id = ?').get(id) as Milestone | undefined) ?? null;
export function listMilestones(q: { product?: string; status?: string } = {}) {
  const st = (q.status ?? 'open,reached,live').split(',').map((x) => x.trim());
  const rows = db.prepare(`SELECT * FROM milestones WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY ord, created`).all(...st) as Milestone[];
  const pid = q.product ? productId(q.product) : null;
  return rows.filter((m) => !pid || m.product === pid || m.product === null).map((m) => ({ ...m, ...milestoneProgress(m.id) }));
}
/**
 * Its items and how far along they are, from their tasks (itemProgress): an item counts once every task of it is on
 * beta (merged and built by beta), verified or live, or J marked it done himself. A milestone is something J playtests
 * himself: never "reached" while a task is still being worked on or beta hasn't built it.
 */
export function milestoneProgress(id: string) {
  const asked = askedJ();
  // An item whose every task was dropped has nothing to do: it no longer counts, like a dropped item.
  const items = (db.prepare(`SELECT * FROM items WHERE milestone = ? AND status != 'dropped' ORDER BY ord, created`).all(id) as any[]).map(toItem)
    .map((i) => ({ ...i, progress: itemProgress(i, asked) })).filter((i) => i.progress.state !== 'dropped');
  const done =items.filter((i) => ['on beta', 'verified', 'live', 'done'].includes(i.progress.state));
  const tasks = { total: 0, merged: 0, built: 0, working: 0, waiting: 0 };
  for (const i of items) for (const k of Object.keys(tasks) as (keyof typeof tasks)[]) tasks[k] += i.progress[k];
  return { items: items.map((i) => ({ id: i.id, title: i.title, product: i.product, status: i.status, display: i.progress.label, state: i.progress.state, consumed: Boolean(i.consumed) })), done: done.length, total: items.length, tasks };
}
/** Every task of the milestone's items (not dropped or ideas). */
export const milestoneTasks = (id: string) => (db.prepare(`SELECT id FROM items WHERE milestone = ? AND status != 'dropped' ORDER BY ord, created`).all(id) as any[])
  .flatMap((r) => tasksOf(r.id)).filter((t) => t.status !== 'dropped' && t.status !== 'idea');
export const setMilestoneChecks = (id: string, runs: string[]) => db.prepare('UPDATE milestones SET checks = ?, updated = ? WHERE id = ?').run(J(runs), Date.now(), id);
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
  db.prepare('UPDATE milestones SET title = ?, goal = ?, test = ?, status = ?, ord = ?, reached_at = ?, checks = ?, updated = ? WHERE id = ?')
    .run(n.title, n.goal, n.test, n.status, n.ord, patch.status === 'open' ? null : n.reached_at, patch.status === 'open' ? null : n.checks ?? null, Date.now(), id);
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
/** Open milestones whose items (at least one) are all on beta (merged and built): their check runs, then reached (pm.ts). */
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
/** Whether a thread can hang on this subject (a finding, item, task, change or milestone id); questions can have others (slugs, m_ ids). */
export const isCommentSubject = (subject: string | null | undefined): subject is string => !!subject && SUBJECT.test(subject);

export function addComment(subject: string, text: string, by = 'J', kind = 'comment') {
  if (!isCommentSubject(subject)) throw new StudioError('subject: a finding (f_), item (i_), task (k_) or change (c_) id');
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

// What the Inbox (inbox.ts) shows with a question: who asked, what they recommend, what waits on it; a topic and the
// question it passes on (an agent's, forwarded to J), so one subject is one question; how often it was asked again.
for (const col of ['recommendation', 'context', 'blocks', 'asked_by', 'topic', 'forwards', 'asks', 'updated']) {
  try { db.exec(`ALTER TABLE questions ADD COLUMN ${col} ${col === 'asks' || col === 'updated' ? 'INTEGER' : 'TEXT'}`); } catch { /* already there */ }
}

export type Question = {
  id: string; kind: 'agent' | 'decision'; subject: string | null; product: string | null; text: string; options: string[]; status: string;
  answer: string | null; answered_by: string | null; origin: string | null; at: number; answered_at: number | null;
  /** What the asker would do (the Inbox's recommended button; "yes" means this). */
  recommendation: string | null;
  /** A line of context (what it is about), and what waits until J answers. */
  context: string | null; blocks: string | null;
  /** Who filed it: "Talk (PM)", "Talk", "agent c_...", "Studio". */
  asked_by: string | null;
  /** Its topic on that subject (e.g. "gpu" for a GPU budget): one open question per subject and topic. */
  topic: string | null;
  /** The agent question (q_...) this decision passes on to J: answering one answers both. */
  forwards: string | null;
  /** Times it was asked (a repeat merges into the open one). */
  asks: number; updated: number | null;
};
const toQuestion = (r: any): Question => ({ ...r, options: parse(r.options) ?? [], asks: r.asks ?? 1 });
export const getQuestion = (id: string) => {
  const r = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return r ? toQuestion(r) : null;
};

const STOP = new Set('a an the to of in on for and or is it be we i you should do does did this that with at by from about now what which my your our its'.split(' '));
/** The words that carry a question's meaning (ids, numbers and filler dropped), for spotting the same question asked twice. */
export function questionWords(text: string) {
  return new Set(String(text).toLowerCase().replace(/\b[a-z]_[0-9a-f]{6,}\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
}
/** How alike two questions read (0..1): shared meaningful words over all of them. */
export function similarity(a: string, b: string) {
  const x = questionWords(a);
  const y = questionWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** The open question this one repeats: same subject and topic, or (no subject) the same product and nearly the same words. */
function sameQuestion(a: { kind: string; subject?: string | null; product?: string | null; text: string; topic?: string | null }) {
  const open = (db.prepare(`SELECT * FROM questions WHERE status IN ('open', 'asked J') AND kind = ? ORDER BY at`).all(a.kind) as any[]).map(toQuestion);
  if (a.subject) {
    const same = open.filter((q) => q.subject === a.subject && (q.topic ?? '') === (a.topic ?? ''));
    return same.find((q) => q.text === a.text) ?? same[0] ?? null;
  }
  return open.find((q) => q.text === a.text) ?? open.find((q) => !q.subject && (q.product ?? '') === (a.product ?? '') && similarity(q.text, a.text) >= 0.6) ?? null;
}

/**
 * kind agent: an agent asked (its change waits, "needs answer"); Talk answers from what J decided, or asks J
 * (status "asked J"). kind decision: only J can decide (direction, money, something failing after 3 tries, live).
 * A question on a subject (and topic) that already has an open one merges into it: the newest wording, options and
 * recommendation win, the first time asked stays, and asks counts the repeats.
 */
export function addQuestion(a: {
  kind: 'agent' | 'decision'; subject?: string | null; product?: string | null; text: string; options?: unknown; origin?: string | null;
  recommendation?: string | null; context?: string | null; blocks?: string | null; askedBy?: string | null; topic?: string | null; forwards?: string | null;
}) {
  const text = String(a.text ?? '').trim().slice(0, 4000);
  if (!text) throw new StudioError('A question needs its text');
  const options = list(a.options);
  const dup = sameQuestion({ ...a, text });
  if (dup) {
    db.prepare(`UPDATE questions SET text = ?, options = ?, recommendation = COALESCE(?, recommendation), context = COALESCE(?, context), blocks = COALESCE(?, blocks),
      forwards = COALESCE(forwards, ?), origin = COALESCE(origin, ?), asks = COALESCE(asks, 1) + ?, updated = ? WHERE id = ?`)
      .run(text, J(options.length ? options : dup.options), a.recommendation ?? null, a.context ?? null, a.blocks ?? null, a.forwards ?? null, a.origin ?? null, dup.text === text ? 0 : 1, Date.now(), dup.id);
    return getQuestion(dup.id)!;
  }
  const id = newId('q');
  db.prepare(`INSERT INTO questions (id, kind, subject, product, text, options, status, origin, at, recommendation, context, blocks, asked_by, topic, forwards, asks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, a.kind, a.subject ?? null, a.product ?? null, text, J(options), 'open', a.origin ?? null, Date.now(), a.recommendation?.trim().slice(0, 300) || null,
      a.context?.trim().slice(0, 500) || null, a.blocks?.trim().slice(0, 300) || null, a.askedBy?.slice(0, 60) ?? null, a.topic ?? null, a.forwards ?? null);
  return getQuestion(id)!;
}
export function listQuestions(status = 'open,asked J') {
  const st = status.split(',').map((s) => s.trim());
  return (db.prepare(`SELECT * FROM questions WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY at`).all(...st) as any[]).map(toQuestion);
}
/** Questions answered (or closed) since a time, newest first: the Inbox's "answered" list, with who answered. */
export const answeredSince = (since: number, limit = 30) =>
  (db.prepare(`SELECT * FROM questions WHERE status NOT IN ('open', 'asked J') AND answered_at >= ? ORDER BY answered_at DESC LIMIT ?`).all(since, limit) as any[]).map(toQuestion);
export function setQuestion(id: string, patch: Partial<{ status: string; answer: string; answered_by: string }>) {
  const q = getQuestion(id);
  if (!q) throw new StudioError(`No question ${id}`, 404);
  const n = { ...q, ...patch };
  db.prepare('UPDATE questions SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
    .run(n.status, n.answer, n.answered_by, patch.answer || (patch.status && !['open', 'asked J'].includes(patch.status)) ? Date.now() : q.answered_at, id);
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

// --------------------------------------------------------- already done

/**
 * Tasks dropped because they were already done ("Expired: already done on beta ...", "Already done ...", "Superseded
 * ..."): done, which counts as on beta (J, 2026-10-19: The Shaft, The path into Hell and The Magma King showed
 * "planned" though their work was merged). At startup (the migration of the old rows) and on each PM pass, so a drop
 * written that way later still counts. Returns the tasks it changed.
 */
export function adoptDoneDrops() {
  const rows = db.prepare(`SELECT id FROM tasks WHERE status = 'dropped' AND (note LIKE 'Expired: already done%' OR note LIKE 'Already done%' OR note LIKE 'Superseded%')`).all() as any[];
  for (const r of rows) {
    const t = setTask(r.id, { status: DONE });
    logDecision('already-done', t.id, t.product, `"${t.title}" was dropped as already done (${String(t.note ?? '').slice(0, 300)}): done, on beta`);
  }
  return rows.map((r) => r.id as string);
}
try {
  const n = adoptDoneDrops();
  if (n.length) console.log(`[roadmap] ${n.length} task(s) dropped as already done are done now: ${n.join(', ')}`);
} catch (e: any) {
  console.warn(`[roadmap] already-done tasks: ${e.message ?? e}`);
}
