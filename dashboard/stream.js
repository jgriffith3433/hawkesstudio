// The push stream (GET /api/stream, src/stream.ts): one EventSource per page tells each part of the dashboard when
// something it shows changed (talk, activity, inbox, changes, runs, ops), so they refetch only then instead of polling.
// studioStream.on(topic, fn): fn gets the event ({ topic, ids?, count?, unseen? }), debounced per topic.
// While the page is hidden events wait; coming back delivers each waiting topic once. A safety tick every 60 s (15 s
// while the stream is down) delivers every topic with { safety: true }; after a reconnect every topic gets { resync: true }.
// The stream reconnects with backoff (2 s doubling to a minute). Loaded right after app.js.
const studioStream = (() => {
  const handlers = new Map();
  const queued = new Map(); // topic -> merged event, waiting for the debounce or for the page to be visible
  const timers = new Map();
  let es = null;
  let up = false;
  let opened = false; // connected once (a later open is a reconnect)
  let backoff = 2000;
  let retry = null;

  function deliver(topic) {
    timers.delete(topic);
    if (document.hidden) return; // stays queued until the page is visible
    const e = queued.get(topic);
    queued.delete(topic);
    for (const fn of handlers.get(topic) ?? []) try { fn(e); } catch (err) { console.warn(`[stream] ${topic}:`, err); }
  }
  function push(e) {
    if (!e?.topic) return;
    const b = queued.get(e.topic);
    if (!b) queued.set(e.topic, { ...e });
    else {
      // What a merged event is about: a badge-only event (badge: true) adds nothing, no ids means everything in the topic.
      const ids = b.badge ? e.ids : e.badge ? b.ids : b.ids && e.ids ? [...new Set([...b.ids, ...e.ids])] : undefined;
      queued.set(e.topic, { ...b, ...e, ids, badge: Boolean(b.badge && e.badge) });
    }
    if (!timers.has(e.topic)) timers.set(e.topic, setTimeout(() => deliver(e.topic), 300));
  }
  const all = (extra) => { for (const topic of handlers.keys()) push({ topic, ...extra }); };

  function connect() {
    clearTimeout(retry);
    try { es?.close(); } catch {}
    es = new EventSource('/api/stream');
    es.onopen = () => {
      up = true;
      backoff = 2000;
      if (opened) all({ resync: true }); // events may have been missed while it was down
      opened = true;
    };
    es.onmessage = (m) => {
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      if (e.topic === 'hello') {
        // The newest counts, for the badges.
        if (typeof e.talkUnseen === 'number') push({ topic: 'talk', unseen: e.talkUnseen, badge: true });
        if (typeof e.inbox === 'number') push({ topic: 'inbox', count: e.inbox, badge: true });
        if (typeof e.activity === 'number') push({ topic: 'activity', count: e.activity, badge: true });
        return;
      }
      push(e);
    };
    es.onerror = () => {
      up = false;
      // The browser retries a dropped stream by itself; one it gave up on (signed out, the server down) we retry, slower each time.
      if (es.readyState === EventSource.CLOSED) {
        retry = setTimeout(connect, backoff);
        backoff = Math.min(60_000, backoff * 2);
      }
    };
  }

  let lastSafety = Date.now();
  setInterval(() => {
    if (document.hidden || Date.now() - lastSafety < (up ? 60_000 : 15_000)) return;
    lastSafety = Date.now();
    all({ safety: true });
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const topic of queued.keys()) if (!timers.has(topic)) deliver(topic);
    // Away for a while: everything once.
    if (Date.now() - lastSafety > 60_000) { lastSafety = Date.now(); all({ safety: true }); }
  });
  if (typeof EventSource !== 'undefined') connect();

  return {
    /** fn(event) when `topic` changed (an array of topics: each). */
    on(topics, fn) {
      for (const t of [].concat(topics)) handlers.set(t, [...(handlers.get(t) ?? []), fn]);
    },
    connected: () => up,
  };
})();
