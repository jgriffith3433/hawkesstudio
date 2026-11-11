// The phone UI layer (src/ui.ts, clients/web/hawkes-ui.js; the rubric's menus-and-ui rule): rect analysis in both
// orientations, metrics from the event timeline, dead and silent presses named in findings, and the quality gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ui-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const { analyzeRects } = await import('../clients/web/hawkes-ui.js');
const { enrichUi, uiFindings, uiMetricsFromEvents, uiSummary } = await import('../src/ui.ts');
const { qualityGate, baseRules } = await import('../src/quality.ts');

const fx = (id: string, x: number, y: number, w: number, h: number) => ({ id, label: id, x, y, w, h, fixed: true });
const ev = (type: string, t: number, d: any) => ({ t, type, detail: JSON.stringify(d) });

test('analyzeRects flags small, inset, offscreen, spacing and reach, per orientation', () => {
  const portrait = analyzeRects([fx('Menu', 10, 10, 30, 30), fx('Play', 100, 700, 190, 56), fx('Next', 300, 760, 80, 56), fx('Gone', 350, 400, 80, 50)], { width: 390, height: 844 });
  const kinds = (id: string) => portrait.filter((i) => i.id === id).map((i) => i.kind).sort();
  assert.deepEqual(kinds('Menu'), ['inset', 'reach', 'small']);
  assert.deepEqual(kinds('Play'), []); // 10 px from Next: fine
  assert.deepEqual(kinds('Gone'), ['offscreen']);
  const landscape = analyzeRects([fx('Pause', 10, 10, 50, 50), fx('Fire', 700, 320, 60, 60)], { width: 844, height: 390 });
  assert.ok(landscape.some((i) => i.id === 'Pause' && i.kind === 'inset'), 'the notch is on the left in landscape');
  assert.ok(landscape.some((i) => i.id === 'Fire' && i.kind === 'inset'), 'the home bar at the bottom');
  const tight = analyzeRects([fx('A', 10, 700, 60, 60), fx('B', 74, 700, 60, 60)], { width: 390, height: 844 });
  assert.ok(tight.some((i) => i.kind === 'spacing'));
  // A control in a page that scrolls is not under the notch, and below the fold is not offscreen.
  const scrolling = analyzeRects([{ id: 'Below', label: 'Below', x: 20, y: 1200, w: 200, h: 50, fixed: false }], { width: 390, height: 844, docH: 2000 });
  assert.deepEqual(scrolling, []);
});

const result = () => ({
  seconds: 20,
  events: [
    ev('audio-sensor', 0, { adapter: 'webaudio' }),
    ev('ui-layout', 1.2, { orientation: 'portrait', viewport: [390, 844], scene: 'Main Menu', controls: 3, outlined: true, issues: [
      { kind: 'small', id: 'btn-opt', label: 'Options', rect: [10, 10, 30, 30], detail: 'is 30x30 px' },
      { kind: 'inset', id: 'btn-opt', label: 'Options', rect: [10, 10, 30, 30], detail: 'under the notch' },
    ] }),
    ev('ui-layout', 3.6, { orientation: 'landscape', viewport: [844, 390], scene: 'Main Menu', controls: 3, source: 'frame', issues: [
      { kind: 'small', id: 'btn-opt', label: 'Options', rect: [10, 10, 30, 30], detail: 'is 30x30 px' },
      { kind: 'offscreen', id: 'btn-play', label: 'Play', rect: [800, 300, 120, 60], detail: 'runs off the right edge' },
    ] }),
    ev('ui-press', 5, { t: 5, id: 'btn-play', label: 'Play', visual: true, visualMs: 16 }),
    ev('sound-start', 5.05, { type: 'sound-start', t: 5.05, sample: 'click', bus: 'ui' }),
    ev('ui-press', 7, { t: 7, id: 'btn-opt', label: 'Options', visual: false, visualMs: null }),
    ev('ui-press', 9, { t: 9, id: 'btn-shop', label: 'Shop', visual: true, visualMs: 30 }),
    ev('sound-start', 9.4, { type: 'sound-start', t: 9.4, sample: 'late', bus: 'ui' }),
  ],
});

test('ui metrics count each control once per orientation, and dead and silent presses by button', () => {
  const m = uiMetricsFromEvents(result()).metrics;
  assert.equal(m['ui.smallTargets'], 2, 'the same button, once in each orientation');
  assert.equal(m['ui.portrait.smallTargets'], 1);
  assert.equal(m['ui.landscape.smallTargets'], 1);
  assert.equal(m['ui.insetOverlaps'], 1);
  assert.equal(m['ui.offscreen'], 1);
  assert.equal(m['ui.landscape.offscreen'], 1);
  assert.equal(m['ui.deadPresses'], 1);
  assert.equal(m['ui.silentPresses'], 2, 'Options and Shop (its sound came 400 ms later); Play was heard');
});

test('findings name the control, the orientation and the press; spacing and reach are readings, not findings', () => {
  const r = enrichUi(result());
  const f = uiFindings(r, { scenario: 'smoke' });
  const titles = f.map((x) => x.title);
  assert.ok(titles.includes('Target under 44 px: Options (portrait)'));
  assert.ok(titles.includes('Target under 44 px: Options (landscape)'));
  assert.ok(titles.includes('Control off screen: Play (landscape)'));
  assert.ok(titles.includes('Dead press: Options'));
  assert.ok(titles.includes('Silent press: Shop'));
  assert.ok(f.find((x) => x.title.startsWith('Target under 44 px: Options (portrait)'))!.detail.includes('390x844'));
  assert.ok(f.find((x) => x.title.includes('(landscape)'))!.detail.includes('844x390'));
  assert.ok(uiSummary(r).includes('NO visual change'));
});

test('without the audio probe a press is dead or alive, never silent', () => {
  const r = { events: [ev('ui-press', 1, { t: 1, id: 'a', label: 'A', visual: true })] };
  const m = uiMetricsFromEvents(r).metrics;
  assert.equal(m['ui.deadPresses'], 0);
  assert.equal(m['ui.silentPresses'], undefined);
  assert.deepEqual(enrichUi({ events: [] }).metrics, undefined);
});

test('the rubric has menus-and-ui and the gate fails on its limits', () => {
  const rule = baseRules().find((x) => x.id === 'menus-and-ui');
  assert.ok(rule && rule.checks.length >= 5);
  const g = qualityGate({ id: 'g', engine: 'web' } as any, { metrics: { 'ui.smallTargets': 2, 'ui.offscreen': 0, 'ui.deadPresses': 1, 'ui.silentPresses': 0 } });
  const fails = g.fails.map((x) => x.check).sort();
  assert.deepEqual(fails, ['dead-presses', 'small-targets']);
});
