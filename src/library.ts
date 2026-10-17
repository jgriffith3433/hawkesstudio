// The library tab's server side: Hawkes Gen's library (entities, slots, versions: hawkesgen/docs/library.md) for every
// product, reviewed here, and picks written into the product's repo.
//
//   /api/gen/v1/...          Gen's API for the dashboard's web components (hawkesgen-ui.mjs), with Studio's own access
//                            (the key, when Gen isn't on this machine); files, Range requests and the event stream pass through
//   GET  /api/library/waiting  per product: entities with takes nobody has picked yet
//   POST /api/library/writeback { entity }  the entity's current versions into the product's beta working copy, using the
//                            product's hawkes.library.json, then committed and pushed to beta (devtools' flushDev)
//
// A product's mapping can point outside its repo (DoD's AllTheCharacters). When that folder is one hawkes-assets tracks
// (its mounts.json), the pick is written there on this machine, uploaded to S3 and recorded in hawkes-assets'
// assets.lock.json (committed and pushed to its main), so every machine gets it with "npm run pull" in hawkes-assets.
// Any other outside folder is left to the product's own tools, and the answer says so.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gen } from './gen.ts';
import { abs, getProduct, loadProducts, PROJECTS, StudioError, type Product } from './config.ts';
import { spawn } from 'node:child_process';
import { ensureWorkingCopy, flushDev } from './dev.ts';
// @ts-ignore: plain JS module (a copy of hawkesgen/clients/js/hawkesgen-folders.mjs, synced by hawkesgen-sdk)
import { parseMappings, exportFolders } from './hawkesgen-folders.mjs';

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

/** Per product: entities with takes waiting for a pick (made since the slot's pick; newest first). Products Gen doesn't know are left out. */
export async function waiting() {
  const out: { product: string; name: string; entities: { id: string; name: string; kind: string; takes: number; slots: string[]; updated: number }[] }[] = [];
  for (const p of loadProducts()) {
    const r = await gen.entities({ project: p.id, limit: 500 }).catch(() => null);
    if (!r) continue;
    const entities = r.items
      .map((e: any) => {
        // Takes made since the pick (Gen's waiting; takes on an older Gen), not the alternatives already passed over.
        const waitingIn = (s: any) => s.waiting ?? s.takes ?? 0;
        const slots = Object.entries<any>(e.slots ?? {}).filter(([, s]) => waitingIn(s) > 0).map(([k]) => k);
        return { id: e.id, name: e.name, kind: e.kind, takes: Object.values<any>(e.slots ?? {}).reduce((n, s) => n + waitingIn(s), 0), slots, updated: e.updated };
      })
      .filter((e: any) => e.takes > 0)
      .sort((a: any, b: any) => b.updated - a.updated);
    if (entities.length || r.total) out.push({ product: p.id, name: p.name, entities });
  }
  return { products: out };
}

/** The product's mappings in a checkout (one per kind it keeps in folders), or []. */
export function mappingsIn(dir: string): any[] {
  const f = ['hawkes.content.json', 'hawkes.library.json'].map((n) => path.join(dir, n)).find((x) => fs.existsSync(x));
  if (!f) return [];
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  // hawkes.content.json keeps the mapping under "library"; hawkes.library.json is the mapping.
  const m = path.basename(f) === 'hawkes.content.json' ? raw.library : raw;
  return m ? parseMappings(m, f) : [];
}

/** The mapping for one kind (or the first), or null. */
export function mappingIn(dir: string, kind?: string) {
  const all = mappingsIn(dir);
  return (kind && all.find((m) => m.kind === kind)) || all[0] || null;
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
  const e = await gen.entity(entityId);
  const all = mappingsIn(dir);
  if (!all.length) return { product: p.id, skipped: `${p.name} has no hawkes.library.json: its picks stay in the library` };
  const m = all.find((x) => x.kind === e.kind);
  if (!m) return { product: p.id, skipped: `${p.name} keeps no ${e.kind} in folders: its picks stay in the library` };
  if (!insideRepo(dir, m.root)) {
    // The beta working copy sits elsewhere: the outside folder is where it is next to the product's own checkout.
    const root = path.resolve(abs(p.repo), path.relative(dir, m.root));
    if (!sharedArt(root)) return { product: p.id, skipped: `${p.name}'s folders (${path.basename(m.root)}) are outside its repo and not in hawkes-assets: its own tools write them` };
    return publishShared(p, { ...m, root }, e, by);
  }
  const report = await exportFolders(gen, m, { only: e.data?.folder ?? e.name });
  const written = report.filter((r: any) => r.action === 'written');
  if (!written.length) return { product: p.id, written: 0, nothing: true };
  const r = await flushDev(p.id, `library: ${e.name}, picked by ${by}`);
  return { product: p.id, written: written.length, files: written.map((x: any) => x.file), ...r };
}

const ASSETS = () => path.join(PROJECTS, 'hawkes-assets');

/** Whether a folder is one hawkes-assets tracks (mounts.json), and so lives in S3 and on every machine. */
export function sharedArt(root: string) {
  try {
    const mounts = JSON.parse(fs.readFileSync(path.join(ASSETS(), 'mounts.json'), 'utf8')) as Record<string, string>;
    return Object.values(mounts).some((d) => path.resolve(ASSETS(), d) === path.resolve(root));
  } catch {
    return false;
  }
}

function sh(cmd: string, args: string[], cwd: string, timeoutMs = 15 * 60_000) {
  return new Promise<{ ok: boolean; out: string }>((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-8000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
  });
}
const last = (s: string) => s.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);

// One publish at a time: they share hawkes-assets' lock file and git.
let publishing: Promise<unknown> = Promise.resolve();

/** Writes an entity's picks into a hawkes-assets folder, uploads them and commits the lock to hawkes-assets main. */
function publishShared(p: Product, m: any, e: any, by: string) {
  const work = publishing.then(async () => {
    const report = await exportFolders(gen, m, { only: e.data?.folder ?? e.name });
    const written = report.filter((r: any) => r.action === 'written');
    if (!written.length) return { product: p.id, written: 0, nothing: true };
    const files = written.map((x: any) => x.file);
    const repo = ASSETS();
    const pushS3 = await sh(process.execPath, ['tools/sync.mjs', 'push'], repo, 30 * 60_000);
    if (!pushS3.ok) return { product: p.id, written: written.length, files, published: false, error: `hawkes-assets push: ${last(pushS3.out)}` };
    const steps: [string, string[]][] = [
      ['git', ['add', 'assets.lock.json']],
      ['git', ['commit', '-q', '-m', `library: ${e.name} (${p.name}), picked by ${by}`]],
      ['git', ['pull', '-q', '--rebase', 'origin', 'main']],
      ['git', ['push', '-q', 'origin', 'HEAD:main']],
    ];
    for (const [cmd, args] of steps) {
      const r = await sh(cmd, args, repo, 5 * 60_000);
      if (!r.ok && !(args[0] === 'commit' && /nothing to commit/.test(r.out))) {
        if (args[0] === 'pull') await sh('git', ['rebase', '--abort'], repo);
        return { product: p.id, written: written.length, files, published: false, error: `hawkes-assets ${args[0]}: ${last(r.out)}` };
      }
    }
    return { product: p.id, written: written.length, files, published: true, where: `hawkes-assets (${path.basename(m.root)}): S3 and assets.lock.json on main; "npm run pull" in hawkes-assets brings it to any machine` };
  });
  publishing = work.catch(() => {});
  return work;
}
