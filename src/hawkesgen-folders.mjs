// Folders <-> the library (Node). A product keeps its files where its engine wants them (DoD: AllTheCharacters/<Name>/
// poses/air.png, anims/jab.mp4, with takes in _takes/ and old versions in _old/); a mapping file says which file is which
// slot, and this brings the folders into Hawkes Gen's library (entities, slots, versions) and writes the picks back.
//
//   node C:/Projects/hawkesgen/bin/hawkesgen-folders.mjs status  <mapping.json> [--only Break]
//   node C:/Projects/hawkesgen/bin/hawkesgen-folders.mjs import  <mapping.json> [--only Break] [--dry]
//   node C:/Projects/hawkesgen/bin/hawkesgen-folders.mjs export  <mapping.json> [--only Break] [--dry]
//
// The mapping (e.g. doseofdestructionwebsite/hawkes.library.json):
//
//   {
//     "project": "doseofdestruction", "kind": "fighter",
//     "root": "../AllTheCharacters",              each folder in root is an entity (relative to the mapping file)
//     "skip": ["_*"],                              folders to leave out
//     "slots": [
//       { "slot": "concept",   "current": "*.{jpg,png}" },
//       { "slot": "side",      "current": "anims/_side.png", "takes": "anims/_side-*.png", "recipe": "{file}.json" },
//       { "slot": "pose/{name}", "current": "poses/{name}.png", "takes": "poses/_takes/{name}-*.png", "recipe": "{file}.json" },
//       { "slot": "clip/{name}", "current": "anims/{name}.mp4", "takes": "anims/_takes/{name}-*.mp4", "old": "anims/_old/{name}-*.mp4" }
//     ]
//   }
//
// A flat folder, one file per entity (PH Origins: assets/models/office-desk.glb), is "layout": "files": root itself holds
// the files, {entity} in a pattern is the entity's name (the file name's variable part), "entities" (patterns over that
// name) picks which ones belong to this mapping, and skip leaves names out:
//
//   { "project": "phorigins", "kind": "prop", "layout": "files", "root": "assets/models", "skip": ["ch*", "hero"],
//     "slots": [{ "slot": "model", "current": "{entity}.glb", "takes": "_takes/{entity}-*.glb" }] }
//
// One file can hold several mappings (characters and props from one folder): { "project": ..., "mappings": [{...}, {...}] }
// (each inherits the top-level fields). loadMappings reads them all; loadMapping(file, kind) one.
//
// Patterns are paths inside the entity's folder: * is any characters but /, {a,b} is either, {name} is the slot's
// variable part (one word: "air", "jab"). A file belongs to the first spec that matches it, so a narrower pattern goes
// first (DoD's anims/_old/take-{name}-*.mp4 before anims/_old/{name}-*.mp4). recipe is the sidecar with the prompt and seed of a take ({file} is the take's
// path without its extension; {path} with it). Import is safe to run again: a file already in its slot (same bytes) is
// not added twice, and a current file that matches a take picks that take (only while the slot has no current version:
// after that the library decides, and a different file is reported as "differs"; --adopt lets the folder win). A take
// that moved to an "old" path is made old in the library ("retired"). Export writes each slot's current version to
// its "current" path (only files whose bytes differ), so the game and the product's tools keep working unchanged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** "DJWontRead" -> "dj-wont-read", "Evil Blue Bird" -> "evil-blue-bird". */
export function slugOf(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

/** A pattern as a regex over a path inside the entity folder; {name} is captured. */
export function patternRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[^/]*';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      const inner = pattern.slice(i + 1, end);
      re += inner === 'name' ? '(?<name>[^/]+?)' : inner === 'entity' ? '(?<entity>[^/]+?)' : `(?:${inner.split(',').map((x) => x.replace(/[.+?^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function listFiles(dir, depth = 4, base = dir) {
  if (!fs.existsSync(dir) || depth < 0) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, depth - 1, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** The mappings in a parsed mapping file (a mapping, or { ...shared, mappings: [...] }); paths resolve against file's folder. */
export function parseMappings(raw, file) {
  const { mappings, ...shared } = raw;
  const list = Array.isArray(mappings) ? mappings.map((m) => ({ ...shared, ...m })) : [raw];
  return list.map((m) => {
    if (!m.project || !m.kind || !m.root || !Array.isArray(m.slots)) throw new Error(`${file}: a mapping needs project, kind, root and slots`);
    if (m.layout && !['folders', 'files'].includes(m.layout)) throw new Error(`${file}: layout is folders or files`);
    if (m.layout === 'files' && !m.slots.some((s) => String(s.current ?? '').includes('{entity}'))) throw new Error(`${file}: a files layout needs {entity} in a current pattern`);
    return { ...m, root: path.resolve(path.dirname(file), m.root), file };
  });
}

export function loadMappings(file) {
  return parseMappings(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/** One mapping from a file: the one for kind, else the first. */
export function loadMapping(file, kind) {
  const all = loadMappings(file);
  return (kind && all.find((m) => m.kind === kind)) || all[0];
}

const isFiles = (m) => m.layout === 'files';
/** Where an entity's files are: its folder, or root itself in a files layout. */
const dirOf = (m, folder) => (isFiles(m) ? m.root : path.join(m.root, folder));
/** A pattern for one entity ({entity} filled in a files layout). */
const fill = (m, pattern, folder) => (isFiles(m) ? pattern.replaceAll('{entity}', folder) : pattern);

/** The entity folders under root (minus skip), or in a files layout the entity names found in root. */
export function entityFolders(m, only) {
  const skip = (m.skip ?? ['_*']).map(patternRegex);
  const keep = m.entities ? [].concat(m.entities).map(patternRegex) : null;
  let names;
  if (isFiles(m)) {
    const files = listFiles(m.root);
    const found = new Set();
    for (const spec of m.slots) {
      if (!spec.current?.includes('{entity}')) continue;
      const re = patternRegex(spec.current);
      for (const f of files) {
        const e = re.exec(f)?.groups?.entity;
        if (e) found.add(e);
      }
    }
    names = [...found];
  } else names = fs.readdirSync(m.root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  return names
    .filter((n) => !skip.some((r) => r.test(n)) && (!keep || keep.some((r) => r.test(n))))
    .filter((n) => !only || n.toLowerCase() === String(only).toLowerCase() || slugOf(n) === slugOf(only))
    .sort();
}

/** What a folder holds, slot by slot: { [slot]: { current?, takes: [], old: [] } } (paths inside the folder). */
export function scanFolder(m, folder) {
  const dir = dirOf(m, folder);
  const files = listFiles(dir);
  const slots = {};
  // A file belongs to one slot: the first spec (in the mapping's order) that matches it.
  const claimed = new Set();
  for (const spec of m.slots) {
    for (const role of ['current', 'takes', 'old']) {
      if (!spec[role]) continue;
      if (isFiles(m) && !spec[role].includes('{entity}')) continue;
      const re = patternRegex(fill(m, spec[role], folder));
      for (const f of files) {
        if (claimed.has(f)) continue;
        const hit = re.exec(f);
        if (!hit) continue;
        const name = hit.groups?.name ? slugOf(hit.groups.name) : null;
        if (spec.slot.includes('{name}') && !name) continue;
        const slot = spec.slot.replace('{name}', name ?? '');
        claimed.add(f);
        const s = (slots[slot] ??= { spec, takes: [], old: [], current: null });
        if (spec.recipe && !s.spec.recipe) s.spec = spec;
        if (role === 'current') {
          // Several files for one current (concept: *.jpg and *.png): the newest.
          if (!s.current || fs.statSync(path.join(dir, f)).mtimeMs > fs.statSync(path.join(dir, s.current)).mtimeMs) s.current = f;
        } else s[role].push(f);
      }
    }
  }
  return slots;
}

function sidecar(m, spec, dir, f) {
  if (!spec.recipe) return null;
  const p = path.join(dir, spec.recipe.replace('{file}', f.replace(/\.[^.]+$/, '')).replace('{path}', f));
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Adds a version, riding out a gateway error or a restart (502/503/504, or Gen briefly unreachable): before trying
 * again it looks whether the version got stored anyway, so a long import never adds the same file twice.
 */
async function stored(gen, id, slot, hash, add) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await add();
    } catch (e) {
      const passing = [0, 502, 503, 504].includes(e.status) || /HTTP 50[234]/.test(e.message);
      if (!passing || attempt >= 4) throw e;
      await sleep(5000 * (attempt + 1));
      const there = (await gen.slot(id, slot).catch(() => ({ versions: [] }))).versions.find((v) => v.file?.sha256 === hash);
      if (there) return there;
    }
  }
}

/**
 * Brings folders into the library. -> [{ entity, slot, file, action }] (action: created, added, picked, same, differs,
 * would-*). differs: the folder's current file isn't the slot's current version (the library's pick stands; adopt: true
 * makes the folder's file current instead).
 */
export async function importFolders(gen, m, { only, dry = false, adopt = false, log = () => {} } = {}) {
  const report = [];
  for (const folder of entityFolders(m, only)) {
    const dir = dirOf(m, folder);
    const where = isFiles(m) ? path.basename(m.root) : `${path.basename(m.root)}/${folder}`;
    const id = `${m.project}/${slugOf(folder)}`;
    let entity = await gen.entity(id).catch(() => null);
    if (!entity) {
      report.push({ entity: id, action: dry ? 'would-create' : 'created' });
      if (!dry) entity = await gen.createEntity({ project: m.project, slug: slugOf(folder), name: folder, kind: m.kind, data: { folder } });
    }
    const slots = scanFolder(m, folder);
    for (const [slot, s] of Object.entries(slots)) {
      const have = entity ? (await gen.slot(id, slot).catch(() => ({ versions: [] }))).versions : [];
      // The same bytes can be in a slot twice (a take, and the current copy of it): prefer the current one.
      const bySha = new Map();
      for (const v of have) if (!bySha.has(v.file?.sha256) || v.status === 'current') bySha.set(v.file?.sha256, v);
      const hasCurrent = have.some((v) => v.status === 'current');
      const add = async (f, status) => {
        const h = sha(path.join(dir, f));
        const there = bySha.get(h);
        // Once a slot has a current version, the library decides what's current: a different file in the folder is
        // reported (and kept as a take), not picked, unless adopt says the folder wins.
        if (status === 'current' && hasCurrent && !adopt && there?.status !== 'current') {
          report.push({ entity: id, slot, file: f, action: 'differs' });
          if (!there) status = 'take';
          else return;
        }
        if (there) {
          // A take moved to _old/ (the product's tools dropped it) is old in the library too.
          if (status === 'old' && there.status === 'take') {
            report.push({ entity: id, slot, file: f, action: dry ? 'would-retire' : 'retired' });
            if (!dry) await gen.request(`/versions/${there.id}`, { method: 'PATCH', body: { status: 'old' } });
            return;
          }
          if (status === 'current' && there.status !== 'current') {
            report.push({ entity: id, slot, file: f, action: dry ? 'would-pick' : 'picked' });
            if (!dry) await gen.pick(there.id);
          } else report.push({ entity: id, slot, file: f, action: 'same' });
          return;
        }
        report.push({ entity: id, slot, file: f, status, action: dry ? 'would-add' : 'added' });
        if (dry) return;
        const r = sidecar(m, s.spec, dir, f);
        const v = await stored(gen, id, slot, h, () => gen.addVersion(id, slot, path.join(dir, f), { status, title: isFiles(m) ? f : `${folder}/${f}`, prompt: r?.prompt, meta: r ? { recipe: r, from: `${where}/${f}` } : { from: `${where}/${f}` } }));
        bySha.set(h, v);
        log(`${id} ${slot} v${v.n} ${status}: ${f}`);
      };
      for (const f of s.old.sort()) await add(f, 'old');
      for (const f of s.takes.sort()) await add(f, 'take');
      if (s.current) await add(s.current, 'current');
    }
  }
  return report;
}

/** The "current" path for a slot under a mapping (pose/air -> poses/air.png), or null. folder: the entity's (files layout). */
export function currentPath(m, slot, folder) {
  for (const spec of m.slots) {
    if (!spec.current || spec.current.includes('*')) continue;
    if (isFiles(m) && !spec.current.includes('{entity}')) continue;
    const re = new RegExp(`^${spec.slot.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace('{name}', '(?<name>[a-z0-9-]+)')}$`);
    const hit = re.exec(slot);
    if (hit) return fill(m, spec.current, folder).replace('{name}', hit.groups?.name ?? '');
  }
  return null;
}

/** Writes each slot's current version into the folders. -> [{ entity, slot, file, action }] (written, same, would-write) */
export async function exportFolders(gen, m, { only, dry = false, log = () => {} } = {}) {
  const report = [];
  const all = (await gen.entities({ project: m.project, kind: m.kind, limit: 500 })).items;
  for (const e of all) {
    const folder = e.data?.folder ?? e.name;
    if (only && slugOf(folder) !== slugOf(only)) continue;
    const dir = dirOf(m, folder);
    for (const [slot, s] of Object.entries(e.slots ?? {})) {
      if (!s.current) continue;
      const rel = currentPath(m, slot, folder);
      if (!rel) continue;
      const file = path.join(dir, rel);
      const same = fs.existsSync(file) && sha(file) === s.current.file?.sha256;
      report.push({ entity: e.id, slot, file: path.relative(m.root, file), action: same ? 'same' : dry ? 'would-write' : 'written' });
      if (!same && !dry) {
        await gen.download(s.current.asset, file);
        log(`${e.id} ${slot} v${s.current.n} -> ${file}`);
      }
    }
  }
  return report;
}
