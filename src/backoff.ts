// Retrying a call that failed only because something it leans on was briefly away (Hawkes Gen during a Studio restart,
// Studio itself restarting). No polling loop: each failure schedules its own next try, a few times, then gives up.

/** The waits between tries of a Gen import: 30 s, 2 min, 5 min. */
export const IMPORT_RETRY_MS = [30_000, 2 * 60_000, 5 * 60_000];

/** Whether an error says "try again" (HTTP 429/502/503/504, or Studio not answering at all: status 0). */
export function isTransient(e: any): boolean {
  const s = Number(e?.status);
  return s === 0 || s === 429 || s === 502 || s === 503 || s === 504;
}

/** Runs `fn`; on a transient error waits the next of `waits` and runs it again, then throws the last error. */
export async function retryWithBackoff<T>(fn: () => Promise<T>, { waits = IMPORT_RETRY_MS, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), onRetry }: { waits?: number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (e: any, waitMs: number, n: number) => void } = {}): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (e: any) {
      if (!isTransient(e) || n >= waits.length) throw e;
      onRetry?.(e, waits[n], n + 1);
      await sleep(waits[n]);
    }
  }
}
