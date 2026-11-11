// Talk's resilience (talk.js uses it; loaded before it): what J typed and didn't send stays in the browser per
// conversation, the conversation on screen is remembered across a reload, and an answer that was cut off (Studio
// restarted while Claude was writing it) is recognised so the page can offer Retry. Plain functions with no DOM, so the
// tests load this file as it is (test/talk-resume.test.ts). Every storage call is wrapped: a private window or a full
// quota must never break Talk.
(function (root) {
  const DRAFT = 'studio.talkDraft.';
  const CURRENT = 'studio.talkCurrent';
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  /** The store over a Storage (localStorage in the page). Drafts are keyed by conversation; a new one is 'new'. */
  function store(storage) {
    const key = (conv) => DRAFT + (conv || 'new');
    return {
      draft: (conv) => safe(() => storage.getItem(key(conv)) ?? '', ''),
      saveDraft(conv, text) {
        safe(() => { if (text) storage.setItem(key(conv), String(text)); else storage.removeItem(key(conv)); }, undefined);
      },
      current: () => safe(() => storage.getItem(CURRENT) || null, null),
      setCurrent(id) { safe(() => { if (id) storage.setItem(CURRENT, String(id)); else storage.removeItem(CURRENT); }, undefined); },
    };
  }

  /**
   * True when the conversation's newest message is J's question with no answer after it and nothing is answering. Every
   * finished turn ends with an assistant line (an answer, "(stopped)", "(no answer)" or a failed start), so this only
   * happens when a turn was lost: Studio restarted while answering (talk.ts resets it at start-up).
   */
  function cutAnswer(conv) {
    if (!conv || conv.status === 'thinking') return false;
    return conv.messages?.at(-1)?.role === 'user';
  }

  const api = { store, cutAnswer, DRAFT, CURRENT };
  root.talkResume = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
