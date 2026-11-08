// Playtests always finish (J's roadmap item): a playtest that hangs on a GPU provider, is cut off by a Gen or Studio
// restart, or ends without a verdict is retried once on the next backend, and always says in one plain sentence why it
// ended the way it did. Pure functions; pipeline.ts playScenario uses them around runGenJob.
import { providerOf } from './gpu-breaker.ts';

/** No playtest runs longer than this without a result (30 minutes; STUDIO_PLAYTEST_HARD_MS for tests/operators). */
export const PLAYTEST_HARD_MS = () => Number(process.env.STUDIO_PLAYTEST_HARD_MS ?? 30 * 60_000);
/** A playtest may wait in Gen's queue this long before it starts (other playtests ahead of it are not a hang). */
export const PLAYTEST_QUEUE_MS = () => Number(process.env.STUDIO_PLAYTEST_QUEUE_MS ?? 45 * 60_000);
/** The run limit for a playtest job: the scenario's own allowance, never past the hard cap. */
export const cappedRunMs = (scenarioMs: number) => Math.min(scenarioMs, PLAYTEST_HARD_MS());

export type FailureKind = 'provider' | 'restart' | 'disk' | 'beta-restart';
const text = (job: any) => String(job?.error ?? job?.detail ?? '');

/** What cut a failed playtest job off, if it is the kind a second try on another backend can get past. */
export function classifyFailure(job: any): { kind: FailureKind; provider: string | null } | null {
  if (!job || job.status === 'done' || job.status === 'cancelled') return null;
  const t = text(job);
  const provider = providerOf(t) ?? providerOf(job.stuckAt) ?? null;
  if (/no space left|disk (is )?full|ENOSPC|out of disk/i.test(t)) return { kind: 'disk', provider };
  if (/Hawkes Gen stopped answering|gen(\s|-)?restart|interrupted by a restart|job was lost|worker (was )?(lost|restarted)/i.test(t)) return { kind: 'restart', provider };
  if (/ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ECONNREFUSED|502|503|bad gateway|service unavailable|Studio.*restart/i.test(t) && !/^stuck:/.test(t)) return { kind: 'beta-restart', provider };
  if (/^stuck:/.test(t) || /no free worker|waiting for (a |this )?(machine|worker)|out of credit|timed out/i.test(t)) return { kind: 'provider', provider };
  return null;
}

/** The params for the second try: the provider that failed is skipped (disk-full and stuck ones included). */
export function retryParams(params: Record<string, unknown>, c: { provider: string | null }): Record<string, unknown> {
  const skip = new Set<string>(Array.isArray(params.skipProviders) ? (params.skipProviders as string[]) : []);
  if (c.provider) skip.add(c.provider);
  return { ...params, ...(skip.size ? { skipProviders: [...skip] } : {}) };
}

const WHY: Record<FailureKind, string> = {
  provider: 'a GPU provider had no free worker',
  disk: 'a GPU provider’s machine ran out of disk space',
  restart: 'Hawkes Gen restarted while it played',
  'beta-restart': 'the beta site was restarting while it played',
};

/** One plain sentence for a playtest that ended without a verdict (the report, the step, the go-live plan). */
export function plainWhy(job: any, retried: { kind: FailureKind; provider: string | null } | null): string {
  const c = retried ?? classifyFailure(job);
  const t = text(job).replace(/\s+/g, ' ').trim();
  if (!c) return `The playtest ended without a result: ${t.slice(0, 160) || 'Gen gave no reason'}.`;
  const who = c.provider ? ` (${c.provider})` : '';
  return `The playtest could not finish because ${WHY[c.kind]}${who}${retried ? ', and the second try on another backend did not finish either' : ''}.`;
}
