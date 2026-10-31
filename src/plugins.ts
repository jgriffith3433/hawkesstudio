// Plugins (docs/plugins.md; J, 2026-10-31: "Hawkes Net can turn into a 'plugin' (both Unity and Babylon, and we can
// support other frameworks later) then we can start offering a suite of plugins and show when plugins are available or
// if installed and what version and allow upgrading if out of date etc. Really make this powerful.").
//
// The catalog is data (plugins/catalog.json): each plugin, per engine, an install recipe (upm-git, upm-embed, npm-tarball,
// npm, script-tag, copy-file) and where its versions come from (a GitHub repo's v<semver> tags, a package.json in a repo,
// a file Studio ships, a fixed list). A new plugin is a catalog entry, no code.
//
// For a project (any repo, any engine) Studio reads its repositories through GitHub's API at beta (else main) with each
// repo's own token (ghtoken.ts), finds Packages/manifest.json, package.json and index.html files anywhere in the tree,
// and says per plugin: installed or not, which version and where, the latest, outdated. Installing or upgrading is a plan
// of exact text edits that keep the file's formatting, committed on a branch plugin/<id>-<version> from beta through the
// Git Data API and opened as a pull request into beta. Plugins whose setup needs code (wiring Hawkes Net into the game)
// can go to an agent instead: a change whose brief starts from that branch.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type http from 'node:http';
import { db, newId } from './db.ts';
import { ROOT, getProduct, StudioError, type Product } from './config.ts';
import { repoMap } from './repos.ts';

// ------------------------------------------------------------------ the catalog

export const KINDS = ['upm-git', 'upm-embed', 'npm-tarball', 'npm', 'script-tag', 'copy-file'] as const;
export const ENGINES = ['unity', 'web', 'babylon', 'godot'] as const;
export type Kind = (typeof KINDS)[number];
export type Engine = (typeof ENGINES)[number];
export type VersionSource =
  | { source: 'github-tags'; repo: string; prefix?: string }
  | { source: 'package-json'; repo: string; path: string; ref?: string }
  | { source: 'studio-file'; path: string; match?: string }
  | { source: 'fixed'; list: string[] }
  | { source: 'none' };
export type Recipe = {
  kind: Kind; versions: VersionSource; available?: boolean; why?: string; docs?: string;
  /** upm-*, npm*: the package name. */
  package?: string;
  /** upm-git: the git URL without its #v<version>. */
  git?: string;
  /** npm-tarball: the tarball URL, {version} in it. */
  tarball?: string;
  /** upm-embed: a folder of Studio's own files copied into Packages/<package>/. */
  from?: string;
  /** copy-file: Studio's files copied into the project (the first one carries the version marker). */
  files?: { from: string; name: string }[];
  marker?: string;
  /** script-tag: the script's address and its whole line (templates), and how an installed one is recognised (a regex; group 1 the version). */
  src?: string; tag?: string; detect?: string;
};
export type Plugin = { id: string; name: string; description: string; gives: string[]; homepage?: string; docs?: string; category?: string; setup: string[]; brief?: string; engines: Partial<Record<Engine, Recipe>> };
export type Catalog = { version: number; plugins: Plugin[] };

export const catalogPath = () => process.env.STUDIO_PLUGINS_CATALOG || path.join(ROOT, 'plugins', 'catalog.json');

/** What is wrong with a catalog (empty: fine). */
export function validateCatalog(c: any): string[] {
  const errs: string[] = [];
  if (!c || !Array.isArray(c.plugins)) return ['plugins: a list'];
  const ids = new Set<string>();
  for (const p of c.plugins) {
    const at = `plugin ${p?.id ?? '?'}`;
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(String(p?.id ?? ''))) errs.push(`${at}: id is lowercase letters, digits and dashes`);
    if (ids.has(p.id)) errs.push(`${at}: id is used twice`);
    ids.add(p.id);
    for (const f of ['name', 'description']) if (typeof p[f] !== 'string' || !p[f].trim()) errs.push(`${at}: ${f}`);
    if (!Array.isArray(p.gives)) errs.push(`${at}: gives (a list)`);
    if (!Array.isArray(p.setup)) errs.push(`${at}: setup (a list of notes)`);
    if (!p.engines || typeof p.engines !== 'object' || !Object.keys(p.engines).length) { errs.push(`${at}: engines`); continue; }
    for (const [e, r] of Object.entries<any>(p.engines)) {
      const where = `${at} ${e}`;
      if (!(ENGINES as readonly string[]).includes(e)) errs.push(`${where}: engine is one of ${ENGINES.join(', ')}`);
      if (!(KINDS as readonly string[]).includes(r?.kind)) { errs.push(`${where}: kind is one of ${KINDS.join(', ')}`); continue; }
      const live = r.available !== false;
      const need = (f: string) => { if (typeof r[f] !== 'string' || !r[f]) errs.push(`${where}: ${r.kind} needs ${f}`); };
      if (r.kind.startsWith('upm') || r.kind.startsWith('npm')) need('package');
      if (r.kind === 'upm-git' && live) need('git');
      if (r.kind === 'npm-tarball' && live) need('tarball');
      if (r.kind === 'upm-embed') need('from');
      if (r.kind === 'script-tag') { need('src'); need('tag'); need('detect'); }
      if (r.kind === 'copy-file') {
        if (!Array.isArray(r.files) || !r.files.length || r.files.some((f: any) => !f?.from || !/^[\w.-]+$/.test(String(f?.name ?? '')))) errs.push(`${where}: copy-file needs files [{ from, name }]`);
        need('marker');
      }
      for (const re of ['detect', 'marker']) if (r[re]) try { new RegExp(r[re]); } catch { errs.push(`${where}: ${re} is not a regex`); }
      const v = r.versions;
      const src = v?.source;
      if (!['github-tags', 'package-json', 'studio-file', 'fixed', 'none'].includes(src)) errs.push(`${where}: versions.source is github-tags | package-json | studio-file | fixed | none`);
      if ((src === 'github-tags' || src === 'package-json') && !/^[\w.-]+\/[\w.-]+$/.test(String(v.repo ?? ''))) errs.push(`${where}: versions.repo (owner/name)`);
      if ((src === 'package-json' || src === 'studio-file') && !v.path) errs.push(`${where}: versions.path`);
      if (src === 'fixed' && (!Array.isArray(v.list) || !v.list.length)) errs.push(`${where}: versions.list`);
      if (src === 'studio-file' && live && !fs.existsSync(path.join(ROOT, v.path))) errs.push(`${where}: Studio has no ${v.path}`);
      for (const f of r.kind === 'copy-file' ? r.files ?? [] : r.kind === 'upm-embed' ? [{ from: r.from }] : []) if (live && f?.from && !fs.existsSync(path.join(ROOT, f.from))) errs.push(`${where}: Studio has no ${f.from}`);
    }
  }
  return errs;
}

export function loadCatalog(): Catalog {
  const c = JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));
  const errs = validateCatalog(c);
  if (errs.length) throw new StudioError(`The plugin catalog has problems: ${errs.join('; ')}`, 500);
  return c;
}
export function getPlugin(id: string): Plugin {
  const p = loadCatalog().plugins.find((x) => x.id === id);
  if (!p) throw new StudioError(`No plugin "${id}". Plugins: ${loadCatalog().plugins.map((x) => x.id).join(', ')}`, 404);
  return p;
}

// ------------------------------------------------------------------ versions

const VERSION = /^v?(\d+(?:\.\d+)*)$/;
/** Dotted numbers compared part by part (missing parts are 0). */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
export const isVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v);
/** An installed version older than the latest (a local path or an unknown version is never "outdated"). */
export const isOutdated = (installed: string | null, latest: string | null) => isVersion(installed) && isVersion(latest) && cmpVersion(installed, latest) < 0;
const newest = (list: string[]) => list.filter(isVersion).map((v) => v.replace(/^v/, '')).sort(cmpVersion).at(-1) ?? null;

const latestCache = new Map<string, { at: number; v: string | null }>();
const LATEST_TTL = 10 * 60_000;
export const forgetLatest = () => latestCache.clear();

/** GitHub's API with the repo's own token when Studio has one (a public repo works without). */
async function ghFor(slug: string) {
  const { repoToken, githubFetch } = await import('./ghtoken.ts');
  const token = await repoToken(slug).catch(() => null);
  const f = githubFetch(token, (u: any, i: any) => globalThis.fetch(u, i));
  return (route: string, init: any = {}) => f(`https://api.github.com${route}`, { ...init, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } });
}

/** The newest version of a plugin for one engine (cached 10 minutes); null when none can be read. */
export async function latestVersion(plugin: Plugin | string, engine: Engine | string): Promise<string | null> {
  const p = typeof plugin === 'string' ? getPlugin(plugin) : plugin;
  const r = p.engines[engine as Engine];
  if (!r) throw new StudioError(`${p.name} has no ${engine} version (it has ${Object.keys(p.engines).join(', ')})`, 404);
  const key = `${p.id}:${engine}`;
  const hit = latestCache.get(key);
  if (hit && Date.now() - hit.at < LATEST_TTL) return hit.v;
  let v: string | null = null;
  const s = r.versions;
  try {
    if (s.source === 'github-tags') {
      const gh = await ghFor(s.repo);
      const res = await gh(`/repos/${s.repo}/tags?per_page=100`);
      if (res.ok) {
        const pre = s.prefix ?? '';
        v = newest(((await res.json()) as any[]).map((t) => String(t.name)).filter((n) => n.startsWith(pre)).map((n) => n.slice(pre.length)));
      }
    } else if (s.source === 'package-json') {
      const gh = await ghFor(s.repo);
      const res = await gh(`/repos/${s.repo}/contents/${s.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(s.ref ?? 'main')}`, { headers: { Accept: 'application/vnd.github.raw' } });
      if (res.ok) v = String(JSON.parse(decodeBody(await res.text())).version ?? '') || null;
    } else if (s.source === 'studio-file') {
      const text = fs.readFileSync(path.join(ROOT, s.path), 'utf8');
      v = s.match ? new RegExp(s.match).exec(text)?.[1] ?? null : String(JSON.parse(text).version ?? '') || null;
    } else if (s.source === 'fixed') v = newest(s.list);
  } catch (e: any) {
    console.warn(`[plugins] latest ${key}: ${e?.message ?? e}`);
  }
  latestCache.set(key, { at: Date.now(), v });
  return v;
}

/** The catalog with each engine's latest version (GET /api/plugins). */
export async function catalogWithLatest() {
  const c = loadCatalog();
  return Promise.all(c.plugins.map(async (p) => ({
    ...p,
    engines: Object.fromEntries(await Promise.all(Object.entries(p.engines).map(async ([e, r]) => [e, { ...r, available: r!.available !== false, latest: await latestVersion(p, e) }]))),
  })));
}

// ------------------------------------------------------------------ a project's repositories

export type RepoRef = { slug: string; sub: string; role: string };

/** The repositories a project lives in: its main one (maybe a subfolder), a Unity game's website, and its other repos. */
export function projectRepos(p: Product): RepoRef[] {
  const out: RepoRef[] = [];
  const add = (slug: string | null | undefined, sub: string, role: string) => {
    if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug) || out.some((r) => r.slug.toLowerCase() === slug.toLowerCase())) return;
    out.push({ slug, sub: sub.replace(/^\/+|\/+$/g, ''), role });
  };
  let map: Record<string, string> = {};
  try { map = repoMap(); } catch { map = {}; }
  const viaFolder = (folder: string | undefined) => {
    if (!folder) return null;
    const [top, ...rest] = folder.split('/');
    return map[top] ? { slug: map[top], sub: rest.join('/') } : null;
  };
  const gh = (p as any).github as string | undefined;
  const main = gh ? { slug: gh, sub: '' } : viaFolder(p.repo) ?? (/^[\w.-]+\/[\w.-]+$/.test(p.repo ?? '') ? { slug: p.repo, sub: '' } : null);
  if (main) add(main.slug, main.sub, 'main');
  // A Unity game's website (J's products: build.site, the folder its Game/ goes to).
  const site = p.site && p.site.split('/')[0] !== String(p.repo ?? '').split('/')[0] ? viaFolder(p.site) : null;
  if (site) add(site.slug, site.sub, 'site');
  for (const r of p.repos ?? []) add(r.repo, '', r.role || r.repo.split('/')[1]);
  return out;
}

// ------------------------------------------------------------------ reading a repository

const SKIP = /(^|\/)(node_modules|Library|Temp|obj|Logs|UserSettings|Builds?|dist|play|\.git|\.github|\.hawkes|coverage|Game\/v\d+)(\/|$)/;
const decodeBody = (t: string) => {
  // GitHub answers the raw file for Accept: raw; a stand-in or a proxy may answer the JSON with base64 content.
  if (t.startsWith('{') && t.includes('"encoding"')) {
    try { const j = JSON.parse(t); if (j.encoding === 'base64' && typeof j.content === 'string') return Buffer.from(j.content, 'base64').toString('utf8'); } catch { /* the file itself */ }
  }
  return t;
};
/** Git's blob id of some text: lets a plan skip files that are already the same. */
export const blobSha = (text: string) => { const b = Buffer.from(text, 'utf8'); return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };

export type RepoScan = {
  slug: string; sub: string; role: string; ref: string; blobs: Map<string, string>;
  manifests: string[]; packages: string[]; htmls: string[];
  read: (p: string) => Promise<string>;
  error?: string;
};

/** A repo's files at beta (else main, else its default branch), with a reader that fetches and keeps a file's text. */
export async function scanRepo(r: RepoRef): Promise<RepoScan> {
  const gh = await ghFor(r.slug);
  const empty = (error: string): RepoScan => ({ ...r, ref: '', blobs: new Map(), manifests: [], packages: [], htmls: [], read: async () => '', error });
  let tree: any = null;
  let ref = '';
  const refs = ['beta', 'main'];
  for (let i = 0; i < refs.length && !tree; i++) {
    const res = await gh(`/repos/${r.slug}/git/trees/${refs[i]}?recursive=1`);
    if (res.ok) { tree = await res.json(); ref = refs[i]; }
    else if (res.status === 401 || res.status === 403) return empty(`Studio has no GitHub access to ${r.slug} (${res.status}): connect GitHub and install the app on it`);
    if (!tree && i === refs.length - 1) {
      const info = await gh(`/repos/${r.slug}`);
      const def = info.ok ? String((await info.json()).default_branch ?? '') : '';
      if (def && !refs.includes(def)) { const t = await gh(`/repos/${r.slug}/git/trees/${def}?recursive=1`); if (t.ok) { tree = await t.json(); ref = def; } }
      if (!tree) return empty(info.status === 404 ? `${r.slug} isn't on GitHub, or Studio can't see it` : `couldn't read ${r.slug}'s files`);
    }
  }
  const prefix = r.sub ? `${r.sub}/` : '';
  const blobs = new Map<string, string>();
  for (const e of tree.tree ?? []) if (e.type === 'blob' && String(e.path).startsWith(prefix)) blobs.set(String(e.path), String(e.sha));
  const live = [...blobs.keys()].filter((f) => !SKIP.test(f));
  const byDepth = (a: string, b: string) => a.split('/').length - b.split('/').length || a.localeCompare(b);
  const manifests = live.filter((f) => /(^|\/)Packages\/manifest\.json$/.test(f)).sort(byDepth);
  // package.json files of the web project (never a Unity package's own package.json, under Packages/ or Assets/).
  const packages = live.filter((f) => /(^|\/)package\.json$/.test(f) && !/(^|\/)(Packages|Assets|ProjectSettings)\//.test(f)).sort(byDepth).slice(0, 30);
  const htmls = live.filter((f) => /(^|\/)index\.html?$/i.test(f) && !/(^|\/)(Packages|Assets|ProjectSettings|TemplateData|test|tests|examples?)\//i.test(f)).sort(byDepth).slice(0, 20);
  const texts = new Map<string, Promise<string>>();
  const read = (f: string) => {
    if (!texts.has(f)) {
      const sha = blobs.get(f);
      texts.set(f, sha ? gh(`/repos/${r.slug}/git/blobs/${sha}`, { headers: { Accept: 'application/vnd.github.raw' } }).then(async (res) => {
        if (!res.ok) throw new Error(`couldn't read ${f} in ${r.slug}: ${res.status}`);
        return decodeBody(Buffer.from(await res.arrayBuffer()).toString('utf8'));
      }) : Promise.resolve(''));
    }
    return texts.get(f)!;
  };
  return { ...r, ref, blobs, manifests, packages, htmls, read };
}

const scanCache = new Map<string, { at: number; scans: Promise<RepoScan[]> }>();
const SCAN_TTL = 60_000;
export const forgetScans = (project?: string) => (project ? scanCache.delete(project) : scanCache.clear());
function scansOf(p: Product, fresh = false) {
  const hit = scanCache.get(p.id);
  if (!fresh && hit && Date.now() - hit.at < SCAN_TTL) return hit.scans;
  const scans = Promise.all(projectRepos(p).map((r) => scanRepo(r).catch((e: any): RepoScan => ({ ...r, ref: '', blobs: new Map(), manifests: [], packages: [], htmls: [], read: async () => '', error: String(e?.message ?? e) }))));
  scanCache.set(p.id, { at: Date.now(), scans });
  return scans;
}

// ------------------------------------------------------------------ JSON edits that keep the file's formatting

type Span = { start: number; end: number };
type Entry = { key: string; keyStart: number; valueStart: number; valueEnd: number; value: Span };

function skipWs(t: string, i: number) { while (i < t.length && /\s/.test(t[i])) i++; return i; }
function stringEnd(t: string, i: number) { // t[i] === '"'
  for (let j = i + 1; j < t.length; j++) { if (t[j] === '\\') j++; else if (t[j] === '"') return j + 1; }
  throw new Error('an unterminated string');
}
function valueEnd(t: string, i: number): number {
  if (t[i] === '"') return stringEnd(t, i);
  if (t[i] === '{' || t[i] === '[') {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (c === '"') { j = stringEnd(t, j) - 1; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (!depth) return j + 1; }
    }
    throw new Error('an unclosed object');
  }
  let j = i;
  while (j < t.length && !/[,}\]\s]/.test(t[j])) j++;
  return j;
}
/** The entries of the object that opens at `open` (t[open] === '{'). */
function entriesOf(t: string, open: number): { entries: Entry[]; close: number } {
  const entries: Entry[] = [];
  let i = skipWs(t, open + 1);
  while (t[i] !== '}') {
    if (t[i] !== '"') throw new Error(`expected a key at ${i}`);
    const ke = stringEnd(t, i);
    const key = JSON.parse(t.slice(i, ke));
    let j = skipWs(t, ke);
    if (t[j] !== ':') throw new Error(`expected : at ${j}`);
    const vs = skipWs(t, j + 1);
    const ve = valueEnd(t, vs);
    entries.push({ key, keyStart: i, valueStart: vs, valueEnd: ve, value: { start: vs, end: ve } });
    i = skipWs(t, ve);
    if (t[i] === ',') i = skipWs(t, i + 1);
  }
  return { entries, close: i };
}
const lineStart = (t: string, i: number) => t.lastIndexOf('\n', i - 1) + 1;
const indentAt = (t: string, i: number) => /^[ \t]*/.exec(t.slice(lineStart(t, i)))![0];
export const lineOf = (t: string, i: number) => t.slice(0, i).split('\n').length;
const nlOf = (t: string) => (t.includes('\r\n') ? '\r\n' : '\n');

/** Inserts "name": raw into the object at `open`, in sorted place when its keys are sorted, else last. */
function insertEntry(t: string, open: number, name: string, raw: string, sortedPlace = true): string {
  const { entries, close } = entriesOf(t, open);
  const nl = nlOf(t);
  if (!entries.length) {
    const outer = indentAt(t, open);
    const unit = outer || '  ';
    return `${t.slice(0, open + 1)}${nl}${outer}${unit}${JSON.stringify(name)}: ${raw}${nl}${outer}${t.slice(close)}`;
  }
  const first = entries[0];
  const indent = indentAt(t, first.keyStart);
  const sep = t.slice(t.indexOf(':', stringEnd(t, first.keyStart)) , first.valueStart).replace(/^:/, '');
  const line = `${JSON.stringify(name)}:${sep}${raw}`;
  const keys = entries.map((e) => e.key.toLowerCase());
  const sorted = sortedPlace && keys.every((k, i) => !i || keys[i - 1] <= k);
  const before = sorted ? entries.find((e) => e.key.toLowerCase() > name.toLowerCase()) : undefined;
  const oneLine = entries.every((e) => lineOf(t, e.keyStart) === lineOf(t, open));
  if (before) {
    if (oneLine) return `${t.slice(0, before.keyStart)}${line}, ${t.slice(before.keyStart)}`;
    const at = lineStart(t, before.keyStart);
    return `${t.slice(0, at)}${indent}${line},${nl}${t.slice(at)}`;
  }
  const last = entries[entries.length - 1];
  return oneLine ? `${t.slice(0, last.valueEnd)}, ${line}${t.slice(last.valueEnd)}` : `${t.slice(0, last.valueEnd)},${nl}${indent}${line}${t.slice(last.valueEnd)}`;
}

/** Removes "name" from the object at `open`, with its comma and line. */
function removeEntry(t: string, open: number, name: string): string {
  const { entries } = entriesOf(t, open);
  const i = entries.findIndex((e) => e.key === name);
  if (i < 0) return t;
  const e = entries[i];
  const next = entries[i + 1];
  if (next) {
    const sameLine = lineOf(t, next.keyStart) === lineOf(t, e.keyStart);
    return sameLine ? t.slice(0, e.keyStart) + t.slice(next.keyStart) : t.slice(0, lineStart(t, e.keyStart)) + t.slice(lineStart(t, next.keyStart));
  }
  const prev = entries[i - 1];
  if (prev) return t.slice(0, prev.valueEnd) + t.slice(e.valueEnd);
  const close = entriesOf(t, open).close;
  return t.slice(0, open + 1) + t.slice(close);
}

function topObject(t: string) {
  const open = skipWs(t.replace(/^﻿/, ''), 0) + (t.startsWith('﻿') ? 1 : 0);
  if (t[open] !== '{') throw new Error('not a JSON object');
  return open;
}
/** Where a dependency is: its section, the value's span and line, the value. */
export function findDep(t: string, name: string, sections = ['dependencies', 'devDependencies']) {
  const top = topObject(t);
  for (const s of sections) {
    const sec = entriesOf(t, top).entries.find((e) => e.key === s && t[e.valueStart] === '{');
    if (!sec) continue;
    const dep = entriesOf(t, sec.valueStart).entries.find((e) => e.key === name);
    if (dep) return { section: s, sectionOpen: sec.valueStart, value: t[dep.valueStart] === '"' ? JSON.parse(t.slice(dep.valueStart, dep.valueEnd)) as string : t.slice(dep.valueStart, dep.valueEnd), span: dep.value, line: lineOf(t, dep.keyStart) };
  }
  return null;
}

/** Sets a dependency's value (in place when it is there, else a new line in `section`), keeping everything else as it was. */
export function setDep(t: string, name: string, value: string, section = 'dependencies'): string {
  const hit = findDep(t, name);
  let out: string;
  if (hit) out = t.slice(0, hit.span.start) + JSON.stringify(value) + t.slice(hit.span.end);
  else {
    const top = topObject(t);
    const sec = entriesOf(t, top).entries.find((e) => e.key === section && t[e.valueStart] === '{');
    if (sec) out = insertEntry(t, sec.valueStart, name, JSON.stringify(value));
    else {
      const first = entriesOf(t, top).entries[0];
      const indent = first ? indentAt(t, first.keyStart) : '  ';
      const nl = nlOf(t);
      out = insertEntry(t, top, section, `{${nl}${indent}${indent}${JSON.stringify(name)}: ${JSON.stringify(value)}${nl}${indent}}`, false);
    }
  }
  const check = JSON.parse(out.replace(/^﻿/, ''));
  if ((check[hit?.section ?? section] ?? {})[name] !== value) throw new Error(`the edit didn't set ${name}`);
  return out;
}
/** Removes a dependency (from whichever section has it). */
export function removeDep(t: string, name: string): string {
  const hit = findDep(t, name);
  if (!hit) return t;
  const out = removeEntry(t, hit.sectionOpen, name);
  JSON.parse(out.replace(/^﻿/, ''));
  return out;
}

// ------------------------------------------------------------------ HTML edits

/** Puts a line before </head> (else </body>), indented like the line before it. */
export function insertScript(html: string, tag: string): string {
  const m = /<\/head\s*>/i.exec(html) ?? /<\/body\s*>/i.exec(html);
  if (!m) throw new StudioError('the page has no </head> or </body> to put the line before', 409);
  const nl = nlOf(html);
  const ls = lineStart(html, m.index);
  const onOwnLine = !html.slice(ls, m.index).trim();
  if (!onOwnLine) return `${html.slice(0, m.index)}${tag}${html.slice(m.index)}`;
  const closing = indentAt(html, m.index);
  // The line before </head>: its indentation is the head's children's.
  const prevStart = lineStart(html, Math.max(0, ls - 1));
  const prev = html.slice(prevStart, ls).trim() ? indentAt(html, prevStart) : `${closing}  `;
  const indent = prev.length > closing.length ? prev : `${closing}  `;
  return `${html.slice(0, ls)}${indent}${tag}${nl}${html.slice(ls)}`;
}
/** Swaps the src="..." value that contains `match` for `src`. */
export function replaceScriptSrc(html: string, at: number, src: string): string {
  const q = Math.max(html.lastIndexOf('"', at), html.lastIndexOf("'", at));
  const quote = html[q];
  const end = html.indexOf(quote, at);
  if (q < 0 || end < 0 || !/src\s*=\s*$/i.test(html.slice(Math.max(0, q - 8), q))) throw new StudioError("couldn't find the script's src to change", 409);
  return html.slice(0, q + 1) + src + html.slice(end);
}

// ------------------------------------------------------------------ detection

export type Where = { repo: string; path: string; line?: number };
export type EngineStatus = {
  engine: Engine; kind: Kind; available: boolean; why?: string;
  /** The project has what this engine needs (a Unity manifest, a package.json, a page). */
  applies: boolean;
  installed: boolean; version: string | null; latest: string | null; outdated: boolean;
  where: Where | null;
  /** Where an install would go. */
  host: Where | null;
  action: 'install' | 'upgrade' | 'current' | 'unavailable' | 'n/a';
  note?: string;
};
export type PluginStatus = { id: string; name: string; description: string; category?: string; homepage?: string; docs?: string; gives: string[]; setup: string[]; wire: boolean; installed: boolean; outdated: boolean; applies: boolean; engines: EngineStatus[] };

const isBabylon = (pkg: any) => Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }).some((d) => d === 'babylonjs' || d.startsWith('@babylonjs/'));
const readJson = async (s: RepoScan, f: string) => { try { return JSON.parse((await s.read(f)).replace(/^﻿/, '')); } catch { return null; } };

/** The version a dependency's value names: #v1.2.3, /v1.2.3.tar.gz, ^1.2.3; "local" for a path on someone's disk. */
export function versionOfSpec(spec: string): string {
  const s = String(spec ?? '').trim();
  if (/^file:|^\.{0,2}\//.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return 'local';
  const tag = /#v?(\d+(?:\.\d+)*)$/.exec(s) ?? /\/v?(\d+(?:\.\d+)*)\.(?:tar\.gz|tgz|zip)$/.exec(s) ?? /^[\^~>=v\s]*(\d+(?:\.\d+)*)/.exec(s);
  return tag ? tag[1] : s || 'unknown';
}

type Found = { installed: boolean; version: string | null; where: Where | null; host: Where | null; applies: boolean; note?: string };

/** One engine's recipe against a project's repositories. */
async function findOne(r: Recipe, engine: Engine, scans: RepoScan[]): Promise<Found> {
  const at = (s: RepoScan, f: string, line?: number): Where => ({ repo: s.slug, path: f, ...(line ? { line } : {}) });
  let host: Where | null = null;
  if (r.kind === 'upm-git' || r.kind === 'upm-embed') {
    for (const s of scans) for (const m of s.manifests) {
      host ??= at(s, m);
      const text = await s.read(m);
      let dep: ReturnType<typeof findDep> = null;
      try { dep = findDep(text, r.package!, ['dependencies']); } catch { /* not JSON */ }
      if (dep) return { installed: true, version: versionOfSpec(dep.value), where: at(s, m, dep.line), host: at(s, m), applies: true, ...(versionOfSpec(dep.value) === 'local' ? { note: `a local path (${dep.value}): it only works on the machine that has it` } : {}) };
      const embedded = `${path.posix.dirname(m)}/${r.package}/package.json`;
      if (s.blobs.has(embedded)) return { installed: true, version: String((await readJson(s, embedded))?.version ?? 'unknown'), where: at(s, embedded), host: at(s, m), applies: true, note: 'embedded in Packages/' };
      // Embedded under another folder name (Packages/HawkesPlaytest/): found by the package's own name, so installing
      // doesn't add a second copy Unity would refuse (2026-10-31 review).
      const dir = path.posix.dirname(m);
      for (const f of [...s.blobs.keys()].filter((b) => b.startsWith(`${dir}/`) && /^[^/]+\/package\.json$/.test(b.slice(dir.length + 1)) && b !== embedded).slice(0, 60)) {
        const j = await readJson(s, f).catch(() => null);
        if (j?.name === r.package) return { installed: true, version: String(j.version ?? 'unknown'), where: at(s, f), host: at(s, m), applies: true, note: `embedded in ${path.posix.dirname(f)}/` };
      }
    }
    return { installed: false, version: null, where: null, host, applies: Boolean(host) };
  }
  if (r.kind === 'npm' || r.kind === 'npm-tarball') {
    for (const s of scans) for (const f of s.packages) {
      const text = await s.read(f);
      let pkg: any = null;
      try { pkg = JSON.parse(text.replace(/^﻿/, '')); } catch { continue; }
      if (engine === 'babylon' && !isBabylon(pkg)) continue;
      host ??= at(s, f);
      const dep = findDep(text, r.package!);
      if (dep) return { installed: true, version: versionOfSpec(dep.value), where: at(s, f, dep.line), host: at(s, f), applies: true };
    }
    return { installed: false, version: null, where: null, host, applies: Boolean(host) };
  }
  if (r.kind === 'script-tag') {
    const re = new RegExp(r.detect!);
    for (const s of scans) for (const f of s.htmls) {
      host ??= at(s, f);
      const text = await s.read(f);
      const m = re.exec(text);
      if (m) return { installed: true, version: m[1] ?? null, where: at(s, f, lineOf(text, m.index)), host: at(s, f), applies: true };
    }
    return { installed: false, version: null, where: null, host, applies: Boolean(host) };
  }
  // copy-file: the file by name anywhere; else next to the web project (its src/ or js/ when it has one).
  const name = r.files![0].name;
  const re = new RegExp(r.marker!);
  for (const s of scans) for (const f of s.blobs.keys()) {
    if (SKIP.test(f) || path.posix.basename(f) !== name) continue;
    const text = await s.read(f);
    const m = re.exec(text);
    return { installed: true, version: m?.[1] ?? 'unknown', where: at(s, f, m ? lineOf(text, m.index) : undefined), host: at(s, f), applies: true };
  }
  for (const s of scans) {
    const base = s.packages[0] ? path.posix.dirname(s.packages[0]) : s.htmls[0] ? path.posix.dirname(s.htmls[0]) : null;
    if (base === null) continue;
    const dir = base === '.' ? '' : base;
    const has = (d: string) => [...s.blobs.keys()].some((f) => f.startsWith(`${d}/`));
    const pick = [dir ? `${dir}/src` : 'src', dir ? `${dir}/js` : 'js'].find((d) => has(d)) ?? dir;
    return { installed: false, version: null, where: null, host: at(s, `${pick ? `${pick}/` : ''}${name}`), applies: true };
  }
  return { installed: false, version: null, where: null, host: null, applies: false };
}

/** Every plugin's status for a project: installed, which version and where, the latest, outdated, where it would go. */
export async function detect(projectId: string, { fresh = false } = {}) {
  const p = getProduct(projectId);
  const scans = await scansOf(p, fresh);
  const plugins: PluginStatus[] = [];
  for (const pl of loadCatalog().plugins) {
    const engines: EngineStatus[] = [];
    for (const [e, r] of Object.entries(pl.engines) as [Engine, Recipe][]) {
      const f = await findOne(r, e, scans).catch((err: any): Found => ({ installed: false, version: null, where: null, host: null, applies: false, note: String(err?.message ?? err) }));
      const available = r.available !== false;
      const latest = await latestVersion(pl, e);
      const outdated = f.installed && isOutdated(f.version, latest);
      const action: EngineStatus['action'] = !f.applies ? 'n/a' : f.installed ? (outdated && available ? 'upgrade' : 'current') : available ? 'install' : 'unavailable';
      engines.push({ engine: e, kind: r.kind, available, ...(r.why ? { why: r.why } : {}), applies: f.applies, installed: f.installed, version: f.version, latest, outdated, where: f.where, host: f.host, action, ...(f.note ? { note: f.note } : {}) });
    }
    plugins.push({
      id: pl.id, name: pl.name, description: pl.description, category: pl.category, homepage: pl.homepage, docs: pl.docs, gives: pl.gives, setup: pl.setup, wire: Boolean(pl.brief),
      installed: engines.some((x) => x.installed), outdated: engines.some((x) => x.outdated), applies: engines.some((x) => x.applies), engines,
    });
  }
  return {
    project: p.id,
    repos: scans.map((s) => ({ repo: s.slug, role: s.role, ref: s.ref || null, sub: s.sub || null, unity: s.manifests, packages: s.packages.slice(0, 10), pages: s.htmls.slice(0, 10), ...(s.error ? { error: s.error } : {}) })),
    plugins,
    installs: installsOf(p.id),
    ...(scans.length ? {} : { note: `${p.name} has no GitHub repository Studio knows: connect one (studio_project update repo) and plugins show here.` }),
  };
}

// ------------------------------------------------------------------ plans

export type Edit = { path: string; action: 'create' | 'update' | 'delete'; content?: string; note: string };
export type Plan = { project: string; plugin: string; engine: Engine; kind: Kind; repo: string; base: string; version: string; from: string | null; upgrade: boolean; edits: Edit[]; summary: string[]; setup: string[] };

/** Studio's own files under a folder, by path relative to it. */
function studioFiles(from: string): { rel: string; text: string }[] {
  const root = path.join(ROOT, from);
  const out: { rel: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push({ rel: path.relative(root, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function templateVars(p: Product, version: string, req?: http.IncomingMessage) {
  const vars: Record<string, string> = { version, major: version.split('.')[0], project: p.id, genProject: p.id };
  try { vars.genProject = String((await import('./gen.ts')).genProject(p.id)); } catch { /* as is */ }
  try { vars.reportScript = (await import('./reportkey.ts')).reportInfo(p.id, req).script; } catch { /* only the report line uses it */ }
  return vars;
}
const render = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/** Picks the engine to install for: the asked one, the one installed already, else the first the project has. */
function pickEngine(pl: Plugin, st: PluginStatus, engine?: string): EngineStatus {
  if (engine) {
    const e = st.engines.find((x) => x.engine === engine);
    if (!e) throw new StudioError(`${pl.name} has no ${engine} version (it has ${Object.keys(pl.engines).join(', ')})`, 404);
    return e;
  }
  const order = (x: EngineStatus) => (x.installed ? 0 : x.available ? 1 : 2) * 10 + ['babylon', 'unity', 'web', 'godot'].indexOf(x.engine);
  const e = st.engines.filter((x) => x.applies).sort((a, b) => order(a) - order(b))[0];
  if (!e) throw new StudioError(`${pl.name} doesn't fit this project yet: it needs ${Object.entries(pl.engines).map(([en, r]) => `${en} (${needOf(r!.kind)})`).join(' or ')}, and Studio found none in its repositories`, 409);
  return e;
}
const needOf = (k: Kind) => (k.startsWith('upm') ? 'a Unity project: Packages/manifest.json' : k.startsWith('npm') ? 'a package.json' : k === 'script-tag' ? 'an index.html' : 'a web project');

/** The exact edits that install or upgrade a plugin in a project (deterministic: the same files give the same edits). */
export async function plan(projectId: string, pluginId: string, o: { version?: string; engine?: string; req?: http.IncomingMessage } = {}): Promise<Plan> {
  const p = getProduct(projectId);
  const pl = getPlugin(pluginId);
  const status = (await detect(p.id)).plugins.find((x) => x.id === pl.id)!;
  const es = pickEngine(pl, status, o.engine);
  const r = pl.engines[es.engine]!;
  if (r.available === false) throw new StudioError(`${pl.name} for ${es.engine}: ${r.why ?? 'not available yet'}`, 409);
  if (!es.applies || !es.host) throw new StudioError(`${pl.name} for ${es.engine} needs ${needOf(r.kind)}, and Studio found none in ${p.name}'s repositories`, 409);
  const latest = es.latest;
  const version = o.version ? String(o.version).replace(/^v/, '') : latest ?? (r.versions.source === 'none' ? 'current' : null);
  if (!version) throw new StudioError(`Studio couldn't read ${pl.name}'s versions for ${es.engine}: say which (version)`, 409);
  if (r.versions.source !== 'none' && !isVersion(version)) throw new StudioError(`version: a number like 1.2.3, not "${version}"`);
  if (r.versions.source === 'github-tags' && o.version && latest && cmpVersion(version, latest) > 0) throw new StudioError(`${pl.name} ${version} isn't released (the newest is ${latest})`);
  const scans = await scansOf(p);
  const scan = scans.find((s) => s.slug === es.host!.repo)!;
  const vars = await templateVars(p, version, o.req);
  const edits: Edit[] = [];
  const summary: string[] = [];
  const file = es.host.path;
  const upgrade = es.installed;
  const same = (f: string, text: string) => scan.blobs.get(f) === blobSha(text);

  if (r.kind === 'upm-git' || r.kind === 'npm' || r.kind === 'npm-tarball') {
    const value = r.kind === 'upm-git' ? `${r.git}#v${version}` : r.kind === 'npm-tarball' ? render(r.tarball!, vars) : `^${version}`;
    const text = await scan.read(file);
    const next = setDep(text, r.package!, value);
    if (next !== text) { edits.push({ path: file, action: 'update', content: next, note: `"${r.package}": "${value}"` }); summary.push(`${file}: ${r.package} ${upgrade ? `${es.version} → ` : ''}${value}`); }
  } else if (r.kind === 'upm-embed') {
    const dir = `${path.posix.dirname(file)}/${r.package}`;
    const files = studioFiles(r.from!);
    const keep = new Set<string>();
    for (const f of files) {
      const to = `${dir}/${f.rel}`;
      keep.add(to);
      if (!same(to, f.text)) edits.push({ path: to, action: scan.blobs.has(to) ? 'update' : 'create', content: f.text, note: `Studio's ${r.from}/${f.rel}` });
    }
    for (const f of scan.blobs.keys()) if (f.startsWith(`${dir}/`) && !keep.has(f)) edits.push({ path: f, action: 'delete', note: `not in ${r.package} ${version}` });
    const manifest = await scan.read(file);
    if (findDep(manifest, r.package!, ['dependencies'])) {
      const next = removeDep(manifest, r.package!);
      edits.push({ path: file, action: 'update', content: next, note: `the old ${r.package} line goes: the package is embedded in Packages/ now` });
    }
    summary.push(`${dir}/: ${r.package} ${upgrade ? `${es.version} → ` : ''}${version} (${files.length} files, embedded)`);
  } else if (r.kind === 'script-tag') {
    const text = await scan.read(file);
    const m = new RegExp(r.detect!).exec(text);
    const src = render(r.src!, vars);
    const next = m ? replaceScriptSrc(text, m.index, src) : insertScript(text, render(r.tag!, vars));
    if (next !== text) { edits.push({ path: file, action: 'update', content: next, note: m ? `src="${src}"` : render(r.tag!, vars) }); summary.push(`${file}: ${m ? `the script now loads ${src}` : `adds ${render(r.tag!, vars)}`}`); }
  } else {
    const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    for (const f of r.files!) {
      const to = `${dir ? `${dir}/` : ''}${f.name}`;
      const text = fs.readFileSync(path.join(ROOT, f.from), 'utf8');
      if (!same(to, text)) edits.push({ path: to, action: scan.blobs.has(to) ? 'update' : 'create', content: text, note: `a copy of Studio's ${f.from}` });
    }
    summary.push(`${dir || '/'}: ${r.files!.map((f) => f.name).join(', ')} ${upgrade ? `${es.version} → ` : ''}${version}`);
  }
  if (!edits.length) summary.splice(0, summary.length, `${pl.name} ${version} is already there: nothing to change`);
  return { project: p.id, plugin: pl.id, engine: es.engine, kind: r.kind, repo: scan.slug, base: scan.ref, version, from: es.version, upgrade, edits, summary, setup: pl.setup };
}

/** A plan as the API shows it: big file contents become their size and first lines. */
export const planView = (pl: Plan) => ({ ...pl, edits: pl.edits.map(({ content, ...e }) => ({ ...e, ...(content === undefined ? {} : content.length <= 4000 ? { content } : { bytes: Buffer.byteLength(content), preview: content.slice(0, 400) }) })) });

// ------------------------------------------------------------------ applying it

db.exec(`CREATE TABLE IF NOT EXISTS plugin_installs (
  id TEXT PRIMARY KEY, product TEXT NOT NULL, plugin TEXT NOT NULL, engine TEXT NOT NULL, version TEXT NOT NULL, from_version TEXT,
  repo TEXT NOT NULL, base TEXT, branch TEXT, sha TEXT, pr INTEGER, pr_url TEXT, change TEXT, status TEXT NOT NULL, detail TEXT, by TEXT, created INTEGER NOT NULL
)`);
export type InstallRow = { id: string; product: string; plugin: string; engine: string; version: string; from_version: string | null; repo: string; base: string | null; branch: string | null; sha: string | null; pr: number | null; pr_url: string | null; change: string | null; status: string; detail: string | null; by: string | null; created: number };
export const installsOf = (product: string, limit = 20) => db.prepare('SELECT * FROM plugin_installs WHERE product = ? ORDER BY created DESC LIMIT ?').all(product, limit) as InstallRow[];

export const branchOf = (plugin: string, version: string) => `plugin/${plugin}${version === 'current' ? '' : `-${version}`}`.replace(/[^\w./-]/g, '-');

/** Commits a plan's edits on plugin/<id>-<version>, cut from its base, through GitHub's Git Data API. */
async function commitPlan(pl: Plan, message: string) {
  const gh = await ghFor(pl.repo);
  const api = async (route: string, init: any = {}) => {
    const r = await gh(`/repos/${pl.repo}${route}`, { ...init, body: init.body ? JSON.stringify(init.body) : undefined });
    if (!r.ok) { const e: any = new Error(`GitHub ${init.method ?? 'GET'} ${route}: ${r.status} ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
    return r.json() as any;
  };
  const head = await api(`/git/ref/heads/${pl.base}`);
  const base = await api(`/git/commits/${head.object.sha}`);
  const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
  for (const e of pl.edits) {
    if (e.action === 'delete') { tree.push({ path: e.path, mode: '100644', type: 'blob', sha: null }); continue; }
    const blob = await api('/git/blobs', { method: 'POST', body: { content: Buffer.from(e.content ?? '', 'utf8').toString('base64'), encoding: 'base64' } });
    tree.push({ path: e.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const t = await api('/git/trees', { method: 'POST', body: { base_tree: base.tree.sha, tree } });
  const c = await api('/git/commits', { method: 'POST', body: { message, tree: t.sha, parents: [head.object.sha] } });
  const branch = branchOf(pl.plugin, pl.version);
  try { await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: c.sha } }); }
  catch (e: any) {
    // The branch from an earlier try: moved onto this commit (it is Studio's own branch, nobody else's).
    if (e.status !== 422) throw e;
    await api(`/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: c.sha, force: true } });
  }
  return { branch, sha: c.sha as string, api };
}

function prBody(pl: Plan, plugin: Plugin) {
  return [
    `${pl.upgrade ? 'Upgrades' : 'Installs'} **${plugin.name}** ${pl.from && pl.upgrade ? `${pl.from} → ` : ''}${pl.version} (${pl.engine}, ${pl.kind}).`,
    '', plugin.description, '',
    '**Changes**', ...pl.summary.map((s) => `- ${s}`), '',
    ...(plugin.setup.length ? ['**Setup**', ...plugin.setup.map((s) => `- ${s}`), ''] : []),
    ...(plugin.engines[pl.engine]?.docs || plugin.docs ? [`Docs: ${plugin.engines[pl.engine]?.docs ?? plugin.docs}`, ''] : []),
    'Opened by Hawkes Studio (Plugins). Merging it puts it on beta; going live is a separate step.',
  ].join('\n');
}

/** What an agent is told when a plugin needs code to be set up (wiring it into the game). */
export function briefFor(pl: Plan, plugin: Plugin, branch: string | null) {
  return [
    `${pl.upgrade ? 'Upgrade' : 'Install and set up'} the ${plugin.name} plugin (${pl.engine}, version ${pl.version}) in ${pl.repo}.`,
    branch
      ? `Studio committed the dependency on the branch ${branch} (from ${pl.base}): start by merging it into your branch (git fetch origin ${branch} && git merge --no-edit FETCH_HEAD). It changes: ${pl.summary.join('; ')}.`
      : `The dependency: ${pl.summary.join('; ')}.`,
    plugin.brief ?? `Wire ${plugin.name} into the project so it is used, not only installed.`,
    plugin.setup.length ? `Setup notes: ${plugin.setup.join(' ')}` : '',
    'Run the project\'s checks. Keep everything that works today working.',
  ].filter(Boolean).join('\n\n');
}

export type ApplyOptions = { version?: string; engine?: string; by?: string | null; origin?: string | null; agent?: boolean; req?: http.IncomingMessage };

/**
 * Installs or upgrades: the plan committed on plugin/<id>-<version> from beta and a pull request into beta (recorded).
 * agent: the branch only, and an agent change (studio_task) that starts from it and wires the plugin into the game.
 */
export async function apply(projectId: string, pluginId: string, o: ApplyOptions = {}) {
  const pl = await plan(projectId, pluginId, o);
  const plugin = getPlugin(pluginId);
  if (!pl.edits.length && !o.agent) return { ok: true, nothing: true, plan: planView(pl), note: pl.summary[0] };
  const id = newId('pi');
  db.prepare('INSERT INTO plugin_installs (id, product, plugin, engine, version, from_version, repo, base, status, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, pl.project, pl.plugin, pl.engine, pl.version, pl.upgrade ? pl.from : null, pl.repo, pl.base, 'working', o.by ?? null, Date.now());
  const set = (f: Partial<InstallRow>) => { const k = Object.keys(f); if (k.length) db.prepare(`UPDATE plugin_installs SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = ?`).run(...(Object.values(f) as any[]), id); };
  try {
    let branch: string | null = null;
    let pr: { number: number; html_url: string } | null = null;
    if (pl.edits.length) {
      const title = `${pl.upgrade ? 'Upgrade' : 'Add'} ${plugin.name} ${pl.version}${pl.upgrade && pl.from ? ` (was ${pl.from})` : ''}`;
      const c = await commitPlan(pl, title);
      branch = c.branch;
      set({ branch, sha: c.sha });
      if (!o.agent) {
        try { pr = await c.api('/pulls', { method: 'POST', body: { title, head: branch, base: pl.base, body: prBody(pl, plugin), maintainer_can_modify: true } }); }
        catch (e: any) {
          if (e.status !== 422) throw e;
          const open = await c.api(`/pulls?state=open&head=${encodeURIComponent(`${pl.repo.split('/')[0]}:${branch}`)}`);
          if (!open?.[0]) throw e;
          pr = open[0];
        }
        set({ pr: pr!.number, pr_url: pr!.html_url });
      }
    }
    let change: string | null = null;
    if (o.agent) {
      const { startTask } = await import('./agents.ts');
      const p = getProduct(projectId);
      const role = projectRepos(p).find((r) => r.slug === pl.repo)?.role;
      const target = role === 'main' || !role ? null : role === 'site' ? 'site' : pl.repo;
      change = startTask(p.id, briefFor(pl, plugin, branch), { title: `Set up ${plugin.name} ${pl.version}`, target });
      if (o.origin !== undefined) { const { tagChange } = await import('./followup.ts'); tagChange(change, o.origin ?? null, o.by ?? null); }
      set({ change });
    }
    set({ status: pr ? 'open' : change ? 'agent' : 'done', detail: pl.summary.join('; ').slice(0, 500) });
    forgetScans(projectId);
    return { ok: true, install: id, repo: pl.repo, base: pl.base, branch, pr: pr?.number ?? null, url: pr?.html_url ?? null, change, plan: planView(pl),
      note: pr ? `A pull request into ${pl.base}: merging it puts ${plugin.name} ${pl.version} on beta.` : change ? `An agent sets it up, starting from ${branch ?? pl.base}; you'll hear when it's ready.` : pl.summary[0] };
  } catch (e: any) {
    set({ status: 'failed', detail: String(e?.message ?? e).slice(0, 500) });
    throw e;
  }
}

// ------------------------------------------------------------------ API

/**
 *   GET  /api/plugins                                         the catalog, each engine with its latest version
 *   GET  /api/projects/<id>/plugins[?fresh=1]                 every plugin's status for the project
 *   GET  /api/projects/<id>/plugins/<plugin>/plan?engine=&version=   the exact edits an install or upgrade makes
 *   POST /api/projects/<id>/plugins/<plugin>  {version?, engine?, agent?}   install or upgrade: a branch and a pull request into beta
 */
export async function handlePluginRoutes(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, url: URL, readJson: (r: http.IncomingMessage) => Promise<any>) {
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
  if (route === '/api/plugins') return method === 'GET' ? send(200, { plugins: await catalogWithLatest() }) : send(405, { error: 'GET' });
  const m = /^\/api\/(?:projects|games)\/([a-z][a-z0-9-]{1,39})\/plugins(?:\/([a-z][a-z0-9-]{1,39})(\/plan)?)?$/.exec(route);
  if (!m) return false;
  const [, project, plugin, isPlan] = m;
  if (!plugin) return method === 'GET' ? send(200, await detect(project, { fresh: url.searchParams.get('fresh') === '1' })) : send(405, { error: 'GET' });
  if (isPlan) return method === 'GET' ? send(200, planView(await plan(project, plugin, { engine: url.searchParams.get('engine') ?? undefined, version: url.searchParams.get('version') ?? undefined, req }))) : send(405, { error: 'GET' });
  if (method !== 'POST') return send(405, { error: 'POST' });
  const b = await readJson(req);
  const { originOf } = await import('./followup.ts');
  const origin = originOf(req);
  const by = origin ? 'Talk' : (await import('./auth.ts')).requester(req)?.email ?? null;
  return send(200, await apply(project, plugin, { version: b.version ? String(b.version) : undefined, engine: b.engine ? String(b.engine) : undefined, agent: Boolean(b.agent), by, origin, req }));
}
