// Calls: J talks to Talk like a phone call (the 📞 button in Talk). Loaded after talk.js (uses api, esc, GEN, openTalk).
//
// Cheap and fast by default: the browser hears J (Web Speech API SpeechRecognition, free) and speaks Talk's answer
// (speechSynthesis, free), sentence by sentence as it streams in (GET /api/talk/<id>/events). The server keeps a warm
// Claude Code process for the call (talk.ts startCall), so a turn doesn't pay Claude Code's start-up. Hands-free: a
// pause after J speaks sends it; J talking while Talk speaks interrupts it (barge-in; what the mic hears of Talk's own
// voice is ignored). Push to talk is the fallback. The call is a normal Talk conversation: every word is in the chat.
// Optional: an ElevenLabs Flash voice through Hawkes Gen (audio.voice), off by default, with its cost per minute.
(() => {
  const el = (s) => document.querySelector(s);
  const Rec = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  /** Flash costs half the credits of the standard voices: about 900 characters per spoken minute. */
  const FLASH_PER_MIN = 900 / 1000 * 0.3 * 0.5;

  // Settings (this browser only).
  const load = () => { try { return JSON.parse(localStorage.getItem('studio.call') ?? '{}'); } catch { return {}; } };
  const prefs = { mode: 'hands-free', bargeIn: !iOS, pause: 800, rate: 1.08, voice: '', eleven: false, elevenVoice: '', ...load() };
  const savePrefs = () => { try { localStorage.setItem('studio.call', JSON.stringify(prefs)); } catch {} };

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

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (prefs.voice) { const v = voices.find((x) => x.name === prefs.voice); if (v) return v; }
    const lang = navigator.language || 'en-US';
    const en = voices.filter((v) => v.lang?.startsWith(lang.slice(0, 2)));
    return en.find((v) => /natural|premium|enhanced|neural/i.test(v.name)) ?? en.find((v) => /Google US English|Samantha|Daniel|Karen/i.test(v.name)) ?? en.find((v) => v.lang === lang) ?? en[0] ?? null;
  }

  /** Speaks sentences in order: the browser's voice, or ElevenLabs Flash clips (fetched ahead while one plays). */
  class Speaker {
    constructor() { this.queue = []; this.busy = false; this.ctx = null; this.source = null; this.spoken = []; this.gen = 0; }
    get speaking() { return this.busy || this.queue.length > 0; }
    say(text) {
      const item = { text, gen: this.gen };
      if (prefs.eleven && prefs.elevenVoice && this.ctx) item.clip = elevenClip(text, this.ctx).catch(() => null);
      this.queue.push(item);
      this.next();
    }
    async next() {
      if (this.busy || !this.queue.length) return;
      const item = this.queue.shift();
      this.busy = true;
      this.spoken.push(item.text);
      if (this.spoken.length > 4) this.spoken.shift();
      const done = () => { if (item.gen !== this.gen) return; this.busy = false; call?.onSpoken(); this.next(); };
      // A clip that isn't there within 3 s is spoken by the browser's voice instead.
      const clip = item.clip ? await Promise.race([item.clip, new Promise((r) => setTimeout(() => r(null), 3000))]) : null;
      if (item.gen !== this.gen) return;
      if (clip) {
        call?.onSpeechStart();
        const src = this.ctx.createBufferSource();
        src.buffer = clip;
        src.playbackRate.value = Math.min(1.2, prefs.rate);
        src.connect(this.ctx.destination);
        src.onended = done;
        this.source = src;
        src.start();
        return;
      }
      const u = new SpeechSynthesisUtterance(item.text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = prefs.rate;
      u.onstart = () => call?.onSpeechStart();
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    }
    /** Barge-in or hang up: silence now, drop what was waiting. */
    hush() {
      this.gen++;
      this.queue = [];
      this.busy = false;
      speechSynthesis.cancel();
      try { this.source?.stop(); } catch {}
      this.source = null;
    }
    /** Does what the mic heard look like Talk's own voice (speaker echo)? */
    isEcho(heard) {
      const words = heard.toLowerCase().match(/[a-z0-9']+/g) ?? [];
      if (!words.length) return true;
      const said = new Set(this.spoken.join(' ').toLowerCase().match(/[a-z0-9']+/g) ?? []);
      return words.filter((w) => said.has(w)).length / words.length >= 0.5;
    }
  }

  /** One sentence in ElevenLabs Flash through Hawkes Gen (about half a second), decoded and ready to play. */
  async function elevenClip(text, ctx) {
    const r = await fetch(`${GEN}/v1/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'audio.voice', project: 'hawkesstudio', labels: { from: 'talk call' }, params: { text, voice: prefs.elevenVoice, model: 'eleven_flash_v2_5', format: 'mp3_44100_64' }, timeout: 20 }) });
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
      this.abort = new AbortController();
    }

    async start(conversation) {
      this.render();
      const r = await api('/api/talk/call', { method: 'POST', body: { conversation } });
      this.id = r.id;
      window.openTalk?.(r.id);
      this.listen();
      this.ping = setInterval(() => this.checkIn(), 20_000);
      this.lockScreen();
      this.events();
      this.setState('listening');
    }

    async checkIn() {
      if (!this.id) return;
      await api(`/api/talk/${this.id}/call`, { method: 'POST', body: {} }).catch(() => {});
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

    onSpeechStart() {
      // Latency: J's last word heard (or the send) to Talk's first word.
      if (this.waitingSince) {
        const ms = Math.round(performance.now() - this.waitingSince);
        this.latencies.push(ms);
        this.lastLatency = { ms, claude: this.firstDelta ? Math.round(this.firstDelta - this.sentAt) : null, pause: Math.round(this.sentAt - this.waitingSince) };
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
      if (!Rec()) return this.note('This browser has no speech recognition: use Chrome or Safari. You can still type in the chat; answers are spoken.');
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
          this.note(iOS ? 'Microphone blocked: allow it in Settings › Safari › Microphone (and Speech Recognition), then tap Call again.' : 'Microphone blocked: allow it for this site (the lock icon in the address bar), then tap Call again.');
          this.render();
        } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') this.note(`Speech recognition: ${ev.error}`);
      };
      rec.onend = () => {
        this.rec = null;
        // It stops by itself after a phrase or a silence: start it again while the call wants to hear J.
        if (call === this && this.wantsMic() && !this.micBlocked && !document.hidden) setTimeout(() => this.listen(), 150);
      };
      this.rec = rec;
      try { rec.start(); } catch { this.rec = null; }
    }

    /** Hands-free: always, except while Talk speaks without barge-in. Push to talk: while the button is held. */
    wantsMic() {
      if (this.muted) return false;
      if (prefs.mode === 'push') return this.pttDown || !!this.heard;
      return prefs.bargeIn || !this.speaker.speaking;
    }

    stopMic() { try { this.rec?.abort(); } catch {} this.rec = null; }

    onHeard(fin, interim) {
      const text = `${fin} ${interim}`.trim();
      if (!text) return;
      // While Talk speaks, what the mic hears may be Talk itself: only J's own words interrupt it.
      if (this.speaker.speaking || this.thinking) {
        if (prefs.mode !== 'push' && this.speaker.speaking && this.speaker.isEcho(text)) return;
        if (prefs.mode !== 'push' && text.split(/\s+/).length < 2 && !fin) return;
        this.bargeIn();
      }
      if (fin) this.heard = `${this.heard} ${fin}`.trim();
      this.interim = interim;
      this.lastHeardAt = performance.now();
      this.setState('hearing');
      if (prefs.mode === 'push') return;
      clearTimeout(this.silence);
      // A pause ends J's turn: shorter after a final phrase than after words still being recognized.
      this.silence = setTimeout(() => this.send(), interim && !fin ? prefs.pause + 700 : prefs.pause);
    }

    bargeIn() {
      if (!this.speaker.speaking && !this.thinking) return;
      this.speaker.hush();
      this.quiet = true; // the rest of the interrupted answer goes to the chat only
      if (this.thinking) api(`/api/talk/${this.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
      this.note('Interrupted');
    }

    async send() {
      clearTimeout(this.silence);
      const text = `${this.heard} ${this.interim}`.trim();
      this.heard = '';
      this.interim = '';
      if (!text) return this.setState('listening');
      this.waitingSince = this.lastHeardAt || performance.now();
      this.setState('thinking');
      this.render(text);
      // An answer still running (an interrupted one, or Studio's own) has to end first.
      for (let i = 0; i < 40 && this.thinking; i++) await new Promise((r) => setTimeout(r, 150));
      this.sentAt = performance.now();
      this.firstDelta = null;
      try {
        await api('/api/talk', { method: 'POST', body: { conversation: this.id, message: text, voice: true } });
        window.loadTalk?.().catch(() => {});
      } catch (e) {
        this.note(`Couldn't send: ${e.message}`);
        this.setState('listening');
      }
    }

    // -------------------------------------------- push to talk

    pttStart() {
      this.pttDown = true;
      this.bargeIn();
      this.heard = '';
      this.interim = '';
      this.stopMic();
      this.listen();
      this.setState('hearing');
    }

    pttEnd() {
      if (!this.pttDown) return;
      this.pttDown = false;
      // Recognition lags the voice a little: give it a moment to finish the last words.
      setTimeout(() => { this.stopMic(); this.send(); }, 450);
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
      // Without barge-in the mic is off while Talk speaks, and back on after.
      if (this.wantsMic()) { if (!this.rec && prefs.mode !== 'push') this.listen(); } else if (prefs.mode !== 'push') this.stopMic();
      this.render();
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
      const label = { connecting: 'Connecting…', listening: prefs.mode === 'push' ? 'Hold to talk' : 'Listening…', hearing: 'Hearing you…', thinking: 'Thinking…', speaking: 'Talk is speaking' }[this.state];
      box.dataset.state = this.state;
      el('#callState').textContent = this.muted ? 'Muted' : label;
      if (said !== undefined) el('#callYou').textContent = said;
      else if (this.state === 'hearing') el('#callYou').textContent = `${this.heard} ${this.interim}`.trim();
      el('#callNote').textContent = this.lastNote ?? '';
      const l = this.lastLatency;
      const med = this.latencies.length ? [...this.latencies].sort((a, b) => a - b)[Math.floor(this.latencies.length / 2)] : null;
      el('#callLatency').textContent = l ? `Last reply: ${(l.ms / 1000).toFixed(1)} s from your last word to Talk's first (pause ${(l.pause / 1000).toFixed(1)} s${l.claude ? `, Claude ${(l.claude / 1000).toFixed(1)} s` : ''})${this.latencies.length > 1 ? ` · median ${(med / 1000).toFixed(1)} s over ${this.latencies.length}` : ''}` : '';
      el('#callMute').textContent = this.muted ? 'Unmute' : 'Mute';
      el('#callPtt').hidden = prefs.mode !== 'push';
    }

    async hangUp() {
      call = null;
      clearInterval(this.ping);
      clearTimeout(this.silence);
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

  function renderSettings() {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith((navigator.language || 'en').slice(0, 2)));
    const auto = pickVoice();
    el('#callSettingsBody').innerHTML = `
      <label>Mode <select id="callMode"><option value="hands-free" ${prefs.mode === 'hands-free' ? 'selected' : ''}>Hands-free (a pause sends)</option><option value="push" ${prefs.mode === 'push' ? 'selected' : ''}>Push to talk</option></select></label>
      <label><input type="checkbox" id="callBarge" ${prefs.bargeIn ? 'checked' : ''}> Talking interrupts Talk${iOS ? ' (works best with headphones on iPhone)' : ''}</label>
      <label>Pause before Talk answers <select id="callPause">${[[500, 'short'], [800, 'normal'], [1300, 'long']].map(([v, n]) => `<option value="${v}" ${prefs.pause === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Voice <select id="callVoice"><option value="">Automatic (${esc(auto?.name ?? 'browser default')})</option>${voices.map((v) => `<option ${v.name === prefs.voice ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
      <label>Speed <input type="range" id="callRate" min="0.8" max="1.4" step="0.02" value="${prefs.rate}"></label>
      <label><input type="checkbox" id="callEleven" ${prefs.eleven ? 'checked' : ''}> Nicer voice: ElevenLabs Flash through Hawkes Gen, about $${FLASH_PER_MIN.toFixed(2)} a minute while Talk speaks (adds about half a second before Talk's first word)</label>
      <label ${prefs.eleven ? '' : 'hidden'}>ElevenLabs voice <select id="callElevenVoice"><option value="">loading…</option></select></label>
      <p class="meta">The browser's voice and speech recognition are free. Talk's answers run on the Max plan like the chat.</p>`;
    if (prefs.eleven) loadElevenVoices();
  }

  async function loadElevenVoices() {
    try {
      const r = await fetch(`${GEN}/v1/providers/elevenlabs/voices`).then((x) => x.json());
      const list = (r.voices ?? []).filter((v) => v.category === 'premade' || v.category === 'professional' || v.category === 'cloned' || v.category === 'generated');
      if (!prefs.elevenVoice && list[0]) { prefs.elevenVoice = list[0].id; savePrefs(); }
      el('#callElevenVoice').innerHTML = list.map((v) => `<option value="${esc(v.id)}" ${v.id === prefs.elevenVoice ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
    } catch (e) {
      el('#callElevenVoice').innerHTML = `<option>couldn't load: ${esc(e.message)}</option>`;
    }
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#talkCall')) startCall();
    if (e.target.id === 'callHang') call?.hangUp();
    if (e.target.id === 'callMute' && call) { call.muted = !call.muted; if (call.muted) call.stopMic(); call.setState(call.state); }
    if (e.target.id === 'callOrb' && call && prefs.mode !== 'push') {
      // Tapping the circle: interrupt Talk, or send what was heard now.
      if (call.speaker.speaking || call.thinking) call.bargeIn();
      else if (call.heard || call.interim) call.send();
    }
    if (e.target.id === 'callSettingsBtn') { const b = el('#callSettings'); b.hidden = !b.hidden; if (!b.hidden) renderSettings(); }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'callMode') prefs.mode = t.value;
    else if (t.id === 'callBarge') prefs.bargeIn = t.checked;
    else if (t.id === 'callPause') prefs.pause = Number(t.value);
    else if (t.id === 'callVoice') prefs.voice = t.value;
    else if (t.id === 'callRate') prefs.rate = Number(t.value);
    else if (t.id === 'callEleven') { prefs.eleven = t.checked; renderSettings(); }
    else if (t.id === 'callElevenVoice') prefs.elevenVoice = t.value;
    else return;
    savePrefs();
    if (call) { call.stopMic(); call.setState(call.state); }
  });
  // Push to talk: hold the button (touch or mouse), or hold the space bar on a computer.
  const ptt = el('#callPtt');
  ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture?.(e.pointerId); call?.pttStart(); });
  ptt.addEventListener('pointerup', () => call?.pttEnd());
  ptt.addEventListener('pointercancel', () => call?.pttEnd());
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => { if (call && prefs.mode === 'push' && e.code === 'Space' && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { e.preventDefault(); call.pttStart(); } });
  addEventListener('keyup', (e) => { if (call && prefs.mode === 'push' && e.code === 'Space') call.pttEnd(); });
  // The screen locked or the tab went away: the mic stops; it comes back with the page.
  document.addEventListener('visibilitychange', () => call?.onVisible());
  window.speechSynthesis?.addEventListener?.('voiceschanged', () => { if (!el('#callSettings').hidden) renderSettings(); });
  if (!('speechSynthesis' in window)) el('#talkCall').hidden = true;
})();
