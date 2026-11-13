// One source of truth for "can GPU work run now" (J, 2026-11-13: Studio's agent slots sat almost empty for 14 hours while
// ~127 art and audio tasks waited. They were parked on "Gen org credits at 1" and the GPU fleet; once they came back, an
// agent called hawkesgen_fleet, read "AWS_ACCESS_KEY_ID ... not in hawkesgen/.env" as "the GPU fleet is down" and ended
// "paused", although Gen was finishing image, video and music jobs through RunPod and Modal every hour).
//
// The verdict is Studio's, made here once:
//   - gpuRunning(): a serverless provider (RunPod, Modal) is ready, or Gen says there is no AWS fleet at all (its other
//     providers take the work), or an AWS generator server is up
//   - genCredits(): the Studio org's Gen credit balance, when Gen says it
//   - gpuVerdict(task): both, against the task's estimate -> `canRun`, or `blocked` with the park condition that holds it
// pm.ts asks it before an agent starts for a task that generates on the GPU: a blocked task is parked on its condition
// (parks.ts, the `park-condition` wait point) and starts again on the event that ends the park; it never starts an agent
// whose only output would be "still paused". The agent's brief carries the same verdict (agents.ts gpuBrief), so an agent
// never re-decides GPU availability from the fleet tool. Nothing here polls: it is read when a start is considered.

import type { Task } from './roadmap.ts';

export type GpuVia = 'provider' | 'no-aws' | 'fleet' | 'none';
export type GpuVerdict = {
  at: number;
  /** Whether GPU jobs can run now, and how. */
  running: boolean;
  via: GpuVia;
  /** The Studio org's Gen credit balance (null: Gen didn't say) and what the task's estimate needs (null: unknown). */
  credits: number | null;
  need: number | null;
  /** The balance is below what the task needs (or below one job when the need isn't known). */
  short: boolean;
  /** The condition that holds the task, as a park, or null when it may start. */
  blocked: { kind: 'credits' | 'gpu'; detail: string } | null;
  /** The sentence an agent and the log read. */
  line: string;
};

/** Without an estimate in credits, a balance at or below this can't pay for a single generation job (it was 1 on Nov 12-13). */
export const MIN_JOB_CREDITS = 1;

export type GpuDeps = {
  /** Gen's /gpu/providers answer (admin only on some Gens: a failure means "couldn't say"). */
  providers?: () => Promise<any>;
  /** Gen's fleet answer. */
  fleet?: () => Promise<any>;
  /** The Studio org's Gen balance, or null. */
  balance?: () => Promise<number | null>;
};

let seen: { at: number; running: boolean; via: GpuVia } | null = null;
/** Forgets the fleet reading (a GPU server just came up, or a park is being looked at again). */
export const forgetGpuSeen = () => { seen = null; };

/** Whether GPU jobs can run now, read at most every 2 minutes. */
export async function gpuRunning(deps: GpuDeps = {}): Promise<{ running: boolean; via: GpuVia }> {
  if (seen && Date.now() - seen.at < 2 * 60_000) return seen;
  const { serverlessReady, generatorRunning, fleetGone } = await import('./gpustart.ts');
  const gen = deps.providers || deps.fleet ? null : (await import('./gen.ts')).gen;
  const providers = deps.providers ?? (() => (gen as any).request('/gpu/providers'));
  const fleet = deps.fleet ?? (() => (gen as any).fleet());
  // RunPod, Modal and the like run GPU jobs with no server to start: one of them ready counts as a GPU server up.
  try {
    if (serverlessReady(await providers())) { seen = { at: Date.now(), running: true, via: 'provider' }; return seen; }
  } catch { /* Gen couldn't say: the fleet as before */ }
  const f: any = await fleet();
  // No AWS at all (the account suspended 2026-10-28): Gen's other providers take the GPU work, so the waits run now.
  const r = f?.error
    ? { running: fleetGone(f.error), via: (fleetGone(f.error) ? 'no-aws' : 'none') as GpuVia }
    : generatorRunning(f?.servers ?? []) ? { running: true, via: 'fleet' as GpuVia } : { running: false, via: 'none' as GpuVia };
  seen = { at: Date.now(), ...r };
  return seen;
}

/** The Studio org's Gen credit balance, or null when Gen doesn't say (then only a recorded refusal holds work: creditwait.ts). */
export async function genCredits(): Promise<number | null> {
  try {
    const { gen } = await import('./gen.ts');
    const me: any = await (gen as any).request('/me');
    for (const v of [me?.credits, me?.credits?.balance, me?.credits?.left, me?.balance, me?.credits_left, me?.org?.credits]) {
      const n = Number(v);
      if (v !== null && v !== undefined && v !== '' && Number.isFinite(n)) return n;
    }
  } catch { /* Gen couldn't say */ }
  return null;
}

/** Credits a task's GPU estimate needs, when Gen priced it in credits. */
export const creditsNeeded = (t: Pick<Task, 'gpu'>): number | null => {
  const c = Number((t.gpu?.estimate as any)?.credits);
  return Number.isFinite(c) && c > 0 ? c : null;
};

let last: GpuVerdict | null = null;
/** The newest verdict (for a brief, which is written without waiting), or null if none was made yet. */
export const lastGpuVerdict = () => last;
export const forgetGpuVerdict = () => { last = null; seen = null; };

/** Whether a task that generates on the GPU can start an agent now: GPU able to run and the credits cover its estimate. */
export async function gpuVerdict(t: Pick<Task, 'gpu'>, deps: GpuDeps = {}): Promise<GpuVerdict> {
  const g = await gpuRunning(deps).catch(() => ({ running: false, via: 'none' as GpuVia }));
  const credits = await (deps.balance ?? genCredits)().catch(() => null);
  const need = creditsNeeded(t);
  const short = credits !== null && (need !== null ? credits < need : credits <= MIN_JOB_CREDITS);
  const how = g.via === 'provider' ? "a serverless provider (RunPod, Modal) is ready and takes GPU jobs"
    : g.via === 'no-aws' ? 'no AWS fleet is set up, and Gen sends GPU jobs to its other providers (RunPod, Modal)'
    : g.via === 'fleet' ? 'an AWS GPU server is running' : 'no GPU server or provider is ready';
  const money = credits === null ? "the Studio org's Gen credit balance is unknown" : `the Studio org has ${credits} Gen credits${need !== null ? ` (this task needs about ${need})` : ''}`;
  let blocked: GpuVerdict['blocked'] = null;
  if (short) blocked = { kind: 'credits', detail: `Gen credits are too low: ${money}` };
  else if (!g.running) blocked = { kind: 'gpu', detail: `a GPU that can take the job: ${how}` };
  const line = blocked
    ? `GPU work can NOT run now: ${blocked.detail}. Studio holds the task and starts it when that clears.`
    : `GPU work can run now: ${how}; ${money}.`;
  last = { at: Date.now(), running: g.running, via: g.via, credits, need, short, blocked, line };
  return last;
}
