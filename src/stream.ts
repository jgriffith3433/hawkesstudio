// The dashboard's push stream (GET /api/stream, server-sent events): small "something changed" events, so the page
// refetches only what an event names instead of polling every few seconds (dashboard/stream.js).
//
// - talk: a conversation changed (a message, its status, an approval card, a guide batch): { ids, unseen } where
//   unseen is the Talk tab's badge. Pushed by talk.ts, guide.ts and approvals.ts as it happens (coalesced briefly).
// - activity { count }, inbox { count }, changes, runs, ops: from a watcher that looks only when something moved, and
//   only while a page is connected. No timer: a database write (db.ts onDbWrite), a Hawkes Gen job event (genevents.ts)
//   or poke() (an approval decided, a card asked for) schedules one look; it compares signatures and sends an event
//   only for what actually changed. A page that nothing happens to receives nothing and asks for nothing.
//
// No safety tick on the page either (J, 2026-11-02: "Please stop implementing polling"): the browser reconnects a dropped
// stream itself (`retry:`), and a reconnect makes every topic refetch once (dashboard/stream.js).

import type http from 'node:http';
import { db, onDbWrite } from './db.ts';
import { genEvents } from './gen.ts';

type Event = { topic: string; [k: string]: unknown };
const clients = new Set<http.ServerResponse>();
const write = (res: http.ServerResponse, e: Event) => res.write(`data: ${JSON.stringify(e)}\n\n`);
const broadcast = (e: Event) => { for (const res of clients) write(res, e); };

// ------------------------------------------------------------ pushed changes (talk)

const COALESCE_MS = 250;
const pending = new Map<string, { ids: Set<string>; extra: Record<string, unknown> }>();
let flushTimer: NodeJS.Timeout | null = null;

/** Something changed (topic, with the id it's about): sent to every page shortly, together with whatever else changed. */
export function changed(topic: string, id?: string | null, extra: Record<string, unknown> = {}) {
  if (!clients.size) return;
  const p = pending.get(topic) ?? { ids: new Set<string>(), extra: {} };
  if (id) p.ids.add(id);
  Object.assign(p.extra, extra);
  pending.set(topic, p);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const [topic, p] of pending) broadcast({ topic, ...(p.ids.size ? { ids: [...p.ids] } : {}), ...p.extra });
    pending.clear();
  }, COALESCE_MS);
  flushTimer.unref?.();
}

// ------------------------------------------------------------ the watcher

/** What the watcher reads (server.ts gives the real ones; tests their own). */
export type Probes = {
  activity?: () => Promise<{ count: number } & Record<string, unknown>>;
  inbox?: () => Promise<{ count: number; ids: string[] }>;
};
let probes: Probes = {};
export const setProbes = (p: Probes) => void (probes = p);

const last = new Map<string, string>();
/** The newest counts, for a page that connects (its badges right away). */
const counts: Record<string, number> = {};
let looking: NodeJS.Timeout | null = null;
let busy = false;
let again = false;
let offWrites: (() => void) | null = null;
let offGen: (() => void)[] = [];

/** Fields that move every second without anything happening (durations, the time of the read). */
const VOLATILE = new Set(['at', 'seconds', 'lastMinute', 'slow', 'stuck']);
export const signature = (v: unknown) => JSON.stringify(v, (k, x) => (VOLATILE.has(k) ? undefined : x));

function one(sql: string) {
  try {
    return JSON.stringify(db.prepare(sql).all());
  } catch {
    return ''; // a table not made yet (a fresh data folder)
  }
}

/** Sends `topic` when its signature moved since the last look (the first look only records it). */
function compare(topic: string, sig: string, extra: Record<string, unknown> = {}) {
  const before = last.get(topic);
  last.set(topic, sig);
  if (before !== undefined && before !== sig) broadcast({ topic, ...extra });
  // The first look after a page connected: its count only (the badge), nothing to refetch.
  else if (before === undefined && 'count' in extra) broadcast({ topic, ...extra, badge: true });
}

async function look() {
  if (busy) return void (again = true);
  busy = true;
  try {
    compare('changes', one('SELECT COUNT(*) AS n, MAX(updated) AS u FROM changes'));
    compare('runs', one(`SELECT COUNT(*) AS n, MAX(started) AS s, MAX(finished) AS f, (SELECT group_concat(id || status || COALESCE(detail, ''), '|') FROM steps WHERE run IN (SELECT id FROM runs WHERE status = 'running')) AS now FROM runs`));
    // Builds finishing or failing (buildfail.ts): the Today cards, Go live and the project's build list redraw.
    compare('builds', one('SELECT id, status, fail_class, notified FROM builds ORDER BY started DESC LIMIT 80'));
    compare('ops', one(`SELECT id, status, step FROM ops WHERE status IN ('queued', 'running') OR created > ${Date.now() - 86_400_000} ORDER BY created DESC LIMIT 40`));
    // The activity panel asks Hawkes Gen for its jobs; the Inbox reads the roadmap: both only after something moved.
    if (probes.activity) {
      const a = await probes.activity().catch(() => null);
      if (a) {
        counts.activity = a.count;
        compare('activity', signature(a), { count: a.count });
      }
    }
    if (probes.inbox) {
      const ib = await probes.inbox().catch(() => null);
      if (ib) {
        counts.inbox = ib.count;
        compare('inbox', `${ib.count}|${ib.ids.join(',')}`, { count: ib.count });
      }
    }
  } finally {
    busy = false;
  }
  if (again) {
    again = false;
    schedule(300);
  }
}

function schedule(ms: number) {
  if (!clients.size || looking) return;
  looking = setTimeout(() => {
    looking = null;
    if (clients.size) void look();
  }, ms);
  looking.unref?.();
}

/** Look soon: something changed that the activity panel, the Inbox or a run's page shows (a burst of writes is one look). */
export function poke(ms = 300) {
  schedule(ms);
}

function startWatch() {
  if (offWrites) return;
  offWrites = onDbWrite(() => poke(400));
  // Hawkes Gen's own events (a job queued, started, a step, done): the activity panel and the playtests lists show them.
  // Held open only while a page is connected (genevents.ts); bursts of progress are one look every 1.5 s at most.
  genEvents.hold('dashboard-stream');
  offGen = [genEvents.onEvent((type) => { if (type === 'job') poke(1500); }), genEvents.onConnect(() => poke(300))];
  poke(0); // the badges' first look
}
function stopWatch() {
  offWrites?.();
  offWrites = null;
  for (const off of offGen) off();
  offGen = [];
  genEvents.release('dashboard-stream');
  if (looking) clearTimeout(looking);
  looking = null;
  last.clear(); // a page connecting later starts from a fresh look
}

// ------------------------------------------------------------ the endpoint

/** GET /api/stream: the page's one event stream (same sign-in as the dashboard: Caddy asks /auth/check first). */
export function handleStream(req: http.IncomingMessage, res: http.ServerResponse, hello: Record<string, unknown> = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  // Reconnect after 5 s when the connection drops (the page adds its own backoff when it can't connect at all).
  res.write('retry: 5000\n\n');
  write(res, { topic: 'hello', ...counts, ...hello });
  clients.add(res);
  startWatch();
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    if (!clients.size) stopWatch();
  });
}

/** Pages connected now (tests, health). */
export const streamClients = () => clients.size;
