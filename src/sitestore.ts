// Publishing beta sites to Cloudflare R2 through the beta-sites Worker (server/beta-sites; docs/studio-cloudrun.md,
// "Beta sites"). Studio on Cloud Run has no disk worth keeping and no Caddy, so instead of a folder per site
// (previews.ts place()) each site is a prefix in R2, published incrementally:
//
//   <lane>/<sub>/beta/<path>              the beta site's files (served by the Worker)
//   <lane>/<sub>/c/<change>/<path>        an agent change's preview
//   <lane>/<sub>/<site>/.studio/manifest.json  what is published there: path -> git blob id and size (Studio only)
//   <lane>/<sub>/<site>/.studio/build.json     what beta serves now (the 🐞 widget's "New build: reload")
//   <lane>/_studio/report.js              the widget itself
//
// Files are named by their git blob id (sha1 of "blob <size>\0" + content), so a file is sent only when its id changed,
// one already published elsewhere in the lane (beta's, for a change's preview) is copied inside R2, and the bytes of
// a tracked file come from GitHub's blob API only when needed: no clone, nothing on Studio's disk. HTML pages get the
// widget (bugreport.ts injectReport) and are sent every time.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { laneOf, signPublish, siteOrg, type Lane } from './sitekeys.ts';
import { injectReport, type PageInfo } from './bugreport.ts';

/** One file of a site: where it goes, its git blob id and size, and how to get its bytes. */
export type SiteFile = { path: string; oid: string; size: number; read: () => Promise<Buffer> };
/** A source's files, optionally able to fetch many of them at once before they're read (publishSite calls it). */
export type SiteFiles = SiteFile[] & { prefetch?: (paths: string[], progress?: (s: string) => void) => Promise<void>; cleanup?: () => void };
/** A filtered or merged copy of a source's files keeps its prefetch (array methods return plain arrays). */
export const keepPrefetch = (to: SiteFile[], from: SiteFile[]): SiteFiles => {
  const f = (from as SiteFiles).prefetch;
  if (f) (to as SiteFiles).prefetch = f;
  const c = (from as SiteFiles).cleanup;
  if (c) (to as SiteFiles).cleanup = c;
  return to as SiteFiles;
};
export type Manifest = { v: 1; at: number; sha?: string | null; ref?: string; files: Record<string, { oid: string; size: number }> };

/** The R2 side, inside this lane's prefix (keys here have no lane). */
export type SiteStore = {
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer, type: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export const gitOid = (data: Buffer) => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', map: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', glb: 'model/gltf-binary', gltf: 'model/gltf+json', pdf: 'application/pdf', webmanifest: 'application/manifest+json',
  // Unity's compressed build files go as they are: the loader decompresses them itself (no Content-Encoding on Pages either).
  unityweb: 'application/octet-stream', data: 'application/octet-stream', bundle: 'application/octet-stream', bin: 'application/octet-stream',
};
export const typeOf = (p: string) => TYPES[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream';
const isHtml = (p: string) => /\.html?$/i.test(p);

/** Runs `f` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await f(items[i++]); }));
}

export async function readManifest(store: SiteStore, base: string): Promise<Manifest | null> {
  const b = await store.get(`${base}/.studio/manifest.json`).catch(() => null);
  try { return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; }
}

export type PublishResult = { files: number; sent: number; copied: number; kept: number; removed: number; bytes: number };

/**
 * Publishes `files` at `base` (e.g. "dod/beta"): sends what changed since the last publish there, copies what another
 * published site of the lane already has (`copyFrom`: their bases), keeps old entries `keep` says to (a Unity site's
 * previous Game/v<n>), then removes what's gone. Non-HTML first, pages after, the manifest last, removals at the end, so
 * a page never points at a file that isn't up yet.
 */
type PublishOptions = { page?: PageInfo; copyFrom?: string[]; keep?: (p: string) => boolean; build?: unknown; meta?: { sha?: string | null; ref?: string }; progress?: (s: string) => void; concurrency?: number };
export async function publishSite(store: SiteStore, base: string, files: SiteFile[], o: PublishOptions = {}): Promise<PublishResult> {
  // What the tarball unpacked and the publish didn't read (it failed part way) is removed: Cloud Run's /tmp is memory,
  // and those files stayed until the instance restarted (2026-11-01).
  try { return await publishFiles(store, base, files, o); } finally { (files as SiteFiles).cleanup?.(); }
}
async function publishFiles(store: SiteStore, base: string, files: SiteFile[], o: PublishOptions): Promise<PublishResult> {
  const prev = await readManifest(store, base);
  const have = new Map<string, string>(); // oid -> full key already in R2
  for (const b of o.copyFrom ?? []) {
    const m = await readManifest(store, b);
    for (const [p, f] of Object.entries(m?.files ?? {})) if (!isHtml(p)) have.set(f.oid, `${b}/${p}`);
  }
  for (const [p, f] of Object.entries(prev?.files ?? {})) if (!isHtml(p)) have.set(f.oid, `${base}/${p}`);
  const next: Manifest = { v: 1, at: Date.now(), sha: o.meta?.sha ?? null, ref: o.meta?.ref, files: {} };
  const r: PublishResult = { files: files.length, sent: 0, copied: 0, kept: 0, removed: 0, bytes: 0 };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const assets = [...byPath.values()].filter((f) => !isHtml(f.path));
  const pages = [...byPath.values()].filter((f) => isHtml(f.path));
  // The bytes this publish reads (changed assets nothing published holds, and every page), fetched in one go when the
  // source can (githubFiles: one tarball instead of an API call per file, 2026-10-29).
  const toRead = [...assets.filter((f) => prev?.files[f.path]?.oid !== f.oid && !have.has(f.oid)), ...pages].map((f) => f.path);
  await (files as SiteFiles).prefetch?.(toRead, o.progress);
  let done = 0;
  const tick = () => { if (++done % 100 === 0) o.progress?.(`publishing: ${done} of ${byPath.size} files`); };
  await pool(assets, o.concurrency ?? 6, async (f) => {
    next.files[f.path] = { oid: f.oid, size: f.size };
    if (prev?.files[f.path]?.oid === f.oid) return void tick();
    const from = have.get(f.oid);
    if (from && from !== `${base}/${f.path}`) {
      await store.copy(from, `${base}/${f.path}`);
      r.copied++;
    } else {
      const data = await f.read();
      await store.put(`${base}/${f.path}`, data, typeOf(f.path));
      r.sent++;
      r.bytes += data.length;
    }
    have.set(f.oid, `${base}/${f.path}`);
    tick();
  });
  await pool(pages, o.concurrency ?? 6, async (f) => {
    const raw = await f.read();
    const data = o.page ? Buffer.from(injectReport(raw.toString('utf8'), o.page), 'utf8') : raw;
    await store.put(`${base}/${f.path}`, data, typeOf(f.path));
    next.files[f.path] = { oid: f.oid, size: f.size };
    r.sent++;
    r.bytes += data.length;
    tick();
  });
  for (const [p, f] of Object.entries(prev?.files ?? {})) {
    if (!next.files[p] && o.keep?.(p)) {
      next.files[p] = f;
      r.kept++;
    }
  }
  await store.put(`${base}/.studio/manifest.json`, Buffer.from(JSON.stringify(next)), 'application/json');
  // The pages' own build time is the build's: build.json is written after the pages, and the widget asks whether what
  // beta serves was published after the page it sits in ("New build: reload" showed on fresh pages).
  if (o.build !== undefined) await store.put(`${base}/.studio/build.json`, Buffer.from(JSON.stringify(o.build && o.page?.built ? { ...o.build, at: o.page.built } : o.build)), 'application/json');
  const gone = Object.keys(prev?.files ?? {}).filter((p) => !next.files[p]).map((p) => `${base}/${p}`);
  for (let i = 0; i < gone.length; i += 1000) await store.remove(gone.slice(i, i + 1000));
  r.removed = gone.length;
  return r;
}

/** Removes a published site (a change's preview once it's merged or closed). */
export async function removeSite(store: SiteStore, base: string) {
  const m = await readManifest(store, base);
  const keys = [...Object.keys(m?.files ?? {}).map((p) => `${base}/${p}`), `${base}/.studio/manifest.json`, `${base}/.studio/build.json`];
  for (let i = 0; i < keys.length; i += 1000) await store.remove(keys.slice(i, i + 1000));
  return keys.length;
}

/** The widget (dashboard/report-widget.js) at <lane>/_studio/report.js, when it changed. */
export async function publishWidget(store: SiteStore, file: string) {
  const data = fs.readFileSync(file);
  const old = await store.get('_studio/report.js').catch(() => null);
  if (!old || !old.equals(data)) await store.put('_studio/report.js', data, typeOf(file));
}

// ------------------------------------------------------------------ the Worker

/** Where Studio sends its writes: STUDIO_SITES_URL, else https://sites.<domain>. */
export const sitesUrl = (domain: string) => (process.env.STUDIO_SITES_URL || `https://sites.${domain}`).replace(/\/+$/, '');

/**
 * The store a publish uses: R2's S3 API straight from Studio when this Studio has R2 keys (r2.ts: never through the
 * beta-sites Worker, so a publish costs no Worker requests), else signed calls to the Worker. A customer's Studio always
 * goes through the Worker, which keeps it under o/<org>/.
 */
export async function siteStore(domain: string): Promise<SiteStore> {
  if (!siteOrg()) {
    const { r2Config, r2Store } = await import('./r2.ts');
    const c = r2Config();
    if (c) return r2Store(c, laneOf());
  }
  return workerStore(sitesUrl(domain));
}

/** The real store: signed calls to the beta-sites Worker. */
export function workerStore(url: string, { lane = laneOf(), fetcher = fetch, sign = signPublish }: { lane?: Lane; fetcher?: typeof fetch; sign?: typeof signPublish } = {}): SiteStore {
  const call = async (method: string, p: string, body: Buffer | null, headers: Record<string, string> = {}, ok404 = false) => {
    const tag = method === 'PUT' ? `len:${body?.length ?? 0}` : `sha256:${crypto.createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex')}`;
    const pq = `/.hawkes-sites/${p}`;
    for (let attempt = 1; ; attempt++) {
      const res = await fetcher(`${url}${pq}`, {
        // A customer's Studio names its org: the Worker checks its own key and keeps it under o/<org>/.
        method, headers: { ...headers, 'X-Hawkes-Lane': lane, 'X-Hawkes-Sig': sign(lane, method, pq, tag), ...(siteOrg() ? { 'X-Hawkes-Org': siteOrg()! } : {}), ...(body ? { 'Content-Length': String(body.length) } : {}) },
        body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(5 * 60_000),
      }).catch((e: any) => ({ ok: false, status: 0, text: async () => String(e.message ?? e), arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response);
      if (res.ok || (ok404 && res.status === 404)) return res;
      if (attempt >= 3 || (res.status >= 400 && res.status < 500 && res.status !== 429)) throw new Error(`beta sites ${method} ${p.slice(0, 120)}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  };
  const enc = (key: string) => key.split('/').map(encodeURIComponent).join('/');
  return {
    get: async (key) => {
      const res = await call('GET', `o/${enc(key)}`, null, {}, true);
      return res.status === 404 ? null : Buffer.from(await res.arrayBuffer());
    },
    put: async (key, data, type) => { await call('PUT', `o/${enc(key)}`, data, { 'Content-Type': type }); },
    copy: async (from, to) => { await call('POST', 'copy', Buffer.from(JSON.stringify({ from, to })), { 'Content-Type': 'application/json' }); },
    remove: async (keys) => { if (keys.length) await call('POST', 'delete', Buffer.from(JSON.stringify({ keys })), { 'Content-Type': 'application/json' }); },
  };
}

// ------------------------------------------------------------------ sources

const GH = 'https://api.github.com';
const ghHeaders = (accept = 'application/vnd.github+json') => ({
  Accept: accept, 'User-Agent': 'hawkes-studio', 'X-GitHub-Api-Version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
});

/** A branch's (or any ref's) commit on GitHub, or null when it has none. */
export async function githubCommit(slug: string, ref: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const r = await fetcher(`${GH}/repos/${slug}/commits/${encodeURIComponent(ref)}`, { headers: ghHeaders('application/vnd.github.sha'), signal: AbortSignal.timeout(30_000) });
  if (r.status === 404 || r.status === 422) return null;
  if (!r.ok) throw new Error(`GitHub ${slug}@${ref}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.text()).trim();
}

/** Above this many files to read, a publish downloads the commit's tarball once instead of one API call per file. */
export const TARBALL_OVER = 40;

/**
 * Reads a .tar.gz stream and writes the members `want` maps (path inside the repo, after the archive's top folder) to
 * files under `dir`. GitHub's archives put every path under one top folder and use pax headers for long names. Returns
 * repo path -> written file.
 */
export async function extractWanted(body: ReadableStream<Uint8Array> | NodeJS.ReadableStream, want: Set<string>, dir: string): Promise<Map<string, string>> {
  const { Readable } = await import('node:stream');
  const zlib = await import('node:zlib');
  const src = typeof (body as any).getReader === 'function' ? Readable.fromWeb(body as any) : (body as NodeJS.ReadableStream);
  const out = new Map<string, string>();
  let buf: Buffer = Buffer.alloc(0);
  let longName: string | null = null;
  let entry: { path: string | null; left: number; pad: number; fd: number | null; meta: Buffer[] | null } | null = null;
  const str = (b: Buffer, at: number, n: number) => b.subarray(at, at + n).toString('utf8').replace(/\0.*$/s, '');
  const done = () => {
    if (!entry) return;
    if (entry.fd !== null) fs.closeSync(entry.fd);
    if (entry.meta) {
      // A pax header ("x"): its "path=" is the next member's name; GNU long name ("L"): the whole body is.
      const text = Buffer.concat(entry.meta).toString('utf8');
      longName = entry.path === '\0L' ? text.replace(/\0+$/, '') : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? longName);
    }
    entry = null;
  };
  for await (const chunk of src.pipe(zlib.createGunzip())) {
    buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
    for (;;) {
      if (entry) {
        if (entry.left > 0) {
          if (!buf.length) break;
          const take = Math.min(entry.left, buf.length);
          const part = buf.subarray(0, take);
          if (entry.fd !== null) fs.writeSync(entry.fd, part);
          else if (entry.meta) entry.meta.push(Buffer.from(part));
          entry.left -= take;
          buf = buf.subarray(take);
          if (entry.left > 0) break;
        }
        if (buf.length < entry.pad) break;
        buf = buf.subarray(entry.pad);
        done();
        continue;
      }
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((x) => x === 0)) continue;
      const size = parseInt(str(h, 124, 12).trim() || '0', 8) || 0;
      const type = String.fromCharCode(h[156] || 48);
      const pad = (512 - (size % 512)) % 512;
      if (type === 'x' || type === 'g' || type === 'L') {
        entry = { path: type === 'L' ? '\0L' : null, left: size, pad, fd: null, meta: type === 'g' ? null : [] };
        if (type === 'g') entry.meta = null;
        continue;
      }
      const name = longName ?? (str(h, 345, 155) ? `${str(h, 345, 155)}/${str(h, 0, 100)}` : str(h, 0, 100));
      longName = null;
      const rel = name.replace(/^[^/]+\//, ''); // drop the archive's top folder
      let fd: number | null = null;
      if ((type === '0' || type === '\0') && want.has(rel)) {
        const file = path.join(dir, String(out.size));
        fd = fs.openSync(file, 'w');
        out.set(rel, file);
      }
      entry = { path: rel, left: size, pad, fd, meta: null };
      if (size === 0) { buf = buf.subarray(Math.min(pad, buf.length)); done(); }
    }
  }
  return out;
}

/** Every file of a commit on GitHub (the trees API; no clone), under `sub` with it cut off. */
export async function githubFiles(slug: string, sha: string, { sub = '', fetcher = fetch }: { sub?: string; fetcher?: typeof fetch } = {}): Promise<SiteFiles> {
  const r = await fetcher(`${GH}/repos/${slug}/git/trees/${sha}?recursive=1`, { headers: ghHeaders(), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`GitHub tree of ${slug}@${sha.slice(0, 7)}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = (await r.json()) as { tree: { path: string; type: string; sha: string; size?: number; mode: string }[]; truncated?: boolean };
  if (t.truncated) throw new Error(`${slug} has too many files for GitHub's tree API`);
  const prefix = sub ? `${sub.replace(/\/+$/, '')}/` : '';
  // Files the tarball already brought (prefetch), by site path; each is read once and deleted (Cloud Run's /tmp is memory).
  const got = new Map<string, string>();
  const files: SiteFiles = t.tree.filter((e) => e.type === 'blob' && e.mode !== '120000' && e.path.startsWith(prefix)).map((e) => ({
    path: e.path.slice(prefix.length), oid: e.sha, size: e.size ?? 0,
    read: async () => {
      const local = got.get(e.path.slice(prefix.length));
      let out: Buffer | null = null;
      if (local) {
        out = fs.readFileSync(local);
        fs.rmSync(local, { force: true });
        got.delete(e.path.slice(prefix.length));
      }
      for (let attempt = 1; !out; attempt++) {
        const b = await fetcher(`${GH}/repos/${slug}/git/blobs/${e.sha}`, { headers: ghHeaders('application/vnd.github.raw'), signal: AbortSignal.timeout(5 * 60_000) }).catch(() => null);
        if (b?.ok) { out = Buffer.from(await b.arrayBuffer()); break; }
        if (attempt >= 3) throw new Error(`GitHub blob ${e.path} of ${slug}: ${b?.status ?? 'no answer'}`);
        await new Promise((res) => setTimeout(res, attempt * 2000));
      }
      // A Git LFS pointer (a big file kept in LFS: a committed Unity build, a video) is replaced by the file itself,
      // from GitHub's media address; publishing the pointer's text broke the site (2026-10-31 review).
      if (out.length < 300 && out.subarray(0, 40).toString('utf8').startsWith('version https://git-lfs')) {
        const media = await fetcher(`https://media.githubusercontent.com/media/${slug}/${sha}/${e.path.split('/').map(encodeURIComponent).join('/')}`, { headers: ghHeaders(), signal: AbortSignal.timeout(10 * 60_000) }).catch(() => null);
        if (!media?.ok) throw new Error(`${e.path} of ${slug} is in Git LFS and GitHub didn't give the file (${media?.status ?? 'no answer'})`);
        out = Buffer.from(await media.arrayBuffer());
      }
      return out;
    },
  }));
  // Many files to read (a first publish, a new Unity build): the commit's tarball, one API call (GitHub redirects it to
  // codeload), keeping only those files. A few: one API call each, as before.
  const dirs: string[] = [];
  files.cleanup = () => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); got.clear(); };
  files.prefetch = async (paths, progress) => {
    if (paths.length <= TARBALL_OVER) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
    dirs.push(dir);
    progress?.(`downloading ${slug}@${sha.slice(0, 7)} as one archive for ${paths.length} files`);
    const a = await fetcher(`${GH}/repos/${slug}/tarball/${sha}`, { headers: ghHeaders(), redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
    if (!a.ok || !a.body) throw new Error(`GitHub tarball of ${slug}@${sha.slice(0, 7)}: ${a.status}`);
    const found = await extractWanted(a.body, new Set(paths.map((p) => `${prefix}${p}`)), dir);
    for (const [rel, file] of found) got.set(rel.slice(prefix.length), file);
    progress?.(`unpacked ${found.size} of ${paths.length} files from the archive`);
  };
  return files;
}

/** The git blob id of a file, hashed as a stream so a big file is never held in memory and the event loop keeps turning. */
export async function gitOidOfFile(file: string, size: number): Promise<string> {
  const h = crypto.createHash('sha1').update(`blob ${size}\0`);
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Every file under a local folder as site files under `to`, without blocking the event loop or reading whole files into
 * memory (2026-11-01: the synchronous folderFiles blocked Studio for seconds on a build's output and its memory grew by
 * the size of every file; Studio restarted while agent changes ran).
 */
export async function folderFilesAsync(dir: string, to = ''): Promise<SiteFile[]> {
  const out: SiteFile[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) {
        const file = path.join(dir, r);
        const size = (await fs.promises.stat(file)).size;
        out.push({ path: to ? `${to}/${r}` : r, oid: await gitOidOfFile(file, size), size, read: async () => fs.promises.readFile(file) });
      }
    }
  };
  if (fs.existsSync(dir)) await walk('');
  return out;
}

/** Every file under a local folder (a build's output), as site files under `to`. */
export function folderFiles(dir: string, to = ''): SiteFile[] {
  const out: SiteFile[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const file = path.join(dir, r);
        const data = fs.readFileSync(file);
        out.push({ path: to ? `${to}/${r}` : r, oid: gitOid(data), size: data.length, read: async () => fs.readFileSync(file) });
      }
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out;
}

/** Files of a commit in a local repo (an agent change's worktree): `git ls-tree`, bytes by `git cat-file`. */
export function localGitFiles(dir: string, sha: string, run: (args: string[]) => { ok: boolean; raw: Buffer; err: string }, sub = ''): SiteFile[] {
  const ls = run(['ls-tree', '-r', '-l', '-z', sha, ...(sub ? ['--', sub] : [])]);
  if (!ls.ok) throw new Error(`git ls-tree: ${ls.err}`);
  const prefix = sub ? `${sub.replace(/\/+$/, '')}/` : '';
  return ls.raw.toString('utf8').split('\0').filter(Boolean).flatMap((line) => {
    const m = /^(\d+) blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
    if (!m || m[1] === '120000' || !m[4].startsWith(prefix)) return [];
    const oid = m[2];
    return [{ path: m[4].slice(prefix.length), oid, size: Number(m[3]), read: async () => {
      const r = run(['cat-file', 'blob', oid]);
      if (!r.ok) throw new Error(`git cat-file ${oid}: ${r.err}`);
      return r.raw;
    } }];
  });
}
