// Findings -> library entities: a playtest finding that names a character, prop or stage ("Warrok's bow clips
// through the piano", "Spider Bot's side view is a person") is linked to that entity in Hawkes Gen's library, so Talk,
// the dashboard and the agent fixing it can go straight to the art: its versions, a revise with feedback, a judge.
//
// Worked out when findings are read (nothing stored): an entity is named when its name (or its slug as words) appears
// in the finding's title, area or detail as whole words. The product's entity list comes from Gen, cached a few minutes.

import { gen } from './gen.ts';

type Ent = { id: string; name: string; kind: string; words: RegExp[] };
const cache = new Map<string, { at: number; list: Ent[] }>();
const TTL = 5 * 60_000;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole words, any spacing or dashes between them: "Spider Bot", "spider-bot", "spiderbot" all match spider-bot. */
export const phrase = (s: string) => {
  const parts = String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(`\\b${parts.map(esc).join('[\\s_-]*')}\\b`, 'i');
};

/** Names too generic to mean an entity on their own. */
const GENERIC = new Set(['start', 'direction', 'gate', 'fog', 'knock', 'truck', 'hero', 'model', 'page', 'level', 'the', 'ai']);

export async function entitiesOf(product: string): Promise<Ent[]> {
  const hit = cache.get(product);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  const r = await gen.entities({ project: product, limit: 500 }).catch(() => null);
  const list: Ent[] = (r?.items ?? []).map((e: any) => ({
    id: e.id, name: e.name, kind: e.kind,
    words: [...new Set([e.name, e.slug])].filter((n) => n && !GENERIC.has(String(n).toLowerCase())).map(phrase).filter(Boolean) as RegExp[],
  }));
  cache.set(product, { at: Date.now(), list });
  return list;
}

/** The entities a finding names. */
export function namedIn(f: { title?: string | null; area?: string | null; detail?: string | null }, ents: Ent[]) {
  const text = [f.title, f.area, f.detail].filter(Boolean).join(' \n ');
  return ents.filter((e) => e.words.some((w) => w.test(text))).map((e) => ({ id: e.id, name: e.name, kind: e.kind }));
}

/** Adds entities: [{ id, name, kind }] to each finding. */
export async function withEntities<T extends { product: string; title?: string | null; area?: string | null; detail?: string | null }>(findings: T[]) {
  const byProduct = new Map<string, Ent[]>();
  for (const p of new Set(findings.map((f) => f.product))) byProduct.set(p, await entitiesOf(p));
  return findings.map((f) => ({ ...f, entities: namedIn(f, byProduct.get(f.product) ?? []) }));
}
