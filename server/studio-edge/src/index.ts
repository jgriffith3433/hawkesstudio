// The Worker in front of studio.hawkesgen.ai (docs/studio-cloudrun.md "The address", docs/studio-customers.md section 2).
//
// J's Studio: the same request to Studio on Cloud Run, the answer streamed back as it comes (the dashboard's event
// stream and Talk's answers included). The host goes along as X-Forwarded-Host, so Studio's session cookie is set for
// .hawkesgen.ai and its sign-in pages accept their own forms (auth.ts, auth-pages.ts); the visitor's address as
// X-Forwarded-For (the sign-in log and its limits).
//
// Customers' Studios (cells, src/cells.ts): studio.hawkesgen.ai/o/<org>/… goes to that org's own Cloud Run service,
// studio-o-<org> (studio-beta-o-<org> on beta), at Cloud Run's deterministic address, with the /o/<org> prefix taken off
// (X-Forwarded-Prefix says what it was). The dashboard asks for absolute paths (/api/…), so a request whose Referer is a
// cell's page goes to that cell too, and a page navigation from a cell to a path outside it is sent back under /o/<org>.
// Cookies never cross: a cell gets only its own (hs_o_<org>), never J's session, the control plane's or another cell's;
// J's Studio never gets a cell's. A cell's redirects come back under its prefix.
//
// A hibernated cell (its service deleted, its data kept) answers with Cloud Run's own 404, without the X-Studio-Cell
// header every cell sets: the Worker asks the control plane to wake it (POST /api/cells/edge/<org>/wake, the edge key)
// and shows "Waking your studio" until /api/health answers, then reloads. An org with no cell yet (signed up, no game or
// plan) goes to the sign-up (/auth/start).

type Env = {
  STUDIO_ORIGIN: string;
  CELLS_PROJECT_NUMBER?: string;
  CELLS_REGION?: string;
  CELLS_SERVICE_PREFIX?: string; // studio, or studio-beta
  EDGE_KEY?: string; // the control plane's edge key (cellkeys.ts edgeKey): wrangler secret put EDGE_KEY
};
type Ctx = { waitUntil(p: Promise<unknown>): void };

const ORG_PATH = /^\/o\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(\/.*)?$/;

/** The org a request is for, and the path inside its cell; a redirect when a navigation left the cell by accident. */
export function route(request: Request): { org: string; path: string } | { redirect: string } | null {
  const url = new URL(request.url);
  const m = ORG_PATH.exec(url.pathname);
  if (m) return m[2] === undefined ? { redirect: `/o/${m[1]}/${url.search}` } : { org: m[1], path: m[2] };
  // An editor finding a customer's Studio's MCP sign-in the standard way (RFC 8414, RFC 9728: the well-known name, then
  // the issuer's or resource's path): /.well-known/<name>/o/<org>[/mcp] is that Studio's /.well-known/<name>[/mcp].
  const wk = /^\/\.well-known\/([a-z-]+)\/o\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(\/.*)?$/.exec(url.pathname);
  if (wk) return { org: wk[2], path: `/.well-known/${wk[1]}${wk[3] ?? ''}` };
  // The control plane's own pages and the sign-up stay with J's Studio whoever links them.
  if (url.pathname.startsWith('/auth/start') || url.pathname === '/favicon.ico') return null;
  // GitHub's answers come back to J's Studio, which holds the GitHub App, whoever started the trip: a sign-in begun on a
  // customer's page keeps that page as its Referer through GitHub's redirects (2026-10-30: it landed in the cell).
  if (/^\/api\/github\/(callback|installed|app\/created)(\/|$)/.test(url.pathname)) return null;
  const ref = request.headers.get('Referer');
  if (!ref) return null;
  let r: URL;
  try { r = new URL(ref); } catch { return null; }
  if (r.host !== url.host) return null;
  const rm = ORG_PATH.exec(r.pathname);
  if (!rm) return null;
  if (request.headers.get('Sec-Fetch-Mode') === 'navigate' && request.method === 'GET') return { redirect: `/o/${rm[1]}${url.pathname}${url.search}` };
  return { org: rm[1], path: url.pathname };
}

/** Only the cookies a destination may see: a cell its own; J's Studio none of the cells'. */
export function filterCookies(cookie: string | null, org: string | null) {
  if (!cookie) return null;
  const mine = org ? `hs_o_${org.replace(/-/g, '_')}` : null;
  const kept = cookie.split(';').map((c) => c.trim()).filter(Boolean).filter((c) => {
    const name = c.split('=')[0];
    if (org) return name === mine || name === 'g_state';
    return !name.startsWith('hs_o_');
  });
  return kept.length ? kept.join('; ') : null;
}

export const cellHost = (org: string, env: Env) => `${`${env.CELLS_SERVICE_PREFIX || 'studio'}-o-${org}`.slice(0, 49)}-${env.CELLS_PROJECT_NUMBER}.${env.CELLS_REGION || 'us-east4'}.run.app`;

function forwardHeaders(request: Request, org: string | null) {
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') ?? '');
  const c = filterCookies(request.headers.get('Cookie'), org);
  if (c) headers.set('Cookie', c); else headers.delete('Cookie');
  if (org) headers.set('X-Forwarded-Prefix', `/o/${org}`);
  else headers.delete('X-Forwarded-Prefix');
  return headers;
}

/** A cell's answer, put back under its prefix: redirects, and a referrer the next request can be routed by. */
function fromCell(r: Response, org: string) {
  const out = new Response(r.body, r);
  const loc = out.headers.get('Location');
  if (loc && loc.startsWith('/') && !loc.startsWith('//') && !ORG_PATH.test(loc)) out.headers.set('Location', `/o/${org}${loc}`);
  // Behind the router the same-origin referrer is how /api/… finds the cell. Not 'same-origin' alone: Google's sign-in
  // button needs the origin as Referer on its own requests, or it says the origin isn't allowed for the client ID.
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return out;
}

const seen = new Map<string, number>();

async function control(env: Env, path: string, method = 'GET') {
  return fetch(`${env.STUDIO_ORIGIN.replace(/\/+$/, '')}${path}`, { method, headers: { Authorization: `Bearer ${env.EDGE_KEY ?? ''}` } });
}

const PAGE = {
  first: { title: 'Setting up your studio', line: 'Your own Hawkes Studio is being made. This takes a few seconds, once.', small: 'You sign in once it opens.' },
  waking: { title: 'Waking your studio', line: 'It was asleep to save you money. This takes a few seconds.', small: 'Your games and data are all there.' },
  busy: { title: 'Your studio is busy', line: 'It has a lot running and is slow to answer. This page opens by itself as soon as it can.', small: 'Your games and data are all there.' },
  restarting: { title: 'Your studio is restarting', line: 'This takes a few seconds.', small: 'Your games and data are all there.' },
} as const;

/**
 * The page while a cell can't answer: its first start, after hibernation, or awake but out of room (Cloud Run's 429) or
 * restarting. Only a hibernated cell is asleep: telling an overloaded one's owner "It was asleep" sent the search the
 * wrong way (2026-11-06).
 */
export function wakingPage(org: string, kind: keyof typeof PAGE = 'waking') {
  const { title, line, small } = PAGE[kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f12;color:#e8edf1;font:16px/1.5 system-ui,sans-serif;padding:16px}main{max-width:380px;text-align:center}.dot{width:12px;height:12px;border-radius:50%;background:#3ddc97;display:inline-block;animation:p 1.2s infinite}@keyframes p{50%{opacity:.25}}small{color:#8a96a0}</style></head>
<body><main><p><span class="dot"></span></p><h1 style="font-size:20px">${title}</h1><p id="s">${line}</p><small>${small}</small></main>
<script>(function(){var n=0;function t(){fetch('/o/${org}/__waking',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j.ready)location.reload();else if(j.next)location.href=j.next;else if(j.error&&++n>60)document.getElementById('s').textContent=j.error;else setTimeout(t,2000)}).catch(function(){setTimeout(t,3000)})}setTimeout(t,1500)})();</script></body></html>`;
}

async function wake(org: string, env: Env) {
  const r = await control(env, `/api/cells/edge/${org}/wake`, 'POST');
  if (r.status === 404) return { gone: true };
  const j: any = await r.json().catch(() => ({}));
  return j.state === 'new' ? { next: j.next ?? '/auth/start' } : { waking: true, first: j.first === true };
}

/**
 * A live answer (the dashboard's event streams `text/event-stream`, the playtests' video `multipart/x-mixed-replace`) goes
 * back as it comes, never buffered, compressed or cached: the body is passed through untouched (not read), `no-transform`
 * keeps Cloudflare from compressing it into a buffer, and the type keeps its charset. A page holds one such request open
 * instead of asking again and again (J, 2026-11-02: no polling); the browser's own reconnect (`retry:`) replaces a dropped one.
 */
export function streaming(res: Response): Response {
  const type = res.headers.get('Content-Type') ?? '';
  if (!/^text\/event-stream|^multipart\/x-mixed-replace/i.test(type)) return res;
  const out = new Response(res.body, res);
  if (/^text\/event-stream/i.test(type)) out.headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  out.headers.set('Cache-Control', 'no-store, no-transform');
  out.headers.set('X-Accel-Buffering', 'no');
  out.headers.delete('Content-Length');
  out.headers.delete('ETag');
  return out;
}

// Workers Logs keep only what this logs (wrangler.jsonc: no per-request invocation logs): errors, never routine hits.
export default {
  async fetch(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
    try {
      const res = streaming(await handle(request, env, ctx));
      if (res.status >= 500 && res.status !== 503) console.error(`studio-edge ${request.method} ${new URL(request.url).pathname.slice(0, 200)}: ${res.status}`);
      return res;
    } catch (e: any) {
      console.error(`studio-edge ${request.method} ${new URL(request.url).pathname.slice(0, 200)}: ${e?.stack ?? e}`);
      return new Response('Studio could not be reached.', { status: 502, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
  },
};

async function handle(request: Request, env: Env, ctx?: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const r = env.CELLS_PROJECT_NUMBER ? route(request) : null;
  if (r && 'redirect' in r) return new Response(null, { status: 302, headers: { Location: r.redirect, 'Cache-Control': 'no-store' } });

  if (!r) {
    const origin = new URL(env.STUDIO_ORIGIN);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = '';
    return fetch(url, { method: request.method, headers: forwardHeaders(request, null), body: request.body, redirect: 'manual' });
  }

  const { org, path } = r;
  const target = new URL(`https://${cellHost(org, env)}${path}${url.search}`);
  // The waking page's question: is the cell up yet?
  if (path === '/__waking') {
    const h = await fetch(new URL('/api/health', target), { headers: { 'X-Forwarded-Prefix': `/o/${org}` } }).catch(() => null);
    if (h?.headers.get('X-Studio-Cell')) return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } });
    const s: any = await (await control(env, `/api/cells/edge/${org}`)).json().catch(() => ({}));
    return Response.json({ ready: false, state: s.state ?? 'unknown', ...(s.state === 'new' ? { next: '/auth/start' } : {}), ...(s.error ? { error: s.error } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  // Small bodies are kept so a request can be sent again: a cell restarting (a deploy's roll, a scale-up) answers
  // with Cloud Run's 429/5xx for a few seconds, and an Approve tap was lost to that once (2026-10-31 review).
  const len = Number(request.headers.get('Content-Length') ?? '0');
  const body = request.body && len > 0 && len <= 1024 * 1024 ? await request.arrayBuffer() : request.body;
  const send = () => fetch(target, { method: request.method, headers: forwardHeaders(request, org), body: body instanceof ArrayBuffer ? body.slice(0) : body, redirect: 'manual' });
  let res = await send();
  for (let i = 0; i < 3 && !res.headers.get('X-Studio-Cell') && res.status !== 404 && (body === null || body instanceof ArrayBuffer); i++) {
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    res = await send();
  }
  if (res.headers.get('X-Studio-Cell') === org) {
    const now = Date.now();
    if (ctx && env.EDGE_KEY && now - (seen.get(org) ?? 0) > 10 * 60_000) {
      seen.set(org, now);
      ctx.waitUntil(control(env, `/api/cells/edge/${org}/seen`, 'POST').catch(() => null));
    }
    return fromCell(res, org);
  }
  // Anything but Cloud Run's 404 is a cell that exists: restarting, or awake with no room (429). Say which, don't wake
  // it, nothing was lost.
  if (res.status !== 404) {
    const busy = res.status === 429;
    const navigating = request.method === 'GET' && (request.headers.get('Sec-Fetch-Mode') === 'navigate' || /text\/html/.test(request.headers.get('Accept') ?? ''));
    if (navigating) return new Response(wakingPage(org, busy ? 'busy' : 'restarting'), { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' } });
    return Response.json({ error: busy ? 'Your studio is busy; nothing was changed. Try again in a moment.' : 'Your studio is restarting for a moment; nothing was changed. Try again in a few seconds.', restarting: true, ...(busy ? { busy: true } : {}) }, { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } });
  }
  // Cloud Run's own answer: no such service (hibernated, or never made).
  const w = await wake(org, env);
  if ('gone' in w) return new Response('No such studio.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  if ('next' in w) return new Response(null, { status: 302, headers: { Location: w.next, 'Cache-Control': 'no-store' } });
  const navigate = request.method === 'GET' && (request.headers.get('Sec-Fetch-Mode') === 'navigate' || /text\/html/.test(request.headers.get('Accept') ?? ''));
  if (navigate) return new Response(wakingPage(org, 'first' in w && w.first ? 'first' : 'waking'), { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' } });
  return Response.json({ error: 'Your studio is waking up; try again in a few seconds.', waking: true }, { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } });
}
