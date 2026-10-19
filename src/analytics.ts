// The Analytics tab's server side (dashboard/analytics.js): Hawkes Gen's player analytics (hawkesgen docs/analytics.md),
// asked server-side with Studio's Gen key, the way Studio reaches Gen for everything else. Only Gen's read routes and
// its filters go through (GET /api/analytics/... -> GET /v1/analytics/...); the overview gets a studio-wide total and
// says which products have no data yet (the SDK isn't on them).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { gen } from './gen.ts';

/** Gen's per-product sections (GET /v1/analytics/:product/:section). */
export const SECTIONS = ['traffic', 'sessions', 'retention', 'funnel', 'dropoff', 'levels', 'deaths', 'features', 'feedback', 'errors', 'perf', 'builds', 'insights', 'export'];
const RANGES = ['today', '24h', '7d', '14d', '30d', '90d', '180d', '365d'];
const ENVS = ['live', 'beta', 'preview', 'local'];
/** The params each route may pass on, besides the filters. */
const EXTRA: Record<string, string[]> = { funnel: ['steps', 'by'], builds: ['a', 'b'], list: ['limit', 'offset'], export: ['what', 'format', 'limit'] };

const PRODUCT = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const TIME = /^(\d{4}-\d\d-\d\d(T[\d:.]+Z?)?|\d{10,13})$/;

/** A filter's value, or null when it isn't one Gen takes (dropped, never forwarded). */
function filterValue(k: string, v: string): string | null {
  v = v.trim();
  if (!v) return null;
  if (k === 'range') return RANGES.includes(v) ? v : null;
  if (k === 'from' || k === 'to') return TIME.test(v) ? v : null;
  if (k === 'env') return v === 'all' || v.split(',').every((e) => ENVS.includes(e.trim())) ? v : null;
  if (k === 'bots' || k === 'internal') return v === '1' ? '1' : null;
  if (k === 'build' || k === 'device' || k === 'browser' || k === 'country') return v.length <= 120 ? v : null;
  if (k === 'steps') return v.length <= 2000 ? v : null;
  if (k === 'by') return v === 'session' || v === 'player' ? v : null;
  if (k === 'a' || k === 'b') return v.length <= 120 ? v : null;
  if (k === 'limit' || k === 'offset') return /^\d{1,6}$/.test(v) ? v : null;
  if (k === 'what') return v === 'events' || v === 'sessions' ? v : null;
  if (k === 'format') return v === 'csv' || v === 'json' ? v : null;
  return null;
}
const FILTERS = ['range', 'from', 'to', 'env', 'build', 'device', 'browser', 'country', 'bots', 'internal'];

/**
 * The Gen path (under /v1) for a Studio route, with only the filters and params that route takes; null when the route
 * isn't one of Gen's analytics read routes.
 */
export function genPath(route: string, params: URLSearchParams): string | null {
  if (!route.startsWith('/api/analytics/')) return null;
  const parts = route.slice('/api/analytics/'.length).split('/').filter(Boolean);
  let kind: string;
  if (parts.length === 1 && (parts[0] === 'overview' || parts[0] === 'products')) kind = parts[0];
  else if (!PRODUCT.test(parts[0] ?? '') || parts[0] === 'overview' || parts[0] === 'products') return null;
  else if (parts.length === 1) kind = 'all';
  else if (parts.length === 2 && SECTIONS.includes(parts[1])) kind = parts[1];
  else if (parts.length === 3 && parts[1] === 'sessions' && parts[2] === 'list') kind = 'list';
  else if (parts.length === 3 && parts[1] === 'sessions' && SESSION.test(parts[2])) kind = 'session';
  else return null;
  const out = new URLSearchParams();
  if (kind !== 'products' && kind !== 'session') {
    for (const k of [...FILTERS, ...(EXTRA[kind] ?? [])]) {
      const v = params.get(k);
      const ok = v == null ? null : filterValue(k, v);
      if (ok != null) out.set(k, ok);
    }
  }
  const qs = out.toString();
  return `/analytics/${parts.join('/')}${qs ? `?${qs}` : ''}`;
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

type Request = (path: string) => Promise<any>;
type Send = (res: ServerResponse, status: number, body: unknown) => void;

/** GET /api/analytics/...: Gen's answer (CSV exports streamed through as a download). request: Gen (tests pass their own). */
export async function handleAnalyticsApi(req: IncomingMessage, res: ServerResponse, url: URL, send: Send, request: Request = (p) => gen.request(p)) {
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'Analytics is read-only (GET)' });
  const path = genPath(url.pathname, url.searchParams);
  if (!path) return send(res, 404, { error: `No analytics route ${url.pathname}` });
  if (/\/export\?/.test(path) && /[?&]format=csv/.test(path)) return (await import('./library.ts')).relay(req, res, path.slice(1));
  try {
    const body = await request(path);
    return send(res, 200, path.startsWith('/analytics/overview') ? withTotals(body) : body);
  } catch (e: any) {
    // Gen down or out of reach: the page says so (and keeps what it showed); Gen's own refusals keep their status.
    const offline = e?.kind === 'offline' || e?.status === 0;
    return send(res, offline ? 502 : Number(e?.status) || 502, { error: offline ? `Hawkes Gen isn't answering: ${e.message}` : String(e?.message ?? e), offline });
  }
}
