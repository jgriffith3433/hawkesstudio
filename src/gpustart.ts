// Starting a stopped GPU server for an agent change with an approved GPU budget (J, 2026-10-18, q_cc094d2d19f8: "Yes,
// start stopped servers (no new launches)"). Agents can't start one (Gen's fleet start needs the owner role, which only
// Studio's own key has), so Studio does it when the change starts: only an existing stopped server, never a launch, at
// most 4 up at once, US regions only; Gen's 60-minute idle stop stays as it is. One start per need, in the PM log and one
// line in Talk. AWS often has no machine free in a stopped server's zone (2026-10-18: both Sick Of It tasks waited 45
// minutes because the one server tried was in a full zone; later that day 6 of 7 starts failed on one us-east-1c server
// while a us-east-2 one sat stopped): every other stopped server is tried next, other zones and regions first, a region
// whose GPU quota is full skipped until the next round; with none startable Studio tries again with backoff for about 45
// minutes while the change still needs it (one PM-log line per round, one Talk line for the start or the give-up).
// Never a launch instead.

/** Regions Studio may start a GPU server in (m_82439219e260): US only, cheapest first. */
export const GPU_REGIONS = ['us-west-2', 'us-east-1', 'us-east-2'];
/** At most this many GPU servers up at once, whatever Gen's own setting says. */
export const GPU_CAP = 4;

type Server = { id?: string; region?: string; zone?: string; state?: string; pricePerHour?: number; launched?: string; purpose?: string | null; imageSource?: string | null; disposable?: boolean; boot?: { stage?: string } | null; unfinished?: { resumable?: boolean } | null };

/** A server that takes generation jobs (not the playtester or the builder, not one cleaned to make an image). */
const generator = (s: Server) => !s.purpose && !s.imageSource;
const up = (s: Server) => s.state === 'running' || s.state === 'pending';
/** A generation server is running (booted, taking jobs): a task waiting for GPU can run again (pm.ts). */
export const generatorRunning = (servers: Server[]) => servers.some((s) => generator(s) && s.state === 'running');

type ProviderRow = { id?: string; provider?: string; enabled?: boolean; ready?: boolean; health?: { down?: boolean } | null };
/**
 * A GPU provider with no server to start (RunPod, Modal, Cloud Run, any HTTPS host: Gen's GET /v1/gpu/providers) that is
 * set up and not cooling down: GPU work runs now. Since AWS suspended the account (2026-10-28) the fleet never comes up,
 * so waiting for a fleet server only waited forever and told Talk "AWS_ACCESS_KEY_ID ... not in hawkesgen/.env" every
 * two hours (J, 2026-11-08: "why am I getting these").
 */
export const serverlessReady = (status: { providers?: ProviderRow[] } | null | undefined) =>
  (status?.providers ?? []).find((p) => p.provider !== 'fleet' && p.enabled !== false && p.ready && !p.health?.down) ?? null;

/**
 * Gen's fleet answer says AWS isn't set up at all (no keys, the account suspended, the fleet skipped): there is no
 * server Studio could ever start, and Gen routes GPU jobs to its other providers itself (and fails one at once when
 * none can take it, hawkesgen docs/gpu-providers.md "When no GPU can run a job"). So a task waiting for GPU runs again
 * instead of waiting on the fleet. Studio's own Gen key can't read /v1/gpu/providers (admin only: 403 on live,
 * 2026-11-08), which is why this, not serverlessReady, is what lets the waits go.
 */
export const fleetGone = (error: unknown) => /AWS_ACCESS_KEY_ID|not in hawkesgen\/\.env|no AWS|AWS (account )?(is )?suspended|fleet is skipped|awsRefused/i.test(String(error ?? ''));

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
  /** Gen's GPU providers (GET /v1/gpu/providers): a ready serverless one means nothing needs starting. */
  providers?: () => Promise<{ providers?: ProviderRow[] }>;
  fleet: () => Promise<{ servers?: Server[]; settings?: { servers?: number } }>;
  start: (id: string) => Promise<{ id?: string; region?: string; was?: string; note?: string }>;
  log: (action: string, subject: string | null, product: string | null, detail: string) => void;
  tell: (title: string, text: string) => Promise<void> | void;
  /** Is the change still working on it (worth another try after no capacity)? */
  stillNeeds?: () => boolean | Promise<boolean>;
  wait?: (ms: number) => Promise<void>;
};

/**
 * Another round after no server could start: sooner first, then every 8 minutes, for about 45 minutes in all (J,
 * 2026-10-18: "keep retrying every few minutes (with backoff, up to e.g. 45 minutes)"). The agent waits about 30.
 */
export const retryDelay = (round: number) => [2, 3, 5][round - 1] ?? 8;
export const GIVE_UP_MINUTES = 45;
// Gen's error kinds that another server, or the same one later, may not have.
const RETRYABLE = new Set(['capacity', 'quota']);

async function defaults(c: GpuChange): Promise<GpuDeps> {
  const { gen } = await import('./gen.ts');
  const { logDecision } = await import('./roadmap.ts');
  const { tellAbout } = await import('./followup.ts');
  return {
    providers: () => (gen as any).request('/gpu/providers'),
    fleet: () => gen.fleet(),
    // Always with the id: Gen's start without one launches a new server when nothing is startable.
    start: (id) => gen.fleetAction('start', { id, confirm: true }),
    log: logDecision,
    tell: (title, text) => tellAbout(c, title, text),
    stillNeeds: c.stillNeeds ?? (async () => {
      const { getChange } = await import('./agents.ts');
      return ['queued', 'working', 'revising'].includes(getChange(c.id)?.status ?? '');
    }),
    wait: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
  };
}

/** A change that needs the GPU; stillNeeds overrides "its change is still running" (a task waiting for GPU, pm.ts). */
type GpuChange = { id: string; product: string; task?: string | null; title?: string | null; gpu_budget?: string | null; origin?: string | null; status?: string; stillNeeds?: () => boolean | Promise<boolean> };

/** Does this change have an approved GPU budget (dollars above 0)? */
export const needsGpu = (c: Pick<GpuChange, 'gpu_budget'>) => c.gpu_budget !== null && c.gpu_budget !== undefined && Number(c.gpu_budget) > 0;

// One start at a time across every change: the second need sees the first one's server pending, and starts nothing.
let chain: Promise<unknown> = Promise.resolve();
// The changes already handled (one start per need; a revision of the same change in the next half hour doesn't redo it).
const handled = new Map<string, number>();

/**
 * Makes sure a GPU server is up for an agent change with an approved budget: starts the best stopped one when none is
 * running, and keeps trying (retryDelay) while it still needs one. Never throws (the agent carries on either way: its
 * brief says to wait for the server). Returns what it did. While its tries go on, another call for it does nothing.
 */
export function ensureGpuFor(c: GpuChange, deps?: GpuDeps): Promise<string> {
  if (!needsGpu(c)) return Promise.resolve('no GPU budget');
  if (trying.has(c.id)) return Promise.resolve('already trying for this change');
  const at = handled.get(c.id);
  if (at && Date.now() - at < 30 * 60_000) return Promise.resolve('already handled for this change');
  trying.add(c.id);
  return startFor(c, deps).catch((e) => `GPU start failed: ${String(e?.message ?? e).slice(0, 200)}`)
    .finally(() => { trying.delete(c.id); handled.set(c.id, Date.now()); });
}
// The changes whose tries are going on now.
const trying = new Set<string>();

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
  let waited = 0;
  for (let round = 1; ; round++) {
    const r = await serial(() => tryStart(c, d));
    if (r.done) return r.result;
    if (waited >= GIVE_UP_MINUTES) {
      const why = `no stopped GPU server could start in ${round} rounds over ${waited} minutes (${r.result})`;
      d.log('gpu-start-failed', c.task ?? c.id, c.product, `gave up starting a GPU server for ${what}: ${why}`);
      await Promise.resolve(d.tell('GPU server not started', `Studio gave up starting a GPU server for ${what}: ${why}. Nothing was launched; a new server is J's call.`)).catch(() => {});
      return `gave up: ${why}`;
    }
    const next = retryDelay(round);
    // One line per round in the PM log (not one per server); Talk hears only the start or the give-up.
    d.log('gpu-start-waiting', c.task ?? c.id, c.product, `round ${round}: no GPU server started yet for ${what}: ${r.result}; trying again in ${next} minutes`);
    await wait(next * 60_000);
    waited += next;
    if (d.stillNeeds && !(await d.stillNeeds())) return `stopped trying: ${c.id} no longer needs a GPU server (${r.result})`;
  }
}

/**
 * One round: the fleet, then each startable server until one starts. After a server's zone has no machine free, servers
 * in other zones and regions are tried first; after a region's GPU quota is full, its other servers wait for the next
 * round. Any other error moves on to the next server too. `done: false` means try again later.
 */
async function tryStart(c: GpuChange, d: GpuDeps): Promise<{ done: boolean; result: string }> {
  const subject = c.task ?? c.id;
  const what = c.task ? `${c.task} (${c.id})` : c.id;
  const budget = `GPU budget $${Number(c.gpu_budget).toFixed(2)}`;
  // A serverless provider takes GPU jobs as they come: there is no server to start.
  try {
    const ready = serverlessReady(d.providers ? await d.providers() : null);
    if (ready) return { done: true, result: `already running: ${ready.id} (${ready.provider}) takes GPU jobs, no server to start` };
  } catch { /* Gen couldn't say: the fleet as before */ }
  let fleet;
  try {
    fleet = await d.fleet();
    // Gen answers with no servers and an error when it couldn't list them: not the same as "none stopped".
    if ((fleet as any)?.error) throw new Error((fleet as any).error);
  } catch (e: any) {
    // No AWS at all: GPU work goes through Gen's other providers, nothing to start and nothing to tell J.
    if (fleetGone(e?.message ?? e)) return { done: true, result: 'already running: no AWS fleet, Gen sends GPU jobs to its other providers (RunPod, Modal)' };
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
  const fullZones = new Set<string>();
  const fullRegions = new Set<string>();
  const zoneOf = (s: Server) => s.zone ?? s.region ?? '';
  // 2: its zone was full this round; 1: another zone of its region was; 0: untried.
  const far = (s: Server) => fullZones.has(zoneOf(s)) ? 2 : [...fullZones].some((z) => Boolean(s.region) && z.startsWith(s.region!)) ? 1 : 0;
  let left = [pick.server, ...pick.next];
  while (left.length) {
    // Untried zones and regions first (a stable sort keeps the ranking otherwise).
    left = left.filter((s) => !fullRegions.has(s.region ?? '')).sort((a, b) => far(a) - far(b));
    const s = left.shift();
    if (!s) break;
    try {
      // Always the id (and confirm, in defaults): a start can never become a launch.
      const r = await d.start(s.id!);
      const line = `started GPU server ${s.id} (${s.region}) for ${what}, ${budget}${r?.note ? `: ${r.note}` : ''}`;
      d.log('gpu-start', subject, c.product, `${line}; it stops itself after Gen's idle time${misses.length ? ` (before it: ${misses.join('; ')})` : ''}`);
      await Promise.resolve(d.tell('GPU server started', `Studio ${line}.`)).catch(() => {});
      return { done: true, result: line };
    } catch (e: any) {
      const why = String(e.message ?? e).slice(0, 200);
      const quota = e?.kind === 'quota' || /quota/i.test(why);
      if (quota) fullRegions.add(s.region ?? '');
      else if (RETRYABLE.has(e?.kind) || /no .* free|capacity/i.test(why)) fullZones.add(zoneOf(s));
      misses.push(`${s.id} (${s.zone ?? s.region}): ${quota ? `no GPU quota free in ${s.region}` : why}`);
    }
  }
  return { done: false, result: misses.join('; ') || 'no server to try' };
}
