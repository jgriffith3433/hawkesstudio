// The dashboard's scripts, loaded the way the browser loads them: dashboard/index.html's <script> tags in order, as
// classic scripts sharing one global scope, in a fake DOM where every element, call and property is a harmless stand-in.
// A script that uses a global another script defines later (studioStream before stream.js, a const before its line)
// throws a ReferenceError at its top level, and everything after it in that script never runs: J's "Cannot access
// 'CH_ICON' before initialization". This fails on that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const dir = path.join(import.meta.dirname, '..', 'dashboard');

/** Anything: an element, a list, a function, a value. Every property is another stand-in; it iterates as empty. */
function anything(): any {
  const fn = function () {};
  const p: any = new Proxy(fn, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === Symbol.asyncIterator) return async function* () {};
      if (k === 'then') return undefined; // not a promise
      if (k === 'length' || k === 'size') return 0;
      if (typeof k === 'symbol') return undefined;
      return p;
    },
    set: () => true,
    has: () => true,
    apply: () => p,
    construct: () => p,
  });
  return p;
}

test('every dashboard script loads in index.html order without a top-level ReferenceError', async () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => m[1]).filter((s) => !/^(https?:)?\/\//.test(s));
  assert.ok(scripts.includes('app.js') && scripts.includes('stream.js'), `index.html's scripts: ${scripts}`);

  const errors: string[] = [];
  const never = () => new Promise(() => {});
  const g: any = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, queueMicrotask() {},
    fetch: never,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '', href: 'https://studio.example/', pathname: '/', search: '', origin: 'https://studio.example', host: 'studio.example', reload() {} },
    URL, URLSearchParams, Promise, Date, Math, JSON, Map, Set, WeakMap, WeakSet, Array, Object, String, Number, Boolean, RegExp, Error, TypeError, Symbol, Intl,
    TextEncoder, TextDecoder, AbortController, Blob: class {}, FormData: class {}, Headers,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, alert() {}, confirm: () => false, prompt: () => null, open: () => null, scrollTo() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  };
  // The DOM and browser APIs: stand-ins.
  for (const k of ['document', 'navigator', 'EventSource', 'Audio', 'AudioContext', 'webkitAudioContext', 'speechSynthesis', 'SpeechSynthesisUtterance',
    'SpeechRecognition', 'webkitSpeechRecognition', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Worker', 'Notification', 'history',
    'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MediaRecorder', 'Image', 'screen', 'performance', 'crypto', 'visualViewport']) g[k] = anything();
  g.window = g; g.self = g; g.globalThis = g;
  g.innerWidth = 1280; g.innerHeight = 800; g.devicePixelRatio = 1;
  const ctx = vm.createContext(g);

  // Async code that started at a top level (show(tab)'s loadChanges) fails later, as a rejected promise.
  const onRejection = (e: any) => { if (e?.name === 'ReferenceError') errors.push(`async: ${e.message}`); };
  process.on('unhandledRejection', onRejection);
  try {
    for (const s of scripts) {
      try {
        vm.runInContext(fs.readFileSync(path.join(dir, s), 'utf8'), ctx, { filename: s });
      } catch (e: any) {
        // Only an undefined or not-yet-initialised global is the order bug; anything else is the fake DOM falling short.
        if (e?.name === 'ReferenceError') errors.push(`${s}: ${e.message}`);
        else errors.push(`${s}: ${e?.name}: ${e?.message} (the fake DOM in this test may need more)`);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(errors, []);
  // They really ran to the end: app.js's Changes tab (below its studioStream line) and the last script.
  assert.equal(vm.runInContext('typeof CH_ICON + typeof loadChanges', ctx), 'objectfunction');
  assert.equal(vm.runInContext('typeof HawkesGuide', ctx), 'object');
});

test('index.html loads stream.js before every script that uses studioStream', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const at = scripts.indexOf('stream.js');
  assert.ok(at >= 0, 'stream.js is loaded');
  for (const s of scripts.slice(0, at)) {
    const src = fs.readFileSync(path.join(dir, s), 'utf8');
    assert.ok(!/\bstudioStream\b/.test(src), `${s} uses studioStream but loads before stream.js`);
  }
});
