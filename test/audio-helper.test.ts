import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore: plain JS
import { createAudioCore, sampleIdOf, busOf, startAudioProbe } from '../clients/web/hawkes-audio.js';

test('createAudioCore: silent jump, identical repeat, first-tap resume', () => {
  let t = 0;
  const core = createAudioCore({ now: () => t, scene: () => 'Arena' });
  core.input({ action: 'jump' });
  t = 0.2; // 200 ms later: silent
  core.soundStart({ sample: 'land', bus: 'sfx' });
  t = 1;
  core.soundStart({ sample: 'foot', bus: 'sfx', rate: 1 });
  t = 1.5;
  core.soundStart({ sample: 'foot', bus: 'sfx', rate: 1 });
  t = 2;
  core.resume({ how: 'first-tap' });
  core.settleSilents(2);
  const m = core.metrics();
  assert.equal(m['audio.silentActions'], 1);
  assert.equal(m['audio.identicalRepeats60s'], 1);
  assert.equal(m['audio.resumes'], 1);
  assert.ok(core.events().some((e: any) => e.type === 'audiocontext-resume' && e.how === 'first-tap'));
});

test('sampleIdOf and busOf honour __hawkes tags', () => {
  assert.equal(sampleIdOf({ __hawkesSampleId: 'jump' }), 'jump');
  assert.equal(busOf({ __hawkesBus: 'voice' }), 'voice');
  assert.equal(busOf({ name: 'MusicBus' }), 'music');
});

test('startAudioProbe listens for pointerdown and logs resume when context was suspended', () => {
  const pushed: any[] = [];
  const listeners: Record<string, Function[]> = {};
  const ctx = {
    state: 'suspended',
    resume: async () => { ctx.state = 'running'; },
    createMediaStreamDestination: () => ({ stream: {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const win: any = {
    AudioContext: function AudioContext() { return ctx; },
    addEventListener: (type: string, fn: Function, _cap?: boolean) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: Function) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    dispatchEvent: () => true,
    CustomEvent: class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } },
    __hawkesPlaytestPush: (m: any) => pushed.push(m),
    MediaRecorder: null,
  };
  win.AudioContext.prototype = { createBufferSource: function () { return { start() {}, connect() {}, buffer: null }; } };
  // Avoid wrapping twice across tests.
  delete win.__hawkesAudioContextWrapped;

  const probe = startAudioProbe({
    win,
    now: () => 0,
    scene: () => 'Title',
  });
  // Register the suspended context the game already made.
  (probe as any); // started
  // Manually tap: the probe wraps AudioContext on construct; feed it via mark path and gesture.
  assert.ok(listeners.pointerdown?.length || listeners.touchstart?.length || listeners.keydown?.length);

  // Simulate a first tap while a suspended context is known: call the pointer handler after adding ctx.
  // The probe discovers contexts created through its wrapped constructor:
  const AC = win.AudioContext;
  const c = new AC();
  assert.equal(c.state, 'suspended');
  const handler = listeners.pointerdown?.[0] || listeners.touchstart?.[0];
  assert.ok(handler, 'gesture listener installed');
  handler({ type: 'pointerdown', pointerType: 'touch', button: 0 });
  // resume is async; wait a tick
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    const m = probe.metrics();
    assert.ok(m['audio.inputs'] >= 1);
    assert.ok(m['audio.resumes'] >= 1 || probe.events().some((e: any) => e.type === 'audiocontext-resume'));
    probe.stop();
  });
});
