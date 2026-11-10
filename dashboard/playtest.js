// Studio's own playtest contract (docs/playtest.md, version 1): window.hawkesPlaytest for the dashboard.
// A self-contained classic script (the dashboard has no modules). Nothing runs until the runner calls start('smoke')
// or the address has ?playtest=smoke. It waits for each tab's own "studio-ready" event (app.js studioReady); it never
// polls the DOM.
(() => {
  const SCENARIOS = [{
    id: 'smoke', title: 'Every main tab loads', seconds: 40, tags: ['smoke'],
    description: 'Home, Roadmap, Backlog, Reports (opens the newest report), Changes (opens one change) and Talk: each waits for its data, with no console errors and nothing wider than the screen.',
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

  async function start(id) {
    if (status === 'running') return;
    if (id !== 'smoke') throw new Error(`unknown scenario ${id}`);
    run = fresh(id);
    errors = [];
    status = 'running';
    event('start', id);
    try {
      await smoke();
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
