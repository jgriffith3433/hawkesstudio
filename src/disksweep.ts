// Keep Cloud Run's in-memory disk from filling the instance's memory.
//
// On 2026-11-10 Studio's live instance was killed with free memory around 100 MB while the writable filesystem (tmpfs,
// counted against the 4 GiB limit) held 2.0 to 2.7 GB. PR 320 logged the biggest folders (`[crashlog] disk holds`); this
// module clears and caps what that readout named: agent worktrees and temp downloads after a change ends, CPU profiles
// and logs by count and size, stale /tmp, and git packs. A write that would push the disk past a safe share of memory
// is refused after one hard sweep (or the write waits behind ensureDiskRoom).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA, PROJECTS } from './config.ts';
import { memInfo } from './memgate.ts';
import { runLight } from './spawner.ts';

const MB = 1024 * 1024;

/** Share of the memory limit the writable disk may hold before Studio sweeps hard and then refuses big writes. */
export const diskShare = () => {
  const n = Number(process.env.STUDIO_DISK_SHARE);
  return Number.isFinite(n) && n > 0.1 && n < 0.95 ? n : 0.45;
};

/** Newest CPU profiles to keep (loopprof.ts also caps; this is the size-aware sweep). */
export const PROFILE_KEEP = () => Math.max(1, Number(process.env.STUDIO_PROFILES_KEEP) || 8);
/** Total bytes of .data/profiles before the oldest are dropped. */
export const PROFILE_MAX_BYTES = () => Math.max(1 * MB, (Number(process.env.STUDIO_PROFILES_MB) || 40) * MB);
/** How long a temp download may sit before the sweep removes it. */
export const TMP_MAX_AGE_MS = () => Math.max(60_000, (Number(process.env.STUDIO_TMP_MAX_MIN) || 30) * 60_000);
/** How often the timer sweeps (brief: at start and on a timer). Off with STUDIO_DISK_SWEEP=off. */
export const SWEEP_EVERY_MS = () => Math.max(60_000, (Number(process.env.STUDIO_DISK_SWEEP_MIN) || 10) * 60_000);

export type DiskInfo = { used: number; free: number; size: number; pct: number; path: string };

/** Used / free on the writable root (Cloud Run: one tmpfs). Pure for tests via diskSource. */
export let diskSource: (() => DiskInfo) | null = null;
export function setDiskSource(f: (() => DiskInfo) | null) { diskSource = f; }

export function diskInfo(dir = PROJECTS): DiskInfo {
  if (diskSource) return diskSource();
  try {
    const s = fs.statfsSync(dir);
    const size = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = size - s.bfree * s.bsize;
    return { used, free, size, pct: size ? Math.round((used / size) * 1000) / 10 : 0, path: dir };
  } catch {
    const size = os.totalmem();
    const free = os.freemem();
    return { used: Math.max(0, size - free), free, size, pct: size ? Math.round(((size - free) / size) * 1000) / 10 : 0, path: dir };
  }
}

/**
 * Whether Studio's working files (PROJECTS: product clones, agents' worktrees, installs) sit on a real disk rather than
 * in RAM. On Cloud Run they used to share the instance's memory, so the disk filled memory within about an hour of a
 * restart and the memory gate idled half the slots (2026-11-10: 5.7 slot-hours). Cells now mount an ephemeral disk at
 * /disk (cellrun.ts CELL_DISK; the entrypoint moves PROJECTS onto it when it is there). On a real disk, room is the
 * disk's own free space and the memory gate no longer counts these files.
 */
const DISK_FS = new Set([0xef53 /* ext2/3/4 */, 0x58465342 /* xfs */, 0x9123683e /* btrfs */]);
export let realDiskSource: (() => boolean) | null = null;
export function setRealDiskSource(f: (() => boolean) | null) { realDiskSource = f; }
export function onRealDisk(dir = PROJECTS): boolean {
  if (realDiskSource) return realDiskSource();
  if (diskSource) return false; // the tests' disk is the in-memory one unless they say otherwise
  try { return DISK_FS.has(Number(fs.statfsSync(dir).type)); } catch { return false; }
}
/** On a real disk: the share of it Studio fills before it sweeps hard. */
export const REAL_DISK_SHARE = 0.85;
/** On a real disk: free space that must stay after a write (512 MB, or 5% of a bigger disk). */
export const realDiskFloor = (size = diskInfo().size) => Math.max(512 * MB, Math.floor(size * 0.05));

/**
 * In memory, but on a sized volume (cellrun.ts CELL_MEMORY_DISK, when Google refuses the disk): smaller than the memory
 * limit, so the volume itself caps what the working files can take and a write past it fails with ENOSPC.
 */
export function onSizedMemoryVolume(limit = memInfo().limit): boolean {
  if (onRealDisk()) return false;
  const d = diskInfo();
  return d.size > 0 && limit > 0 && d.size < limit * 0.9;
}
/** On a sized in-memory volume: room that must stay on it after a write. */
export const MEMORY_VOLUME_FLOOR = 256 * MB;

/** Soft ceiling: on a real disk or a sized in-memory volume, most of it; in RAM, this share of the memory (cgroup) limit. */
export function diskBudget(limit = memInfo().limit): number {
  if (onRealDisk() || onSizedMemoryVolume(limit)) return Math.floor(diskInfo().size * REAL_DISK_SHARE);
  return Math.floor(limit * diskShare());
}

export function diskHigh(need = 0): boolean {
  if (process.env.STUDIO_DISK_SWEEP === 'off') return false;
  const d = diskInfo();
  return d.used + need > diskBudget();
}

/**
 * Memory that must stay free after a write (the disk is RAM on Cloud Run): STUDIO_DISK_FLOOR_MB, else a tenth of the
 * limit and at least 384 MB. Below this the kernel starts killing processes.
 */
export const diskFloor = (limit = memInfo().limit) => {
  const set = Number(process.env.STUDIO_DISK_FLOOR_MB);
  return set > 0 ? set * MB : Math.max(384 * MB, Math.floor(limit / 10));
};

/**
 * Too little memory for a write of `need` bytes. The share budget (diskHigh) only says when to sweep: on 2026-11-10
 * the disk held 2.05 GB at rest (repos, caches) against a 1.72 GB budget with about 1 GB of memory free, so every change
 * waited for disk room for hours and Studio ran one agent. What can kill Studio is memory, so that is what refuses.
 */
export function diskFull(need = 0): boolean {
  if (process.env.STUDIO_DISK_SWEEP === 'off') return false;
  if (onRealDisk()) { const d = diskInfo(); return d.free - need < realDiskFloor(d.size); }
  if (onSizedMemoryVolume() && diskInfo().free - need < MEMORY_VOLUME_FLOOR) return true;
  return memInfo().available - need < diskFloor();
}

/** Room for one worktree (what a change waiting for disk room needs to start): not over budget and not full. */
export const WORKTREE_NEED = 100 * MB;
export function roomForAWorktree(): boolean {
  return !diskHigh(WORKTREE_NEED) || !diskFull(WORKTREE_NEED);
}

export function diskSummary(): string {
  const d = diskInfo();
  const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
  return `${gb(d.used)} GB used of ${gb(d.size)} GB (${d.pct}%; ${onRealDisk() ? 'on disk' : onSizedMemoryVolume() ? 'in a sized memory volume' : 'in memory'}; budget ${gb(diskBudget())} GB; ${gb(memInfo().available)} GB of memory free)`;
}

export type SweepReport = {
  profiles: number; logs: number; tmp: number; worktrees: number; git: number; bytes: number; detail: string[];
};

const emptyReport = (): SweepReport => ({ profiles: 0, logs: 0, tmp: 0, worktrees: 0, git: 0, bytes: 0, detail: [] });

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let n = 0;
    for (const name of fs.readdirSync(p)) n += sizeOf(path.join(p, name));
    return n;
  } catch { return 0; }
}

function rmTree(p: string): number {
  const n = sizeOf(p);
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { return 0; }
  return n;
}

/** Cap .data/profiles by count and total size (newest kept). */
export function sweepProfiles(dir = path.join(DATA, 'profiles'), keep = PROFILE_KEEP(), maxBytes = PROFILE_MAX_BYTES()): { removed: number; bytes: number } {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.cpuprofile')); } catch { return { removed: 0, bytes: 0 }; }
  const rows = names.map((n) => {
    const p = path.join(dir, n);
    try { const st = fs.statSync(p); return { p, mtime: st.mtimeMs, size: st.size }; }
    catch { return { p, mtime: 0, size: 0 }; }
  }).sort((a, b) => b.mtime - a.mtime);
  const keepNames = new Set(capByCountAndSize(rows.map((r, i) => ({ name: String(i), size: r.size, mtime: r.mtime })), keep, maxBytes).map(Number));
  let removed = 0, freed = 0;
  rows.forEach((r, i) => {
    if (keepNames.has(i)) return;
    try { fs.rmSync(r.p, { force: true }); removed++; freed += r.size; } catch { /* gone */ }
  });
  return { removed, bytes: freed };
}

/** Cap rotated text logs under .data/logs (and restarts.jsonl is already capped in crashlog). */
export function sweepLogs(dir = path.join(DATA, 'logs'), keep = 20, maxBytes = 32 * MB): { removed: number; bytes: number } {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return { removed: 0, bytes: 0 }; }
  const rows = names.map((n) => {
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      return { p, mtime: st.mtimeMs, size: st.isFile() ? st.size : sizeOf(p), file: st.isFile() };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b!.mtime - a!.mtime) as { p: string; mtime: number; size: number; file: boolean }[];
  let kept = 0, keptBytes = 0, removed = 0, freed = 0;
  for (const r of rows) {
    if (kept < keep && keptBytes + r.size <= maxBytes) { kept++; keptBytes += r.size; continue; }
    freed += rmTree(r.p);
    removed++;
  }
  return { removed, bytes: freed };
}

/**
 * Stale temp downloads: Studio's hs-build-* folders, leftover /tmp/build trees, and other Studio scratch dirs older
 * than TMP_MAX_AGE_MS. Never touches another process's live cwd.
 */
export function sweepTmp(root = os.tmpdir(), now = Date.now(), maxAge = TMP_MAX_AGE_MS()): { removed: number; bytes: number } {
  let removed = 0, bytes = 0;
  const take = (p: string) => {
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs < maxAge) return;
      bytes += rmTree(p);
      removed++;
    } catch { /* gone */ }
  };
  try {
    for (const n of fs.readdirSync(root)) {
      if (/^hs-build-/.test(n) || /^hs-du-/.test(n) || /^studio-tmp-/.test(n)) take(path.join(root, n));
    }
  } catch { /* no tmp */ }
  const buildRoot = path.join(root, 'build');
  try {
    for (const n of fs.readdirSync(buildRoot)) take(path.join(buildRoot, n));
  } catch { /* none */ }
  return { removed, bytes };
}

/**
 * Agent / scout / revert worktrees that no longer belong to a live change. `keep` is the set of folder names under
 * `.work` that must stay (active change ids, and reserved names). Soft: only terminal-status change folders; hard: any
 * folder not in keep.
 */
export function sweepWorktrees(workDir: string, keep: Set<string>, hard = false): { removed: number; bytes: number } {
  let removed = 0, bytes = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(workDir); } catch { return { removed: 0, bytes: 0 }; }
  for (const n of names) {
    if (n === '.' || n === '..' || n.startsWith('.')) continue;
    if (keep.has(n)) continue;
    // Soft: only clear obvious leftovers (ended change ids, scout-/revert- scratch). Hard: everything not kept.
    if (!hard && !/^c_[0-9a-f]+/.test(n) && !n.startsWith('scout-') && !n.startsWith('revert-') && !n.endsWith('-site') && !n.endsWith('.repos')) continue;
    if (!hard && /^c_[0-9a-f]+/.test(n) && keep.has(n)) continue;
    bytes += rmTree(path.join(workDir, n));
    removed++;
  }
  return { removed, bytes };
}

/** Prune stale worktree records and run git gc --auto in each product clone (best effort, capped). */
export async function pruneGit(repos: string[], timeoutMs = 20_000): Promise<{ repos: number; bytes: number }> {
  let n = 0;
  for (const dir of repos) {
    if (!fs.existsSync(path.join(dir, '.git')) && !fs.existsSync(path.join(dir, 'HEAD'))) continue;
    await runLight('git', ['-c', 'gc.auto=256', 'worktree', 'prune'], { cwd: dir, timeoutMs: Math.min(10_000, timeoutMs) }).catch(() => null);
    await runLight('git', ['-c', 'gc.auto=256', 'gc', '--auto', '--quiet'], { cwd: dir, timeoutMs }).catch(() => null);
    n++;
  }
  return { repos: n, bytes: 0 };
}

/** Live change folder names that must not be swept (queued through ready / waiting). */
export function liveWorkNames(rows: { id: string; worktree?: string | null; status: string }[]): Set<string> {
  const keep = new Set<string>(['beta', 'memory-export']);
  const live = /^(queued|working|revising|verifying|ready|needs answer|waiting on Gen)$/;
  for (const r of rows) {
    if (!live.test(r.status)) continue;
    keep.add(r.id);
    keep.add(`${r.id}-site`);
    keep.add(`${r.id}.repos`);
    if (r.worktree) {
      const base = path.basename(r.worktree);
      if (base) keep.add(base);
      if (base.endsWith('-site')) keep.add(base);
      else keep.add(`${base}-site`);
      keep.add(`${base}.repos`);
    }
  }
  return keep;
}

/**
 * One sweep. soft: profiles, logs, tmp, orphaned ended-change folders. hard (disk already over budget): also drop
 * every `.work` folder not in the live set, and prune git.
 */
export async function sweepDisk(opts: {
  soft?: boolean; hard?: boolean; workDir?: string; keep?: Set<string>;
  repos?: string[]; now?: number; say?: (s: string) => void;
} = {}): Promise<SweepReport> {
  if (process.env.STUDIO_DISK_SWEEP === 'off') return emptyReport();
  const hard = opts.hard === true || (!opts.soft && diskHigh());
  const report = emptyReport();
  const before = diskInfo().used;

  const p = sweepProfiles();
  report.profiles = p.removed; report.bytes += p.bytes;
  if (p.removed) report.detail.push(`profiles -${p.removed} (${Math.round(p.bytes / MB)} MB)`);

  const l = sweepLogs();
  report.logs = l.removed; report.bytes += l.bytes;
  if (l.removed) report.detail.push(`logs -${l.removed} (${Math.round(l.bytes / MB)} MB)`);

  const t = sweepTmp(os.tmpdir(), opts.now);
  report.tmp = t.removed; report.bytes += t.bytes;
  if (t.removed) report.detail.push(`tmp -${t.removed} (${Math.round(t.bytes / MB)} MB)`);

  const work = opts.workDir ?? path.join(PROJECTS, '.work');
  if (opts.keep) {
    const w = sweepWorktrees(work, opts.keep, hard);
    report.worktrees = w.removed; report.bytes += w.bytes;
    if (w.removed) report.detail.push(`worktrees -${w.removed} (${Math.round(w.bytes / MB)} MB)`);
  }

  if (hard && opts.repos?.length) {
    const g = await pruneGit(opts.repos);
    report.git = g.repos;
    if (g.repos) report.detail.push(`git prune in ${g.repos} repo(s)`);
  }

  const freed = Math.max(0, before - diskInfo().used);
  if (freed > MB) report.detail.push(`statfs freed ~${Math.round(freed / MB)} MB`);
  // Waiting changes are told only when the sweep left room for one (a worktree's 100 MB): a sweep that cleared a few
  // MB of logs while the disk stays full would wake them to sweep and fail again, round and round (2026-11-11).
  if ((freed > MB || report.bytes > MB) && roomForAWorktree()) diskFreed(`a ${hard ? 'hard' : 'soft'} sweep freed ~${Math.round(Math.max(freed, report.bytes) / MB)} MB`);
  const line = report.detail.length ? report.detail.join('; ') : 'nothing to clear';
  opts.say?.(`[disksweep] ${hard ? 'hard' : 'soft'}: ${line}; ${diskSummary()}`);
  return report;
}

/**
 * Before a write that needs `need` more bytes: soft sweep if over the budget; if memory can't hold the write, a hard
 * sweep; then throw only if memory still can't hold it (diskFull). Returns the disk summary when it had to sweep.
 */
export async function ensureDiskRoom(need = 0, opts: { keep?: Set<string>; repos?: string[]; say?: (s: string) => void } = {}): Promise<string | null> {
  if (process.env.STUDIO_DISK_SWEEP === 'off' || !diskHigh(need)) return null;
  opts.say?.(`[disksweep] disk high before a write (${diskSummary()}; need ${Math.round(need / MB)} MB): sweeping`);
  await sweepDisk({ soft: true, keep: opts.keep, repos: opts.repos, say: opts.say });
  if (!diskHigh(need)) return diskSummary();
  if (!diskFull(need)) return diskSummary();
  await sweepDisk({ hard: true, keep: opts.keep, repos: opts.repos, say: opts.say });
  if (!diskHigh(need) || !diskFull(need)) return diskSummary();
  throw new Error(`${onRealDisk() ? 'working' : 'in-memory'} disk is full (${diskSummary()}; need ${Math.round(need / MB)} MB more). Cleared profiles, logs, tmp and ended worktrees; free space and try again.`);
}

/** Resolve live keep-set and repo list from Studio's DB (lazy import so tests stay free of agents.ts). */
async function liveContext(): Promise<{ keep: Set<string>; repos: string[] }> {
  try {
    const { db } = await import('./db.ts');
    const rows = db.prepare(`SELECT id, worktree, status FROM changes`).all() as { id: string; worktree: string | null; status: string }[];
    const keep = liveWorkNames(rows);
    try {
      const scouts = db.prepare(`SELECT id FROM scouts WHERE status = 'running'`).all() as { id: string }[];
      for (const s of scouts) keep.add(`scout-${s.id}`);
    } catch { /* no scouts table */ }
    const repos: string[] = [];
    try {
      for (const n of fs.readdirSync(PROJECTS)) {
        if (n === '.work' || n.startsWith('.')) continue;
        const p = path.join(PROJECTS, n);
        if (fs.existsSync(path.join(p, '.git'))) repos.push(p);
      }
    } catch { /* no projects */ }
    return { keep, repos };
  } catch {
    return { keep: new Set(), repos: [] };
  }
}

/** Soft (or hard when already over budget) sweep with Studio's live keep-set. */
export async function sweepNow(opts: { hard?: boolean; say?: (s: string) => void } = {}): Promise<SweepReport> {
  const ctx = await liveContext();
  return sweepDisk({ soft: !opts.hard, hard: opts.hard, keep: ctx.keep, repos: ctx.repos, say: opts.say ?? ((s) => console.log(s)) });
}

/**
 * Remove one change's worktree folder (and its -site / .repos siblings) from disk. Safe only under PROJECTS/.work.
 * Called from agents.ts cleanup so a failed git worktree remove still frees memory.
 */
export function removeChangeDirs(worktree: string): number {
  const work = path.join(PROJECTS, '.work');
  const abs = path.resolve(worktree);
  const rel = path.relative(work, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 0;
  const base = rel.split(/[\\/]/)[0];
  if (!base || base === '.' || base === '..') return 0;
  let bytes = 0;
  for (const name of [base, `${base}-site`, `${base}.repos`]) {
    bytes += rmTree(path.join(work, name));
  }
  try { fs.rmSync(path.join(work, `${base}-site.json`), { force: true }); } catch { /* none */ }
  return bytes;
}

let timer: NodeJS.Timeout | null = null;
let started = false;

/** At start-up and on a timer (Cloud Run or STUDIO_DISK_SWEEP=on). Idempotent. */
/** Who wants to hear that a sweep freed space (agents.ts: changes waiting for disk room try again). */
const freedListeners = new Set<(why: string) => void>();
export function onDiskFreed(f: (why: string) => void) { freedListeners.add(f); return () => void freedListeners.delete(f); }
export function diskFreed(why: string) { for (const f of freedListeners) { try { f(why); } catch { /* a listener's own problem */ } } }

export function startDiskSweep() {
  if (started || process.env.STUDIO_DISK_SWEEP === 'off') return;
  if (!process.env.K_SERVICE && process.env.STUDIO_DISK_SWEEP !== 'on') return;
  started = true;
  const say = (s: string) => console.log(s);
  void sweepNow({ say }).catch((e) => console.warn(`[disksweep] start: ${e?.message ?? e}`));
  timer = setInterval(() => {
    void sweepNow({ say }).catch((e) => console.warn(`[disksweep] timer: ${e?.message ?? e}`));
  }, SWEEP_EVERY_MS());
  timer.unref();
}

/** Sync helper for tests: drop profiles over keep/max without touching the live DATA path. */
export function capByCountAndSize(files: { name: string; size: number; mtime: number }[], keep: number, maxBytes: number): string[] {
  const sorted = [...files].sort((a, b) => b.mtime - a.mtime);
  const kept: string[] = [];
  let bytes = 0;
  for (const f of sorted) {
    if (kept.length >= keep || bytes + f.size > maxBytes) continue;
    kept.push(f.name);
    bytes += f.size;
  }
  return kept;
}

/** Used only by tests that need a tiny synchronous git prune stand-in. */
export function gitPruneSync(dir: string): boolean {
  const r = spawnSync('git', ['worktree', 'prune'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0;
}
