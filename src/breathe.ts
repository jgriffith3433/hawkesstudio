// A loop over every task, change or run gives the event loop room as it goes (2026-11-14: the PM's pass over ~200
// tasks ran as one synchronous stretch, because `await` on a function that finishes without real I/O never lets
// requests, timers or the lease's heartbeat in, so Studio froze for 1-5 s at a time and J couldn't open it).
// forEachBreathing awaits each item, then hands the loop back to Node (setImmediate) whenever BREATH_MS of work has
// gone by since the last time. It is event-driven: nothing waits on a timer and nothing runs that wasn't asked.

/** Most milliseconds of one loop's work between two chances for Studio to answer requests. */
export const BREATH_MS = 15;

/** Hands the event loop back once: queued I/O, timers and requests run, then this resolves. */
export const breathe = () => new Promise<void>((r) => setImmediate(r));

/** Runs fn on each item in order (awaiting it), letting the event loop in at least every BREATH_MS. */
export async function forEachBreathing<T>(items: Iterable<T>, fn: (item: T) => unknown | Promise<unknown>, ms = BREATH_MS): Promise<void> {
  let since = Date.now();
  for (const item of items) {
    await fn(item);
    if (Date.now() - since >= ms) {
      await breathe();
      since = Date.now();
    }
  }
}
