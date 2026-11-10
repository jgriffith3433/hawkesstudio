// Studio paces itself when Hawkes Gen says it is busy (2026-11-10: when Studio's agent queue started moving again, its
// agent jobs took the region's Cloud Run CPU quota that Gen live shares with them; Cloud Run then answered Gen calls with
// 429 "no available instance" and 503 "cpu_allocation quota" for 11 minutes, and Yooba Land's build failed on the first
// busy answer to its submit). Now:
//   - every busy answer from Gen (429, 503) opens a calm window: Retry-After when Gen sends one, else 15 s doubling to
//     5 minutes while busy answers keep coming;
//   - job submits (POST /jobs) wait out the window and go out one at a time, spaced under Gen's 120 a minute;
//   - genRun (gen.ts) retries a busy submit through the window for up to 15 minutes instead of failing the build;
//   - starting an agent's Cloud Run job (cloudjob.ts) waits out the window (up to 5 minutes) and starts are spaced, so a
//     queue that starts moving doesn't take the region's CPU from Gen all at once;
//   - the busy answers of the last hour show in /api/ops, /api/health and the Resources page, so it can't come back quietly.
// Nothing polls: each wait is one timer to the end of the window.

/** A busy answer from Gen or the Cloud Run in front of it: try again later, nothing was done. */
export function isGenBusy(e: unknown): boolean {
  const s = Number((e as any)?.status);
  return s === 429 || s === 503;
}

/** Retry-After of a busy answer in ms (hawkesgen.mjs sets retryAfter in seconds), capped at 10 minutes. */
export function retryAfterMs(e: unknown): number | null {
  const s = Number((e as any)?.retryAfter);
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 10 * 60_000) : null;
}

const FIRST_MS = Number(process.env.STUDIO_GEN_CALM_MS ?? 15_000), MAX_MS = 5 * 60_000;
let calmUntil = 0;
let lastWait = 0;
let lastAt = 0;
const noted = new WeakSet<object>();
const log: { at: number; status: number; path: string }[] = [];

/** Records a busy answer (once per error) and opens or lengthens the calm window. Returns the window's end. */
export function noteGenBusy(e: unknown, path = '', now = Date.now()): number {
  if (!isGenBusy(e)) return calmUntil;
  if (e && typeof e === 'object') {
    if (noted.has(e)) return calmUntil;
    noted.add(e);
  }
  // Busy answers that keep coming (within 2 minutes of the window's end) double the wait; a quiet spell starts over.
  const streak = now - Math.max(lastAt, calmUntil) < 2 * 60_000 && lastWait > 0;
  const wait = retryAfterMs(e) ?? (streak ? Math.min(lastWait * 2, MAX_MS) : FIRST_MS);
  lastWait = wait;
  lastAt = now;
  calmUntil = Math.max(calmUntil, now + wait);
  log.push({ at: now, status: Number((e as any).status), path: String(path).split('?')[0] });
  while (log.length && log[0].at < now - 3600_000) log.shift();
  if (log.length === 1 || log.length % 20 === 0) console.warn(`[gen] Hawkes Gen is busy (HTTP ${(e as any).status} on ${String(path).split('?')[0] || 'a call'}): Studio waits ${Math.round(wait / 1000)} s before sending more (${log.length} busy answers in the last hour)`);
  return calmUntil;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until the calm window is over, or `max` ms. Returns how long it waited. */
export async function genCalm(max = 10 * 60_000): Promise<number> {
  const start = Date.now();
  while (Date.now() < calmUntil && Date.now() - start < max) await sleep(Math.min(calmUntil - Date.now(), max - (Date.now() - start)));
  return Date.now() - start;
}

/** Gap between job submits: 100 a minute, under Gen's limit of 120 a minute for them (src/ratelimit.ts in hawkesgen). */
export const SUBMIT_GAP_MS = () => Number(process.env.STUDIO_GEN_SUBMIT_GAP_MS ?? 600);
let nextSubmit = 0;
/** A job submit's turn: after the calm window, and spaced from the one before. */
export async function submitTurn(): Promise<void> {
  await genCalm();
  const now = Date.now();
  const at = Math.max(now, nextSubmit);
  nextSubmit = at + SUBMIT_GAP_MS();
  if (at > now) await sleep(at - now);
}

/** Gap between starting agents' Cloud Run jobs (STUDIO_JOB_START_GAP_MS; the tests set 0). */
export const JOB_START_GAP_MS = () => Number(process.env.STUDIO_JOB_START_GAP_MS ?? 10_000);
let nextJob = 0;
/** A Cloud Run job start's turn: after the calm window (at most 5 minutes: work never stops for Gen), spaced from the one before. */
export async function jobStartTurn(): Promise<void> {
  await genCalm(5 * 60_000);
  const now = Date.now();
  const at = Math.max(now, nextJob);
  nextJob = at + JOB_START_GAP_MS();
  if (at > now) await sleep(at - now);
}

/** For /api/ops, /api/health and the Resources page. */
export function genBusy(now = Date.now()) {
  const hour = log.filter((x) => x.at > now - 3600_000);
  return { lastHour: hour.length, last: hour.at(-1) ?? null, calmFor: Math.max(0, calmUntil - now) };
}

/** A sentence for the Resources page when Gen was busy in the last hour, else null (pure on its input: tested). */
export function genBusyAttention(b = genBusy()): { level: 'bad' | 'warn'; text: string } | null {
  if (!b.lastHour) return null;
  const mins = b.last ? Math.max(1, Math.round((Date.now() - b.last.at) / 60_000)) : 0;
  return { level: b.lastHour >= 50 ? 'bad' : 'warn', text: `Hawkes Gen answered busy ${b.lastHour} time${b.lastHour === 1 ? '' : 's'} in the last hour (last ${mins} min ago): Studio is pacing its Gen calls and agent starts${b.calmFor ? ` and waits ${Math.ceil(b.calmFor / 1000)} s more` : ''}. Many in a row mean Gen has no room on Cloud Run (the region's CPU quota).` };
}

/** Tests: forget everything. */
export function resetGenPace() {
  calmUntil = 0; lastWait = 0; lastAt = 0; nextSubmit = 0; nextJob = 0; log.length = 0;
}
