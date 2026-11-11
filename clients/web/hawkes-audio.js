// Hawkes playtest audio probe v1: what the game sounds like, measured while a playtest runs.
// Source of truth: hawkesstudio/clients/web/hawkes-audio.js (copy next to hawkes-playtest.js). Spec: docs/playtest.md#audio.
//
// It taps the page's AudioContext (Unity WebGL plays through WebAudio too) into a MediaRecorder, and pushes events
// for every sound start (sample id, bus, rate, gain) and every real input. Events are pushed, never polled.
// Studio (src/audio.ts) turns the timeline + the recording into audio.* metrics and sound-design findings.
//
// Web games get it through installPlaytest (hawkes-playtest.js) with every run (`audio: false` turns it off).
// Games that play through their own mixer can tag a node: source.__hawkesSampleId = 'jump'; gain.__hawkesBus = 'sfx'.

export const AUDIO_VERSION = 1;

export const AUDIO_DEFAULTS = {
  silentActionMs: 150,   // an input with no sound start within this fails sound-design
  identicalWindowS: 60,  // same sample + rate twice inside this window is an identical-repeat
  maxEvents: 2000,
};

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Sends a message to the runner right away (Playwright binding); nobody polls. */
export function pushToRunner(msg) {
  try { if (typeof window !== 'undefined' && typeof window.__hawkesPlaytestPush === 'function') window.__hawkesPlaytestPush(msg); } catch {}
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hawkes-playtest', { detail: msg })); } catch {}
}

/**
 * Sample id for a buffer source or media element. Games may set `__hawkesSampleId` on the node.
 */
export function sampleIdOf(node) {
  if (!node) return 'unknown';
  if (typeof node.__hawkesSampleId === 'string' && node.__hawkesSampleId) return node.__hawkesSampleId.slice(0, 120);
  if (typeof node.id === 'string' && node.id) return node.id.slice(0, 120);
  const b = node.buffer;
  if (b) {
    if (typeof b.name === 'string' && b.name) return b.name.slice(0, 120);
    return `buf:${r3(b.duration)}x${b.length}`;
  }
  if (typeof node.src === 'string' && node.src) {
    try { return decodeURIComponent(node.src.split('/').pop().split('?')[0]).slice(0, 120) || 'media'; } catch { return 'media'; }
  }
  if (node.constructor && node.constructor.name) return String(node.constructor.name).slice(0, 40);
  return 'unknown';
}

/** Bus for a node: `__hawkesBus` on it (or its buffer), else a name that looks like a bus, else `sfx`. */
export function busOf(node) {
  if (!node) return 'sfx';
  if (typeof node.__hawkesBus === 'string' && node.__hawkesBus) return node.__hawkesBus.slice(0, 40);
  if (typeof node.buffer?.__hawkesBus === 'string' && node.buffer.__hawkesBus) return node.buffer.__hawkesBus.slice(0, 40);
  const NAME = /(music|voice|sfx|ui|ambience|ambient|master)/i;
  for (const label of [node.name, node.id, node.buffer?.name]) {
    const m = NAME.exec(String(label ?? ''));
    if (m) return m[1].toLowerCase();
  }
  return 'sfx';
}

function gainOf(node) {
  try {
    if (typeof node?.__hawkesGain === 'number') return r2(node.__hawkesGain); // hawkes-sound.js: the bus's gain when it started
    if (node?.gain && typeof node.gain.value === 'number') return r2(node.gain.value);
    if (typeof node?.volume === 'number') return r2(node.volume);
  } catch {}
  return 1;
}

function rateOf(node) {
  try {
    if (node?.playbackRate && typeof node.playbackRate.value === 'number') return r3(node.playbackRate.value);
    if (typeof node?.playbackRate === 'number') return r3(node.playbackRate);
  } catch {}
  return 1;
}

/**
 * Engine-free core: feed it sound-start and input events; it keeps the timeline Studio analyses.
 * Also used by tests without a real AudioContext.
 */
export function createAudioCore({ emit = () => {}, now = () => 0, scene = () => undefined, thresholds = {} } = {}) {
  const th = { ...AUDIO_DEFAULTS, ...thresholds };
  const events = [];
  let n = 0;
  let sceneName;
  const m = {
    sounds: 0, inputs: 0, resumes: 0,
    longestSilenceS: 0, silentActions: 0, identicalRepeats60s: 0, voiceDuckDb: 0, hadVoice: false,
  };
  let lastSoundT = null;
  let playStarted = null;
  const recent = []; // { id, rate, t } for identical repeats
  const voiceUntil = []; // voice end times for ducking
  let musicGain = 1;

  function inPlay(sc) {
    const s = String(sc ?? '');
    return !/\b(load(ing)?|title|main menu|menu|splash|intro|boot|lobby|start screen|press start)\b/i.test(s);
  }

  function push(ev) {
    if (events.length >= th.maxEvents) return;
    events.push(ev);
    try { emit(ev); } catch {}
  }

  function soundStart({ sample, bus = 'sfx', rate = 1, gain = 1, dur, t: at } = {}) {
    const t = at ?? now();
    const sc = scene() ?? sceneName;
    if (sc !== undefined) sceneName = sc;
    if (playStarted == null && inPlay(sc)) playStarted = t;
    if (lastSoundT != null && inPlay(sc)) {
      const gap = t - lastSoundT;
      if (gap > m.longestSilenceS) m.longestSilenceS = r2(gap);
    }
    if (inPlay(sc)) lastSoundT = t;
    const id = String(sample ?? 'unknown').slice(0, 120);
    const r = Number(rate) || 1;
    const b = String(bus || 'sfx').toLowerCase().slice(0, 40);
    const g = Number.isFinite(Number(gain)) ? Number(gain) : 1;
    m.sounds++;
    // Identical sample + rate within the window.
    const win = th.identicalWindowS;
    for (const prev of recent) {
      if (t - prev.t > win) continue;
      if (prev.id === id && Math.abs(prev.rate - r) < 0.001) {
        m.identicalRepeats60s++;
        break;
      }
    }
    recent.push({ id, rate: r, t });
    while (recent.length && t - recent[0].t > win) recent.shift();
    if (b === 'music') musicGain = g;
    if (b === 'voice') {
      m.hadVoice = true;
      voiceUntil.push(t + (Number(dur) > 0 ? Number(dur) : 2));
      // Duck = how far music is below unity while voice plays (positive dB of reduction).
      if (musicGain > 0 && musicGain < 1) {
        const db = -20 * Math.log10(Math.max(1e-6, musicGain));
        if (db > m.voiceDuckDb) m.voiceDuckDb = r2(db);
      }
    } else if (voiceUntil.some((end) => t <= end) && b === 'music' && g > 0 && g < 1) {
      const db = -20 * Math.log10(Math.max(1e-6, g));
      if (db > m.voiceDuckDb) m.voiceDuckDb = r2(db);
    }
    while (voiceUntil.length && voiceUntil[0] < t) voiceUntil.shift();
    const ev = { type: 'sound-start', t: r2(t), sample: id, bus: b, rate: r3(r), gain: r2(g), scene: sc ?? undefined, id: `aud-${++n}` };
    if (Number(dur) > 0) ev.dur = r2(Number(dur));
    push(ev);
    return ev;
  }

  /** A bus's gain moved (the sound kit's ducking): music below 1 while a voice line plays is the duck. */
  function busGain({ bus = 'music', gain = 1, t: at } = {}) {
    const t = at ?? now();
    const b = String(bus || 'music').toLowerCase().slice(0, 40);
    const g = Number.isFinite(Number(gain)) ? Number(gain) : 1;
    if (b === 'music') {
      musicGain = g;
      if (g > 0 && g < 1 && voiceUntil.some((end) => t <= end)) {
        const db = -20 * Math.log10(Math.max(1e-6, g));
        if (db > m.voiceDuckDb) m.voiceDuckDb = r2(db);
      }
    }
    const ev = { type: 'bus-gain', t: r2(t), bus: b, gain: r3(g), id: `aud-${++n}` };
    push(ev);
    return ev;
  }

  function input({ action = 'input', t: at } = {}) {
    const t = at ?? now();
    const sc = scene() ?? sceneName;
    m.inputs++;
    const ev = { type: 'input', t: r2(t), action: String(action).slice(0, 80), scene: sc ?? undefined, id: `aud-${++n}` };
    push(ev);
    // Silent action: no sound-start within silentActionMs after this input (resolved when a later sound arrives, or at end).
    ev._pendingSilent = true;
    return ev;
  }

  function resume({ t: at, how = 'gesture' } = {}) {
    const t = at ?? now();
    m.resumes++;
    const ev = { type: 'audiocontext-resume', t: r2(t), how: String(how).slice(0, 40), id: `aud-${++n}` };
    push(ev);
    return ev;
  }

  function settleSilents(endT) {
    const end = endT ?? now();
    const ms = th.silentActionMs / 1000;
    for (const ev of events) {
      if (ev.type !== 'input' || !ev._pendingSilent) continue;
      const heard = events.some((s) => s.type === 'sound-start' && s.t >= ev.t - 0.001 && s.t <= ev.t + ms);
      delete ev._pendingSilent;
      if (!heard) {
        m.silentActions++;
        ev.silent = true;
      }
    }
    // Trailing silence in play.
    if (lastSoundT != null && playStarted != null) {
      const gap = end - lastSoundT;
      if (gap > m.longestSilenceS && inPlay(sceneName)) m.longestSilenceS = r2(gap);
    }
  }

  return {
    soundStart, busGain, input, resume, settleSilents,
    events: () => events.slice(),
    metrics: () => {
      const out = {
        'audio.sounds': m.sounds,
        'audio.inputs': m.inputs,
        'audio.resumes': m.resumes,
        'audio.longestSilenceS': r2(m.longestSilenceS),
        'audio.silentActions': m.silentActions,
        'audio.identicalRepeats60s': m.identicalRepeats60s,
      };
      // Only when voice played: otherwise an optional min:6 check would fail every quiet run.
      if (m.hadVoice) out['audio.voiceDuckDb'] = r2(m.voiceDuckDb);
      return out;
    },
    thresholds: th,
  };
}

/**
 * Install the page probe: hooks AudioContext / buffer sources / media elements, records the tapped graph,
 * and listens for real pointer/key input (and AudioContext resume on first gesture).
 *
 * opts: { emit(ev), now(), scene(), thresholds, win }
 * Returns { core, stop(), mark(sample, opts), metrics(), events(), info() }.
 */
export function startAudioProbe(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
  const t0 = now();
  const rel = () => Math.max(0, now() - t0);
  const core = createAudioCore({
    emit: (ev) => {
      try { opts.emit?.(ev); } catch {}
      pushToRunner({ type: 'audio', event: ev });
    },
    now: rel,
    scene: opts.scene,
    thresholds: opts.thresholds,
  });

  const cleanups = [];
  const contexts = new Set();
  let recorder = null;
  let dest = null;
  let hookedProto = false;

  function ensureRecorder(ctx) {
    if (recorder || !ctx || typeof ctx.createMediaStreamDestination !== 'function') return;
    try {
      dest = ctx.createMediaStreamDestination();
      ctx.__hawkesAudioTap = dest;
      if (typeof win?.MediaRecorder === 'function') {
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'].find((t) => {
          try { return win.MediaRecorder.isTypeSupported?.(t); } catch { return false; }
        });
        try {
          recorder = new win.MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
          recorder.start(1000);
        } catch { recorder = null; }
      }
    } catch {}
  }

  function tapContext(ctx) {
    if (!ctx || contexts.has(ctx)) return;
    contexts.add(ctx);
    ensureRecorder(ctx);
  }

  function pushEvent(type, extra = {}) {
    if (type === 'sound-start') return core.soundStart(extra);
    if (type === 'bus-gain') return core.busGain(extra);
    if (type === 'input') return core.input(extra);
    if (type === 'audiocontext-resume') return core.resume(extra);
    return null;
  }

  // Hook AudioBufferSourceNode.start
  try {
    const AC = win?.AudioContext || win?.webkitAudioContext;
    if (AC && AC.prototype && !AC.prototype.__hawkesAudioHooked) {
      const origCreate = AC.prototype.createBufferSource;
      if (typeof origCreate === 'function') {
        AC.prototype.createBufferSource = function (...args) {
          const node = origCreate.apply(this, args);
          tapContext(this);
          try {
            const origStart = node.start;
            node.start = function (...a) {
              try {
                // Connect into the tap so MediaRecorder hears it.
                if (dest) {
                  try { node.connect(dest); } catch {}
                }
                pushEvent('sound-start', {
                  sample: sampleIdOf(node),
                  bus: busOf(node),
                  rate: rateOf(node),
                  gain: gainOf(node),
                  dur: node.__hawkesDur,
                });
              } catch {}
              return origStart.apply(this, a);
            };
          } catch {}
          return node;
        };
        AC.prototype.__hawkesAudioHooked = true;
        hookedProto = true;
      }
      const OrigAC = AC;
      // Wrap constructor so new contexts are tapped.
      if (!win.__hawkesAudioContextWrapped) {
        const Wrapped = function (...args) {
          const ctx = new OrigAC(...args);
          tapContext(ctx);
          return ctx;
        };
        Wrapped.prototype = OrigAC.prototype;
        Object.keys(OrigAC).forEach((k) => { try { Wrapped[k] = OrigAC[k]; } catch {} });
        try { win.AudioContext = Wrapped; } catch {}
        try { if (win.webkitAudioContext) win.webkitAudioContext = Wrapped; } catch {}
        win.__hawkesAudioContextWrapped = true;
        cleanups.push(() => { /* leave hooks for the page lifetime; playtests are short */ });
      }
    }
  } catch {}

  // Existing contexts on the page (Babylon / Unity WebGL often create one at boot).
  try {
    const engines = win?.BABYLON?.Engine?.Instances;
    if (Array.isArray(engines)) {
      for (const e of engines) {
        const ctx = e?.audioEngine?.audioContext || e?._audioEngine?.audioContext;
        if (ctx) tapContext(ctx);
      }
    }
    for (const c of [win?.__hawkesAudioContext, win?.audioContext, win?.game?.audioContext]) {
      if (c) tapContext(c);
    }
  } catch {}

  // HTMLMediaElement.play
  try {
    const proto = win?.HTMLMediaElement?.prototype;
    if (proto && !proto.__hawkesAudioHooked) {
      const orig = proto.play;
      proto.play = function (...args) {
        try {
          pushEvent('sound-start', { sample: sampleIdOf(this), bus: this.__hawkesBus || 'sfx', rate: rateOf(this), gain: gainOf(this) });
        } catch {}
        return orig.apply(this, args);
      };
      proto.__hawkesAudioHooked = true;
    }
  } catch {}

  // Real input: pointer and key. First gesture that resumes a suspended context is logged.
  const onPointer = (e) => {
    const action = e.type === 'keydown' ? `key:${e.key || e.code || 'key'}` : (e.pointerType === 'touch' || e.type.startsWith('touch') ? 'tap' : `pointer:${e.button ?? 0}`);
    pushEvent('input', { action });
    // iOS / autoplay policy: resume suspended contexts on the gesture.
    for (const ctx of contexts) {
      try {
        if (ctx.state === 'suspended') {
          const p = ctx.resume?.();
          Promise.resolve(p).then(() => pushEvent('audiocontext-resume', { how: 'first-tap' })).catch(() => {});
        }
      } catch {}
    }
  };
  if (win?.addEventListener) {
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      win.addEventListener(type, onPointer, true);
      cleanups.push(() => { try { win.removeEventListener(type, onPointer, true); } catch {} });
    }
  }

  // The sound kit (hawkes-sound.js) says when it makes a context and when a bus's gain moves (ducking).
  const onKit = (e) => {
    const d = e?.detail;
    if (!d) return;
    if (d.type === 'context' && d.ctx) tapContext(d.ctx);
    else if (d.type === 'bus-gain') pushEvent('bus-gain', { bus: d.bus, gain: d.gain });
    else if (d.type === 'sound-start') pushEvent('sound-start', { sample: d.sample, bus: d.bus, rate: d.rate, gain: d.gain, dur: d.dur }); // Unity's HawkesSound reports its own starts
  };
  if (win?.addEventListener) {
    win.addEventListener('hawkes-sound', onKit);
    cleanups.push(() => { try { win.removeEventListener('hawkes-sound', onKit); } catch {} });
  }
  try { if (win?.__hawkesSoundContexts) for (const c of win.__hawkesSoundContexts) tapContext(c); } catch {}

  // Announce the probe.
  const info = () => ({
    adapter: contexts.size ? 'webaudio' : (hookedProto ? 'hooked' : 'none'),
    contexts: contexts.size,
    recorder: recorder ? 'yes' : 'no',
  });
  pushToRunner({ type: 'audio-sensor', info: info() });
  try { opts.emit?.({ type: 'audio-sensor', ...info(), t: 0 }); } catch {}

  return {
    core,
    mark(sample, o = {}) { return core.soundStart({ sample, bus: o.bus, rate: o.rate, gain: o.gain }); },
    input(action) { return core.input({ action }); },
    events: () => core.events(),
    metrics: () => {
      core.settleSilents(rel());
      return core.metrics();
    },
    info,
    stop() {
      try { core.settleSilents(rel()); } catch {}
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
      recorder = null;
      for (const c of cleanups) { try { c(); } catch {} }
      cleanups.length = 0;
    },
  };
}
