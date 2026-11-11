// Hawkes playtest UI probe v1: is every control big enough, reachable, clear of the notch, on screen, and does a press
// answer? Source of truth: hawkesstudio/clients/web/hawkes-ui.js (copy next to hawkes-playtest.js). Spec: docs/playtest.md#ui.
//
// Web games get it through installPlaytest (hawkes-playtest.js) on a touch or phone-sized page (`ui: false` turns it off,
// `ui: { always: true }` runs it on desktop too). It reads the DOM's controls (buttons, links, inputs, [role=button],
// [onclick], [data-ui]) and pushes events (never polled): `ui-layout` (every control's problems at this viewport) and
// `ui-press` (a press, and whether anything changed on screen within 100 ms). Studio (src/ui.ts) adds the sound check from the
// audio probe's events (no sound start within 150 ms = silent) and turns the rest into ui.* metrics and findings.
// The UI KIT (createUiKit, below) is the drop-in that makes a game's menus feel alive: pressed, hover and focus states, a ui-bus
// click on every press (through the sound kit when there is one), 150-200 ms screen slides (0 ms with reduced motion) and safe-area
// containers. It announces each press and transition to the probe, which logs them: exactly one `ui-press` per press.
// Canvas and WebGL games have no DOM controls: give the rects with t.ui([{ id, label, x, y, w, h }]) and each press with
// t.uiPress(label, { changed: true }) (docs/playtest.md#ui).

export const UI_VERSION = 1;

export const UI_DEFAULTS = {
  minTarget: 44,        // CSS px (Apple HIG 44 pt; Material is 48 dp)
  minGap: 8,            // px between neighbouring controls
  visualMs: 100,        // a press with no visual change inside this is dead
  // Simulated safe areas (iPhone 15-class): the notch / Dynamic Island on top in portrait or on the left in landscape, the home bar below.
  insets: {
    portrait: { top: 47, right: 0, bottom: 34, left: 0 },
    landscape: { top: 0, right: 47, bottom: 21, left: 47 },
  },
};

const r1 = (n) => Math.round(n * 10) / 10;
const ri = (n) => Math.round(n);

/**
 * Pure: the problems in a list of control rects at a viewport. rects: [{ id, label, x, y, w, h, fixed? }]. `docH` is the
 * page height (a control below the fold of a scrolling page is reachable by scrolling, so only a fixed control is checked
 * against the viewport's bottom). Returns issues { kind: small|spacing|reach|inset|offscreen, id, label, rect, detail }.
 */
export function analyzeRects(rects, { width, height, insets, minTarget = UI_DEFAULTS.minTarget, minGap = UI_DEFAULTS.minGap, docH } = {}) {
  const portrait = height >= width;
  const inset = insets ?? UI_DEFAULTS.insets[portrait ? 'portrait' : 'landscape'];
  const issues = [];
  const issue = (c, kind, detail) => issues.push({ kind, id: c.id, label: c.label, rect: [ri(c.x), ri(c.y), ri(c.w), ri(c.h)], detail });
  // Thumb reach: from the bottom corners, a thumb sweeps about 0.66 of the screen height in portrait, 0.45 of the width in landscape.
  const reach = portrait ? 0.66 * height : 0.45 * width;
  const maxY = docH && docH > height ? docH : height;
  for (const c of rects) {
    const right = c.x + c.w;
    const bottom = c.y + c.h;
    const offX = c.x < -1 || right > width + 1;
    const offY = c.fixed || c.y < -1 ? c.y < -1 || bottom > height + 1 : bottom > maxY + 1;
    if (offX || offY) {
      const which = [c.x < -1 && 'left', right > width + 1 && 'right', c.y < -1 && 'top', (c.fixed || c.y >= -1) && bottom > (c.fixed ? height : maxY) + 1 && 'bottom'].filter(Boolean).join('/');
      issue(c, 'offscreen', `runs off the ${which} edge of the ${width}x${height} screen`);
      continue;
    }
    if (c.w < minTarget || c.h < minTarget) issue(c, 'small', `is ${r1(c.w)}x${r1(c.h)} px, under the ${minTarget} px minimum`);
    // Under a simulated inset: only what is fixed to the screen's edge matters (scrolling content moves out from under it).
    if (c.fixed) {
      const hit = [c.y < inset.top && 'the notch', bottom > height - inset.bottom && 'the home bar', c.x < inset.left && 'the left inset', right > width - inset.right && 'the right inset'].filter(Boolean);
      if (hit.length) issue(c, 'inset', `sits under ${hit.join(' and ')} (safe area top ${inset.top}, bottom ${inset.bottom}, left ${inset.left}, right ${inset.right} px)`);
      const cx = c.x + c.w / 2; const cy = c.y + c.h / 2;
      const d = Math.min(Math.hypot(cx, height - cy), Math.hypot(width - cx, height - cy));
      if (d > reach) issue(c, 'reach', `is ${ri(d)} px from the nearest bottom corner, outside the thumb zone (${ri(reach)} px)`);
    }
  }
  // Spacing: neighbours closer than minGap that don't overlap by design (a gap of 0 or less between siblings is a stacked or nested control, skipped).
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]; const b = rects[j];
      const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      const gap = Math.max(gx, gy);
      if (gap > 0 && gap < minGap && Math.min(gx, gy) < 0) issue(a, 'spacing', `is ${r1(gap)} px from "${b.label}" (under ${minGap} px)`);
    }
  }
  return issues;
}

const CONTROL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [onclick], [data-ui], [tabindex]:not([tabindex="-1"])';

function labelOf(el) {
  const t = (el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.value || el.getAttribute?.('alt') || el.getAttribute?.('data-ui') || '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 40);
  const img = el.querySelector?.('img[alt]');
  if (img?.alt) return img.alt.slice(0, 40);
  return el.id ? `#${el.id}` : `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/)[0]}` : ''}>`;
}
function idOf(el, label) {
  const parts = [];
  for (let n = el, d = 0; n && n.nodeType === 1 && d < 3; n = n.parentElement, d++) {
    parts.unshift(n.id ? `#${n.id}` : n.tagName.toLowerCase());
    if (n.id) break;
  }
  return `${parts.join('>')}|${label}`.slice(0, 120);
}

function visible(el, win) {
  const cs = win.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none' || Number(cs.opacity) < 0.05) return false;
  if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}
function fixedOrSticky(el, win) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const p = win.getComputedStyle(n).position;
    if (p === 'fixed' || p === 'sticky') return true;
  }
  return false;
}
function inScroller(el, win) {
  for (let n = el.parentElement; n && n !== win.document.body && n !== win.document.documentElement; n = n.parentElement) {
    const cs = win.getComputedStyle(n);
    if (/(auto|scroll)/.test(`${cs.overflowX} ${cs.overflowY}`) && (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1)) return true;
  }
  return false;
}

/**
 * The controls of a document as rects. Hidden ones are left out. A control inside a scroll container that is clipped by it is reachable by
 * scrolling, so it is left out of the offscreen check (its size still counts). The hit area is the control's own box (a link with a larger
 * padded or ::before area reports that box, as the browser lays it out).
 */
export function collectDomRects(win = window) {
  const doc = win.document;
  const out = [];
  const seen = new Set();
  // A page that doesn't scroll is a screen: what sits at its edges is fixed to them (and sits under the notch or home bar).
  const pageScrolls = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0) > win.innerHeight + 1;
  for (const el of doc.querySelectorAll(CONTROL)) {
    if (!visible(el, win)) continue;
    // A label wrapping an input, or an input inside a button: the outer control is the target.
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const label = labelOf(el);
    let id = idOf(el, label);
    if (seen.has(id)) id = `${id}#${seen.size}`;
    seen.add(id);
    let { left: x, top: y, width: w, height: h } = r;
    const scroller = inScroller(el, win);
    const fixed = fixedOrSticky(el, win) || (!pageScrolls && !scroller);
    if (scroller && !fixed) {
      // Clip the rect to the viewport horizontally for the offscreen check; size stays what it is.
      const cx = Math.max(0, Math.min(x, win.innerWidth - Math.min(w, win.innerWidth)));
      out.push({ id, label, x: cx, y: Math.max(0, Math.min(y, Math.max(0, win.innerHeight - h))), w, h, fixed: false });
    } else out.push({ id, label, x, y, w, h, fixed });
  }
  return out;
}

/** Draws every problem control's outline and name over the page for `ms` (what the review's screenshot shows). */
export function outlineIssues(issues, win = window, ms = 1500) {
  try {
    const doc = win.document;
    const host = doc.createElement('div');
    host.setAttribute('data-hawkes-ui-overlay', '1');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const colour = { small: '#ff2d55', inset: '#ff9500', offscreen: '#af52de', spacing: '#ffcc00', reach: '#5ac8fa' };
    for (const i of issues) {
      const [x, y, w, h] = i.rect;
      const box = doc.createElement('div');
      box.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${Math.max(w, 6)}px;height:${Math.max(h, 6)}px;border:2px solid ${colour[i.kind] ?? '#ff2d55'};box-sizing:border-box;border-radius:3px;`;
      const tag = doc.createElement('span');
      tag.textContent = `${i.kind}: ${i.label}`;
      tag.style.cssText = `position:absolute;left:0;top:100%;white-space:nowrap;font:10px/1.2 sans-serif;color:#fff;background:${colour[i.kind] ?? '#ff2d55'};padding:1px 3px;`;
      box.appendChild(tag);
      host.appendChild(box);
    }
    doc.body.appendChild(host);
    setTimeout(() => host.remove(), ms);
  } catch {}
}

const isOverlay = (n) => !!(n?.closest?.('[data-hawkes-ui-overlay]') || n?.parentElement?.closest?.('[data-hawkes-ui-overlay]'));

/**
 * The probe. emit(type, detailObject) pushes a run event; now() is the run clock in seconds; scene() the current scene name.
 * Returns { layout, press, stop, metrics }.
 */
export function startUiProbe({ emit = () => {}, now = () => 0, scene = () => undefined, win = typeof window !== 'undefined' ? window : null, thresholds = {} } = {}) {
  if (!win?.document) return { layout() { return null; }, press() {}, stop() {}, metrics: () => ({}), info: () => ({ adapter: 'none' }) };
  const th = { ...UI_DEFAULTS, ...thresholds };
  const doc = win.document;
  const state = { layouts: 0, presses: 0, dead: 0, canvas: new Map(), stopped: false };
  const orientation = () => (win.innerHeight >= win.innerWidth ? 'portrait' : 'landscape');

  /** One layout check at the current viewport. `rects` instead of the DOM for canvas games. Emits `ui-layout`. */
  function layout({ rects, source, outline = true, label } = {}) {
    if (state.stopped) return null;
    const width = win.innerWidth; const height = win.innerHeight;
    const list = rects ?? collectDomRects(win);
    const docH = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
    const o = width > height ? 'landscape' : 'portrait';
    const issues = analyzeRects(list, { width, height, minTarget: th.minTarget, minGap: th.minGap, docH, insets: th.insets?.[o] });
    const reportable = issues.filter((i) => i.kind === 'small' || i.kind === 'inset' || i.kind === 'offscreen');
    const outlined = outline && reportable.length > 0 && !rects;
    if (outlined) outlineIssues(reportable, win);
    state.layouts++;
    const detail = { orientation: o, viewport: [width, height], insets: th.insets?.[o], scene: label ?? scene(), controls: list.length, issues, outlined, source: source ?? (rects ? 'rects' : 'dom') };
    emit('ui-layout', detail);
    return detail;
  }

  // ----- presses -------------------------------------------------------------------------------------------------------
  // A press is a pointerdown (touch or mouse) or a key activation on a control. The screen "answers" when a DOM mutation outside
  // the probe's own overlay, or a change in the control's (or its ancestors') computed look, shows up before visualMs.
  const LOOK = ['backgroundColor', 'color', 'transform', 'opacity', 'boxShadow', 'filter', 'outlineColor', 'borderColor', 'scale', 'translate'];
  const look = (el) => {
    const parts = [];
    for (let n = el, d = 0; n && n.nodeType === 1 && d < 3; n = n.parentElement, d++) {
      const cs = win.getComputedStyle(n);
      parts.push(LOOK.map((k) => cs[k]).join('|'), n.className);
    }
    return parts.join('~');
  };
  let pending = [];
  const mo = typeof win.MutationObserver === 'function' ? new win.MutationObserver((list) => {
    const real = list.some((m) => !isOverlay(m.target) && !(m.type === 'attributes' && m.attributeName === 'style' && m.target === doc.documentElement));
    if (!real) return;
    const t = performance.now();
    for (const p of pending) if (p.visualAt == null) p.visualAt = t;
  }) : null;
  try { mo?.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}

  function begin(el, labelText, idText, rect) {
    const p = { el, label: labelText, id: idText, rect, t: now(), t0: performance.now(), visualAt: null, before: el ? look(el) : null, orientation: orientation(), scene: scene(), done: false };
    pending.push(p);
    // Sample the control's look every frame inside the window (a :active style is back to normal on release).
    const sample = () => {
      if (p.done) return;
      if (p.visualAt == null && p.el && p.el.isConnected && look(p.el) !== p.before) p.visualAt = performance.now();
      if (p.visualAt == null && performance.now() - p.t0 < th.visualMs + 30) (win.requestAnimationFrame ?? ((f) => setTimeout(f, 16)))(sample);
    };
    sample();
    setTimeout(() => settle(p), th.visualMs + 40);
    return p;
  }
  function settle(p, forced) {
    if (p.done) return;
    p.done = true;
    pending = pending.filter((x) => x !== p);
    const ms = p.visualAt != null ? Math.round(p.visualAt - p.t0) : null;
    const visual = forced != null ? forced : ms != null && ms <= th.visualMs;
    state.presses++;
    if (!visual) state.dead++;
    emit('ui-press', { t: p.t, id: p.id, label: p.label, orientation: p.orientation, scene: p.scene, visual, visualMs: forced != null ? 0 : ms, rect: p.rect });
  }
  /** A press the game reports itself (canvas controls): changed says whether the screen answered. */
  function press(labelText, { changed, ms, rect } = {}) {
    if (state.stopped) return;
    const p = { label: String(labelText).slice(0, 80), id: `ui|${labelText}`.slice(0, 120), rect, t: now(), t0: performance.now(), orientation: orientation(), scene: scene(), done: true, visualAt: null };
    state.presses++;
    const visual = changed !== false && (ms == null || ms <= th.visualMs);
    if (!visual) state.dead++;
    emit('ui-press', { t: p.t, id: p.id, label: p.label, orientation: p.orientation, scene: p.scene, visual, visualMs: ms ?? (visual ? 0 : null), rect });
  }

  const target = (e) => {
    const n = e.target;
    if (!n || n.nodeType !== 1) return null;
    const el = n.closest?.(CONTROL);
    return el && !isOverlay(el) ? el : null;
  };
  const onDown = (e) => {
    if (win.__hawkesUiKit) return; // the kit logs its own presses (one ui-press per press)
    const el = target(e);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const labelText = labelOf(el);
    begin(el, labelText, idOf(el, labelText), [ri(r.left), ri(r.top), ri(r.width), ri(r.height)]);
  };
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') onDown(e); };
  const opts = { capture: true, passive: true };
  doc.addEventListener('pointerdown', onDown, opts);
  doc.addEventListener('keydown', onKey, opts);
  // The kit (createUiKit) announces its presses and screen transitions as 'hawkes-ui' window events; they become run events.
  const onKit = (e) => {
    const d = e?.detail;
    if (state.stopped || !d) return;
    if (d.type === 'press') {
      state.presses++;
      if (!d.visual) state.dead++;
      emit('ui-press', { t: now(), id: d.id, label: d.label, orientation: orientation(), scene: scene(), visual: !!d.visual, visualMs: d.visualMs, rect: d.rect, kit: true });
    } else if (d.type === 'transition') {
      state.transitions = (state.transitions ?? 0) + 1;
      emit('ui-transition', { t: now(), from: d.from, to: d.to, ms: d.ms, plannedMs: d.plannedMs, reduced: !!d.reduced, scene: scene() });
    }
  };
  win.addEventListener?.('hawkes-ui', onKit);

  return {
    layout, press,
    stop() {
      state.stopped = true;
      try { mo?.disconnect(); } catch {}
      doc.removeEventListener('pointerdown', onDown, opts);
      doc.removeEventListener('keydown', onKey, opts);
      win.removeEventListener?.('hawkes-ui', onKit);
      for (const p of pending.slice()) settle(p);
    },
    metrics: () => ({ 'ui.layouts': state.layouts, 'ui.presses': state.presses }),
    info: () => ({ adapter: 'dom', orientation: orientation(), viewport: [win.innerWidth, win.innerHeight] }),
  };
}

/**
 * The other orientation, for a runner that plays one viewport: loads this page in an off-screen frame at the swapped size
 * (a landscape 844x390 for a 390x844 phone) and reads its controls. Only the page's first screen shows (the frame never
 * starts a playtest or plays the game). Resolves to a `ui-layout` detail, or null (cross-origin, no frame, timed out).
 */
export async function layoutOtherOrientation({ win = window, emit = () => {}, scene = () => undefined, thresholds = {}, settleMs = 2500 } = {}) {
  const doc = win.document;
  const width = win.innerHeight; const height = win.innerWidth; // swapped
  const th = { ...UI_DEFAULTS, ...thresholds };
  return new Promise((resolve) => {
    let frame;
    const finish = (v) => { try { frame?.remove(); } catch {} resolve(v); };
    try {
      frame = doc.createElement('iframe');
      const u = new URL(win.location.href);
      u.searchParams.delete('playtest');
      u.searchParams.set('hawkes-ui-frame', '1');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;border:0;visibility:hidden;pointer-events:none;`;
      frame.src = u.href;
      frame.onload = () => setTimeout(() => {
        try {
          const w = frame.contentWindow;
          const o = width > height ? 'landscape' : 'portrait';
          const list = collectDomRects(w);
          const docH = Math.max(w.document.documentElement?.scrollHeight ?? 0, w.document.body?.scrollHeight ?? 0);
          const issues = analyzeRects(list, { width, height, minTarget: th.minTarget, minGap: th.minGap, docH, insets: th.insets?.[o] });
          const detail = { orientation: o, viewport: [width, height], insets: th.insets?.[o], scene: scene(), controls: list.length, issues, outlined: false, source: 'frame' };
          emit('ui-layout', detail);
          finish(detail);
        } catch { finish(null); }
      }, settleMs);
      frame.onerror = () => finish(null);
      doc.body.appendChild(frame);
      setTimeout(() => finish(null), settleMs + 6000);
    } catch { finish(null); }
  });
}

// ====================================================================================================================
// The UI kit: pressed / hover / focus states, a UI-bus sound on every press, screen transitions, safe-area containers.
// Spec: docs/playtest.md#ui-kit; how to use it: the ui-kit skill (docs/ui-kit-skill.md); the Unity twin is HawkesUI.cs.
//
//   import { createUiKit } from './hawkes-ui.js';
//   const ui = createUiKit({ sound });                 // sound: the sound kit (hawkes-sound.js); without it one is loaded for you
//   // markup: <main class="hawkes-safe"><section data-ui-screen="menu">...<button class="hawkes-btn">Play</button></section>
//   //         <section data-ui-screen="options" hidden>...</section></main>
//   await ui.show('options');                          // slides 180 ms (150-200), instantly with prefers-reduced-motion
//   await ui.show('menu', { dir: 'back' });
// ====================================================================================================================

export const UI_KIT_VERSION = 1;
export const TRANSITION_MS = { min: 150, max: 200, default: 180 };
const KIT_CONTROL = 'button, a[href], [role=button], [role=tab], [role=menuitem], input[type=button], input[type=submit], summary, [data-hawkes-ui]';

/** The transition length in ms: clamped to 150-200, and 0 when the player asks for reduced motion. */
export function transitionMs(ms = TRANSITION_MS.default, reduced = false) {
  if (reduced) return 0;
  const n = Number(ms);
  return Math.min(TRANSITION_MS.max, Math.max(TRANSITION_MS.min, Number.isFinite(n) ? Math.round(n) : TRANSITION_MS.default));
}

/** The simulated notch and home bar for a viewport (what the probe checks fixed controls against). */
export function simulatedInsets(width, height) {
  return UI_DEFAULTS.insets[height >= width ? 'portrait' : 'landscape'];
}

/** The kit's stylesheet. :where() keeps its specificity at zero so a game's own CSS always wins. */
export function kitCss() {
  return `
:where(.hawkes-btn, [data-hawkes-ui]:not([data-hawkes-ui=off])){min-width:44px;min-height:44px;box-sizing:border-box;touch-action:manipulation;-webkit-tap-highlight-color:transparent;cursor:pointer;
  transition:transform 70ms ease-out,filter 90ms ease-out,box-shadow 90ms ease-out,background-color 90ms ease-out}
:where(.hawkes-stack){display:flex;flex-direction:column;gap:8px}
:where(.hawkes-row){display:flex;flex-direction:row;flex-wrap:wrap;gap:8px}
:where(.hawkes-safe){box-sizing:border-box;padding-top:var(--hawkes-safe-top,0px);padding-right:var(--hawkes-safe-right,0px);padding-bottom:var(--hawkes-safe-bottom,0px);padding-left:var(--hawkes-safe-left,0px)}
:where(.hawkes-safe-fixed){position:fixed;inset:0;overflow:hidden}
@media (hover:hover){:where(.hawkes-btn,[data-hawkes-ui]):not([disabled]):hover{filter:brightness(1.12);transform:translateY(-1px)}}
:where(.hawkes-btn,[data-hawkes-ui],button,a[href],[role=button]):focus-visible{outline:3px solid #ffd45a;outline-offset:2px}
:where(.hawkes-btn,[data-hawkes-ui],button,a[href],[role=button])[data-hawkes-pressed]{transform:scale(.95);filter:brightness(.88);box-shadow:inset 0 2px 6px rgba(0,0,0,.35)}
@media (prefers-reduced-motion:reduce){:where(.hawkes-btn,[data-hawkes-ui]){transition:none}:where(.hawkes-btn,[data-hawkes-ui],button,a[href],[role=button])[data-hawkes-pressed]{transform:none}}
[data-ui-screen][hidden]{display:none!important}
`;
}

/**
 * Make the kit. opts: { sound (the sound kit), win, durationMs (150-200, default 180), simulateInsets (default: on when the page
 * is a playtest), css (false to skip the stylesheet) }. Returns { show, current, press, safeArea, state, dispose }.
 */
export function createUiKit(opts = {}) {
  const win = opts.win ?? (typeof window !== 'undefined' ? window : null);
  const doc = win?.document;
  const kit = { presses: [], transitions: [] };
  if (!doc) return { ...kit, show: async () => null, current: () => null, press() {}, safeArea() {}, state: () => kit, dispose() {} };
  const now = () => (win.performance ?? performance).now();
  const emit = (detail) => { try { win.dispatchEvent(new win.CustomEvent('hawkes-ui', { detail })); } catch {} };
  const reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const cleanups = [];
  win.__hawkesUiKit = true; // the probe leaves DOM presses to the kit

  // ---- the stylesheet, viewport-fit=cover, safe-area variables ----
  if (opts.css !== false && !doc.querySelector?.('style[data-hawkes-ui-kit]')) {
    const st = doc.createElement('style');
    st.setAttribute('data-hawkes-ui-kit', '1');
    st.textContent = kitCss();
    (doc.head ?? doc.documentElement).appendChild(st);
    cleanups.push(() => st.remove());
  }
  try {
    const meta = doc.querySelector?.('meta[name=viewport]');
    if (meta && !/viewport-fit=cover/.test(meta.content)) meta.content = `${meta.content}, viewport-fit=cover`;
  } catch {}
  const simulate = opts.simulateInsets ?? /[?&](playtest|hawkes-ui-sim)\b/.test(win.location?.search ?? '');
  let probeEl = null;
  function readEnv() {
    // env() only resolves inside CSS: read it through a hidden element's padding.
    if (!probeEl) {
      probeEl = doc.createElement('div');
      probeEl.setAttribute('aria-hidden', 'true');
      probeEl.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      doc.body.appendChild(probeEl);
      cleanups.push(() => probeEl?.remove());
    }
    const cs = win.getComputedStyle(probeEl);
    const px = (v) => parseFloat(v) || 0;
    return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  }
  /** Sets --hawkes-safe-* on the root: the device's own insets, or at least the simulated ones while a playtest runs. */
  function safeArea() {
    const env = readEnv();
    const sim = simulate ? simulatedInsets(win.innerWidth, win.innerHeight) : { top: 0, right: 0, bottom: 0, left: 0 };
    const out = {};
    for (const k of ['top', 'right', 'bottom', 'left']) {
      out[k] = Math.max(env[k], sim[k]);
      doc.documentElement.style.setProperty(`--hawkes-safe-${k}`, `${out[k]}px`);
    }
    return out;
  }
  const onResize = () => safeArea();
  win.addEventListener?.('resize', onResize);
  win.addEventListener?.('orientationchange', onResize);
  cleanups.push(() => { win.removeEventListener?.('resize', onResize); win.removeEventListener?.('orientationchange', onResize); });
  if (doc.body) safeArea(); else doc.addEventListener?.('DOMContentLoaded', safeArea, { once: true });

  // ---- sound: the sound kit's ui bus; the kit takes over its auto-click so a press clicks once ----
  let sound = opts.sound ?? null;
  if (sound) { try { sound.autoUi = false; } catch {} }
  else if (opts.sound !== false) {
    import('./hawkes-sound.js').then((m) => { if (!sound) { sound = m.createSoundKit({ win, autoUi: false }); sound.autoUi = false; } }).catch(() => {});
  }
  const click = () => { try { sound?.unlock?.(); sound?.play?.('ui-press'); } catch {} };

  // ---- presses: pressed state at once, a click, one ui-press ----
  const MIN_HELD_MS = 110; // a quick tap still shows its pressed state for this long
  const pressedAt = new Map();
  function release(el) {
    const t0 = pressedAt.get(el);
    if (t0 == null) return;
    const wait = Math.max(0, MIN_HELD_MS - (now() - t0));
    setTimeout(() => { el.removeAttribute('data-hawkes-pressed'); pressedAt.delete(el); }, wait);
  }
  function record(el, label, id, rect, t0) {
    const d = { type: 'press', id, label, rect, visual: true, visualMs: 0 };
    // The pressed state was set synchronously; confirm it took (and how long it took) on the next frame.
    const raf = win.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
    raf(() => {
      d.visual = el.hasAttribute('data-hawkes-pressed') || pressedAt.has(el);
      d.visualMs = Math.round(now() - t0);
      kit.presses.push(d);
      if (kit.presses.length > 500) kit.presses.shift();
      emit(d);
    });
  }
  function onPress(e) {
    const el = e.target?.closest?.(KIT_CONTROL);
    if (!el || el.getAttribute('data-hawkes-ui') === 'off' || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    if (el.closest?.('[data-hawkes-ui-overlay]')) return;
    const t0 = now();
    el.setAttribute('data-hawkes-pressed', '');
    pressedAt.set(el, t0);
    click();
    const r = el.getBoundingClientRect();
    const label = labelOf(el);
    record(el, label, idOf(el, label), [ri(r.left), ri(r.top), ri(r.width), ri(r.height)], t0);
    if (e.type === 'keydown') release(el); // a key has no pointerup
  }
  const onDown = (e) => { if (e.button > 0 && e.pointerType === 'mouse') return; onPress(e); };
  const onKey = (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) onPress(e); };
  const onUp = (e) => { const el = e.target?.closest?.(KIT_CONTROL); if (el) release(el); for (const k of [...pressedAt.keys()]) if (k !== el) release(k); };
  const o = { capture: true, passive: true };
  doc.addEventListener('pointerdown', onDown, o);
  doc.addEventListener('keydown', onKey, o);
  for (const t of ['pointerup', 'pointercancel']) doc.addEventListener(t, onUp, o);
  cleanups.push(() => {
    doc.removeEventListener('pointerdown', onDown, o); doc.removeEventListener('keydown', onKey, o);
    for (const t of ['pointerup', 'pointercancel']) doc.removeEventListener(t, onUp, o);
  });

  // ---- screens: slide, 150-200 ms, 0 with reduced motion ----
  const screens = () => [...doc.querySelectorAll('[data-ui-screen]')];
  const current = () => screens().find((s) => !s.hidden)?.getAttribute('data-ui-screen') ?? null;
  let busy = null;
  /** Shows screen `name`. dir: 'forward' (default; the new screen slides in from the right), 'back' (from the left). Resolves to the transition's record. */
  async function show(name, { dir = 'forward' } = {}) {
    if (busy) await busy.catch(() => {});
    const to = screens().find((s) => s.getAttribute('data-ui-screen') === name);
    if (!to) return null;
    const from = screens().find((s) => !s.hidden && s !== to) ?? null;
    const isReduced = reduced();
    const planned = transitionMs(opts.durationMs, isReduced);
    const t0 = now();
    const run = async () => {
      if (planned > 0 && from && typeof to.animate === 'function') {
        const sign = dir === 'back' ? -1 : 1;
        to.hidden = false;
        const easing = 'cubic-bezier(.2,.8,.2,1)';
        const a = to.animate([{ transform: `translateX(${28 * sign}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: planned, easing, fill: 'both' });
        const b = from.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${-28 * sign}px)`, opacity: 0 }], { duration: planned, easing, fill: 'both' });
        await Promise.all([a.finished, b.finished].map((p) => Promise.resolve(p).catch(() => {})));
        from.hidden = true;
        try { a.cancel(); b.cancel(); } catch {}
      } else {
        if (from) from.hidden = true;
        to.hidden = false;
      }
    };
    busy = run();
    await busy; busy = null;
    const rec = { type: 'transition', from: from?.getAttribute('data-ui-screen') ?? null, to: name, ms: planned === 0 ? 0 : Math.round(now() - t0), plannedMs: planned, reduced: isReduced };
    kit.transitions.push(rec);
    emit(rec);
    return rec;
  }

  return {
    show, current, safeArea, press: (el) => onPress({ target: el, type: 'pointerdown' }),
    state: () => ({ presses: kit.presses.slice(), transitions: kit.transitions.slice() }),
    dispose() { for (const c of cleanups) { try { c(); } catch {} } try { delete win.__hawkesUiKit; } catch {} },
  };
}
