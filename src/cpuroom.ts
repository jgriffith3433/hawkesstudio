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
// While the jobs' place refuses them and they run beside the server (startInJobsPlace), the gate counts the server's
// region and keeps the reserve there again (startPlace / startsApart).
import { startsApart as jobsApart, startPlace as jobsPlace, serverPlace, spillTo, type Place } from './jobsproject.ts';

export const RESERVE_VCPU = () => Number(process.env.STUDIO_CPU_RESERVE ?? (jobsApart() ? 0 : 8));
export const AGENT_JOB_VCPU = () => Number(process.env.STUDIO_AGENT_JOB_CPU ?? 2);
const WAIT_MIN_MS = () => Number(process.env.STUDIO_CPU_WAIT_MS ?? 60_000);
const WAIT_MAX_MS = 10 * 60_000;
/** A start waits at most this long, then goes anyway (Cloud Run queues it; JOB_START_MS still guards it). */
export const MAX_HOLD_MS = () => Math.min(Number(process.env.STUDIO_CPU_MAX_HOLD_MS ?? 2 * 3600_000), 2 * 3600_000);
/**
 * Where a turn in the line is recorded as a wait of the shared rule (waits.ts, point cpu-turn): agents.ts connects it. This
 * file stays free of the database so the gate can be read and tested alone.
 */
export const cpuWaits: { begin?: (tag: string, waitsOn: string, since: number, deadlineMs: number) => void; end?: (tag: string, how: 'event' | 'deadline') => void } = {};

/**
 * Spill (2026-11-11 stall review: "no single cause may stop all work"): with the jobs in a region of their own, that
 * region full for this long sends one start to run beside the server instead, when the server's region has room for it
 * above SPILL_RESERVE vCPU kept for Studio's own server (a roll runs two revisions). The jobs' region being full then
 * slows work instead of stopping it, and the server is never starved: a full server region holds the start as before.
 */
export const SPILL_AFTER_MS = () => Number(process.env.STUDIO_CPU_SPILL_AFTER_MS ?? 10 * 60_000);
export const SPILL_RESERVE = () => Number(process.env.STUDIO_CPU_SPILL_RESERVE ?? 8);

export type Room = { limit: number; used: number; reserve: number; need: number };
/** Whether a start needing `need` vCPU leaves the reserve free (pure: tested). */
export const fits = (r: Room) => r.used + r.need <= r.limit - r.reserve;

let learned: number | null = null;
/** Cloud Run left a job unstarted for want of room while the region's jobs held `used` vCPU: that is the quota, near enough. */
export function noteNoRoom(used: number | null) {
  if (used != null && Number.isFinite(used) && used > 0) learned = learned == null ? used : Math.min(learned, used);
}

export const roomHooks: { limit?: () => Promise<number | null>; used?: () => Promise<number | null>; running?: () => Promise<number | null>; at?: (p: Place) => Promise<{ limit: number; used: number } | null> } = {};

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

/** Room in another place (the server's, for a spill): its quota and the vCPU its jobs hold, or null when unseen. */
async function roomAt(p: Place): Promise<{ limit: number; used: number } | null> {
  if (roomHooks.at) return roomHooks.at(p);
  if (!p.project) return null;
  const [q, used] = await Promise.all([
    import('./quota.ts').then((Q) => Q.quotaNow('cpu', p.region)).catch(() => null),
    import('./gcp.ts').then((G) => G.regionJobCpu(p.project, p.region)).then((x) => x.vcpu).catch(() => null),
  ]);
  return q?.value && used != null ? { limit: q.value, used } : null;
}
const spilledRecent: { at: number; need: number }[] = [];

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
/** Starts in line for CPU room now, by who asked (the job's unit), with when they asked. */
const inLine = new Map<string, number>();
/**
 * Whether `who` (a job's unit) is in line for CPU room: its pass is waiting its turn, not hung (agents.ts checkStuck,
 * 2026-11-11: a start held for room past the agent step's stall time was taken over as "hung" and, twice, failed).
 */
export const cpuWaiting = (who: string) => inLine.has(who);
/**
 * A start's turn: resolves when starting `need` vCPU more leaves the reserve free (or the gate can't see). The longest
 * hold counts from when the start asked, not from its turn at the front of the line: starts wait one behind another,
 * and counted from the front a line of six could wait twelve hours (the sixth only started counting when the fifth went).
 */
export function cpuTurn(need = AGENT_JOB_VCPU(), who?: string): Promise<void> {
  if (process.env.STUDIO_CPU_ROOM === 'off') return Promise.resolve();
  const asked = Date.now();
  const tag = who ?? `start-${asked}-${Math.random()}`;
  inLine.set(tag, asked);
  // The turn is a wait of the shared rule (waits.ts): what it waits on and its deadline, from when the start asked.
  cpuWaits.begin?.(tag, `room in the region's Cloud Run CPU quota for ${need} vCPU`, asked, MAX_HOLD_MS());
  const mine = line.then(() => admit(need, asked, who)).finally(() => {
    inLine.delete(tag);
    cpuWaits.end?.(tag, Date.now() - asked >= MAX_HOLD_MS() ? 'deadline' : 'event');
  });
  line = mine.catch(() => {});
  return mine;
}

async function admit(need: number, since = Date.now(), who?: string) {
  let wait = WAIT_MIN_MS();
  try {
    for (;;) {
      const [limit, seen] = await Promise.all([limitNow(), usedNow()]);
      if (limit == null || seen == null) return;
      const used = seen + recentCpu();
      const room = { limit, used, reserve: RESERVE_VCPU(), need };
      if (fits(room) || Date.now() - since >= MAX_HOLD_MS()) { recent.push({ at: Date.now(), need }); return; }
      if (who && jobsApart() && Date.now() - since >= SPILL_AFTER_MS()) {
        const server = serverPlace();
        const there = await roomAt(server).catch(() => null);
        const now = Date.now();
        while (spilledRecent.length && spilledRecent[0].at < now - SHOW_MS) spilledRecent.shift();
        const extra = spilledRecent.reduce((a, x) => a + x.need, 0);
        if (there && fits({ limit: there.limit, used: there.used + extra, reserve: SPILL_RESERVE(), need })) {
          spilledRecent.push({ at: now, need });
          spillTo(who, server);
          console.warn(`[cpuroom] the jobs' region has had no room for ${Math.round((now - since) / 60_000)} min: ${who} runs in ${server.region} (${there.used + extra} of ${there.limit} vCPU used there, ${SPILL_RESERVE()} kept for Studio)`);
          return;
        }
      }
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
export function resetCpuRoom() { inLine.clear(); spilledRecent.length = 0; delete roomHooks.at; learned = null; held = null; wake = null; line = Promise.resolve(); recent.length = 0; delete roomHooks.limit; delete roomHooks.used; delete roomHooks.running; }
