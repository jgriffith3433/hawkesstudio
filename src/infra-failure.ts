// Failures of Studio's own machinery around an agent (J, 2026-11-02: the day's 8 starts were burned by retry loops of
// clones killed for memory, resumes of sessions that were gone and shells that refused git, before any agent ran).
// None of them is the agent's try, and none uses one of the PM's starts a day: a start counts only when an agent ran.
// Pure and import-free: agents.ts, pm.ts and roadmap.ts all read it (as JS and, below, as SQL).

/** Lower-case phrases that say Studio, not the agent, failed (git, the checkout, the resume, the shell around the agent). */
export const INFRA_PHRASES = [
  'sigkill', 'signal 9', 'by signal', 'out of memory',
  'no space left', 'enospc', 'disk full',
  'could not read username', 'terminal prompts disabled', 'authentication failed for',
  "couldn't clone", 'clone failed', 'checkout failed', 'sparse checkout', 'half-made clone',
  'worktree failed', 'could not lock',
  'git: command not found', 'git not found', 'spawn git enoent', 'enoent: git',
  'no conversation found',
  'prepare failed', 'prepare error',
  'git add', 'git commit',
];
// "git add"/"git commit" are infra only when the shell refused them (the content role's sandbox did, 2026-11-02).
const NEEDS_REFUSAL = new Set(['git add', 'git commit']);
const REFUSAL = /(refus|denied|not allowed|not permitted|blocked|permission)/i;

/** Whether a change's failure text is Studio's machinery failing, not the agent. */
export function isInfraText(text: unknown): boolean {
  const s = String(text ?? '').toLowerCase();
  if (!s) return false;
  return INFRA_PHRASES.some((p) => s.includes(p) && (!NEEDS_REFUSAL.has(p) || REFUSAL.test(s)));
}

/**
 * Studio's failure around a change: the step it failed at was Studio's (work()'s catch sets `failed` in the phase), or its
 * detail reads as one of the phrases above. Never a change that finished with a commit or a summary of the agent's own.
 */
export function infraFailed(c: { status: string; phase?: unknown; detail?: unknown }, parse: (s: string) => any = (s) => { try { return JSON.parse(s); } catch { return null; } }): boolean {
  if (c.status !== 'failed') return false;
  const phase = typeof c.phase === 'string' ? parse(c.phase) : (c.phase as any);
  if (phase?.failed) return true;
  return isInfraText(c.detail);
}

const like = (p: string) => `LOWER(COALESCE(detail, '')) LIKE '%${p.replace(/'/g, "''")}%'`;
/** The same test on the changes table (columns status, phase, detail). */
export const INFRA_FAILED_SQL = `(status = 'failed' AND (COALESCE(phase, '') LIKE '%"failed":true%' OR ${INFRA_PHRASES.filter((p) => !NEEDS_REFUSAL.has(p)).map(like).join(' OR ')}))`;

/** Wait before the next attempt after `n` Studio failures in a row (10 minutes, doubling, at most 4 hours). */
export const INFRA_BASE_WAIT_MS = 10 * 60_000;
export const infraWaitMs = (n: number) => (n <= 0 ? 0 : Math.min(4 * 3600_000, INFRA_BASE_WAIT_MS * 2 ** (n - 1)));

/** One finding may start at most this many agents a day (retry loops used to eat the day's starts). */
export const MAX_FINDING_STARTS_PER_DAY = 2;
