// The UI kit (clients/web/hawkes-ui.js createUiKit; docs/playtest.md#ui-kit): a press shows its pressed state and plays the
// ui-bus click once, logs exactly one ui-press through the probe, screens slide 150-200 ms (0 with reduced motion), and the
// safe-area variables never go under the simulated notch and home bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore: plain JS
import { createUiKit, transitionMs, simulatedInsets, kitCss, startUiProbe } from '../clients/web/hawkes-ui.js';
import { uiMetricsFromEvents } from '../src/ui.ts';

function fakeEl(attrs: Record<string, string> = {}, extra: any = {}) {
  const a = new Map(Object.entries(attrs));
  const el: any = {
    nodeType: 1, hidden: false, tagName: 'BUTTON', innerText: attrs['aria-label'] ?? 'Play', className: '', id: '',
    getAttribute: (k: string) => a.get(k) ?? null, setAttribute: (k: string, v: string) => a.set(k, v), removeAttribute: (k: string) => a.delete(k), hasAttribute: (k: string) => a.has(k),
    closest(sel: string) { return sel.includes('hawkes-ui-overlay') ? null : el; }, getBoundingClientRect: () => ({ left: 10, top: 700, width: 190, height: 56 }),
    querySelector: () => null, parentElement: null, animate: undefined, style: {}, remove() {}, ...extra,
  };
  return el;
}
function fakeWin(reduced = false, w = 390, h = 844) {
  const L: Record<string, Function[]> = {}; const D: Record<string, Function[]> = {};
  const rootStyle: Record<string, string> = {};
  const screens = ['menu', 'options'].map((n, i) => fakeEl({ 'data-ui-screen': n }, { hidden: i === 1, animate: (_k: any, o: any) => { const fin = new Promise((r) => setTimeout(r, o.duration)); return { finished: fin, cancel() {} }; } }));
  const win: any = {
    innerWidth: w, innerHeight: h, location: { search: '?playtest=1' }, performance, CustomEvent: class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o.detail; } },
    matchMedia: () => ({ matches: reduced }), requestAnimationFrame: (f: Function) => setTimeout(f, 1),
    getComputedStyle: () => ({ paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' }),
    addEventListener: (t: string, f: Function) => (L[t] ||= []).push(f), removeEventListener() {},
    dispatchEvent: (e: any) => { for (const f of L[e.type] || []) f(e); },
    document: {
      body: { appendChild() {} }, head: { appendChild() {} }, documentElement: { style: { setProperty: (k: string, v: string) => { rootStyle[k] = v; } }, appendChild() {} },
      querySelector: () => null, querySelectorAll: (s: string) => (s === '[data-ui-screen]' ? screens : []), createElement: () => fakeEl(), 
      addEventListener: (t: string, f: Function) => (D[t] ||= []).push(f), removeEventListener() {},
    },
  };
  const fire = (type: string, target: any, extra: any = {}) => { for (const f of D[type] || []) f({ type, target, pointerType: 'touch', button: 0, ...extra }); };
  return { win, fire, screens, rootStyle };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('transitionMs is 150-200 ms and exactly 0 with reduced motion', () => {
  assert.equal(transitionMs(), 180);
  assert.equal(transitionMs(50), 150);
  assert.equal(transitionMs(900), 200);
  assert.equal(transitionMs(180, true), 0);
  assert.match(kitCss(), /min-width:44px;min-height:44px/);
  assert.match(kitCss(), /prefers-reduced-motion:reduce/);
});

test('a press: pressed state at once, one click, exactly one ui-press through the probe, visual within 100 ms', async () => {
  const { win, fire } = fakeWin();
  const events: any[] = [];
  const probe = startUiProbe({ win, emit: (type: string, d: any) => events.push({ t: 1, type, detail: JSON.stringify(d) }) });
  const played: string[] = [];
  const sound: any = { autoUi: true, unlock() {}, play: (n: string) => { played.push(n); return null; } };
  const ui = createUiKit({ win, sound });
  assert.equal(sound.autoUi, false, 'the kit takes over the sound kit\'s auto-click so a press clicks once');
  const btn = fakeEl({ 'aria-label': 'Play' });
  fire('pointerdown', btn);
  assert.ok(btn.hasAttribute('data-hawkes-pressed'), 'pressed state is on in the same event');
  assert.deepEqual(played, ['ui-press']);
  fire('pointerup', btn);
  await wait(30);
  assert.equal(events.filter((e) => e.type === 'ui-press').length, 1, 'one ui-press per press, not one from the probe and one from the kit');
  const m = uiMetricsFromEvents({ events });
  assert.equal(m.metrics['ui.presses'], 1);
  assert.equal(m.metrics['ui.deadPresses'], 0);
  assert.ok(m.presses[0].visualMs! <= 100);
  await wait(130);
  assert.ok(!btn.hasAttribute('data-hawkes-pressed'), 'the pressed state is released after a minimum hold');
  // A key press counts once too; a held key (repeat) does not.
  fire('keydown', btn, { key: 'Enter' }); fire('keydown', btn, { key: 'Enter', repeat: true });
  await wait(30);
  assert.equal(events.filter((e) => e.type === 'ui-press').length, 2);
  // data-hawkes-ui="off" and disabled controls make no press.
  fire('pointerdown', fakeEl({ 'data-hawkes-ui': 'off' })); fire('pointerdown', fakeEl({}, { disabled: true }));
  await wait(30);
  assert.equal(events.filter((e) => e.type === 'ui-press').length, 2);
  probe.stop(); ui.dispose();
});

test('screens slide for 150-200 ms and complete in 0 ms with reduced motion', async () => {
  for (const reduced of [false, true]) {
    const { win, screens } = fakeWin(reduced);
    const events: any[] = [];
    const probe = startUiProbe({ win, emit: (type: string, d: any) => events.push({ t: 1, type, detail: JSON.stringify(d) }) });
    const ui = createUiKit({ win, sound: false });
    const rec = await ui.show('options');
    assert.equal(screens[0].hidden, true); assert.equal(screens[1].hidden, false);
    const ev = JSON.parse(events.find((e) => e.type === 'ui-transition').detail);
    if (reduced) { assert.equal(rec.ms, 0); assert.equal(ev.ms, 0); assert.equal(ev.reduced, true); }
    else { assert.ok(rec.plannedMs >= 150 && rec.plannedMs <= 200); assert.ok(rec.ms >= 150 && rec.ms <= 200, `took ${rec.ms} ms`); }
    probe.stop(); ui.dispose();
  }
});

test('safe-area variables are at least the simulated notch and home bar at 390x844 and 844x390', () => {
  for (const [w, h] of [[390, 844], [844, 390]]) {
    const { win, rootStyle } = fakeWin(false, w, h);
    const ui = createUiKit({ win, sound: false });
    const got = ui.safeArea();
    const want = simulatedInsets(w, h);
    for (const k of ['top', 'right', 'bottom', 'left'] as const) { assert.ok(got[k] >= want[k]); assert.equal(rootStyle[`--hawkes-safe-${k}`], `${got[k]}px`); }
    ui.dispose();
  }
});

test('ui metrics read transitions and catch a double-logged press', () => {
  const ev = (type: string, t: number, d: any) => ({ t, type, detail: JSON.stringify(d) });
  const m = uiMetricsFromEvents({ events: [
    ev('ui-press', 1, { t: 1, id: 'a', label: 'Play', visual: true, visualMs: 8 }),
    ev('ui-press', 1.004, { t: 1.004, id: 'a', label: 'Play', visual: true, visualMs: 8 }),
    ev('ui-transition', 1.1, { ms: 180, plannedMs: 180, reduced: false }),
    ev('ui-transition', 2, { ms: 40, plannedMs: 180, reduced: false }),
    ev('ui-transition', 3, { ms: 0, plannedMs: 0, reduced: true }),
    ev('ui-transition', 4, { ms: 90, plannedMs: 0, reduced: true }),
  ] }).metrics;
  assert.equal(m['ui.duplicatePresses'], 1);
  assert.equal(m['ui.transitions'], 4);
  assert.equal(m['ui.transitionsOffSpec'], 2, 'a 40 ms slide and a reduced-motion one that took 90 ms');
});
