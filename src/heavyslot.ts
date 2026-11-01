/**
 * One heavy job at a time in a Studio on Cloud Run: downloading a build's output, unpacking it, and publishing a beta
 * site (its GitHub tarball included). Cloud Run's disk is the instance's memory, so each of these holds its whole size
 * in RAM. On 2026-11-01 several products' beta sites and builds published at once and went over a customer's Studio's
 * 2 GiB: the container was killed for memory every few minutes (19:44 to 20:29 UTC), each new instance resumed the same
 * runs and was killed again until the restart limit stopped them. The per-product queues (previews.ts) never limited
 * across products. Off Cloud Run there's no limit; STUDIO_HEAVY_SLOTS sets one anywhere.
 */
const limit = () => {
  const n = Number(process.env.STUDIO_HEAVY_SLOTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : process.env.K_SERVICE ? 1 : Infinity;
};

let used = 0;
const waiting: (() => void)[] = [];

/** Takes a slot (waiting in line for one) and returns its release, which is safe to call more than once. */
export async function heavySlot(say?: (s: string) => void): Promise<() => void> {
  if (used < limit()) used++;
  else {
    say?.('waiting for another build download or site publish to finish (one at a time, so Studio stays within its memory)');
    await new Promise<void>((ok) => waiting.push(ok)); // the releaser hands its slot straight over
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const next = waiting.shift();
    if (next) next();
    else used--;
  };
}

/** Runs fn holding a slot. */
export async function heavy<T>(fn: () => Promise<T>, say?: (s: string) => void): Promise<T> {
  const release = await heavySlot(say);
  try { return await fn(); } finally { release(); }
}

export const heavyState = () => ({ used, waiting: waiting.length, limit: limit() });
