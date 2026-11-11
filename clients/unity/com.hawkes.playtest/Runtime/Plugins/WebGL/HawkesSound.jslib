// Browser side of HawkesSound.cs (hawkesstudio/docs/playtest.md#sound-kit).
mergeInto(LibraryManager.library, {
  // The first tap, click or key resumes Unity's AudioContext (iOS Safari keeps it suspended until a gesture).
  // The audio probe (hawkes-audio.js) logs that resume when it finds the context suspended, so the context is announced to it.
  HawkesSound_Install: function () {
    var w = window;
    if (w.__hawkesSoundInstalled) return;
    w.__hawkesSoundInstalled = true;
    var contexts = function () {
      var out = [];
      try { if (typeof WEBAudio !== 'undefined' && WEBAudio.audioContext) out.push(WEBAudio.audioContext); } catch (e) {}
      try { if (typeof Module !== 'undefined' && Module.SDL2 && Module.SDL2.audioContext) out.push(Module.SDL2.audioContext); } catch (e) {}
      try { if (w.__hawkesAudioContext) out.push(w.__hawkesAudioContext); } catch (e) {}
      return out;
    };
    contexts().forEach(function (c) {
      w.__hawkesSoundContexts = w.__hawkesSoundContexts || [];
      if (w.__hawkesSoundContexts.indexOf(c) < 0) w.__hawkesSoundContexts.push(c);
      w.dispatchEvent(new CustomEvent('hawkes-sound', { detail: { type: 'context', ctx: c } }));
    });
    var unlock = function () {
      contexts().forEach(function (c) { try { if (c.state === 'suspended') c.resume(); } catch (e) {} });
    };
    ['pointerdown', 'touchend', 'keydown'].forEach(function (t) { w.addEventListener(t, unlock, true); });
  },

  // A sound-start or bus-gain from HawkesSound.cs, for the audio probe.
  HawkesSound_Emit: function (jsonPtr) {
    try { window.dispatchEvent(new CustomEvent('hawkes-sound', { detail: JSON.parse(UTF8ToString(jsonPtr)) })); } catch (e) {}
  },
});
