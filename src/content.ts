// Content health: for each product, whether its generated content is wired the standard way and what's left to do.
//
//   GET /api/content/health[?product=id][&folders=1]
//
// Per product:
//   contract  the standard integration (hawkesgen/docs/library.md): a mapping (hawkes.content.json or
//             hawkes.library.json), the hawkesgen MCP server in .mcp.json, a "Hawkes Gen" section in AGENTS.md
//   mappings  each kind kept in folders: its root, whether that is in the repo (Studio writes picks) and on this machine
//   library   entities by kind, takes waiting for a pick (made since the slot's pick), and unmade slots: a slot the kind's recipe can make
//             (presets/<project>.json kinds) that an entity has no current version of
//   sdk       every copy of the Gen SDK in the repo (hawkesgen.mjs, hawkesgen-ui.mjs, hawkesgen-folders.mjs) and its
//             version, against Gen's current one; behind ones are listed
//   folders   (folders=1, slower: it asks Gen about every slot) what an import would change: files in the folders the
//             library doesn't have yet, and slots where the folder and the library's pick differ
//
// The checkout read is the beta working copy when Studio has one, else the product's repo folder.

import fs from 'node:fs';
import path from 'node:path';
import { gen } from './gen.ts';
import { abs, getProduct, loadProducts, type Product } from './config.ts';
import { devDir } from './dev.ts';
import { mappingsIn, insideRepo } from './library.ts';
// @ts-ignore: plain JS module (a copy of hawkesgen/clients/js/hawkesgen-folders.mjs)
import { importFolders } from './hawkesgen-folders.mjs';

const SDK_FILES = ['hawkesgen.mjs', 'hawkesgen-ui.mjs', 'hawkesgen-folders.mjs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'Library', 'Temp', 'Logs', '.data', '.work', 'staging', 'play', 'releases']);

/** The checkout Studio reads for a product. */
export function checkoutOf(p: Product) {
  const beta = devDir(p);
  return fs.existsSync(path.join(beta, '.git')) ? beta : abs(p.repo ?? p.id);
}

/** Every SDK copy under dir: [{ file, name, version }] (version: CLIENT_VERSION or UI_VERSION; null for the bridge). */
export function sdkCopies(dir: string, depth = 5) {
  const out: { file: string; name: string; version: number | null }[] = [];
  const walk = (d: string, left: number) => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.isDirectory()) {
        if (left > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), left - 1);
      } else if (SDK_FILES.includes(e.name)) {
        const text = fs.readFileSync(path.join(d, e.name), 'utf8');
        const v = /export const (?:CLIENT|UI)_VERSION = (\d+)/.exec(text);
        out.push({ file: path.relative(dir, path.join(d, e.name)).split(path.sep).join('/'), name: e.name, version: v ? Number(v[1]) : null });
      }
    }
  };
  walk(dir, depth);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The standard integration's pieces in a checkout. The mapping is at the checkout's root; the MCP server and the docs
 * section may also be in an enclosing folder (more: e.g. YoobaLand/ around the Unity project YoobaLand/YoobaLand), and
 * the section in AGENTS.md, CLAUDE.md or README.md.
 */
export function contract(dir: string, more: string[] = []) {
  const has = (d: string, f: string) => fs.existsSync(path.join(d, f));
  const read = (d: string, f: string) => (has(d, f) ? fs.readFileSync(path.join(d, f), 'utf8') : '');
  const dirs = [dir, ...more];
  const mcp = dirs.some((d) => {
    try {
      return !!JSON.parse(read(d, '.mcp.json') || '{}').mcpServers?.hawkesgen;
    } catch {
      return false; // unreadable: not wired
    }
  });
  return {
    mapping: has(dir, 'hawkes.content.json') ? 'hawkes.content.json' : has(dir, 'hawkes.library.json') ? 'hawkes.library.json' : null,
    mcp,
    agents: dirs.some((d) => ['AGENTS.md', 'CLAUDE.md', 'README.md'].some((f) => /^#+ .*Hawkes Gen/m.test(read(d, f)))),
  };
}

/** The folders between a product's repo and C:\Projects (YoobaLand/YoobaLand -> [YoobaLand]). */
const enclosing = (p: Product) => {
  const out: string[] = [];
  const parts = String(p.repo ?? p.id).split(/[\\/]/).filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) out.push(abs(parts.slice(0, i).join('/')));
  return out;
};

type Kinds = Record<string, { slots?: Record<string, { make?: unknown; optional?: boolean }> }>;

/** Slots a kind's recipe can make (no wildcards: pose/* is made per pose the entity has; optional ones left out). */
export const makeable = (kinds: Kinds, kind: string) =>
  Object.entries(kinds?.[kind]?.slots ?? {})
    .filter(([slot, s]) => s?.make && !s.optional && !slot.includes('*'))
    .map(([slot]) => slot);

/** The slots of a kind whose recipe uses slot (slot:./<slot> in its make): a prop's model uses its reference. */
export const usedBy = (kinds: Kinds, kind: string, slot: string) =>
  Object.entries(kinds?.[kind]?.slots ?? {})
    .filter(([, s]) => s?.make && JSON.stringify(s.make).includes(`"slot:./${slot}"`))
    .map(([k]) => k);

/**
 * Per entity: makeable slots with no current version. A slot only there to make another one isn't missing once that
 * one has a pick (a prop whose model is done doesn't need the reference it would be made from).
 */
export function unmade(entities: any[], kinds: Kinds) {
  const out: { entity: string; name: string; kind: string; slots: string[] }[] = [];
  for (const e of entities) {
    const done = (slot: string) => !!e.slots?.[slot]?.current;
    const slots = makeable(kinds, e.kind).filter((s) => {
      if (done(s)) return false;
      const users = usedBy(kinds, e.kind, s);
      return !(users.length && users.every(done));
    });
    if (slots.length) out.push({ entity: e.id, name: e.name, kind: e.kind, slots });
  }
  return out;
}

export async function productHealth(p: Product, { folders = false } = {}) {
  const dir = checkoutOf(p);
  const there = fs.existsSync(dir);
  const c = there ? contract(dir, enclosing(p)) : { mapping: null, mcp: false, agents: false };
  const maps = there ? (() => { try { return mappingsIn(dir); } catch (e: any) { return { error: e.message }; } })() : [];
  const mappings = Array.isArray(maps)
    ? maps.map((m: any) => ({ kind: m.kind, root: path.relative(dir, m.root).split(path.sep).join('/') || '.', inRepo: insideRepo(dir, m.root), here: fs.existsSync(m.root), layout: m.layout ?? 'folders' }))
    : [];

  const [list, presets, health] = await Promise.all([
    gen.entities({ project: p.id, limit: 500 }).catch(() => null),
    gen.presets(p.id).catch(() => null),
    gen.health().catch(() => null),
  ]);
  const items: any[] = list?.items ?? [];
  const kinds: Kinds = presets?.kinds ?? {};
  const byKind: Record<string, number> = {};
  let takes = 0;
  for (const e of items) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    for (const s of Object.values<any>(e.slots ?? {})) takes += s.waiting ?? s.takes ?? 0;
  }

  const current = health?.client?.current ?? {};
  const copies = there ? sdkCopies(dir) : [];
  const want = (name: string) => (name === 'hawkesgen.mjs' ? current.js : name === 'hawkesgen-ui.mjs' ? current.ui : undefined);
  const sdk = copies.map((x) => ({ ...x, current: want(x.name) ?? null, behind: want(x.name) != null && x.version != null && x.version < want(x.name) }));

  let folderStatus: any = undefined;
  if (folders && Array.isArray(maps)) {
    folderStatus = [];
    for (const m of maps as any[]) {
      if (!fs.existsSync(m.root)) {
        folderStatus.push({ kind: m.kind, skipped: `${path.basename(m.root)} isn't on this machine` });
        continue;
      }
      const r: any[] = await importFolders(gen, m, { dry: true }).catch((e: any) => [{ action: 'error', error: e.message }]);
      const n: Record<string, number> = {};
      for (const x of r) n[x.action] = (n[x.action] ?? 0) + 1;
      folderStatus.push({ kind: m.kind, counts: n, differs: r.filter((x) => x.action === 'differs').slice(0, 20).map((x) => `${x.entity} ${x.slot}`) });
    }
  }

  const missing = unmade(items, kinds);
  const issues: string[] = [];
  if (!there) issues.push(`no checkout at ${dir}`);
  if (!Array.isArray(maps)) issues.push(`mapping: ${(maps as any).error}`);
  if (there && !c.mcp) issues.push('.mcp.json has no hawkesgen server');
  if (there && !c.agents) issues.push('AGENTS.md has no Hawkes Gen section');
  for (const x of sdk.filter((x) => x.behind)) issues.push(`${x.file} is v${x.version} (current v${x.current}): node C:/Projects/hawkesgen/bin/hawkesgen-sdk.mjs sync`);
  if (!list) issues.push("Hawkes Gen didn't answer");

  return {
    product: p.id,
    name: p.name,
    checkout: dir,
    contract: c,
    mappings,
    library: { entities: items.length, byKind, takesWaiting: takes, kinds: Object.keys(kinds).filter((k) => !k.startsWith('_')), unmade: missing.slice(0, 50), unmadeCount: missing.reduce((n, x) => n + x.slots.length, 0) },
    sdk,
    folders: folderStatus,
    issues,
    ok: issues.length === 0,
  };
}

export async function contentHealth({ product, folders = false }: { product?: string; folders?: boolean } = {}) {
  const ps = product ? [getProduct(product)] : loadProducts();
  return { products: await Promise.all(ps.map((p) => productHealth(p, { folders }))) };
}

/**
 * Wires a product to Hawkes Gen the standard way, writing only what's missing (never overwriting):
 *   .mcp.json                the hawkesgen and hawkesstudio MCP servers (added to an existing file's servers)
 *   AGENTS.md                a "Generative AI: Hawkes Gen" section (appended; AGENTS.md is made if there is none)
 *   hawkes.library.json      when kind and root are given: folders under root, one entity each (slots: given, or a
 *                            single "concept" image), so the product's art comes into the library
 *   hawkesgen/presets/<id>.json  the product's art direction file with an empty style: J or the product's docs fill it
 *                            (Hawkes Gen's rule: don't invent a look for a project that hasn't chosen one)
 * Writes into the product's own checkout (C:\Projects\<repo>) and commits nothing. dry: report only.
 */
export function wire(productId: string, { kind, root, slots, dry = false }: { kind?: string; root?: string; slots?: unknown[]; dry?: boolean } = {}) {
  const p = getProduct(productId);
  const dir = abs(p.repo ?? p.id);
  if (!fs.existsSync(dir)) throw new Error(`${p.name} has no checkout at ${dir}`);
  const done: { file: string; action: string }[] = [];
  const write = (file: string, text: string, action: string) => {
    done.push({ file: path.relative(abs(''), file).split(path.sep).join('/'), action: dry ? `would-${action}` : action });
    if (!dry) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  };
  const c = contract(dir, enclosing(p));
  const mapped = !!c.mapping || !!(kind && root);

  if (!c.mcp) {
    const f = path.join(dir, '.mcp.json');
    let cur: any = {};
    try {
      cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      /* none yet */
    }
    cur.mcpServers = {
      ...cur.mcpServers,
      hawkesgen: { command: 'node', args: ['C:/Projects/hawkesgen/bin/hawkesgen-mcp.mjs'] },
      hawkesstudio: cur.mcpServers?.hawkesstudio ?? { command: 'node', args: ['C:/Projects/hawkesstudio/bin/studio-mcp.mjs'] },
    };
    write(f, `${JSON.stringify(cur, null, 2)}\n`, fs.existsSync(f) ? 'added' : 'created');
  }

  if (!c.agents) {
    const f = path.join(dir, 'AGENTS.md');
    const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `# ${p.name}\n`;
    const unity = p.engine === 'unity';
    const section = [
      '## Generative AI: Hawkes Gen',
      '',
      'Images, textures, video, 3D, music, voice, sound and Claude all go through **Hawkes Gen**',
      '(`C:\\Projects\\hawkesgen`, https://gen.hawkesgen.com). It holds the API and AWS keys and runs the shared GPU fleet.',
      'This project never holds those keys.',
      '',
      `- **Agents:** the \`hawkesgen\` MCP server is in \`.mcp.json\`. Use \`hawkesgen_presets\` (project \`${p.id}\`) for the`,
      '  art direction, then `hawkesgen_run`.',
      `- **Art direction:** \`hawkesgen/presets/${p.id}.json\` (style line, named presets, kinds). Edit it there.`,
      "- **Library:** characters, props and shots live in Hawkes Gen's library (`hawkesgen/docs/library.md`): every version",
      `  of every slot, picked in Studio's Library tab${unity ? ' or Window > Hawkes Gen > Entities' : ''}.${mapped ? " `hawkes.library.json` maps this repo's folders to it." : ''}`,
      unity
        ? '- **Unity:** Window > Hawkes Gen (package `com.hawkes.gen`) runs any tool or preset and imports the results.'
        : '- **Code:** copy `hawkesgen/clients/js/hawkesgen.mjs` into the project and list it in `hawkesgen/clients/js/sdk.json` (`node C:/Projects/hawkesgen/bin/hawkesgen-sdk.mjs sync` keeps it current).',
      '- GPU tools cost money while a server runs. Price a batch first (`hawkesgen_estimate`) and ask J before starting servers.',
      '',
    ].join('\n');
    write(f, `${had.replace(/\s*$/, '')}\n\n${section}`, fs.existsSync(f) ? 'added' : 'created');
  }

  if (kind && root && !c.mapping) {
    const mapping = {
      _about: `${p.name}'s folders in the Hawkes Gen library (hawkesgen/clients/js/hawkesgen-folders.mjs has the format): each folder under root is a ${kind}.`,
      project: p.id,
      kind,
      root,
      skip: ['_*'],
      slots: slots ?? [{ slot: 'concept', current: '*.{jpg,jpeg,png}' }],
    };
    write(path.join(dir, 'hawkes.library.json'), `${JSON.stringify(mapping, null, 2)}\n`, 'created');
  }

  const presets = path.join(abs('hawkesgen'), 'presets', `${p.id}.json`);
  if (fs.existsSync(path.dirname(presets)) && !fs.existsSync(presets)) {
    const preset = { project: p.id, title: p.name, style: '', negative: 'text, watermark', notes: `Fill the style from ${p.name}'s own docs once it has chosen a look.`, presets: {} };
    write(presets, `${JSON.stringify(preset, null, 2)}\n`, 'created');
  }

  return { product: p.id, checkout: dir, wrote: done, nothing: done.length === 0 };
}
