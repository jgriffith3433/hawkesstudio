// The Analytics tab's server side (dashboard/analytics.js): Hawkes Gen's player analytics (hawkesgen docs/analytics.md),
// asked server-side with Studio's Gen key, the way Studio reaches Gen for everything else. Only Gen's read routes and
// its filters go through (GET /api/analytics/... -> GET /v1/analytics/...); the overview gets a studio-wide total and
// says which products have no data yet (the SDK isn't on them). One write: J's "that was me" (POST
// /api/analytics/marks -> Gen's marks), so his own devices and private windows stop counting as players, and "not a
// person" for bots that got through.
//
// A customer's Studio (a cell, gen.ts): its Gen key answers only for its own org's games (Gen's canProject), which Gen
// knows as org_<hex>.<game>. So the game in the path gets that prefix on the way to Gen, comes back without it, and the
// overview lists every game of this Studio, the ones Gen has nothing on yet too. J's players list and marks stay J's
// (lockdown.ts); Gen refuses them to a cell's key anyway.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { gen } from './gen.ts';

/** Gen's per-product sections (GET /v1/analytics/:product/:section). */
export const SECTIONS = ['traffic', 'sessions', 'retention', 'segments', 'funnel', 'dropoff', 'levels', 'deaths', 'features', 'engagement', 'frustration', 'feedback', 'errors', 'perf', 'accounts', 'builds', 'insights', 'export'];
const RANGES = ['today', '24h', '7d', '14d', '30d', '90d', '180d', '365d'];
const ENVS = ['live', 'beta', 'preview', 'local'];
/** The params each route may pass on, besides the filters. */
const EXTRA: Record<string, string[]> = { funnel: ['steps', 'by'], builds: ['a', 'b'], list: ['limit', 'offset'], accounts: ['limit', 'offset'], players: ['limit', 'offset'], export: ['what', 'format', 'limit'] };

const PRODUCT = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
/** A site's account id (hawkesAnalytics.identify; hawkesgen.ai's usr_...). */
const USER = /^[A-Za-z0-9_-]{4,64}$/;
const TIME = /^(\d{4}-\d\d-\d\d(T[\d:.]+Z?)?|\d{10,13})$/;

/** A filter's value, or null when it isn't one Gen takes (dropped, never forwarded). */
function filterValue(k: string, v: string): string | null {
  v = v.trim();
  if (!v) return null;
  if (k === 'range') return RANGES.includes(v) ? v : null;
  if (k === 'from' || k === 'to') return TIME.test(v) ? v : null;
  if (k === 'env') return v === 'all' || v.split(',').every((e) => ENVS.includes(e.trim())) ? v : null;
  if (k === 'bots' || k === 'internal' || k === 'engaged') return v === '1' ? '1' : null;
  if (k === 'build' || k === 'device' || k === 'browser' || k === 'country') return v.length <= 120 ? v : null;
  if (k === 'user') return USER.test(v) ? v : null;
  if (k === 'steps') return v.length <= 2000 ? v : null;
  if (k === 'by') return v === 'session' || v === 'player' ? v : null;
  if (k === 'a' || k === 'b') return v.length <= 120 ? v : null;
  if (k === 'limit' || k === 'offset') return /^\d{1,6}$/.test(v) ? v : null;
  if (k === 'what') return v === 'events' || v === 'sessions' ? v : null;
  if (k === 'format') return v === 'csv' || v === 'json' ? v : null;
  return null;
}
const FILTERS = ['range', 'from', 'to', 'env', 'build', 'device', 'browser', 'country', 'user', 'bots', 'internal', 'engaged'];

/**
 * The Gen path (under /v1) for a Studio route, with only the filters and params that route takes; null when the route
 * isn't one of Gen's analytics read routes.
 */
export function genPath(route: string, params: URLSearchParams): string | null {
  if (!route.startsWith('/api/analytics/')) return null;
  const parts = route.slice('/api/analytics/'.length).split('/').filter(Boolean);
  let kind: string;
  const TOP = ['overview', 'products', 'players', 'marks'];
  if (parts.length === 1 && TOP.includes(parts[0])) kind = parts[0];
  else if (!PRODUCT.test(parts[0] ?? '') || TOP.includes(parts[0])) return null;
  else if (parts.length === 1) kind = 'all';
  else if (parts.length === 2 && SECTIONS.includes(parts[1])) kind = parts[1];
  else if (parts.length === 3 && parts[1] === 'sessions' && parts[2] === 'list') kind = 'list';
  else if (parts.length === 3 && parts[1] === 'sessions' && SESSION.test(parts[2])) kind = 'session';
  else if (parts.length === 3 && parts[1] === 'accounts' && USER.test(parts[2])) kind = 'account';
  else return null;
  const out = new URLSearchParams();
  if (kind !== 'products' && kind !== 'session' && kind !== 'marks') {
    for (const k of [...FILTERS, ...(EXTRA[kind] ?? [])]) {
      const v = params.get(k);
      const ok = v == null ? null : filterValue(k, v);
      if (ok != null) out.set(k, ok);
    }
  }
  const qs = out.toString();
  return `/analytics/${parts.join('/')}${qs ? `?${qs}` : ''}`;
}

/** A customer's cell: how Gen names its games (org_<hex>.); '' in J's Studio (gen.ts HAWKESGEN_PROJECT_PREFIX). */
export const orgPrefix = () => process.env.HAWKESGEN_PROJECT_PREFIX?.trim() || '';
const TOP_ROUTES = ['overview', 'products', 'players', 'marks'];

/** A Gen path with the game named the way Gen knows it in a customer's cell (prefix + game); as is in J's Studio. */
export function orgPath(path: string, prefix = orgPrefix()): string {
  if (!prefix) return path;
  const m = /^\/analytics\/([^/?]+)(.*)$/.exec(path);
  if (!m || TOP_ROUTES.includes(m[1]) || m[1].startsWith(prefix)) return path;
  return `/analytics/${encodeURIComponent(prefix + m[1])}${m[2]}`;
}

/**
 * Gen's answer as this Studio shows it, in a customer's cell: only the org's own games (Gen already scopes them; this is
 * belt and braces), named without the prefix, and the overview with every game of this Studio (own), the ones Gen has
 * nothing on yet as "no players on record". As is in J's Studio.
 */
export function orgView(path: string, body: any, prefix = orgPrefix(), own: { id: string; name: string }[] = []): any {
  if (!prefix || !body || typeof body !== 'object') return body;
  const strip = (id: unknown) => (typeof id === 'string' && id.startsWith(prefix) ? id.slice(prefix.length) : null);
  const base = path.split('?')[0];
  if (base === '/analytics/overview') {
    const mine = (Array.isArray(body.products) ? body.products : []).flatMap((p: any) => {
      const id = strip(p?.product);
      return id ? [{ ...p, product: id, name: own.find((g) => g.id === id)?.name ?? (p.name === p.product ? id : p.name) }] : [];
    });
    for (const g of own) if (!mine.some((p: any) => p.product === g.id)) mine.push({ product: g.id, name: g.name, daily: [] });
    return { ...body, products: mine };
  }
  if (base === '/analytics/products') {
    return { ...body, products: (Array.isArray(body.products) ? body.products : []).flatMap((p: any) => { const id = strip(p?.id); return id ? [{ ...p, id }] : []; }) };
  }
  return typeof body.product === 'string' ? { ...body, product: strip(body.product) ?? body.product } : body;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const trend = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 1000 : null);

/** Whether Gen has seen anything from a product (this month or the one before, or right now). */
export const hasData = (p: any) => Boolean(p?.activeNow || p?.['30d']?.sessions || p?.['30d']?.previous?.sessions);

/**
 * Gen's overview with what the page shows on top: hasData per product (none: the SDK isn't on it yet) and a studio-wide
 * total (active now, visitors and sessions today / 7d / 30d with their trend, the daily series). Visitors are added up
 * across games: one player of two games counts twice.
 */
export function withTotals(o: any) {
  const products = (Array.isArray(o?.products) ? o.products : []).map((p: any) => ({ ...p, hasData: hasData(p) }));
  const total: any = { activeNow: sum(products.map((p: any) => p.activeNow)), withData: products.filter((p: any) => p.hasData).length, products: products.length };
  for (const k of ['today', '7d', '30d']) {
    const of = (f: (x: any) => number) => sum(products.map((p: any) => f(p[k] ?? {})));
    const cur = { sessions: of((x) => x.sessions), visitors: of((x) => x.visitors) };
    const previous = { sessions: of((x) => x.previous?.sessions), visitors: of((x) => x.previous?.visitors) };
    total[k] = { ...cur, previous, trend: { sessions: trend(cur.sessions, previous.sessions), visitors: trend(cur.visitors, previous.visitors) } };
  }
  const days = new Map<string, { day: string; sessions: number; visitors: number }>();
  for (const p of products) {
    for (const d of p.daily ?? []) {
      const x = days.get(d.day) ?? { day: d.day, sessions: 0, visitors: 0 };
      x.sessions += Number(d.sessions) || 0;
      x.visitors += Number(d.visitors) || 0;
      days.set(d.day, x);
    }
  }
  total.daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  return { ...o, products, total };
}

type Request = (path: string, opts?: { method?: string; body?: unknown }) => Promise<any>;
type Send = (res: ServerResponse, status: number, body: unknown) => void;

const MARK_VALUE = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * GET /api/analytics/...: Gen's answer (CSV exports streamed through as a download). POST /api/analytics/marks
 * {kind: net | anon, value, what: me | bot, on, note}: J's "that was me" or "not a person", or taking it back (on:
 * false; the older me: false too). Admins only: auth.ts memberRefusal. request: Gen (tests pass their own); readBody:
 * the JSON body.
 */
export async function handleAnalyticsApi(req: IncomingMessage, res: ServerResponse, url: URL, send: Send, request: Request = (p, o) => gen.request(p, o), readBody: (req: IncomingMessage) => Promise<any> = async () => ({})) {
  if ((req.method ?? 'GET') === 'POST' && url.pathname === '/api/analytics/marks') {
    const b = await readBody(req);
    if ((b?.kind !== 'net' && b?.kind !== 'anon') || !MARK_VALUE.test(String(b?.value ?? ''))) return send(res, 400, { error: 'kind (net | anon) and value are required' });
    const body = { kind: b.kind, value: String(b.value), what: b.what === 'bot' ? 'bot' : 'me', on: b.on !== false && b.me !== false, ...(typeof b.note === 'string' ? { note: b.note.slice(0, 200) } : {}) };
    try {
      return send(res, 200, await request('/analytics/marks', { method: 'POST', body }));
    } catch (e: any) {
      return send(res, Number(e?.status) || 502, { error: String(e?.message ?? e) });
    }
  }
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'Analytics is read-only (GET), besides POST /api/analytics/marks' });
  const plain = genPath(url.pathname, url.searchParams);
  if (!plain) return send(res, 404, { error: `No analytics route ${url.pathname}` });
  const prefix = orgPrefix();
  const path = orgPath(plain, prefix);
  if (/\/export\?/.test(path) && /[?&]format=csv/.test(path)) return (await import('./library.ts')).relay(req, res, path.slice(1));
  // A customer's games (their names for the overview, and which games are theirs).
  let own: { id: string; name: string }[] = [];
  if (prefix) { try { own = (await import('./config.ts')).loadProducts().map((p) => ({ id: p.id, name: p.name })); } catch { /* no games yet */ } }
  try {
    const body = orgView(plain, await request(path), prefix, own);
    return send(res, 200, path.startsWith('/analytics/overview') ? withTotals(body) : body);
  } catch (e: any) {
    // A customer's game Gen has no analytics on yet: nothing on record, not an error (the page says the SDK isn't on it).
    const game = plain.split(/[/?]/)[2];
    if (prefix && Number(e?.status) === 404 && own.some((g) => g.id === game) && /No analytics product/.test(String(e?.message ?? ''))) {
      return send(res, 200, { product: game, onRecord: false });
    }
    // Gen down or out of reach: the page says so (and keeps what it showed); Gen's own refusals keep their status.
    const offline = e?.kind === 'offline' || e?.status === 0;
    return send(res, offline ? 502 : Number(e?.status) || 502, { error: offline ? `Hawkes Gen isn't answering: ${e.message}` : String(e?.message ?? e), offline });
  }
}
