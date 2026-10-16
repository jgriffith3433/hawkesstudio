// Calls: J talks to Talk out loud (the 📞 button in Talk). Loaded after talk.js (uses api, esc, GEN, openTalk).
//
// Cheap and fast by default: the browser hears J (Web Speech API SpeechRecognition, free) and Talk's answer is spoken
// sentence by sentence as it streams in (GET /api/talk/<id>/events). The voice:
//   - the browser's own voice (the default: free and instant; Edge's "Natural" voices first).
//   - Kokoro (free, more natural): an 82M-parameter TTS model running in this browser (kokoro-worker.js: WebGPU, else
//     WebAssembly), loaded on the first call and cached. A sentence it hasn't made within 1.5 s is spoken by the
//     browser's voice instead; a device that is too slow for it falls back for the rest of the call. Measured on J's
//     laptop (Intel integrated graphics, October 2026): 1.2-2.5 s for a short sentence on WebGPU (real-time factor
//     0.5-1.2 once warm, 20-35 s to load), 5-14 s on the CPU: too slow to be the default there; it suits a real GPU.
//   - ElevenLabs Flash through Hawkes Gen (audio.voice, paid: its price is shown in Settings).
// The server keeps a warm Claude Code process for the call (talk.ts startCall) and is told the device J calls from.
//
// Listening: push to talk is always there (the big button, or holding Space on a computer): pressing cuts Talk off at
// once (barge-in) and the mic listens only while it is held. Hands-free (a pause sends) keeps the mic off while Talk
// speaks unless barge-in is on (headphones), and what the mic hears that matches what Talk just said is dropped (echo).
//
// Settings come from Studio (GET /api/settings, the Settings tab) so they follow J across devices; only the browser
// voice's name is this device's own (localStorage).
(() => {
  const el = (s) => document.querySelector(s);
  const Rec = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /** phone | tablet | computer: what Talk is told, and which listening mode applies. */
  function device() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
    if (/iPhone|iPod|Android.*Mobile|Mobile Safari|IEMobile|Opera Mini/.test(ua)) return 'phone';
    if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches && Math.min(screen.width, screen.height) < 600) return 'phone';
    return 'computer';
  }

  // ------------------------------------------------------------ settings

  const DEFAULTS = { engine: 'browser', kokoroVoice: 'af_heart', elevenVoice: '', rate: 1.05, mode: { computer: 'push', phone: 'hands-free' }, bargeIn: false, pause: 800 };
  let S = { ...DEFAULTS };
  let prices = { elevenPerMinute: 0.14 };
  /** This device only: the browser voice's name (voices differ per browser and OS). */
  const LOCAL_KEY = 'studio.call.device';
  const local = (() => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}'); } catch { return {}; } })();
  const saveLocal = () => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch {} };
  const mode = () => (device() === 'computer' ? S.mode.computer : S.mode.phone);

  async function loadSettings() {
    try {
      const r = await api('/api/settings');
      prices = r.prices ?? prices;
      S = { ...DEFAULTS, ...r.call, mode: { ...DEFAULTS.mode, ...(r.call?.mode ?? {}) } };
      // Once: the old per-browser call settings move to Studio (if Studio has none yet).
      let old = null;
      try { old = JSON.parse(localStorage.getItem('studio.call') ?? 'null'); } catch {}
      if (old) {
        if (old.voice && !local.browserVoice) { local.browserVoice = old.voice; saveLocal(); }
        if (!r.call?.saved) {
          const patch = { bargeIn: !!old.bargeIn && !iOS, pause: old.pause, rate: old.rate, ...(old.mode ? { mode: { [device() === 'computer' ? 'computer' : 'phone']: old.mode } } : {}), ...(old.elevenVoice ? { elevenVoice: old.elevenVoice } : {}) };
          const saved = await api('/api/settings', { method: 'POST', body: { section: 'call', patch } }).catch(() => null);
          if (saved) S = { ...S, ...saved.settings };
        }
        try { localStorage.removeItem('studio.call'); } catch {}
      }
    } catch {}
    return S;
  }

  let call = null; // the call in progress

  // ------------------------------------------------------------ speaking

  /** What a speech voice should say for a piece of Markdown (links, code, lists and tables are for the chat). */
  function speakable(s) {
    return s
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^\s*\|.*$/gm, ' ')
      .replace(/^\s*#+\s*/gm, '')
      .replace(/^\s*([-*•]|\d+\.)\s+/gm, '')
      .replace(/[`*_~>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The browser's voice: J's pick on this device, else Edge's "Natural" neural voices, else the best one there is. */
  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (local.browserVoice) { const v = voices.find((x) => x.name === local.browserVoice); if (v) return v; }
    const lang = navigator.language || 'en-US';
    const en = voices.filter((v) => v.lang?.startsWith(lang.slice(0, 2)));
    const best = (re) => en.find((v) => re.test(v.name) && v.lang === lang) ?? en.find((v) => re.test(v.name));
    return best(/\(Natural\)|Natural/) ?? best(/Online|Neural|Premium|Enhanced/i) ?? best(/Google US English|Samantha|Daniel|Karen/) ?? en.find((v) => v.lang === lang) ?? en[0] ?? null;
  }

  /** Kokoro in a worker: loaded once per page, on the first call (or the Settings tab's test). */
  const kokoro = {
    worker: null, state: 'off', device: null, dtype: null, loadMs: null, error: null, waiters: new Map(), seq: 0, ready: null,
    /** WebGPU (fp32, the precision Kokoro needs there) when the browser has an adapter, else WebAssembly (q8: 92 MB). */
    async pick() {
      try {
        const a = await navigator.gpu?.requestAdapter();
        if (a) return { device: 'webgpu', dtype: 'fp32' };
      } catch {}
      return { device: 'wasm', dtype: 'q8' };
    },
    load(force) {
      if (this.ready && !force) return this.ready;
      this.state = 'loading';
      this.ready = (async () => {
        const want = force ?? await this.pick();
        this.worker?.terminate();
        this.worker = new Worker('kokoro-worker.js', { type: 'module' });
        const t0 = performance.now();
        return await new Promise((resolve) => {
          this.worker.onerror = (e) => { this.state = 'failed'; this.error = e.message || 'the worker failed'; resolve(false); };
          this.worker.onmessage = (ev) => {
            const m = ev.data;
            if (m.type === 'ready') {
              Object.assign(this, { state: 'ready', device: m.device, dtype: m.dtype, loadMs: Math.round(performance.now() - t0) });
              console.info('[call] kokoro ready', { device: m.device, dtype: m.dtype, ms: this.loadMs, fellBack: m.fellBack });
              resolve(true);
            } else if (m.type === 'error' && m.id === undefined) {
              this.state = 'failed';
              this.error = m.error;
              resolve(false);
            } else {
              const w = this.waiters.get(m.id);
              this.waiters.delete(m.id);
              if (w) m.type === 'audio' ? w.resolve(m) : w.reject(new Error(m.error));
            }
          };
          this.worker.postMessage({ type: 'load', ...want });
        });
      })();
      return this.ready;
    },
    /** One sentence: { audio, rate, ms } (ms: the model's time for it). */
    synth(text, voice, speed) {
      if (this.state !== 'ready') return Promise.reject(new Error('not ready'));
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.waiters.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'speak', id, text, voice, speed });
      });
    },
    label() {
      return this.state === 'ready' ? `Kokoro (${this.device === 'webgpu' ? 'WebGPU' : 'CPU'})` : this.state === 'loading' ? 'Kokoro (loading…)' : this.state === 'failed' ? 'Kokoro (failed)' : 'Kokoro';
    },
  };

  /** How long a Kokoro sentence may keep the voice waiting before the browser's voice says it instead. */
  const KOKORO_WAIT_MS = 1500;

  /** Speaks sentences in order: Kokoro or ElevenLabs clips (made ahead while one plays), or the browser's voice. */
  class Speaker {
    /** owner: who hears about the voice starting and ending (the call, or the Settings tab's test). */
    constructor(owner = () => call) {
      this.owner = owner;
      this.queue = []; this.busy = false; this.ctx = null; this.source = null; this.gen = 0;
      /** What Talk said lately, with when it finished (for echo): [{ text, words, until }]. */
      this.said = [];
      this.slow = 0; // Kokoro sentences in a row that came too late
      this.stats = []; // { engine, wait, rtf } per sentence
      this.endedAt = 0;
    }
    get speaking() { return this.busy || this.queue.length > 0; }
    engine() {
      if (S.engine === 'eleven' && S.elevenVoice && this.ctx) return 'eleven';
      if (S.engine === 'kokoro' && kokoro.state === 'ready' && this.ctx && this.slow < 3) return 'kokoro';
      return 'browser';
    }
    say(text) {
      const item = { text, gen: this.gen, at: performance.now(), engine: this.engine() };
      if (item.engine === 'eleven') item.clip = elevenClip(text, this.ctx).catch(() => null);
      if (item.engine === 'kokoro') {
        item.clip = kokoro.synth(text, S.kokoroVoice, S.rate).then((m) => {
          item.model = m.ms;
          item.seconds = m.audio.length / m.rate;
          const buf = this.ctx.createBuffer(1, m.audio.length, m.rate);
          buf.copyToChannel(m.audio, 0);
          return buf;
        }).catch(() => null);
      }
      this.queue.push(item);
      this.remember(text, Infinity);
      this.next();
    }
    remember(text, until) {
      const words = norm(text);
      const hit = this.said.find((x) => x.text === text && x.until === Infinity);
      if (hit && until !== Infinity) { hit.until = until; return; }
      if (!hit) this.said.push({ text, words, until });
      const now = performance.now();
      this.said = this.said.filter((x) => x.until === Infinity || now - x.until < 20_000).slice(-12);
    }
    async next() {
      if (this.busy || !this.queue.length) return;
      const item = this.queue.shift();
      this.busy = true;
      const done = () => {
        if (item.gen !== this.gen) return;
        this.busy = false;
        this.endedAt = performance.now();
        this.remember(item.text, this.endedAt);
        this.owner()?.onSpoken();
        this.next();
      };
      let clip = null;
      if (item.clip) {
        const t0 = performance.now();
        // Kokoro gets 1.5 s from the moment its sentence is due; ElevenLabs 3 s (a network round trip).
        const wait = item.engine === 'kokoro' ? KOKORO_WAIT_MS : 3000;
        clip = await Promise.race([item.clip, new Promise((r) => setTimeout(() => r(null), wait))]);
        if (item.engine === 'kokoro') {
          if (clip) this.slow = 0;
          else if (++this.slow >= 3) this.owner()?.note('Kokoro is too slow on this device: the browser voice speaks for the rest of the call.');
        }
        item.waited = Math.round(performance.now() - t0);
      }
      if (item.gen !== this.gen) return;
      const stat = { engine: clip ? item.engine : 'browser', wait: Math.round(performance.now() - item.at), rtf: item.model && item.seconds ? item.model / 1000 / item.seconds : null };
      this.stats.push(stat);
      if (this.stats.length > 50) this.stats.shift();
      if (clip) {
        this.owner()?.onSpeechStart(stat);
        const src = this.ctx.createBufferSource();
        src.buffer = clip;
        // Kokoro already speaks at S.rate; ElevenLabs is sped up here.
        if (item.engine === 'eleven') src.playbackRate.value = Math.min(1.2, S.rate);
        src.connect(this.ctx.destination);
        src.onended = done;
        this.source = src;
        src.start();
        return;
      }
      const u = new SpeechSynthesisUtterance(item.text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = S.rate;
      u.onstart = () => this.owner()?.onSpeechStart(stat);
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    }
    /** Barge-in or hang up: silence now, drop what was waiting. */
    hush() {
      this.gen++;
      for (const x of this.queue) this.remember(x.text, performance.now());
      this.queue = [];
      if (this.busy) this.endedAt = performance.now();
      this.busy = false;
      speechSynthesis.cancel();
      try { this.source?.stop(); } catch {}
      this.source = null;
      for (const x of this.said) if (x.until === Infinity) x.until = performance.now();
    }
    /**
     * Does what the mic heard look like Talk's own voice (speaker echo, or recognition catching up after Talk spoke)?
     * Fuzzy: most of the heard words are in what Talk said in the last 20 seconds, in roughly the same order.
     */
    isEcho(heard) {
      const words = norm(heard);
      if (!words.length) return true;
      const now = performance.now();
      const recent = this.said.filter((x) => x.until === Infinity || now - x.until < 20_000);
      if (!recent.length) return false;
      const said = recent.flatMap((x) => x.words);
      const set = new Set(said);
      const overlap = words.filter((w) => set.has(w)).length / words.length;
      if (words.length <= 2) return overlap === 1 && (this.speaking || now - this.endedAt < 4000);
      if (overlap >= 0.75) return true;
      // Pairs of words in the same order: a sentence half-heard still matches.
      const pairs = new Set(said.slice(1).map((w, i) => `${said[i]} ${w}`));
      const heardPairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
      return overlap >= 0.5 && heardPairs.filter((p) => pairs.has(p)).length / heardPairs.length >= 0.4;
    }
  }
  const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) ?? [];

  /** One sentence in ElevenLabs Flash through Hawkes Gen (about half a second), decoded and ready to play. */
  async function elevenClip(text, ctx) {
    const r = await fetch(`${GEN}/v1/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'audio.voice', project: 'hawkesstudio', labels: { from: 'talk call' }, params: { text, voice: S.elevenVoice, model: 'eleven_flash_v2_5', format: 'mp3_44100_64' }, timeout: 20 }) });
    const j = await r.json();
    const asset = j.outputs?.[0]?.asset;
    if (!r.ok || !asset) throw new Error(j.error ?? 'no audio');
    const audio = await fetch(`${GEN}/v1/files/${asset}`).then((x) => x.arrayBuffer());
    return await ctx.decodeAudioData(audio);
  }

  // ------------------------------------------------------------ the call

  class Call {
    constructor() {
      this.id = null;
      this.state = 'connecting';
      this.speaker = new Speaker();
      this.heard = '';
      this.interim = '';
      this.lastHeardAt = 0;
      this.thinking = false;
      this.pttDown = false;
      this.latencies = [];
      this.dropped = 0;
      this.abort = new AbortController();
    }

    async start(conversation) {
      this.render();
      await loadSettings();
      if (S.engine === 'kokoro') kokoro.load().then(() => this.render());
      const r = await api('/api/talk/call', { method: 'POST', body: { conversation, device: device() } });
      this.id = r.id;
      window.openTalk?.(r.id);
      if (mode() === 'hands-free') this.listen();
      this.ping = setInterval(() => this.checkIn(), 20_000);
      this.lockScreen();
      this.events();
      this.setState('listening');
    }

    async checkIn() {
      if (!this.id) return;
      await api(`/api/talk/${this.id}/call`, { method: 'POST', body: { device: device() } }).catch(() => {});
    }

    /** The answer streams in as events: sentences are spoken as soon as they are complete. */
    async events() {
      while (call === this) {
        try {
          const r = await fetch(`/api/talk/${this.id}/events`, { signal: this.abort.signal });
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
              if (data) this.onEvent(JSON.parse(data));
            }
          }
        } catch (e) {
          if (call !== this) return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    onEvent(e) {
      if (e.type === 'hello') { this.thinking = e.status === 'thinking'; return this.render(); }
      if (e.type === 'turn') {
        this.thinking = true;
        this.text = '';
        this.quiet = false; // after a "---" line the rest of the answer is for the chat only
        this.firstDelta = null;
        if (e.auto) this.note('Studio asked Talk about a result');
        return this.setState('thinking');
      }
      if (e.type === 'start') return this.flush(true);
      if (e.type === 'delta') {
        if (!this.firstDelta) this.firstDelta = performance.now();
        this.text += e.text;
        return this.flush(false);
      }
      if (e.type === 'end' || e.type === 'tool') {
        this.flush(true);
        if (e.type === 'tool') this.note(`⚙ ${e.text}`);
        return;
      }
      if (e.type === 'idle') {
        this.flush(true);
        this.thinking = false;
        if (!this.speaker.speaking) this.setState('listening');
      }
    }

    /** Speaks every complete sentence written so far (all of it at the end of a block). */
    flush(all) {
      for (;;) {
        if (this.quiet) { this.text = ''; return; }
        const hr = /(^|\n)\s*---+\s*(\n|$)/.exec(this.text);
        let cut = -1;
        const m = /[.!?…:](["')\]]?)\s|\n/.exec(this.text);
        if (m) cut = m.index + m[0].length;
        if (hr && (cut < 0 || hr.index < cut)) {
          this.say(this.text.slice(0, hr.index));
          this.quiet = true;
          this.text = '';
          return;
        }
        if (cut < 0) {
          // A long sentence without a stop yet: speak up to its last comma rather than wait.
          if (!all && this.text.length > 160 && this.text.lastIndexOf(', ') > 40) cut = this.text.lastIndexOf(', ') + 2;
          else if (all) cut = this.text.length;
          else return;
        }
        this.say(this.text.slice(0, cut));
        this.text = this.text.slice(cut);
        if (!this.text) return;
      }
    }

    say(s) {
      const t = speakable(s);
      if (!/[a-z0-9]/i.test(t)) return;
      this.speaker.say(t);
      if (this.state !== 'speaking') this.setState('speaking');
    }

    onSpeechStart(stat) {
      // Latency: J's last word heard (or the send) to Talk's first word.
      if (this.waitingSince) {
        const ms = Math.round(performance.now() - this.waitingSince);
        this.latencies.push(ms);
        this.lastLatency = { ms, claude: this.firstDelta ? Math.round(this.firstDelta - this.sentAt) : null, pause: Math.round(this.sentAt - this.waitingSince), voice: stat?.engine, voiceMs: stat?.wait };
        this.waitingSince = null;
        console.info('[call] latency', this.lastLatency);
      }
      if (this.state !== 'speaking') this.setState('speaking');
    }

    onSpoken() {
      if (!this.speaker.speaking && !this.thinking) this.setState('listening');
    }

    // -------------------------------------------- listening

    listen() {
      if (!Rec()) return this.note('This browser has no speech recognition: use Chrome, Edge or Safari. You can still type in the chat; answers are spoken.');
      if (this.rec) return;
      const rec = new (Rec())();
      rec.lang = navigator.language || 'en-US';
      rec.continuous = !iOS; // iOS ends a continuous session unpredictably: one phrase per session there
      rec.interimResults = true;
      rec.onresult = (ev) => {
        let fin = '', interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) fin += r[0].transcript;
          else interim += r[0].transcript;
        }
        this.onHeard(fin, interim);
      };
      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          this.micBlocked = true;
          this.note(iOS ? 'Microphone blocked: allow it in Settings › Safari › Microphone (and Speech Recognition), then tap Call again.' : 'Microphone blocked: allow it for this site (the lock icon in the address bar), then call again.');
          this.render();
        } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') this.note(`Speech recognition: ${ev.error}`);
      };
      rec.onend = () => {
        if (this.rec === rec) this.rec = null;
        // It stops by itself after a phrase or a silence: start it again while the call wants to hear J.
        if (call === this && this.wantsMic() && !this.micBlocked && !document.hidden) setTimeout(() => this.wantsMic() && this.listen(), 150);
      };
      this.rec = rec;
      try { rec.start(); } catch { this.rec = null; }
    }

    /**
     * Push to talk: only while the button (or Space) is held, and a moment after. Hands-free: always, except while
     * Talk speaks (and a moment after its voice ends, so the tail of it isn't heard) unless barge-in is on.
     */
    wantsMic() {
      if (this.muted) return false;
      if (this.pttDown || this.pttTail) return true;
      if (mode() === 'push') return false;
      if (S.bargeIn) return true;
      return !this.speaker.speaking && performance.now() - this.speaker.endedAt > 350;
    }

    stopMic() { const r = this.rec; this.rec = null; try { r?.abort(); } catch {} }

    onHeard(fin, interim) {
      const text = `${fin} ${interim}`.trim();
      if (!text) return;
      const held = this.pttDown || this.pttTail;
      if (!held) {
        // Hands-free: what sounds like Talk's own words is its voice coming back through the mic.
        if (this.speaker.isEcho(text)) { if (fin) this.dropped++; return; }
        if (this.speaker.speaking || this.thinking) {
          if (text.split(/\s+/).length < 2 && !fin) return;
          this.bargeIn();
        }
      }
      if (fin) this.heard = `${this.heard} ${fin}`.trim();
      this.interim = interim;
      this.lastHeardAt = performance.now();
      this.setState('hearing');
      if (held) return;
      clearTimeout(this.silence);
      // A pause ends J's turn: shorter after a final phrase than after words still being recognized.
      this.silence = setTimeout(() => this.send(), interim && !fin ? S.pause + 700 : S.pause);
    }

    bargeIn() {
      if (!this.speaker.speaking && !this.thinking) return;
      this.speaker.hush();
      this.quiet = true; // the rest of the interrupted answer goes to the chat only
      if (this.thinking) api(`/api/talk/${this.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
      this.note('Interrupted');
    }

    async send({ held = false } = {}) {
      clearTimeout(this.silence);
      let text = `${this.heard} ${this.interim}`.trim();
      this.heard = '';
      this.interim = '';
      // Recognition can deliver Talk's last sentence late, after it stopped speaking: never send that as J's words.
      if (text && !held && this.speaker.isEcho(text)) { this.dropped++; text = ''; }
      if (!text) return this.setState('listening');
      this.waitingSince = this.lastHeardAt || performance.now();
      this.setState('thinking');
      this.render(text);
      // An answer still running (an interrupted one, or Studio's own) has to end first.
      for (let i = 0; i < 40 && this.thinking; i++) await new Promise((r) => setTimeout(r, 150));
      this.sentAt = performance.now();
      this.firstDelta = null;
      try {
        await api('/api/talk', { method: 'POST', body: { conversation: this.id, message: text, voice: true, context: window.studioContext?.() ?? undefined } });
        window.loadTalk?.().catch(() => {});
      } catch (e) {
        this.note(`Couldn't send: ${e.message}`);
        this.setState('listening');
      }
    }

    // -------------------------------------------- push to talk

    pttStart() {
      if (this.pttDown) return;
      this.pttDown = true;
      clearTimeout(this.pttTimer);
      this.pttTail = false;
      // Pressing cuts Talk off at once, and what it was saying never counts as J's words.
      this.bargeIn();
      clearTimeout(this.silence);
      this.heard = '';
      this.interim = '';
      this.stopMic();
      this.listen();
      this.setState('hearing');
    }

    pttEnd() {
      if (!this.pttDown) return;
      this.pttDown = false;
      // Recognition lags the voice a little: keep listening a moment to catch the last words, then send.
      this.pttTail = true;
      this.render();
      this.pttTimer = setTimeout(() => {
        this.pttTail = false;
        this.stopMic();
        this.send({ held: true });
      }, 450);
    }

    // -------------------------------------------- the phone

    async lockScreen() {
      try { this.wake = await navigator.wakeLock?.request('screen'); } catch {}
    }

    onVisible() {
      if (document.hidden) { this.stopMic(); return; }
      this.lockScreen();
      this.speaker.ctx?.resume?.();
      this.checkIn();
      if (this.wantsMic()) this.listen();
    }

    setState(s) {
      this.state = s;
      this.syncMic();
      this.render();
    }

    /** The mic follows wantsMic(): on when it should hear J, off otherwise (no echo while Talk speaks). */
    syncMic() {
      clearTimeout(this.micTimer);
      if (this.wantsMic()) { if (!this.rec && !this.micBlocked) this.listen(); }
      else {
        this.stopMic();
        // Hands-free without barge-in: back on shortly after Talk's voice ends.
        if (mode() === 'hands-free' && !this.muted && !this.speaker.speaking) this.micTimer = setTimeout(() => this.syncMic(), 400);
      }
    }

    note(t) {
      this.lastNote = t;
      clearTimeout(this.noteTimer);
      // Short notes go away by themselves; problems (the mic, sending) stay until the next one.
      if (/^(Interrupted|⚙|Studio asked)/.test(t)) this.noteTimer = setTimeout(() => { this.lastNote = ''; this.render(); }, 4000);
      this.render();
    }

    render(said) {
      const box = el('#callPane');
      if (!box) return;
      const push = mode() === 'push';
      const label = { connecting: 'Connecting…', listening: push ? 'Hold the button (or Space) to talk' : this.wantsMic() ? 'Listening…' : 'Hold to talk', hearing: 'Hearing you…', thinking: 'Thinking…', speaking: push ? 'Talk is speaking: hold to cut in' : 'Talk is speaking' }[this.state];
      box.dataset.state = this.state;
      box.dataset.mode = push ? 'push' : 'hands-free';
      el('#callState').textContent = this.muted ? 'Muted' : label;
      if (said !== undefined) el('#callYou').textContent = said;
      else if (this.state === 'hearing') el('#callYou').textContent = `${this.heard} ${this.interim}`.trim();
      el('#callNote').textContent = this.lastNote ?? '';
      const l = this.lastLatency;
      const med = this.latencies.length ? [...this.latencies].sort((a, b) => a - b)[Math.floor(this.latencies.length / 2)] : null;
      const voice = S.engine === 'kokoro' ? kokoro.label() : S.engine === 'eleven' ? 'ElevenLabs Flash' : 'browser voice';
      el('#callLatency').textContent = [
        l ? `Last reply: ${(l.ms / 1000).toFixed(1)} s from your last word to Talk's first (pause ${(l.pause / 1000).toFixed(1)} s${l.claude ? `, Claude ${(l.claude / 1000).toFixed(1)} s` : ''}, voice ${(l.voiceMs / 1000).toFixed(1)} s)${this.latencies.length > 1 ? ` · median ${(med / 1000).toFixed(1)} s over ${this.latencies.length}` : ''}` : '',
        `Voice: ${voice}${this.dropped ? ` · ${this.dropped} echo${this.dropped > 1 ? 'es' : ''} ignored` : ''}`,
      ].filter(Boolean).join(' · ');
      el('#callMute').textContent = this.muted ? 'Unmute' : 'Mute';
      const ptt = el('#callPtt');
      ptt.classList.toggle('down', this.pttDown || !!this.pttTail);
      ptt.textContent = this.pttDown ? 'Listening… release to send' : this.pttTail ? 'Sending…' : `Hold to talk${device() === 'computer' ? ' (or Space)' : ''}`;
    }

    async hangUp() {
      call = null;
      clearInterval(this.ping);
      clearTimeout(this.silence);
      clearTimeout(this.micTimer);
      this.abort.abort();
      this.stopMic();
      this.speaker.hush();
      this.speaker.ctx?.close?.().catch(() => {});
      this.wake?.release?.().catch(() => {});
      el('#callPane').hidden = true;
      document.body.classList.remove('in-call');
      dispatchEvent(new Event('resize'));
      if (this.id) await api(`/api/talk/${this.id}/call`, { method: 'POST', body: { end: true } }).catch(() => {});
      window.loadTalk?.().catch(() => {});
    }
  }

  // ------------------------------------------------------------ UI

  /** Runs inside the tap: phones only let a page make sound (and open the mic) from a user gesture. */
  function unlockAudio(speaker) {
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {}
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      speaker.ctx = new AC();
      // A silent sample played now keeps the context allowed to play for the rest of the call (iOS).
      const src = speaker.ctx.createBufferSource();
      src.buffer = speaker.ctx.createBuffer(1, 1, 22050);
      src.connect(speaker.ctx.destination);
      src.start();
      speaker.ctx.resume?.();
    } catch {}
  }

  async function startCall() {
    if (call) return;
    const pane = el('#callPane');
    pane.hidden = false;
    document.body.classList.add('in-call');
    dispatchEvent(new Event('resize')); // Talk's height follows the header's (hidden on a phone during a call)
    call = new Call();
    unlockAudio(call.speaker);
    try {
      await call.start(window.talkConversation?.() ?? null);
    } catch (e) {
      call?.note(`Couldn't start the call: ${e.message}`);
    }
  }

  /**
   * The Settings tab's voice test (and a measurement): says a sentence with the chosen engine and reports the time to
   * the first sound, and Kokoro's real-time factor (seconds of compute per second of speech; under 1 keeps up).
   */
  async function testVoice(text = "Hi J. This is Talk's voice: the agent is started, and the details are in the chat.") {
    await loadSettings();
    const tmp = {};
    unlockAudio(tmp);
    const ctx = tmp.ctx;
    const out = { engine: S.engine };
    if (S.engine === 'kokoro') {
      const t0 = performance.now();
      const ok = await kokoro.load();
      out.load = { ms: Math.round(performance.now() - t0), device: kokoro.device, dtype: kokoro.dtype, ok, error: kokoro.error };
      if (!ok) return out;
      const runs = [];
      for (const s of [text, 'Two short sentences.', 'The daily run found three bugs in Dose Of Destruction, and one of them blocks the second stage.']) {
        const t1 = performance.now();
        const m = await kokoro.synth(s, S.kokoroVoice, S.rate);
        runs.push({ chars: s.length, ms: Math.round(performance.now() - t1), audioSeconds: +(m.audio.length / m.rate).toFixed(2), rtf: +((performance.now() - t1) / 1000 / (m.audio.length / m.rate)).toFixed(2) });
      }
      out.sentences = runs;
    }
    await new Promise((resolve) => {
      const t0 = performance.now();
      const sp = new Speaker(() => listener);
      const listener = { onSpeechStart: () => (out.firstSoundMs = Math.round(performance.now() - t0)), onSpoken: () => !sp.speaking && resolve(), note: () => {} };
      sp.ctx = ctx;
      sp.say(text);
      out.speaker = sp;
      setTimeout(resolve, 20_000);
    });
    ctx?.close?.().catch(() => {});
    const sp = out.speaker;
    delete out.speaker;
    out.voice = out.engine === 'browser' || !sp.stats[0] || sp.stats[0].engine === 'browser' ? pickVoice()?.name ?? 'browser default' : out.engine === 'kokoro' ? S.kokoroVoice : S.elevenVoice;
    console.info('[call] voice test', out);
    return out;
  }

  /** For the Settings tab (settings.js). */
  window.callVoice = {
    device, pickVoice, testVoice, kokoro, loadSettings,
    get settings() { return S; },
    /** The call in progress (for debugging in the console). */
    get call() { return call; },
    get prices() { return prices; },
    get local() { return local; },
    setLocal(patch) { Object.assign(local, patch); saveLocal(); },
    /** New settings saved on the Settings tab: a call in progress uses them from its next sentence. */
    apply(next) {
      S = { ...DEFAULTS, ...next, mode: { ...DEFAULTS.mode, ...(next?.mode ?? {}) } };
      if (S.engine === 'kokoro' && call) kokoro.load();
      if (call) { call.syncMic(); call.render(); }
    },
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('#talkCall')) startCall();
    if (e.target.id === 'callHang') call?.hangUp();
    if (e.target.id === 'callMute' && call) { call.muted = !call.muted; call.syncMic(); call.render(); }
    if (e.target.id === 'callOrb' && call) {
      // Tapping the circle: interrupt Talk, or send what was heard now.
      if (call.speaker.speaking || call.thinking) call.bargeIn();
      else if (call.heard || call.interim) call.send();
    }
    if (e.target.id === 'callSettingsBtn') window.show?.('settings');
  });
  // Push to talk: hold the button (touch or mouse), or hold the space bar on a computer, in either mode.
  const ptt = el('#callPtt');
  ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture?.(e.pointerId); call?.pttStart(); });
  ptt.addEventListener('pointerup', () => call?.pttEnd());
  ptt.addEventListener('pointercancel', () => call?.pttEnd());
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  const typing = (t) => /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable;
  addEventListener('keydown', (e) => { if (call && e.code === 'Space' && !typing(e.target)) { e.preventDefault(); if (!e.repeat) call.pttStart(); } });
  addEventListener('keyup', (e) => { if (call && e.code === 'Space' && !typing(e.target)) { e.preventDefault(); call.pttEnd(); } });
  addEventListener('blur', () => call?.pttEnd()); // Space released in another window
  // The screen locked or the tab went away: the mic stops; it comes back with the page.
  document.addEventListener('visibilitychange', () => call?.onVisible());
  if (!('speechSynthesis' in window)) el('#talkCall').hidden = true;
})();
