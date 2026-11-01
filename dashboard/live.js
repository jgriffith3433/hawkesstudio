// Playtests (the live page, #live): every playtest playing now, waiting for a browser, or finished in the last half hour,
// as a grid of tiles with each one's live video (Hawkes Gen's MJPEG stream of the newest screencast frames), its step,
// what the game's bot says it's doing, its progress and its problems so far. A tile maximizes (#live/<job>) to the
// big view: every player's video, the step history, the bot's state and metrics, progress and fps over time, problems,
// console errors and failed requests. Activity's playtest cards open it there.
//
// Kept light: one request for the grid every 1.5 s while the tab is visible (GET /api/playtests/live), one more per
// second for the maximized one (GET /api/playtests/live/<job>); tiles are built once and updated in place (an <img>
// streaming MJPEG is never recreated); only tiles on screen stream, at 4 fps (the maximized view at 12), and nothing
// streams while the page is hidden or another tab is open. Uses app.js's helpers ($, esc, api, show, tab, GEN, file).

(() => {
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const GRID_FPS = 4;
  const BIG_FPS = 12;
  const S = { data: null, open: null, detail: null, timer: null, detailTimer: null, tiles: new Map(), product: '', showDone: true, shots: new Map() };
  const root = () => $('#live');

  // ------------------------------------------------------------- formatting
  const clock = (s) => {
    if (s == null || !Number.isFinite(s)) return '–';
    s = Math.max(0, Math.round(s));
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const elapsed = (p) => (p.live === false && p.finishedAt ? (p.finishedAt - p.startedAt) / 1000 : (Date.now() - (p.startedAt ?? Date.now())) / 1000);
  const title = (p) => p.ctx?.name || p.scenario?.title || p.scenario?.id || (p.url ? p.url.replace(/^https?:\/\//, '').slice(0, 40) : 'playtest');
  const outcomeClass = (o) => (o === 'won' || o === 'done' || o === 'passed' ? 'ship' : o === 'lost' ? 'fix-first' : o ? 'failed' : '');
  const stateOf = (p) => {
    if (p.live === false && p.status) return p.outcome ?? p.status;
    const st = p.players?.[0]?.state;
    return p.outcome ?? st?.status ?? (p.live ? 'playing' : 'starting');
  };
  const progressOf = (p) => {
    const ps = (p.players ?? []).map((x) => x.state?.progress).filter((x) => typeof x === 'number');
    return ps.length ? Math.max(0, Math.min(1, ps.reduce((a, b) => a + b, 0) / ps.length)) : null;
  };
  const streamUrl = (job, player, fps) => `/api/gen/v1/jobs/${job}/live.mjpeg?player=${player}&fps=${fps}`;
  const frameUrl = (job, player) => `/api/gen/v1/jobs/${job}/frame?player=${player}&_=${Date.now()}`;

  // One picture's feed: the MJPEG stream, and if it hasn't produced a frame within a couple of seconds (a proxy buffering
  // it) or it drops, the single-frame route polled every ~250 ms. note(text) says what's up while there is no picture.
  const FEED_WAIT = 2500;
  const FRAME_EVERY = 1000; // one frame a second: every frame is a request through the edge
  const feeds = new WeakMap();
  function feedOff(img) {
    const f = feeds.get(img);
    if (f) {
      clearTimeout(f.timer);
      img.onload = img.onerror = null;
      feeds.delete(img);
    }
    img.src = BLANK;
  }
  function feedOn(img, job, player, fps, note = () => {}) {
    if (feeds.has(img)) feedOff(img);
    const f = { mode: 'stream', got: false, fails: 0, timer: null };
    feeds.set(img, f);
    const poll = () => {
      if (feeds.get(img) !== f) return;
      img.src = frameUrl(job, player);
    };
    const toPoll = () => {
      if (f.mode === 'poll') return;
      f.mode = 'poll';
      clearTimeout(f.timer);
      poll();
    };
    img.onload = () => {
      if (feeds.get(img) !== f || img.src === BLANK) return;
      f.got = true;
      f.fails = 0;
      note('');
      if (f.mode === 'poll') f.timer = setTimeout(poll, FRAME_EVERY);
      else clearTimeout(f.timer);
    };
    img.onerror = () => {
      if (feeds.get(img) !== f) return;
      if (f.mode === 'stream') return toPoll();
      f.fails += 1;
      if (f.fails >= 3 && !f.got) note('no video available');
      f.timer = setTimeout(poll, f.fails > 3 ? 5000 : 2000);
    };
    note('waiting for the first frame…');
    img.src = streamUrl(job, player, fps);
    f.timer = setTimeout(() => { if (!f.got) toPoll(); }, FEED_WAIT);
  }

  // ------------------------------------------------------------- data
  async function load() {
    if (tab !== 'live') return;
    try {
      S.data = await api('/api/playtests/live');
      render();
    } catch (e) {
      $('#ltBody').innerHTML = `<div class="empty">Couldn't load the playtests: ${esc(e.message)}</div>`;
    }
  }
  function schedule() {
    clearTimeout(S.timer);
    if (tab !== 'live') return;
    S.timer = setTimeout(async () => {
      if (!document.hidden && tab === 'live') await load();
      schedule();
    }, 5000);
  }
  window.loadLiveTab = async () => {
    const want = /^#live\/(j_[0-9a-f]+)/.exec(location.hash)?.[1] ?? null;
    if (!S.data) await load();
    else render();
    if (want !== S.open) want ? openBig(want, { push: false }) : closeBig({ push: false });
    schedule();
  };
  addEventListener('studio-tab', (e) => {
    if (e.detail !== 'live') {
      clearTimeout(S.timer);
      closeBig({ push: false, keepHash: true });
      for (const t of S.tiles.values()) stream(t, false);
    }
  });
  document.addEventListener('visibilitychange', () => {
    for (const t of S.tiles.values()) stream(t, !document.hidden && t.seen && !S.open);
    if (S.open) bigStreams(!document.hidden);
  });

  // ------------------------------------------------------------- the grid
  function header(d) {
    const lanes = d.lanes;
    const cap = d.capacity;
    const products = [...new Set([...d.playing, ...d.waiting, ...d.finished].map((p) => p.ctx?.product).filter(Boolean))];
    const names = Object.fromEntries([...d.playing, ...d.waiting, ...d.finished].map((p) => [p.ctx?.product, p.ctx?.productName]));
    const sel = `<select id="ltProduct"><option value="">All products</option>${products.map((p) => `<option value="${esc(p)}"${p === S.product ? ' selected' : ''}>${esc(names[p] ?? p)}</option>`).join('')}</select>`;
    return `<div class="bar lt-bar-top">${sel}
      <label class="meta"><input type="checkbox" id="ltDone"${S.showDone ? ' checked' : ''}> finished</label>
      <span class="lt-chip"><span class="dot ${d.playing.length ? 'ok' : ''}"></span>${d.playing.length} playing</span>
      ${d.waiting.length ? `<span class="lt-chip">⏳ ${d.waiting.length} waiting</span>` : ''}
      ${lanes ? `<span class="lt-chip" title="Browser tabs the running playtests use, of what the playtesters take at once">${lanes.used}/${lanes.limit} browser tabs</span>` : ''}
      ${cap ? `<span class="lt-chip" title="Playtest machines (T4 GPU); a full or stopped one is started when needed">${cap.machines} playtester${cap.machines === 1 ? '' : 's'}</span>` : ''}
    </div>`;
  }

  function render() {
    const d = S.data;
    if (!d) return;
    const box = $('#ltBody');
    const keep = (p) => !S.product || p.ctx?.product === S.product;
    const playing = d.playing.filter(keep);
    const waiting = d.waiting.filter(keep);
    const finished = S.showDone ? d.finished.filter(keep) : [];
    // The frame (header and sections) is rebuilt only when its shape changes; tiles are updated in place.
    const shape = JSON.stringify([S.product, S.showDone, d.playing.length, d.waiting.length, d.finished.length, playing.length, waiting.length, finished.length, d.lanes, d.capacity]);
    if (box.dataset.shape !== shape) {
      box.dataset.shape = shape;
      box.innerHTML = `${header(d)}
        <h3 class="lt-h">Playing now <span class="meta">${playing.length}</span></h3>
        <div class="lt-grid" id="ltPlaying">${playing.length ? '' : '<div class="empty lt-empty">Nothing is playing. Playtests show up here the moment they start: the daily run, beta checks, an agent checking its change, or one you ask Talk for.</div>'}</div>
        ${waiting.length ? `<h3 class="lt-h">Waiting for a browser <span class="meta">${waiting.length}</span></h3><div class="lt-waiting" id="ltWaiting"></div>` : ''}
        ${finished.length ? `<h3 class="lt-h">Finished in the last 30 minutes <span class="meta">${finished.length}</span></h3><div class="lt-grid lt-done" id="ltFinished"></div>` : ''}`;
      $('#ltProduct').onchange = (e) => { S.product = e.target.value; render(); };
      $('#ltDone').onchange = (e) => { S.showDone = e.target.checked; render(); };
      // The tiles move into the new sections.
      for (const t of S.tiles.values()) t.el.remove();
    }
    const seen = new Set();
    const place = (list, where) => {
      const host = $(where);
      if (!host) return;
      for (const p of list) {
        seen.add(p.job);
        const t = tileFor(p);
        update(t, p);
        if (t.el.parentElement !== host) host.appendChild(t.el);
      }
      // Newest first in the order given.
      list.forEach((p, i) => { const el = S.tiles.get(p.job).el; if (host.children[i] !== el) host.insertBefore(el, host.children[i] ?? null); });
    };
    place(playing, '#ltPlaying');
    place(finished, '#ltFinished');
    for (const [job, t] of S.tiles) {
      if (!seen.has(job)) {
        stream(t, false);
        observer.unobserve(t.el);
        t.el.remove();
        S.tiles.delete(job);
      }
    }
    const w = $('#ltWaiting');
    if (w) w.innerHTML = waiting.map((x) => `<div class="lt-wait-row"><b>${esc(x.ctx?.productName ?? x.project)}</b> · ${esc(x.scenario ?? 'playtest')}${x.peers > 1 ? ` · ${x.peers} players` : ''}${x.device === 'phone' ? ' · 📱' : ''} <span class="meta">${esc(x.detail ?? 'waiting its turn')} · ${clock((Date.now() - x.created) / 1000)}</span></div>`).join('');
    if (S.open) renderBigFromGrid();
  }

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const t = S.tiles.get(e.target.dataset.job);
      if (!t) continue;
      t.seen = e.isIntersecting;
      stream(t, t.seen && !document.hidden && !S.open);
    }
  }, { rootMargin: '200px' });

  function tileFor(p) {
    let t = S.tiles.get(p.job);
    if (t) return t;
    const el = document.createElement('article');
    el.className = 'lt-tile';
    el.dataset.job = p.job;
    el.innerHTML = `<div class="lt-screen"><img class="lt-img" alt="" src="${BLANK}"><div class="lt-wait">waiting for the first frame…</div>
        <div class="lt-ovl lt-ovl-top"><span class="lt-prod"></span><span class="lt-time"></span></div>
        <div class="lt-ovl lt-ovl-bottom"><div class="lt-prog"><span></span></div></div>
        <button class="lt-maxbtn" title="Maximize (watch it big)" aria-label="Maximize">⤢</button></div>
      <div class="lt-info"><div class="lt-title"><b class="lt-name"></b> <span class="pill lt-state"></span></div>
        <div class="lt-step"></div><div class="lt-note"></div><div class="lt-facts meta"></div></div>`;
    el.addEventListener('click', (e) => { if (!e.target.closest('a')) openBig(p.job); });
    const img = el.querySelector('.lt-img');
    img.addEventListener('load', () => { if (img.src !== BLANK) el.classList.add('has-frame'); });
    t = { el, img, job: p.job, live: p.live !== false, seen: false, streaming: false, p };
    S.tiles.set(p.job, t);
    observer.observe(el);
    return t;
  }

  /** A tile's stream on or off (off: a 1-pixel image, which closes the connection). Finished tiles show their last screenshot. */
  function stream(t, on) {
    if (t.p?.live === false) {
      if (on && !t.shot) lastShot(t);
      return;
    }
    if (on === t.streaming) return;
    t.streaming = on;
    if (on) feedOn(t.img, t.job, 0, GRID_FPS, (m) => { t.msg = m; showWait(t); });
    else feedOff(t.img);
  }
  function showWait(t) {
    const w = t.el.querySelector('.lt-wait');
    if (t.msg) w.textContent = t.msg;
    else if (t.p?.live === false) w.textContent = t.p.outcome ?? t.p.status ?? '';
  }
  async function lastShot(t) {
    t.shot = true;
    try {
      const r = await fetch(`/api/gen/v1/jobs/${t.job}/shots`).then((x) => x.json());
      const last = (r.shots ?? []).at(-1);
      if (last) t.img.src = `/api/gen/v1/jobs/${t.job}/shots/${last.i}`;
      else { t.msg = 'no video available'; showWait(t); }
    } catch {
      // No screenshot: the tile says how it ended.
    }
  }

  function facts(p) {
    const st = p.players?.[0]?.state;
    const out = [];
    if (st?.fps != null) out.push(`${st.fps} fps`);
    else if (p.fps != null) out.push(`${Math.round(p.fps)} fps avg`);
    if (p.problems?.count) out.push(`<span class="lt-bad">⚠ ${p.problems.count} problem${p.problems.count === 1 ? '' : 's'}</span>`);
    if (p.console?.errors) out.push(`<span class="lt-warn">${p.console.errors} console error${p.console.errors === 1 ? '' : 's'}</span>`);
    if (p.peers > 1) out.push(`${p.peers} players`);
    if (p.playtester) out.push(`on ${esc(p.playtester.slice(-6))}`);
    out.push(esc(p.ctx?.by ?? ''));
    return out.filter(Boolean).join(' · ');
  }

  function update(t, p) {
    t.p = p;
    const q = (s) => t.el.querySelector(s);
    const live = p.live !== false;
    t.el.classList.toggle('lt-finished', !live);
    t.el.querySelector('.lt-screen').classList.toggle('phone', p.device === 'phone');
    q('.lt-prod').textContent = p.ctx?.productName ?? p.project ?? '';
    q('.lt-time').textContent = `${p.device === 'phone' ? '📱 ' : ''}${clock(elapsed(p))}`;
    q('.lt-name').textContent = title(p);
    const state = stateOf(p);
    const pill = q('.lt-state');
    pill.textContent = state;
    pill.className = `pill lt-state ${live ? (state === 'error' ? 'failed' : '') : outcomeClass(state)}`;
    q('.lt-step').textContent = live ? p.step ?? '' : `${p.outcome ?? p.status}${p.seconds ? ` after ${clock(p.seconds)}` : ''}`;
    const st = p.players?.[0]?.state;
    const note = live ? [st?.scene, st?.note].filter(Boolean).join(' — ') : (p.problems?.last?.[0]?.message ?? '');
    q('.lt-note').textContent = note;
    q('.lt-note').title = note;
    q('.lt-facts').innerHTML = facts(p);
    const pr = progressOf(p);
    const bar = q('.lt-prog span');
    bar.style.width = pr == null ? '0' : `${Math.round(pr * 100)}%`;
    q('.lt-prog').classList.toggle('none', pr == null);
    q('.lt-wait').textContent = t.msg || (live ? 'waiting for the first frame…' : `${p.outcome ?? p.status ?? ''} · no video available`);
    if (!live && t.seen) stream(t, true);
  }

  // ------------------------------------------------------------- the big view
  function openBig(job, { push = true } = {}) {
    S.open = job;
    if (push) show('live', job);
    for (const t of S.tiles.values()) stream(t, false);
    let el = $('#ltBig');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ltBig';
      el.className = 'lt-big';
      el.setAttribute('role', 'dialog');
      el.innerHTML = `<div class="lt-big-main"><div class="lt-players"></div></div>
        <aside class="lt-side"><div class="lt-side-head"><div><div class="lt-big-prod meta"></div><h3 class="lt-big-title"></h3></div>
          <div class="lt-nav"><button class="lt-prev" title="Previous (←)">‹</button><button class="lt-next" title="Next (→)">›</button><button class="lt-close" title="Back to the grid (Esc)">✕</button></div></div>
          <div class="lt-side-body"></div></aside>`;
      document.body.appendChild(el);
      el.querySelector('.lt-close').onclick = () => closeBig();
      el.querySelector('.lt-prev').onclick = () => step(-1);
      el.querySelector('.lt-next').onclick = () => step(1);
    }
    el.hidden = false;
    document.body.classList.add('lt-big-open');
    el.dataset.job = job;
    bigStreams(false);
    el.querySelector('.lt-players').innerHTML = '';
    delete el.querySelector('.lt-players').dataset.key;
    el.querySelector('.lt-side-body').innerHTML = '<div class="meta">loading…</div>';
    S.detail = null;
    renderBigFromGrid();
    pollDetail();
  }
  function closeBig({ push = true, keepHash = false } = {}) {
    if (!S.open) return;
    S.open = null;
    clearTimeout(S.detailTimer);
    const el = $('#ltBig');
    if (el) {
      bigStreams(false);
      el.hidden = true;
    }
    document.body.classList.remove('lt-big-open');
    if (push && !keepHash) show('live');
    for (const t of S.tiles.values()) stream(t, t.seen && !document.hidden && tab === 'live');
  }
  function step(dir) {
    const order = [...(S.data?.playing ?? []), ...(S.showDone ? S.data?.finished ?? [] : [])].filter((p) => !S.product || p.ctx?.product === S.product).map((p) => p.job);
    const i = order.indexOf(S.open);
    if (!order.length) return;
    openBig(order[(i + dir + order.length) % order.length]);
  }
  document.addEventListener('keydown', (e) => {
    if (!S.open || e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'Escape') closeBig();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  const gridEntry = () => [...(S.data?.playing ?? []), ...(S.data?.finished ?? [])].find((p) => p.job === S.open) ?? null;

  async function pollDetail() {
    clearTimeout(S.detailTimer);
    const job = S.open;
    if (!job) return;
    const g = gridEntry();
    if (!document.hidden && (!g || g.live !== false)) {
      try {
        const r = await api(`/api/playtests/live/${job}`);
        if (S.open !== job) return;
        S.detail = r.live ? { ...r.live, ctx: g?.ctx } : null;
        renderBig();
      } catch {
        // The grid's entry still shows.
      }
    }
    if (S.open === job) S.detailTimer = setTimeout(pollDetail, (gridEntry()?.live === false) ? 10000 : 3000);
  }
  function renderBigFromGrid() {
    if (!S.detail) renderBig();
  }

  /** The players' videos: one big, two side by side, three or four in a grid; finished: the video file. */
  function playersHtml(p) {
    const n = Math.max(1, p.players?.length || p.peers || 1);
    if (p.live === false) {
      return p.video ? `<video class="lt-video" controls autoplay muted playsinline src="${esc(file(p.video))}"></video>` : `<div class="empty">This playtest ${esc(p.outcome ?? p.status)} and no video was kept for it. Its history page has what was recorded.</div>`;
    }
    return `<div class="lt-pgrid n${Math.min(4, n)}">${Array.from({ length: n }, (_, i) => `<figure class="lt-player${p.device === 'phone' ? ' phone' : ''}" data-player="${i}"><img alt="" src="${BLANK}"><div class="lt-pmsg lt-wait">waiting for the first frame…</div><figcaption></figcaption></figure>`).join('')}</div>`;
  }
  function bigStreams(on) {
    const el = $('#ltBig');
    if (!el) return;
    for (const f of el.querySelectorAll('.lt-player')) {
      const img = f.querySelector('img');
      const msg = f.querySelector('.lt-pmsg');
      if (!on) feedOff(img);
      else if (!feeds.has(img)) feedOn(img, el.dataset.job, Number(f.dataset.player), BIG_FPS, (m) => { msg.textContent = m; msg.hidden = !m; });
    }
    for (const v of el.querySelectorAll('video')) if (!on) v.pause();
  }

  function sparkline(timeline) {
    const pts = (timeline ?? []).filter((x) => (x.peer ?? 0) === 0);
    if (pts.length < 2) return '';
    const t0 = pts[0].t;
    const t1 = pts.at(-1).t || t0 + 1;
    const W = 300;
    const H = 60;
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const line = (key, max) => pts.filter((p) => typeof p[key] === 'number').map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${(H - 4 - (Math.min(max, p[key]) / max) * (H - 8)).toFixed(1)}`).join('');
    const fpsMax = Math.max(60, ...pts.map((p) => p.fps ?? 0));
    return `<svg class="lt-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Progress and frame rate over time">
      <path d="${line('progress', 1)}" class="lt-spark-prog"/><path d="${line('fps', fpsMax)}" class="lt-spark-fps"/></svg>
      <div class="meta lt-spark-key"><span class="k prog"></span> progress <span class="k fps"></span> fps (0–${fpsMax}) · ${clock(t1 - t0)}</div>`;
  }

  function renderBig() {
    const el = $('#ltBig');
    if (!el || !S.open) return;
    const g = gridEntry();
    const p = S.detail ?? g;
    if (!p) {
      el.querySelector('.lt-side-body').innerHTML = '<div class="meta">This playtest isn\'t playing any more and isn\'t in the last half hour. Its history page has everything.</div>';
      return;
    }
    const ctx = p.ctx ?? g?.ctx ?? {};
    el.querySelector('.lt-big-prod').textContent = `${ctx.productName ?? p.project ?? ''} · ${ctx.by ?? ''}`;
    el.querySelector('.lt-big-title').textContent = title({ ...p, ctx });
    // The players' frame is rebuilt only when their count or the live/finished state changes (it holds the streams).
    const pbox = el.querySelector('.lt-players');
    const pkey = `${p.live === false ? 'done' : 'live'}:${Math.max(1, p.players?.length || p.peers || 1)}:${p.device}`;
    if (pbox.dataset.key !== pkey) {
      pbox.dataset.key = pkey;
      pbox.innerHTML = playersHtml(p);
      if (p.live !== false) bigStreams(!document.hidden);
    }
    for (const f of el.querySelectorAll('.lt-player')) {
      const pl = (p.players ?? [])[Number(f.dataset.player)];
      const st = pl?.state;
      f.querySelector('figcaption').textContent = [p.players?.length > 1 ? `Player ${Number(f.dataset.player) + 1}` : '', st?.scene, st?.progress != null ? `${Math.round(st.progress * 100)}%` : '', st?.fps != null ? `${st.fps} fps` : '', st?.note].filter(Boolean).join(' · ');
    }
    const live = p.live !== false;
    const st = p.players?.[0]?.state;
    const pr = progressOf(p);
    const links = [
      ctx.step ? `<a href="#playtests" data-lt-history="${esc(ctx.step)}">history page</a>` : '',
      ctx.change ? `<a href="#changes/${esc(ctx.change)}">the change it checks</a>` : '',
      `<a href="${esc(GEN)}/#job/${esc(p.job)}" target="_blank" rel="noopener">Gen job</a>`,
    ].filter(Boolean).join(' · ');
    const section = (name, body, open = true) => (body ? `<details class="lt-sec"${open ? ' open' : ''}><summary>${name}</summary>${body}</details>` : '');
    const metrics = st?.metrics ? Object.entries(st.metrics) : [];
    const steps = (p.steps ?? []);
    const t0 = p.startedAt ?? Date.now();
    const problems = p.problems?.last ?? [];
    const consoleLast = p.console?.last ?? [];
    const failed = p.failed?.last ?? [];
    const body = `
      <div class="lt-now">
        <div><span class="pill ${live ? '' : outcomeClass(stateOf(p))}">${esc(stateOf(p))}</span> <span class="meta">${clock(elapsed(p))}${p.device === 'phone' ? ' · 📱 phone' : ''}${p.playtester ? ` · playtester ${esc(p.playtester)}` : p.host ? ` · ${esc(p.host)}` : ''}</span></div>
        <div class="lt-big-step">${esc(live ? p.step ?? '' : `${p.outcome ?? p.status}${p.seconds ? ` after ${clock(p.seconds)}` : ''}`)}</div>
        ${st?.note ? `<div class="lt-thinking" title="What the game's bot says it's doing">🤖 ${esc(st.note)}</div>` : ''}
        ${pr != null ? `<div class="lt-prog big"><span style="width:${Math.round(pr * 100)}%"></span></div>` : ''}
        <div class="meta">${links}</div>
      </div>
      ${section('Bot state', st ? `<table class="lt-kv">${[['scene', st.scene], ['status', st.status], ['progress', st.progress != null ? `${Math.round(st.progress * 100)}%` : null], ['fps', st.fps], ...metrics].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}</table>` : '')}
      ${section('Over time', sparkline(p.timeline))}
      ${section(`Problems <span class="meta">${p.problems?.count ?? 0}</span>`, problems.length ? problems.map((x) => `<div class="lt-prob ${esc(x.severity)}"><b>${esc(x.severity)}</b> ${esc(x.message)}${x.peer != null ? ` <span class="meta">player ${x.peer + 1}</span>` : ''}</div>`).join('') : '<div class="meta">none so far</div>')}
      ${section(`Steps <span class="meta">${steps.length}</span>`, steps.length ? `<ol class="lt-steps">${steps.map((s, i) => `<li class="${i === steps.length - 1 && live ? 'now' : ''}"><span class="meta">${clock((s.t - t0) / 1000)}</span> ${esc(s.text)}</li>`).join('')}</ol>` : '')}
      ${section(`Console errors <span class="meta">${p.console?.errors ?? 0}</span>`, consoleLast.length ? consoleLast.map((c) => `<pre class="lt-pre">${esc(c.text)}</pre>`).join('') : '', false)}
      ${section(`Failed requests <span class="meta">${p.failed?.count ?? 0}</span>`, failed.length ? failed.map((f) => `<div class="lt-pre">${esc(String(f.status))} ${esc(f.url)}</div>`).join('') : '', false)}
      ${section('Details', `<table class="lt-kv">${[['url', p.url], ['scenario', p.scenario?.id], ['mode', p.mode], ['recorder', p.recorder], ['load', p.loadSeconds != null ? `${p.loadSeconds} s` : null], ['job', p.job]].filter(([, v]) => v).map(([k, v]) => `<tr><td>${k}</td><td>${esc(String(v))}</td></tr>`).join('')}</table>`, false)}`;
    const side = el.querySelector('.lt-side-body');
    // Keep what J opened or closed, and the step list scrolled to the newest.
    const opened = new Map([...side.querySelectorAll('details.lt-sec')].map((d) => [d.querySelector('summary').textContent.split(' ')[0], d.open]));
    const list = side.querySelector('.lt-steps');
    const atEnd = !list || list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
    if (side.dataset.html !== body) {
      side.dataset.html = body;
      side.innerHTML = body;
      for (const d of side.querySelectorAll('details.lt-sec')) {
        const k = d.querySelector('summary').textContent.split(' ')[0];
        if (opened.has(k)) d.open = opened.get(k);
      }
      const l2 = side.querySelector('.lt-steps');
      if (l2 && atEnd) l2.scrollTop = l2.scrollHeight;
    }
  }

  // The history link opens the playtest on the history page.
  document.addEventListener('click', (e) => {
    const h = e.target.closest('[data-lt-history]');
    if (!h) return;
    e.preventDefault();
    closeBig({ push: false, keepHash: true });
    if (typeof pt !== 'undefined') pt.open = h.dataset.ltHistory;
    show('playtests');
  });

  window.openLivePlaytest = (job) => show('live', job);
  // Back and forward: #live/<job> opens it big, #live goes back to the grid.
  addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#live')) return;
    const want = /^#live\/(j_[0-9a-f]+)/.exec(location.hash)?.[1] ?? null;
    if (tab !== 'live') show('live', want ?? undefined);
    else if (want !== S.open) window.loadLiveTab();
  });
})();
