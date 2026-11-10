// A circuit breaker for the playtest GPU providers (J's backlog, 2026-11-03): when RunPod is out of credit or Modal times
// out, every playtest used to wait 110-300 s before Hawkes Gen fell back to software, and the run was then "inconclusive".
// Now the first software fallback that names a provider opens that provider's breaker for a few minutes. While it is open
// the next playtest goes
// straight to the next backend without touching Gen's saved order, and the problem is told once instead of on every playtest.

export const OPEN_MS = () => Number(process.env.STUDIO_GPU_BREAKER_MS ?? 10 * 60_000);
const PROVIDERS = ['runpod', 'modal'];
const open = new Map<string, { until: number; why: string }>();

/** Which provider a Gen reason blames ("RunPod out of credit", "Modal timed out"), or null. */
export function providerOf(reason: string | null | undefined): string | null {
  const t = String(reason ?? '').toLowerCase();
  return PROVIDERS.find((p) => t.includes(p)) ?? null;
}

/** Opens the breaker for the provider a software fallback blames. Returns true when it was newly opened (tell once). */
export function trip(reason: string | null | undefined, now = Date.now()): { provider: string; fresh: boolean } | null {
  const provider = providerOf(reason);
  if (!provider) return null;
  const was = open.get(provider);
  const fresh = !was || was.until <= now;
  open.set(provider, { until: now + OPEN_MS(), why: String(reason).replace(/\s+/g, ' ').slice(0, 300) });
  return { provider, fresh };
}

/** Providers to skip right now. */
export function down(now = Date.now()): string[] {
  return [...open].filter(([, v]) => v.until > now).map(([k]) => k);
}

/** The provider order with the ones that are down moved last (nothing removed: if all are down, the order stays). */
export function reorder(ids: string[], now = Date.now()): string[] {
  const bad = new Set(down(now));
  return [...ids.filter((i) => !bad.has(i)), ...ids.filter((i) => bad.has(i))];
}

export const reset = () => open.clear();

/**
 * A software run is still worth a review when the game isn't GPU-bound: the product says so (`gpuBound: false`), or it is a
 * web game that still ran at a playable rate in software. Unity, Godot and desktop games, and slow web games, are not.
 */
export function reviewableInSoftware(p: { engine?: string; gpuBound?: boolean }, r: { fps?: { average?: number | null } | null }): boolean {
  if (p.gpuBound === false) return true;
  if (p.gpuBound === true) return false;
  const fps = Number(r.fps?.average);
  return p.engine === 'web' && Number.isFinite(fps) && fps >= 15;
}

