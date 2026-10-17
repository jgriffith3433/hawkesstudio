// The library tab's server side: Hawkes Gen's library (entities, slots, versions: hawkesgen/docs/library.md) for every
// product, reviewed here, and picks written into the product's repo.
//
//   /api/gen/v1/...          Gen's API for the dashboard's web components (hawkesgen-ui.mjs), with Studio's own access
//                            (the key, when Gen isn't on this machine); files, Range requests and the event stream pass through
//   GET  /api/library/waiting  per product: entities with takes nobody has picked yet
//   POST /api/library/writeback { entity }  the entity's current versions into the product's beta working copy, using the
//                            product's hawkes.library.json, then committed and pushed to beta (devtools' flushDev)
//
// A product's mapping can point outside its repo (DoD's AllTheCharacters): those picks are written by the product's own
// tools (DoD's Library tab), not here, and the answer says so.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gen } from './gen.ts';
import { getProduct, loadProducts, StudioError, type Product } from './config.ts';
import { ensureWorkingCopy, flushDev } from './dev.ts';
// @ts-ignore: plain JS module (a copy of hawkesgen/clients/js/hawkesgen-folders.mjs, synced by hawkesgen-sdk)
import { loadMapping, exportFolders } from './hawkesgen-folders.mjs';

/** Forwards /api/gen/v1/* to Gen. */
export function relay(req: IncomingMessage, res: ServerResponse, rest: string) {
  const target = new URL(`/v1/${rest}`, gen.url);
  const headers: Record<string, string> = {};
  for (const k of ['content-type', 'x-filename', 'accept', 'range', 'x-hawkes-client']) {
    const v = req.headers[k];
    if (typeof v === 'string') headers[k] = v;
  }
  if (gen.key) headers.authorization = `Bearer ${gen.key}`;
  return new Promise<void>((resolve) => {
    const up = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, Object.fromEntries(Object.entries(r.headers).filter(([k]) => !['transfer-encoding', 'connection'].includes(k))) as any);
      r.pipe(res);
      r.on('end', () => resolve());
    });
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Hawkes Gen: ${e.message}` }));
      }
      resolve();
    });
    // The browser left (an event stream closed): stop asking Gen.
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
}

/** Per product: entities with takes waiting for a pick (newest first). Products Gen doesn't know are left out. */
export async function waiting() {
  const out: { product: string; name: string; entities: { id: string; name: string; kind: string; takes: number; slots: string[]; updated: number }[] }[] = [];
  for (const p of loadProducts()) {
    const r = await gen.entities({ project: p.id, limit: 500 }).catch(() => null);
    if (!r) continue;
    const entities = r.items
      .map((e: any) => {
        const slots = Object.entries<any>(e.slots ?? {}).filter(([, s]) => s.takes > 0).map(([k]) => k);
        return { id: e.id, name: e.name, kind: e.kind, takes: Object.values<any>(e.slots ?? {}).reduce((n, s) => n + (s.takes ?? 0), 0), slots, updated: e.updated };
      })
      .filter((e: any) => e.takes > 0)
      .sort((a: any, b: any) => b.updated - a.updated);
    if (entities.length || r.total) out.push({ product: p.id, name: p.name, entities });
  }
  return { products: out };
}

/** The product's mapping file in a checkout, or null. */
export function mappingIn(dir: string) {
  const f = ['hawkes.content.json', 'hawkes.library.json'].map((n) => path.join(dir, n)).find((x) => fs.existsSync(x));
  if (!f) return null;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  // hawkes.content.json keeps the mapping under "library"; hawkes.library.json is the mapping.
  if (path.basename(f) === 'hawkes.content.json') {
    if (!raw.library) return null;
    const tmp = path.join(dir, '.hawkes-library.tmp.json');
    fs.writeFileSync(tmp, JSON.stringify(raw.library));
    try {
      return loadMapping(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return loadMapping(f);
}

/** Whether a mapping's folders are inside the repo checkout (so Studio may commit them). */
export const insideRepo = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(root));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Writes an entity's picks into its product's beta and pushes it. */
export async function writeBack(entityId: string, { by = 'J' }: { by?: string } = {}) {
  const [project] = String(entityId).split('/');
  let p: Product;
  try {
    p = getProduct(project);
  } catch {
    throw new StudioError(`No product ${project}`, 404);
  }
  const dir = await ensureWorkingCopy(p);
  const m = mappingIn(dir);
  if (!m) return { product: p.id, skipped: `${p.name} has no hawkes.library.json: its picks stay in the library` };
  if (!insideRepo(dir, m.root)) return { product: p.id, skipped: `${p.name}'s folders (${path.basename(m.root)}) are outside its repo: its own tools write them` };
  const e = await gen.entity(entityId);
  const report = await exportFolders(gen, m, { only: e.data?.folder ?? e.name });
  const written = report.filter((r: any) => r.action === 'written');
  if (!written.length) return { product: p.id, written: 0, nothing: true };
  const r = await flushDev(p.id, `library: ${e.name}, picked by ${by}`);
  return { product: p.id, written: written.length, files: written.map((x: any) => x.file), ...r };
}
