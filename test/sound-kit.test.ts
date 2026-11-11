import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore: plain JS
import { createSoundKit, pickVariant, jitterRate, MAX_JITTER } from '../clients/web/hawkes-sound.js';
// @ts-ignore: plain JS
import { startAudioProbe } from '../clients/web/hawkes-audio.js';
import { audioMetricsFromEvents } from '../src/audio.ts';

function fakeWin() {
  const listeners: Record<string, Function[]> = {};
  const docL: Record<string, Function[]> = {};
  const started: any[] = [];
  const gainNode = () => ({ gain: { value: 1, setTargetAtTime(v: number) { this.value = v; }, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} });
  class AC {
    state = 'suspended'; currentTime = 0; sampleRate = 8000; destination = {};
    async resume() { this.state = 'running'; }
    createGain() { return gainNode(); }
    createBuffer(_c: number, n: number, sr: number) { return { length: n, duration: n / sr, getChannelData: () => new Float32Array(n) }; }
    createMediaStreamDestination() { return { stream: {} }; }
    createBufferSource() { return { playbackRate: { value: 1 }, connect() {}, start() {}, stop() {} }; }
  }
  const ctx: any = new AC();
  const Real = AC;
  void Real;
  const win: any = {
    AudioContext: Object.assign(function (this: any) { return ctx; }, { prototype: AC.prototype }) as any, CustomEvent: class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o.detail; } },
    addEventListener: (t: string, f: Function) => (listeners[t] ||= []).push(f),
    removeEventListener() {},
    dispatchEvent: (e: any) => { for (const f of listeners[e.type] || []) f(e); },
    document: { addEventListener: (t: string, f: Function) => (docL[t] ||= []).push(f), removeEventListener() {} },
  };
  const press = (type: string, target?: any) => { for (const f of [...(listeners[type] || []), ...(docL[type] || [])]) f({ type, pointerType: 'touch', target }); };
  return { win, ctx, press, started };
}

test('pickVariant never repeats back to back and uses every variant; jitter stays within ±5%', () => {
  let last = -1; const seen = new Set<number>();
  for (let i = 0; i < 500; i++) { const v = pickVariant(4, last); assert.notEqual(v, last); seen.add(v); last = v; }
  assert.equal(seen.size, 4);
  for (let i = 0; i < 500; i++) { const r = jitterRate(1, 0.5); assert.ok(r >= 0.95 && r <= 1.05); }
  assert.equal(MAX_JITTER, 0.05);
});

test('kit + probe: 3+ distinct footsteps with no repeat, music ducks >= 6 dB under voice, first tap resumes and ui plays', async () => {
  const { win, ctx, press } = fakeWin();
  const events: any[] = [];
  const probe = startAudioProbe({ win, emit: (e: any) => events.push(e) });
  const kit = createSoundKit({ win });
  kit.defineSet('step', { bus: 'sfx', synth: { kind: 'step', count: 4 } });
  kit.music({ bpm: 120, stems: { drums: 'synth', bass: 'synth' } });

  // iOS-style first tap on a button: resumes the context and plays the ui bus.
  const btn = { closest: () => btn, getAttribute: () => null };
  press('pointerdown', btn);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ctx.state, 'running');

  for (let i = 0; i < 20; i++) kit.play('step');
  const buf = ctx.createBuffer(1, 8000, 8000);
  await kit.speak('hello', { buffer: buf });

  const ev = probe.events();
  assert.ok(ev.some((e: any) => e.type === 'audiocontext-resume' && e.how === 'first-tap'));
  assert.ok(ev.some((e: any) => e.type === 'sound-start' && e.bus === 'ui'), 'the press played a ui sound');
  const steps = ev.filter((e: any) => e.type === 'sound-start' && String(e.sample).startsWith('step/'));
  assert.equal(steps.length, 20);
  assert.ok(new Set(steps.map((e: any) => e.sample)).size >= 3);
  steps.forEach((e: any, i: number) => { if (i) assert.notEqual(e.sample, steps[i - 1].sample); assert.ok(e.rate >= 0.95 && e.rate <= 1.05); });
  assert.ok(ev.some((e: any) => e.type === 'bus-gain' && e.bus === 'music' && e.gain <= 0.5));
  assert.ok(probe.metrics()['audio.voiceDuckDb'] >= 6);
  // Studio's analyser reads the same timeline.
  const m = audioMetricsFromEvents(ev.map((e: any) => ({ ...e })));
  assert.ok(m.metrics['audio.voiceDuckDb'] >= 6);
  probe.stop(); kit.dispose();
});

test('setStem lands on the next bar line', () => {
  const { win, ctx } = fakeWin();
  const kit = createSoundKit({ win, autoUi: false });
  kit.music({ bpm: 120, beatsPerBar: 4, stems: { drums: 'synth', bass: 'synth' }, on: ['drums'] });
  ctx.currentTime = 0.3;
  const at = kit.setStem('bass', true);
  assert.ok(at != null && Math.abs(at - 2.05) < 1e-6, 'a multiple of one 2 s bar after the start');
  kit.dispose();
});
