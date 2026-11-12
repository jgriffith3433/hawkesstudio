// Shared recovery for Gen jobs Studio waits on (builds, playtests, GPU): when Gen answers that a job is unknown, or a
// job stays queued past a bound while Gen's lane shows free room, Studio resubmits once from the look it already does
// (genWait / watchGenJob), never a new poller or watchdog. A second loss is reported. A job Gen still knows that is
// waiting behind real work is left alone (fromStart / queue waits stay).

/** How long a Gen job may sit queued with free room in its lane before Studio treats it as lost (STUDIO_GEN_QUEUED_GHOST_MS). */
export const QUEUED_GHOST_MS = () => (Number(process.env.STUDIO_GEN_QUEUED_GHOST_MS) > 0 ? Number(process.env.STUDIO_GEN_QUEUED_GHOST_MS) : 15 * 60_000);

/** Gen answered that it has no such job (404 or that wording). */
export function jobUnknown(e: any): boolean {
  return e?.status === 404 || /no such job/i.test(String(e?.message ?? ''));
}

/** The wait's result when Gen no longer has the job (callers resubmit through recoverOnce). */
export function lostResult(id: string, why: string) {
  return { id, status: 'failed', error: `Hawkes Gen lost job ${id} (${why})`, lost: true as const };
}

/** Whether Gen's answer says the job has not started yet (still in its queue, or waiting for a builder). */
export function stillQueued(j: any): boolean {
  if (!j) return false;
  if (String(j.status) === 'queued') return true;
  // Gen can say "running" while it is only waiting for a cloud machine / a free lane slot.
  if (String(j.status) === 'running' && j?.progress?.step) return false;
  return /\bwaiting\b|\bqueued\b|already running|cloud machine/i.test(String(j?.detail ?? j?.progress?.step ?? ''));
}

/**
 * A still-queued job past the bound, while Gen's live list for that tool shows free room: either our job is gone from
 * the list, or nothing of the tool is running (the lane should have taken us). listed null: Gen couldn't say, so we don't
 * guess. A job waiting behind real running work is never a ghost.
 */
export function ghostQueued(job: any, listed: any[] | null, since: number, now = Date.now(), boundMs = QUEUED_GHOST_MS()): boolean {
  if (!stillQueued(job)) return false;
  if (now - since < boundMs) return false;
  if (!listed) return false;
  const id = String(job?.id ?? '');
  if (id && !listed.some((x) => String(x?.id) === id)) return true;
  return listed.filter((x) => String(x?.status) === 'running').length === 0;
}

/** Gen's queued and running jobs of one tool (one look for the ghost check). null when Gen can't answer. */
export async function laneJobs(api: { jobs?(q: Record<string, string>): Promise<any[]> } | null | undefined, tool: string): Promise<any[] | null> {
  if (!api?.jobs || !tool) return null;
  try {
    const queued = ((await api.jobs({ tool, status: 'queued', limit: '50' })) ?? []) as any[];
    const running = ((await api.jobs({ tool, status: 'running', limit: '50' })) ?? []) as any[];
    const seen = new Map<string, any>();
    for (const x of [...queued, ...running]) if (x?.id) seen.set(String(x.id), x);
    return [...seen.values()];
  } catch {
    return null;
  }
}

/**
 * One shared recovery: a wait that ended as lost is submitted again once; if Gen loses that too, it is reported (never
 * another automatic submit). Callers that already resubmitted (job.retried / job.reported) are left alone.
 */
export async function recoverOnce(opts: {
  first: any;
  resubmit: () => Promise<{ id: string }>;
  wait: (id: string) => Promise<any>;
  onSubmit?: (id: string) => void;
  log?: (s: string) => void;
}): Promise<any> {
  const first = opts.first;
  if (!first?.lost || first.retried || first.reported) return first;
  const old = String(first.id ?? '');
  opts.log?.(`Hawkes Gen lost job ${old}: Studio is submitting it again once`);
  const next = await opts.resubmit();
  const id = String(next.id);
  opts.onSubmit?.(id);
  const second = await opts.wait(id);
  if (second?.lost) {
    return {
      ...second,
      id,
      retried: true,
      reported: true,
      error: `${second.error}: Studio already resubmitted once; reporting it`,
    };
  }
  return { ...second, id, retried: true };
}
