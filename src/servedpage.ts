// The page a playtest opens must be the commit the report names (J, 2026-11-09: Imagine Live TV's beta runs said
// "played beta d269309" but played a page from before #121: the commit came from the server's beta checkout, the page
// from the published beta site, which can lag a push).
//
// Every beta page Studio publishes carries the commit it was built from (bugreport.ts injectReport: the loader
// script's page info, `{"sha":"d269309",...}`; before #369 a `data-hawkes` attribute on the widget's script). `servedSha` reads it, `servedMismatch`
// compares it with the commit the run is about to report, and the playtest step fails with that sentence instead of
// judging a page that is not the commit. A page that doesn't say (a local dev server, a page not injected) is unknown,
// never a failure.

/**
 * What an injected page says about itself (bugreport.ts injectReport): the loader script's second argument since #369
 * (the widget is made after the page's load event), or the older `data-hawkes='{...}'` attribute on the widget's
 * script. Null when the page carries neither.
 */
export function pageInfoOf(html: string): Record<string, any> | null {
  const loader = /<script data-hawkes-loader>[\s\S]*?\}\)\(("(?:[^"\\]|\\.)*"),("(?:[^"\\]|\\.)*")\)<\/script>/i.exec(html);
  try {
    if (loader) return JSON.parse(JSON.parse(loader[2]));
    const m = /<script[^>]*\bdata-hawkes='([^']*)'/i.exec(html);
    return m ? JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&#39;/g, "'").replace(/&amp;/g, '&')) : null;
  } catch {
    return null;
  }
}

/** The commit the published page says it was built from (a short or full sha), or null. */
export function servedSha(html: string): string | null {
  const sha = String(pageInfoOf(html)?.sha ?? '').toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** Whether two shas (short or full) name the same commit. */
export const sameCommit = (a: string, b: string) => {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
};

/** The sentence that fails a playtest whose page is not the commit it would report; null when it matches or can't be told. */
export function servedMismatch(html: string, played: { sha: string; branch?: string } | null, url: string): string | null {
  if (!played) return null;
  const served = servedSha(html);
  if (!served || sameCommit(served, played.sha)) return null;
  return `Not playing the commit it would report: the page at ${url} was published from ${served.slice(0, 7)}, but this run is of ${played.branch ?? 'beta'} ${played.sha.slice(0, 7)}. Its beta site hasn't caught up with the push; it is published again and the next run plays it.`;
}

/** Fetches the page (once, a few seconds) and applies servedMismatch. A page that can't be read is not a mismatch. */
export async function checkServedPage(url: string, played: { sha: string; branch?: string } | null, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!played) return null;
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'hawkes-studio' } });
    if (!r.ok || !/html/i.test(r.headers.get('content-type') ?? '')) return null;
    return servedMismatch((await r.text()).slice(0, 2_000_000), played, url);
  } catch {
    return null;
  }
}

/**
 * A beta playtest of a published site plays what is published, so the published commit must be beta's tip (J,
 * 2026-11-11: PH Origins' beta runs said "beta is up to date (b314db9)" and played a6c1dff, #165, while #166-#170 were
 * merged; their findings started a fixer for a stall #168 had already fixed). When the site is behind, it is published
 * again first (`republish` builds beta's newest commit) and `published` is read once more; if it still differs the
 * verdict is stale: the caller fails the step with `why`, files no findings and starts no fixers from it.
 * Unknown (no tip, or no published commit) is never a failure.
 */
export type PublishedCurrent =
  | { ok: true; republished: boolean; waited?: { before: string; after: string; seconds: number } }
  | { ok: false; why: string; published: string; tip: string; waited?: { before: string; after: string; seconds: number; timedOut: boolean } };

/** How long to wait for a republish: three times the site's last publish (`lastMs`), within 2 to 10 minutes. */
export const publishWaitMs = (lastMs?: number | null) => Math.min(10 * 60_000, Math.max(2 * 60_000, Math.round((lastMs ?? 0) * 3)));

export async function ensurePublishedCurrent(o: { tip: string | null; published: () => string | null | undefined; republish: () => Promise<unknown>; timeoutMs?: number; now?: () => number }): Promise<PublishedCurrent> {
  const behind = () => {
    const pub = o.published();
    return o.tip && pub && !sameCommit(pub, o.tip) ? pub : null;
  };
  const before = behind();
  if (!before) return { ok: true, republished: false };
  const now = o.now ?? Date.now;
  const t0 = now();
  // Awaits the republish itself (the publish job's own promise, or the build already running for the tip), bounded by one
  // timer: no polling.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    o.republish().catch(() => {}).then(() => false),
    new Promise<boolean>((res) => { timer = setTimeout(() => res(true), o.timeoutMs ?? 10 * 60_000); }),
  ]).finally(() => clearTimeout(timer));
  const still = behind();
  const after = (still ?? o.published() ?? o.tip!).toString();
  const seconds = Math.round((now() - t0) / 1000);
  if (!still) return { ok: true, republished: true, waited: { before, after, seconds } };
  return { ok: false, published: still, tip: o.tip!, waited: { before, after, seconds, timedOut }, why: `Stale verdict, not judged: the published beta site is at ${still.slice(0, 7)} but beta is at ${o.tip!.slice(0, 7)}, and ${timedOut ? `publishing it again didn't finish within ${seconds} s` : "publishing it again didn't catch up"}. No findings or fixes come from this run; the next one plays the republished site.` };
}
