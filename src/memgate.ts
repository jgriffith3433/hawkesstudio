// How much memory Studio's machine has left, and whether there is room to start more work.
//
// On 2026-11-10 Studio's cloud server (4 GiB, no swap) was killed for memory seven times in 20 minutes at 12 agents: each
// change's agent, its worktree and its dependency install live in memory (/tmp and /data are in RAM there), and after
// every restart all of them came back at once. Concurrency is a ceiling; this is the floor under it. A new change, a
// resumed one and a second checkout start only while enough is free; the rest wait their turn and start as running work
// finishes (no timers, no polling). One always runs, so nothing waits forever.
import fs from 'node:fs';
import os from 'node:os';

const MB = 1024 * 1024;
const NO_LIMIT = 2 ** 60;

function num(file: string): number | null {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t === 'max') return NO_LIMIT;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function stat(file: string, key: string): number {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
function meminfoAvailable(): number {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return os.freemem();
}

export type MemInfo = { limit: number; available: number };

/** The tests set this. */
export let memSource: (() => MemInfo) | null = null;
export function setMemSource(f: (() => MemInfo) | null) { memSource = f; cached = null; }

/**
 * The machine's (or container's) memory limit and what is still free under it. Page cache that can be dropped counts as
 * free; files in a RAM disk (shmem) don't. Reads a few small /sys and /proc files, cached for half a second.
 */
let cached: { at: number; v: MemInfo } | null = null;
export function memInfo(now = Date.now()): MemInfo {
  if (memSource) return memSource();
  if (cached && now - cached.at < 500) return cached.v;
  let limit = os.totalmem();
  let available = meminfoAvailable();
  // cgroup v2, then v1.
  const v2max = num('/sys/fs/cgroup/memory.max');
  const v1max = v2max === null ? num('/sys/fs/cgroup/memory/memory.limit_in_bytes') : null;
  const cgMax = v2max ?? v1max;
  if (cgMax !== null && cgMax < limit) {
    const used = v2max !== null
      ? (num('/sys/fs/cgroup/memory.current') ?? 0) - stat('/sys/fs/cgroup/memory.stat', 'inactive_file')
      : (num('/sys/fs/cgroup/memory/memory.usage_in_bytes') ?? 0) - stat('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file');
    limit = cgMax;
    available = Math.min(available, Math.max(0, cgMax - Math.max(0, used)));
  }
  const v = { limit, available };
  cached = { at: now, v };
  return v;
}

/** Free memory a new start needs: STUDIO_MEM_RESERVE_MB, else a quarter of the limit and at least 1 GiB (capped at half the limit). */
export function memNeeded(limit = memInfo().limit): number {
  const set = Number(process.env.STUDIO_MEM_RESERVE_MB);
  if (set > 0) return set * MB;
  return Math.min(Math.max(1024 * MB, limit / 4), limit / 2);
}

/** Too little free to start more work now. */
export function memLow(): boolean {
  if (process.env.STUDIO_MEM_GATE === 'off') return false;
  const m = memInfo();
  return m.available < memNeeded(m.limit);
}

/** "1.2 GB free of 4.0 GB" for change details and logs. */
export function memSummary(): string {
  const m = memInfo();
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  return `${gb(m.available)} GB free of ${gb(m.limit)} GB`;
}

/**
 * Waits for room to start: at once when memory isn't low or nothing else is running (busy() is 0); otherwise until some
 * running work ends (memFreed) and there is room. Running work always ends, so this never waits forever.
 */
const waiters: (() => void)[] = [];
export async function memRoom(busy: () => number, onWait?: () => void): Promise<void> {
  let told = false;
  while (busy() > 0 && memLow()) {
    if (!told) { told = true; onWait?.(); }
    await new Promise<void>((r) => waiters.push(r));
  }
}
/** Some work ended: whatever waits for memory looks again. */
export function memFreed() {
  cached = null;
  for (const w of waiters.splice(0)) w();
}
export const memWaiting = () => waiters.length;
