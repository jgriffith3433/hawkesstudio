// Asset manifests: each project lists the generated assets it needs in hawkes.assets.json (at its repo root), as
// recipes. Studio makes what's missing or out of date through Hawkes Gen (asset.make: a chain of tools, with
// best-of-N picking by Claude) and writes the files where the project wants them. hawkes.assets.lock.json records
// what made each file, so a file edited by hand isn't overwritten (unless forced).
//
//   {
//     "project": "phorigins",
//     "assets": [
//       {
//         "id": "lab-floor",
//         "steps": [
//           { "preset": "material", "params": { "prompt": "cracked white lab floor tiles" }, "save": "albedo" },
//           { "tool": "texture.maps", "inputs": { "image": "$prev" }, "save": "maps" }
//         ],
//         "candidates": 3, "pick": "clean tiles, no text",
//         "files": { "albedo": "public/textures/lab_floor.png", "maps.normal": "public/textures/lab_floor_n.png" }
//       }
//     ]
//   }
//
// "inputs": ["relative/path.png"] (relative to the repo) are passed as $input:0, $input:1 ...
// "pickAt": 2 makes the candidates at step 2 (the steps before it run once), e.g. a Blender render styled three ways.
// "$step1:depth" passes on step 1's output titled "depth" (blender.render makes several).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { abs, getProduct, type Product } from './config.ts';
import { gen, genWait } from './gen.ts';

export type AssetSpec = { id: string; steps: any[]; candidates?: number; pick?: string; pickAt?: number; files: Record<string, string>; inputs?: string[]; note?: string };
type Manifest = { project?: string; assets: AssetSpec[] };
type Lock = Record<string, { recipe: string; job: string; made: string; files: Record<string, string> }>;

const manifestPath = (p: Product) => path.join(abs(p.repo), 'hawkes.assets.json');
const lockPath = (p: Product) => path.join(abs(p.repo), 'hawkes.assets.lock.json');

export function loadManifest(p: Product): Manifest | null {
  const f = manifestPath(p);
  if (!fs.existsSync(f)) return null;
  const m = JSON.parse(fs.readFileSync(f, 'utf8')) as Manifest;
  const ids = new Set<string>();
  for (const a of m.assets ?? []) {
    if (!a.id || !Array.isArray(a.steps) || !a.steps.length || !a.files || typeof a.files !== 'object') throw new Error(`${p.repo}/hawkes.assets.json: every asset needs id, steps and files (${a.id ?? '?'})`);
    if (ids.has(a.id)) throw new Error(`${p.repo}/hawkes.assets.json: duplicate id ${a.id}`);
    ids.add(a.id);
  }
  return m;
}

const readLock = (p: Product): Lock => {
  try {
    return JSON.parse(fs.readFileSync(lockPath(p), 'utf8'));
  } catch {
    return {};
  }
};
const writeLock = (p: Product, lock: Lock) => fs.writeFileSync(lockPath(p), JSON.stringify(lock, null, 2) + '\n');
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function paramsOf(a: AssetSpec) {
  // pickAt only when set, so recipes written before it keep their fingerprints.
  return { steps: a.steps, candidates: a.candidates ?? 1, ...(a.pick ? { pick: a.pick } : {}), ...(a.pickAt ? { pickAt: a.pickAt } : {}) };
}
function inputsOf(p: Product, a: AssetSpec) {
  return a.inputs?.length ? { files: a.inputs.map((rel) => path.join(abs(p.repo), rel)) } : {};
}
/** A recipe fingerprint: the steps and the input files' contents. */
function recipeOf(p: Product, a: AssetSpec) {
  const h = crypto.createHash('sha256').update(JSON.stringify(paramsOf(a)));
  for (const rel of a.inputs ?? []) {
    const f = path.join(abs(p.repo), rel);
    h.update(fs.existsSync(f) ? sha(f) : `missing:${rel}`);
  }
  return h.digest('hex').slice(0, 16);
}

export type AssetStatus = { id: string; status: 'current' | 'missing' | 'changed' | 'edited' | 'no-file'; detail: string; files: Record<string, string>; note?: string };

/** What each asset needs: current, missing (never made), changed (recipe changed), edited (a file changed by hand), no-file. */
export function assetStatus(productId: string): { product: string; manifest: string | null; assets: AssetStatus[] } {
  const p = getProduct(productId);
  const m = loadManifest(p);
  if (!m) return { product: p.id, manifest: null, assets: [] };
  const lock = readLock(p);
  const assets = m.assets.map((a): AssetStatus => {
    const l = lock[a.id];
    const recipe = recipeOf(p, a);
    if (!l) return { id: a.id, status: 'missing', detail: 'never made', files: a.files, note: a.note };
    if (l.recipe !== recipe) return { id: a.id, status: 'changed', detail: 'the recipe changed since it was made', files: a.files, note: a.note };
    for (const rel of Object.values(a.files)) {
      const f = path.join(abs(p.repo), rel);
      if (!fs.existsSync(f)) return { id: a.id, status: 'no-file', detail: `${rel} is missing`, files: a.files, note: a.note };
      if (l.files[rel] && l.files[rel] !== sha(f)) return { id: a.id, status: 'edited', detail: `${rel} was changed by hand (kept; force to regenerate)`, files: a.files, note: a.note };
    }
    return { id: a.id, status: 'current', detail: `made ${l.made}`, files: a.files, note: a.note };
  });
  return { product: p.id, manifest: path.relative(abs(''), manifestPath(p)), assets };
}

/**
 * Makes one asset through Hawkes Gen and writes its files. A recipe Gen already made (any project run) is reused
 * from its library instead of generated again.
 */
export async function makeAsset(productId: string, id: string, { force = false, onUpdate, job: prior }: { force?: boolean; onUpdate?: (detail: string, job?: string) => void; job?: string } = {}) {
  const p = getProduct(productId);
  const m = loadManifest(p);
  const a = m?.assets.find((x) => x.id === id);
  if (!m || !a) throw new Error(`${p.name} has no asset "${id}" in hawkes.assets.json`);
  const status = assetStatus(p.id).assets.find((x) => x.id === id)!;
  if (status.status === 'current' && !force) return { id, skipped: 'current' };
  if (status.status === 'edited' && !force) return { id, skipped: 'edited by hand' };
  const project = m.project ?? p.id;
  const recipe = recipeOf(p, a);
  const version = (await gen.tool('asset.make')).version;
  const params = paramsOf(a);
  const inputs = inputsOf(p, a);
  // A job submitted before a Studio restart (a resumed run) is waited for again, not made twice.
  const job = prior ? { id: prior } : await gen.submit('asset.make', { project, params, inputs, labels: { manifest: p.id, asset: id }, key: force ? undefined : `assets:${project}:${id}:${recipe}:v${version}` });
  onUpdate?.('queued', job.id);
  const done = await genWait(job.id, (j: any) => onUpdate?.(j.detail, j.id), 6 * 3600_000);
  if (done.status !== 'done') throw new Error(`asset.make ${done.status}: ${done.error ?? done.detail}`);
  const byName = new Map<string, any>();
  for (const o of done.outputs ?? []) byName.set(String(o.title), o);
  const lockFiles: Record<string, string> = {};
  for (const [save, rel] of Object.entries(a.files)) {
    const o = byName.get(save);
    if (!o) throw new Error(`asset.make made no output "${save}" (it made: ${[...byName.keys()].join(', ')})`);
    const dest = path.join(abs(p.repo), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await gen.download(o.asset, dest);
    lockFiles[rel] = sha(dest);
  }
  const lock = readLock(p);
  lock[id] = { recipe, job: done.id, made: new Date().toISOString(), files: lockFiles };
  writeLock(p, lock);
  return { id, job: done.id, files: Object.keys(lockFiles), cost: done.cost ?? 0, picked: done.result?.picked ?? null };
}
