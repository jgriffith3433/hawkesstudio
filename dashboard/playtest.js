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
    description: 'Opens the newest playtest that has a video, checks the scrubber carries markers for its findings and events, taps a finding and sees the video jump to its moment with the finding highlighted, and checks the viewer fits the screen (video full width, markers 44px, one marker per finding and event).',
  }, {
    id: 'rail', title: 'A change\'s progress rail', seconds: 30, tags: ['changes', 'rail', 'phone'],
    description: 'Opens Changes and checks every change\'s rail: all its steps listed with a time and a one-line detail on the ones reached, exactly one current step highlighted while it runs, a failed step in red with its reason, the rail and the page not scrolling sideways (390px included), and then sits idle for a few seconds to see that no request goes to the changes API on a timer (updates arrive only as /api/stream change-step events).',
  }, {
    id: 'roadmap', title: 'Roadmap: a milestone and an item', seconds: 30, tags: ['roadmap'],
    description: 'Opens Roadmap on the milestone board, opens one milestone and one item (the way a person taps them) and logs each one\'s state; every check is a pass or fail event naming the screen and the element.',
  }, {
    id: 'report', title: 'Report: the latest report and its findings', seconds: 30, tags: ['report'],
    description: 'Opens the latest report, checks it drew with its run summary, and opens its findings one by one, logging each as a pass or fail event naming the screen and element.',
  }, {
    id: 'phone-cockpit', title: 'Phone cockpit: Inbox, a card, a milestone, Talk', seconds: 45, tags: ['phone', 'cockpit'],
    description: 'At 390x844 touch: Inbox, one Inbox card, a Roadmap milestone, and the Talk input with the keyboard up. Any control under 44px or any sideways scroll fails and names the screen and element.',
  }, {
    id: 'signin', title: 'Sign-in card in a non-English browser, then Home', seconds: 30, tags: ['signin', 'phone'],
    description: 'Loads the signed-out sign-in card, checks its button is English and at least 44px tall, taps it and expects a loading state within 100ms, then confirms the test sign-in landed on Home.',
  }, {
    id: 'look', title: 'Every tab: text contrast and nothing wider than the screen', seconds: 60, tags: ['look'],
    description: 'Opens every tab; fails and names the tab and element when body text is under 4.5:1 contrast or any element is wider than the viewport.',
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
    const listed = document.querySelectorAll('#ptFlist [data-mseek]').length;
    if (listed !== marks.length) fail('Viewer', `${marks.length} markers on the scrubber but ${listed} timed findings and events in the list`);
    if (document.documentElement.scrollWidth > vw + 1) fail('Viewer', 'the page scrolls sideways');
    for (const m of marks) {
      const r = m.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) fail('Viewer', `a marker is ${Math.round(r.width)}x${Math.round(r.height)}px, smaller than a thumb can hit (44px)`);
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

  // The progress rail (dashboard/rail.js): its steps, times, details, the failed step's reason, no sideways scroll, and no timer-driven requests.
  async function rail() {
    run.scene = 'Changes';
    event('scene', 'Changes');
    errors = [];
    await ready('changes', () => openTab('changes', 'Changes'), 'Changes');
    await appears('#chList ol.rail, #chList .empty', 'the change list');
    const rails = [...document.querySelectorAll('#chList ol.rail')];
    if (!rails.length) { log('Changes: none yet, the empty page is what a person sees'); event('pass:rail', 'no changes yet'); run.progress = 1; return; }
    const vw = document.documentElement.clientWidth || innerWidth;
    let failedSeen = 0, nowSeen = 0, doneSeen = 0;
    for (const ol of rails) {
      const id = ol.dataset.rail;
      const steps = [...ol.querySelectorAll('li.rs')];
      if (steps.length < 6) fail('Rail', `change ${id}: ${steps.length} steps shown, not the whole rail`);
      if (ol.scrollWidth > ol.clientWidth + 1) fail('Rail', `change ${id}: the rail scrolls sideways (${ol.scrollWidth}px in ${ol.clientWidth}px)`);
      const current = steps.filter((li) => li.classList.contains('now'));
      if (current.length > 1) fail('Rail', `change ${id}: ${current.length} steps highlighted as current`);
      if (current.length) nowSeen++;
      for (const li of steps) {
        const label = li.querySelector('.rs-head b')?.textContent.trim();
        if (!label) fail('Rail', `change ${id}: a step has no name`);
        if (li.classList.contains('done') && !li.querySelector('time')) log(`${id}: "${label}" is done but has no time (an older change)`);
        if (li.classList.contains('failed')) {
          const why = li.querySelector('.rs-detail')?.textContent.trim();
          if (!why) fail('Rail', `change ${id}: failed step "${label}" shows no reason`);
          const c = parseColor(getComputedStyle(li).color);
          if (!c || c[0] < 150 || c[1] > 140) fail('Rail', `change ${id}: failed step "${label}" is not red`);
          failedSeen++;
          event('failed-step', `${id}: ${label}: ${why.slice(0, 80)}`);
        }
        if (li.classList.contains('done')) doneSeen++;
      }
      if (steps.length === 8 && !steps.every((li) => li.classList.contains('todo') || li.querySelector('.rs-detail'))) log(`${id}: a reached step has no detail yet`);
    }
    if (document.documentElement.scrollWidth > vw + 1) fail('Rail', `the page scrolls sideways (${document.documentElement.scrollWidth}px on a ${vw}px screen)`);
    const wide = tooWide(document.getElementById('changes'));
    if (wide.length) fail('Rail', `wider than the screen: ${wide.join('; ')}`);
    event('pass:rail', `${rails.length} rails, ${doneSeen} steps done, ${nowSeen} running, ${failedSeen} failed, ${vw}px wide`);
    run.metrics.rails = rails.length; run.metrics.failedSteps = failedSeen; run.metrics.doneSteps = doneSeen;
    run.progress = 0.6;
    // Idle: no request to the changes API unless a stream event asked for it (a timer would show up here).
    const seen = [];
    run.streamEvents = 0;
    if (typeof studioStream !== 'undefined') studioStream.on(['change-step', 'changes', 'runs', 'builds'], () => { if (run) run.streamEvents = (run.streamEvents ?? 0) + 1; });
    const po = typeof PerformanceObserver === 'function' ? new PerformanceObserver((l) => { for (const e of l.getEntries()) if (/\/api\/changes(\/|\?|$)/.test(e.name)) seen.push(e.name); }) : null;
    try { po?.observe({ type: 'resource', buffered: false }); } catch { /* no resource timing */ }
    const before = performance.now();
    await sleep(5000);
    po?.disconnect();
    const evt = run.streamEvents ?? 0;
    if (seen.length && !evt) fail('Rail', `${seen.length} request(s) to the changes API in 5 idle seconds with no stream event: ${seen[0]}`);
    run.metrics.idleRequests = seen.length;
    event('pass:no-timer-requests', `${seen.length} change requests in ${Math.round(performance.now() - before)}ms idle`);
    run.progress = 1;
  }


  // ---- Scenarios that end in a pass or fail, with one logged event per check naming its screen and element ----
  const MIN_TOUCH = 44;
  const vwNow = () => document.documentElement.clientWidth || innerWidth;
  const nameOf = (el) => {
    const label = (el.getAttribute?.('aria-label') || el.title || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : cls}${label ? ` "${label}"` : ''}`;
  };
  // Every check is one event: pass:<scenario>:<screen> or fail:<scenario>:<screen>, its detail naming the element.
  let checks = [];
  function check(screen, element, ok, detail) {
    const type = `${ok ? 'pass' : 'fail'}:${run.id}:${screen}`;
    event(type, `${element}: ${detail}`);
    if (!ok) checks.push(`${screen}: ${element}: ${detail}`);
    return ok;
  }
  function finish() {
    run.metrics.checks = run.events.filter((e) => /^(pass|fail):/.test(e.type)).length;
    run.metrics.failedChecks = checks.length;
    event(`result:${run.id}`, checks.length ? `fail (${checks.length}): ${checks[0]}` : 'pass');
    if (checks.length) throw new TabFailure(`${checks.length} check(s) failed. First: ${checks.slice(0, 3).join(' | ')}`);
    run.progress = 1;
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  };
  // Controls a thumb has to hit, smaller than 44px either way (a checkbox inside a label counts through its label).
  function smallControls(root) {
    const bad = [];
    for (const el of root.querySelectorAll('button, a[href], select, summary, textarea, input:not([type=hidden]), [role=button]')) {
      if (el.disabled || !visible(el)) continue;
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.closest('label')) continue; }
      const r = el.getBoundingClientRect();
      if (r.width < MIN_TOUCH || r.height < MIN_TOUCH) bad.push(`${nameOf(el)} is ${Math.round(r.width)}x${Math.round(r.height)}px`);
    }
    return bad;
  }
  const sideways = () => document.documentElement.scrollWidth > vwNow() + 1;
  const sidewaysWords = () => `the page is ${document.documentElement.scrollWidth}px wide on a ${vwNow()}px screen`;

  async function roadmap() {
    await ready('roadmap', () => openTab('roadmap', 'Roadmap'), 'Roadmap');
    run.scene = 'Roadmap';
    event('scene', 'Roadmap');
    const view = document.getElementById('rmView');
    if (view && view.value !== 'board') { view.value = 'board'; view.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(100);
    await appears('#rmBoard .rm-col, #rmList .finding[data-item], #rmList .empty', 'the milestone board');
    const board = document.getElementById('roadmap');
    check('Roadmap', '#rmView', view?.value === 'board', `view is "${view?.value}"`);
    const ms = document.querySelector('#rmBoard .rm-col');
    if (!ms) check('Roadmap', '#rmBoard', true, 'no milestones yet, the empty board is what a person sees');
    else {
      ms.scrollIntoView?.({ block: 'center' });
      const title = ms.querySelector('h3')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
      const state = ms.querySelector('.pill')?.textContent.trim() ?? '';
      const progress = ms.querySelector('.status-line')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
      check('Roadmap', `milestone ${title.slice(0, 40)}`, Boolean(title && state && progress), `state "${state}", ${progress || 'no progress line'}`);
      const details = ms.querySelector('details > summary');
      if (details) { details.click(); check('Roadmap', `milestone ${title.slice(0, 40)} details`, details.parentElement.open, details.parentElement.open ? 'opened' : 'would not open'); }
      run.metrics.milestones = document.querySelectorAll('#rmBoard .rm-col').length;
    }
    const item = document.querySelector('#rmList .finding[data-item]');
    if (!item) check('Roadmap', '#rmList', true, 'no items yet, the empty list is what a person sees');
    else {
      item.scrollIntoView?.({ block: 'center' });
      const title = item.querySelector('h4')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) ?? '';
      const state = item.querySelector('h4 .pill')?.textContent.trim() ?? '';
      check('Roadmap', `item ${title}`, Boolean(title && state), `state "${state}", ${item.querySelector('.status-line')?.textContent.replace(/\s+/g, ' ').trim() || 'no status line'}`);
      const sum = item.querySelector('details.more-details > summary');
      if (sum) { sum.click(); check('Roadmap', `item ${title.slice(0, 40)} details`, sum.parentElement.open, sum.parentElement.open ? 'opened' : 'would not open'); }
      run.metrics.items = document.querySelectorAll('#rmList .finding[data-item]').length;
    }
    const wide = tooWide(board);
    check('Roadmap', '#roadmap', !wide.length && !sideways(), wide.length ? wide.join('; ') : sideways() ? sidewaysWords() : `fits ${vwNow()}px`);
    if (errors.length) check('Roadmap', 'console', false, errors.slice(0, 2).join(' | '));
    finish();
  }

  async function report() {
    await ready('report', () => openTab('report', 'Reports'), 'Reports');
    run.scene = 'Report';
    event('scene', 'Report');
    const sel = document.getElementById('reportRun');
    const first = sel?.querySelector('option');
    if (!first) { check('Report', '#reportRun', true, 'no runs yet, the empty page is what a person sees'); return finish(); }
    if (sel.value !== first.value) await ready('report', () => { sel.value = first.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }, 'Reports');
    const body = document.getElementById('reportBody');
    check('Report', '#reportRun', true, `latest report ${first.textContent.trim().slice(0, 50)}`);
    check('Report', '#reportBody', Boolean(body?.children.length && body.textContent.trim().length > 20), body?.children.length ? 'the report drew' : 'the report did not draw');
    const findings = [...(body?.querySelectorAll('.finding') ?? [])];
    run.metrics.findings = findings.length;
    if (!findings.length) check('Report', '.finding', true, 'the latest report has no findings');
    for (const f of findings.slice(0, 5)) {
      const title = f.querySelector('h4, b')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) ?? '';
      check('Report', `finding ${title}`, Boolean(title), title ? `${f.querySelector('.pill')?.textContent.trim() || 'no severity'}` : 'a finding has no title');
    }
    const sum = body?.querySelector('details.more-details > summary');
    if (sum) { sum.click(); check('Report', 'details', sum.parentElement.open, sum.parentElement.open ? 'opened' : 'would not open'); }
    const wide = tooWide(document.getElementById('report'));
    check('Report', '#report', !wide.length && !sideways(), wide.length ? wide.join('; ') : sideways() ? sidewaysWords() : `fits ${vwNow()}px`);
    if (errors.length) check('Report', 'console', false, errors.slice(0, 2).join(' | '));
    finish();
  }

  async function phoneCockpit() {
    const vw = vwNow();
    check('Phone', 'viewport', vw <= 480, `${vw}px wide${vw <= 480 ? '' : ' (this scenario is for a 390x844 phone)'}`);
    // One screen: its controls (44px) and no sideways scroll, named.
    const screen = (name, root) => {
      const small = smallControls(root);
      check(name, 'controls', !small.length, small.length ? `${small.length} under ${MIN_TOUCH}px: ${small.slice(0, 3).join('; ')}` : `every control is at least ${MIN_TOUCH}px`);
      const wide = tooWide(root);
      check(name, 'page', !sideways() && !wide.length, wide.length ? wide.join('; ') : sideways() ? sidewaysWords() : `no sideways scroll at ${vw}px`);
    };
    run.scene = 'Inbox';
    event('scene', 'Inbox');
    openTab('inbox', 'Inbox');
    await appears('#ibList .ib-card, #ibList .empty, #ibList .meta', 'the Inbox list');
    await sleep(400);
    screen('Inbox', document.getElementById('inbox'));
    const card = document.querySelector('#ibList .ib-card');
    if (!card) check('Inbox card', '.ib-card', true, 'nothing waiting, the empty Inbox is what a person sees');
    else {
      card.scrollIntoView?.({ block: 'center' });
      const sum = card.querySelector('details > summary');
      if (sum) { sum.click(); await sleep(150); }
      screen('Inbox card', card);
    }
    run.scene = 'Roadmap milestone';
    event('scene', 'Roadmap milestone');
    await ready('roadmap', () => openTab('roadmap', 'Roadmap'), 'Roadmap');
    const view = document.getElementById('rmView');
    if (view && view.value !== 'board') { view.value = 'board'; view.dispatchEvent(new Event('change', { bubbles: true })); }
    await appears('#rmBoard .rm-col, #rmList .finding[data-item], #rmList .empty', 'the milestone board');
    const ms = document.querySelector('#rmBoard .rm-col');
    if (!ms) check('Roadmap milestone', '.rm-col', true, 'no milestones yet');
    else { ms.scrollIntoView?.({ block: 'center' }); screen('Roadmap milestone', ms); }
    run.scene = 'Talk';
    event('scene', 'Talk');
    await ready('talk', () => openTab('talk', 'Talk'), 'Talk');
    const input = document.getElementById('talkInput');
    if (!input) check('Talk', '#talkInput', false, 'the message box is missing');
    else {
      input.focus();
      await sleep(400); // the keyboard rises and talk.js moves the box (visualViewport)
      const r = input.getBoundingClientRect();
      const vv = window.visualViewport;
      const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
      check('Talk', '#talkInput', r.top >= 0 && r.bottom <= bottom + 1, `box spans ${Math.round(r.top)}-${Math.round(r.bottom)}px, visible area ends at ${Math.round(bottom)}px`);
      const send = document.getElementById('talkSend')?.getBoundingClientRect();
      check('Talk', '#talkSend', Boolean(send && send.bottom <= bottom + 1 && send.top >= 0), send ? `Send spans ${Math.round(send.top)}-${Math.round(send.bottom)}px` : 'the Send button is missing');
      screen('Talk', document.getElementById('talk'));
      input.blur();
    }
    if (errors.length) check('Phone', 'console', false, errors.slice(0, 2).join(' | '));
    finish();
  }

  // The signed-out card is a page of its own (auth-pages.ts), so it is fetched with no cookies and drawn in a frame at this
  // screen's width; its Google button is stood in for (the real one is Google's, in its own frame).
  async function signin() {
    run.scene = 'Sign-in card';
    event('scene', 'Sign-in card');
    const lang = navigator.language || 'en';
    event('locale', `browser language ${lang}`);
    if (/^en/i.test(lang)) run.problems.push({ severity: 'warning', message: `the browser language is ${lang}: run this in a non-English browser to prove the card stays English` });
    const res = await fetch('/auth/signin?next=%2F', { credentials: 'omit', headers: { 'Accept-Language': 'de-DE,de;q=0.9' } });
    const htmlText = await res.text();
    check('Sign-in card', '/auth/signin', res.ok && /<h1>Sign in<\/h1>/.test(htmlText), `HTTP ${res.status}${/<h1>Sign in<\/h1>/.test(htmlText) ? ', "Sign in" card' : ', not the sign-in card'}`);
    check('Sign-in card', 'html[lang]', /<html lang="en"/.test(htmlText), 'the card says it is English (lang="en")');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.style.cssText = `position:fixed;left:0;top:0;width:${vwNow()}px;height:${innerHeight}px;border:0;opacity:0.01;pointer-events:none`;
    frame.srcdoc = htmlText.replace(/<script src="https:\/\/accounts\.google\.com[^>]*><\/script>/, '');
    const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
    document.body.appendChild(frame);
    try {
      await loaded;
      const w = frame.contentWindow, d = frame.contentDocument;
      const tap = d.querySelector('.g-tap');
      if (tap && typeof w.hsGoogle === 'function') {
        w.google = { accounts: { id: { initialize() {}, renderButton(el) { el.innerHTML = '<div role="button" style="height:40px">Continue with Google</div>'; } } } };
        w.hsGoogle();
      }
      const buttons = [...d.querySelectorAll('button')].filter((b) => !b.hidden && b.getBoundingClientRect().height > 0);
      const targets = [...(tap ? [tap] : []), ...buttons];
      check('Sign-in card', 'button', targets.length > 0, targets.length ? `${targets.length} sign-in control(s)` : 'no sign-in button on the card');
      for (const el of targets) {
        const r = el.getBoundingClientRect();
        const label = (el.textContent || '').replace(/\s+/g, ' ').trim();
        check('Sign-in card', nameOf(el), r.height >= MIN_TOUCH, `${Math.round(r.width)}x${Math.round(r.height)}px${r.height >= MIN_TOUCH ? '' : `, under ${MIN_TOUCH}px`}`);
        if (label) check('Sign-in card', `${nameOf(el)} text`, /^[\x20-\x7E…’']+$/.test(label), `"${label.slice(0, 40)}" ${/^[\x20-\x7E…’']+$/.test(label) ? 'is English' : 'is not English'}`);
      }
      check('Sign-in card', 'page', d.documentElement.scrollWidth <= vwNow() + 1, `card ${d.documentElement.scrollWidth}px in ${vwNow()}px`);
      // Tap, and the loading state must be showing within 100ms.
      const busy = d.getElementById('gbusy');
      const form = d.querySelector('form');
      let tapped, shown;
      if (tap && busy) {
        tapped = performance.now();
        tap.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true }));
        shown = !busy.hidden;
      } else if (form) {
        form.addEventListener('submit', (e) => e.preventDefault(), true);
        tapped = performance.now();
        form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        const b = form.querySelector('button[type=submit]');
        shown = Boolean(b?.disabled);
      }
      if (tapped === undefined) check('Sign-in card', 'loading state', false, 'nothing on the card can be tapped');
      else {
        await new Promise((r) => w.requestAnimationFrame(() => r()));
        const ms = Math.round(performance.now() - tapped);
        const nowShown = tap && busy ? !busy.hidden : Boolean(form?.querySelector('button[type=submit]')?.disabled);
        run.metrics.loadingMs = ms;
        check('Sign-in card', tap && busy ? '#gbusy' : 'button[type=submit]', (shown || nowShown) && ms <= 100, `${shown || nowShown ? 'loading state shown' : 'no loading state'} ${ms}ms after the tap`);
      }
    } finally { frame.remove(); }
    // The runner signed in with the test sign-in before the page opened: it must have landed on Home.
    run.scene = 'Home';
    event('scene', 'Home');
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.ok, () => false);
    check('Home', 'test sign-in', me, me ? 'signed in as the test account' : 'the session is not signed in');
    await ready('home', () => openTab('home', 'Home'), 'Home');
    check('Home', '#homeGames', document.getElementById('home')?.classList.contains('on') && Boolean(document.getElementById('homeGames')), 'Home opened after the test sign-in');
    finish();
  }

  // Colours with alpha, in the forms the browser gives back (rgb(), rgba(), color(srgb ...)).
  function rgba(str) {
    if (!str) return null;
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/.exec(str);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4])];
    const c = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?/.exec(str);
    if (c) return [Number(c[1]) * 255, Number(c[2]) * 255, Number(c[3]) * 255, c[4] === undefined ? 1 : c[4].endsWith('%') ? parseFloat(c[4]) / 100 : Number(c[4])];
    const p = parseColor(str);
    return p ? [...p, 1] : null;
  }
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  function backdrop(el) {
    const layers = [];
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const c = rgba(getComputedStyle(p).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let bg = [255, 255, 255];
    if (!layers.length || layers[layers.length - 1][3] < 1) bg = rgba(getComputedStyle(document.body).backgroundColor)?.slice(0, 3) ?? [255, 255, 255];
    for (const l of layers.reverse()) bg = over(l, bg);
    return bg;
  }
  // Text that has words of its own, shown, with its worst contrast against what is behind it.
  function lowContrast(root) {
    const bad = [];
    let seen = 0;
    for (const el of root.querySelectorAll('*')) {
      if (['SCRIPT', 'STYLE', 'SVG', 'PATH', 'OPTION', 'CANVAS', 'VIDEO', 'IMG'].includes(el.tagName.toUpperCase())) continue;
      if (!el.childNodes) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own || !visible(el)) continue;
      if (el.disabled || el.closest?.('[disabled], [aria-disabled=true]')) continue;
      const cs = getComputedStyle(el);
      const fg = rgba(cs.color);
      if (!fg) continue;
      let opacity = 1;
      for (let p = el; p && p.nodeType === 1; p = p.parentElement) opacity *= Number(getComputedStyle(p).opacity || 1);
      const bg = backdrop(el);
      const text = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
      const ratio = contrastRatio(text.map(Math.round), bg.map(Math.round));
      seen++;
      if (ratio < 4.5) bad.push({ ratio, what: `${nameOf(el)} ${ratio}:1` });
    }
    bad.sort((a, b) => a.ratio - b.ratio);
    return { bad, seen };
  }

  async function look() {
    const buttons = [...document.querySelectorAll('nav button[data-tab]')].filter((b) => !b.hidden && !b.closest('[hidden]') && !b.disabled);
    const tabs = [...new Set(buttons.map((b) => b.dataset.tab))].filter((t) => document.getElementById(t) && document.getElementById(t).dataset.guide !== 'off');
    run.metrics.tabs = tabs.length;
    let n = 0;
    for (const tab of tabs) {
      const name = navButton(tab)?.textContent.replace(/\s+/g, ' ').trim().replace(/\d+$/, '').trim() || tab;
      run.scene = name;
      event('scene', name);
      errors = [];
      try {
        const sec = document.getElementById(tab);
        if (sec) delete sec.dataset.ready;
        if (['home', 'backlog', 'report', 'changes', 'talk', 'roadmap'].includes(tab)) await ready(tab, () => openTab(tab, name), name);
        else { openTab(tab, name); await sleep(700); }
      } catch (e) {
        check(name, `#${tab}`, false, e.message);
        continue;
      }
      await sleep(200);
      const section = document.getElementById(tab);
      if (!section.classList.contains('on')) { check(name, `#${tab}`, false, 'the tab did not open'); continue; }
      const wide = tooWide(section);
      check(name, `#${tab}`, !wide.length && !sideways(), wide.length ? `wider than the screen: ${wide.join('; ')}` : sideways() ? sidewaysWords() : `nothing wider than ${vwNow()}px`);
      const { bad, seen } = lowContrast(section);
      check(name, `#${tab} text`, !bad.length, bad.length ? `${bad.length} of ${seen} text elements under 4.5:1: ${bad.slice(0, 3).map((b) => b.what).join('; ')}` : `${seen} text elements all at least 4.5:1`);
      run.progress = ++n / tabs.length;
    }
    finish();
  }

  async function start(id) {
    if (status === 'running') return;
    if (!SCENARIOS.some((x) => x.id === id)) throw new Error(`unknown scenario ${id}`);
    run = fresh(id);
    errors = [];
    checks = [];
    status = 'running';
    event('start', id);
    try {
      await ({ viewer, rail, roadmap, report, 'phone-cockpit': phoneCockpit, signin, look }[id] ?? smoke)();
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
