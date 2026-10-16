// Guide and drive (src/guide.ts): Talk shows J around the dashboard, and works it for him when he asks. Loaded after
// app.js, talk.js, call.js and playtests.js (uses show, tab, openRun, loadReport, loadBacklog, loadChanges, loadRuns,
// openPlaytest, studioContext, api, esc). talk.js hands it the batches waiting for the conversation on screen
// (window.studioGuide.offer); it claims one, runs it here and reports each action's result.
//
// The safety rules are enforced here, whatever Talk sends:
//   - never pressed or typed into: approve, merge, deploy / go live, rollback, delete, drop, undo, the Inbox's answers,
//     Settings, budgets, limits, costs and PM switches, Talk's own controls (OFF_ATTRS, OFF_IDS, OFF_TEXT; markup can
//     also say data-guide="off"); the typed confirmations (MERGE, DEPLOY, ROLLBACK) are never typed.
//   - elements are found again right before each action (selector and/or visible text): gone, hidden, ambiguous or
//     changed under the pointer means the action is skipped and Talk is told why.
//   - J's own click, tap or key stops a batch at once; driving stays off until J writes again (a newer turn).
//
// HawkesGuide (the rules, no DOM) is also loaded by test/guide.test.ts.
var HawkesGuide = (() => {
  const DRIVE = ['click', 'type'];
  /** [attribute, value (null: any), why]: on the element or any element around it. */
  const OFF_ATTRS = [
    ['data-guide', 'off', 'marked off-limits for Talk'],
    ['data-gl', null, "going live, rollbacks and merging main into beta are J's"],
    ['data-confirm', null, "typed confirmations are J's"],
    ['data-act', 'approve', "approving a change is J's"],
    ['data-act', 'deploy', "going live is J's"],
    ['data-act', 'close', "closing a change is J's"],
    ['data-ibopt', null, "answering his Inbox is J's"],
    ['data-ibsend', null, "answering his Inbox is J's"],
    ['data-pm', null, "PM settings are J's"],
    ['data-undo', null, "undoing a decision is J's"],
    ['data-mem-del', null, "deleting is J's"],
    ['data-dev', 'keep-beta', "resolving a beta conflict is J's"],
  ];
  /** Whole areas: Talk's own controls, Settings, the costs tab's budget and alert buttons, the go-live dialog's typed box. */
  const OFF_IDS = {
    talk: "Talk's own controls are J's", talkDock: "Talk's own controls are J's", callPane: "Talk's own controls are J's", guideLayer: "Talk's own controls are J's",
    settings: "Settings (budgets, limits, PM, agents) are J's", coSettings: "budgets are J's", coAlerts: "alerts are J's", coRefresh: 'fetching costs costs money',
    glConfirm: "typed confirmations are J's",
  };
  const OFF_CLASSES = { golive: "going live and rollbacks are J's" };
  /** Words on a button, link or field that mean it is J's to press. */
  const OFF_TEXT = /\b(approve[ds]?|merge[ds]?|deploy(s|ed)?|go(ing)? live|roll ?back|delete[ds]?|drop|undo|budgets?|limits?|costs?|alerts?)\b/i;
  const CONFIRM_WORDS = /\b(MERGE|DEPLOY|ROLLBACK)\b/;
  const LABELLED = ['BUTTON', 'A', 'SUMMARY', 'LABEL', 'SELECT', 'INPUT', 'TEXTAREA', 'OPTION'];
  const TYPE_INPUTS = ['', 'text', 'search', 'number', 'email', 'url', 'tel'];

  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const attr = (el, a) => (typeof el.getAttribute === 'function' ? el.getAttribute(a) : null);
  /** The words an element shows or is named by. */
  const labelOf = (el) => [el.tagName === 'SELECT' ? el.selectedOptions?.[0]?.textContent : el.textContent, attr(el, 'aria-label'), attr(el, 'title'), el.tagName === 'INPUT' && ['button', 'submit'].includes(String(el.type)) ? el.value : '', attr(el, 'placeholder')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  /** Why Talk may not press or type into this element, or null when it may. */
  function offLimits(el) {
    for (let n = el; n; n = n.parentElement) {
      if (n.id && OFF_IDS[n.id]) return OFF_IDS[n.id];
      for (const c of Object.keys(OFF_CLASSES)) if (n.classList?.contains?.(c)) return OFF_CLASSES[c];
      for (const [a, v, why] of OFF_ATTRS) {
        const got = attr(n, a);
        if (got !== null && got !== undefined && (v === null || got === v)) return why;
      }
      // The words on the control itself (a span inside a button: the button's words).
      if ((n === el || LABELLED.includes(n.tagName)) && OFF_TEXT.test(labelOf(n))) return `"${labelOf(n).slice(0, 40)}" is J's to press`;
      if (n.tagName === 'NAV' || n.tagName === 'MAIN' || n.tagName === 'BODY') break;
    }
    return null;
  }

  /** Why this element can't take this text, or null. */
  function typeCheck(el, text) {
    if (CONFIRM_WORDS.test(String(text))) return 'the typed confirmations (MERGE, DEPLOY, ROLLBACK) are J\'s to type';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return null;
    if (el.tagName === 'INPUT' && TYPE_INPUTS.includes(String(el.type ?? '').toLowerCase())) return null;
    return `that is not a text field (${String(el.tagName).toLowerCase()}${el.type ? ` ${el.type}` : ''})`;
  }

  /** A selector Talk sent: short, no braces or markup. Null when fine. */
  function checkSelector(sel) {
    if (sel === undefined || sel === null || sel === '') return null;
    if (typeof sel !== 'string' || sel.length > 200 || /[{}<>]/.test(sel)) return "that selector isn't allowed";
    return null;
  }

  /**
   * Picks the element a target means among candidates ({ el, text, visible }): visible ones only; with text, exact
   * words first, else those containing them; the innermost of nested matches (the button, not the card around it).
   * Driving needs exactly one; guiding takes the first. Returns { el, count } or { error }.
   */
  function pick(cands, target, drive) {
    let list = cands.filter((c) => c.visible);
    if (!list.length) return { error: cands.length ? "it isn't visible on the page" : 'not found on the page' };
    if (target?.text) {
      const t = norm(target.text);
      const exact = list.filter((c) => norm(c.text) === t);
      list = exact.length ? exact : list.filter((c) => norm(c.text).includes(t));
      if (!list.length) return { error: `nothing showing "${target.text}" there` };
    }
    list = list.filter((c) => !list.some((o) => o !== c && o.el !== c.el && c.el.contains?.(o.el)));
    if (drive && list.length > 1) return { error: `${list.length} elements match: use look for a more exact selector` };
    return { el: list[0].el, count: list.length };
  }

  /** A selector that finds this element again: its id, or its data attributes. Null when it has neither. */
  function stableSelector(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const skip = ['data-full', 'data-video', 'data-media', 'data-key'];
    const data = [...(el.attributes ?? [])].filter((a) => a.name.startsWith('data-') && !skip.includes(a.name)).slice(0, 2);
    if (!data.length) return null;
    return `${String(el.tagName).toLowerCase()}${data.map((a) => `[${a.name}="${String(a.value).replace(/["\\]/g, '\\$&')}"]`).join('')}`;
  }

  return { DRIVE, OFF_TEXT, CONFIRM_WORDS, offLimits, typeCheck, checkSelector, pick, stableSelector, labelOf };
})();

if (typeof document !== 'undefined') (() => {
  const G = HawkesGuide;
  const el = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const page = Math.random().toString(36).slice(2, 10);
  const seen = new Set();
  const CLICKABLE = 'button, a, summary, select, input, textarea, label, nav button, [data-run], [data-report-run], [data-cid], [data-fid], [data-ptopen], .run-row, .test, .finding h4, .card h3, h2, h3, h4';
  const TALK = '#talkDock, #talk, #callPane, #guideLayer';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = () => matchMedia('(max-width: 1099px)').matches;

  // ------------------------------------------------------------ the layer: outline, label, pointer, banner
  const layer = document.createElement('div');
  layer.id = 'guideLayer';
  layer.innerHTML = `<div class="guide-box" hidden></div><div class="guide-label" hidden><span></span><button class="guide-x" title="Clear">×</button></div>
    <div class="guide-cursor" hidden><svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#fff" stroke="#062018" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
    <div class="guide-banner" hidden><span>🖱 Claude is driving</span><button id="guideStop" class="small">Stop</button></div>`;
  document.body.append(layer);
  const box = layer.querySelector('.guide-box');
  const label = layer.querySelector('.guide-label');
  const cursor = layer.querySelector('.guide-cursor');
  const banner = layer.querySelector('.guide-banner');

  let lit = null; // the highlighted element
  let litTimer = null;
  let run = null; // the batch running: { aborted, why }
  let stoppedAt = 0; // J took back control: no driving from turns before this
  let lastTab = null;

  function place() {
    if (!lit) return;
    if (!lit.isConnected || !visible(lit)) return clearHighlight();
    const r = lit.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    // The label above the element, else below it; always on screen.
    const lw = Math.min(label.offsetWidth || 200, innerWidth - 16);
    const lh = label.offsetHeight || 30;
    const top = r.top - lh - 10 > 4 ? r.top - lh - 10 : Math.min(r.bottom + 10, innerHeight - lh - 4);
    Object.assign(label.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - lw - 8))}px`, top: `${Math.max(4, top)}px` });
  }
  addEventListener('scroll', place, true);
  addEventListener('resize', place);

  function highlight(n, text) {
    lit = n;
    box.hidden = false;
    label.hidden = !text;
    label.querySelector('span').textContent = text ?? '';
    place();
    stripOn();
    clearTimeout(litTimer);
    litTimer = setTimeout(clearHighlight, 45_000);
  }
  function clearHighlight() {
    lit = null;
    box.hidden = true;
    label.hidden = true;
    clearTimeout(litTimer);
    if (!run) stripOff();
  }
  label.querySelector('.guide-x').addEventListener('click', clearHighlight);

  let cx = innerWidth / 2;
  let cy = innerHeight / 2;
  async function pointAt(n) {
    const r = n.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 40);
    const y = r.top + r.height / 2;
    if (cursor.hidden) { cursor.style.transition = 'none'; cursor.style.transform = `translate(${cx}px, ${cy}px)`; cursor.hidden = false; void cursor.offsetWidth; }
    cursor.style.transition = reduced ? 'none' : 'transform .45s ease-in-out';
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cx = x;
    cy = y;
    await sleep(reduced ? 80 : 500);
  }
  function pulse() {
    cursor.classList.remove('click');
    void cursor.offsetWidth;
    cursor.classList.add('click');
  }

  function driving(on) {
    banner.hidden = !on;
    document.body.classList.toggle('guide-driving', on);
    if (!on) cursor.hidden = true;
  }

  // The strip: on a phone or tablet the Talk dock shrinks while Talk shows something, so the page is visible (the
  // hold-to-talk button stays in it during a call).
  let stripTimer = null;
  function stripOn() { clearTimeout(stripTimer); document.body.classList.add('guide-on'); }
  function stripOff(ms = 4000) { clearTimeout(stripTimer); stripTimer = setTimeout(() => document.body.classList.remove('guide-on'), ms); }

  // J's own click, tap or key: the batch stops at once, and driving stays off until he writes again.
  function takeBack(e) {
    if (!e.isTrusted) return;
    if (e.type === 'keydown' && e.key === 'Escape') clearHighlight();
    if (!run && banner.hidden) return;
    stoppedAt = Date.now();
    if (run) { run.aborted = true; run.why = 'J took back control'; }
    driving(false);
  }
  for (const t of ['pointerdown', 'keydown']) addEventListener(t, takeBack, true);
  // The strip opens again with a tap on it.
  el('#talkDock').addEventListener('pointerdown', () => document.body.classList.remove('guide-on'));

  // ------------------------------------------------------------ finding elements
  const visible = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden' && !n.closest('[hidden]');
  function find(target, drive) {
    const bad = G.checkSelector(target?.selector);
    if (bad) return { error: bad };
    let nodes;
    try {
      nodes = [...document.querySelectorAll(target?.selector || CLICKABLE)];
    } catch {
      return { error: `"${target.selector}" is not a valid selector` };
    }
    nodes = nodes.filter((n) => !n.closest(TALK));
    return G.pick(nodes.map((n) => ({ el: n, text: G.labelOf(n), visible: visible(n) })), target, drive);
  }
  /** What J would call it: its words (a field: its label or placeholder), not its tooltip. */
  const name = (n) => {
    const words = (n.tagName === 'SELECT' ? n.selectedOptions[0]?.textContent : ['INPUT', 'TEXTAREA'].includes(n.tagName) ? n.closest('label')?.textContent || n.getAttribute('aria-label') || n.placeholder : n.textContent) ?? '';
    return `“${(words.replace(/\s+/g, ' ').trim() || G.labelOf(n) || n.id || n.tagName.toLowerCase()).slice(0, 50)}”`;
  };
  const tabName = (t) => el(`nav button[data-tab="${t}"]`)?.firstChild?.textContent.trim() ?? t;
  /** After the pointer moved: still the same element, still there? */
  function still(n, target, drive) {
    const again = find(target, drive);
    if (again.error) return `the page changed under it (${again.error})`;
    if (again.el !== n || !n.isConnected) return 'the page changed under it';
    return null;
  }
  async function waitFor(f, ms = 4000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v || Date.now() > end) return v;
      await sleep(100);
    }
  }

  // ------------------------------------------------------------ actions
  async function goTab(t) {
    const b = el(`nav button[data-tab="${t}"]`);
    if (!b) throw new Error(`there is no ${t} tab`);
    // Leaving the Talk tab on a phone or tablet: the chat comes along in the dock (a strip while Talk shows things).
    if (tab === 'talk' && t !== 'talk') window.talkDock?.open();
    if (tab !== t) b.click();
    lastTab = t;
    await sleep(300);
  }

  async function open(kind, id) {
    if (kind === 'report') {
      await goTab('report');
      await waitFor(() => el(`#reportRun option[value="${CSS.escape(id)}"]`));
      if (!el(`#reportRun option[value="${CSS.escape(id)}"]`)) throw new Error(`no report for run ${id}`);
      el('#reportRun').value = id;
      await loadReport();
      return { line: `Opened the report of ${el('#reportRun').selectedOptions[0]?.textContent.split(' · ').slice(0, 2).join(' · ') ?? id}`, n: el('#reportBody') };
    }
    if (kind === 'run') {
      if (!(await api(`/api/runs/${encodeURIComponent(id)}`).catch(() => null))?.id) throw new Error(`no run ${id}`);
      openRun = id;
      await goTab('runs');
      await loadRuns();
      const n = await waitFor(() => el(`[data-run="${CSS.escape(id)}"]`));
      if (!n) throw new Error(`no run ${id} in the list`);
      return { line: `Opened run ${id}`, n };
    }
    if (kind === 'change') {
      await goTab('changes');
      let n = await waitFor(() => el(`[data-cid="${CSS.escape(id)}"]`), 2500);
      if (!n) { el('#chStatus').value = ''; loadChanges.sig = null; await loadChanges(); n = el(`[data-cid="${CSS.escape(id)}"]`); }
      if (!n) throw new Error(`no change ${id}`);
      return { line: `Opened change ${id}`, n };
    }
    if (kind === 'finding') {
      await goTab('backlog');
      let n = await waitFor(() => el(`[data-fid="${CSS.escape(id)}"]`), 2500);
      if (!n) { el('#blProduct').value = ''; el('#blStatus').value = el('#blStatus option:last-child').value; await loadBacklog(); n = el(`[data-fid="${CSS.escape(id)}"]`); }
      if (!n) throw new Error(`no finding ${id}`);
      return { line: `Opened finding ${id}`, n };
    }
    if (kind === 'playtest') {
      await goTab('playtests');
      await openPlaytest(id);
      if (!el('#ptDetail .pt-title')) throw new Error(`no playtest ${id}`);
      return { line: `Opened playtest ${id}`, n: el('#ptDetail') };
    }
    throw new Error(`can't open a ${kind}`);
  }

  /** What is on J's screen for Talk: the tab, what is open, and the controls and items it could point at. */
  function look() {
    const nodes = [...document.querySelectorAll(CLICKABLE)].filter((n) => !n.closest(TALK) && !n.closest('nav') && visible(n));
    const out = [];
    for (const n of nodes) {
      if (out.length >= 80) break;
      const text = G.labelOf(n).slice(0, 70);
      if (!text && !n.id) continue;
      const sel = G.stableSelector(n);
      const off = G.offLimits(n);
      out.push({ tag: n.tagName.toLowerCase(), text, ...(sel ? { selector: sel } : {}), ...(n.value && ['SELECT', 'INPUT', 'TEXTAREA'].includes(n.tagName) && n.type !== 'password' ? { value: String(n.value).slice(0, 60) } : {}), ...(off ? { off } : {}) });
    }
    return { tab, looking: window.studioContext?.() ?? null, tabs: [...document.querySelectorAll('nav button[data-tab]')].map((b) => b.dataset.tab), device: window.callVoice?.device?.() ?? null, targets: out };
  }

  async function act(a, batch) {
    if (lastTab && tab !== lastTab) throw new Error(`J moved to the ${tabName(tab)} tab`);
    if (a.do === 'tab') { await goTab(a.tab); return { line: `Opened the ${tabName(a.tab)} tab` }; }
    if (a.do === 'open') {
      const r = await open(a.kind, a.id);
      lastTab = tab;
      r.n?.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      return { line: r.line };
    }
    if (a.do === 'clear') { clearHighlight(); return { line: 'Cleared the highlight' }; }
    if (a.do === 'look') return { line: `Looked at the ${tabName(tab)} tab`, data: look() };
    const drive = G.DRIVE.includes(a.do);
    if (drive && batch.turnAt < stoppedAt) throw new Error('J took back control: ask him before driving again');
    const f = find(a.target, drive);
    if (f.error) throw new Error(f.error);
    const n = f.el;
    if (drive) {
      const off = G.offLimits(n);
      if (off) throw new Error(`refused: ${off}`);
      if (a.do === 'type') { const bad = G.typeCheck(n, a.text); if (bad) throw new Error(bad); }
    }
    n.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    await sleep(reduced ? 50 : 350);
    if (a.do === 'scroll') return { line: `Scrolled to ${name(n)}` };
    if (a.do === 'highlight') {
      highlight(n, a.label);
      return { line: `Pointed at ${name(n)}${a.label ? `: ${a.label}` : ''}${f.count > 1 ? ` (the first of ${f.count})` : ''}` };
    }
    // Driving: the pointer goes there, then the element is found again (the page may have changed meanwhile).
    driving(true);
    stripOn();
    await pointAt(n);
    if (run?.aborted) throw new Error(run.why);
    const changed = still(n, a.target, true) ?? G.offLimits(n);
    if (changed) throw new Error(changed);
    if (a.do === 'click') {
      pulse();
      n.focus?.({ preventScroll: true });
      n.click();
      await sleep(400);
      return { line: `Clicked ${name(n)}` };
    }
    // type
    n.focus({ preventScroll: true });
    if (n.tagName === 'SELECT') {
      const want = String(a.text).trim().toLowerCase();
      const o = [...n.options].find((x) => x.value.toLowerCase() === want || x.textContent.trim().toLowerCase() === want) ?? [...n.options].find((x) => x.textContent.toLowerCase().includes(want));
      if (!o) throw new Error(`no option "${a.text}" in ${name(n)}`);
      n.value = o.value;
      n.dispatchEvent(new Event('change', { bubbles: true }));
      return { line: `Chose “${o.textContent.trim().slice(0, 40)}”${n.id ? ` in ${n.id}` : ''}` };
    }
    const text = String(a.text);
    const step = Math.max(1, Math.ceil(text.length / 25));
    n.value = '';
    for (let i = step; i < text.length + step; i += step) {
      if (run?.aborted) throw new Error(run.why);
      n.value = text.slice(0, i);
      n.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(reduced ? 0 : 30);
    }
    n.dispatchEvent(new Event('change', { bubbles: true }));
    if (a.submit) {
      n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      n.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
    return { line: `Typed “${text.slice(0, 40)}${text.length > 40 ? '…' : ''}” into ${name(n)}${a.submit ? ' and pressed Enter' : ''}` };
  }

  async function runBatch(conv, b) {
    run = { aborted: false, why: '' };
    lastTab = null;
    stripOn();
    const results = [];
    for (const a of b.actions) {
      if (run.aborted) { results.push({ ok: false, line: `Skipped ${a.do}`, error: run.why }); continue; }
      try {
        const r = await act(a, b);
        results.push({ ok: true, line: r.line, ...(r.data ? { data: r.data } : {}) });
      } catch (e) {
        results.push({ ok: false, line: `Couldn't ${a.do}${a.target?.text ? ` “${a.target.text}”` : a.target?.selector ? ` ${a.target.selector}` : a.kind ? ` ${a.kind} ${a.id}` : a.tab ? ` the ${a.tab} tab` : ''}`, error: String(e.message ?? e) });
      }
    }
    run = null;
    if (b.drive) setTimeout(() => { if (!run) driving(false); }, 1500);
    if (!lit) stripOff();
    await api(`/api/talk/${conv}/guide/${b.id}`, { method: 'POST', body: { page, results } }).catch(() => {});
  }

  let queue = Promise.resolve();
  /** talk.js: the batches waiting for the conversation on screen. A visible page claims each one; one page runs it. */
  function offer(conv, batches) {
    if (!conv || !Array.isArray(batches) || document.hidden) return;
    for (const b of batches) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      queue = queue.then(async () => {
        const r = await api(`/api/talk/${conv}/guide/${b.id}/claim`, { method: 'POST', body: { page } }).catch(() => null);
        if (r?.ok) await runBatch(conv, b);
      });
    }
  }

  el('#guideStop').addEventListener('click', () => { stoppedAt = Date.now(); if (run) { run.aborted = true; run.why = 'J pressed Stop'; } driving(false); });
  window.studioGuide = { offer, look, clear: clearHighlight };
})();
