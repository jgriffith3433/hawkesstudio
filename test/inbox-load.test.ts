// The Inbox page always ends in its cards, the empty state, or what went wrong with a Retry button, never "Loading…"
// forever (J, 2026-11-01: "the first time you navigate to inbox if it's been a while it says 'Loading..' but never
// loads. Then if you refresh the page it populates"). dashboard/inbox.js runs here as the browser runs it (a classic
// script in a shared global scope) in a small fake DOM, with a fake clock and a fetch the test answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'inbox.js'), 'utf8');

type Call = { path: string; init: any; resolve: (v: any) => void; reject: (e: any) => void };

function page({ onInbox = false, hidden = false } = {}) {
  // ---- a fake clock
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimeout = (fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
    await flush();
  }

  // ---- a small DOM
  const winListeners = new Map<string, Function[]>();
  const docListeners = new Map<string, Function[]>();
  function el(id: string, cls: string[] = []) {
    const listeners = new Map<string, Function[]>();
    const e: any = {
      id, innerHTML: '', textContent: '', hidden: false, title: '',
      classList: { set: new Set(cls), contains(c: string) { return this.set.has(c); }, toggle(c: string, on?: boolean) { (on ?? !this.set.has(c)) ? this.set.add(c) : this.set.delete(c); }, add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); } },
      addEventListener(t: string, fn: Function) { listeners.set(t, [...(listeners.get(t) ?? []), fn]); },
      before(n: any) { byId.set(n.id, n); },
      fire(t: string, ev: any) { for (const fn of listeners.get(t) ?? []) fn(ev); },
    };
    return e;
  }
  const byId = new Map<string, any>();
  for (const [id, cls] of [['inbox', onInbox ? ['tab', 'on'] : ['tab']], ['ibList', []], ['ibAnswered', []], ['inboxCount', []], ['walkAwayBadge', []]] as [string, string[]][]) byId.set(id, el(id, cls));
  byId.get('ibList').innerHTML = '<div class="meta">Loading…</div>';
  const document: any = {
    hidden, activeElement: null, title: '',
    addEventListener(t: string, fn: Function) { docListeners.set(t, [...(docListeners.get(t) ?? []), fn]); },
    createElement: () => el(''),
    querySelector: () => null,
  };
  Object.defineProperty(document, 'createElement', { value: () => { const e = el(''); return new Proxy(e, { set(t, k, v) { t[k] = v; if (k === 'id') byId.set(v, t); return true; } }); } });

  // ---- fetch, answered by the test
  const calls: Call[] = [];
  const fetch = (p: string, init: any = {}) => new Promise((resolve, reject) => {
    calls.push({ path: p, init, resolve, reject });
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
  });
  const json = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const notJson = (status: number) => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <'); } });

  const location = { hash: onInbox ? '#inbox' : '#today', href: 'https://studio.example/#inbox' };
  const streamOn = new Map<string, Function>();
  const counts: number[] = [];
  const g: any = {
    console, Promise, Date, Math, JSON, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, AbortController, encodeURIComponent,
    setTimeout, clearTimeout, document, location,
    fetch,
    addEventListener(t: string, fn: Function) { winListeners.set(t, [...(winListeners.get(t) ?? []), fn]); },
    $: (sel: string) => byId.get(sel.replace(/^#/, '')) ?? null,
    esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`),
    ago: () => '1 min ago', file: (x: string) => x,
    api: async () => { counts.push(Date.now()); return { count: 0 }; },
    approvals: { html: () => '' },
    studioPatch: (e: any, html: string) => { e.innerHTML = html; },
    studioStream: { on: (t: string, fn: Function) => streamOn.set(t, fn) },
    alert() {}, confirm: () => false, prompt: () => null,
  };
  g.window = g;
  vm.createContext(g);
  vm.runInContext(src, g, { filename: 'inbox.js' });

  const list = () => byId.get('ibList').innerHTML as string;
  const errBox = () => byId.get('ibErr');
  /** show('inbox') in app.js: the section turns on, the address follows, then studio-tab. */
  function showInbox() {
    byId.get('inbox').classList.add('on');
    location.hash = '#inbox';
    for (const fn of winListeners.get('studio-tab') ?? []) fn({ detail: 'inbox' });
  }
  function setHidden(h: boolean) {
    document.hidden = h;
    for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
  }
  const clickRetry = () => byId.get('inbox').fire('click', { target: { closest: (s: string) => (s === 'button[data-ibretry]' ? {} : null) } });
  const items = (title: string) => ({ count: 1, walkAway: false, answered: [], items: [{ id: 'q_1', kind: 'question', title, text: null, productName: null, context: null, recommendation: null, options: [], links: [], blocks: 'x', since: 0, asker: 'Studio PM', asks: 1 }] });
  return { calls, json, notJson, list, errBox, showInbox, setHidden, clickRetry, advance, flush, items, location, counts, streamOn };
}

test('opened from the Talk · Inbox bar (no Inbox nav button), after a quiet while: it loads', async () => {
  const p = page({ onInbox: false }); // a customer's Studio opens on Projects
  await p.flush();
  assert.equal(p.calls.length, 0, 'not on screen: only the badge count');
  assert.match(p.list(), /Loading/);
  p.showInbox(); // show('inbox') from groups.js's bar: no nav button click, no stream event
  await p.flush();
  assert.equal(p.calls.length, 1, 'showing the Inbox fetches it');
  assert.equal(p.calls[0].path, '/api/inbox');
  assert.equal(p.calls[0].init.headers['X-Studio-Click'], '1', "as J's click (approval cards' tokens)");
  p.calls[0].resolve(p.json(200, p.items('Pick a name')));
  await p.flush();
  assert.match(p.list(), /Pick a name/);
});

test('a request that hangs after idle times out and is retried once', async () => {
  const p = page({ onInbox: true });
  await p.flush();
  assert.equal(p.calls.length, 1);
  await p.advance(15_000); // the first try never answers
  assert.match(p.list(), /Still loading/);
  await p.advance(1_000);
  assert.equal(p.calls.length, 2, 'one automatic retry');
  p.calls[1].resolve(p.json(200, { count: 0, walkAway: false, items: [], answered: [] }));
  await p.flush();
  assert.match(p.list(), /Nothing is waiting on you/);
});

test('when both tries fail it says why with a Retry button, and Retry loads it', async () => {
  const p = page({ onInbox: true });
  await p.flush();
  await p.advance(15_000);
  await p.advance(1_000);
  await p.advance(15_000);
  assert.equal(p.calls.length, 2, 'no third try by itself');
  assert.match(p.list(), /Couldn't load the Inbox: Studio didn't answer in 15 seconds\./);
  assert.match(p.list(), /data-ibretry/);
  assert.doesNotMatch(p.list(), /Loading/);
  p.clickRetry();
  await p.flush();
  assert.equal(p.calls.length, 3);
  p.calls[2].resolve(p.json(200, p.items('Back again')));
  await p.flush();
  assert.match(p.list(), /Back again/);
});

test('an expired session goes to sign-in (and back), without retrying', async () => {
  const p = page({ onInbox: true });
  await p.flush();
  p.calls[0].resolve(p.json(401, { error: 'Sign in first.', signin: 'https://studio.example/auth/signin' }));
  await p.advance(5_000);
  assert.equal(p.calls.length, 1, 'no retry');
  assert.equal(p.location.href, `https://studio.example/auth/signin?next=${encodeURIComponent('https://studio.example/#inbox')}`);
  assert.match(p.list(), /Signing in again/);
});

test('a 5xx or a page that is not JSON (a cold start) is retried; a 4xx is not', async () => {
  const p = page({ onInbox: true });
  await p.flush();
  p.calls[0].resolve(p.notJson(502));
  await p.advance(1_000);
  assert.equal(p.calls.length, 2);
  p.calls[1].resolve(p.json(200, p.items('After the cold start')));
  await p.flush();
  assert.match(p.list(), /After the cold start/);

  const q = page({ onInbox: true });
  await q.flush();
  q.calls[0].resolve(q.json(404, { error: 'No route GET /api/inbox' }));
  await q.advance(5_000);
  assert.equal(q.calls.length, 1);
  assert.match(q.list(), /No route GET/);
});

test('an error after cards were drawn keeps the cards and shows the error above them', async () => {
  const p = page({ onInbox: true });
  await p.flush();
  p.calls[0].resolve(p.json(200, p.items('Keep me')));
  await p.flush();
  p.streamOn.get('inbox')!({ topic: 'inbox', safety: true });
  await p.flush();
  p.calls[1].resolve(p.json(404, { error: 'Gone' }));
  await p.flush();
  assert.match(p.list(), /Keep me/);
  assert.match(p.errBox().innerHTML, /Gone/);
  assert.equal(p.errBox().hidden, false);
  p.clickRetry();
  await p.flush();
  p.calls[2].resolve(p.json(200, p.items('Keep me')));
  await p.flush();
  assert.equal(p.errBox().hidden, true);
});

test('shown while the page is hidden: it loads when the page is visible again', async () => {
  const p = page({ onInbox: false, hidden: true });
  await p.flush();
  p.showInbox();
  await p.flush();
  assert.equal(p.calls.length, 0, 'nothing while hidden');
  p.setHidden(false);
  await p.flush();
  assert.equal(p.calls.length, 1);
  p.calls[0].resolve(p.json(200, p.items('Hello')));
  await p.flush();
  assert.match(p.list(), /Hello/);
});

test('asked again while a load is in flight: one request at a time, then one more for the newest', async () => {
  const p = page({ onInbox: true });
  await p.flush();
  p.showInbox();
  p.showInbox();
  await p.flush();
  assert.equal(p.calls.length, 1, 'still one in flight');
  p.calls[0].resolve(p.json(200, p.items('Old')));
  await p.flush();
  assert.equal(p.calls.length, 2, 'then one more');
  p.calls[1].resolve(p.json(200, p.items('New')));
  await p.flush();
  assert.match(p.list(), /New/);
  assert.equal(p.calls.length, 2);
});
