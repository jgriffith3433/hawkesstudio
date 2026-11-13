// The reclaim ladder (J, 2026-11-13: "Studio's disk is full and the agent queue is stuck ... Make it so agents never get
// stuck. Ever"). The working volume (/disk, a memory volume of 2.5 GiB on Cloud Run) filled with product clones, agent
// worktrees, caches and profiles, and the only sweep (disksweep.ts) cleared logs and ended worktrees: once the volume sat
// at its ceiling nothing freed room, every change waited for disk room, and the database itself could not write.
//
// The ladder frees space in order, cheapest and safest first, stopping once there is room (or on every rung when asked
// for all of it):
//   1. worktrees of changes that ended (failed, cancelled, closed, merged) and their -site / .repos folders
//   2. leftover temp folders (tmp, build stage dirs, .trash)
//   3. old CPU profiles and logs
//   4. npm's download cache (when no npm runs)
//   5. product clones no running change or run uses (they clone light again on demand)
//   6. git worktree prune and gc in the clones that stay
// It never touches the database (.data/studio.db) or the worktree of a change still at work, and it records what each
// rung freed (rung, path, MB) in a log studio_ops shows, so the next full disk is diagnosable in one call.
// It runs when a write is refused and when usage passes 80% (disksweep.ts ensureDiskRoom, sweepNow), never on a timer,
// and tells the queue the moment it freed room (disksweep.ts diskFreed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, PROJECTS } from './config.ts';
import * as D from './disksweep.ts';

const MB = 1024 * 1024;

export const LADDER_START = D.LADDER_START;
export const LADDER_TARGET = 0.7;
export const dbReserve = D.dbReserve;
export const ladderDue = D.ladderDue;

export type ReclaimStep = { at: number; rung: string; path: string; mb: number; why: string };
const LOG_KEEP = 200;
const steps: ReclaimStep[] = [];
const logFile = () => path.join(DATA, 'disk-reclaim.jsonl');

function record(rung: string, p: string, bytes: number, why: string) {
  const s: ReclaimStep = { at: Date.now(), rung, path: p, mb: Math.round((bytes / MB) * 10) / 10, why };
  steps.push(s);
  if (steps.length > LOG_KEEP) steps.splice(0, steps.length - LOG_KEEP);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(s) + '\n');
    if (fs.statSync(logFile()).size > 256 * 1024) {
      const keep = fs.readFileSync(logFile(), 'utf8').trim().split('\n').slice(-100).join('\n') + '\n';
      fs.writeFileSync(logFile(), keep);
    }
  } catch { /* the log is a help, never a failure */ }
}

/** What the sweeps freed lately, newest last (studio_ops: /api/ops `diskReclaims`). */
export function reclaimLog(limit = 50): ReclaimStep[] {
  if (!steps.length) {
    try { for (const l of fs.readFileSync(logFile(), 'utf8').trim().split('\n').slice(-LOG_KEEP)) { try { steps.push(JSON.parse(l)); } catch { /* bad line */ } } } catch { /* none yet */ }
  }
  return steps.slice(-limit);
}
export function resetReclaimLog() { steps.length = 0; }

function sizeOf(p: string): number {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let n = 0;
    for (const name of fs.readdirSync(p)) n += sizeOf(path.join(p, name));
    return n;
  } catch { return 0; }
}
function drop(p: string): number {
  const n = sizeOf(p);
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { return 0; }
  return n;
}

/** What the ladder may not touch. */
export type Protect = {
  /** Folder names under .work that belong to a change at work (D.liveWorkNames). */
  work: Set<string>;
  /** Top-level folders of PROJECTS that a running change or run uses. */
  clones: Set<string>;
};

export type LadderOpts = {
  workDir?: string;
  projects?: string;
  tmpDirs?: string[];
  protect: Protect;
  /** All rungs, whatever the room (a refused write); else stops once usage is under the target. */
  all?: boolean;
  say?: (s: string) => void;
  why?: string;
};
export type LadderResult = { freed: number; steps: ReclaimStep[]; room: boolean };

const enough = (all: boolean) => !all && D.diskInfo().used <= D.diskInfo().size * LADDER_TARGET && !D.diskFull(D.WORKTREE_NEED);

/**
 * Walk the ladder. Pure with respect to Studio's state: what is protected is given. Returns what it freed and whether
 * a worktree now fits. One at a time (a second caller gets the first one's answer).
 */
let flight: Promise<LadderResult> | null = null;
export function reclaim(o: LadderOpts): Promise<LadderResult> {
  if (process.env.STUDIO_DISK_SWEEP === 'off') return Promise.resolve({ freed: 0, steps: [], room: true });
  if (flight) return flight;
  flight = runLadder(o).finally(() => { flight = null; });
  return flight;
}

async function runLadder(o: LadderOpts): Promise<LadderResult> {
  const work = o.workDir ?? path.join(PROJECTS, '.work');
  const projects = o.projects ?? PROJECTS;
  const why = o.why ?? 'disk high';
  const before = D.diskInfo().used;
  const mine: ReclaimStep[] = [];
  let freed = 0;
  const took = (rung: string, p: string, bytes: number) => {
    if (bytes <= 0) return;
    freed += bytes;
    record(rung, p, bytes, why);
    mine.push(steps[steps.length - 1]);
  };
  const done = () => enough(o.all === true);

  // 1. ended changes' worktrees
  try {
    for (const n of fs.readdirSync(work)) {
      if (n.startsWith('.') || n.startsWith('beta') || n === 'memory-export' || o.protect.work.has(n)) continue;
      const p = path.join(work, n);
      took('ended worktree', p, drop(p));
      if (done()) break;
    }
  } catch { /* no work folder */ }

  // 2. temp leftovers
  if (!done()) {
    const tmps = o.tmpDirs ?? [os.tmpdir(), path.join(path.dirname(projects), 'tmp')];
    for (const t of new Set(tmps)) {
      const r = D.sweepTmp(t, Date.now(), 0);
      took('tmp', t, r.bytes);
    }
    const trash = path.join(projects, '.trash');
    if (fs.existsSync(trash)) took('trash', trash, drop(trash));
  }

  // 3. old profiles and logs
  if (!done()) {
    const p = D.sweepProfiles(path.join(DATA, 'profiles'), 2, 8 * MB);
    took('profiles', path.join(DATA, 'profiles'), p.bytes);
    const l = D.sweepLogs(path.join(DATA, 'logs'), 8, 8 * MB);
    took('logs', path.join(DATA, 'logs'), l.bytes);
  }

  // 4. npm's cache
  if (!done()) {
    const dir = D.npmCacheDir();
    const n = D.sweepNpmCache(dir);
    took('npm cache', dir, n.bytes);
  }

  // 5. product clones nothing uses (the biggest first)
  if (!done()) {
    let names: { n: string; size: number }[] = [];
    try {
      names = fs.readdirSync(projects)
        .filter((n) => !n.startsWith('.') && !o.protect.clones.has(n) && fs.existsSync(path.join(projects, n, '.git')))
        .map((n) => ({ n, size: sizeOf(path.join(projects, n)) }))
        .sort((a, b) => b.size - a.size);
    } catch { /* no projects */ }
    for (const c of names) {
      const p = path.join(projects, c.n);
      took('unused clone', p, drop(p));
      if (done()) break;
    }
  }

  // 6. git housekeeping in the clones that stay
  if (!done()) {
    let repos: string[] = [];
    try { repos = fs.readdirSync(projects).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(projects, n, '.git'))).map((n) => path.join(projects, n)); } catch { /* none */ }
    const g = await D.pruneGit(repos).catch(() => ({ repos: 0, bytes: 0 }));
    const after = D.diskInfo().used;
    if (g.repos && after < before - freed) took('git gc', `${g.repos} clone(s)`, before - freed - after);
  }

  const room = !D.diskFull(D.WORKTREE_NEED) && D.diskInfo().free >= D.WORKTREE_NEED + dbReserve();
  const statfsFreed = Math.max(0, before - D.diskInfo().used);
  const line = mine.length ? mine.map((s) => `${s.rung} ${path.basename(s.path)} ${s.mb} MB`).join('; ') : 'nothing to free';
  o.say?.(`[disksweep] reclaim ladder (${why}): ${line}; freed ~${Math.round(Math.max(freed, statfsFreed) / MB)} MB; ${D.diskSummary()}`);
  if (room && (freed > MB || statfsFreed > MB)) D.diskFreed(`the reclaim ladder freed ~${Math.round(Math.max(freed, statfsFreed) / MB)} MB (${why})`);
  return { freed: Math.max(freed, statfsFreed), steps: mine, room };
}

/** Top-level PROJECTS folders a product's checkouts live in. */
function foldersOf(p: { repo?: string; site?: string; repos?: { folder?: string }[] }): string[] {
  const top = (s?: string) => (s ? s.split(/[\\/]/)[0] : '');
  return [top(p.repo), top(p.site), ...(p.repos ?? []).map((r) => top(r.folder))].filter(Boolean);
}

/** The ladder's protection from Studio's database: live changes' worktrees and the clones changes and running runs use. */
export async function liveProtect(): Promise<Protect> {
  const protect: Protect = { work: new Set(['beta', 'memory-export']), clones: new Set() };
  try {
    const { db } = await import('./db.ts');
    const rows = db.prepare(`SELECT id, worktree, status, repo, product FROM changes`).all() as { id: string; worktree: string | null; status: string; repo: string | null; product: string }[];
    protect.work = D.liveWorkNames(rows);
    for (const r of rows) {
      if (/^(queued|working|revising|verifying|ready|needs answer|waiting on Gen)$/.test(r.status) && r.repo) protect.clones.add(r.repo.split(/[\\/]/)[0]);
    }
    try {
      const scouts = db.prepare(`SELECT id FROM scouts WHERE status = 'running'`).all() as { id: string }[];
      for (const s of scouts) protect.work.add(`scout-${s.id}`);
    } catch { /* no scouts table */ }
    try {
      const runs = db.prepare(`SELECT product FROM runs WHERE status = 'running'`).all() as { product: string | null }[];
      const { loadProducts } = await import('./config.ts');
      const all = loadProducts() as any;
      const list: any[] = Array.isArray(all) ? all : Object.values(all);
      for (const r of runs) {
        const prods = r.product ? list.filter((p) => p.id === r.product) : list; // a run with no product: every clone is in use
        for (const p of prods) for (const f of foldersOf(p)) protect.clones.add(f);
      }
    } catch { /* no runs table */ }
  } catch { /* no database: nothing is live */ }
  return protect;
}

/** The ladder with Studio's live protection. */
export async function reclaimNow(o: { all?: boolean; say?: (s: string) => void; why?: string } = {}): Promise<LadderResult> {
  return reclaim({ ...o, protect: await liveProtect(), say: o.say ?? ((s) => console.log(s)) });
}

/**
 * What of the working files Studio can free (ended worktrees, unused clones, temp): the baseline at rest counts only the
 * rest, so a volume full of reclaimable files has a small baseline and a budget with room in it.
 */
export async function reclaimableBytes(): Promise<number> {
  const prot = await liveProtect();
  const work = path.join(PROJECTS, '.work');
  let n = 0;
  try {
    for (const f of fs.readdirSync(work)) {
      if (f.startsWith('.') || f.startsWith('beta') || f === 'memory-export' || prot.work.has(f)) continue;
      n += sizeOf(path.join(work, f));
    }
  } catch { /* none */ }
  try {
    for (const f of fs.readdirSync(PROJECTS)) {
      if (f.startsWith('.') || prot.clones.has(f) || !fs.existsSync(path.join(PROJECTS, f, '.git'))) continue;
      n += sizeOf(path.join(PROJECTS, f));
    }
  } catch { /* none */ }
  n += sizeOf(path.join(PROJECTS, '.trash'));
  return n;
}

/** Measure the baseline at rest: used, less what the ladder can free. */
export async function noteReclaimableBaseline() {
  const d = D.diskInfo();
  return D.noteDiskBaseline(d, Date.now(), await reclaimableBytes().catch(() => 0));
}
