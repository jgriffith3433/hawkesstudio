// Hawkes Studio: the "report a bug" button on the beta sites (https://<sub>.hawkesgen.com/, behind Studio's login).
// previews.ts puts it into every HTML page it publishes, with a tiny console hook at the top of <head>; it is never in a
// product repo or a live site. Served by the product's /dev/ front door as /dev/__studio/report.js (dev-front.ts);
// reports go to POST /dev/__studio/report (src/bugreport.ts), which makes them findings with source "J".
//
// The button is a small dot on the right edge (drag it up or down; "hide" shrinks it to a sliver). Tapping it takes the
// screenshot first (the moment J saw it), then opens the panel: type, or hold the mic to talk (the browser's speech
// recognition, where there is one), then send. Events inside it never reach the game.
(() => {
  if (window.__hawkesReport) return;
  try { if (window.top !== window) return; } catch { return; }
  window.__hawkesReport = true;
  const me = document.currentScript;
  let cfg = {};
  try { cfg = JSON.parse((me && me.getAttribute('data-hawkes')) || '{}'); } catch {}
  const ENDPOINT = '/dev/__studio/report';
  const H2C = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hawkesReport.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hawkesReport.' + k, JSON.stringify(v)); } catch {} },
  };

  // Console: the early hook (window.__hawkesLog, put at the top of <head>) catches what happens before this loads.
  const log = (window.__hawkesLog = window.__hawkesLog || []);
  if (!window.__hawkesLogHooked) {
    window.__hawkesLogHooked = true;
    const push = (level, args) => { try { log.push({ level, at: Date.now(), text: [...args].map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 400) }); if (log.length > 60) log.splice(0, log.length - 60); } catch {} };
    for (const level of ['error', 'warn']) { const o = console[level]; console[level] = function (...a) { push(level, a); return o.apply(this, a); }; }
    addEventListener('error', (e) => push('error', [e.message || 'error', e.filename ? `${e.filename}:${e.lineno}` : '']));
    addEventListener('unhandledrejection', (e) => push('error', ['unhandled rejection:', e.reason]));
  }

  // ------------------------------------------------------------- the button
  const host = document.createElement('div');
  host.setAttribute('data-hawkes-report', '');
  host.style.cssText = 'position:fixed;right:0;z-index:2147483646;top:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  :host { all: initial; }
  * { box-sizing: border-box; font: 14px/1.35 system-ui, -apple-system, Segoe UI, sans-serif; }
  .dot { position: fixed; right: 6px; width: 38px; height: 38px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
    background: #c62f3c; color: #fff; font-size: 18px; box-shadow: 0 2px 8px #0007; opacity: .55; touch-action: none; user-select: none; -webkit-user-select: none; }
  .dot:hover, .dot:focus-visible { opacity: 1; }
  .dot.hidden { width: 9px; height: 34px; right: 0; border-radius: 6px 0 0 6px; font-size: 0; opacity: .45; }
  .panel { position: fixed; right: 8px; width: min(360px, calc(100vw - 16px)); background: #16181d; color: #e9ecf1; border-radius: 12px;
    box-shadow: 0 6px 28px #000a; padding: 12px; display: none; max-height: calc(100vh - 16px); overflow: auto; }
  .panel.open { display: block; }
  .row { display: flex; gap: 8px; align-items: center; }
  .top { justify-content: space-between; margin-bottom: 8px; }
  .top b { font-weight: 600; }
  .x { background: none; border: 0; color: #9aa3b2; font-size: 20px; cursor: pointer; padding: 0 4px; }
  textarea { width: 100%; min-height: 84px; resize: vertical; border-radius: 8px; border: 1px solid #333a46; background: #0e1014; color: #e9ecf1; padding: 8px; font-size: 16px; }
  .shot { position: relative; margin: 8px 0; }
  .shot img { max-width: 100%; max-height: 120px; border-radius: 6px; display: block; border: 1px solid #333a46; }
  .shot button { position: absolute; top: 4px; left: 4px; background: #000a; color: #fff; border: 0; border-radius: 6px; font-size: 12px; padding: 2px 6px; cursor: pointer; }
  .btn { border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; background: #2a303b; color: #e9ecf1; font-weight: 600; }
  .send { background: #3b82f6; color: #fff; flex: 1; }
  .mic { flex: 1; touch-action: none; user-select: none; -webkit-user-select: none; }
  .mic.on { background: #c62f3c; color: #fff; }
  .btn:disabled { opacity: .5; cursor: default; }
  label { display: flex; gap: 6px; align-items: center; color: #9aa3b2; font-size: 13px; margin: 8px 0; }
  .msg { margin-top: 8px; font-size: 13px; color: #9aa3b2; min-height: 1em; white-space: pre-wrap; }
  .msg.ok { color: #7ee2a1; } .msg.err { color: #ff8b8b; }
  .foot { margin-top: 6px; display: flex; justify-content: space-between; font-size: 12px; color: #6b7382; }
  .foot a { color: #9aa3b2; cursor: pointer; text-decoration: underline; }
  </style>
  <button class="dot" title="Report a bug (Hawkes Studio, beta only)" aria-label="Report a bug">🐞</button>
  <div class="panel" role="dialog" aria-label="Report a bug">
    <div class="row top"><b>Report a bug</b><button class="x" aria-label="Close">×</button></div>
    <textarea placeholder="What's wrong? (what you did, what you expected)"></textarea>
    <div class="shot"></div>
    <label><input type="checkbox" class="block"> It blocks me (can't go on)</label>
    <div class="row"><button class="btn mic" type="button">🎙 Hold to talk</button><button class="btn send" type="button">Send</button></div>
    <div class="msg"></div>
    <div class="foot"><span class="info"></span><a class="hide">hide button</a></div>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const dot = $('.dot'), panel = $('.panel'), ta = $('textarea'), shotBox = $('.shot'), msg = $('.msg'), send = $('.send'), mic = $('.mic');
  $('.info').textContent = [cfg.ref, cfg.sha].filter(Boolean).join(' ') || 'beta';

  // Nothing typed or tapped in here reaches the game (its listeners are on window/document).
  for (const t of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'touchmove', 'wheel', 'contextmenu']) {
    host.addEventListener(t, (e) => e.stopPropagation());
  }

  let top = store.get('top', 0.42);
  let hidden = store.get('hidden', false);
  const place = () => {
    const y = Math.round(Math.max(8, Math.min(innerHeight - 46, top * innerHeight)));
    dot.style.top = y + 'px';
    dot.classList.toggle('hidden', hidden);
    const ph = panel.offsetHeight || 300;
    panel.style.top = Math.max(8, Math.min(innerHeight - ph - 8, y - 40)) + 'px';
  };
  addEventListener('resize', place);

  // Drag up and down the edge (a move of more than 6px is a drag, not a tap).
  let drag = null;
  dot.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, moved: false }; dot.setPointerCapture(e.pointerId); });
  dot.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
    if (drag.moved) { top = Math.max(0, Math.min(1, (e.clientY - 19) / innerHeight)); place(); }
  });
  dot.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.moved) return store.set('top', top);
    if (hidden) { hidden = false; store.set('hidden', false); place(); return; }
    if (panel.classList.contains('open')) close(); else open();
  });
  dot.addEventListener('pointercancel', () => { drag = null; });
  $('.x').onclick = () => close();
  $('.hide').onclick = () => { close(); hidden = true; store.set('hidden', true); place(); };

  // ------------------------------------------------------------ screenshot
  let shot = null;
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const toJpeg = (src, w, h) => {
    const k = Math.min(1, 1280 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    // A WebGL canvas read at the wrong moment is all one color: no screenshot then.
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let same = true;
    for (let i = 4; i < px.length && same; i += 4 * 97) same = px[i] === px[0] && px[i + 1] === px[1] && px[i + 2] === px[2] && px[i + 3] === px[3];
    return same ? null : c.toDataURL('image/jpeg', 0.72);
  };
  const loadH2c = () => window.html2canvas ? Promise.resolve(window.html2canvas) : new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = H2C;
    s.onload = () => ok(window.html2canvas);
    s.onerror = bad;
    document.head.appendChild(s);
  });
  async function capture() {
    // A canvas game: its biggest visible canvas, read right after the game draws (our frame callback runs after its).
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ c, r: c.getBoundingClientRect() })).filter((x) => x.c.width && x.c.height && area(x.r) > 0).sort((a, b) => area(b.r) - area(a.r));
    let frame = null;
    let game = null;
    if (canvases[0] && area(canvases[0].r) >= 0.25 * innerWidth * innerHeight) {
      game = canvases[0].c;
      frame = await new Promise((ok) => requestAnimationFrame(() => { try { ok(toJpeg(game, game.width, game.height)); } catch { ok(null); } }));
    }
    // The page as J sees it (html2canvas, loaded only now), with the game's frame in place of its canvas (a WebGL
    // canvas reads blank outside its frame), so HUDs and menus drawn in HTML are in the picture too.
    try {
      const h2c = await loadH2c();
      if (game) game.setAttribute('data-hawkes-shot', '');
      const late = new Promise((ok) => setTimeout(() => ok(null), 6000)); // a heavy page: the game's frame alone
      const c = await Promise.race([late, h2c(document.body, {
        logging: false, useCORS: true, x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, scale: Math.min(devicePixelRatio || 1, 1280 / innerWidth),
        ignoreElements: (el) => el === host,
        onclone: (doc) => {
          const cv = doc.querySelector('canvas[data-hawkes-shot]');
          if (!cv || !frame) return;
          const img = doc.createElement('img');
          img.src = frame;
          img.style.cssText = cv.style.cssText;
          img.className = cv.className;
          const r = game.getBoundingClientRect();
          img.style.width = r.width + 'px';
          img.style.height = r.height + 'px';
          cv.replaceWith(img);
        },
      })]);
      return (c && toJpeg(c, c.width, c.height)) || frame;
    } catch { return frame; } finally { if (game) game.removeAttribute('data-hawkes-shot'); }
  }
  const showShot = () => {
    shotBox.innerHTML = '';
    if (!shot) { shotBox.textContent = ''; return; }
    const img = document.createElement('img');
    img.src = shot;
    img.alt = 'screenshot';
    const rm = document.createElement('button');
    rm.textContent = 'remove';
    rm.onclick = () => { shot = null; showShot(); };
    shotBox.append(img, rm);
  };

  async function open() {
    msg.className = 'msg';
    msg.textContent = 'Taking a screenshot…';
    shot = await capture();
    showShot();
    msg.textContent = shot ? '' : 'No screenshot (sending without one).';
    panel.classList.add('open');
    place();
    if (!matchMedia('(pointer: coarse)').matches) ta.focus();
  }
  function close() { panel.classList.remove('open'); stopMic(); }

  // ------------------------------------------------------------ hold to talk
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let base = '';
  if (!SR) mic.style.display = 'none';
  const startMic = (e) => {
    e.preventDefault();
    if (!SR || rec) return;
    try {
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
      rec.onresult = (ev) => { let s = ''; for (const r of ev.results) s += r[0].transcript; ta.value = base + s; };
      rec.onerror = (ev) => { msg.className = 'msg err'; msg.textContent = `Speech: ${ev.error}`; };
      rec.onend = () => { rec = null; mic.classList.remove('on'); mic.textContent = '🎙 Hold to talk'; };
      rec.start();
      mic.classList.add('on');
      mic.textContent = '🎙 Listening… let go when done';
    } catch (err) { rec = null; msg.className = 'msg err'; msg.textContent = String(err.message || err); }
  };
  const stopMic = () => { if (rec) try { rec.stop(); } catch {} };
  mic.addEventListener('pointerdown', (e) => { try { mic.setPointerCapture(e.pointerId); } catch {} startMic(e); });
  for (const t of ['pointerup', 'pointercancel']) mic.addEventListener(t, stopMic);

  // ------------------------------------------------------------------ send
  const json = (v, n) => { try { const s = JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; } catch { return null; } };
  send.onclick = async () => {
    stopMic();
    const text = ta.value.trim();
    if (!text && !shot) { msg.className = 'msg err'; msg.textContent = 'Say what is wrong first.'; return; }
    send.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    const pt = window.hawkesPlaytest;
    let state = null, report = null;
    try { if (pt && typeof pt.state === 'function') state = json(pt.state(), 4000); } catch (err) { state = `state() threw: ${err.message || err}`; }
    try { if (pt && typeof pt.report === 'function') report = json(pt.report(), 4000); } catch (err) { report = `report() threw: ${err.message || err}`; }
    const body = {
      text, blocker: $('.block').checked, url: location.href, title: document.title, shot,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      device: { ua: navigator.userAgent, touch: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints || 0,platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform, lang: navigator.language },
      console: log.slice(-25), state, report, build: cfg,
    };
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
      msg.className = 'msg ok';
      msg.textContent = `${out.message || 'Got it.'}\n${out.id || ''}`;
      ta.value = '';
      $('.block').checked = false;
      shot = null;
      showShot();
      setTimeout(() => { if (!ta.value) close(); }, 3500);
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = `Not sent: ${err.message || err}. Your text is still here; try again.`;
    } finally { send.disabled = false; }
  };

  const mount = () => { (document.body || document.documentElement).appendChild(host); place(); };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
})();
