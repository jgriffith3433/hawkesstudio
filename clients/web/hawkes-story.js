// Hawkes story kit v1: story arrives through play. Voiced barks that react to what the player did, short skippable in-engine
// cutscenes and real choices, all driven by data (beats.json), and every one reported to Studio as a story event, so
// quality.textOnlyBeats and quality.maxQuietSeconds are MEASURED from what played, not self-reported.
// Source of truth: hawkesstudio/clients/web/hawkes-story.js (copy next to hawkes-playtest.js). Spec: docs/playtest.md#story-kit;
// how to write the data: the story-through-play skill; the Unity twin is HawkesStory.cs; the story-map check
// (src/storymap.ts) reads the same beats.json on every build.
//
//   import { createStoryKit } from './hawkes-story.js';
//   const story = createStoryKit({ sound, root: document.body });   // sound: the hawkes-sound.js kit (voice bus, music ducking)
//   story.load(beatsJson);                                           // or: await story.loadUrl('beats.json')
//   story.setFact('hp', 20);                                          // what the player did / the world's state
//   story.bark('hurt');                                               // the best eligible bark for that trigger, or nothing
//   await story.cutscene('wake-in-the-sewer');                       // voice + captions + music ducking; a tap on Skip ends it
//   const pick = await story.choose('rat-or-run');                   // real choice with a timeout default
//
// beats.json (version 1):
//   { "version": 1, "story": "the-final-spark", "start": "wake",
//     "barks":     [{ "id", "trigger", "text", "voice": "url", "speaker", "requires": [Req], "priority": 5, "cooldown": 300, "once": false, "mood" }],
//     "cutscenes": [{ "id", "skippable": true, "music": "bed", "lines": [{ "text", "voice": "url", "speaker", "dur": 3 }], "next": "page-id" }],
//     "pages":     [{ "id", "text", "voice", "video", "choices": [{ "text", "to" }], "timeout": { "sec": 10, "to": "page-id" }, "ending": "name" }] }
//   Req: { "fact": "hp", "lt" | "lte" | "gt" | "gte" | "eq" | "ne": n, "in": [..] }   { "seen": "beat-id" }   { "notSeen": "beat-id" }
//        { "flag": "name" } (fact is truthy)   { "any": [Req, ...] }   { "not": Req }
//
// BARKS carry requirements, priority, cooldown and memory (Hades): of the barks for a trigger whose requirements hold and that are not
// cooling down, the highest priority wins (ties: the least recently said, then data order). A bark never plays twice within its
// cooldown (default 300 s, never under MIN_COOLDOWN_S) and a `once` bark never again. The kit remembers what it said and when
// (`memory()`), and `seen`/`notSeen` requirements read it, so a later line can answer an earlier one.
//
// EVENTS (pushed through window.__hawkesPlaytestPush and a `hawkes-playtest` window event, never polled):
//   story-beat  { id, kind: bark|cutscene|choice|page, voiced, acted, captioned, textOnly, dur, speaker, t }
//   story-cutscene { id, state: start|skip|end, via, skipRect, captionRect, safe, viewport, t }     (rects in CSS px, for the phone check)
//   story-choice { id, options, real, timeout, defaultTo, picked, t }
//   story-activity { what, t }                                                                      (game: story.activity('door') - something to see, hear or do)
// A beat is textOnly when it shows words and has neither a voice line nor an acted scene (animation, cutscene, event). Studio counts them.

export const STORY_VERSION = 1;
/** A bark may not come back sooner than this, whatever the data says (Studio's repeat check is 5 minutes). */
export const MIN_COOLDOWN_S = 300;
/** The cutscene Skip button and caption box are laid out inside the safe area with at least this tap target (px). */
export const MIN_TAP_PX = 44;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/** Does one requirement hold for these facts and this memory? Pure. */
export function meets(req, facts = {}, mem = { count: () => 0 }) {
  if (req == null) return true;
  if (Array.isArray(req)) return req.every((r) => meets(r, facts, mem));
  if (req.any) return req.any.some((r) => meets(r, facts, mem));
  if (req.not) return !meets(req.not, facts, mem);
  if (req.seen !== undefined) return mem.count(req.seen) > 0;
  if (req.notSeen !== undefined) return mem.count(req.notSeen) === 0;
  if (req.flag !== undefined) return Boolean(facts[req.flag]);
  if (req.fact === undefined) return true;
  const v = facts[req.fact];
  if ('eq' in req) return v === req.eq;
  if ('ne' in req) return v !== req.ne;
  if ('in' in req) return Array.isArray(req.in) && req.in.includes(v);
  const n = num(v);
  if ('lt' in req) return n < req.lt;
  if ('lte' in req) return n <= req.lte;
  if ('gt' in req) return n > req.gt;
  if ('gte' in req) return n >= req.gte;
  return v !== undefined && v !== null && v !== false;
}

/** Pick the bark to say: requirements hold, not cooling down, not a spent `once`; highest priority, then least recently said. Pure. */
export function pickBark(barks, trigger, facts, mem, nowS) {
  let best = null;
  for (const b of barks) {
    if (trigger && b.trigger !== trigger) continue;
    if (b.once && mem.count(b.id) > 0) continue;
    const last = mem.last(b.id);
    const cd = Math.max(MIN_COOLDOWN_S, num(b.cooldown) || 0);
    if (last != null && nowS - last < cd) continue;
    if (!meets(b.requires, facts, mem)) continue;
    const pr = num(b.priority) || 0;
    const when = last ?? -Infinity;
    if (!best || pr > best.pr || (pr === best.pr && when < best.when)) best = { b, pr, when };
  }
  return best ? best.b : null;
}

export function createStoryKit(opts = {}) {
  const win = opts.win ?? (typeof window !== 'undefined' ? window : null);
  const doc = opts.doc ?? (win ? win.document : null);
  const root = opts.root ?? (doc ? doc.body : null);
  const sound = opts.sound ?? null;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
  const wait = opts.wait ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  const r2 = (n) => Math.round(n * 100) / 100;
  const facts = {};
  const said = new Map(); // id -> { count, last }
  let data = { barks: [], cutscenes: [], pages: [] };
  const mem = { count: (id) => said.get(id)?.count ?? 0, last: (id) => said.get(id)?.last ?? null };

  function push(msg) {
    msg.t = r2(msg.t ?? now());
    try { if (win && typeof win.__hawkesPlaytestPush === 'function') win.__hawkesPlaytestPush(msg); } catch {}
    try { if (win && win.dispatchEvent && typeof win.CustomEvent === 'function') win.dispatchEvent(new win.CustomEvent('hawkes-playtest', { detail: msg })); } catch {}
    events.push(msg);
    if (events.length > 2000) events.shift();
    return msg;
  }
  const events = [];

  function remember(id) {
    const m = said.get(id) ?? { count: 0, last: null };
    m.count++; m.last = now(); said.set(id, m);
  }

  /** The beat is reported with what it used: voice, an acted scene, a caption. textOnly = words and nothing else. */
  function beat(kind, id, o) {
    const voiced = Boolean(o.voiced);
    const acted = Boolean(o.acted);
    const captioned = Boolean(o.captioned);
    remember(id);
    return push({ type: 'story-beat', id, kind, voiced, acted, captioned, textOnly: !voiced && !acted && (captioned || Boolean(o.text)), dur: o.dur ?? 0, speaker: o.speaker });
  }

  // ---- the caption layer: inside the safe area, above the thumb, one line group at a time ----
  let capEl = null;
  function ensureLayer() {
    if (!doc || !root || capEl) return capEl;
    capEl = doc.createElement('div');
    capEl.setAttribute('data-hawkes-story', 'captions');
    capEl.setAttribute('role', 'status');
    capEl.setAttribute('aria-live', 'polite');
    Object.assign(capEl.style, {
      position: 'fixed', left: 'max(12px, env(safe-area-inset-left))', right: 'max(12px, env(safe-area-inset-right))',
      bottom: 'max(96px, calc(env(safe-area-inset-bottom) + 72px))', textAlign: 'center', pointerEvents: 'none', zIndex: '2147483000',
      color: '#fff', font: '600 18px/1.3 system-ui, sans-serif', textShadow: '0 1px 3px #000, 0 0 8px #000', display: 'none', boxSizing: 'border-box',
    });
    root.appendChild(capEl);
    return capEl;
  }
  function caption(text, speaker) {
    const el = ensureLayer();
    if (!el) return false;
    el.textContent = speaker ? `${speaker}: ${text}` : text;
    el.style.display = text ? 'block' : 'none';
    return Boolean(text);
  }
  const rectOf = (el) => {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    return { x: r2(r.left), y: r2(r.top), w: r2(r.width), h: r2(r.height) };
  };
  const viewport = () => ({ w: win?.innerWidth ?? 0, h: win?.innerHeight ?? 0 });
  function safeInsets() {
    try {
      if (!doc || !win?.getComputedStyle) return { top: 0, right: 0, bottom: 0, left: 0 };
      const probe = doc.createElement('div');
      probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      root.appendChild(probe);
      const cs = win.getComputedStyle(probe);
      const s = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
      probe.remove();
      return s;
    } catch { return { top: 0, right: 0, bottom: 0, left: 0 }; }
  }

  async function say(line, o = {}) {
    const hasVoice = Boolean(line.voice) && Boolean(sound?.speak);
    let voiced = false;
    if (hasVoice) {
      try { voiced = Boolean(await Promise.race([sound.speak(line.id ?? o.id ?? 'story-line', { url: line.voice }), wait(o.maxWait ?? 20).then(() => null)])); } catch { voiced = false; }
    }
    return voiced;
  }

  const api = {
    version: STORY_VERSION,
    events,
    facts,
    load(json) {
      const j = typeof json === 'string' ? JSON.parse(json) : json;
      data = { ...j, barks: j.barks ?? [], cutscenes: j.cutscenes ?? [], pages: j.pages ?? [] };
      return data;
    },
    async loadUrl(url) { const r = await fetch(url); return api.load(await r.json()); },
    setFact(k, v) { facts[k] = v; },
    fact: (k) => facts[k],
    /** What the kit remembers: per beat id, how many times and when it last played. */
    memory: () => Object.fromEntries([...said].map(([k, v]) => [k, { ...v }])),
    seen: (id) => mem.count(id) > 0,
    /** Something to see, hear or do happened (a door opened, a crowd cheered): counts against the quiet gap. */
    activity(what = 'activity') { return push({ type: 'story-activity', what: String(what).slice(0, 80) }); },

    /** The best eligible bark for `trigger` (or any trigger when omitted), voiced, captioned and reported. Null when none may play. */
    async bark(trigger) {
      const b = pickBark(data.barks, trigger, facts, mem, now());
      if (!b) return null;
      const captioned = caption(b.text ?? '', b.speaker);
      const ev = beat('bark', b.id, { voiced: Boolean(b.voice && sound?.speak), acted: Boolean(b.anim || b.event), captioned, text: b.text, speaker: b.speaker });
      const voiced = await say({ ...b, id: `bark-${b.id}` });
      if (!voiced && b.voice) ev.voiced = false;
      if (b.text) wait(Math.max(2, Math.min(6, String(b.text).length / 14))).then(() => caption('')).catch(() => {});
      return b;
    },

    /**
     * A cutscene: its lines voiced (music ducks under each through the sound kit) and captioned in the safe area, and a Skip
     * button one tap away. Resolves with { skipped, next }. Skippable unless the data says `skippable: false` (never for a
     * cutscene a player has seen before).
     */
    async cutscene(id) {
      const c = data.cutscenes.find((x) => x.id === id);
      if (!c) return { skipped: false, next: null, missing: true };
      const seenBefore = mem.count(id) > 0;
      const skippable = c.skippable !== false || seenBefore;
      let skipped = false;
      let via = 'end';
      let resolveSkip = () => {};
      const skipP = new Promise((r) => { resolveSkip = r; });
      let btn = null;
      const layer = ensureLayer();
      if (doc && root) {
        btn = doc.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-hawkes-ui', '');
        btn.setAttribute('data-hawkes-story', 'skip');
        btn.setAttribute('aria-label', 'Skip scene');
        btn.textContent = 'Skip';
        Object.assign(btn.style, {
          position: 'fixed', top: 'max(12px, env(safe-area-inset-top))', right: 'max(12px, env(safe-area-inset-right))',
          minWidth: `${MIN_TAP_PX + 8}px`, minHeight: `${MIN_TAP_PX + 4}px`, padding: '0 18px', zIndex: '2147483001', font: '700 16px system-ui, sans-serif',
          color: '#fff', background: 'rgba(0,0,0,0.65)', border: '2px solid #fff', borderRadius: '24px', touchAction: 'manipulation', cursor: 'pointer',
        });
        const hit = (e) => { skipped = true; via = e?.pointerType === 'touch' || e?.type === 'touchend' ? 'tap' : (e?.type === 'keydown' ? 'key' : 'click'); resolveSkip(); };
        if (skippable) {
          btn.addEventListener('pointerup', hit);
          btn.addEventListener('click', hit);
          root.appendChild(btn);
        }
      }
      let playedVoice = false;
      const lines = c.lines ?? [];
      push({ type: 'story-cutscene', id, state: 'start', skippable, safe: safeInsets(), viewport: viewport(), skipRect: rectOf(btn), captionRect: rectOf(layer) });
      const run = (async () => {
        for (const line of lines) {
          if (skipped) return;
          const shown = caption(line.text ?? '', line.speaker);
          const rect = rectOf(layer);
          if (rect) push({ type: 'story-cutscene', id, state: 'caption', safe: safeInsets(), viewport: viewport(), captionRect: rect, skipRect: rectOf(btn) });
          if (line.voice && sound?.speak) {
            const v = await say({ ...line, id: `${id}-${lines.indexOf(line) + 1}` });
            playedVoice = playedVoice || v;
          }
          if (skipped) return;
          if (!line.voice || !sound?.speak) await wait(Math.max(1.5, num(line.dur) || String(line.text ?? '').length / 14));
          void shown;
        }
      })();
      await Promise.race([run, skipP]);
      caption('');
      try { btn?.remove(); } catch {}
      const dur = c.lines?.reduce((s, l) => s + (num(l.dur) || 0), 0) ?? 0;
      beat('cutscene', id, { voiced: playedVoice || lines.some((l) => l.voice), acted: true, captioned: lines.some((l) => l.text), dur });
      push({ type: 'story-cutscene', id, state: skipped ? 'skip' : 'end', via: skipped ? via : 'end' });
      return { skipped, next: c.next ?? null };
    },

    /** Skip the cutscene that is playing, as a tap would (for the playtest bot and the keyboard). */
    skip() { try { const el = doc?.querySelector('[data-hawkes-story="skip"]'); if (el) el.click(); return Boolean(el); } catch { return false; } },

    /** A page's choices as a real choice (two or more different destinations) with its timeout default; reports the pick. */
    choose(pageId, picked) {
      const p = data.pages.find((x) => x.id === pageId);
      if (!p) return null;
      const options = (p.choices ?? []).map((c) => c.to);
      const real = new Set(options).size >= 2;
      const to = picked ?? (p.timeout?.to ?? null);
      push({ type: 'story-choice', id: pageId, options: options.length, real, timeout: p.timeout?.sec ?? null, defaultTo: p.timeout?.to ?? null, picked: to });
      beat('choice', pageId, { voiced: Boolean(p.voice), acted: Boolean(p.video), captioned: Boolean(p.text), text: p.text });
      return to;
    },
    /** For tests and the playtest bot: every event this kit pushed. */
    pushed: () => events.slice(),
  };
  if (win) win.hawkesStory = api;
  // Announced once, so a game that uses the kit shows measured zeros (not "unmeasured") even when nothing has played yet.
  push({ type: 'story-kit', version: STORY_VERSION });
  return api;
}
