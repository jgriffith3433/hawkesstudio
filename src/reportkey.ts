// 🐞 reports from any project's pages (J, 2026-10-30: a customer points Talk at their web app's repos and "it can start
// taking in the bug reports"). A project gets a report key; its pages load one script,
//   <script src="<this Studio>/r/<project>.js?k=<key>" defer></script>
// which is Studio's widget (dashboard/report-widget.js: the screenshot, the console, the page's own context from
// window.hawkesReportContext), posting straight to this Studio: POST /r/<project>/report and /error with the key. No
// Studio sign-in is needed, so it works on any domain; what lets a report in is the key and the page's origin, which
// must be one of the project's (its beta's and its reportOrigins; live's only when listed). Reports are rate limited.
// Beta sites Studio publishes itself keep their own button (bugreport.ts injectReport).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { DATA, getProduct, StudioError, type Product } from './config.ts';
import { WIDGET, fileReport, fileAutoError } from './bugreport.ts';
import { siteOrg } from './sitekeys.ts';

const KEY_FILE = () => path.join(DATA, 'report.key');
let secret: Buffer | null = null;
function master() {
  if (secret) return secret;
  try { secret = Buffer.from(fs.readFileSync(KEY_FILE(), 'utf8').trim(), 'hex'); } catch { /* made below */ }
  if (!secret || secret.length < 32) {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(KEY_FILE(), secret.toString('hex'), { mode: 0o600 });
  }
  return secret;
}
/** Tests: forget the cached secret. */
export const resetReportKeys = () => { secret = null; };

/** A project's report key (stable: derived from this Studio's secret and the project id). */
export const reportKey = (project: string) => `rk_${crypto.createHmac('sha256', master()).update(`report:${project}`).digest('base64url').slice(0, 32)}`;

function keyOk(project: string, key: string | null) {
  if (!key) return false;
  const a = Buffer.from(reportKey(project)), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** This Studio's public address (a customer's Studio: with its /o/<org>). */
const base = (req?: http.IncomingMessage) =>
  (process.env.STUDIO_PUBLIC_URL || (req?.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : `http://${req?.headers.host ?? '127.0.0.1:8791'}`)).replace(/\/+$/, '');

/** The sites whose pages may report for a project: its beta, and what it lists (live only when listed). */
export function originsOf(p: Product) {
  const out = new Set<string>();
  try { if (p.beta) out.add(new URL(p.beta).origin); } catch { /* not a URL */ }
  // A customer's Studio hosts its projects' betas on the shared sites host (previews.ts: /o/<org>/<project>/).
  if (!p.beta && siteOrg()) out.add(`https://sites.${process.env.STUDIO_DOMAIN || 'hawkesgen.ai'}`);
  for (const o of p.reportOrigins ?? []) out.add(o.replace(/\/+$/, ''));
  return [...out];
}

/** What a project's page needs: the script line, the key, and where reports are taken from. */
export function reportInfo(projectId: string, req?: http.IncomingMessage) {
  const p = getProduct(projectId);
  const key = reportKey(p.id);
  const b = base(req);
  const script = `${b}/r/${p.id}.js?k=${key}`;
  // widget, endpoint, errors: what the loader script sets up, for pages Studio publishes itself (previews-cloud.ts).
  return { project: p.id, key, script, tag: `<script src="${script}" defer></script>`, origins: originsOf(p), widget: `${b}/r/widget.js`, endpoint: `${b}/r/${p.id}/report?k=${key}`, errors: `${b}/r/${p.id}/error?k=${key}` };
}

const cors = (origin: string) => ({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

/** Open routes (cloudauth.ts openRoute): /r/widget.js, /r/<project>.js, /r/<project>/report|error. true when answered. */
export async function handleReportRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  if (!route.startsWith('/r/')) return false;
  const method = req.method ?? 'GET';
  if (route === '/r/widget.js' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
    res.end(fs.readFileSync(WIDGET));
    return true;
  }
  const m = /^\/r\/([a-z][a-z0-9-]{1,39})(?:\.js|\/(report|error))$/.exec(route);
  if (!m) return false;
  let p: Product;
  try { p = getProduct(m[1]); } catch { json(res, 404, { error: 'No such project' }); return true; }
  const key = url.searchParams.get('k');
  if (!keyOk(p.id, key)) { json(res, 403, { error: 'Wrong report key' }); return true; }
  // The script: loads the widget with this project's endpoints (the widget reads its data-hawkes).
  if (!m[2] && method === 'GET') {
    const b = base(req);
    const cfg = { product: p.id, ref: 'beta', endpoint: `${b}/r/${p.id}/report?k=${key}`, errors: `${b}/r/${p.id}/error?k=${key}` };
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
    res.end(`(function(){if(window.__hawkesReport)return;var s=document.createElement('script');s.src=${JSON.stringify(`${b}/r/widget.js`)};s.defer=true;s.setAttribute('data-hawkes',${JSON.stringify(JSON.stringify(cfg))});(document.body||document.head).appendChild(s)})();`);
    return true;
  }
  const origin = String(req.headers.origin ?? '');
  const allowed = originsOf(p);
  if (!allowed.includes(origin)) { json(res, 403, { error: `Reports for ${p.name} come from ${allowed.join(', ') || 'its beta (none set)'}` }); return true; }
  if (method === 'OPTIONS') { res.writeHead(204, cors(origin)); res.end(); return true; }
  if (method !== 'POST') { json(res, 405, { error: 'POST' }, cors(origin)); return true; }
  if (!limit(String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim(), m[2]!)) { json(res, 429, { error: 'Too many reports from here; try again in a minute' }, cors(origin)); return true; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > (m[2] === 'error' ? 4 : 10) * 1024 * 1024) { json(res, 413, { error: 'too big' }, cors(origin)); return true; }
    chunks.push(c as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';
    json(res, 200, m[2] === 'error' ? await fileAutoError(p.id, body, ip) : await fileReport(p.id, body), cors(origin));
  } catch (e: any) {
    json(res, e instanceof StudioError ? e.status : 400, { error: String(e.message ?? e) }, cors(origin));
  }
  return true;
}

// At most 10 reports and 30 errors a minute from one address (a page can't flood a project's backlog).
const hits = new Map<string, number[]>();
function limit(ip: string, kind: string) {
  const k = `${kind}:${ip}`, now = Date.now();
  const list = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= (kind === 'error' ? 30 : 10)) return false;
  list.push(now);
  hits.set(k, list);
  return true;
}
