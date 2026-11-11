// Hawkes playtest contract v1 for web games. Copy this file into the game
// (source of truth: C:\Projects\hawkesstudio\clients\web\hawkes-playtest.js)
// and call installPlaytest once at startup. Spec: hawkesstudio/docs/playtest.md.
//
//   import { installPlaytest } from './hawkes-playtest.js';
//   installPlaytest({
//     product: 'doseofdestruction',
//     scenarios: [{ id: 'smoke', title: 'Boot, menu, one fight', seconds: 45, tags: ['smoke'] },
//                 { id: 'story', title: 'The story', seconds: 300, starts: ['chapter-2', 'chapter-3'] }],
//     isReady: () => game.loaded,
//     async start(id, options, t) {
//       if (t.at) await game.loadChapter(t.at);  // a named start point (options.at); none: from the start
//       t.scene('Main Menu');
//       await bot.pressStart();            // real input, like a player
//       t.event('match-start');
//       t.add('kos', 1);                   // counters; t.metric('hp', 80) sets a value
//       t.progress(0.5);
//       t.finish('won');                   // or 'lost' | 'done' | 'stuck' | 'error'
//     },
//     stop() { bot.stop(); },
//   });
//
// Nothing runs until the runner calls start() or the URL has ?playtest=<id> (&seed=, &speed=, &at=, &spot=).
//
// The feel sensor (hawkes-feel.js, docs/playtest.md#feel) runs with every run of a Babylon.js game: camera snaps, the
// camera behind walls, frame hitches. Give it the player for the player checks (falling through the floor, stuck,
// collision shoves, jitter):
//   installPlaytest({ ..., feel: { player: () => hero.mesh, input: () => (keys.any ? 1 : 0) } });
// feel: false turns it off. In start(), t.spot is { x, y, z, yaw? } when the run replays a flagged place
// (options.spot): put the player there (a named setup shortcut) and play on from it; t.cut() before a teleport or
// cutscene the sensor shouldn't count.
//
// The explore bot (hawkes-explore.js, docs/playtest.md#explore) hugs walls, jumps edges and maps stuck and fall spots.
// Give feel.player and explore: { enter: async (t) => game.startLevel() } (or explore: true when the game is playable
// on load) and the run gets an "explore" scenario. A game's own "explore" scenario wins.
//
// The first five minutes (docs/playtest.md#first-five): t.milestone('gameplay' | 'first-input-accepted' | 'first-success' |
// 'tutorial-step:<name>') says when a stranger got into the game; Studio's built-in first-five scenario plays the live
// page cold and reports the same moments, taps, walls and developer UI.
//
// The audio probe (hawkes-audio.js, docs/playtest.md#audio) taps WebAudio into a MediaRecorder and pushes sound-start
// and input events (and AudioContext resume on first tap). `audio: false` turns it off.
//
// The UI probe (hawkes-ui.js, docs/playtest.md#ui) runs on a touch or phone-sized page: every control's size, spacing, thumb
// reach, notch and home-bar insets and whether it is on screen, in the viewport's orientation and the other one, and every
// press (`ui-press`: did the screen answer within 100 ms; Studio adds the sound check). Canvas games give the rects:
// t.ui([{ id, label, x, y, w, h }]) and each press t.uiPress('Play', { changed: true }). `ui: false` turns it off,
// `ui: { always: true }` runs it on desktop too.

import { installPerfMonitor, discoverBabylonScene } from './hawkes-perf.js';
import { startBabylonFeel, startFrameFeel, parseSpot, pushToRunner } from './hawkes-feel.js';
import { startAudioProbe } from './hawkes-audio.js';
import { startUiProbe, layoutOtherOrientation } from './hawkes-ui.js';
import { runExplore, createExploreMap, EXPLORE_DEFAULTS } from './hawkes-explore.js';

export const CONTRACT_VERSION = 1;

export function installPlaytest(opts) {
  const { product, isReady = () => true, start, stop, input, stallSeconds = 60, feel: feelOpts, explore: exploreOpts, audio: audioOpts, ui: uiOpts } = opts;
  if (!product || !Array.isArray(opts.scenarios) || typeof start !== 'function') {
    throw new Error('installPlaytest needs product, scenarios and start');
  }
  // The built-in explore scenario: the game gave the player to the feel sensor and said how to get into play.
  const explorePlayer = feelOpts && typeof feelOpts === 'object' ? feelOpts.player : null;
  const exploreOn = Boolean(exploreOpts && explorePlayer && !opts.scenarios.some((s) => s.id === 'explore'));
  const ex = exploreOpts && typeof exploreOpts === 'object' ? exploreOpts : {};
  const scenarios = exploreOn
    ? [...opts.scenarios, { id: 'explore', title: 'Explore bot: hugs walls, jumps edges, maps stuck and fall spots', seconds: (ex.seconds ?? EXPLORE_DEFAULTS.seconds) + 15, tags: ['explore'] }]
    : opts.scenarios;

  let run = null; // the current run
  let sensor = null; // the feel sensor of the current run
  let audio = null; // the audio probe of the current run
  let uiProbe = null; // the UI probe of the current run
  let uiTimer = null;
  const fps = makeFpsMeter();

  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const tracker = {
    scene(name) {
      if (run && run.state.scene !== name) { run.state.scene = name; tracker.event('scene', name); scheduleUi(1000); }
    },
    /** A layout check now (a menu just opened): the DOM's controls, or `rects` ([{ id, label, x, y, w, h }]) for a canvas game. */
    ui(rects, o = {}) {
      if (!run || run.done) return null;
      if (!uiProbe) startUi(run, true);
      return uiProbe?.layout({ ...o, ...(Array.isArray(rects) ? { rects: rects.map(normRect) } : {}) }) ?? null;
    },
    /** A press on a control the DOM doesn't know (canvas): `changed` says the screen answered; `ms` how fast. */
    uiPress(label, o = {}) {
      if (!run || run.done) return;
      if (!uiProbe) startUi(run, true);
      uiProbe?.press(label, o);
    },
    progress(p) { if (run) { run.state.progress = Math.max(0, Math.min(1, p)); run.moved = performance.now(); } },
    note(text) { if (run) run.state.note = String(text); },
    // A metric is a reading, not progress: it doesn't reset the softlock timer (progress, add and events do).
    metric(name, value) { if (run) run.metrics[name] = value; },
    add(name, n = 1) { if (run) { run.metrics[name] = (run.metrics[name] ?? 0) + n; run.moved = performance.now(); } },
    event(type, detail) {
      if (!run) return;
      run.events.push({ t: round(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) });
      if (run.events.length > 2000) run.events.splice(0, run.events.length - 2000);
      run.moved = performance.now();
    },
    problem(severity, message) {
      if (!run) return;
      if (run.problems.some((p) => p.message === message)) return;
      run.problems.push({ severity, message: String(message) });
      tracker.event('problem', `${severity}: ${message}`);
    },
    // The first five minutes (docs/playtest.md#first-five; src/ftue.ts). Milestones are the moments a stranger gets into the
    // game: 'gameplay', 'first-input-accepted', 'first-success', 'tutorial-step:<name>'. Each is reported once, with the
    // seconds since the page opened (what a stranger waited), not since the run started.
    milestone(name, note) {
      if (!run) return;
      const key = String(name).trim().toLowerCase();
      if (!key) return;
      run.milestones ??= new Set();
      if (run.milestones.has(key)) return;
      run.milestones.add(key);
      const sincePage = round(performance.now() / 1000);
      run.metrics[`milestone.${key}`] = sincePage; // a reading, not a rubric limit: only the first-five scenario is judged
      tracker.event('milestone', key);
      if (note) tracker.log(`milestone ${key} at ${sincePage}s: ${note}`);
    },
    /** One tap or click the bot needed to get from the first screen to play (counted up to the 'gameplay' milestone). */
    tap() { tracker.event('tap'); },
    /** Something between the stranger and the game: a terms screen, a sign-in, a menu. `seconds` is what it cost. */
    wall(kind, label, seconds) { tracker.event('wall', JSON.stringify({ kind: String(kind), label: String(label), seconds: Number(seconds) || 0 })); },
    /** A developer panel or debug control a player can see (what it is, and the screenshot's Gen asset when there is one). */
    devUi(what, shot) { tracker.event('dev-ui', JSON.stringify({ what: String(what), ...(shot ? { shot: String(shot) } : {}) })); },
    log(line) { if (run) { run.log.push(`${round(now())}s ${line}`); if (run.log.length > 200) run.log.shift(); } },
    finish(outcome = 'done') {
      if (!run || run.done) return;
      run.done = true;
      run.state.status = outcome;
      run.seconds = now();
      tracker.event('finish', outcome);
      stopFeel();
      stopAudio();
      stopUi();
    },
    get seed() { return run?.options.seed ?? 0; },
    get speed() { return run?.options.speed ?? 1; },
    /** The named start point (options.at: a place, chapter or level), or null: play from the start. */
    get at() { const a = run?.options.at; return a == null || a === '' ? null : String(a); },
    /** A place to start from (options.spot "x,y,z[,yaw]", a feel flag's replay), or null. */
    get spot() { return parseSpot(run?.options.spot); },
    /** An intended cut, respawn or teleport: the feel sensor's camera and movement checks rest for a moment. */
    cut(seconds) { sensor?.cut(seconds); },
    /** Resolves after ms of real time (games that honor speed can divide by t.speed themselves); rejects if the run was stopped. */
    wait(ms) {
      return new Promise((resolve, reject) => {
        const r = run;
        setTimeout(() => (r && r === run && !r.done ? resolve() : reject(new Error('playtest stopped'))), ms);
      });
    },
    /** Resolves when test() is true (polled every 50 ms, so it works in hidden pages too), or rejects after timeoutMs. */
    until(test, timeoutMs = 30000, what = 'condition') {
      const r = run;
      const t0 = performance.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (!r || r !== run || r.done) return reject(new Error('playtest stopped'));
          let ok = false;
          try { ok = test(); } catch {}
          if (ok) return resolve();
          if (performance.now() - t0 > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
          setTimeout(tick, 50);
        };
        tick();
      });
    },
  };

  function startFeel(r) {
    stopFeel();
    if (feelOpts === false) return;
    const o = feelOpts && typeof feelOpts === 'object' ? feelOpts : {};
    const emit = (flag) => {
      if (r !== run) return;
      r.feel.push(flag);
      if (r.exploreMap && flag.pos) {
        if (flag.kind === 'below-ground' || flag.kind === 'fell-out') r.exploreMap.mark('fall', flag.pos);
        else if (flag.kind === 'stuck') r.exploreMap.mark('stuck', flag.pos);
      }
      tracker.event('feel', JSON.stringify({ id: flag.id, kind: flag.kind, pos: flag.pos, seed: flag.seed }));
      if (flag.severity === 'bug') tracker.problem('bug', `${flag.detail} at ${flag.pos ? flag.pos.join(',') : '?'}${flag.scene ? ` (${flag.scene})` : ''}`);
      pushToRunner({ type: 'feel', flag });
    };
    const base = { ...o, seed: r.options.seed, sceneName: () => r.state.scene, emit };
    // feel.scene is a scene or a function returning one (the game builds its scene later than it installs the playtest).
    const given = () => { try { return typeof o.scene === 'function' ? o.scene() : o.scene; } catch { return null; } };
    const attach = (scene) => {
      try {
        sensor = (scene && startBabylonFeel({ ...base, scene })) || startFrameFeel(base);
      } catch (e) {
        sensor = null;
        tracker.log(`feel sensor off: ${e?.message ?? e}`);
      }
      // Always say what the sensor is (or that it isn't): a sensor that is silently off reads as "no feel problems".
      const info = sensor?.info?.() ?? { adapter: 'none', player: false, camera: false };
      tracker.event('feel-sensor', JSON.stringify({ adapter: info.adapter, player: info.player ? 'yes' : 'no', camera: info.camera ? 'yes' : 'no' }));
    };
    const first = given() ?? discoverBabylonScene(window);
    attach(first);
    // A Babylon scene that renders no frame in 5 s is the wrong scene (a menu scene, a disposed one): look again, once.
    if (sensor?.info?.().adapter === 'babylon') {
      const mine = sensor;
      feelTimer = setTimeout(() => {
        feelTimer = null;
        if (r !== run || r.done || sensor !== mine || (mine.metrics?.()['feel.samples'] ?? 0) > 0) return;
        const again = given() ?? discoverBabylonScene(window);
        tracker.log(`feel sensor: its scene rendered no frame in 5 s; looking again${again && again !== first ? ' (found another scene)' : again ? ' (same scene)' : ' (none found, frames only)'}`);
        try { mine.stop(); } catch {}
        attach(again);
      }, 5000);
    }
  }
  function feelMetrics() {
    try {
      if (run?.feelMetrics) return run.feelMetrics;
      if (sensor) return sensor.metrics?.() ?? {};
      // The sensor was meant to run and isn't: say so (feel.samples 0), unless the game turned it off.
      return feelOpts === false ? {} : { 'feel.samples': 0 };
    } catch { return {}; }
  }
  function audioMetrics() {
    try {
      if (run?.audioMetrics) return run.audioMetrics;
      if (audio) return audio.metrics?.() ?? {};
      return audioOpts === false ? {} : {};
    } catch { return {}; }
  }
  let feelTimer = null;
  function stopFeel() {
    if (feelTimer) { clearTimeout(feelTimer); feelTimer = null; }
    try { if (sensor && run) { run.feelFinal = sensor.flags(); run.feelMetrics = sensor.metrics?.() ?? null; } sensor?.stop(); } catch {}
    sensor = null;
  }
  function startAudio(r) {
    stopAudio();
    if (audioOpts === false) return;
    const o = audioOpts && typeof audioOpts === 'object' ? audioOpts : {};
    try {
      audio = startAudioProbe({
        ...o,
        scene: () => r.state.scene,
        emit: (ev) => {
          if (r !== run) return;
          r.audio = r.audio || [];
          r.audio.push(ev);
          if (ev.type === 'sound-start' || ev.type === 'input' || ev.type === 'audiocontext-resume' || ev.type === 'bus-gain') {
            tracker.event(ev.type, JSON.stringify(ev));
          } else if (ev.type === 'audio-sensor') {
            tracker.event('audio-sensor', JSON.stringify(ev));
          }
        },
      });
      tracker.event('audio-sensor', JSON.stringify(audio.info?.() ?? { adapter: 'none' }));
    } catch (e) {
      audio = null;
      tracker.log(`audio probe off: ${e?.message ?? e}`);
    }
  }
  function stopAudio() {
    try {
      if (audio && run) {
        run.audioFinal = audio.events?.() ?? run.audio ?? [];
        run.audioMetrics = audio.metrics?.() ?? null;
      }
      audio?.stop();
    } catch {}
    audio = null;
  }

  const normRect = (c, i) => ({ id: String(c.id ?? c.label ?? `control-${i}`), label: String(c.label ?? c.id ?? `control-${i}`), x: Number(c.x) || 0, y: Number(c.y) || 0, w: Number(c.w ?? c.width) || 0, h: Number(c.h ?? c.height) || 0, fixed: c.fixed !== false });
  const uiWanted = () => {
    if (uiOpts === false) return false;
    if (uiOpts && typeof uiOpts === 'object' && uiOpts.always) return true;
    try { return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 || innerWidth <= 900; } catch { try { return innerWidth <= 900; } catch { return false; } }
  };
  function startUi(r, force) {
    stopUi();
    if (!force && !uiWanted()) return;
    const o = uiOpts && typeof uiOpts === 'object' ? uiOpts : {};
    try {
      uiProbe = startUiProbe({
        thresholds: o.thresholds, scene: () => r.state.scene, now,
        emit: (type, detail) => { if (r === run) tracker.event(type, JSON.stringify(detail)); },
      });
      tracker.event('ui-sensor', JSON.stringify(uiProbe.info?.() ?? { adapter: 'none' }));
      // The first screen, then the other orientation once (a runner plays one viewport; the probe reads the page at the swapped size).
      scheduleUi(1200);
      if (o.otherOrientation !== false && !o.canvas) {
        setTimeout(() => { if (r === run && !r.done && uiProbe && !r.uiOther) { r.uiOther = true; layoutOtherOrientation({ emit: (type, d) => tracker.event(type, JSON.stringify(d)), scene: () => r.state.scene, thresholds: o.thresholds }); } }, 3500);
      }
    } catch (e) {
      uiProbe = null;
      tracker.log(`ui probe off: ${e?.message ?? e}`);
    }
  }
  // A DOM layout check a moment after a scene change (the menu has drawn), once per scene; canvas games call t.ui(rects) themselves.
  function scheduleUi(ms) {
    if (!uiProbe || (uiOpts && typeof uiOpts === 'object' && uiOpts.canvas)) return;
    const r = run;
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => { if (r === run && !r.done && uiProbe) uiProbe.layout(); }, ms);
  }
  function stopUi() {
    clearTimeout(uiTimer);
    try { uiProbe?.stop(); } catch {}
    uiProbe = null;
  }

  async function playExplore(r) {
    r.exploreMap = createExploreMap({ cell: ex.cell ?? EXPLORE_DEFAULTS.cell });
    if (typeof ex.enter === 'function') await ex.enter(tracker);
    const seconds = Number(r.options.seconds) || ex.seconds || EXPLORE_DEFAULTS.seconds;
    const map = await runExplore({ player: explorePlayer, t: tracker, seed: r.options.seed, seconds, map: r.exploreMap, thresholds: ex.thresholds });
    if (r !== run) return;
    tracker.metric('explore.coverage', map.coverage);
    tracker.metric('explore.stuckSpots', map.stuck.length);
    tracker.metric('explore.fallSpots', map.falls.length);
    tracker.metric('explore.deadSeconds', map.deadSeconds);
    tracker.event('explore-map', JSON.stringify(map));
    tracker.finish('done');
  }

  const onError = (e) => tracker.problem('bug', `page error: ${e.message ?? e.reason?.message ?? e.reason ?? e}`);
  addEventListener('error', onError);
  addEventListener('unhandledrejection', onError);

  const api = {
    version: CONTRACT_VERSION,
    product,
    scenarios: () => scenarios.map((s) => ({ ...s })),
    async start(id, options = {}) {
      const sc = scenarios.find((s) => s.id === id);
      if (!sc) throw new Error(`no playtest scenario "${id}" (have: ${scenarios.map((s) => s.id).join(', ')})`);
      if (run && !run.done) api.stop();
      run = {
        id, options: { seed: 1, speed: 1, ...options }, t0: performance.now(), moved: performance.now(), done: false,
        state: { ready: true, status: 'running', progress: 0 }, metrics: {}, events: [], problems: [], log: [], feel: [],
      };
      const mine = run;
      tracker.event('start', id);
      startFeel(mine);
      startAudio(mine);
      startUi(mine, false);
      // A start point (options.at): where the scenario starts; the game loads it in start() (t.at).
      if (mine.options.at != null && mine.options.at !== '') tracker.event('start-at', mine.options.at);
      try {
        if (id === 'explore' && exploreOn) await playExplore(mine);
        else await start(id, mine.options, tracker);
        if (mine === run && !mine.done) tracker.finish('done');
      } catch (e) {
        if (mine === run && !mine.done) {
          tracker.problem('bug', `bot error: ${e?.message ?? e}`);
          tracker.log(String(e?.stack ?? e));
          tracker.finish(/timed out/.test(String(e?.message)) ? 'stuck' : 'error');
        }
      }
    },
    stop() {
      if (run && !run.done) tracker.finish('done');
      try { stop?.(); } catch {}
    },
    state() {
      let ready = false;
      try { ready = !!isReady(); } catch {}
      const perf = readPerf();
      if (!run) return { ready, status: 'idle', fps: fps.value(), ...(perf ? { perf } : {}) };
      if (!run.done && performance.now() - run.moved > stallSeconds * 1000) {
        tracker.problem('bug', `no progress for ${stallSeconds} s (softlock?)`);
        tracker.finish('stuck');
      }
      return { ...run.state, ready, fps: fps.value(), metrics: { ...run.metrics }, ...(perf ? { perf } : {}) };
    },
    report() {
      if (!run) return null;
      const perf = readPerf();
      return {
        scenario: run.id,
        outcome: run.done ? run.state.status : 'stuck',
        seconds: round(run.seconds ?? now()),
        // Feel then audio measurements first, so a game's own run.metric('feel.…' / 'audio.…') wins.
        metrics: { ...feelMetrics(), ...audioMetrics(), ...(uiProbe?.metrics?.() ?? {}), ...run.metrics, fpsAverage: fps.average(), fpsWorst: fps.worst() },
        events: run.events.slice(),
        problems: run.problems.slice(),
        log: run.log.slice(),
        feel: (run.feelFinal ?? sensor?.flags() ?? run.feel).slice(),
        audio: (run.audioFinal ?? audio?.events?.() ?? run.audio ?? []).slice(),
        ...(perf ? { perf } : {}),
      };
    },
    ...(input ? { input } : {}),
  };
  window.hawkesPlaytest = api;

  // ?playtest=<id>&seed=&speed= starts a run once the game is ready.
  const q = new URLSearchParams(location.search);
  const auto = q.get('playtest');
  if (auto) {
    const at = q.get('at');
    const spot = q.get('spot');
    const go = () => (isReadySafe(isReady) ? api.start(auto, { seed: num(q.get('seed'), 1), speed: num(q.get('speed'), 1), ...(at ? { at } : {}), ...(spot ? { spot } : {}) }) : setTimeout(go, 250));
    go();
  }
  return api;
}

function makeFpsMeter() {
  let frames = 0;
  let last = performance.now();
  let current = 0;
  const samples = [];
  const tick = (t) => {
    frames++;
    if (t - last >= 1000) {
      current = Math.round((frames * 1000) / (t - last));
      samples.push(current);
      if (samples.length > 600) samples.shift();
      frames = 0;
      last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    value: () => current,
    average: () => (samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : current),
    worst: () => (samples.length ? Math.min(...samples) : current),
  };
}

const round = (n) => Math.round(n * 10) / 10;
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const isReadySafe = (f) => { try { return !!f(); } catch { return false; } };
function readPerf() {
  try {
    if (typeof window === 'undefined') return null;
    if (window.hawkesPerf && typeof window.hawkesPerf.snapshot === 'function') return window.hawkesPerf.snapshot();
    const scene = discoverBabylonScene(window);
    if (scene) return installPerfMonitor(scene).snapshot();
  } catch {}
  return null;
}
