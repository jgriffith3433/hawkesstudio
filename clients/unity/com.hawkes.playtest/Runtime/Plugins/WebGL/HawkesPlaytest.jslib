// Browser side of the Hawkes playtest contract v1 (hawkesstudio/docs/playtest.md).
// Defines window.hawkesPlaytest. Commands are queued here and polled by
// HawkesPlaytest.cs each frame; state and the report are pushed from C#.
mergeInto(LibraryManager.library, {
  HawkesPlaytest_Install: function (productPtr, scenariosPtr) {
    var product = UTF8ToString(productPtr);
    var scenarios = [];
    try { scenarios = JSON.parse(UTF8ToString(scenariosPtr)); } catch (e) {}
    var w = window;
    w.__hawkesPlaytestQueue = w.__hawkesPlaytestQueue || [];
    w.__hawkesPlaytestState = w.__hawkesPlaytestState || { ready: true, status: 'idle' };
    var frames = 0, last = performance.now(), fps = 0, samples = [];
    var tick = function (t) {
      frames++;
      if (t - last >= 1000) { fps = Math.round(frames * 1000 / (t - last)); samples.push(fps); if (samples.length > 600) samples.shift(); frames = 0; last = t; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.hawkesPlaytest = {
      version: 1,
      product: product,
      engine: 'unity',
      scenarios: function () { return scenarios.slice(); },
      start: function (id, options) {
        options = options || {};
        w.__hawkesPlaytestReport = null;
        w.__hawkesPlaytestState = { ready: true, status: 'running', progress: 0 };
        // at: a named start point (docs/playtest.md); options: every option as JSON, for scenario-specific keys.
        w.__hawkesPlaytestQueue.push({ cmd: 'start', id: String(id), seed: Number(options.seed || 1), speed: Number(options.speed || 1), at: options.at == null ? '' : String(options.at), spot: options.spot == null ? '' : String(options.spot), options: JSON.stringify(options) });
      },
      stop: function () { w.__hawkesPlaytestQueue.push({ cmd: 'stop' }); },
      input: function (action, down) { w.__hawkesPlaytestQueue.push({ cmd: 'input', action: String(action), down: !!down }); },
      state: function () {
        var s = Object.assign({}, w.__hawkesPlaytestState);
        if (s.fps == null) s.fps = fps;
        return s;
      },
      report: function () {
        var r = w.__hawkesPlaytestReport;
        if (!r) return null;
        r = JSON.parse(JSON.stringify(r));
        r.metrics = r.metrics || {};
        if (samples.length) {
          r.metrics.fpsAverage = Math.round(samples.reduce(function (a, b) { return a + b; }, 0) / samples.length);
          r.metrics.fpsWorst = Math.min.apply(null, samples);
        }
        return r;
      },
    };
    var q = new URLSearchParams(location.search);
    var auto = q.get('playtest');
    if (auto && !w.__hawkesPlaytestAutoStarted) {
      w.__hawkesPlaytestAutoStarted = true;
      var opts = { seed: Number(q.get('seed') || 1), speed: Number(q.get('speed') || 1) };
      if (q.get('at')) opts.at = q.get('at');
      w.hawkesPlaytest.start(auto, opts);
    }
  },

  HawkesPlaytest_TakeCommand: function () {
    var q = window.__hawkesPlaytestQueue;
    if (!q || !q.length) return 0;
    var s = JSON.stringify(q.shift());
    var size = lengthBytesUTF8(s) + 1;
    var buf = _malloc(size);
    stringToUTF8(s, buf, size);
    return buf;
  },

  HawkesPlaytest_SetState: function (jsonPtr) {
    try { window.__hawkesPlaytestState = JSON.parse(UTF8ToString(jsonPtr)); } catch (e) {}
  },

  // The feel sensor (HawkesFeel.cs): a flag, pushed to the runner the moment it happens (a Playwright binding), no polling.
  HawkesPlaytest_Push: function (jsonPtr) {
    try {
      var msg = JSON.parse(UTF8ToString(jsonPtr));
      if (typeof window.__hawkesPlaytestPush === 'function') window.__hawkesPlaytestPush(msg);
      window.dispatchEvent(new CustomEvent('hawkes-playtest', { detail: msg }));
    } catch (e) {}
  },

  HawkesPlaytest_SetReport: function (jsonPtr) {
    try { window.__hawkesPlaytestReport = JSON.parse(UTF8ToString(jsonPtr)); } catch (e) {}
  },
});
