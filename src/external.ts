// External targets for the Resources tab's sampler (resources.ts): the portal's health every minute (status and time),
// its admin details when Studio has a key, and each Hawkes Net relay node's health (the list from the Hawkes Net service's
// GET /v1/net/nodes, https://net.hawkesgen.ai: its own box since 2026-10-25). Alerts are incidents: one phone note when
// one opens, one recovery note when it closes.
//
// The portal admin key is a portal API key for an admin account, given to Studio through the usual secrets path as the
// environment variable HAWKES_PORTAL_ADMIN_KEY. Without it the details are skipped, quietly. Before Gen has
// /v1/net/nodes the node list is empty, also quietly.

import type { ResourceSettings } from './resources.ts';

export const PORTAL_URL = () => (process.env.HAWKES_PORTAL_URL || 'https://hawkesgen.ai').replace(/\/+$/, '');
const TIMEOUT_MS = 8_000;
const KEEP = 240; // probes kept per target (4 hours at one a minute)

export type Probe = { at: number; ok: boolean; status: number | null; ms: number; error?: string };
export type NodeState = { id: string; url: string; players: number | null; capacity: number | null; last: Probe };
export type PortalDetails = { p99ms: number | null; sockets: number | null; cap: number | null; lastBackup: number | null };
export type External = {
  at: number;
  portal: { url: string; last: Probe | null; failingSince: number | null; history: Probe[] };
  details: { state: 'skipped' | 'ok' | 'failed'; note?: string; at: number | null; data: PortalDetails | null };
  nodes: { state: 'skipped' | 'ok' | 'failed'; note?: string; list: NodeState[] };
};

const ext: External = {
  at: 0, portal: { url: '', last: null, failingSince: null, history: [] },
  details: { state: 'skipped', note: 'no portal admin key yet', at: null, data: null }, nodes: { state: 'skipped', list: [] },
};
export const externalState = () => ext;
export function resetExternal() {
  Object.assign(ext, { at: 0, portal: { url: '', last: null, failingSince: null, history: [] }, details: { state: 'skipped', note: 'no portal admin key yet', at: null, data: null }, nodes: { state: 'skipped', list: [] } });
  open.clear();
}

async function get(url: string, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const at = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    const body = await r.text().catch(() => '');
    return { probe: { at, ok: r.status >= 200 && r.status < 300, status: r.status, ms: Math.round(performance.now() - t0) } as Probe, body };
  } catch (e: any) {
    return { probe: { at, ok: false, status: null, ms: Math.round(performance.now() - t0), error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) } as Probe, body: '' };
  }
}

const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const when = (v: any) => {
  if (v && typeof v === 'object') v = v.at ?? v.finishedAt ?? v.time;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The numbers Studio needs from the portal's /v1/health/details, wherever in the document they sit (pure: tested). */
export function readDetails(d: any): PortalDetails {
  const loop = d?.eventLoop ?? d?.event_loop ?? d?.loop ?? {};
  const sock = d?.sockets ?? d?.ws ?? d?.websockets ?? {};
  return {
    p99ms: num(loop.p99ms ?? loop.p99 ?? d?.eventLoopP99),
    sockets: num(sock.game ?? sock.open ?? sock.connections ?? d?.gameSockets ?? d?.wsConnections),
    cap: num(sock.cap ?? sock.max ?? sock.limit ?? d?.wsCap ?? d?.maxWsConnections),
    lastBackup: when(d?.lastBackup ?? d?.backup?.last ?? d?.backup?.at ?? d?.backup),
  };
}

export type ProbeOptions = { portalUrl?: string; adminKey?: string; nodes?: () => Promise<any[]> };

export const NET_URL = () => (process.env.HAWKES_NET_URL || 'https://net.hawkesgen.ai').replace(/\/+$/, '');
async function nodeList(): Promise<any[]> {
  const r = await fetch(`${NET_URL()}/v1/net/nodes`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Hawkes Net answered ${r.status}`);
  const j: any = await r.json();
  return (Array.isArray(j) ? j : j?.nodes ?? []) as any[];
}
/** Where a node's health is: a node's own address (wss://host/v1/net/ws) answers /healthz at https://host; a test row's
 *  path or healthUrl answers /health. */
export function healthOf(r: any, base: string): string {
  const u = String(r.healthUrl ?? r.url ?? r.origin ?? (r.path ? `${base}${r.path}` : ''));
  const ws = /^wss?:\/\/([^/]+)/i.exec(u);
  if (ws) return `${u.toLowerCase().startsWith('wss:') ? 'https' : 'http'}://${ws[1]}/healthz`;
  return u ? `${u.replace(/\/+$/, '').replace(/\/health$/, '')}/health` : '';
}

/** One round: the portal, its details and the relay nodes. Never throws. */
export async function probeExternal(o: ProbeOptions = {}, now = Date.now()) {
  const base = (o.portalUrl ?? PORTAL_URL()).replace(/\/+$/, '');
  const key = o.adminKey ?? process.env.HAWKES_PORTAL_ADMIN_KEY ?? '';
  const [h, d, n] = await Promise.all([
    get(`${base}/v1/health`),
    key ? get(`${base}/v1/health/details`, { Authorization: `Bearer ${key}` }) : null,
    (async () => {
      try { return { list: await (o.nodes ?? nodeList)() }; } catch (e: any) { return { error: String(e?.message ?? e) }; }
    })(),
  ]);
  ext.at = now;
  ext.portal.url = base;
  ext.portal.last = h.probe;
  ext.portal.history = [...ext.portal.history, h.probe].slice(-KEEP);
  ext.portal.failingSince = h.probe.ok ? null : ext.portal.failingSince ?? h.probe.at;

  if (!d) ext.details = { state: 'skipped', note: 'no portal admin key yet', at: null, data: null };
  else if (!d.probe.ok) ext.details = { state: 'failed', note: d.probe.status ? `HTTP ${d.probe.status}` : d.probe.error, at: d.probe.at, data: ext.details.data };
  else {
    let json: any = null;
    try { json = JSON.parse(d.body); } catch { /* not JSON */ }
    ext.details = json ? { state: 'ok', at: d.probe.at, data: readDetails(json) } : { state: 'failed', note: 'not JSON', at: d.probe.at, data: null };
  }

  if ('error' in n) {
    // Before Gen has the route (404) or while it is down: quiet, nothing to show.
    ext.nodes = { state: /\b404\b|not found/i.test(n.error!) ? 'skipped' : 'failed', note: n.error!.slice(0, 120), list: [] };
  } else {
    const list: NodeState[] = [];
    await Promise.all((n.list ?? []).map(async (r: any) => {
      const id = String(r.id ?? r.path ?? '');
      const url = healthOf(r, base);
      if (!id || !url || r.status === 'draining') return; // a draining node is leaving on purpose
      const p = (await get(url)).probe;
      list.push({ id, url, players: num(r.players), capacity: num(r.capacity), last: p });
    }));
    ext.nodes = { state: 'ok', list: list.sort((a, b) => a.id.localeCompare(b.id)) };
  }
  return ext;
}

// ------------------------------------------------------------- incidents

export type Incident = { key: string; title: string; message: string };

/** Event-loop p99 readings, one per 30 s sample (resources.ts adds them). */
const loopSeries: { at: number; v: number }[] = [];
export function addLoopReading(v: number | null, at = Date.now()) {
  if (v == null) return;
  loopSeries.push({ at, v });
  while (loopSeries.length && loopSeries[0].at < at - 30 * 60_000) loopSeries.shift();
}
export const clearLoopReadings = () => { loopSeries.length = 0; };

/** Every reading over the limit for the whole window (the series must reach back across it). Pure over its inputs. */
export function loopSlow(series: { at: number; v: number }[], limitMs: number, minutes: number, now = Date.now()) {
  const inWindow = series.filter((r) => r.at >= now - minutes * 60_000);
  return series.length > 0 && series[0].at <= now - (minutes * 60_000 - 45_000) && inWindow.length >= 2 && inWindow.every((r) => r.v > limitMs);
}

const fmtAgo = (ms: number) => (ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1)} h`);

/** What is wrong with the external targets now (pure over the state: tested). */
export function externalIncidents(s: ResourceSettings, e: External = ext, series = loopSeries, now = Date.now()): Incident[] {
  const out: Incident[] = [];
  const fs = e.portal.failingSince;
  if (fs != null && now - fs >= s.portalMinutes * 60_000 - 5_000) {
    const l = e.portal.last;
    out.push({ key: 'portal', title: 'The portal is not answering', message: `hawkesgen.ai/v1/health has failed for ${fmtAgo(now - fs)} (${l?.status ? `HTTP ${l.status}` : l?.error ?? 'no answer'}).` });
  }
  if (e.details.state === 'ok' && e.details.data) {
    const d = e.details.data;
    if (loopSlow(series, s.loopP99Ms, s.loopMinutes, now)) out.push({ key: 'portal-loop', title: 'The portal is slow', message: `Its event-loop delay p99 has been over ${s.loopP99Ms} ms for ${s.loopMinutes} minutes (now ${Math.round(d.p99ms ?? series.at(-1)?.v ?? 0)} ms).` });
    if (d.sockets != null && d.cap && (100 * d.sockets) / d.cap > s.wsPct) out.push({ key: 'portal-ws', title: 'The portal is nearly full of WebSockets', message: `${d.sockets} of ${d.cap} game connections (${Math.round((100 * d.sockets) / d.cap)}%, alert past ${s.wsPct}%).` });
    if (d.lastBackup != null && now - d.lastBackup > s.backupHours * 3600_000) out.push({ key: 'portal-backup', title: 'The portal backup is old', message: `The last backup was ${fmtAgo(now - d.lastBackup)} ago (alert past ${s.backupHours} h).` });
  }
  for (const n of e.nodes.list) if (!n.last.ok) out.push({ key: `node:${n.id}`, title: `Relay node ${n.id} is down`, message: `${n.url} ${n.last.status ? `answered HTTP ${n.last.status}` : `didn't answer (${n.last.error ?? 'no answer'})`}${n.players ? `; it had ${n.players} players` : ''}.` });
  return out;
}

const open = new Map<string, { since: number; title: string }>();
/** Opens and closes incidents: the new ones to announce, the gone ones for a recovery note. Pure over `open`. */
export function reconcile(active: Incident[], now = Date.now()) {
  const keys = new Set(active.map((i) => i.key));
  const opened = active.filter((i) => !open.has(i.key));
  const closed = [...open].filter(([k]) => !keys.has(k)).map(([key, v]) => ({ key, since: v.since, title: v.title }));
  for (const i of opened) open.set(i.key, { since: now, title: i.title });
  for (const c of closed) open.delete(c.key);
  return { opened, closed };
}
export const openIncidents = () => [...open].map(([key, v]) => ({ key, ...v }));
