// Room in the region's Cloud Run CPU quota before Studio starts an agent job.
//
// 2026-11-10/11: about 26 job executions (queued Unity builds at 8 vCPU, agent jobs at 2) held us-east4's whole Cloud
// Run CPU quota. Studio's own new revision then never started (00097, 00098: "no instance" for 10 min), the roll went
// back, and the old revision lost its instance too: studio.hawkesgen.ai was down. Studio's server shares that quota
// with every job, and nothing kept a share for it.
//
// Now a start takes its turn here: it goes ahead only if every open job execution in the region (any job: agents, Unity
// builds, Gen's) plus this one leaves RESERVE vCPU free for Studio's own server and the services beside it (a roll
// runs two revisions at once; Gen's services scale too). Otherwise it waits and is woken when room may have come back:
// one of Studio's own jobs ending (cloudjob.ts end / dropJob call cpuFreed), or, since other jobs end without telling
// Studio, a backoff look (1, 2, 4 … 10 min) that runs only while a start is waiting. Starts are admitted one at a
// time, and a start is counted as soon as it is admitted, so two can't both see the same room.
//
// The quota: Google's own value when Studio may read it (quota.ts quotaNow), else STUDIO_CPU_QUOTA, else what Studio
// learned the hard way: the CPU in use when Cloud Run last left one of its jobs unstarted for want of room (noteNoRoom).
// With none of those known, starts are not held (work never stops for a gate that can't see).

// With the jobs in a region (or project) of their own (jobsproject.ts) they share no quota with the server: nothing to
// keep back, and the room is that place's quota (STUDIO_JOBS_CPU_QUOTA, else learned), counted over that place's jobs.
import { jobsApart, jobsPlace } from './jobsproject.ts';

export const RESERVE_VCPU = () => Number(process.env.STUDIO_CPU_RESERVE ?? (jobsApart() ? 0 : 8));
export const AGENT_JOB_VCPU = () => Number(process.env.STUDIO_AGENT_JOB_CPU ?? 2);
const WAIT_MIN_MS = () => Number(process.env.STUDIO_CPU_WAIT_MS ?? 60_000);
const WAIT_MAX_MS = 10 * 60_000;
/** A start waits at most this long, then goes anyway (Cloud Run queues it; JOB_START_MS still guards it). */
export const MAX_HOLD_MS = () => Number(process.env.STUDIO_CPU_MAX_HOLD_MS ?? 2 * 3600_000);

export type Room = { limit: number; used: number; reserve: number; need: number };
/** Whether a start needing `need` vCPU leaves the reserve free (pure: tested). */
export const fits = (r: Room) => r.used + r.need <= r.limit - r.reserve;

let learned: number | null = null;
/** Cloud Run left a job unstarted for want of room while the region's jobs held `used` vCPU: that is the quota, near enough. */
export function noteNoRoom(used: number | null) {
  if (used != null && Number.isFinite(used) && used > 0) learned = learned == null ? used : Math.min(learned, used);
}

export const roomHooks: { limit?: () => Promise<number | null>; used?: () => Promise<number | null>; running?: () => Promise<number | null> } = {};

async function limitNow(): Promise<number | null> {
  if (roomHooks.limit) return roomHooks.limit();
  const env = Number(process.env.STUDIO_JOBS_CPU_QUOTA);
  if (jobsApart() && Number.isFinite(env) && env > 0) return env;
  const p = jobsPlace();
  // Google's value for the jobs' own region (quota.ts reads the server's project; another project's is env or learned).
  const q = jobsApart() && p.project !== (process.env.STUDIO_GCP_PROJECT || '') ? null
    : await import('./quota.ts').then((Q) => Q.quotaNow('cpu', p.region)).catch(() => null);
  if (q?.value) return q.value;
  const set = Number(process.env.STUDIO_CPU_QUOTA);
  return !jobsApart() && Number.isFinite(set) && set > 0 ? set : learned;
}

/** vCPU every open job execution in the region holds or waits for, or null when Studio can't read it. */
export async function usedNow(): Promise<number | null> {
  if (roomHooks.used) return roomHooks.used();
  const { project, region } = jobsPlace();
  if (!project) return null;
  return (await import('./gcp.ts')).regionJobCpu(project, region).then((x) => x.vcpu).catch(() => null);
}

/** vCPU of job tasks running now in the region (what Cloud Run actually granted), or null. */
export async function runningNow(): Promise<number | null> {
  if (roomHooks.running) return roomHooks.running();
  const { project, region } = jobsPlace();
  if (!project) return null;
  return (await import('./gcp.ts')).regionJobCpu(project, region).then((x) => x.running).catch(() => null);
}

/** Cloud Run left one of Studio's jobs unstarted for want of room: learn the quota from what it did grant. */
export async function learnFromNoRoom() { noteNoRoom(await runningNow()); }

let wake: (() => void) | null = null;
/** Room may have come back (one of Studio's jobs ended): a waiting start looks again now. */
export function cpuFreed() { const w = wake; wake = null; w?.(); }

let held: { since: number; used: number; limit: number; reserve: number } | null = null;
/** For the Resources page and /api/health: a start waiting for CPU room, or null. */
export const cpuHold = () => held;

/** Starts admitted lately: counted until Cloud Run's own listing has them (a start takes a while to show there). */
const recent: { at: number; need: number }[] = [];
const SHOW_MS = 2 * 60_000;
const recentCpu = (now = Date.now()) => { while (recent.length && recent[0].at < now - SHOW_MS) recent.shift(); return recent.reduce((a, x) => a + x.need, 0); };

let line: Promise<unknown> = Promise.resolve();
/** A start's turn: resolves when starting `need` vCPU more leaves the reserve free (or the gate can't see). */
export function cpuTurn(need = AGENT_JOB_VCPU()): Promise<void> {
  if (process.env.STUDIO_CPU_ROOM === 'off') return Promise.resolve();
  const mine = line.then(() => admit(need));
  line = mine.catch(() => {});
  return mine;
}

async function admit(need: number) {
  const since = Date.now();
  let wait = WAIT_MIN_MS();
  try {
    for (;;) {
      const [limit, seen] = await Promise.all([limitNow(), usedNow()]);
      if (limit == null || seen == null) return;
      const used = seen + recentCpu();
      const room = { limit, used, reserve: RESERVE_VCPU(), need };
      if (fits(room) || Date.now() - since >= MAX_HOLD_MS()) { recent.push({ at: Date.now(), need }); return; }
      if (!held) console.warn(`[cpuroom] holding an agent job: jobs hold ${used} of ${limit} vCPU, ${room.reserve} kept for Studio's server`);
      held = { since, used, limit, reserve: room.reserve };
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { if (wake === go) wake = null; resolve(); }, wait);
        const go = () => { clearTimeout(t); resolve(); };
        wake = go;
      });
      wait = Math.min(WAIT_MAX_MS, wait * 2);
    }
  } finally {
    held = null;
  }
}

/** Tests. */
export function resetCpuRoom() { learned = null; held = null; wake = null; line = Promise.resolve(); recent.length = 0; delete roomHooks.limit; delete roomHooks.used; delete roomHooks.running; }
