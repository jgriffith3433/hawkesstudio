// Hawkes sound kit v1: the drop-in mixer for web games (Babylon, Phaser, plain WebAudio). Agents use this instead of
// wiring raw clips. Source of truth: hawkesstudio/clients/web/hawkes-sound.js (copy next to hawkes-playtest.js).
// Spec: docs/playtest.md#sound-kit; how to use it: the sound-design skill; the Unity twin is HawkesSound.cs.
//
//   import { createSoundKit } from './hawkes-sound.js';
//   const sound = createSoundKit();                       // buses: music, sfx, ui, voice, ambience
//   sound.defineSet('step-stone', { bus: 'sfx', urls: ['s1.ogg', 's2.ogg', 's3.ogg', 's4.ogg'] });  // 3-5 variants
//   sound.defineSet('hit', { bus: 'sfx', synth: { kind: 'hit', count: 4 } });                       // no files yet
//   await sound.load();
//   sound.play('step-stone');                             // random variant, never the same twice in a row, rate within ±5%
//   sound.speak('npc-greeting', { url: 'greeting.mp3' }); // voice: music ducks at least 6 dB and comes back
//   sound.music({ bpm: 120, beatsPerBar: 4, stems: { drums: 'd.ogg', bass: 'b.ogg' }, on: ['drums'] });
//   sound.setStem('bass', true);                          // takes effect on the next bar line
//
// The first tap, click or key resumes the AudioContext (iOS Safari needs it) and every press on a button, link or
// [data-hawkes-ui] element plays the ui bus ('ui-press': four synthesized clicks unless the game defines its own).
//
// What the audio probe (hawkes-audio.js) reads: every source is tagged (__hawkesSampleId "set/variant", __hawkesBus,
// __hawkesGain, __hawkesDur) so its sound-start events carry the sample, bus, rate and gain; ducking dispatches a
// 'hawkes-sound' window event {type:'bus-gain', bus:'music', gain} which the probe logs as a bus-gain event, and a new
// context is announced the same way. Nothing here polls.

export const SOUND_VERSION = 1;
export const BUSES = ['music', 'sfx', 'ui', 'voice', 'ambience'];
/** Pitch jitter is capped at ±5%: the sound-design criterion reads every event's rate against its base pitch. */
export const MAX_JITTER = 0.05;
/** Music under voice drops at least this many dB (the audio probe's voice-duck limit is 6). */
export const MIN_DUCK_DB = 6;
export const DEFAULT_DUCK_DB = 9;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dbToGain = (db) => Math.pow(10, -db / 20);

/** Index of the next variant: random, never the one just played (when there is more than one). */
export function pickVariant(count, last = -1, rng = Math.random) {
  if (!(count > 1)) return 0;
  let i = Math.floor(rng() * (count - 1));
  if (last >= 0 && i >= last) i++;
  return clamp(i, 0, count - 1);
}

/** Playback rate: the base pitch times a random ±jitter (jitter capped at ±5%). */
export function jitterRate(base = 1, jitter = MAX_JITTER, rng = Math.random) {
  const j = clamp(Number(jitter) || 0, 0, MAX_JITTER);
  return Math.round(base * (1 + (rng() * 2 - 1) * j) * 10000) / 10000;
}

/** Small seeded generator so synthesized variants are the same on every load. */
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Procedural stand-ins (a click, a step, a hit, a thud, a blip): `count` different buffers of a kind. */
export function synthBuffers(ctx, kind = 'click', count = 4) {
  const sr = ctx.sampleRate || 44100;
  const out = [];
  for (let v = 0; v < count; v++) {
    const rnd = seeded(7919 * (v + 1) + kind.length * 101);
    const dur = { click: 0.07, step: 0.16, hit: 0.22, thud: 0.3, blip: 0.12 }[kind] ?? 0.12;
    const n = Math.max(1, Math.floor(sr * dur));
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const tone = { click: 1800, step: 160, hit: 240, thud: 90, blip: 880 }[kind] ?? 600;
    const f = tone * (0.8 + 0.4 * (v / Math.max(1, count - 1)) + rnd() * 0.05);
    const noise = { click: 0.2, step: 0.8, hit: 0.6, thud: 0.3, blip: 0 }[kind] ?? 0.3;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t * (6 / dur)) * Math.min(1, i / 40);
      lp += 0.35 * ((rnd() * 2 - 1) - lp);
      d[i] = env * (Math.sin(2 * Math.PI * f * t) * (1 - noise) + lp * noise) * 0.8;
    }
    buf.name = `${kind}-${v + 1}`;
    out.push(buf);
  }
  return out;
}

/** A looping synthesized stem exactly `bars` bars long (so stems of one track always line up). */
function synthStem(ctx, name, bpm, beatsPerBar, bars = 2) {
  const sr = ctx.sampleRate || 44100;
  const beat = 60 / bpm;
  const len = Math.round(sr * beat * beatsPerBar * bars);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const rnd = seeded(name.length * 313);
  const roots = [55, 65.4, 49, 58.3];
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const inBeat = (t % beat) / beat;
    let v = 0;
    if (name === 'drums') v = Math.exp(-inBeat * 14) * Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-inBeat * 30)) * inBeat * beat) * 0.7 + (Math.floor(t / beat) % 2 ? (rnd() * 2 - 1) * Math.exp(-inBeat * 20) * 0.2 : 0);
    else if (name === 'bass') v = Math.sin(2 * Math.PI * roots[Math.floor(t / (beat * beatsPerBar)) % 4] * t) * 0.35;
    else v = Math.sin(2 * Math.PI * roots[Math.floor(t / (beat * beatsPerBar)) % 4] * 4 * t) * 0.08 * (0.6 + 0.4 * Math.sin(t * 0.7));
    d[i] = v * 0.7;
  }
  buf.name = `${name}`;
  return buf;
}

/**
 * Make the kit. opts: { ctx, win, rng, autoUi (default true), duckDb (default 9, never under 6), duckAttack, duckRelease }.
 * `ctx` may be an existing AudioContext (a Babylon engine's); otherwise one is made (suspended until the first tap on iOS).
 */
export function createSoundKit(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const rng = opts.rng || Math.random;
  const AC = win?.AudioContext || win?.webkitAudioContext;
  const ctx = opts.ctx || (AC ? new AC() : null);
  if (!ctx) throw new Error('hawkes-sound: no AudioContext in this environment');
  const duckDb = Math.max(MIN_DUCK_DB, Number(opts.duckDb) || DEFAULT_DUCK_DB);
  const duckAttack = opts.duckAttack ?? 0.06;
  const duckRelease = opts.duckRelease ?? 0.5;
  const emit = (detail) => { try { win?.dispatchEvent?.(new win.CustomEvent('hawkes-sound', { detail })); } catch {} };

  // Graph: each bus -> master. Music has a second gain, the duck, so the player's music volume and the duck never fight.
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const bus = {};
  for (const name of BUSES) {
    const g = ctx.createGain();
    g.gain.value = 1;
    bus[name] = g;
  }
  const duck = ctx.createGain();
  duck.gain.value = 1;
  bus.music.connect(duck);
  duck.connect(master);
  for (const name of BUSES) if (name !== 'music') bus[name].connect(master);
  try { (win.__hawkesSoundContexts = win.__hawkesSoundContexts || []).push(ctx); } catch {}
  win && (win.__hawkesAudioContext = win.__hawkesAudioContext || ctx);
  emit({ type: 'context', ctx });

  const sets = new Map();   // name -> { bus, buffers[], rate, jitter, volume, volumeJitter, last }
  let voiceCount = 0;
  let duckLevel = 1;
  const duckTo = (gain) => {
    duckLevel = gain;
    try { duck.gain.cancelScheduledValues?.(ctx.currentTime); duck.gain.setTargetAtTime?.(gain, ctx.currentTime, gain < 1 ? duckAttack / 3 : duckRelease / 3); } catch {}
    if (!duck.gain.setTargetAtTime) duck.gain.value = gain;
    emit({ type: 'bus-gain', bus: 'music', gain: Math.round(gain * 1000) / 1000 });
  };

  /** Tag and start one source on a bus. Everything the probe reads is set here, before start(). */
  function startSource(buffer, { busName, id, rate, volume = 1, loop = false, when = 0, offset = 0, onended }) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    if (src.playbackRate) src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(bus[busName]);
    src.__hawkesSampleId = id;
    src.__hawkesBus = busName;
    src.__hawkesGain = busName === 'music' ? duckLevel * volume : volume;
    src.__hawkesDur = buffer.duration ? buffer.duration / rate : undefined;
    if (onended) src.onended = onended;
    src.start(when, offset);
    return { src, gain: g };
  }

  async function decode(url) {
    const res = await (win.fetch ? win.fetch(url) : fetch(url));
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await new Promise((ok, bad) => { const p = ctx.decodeAudioData(arr, ok, bad); p?.then?.(ok, bad); });
    buf.name = url.split('/').pop().split('?')[0];
    return buf;
  }

  /**
   * A variant set: `urls` (3-5 files), `buffers`, or `synth: {kind, count}`. rate = base pitch; jitter ≤ 0.05;
   * volume with volumeJitter. Frequent sounds (footsteps, hits, UI) need 3+ variants.
   */
  function defineSet(name, o = {}) {
    const set = {
      name, bus: BUSES.includes(o.bus) ? o.bus : 'sfx', urls: o.urls || [], buffers: o.buffers ? o.buffers.slice() : [],
      synth: o.synth || null, rate: o.pitch ?? 1, jitter: clamp(o.jitter ?? MAX_JITTER, 0, MAX_JITTER),
      volume: o.volume ?? 1, volumeJitter: clamp(o.volumeJitter ?? 0.1, 0, 0.3), last: -1,
    };
    sets.set(name, set);
    if (set.synth && !set.buffers.length) set.buffers = synthBuffers(ctx, set.synth.kind, set.synth.count || 4);
    return set;
  }

  /** Fetch and decode every set's files and every stem. Resolves when the game can play everything. */
  async function load() {
    const jobs = [];
    for (const set of sets.values()) {
      if (set.buffers.length || !set.urls.length) continue;
      jobs.push(Promise.all(set.urls.map(decode)).then((b) => { set.buffers = b; }));
    }
    for (const s of stemList) if (!s.buffer && s.url) jobs.push(decode(s.url).then((b) => { s.buffer = b; }));
    await Promise.all(jobs);
  }

  /** Play one variant of a set: no immediate repeat, ±5% pitch, small volume jitter. Returns the played info or null. */
  function play(name, o = {}) {
    if (name === 'ui-press' && !sets.has(name)) defineSet(name, { bus: 'ui', synth: { kind: 'click', count: 4 } });
    const set = sets.get(name);
    if (!set || !set.buffers.length) return null;
    const i = pickVariant(set.buffers.length, set.last, rng);
    set.last = i;
    const rate = jitterRate(set.rate * (o.pitch ?? 1), o.jitter ?? set.jitter, rng);
    const vol = clamp((o.volume ?? set.volume) * (1 + (rng() * 2 - 1) * set.volumeJitter), 0, 2);
    const b = set.buffers[i];
    const id = `${name}/${i + 1}`;
    try { if (!b.name) b.name = id; } catch {}
    startSource(b, { busName: o.bus && BUSES.includes(o.bus) ? o.bus : set.bus, id, rate, volume: vol, loop: !!o.loop });
    return { sample: id, variant: i, rate, volume: vol, bus: set.bus };
  }

  /** A voice line (a set or a url): plays on the voice bus and ducks the music at least 6 dB until it ends. */
  async function speak(name, o = {}) {
    let buffer = o.buffer || sets.get(name)?.buffers?.[0];
    if (!buffer && o.url) buffer = await decode(o.url);
    if (!buffer) return null;
    voiceCount++;
    const id = `voice/${name}`;
    const { src } = startSource(buffer, {
      busName: 'voice', id, rate: 1, volume: o.volume ?? 1,
      onended: () => { if (--voiceCount <= 0) { voiceCount = 0; duckTo(1); } },
    });
    duckTo(dbToGain(duckDb));
    return { sample: id, duckDb, src };
  }

  // ---- bar-synced music stems ----
  const stemList = [];
  let track = null;
  /**
   * { bpm, beatsPerBar, stems: { name: url | AudioBuffer | 'synth' }, on: [names playing at the start], volume }.
   * Every stem loops from the same start time, so stems always line up; setStem() changes on the next bar line.
   */
  function music(o = {}) {
    stopMusic();
    const bpm = o.bpm || 120, beatsPerBar = o.beatsPerBar || 4;
    stemList.length = 0;
    for (const [name, v] of Object.entries(o.stems || {})) {
      const s = { name, url: typeof v === 'string' && v !== 'synth' ? v : null, buffer: v && typeof v === 'object' ? v : null };
      if (v === 'synth') s.buffer = synthStem(ctx, name, bpm, beatsPerBar);
      stemList.push(s);
    }
    track = { bpm, beatsPerBar, barLen: (60 / bpm) * beatsPerBar, volume: o.volume ?? 0.8, on: new Set(o.on || stemList.map((s) => s.name)), startAt: 0, playing: false };
    if (stemList.every((s) => s.buffer)) startMusic();
    return track;
  }
  function startMusic() {
    if (!track || track.playing) return;
    track.playing = true;
    track.startAt = ctx.currentTime + 0.05;
    for (const s of stemList) {
      if (!s.buffer) continue;
      const on = track.on.has(s.name);
      const { src, gain } = startSource(s.buffer, { busName: 'music', id: `music/${s.name}`, rate: 1, volume: on ? track.volume : 0, loop: true, when: track.startAt });
      s.src = src; s.gain = gain;
    }
  }
  const nextBar = (t) => track.startAt + Math.max(1, Math.ceil((t - track.startAt) / track.barLen - 1e-9)) * track.barLen;
  /** Bring a stem in or out on the next bar line (a short fade there). Returns the context time it takes effect. */
  function setStem(name, on) {
    if (!track) return null;
    if (on) track.on.add(name); else track.on.delete(name);
    const s = stemList.find((x) => x.name === name);
    if (!s?.gain) return null;
    const at = nextBar(ctx.currentTime);
    try {
      s.gain.gain.setValueAtTime(s.gain.gain.value, at - 0.02);
      s.gain.gain.linearRampToValueAtTime(on ? track.volume : 0, at + 0.02);
    } catch { s.gain.gain.value = on ? track.volume : 0; }
    return at;
  }
  function stopMusic() {
    for (const s of stemList) { try { s.src?.stop(); } catch {} s.src = null; s.gain = null; }
    if (track) track.playing = false;
  }

  function setBusVolume(name, v) { if (bus[name]) bus[name].gain.value = clamp(v, 0, 1.5); }

  // ---- first tap resumes audio; every press on a control plays the ui bus ----
  const CONTROL = 'button, a[href], [role="button"], input[type="button"], input[type="submit"], [data-hawkes-ui]';
  function unlock() {
    if (ctx.state === 'running') return;
    try {
      const p = ctx.resume?.();
      // iOS Safari wants a sound started inside the gesture: a one-sample silent buffer.
      const b = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
      Promise.resolve(p).then(() => { if (track && !track.playing && stemList.every((x) => x.buffer)) startMusic(); }).catch(() => {});
    } catch {}
  }
  const cleanups = [];
  const onGesture = (e) => {
    unlock();
    if (api.autoUi === false || e.type !== 'pointerdown') return;
    const el = e.target?.closest?.(CONTROL);
    if (el && el.getAttribute('data-hawkes-ui') !== 'off') play('ui-press');
  };
  const doc = win?.document;
  if (doc?.addEventListener) {
    for (const type of ['pointerdown', 'keydown', 'touchend']) {
      doc.addEventListener(type, onGesture, true);
      cleanups.push(() => doc.removeEventListener(type, onGesture, true));
    }
  }
  // Prepare the default ui set now so the very first press already has a buffer.
  if (opts.autoUi !== false) defineSet('ui-press', { bus: 'ui', synth: { kind: 'click', count: 4 } });

  const api = {
    autoUi: opts.autoUi !== false,
    ctx, buses: bus, defineSet, load, play, speak, music, startMusic, setStem, stopMusic, setBusVolume, unlock,
    sets, duckDb, state: () => ctx.state,
    dispose() { stopMusic(); for (const c of cleanups) { try { c(); } catch {} } },
  };
  return api;
}
