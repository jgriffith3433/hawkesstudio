// Redrawing in place (dashboard/patch.js studioPatch): what a refresh keeps (the very nodes of what didn't change, open
// Details, what the reader typed or picked, a slot filled by script) and what it changes (text, attributes, new and gone
// rows, order). J, 2026-11-01: the projects page "refreshes and it makes it jump back up". Loaded the way the browser
// loads it (a classic script), on a small DOM of its own below: enough of one for the redraw, no layout (the scroll
// position is checked in a real browser at a phone's size: see the pull request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// ------------------------------------------------------------------ a small DOM
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'wbr']);
class N {
  childNodes: N[] = [];
  parentNode: N | null = null;
  nodeType: number;
  ownerDocument: any;
  constructor(nodeType: number, ownerDocument: any) { this.nodeType = nodeType; this.ownerDocument = ownerDocument; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  get isConnected(): boolean { let n: N | null = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.root; }
  get textContent(): string { return this.nodeType === 3 ? (this as any).nodeValue : this.childNodes.map((c) => c.textContent).join(''); }
  insertBefore(n: N, ref: N | null) {
    if (n.nodeType === 11) { for (const c of [...n.childNodes]) this.insertBefore(c, ref); return n; }
    n.parentNode?.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (i < 0) throw new Error('ref is not a child');
    this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    if (this.isConnected) this.ownerDocument.moves++; // moves and inserts on the page (not building a fragment)
    return n;
  }
  appendChild(n: N) { return this.insertBefore(n, null); }
  removeChild(n: N) { const i = this.childNodes.indexOf(n); if (i < 0) throw new Error('not a child'); this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  replaceChildren(...ns: N[]) { for (const c of [...this.childNodes]) this.removeChild(c); for (const n of ns) this.appendChild(n); }
  contains(n: N | null) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
}
class T extends N { nodeValue: string; constructor(nodeValue: string, d: any) { super(3, d); this.nodeValue = nodeValue; } }
class E extends N {
  attributes: { name: string; value: string }[] = [];
  tagName: string;
  // Form state, as a browser keeps it apart from the attributes.
  _value: string | null = null;
  _checked: boolean | null = null;
  constructor(tag: string, d: any) { super(1, d); this.tagName = tag.toUpperCase(); }
  getAttribute(k: string) { return this.attributes.find((a) => a.name === k)?.value ?? null; }
  hasAttribute(k: string) { return this.attributes.some((a) => a.name === k); }
  setAttribute(k: string, v: string) { const a = this.attributes.find((x) => x.name === k); if (a) a.value = String(v); else this.attributes.push({ name: k, value: String(v) }); }
  removeAttribute(k: string) { this.attributes = this.attributes.filter((a) => a.name !== k); }
  get id() { return this.getAttribute('id') ?? ''; }
  get type() { return (this.getAttribute('type') ?? 'text').toLowerCase(); }
  get defaultValue() { return this.tagName === 'TEXTAREA' ? this.textContent : this.getAttribute('value') ?? ''; }
  set defaultValue(v: string) { if (this.tagName === 'TEXTAREA') this.replaceChildren(new T(v, this.ownerDocument)); else this.setAttribute('value', v); }
  get value(): string {
    if (this.tagName === 'SELECT') { const o = this.options; return (o.find((x: any) => x.selected) ?? o[0])?.value ?? ''; }
    if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent;
    return this._value ?? this.defaultValue;
  }
  set value(v: string) {
    if (this.tagName === 'SELECT') { for (const o of this.options) o._sel = o.value === v; return; }
    this._value = v;
  }
  get defaultChecked() { return this.hasAttribute('checked'); }
  get checked() { return this._checked ?? this.defaultChecked; }
  set checked(v: boolean) { this._checked = v; }
  // <option>: picked by hand (_sel), else its selected attribute.
  _sel: boolean | null = null;
  get defaultSelected() { return this.hasAttribute('selected'); }
  get selected(): boolean {
    const sel = this.parentNode as any;
    if (sel?.options?.some((o: any) => o._sel !== null)) return Boolean(this._sel);
    return this.defaultSelected;
  }
  get options(): any[] { return this.childNodes.filter((c: any) => c.tagName === 'OPTION'); }
  get open() { return this.hasAttribute('open'); }
  set open(v: boolean) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  querySelectorAll(sel: string) {
    // Only what the tests ask: [attr] and tag names.
    const out: E[] = [];
    const m = /^\[([a-z-]+)\]$/.exec(sel);
    const walk = (n: N) => { for (const c of n.childNodes) if (c instanceof E) { if (m ? c.hasAttribute(m[1]) : c.tagName === sel.toUpperCase()) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  set innerHTML(html: string) { this.replaceChildren(...parse(html, this.ownerDocument)); }
}
class Template extends E {
  content: N;
  constructor(d: any) { super('template', d); this.content = new N(11, d); }
  set innerHTML(html: string) { this.content = new N(11, this.ownerDocument); for (const n of parse(html, this.ownerDocument)) this.content.appendChild(n); }
}

/** Enough HTML for the dashboard's templates: tags with quoted (or bare) attributes, text, void elements. */
function parse(html: string, d: any): N[] {
  const top = new N(11, d);
  const stack: N[] = [top];
  const re = /<\/([a-z0-9-]+)\s*>|<([a-z0-9-]+)((?:\s+[a-z0-9-:]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const cur = stack.at(-1)!;
    if (m[1]) { while (stack.length > 1 && (stack.pop() as E).tagName !== m[1].toUpperCase()); continue; }
    if (m[4] !== undefined) { cur.appendChild(new T(m[4].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), d)); continue; }
    const e = d.createElement(m[2]);
    for (const a of m[3].matchAll(/([a-z0-9-:]+)(?:="([^"]*)")?/gi)) e.setAttribute(a[1], a[2] ?? '');
    cur.appendChild(e);
    if (!VOID.has(m[2].toLowerCase())) stack.push(e);
  }
  return [...top.childNodes];
}

function makeDocument() {
  const d: any = { moves: 0, activeElement: null };
  d.createElement = (tag: string) => (tag === 'template' ? new Template(d) : new E(tag, d));
  d.importNode = (n: N, deep: boolean) => {
    const copy = (x: N): N => {
      if (x instanceof T) return new T(x.nodeValue, d);
      const e = d.createElement((x as E).tagName.toLowerCase());
      for (const a of (x as E).attributes) e.setAttribute(a.name, a.value);
      if (deep) for (const c of x.childNodes) e.appendChild(copy(c));
      return e;
    };
    return copy(n);
  };
  d.root = new E('html', d);
  d.documentElement = d.root;
  d.body = new E('body', d);
  d.root.appendChild(d.body);
  d.root.scrollTop = 0; // at the top: the patch holds no scroll position (no layout here)
  d.scrollingElement = d.root;
  return d;
}

/** patch.js in a context of its own with that document. */
function load() {
  const document = makeDocument();
  const ctx: any = { document, Date, Math, JSON, Set, Map, Array, String, Number, Object, Boolean, setTimeout, clearTimeout };
  vm.runInNewContext(`${fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'patch.js'), 'utf8')}\nthis.studioPatch = studioPatch;`, ctx);
  const el = document.createElement('div');
  document.body.appendChild(el);
  return { patch: ctx.studioPatch, document, el };
}
const html = (n: N): string => n.childNodes.map((c) => (c instanceof T ? c.nodeValue : `<${(c as E).tagName.toLowerCase()}${(c as E).attributes.map((a) => ` ${a.name}${a.value ? `="${a.value}"` : ''}`).join('')}>${VOID.has((c as E).tagName.toLowerCase()) ? '' : `${html(c)}</${(c as E).tagName.toLowerCase()}>`}`)).join('');

// The projects page's cards, shaped like dashboard/app.js card(): a key, a status line, an image, Details.
const card = (id: string, line: string, extra = '') => `<div class="card" data-key="card:${id}"><h3>${id}</h3><div class="status-line">${line}</div>${extra}<img src="/f/${id}.png"><details class="more-details"><summary>Details</summary><div class="meta">${id} details</div></details></div>`;

test('a refresh changes only what differs: the same cards (and their images) stay, their text follows', () => {
  const { patch, el } = load();
  patch(el, card('a', 'played 1 min ago') + card('b', 'played 2 min ago'));
  const [a, b] = el.childNodes as E[];
  const img = a.querySelector('img');
  assert.equal(patch(el, card('a', 'played 2 min ago') + card('b', 'played 3 min ago')), true);
  assert.equal(el.childNodes[0], a);
  assert.equal(el.childNodes[1], b);
  assert.equal(a.querySelector('img'), img, 'the image element is kept, so it does not load again');
  assert.equal(html(el), card('a', 'played 2 min ago') + card('b', 'played 3 min ago'));
});

test('the same html again touches nothing; contents replaced by someone else are redrawn', () => {
  const { patch, el, document } = load();
  patch(el, card('a', 'x'));
  const moves = document.moves;
  assert.equal(patch(el, card('a', 'x')), false);
  assert.equal(document.moves, moves);
  el.innerHTML = '<div class="empty">error</div>'; // an error path writing innerHTML itself
  assert.equal(patch(el, card('a', 'x')), true);
  assert.equal(html(el), card('a', 'x'));
});

test('a Details the reader opened stays open (and one they closed stays closed) across a refresh', () => {
  const { patch, el } = load();
  patch(el, card('a', 'x') + card('b', 'y'));
  const [a, b] = el.childNodes as E[];
  a.querySelector('details')!.open = true;
  patch(el, card('a', 'x2') + card('b', 'y2').replace('<details class="more-details">', '<details class="more-details" open>'));
  assert.equal(a.querySelector('details')!.open, true, 'opened by the reader: still open');
  assert.equal(b.querySelector('details')!.open, false, 'closed: the new html saying open does not pop it open under them');
});

test('problems first: cards that change places are moved, not rebuilt; new ones appear, gone ones go', () => {
  const { patch, el } = load();
  patch(el, card('a', '1') + card('b', '2') + card('c', '3'));
  const [a, b, c] = el.childNodes as E[];
  patch(el, card('c', 'broken') + card('a', '1') + card('d', 'new'));
  assert.deepEqual(el.childNodes.map((n: any) => n.getAttribute('data-key')), ['card:c', 'card:a', 'card:d']);
  assert.equal(el.childNodes[0], c);
  assert.equal(el.childNodes[1], a);
  assert.equal(b.parentNode, null);
  assert.equal(html(el), card('c', 'broken') + card('a', '1') + card('d', 'new'));
});

test('a removed card in the middle does not shuffle the ones after it', () => {
  const { patch, el, document } = load();
  patch(el, card('a', '1') + card('b', '2') + card('c', '3') + card('d', '4'));
  const [, , c, d] = el.childNodes as E[];
  const moves = document.moves;
  patch(el, card('a', '1') + card('c', '3') + card('d', '4'));
  assert.equal(document.moves, moves, 'nothing was moved or inserted');
  assert.deepEqual([el.childNodes[1], el.childNodes[2]], [c, d]);
});

test('what the reader typed, ticked or picked stays; untouched controls follow the new html', () => {
  const { patch, el, document } = load();
  const form = (v: string, on: boolean, pick: string) => `<input type="text" data-key="t" value="${v}"><input type="checkbox" data-key="c"${on ? ' checked' : ''}><select data-key="s"><option value="a"${pick === 'a' ? ' selected' : ''}>A</option><option value="b"${pick === 'b' ? ' selected' : ''}>B</option></select><textarea data-key="ta">${v}</textarea>`;
  patch(el, form('one', false, 'a'));
  const [text, box, sel, ta] = el.childNodes as E[];
  text.value = 'typed';
  box.checked = true;
  sel.value = 'b';
  document.activeElement = ta; // the reader is in the textarea, nothing typed yet
  patch(el, form('two', false, 'a'));
  assert.equal(text.value, 'typed');
  assert.equal(box.checked, true);
  assert.equal(sel.value, 'b');
  assert.equal(ta.value, 'one', 'focused: left as it is');
  document.activeElement = null;
  // Untouched ones follow.
  const { patch: p2, el: el2 } = load();
  p2(el2, form('one', false, 'a'));
  p2(el2, form('two', true, 'b'));
  const [t2, b2, s2, ta2] = el2.childNodes as E[];
  assert.equal(t2.value, 'two');
  assert.equal(b2.checked, true);
  assert.equal(s2.value, 'b');
  assert.equal(ta2.value, 'two');
});

test('a select whose options are rebuilt keeps the pick if it is still there', () => {
  const { patch, el } = load();
  const opts = (ids: string[]) => ids.map((i) => `<option value="${i}">${i}</option>`).join('');
  patch(el, `<select data-key="s">${opts(['a', 'b', 'c'])}</select>`);
  const sel = el.firstChild as E;
  sel.value = 'c';
  patch(el, `<select data-key="s">${opts(['a', 'c', 'd'])}</select>`);
  assert.equal(el.firstChild, sel);
  assert.equal(sel.value, 'c');
  patch(el, `<select data-key="s">${opts(['a', 'd'])}</select>`);
  assert.equal(sel.value, 'a', 'gone: the first');
});

test('data-patch-keep: what a script filled in later stays (a thread, an approval card); its attributes still follow', () => {
  const { patch, el, document } = load();
  patch(el, '<div data-key="row"><b>Item</b><div id="th-1" data-patch-keep></div></div>');
  const slot = (el.firstChild as E).childNodes[1] as E;
  slot.innerHTML = '<div class="thread">a comment</div>';
  patch(el, '<div data-key="row"><b>Item, renamed</b><div id="th-1" data-patch-keep class="x"></div></div>');
  assert.equal(slot.textContent, 'a comment');
  assert.equal(slot.getAttribute('class'), 'x');
  assert.equal((el.firstChild as E).childNodes[0].textContent, 'Item, renamed');
  void document;
});

test('unkeyed rows match by position and tag: a row that changes kind is replaced', () => {
  const { patch, el } = load();
  patch(el, '<p>one</p><div>two</div>');
  const p = el.childNodes[0];
  patch(el, '<p>uno</p><span>two</span>');
  assert.equal(el.childNodes[0], p);
  assert.equal((el.childNodes[1] as E).tagName, 'SPAN');
  assert.equal(html(el), '<p>uno</p><span>two</span>');
});

test('busy: touching or scrolling holds the stream (stream.js asks before it delivers)', () => {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const ctx: any = { document: makeDocument(), Date, Math, JSON, Set, Map, Array, String, Number, Object, Boolean, setTimeout, clearTimeout,
    addEventListener: (k: string, f: any) => (listeners[k] ??= []).push(f) };
  vm.runInNewContext(`${fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'patch.js'), 'utf8')}\nthis.studioPatch = studioPatch;`, ctx);
  const fire = (k: string, e: any = {}) => listeners[k]?.forEach((f) => f(e));
  const busy = () => ctx.studioPatch.busy();
  assert.equal(busy(), false);
  fire('touchstart', { touches: [1] });
  assert.equal(busy(), true);
  fire('touchend', { touches: [] });
  assert.equal(busy(), true, 'right after the finger lifts (momentum)');
  const real = Date.now;
  try {
    Date.now = () => real() + 1000;
    assert.equal(busy(), false);
    fire('scroll');
    assert.equal(busy(), true);
  } finally { Date.now = real; }
  // stream.js waits on it.
  const stream = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'stream.js'), 'utf8');
  assert.match(stream, /studioPatch\.busy\(\)/);
  const index = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.ok(index.indexOf('src="patch.js"') > index.indexOf('src="stream.js"') && index.indexOf('src="patch.js"') < index.indexOf('src="app.js"'), 'patch.js loads after stream.js, before the pages');
});

test('the pages that refresh by themselves redraw in place, not with innerHTML', () => {
  const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', f), 'utf8');
  const app = read('app.js');
  for (const id of ['#cards', '#todayNow', '#status', '#runList', '#chList']) assert.match(app, new RegExp(`studioPatch\\(\\$\\('${id}'\\)`), `${id} is patched`);
  assert.doesNotMatch(app, /\$\('#cards'\)\.innerHTML\s*=/);
  assert.match(app, /data-key="card:/, 'the cards are keyed');
  assert.match(read('golive.js'), /studioPatch\(box,/);
  assert.match(read('roadmap.js'), /studioPatch\(\$\('#rmList'\)/);
  assert.match(read('inbox.js'), /studioPatch\(\$\('#ibList'\)/);
  assert.match(read('resources.js'), /studioPatch\(el,/);
  assert.match(read('activity.js'), /studioPatch\(el\('#actBody'\)/);
  assert.match(read('analytics.js'), /id="anPlayers" data-patch-keep/);
});

// ------------------------------------------------------------------ the scroll position, on a simple phone layout
// No browser here, so a model of one: a 390×844 phone, a sticky 60 px header, blocks stacked top to bottom (a block's
// height is its data-h, else its children's, else 20 px a line of text), and no scroll anchoring of its own, like Safari
// on an iPhone. getBoundingClientRect, elementsFromPoint, getComputedStyle and scrollBy follow it.
function phone() {
  const { patch, document, el } = (() => {
    const document = makeDocument();
    const win: any = { scrollY: 0, innerWidth: 390, innerHeight: 844 };
    const height = (n: N): number => {
      if (n instanceof T) return 0;
      const e = n as E;
      if (e.hasAttribute('data-h')) return Number(e.getAttribute('data-h'));
      const kids = e.childNodes.filter((c) => c instanceof E);
      if (!kids.length) return e.textContent.trim() ? 20 * e.textContent.split('\n').length : 0;
      return kids.reduce((a, c) => a + height(c), 0);
    };
    /** Each element's top on the page (document order, stacked). */
    const tops = () => {
      const out = new Map<N, number>();
      const walk = (n: N, top: number) => { out.set(n, top); let y = top; for (const c of n.childNodes) if (c instanceof E) { walk(c, y); y += height(c); } };
      walk(document.root, 0);
      return out;
    };
    const header = () => document.body.childNodes.find((c: any) => c.tagName === 'HEADER') as E | undefined;
    const rect = (e: E) => {
      const t = tops().get(e);
      if (t === undefined) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      const h = height(e);
      // The sticky header stays at the top of the screen once scrolled past.
      const top = e === header() ? Math.max(t - win.scrollY, 0) : t - win.scrollY;
      return { top, bottom: top + h, left: 0, right: 390, width: 390, height: h };
    };
    (E.prototype as any).getBoundingClientRect = function () { return rect(this); };
    Object.defineProperty(document.root, 'scrollTop', { get: () => win.scrollY, set: (v) => { win.scrollY = v; }, configurable: true });
    (document.root as any).style = { setProperty() {}, removeProperty() {} };
    (document.body as any).style = { setProperty() {}, removeProperty() {} };
    document.querySelector = (sel: string) => (sel === 'header' ? header() ?? null : null);
    document.elementsFromPoint = (_x: number, y: number) => {
      const at = y + win.scrollY;
      const hit: E[] = [];
      for (const [n, t] of tops()) if (n instanceof E && n !== document.root && t <= at && at < t + height(n)) hit.push(n);
      return hit.reverse(); // the deepest first, like a browser
    };
    const ctx: any = {
      document, Date, Math, JSON, Set, Map, Array, String, Number, Object, Boolean, setTimeout, clearTimeout,
      get innerWidth() { return win.innerWidth; }, get innerHeight() { return win.innerHeight; },
      getComputedStyle: (e: E) => ({ position: e.tagName === 'HEADER' ? 'sticky' : 'static', overflowY: 'visible' }),
      requestAnimationFrame: (f: any) => setTimeout(f, 0),
    };
    ctx.window = ctx;
    ctx.scrollBy = (o: any) => { win.scrollY += typeof o === 'number' ? o : o.top; };
    vm.runInNewContext(`${fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'patch.js'), 'utf8')}\nthis.studioPatch = studioPatch;`, ctx);
    const hdr = document.createElement('header');
    hdr.setAttribute('data-h', '60');
    document.body.appendChild(hdr);
    const el = document.createElement('div');
    document.body.appendChild(el);
    return { patch: ctx.studioPatch, document: Object.assign(document, { win, rect }), el };
  })();
  return { patch, document, el, win: (document as any).win, rect: (document as any).rect };
}
const tall = (id: string, h: number, line = '') => `<div class="card" data-key="card:${id}"><h3>${id}</h3><div class="status-line">${line}</div><div class="summary" data-h="${h}"></div></div>`;

test('scrolled down a phone: a card above growing, or moving to the top, leaves what J is reading where it was', () => {
  const { patch, el, win, rect } = phone();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  patch(el, ids.map((i) => tall(i, 300, 'played 1 min ago')).join(''));
  win.scrollY = 1500; // reading card f or so
  const reading = (el.childNodes as E[]).find((c) => rect(c).bottom > 60 + 4)!;
  const before = rect(reading).top;
  // The refresh: card b's summary is two lines longer, card h (below) shrinks, card i is broken now and moves to the top.
  const next = ['i', ...ids.filter((x) => x !== 'i')].map((i) => tall(i, i === 'b' ? 340 : i === 'h' ? 100 : 300, i === 'i' ? 'A playtest failed' : 'played 2 min ago')).join('');
  patch(el, next);
  assert.equal(rect(reading).top, before, 'the card on screen did not move');
  assert.notEqual(win.scrollY, 1500, 'the page scrolled by what changed above, so the card stayed put');
});

test('what a plain innerHTML redraw did on the same phone (the jump J saw), for comparison', () => {
  const { patch, el, win, rect } = phone();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  patch(el, ids.map((i) => tall(i, 300)).join(''));
  win.scrollY = 1000;
  const key = (el.childNodes as E[]).find((c) => rect(c).bottom > 64)!.getAttribute('data-key');
  const before = rect(el.childNodes.find((c: any) => c.getAttribute('data-key') === key) as E).top;
  el.innerHTML = ['f', ...ids.filter((x) => x !== 'f')].map((i) => tall(i, i === 'b' ? 400 : 300)).join('');
  const after = rect(el.childNodes.find((c: any) => c.getAttribute('data-key') === key) as E).top;
  assert.notEqual(after, before, 'without holding the place, the card under the thumb moves');
});

test('at the top of the page nothing scrolls', () => {
  const { patch, el, win } = phone();
  patch(el, ['a', 'b'].map((i) => tall(i, 300)).join(''));
  patch(el, ['a', 'b'].map((i) => tall(i, i === 'a' ? 500 : 300)).join(''));
  assert.equal(win.scrollY, 0);
});
