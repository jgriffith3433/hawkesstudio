// Hawkes playtest contract v1 for web games. Copy this file into the game
// (source of truth: C:\Projects\hawkesstudio\clients\web\hawkes-playtest.js)
// and call installPlaytest once at startup. Spec: hawkesstudio/docs/playtest.md.
//
//   import { installPlaytest } from './hawkes-playtest.js';
//   installPlaytest({
//     product: 'doseofdestruction',
//     scenarios: [{ id: 'smoke', title: 'Boot, menu, one fight', seconds: 45, tags: ['smoke'] }],
//     isReady: () => game.loaded,
//     async start(id, options, t) {
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
// Nothing runs until the runner calls start() or the URL has ?playtest=<id>.

export const CONTRACT_VERSION = 1;

export function installPlaytest(opts) {
  const { product, scenarios, isReady = () => true, start, stop, input, stallSeconds = 60 } = opts;
  if (!product || !Array.isArray(scenarios) || typeof start !== 'function') {
    throw new Error('installPlaytest needs product, scenarios and start');
  }

  let run = null; // the current run
  const fps = makeFpsMeter();

  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const tracker = {
    scene(name) { if (run && run.state.scene !== name) { run.state.scene = name; tracker.event('scene', name); } },
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
    log(line) { if (run) { run.log.push(`${round(now())}s ${line}`); if (run.log.length > 200) run.log.shift(); } },
    finish(outcome = 'done') {
      if (!run || run.done) return;
      run.done = true;
      run.state.status = outcome;
      run.seconds = now();
      tracker.event('finish', outcome);
    },
    get seed() { return run?.options.seed ?? 0; },
    get speed() { return run?.options.speed ?? 1; },
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
        state: { ready: true, status: 'running', progress: 0 }, metrics: {}, events: [], problems: [], log: [],
      };
      const mine = run;
      tracker.event('start', id);
      try {
        await start(id, mine.options, tracker);
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
      if (!run) return { ready, status: 'idle', fps: fps.value() };
      if (!run.done && performance.now() - run.moved > stallSeconds * 1000) {
        tracker.problem('bug', `no progress for ${stallSeconds} s (softlock?)`);
        tracker.finish('stuck');
      }
      return { ...run.state, ready, fps: fps.value(), metrics: { ...run.metrics } };
    },
    report() {
      if (!run) return null;
      return {
        scenario: run.id,
        outcome: run.done ? run.state.status : 'stuck',
        seconds: round(run.seconds ?? now()),
        metrics: { ...run.metrics, fpsAverage: fps.average(), fpsWorst: fps.worst() },
        events: run.events.slice(),
        problems: run.problems.slice(),
        log: run.log.slice(),
      };
    },
    ...(input ? { input } : {}),
  };
  window.hawkesPlaytest = api;

  // ?playtest=<id>&seed=&speed= starts a run once the game is ready.
  const q = new URLSearchParams(location.search);
  const auto = q.get('playtest');
  if (auto) {
    const go = () => (isReadySafe(isReady) ? api.start(auto, { seed: num(q.get('seed'), 1), speed: num(q.get('speed'), 1) }) : setTimeout(go, 250));
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
