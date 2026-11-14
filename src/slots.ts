// Studio's request slots (2026-11-14: J's pages got Cloud Run's "no available instance" 503 from 06:50 to 07:17Z).
//
// A Studio is one Cloud Run instance that takes at most SLOTS requests at a time (cellrun.ts maxInstanceRequestConcurrency).
// Once SLOTS requests are open, Cloud Run holds the next ones in front of Studio and then turns them away: a page load,
// an agent's call and an event stream all look alike to it. Most of Studio's requests last milliseconds, but some stay
// open by design: the dashboard's event streams (stream.ts, feeds.ts, Talk's events), MCP tool calls answered as a
// stream (mcp-core.ts), and waits (Talk's ?wait, guide). Nothing bounded those: a stream stayed open until its page went
// away, and when Cloud Run never passed the page's going away on, until the 3600 s request timeout; every open tab, every
// reconnect and every phone that slept with Studio open took a slot for up to an hour. Enough of them and nothing else
// gets in.
//
// So the requests that stay open are held to a share of the slots, and the rest are always free for everything else:
// - HELD_MAX: at most this many held requests at once. A new stream over it ends the oldest stream (its page reconnects
//   by itself: `retry:`), so a new page always gets its stream and an old, likely abandoned one makes room.
// - STREAM_MAX_MS: a stream ends itself after this long; its page reconnects at once. A connection whose page left
//   without Cloud Run saying so is gone within this, not an hour (the 25 s pings only find a socket that is really shut).
// - One stream per tab: a page sends its tab's id (?tab=, dashboard/stream.js) and a new stream from that tab ends the
//   tab's old one, so a reload or a reconnect replaces its stream instead of adding another.
// Calls and waits that end on their own (MCP tool calls, Talk's ?wait, guide) count as held but are never cut.
//
// No timers besides each stream's own end: the ledger changes as requests open and close.

import type http from 'node:http';

/** Cloud Run's request concurrency for a Studio (cellrun.ts cellService maxInstanceRequestConcurrency). */
export const SLOTS = 80;
/** Held requests at most: the other half of the slots are always free for page loads and API calls. */
export const HELD_MAX = 40;
/** How long one event stream lasts before it ends itself (its page reconnects at once). */
export const STREAM_MAX_MS = 10 * 60_000;
/** Open requests at which Studio logs what holds them (once, until it drops back to half). */
export const CROWDED = 60;

export type HeldKind = 'stream' | 'mcp' | 'wait';
type Entry = { route: string; at: number; kind: HeldKind | null; end: (() => void) | null; timer: NodeJS.Timeout | null; key: string | null };

const open = new Set<Entry>();
const byRes = new WeakMap<http.ServerResponse, Entry>();
let peak = 0;
let peakAt = 0;
let ended = { cap: 0, age: 0, replaced: 0 };
let crowdedLogged = false;
let log: (line: string) => void = (l) => console.log(l);
/** Tests: where the crowded line goes. */
export const setSlotLog = (fn: (line: string) => void) => void (log = fn);

const heldCount = () => { let n = 0; for (const e of open) if (e.kind) n++; return n; };

/** Every request Studio answers (server.ts, first thing): counted until its response closes. */
export function track(req: http.IncomingMessage, res: http.ServerResponse, route: string, now = Date.now()) {
  const e: Entry = { route, at: now, kind: null, end: null, timer: null, key: null };
  open.add(e);
  byRes.set(res, e);
  if (open.size > peak) { peak = open.size; peakAt = now; }
  if (open.size >= CROWDED && !crowdedLogged) {
    crowdedLogged = true;
    log(`[slots] ${open.size} of ${SLOTS} requests open (${heldCount()} held): ${summary().top.map((t) => `${t.route} ${t.n}`).join(', ')}`);
  }
  const done = () => {
    if (!open.delete(e)) return;
    if (e.timer) clearTimeout(e.timer);
    if (open.size <= SLOTS / 2) crowdedLogged = false;
  };
  res.on('close', done);
  res.on('finish', done);
  return e;
}

/**
 * This response stays open (a stream, a streamed tool call, a wait). `end` closes it early (streams only: its page
 * reconnects); without `end` it is counted but never cut. Over HELD_MAX, the oldest cuttable one ends to make room.
 * `key` (a stream's route and its tab): an older open stream with the same key ends, one stream per tab.
 */
export function hold(res: http.ServerResponse, kind: HeldKind, end?: () => void, key?: string | null, now = Date.now()) {
  let e = byRes.get(res);
  if (!e) { // not tracked (a test calling a handler directly): track it now
    e = track({} as http.IncomingMessage, res, '(direct)', now);
  }
  e.kind = kind;
  e.end = end ?? null;
  e.key = end && key ? key : null;
  if (e.key) for (const x of open) if (x !== e && x.key === e.key && x.end) { ended.replaced++; cut(x); }
  if (e.end) {
    const ent = e;
    ent.timer = setTimeout(() => { ended.age++; cut(ent); }, STREAM_MAX_MS);
    ent.timer.unref?.();
  }
  while (heldCount() > HELD_MAX) {
    let oldest: Entry | null = null;
    for (const x of open) if (x.kind && x.end && x !== e && (!oldest || x.at < oldest.at)) oldest = x;
    if (!oldest) break; // only calls that end on their own: nothing to cut
    ended.cap++;
    cut(oldest);
  }
}

function cut(e: Entry) {
  const end = e.end;
  e.end = null;
  e.kind = null; // no longer held, even before the close arrives
  e.key = null;
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  try { end?.(); } catch { /* already closed */ }
}

/** A stream's key for one-per-tab: its route and the page's ?tab= (letters, digits, - and _), else none. */
export function tabKey(req: http.IncomingMessage, route: string): string | null {
  const tab = new URL(req.url ?? '/', 'http://x').searchParams.get('tab') ?? '';
  return /^[A-Za-z0-9_-]{6,64}$/.test(tab) ? `${route}#${tab}` : null;
}

/** End an event stream's response: it reconnects (`retry:`). */
export const endStream = (res: http.ServerResponse) => () => { if (!res.writableEnded) res.end(); };

/** What holds the slots now (studio_ops, /api/health). */
export function summary(now = Date.now()) {
  const routes = new Map<string, number>();
  const kinds: Record<string, number> = {};
  let oldest = 0;
  for (const e of open) {
    const r = e.route.replace(/\/[a-z]_[0-9a-f]{6,}/g, '/:id').replace(/^\/mcp\/.+/, '/mcp/:key');
    routes.set(r, (routes.get(r) ?? 0) + 1);
    const k = e.kind ?? 'request';
    kinds[k] = (kinds[k] ?? 0) + 1;
    oldest = Math.max(oldest, now - e.at);
  }
  const top = [...routes].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([route, n]) => ({ route, n }));
  return { open: open.size, slots: SLOTS, held: heldCount(), heldMax: HELD_MAX, kinds, oldestSec: Math.round(oldest / 1000), peak, peakAt, ended: { ...ended }, top };
}

/** Tests: start clean. */
export function resetSlots() {
  for (const e of open) if (e.timer) clearTimeout(e.timer);
  open.clear();
  peak = 0; peakAt = 0; ended = { cap: 0, age: 0, replaced: 0 }; crowdedLogged = false;
}
