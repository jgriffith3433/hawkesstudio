// Redrawing a page without it jumping (J, 2026-11-01: "Some pages on studio refresh and it makes the page unusable ...
// the projects page is almost unusable on mobile when scrolling down it refreshes and it makes it jump back up").
//
// The pages refetch when the push stream says something moved (stream.js) and used to redraw with el.innerHTML = html.
// That threw every card away and built new ones: images started loading again (zero height for a moment, so the page
// got shorter and the browser pulled the scroll position up), open Details closed, a select's picker shut, and Safari
// (no scroll anchoring) jumped whenever anything above the reader changed height.
//
// studioPatch(el, html, opts?) changes the page in place instead:
//   - Only what differs changes. Nodes are matched by data-key (or id) first, then by position and tag; an unchanged
//     card keeps its very nodes, so its images, focus and open <details> stay as they are.
//   - What the reader set stays: a <details> they opened or closed, an input or textarea they typed in or that has
//     focus, a checkbox they ticked, a select they changed.
//   - data-patch-keep on an element: its children are the page's own (filled later by script: a thread, a card slot),
//     so a redraw leaves them alone (its attributes still follow the new html).
//   - The scroll position holds: the element at the top of the visible area keeps its place on screen, whatever changed
//     above it (our own anchoring, the same in every browser; the browser's own is paused while we measure).
//   - Same html as last time: nothing is touched.
// studioPatch.busy(): the reader is touching, scrolling or dragging right now (or a moment ago). stream.js holds its
// events until they stop, so a redraw never lands under a moving thumb.
// Loaded right after stream.js, before every script that draws. Test: test/patch.test.ts.
const studioPatch = (() => {
  const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') || n.id || null : null);
  const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
  const TEXTY = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time|color|range)$/;

  /** The reader's own value in a control (typed, ticked, picked, or it has focus): left as it is. */
  function touched(el) {
    const doc = el.ownerDocument;
    if (doc && doc.activeElement === el) return true;
    if (el.tagName === 'TEXTAREA') return el.value !== el.defaultValue;
    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
      if (TEXTY.test(el.type || 'text')) return el.value !== el.defaultValue;
    }
    return false;
  }

  function syncAttrs(old, neu) {
    const details = old.tagName === 'DETAILS'; // open is the reader's
    for (const a of [...neu.attributes]) {
      if (details && a.name === 'open') continue;
      if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
    }
    for (const a of [...old.attributes]) {
      if (details && a.name === 'open') continue;
      if (!neu.hasAttribute(a.name)) old.removeAttribute(a.name);
    }
  }

  function morphNode(old, neu) {
    if (old.nodeType !== 1) {
      if (old.nodeValue !== neu.nodeValue) old.nodeValue = neu.nodeValue;
      return;
    }
    const tag = old.tagName;
    if (tag === 'INPUT') {
      const mine = touched(old);
      const value = old.value;
      const checked = old.checked;
      syncAttrs(old, neu);
      if (mine) { if (old.value !== value) old.value = value; old.checked = checked; }
      else {
        if (old.type === 'checkbox' || old.type === 'radio') old.checked = neu.hasAttribute('checked');
        else if (old.type !== 'file') old.value = neu.getAttribute('value') ?? '';
      }
      return;
    }
    if (tag === 'TEXTAREA') {
      if (touched(old)) { const v = old.value; syncAttrs(old, neu); if (old.value !== v) old.value = v; return; }
      syncAttrs(old, neu);
      if (old.defaultValue !== neu.textContent) old.defaultValue = neu.textContent;
      old.value = old.defaultValue;
      return;
    }
    if (tag === 'SELECT') {
      const value = old.value;
      const def = [...old.options].find((o) => o.defaultSelected)?.value ?? old.options[0]?.value;
      const mine = old.ownerDocument?.activeElement === old || value !== def;
      syncAttrs(old, neu);
      morphChildren(old, neu);
      const has = (v) => [...old.options].some((o) => o.value === v);
      if (mine && has(value)) old.value = value;
      else { const want = [...old.options].find((o) => o.defaultSelected) ?? old.options[0]; if (want && old.value !== want.value) old.value = want.value; }
      return;
    }
    syncAttrs(old, neu);
    if (old.hasAttribute('data-patch-keep')) return;
    morphChildren(old, neu);
  }

  function morphChildren(parent, neuParent) {
    const neuKids = [...neuParent.childNodes];
    const wanted = new Set();
    for (const n of neuKids) { const k = keyOf(n); if (k) wanted.add(k); }
    const byKey = new Map();
    for (const o of parent.childNodes) { const k = keyOf(o); if (k && !byKey.has(k)) byKey.set(k, o); }
    let cursor = parent.firstChild;
    const drop = () => {
      // Old nodes whose key the new html no longer has: gone (before they'd be shuffled around).
      while (cursor && keyOf(cursor) && !wanted.has(keyOf(cursor))) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
    };
    for (const neu of neuKids) {
      drop();
      const k = keyOf(neu);
      let match = null;
      if (k) {
        const o = byKey.get(k);
        if (o && same(o, neu)) { match = o; byKey.delete(k); }
      } else if (cursor && !keyOf(cursor) && same(cursor, neu)) match = cursor;
      if (match) {
        if (match === cursor) cursor = cursor.nextSibling;
        else parent.insertBefore(match, cursor);
        morphNode(match, neu);
      } else {
        parent.insertBefore(parent.ownerDocument.importNode(neu, true), cursor);
      }
    }
    while (cursor) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
  }

  // --------------------------------------------------------------- the scroll position
  function scrollerOf(el) {
    const doc = el.ownerDocument;
    for (let n = el.parentElement; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return doc.scrollingElement || doc.documentElement;
  }
  const isPage = (sc) => sc === sc.ownerDocument.scrollingElement || sc === sc.ownerDocument.documentElement;
  const fixed = (n) => { for (; n && n.nodeType === 1; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true; return false; };

  /** The top edge of what the reader sees in this scroller (under a sticky or fixed header on the page). */
  function visibleTop(sc) {
    if (!isPage(sc)) return sc.getBoundingClientRect().top;
    const h = sc.ownerDocument.querySelector('header');
    if (!h) return 0;
    const pos = getComputedStyle(h).position;
    return pos === 'sticky' || pos === 'fixed' ? Math.max(0, h.getBoundingClientRect().bottom) : 0;
  }

  /** The element at the top of the visible area, with its ancestors (the first still on the page after the redraw wins). */
  function anchor(el) {
    const doc = el.ownerDocument;
    const sc = scrollerOf(el);
    if ((isPage(sc) ? (doc.scrollingElement || doc.documentElement).scrollTop : sc.scrollTop) <= 0) return null; // at the top: nothing to hold
    const top = visibleTop(sc);
    const r = el.getBoundingClientRect();
    const vh = isPage(sc) ? innerHeight : sc.getBoundingClientRect().bottom;
    if (r.top > vh) return null; // all of it is below the screen: changing it moves nothing the reader sees
    const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 40), 1), innerWidth - 1);
    let hit = null;
    for (const y of [top + 4, top + 24, top + 60]) {
      hit = (doc.elementsFromPoint?.(x, y) ?? []).find((n) => (isPage(sc) ? !fixed(n) : sc.contains(n)) && n !== doc.documentElement && n !== doc.body);
      if (hit) break;
    }
    if (!hit) return null;
    const chain = [];
    for (let n = hit; n && n !== doc.body; n = n.parentElement) chain.push({ n, top: n.getBoundingClientRect().top });
    return { sc, chain };
  }

  function hold(a) {
    const at = a.chain.find((c) => c.n.isConnected);
    if (!at) return;
    const delta = at.n.getBoundingClientRect().top - at.top;
    if (Math.abs(delta) < 0.5) return;
    // instant: a page with scroll-behavior: smooth would otherwise glide there, which reads as the jump we're preventing.
    const target = isPage(a.sc) ? window : a.sc;
    try { target.scrollBy({ top: delta, behavior: 'instant' }); } catch { target.scrollBy(0, delta); } // an older Safari doesn't know 'instant'
  }

  /** The browser's own scroll anchoring (Chrome, Firefox) off while we redraw and hold the place ourselves, so the two never both move it. */
  let paused = 0;
  function pauseNativeAnchoring(doc) {
    const els = [doc.documentElement, doc.body].filter(Boolean);
    if (!paused++) for (const e of els) e.style.setProperty('overflow-anchor', 'none');
    const resume = () => { if (!--paused) for (const e of els) e.style.removeProperty('overflow-anchor'); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(resume));
    else setTimeout(resume, 50);
  }

  /** Makes el's contents match html, changing only what differs (see the top of this file). Returns whether anything was redrawn. */
  function patch(el, html, opts = {}) {
    if (!el) return false;
    html = String(html ?? '');
    // Unchanged since our last redraw (and nobody else replaced the contents meanwhile): nothing to do.
    const mark = el.__patched;
    if (!opts.force && mark && mark.html === html && mark.first === el.firstChild && mark.last === el.lastChild) return false;
    const doc = el.ownerDocument;
    const tpl = doc.createElement('template');
    tpl.innerHTML = html;
    if (!el.firstChild) el.replaceChildren(tpl.content);
    else {
      const a = opts.hold === false ? null : anchor(el);
      if (a) pauseNativeAnchoring(doc);
      morphChildren(el, tpl.content);
      if (a) hold(a);
    }
    el.__patched = { html, first: el.firstChild, last: el.lastChild };
    return true;
  }

  // ------------------------------------------------------------- is the reader moving the page?
  let touching = 0;
  let pointer = false;
  let downAt = 0;
  let lastMove = 0;
  if (typeof addEventListener === 'function') {
    const moved = () => { lastMove = Date.now(); };
    const opt = { passive: true, capture: true };
    addEventListener('touchstart', (e) => { touching = e.touches?.length ?? 1; downAt = Date.now(); moved(); }, opt);
    addEventListener('touchend', (e) => { touching = e.touches?.length ?? 0; moved(); }, opt);
    addEventListener('touchcancel', () => { touching = 0; moved(); }, opt);
    addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { pointer = true; downAt = Date.now(); } }, opt);
    addEventListener('pointerup', () => { pointer = false; }, opt);
    addEventListener('pointercancel', () => { pointer = false; }, opt);
    addEventListener('blur', () => { pointer = false; touching = 0; }, opt);
    addEventListener('scroll', moved, opt); // capture: inner scrollers too (momentum keeps firing these)
    addEventListener('wheel', moved, opt);
  }
  /** Touching, dragging (a scrollbar, a selection) or scrolled in the last 400 ms. A finger or button down for more
   *  than 15 s counts as lifted (an end the page never heard of must not hold the updates forever). */
  patch.busy = () => ((touching > 0 || pointer) && Date.now() - downAt < 15_000) || Date.now() - lastMove < 400;
  return patch;
})();
