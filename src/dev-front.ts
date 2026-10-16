// The /dev/ front door: one small listener per product (products.json dev.front, on 127.0.0.1). Caddy sends
// https://<sub>.hawkesgen.com/dev/* there, and Vite's HMR websocket (Sec-WebSocket-Protocol: vite-hmr) too.
//
//   /dev/                        the start page: starts the dev server (dev.ts), installs the service worker, then
//                                opens the product's devtools page (dev.path, e.g. /dev/devtools.html)
//   /dev/<anything>              proxied to the dev server as /<anything> (the "starting" page while it isn't up)
//   /dev/__studio/...            this file's own pages and API (status, start, stop)
//
// Why a service worker: the devtools are written for the site root (fetch('/api/dev/...'), <script src="/src/...">,
// links to /Game/), which a Vite `base` can't fix (it only rewrites what Vite bundles). The worker, scoped to /dev/,
// sends every same-origin request a /dev/ page makes to /dev/<path>, so the products need no changes. A small script
// put into each HTML page (shim) keeps links, window.open and iframes inside /dev/, shows a status pill, and sends a
// page that was opened without the worker through the start page. Without a domain (J's PC) the same front door is
// http://localhost:<front>/dev/.
//
// The fallback, for a browser without service workers (the Claude desktop app's browser pane refuses them): the
// dev-<sub> host (https://dev-<sub>.hawkesgen.com/, or http://dev-<product>.localhost:<front>/ here), where the whole
// host is the dev server at its root and nothing needs rewriting. Caddy sends that host here with no path change; any
// Host starting with "dev-" is served this way ("root mode"). /__studio/ and /dev/__studio/ are this file's pages there.
//
// Unity products: /dev/ is a page explaining that their editor runs on the build server.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { getProduct, loadProducts, GEN_URL, type Product } from './config.ts';
import { fileReport, WIDGET } from './bugreport.ts';
import { devConf, devHostUrl, devStatus, startDev, stopDev, touchDev, devRunning, isUnity, unityInfo, sinceLive } from './dev.ts';

const P = '/dev';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const SW = `// Hawkes Studio /dev/ service worker: same-origin requests from /dev/ pages go to /dev/<path>.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin || r.mode === 'navigate') return;
  if (u.pathname === '${P}' || u.pathname.startsWith('${P}/')) return;
  u.pathname = '${P}' + u.pathname;
  e.respondWith((async () => {
    const init = { method: r.method, headers: r.headers, credentials: r.credentials, cache: r.cache, redirect: r.redirect, referrer: r.referrer, integrity: r.integrity };
    if (r.method !== 'GET' && r.method !== 'HEAD') init.body = await r.blob();
    return fetch(u.href, init);
  })());
});
`;

const SHIM = `(() => {
  const P = '${P}';
  // Root mode (the dev-<sub> host): the page is already at the root; only the status pill.
  const ROOT = /[?&]root=1/.test((document.currentScript && document.currentScript.src) || '');
  const inside = (p) => p === P || p.startsWith(P + '/');
  // Opened without the service worker (a bookmark, a new browser): go through the start page, which installs it.
  if (!ROOT && (!navigator.serviceWorker || !navigator.serviceWorker.controller)) {
    if (window.stop) window.stop();
    location.replace(P + '/__studio/start?to=' + encodeURIComponent(location.pathname + location.search + location.hash));
    return;
  }
  const fix = (url) => {
    try {
      const u = new URL(url, location.href);
      if (u.origin === location.origin && !inside(u.pathname)) return P + u.pathname + u.search + u.hash;
    } catch {}
    return url;
  };
  if (!ROOT) document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a && !a.hasAttribute('download')) { const f = fix(a.href); if (f !== a.href) a.setAttribute('href', f); }
  }, true);
  const open = window.open;
  if (!ROOT) window.open = function (url, ...rest) { return open.call(window, url == null ? url : fix(String(url)), ...rest); };
  const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  if (!ROOT && d && d.set) Object.defineProperty(HTMLIFrameElement.prototype, 'src', { ...d, set(v) { d.set.call(this, fix(String(v))); } });
  // The status pill: what happens to saves.
  const pill = document.createElement('a');
  pill.href = P + '/__studio/info';
  pill.target = '_blank';
  pill.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;font:12px/1.4 system-ui,sans-serif;padding:3px 9px;border-radius:999px;background:#1d2a22;color:#b7f5c8;text-decoration:none;opacity:.85;box-shadow:0 1px 4px #0006';
  pill.textContent = 'beta · saves commit to beta';
  const show = () => fetch(P + '/__studio/status').then((r) => r.json()).then((s) => {
    const c = s.copy || {};
    if (s.conflict) { pill.style.background = '#4a1d1d'; pill.style.color = '#ffc9c9'; pill.textContent = 'beta conflict: ' + s.conflict.files.join(', ') + ' (saves are not committed)'; return; }
    pill.textContent = c.uncommitted ? 'beta · ' + c.uncommitted + ' change(s) commit after 60 s quiet' : (s.lastPush ? 'beta · pushed ' + Math.max(0, Math.round((Date.now() - s.lastPush.at) / 60000)) + ' min ago' : 'beta · saves commit to beta');
  }).catch(() => {});
  const go = () => { if (document.body) { document.body.appendChild(pill); show(); setInterval(show, 15000); } else setTimeout(go, 200); };
  go();
})();
`;

const page = (title: string, body: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#0f1412;--fg:#e8efe9;--mut:#9aa8a0;--acc:#7ee2a0;--card:#18201c;--warn:#ffb36b}
@media (prefers-color-scheme: light){:root{--bg:#f6f8f6;--fg:#17201b;--mut:#5b6a61;--acc:#137a3a;--card:#fff;--warn:#a65500}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut)}.card{background:var(--card);border-radius:10px;padding:14px 16px;margin:14px 0}
a{color:var(--acc)}code{font-size:13px}.warn{color:var(--warn)}button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--mut);background:transparent;color:var(--fg);cursor:pointer}
li{margin:4px 0}
</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;

function startPage(p: Product, to: string, root = false) {
  let target = to && to.startsWith(`${P}/`) && !to.startsWith(`${P}/__studio`) ? to : `${P}${devConf(p)?.path ?? '/'}`;
  if (root) target = target.slice(P.length);
  const fallback = devHostUrl(p);
  return page(`${p.name} devtools`, `<h1>${esc(p.name)} devtools on beta</h1>
<p class="mut">Running on the cloud server in beta's working copy. Saves are committed to the <b>beta</b> branch after 60 quiet seconds
and the beta site is rebuilt. Nothing goes live from here.</p>
<div class="card"><b id="state">Starting the dev server…</b><div id="detail" class="mut"></div></div>
<p class="mut"><a href="/">Beta site</a> · <a href="${esc(p.live)}">Live</a> · <a href="${P}/__studio/info">Status</a></p>`, `
const target = ${JSON.stringify(target)};
const ROOT = ${root};
const FALLBACK = ${JSON.stringify(fallback)};
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function worker() {
  if (ROOT) return;
  const no = (why) => new Error('This browser won\\'t run the service worker /dev/ needs (' + why + '). Open this page in Chrome, or use the dev host: ' + FALLBACK);
  if (!('serviceWorker' in navigator)) throw no('no service workers');
  try {
    await navigator.serviceWorker.register('${P}/__studio/sw.js', { scope: '${P}/' });
  } catch (e) {
    throw no(String(e.message || e).slice(0, 120));
  }
  await navigator.serviceWorker.ready;
  for (let i = 0; i < 30 && !navigator.serviceWorker.controller; i++) await sleep(100);
  if (!navigator.serviceWorker.controller) { location.reload(); await sleep(60000); }
}
async function server() {
  const r = await fetch('${P}/__studio/start', { method: 'POST' });
  const s = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(s.error || ('HTTP ' + r.status));
  for (;;) {
    const st = await fetch('${P}/__studio/status').then((x) => x.json());
    const sv = st.server || {};
    $('detail').textContent = sv.detail || '';
    if (st.conflict) throw new Error('Beta conflicts with the working copy: ' + st.conflict.files.join(', ') + '. See the status page.');
    if (sv.status === 'running') return;
    if (sv.status === 'failed') throw new Error(sv.detail || 'The dev server failed to start.');
    if (sv.status === 'stopped') await fetch('${P}/__studio/start', { method: 'POST' });
    await sleep(1500);
  }
}
(async () => {
  try {
    await Promise.all([worker(), server()]);
    $('state').textContent = 'Ready. Opening…';
    location.replace(target);
  } catch (e) {
    $('state').className = 'warn';
    $('state').textContent = String(e.message || e);
  }
})();
`);
}

function infoPage(p: Product) {
  const s = devStatus(p.id);
  let since: ReturnType<typeof sinceLive> | null = null;
  try {
    since = sinceLive(p.id);
  } catch {
    // No beta yet, or git trouble: the page still shows the rest.
  }
  const t = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : '—');
  const c = s.copy;
  return page(`${p.name} beta status`, `<h1>${esc(p.name)} on beta</h1>
<p class="mut"><a href="${P}/">Devtools</a> · <a href="/">Beta site</a> · <a href="${esc(p.live)}">Live</a></p>
${s.conflict ? `<div class="card warn"><b>Conflict with beta</b> (${esc(s.conflict.during)}, ${t(s.conflict.at)}): ${esc(s.conflict.files.join(', '))}<br>Auto-commit and the dev server are stopped. Ask Claude in Talk to retry or keep beta's version (studio_dev_resolve), or use Studio's dashboard.</div>` : ''}
<div class="card"><b>Dev server:</b> ${esc(s.server?.status ?? 'none')} ${s.server?.detail ? `<span class="mut">(${esc(s.server.detail)})</span>` : ''}<br>
<span class="mut">Last used ${t(s.server?.lastUsed)}${s.server?.idleStopAt ? ` · stops when idle at ${t(s.server.idleStopAt)}` : ''}</span></div>
<div class="card"><b>Working copy</b> ${c ? `(<code>${esc(c.head)}</code>)<br>${c.uncommitted} uncommitted file(s)${c.files.length ? `: <code>${esc(c.files.slice(0, 8).join(', '))}</code>` : ''} · ${c.unpushed} unpushed commit(s)` : '<span class="mut">not made yet (opening devtools makes it)</span>'}<br>
<span class="mut">Last commit: ${s.lastCommit ? `${esc(s.lastCommit.message)} (${t(s.lastCommit.at)})` : '—'} · last push to beta: ${t(s.lastPush?.at)}</span></div>
${since ? `<div class="card"><b>On beta, not live yet:</b> ${since.commits.length} commit(s)<ul>${since.commits.slice(0, 20).map((x) => `<li><code>${esc(x.sha)}</code> ${esc(x.title)} <span class="mut">(${esc(x.author)})</span></li>`).join('')}</ul></div>` : ''}
<p><button onclick="fetch('${P}/__studio/stop',{method:'POST'}).then(()=>location.reload())">Stop the dev server</button></p>`);
}

function unityPage(p: Product) {
  const u = unityInfo(p);
  const gen = GEN_URL.includes('127.0.0.1') ? 'https://gen.hawkesgen.com' : GEN_URL;
  return page(`${p.name}: Unity editor`, `<h1>${esc(p.name)} is a Unity game</h1>
<p>Its editor can't run on this server. Unity runs on the <b>build server</b> (a Windows machine on AWS that mirrors C:\\Projects
and builds every Unity product), and you can open it there over Remote Desktop.</p>
<div class="card"><b>Open the editor on the build server</b><ol>
<li>On your PC: <code>hawkesgen.cmd builder start</code> (if it's stopped) and <code>hawkesgen.cmd builder access</code> (lets your IP in).</li>
<li><code>hawkesgen.cmd builder rdp</code> writes the Remote Desktop file (<code>.rdp</code>); the password stays in a file next to it. Open the file.</li>
<li>Open <code>${esc(u.project)}</code> in Unity there. It's on the beta branch's source; commit to a branch and push it, never main.</li></ol>
<p class="warn">Cost: ${esc(u.cost)}. Builds use the same machine.</p>
<p class="mut">Status and controls: <a href="${esc(gen)}/#builder">Hawkes Gen → build server</a>.</p></div>
<div class="card"><b>What agents can do on beta instead</b><ul>
<li>Ask Claude in Talk for a change ("make the slimes slower"): an agent edits the source on a branch from beta, the build server builds it, it's playtested, and you approve it into beta.</li>
<li>Data edits (most of the game is JSON, e.g. Sick Of It's <code>Assets/GameConfig/</code>) go the same way and need no editor.</li>
<li>Rebuild and playtest beta: <code>studio.cmd beta ${esc(p.id)}</code> (or "Update &amp; playtest beta" on Today).</li>
<li>Unity tests on the build server: <code>studio_unity_test</code>.</li></ul></div>
<p class="mut"><a href="/">Beta site</a> · <a href="${esc(p.live)}">Live</a></p>`);
}

const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
};
const json = (res: http.ServerResponse, status: number, v: unknown) => send(res, status, 'application/json', JSON.stringify(v));
const isNav = (req: http.IncomingMessage) => req.headers['sec-fetch-mode'] === 'navigate' || (!req.headers['sec-fetch-mode'] && String(req.headers.accept ?? '').includes('text/html'));
const isPing = (req: http.IncomingMessage) => String(req.headers.accept ?? '').includes('text/x-vite-ping');

/** Headers for the dev server: its own host (Vite checks it), no compression (HTML gets the shim). */
function upstreamHeaders(req: http.IncomingMessage, port: number) {
  const h: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
  delete h['accept-encoding'];
  delete h.authorization; // Caddy's login; the dev server doesn't need it
  return h;
}

function proxy(p: Product, req: http.IncomingMessage, res: http.ServerResponse, rest: string, root = false) {
  const px = root ? '' : P;
  const port = devConf(p)!.port!;
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: rest, headers: upstreamHeaders(req, port) }, (ur) => {
    const headers = { ...ur.headers };
    const loc = headers.location;
    if (typeof loc === 'string') {
      if (loc.startsWith('/') && !loc.startsWith('//')) headers.location = px + loc;
      else if (/^https?:\/\/(127\.0\.0\.1|localhost):\d+\//.test(loc)) headers.location = px + loc.replace(/^https?:\/\/[^/]+/, '');
    }
    if (String(headers['content-type'] ?? '').includes('text/html')) {
      const chunks: Buffer[] = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        const tag = `<script src="${P}/__studio/shim.js${root ? '?root=1' : ''}"></script>`;
        const m = /<head[^>]*>/i.exec(html);
        html = m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
        delete headers['content-length'];
        delete headers.etag;
        res.writeHead(ur.statusCode ?? 200, { ...headers, 'cache-control': 'no-store' });
        res.end(html);
      });
      ur.on('error', () => res.destroy());
      return;
    }
    res.writeHead(ur.statusCode ?? 200, headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: `${p.name}'s dev server didn't answer: ${e.message}` });
    else res.destroy();
  });
  req.pipe(up);
}

/** The dev-<sub> host: the dev server at the root (no service worker). */
const isRoot = (req: http.IncomingMessage) => /^dev-/i.test(String(req.headers['x-forwarded-host'] ?? req.headers.host ?? ''));

async function handle(p: Product, req: http.IncomingMessage, res: http.ServerResponse) {
  const root = isRoot(req);
  if (root) {
    const u = req.url ?? '/';
    req.url = u.startsWith(`${P}/__studio/`) ? u : u.startsWith('/__studio/') ? P + u : P + u;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const route = url.pathname;
  const method = req.method ?? 'GET';
  const unity = isUnity(p) || !devConf(p)?.port;
  if (route === P) return send(res, 302, 'text/plain', '', { Location: `${P}/${url.search}` });
  // Only /dev/ (and HMR, handled on upgrade) comes here through Caddy. Locally, other paths are sent inside /dev/.
  if (!route.startsWith(`${P}/`)) {
    if (isPing(req) && !unity) return devRunning(p.id) ? proxy(p, req, res, req.url ?? '/') : send(res, 503, 'text/plain', 'stopped');
    return send(res, 302, 'text/plain', '', { Location: P + (req.url ?? '/') });
  }
  const rest = (req.url ?? '/').slice(P.length);
  if (route.startsWith(`${P}/__studio/`)) {
    const what = route.slice(`${P}/__studio/`.length);
    if (what === 'sw.js') return send(res, 200, 'text/javascript', SW, { 'Service-Worker-Allowed': `${P}/` });
    if (what === 'shim.js') return send(res, 200, 'text/javascript', SHIM);
    // J's "report a bug" button on the beta site (bugreport.ts; previews.ts puts the script into every page).
    if (what === 'report.js') return send(res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(WIDGET));
    if (what === 'report' && method === 'POST') return report(p, req, res);
    if (what === 'status') return json(res, 200, devStatus(p.id));
    if (what === 'info') return send(res, 200, 'text/html; charset=utf-8', unity ? unityPage(p) : infoPage(p));
    if (what === 'start' && method === 'POST') {
      if (unity) return json(res, 400, { error: `${p.name} is a Unity game: no dev server` });
      try {
        // Answers once the start is under way; the page polls status.
        const run = startDev(p.id, { by: 'the /dev/ page' });
        run.catch(() => {});
        return json(res, 200, { ok: true, status: devStatus(p.id).server });
      } catch (e: any) {
        return json(res, e.status ?? 500, { error: String(e.message ?? e) });
      }
    }
    if (what === 'stop' && method === 'POST') return json(res, 200, await stopDev(p.id, { why: 'stopped from the /dev/ page' }));
    if (what === 'start') return send(res, 200, 'text/html; charset=utf-8', unity ? unityPage(p) : startPage(p, url.searchParams.get('to') ?? '', root));
    return json(res, 404, { error: 'no such page' });
  }
  if (unity) return send(res, 200, 'text/html; charset=utf-8', unityPage(p));
  if (isPing(req)) return devRunning(p.id) ? proxy(p, req, res, rest, root) : send(res, 503, 'text/plain', 'stopped');
  // /dev/ itself is always the start page (it installs the worker and opens the devtools).
  if (route === `${P}/` && isNav(req) && !(root && devRunning(p.id))) return send(res, 200, 'text/html; charset=utf-8', startPage(p, url.searchParams.get('to') ?? '', root));
  if (!devRunning(p.id)) {
    if (isNav(req)) return send(res, 200, 'text/html; charset=utf-8', startPage(p, P + rest, root));
    return json(res, 503, { error: `${p.name}'s dev server isn't running (it stops after 30 idle minutes). Open ${P}/ to start it.` });
  }
  touchDev(p.id);
  proxy(p, req, res, rest, root);
}

/** POST /dev/__studio/report: J's report from a page of this product's beta site (JSON, same origin only). */
async function report(p: Product, req: http.IncomingMessage, res: http.ServerResponse) {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  const origin = req.headers.origin;
  const from = (() => { try { return origin ? new URL(origin).host : host; } catch { return ''; } })();
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || from !== host) return json(res, 403, { error: 'same-origin JSON only' });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 10 * 1024 * 1024) return json(res, 413, { error: 'too big' });
    chunks.push(c);
  }
  try {
    return json(res, 200, await fileReport(p.id, JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  } catch (e: any) {
    return json(res, e.status ?? 400, { error: String(e.message ?? e) });
  }
}

/** Vite's HMR websocket (and any other websocket under /dev/): piped to the dev server. */
function upgrade(p: Product, req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  const port = devConf(p)?.port;
  if (!port || !devRunning(p.id)) return socket.destroy();
  const rest = (req.url ?? '/').startsWith(`${P}/`) ? (req.url ?? '/').slice(P.length) : req.url ?? '/';
  const up = net.connect(port, '127.0.0.1', () => {
    const h = upstreamHeaders(req, port);
    const lines = [`${req.method} ${rest} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end);
  socket.on('error', end);
}

const fronts = new Map<string, http.Server>();
/** Starts every product's front door (127.0.0.1:<dev.front>). Returns the ports it listens on. */
export function startFronts(host = '127.0.0.1') {
  const out: Record<string, number> = {};
  for (const p of loadProducts()) {
    const front = devConf(p)?.front;
    if (!front || fronts.has(p.id)) continue;
    const s = http.createServer((req, res) => {
      handle(getProduct(p.id), req, res).catch((e) => { if (!res.headersSent) json(res, 500, { error: String(e.message ?? e) }); });
    });
    s.on('upgrade', (req, socket, head) => upgrade(getProduct(p.id), req, socket as net.Socket, head));
    s.on('error', (e: any) => console.warn(`[studio] /dev/ front door for ${p.id} on :${front}: ${e.message ?? e}`));
    s.listen(front, host);
    fronts.set(p.id, s);
    out[p.id] = front;
  }
  return out;
}

export function stopFronts() {
  for (const s of fronts.values()) s.close();
  fronts.clear();
}
