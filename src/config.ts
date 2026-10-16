// Paths, settings and the product list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Every project lives next to Studio: C:\Projects. STUDIO_PROJECTS and STUDIO_DATA move them (tests use temp folders). */
export const PROJECTS = process.env.STUDIO_PROJECTS ? path.resolve(process.env.STUDIO_PROJECTS) : path.resolve(ROOT, '..');
export const DATA = process.env.STUDIO_DATA ? path.resolve(process.env.STUDIO_DATA) : path.join(ROOT, '.data');
export const PORT = Number(process.env.STUDIO_PORT) || 8791;
export const GEN_URL = process.env.HAWKESGEN_URL || 'http://127.0.0.1:8790';
/** Where browsers reach Hawkes Gen (screenshots, videos): the public address on the server, else the same as GEN_URL. */
export const GEN_PUBLIC_URL = process.env.GEN_PUBLIC_URL || GEN_URL;

export const paths = {
  db: path.join(DATA, 'studio.db'),
  logs: path.join(DATA, 'logs'),
  reports: path.join(ROOT, 'reports'),
  dashboard: path.join(ROOT, 'dashboard'),
  /** STUDIO_PRODUCTS points at another products file (tests use a fixture). */
  products: process.env.STUDIO_PRODUCTS || path.join(ROOT, 'products.json'),
};
for (const d of [DATA, paths.logs, paths.reports]) fs.mkdirSync(d, { recursive: true });

/** device "phone": a 390x844 touch phone (the review also judges touch controls, text size and layout). */
export type Playtest = { scenario?: string; mode?: 'auto' | 'contract' | 'generic' | 'site'; where: 'local' | 'live'; device?: 'desktop' | 'phone'; daily?: boolean; timeout?: number; seed?: number; options?: Record<string, unknown> };

export type Product = {
  id: string;
  name: string;
  framing: string;
  engine: 'web' | 'unity' | 'static';
  repo: string;
  site: string;
  live: string;
  local: { serve: 'npm' | 'static'; dir: string; port: number; path: string };
  /** Unity: the project, its website folder, the batch deploy method, and test platforms to run on the build server when the source changes. */
  build?: { project: string; site: string; method: string; tests?: ('EditMode' | 'PlayMode')[] };
  /** The product implements the playtest contract (docs/playtest.md): playtests wait for it instead of falling back to a generic smoke test. */
  contract?: boolean;
  checks?: { dir: string; cmd: string }[];
  deploy?: { prebuild?: string };
  /**
   * Developing on beta (dev.ts): front = the /dev/ front door's port (Caddy sends https://<sub>.<domain>/dev/* there),
   * port = the dev server's port (web products; Unity products have none), path = the devtools page under /dev/,
   * env = extra environment for the dev server (${PROJECTS} is replaced).
   */
  dev?: { front: number; port?: number; path?: string; env?: Record<string, string> };
  playtests: Playtest[];
  story: string[];
  about: string;
  /**
   * The quality bar: what "done" means for this product, in a few sentences. Reviews judge against it; once a full
   * review says the build meets it, the daily review of that scenario is regression-only until the build changes
   * meaningfully (review.ts). Unset: no bar (full daily reviews, still capped).
   */
  quality?: string;
};

export function loadProducts(): Product[] {
  return JSON.parse(fs.readFileSync(paths.products, 'utf8')).products;
}

export function getProduct(id: string): Product {
  const p = loadProducts().find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!p) throw new StudioError(`No product "${id}". Products: ${loadProducts().map((x) => x.id).join(', ')}`, 404);
  return p;
}

/**
 * Hawkes Studio and Hawkes Gen as agent targets (products.json "infra"): not products (no playtests, no beta lane).
 * An agent change is a pull request into main; main deploys itself to the control server once CI passes.
 * smoke: how agents.ts starts the changed service on a spare port for its smoke check (portEnv/dataEnv point it at
 * that port and a scratch data folder; health must answer { ok: true }; scripts are node --check'ed).
 */
export type Infra = {
  id: string;
  name: string;
  repo: string;
  slug: string;
  about: string;
  checks: string[];
  smoke: { start: string; portEnv: string; dataEnv: string; health: string; scripts: string; env?: Record<string, string> };
};

export function loadInfra(): Infra[] {
  return JSON.parse(fs.readFileSync(paths.products, 'utf8')).infra ?? [];
}
export const isInfra = (id: string) => loadInfra().some((x) => x.id === id);
export function getInfra(id: string): Infra {
  const t = loadInfra().find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!t) throw new StudioError(`No infra target "${id}"`, 404);
  return t;
}

export const localUrl = (p: Product) => `http://localhost:${p.local.port}${p.local.path}`;
export const abs = (rel: string) => path.join(PROJECTS, rel);

/** The product's story doc(s), trimmed for prompts. */
export function storyOf(p: Product, max = 12000) {
  let out = '';
  for (const rel of p.story) {
    try {
      out += `--- ${rel}\n${fs.readFileSync(abs(rel), 'utf8')}\n`;
    } catch {
      // A missing doc just isn't included.
    }
  }
  return out.slice(0, max);
}

export class StudioError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
