// The beta sites (docs/studio-cloudrun.md, "Beta sites"): one Cloudflare Worker serves every product's beta site from R2,
// only to people signed in to Studio, and takes Studio's uploads. No secrets: Studio signs with its lane's Ed25519 key
// (src/sitekeys.ts), whose public half this Worker reads from the lane's Studio (GET /auth/sites-key) and caches.
//
//   https://<sub>.hawkesgen.ai/...        live Studio's beta site of a product   R2 live/<sub>/beta/...
//   https://<sub>.hawkesgen.ai/c/<id>/... an agent change's preview              R2 live/<sub>/c/<id>/...
//   https://sb-<sub>.hawkesgen.ai/...     studio-beta's copies (its own lane)    R2 beta/<sub>/...
//   /dev/__studio/report.js, /build       the 🐞 widget and what beta serves now, from R2 (Studio stays asleep)
//   /dev/__studio/report, /error (POST)   passed to the lane's Studio (its session cookie comes along)
//   /.hawkes-sites/...                    Studio's signed writes (any routed host; Studio uses sites.hawkesgen.ai)
//
// Sign-in: a page needs the lane's pass cookie (hawkes_pass / hawkes_pass_beta), which Studio signs at /auth/pass for a
// signed-in user (12 hours). Without one a page load goes to Studio's /auth/pass?next=<this url> and comes back with it.
//
// Written without Cloudflare's types so the Node tests (test/beta-sites.test.ts) run this exact file.

export type Lane = 'live' | 'beta';

/** The parts of an R2 bucket binding used here. */
export interface R2Obj { body?: ReadableStream | null; size: number; httpEtag: string; uploaded?: Date; httpMetadata?: { contentType?: string; contentEncoding?: string }; range?: { offset?: number; length?: number } }
export interface R2Like {
  get(key: string, o?: { onlyIf?: Headers; range?: Headers }): Promise<R2Obj | null>;
  head(key: string): Promise<R2Obj | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string | null, o?: { httpMetadata?: { contentType?: string; contentEncoding?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}
export interface Env {
  SITES: R2Like;
  DOMAIN?: string;
  /** Each lane's Studio on Cloud Run (its run.app address: the key and the 🐞 posts go there directly). */
  STUDIO_ORIGIN_LIVE: string;
  STUDIO_ORIGIN_BETA?: string;
  /** Where people sign in (the Workers in front of Studio). */
  STUDIO_PUBLIC_LIVE?: string;
  STUDIO_PUBLIC_BETA?: string;
  /** Customers' Studios (cells): Cloud Run's deterministic address per org, as the studio-edge Worker computes it. */
  CELLS_PROJECT_NUMBER?: string;
  CELLS_REGION_LIVE?: string;
  CELLS_REGION_BETA?: string;
}

/** A customer's Studio's org id (cells.ts orgIdFor). */
const ORG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** A customer's Studio on Cloud Run (cellrun.ts serviceUrl): its key and its passes. */
export const cellOrigin = (env: Env, lane: Lane, org: string) => (env.CELLS_PROJECT_NUMBER
  ? `https://${`${lane === 'beta' ? 'studio-beta' : 'studio'}-o-${org}`.slice(0, 49)}-${env.CELLS_PROJECT_NUMBER}.${(lane === 'beta' ? env.CELLS_REGION_BETA : env.CELLS_REGION_LIVE) || (lane === 'beta' ? 'us-central1' : 'us-east4')}.run.app`
  : null);
/** Customers' sites' pass cookie: host-only on sites.<domain>, one per org by its Path (/o/<org>/, /ob/<org>/). */
export const orgPassCookie = (lane: Lane) => (lane === 'beta' ? 'hawkes_opass_beta' : 'hawkes_opass');
/** A customer site's path prefix in this lane: /o/<org> on live, /ob/<org> for studio-beta's. */
export const orgPrefix = (lane: Lane, org: string) => `/${lane === 'beta' ? 'ob' : 'o'}/${org}`;

const enc = new TextEncoder();
const b64uBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const b64uText = (s: string) => new TextDecoder().decode(b64uBytes(s));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export const passMessage = (lane: Lane, exp: number, user: string) => `pass\n${lane}\n${exp}\n${user}`;
export const publishMessage = (lane: Lane, method: string, pathAndQuery: string, ts: number, body: string) => `publish\n${lane}\n${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${body}`;
export const passCookie = (lane: Lane) => (lane === 'beta' ? 'hawkes_pass_beta' : 'hawkes_pass');

/** host -> lane and products.json "previews" subdomain, or null when this isn't a beta host. */
export function siteOf(host: string, domain = 'hawkesgen.ai'): { lane: Lane; sub: string } | null {
  const h = host.toLowerCase().split(':')[0];
  if (!h.endsWith(`.${domain}`)) return null;
  const label = h.slice(0, -domain.length - 1);
  if (!label || label.includes('.') || !/^[a-z0-9-]+$/.test(label)) return null;
  return label.startsWith('sb-') ? { lane: 'beta', sub: label.slice(3) } : { lane: 'live', sub: label };
}

/** The R2 key prefix and path inside it for a page path: /c/<change>/... is a change's preview, the rest is beta. */
export function keyOf(lane: Lane, sub: string, pathname: string): { base: string; rel: string } | null {
  let p: string;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes('\0') || p.split('/').some((s) => s === '..' || (s.startsWith('.') && s !== '.well-known'))) return null;
  const m = /^\/c\/(c_[0-9a-f]+)(\/.*)?$/.exec(p);
  const base = m ? `${lane}/${sub}/c/${m[1]}` : `${lane}/${sub}/beta`;
  const rest = m ? (m[2] ?? '/') : p;
  return { base, rel: rest.replace(/^\/+/, '') };
}

// ------------------------------------------------------------------ keys

type KeyEntry = { key: CryptoKey; at: number };
// Keyed by the lane, or lane and org for a customer's Studio (each signs with its own key).
const keys = new Map<string, KeyEntry>();
const lastRefetch = new Map<string, number>();

const originOf = (env: Env, lane: Lane) => (lane === 'beta' ? env.STUDIO_ORIGIN_BETA : env.STUDIO_ORIGIN_LIVE)?.replace(/\/+$/, '');
const publicOf = (env: Env, lane: Lane) => ((lane === 'beta' ? env.STUDIO_PUBLIC_BETA : env.STUDIO_PUBLIC_LIVE) ?? originOf(env, lane) ?? '').replace(/\/+$/, '');

/** Tests only: forget the cached keys. */
export function resetKeys() { keys.clear(); lastRefetch.clear(); }

/**
 * The lane's public key (or a customer's Studio's, with org): from memory (an hour), else that Studio's /auth/sites-key
 * (through Cloudflare's cache when there is one).
 */
async function laneKey(env: Env, lane: Lane, fresh = false, org: string | null = null): Promise<CryptoKey | null> {
  const id = org ? `${lane}:${org}` : lane;
  const k = keys.get(id);
  if (k && !fresh && Date.now() - k.at < 3600_000) return k.key;
  const origin = org ? cellOrigin(env, lane, org) : originOf(env, lane);
  if (!origin) return null;
  const url = `${origin}/auth/sites-key`;
  const cache = (globalThis as any).caches?.default as { match(r: Request): Promise<Response | undefined>; put(r: Request, s: Response): Promise<void> } | undefined;
  let res = !fresh && cache ? await cache.match(new Request(url)).catch(() => undefined) : undefined;
  if (!res) {
    res = await fetch(url, { headers: { Accept: 'application/json' } }).catch(() => undefined);
    if (!res?.ok) return k?.key ?? null;
    if (cache) await cache.put(new Request(url), new Response(await res.clone().text(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' } })).catch(() => {});
  }
  const j = (await res.json().catch(() => null)) as { lane?: string; key?: string } | null;
  if (!j?.key || (j.lane ?? 'live') !== lane) return k?.key ?? null;
  const key = await crypto.subtle.importKey('raw', b64uBytes(j.key), { name: 'Ed25519' }, false, ['verify']);
  keys.set(id, { key, at: Date.now() });
  return key;
}

async function verify(env: Env, lane: Lane, message: string, sig: string, retry: boolean, org: string | null = null) {
  const check = async (key: CryptoKey | null) => Boolean(key) && crypto.subtle.verify({ name: 'Ed25519' }, key!, b64uBytes(sig), enc.encode(message)).catch(() => false);
  if (await check(await laneKey(env, lane, false, org))) return true;
  // A new key (STUDIO_OWNER_KEY rotated): ask again, at most once a minute.
  const id = org ? `${lane}:${org}` : lane;
  if (retry && Date.now() - (lastRefetch.get(id) ?? 0) > 60_000) {
    lastRefetch.set(id, Date.now());
    return check(await laneKey(env, lane, true, org));
  }
  return false;
}

// ------------------------------------------------------------------ passes

const passOk = new Map<string, number>();

/** The user id of a valid pass for this lane (or a customer's Studio's, with org: signed with its key), or null. */
export async function checkPass(env: Env, lane: Lane, value: string | null, now = Date.now(), org: string | null = null): Promise<string | null> {
  if (!value) return null;
  const cached = passOk.get(org ? `${org} ${value}` : value);
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== lane) return null;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  let user: string;
  try { user = b64uText(parts[3]); } catch { return null; }
  if (cached) return user;
  if (!(await verify(env, lane, passMessage(lane, exp, user), parts[4], false, org))) return null;
  if (passOk.size > 500) passOk.clear();
  passOk.set(org ? `${org} ${value}` : value, exp);
  return user;
}

const cookie = (req: Request, name: string) => cookies(req, name)[0] ?? null;
/** Every value of a cookie name: a browser can hold an old pass beside a new one (another Domain or Path), and sends both. */
const cookies = (req: Request, name: string) => {
  const out: string[] = [];
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) out.push(v.join('='));
  }
  return out;
};

const isPage = (req: Request) => req.method === 'GET' && (req.headers.get('Sec-Fetch-Mode') === 'navigate' || /text\/html/.test(req.headers.get('Accept') ?? ''));

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ------------------------------------------------------------------ publishing

/**
 * Studio's signed writes, all inside its lane's prefix:
 *   PUT    /.hawkes-sites/o/<key>        the body (Content-Length, Content-Type kept)
 *   GET    /.hawkes-sites/o/<key>        read one (Studio's manifests)
 *   POST   /.hawkes-sites/copy           {"from": key, "to": key}
 *   POST   /.hawkes-sites/delete         {"keys": [...]} (up to 1000)
 * Headers: X-Hawkes-Lane, X-Hawkes-Sig "<unix seconds>.<signature>" of publishMessage, whose body part is "len:<n>" for
 * a PUT and "sha256:<hex>" of the body otherwise. Five minutes either way of the Worker's clock.
 */
export async function publish(req: Request, env: Env, url: URL, now = Date.now()): Promise<Response> {
  const lane = req.headers.get('X-Hawkes-Lane');
  if (lane !== 'live' && lane !== 'beta') return json(400, { error: 'X-Hawkes-Lane: live or beta' });
  const [tsS, sig] = (req.headers.get('X-Hawkes-Sig') ?? '').split('.');
  const ts = Number(tsS);
  if (!sig || !Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return json(401, { error: 'unsigned or stale' });
  const rest = url.pathname.slice('/.hawkes-sites/'.length);
  let bodyTag: string;
  let body: ArrayBuffer | null = null;
  if (req.method === 'PUT') {
    const len = req.headers.get('Content-Length');
    if (len === null) return json(411, { error: 'Content-Length needed' });
    bodyTag = `len:${len}`;
  } else {
    body = req.method === 'POST' ? await req.arrayBuffer() : new ArrayBuffer(0);
    bodyTag = `sha256:${hex(await crypto.subtle.digest('SHA-256', body))}`;
  }
  // A customer's Studio names its org and signs with its own key; it writes only under o/<org>/ in its lane.
  const org = req.headers.get('X-Hawkes-Org');
  if (org !== null && !ORG.test(org)) return json(400, { error: 'X-Hawkes-Org: an org id' });
  if (!(await verify(env, lane, publishMessage(lane, req.method, url.pathname + url.search, ts, bodyTag), sig, true, org))) return json(403, { error: 'bad signature' });
  const inLane = (k: unknown) => {
    const s = String(k ?? '');
    if (!s || s.startsWith('/') || s.split('/').some((x) => x === '..' || x === '') || s.length > 1000) throw new Error(`bad key ${s.slice(0, 80)}`);
    if (org && !s.startsWith(`o/${org}/`)) throw new Error(`a customer's Studio writes only under o/${org}/`);
    return `${lane}/${s}`;
  };
  try {
    if (rest.startsWith('o/')) {
      const key = inLane(decodeURIComponent(rest.slice(2)));
      if (req.method === 'PUT') {
        await env.SITES.put(key, req.body, { httpMetadata: { contentType: req.headers.get('Content-Type') ?? 'application/octet-stream' } });
        return json(200, { ok: true });
      }
      if (req.method === 'GET') {
        const o = await env.SITES.get(key);
        return o ? new Response(o.body ?? null, { headers: { 'Content-Type': o.httpMetadata?.contentType ?? 'application/octet-stream' } }) : json(404, { error: 'none' });
      }
      if (req.method === 'DELETE') {
        await env.SITES.delete(key);
        return json(200, { ok: true });
      }
    }
    const b = body ? JSON.parse(new TextDecoder().decode(body) || '{}') : {};
    if (rest === 'copy' && req.method === 'POST') {
      const from = await env.SITES.get(inLane(b.from));
      if (!from) return json(404, { error: `no ${b.from}` });
      await env.SITES.put(inLane(b.to), from.body ?? null, { httpMetadata: { contentType: from.httpMetadata?.contentType } });
      return json(200, { ok: true });
    }
    if (rest === 'delete' && req.method === 'POST') {
      const list = (Array.isArray(b.keys) ? b.keys : []).slice(0, 1000).map(inLane);
      if (list.length) await env.SITES.delete(list);
      return json(200, { ok: true, deleted: list.length });
    }
  } catch (e: any) {
    return json(400, { error: String(e?.message ?? e) });
  }
  return json(404, { error: 'no such call' });
}

// ------------------------------------------------------------------ serving

// A build's pre-compressed files (Unity's Build/x.wasm.br, x.data.gz, …): sent with their Content-Encoding and the
// inner file's type, so a build compressed without Unity's decompression fallback loads too (docs/builds.md).
const PRECOMPRESSED = /\.(js|wasm|data|json|symbols\.json|mem)\.(br|gz)$/;
const INNER_TYPE: Record<string, string> = { js: 'text/javascript; charset=utf-8', wasm: 'application/wasm', json: 'application/json', 'symbols.json': 'application/json', data: 'application/octet-stream', mem: 'application/octet-stream' };

async function serveFile(req: Request, env: Env, key: string, status = 200, extra?: Record<string, string>): Promise<Response | null> {
  const pre = PRECOMPRESSED.exec(key);
  const o = await env.SITES.get(key, { onlyIf: req.headers, ...(pre ? {} : { range: req.headers }) });
  if (!o) return null;
  const headers = new Headers({
    'Content-Type': pre ? INNER_TYPE[pre[1]] : o.httpMetadata?.contentType ?? 'application/octet-stream',
    ETag: o.httpEtag,
    // Behind a login: never in a shared cache; the browser asks again each time (304 when unchanged).
    'Cache-Control': 'private, no-cache',
    'Accept-Ranges': pre ? 'none' : 'bytes',
    'X-Robots-Tag': 'noindex',
    ...(extra ?? {}),
  });
  if (!o.body) return new Response(null, { status: 304, headers });
  if (pre) {
    headers.set('Content-Encoding', pre[2] === 'br' ? 'br' : 'gzip');
    return new Response(req.method === 'HEAD' ? null : o.body, { status, headers, encodeBody: 'manual' } as ResponseInit);
  }
  if (req.headers.get('Range') && o.range && (o.range.offset !== undefined || o.range.length !== undefined)) {
    const start = o.range.offset ?? 0;
    const len = o.range.length ?? o.size - start;
    headers.set('Content-Range', `bytes ${start}-${start + len - 1}/${o.size}`);
    headers.set('Content-Length', String(len));
    return new Response(o.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(o.size));
  return new Response(req.method === 'HEAD' ? null : o.body, { status, headers });
}

const BUILD_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' };

/**
 * A Unity build file from R2 (`builds/<game>/v<n>/...`, uploaded by Gen's build container): public, open CORS, cached for
 * a year (a version folder never changes), and sent with the Content-Encoding it was stored with (Brotli .unityweb), the
 * body passed as is so the browser decompresses it and Unity's slower JavaScript fallback never runs.
 */
export async function serveBuild(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: BUILD_CORS });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Read only.', { status: 405, headers: BUILD_CORS });
  let p: string;
  try { p = decodeURIComponent(url.pathname); } catch { return new Response('Not found', { status: 404, headers: BUILD_CORS }); }
  if (!/^\/builds\/[a-z0-9-]+\/v[0-9]+\/[^\0]+$/.test(p) || p.split('/').some((s) => s === '..' || s === '.')) return new Response('Not found', { status: 404, headers: BUILD_CORS });
  const o = await env.SITES.get(p.slice(1), { onlyIf: req.headers });
  if (!o) return new Response('Not found', { status: 404, headers: BUILD_CORS });
  const headers = new Headers({
    ...BUILD_CORS,
    'Content-Type': o.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: o.httpEtag,
  });
  const enc = o.httpMetadata?.contentEncoding;
  if (enc) headers.set('Content-Encoding', enc);
  if (!o.body) return new Response(null, { status: 304, headers });
  if (!enc) headers.set('Content-Length', String(o.size));
  return new Response(req.method === 'HEAD' ? null : o.body, { status: 200, headers, ...(enc ? { encodeBody: 'manual' } : {}) } as ResponseInit);
}

/** A page path's file: <path>, <path>index.html for a folder, else a redirect to <path>/ when that folder has one. */
async function page(req: Request, env: Env, url: URL, base: string, rel: string): Promise<Response> {
  const want = !rel || rel.endsWith('/') ? `${rel}index.html` : rel;
  const extra = await headerRules(env, base, `/${want}`);
  const hit = await serveFile(req, env, `${base}/${want}`, 200, extra);
  if (hit) return hit;
  if (rel && !rel.endsWith('/') && !/\.[a-z0-9]+$/i.test(rel) && (await env.SITES.head(`${base}/${rel}/index.html`))) {
    return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
  }
  if (!(await env.SITES.head(`${base}/.studio/build.json`)) && !(await env.SITES.head(`${base}/index.html`))) {
    return text(404, 'This beta site has not been published yet. Studio publishes it on the next push to the product\'s beta branch (or Runs > rebuild the beta site).');
  }
  // A single-page app's own routes: its 200.html (the convention static hosts use), else 404.html.
  if (isPage(req) && !/\.[a-z0-9]+$/i.test(rel)) { const spa = await serveFile(req, env, `${base}/200.html`, 200, extra); if (spa) return spa; }
  return (await serveFile(req, env, `${base}/404.html`, 404, extra)) ?? text(404, 'Not found');
}

// ------------------------------------------------------------------ builds, beta pointers, mounts, _headers (docs/builds.md)

const small = new Map<string, { at: number; v: any }>();
/** A small JSON file of a site (beta.json, mounts.json, _headers), cached for 10 seconds. */
async function smallFile(env: Env, key: string, parse: (s: string) => any): Promise<any> {
  const hit = small.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.v;
  const o = await env.SITES.get(key);
  let v: any = null;
  if (o?.body) { try { v = parse(await new Response(o.body).text()); } catch { v = null; } }
  if (small.size > 2000) small.clear();
  small.set(key, { at: Date.now(), v });
  return v;
}
/** Tests: forget cached pointers. */
export const resetSmall = () => small.clear();

/**
 * Where a page path of a site lives in R2: a build's version (/b/<build>/<n>/…), an agent change (/c/<id>/…), a build
 * mounted at a path (mounts.json: {"Game/": "o/<org>/<project>/b/web/7"}), else beta (beta.json's build, or the files
 * published as beta). A customer's site may only mount its own org's builds.
 */
export async function resolveKey(env: Env, lane: Lane, sub: string, pathname: string, org: string | null): Promise<{ base: string; rel: string } | { redirect: string } | null> {
  const k = keyOf(lane, sub, pathname);
  if (!k) return null;
  if (k.base.includes('/c/')) return k;
  const b = /^b\/([a-z0-9][a-z0-9-]{0,30})\/(\d{1,6})(\/.*)?$/.exec(k.rel);
  if (b) return b[3] === undefined ? { redirect: '/' } : { base: `${lane}/${sub}/b/${b[1]}/${b[2]}`, rel: b[3].replace(/^\/+/, '') };
  const mounts = (await smallFile(env, `${lane}/${sub}/mounts.json`, JSON.parse)) as Record<string, string> | null;
  if (mounts) {
    const at = Object.keys(mounts).filter((m) => m && k.rel.startsWith(m)).sort((x, y) => y.length - x.length)[0];
    const to = at ? String(mounts[at]) : '';
    const ok = to && !to.split('/').some((s) => s === '..' || s === '') && (!org || to.startsWith(`o/${org}/`));
    if (at && ok) return { base: `${lane}/${to}`, rel: k.rel.slice(at.length) };
  }
  const beta = await smallFile(env, `${lane}/${sub}/beta.json`, JSON.parse);
  if (beta && /^[a-z0-9][a-z0-9-]{0,30}$/.test(String(beta.build)) && Number.isInteger(beta.version)) return { base: `${lane}/${sub}/b/${beta.build}/${beta.version}`, rel: k.rel };
  return k;
}

/** Headers a site's _headers file asks for (the Cloudflare Pages format), from a safe list: Godot 4's isolation and the like. */
const HEADER_OK = /^(cross-origin-opener-policy|cross-origin-embedder-policy|cross-origin-resource-policy|content-security-policy|permissions-policy|referrer-policy|x-frame-options|x-content-type-options)$/i;
async function headerRules(env: Env, base: string, path: string): Promise<Record<string, string>> {
  const rules = (await smallFile(env, `${base}/_headers`, parseHeaders)) as { pattern: RegExp; headers: [string, string][] }[] | null;
  const out: Record<string, string> = {};
  for (const r of rules ?? []) if (r.pattern.test(path)) for (const [k, v] of r.headers) out[k] = v;
  return out;
}
export function parseHeaders(text: string) {
  const rules: { pattern: RegExp; headers: [string, string][] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const glob = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      rules.push({ pattern: new RegExp(`^${glob}$`), headers: [] });
      continue;
    }
    const m = /^\s+([\w-]+):\s*(.+)$/.exec(line);
    if (m && rules.length && HEADER_OK.test(m[1])) rules[rules.length - 1].headers.push([m[1], m[2].trim()]);
  }
  return rules;
}

/** POST /dev/__studio/report|error: to the lane's Studio, as the studio.hawkesgen.ai Worker passes requests. */
async function toStudio(req: Request, env: Env, lane: Lane, url: URL) {
  const origin = originOf(env, lane);
  if (!origin) return json(503, { error: 'no Studio for this lane' });
  const to = new URL(url.pathname + url.search, origin);
  const headers = new Headers(req.headers);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Forwarded-For', req.headers.get('CF-Connecting-IP') ?? '');
  // The body is small JSON (a report, an error): read it whole, so nothing depends on streaming a request body on.
  return fetch(to, { method: req.method, headers, body: await req.arrayBuffer(), redirect: 'manual' });
}

/**
 * POST /o/<org>/.hawkes-pass {pass, next}: a customer's Studio hands over a pass it signed (a form its /auth/pass page
 * posts, so the pass is never in an address). Kept host-only on this host, under that org's path alone, then back to
 * the page.
 */
async function takePass(req: Request, env: Env, lane: Lane, org: string, url: URL, now: number): Promise<Response> {
  if (req.method !== 'POST') return text(405, 'Studio posts here.');
  const form = await req.formData().catch(() => null);
  const pass = String(form?.get('pass') ?? '');
  if (!(await checkPass(env, lane, pass, now, org))) return text(403, 'That sign-in did not check out. Open the page again from your Studio.');
  const prefix = orgPrefix(lane, org);
  let to = `${prefix}/`;
  try {
    const n = new URL(String(form?.get('next') ?? ''), url);
    if (n.origin === url.origin && n.pathname.startsWith(`${prefix}/`)) to = n.pathname + n.search;
  } catch { /* back to the org's root */ }
  const cookie = [`${orgPassCookie(lane)}=${pass}`, `Path=${prefix}/`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=43200'].join('; ');
  return new Response(null, { status: 303, headers: { Location: to, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } });
}

/** The project prefix of the page that asked (same host only): /o/<org>/<project>, /ob/..., /g/<game>, /b/<game>, with
 *  a change's /c/<id> when the page was inside one. null: not from a project under a path. */
export function underProject(req: Request, url: URL): string | null {
  const ref = req.headers.get('Referer');
  if (!ref) return null;
  let r: URL;
  try { r = new URL(ref); } catch { return null; }
  if (r.host !== url.host) return null;
  const m = /^(\/(?:o|ob)\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]\/[a-z][a-z0-9-]{1,39}|\/(?:g|b)\/[a-z][a-z0-9-]{1,39})(\/c\/[A-Za-z0-9_-]{1,64})?\//.exec(r.pathname);
  return m ? m[1] + (m[2] ?? '') : null;
}

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/.hawkes-sites/')) return publish(req, env, url, now);
  const site = siteOf(url.host, env.DOMAIN ?? 'hawkesgen.ai');
  if (!site) return text(404, 'Not a beta site.');
  let { lane, sub } = site;
  let pathname = url.pathname;
  // Unity builds (docs/unity-builds-storage.md): https://sites.<domain>/builds/<game>/v<n>/..., public (live pages load
  // them), before any pass check.
  if (lane === 'live' && sub === 'sites' && url.pathname.startsWith('/builds/')) return serveBuild(req, env, url);
  // Games added through Talk have no host of their own (each host needs a route): https://sites.<domain>/g/<game>/ is
  // live Studio's beta site of one, /b/<game>/ studio-beta's (R2 <lane>/g-<game>/...). Their builds use relative paths.
  const g = lane === 'live' && sub === 'sites' ? /^\/(g|b)\/([a-z][a-z0-9-]{1,39})(\/.*)?$/.exec(url.pathname) : null;
  if (g) {
    if (!g[3]) return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
    lane = g[1] === 'b' ? 'beta' : 'live';
    sub = `g-${g[2]}`;
    pathname = g[3];
  }
  // A root path asked for by a page of a project under a path (/o/<org>/<project>/, /g/<game>/, a change's /c/<id>/
  // inside): back into that project. Sites written for their own domain use root paths (/css/site.css, /Game/), which
  // left Yooba Land's website unstyled with Play going nowhere (2026-10-31). The Referer says which project; 307 keeps
  // a form's method and body.
  if (lane === 'live' && sub === 'sites' && !g && !/^\/(o|ob|g|b|builds)\//.test(url.pathname)) {
    const back = underProject(req, url);
    if (back) return new Response(null, { status: url.pathname === '/' ? 302 : 307, headers: { Location: `${back}${url.pathname}${url.search}`, 'Cache-Control': 'no-store', Vary: 'Referer' } });
  }
  // Customers' Studios' sites (J, 2026-10-31): https://sites.<domain>/o/<org>/<project>/ (studio-beta's /ob/...), R2
  // <lane>/o/<org>/<project>/..., previews at /c/<change>/ inside; passes signed by that Studio, kept per org by Path.
  let org: string | null = null;
  const o = lane === 'live' && sub === 'sites' ? /^\/(o|ob)\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(?:\/([a-z][a-z0-9-]{1,39}))?(\/.*)?$/.exec(url.pathname) : null;
  if (o) {
    lane = o[1] === 'ob' ? 'beta' : 'live';
    org = o[2];
    if (!o[3] && o[4] === '/.hawkes-pass') return takePass(req, env, lane, org, url, now);
    if (!o[3]) return text(404, 'Not found');
    if (!o[4]) return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
    sub = `o/${org}/${o[3]}`;
    pathname = o[4];
  }
  // The first pass that checks out: a stale one sent first must not hide a good one (2026-10-29: beta sites 403 for J).
  let user: string | null = null;
  for (const v of cookies(req, org ? orgPassCookie(lane) : passCookie(lane))) if ((user = await checkPass(env, lane, v, now, org))) break;
  if (!user) {
    // Sign-in happens at the Studio that owns the site: a customer's at its own /o/<org>/.
    const signin = `${publicOf(env, lane)}${org ? `/o/${org}` : ''}/auth/pass`;
    if (isPage(req)) {
      // Back from /auth/pass without a pass that works: say so instead of going round again.
      if (url.searchParams.has('__hawkes_pass')) return text(403, 'Studio signed you in, but this browser did not keep the beta-site pass (cookies blocked?). Allow cookies for hawkesgen.ai and reload.');
      return new Response(null, { status: 302, headers: { Location: `${signin}?next=${encodeURIComponent(url.toString())}`, 'Cache-Control': 'no-store' } });
    }
    return json(401, { error: 'Sign in to Studio first.', signin });
  }
  if (url.searchParams.has('__hawkes_pass')) {
    url.searchParams.delete('__hawkes_pass');
    return new Response(null, { status: 302, headers: { Location: url.pathname + url.search, 'Cache-Control': 'no-store' } });
  }
  // pathname: under a game's own path for one added through Talk (/b/<game>/dev/__studio/...), as for any other host.
  if (pathname.startsWith('/dev/')) {
    const what = pathname.slice('/dev/__studio/'.length);
    if (pathname.startsWith('/dev/__studio/')) {
      if (what === 'report.js') return (await serveFile(req, env, `${lane}/_studio/report.js`)) ?? text(404, 'no widget yet');
      if (what === 'build') return (await serveFile(req, env, `${lane}/${sub}/beta/.studio/build.json`)) ?? json(200, {});
      // A customer's pages post reports to their own Studio with their project's key (reportkey.ts), never here.
      if ((what === 'report' || what === 'error') && req.method === 'POST' && !org) return toStudio(req, env, lane, url);
    }
    return text(404, 'The /dev/ dev servers are not running on Google Cloud yet (docs/studio-cloudrun.md, "Not done here").');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Read only.');
  const k = await resolveKey(env, lane, sub, pathname, org);
  if (!k) return text(404, 'Not found');
  if ('redirect' in k) return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
  return page(req, env, url, k.base, k.rel);
}

export default { fetch: (req: Request, env: Env) => handle(req, env) };
