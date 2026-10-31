// Handing a project over to another Studio (J, 2026-10-31: J's own Studio hands a project to a customer's, cleanly).
// Two sides, for any repo and any pair of Studios:
//   - the Studio that lets go marks the project `managedBy: "<the other Studio's address>"` (products.json or an added
//     game): its daily and beta runs, push hooks, agents and PM leave it alone (config.ts managedElsewhere), it shows
//     as managed elsewhere, and nothing deletes its history.
//   - the Studio that takes it checks where the repo's hook (.github/workflows/hawkes-studio.yml) points: the address
//     and OIDC audience inside it. When that isn't this Studio, its readiness (repokit.ts) offers "Point this repo's hook
//     at this Studio" as a setup step on an Approve card (kind github), which rewrites the workflow with this address.

import { loadProducts, managedElsewhere, type Product } from './config.ts';

const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

/** This Studio's own address (what its hook workflows post to and name as the OIDC audience). */
export const studioAddress = () => (process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.ai').replace(/\/+$/, '');

/** The projects here whose repositories include this owner/name (the main repo, its folder's repo, or one of `repos`). */
export async function projectsOfRepo(slug: string): Promise<Product[]> {
  const s = slug.toLowerCase();
  let map: Record<string, string> = {};
  try { map = (await import('./repos.ts')).repoMap(); } catch { /* a customer's Studio before its first project */ }
  const of = (p: Product) => [p.github, map[p.repo?.split('/')[0] ?? ''], map[p.site?.split('/')[0] ?? ''], ...(p.repos ?? []).map((r) => r.repo)];
  return loadProducts().filter((p) => of(p).some((x) => x && String(x).toLowerCase() === s));
}

/**
 * The other Studio a repo's pushes belong to: every project here with that repo is managed elsewhere. null when any
 * project here still has it (or none does: the hook's other checks answer then).
 */
export async function managedForRepo(slug: string): Promise<string | null> {
  const mine = await projectsOfRepo(slug);
  return mine.length && mine.every((p) => managedElsewhere(p)) ? managedElsewhere(mine[0]) : null;
}

/**
 * Where a hook workflow sends its pushes: the Studio addresses in it (the audience it asks GitHub's OIDC token for and
 * the address it posts to). [] when it names none (not Studio's hook, or written by hand some other way).
 */
export function hookTargets(yml: string): string[] {
  const out = new Set<string>();
  for (const m of yml.matchAll(/audience=([^\s"'&)]+)/g)) if (/^https?:\/\//.test(m[1]) && !m[1].includes('$')) out.add(m[1].replace(/\/+$/, ''));
  for (const m of yml.matchAll(/(https?:\/\/[^\s"'$]+?)\/api\/hooks\/github(?:-beta)?\b/g)) out.add(m[1].replace(/\/+$/, ''));
  // A workflow that keeps the address in a variable (STUDIO: https://...): the value.
  for (const m of yml.matchAll(/^\s*(?:STUDIO|STUDIO_URL|HAWKES_STUDIO)\s*:\s*['"]?(https?:\/\/[^\s'"]+)/gm)) out.add(m[1].replace(/\/+$/, ''));
  return [...out];
}

/** Whether a hook workflow points at this Studio (every address it names is this one). */
export function hookPointsAt(yml: string, base = studioAddress()): { ok: boolean; targets: string[]; elsewhere: string[] } {
  const targets = hookTargets(yml);
  const elsewhere = targets.filter((t) => norm(t) !== norm(base));
  return { ok: targets.length > 0 && !elsewhere.length, targets, elsewhere };
}

/**
 * The same workflow pointed at this Studio: every other Studio address in it replaced with this one (the audience and
 * the address it posts to), everything else as it was. null when it names no Studio address to replace (write Studio's
 * own hook instead).
 */
export function repointHook(yml: string, base = studioAddress()): string | null {
  const { targets, elsewhere } = hookPointsAt(yml, base);
  if (!targets.length) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // One pass over every address (this one included), longest first: one can be a prefix of another (studio.x and
  // studio.x/o/acme), and the longest match at each place wins. Each becomes this Studio's address.
  const all = [...new Set([base, ...elsewhere])].sort((a, b) => b.length - a.length).map(esc).join('|');
  return yml.replace(new RegExp(`(?:${all})(?![\\w.-]*[\\w-])`, 'g'), base);
}
