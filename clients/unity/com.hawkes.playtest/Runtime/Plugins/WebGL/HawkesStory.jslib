// Browser side of HawkesStory.cs (hawkesstudio/docs/playtest.md#story-kit): a story event reaches the runner the same way the web kit's do.
mergeInto(LibraryManager.library, {
  HawkesStory_Emit: function (jsonPtr) {
    try {
      var msg = JSON.parse(UTF8ToString(jsonPtr));
      if (typeof window.__hawkesPlaytestPush === 'function') window.__hawkesPlaytestPush(msg);
      window.dispatchEvent(new CustomEvent('hawkes-playtest', { detail: msg }));
    } catch (e) {}
  },
});
