// Starting a stopped GPU server for an agent change with an approved GPU budget (J, 2026-10-18, q_cc094d2d19f8: "Yes,
// start stopped servers (no new launches)"). Agents can't start one (Gen's fleet start needs the owner role, which only
// Studio's own key has), so Studio does it when the change starts: only an existing stopped server, never a launch, at
// most 4 up at once, US regions only; Gen's 60-minute idle stop stays as it is. One start per need, in the PM log and one
// line in Talk. AWS often has no machine free in a stopped server's zone (2026-10-18: both Sick Of It tasks waited 45
// minutes because the one server tried was in a full zone): every other stopped server is tried next, and with none
// startable Studio tries again every few minutes while the change still runs. Never a launch instead.

/** Regions Studio may start a GPU server in (m_82439219e260): US only, cheapest first. */
export const GPU_REGIONS = ['us-west-2', 'us-east-1', 'us-east-2'];
/** At most this many GPU servers up at once, whatever Gen's own setting says. */
export const GPU_CAP = 4;

type Server = { id?: string; region?: string; state?: string; pricePerHour?: number; launched?: string; purpose?: string | null; imageSource?: string | null; disposable?: boolean; boot?: { stage?: string } | null; unfinished?: { resumable?: boolean } | null };

/** A server that takes generation jobs (not the playtester or the builder, not one cleaned to make an image). */
const generator = (s: Server) => !s.purpose && !s.imageSource;
const up = (s: Server) => s.state === 'running' || s.state === 'pending';

/**
 * What to do for a change that needs the GPU: nothing (a server is already up or coming up), start one stopped server
 * (the one whose disk fits the job best), or nothing possible (why). Pure: the fleet list in, the decision out.
 * Preferred, in order: an install that finished (its models are on its disk; a resumable unfinished one would install
 * first), a kept disk over a disposable one, the cheapest region (GPU_REGIONS order), the most recently launched.
 */
export function pickGpuServer(servers: Server[], max = GPU_CAP): { action: 'none'; why: string; id?: string } | { action: 'start'; server: Server; next: Server[] } | { action: 'blocked'; why: string } {
  const running = servers.find((s) => generator(s) && up(s));
  if (running) return { action: 'none', id: running.id, why: `${running.id} (${running.region}) is already ${running.state}` };
  const cap = Math.min(GPU_CAP, max > 0 ? max : GPU_CAP);
  const busy = servers.filter(up).length;
  if (busy >= cap) return { action: 'blocked', why: `${busy} GPU servers are up already (the cap is ${cap})` };
  const can = servers.filter((s) => generator(s) && s.state === 'stopped' && s.id && GPU_REGIONS.includes(s.region ?? '') && !(s.unfinished && !s.unfinished.resumable));
  if (!can.length) return { action: 'blocked', why: 'there is no stopped GPU server in a US region to start (Studio never launches a new one: that is J\'s call)' };
  const rank = (s: Server) => [s.unfinished ? 1 : 0, s.disposable ? 1 : 0, GPU_REGIONS.indexOf(s.region!), -(Date.parse(s.launched ?? '') || 0)];
  const [best, ...next] = can.sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  // The others, in the same order: tried when AWS has no machine free in the best one's zone.
  return { action: 'start', server: best, next };
}

export type GpuDeps = {
  fleet: () => Promise<{ servers?: Server[]; settings?: { servers?: number } }>;
  start: (id: string) => Promise<{ id?: string; region?: string; was?: string; note?: string }>;
  log: (action: string, subject: string | null, product: string | null, detail: string) => void;
  tell: (title: string, text: string) => Promise<void> | void;
  /** Is the change still working on it (worth another try after no capacity)? */
  stillNeeds?: () => boolean | Promise<boolean>;
  wait?: (ms: number) => Promise<void>;
};

/** Another try after no capacity anywhere: every few minutes, for about an hour (the agent waits about 30 minutes). */
export const RETRY_MS = 3 * 60_000;
export const RETRIES = 20;
// Gen's error kinds that another server, or the same one later, may not have.
const RETRYABLE = new Set(['capacity', 'quota']);

async function defaults(c: GpuChange): Promise<GpuDeps> {
  const { gen } = await import('./gen.ts');
  const { logDecision } = await import('./roadmap.ts');
  const { tellAbout } = await import('./followup.ts');
  return {
    fleet: () => gen.fleet(),
    // Always with the id: Gen's start without one launches a new server when nothing is startable.
    start: (id) => gen.fleetAction('start', { id, confirm: true }),
    log: logDecision,
    tell: (title, text) => tellAbout(c, title, text),
    stillNeeds: async () => {
      const { getChange } = await import('./agents.ts');
      return ['queued', 'working', 'revising'].includes(getChange(c.id)?.status ?? '');
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
  };
}

type GpuChange = { id: string; product: string; task?: string | null; title?: string | null; gpu_budget?: string | null; origin?: string | null; status?: string };

/** Does this change have an approved GPU budget (dollars above 0)? */
export const needsGpu = (c: Pick<GpuChange, 'gpu_budget'>) => c.gpu_budget !== null && c.gpu_budget !== undefined && Number(c.gpu_budget) > 0;

// One start at a time across every change: the second need sees the first one's server pending, and starts nothing.
let chain: Promise<unknown> = Promise.resolve();
// The changes already handled (one start per need; a revision of the same change in the next half hour doesn't redo it).
const handled = new Map<string, number>();

/**
 * Makes sure a GPU server is up for an agent change with an approved budget: starts the best stopped one when none is
 * running. Never throws (the agent carries on either way: its brief says to wait for the server). Returns what it did.
 */
export function ensureGpuFor(c: GpuChange, deps?: GpuDeps): Promise<string> {
  if (!needsGpu(c)) return Promise.resolve('no GPU budget');
  const at = handled.get(c.id);
  if (at && Date.now() - at < 30 * 60_000) return Promise.resolve('already handled for this change');
  handled.set(c.id, Date.now());
  return startFor(c, deps).catch((e) => `GPU start failed: ${String(e?.message ?? e).slice(0, 200)}`);
}

/** One try at a time across every change (the lock is held for a try, never for the wait between tries). */
function serial<T>(f: () => Promise<T>): Promise<T> {
  const run = chain.then(f);
  chain = run.catch(() => {});
  return run;
}

async function startFor(c: GpuChange, deps?: GpuDeps): Promise<string> {
  const d = deps ?? await defaults(c);
  const what = c.task ? `${c.task} (${c.id})` : c.id;
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let round = 1; ; round++) {
    const r = await serial(() => tryStart(c, d, round));
    if (r.done) return r.result;
    if (round >= RETRIES) {
      const why = `AWS had no machine free for any stopped GPU server after ${round} tries (${r.result})`;
      d.log('gpu-start-failed', c.task ?? c.id, c.product, `no GPU server started for ${what}: ${why}`);
      await Promise.resolve(d.tell('GPU server not started', `Studio gave up starting a GPU server for ${what}: ${why}. Nothing was launched; a new server is J's call.`)).catch(() => {});
      return why;
    }
    await wait(RETRY_MS);
    if (d.stillNeeds && !(await d.stillNeeds())) return `stopped trying: ${c.id} no longer needs a GPU server (${r.result})`;
  }
}

/** One round: the fleet, then each startable server in order until one starts. `done: false` means try again later. */
async function tryStart(c: GpuChange, d: GpuDeps, round: number): Promise<{ done: boolean; result: string }> {
  const subject = c.task ?? c.id;
  const what = c.task ? `${c.task} (${c.id})` : c.id;
  const budget = `GPU budget $${Number(c.gpu_budget).toFixed(2)}`;
  let fleet;
  try {
    fleet = await d.fleet();
    // Gen answers with no servers and an error when it couldn't list them: not the same as "none stopped".
    if ((fleet as any)?.error) throw new Error((fleet as any).error);
  } catch (e: any) {
    const why = `couldn't read the GPU fleet: ${String(e.message ?? e).slice(0, 200)}`;
    d.log('gpu-start-failed', subject, c.product, `no GPU server started for ${what}: ${why}`);
    await Promise.resolve(d.tell('GPU server not started', `Couldn't start a GPU server for ${what}: ${why}. The agent waits; nothing was launched.`)).catch(() => {});
    return { done: true, result: why };
  }
  const pick = pickGpuServer(fleet.servers ?? [], fleet.settings?.servers ?? GPU_CAP);
  if (pick.action === 'none') return { done: true, result: pick.why };
  if (pick.action === 'blocked') {
    d.log('gpu-start-failed', subject, c.product, `no GPU server started for ${what}: ${pick.why}`);
    await Promise.resolve(d.tell('GPU server not started', `No GPU server started for ${what}: ${pick.why}. The task waits for one; nothing was launched.`)).catch(() => {});
    return { done: true, result: pick.why };
  }
  const misses: string[] = [];
  for (const s of [pick.server, ...pick.next]) {
    try {
      // Always the id (and confirm, in defaults): a start can never become a launch.
      const r = await d.start(s.id!);
      const line = `started GPU server ${s.id} (${s.region}) for ${what}, ${budget}${r?.note ? `: ${r.note}` : ''}`;
      d.log('gpu-start', subject, c.product, `${line}; it stops itself after Gen's idle time${misses.length ? ` (no machine free for ${misses.join(', ')})` : ''}`);
      await Promise.resolve(d.tell('GPU server started', `Studio ${line}.`)).catch(() => {});
      return { done: true, result: line };
    } catch (e: any) {
      const why = String(e.message ?? e).slice(0, 300);
      if (RETRYABLE.has(e?.kind) || /no .* free|capacity/i.test(why)) {
        misses.push(`${s.id} (${s.region})`);
        continue;
      }
      d.log('gpu-start-failed', subject, c.product, `couldn't start GPU server ${s.id} (${s.region}) for ${what}: ${why}`);
      await Promise.resolve(d.tell('GPU server not started', `Couldn't start GPU server ${s.id} (${s.region}) for ${what}: ${why} The task waits; nothing was launched instead.`)).catch(() => {});
      return { done: true, result: why };
    }
  }
  const why = `AWS has no machine free for ${misses.join(', ')}`;
  // Said once, on the first round; the give-up (or the start) is the next line.
  if (round === 1) {
    d.log('gpu-start-waiting', subject, c.product, `no GPU server started yet for ${what}: ${why}; trying again every ${RETRY_MS / 60_000} minutes`);
    await Promise.resolve(d.tell('GPU server not started yet', `No GPU server could start for ${what} (${budget}): ${why}. Studio tries again every ${RETRY_MS / 60_000} minutes while the task runs; nothing is launched.`)).catch(() => {});
  }
  return { done: false, result: why };
}
