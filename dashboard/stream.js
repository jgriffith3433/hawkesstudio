// The push stream (GET /api/stream, src/stream.ts): one EventSource per page tells each part of the dashboard when
// something it shows changed (talk, activity, inbox, changes, runs, ops), so they refetch only then instead of polling.
// studioStream.on(topic, fn): fn gets the event ({ topic, ids?, count?, unseen? }), debounced per topic.
// While the page is hidden, or the reader is scrolling or touching it (studioPatch.busy, patch.js), events wait; coming back delivers each waiting topic once.
// No timer asks for anything (J, 2026-11-02: "Please stop implementing polling"): there is no safety tick. A dropped stream
// is reconnected by the browser itself (EventSource, the server's `retry:`), and after a reconnect, or when the page comes
// back after a minute hidden, every topic gets { resync: true } once, so a missed event costs one refetch, not a poll.
// Only a stream the browser gave up on (signed out, the server down: readyState CLOSED, which it never retries) is reopened
// by a timer, slower each time (2 s doubling to a minute): that is a reconnect, it fetches nothing but the stream itself.
// Loaded first, before app.js (which uses it at its top level); it needs nothing from the other scripts.
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
    // The reader is scrolling or touching the page (patch.js): wait until they stop, so nothing redraws under their thumb.
    if (typeof studioPatch !== 'undefined' && studioPatch.busy()) { timers.set(topic, setTimeout(() => deliver(topic), 250)); return; }
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

  // A tab left hidden for a minute closes its stream (a held stream is a request the edge and Cloud Run keep open).
  // Back on screen, it connects again and catches up with one resync.
  let hideTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (document.hidden && es) { clearTimeout(retry); try { es.close(); } catch {} es = null; up = false; } }, 60_000);
      return;
    }
    clearTimeout(hideTimer);
    if (!es && typeof EventSource !== 'undefined') connect();
    for (const topic of queued.keys()) if (!timers.has(topic)) deliver(topic);
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
