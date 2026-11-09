// What an agent may reach beyond its own project (J, 2026-11-02: "Agents should have access to images yes. This is an
// oversight it would seem in the way I designed studio with all of these projects being isolated. A believe a customer
// would want agents to have wider access to their repositories for many different reasons"). The trigger: 11 images
// made in the owner's own hawkesgen.ai library for Hawkes Biomedical couldn't reach its repo, because an agent holds a
// token for one repo and a Gen key for its Studio's own Gen org only.
//
// Two widenings, on by default (J, 2026-11-02: "just build it out so it's powerful"); Settings → agents.access turns either
// off Studio-wide, and a project's own `access` overrides that:
//   gen    studio_gen_import also takes files from the personal hawkesgen.ai library of a Studio owner (the Gen
//          account whose email is that owner's verified Google sign-in at the control plane). The Studio's own Gen
//          library is always allowed: agents already reach it through their hawkesgen MCP.
//   repos  an agent's Cloud Run job also gets read-only, shallow clones of the Studio's other projects' repositories,
//          next to its worktree (<worktree>.repos/<name>), never sent back. Changing another repo stays that project's
//          own change on its own beta lane.
//
// Never across customers: a cell's Gen key and GitHub tokens only reach its own org's, and the control plane, which holds
// Gen's owner key, hands a cell a file only from that org's Gen org or an owner's own account (controlGenAsset). The
// bytes are fetched server side; the agent never holds a Gen or GitHub credential for them. Every import is logged
// (access_log here, cp_gen_imports at the control plane) and on the change's own log.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { StudioError, loadProducts, type Product } from './config.ts';
import { customerStudio } from './tenancy.ts';

db.exec(`CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT NOT NULL, product TEXT, kind TEXT NOT NULL,
  source TEXT NOT NULL, target TEXT, detail TEXT
)`);

export type AgentAccess = { gen: boolean; repos: boolean };
export const DEFAULT_ACCESS: AgentAccess = { gen: true, repos: true };

/** The Studio-wide default (agents.access) with the project's own `access` over it. */
export function accessFor(studioWide: Partial<AgentAccess> | null | undefined, project: Partial<AgentAccess> | null | undefined): AgentAccess {
  const pick = (k: keyof AgentAccess) => (typeof project?.[k] === 'boolean' ? project[k]! : typeof studioWide?.[k] === 'boolean' ? studioWide[k]! : DEFAULT_ACCESS[k]);
  return { gen: pick('gen'), repos: pick('repos') };
}

/** What a product's agents may reach now. */
export async function agentAccess(productId: string): Promise<AgentAccess> {
  const { agentSettings } = await import('./agents.ts');
  const p = loadProducts().find((x) => x.id === productId) as (Product & { access?: Partial<AgentAccess> }) | undefined;
  return accessFor(agentSettings().access, p?.access);
}

export function logAccess(e: { who: string; product?: string | null; kind: 'gen' | 'repo'; source: string; target?: string | null; detail?: string | null }) {
  try {
    db.prepare('INSERT INTO access_log (at, who, product, kind, source, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), e.who, e.product ?? null, e.kind, e.source, e.target ?? null, e.detail ?? null);
  } catch { /* the log never stops the work */ }
}
export const accessLog = (limit = 100) => db.prepare('SELECT * FROM access_log ORDER BY id DESC LIMIT ?').all(Math.min(500, limit));

// ------------------------------------------------------------------ Gen files

/** A Gen account's own project (hawkesgen.ai: each account works in u_<id>). */
export const isPersonalGen = (project: string) => /^u_[0-9a-z]{6,40}$/i.test(project);

/**
 * Whether a file in this Gen project may come into this Studio. `own`: the Studio's Gen org ("org_<hex>", a cell) or
 * null (J's Studio: its own projects, which are any but customers' org_* and accounts' u_*). `owners`: the personal Gen
 * projects of this Studio's owners, when the gen widening is on (empty otherwise).
 */
export function genSourceOk(project: string, { own, owners }: { own: string | null; owners: Set<string> }): 'own' | 'owner' | null {
  const p = String(project ?? '');
  if (!p) return null;
  if (own) {
    if (p === own || p.startsWith(`${own}.`)) return 'own';
  } else if (!p.startsWith('org_') && !isPersonalGen(p) && p !== 'public') return 'own';
  if (isPersonalGen(p) && owners.has(p)) return 'owner';
  return null;
}

/**
 * The personal Gen projects of these emails (exact, lower case), through Gen's owner-only account search. `admin` is a
 * GET on Gen's /v1 with an owner key. Accounts that don't match exactly are ignored.
 */
export async function personalProjectsOf(emails: string[], admin: (p: string) => Promise<any>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of [...new Set(emails.map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x)))]) {
    // A real "no such account" is an empty answer; Gen not answering is a 503 the caller (and the tool) retries.
    const r = await admin(`/admin/accounts?q=${encodeURIComponent(e)}&limit=20`).catch(missingOr503);
    for (const a of (r?.items ?? []) as any[]) if (String(a.email ?? '').toLowerCase() === e && !a.disabled && isPersonalGen(String(a.project ?? ''))) out.add(String(a.project));
  }
  return out;
}

/**
 * Gen's lookup failed. Only Gen's own "not found" (404) means the asset or account isn't there (null, for the caller's
 * 404); anything else (Gen restarting, a timeout, a 5xx) is a 503 "didn't answer, retrying", which studio_gen_import retries.
 */
export function missingOr503(e: any): null {
  if (Number(e?.status) === 404) return null;
  throw new StudioError("Hawkes Gen didn't answer, retrying", 503);
}

export type GenFile = { bytes: Buffer; mime: string; project: string; title: string | null; ext: string };

const extOf = (mime: string, fallback = '.png') => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'model/gltf-binary': '.glb' } as Record<string, string>)[mime.split(';')[0].trim()] ?? fallback;
/** The largest file an import carries (it travels as JSON to the agent's tool). */
export const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

/**
 * The control plane's side (cells.ts /api/cells/self/gen-asset, the cell's key): one Gen file for one org, with Gen's
 * owner key, only from that org's Gen org, or (the org's `gen` widening, which the cell says it has) the personal Gen
 * account of one of the org's owners: people who signed in at the control plane with Google (cp_members, and the org's
 * own owner), never the people a cell reports about itself. Refusals name nothing of another org.
 */
export async function controlGenAsset(o: {
  asset: string; genOrg: string | null; ownerEmails: string[]; wantOwners: boolean;
  admin: (p: string) => Promise<any>; bytes: (asset: string) => Promise<{ bytes: Buffer; mime: string }>;
}): Promise<GenFile & { via: 'own' | 'owner' }> {
  if (!/^a_[0-9a-f]{8,40}$/.test(o.asset)) throw new StudioError('asset: a Gen asset id (a_...)', 400);
  if (!o.genOrg) throw new StudioError('This studio has no Hawkes Gen org yet.', 409);
  const a = await o.admin(`/assets/${o.asset}`).catch(missingOr503);
  const project = String(a?.project ?? '');
  const owners = o.wantOwners && isPersonalGen(project) ? await personalProjectsOf(o.ownerEmails, o.admin) : new Set<string>();
  const via = a ? genSourceOk(project, { own: o.genOrg, owners }) : null;
  if (!via) {
    if (a && isPersonalGen(project) && !o.wantOwners) throw new StudioError(`${o.asset} is in a personal Hawkes Gen library. Turn on "agents may use the owners' own Gen libraries" (Settings → Agents) for this Studio or project.`, 403);
    throw new StudioError(`No Gen file ${o.asset} this studio may use (its own Gen library, or its owners' own when that is on).`, 404);
  }
  const f = await o.bytes(o.asset);
  if (f.bytes.length > MAX_IMPORT_BYTES) throw new StudioError(`${o.asset} is ${Math.round(f.bytes.length / 1e6)} MB: over the ${MAX_IMPORT_BYTES / 1e6} MB an import carries.`, 413);
  return { ...f, project, title: a.title ?? null, ext: path.extname(String(a.path ?? '')) || extOf(f.mime), via };
}

/** Gen's API as the control plane's owner key (HAWKESGEN_URL, STUDIO_GEN_OWNER_KEY): JSON, and one file's bytes. */
export function ownerGen() {
  const url = (process.env.HAWKESGEN_URL ?? '').replace(/\/+$/, '');
  const key = process.env.STUDIO_GEN_OWNER_KEY?.trim() || '';
  if (!url || !key) throw new StudioError("Hawkes Gen is not set up for customers' Studios here (HAWKESGEN_URL, STUDIO_GEN_OWNER_KEY).", 503);
  const h = { Authorization: `Bearer ${key}` };
  return {
    admin: async (p: string) => {
      const r = await fetch(`${url}/v1${p}`, { headers: h, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new StudioError(`Hawkes Gen answered ${r.status}`, r.status === 404 ? 404 : 502);
      return r.json();
    },
    bytes: async (asset: string) => {
      const r = await fetch(`${url}/v1/files/${asset}`, { headers: h, signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new StudioError(`Hawkes Gen answered ${r.status} for ${asset}'s file`, 502);
      return { bytes: Buffer.from(await r.arrayBuffer()), mime: String(r.headers.get('content-type') ?? 'application/octet-stream') };
    },
  };
}

// ------------------------------------------------------------------ an import, in this Studio

export type ImportAsk = { asset: string; product: string; width?: number; height?: number; fit?: 'contain' | 'cover' | 'stretch'; format?: 'png' | 'jpg' | 'webp'; quality?: number };

/** The image.transform steps an ask needs, or null when the file goes in as it is. */
export function transformOf(a: Pick<ImportAsk, 'width' | 'height' | 'fit' | 'format' | 'quality'>) {
  const w = Math.round(Number(a.width) || 0);
  const h = Math.round(Number(a.height) || 0);
  if ((w && (w < 1 || w > 8192)) || (h && (h < 1 || h > 8192))) throw new StudioError('width and height: 1 to 8192 pixels', 400);
  const fit = a.fit && ['contain', 'cover', 'stretch'].includes(a.fit) ? a.fit : (w && h ? 'cover' : 'contain');
  const format = a.format ? (String(a.format).toLowerCase().replace('jpeg', 'jpg') as 'png' | 'jpg' | 'webp') : null;
  if (format && !['png', 'jpg', 'webp'].includes(format)) throw new StudioError('format: png, jpg or webp', 400);
  const quality = a.quality === undefined ? null : Math.round(Number(a.quality));
  if (quality !== null && !(quality >= 1 && quality <= 100)) throw new StudioError('quality: 1 to 100', 400);
  if (!w && !h && !format && quality === null) return null;
  return { ops: w || h ? [{ op: 'resize', ...(w ? { width: w } : {}), ...(h ? { height: h } : {}), fit }] : [], format: format ?? 'png', ...(quality !== null ? { quality } : {}) };
}

/** The format a file's name asks for (.jpg → jpg), or null. */
export const formatOfPath = (p: string) => ({ '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.webp': 'webp' } as Record<string, 'jpg' | 'png' | 'webp'>)[path.extname(String(p)).toLowerCase()] ?? null;

/**
 * One Gen file for one of this Studio's products: the Studio's own Gen library first (its own key), else, in a cell,
 * through the control plane, else (J's Studio) Gen's own answer checked against genSourceOk. A file from outside the
 * Studio's own library is copied into it first (the product's Gen project, so it shows in its library and usage), and
 * resized or converted there with image.transform (free, Gen's CPU) when asked. Returns the final bytes.
 */
export async function importGenFile(ask: ImportAsk, deps: Partial<ImportDeps> = {}) {
  const d = { ...(await defaultImportDeps()), ...deps };
  const access = await d.access(ask.product);
  const step = transformOf(ask);
  // 1. Where the file is, and whether this Studio may use it.
  let src: GenFile & { via: 'own' | 'owner' };
  const mine = await d.ownAsset(ask.asset).catch(missingOr503);
  const ownOk = mine ? genSourceOk(mine.project, { own: d.ownOrg(), owners: new Set() }) : null;
  if (mine && ownOk) src = { ...(await d.ownBytes(ask.asset, mine)), via: 'own' };
  else if (d.inCell()) src = await d.cellAsset(ask.asset, access.gen);
  else {
    // J's Studio: its Gen key can be Gen's owner, which reaches every account: only its own projects, and its admins'
    // own accounts when the widening is on.
    const owners = access.gen && mine && isPersonalGen(mine.project) ? await d.ownerProjects() : new Set<string>();
    const via = mine ? genSourceOk(mine.project, { own: null, owners }) : null;
    if (!mine || !via) {
      if (mine && isPersonalGen(mine.project) && !access.gen) throw new StudioError(`${ask.asset} is in a personal Hawkes Gen library. Turn on "agents may use the owners' own Gen libraries" (Settings → Agents) for this Studio or project.`, 403);
      throw new StudioError(`No Gen file ${ask.asset} this studio may use.`, 404);
    }
    src = { ...(await d.ownBytes(ask.asset, mine)), via };
  }
  // 2. Into the Studio's own library when it came from elsewhere, so a transform (and the record) happen there.
  let local = src.via === 'own' ? ask.asset : null;
  const copyIn = d.copyIn;
  if (!local && copyIn) local = await copyIn(ask.product, src, ask.asset).catch((e: any) => { if (step) throw e; return null; });
  if (step && !local) throw new StudioError(`${ask.asset} couldn't be copied into this Studio's Gen library to resize it.`, 502);
  // 3. Resize or convert there.
  let out = { bytes: src.bytes, mime: src.mime, ext: src.ext };
  let made: string | null = null;
  if (step) {
    const r = await d.transform(ask.product, local!, step);
    made = r.asset;
    out = { bytes: r.bytes, mime: r.mime, ext: `.${step.format}` };
  }
  return { ...out, source: { asset: ask.asset, project: src.project, via: src.via, title: src.title }, copy: local !== ask.asset ? local : null, made };
}

export type ImportDeps = {
  access: (product: string) => Promise<AgentAccess>;
  ownOrg: () => string | null;
  inCell: () => boolean;
  ownAsset: (asset: string) => Promise<{ project: string; title?: string | null; path?: string; mime?: string } | null>;
  ownBytes: (asset: string, meta: { project: string; title?: string | null; path?: string }) => Promise<GenFile>;
  cellAsset: (asset: string, owners: boolean) => Promise<GenFile & { via: 'own' | 'owner' }>;
  ownerProjects: () => Promise<Set<string>>;
  copyIn: ((product: string, f: GenFile, from: string) => Promise<string>) | null;
  transform: (product: string, asset: string, step: NonNullable<ReturnType<typeof transformOf>>) => Promise<{ asset: string; bytes: Buffer; mime: string }>;
};

async function defaultImportDeps(): Promise<ImportDeps> {
  const { gen, genProject, genWait } = await import('./gen.ts');
  const cellside = await import('./cellside.ts');
  const prefix = process.env.HAWKESGEN_PROJECT_PREFIX?.trim() || '';
  const bytesOf = async (asset: string) => {
    const r = await gen.request(`/files/${asset}`, { raw: true });
    return { bytes: Buffer.from(await r.arrayBuffer()), mime: String(r.headers.get('content-type') ?? 'application/octet-stream') };
  };
  return {
    access: agentAccess,
    ownOrg: () => (prefix ? prefix.replace(/\.$/, '') : null),
    inCell: () => cellside.inCell(),
    ownAsset: async (asset) => {
      try { return await gen.asset(asset); } catch (e) { return missingOr503(e); }
    },
    ownBytes: async (asset, meta) => {
      const f = await bytesOf(asset);
      if (f.bytes.length > MAX_IMPORT_BYTES) throw new StudioError(`${asset} is over the ${MAX_IMPORT_BYTES / 1e6} MB an import carries.`, 413);
      return { ...f, project: meta.project, title: meta.title ?? null, ext: path.extname(String(meta.path ?? '')) || extOf(f.mime) };
    },
    cellAsset: (asset, owners) => cellside.cellGenAsset(asset, owners),
    ownerProjects: async () => {
      // This Studio's admins (verified Google sign-ins): their own hawkesgen.ai accounts, through Gen's owner search.
      const { listUsers } = await import('./auth.ts');
      const emails = listUsers().filter((u: any) => u.role === 'admin' && !u.disabled).map((u: any) => u.email);
      return personalProjectsOf(emails, (p) => gen.request(p));
    },
    copyIn: async (product, f, from) => {
      const name = `${(f.title || from).replace(/[^\w .-]+/g, '').trim().slice(0, 60) || from}${f.ext}`.replace(/\s+/g, '_');
      const r = await gen.request(`/assets?project=${encodeURIComponent(String(genProject(product)))}&title=${encodeURIComponent(`Imported ${from}: ${f.title ?? ''}`.trim())}&normalize=0`, {
        method: 'POST', body: new Uint8Array(f.bytes), headers: { 'X-Filename': name.replace(/[^ -~]/g, '_'), 'Content-Type': f.mime || 'application/octet-stream' },
      });
      return String(r.asset?.id ?? r.id);
    },
    transform: async (product, asset, step) => {
      const job = await gen.submit('image.transform', { project: genProject(product), params: { ops: step.ops.length ? step.ops : [{ op: 'scale', factor: 1 }], format: step.format, ...(step.quality ? { quality: step.quality } : {}) }, inputs: { image: `asset:${asset}` }, labels: { import: asset } });
      const done = await genWait(job.id, undefined, 15 * 60_000);
      if (done.status !== 'done') throw new StudioError(`image.transform ${done.status}: ${done.error ?? done.detail ?? ''}`, 502);
      const o = (done.outputs ?? [])[0];
      if (!o?.asset) throw new StudioError('image.transform made no file', 502);
      return { asset: String(o.asset), ...(await bytesOf(String(o.asset))) };
    },
  };
}

// ------------------------------------------------------------------ the agent's call (POST /api/agents/gen-import)

export { safeRepoPath, writeImport } from './repo-write.ts';
import { safeRepoPath } from './repo-write.ts';

/**
 * Who is importing and for which product: an agent's own MCP server names its running change (X-Studio-Agent); a person
 * or Talk names the product. An agent's change must be running, so a finished change's id opens nothing.
 */
export async function importerOf(header: string, product: unknown): Promise<{ who: string; product: string; change: string | null }> {
  if (/^c_[0-9a-f]{12}$/.test(header)) {
    const { getChange } = await import('./agents.ts');
    const c = getChange(header);
    if (!c || !['working', 'revising', 'verifying'].includes(String(c.status))) throw new StudioError('Only a running agent change imports Gen files.', 403);
    return { who: header, product: c.product, change: header };
  }
  if (/^x_[0-9a-f]{12}$/.test(header)) throw new StudioError("Scouts don't import files.", 403);
  const id = String(product ?? '').trim();
  if (!loadProducts().some((p) => p.id === id)) throw new StudioError('product: one of this Studio\'s project ids', 400);
  return { who: 'talk-or-owner', product: id, change: null };
}

// ------------------------------------------------------------------ other repos, read-only, for an agent's job

/** The other repositories of this Studio's projects (owner/name), besides the ones this product's work already has. */
export async function siblingRepos(productId: string): Promise<string[]> {
  const { productSlugs } = await import('./repos.ts');
  const all = loadProducts();
  const me = all.find((p) => p.id === productId);
  const mine = new Set((me ? productSlugs(me as any) : []).map((s) => s.toLowerCase()));
  const out = new Map<string, string>();
  for (const p of all) {
    if (p.id === productId || (p as any).managedBy) continue;
    for (const s of productSlugs(p as any)) if (!mine.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
  }
  // A customer's Studio never lists Hawkes Studio's owner's repos it wasn't given (config.ts checkRepoOwnership made sure).
  return [...out.values()].slice(0, 30);
}

export type ExtraRepo = { slug: string; remote: string; token: string | null; dir: string };

/** Where an agent's job puts a sibling repo: next to its worktree, outside it, so nothing of it goes back as its work. */
export const extraRepoDir = (worktree: string, slug: string) => path.join(`${worktree.replace(/[\\/]+$/, '')}.repos`, slug.split('/')[1]);

/**
 * The read-only clones an agent's job gets (cloudjob.ts): only for an agent change's worktree whose product has the
 * repos widening, skipping big repos (Unity's) and any the Studio has no token for. Each token is read-only and scoped
 * to that one repo.
 */
export async function extraReposFor(worktree: string, deps: { token?: (slug: string) => Promise<string | null>; big?: (slug: string) => Promise<string | null> } = {}): Promise<ExtraRepo[]> {
  const row = db.prepare('SELECT id FROM changes WHERE worktree = ? OR worktree = ?').get(worktree, path.resolve(worktree)) as { id: string } | undefined;
  if (!row) return [];
  const id = row.id;
  const { getChange } = await import('./agents.ts');
  const c = getChange(id);
  if (!c || c.infra) return [];
  if (!(await agentAccess(c.product)).repos) return [];
  const token = deps.token ?? (async (s: string) => (await import('./ghtoken.ts')).readRepoToken(s));
  const big = deps.big ?? (async (s: string) => (await import('./repos.ts')).bigRepo(s).catch(() => null));
  const out: ExtraRepo[] = [];
  for (const slug of await siblingRepos(c.product)) {
    if (await big(slug)) continue;
    const t = await token(slug).catch(() => null);
    if (!t && customerStudio()) continue;
    out.push({ slug, remote: `https://github.com/${slug}.git`, token: t, dir: extraRepoDir(worktree, slug) });
    logAccess({ who: id, product: c.product, kind: 'repo', source: slug, target: 'read-only clone', detail: null });
  }
  return out;
}

/** The brief's lines about what the agent may reach (agents.ts writeBrief). */
export function accessBrief(a: AgentAccess, repos: { slug: string; dir: string }[]): string {
  const lines = [
    '\n## Studio\'s tools, and Talk\n',
    'You have Studio\'s own tools, the same ones Talk has (the `hawkesstudio` MCP server): the backlog, reports, playtests,',
    'previews, the roadmap, the other projects, deploy plans. Read whatever helps. `studio_task` starts work in another',
    `project (up to ${AGENT_STARTS}; work you start can't start more). Going live, rollbacks and Approve cards stay the owner's.`,
    'To tell the owner something while you work (a result, a question you can carry on without), use `studio_tell`: it goes',
    'to Talk, which passes it on. A question you can\'t go on without still goes in `.hawkes/question.md` (see above).',
    'GitHub: `studio_github_api` makes REST calls to any of this Studio\'s repos with Studio\'s own token (issues, pull',
    'requests, Actions runs and logs, search, branches of your own). There is no GitHub token in your shell, so use it',
    'instead of `gh` or `curl`. Merging and approving stay with Studio\'s gates.',
    '\n## Files from Hawkes Gen\n',
    'To put a file from Hawkes Gen into this repo (an image, a sound, a model), call `studio_gen_import` with its asset id',
    '(`a_...`) and the path in the repo; give `width`/`height`/`format`/`quality` to resize or convert an image (Gen does it,',
    'free). It writes the file for you: no download, key or converter needed. Then commit it.',
    a.gen ? 'It takes files from this Studio\'s own Gen library and from its owners\' own hawkesgen.ai libraries.' : 'It takes files from this Studio\'s own Gen library.',
  ];
  if (repos.length) {
    lines.push('\n## The Studio\'s other repositories (read-only)\n', 'Shallow clones of the other projects\' repositories, to read (not to change: a change there is that project\'s own task):');
    for (const r of repos) lines.push(`- \`${r.slug}\`: \`${r.dir}\``);
  }
  return `${lines.join('\n')}\n`;
}


// ------------------------------------------------------------------ agents starting work, and talking to Talk

/** Tasks one agent change may start with studio_task / studio_fix. */
export const AGENT_STARTS = 3;

/**
 * Before an agent's call starts a change (server.ts POST /api/changes): null when the caller isn't an agent change;
 * else its id, once it may (it is running, it wasn't itself started by an agent, and it has started fewer than
 * AGENT_STARTS). A guard against a loop of agents, not a security line: that is the Studio's own keys.
 */
export function agentStarts(header: string): string | null {
  if (!/^c_[0-9a-f]{12}$/.test(header)) return null;
  const c = db.prepare('SELECT status, started_by FROM changes WHERE id = ?').get(header) as { status: string; started_by: string | null } | undefined;
  if (!c || !['working', 'revising', 'verifying'].includes(c.status)) throw new StudioError('Only a running agent starts work.', 403);
  if (String(c.started_by ?? '').startsWith('agent ')) throw new StudioError('This task was started by another agent, so it does not start more: tell Talk what else needs doing (studio_tell).', 403);
  const n = (db.prepare('SELECT COUNT(*) AS n FROM changes WHERE started_by = ?').get(`agent ${header}`) as { n: number }).n;
  if (n >= AGENT_STARTS) throw new StudioError(`This agent has started ${n} tasks, the most one may: tell Talk what else needs doing (studio_tell).`, 429);
  return header;
}

/**
 * An agent telling Talk something while it works (studio_tell): progress, a result, or a question for the owner. It lands
 * in the Talk conversation the change reports to, and Talk passes it on to the owner in its own words; with no such
 * conversation (the PM's work, the daily run) a question goes to the owner's Inbox and the rest to the change's log.
 * The agent doesn't wait for the answer: it carries on, or ends its pass saying what it waits on.
 */
export async function agentSays(header: string, b: { text?: unknown; kind?: unknown; options?: unknown; recommend?: unknown }) {
  if (!/^c_[0-9a-f]{12}$/.test(header)) throw new StudioError('studio_tell is for agents (their own change).', 403);
  const text = String(b.text ?? '').trim().slice(0, 2000);
  if (!text) throw new StudioError('text: what to tell Talk', 400);
  const kind = ['question', 'result', 'update'].includes(String(b.kind)) ? String(b.kind) as 'question' | 'result' | 'update' : 'update';
  const c = db.prepare('SELECT id, product, status, origin, request FROM changes WHERE id = ?').get(header) as any;
  if (!c || !['working', 'revising', 'verifying'].includes(c.status)) throw new StudioError('Only a running agent tells Talk things.', 403);
  const options = Array.isArray(b.options) ? b.options.map((x) => String(x).slice(0, 80)).slice(0, 5) : [];
  const { changeLog } = await import('./agents.ts');
  changeLog(header, `told Talk (${kind}): ${text.slice(0, 300)}`);
  const conv = c.origin && db.prepare("SELECT 1 FROM conversations WHERE id = ? AND COALESCE(kind, '') != 'pm'").get(c.origin) ? String(c.origin) : null;
  const label = { question: 'asks', result: 'reports', update: 'says' }[kind];
  if (conv) {
    const { studioSays } = await import('./talk.ts');
    const line = `The agent working on ${c.product} (${header}) ${label}: ${text}${options.length ? `\nOptions: ${options.join(' / ')}${b.recommend ? ` (it would pick ${String(b.recommend).slice(0, 80)})` : ''}` : ''}${kind === 'question' ? `\nAsk the owner; pass their answer on with studio_change { id: "${header}", action: "revise", note } once it is ready (it carries on meanwhile).` : ''}`;
    studioSays(conv, line);
    return { ok: true, to: 'talk', conversation: conv };
  }
  if (kind === 'question') {
    const { askJ } = await import('./pm.ts');
    const q = askJ(text, { subject: header, product: c.product, options: options.length ? options : undefined, recommend: b.recommend ? String(b.recommend) : null, from: `agent ${header}` } as any);
    return { ok: true, to: 'inbox', question: q };
  }
  return { ok: true, to: 'log', note: 'No Talk conversation follows this change, so it went on the change\'s log; the owner sees it with the change.' };
}

/** An agent paused on a question (.hawkes/question.md): the conversation its change reports to hears it, for Talk to ask. */
export async function agentPaused(id: string, question: string) {
  const c = db.prepare('SELECT product, origin, task FROM changes WHERE id = ?').get(id) as { product: string; origin: string | null; task: string | null } | undefined;
  if (!c?.origin || c.task || !db.prepare("SELECT 1 FROM conversations WHERE id = ? AND COALESCE(kind, '') != 'pm'").get(c.origin)) return false;
  const { studioSays } = await import('./talk.ts');
  return studioSays(c.origin, `The agent working on ${c.product} (${id}) stopped to ask: ${question.slice(0, 1500)}\nAsk the owner; send their answer with studio_change { id: "${id}", action: "answer", note } and it carries on.`);
}
