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
}

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
const keys = new Map<Lane, KeyEntry>();
let lastRefetch = 0;

const originOf = (env: Env, lane: Lane) => (lane === 'beta' ? env.STUDIO_ORIGIN_BETA : env.STUDIO_ORIGIN_LIVE)?.replace(/\/+$/, '');
const publicOf = (env: Env, lane: Lane) => ((lane === 'beta' ? env.STUDIO_PUBLIC_BETA : env.STUDIO_PUBLIC_LIVE) ?? originOf(env, lane) ?? '').replace(/\/+$/, '');

/** Tests only: forget the cached keys. */
export function resetKeys() { keys.clear(); lastRefetch = 0; }

/** The lane's public key: from memory (an hour), else Studio's /auth/sites-key (through Cloudflare's cache when there is one). */
async function laneKey(env: Env, lane: Lane, fresh = false): Promise<CryptoKey | null> {
  const k = keys.get(lane);
  if (k && !fresh && Date.now() - k.at < 3600_000) return k.key;
  const origin = originOf(env, lane);
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
  keys.set(lane, { key, at: Date.now() });
  return key;
}

async function verify(env: Env, lane: Lane, message: string, sig: string, retry: boolean) {
  const check = async (key: CryptoKey | null) => Boolean(key) && crypto.subtle.verify({ name: 'Ed25519' }, key!, b64uBytes(sig), enc.encode(message)).catch(() => false);
  if (await check(await laneKey(env, lane))) return true;
  // A new key (STUDIO_OWNER_KEY rotated): ask again, at most once a minute.
  if (retry && Date.now() - lastRefetch > 60_000) {
    lastRefetch = Date.now();
    return check(await laneKey(env, lane, true));
  }
  return false;
}

// ------------------------------------------------------------------ passes

const passOk = new Map<string, number>();

/** The user id of a valid pass for this lane, or null. */
export async function checkPass(env: Env, lane: Lane, value: string | null, now = Date.now()): Promise<string | null> {
  if (!value) return null;
  const cached = passOk.get(value);
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== lane) return null;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  let user: string;
  try { user = b64uText(parts[3]); } catch { return null; }
  if (cached) return user;
  if (!(await verify(env, lane, passMessage(lane, exp, user), parts[4], false))) return null;
  if (passOk.size > 500) passOk.clear();
  passOk.set(value, exp);
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
  if (!(await verify(env, lane, publishMessage(lane, req.method, url.pathname + url.search, ts, bodyTag), sig, true))) return json(403, { error: 'bad signature' });
  const inLane = (k: unknown) => {
    const s = String(k ?? '');
    if (!s || s.startsWith('/') || s.split('/').some((x) => x === '..' || x === '') || s.length > 1000) throw new Error(`bad key ${s.slice(0, 80)}`);
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

async function serveFile(req: Request, env: Env, key: string, status = 200): Promise<Response | null> {
  const o = await env.SITES.get(key, { onlyIf: req.headers, range: req.headers });
  if (!o) return null;
  const headers = new Headers({
    'Content-Type': o.httpMetadata?.contentType ?? 'application/octet-stream',
    ETag: o.httpEtag,
    // Behind a login: never in a shared cache; the browser asks again each time (304 when unchanged).
    'Cache-Control': 'private, no-cache',
    'Accept-Ranges': 'bytes',
    'X-Robots-Tag': 'noindex',
  });
  if (!o.body) return new Response(null, { status: 304, headers });
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
  const hit = await serveFile(req, env, `${base}/${want}`);
  if (hit) return hit;
  if (rel && !rel.endsWith('/') && !/\.[a-z0-9]+$/i.test(rel) && (await env.SITES.head(`${base}/${rel}/index.html`))) {
    return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
  }
  if (!(await env.SITES.head(`${base}/.studio/build.json`)) && !(await env.SITES.head(`${base}/index.html`))) {
    return text(404, 'This beta site has not been published yet. Studio publishes it on the next push to the product\'s beta branch (or Runs > rebuild the beta site).');
  }
  return (await serveFile(req, env, `${base}/404.html`, 404)) ?? text(404, 'Not found');
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

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/.hawkes-sites/')) return publish(req, env, url, now);
  const site = siteOf(url.host, env.DOMAIN ?? 'hawkesgen.ai');
  if (!site) return text(404, 'Not a beta site.');
  const { lane, sub } = site;
  // Unity builds (docs/unity-builds-storage.md): https://sites.<domain>/builds/<game>/v<n>/..., public (live pages load
  // them), before any pass check.
  if (lane === 'live' && sub === 'sites' && url.pathname.startsWith('/builds/')) return serveBuild(req, env, url);
  // The first pass that checks out: a stale one sent first must not hide a good one (2026-10-29: beta sites 403 for J).
  let user: string | null = null;
  for (const v of cookies(req, passCookie(lane))) if ((user = await checkPass(env, lane, v, now))) break;
  if (!user) {
    if (isPage(req)) {
      // Back from /auth/pass without a pass that works: say so instead of going round again.
      if (url.searchParams.has('__hawkes_pass')) return text(403, 'Studio signed you in, but this browser did not keep the beta-site pass (cookies blocked?). Allow cookies for hawkesgen.ai and reload.');
      return new Response(null, { status: 302, headers: { Location: `${publicOf(env, lane)}/auth/pass?next=${encodeURIComponent(url.toString())}`, 'Cache-Control': 'no-store' } });
    }
    return json(401, { error: 'Sign in to Studio first.', signin: `${publicOf(env, lane)}/auth/pass` });
  }
  if (url.searchParams.has('__hawkes_pass')) {
    url.searchParams.delete('__hawkes_pass');
    return new Response(null, { status: 302, headers: { Location: url.pathname + url.search, 'Cache-Control': 'no-store' } });
  }
  if (url.pathname.startsWith('/dev/')) {
    const what = url.pathname.slice('/dev/__studio/'.length);
    if (url.pathname.startsWith('/dev/__studio/')) {
      if (what === 'report.js') return (await serveFile(req, env, `${lane}/_studio/report.js`)) ?? text(404, 'no widget yet');
      if (what === 'build') return (await serveFile(req, env, `${lane}/${sub}/beta/.studio/build.json`)) ?? json(200, {});
      if ((what === 'report' || what === 'error') && req.method === 'POST') return toStudio(req, env, lane, url);
    }
    return text(404, 'The /dev/ dev servers are not running on Google Cloud yet (docs/studio-cloudrun.md, "Not done here").');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Read only.');
  const k = keyOf(lane, sub, url.pathname);
  if (!k) return text(404, 'Not found');
  return page(req, env, url, k.base, k.rel);
}

export default { fetch: (req: Request, env: Env) => handle(req, env) };
