// Studio's own playtest contract (docs/playtest.md, version 1): window.hawkesPlaytest for the dashboard.
// A self-contained classic script (the dashboard has no modules). Nothing runs until the runner calls start('smoke')
// or the address has ?playtest=smoke. It waits for each tab's own "studio-ready" event (app.js studioReady); it never
// polls the DOM.
(() => {
  const SCENARIOS = [{
    id: 'smoke', title: 'Every main tab loads', seconds: 40, tags: ['smoke'],
    description: 'Home, Roadmap, Backlog, Reports (opens the newest report), Changes (opens one change) and Talk: each waits for its data, with no console errors and nothing wider than the screen.',
  }, {
    id: 'viewer', title: 'Playtest viewer: markers and seeking', seconds: 40, tags: ['viewer'],
    description: 'Opens the newest playtest that has a video, checks the scrubber carries markers for its findings and events, taps a finding and sees the video jump to its moment with the finding highlighted, and checks the viewer fits the screen (video full width, touch targets 44px high).',
  }];
  const READY_TIMEOUT_MS = 20000;
  const t0 = () => Date.now();
  let run = null;
  let status = 'idle';

  const fresh = (id) => ({ id, started: t0(), outcome: undefined, metrics: { tabsPassed: 0 }, events: [], problems: [], log: [], scene: undefined, progress: 0, note: undefined, stopped: false });
  const secs = () => (run ? (t0() - run.started) / 1000 : 0);
  const event = (type, detail) => run.events.push({ t: Math.round(secs() * 10) / 10, type, detail });
  const log = (line) => { run.log.push(line); if (run.log.length > 60) run.log.shift(); };

  // Console errors, uncaught errors and rejected promises while a run is under way.
  let errors = [];
  const origError = console.error;
  console.error = function (...a) {
    if (run && status === 'running') errors.push(a.map((x) => (x && x.message) || String(x)).join(' ').slice(0, 200));
    return origError.apply(this, a);
  };
  addEventListener('error', (e) => { if (run && status === 'running') errors.push(`${e.message || 'error'}`.slice(0, 200)); });
  addEventListener('unhandledrejection', (e) => { if (run && status === 'running') errors.push(`unhandled: ${e.reason?.message ?? e.reason}`.slice(0, 200)); });

  class TabFailure extends Error {}
  const fail = (tab, why) => { throw new TabFailure(`${tab}: ${why}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Resolves on the tab's studio-ready event (or rejects with its error, or after one timeout).
  function ready(tab, act, name = tab) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { removeEventListener('studio-ready', on); clearTimeout(timer); fn(v); };
      const on = (e) => {
        if (e.detail?.tab !== tab) return;
        if (e.detail.error) done(reject, new TabFailure(`${name}: its data failed to load (${e.detail.error})`));
        else done(resolve);
      };
      const timer = setTimeout(() => done(reject, new TabFailure(`${name}: its data was not ready after ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS);
      addEventListener('studio-ready', on);
      act();
    });
  }

  const navButton = (tab) => document.querySelector(`nav button[data-tab="${tab}"]`);
  // Report and Changes sit under More: open the menu the way a person does, then click.
  function openTab(tab, name) {
    const btn = navButton(tab);
    if (!btn) fail(name, `no "${tab}" button in the navigation`);
    if (btn.closest('#moreMenu') && document.querySelector('#moreMenu')?.hidden) document.querySelector('#moreBtn')?.click();
    btn.click();
  }

  // Anything in the tab that sticks out past the right edge of the screen, outside a box that scrolls on purpose.
  function tooWide(section) {
    const vw = document.documentElement.clientWidth || innerWidth;
    const bad = [];
    for (const el of section.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= vw + 1) continue;
      let skip = false;
      for (let p = el; p && p !== section.parentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' || (p !== el && /(auto|scroll|hidden)/.test(cs.overflowX))) { skip = true; break; }
      }
      if (!skip) bad.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} ends at ${Math.round(r.right)}px of ${vw}px`);
      if (bad.length >= 3) break;
    }
    return bad;
  }

  function verify(tab, name) {
    if (errors.length) fail(name, `console errors: ${errors.slice(0, 3).join(' | ')}`);
    const section = document.getElementById(tab);
    if (!section) fail(name, 'its section is missing');
    if (!section.classList.contains('on')) fail(name, 'it did not open');
    const wide = tooWide(section);
    if (wide.length) fail(name, `wider than the screen: ${wide.join('; ')}`);
  }

  function parseColor(str) {
    if (!str) return null;
    const s = str.trim();
    if (s.startsWith('#')) {
      const hex = s.length === 4 ? s.slice(1).split('').map((c) => c + c).join('') : s.slice(1, 7);
      const n = parseInt(hex, 16);
      return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function contrastRatio(a, b) {
    const lum = (rgb) => {
      const [r, g, bl] = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const l1 = lum(a), l2 = lum(b);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  }

  async function verifyThemesAndScale(tab, name) {
    const root = document.documentElement;
    const cs0 = getComputedStyle(root);
    if (typeof cs0?.getPropertyValue !== 'function') return;
    const prev = root.dataset ? root.dataset.theme : undefined;
    const ratios = {};
    for (const theme of ['dark', 'light']) {
      if (root.dataset) root.dataset.theme = theme;
      await sleep(60);
      const cs = getComputedStyle(root);
      const surf = parseColor(cs.getPropertyValue('--surface'));
      const txt = parseColor(cs.getPropertyValue('--text'));
      const muted = parseColor(cs.getPropertyValue('--text-muted'));
      if (surf && txt && muted) {
        const tc = contrastRatio(txt, surf);
        const mc = contrastRatio(muted, surf);
        if (tc < 4.5 || mc < 4.5) fail(name, `${theme} theme contrast too low (text ${tc}:1, muted ${mc}:1)`);
        ratios[theme] = { text: tc, muted: mc };
      }
      verify(tab, name);
    }
    const cs = getComputedStyle(root);
    const scale = ['--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl'].map((k) => parseFloat(cs.getPropertyValue(k)));
    if (scale.every((n) => Number.isFinite(n))) {
      for (let i = 1; i < scale.length; i++) {
        if (!(scale[i] > scale[i - 1])) fail(name, `type scale not stepping monotonically: ${scale.join(' -> ')}`);
      }
      event(`type-scale:${tab}`, `${scale.join('px -> ')}px`);
    }
    if (ratios.dark && ratios.light) {
      event(`theme:${tab}`, `dark ${ratios.dark.text}:1 (muted ${ratios.dark.muted}:1), light ${ratios.light.text}:1 (muted ${ratios.light.muted}:1)`);
      log(`${name}: dark (${ratios.dark.text}:1) & light (${ratios.light.text}:1) themes coherent, 6-step type scale (${scale.join('/')}px), layout ok at ${root.clientWidth || innerWidth}px`);
    }
    if (root.dataset) {
      if (prev === undefined) delete root.dataset.theme;
      else root.dataset.theme = prev;
    }
  }

  async function step(name, tab, act, extra) {
    if (run.stopped) throw new TabFailure('stopped');
    errors = [];
    run.scene = name;
    event('scene', name);
    run.note = `opening ${name}`;
    const sec = document.getElementById(tab);
    if (sec) delete sec.dataset.ready;
    await ready(tab, act, name);
    if (extra) await extra();
    await sleep(150); // a frame or two for the render to paint before the screenshot
    verify(tab, name);
    await verifyThemesAndScale(tab, name);
    run.metrics.tabsPassed += 1;
    run.progress = run.metrics.tabsPassed / 6;
    event(`pass:${tab}`, name);
    log(`${name}: pass`);
  }

  // Reports: pick the newest report in the list, the way a person does, and wait for it to draw.
  async function openNewestReport() {
    const sel = document.getElementById('reportRun');
    const first = sel?.querySelector('option');
    if (!first) { log('Reports: no runs yet, the empty page is what a person sees'); return; }
    if (!document.getElementById('reportBody')?.children.length) fail('Reports', 'the newest report did not draw');
    if (sel.value !== first.value) {
      await ready('report', () => { sel.value = first.value; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    }
    event('report-opened', first.value);
  }

  // Changes: open one change's details with a click.
  async function openOneChange() {
    const row = document.querySelector('#chList .finding[data-cid]');
    if (!row) { log('Changes: none yet, the empty page is what a person sees'); return; }
    const sum = row.querySelector('details.more-details > summary') || row.querySelector('summary');
    if (!sum) fail('Changes', 'a change has no details to open');
    sum.click();
    const d = sum.parentElement;
    if (!d.open) fail('Changes', 'a change would not open');
    event('change-opened', row.dataset.cid);
  }

  async function smoke() {
    await step('Home', 'home', () => openTab('home', 'Home'));
    await step('Roadmap', 'roadmap', () => openTab('roadmap', 'Roadmap'));
    await step('Backlog', 'backlog', () => openTab('backlog', 'Backlog'));
    await step('Reports', 'report', () => openTab('report', 'Reports'), openNewestReport);
    await step('Changes', 'changes', () => openTab('changes', 'Changes'), openOneChange);
    await step('Talk', 'talk', () => openTab('talk', 'Talk'));
  }

  // Resolves when the selector matches (watching the DOM for changes, never on a timer), or fails after READY_TIMEOUT_MS.
  function appears(sel, what, root = document) {
    return new Promise((resolve, reject) => {
      const hit = () => root.querySelector(sel);
      if (hit()) return resolve(hit());
      const mo = new MutationObserver(() => { if (hit()) { mo.disconnect(); clearTimeout(timer); resolve(hit()); } });
      const timer = setTimeout(() => { mo.disconnect(); reject(new TabFailure(`${what} did not appear after ${READY_TIMEOUT_MS / 1000}s`)); }, READY_TIMEOUT_MS);
      mo.observe(root.body ?? root, { childList: true, subtree: true });
    });
  }

  async function viewer() {
    run.scene = 'Playtests list';
    event('scene', 'Playtests list');
    openTab('playtests', 'Playtests');
    await appears('#ptList .pt-row', 'the playtest list');
    const rows = [...document.querySelectorAll('#ptList .pt-row')];
    if (!rows.length) { log('Playtests: none yet, the empty page is what a person sees'); return; }
    // The newest with a video (its row ends with the play mark).
    const row = rows.find((r) => r.querySelector('.pt-when')?.textContent.includes('▶'));
    if (!row) { log('Playtests: none has a video yet'); return; }
    run.scene = 'Playtest viewer';
    event('scene', 'Playtest viewer');
    row.click();
    await appears('#ptScrub', 'the scrubber under the video');
    const video = document.getElementById('ptVideo');
    const vw = document.documentElement.clientWidth || innerWidth;
    const box = video.getBoundingClientRect();
    if (vw <= 480 && box.width < vw * 0.85) fail('Viewer', `the video is ${Math.round(box.width)}px wide on a ${vw}px screen, not full width`);
    event('pass:video-width', `${Math.round(box.width)}px of ${vw}px`);
    const marks = [...document.querySelectorAll('#ptScrub .pt-mark')];
    const findings = marks.filter((m) => m.classList.contains('finding'));
    const events = marks.filter((m) => m.classList.contains('event'));
    run.metrics.markers = marks.length;
    event('pass:markers', `${findings.length} finding marks, ${events.length} event marks`);
    for (const m of marks) {
      const r = m.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) fail('Viewer', 'a marker is smaller than a thumb can hit (24px)');
    }
    const item = document.querySelector('#ptFlist .pt-fitem[data-mseek]:not(.ev)');
    if (!item) { log('Viewer: this playtest has no timed findings, markers for events only'); event('pass:viewer', 'no findings to tap'); return; }
    const small = [...document.querySelectorAll('#ptFlist .pt-fitem')].find((b) => b.getBoundingClientRect().height < 40);
    if (small) fail('Viewer', 'a finding row is under 40px high, too small to tap');
    const want = Number(item.dataset.mseek);
    const seeked = new Promise((r) => { video.addEventListener('seeked', r, { once: true }); setTimeout(r, 5000); });
    item.click();
    await seeked;
    if (Math.abs(video.currentTime - Math.max(0, want - 0.5)) > 1.5 && video.readyState > 0) fail('Viewer', `tapping a finding at ${want}s left the video at ${video.currentTime.toFixed(1)}s`);
    if (!item.classList.contains('on')) fail('Viewer', 'the tapped finding was not highlighted');
    event('pass:seek', `finding at ${want}s, video at ${video.currentTime.toFixed(1)}s`);
    const over = tooWide(document.getElementById('ptDetail'));
    if (over.length) fail('Viewer', `sticks out past the screen: ${over.join('; ')}`);
    event('pass:fits', `${vw}px`);
    run.metrics.tabsPassed = 1;
    run.progress = 1;
  }

  async function start(id) {
    if (status === 'running') return;
    if (id !== 'smoke' && id !== 'viewer') throw new Error(`unknown scenario ${id}`);
    run = fresh(id);
    errors = [];
    status = 'running';
    event('start', id);
    try {
      await (id === 'viewer' ? viewer() : smoke());
      run.outcome = 'done';
      status = 'done';
      event('end', 'done');
    } catch (e) {
      if (e instanceof TabFailure && e.message === 'stopped') { run.outcome = 'done'; status = 'done'; return; }
      const msg = e?.message ?? String(e);
      run.outcome = 'error';
      status = 'error';
      run.note = msg;
      run.problems.push({ severity: 'bug', message: msg });
      event('tab-failed', msg);
      log(`FAILED ${msg}`);
    }
  }

  window.hawkesPlaytest = {
    version: 1,
    product: 'hawkesstudio',
    scenarios: () => SCENARIOS.map((s) => ({ ...s })),
    start,
    state: () => ({
      ready: Boolean(document.querySelector('nav button[data-tab]')) && typeof window.studioReady === 'function',
      status,
      scene: run?.scene,
      progress: run?.progress,
      metrics: run ? { ...run.metrics } : undefined,
      note: run?.note,
    }),
    report: () => ({
      scenario: run?.id ?? 'smoke',
      outcome: run?.outcome ?? 'error',
      seconds: Math.round(secs() * 10) / 10,
      metrics: run ? { ...run.metrics } : {},
      events: run?.events ?? [],
      problems: run?.problems ?? [],
      log: run?.log ?? [],
    }),
    stop() { if (run) run.stopped = true; },
  };

  const auto = new URLSearchParams(location.search).get('playtest');
  if (auto) addEventListener('load', () => start(auto).catch(() => {}));
})();
