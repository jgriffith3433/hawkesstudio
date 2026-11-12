// Playtests always finish (J's roadmap item): a playtest that hangs on a GPU provider, is cut off by a Gen or Studio
// restart, or ends without a verdict is retried once on the next backend, and always says in one plain sentence why it
// ended the way it did. Pure functions; pipeline.ts playScenario uses them around runGenJob.
import { providerOf } from './gpu-breaker.ts';

/** No playtest runs longer than this without a result (30 minutes; STUDIO_PLAYTEST_HARD_MS for tests/operators). */
export const PLAYTEST_HARD_MS = () => Number(process.env.STUDIO_PLAYTEST_HARD_MS ?? 30 * 60_000);
/**
 * A playtest may wait in Gen's queue this long before it starts, when Gen can't say where it stands (the ceiling). A deep
 * queue that moves is not a hang: with Gen's place in line known, the wait is cut only by PLAYTEST_QUEUE_STALL_MS.
 */
export const PLAYTEST_QUEUE_MS = () => Number(process.env.STUDIO_PLAYTEST_QUEUE_MS ?? 45 * 60_000);
/**
 * A queued playtest is cut only when nothing ahead of it moved for this long (20 minutes; J, 2026-11-10: a healthy but
 * deep queue, 20 ahead on 8 tabs, cut at 45 minutes and needed a manual restart). Each look at Gen's line that finds
 * the place moved on restarts the clock.
 */
export const PLAYTEST_QUEUE_STALL_MS = () => Number(process.env.STUDIO_PLAYTEST_QUEUE_STALL_MS ?? 20 * 60_000);
/** The run limit for a playtest job: the scenario's own allowance, never past the hard cap. */
export const cappedRunMs = (scenarioMs: number) => Math.min(scenarioMs, PLAYTEST_HARD_MS());

export type FailureKind = 'provider' | 'restart' | 'disk' | 'beta-restart' | 'queue';
const text = (job: any) => String(job?.error ?? job?.detail ?? '');
/** The wording runGenJob's queue limits end a job with (playtests.ts watchGenJob). */
export const QUEUE_CUT = /the playtest queue didn.t move|waited in the queue for over/;

/** What cut a failed playtest job off, if it is the kind a second try on another backend can get past. */
export function classifyFailure(job: any): { kind: FailureKind; provider: string | null } | null {
  if (!job || job.status === 'done' || job.status === 'cancelled') return null;
  // Shared recovery (gen-recover.ts via runGenJob) already resubmitted a lost/ghost job once: do not try again here.
  if (job.reported || (job.lost && job.retried)) return null;
  const t = text(job);
  // Cut by the queue's own limit (runGenJob): nothing ahead moved, or Gen couldn't say and the ceiling passed. It never
  // says a provider is at fault, so the GPU breaker isn't tripped; the step is tried once more by itself.
  if (QUEUE_CUT.test(t)) return { kind: 'queue', provider: null };
  const provider = providerOf(t) ?? providerOf(job.stuckAt) ?? null;
  if (/no space left|disk (is )?full|ENOSPC|out of disk/i.test(t)) return { kind: 'disk', provider };
  if (/Hawkes Gen (stopped answering|lost job)|gen(\s|-)?restart|interrupted by a restart|job was lost|no such job|worker (was )?(lost|restarted)/i.test(t)) return { kind: 'restart', provider };
  if (/ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ECONNREFUSED|502|503|bad gateway|service unavailable|Studio.*restart/i.test(t) && !/^stuck:/.test(t)) return { kind: 'beta-restart', provider };
  if (/^stuck:/.test(t) || /no free worker|waiting for (a |this )?(machine|worker)|out of credit|timed out/i.test(t)) return { kind: 'provider', provider };
  return null;
}

/** The params for the second try. playtest.run accepts no provider hint (Gen rejects unknown params), so they are the same minus any stale `skipProviders`. */
export function retryParams(params: Record<string, unknown>, _c: { provider: string | null }): Record<string, unknown> {
  const { skipProviders: _skip, ...rest } = params;
  return rest;
}

const WHY: Record<FailureKind, string> = {
  provider: 'a GPU provider had no free worker',
  disk: 'a GPU provider’s machine ran out of disk space',
  restart: 'Hawkes Gen restarted while it played',
  'beta-restart': 'the beta site was restarting while it played',
  queue: 'it waited in Hawkes Gen’s queue and nothing ahead of it moved',
};

/** One plain sentence for a playtest that ended without a verdict (the report, the step, the go-live plan). */
export function plainWhy(job: any, retried: { kind: FailureKind; provider: string | null } | null): string {
  const c = retried ?? classifyFailure(job);
  const t = text(job).replace(/\s+/g, ' ').trim();
  if (!c) return `The playtest ended without a result: ${t.slice(0, 160) || 'Gen gave no reason'}.`;
  const who = c.provider ? ` (${c.provider})` : '';
  return `The playtest could not finish because ${WHY[c.kind]}${who}${retried ? ', and the second try on another backend did not finish either' : ''}.`;
}
