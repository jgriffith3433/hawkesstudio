// What else is in flight on a product, for an agent pass that is about to start (the owner, 2026-11-11: "make the
// agents aware of the other work the other agents are doing with that project", after a day of the same product's
// builds piling up in a queue and agents redoing each other's work).
//
// Every agent pass (agents.ts runAgentInner: a first pass, a resumed session, an answer, a conflict pass, a nudge, a
// Studio or Gen change) gets this section at the end of its prompt, read from Studio's own database at the moment the
// pass starts: the product's other agent changes (status, branch, pull request, the files each has touched so far),
// its roadmap tasks being worked or reviewed, and the builds and beta or daily runs going for it, with what started
// them. With it, the rules that follow from it: don't redo another change's work, keep an edit in a shared file small,
// never start a build (Studio builds at a milestone's end: unitybuild-policy.ts), and say "Already done by <change id>"
// when another change already does the whole task (agents.ts alreadyDone closes it the way any already-done change is
// closed: a fix's bugs are fixed, a task's claim is checked by the PM, pm.ts doneProof).
//
// Nothing here runs git or calls another service: the files a change touched are recorded once after each of its
// passes (noteTouched, from agents.ts agentPass) and read back from the table, so a prompt costs a few indexed reads,
// however many changes run beside it. Every list is bounded, so the section stays short.

import { db, parse } from './db.ts';

db.exec(`CREATE TABLE IF NOT EXISTS change_files (id TEXT PRIMARY KEY, files TEXT NOT NULL, at INTEGER NOT NULL)`);

/** The agent change statuses that are still in flight (work on a branch that hasn't merged or ended). */
export const IN_FLIGHT = ['queued', 'working', 'verifying', 'revising', 'ready', 'needs answer', 'waiting on Gen'] as const;
/** At most this many files are kept per change. */
const KEEP_FILES = 200;
/** A run "running" for longer than this was left behind (pipeline.ts startRun's rule, betaqueue.ts STALE_MS). */
const STALE_MS = 6 * 3600_000;

export const LIMITS = { changes: 12, files: 15, tasks: 6, builds: 6, runs: 4, text: 6000 };

/** Records the files a change has touched so far (its branch against its base, and what's uncommitted), Studio's work notes aside. */
export function noteTouched(id: string, files: string[], at = Date.now()) {
  const list = [...new Set(files.map((f) => f.trim()).filter((f) => f && !f.startsWith('.hawkes/')))].slice(0, KEEP_FILES);
  db.prepare('INSERT INTO change_files (id, files, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET files = excluded.files, at = excluded.at').run(id, JSON.stringify(list), at);
  return list;
}

/** The files a change touched, as last recorded ([] when none was). */
export function touchedFiles(id: string): string[] {
  const r = db.prepare('SELECT files FROM change_files WHERE id = ?').get(id) as { files: string } | undefined;
  const v = r ? parse(r.files) : null;
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * After an agent pass: reads what the change's worktree touched (two quick git reads, off the event loop) and records
 * it. Never throws: a missing worktree or a failed read keeps the last record.
 */
export async function recordTouched(c: { id: string; worktree?: string | null; base?: string | null }) {
  try {
    if (!c.worktree) return touchedFiles(c.id);
    const { gitAsync } = await import('./beta.ts');
    const [committed, open] = await Promise.all([
      gitAsync(c.worktree, ['diff', '--name-only', `origin/${c.base || 'beta'}...HEAD`], 20_000),
      gitAsync(c.worktree, ['status', '--porcelain'], 20_000),
    ]);
    if (!committed.ok && !open.ok) return touchedFiles(c.id);
    const files = [
      ...(committed.ok ? committed.out.split('\n') : []),
      ...(open.ok ? open.out.split('\n').map((l) => l.slice(3).split(' -> ').pop() ?? '') : []),
    ];
    // The branch diff is the whole picture; without it (no base ref yet), what was recorded before stays, plus what's open.
    return noteTouched(c.id, committed.ok ? files : [...touchedFiles(c.id), ...files]);
  } catch {
    return touchedFiles(c.id);
  }
}

export type InFlightChange = { id: string; status: string; title: string | null; request: string | null; branch: string | null; pr: number | null; task: string | null; files: string[] };
export type InFlightTask = { id: string; title: string; status: string; change: string | null };
export type InFlightBuild = { id: string; build: string; version: number | null; cause: string; started: number };
export type InFlightRun = { id: string; kind: string; cause: string; started: number };
export type InFlight = { changes: InFlightChange[]; moreChanges: number; tasks: InFlightTask[]; builds: InFlightBuild[]; runs: InFlightRun[] };

/** One query that may run before its table exists (a fresh database, a test): [] then. */
function rows<T>(sql: string, ...args: (string | number | null)[]): T[] {
  try { return db.prepare(sql).all(...args) as T[]; } catch { return []; }
}

/**
 * The product's other work in flight right now, from Studio's own tables: its other agent changes (oldest first, the
 * one asking excluded), its roadmap tasks being worked or reviewed that aren't one of those changes, and its builds and
 * beta or daily runs that are going. Bounded by LIMITS.
 */
export function inFlightFor(product: string, exceptChangeId?: string | null, now = Date.now()): InFlight {
  const marks = IN_FLIGHT.map(() => '?').join(',');
  const all = rows<any>(`SELECT id, status, title, request, branch, pr, task FROM changes WHERE product = ? AND status IN (${marks}) AND id != ? ORDER BY created, rowid`, product, ...IN_FLIGHT, exceptChangeId ?? '');
  const changes: InFlightChange[] = all.slice(0, LIMITS.changes).map((r) => ({
    id: r.id, status: r.status, title: r.title ?? null, request: r.request ?? null, branch: r.branch ?? null, pr: r.pr ?? null, task: r.task ?? null, files: touchedFiles(r.id),
  }));
  const own = exceptChangeId ? (rows<{ task: string | null }>('SELECT task FROM changes WHERE id = ?', exceptChangeId)[0]?.task ?? null) : null;
  const listed = new Set(all.map((r) => r.id));
  const tasks = rows<any>(`SELECT id, title, status, change FROM tasks WHERE product = ? AND status IN ('working', 'review') ORDER BY ord, created`, product)
    .filter((t) => t.id !== own && !(t.change && (listed.has(t.change) || t.change === exceptChangeId)))
    .slice(0, LIMITS.tasks)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, change: t.change ?? null }));
  const builds = rows<any>(`SELECT id, build, version, change, run, ref, started FROM builds WHERE product = ? AND status = 'building' AND started > ? ORDER BY started`, product, now - STALE_MS)
    .slice(0, LIMITS.builds)
    .map((b) => ({ id: b.id, build: b.build, version: b.change ? null : b.version ?? null, started: b.started, cause: b.change ? `change ${b.change}'s preview` : b.run ? `run ${b.run}` : b.ref ? `${b.ref}` : 'asked for' }));
  const runs = rows<any>(`SELECT id, kind, detail, options, started FROM runs WHERE status = 'running' AND kind IN ('beta', 'daily') AND products LIKE ? AND started > ? ORDER BY started`, `%"${product}"%`, now - STALE_MS)
    .slice(0, LIMITS.runs)
    .map((r) => {
      const o = parse(r.options) ?? {};
      const why = String(o.focus ?? r.detail ?? '').replace(/\s+/g, ' ').trim();
      return { id: r.id, kind: r.kind, started: r.started, cause: why ? clip(why, 140) : r.kind === 'daily' ? 'the daily run' : 'a push to beta' };
    });
  return { changes, moreChanges: Math.max(0, all.length - changes.length), tasks, builds, runs };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

/**
 * The prompt's section on the other work in flight (inFlightFor) and what the agent does about it. `name`: the
 * product's name for the heading. Always has the rules (never start a build); the lists only when there is something.
 */
export function inFlightSection(name: string, f: InFlight) {
  const lines: string[] = [];
  if (f.changes.length) {
    lines.push('Other agent changes (each on its own branch from its base):');
    for (const c of f.changes) {
      const ask = (c.request ?? '').replace(/\s+/g, ' ').trim();
      const what = clip((c.title ?? ask) || c.id, 100);
      const extra = [c.task ? `task ${c.task}` : '', c.branch ? `branch ${c.branch}` : '', c.pr ? `PR #${c.pr}` : ''].filter(Boolean).join(', ');
      const files = c.files.length ? `${c.files.slice(0, LIMITS.files).join(', ')}${c.files.length > LIMITS.files ? ` (+${c.files.length - LIMITS.files} more)` : ''}` : 'none recorded yet';
      lines.push(`- ${c.id} [${c.status}] ${what}${extra ? ` (${extra})` : ''}${ask && ask !== c.title ? `\n  Asked: ${clip(ask, 160)}` : ''}\n  Files: ${files}`);
    }
    if (f.moreChanges) lines.push(`- and ${f.moreChanges} more`);
  }
  if (f.tasks.length) {
    lines.push('Roadmap tasks being worked or reviewed:');
    for (const t of f.tasks) lines.push(`- ${t.id} [${t.status}] ${clip(t.title, 100)}${t.change ? ` (change ${t.change})` : ''}`);
  }
  if (f.builds.length || f.runs.length) {
    lines.push('Builds and runs going now (Studio started them; they need nothing from you):');
    for (const b of f.builds) lines.push(`- build ${b.id}: ${b.build}${b.version != null ? ` v${b.version}` : ''}, since ${hhmm(b.started)} UTC, for ${b.cause}`);
    for (const r of f.runs) lines.push(`- ${r.kind} run ${r.id}, since ${hhmm(r.started)} UTC: ${r.cause}`);
  }
  const head = `## Other work in flight on ${name} (as this pass starts)\n\n`;
  const rules = `
- Don't redo work one of these already has. If one of them already does your whole task, commit nothing and write in
  .hawkes/summary.md "Already done by <its change id>" and what you checked: Studio closes your change.
- Where your task needs a file another change is editing, keep your edit there minimal and compatible with theirs, and
  say so in your summary.
- Never start or ask for a build, a beta run or a playtest, and never trigger one with an empty commit, a tag or a
  push: Studio builds by itself once a milestone is complete in code.
`;
  let list = lines.length ? lines.join('\n') : `Nothing else is in flight on ${name} right now (another change may start while you work).`;
  // Over the limit, the list is cut at a line (the rules always stay).
  const room = LIMITS.text - head.length - rules.length - 40;
  if (list.length > room) list = `${list.slice(0, Math.max(0, list.lastIndexOf('\n', room)))}\n(more in flight; cut for length)`;
  return `${head}${list}\n${rules}`;
}

/** The section for a change about to run a pass: its product's other work, the change itself excluded. Never throws. */
export function inFlightPrompt(c: { id: string; product: string }, name = c.product) {
  try {
    return inFlightSection(name, inFlightFor(c.product, c.id));
  } catch (e: any) {
    console.warn(`[studio] in-flight section for ${c.id}: ${e?.message ?? e}`);
    return '';
  }
}

/** The change an agent's summary says already did its task ("Already done by c_..."), or null. */
export function doneByOf(summary: string): string | null {
  return String(summary ?? '').match(/\bdone by (c_[0-9a-f]{12})\b/i)?.[1] ?? null;
}
