// Which commit a deployed project runs (J, 2026-10-30: Studio for web apps with a server and their own beta and live
// lanes, like Hawkes Gen). A project names a path on its own site (Product.versionPath, e.g. /v1/health) that answers
// JSON with its commit: Studio reads it on its beta to record what a playtest played, and on live to know a go-live has
// deployed. The field may be commit, sha, git or gitSha (a full or short hash); `version` alone is kept as the build.
import type { Product } from './config.ts';

export type Deployed = { commit: string | null; version: string | null; at: number };

/** The origin of a lane: its beta address or its live one. */
const originOf = (p: Product, lane: 'beta' | 'live') => {
  const u = lane === 'beta' ? p.beta : p.live;
  try { return u ? new URL(u).origin : null; } catch { return null; }
};

/** What the lane runs, or null when the project has no version address or it can't be read now. */
export async function deployedOf(p: Product, lane: 'beta' | 'live', fetchImpl: typeof fetch = fetch): Promise<Deployed | null> {
  if (!p.versionPath) return null;
  const origin = originOf(p, lane);
  if (!origin) return null;
  try {
    const r = await fetchImpl(`${origin}${p.versionPath}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const pick = (o: any) => o?.commit ?? o?.sha ?? o?.gitSha ?? o?.git ?? null;
    const commit = pick(j) ?? pick(j?.build) ?? null;
    return { commit: commit && /^[0-9a-f]{7,40}$/i.test(String(commit)) ? String(commit).toLowerCase() : null, version: j?.version ? String(j.version) : null, at: Date.now() };
  } catch {
    return null;
  }
}

/** Whether a deployed commit is this one (either may be short). */
export const sameCommit = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};
