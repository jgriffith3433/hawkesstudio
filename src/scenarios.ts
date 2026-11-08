// Scenario names that changed in a game (J, 2026-10-19: "We renamed glob to Yooba"). Tasks' changes keep the scenario
// their agent wrote (changes.verify.scenario), and beta and milestone runs play it later, after the game may have
// renamed or dropped it. So before a playtest:
//
// - a name is mapped through the product's alias table (products.json scenarioAliases, e.g. sickofit gloob → yooba);
// - a name the build is known not to have (its own list, from a playtest of the same build: the contract's scenarios(),
//   or Gen's "No scenario "x". This game has: ..." error) is skipped, never played;
// - a playtest that fails only because the game has no such scenario is skipped with one note (the step's detail, in
//   the report) and one PM-log line, never a failed step.
//
// migrateScenarioAliases() renames the stored names on changes once (at start-up; idempotent).

import { db, J, parse } from './db.ts';
import { loadProducts, type Product } from './config.ts';

/** The product's alias table: an old scenario name → its new one. */
export const aliasesOf = (p: Pick<Product, 'scenarioAliases'>): Record<string, string> => p.scenarioAliases ?? {};

/** A scenario name through the product's aliases (chains followed, loops stopped). */
export function resolveScenario(p: Pick<Product, 'scenarioAliases'>, name: string): string {
  const a = aliasesOf(p);
  const seen = new Set([name]);
  let cur = name;
  while (a[cur] && !seen.has(a[cur])) seen.add((cur = a[cur]));
  return cur;
}

/** Gen's playtest error for a scenario the game doesn't have: the name and the game's own list. */
export function missingScenario(error: unknown): { scenario: string; has: string[] } | null {
  const m = /No scenario "([^"]+)"(?: \(peer \d+\))?\. This game has: (.*)$/m.exec(String(error ?? ''));
  if (!m) return null;
  const has = m[2].trim() === 'none' ? [] : m[2].split(',').map((s) => s.trim()).filter(Boolean);
  return { scenario: m[1], has };
}

/** The scenarios each build was seen to have: `${product}:${build}` → ids. */
const seen = new Map<string, string[]>();
/** Keyed by the page too (its address without the query), so a list read at one page never speaks for another. */
const pageOf = (url?: string | null) => { try { const u = new URL(String(url)); return `${u.origin}${u.pathname}`; } catch { return ''; } };
const key = (product: string, build: string, url?: string | null) => `${product}:${build}@${pageOf(url)}`;

/** Records a build's scenario list (Gen's result.scenarios: ids or { id }). */
export function noteScenarios(product: string, build: string | null | undefined, list: unknown, url?: string | null) {
  if (!build || !Array.isArray(list) || !list.length) return;
  const ids = list.map((s: any) => (typeof s === 'string' ? s : s?.id)).filter((s): s is string => typeof s === 'string' && Boolean(s));
  if (ids.length) seen.set(key(product, build, url), ids);
}

/** The scenarios a build is known to have (null: not known yet). */
export const knownScenarios = (product: string, build: string | null | undefined, url?: string | null) => (build ? seen.get(key(product, build, url)) ?? null : null);

/** Forgets every list seen for a product: its beta was (re)published, so the next playtest reads the new page's own. */
export function forgetProductScenarios(product: string) {
  for (const k of [...seen.keys()]) if (k.startsWith(`${product}:`)) seen.delete(k);
}

/** For tests. */
export const forgetScenarios = () => seen.clear();

/**
 * Renames the stored scenarios of changes whose product has aliases (changes.verify.scenario), so new beta and
 * milestone runs ask for the current names. Returns the changes renamed. No changes table yet: nothing.
 */
export function migrateScenarioAliases(products: Pick<Product, 'id' | 'scenarioAliases'>[] = loadProducts()): { id: string; from: string; to: string }[] {
  const out: { id: string; from: string; to: string }[] = [];
  for (const p of products) {
    if (!Object.keys(aliasesOf(p)).length) continue;
    let rows: { id: string; verify: string | null }[];
    try {
      rows = db.prepare(`SELECT id, verify FROM changes WHERE product = ? AND verify LIKE '%"scenario"%'`).all(p.id) as any[];
    } catch {
      return out; // no changes table (agents.ts not loaded)
    }
    for (const r of rows) {
      const v = parse(r.verify);
      if (!v || typeof v.scenario !== 'string') continue;
      const to = resolveScenario(p, v.scenario);
      if (to === v.scenario) continue;
      db.prepare('UPDATE changes SET verify = ? WHERE id = ?').run(J({ ...v, scenario: to }), r.id);
      out.push({ id: r.id, from: v.scenario, to });
    }
  }
  return out;
}
