// Hawkes Gen UI kit: the library (entities, slots, versions) as web components any product's tools can drop in: a
// level editor, DoD's dev tools, a Studio tab, a plain HTML page. No framework, no build step; Shadow DOM, themed by
// CSS variables. Needs hawkesgen.mjs (v6+) next to it.
//
//   <script type="module">
//     import { configure } from './hawkesgen-ui.mjs';
//     configure({ project: 'doseofdestruction' });          // or { url, key, project }, or { gen: aHawkesGenClient }
//   </script>                                                (configure before adding elements, or set
//   <script>window.hawkesGenConfig = { url, key, project }   window.hawkesGenConfig before loading this module)
//   </script>
//   <hg-library project="doseofdestruction" kind="fighter" thumb="side,concept" open-inline></hg-library>
//   <hg-entity entity="doseofdestruction/break"></hg-entity>
//   <hg-slot entity="doseofdestruction/break" slot="side"></hg-slot>
//
// Events (bubble, composed): hg-select { id } from a library card; hg-pick { entity, slot, version } when a version
// is made current (a product can write its files then: gen.exportSlots). Theme: --hg-bg, --hg-panel, --hg-fg,
// --hg-muted, --hg-accent, --hg-line, --hg-radius, --hg-font on the element or any parent (light or dark follows
// the page's prefers-color-scheme until a product sets its own).
//
// Source of truth: C:\Projects\hawkesgen\clients\js\hawkesgen-ui.mjs (also served by Hawkes Gen at /client/).

import { HawkesGen } from './hawkesgen.mjs';

export const UI_VERSION = 1;

// ------------------------------------------------------------------ shared client, events, media

let client = null;
/** Sets the client every component uses: { gen } or HawkesGen options ({ url, key, project }). */
export function configure(opts = {}) {
  client = opts.gen ?? new HawkesGen(opts);
  return client;
}
// Before configure() runs (elements upgrade the moment this module loads), a page can set window.hawkesGenConfig.
const gen = () => (client ??= new HawkesGen(globalThis.hawkesGenConfig ?? {}));

const listeners = new Set();
let stopWatch = null;
/** One live event stream for the page, shared by every component. */
function subscribe(fn) {
  listeners.add(fn);
  stopWatch ??= gen().watch((ev) => listeners.forEach((l) => { try { l(ev); } catch {} }));
  return () => {
    listeners.delete(fn);
    if (!listeners.size && stopWatch) { stopWatch(); stopWatch = null; }
  };
}

const urls = new Map();
/** A URL an <img>/<video> can load: Gen's own file URL when no key is needed, else the bytes as a blob URL (cached). */
export async function assetUrl(assetId, mime) {
  if (urls.has(assetId)) return urls.get(assetId);
  const g = gen();
  const p = (async () => {
    // No key to send (this PC, or a dev server that adds it): the browser streams the file itself (video seeks).
    if (!g.key) return g.fileUrl(assetId);
    const bytes = await g.bytes(assetId);
    return URL.createObjectURL(new Blob([bytes], { type: mime ?? 'application/octet-stream' }));
  })();
  urls.set(assetId, p);
  p.catch(() => urls.delete(assetId));
  return p;
}

// ------------------------------------------------------------------ little helpers

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value' || k === 'checked' || k === 'muted' || k === 'files') el[k] = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const CSS = `
:host { --hgk-bg: var(--hg-bg, #ffffff); --hgk-panel: var(--hg-panel, #f6f7f9); --hgk-fg: var(--hg-fg, #1d2128); --hgk-muted: var(--hg-muted, #66707c);
  --hgk-accent: var(--hg-accent, #2f6fdb); --hgk-line: var(--hg-line, #dfe3e8); --hgk-radius: var(--hg-radius, 8px);
  display: block; color: var(--hgk-fg); font: 13px/1.45 var(--hg-font, system-ui, -apple-system, Segoe UI, sans-serif); }
@media (prefers-color-scheme: dark) {
  :host { --hgk-bg: var(--hg-bg, #121417); --hgk-panel: var(--hg-panel, #1b1e23); --hgk-fg: var(--hg-fg, #e7e9ec); --hgk-muted: var(--hg-muted, #9aa1ab);
    --hgk-accent: var(--hg-accent, #5aa9ff); --hgk-line: var(--hg-line, #2c3138); }
}
* { box-sizing: border-box; }
button, input, textarea, select { font: inherit; color: var(--hgk-fg); background: var(--hgk-bg); border: 1px solid var(--hgk-line); border-radius: 6px; }
button { padding: 4px 10px; cursor: pointer; } button:hover { border-color: var(--hgk-accent); } button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--hgk-accent); color: #fff; border-color: var(--hgk-accent); }
input, select { padding: 4px 8px; } textarea { padding: 6px 8px; width: 100%; resize: vertical; min-height: 54px; }
.muted { color: var(--hgk-muted); } .err { color: #ff7b72; white-space: pre-wrap; } .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.panel { background: var(--hgk-panel); border: 1px solid var(--hgk-line); border-radius: var(--hgk-radius); padding: 10px; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--hgk-line); color: var(--hgk-muted); }
.badge.current { color: #fff; background: #238636; border-color: #238636; } .badge.take { color: var(--hgk-accent); border-color: var(--hgk-accent); }
.badge.discarded { text-decoration: line-through; }
.media { width: 100%; max-height: 420px; object-fit: contain; background: repeating-conic-gradient(#0003 0 25%, transparent 0 50%) 50% / 16px 16px; border-radius: 6px; display: block; }
.empty { display: grid; place-items: center; min-height: 140px; border: 1px dashed var(--hgk-line); border-radius: 6px; color: var(--hgk-muted); }
`;

class Base extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.append(h('style', {}, CSS + (this.constructor.css ?? '')));
    this.body = h('div');
    this.root.append(this.body);
  }
  set(...kids) { this.body.replaceChildren(...kids); }
  fire(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }
  disconnectedCallback() {
    // Moved, not removed: keep listening. Removed: stop.
    queueMicrotask(() => { if (!this.isConnected) { this.unsub?.(); this.unsub = null; this.ready = false; } });
  }
}

/** A version's file, shown by kind. */
async function media(v, { thumb = false } = {}) {
  if (!v?.file) return h('div', { class: 'empty' }, 'no file');
  const kind = v.file.kind;
  const url = await assetUrl(v.asset, v.file.mime);
  if (kind === 'image') return h('img', { class: 'media', src: url, alt: `v${v.n}`, loading: 'lazy' });
  if (kind === 'video') return thumb ? h('video', { class: 'media', src: url, muted: true, preload: 'metadata' }) : h('video', { class: 'media', src: url, controls: true, loop: true, muted: true, autoplay: true, playsInline: true });
  if (kind === 'audio') return thumb ? h('div', { class: 'empty' }, '♪ audio') : h('audio', { src: url, controls: true, style: { width: '100%' } });
  return h('div', { class: 'empty' }, h('a', { href: url, download: `v${v.n}`, style: { color: 'var(--hgk-accent)' } }, `${kind} file (${Math.round((v.file.bytes ?? 0) / 1024)} KB)`));
}

// ------------------------------------------------------------------ <hg-slot>

/** One slot: the version in view, every version as a strip, pick/discard/note, feedback → revise or make more, upload. */
class HgSlot extends Base {
  static css = `
  .head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 6px; }
  .name { font-weight: 600; } .strip { display: flex; gap: 6px; overflow-x: auto; padding: 6px 0; }
  .strip button { padding: 2px; width: 74px; flex: none; position: relative; } .strip button.sel { border-color: var(--hgk-accent); box-shadow: 0 0 0 1px var(--hgk-accent); }
  .strip .media { height: 60px; } .strip .n { position: absolute; left: 4px; top: 2px; font-size: 10px; background: #000a; padding: 0 4px; border-radius: 4px; }
  .strip .dot { position: absolute; right: 4px; top: 4px; width: 8px; height: 8px; border-radius: 50%; }
  .info { margin: 6px 0; } .prompt { font-size: 12px; color: var(--hgk-muted); max-height: 3.2em; overflow: hidden; cursor: pointer; } .prompt.open { max-height: none; }
  .jobs { font-size: 12px; color: var(--hgk-accent); }
  .drop { outline: 2px dashed var(--hgk-accent); }
  `;
  static get observedAttributes() { return ['entity', 'slot']; }
  attributeChangedCallback() { if (this.ready) this.load(); }
  connectedCallback() {
    if (this.ready) return;
    this.ready = true;
    this.state = { versions: [], sel: null, showDiscarded: false, jobs: new Map(), error: '', brief: '' };
    // A fighter can have 40 slots: each loads its versions (and files) when it scrolls into view.
    this.set(h('div', { class: 'panel' }, h('b', {}, this.getAttribute('slot') ?? ''), h('div', { class: 'empty' }, '…')));
    if ('IntersectionObserver' in globalThis) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          this.load();
        }
      }, { rootMargin: '400px' });
      io.observe(this);
    } else this.load();
    const reload = debounce(() => this.load(), 200);
    this.unsub = subscribe((ev) => {
      const e = this.getAttribute('entity');
      const s = this.getAttribute('slot');
      if (ev.type === 'library' && ev.data.entity === e && (!ev.data.slot || ev.data.slot === s)) reload();
      if (ev.type === 'job' && ev.data.labels?.entity === e && (ev.data.labels?.slot === s || Object.values(ev.data.labels?.slots ?? {}).includes(s))) {
        const done = ['done', 'failed', 'cancelled'].includes(ev.data.status);
        if (done) {
          this.state.jobs.delete(ev.data.id);
          if (ev.data.status === 'failed') this.state.error = `${ev.data.tool} failed: ${ev.data.error ?? ''}`;
        } else this.state.jobs.set(ev.data.id, ev.data);
        this.render();
      }
    });
    if (this.dragSet) return;
    this.dragSet = true;
    this.addEventListener('dragover', (e) => { e.preventDefault(); this.body.classList.add('drop'); });
    this.addEventListener('dragleave', () => this.body.classList.remove('drop'));
    this.addEventListener('drop', (e) => {
      e.preventDefault();
      this.body.classList.remove('drop');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.upload(f);
    });
  }
  async load() {
    const e = this.getAttribute('entity');
    const s = this.getAttribute('slot');
    if (!e || !s) return;
    try {
      const [hist, ent] = await Promise.all([gen().slot(e, s), this.entityData ? Promise.resolve(this.entityData) : gen().entity(e)]);
      this.entityData = null;
      this.state.versions = hist.versions;
      this.state.brief = ent?.data?.slots?.[s]?.brief ?? '';
      const keep = this.state.versions.find((v) => v.id === this.state.sel?.id);
      this.state.sel = keep ?? this.state.versions.find((v) => v.status === 'current') ?? this.state.versions.find((v) => v.status !== 'discarded') ?? null;
      this.state.error = '';
    } catch (err) {
      this.state.error = err.message;
    }
    this.render();
  }
  async act(fn) {
    try {
      this.state.error = '';
      await fn();
    } catch (err) {
      this.state.error = err.message;
      this.render();
    }
  }
  async upload(file) {
    await this.act(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await gen().addVersion(this.getAttribute('entity'), this.getAttribute('slot'), bytes, { title: file.name, note: `uploaded ${file.name}` });
    });
  }
  async render() {
    const st = this.state;
    const e = this.getAttribute('entity');
    const s = this.getAttribute('slot');
    const v = st.sel;
    const shown = st.versions.filter((x) => st.showDiscarded || x.status !== 'discarded');
    const strip = h('div', { class: 'strip' }, await Promise.all(shown.map(async (x) => h('button', {
      class: x.id === v?.id ? 'sel' : '', title: `v${x.n} ${x.status}${x.note ? ` · ${x.note}` : ''}`,
      onclick: () => { st.sel = x; this.render(); },
    }, await media(x, { thumb: true }), h('span', { class: 'n' }, `v${x.n}`), h('span', { class: 'dot', style: { background: x.status === 'current' ? '#2ea043' : x.status === 'take' ? 'var(--hgk-accent)' : 'transparent' } })))));
    const feedback = h('textarea', { placeholder: 'Feedback: "make the visor bigger", "lower stance"...' });
    const count = h('select', {}, [1, 2, 3, 4].map((n) => h('option', { value: n }, `${n} take${n > 1 ? 's' : ''}`)));
    const note = h('input', { placeholder: 'note on this version', value: v?.note ?? '', style: { flex: '1' } });
    note.addEventListener('change', () => v && this.act(() => gen().note(v.id, note.value)));
    const brief = h('input', { placeholder: 'brief (what this slot is: the pose, the move...)', value: st.brief, style: { flex: '1' } });
    brief.addEventListener('change', () => this.act(() => gen().updateEntity(e, { data: { slots: { [s]: { brief: brief.value } } } })));
    const fileIn = h('input', { type: 'file', style: { display: 'none' }, onchange: () => fileIn.files[0] && this.upload(fileIn.files[0]) });
    const running = [...st.jobs.values()];
    const madeFrom = (v?.made_from ?? []).map((m) => (m.slot ? `${m.entity === e ? '' : `${m.entity} `}${m.slot} v${m.n}` : m.asset)).join(', ');

    this.set(h('div', { class: 'panel' },
      h('div', { class: 'head' },
        h('span', {}, h('span', { class: 'name' }, s), ' ', h('span', { class: 'muted' }, `${st.versions.filter((x) => x.status === 'take').length} takes · ${st.versions.length} versions`)),
        h('span', { class: 'row' },
          h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: st.showDiscarded, onchange: (ev) => { st.showDiscarded = ev.target.checked; this.render(); } }), ' discarded'),
          h('button', { onclick: () => fileIn.click(), title: 'Add a file (or drop one here)' }, 'Add file'), fileIn)),
      h('div', { class: 'row', style: { marginBottom: '6px' } }, brief),
      v ? await media(v) : h('div', { class: 'empty' }, 'Nothing yet: make takes, or drop a file here'),
      v && h('div', { class: 'info' },
        h('div', { class: 'row' },
          h('span', { class: `badge ${v.status}` }, v.status), h('b', {}, `v${v.n}`),
          h('span', { class: 'muted' }, [v.file?.tool, v.by, ago(v.created)].filter(Boolean).join(' · ')),
          madeFrom && h('span', { class: 'muted' }, `from ${madeFrom}`)),
        v.file?.prompt && h('div', { class: 'prompt', title: 'the prompt (click to expand)', onclick: (ev) => ev.currentTarget.classList.toggle('open') }, v.file.prompt),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          v.status !== 'current' && h('button', { class: 'primary', onclick: () => this.act(async () => { await gen().pick(v.id); this.fire('hg-pick', { entity: e, slot: s, version: v.id }); }) }, 'Use this'),
          v.status === 'discarded'
            ? h('button', { onclick: () => this.act(() => gen().restore(v.id)) }, 'Restore')
            : v.status !== 'current' && h('button', { onclick: () => this.act(() => gen().discard(v.id)) }, 'Discard'),
          note)),
      strip,
      h('div', { style: { marginTop: '6px' } }, feedback),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { disabled: !v, title: 'Change the version in view with the feedback (images are edited in place)', onclick: () => this.act(async () => {
          if (!feedback.value.trim()) throw new Error('Write the feedback first');
          await gen().revise(e, s, feedback.value.trim(), { version: v.n, count: Number(count.value) });
        }) }, 'Revise this'),
        h('button', { title: "Make new takes with the slot's recipe (and the feedback)", onclick: () => this.act(() => gen().make(e, s, { feedback: feedback.value.trim() || undefined, count: Number(count.value) })) }, 'Make takes'),
        count,
        running.length > 0 && h('span', { class: 'jobs' }, running.map((j) => `${j.tool}: ${j.detail || j.status}`).join(' · '))),
      st.error && h('div', { class: 'err' }, st.error),
    ));
  }
}

// ------------------------------------------------------------------ <hg-entity>

/** An entity: its name, canon and look, and every slot it has or its kind expects. */
class HgEntity extends Base {
  static css = `.slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 10px; margin-top: 10px; }
  h2 { margin: 0; font-size: 18px; } label { display: block; font-size: 12px; color: var(--hgk-muted); margin-top: 6px; }`;
  static get observedAttributes() { return ['entity']; }
  attributeChangedCallback() { if (this.ready) this.load(); }
  connectedCallback() {
    if (this.ready) return;
    this.ready = true;
    this.load();
    const reload = debounce(() => this.load(), 300);
    this.unsub = subscribe((ev) => ev.type === 'library' && ev.data.entity === this.getAttribute('entity') && ev.data.type === 'entity' && reload());
  }
  async load() {
    const id = this.getAttribute('entity');
    if (!id) return;
    try {
      const e = await gen().entity(id);
      const presets = await gen().presets(e.project).catch(() => null);
      const kind = presets?.kinds?.[e.kind];
      // Slots: those it has, those its data names, and the kind's fixed ones (wildcards like pose/* are added by hand).
      const names = new Set([...Object.keys(e.slots ?? {}), ...Object.keys(e.data?.slots ?? {}), ...Object.keys(kind?.slots ?? {}).filter((k) => !k.includes('*'))]);
      const wild = Object.keys(kind?.slots ?? {}).filter((k) => k.endsWith('/*')).map((k) => k.slice(0, -2));
      this.renderEntity(e, [...names].sort(slotOrder(kind)), wild);
    } catch (err) {
      this.set(h('div', { class: 'err' }, err.message));
    }
  }
  renderEntity(e, slots, wild) {
    const field = (key, label) => {
      const t = h('textarea', { value: e.data?.[key] ?? '', placeholder: label });
      t.addEventListener('change', () => gen().updateEntity(e.id, { data: { [key]: t.value } }).catch((err) => alert(err.message)));
      return [h('label', {}, label), t];
    };
    const add = h('input', { placeholder: wild.length ? `new slot: ${wild.map((w) => `${w}/name`).join(' or ')}` : 'new slot (e.g. pose/kick)' });
    const addSlot = () => {
      const s = add.value.trim().toLowerCase().replace(/\s+/g, '-');
      if (!s) return;
      gen().updateEntity(e.id, { data: { slots: { [s]: { brief: '' } } } }).then(() => this.load()).catch((err) => alert(err.message));
    };
    add.addEventListener('keydown', (ev) => ev.key === 'Enter' && addSlot());
    this.set(
      h('div', { class: 'panel' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', {}, e.name), h('span', { class: 'muted' }, `${e.kind} · ${e.id}`)),
        field('look', 'Look: what it looks like, in words (used by every recipe)'), field('canon', 'Canon: facts every version must respect'),
        h('div', { class: 'row', style: { marginTop: '8px' } }, add, h('button', { onclick: addSlot }, 'Add slot'))),
      h('div', { class: 'slots' }, slots.map((s) => {
        const el = h('hg-slot', { entity: e.id, slot: s });
        el.entityData = e;
        return el;
      })),
    );
  }
}

/** Slots in a kind's order (concept, reference, side, poses, clips...), then by name. */
function slotOrder(kind) {
  const order = Object.keys(kind?.slots ?? {}).map((k) => k.replace('/*', '/'));
  const rank = (s) => {
    const i = order.findIndex((o) => (o.endsWith('/') ? s.startsWith(o) : s === o));
    return i < 0 ? 999 : i;
  };
  return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

// ------------------------------------------------------------------ <hg-library>

/** Every entity of a project (and kind): a searchable grid of cards; opens one inline or fires hg-select. */
class HgLibrary extends Base {
  static css = `.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 10px; }
  .card { padding: 0; text-align: left; overflow: hidden; } .card .media, .card .empty { height: 130px; min-height: 0; border-radius: 0; }
  .card .t { padding: 6px 8px; } .card .t b { display: block; } .waiting { color: var(--hgk-accent); }`;
  static get observedAttributes() { return ['project', 'kind']; }
  attributeChangedCallback() { if (this.ready) this.load(); }
  connectedCallback() {
    if (this.ready) return;
    this.ready = true;
    this.q = '';
    this.open = null;
    this.load();
    const reload = debounce(() => !this.open && this.load(), 400);
    this.unsub = subscribe((ev) => ev.type === 'library' && String(ev.data.entity).startsWith(`${this.getAttribute('project')}/`) && reload());
  }
  async load() {
    const project = this.getAttribute('project') ?? gen().project;
    if (!project) return this.set(h('div', { class: 'err' }, 'Give the library a project'));
    if (this.open) return this.showEntity(this.open);
    try {
      const r = await gen().entities({ project, kind: this.getAttribute('kind') ?? undefined, q: this.q || undefined, limit: 500 });
      await this.renderGrid(project, r.items);
    } catch (err) {
      this.set(h('div', { class: 'err' }, err.message));
    }
  }
  async renderGrid(project, items) {
    const thumbs = (this.getAttribute('thumb') ?? 'concept,side,reference').split(',').map((s) => s.trim());
    const search = h('input', { type: 'search', placeholder: 'Find...', value: this.q, style: { flex: '1' } });
    search.addEventListener('input', debounce(() => { this.q = search.value; this.load(); }, 250));
    const create = async () => {
      const name = prompt('Name');
      if (!name) return;
      const kind = this.getAttribute('kind') ?? prompt('Kind (character, stage, prop, shot...)', 'character');
      if (!kind) return;
      try {
        const e = await gen().createEntity({ project, name, kind });
        this.select(e.id);
      } catch (err) {
        alert(err.message);
      }
    };
    const cards = await Promise.all(items.map(async (e) => {
      const slot = thumbs.find((s) => e.slots?.[s]?.current?.file?.kind === 'image') ?? Object.keys(e.slots ?? {}).find((s) => e.slots[s].current?.file?.kind === 'image');
      const takes = Object.values(e.slots ?? {}).reduce((n, s) => n + (s.takes ?? 0), 0);
      return h('button', { class: 'card', onclick: () => this.select(e.id) },
        slot ? await media(e.slots[slot].current, { thumb: true }) : h('div', { class: 'empty' }, e.kind),
        h('div', { class: 't' }, h('b', {}, e.name), h('span', { class: 'muted' }, `${Object.keys(e.slots ?? {}).length} slots`), takes ? h('span', { class: 'waiting' }, ` · ${takes} takes waiting`) : ''));
    }));
    this.set(
      h('div', { class: 'row' }, search, h('button', { onclick: create }, 'New')),
      items.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'empty', style: { marginTop: '10px' } }, this.q ? 'Nothing matches' : 'Nothing here yet'),
    );
  }
  select(id) {
    this.fire('hg-select', { id });
    if (this.hasAttribute('open-inline')) this.showEntity(id);
  }
  showEntity(id) {
    this.open = id;
    this.set(h('button', { onclick: () => { this.open = null; this.load(); } }, '← All'), h('div', { style: { marginTop: '8px' } }, h('hg-entity', { entity: id })));
  }
}

for (const [name, cls] of [['hg-slot', HgSlot], ['hg-entity', HgEntity], ['hg-library', HgLibrary]]) {
  if (!customElements.get(name)) customElements.define(name, cls);
}
