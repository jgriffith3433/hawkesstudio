// The page a playtest opens must be the commit the report names (J, 2026-11-09: Imagine Live TV's beta runs said
// "played beta d269309" but played a page from before #121: the commit came from the server's beta checkout, the page
// from the published beta site, which can lag a push).
//
// Every beta page Studio publishes carries the commit it was built from (bugreport.ts injectReport: a
// `data-hawkes='{"sha":"d269309",...}'` attribute on the widget's script). `servedSha` reads it, `servedMismatch`
// compares it with the commit the run is about to report, and the playtest step fails with that sentence instead of
// judging a page that is not the commit. A page that doesn't say (a local dev server, a page not injected) is unknown,
// never a failure.

/** The commit the published page says it was built from (a short or full sha), or null. */
export function servedSha(html: string): string | null {
  const m = /<script[^>]*\bdata-hawkes='([^']*)'/i.exec(html);
  if (!m) return null;
  try {
    const info = JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const sha = String(info?.sha ?? '').toLowerCase();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
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
