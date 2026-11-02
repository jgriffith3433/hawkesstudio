// Pushed feeds (server-sent events) for pages that show something that moves all the time: the Playtests page's grid and
// its big view (dashboard/live.js), the On Air page (dashboard/broadcast.js). The page opens one stream and gets the whole
// payload whenever it changed, instead of asking for it every second or two: one long request per open page through the
// edge Worker instead of thousands a day. The server reads each feed once per key however many pages watch it, and only
// while one does (a key's loop stops with its last page).

import type http from 'node:http';

type Feed = {
  clients: Set<http.ServerResponse>;
  timer: NodeJS.Timeout | null;
  last: string | null;
  lastData: string | null;
  busy: boolean;
};
const feeds = new Map<string, Feed>();

/** The payload's signature: the JSON without the top-level read time (`at`), so an unchanged payload isn't sent again. */
const sigOf = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'at' ? undefined : x));

export type FeedOptions = {
  /** How often the server reads it while someone watches (ms). */
  everyMs: number;
  /** Reads the payload; null sends nothing this time. */
  read: () => Promise<unknown>;
  /** When true for the newest payload the feed stops (a finished playtest won't change again). */
  done?: (v: any) => boolean;
};

/** GET …/stream: serve `key` to this page until it closes. */
export function serveFeed(req: http.IncomingMessage, res: http.ServerResponse, key: string, o: FeedOptions) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  let f = feeds.get(key);
  if (!f) {
    f = { clients: new Set(), timer: null, last: null, lastData: null, busy: false };
    feeds.set(key, f);
  }
  const feed = f;
  feed.clients.add(res);
  if (feed.lastData) res.write(feed.lastData); // what the others already have, at once

  const tick = async () => {
    if (feed.busy || !feed.clients.size) return;
    feed.busy = true;
    try {
      const v = await o.read().catch((e) => ({ error: String(e?.message ?? e) }));
      if (v != null) {
        const sig = sigOf(v);
        if (sig !== feed.last) {
          feed.last = sig;
          feed.lastData = `data: ${JSON.stringify(v)}\n\n`;
          for (const c of feed.clients) c.write(feed.lastData);
        }
        if (o.done?.(v)) stop();
      }
    } finally {
      feed.busy = false;
    }
  };
  const stop = () => {
    if (feed.timer) clearInterval(feed.timer);
    feed.timer = null;
  };
  if (!feed.timer) {
    void tick();
    feed.timer = setInterval(() => void tick(), o.everyMs);
    feed.timer.unref?.();
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    feed.clients.delete(res);
    if (!feed.clients.size) {
      stop();
      feeds.delete(key);
    }
  });
}

/** Pages watching a feed now (tests). */
export const feedClients = (key: string) => feeds.get(key)?.clients.size ?? 0;
