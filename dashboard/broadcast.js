// The On Air show page. It polls /api/broadcast every second and paints the show Studio is running (show.ts): the rung
// on now (a live playtest, an agent at work, the roadmap, or something from the showcase), Yooba's line, what else is
// on the floor and what just landed. The clock is Studio's, so this page, the director's and the encoder agree.
// ?clean=1 is the 1920×1080 frame the encoder captures: no director bar, no cursor.
// The director's bar posts /api/broadcast/desk (only from J's dashboard session).
(() => {
  const q = new URLSearchParams(location.search);
  const clean = q.get('clean') === '1';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KIND_LABEL = { playtest: 'LIVE PLAYTEST', work: 'IN THE WORKSHOP', roadmap: 'ON THE ROADMAP', showcase: 'FROM THE STUDIO', lore: 'THE LORE', quiet: 'HAWKES STUDIO' };
  const KIND_COLOR = { playtest: 'var(--live)', work: 'var(--work)', roadmap: 'var(--road)', showcase: 'var(--show)', lore: 'var(--lore)', quiet: 'var(--mint)' };
  let latest = {};
  let segId = '';
  let lineId = '';
  let posting = false;

  document.body.classList.add(clean ? 'clean' : 'desk');

  // The director's panel is a column on the right; on a narrow window it sits under the stage instead.
  function fit() {
    const narrow = !clean && window.innerWidth <= 900;
    const side = clean || narrow ? 0 : ($('desk')?.offsetWidth || 0);
    const z = narrow ? window.innerWidth / 1920 : Math.min(Math.max(1, window.innerWidth - side) / 1920, window.innerHeight / 1080);
    $('stage').style.transform = `scale(${z})`;
    if (!clean) $('desk').style.top = narrow ? `${Math.round(1080 * z)}px` : '';
  }
  addEventListener('resize', fit);
  fit();

  // Equalizer bars for songs: CSS animates them; each gets its own speed.
  $('sh-eq').innerHTML = Array.from({ length: 28 }, (_, i) => `<i style="animation-duration:${(0.35 + ((i * 37) % 60) / 100).toFixed(2)}s;animation-delay:-${(i * 0.13).toFixed(2)}s"></i>`).join('');

  const setSrc = (el, src) => { if ((el.dataset.src || '') !== (src || '')) { el.dataset.src = src || ''; if (src) el.src = src; else el.removeAttribute('src'); } };
  const bg = (el, url) => { const v = url ? `url("${url}")` : 'none'; if (el.style.backgroundImage !== v) el.style.backgroundImage = v; };

  function scene(kind) {
    for (const k of ['playtest', 'work', 'roadmap', 'showcase', 'lore', 'quiet']) $(`sc-${k}`).classList.toggle('on', k === kind);
  }

  function stinger(kind) {
    const el = $('stinger');
    el.style.setProperty('--k', KIND_COLOR[kind] || 'var(--mint)');
    el.querySelector('span').textContent = KIND_LABEL[kind] || '';
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
  }

  function paintPlaytest(c, show) {
    // A higher frame rate for the one on screen; the rail's thumbnails stay cheap.
    setSrc($('pt-live'), c.stream ? c.stream.replace(/fps=\d+/, 'fps=15') : '');
    $('pt-product').textContent = c.productName || '';
    $('pt-scenario').textContent = c.scenario ? `Testing: ${c.scenario}` : (c.checks || '');
    $('pt-now').textContent = c.note || c.step || 'Getting started';
    const pr = $('pt-problems');
    pr.hidden = !c.problems;
    pr.textContent = c.problems ? `${c.problems} problem${c.problems === 1 ? '' : 's'} spotted` : '';
    const w = $('pt-wrap');
    w.hidden = !show.wrap;
    w.textContent = show.wrap ? `Run finished: ${show.wrap}` : '';
  }

  function paintWork(c) {
    bg($('wk-bg'), c.still);
    $('wk-product').textContent = c.productName || '';
    $('wk-title').textContent = c.title || '';
    $('wk-meta').textContent = [c.status, `${c.minutes} min on it`, c.size].filter(Boolean).join(' · ');
    $('wk-why').textContent = c.why || '';
    const notes = (c.notes || []).map((n) => `<li>${esc(n)}</li>`).join('') || '<li>Reading the brief…</li>';
    if ($('wk-notes').dataset.v !== notes) { $('wk-notes').dataset.v = notes; $('wk-notes').innerHTML = notes; }
    $('wk-criteria').innerHTML = (c.criteria || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>The agent checks its own work, then a playtest does.</li>';
    const tools = (c.tools || []).map((t) => `<span>${esc(t)}</span>`).join('');
    if ($('wk-tools').dataset.v !== tools) { $('wk-tools').dataset.v = tools; $('wk-tools').innerHTML = tools; }
  }

  function paintRoadmap(c) {
    bg($('rm-bg'), c.still);
    $('rm-product').textContent = c.productName || '';
    $('rm-milestone').textContent = c.milestone || 'What’s next';
    const pct = c.total ? c.done / c.total : 0;
    $('rm-ring').style.strokeDashoffset = String(327 * (1 - pct));
    $('rm-count').textContent = c.total ? `${c.done}/${c.total}` : '—';
    $('rm-goal').textContent = c.goal || '';
    // Each item: its state and real task count, what an agent is on now (else why it's planned), its bar of tasks merged.
    const html = (c.items || []).map((i, n) => `<div class="rm-item" style="animation-delay:${n * 0.12}s"><b>${esc(i.title)}</b><span class="st">${esc([i.state, i.tasks].filter(Boolean).join(' · '))}</span>${i.inMilestone && c.milestone ? '<span class="ms">milestone</span>' : ''}${i.now ? `<small class="now">Now: ${esc(i.now)}</small>` : i.why ? `<small>${esc(i.why)}</small>` : ''}<div class="track"><span style="width:${Math.round((i.pct || 0) * 100)}%"></span></div></div>`).join('');
    if ($('rm-items').dataset.v !== html) { $('rm-items').dataset.v = html; $('rm-items').innerHTML = html; }
  }

  function paintLore(c) {
    bg($('lo-bg'), c.still);
    $('lo-product').textContent = c.productName || '';
    $('lo-title').textContent = c.title || '';
    $('lo-body').textContent = c.body || '';
    const now = (c.related || []).map((t) => `<li>${esc(t)}</li>`).join('');
    $('lo-now-box').hidden = !now;
    if ($('lo-now').dataset.v !== now) { $('lo-now').dataset.v = now; $('lo-now').innerHTML = now; }
  }

  // The host on air: their portrait (a cutout figure, or a photo filling the cam), name and tagline.
  function paintHost(h) {
    if (!h) return;
    const img = $('yooba');
    setSrc(img, h.image);
    img.classList.toggle('photo', !h.cutout);
    $('host-name').textContent = (h.name || '').toUpperCase();
    $('host-tag').textContent = h.tagline || '';
    $('caption-who').textContent = (h.name || '').toUpperCase();
  }

  function paintShowcase(c, show) {
    const img = $('sh-img'), vid = $('sh-video'), song = $('sh-song');
    img.style.display = c.kind === 'image' ? '' : 'none';
    vid.style.display = c.kind === 'video' ? '' : 'none';
    song.style.display = c.kind === 'song' ? '' : 'none';
    if (c.kind === 'image') {
      if (img.dataset.src !== c.src) { img.style.animation = 'none'; void img.offsetWidth; img.style.animation = ''; }
      setSrc(img, c.src);
    } else setSrc(img, '');
    if (c.kind === 'video') { setSrc(vid, c.src); if (vid.paused) vid.play().catch(() => {}); } else { vid.pause(); setSrc(vid, ''); }
    if (c.kind === 'song') {
      bg($('sh-cover'), c.cover);
      $('sh-song-title').textContent = `A song for ${c.productName}`;
      $('sh-song-meta').textContent = [c.what, c.bpm ? `${c.bpm} BPM` : '', c.key].filter(Boolean).join(' · ');
    }
    $('sh-product').textContent = c.kind === 'song' ? '' : (c.productName || '');
    $('sh-what').textContent = c.kind === 'song' ? '' : [c.title, c.what].filter(Boolean).join(' · ');
    playSong(show.music);
  }

  // Songs play here too (J hears them on the director page); the encoder mixes the same file into the stream.
  function playSong(m) {
    const a = $('song-audio');
    if (!m) { if (!a.paused) a.pause(); setSrc(a, ''); return; }
    if (a.dataset.src !== m.src) {
      setSrc(a, m.src);
      a.onloadedmetadata = () => { a.currentTime = Math.max(0, (Date.now() - m.started) / 1000) % (a.duration || 1e9); };
    }
    a.volume = document.body.classList.contains('talking') ? 0.25 : 0.8;
    if (a.paused) a.play().catch(() => {});
  }

  function paintRail(d) {
    const s = d.show || {};
    const also = (s.upNext || []).map((x) => x.stream
      ? `<div class="also"><img src="${esc(x.stream)}" alt=""><div><b>${esc(x.title)}</b><small>${esc(x.sub || '')}</small></div></div>`
      : `<div class="also text"><div><b>${esc(x.title)}</b><small>${esc(x.sub || '')}</small></div></div>`).join('');
    if ($('also').dataset.v !== also) { $('also').dataset.v = also; $('also').innerHTML = also; }
    $('rail-k').style.display = also ? '' : 'none';
    const landed = s.kind === 'playtest' ? (s.card?.landed || []) : s.kind === 'roadmap' ? (s.card?.recent || []) : [];
    const items = landed.length ? landed.map((l) => ({ t: l.title, s: l.ago })) : (d.ticker || []).slice(0, 4).map((t) => ({ t: t.text, s: '' }));
    $('landed-k').textContent = landed.length ? `${s.kind === 'roadmap' ? 'Merged this week in' : 'Just landed in'} ${s.card.productName}` : 'On the floor';
    const html = items.map((i) => `<div class="landed">${esc(i.t)}${i.s ? `<small>${esc(i.s)}</small>` : ''}</div>`).join('');
    if ($('landed').dataset.v !== html) { $('landed').dataset.v = html; $('landed').innerHTML = html; }
  }

  function paintCaption(s) {
    const line = s.line;
    const text = line?.text || '';
    if (line?.id !== lineId) {
      lineId = line?.id || '';
      const el = $('caption-text');
      el.textContent = text;
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      // A quiet segment: no caption bar (the host sat it out).
      document.body.classList.toggle('silent', !text);
      if (!clean && line?.voice && latest.desk?.voice !== false) {
        const a = $('host-audio');
        setSrc(a, line.voice);
        a.play().catch(() => {});
      }
    }
    document.body.classList.toggle('talking', !!line?.speaking);
  }

  function render(d) {
    latest = d;
    const s = d.show || {};
    const kind = s.kind || 'quiet';
    if (s.id && s.id !== segId) { segId = s.id; stinger(kind); }
    const c = s.card;
    scene(c ? kind : 'quiet');
    if (c && kind === 'playtest') paintPlaytest(c, s);
    else { setSrc($('pt-live'), ''); }
    if (c && kind === 'work') paintWork(c);
    if (c && kind === 'roadmap') paintRoadmap(c);
    if (c && kind === 'lore') paintLore(c);
    paintHost(s.host);
    if (c && kind === 'showcase') paintShowcase(c, s); else { playSong(null); $('sh-video').pause(); }
    for (const el of document.querySelectorAll('#ladder span')) {
      const k = el.dataset.k;
      el.classList.toggle('on', k === kind);
      const b = el.querySelector('b');
      if (b) b.textContent = s.counts?.[k] ? String(s.counts[k]) : '';
    }
    paintRail(d);
    paintCaption(s);
    const line = (d.ticker || []).map((t) => t.text).join('     •     ');
    if ($('ticker').dataset.v !== line) { $('ticker').dataset.v = line; $('ticker').innerHTML = line ? `<span>${esc(line)}</span>` : ''; }
    $('banner').hidden = !d.desk?.banner;
    $('banner').textContent = d.desk?.banner || '';
    document.body.classList.toggle('hide-host', d.desk?.showHost === false);
    document.body.classList.toggle('hide-pips', d.desk?.showPips === false);
    document.body.classList.toggle('hide-ticker', d.desk?.showTicker === false);
    $('disclose').textContent = d.disclose || '';
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (!clean) paintDesk(d);
  }

  // ---------------------------------------------------------------- the director's bar

  function setSelect(el, key, html, value) {
    if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = html; }
    if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
  }
  const setCheck = (id, on) => { const el = $(id); if (el && document.activeElement !== el) el.checked = !!on; };
  const setText = (id, v) => { const el = $(id); if (el && document.activeElement !== el && el.value !== v) el.value = v; };

  function paintDesk(d) {
    const desk = d.desk || {};
    const lineup = d.lineup || [];
    setSelect($('desk-product'), lineup.map((p) => p.id).join('|'), ['<option value="">Every product</option>', ...lineup.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)].join(''), desk.product || '');
    setSelect($('desk-screen'), 'screen', $('desk-screen').innerHTML, desk.screen || 'auto');
    const takes = (d.takes || []).filter((t) => t.phase === 'playing');
    setSelect($('desk-take'), takes.map((t) => t.job).join('|'), ['<option value="">Take turns</option>', ...takes.map((t) => `<option value="${esc(t.job)}">${esc([t.productName, t.scenario].filter(Boolean).join(' · '))}</option>`)].join(''), desk.screen === 'take' ? desk.take || '' : '');
    setCheck('desk-voice', desk.voice !== false);
    setCheck('desk-brain', desk.brain !== false);
    setCheck('desk-showHost', desk.showHost !== false);
    setCheck('desk-showPips', desk.showPips !== false);
    setCheck('desk-showTicker', desk.showTicker !== false);
    setText('desk-banner', desk.banner || '');
    setText('desk-cue', desk.cue || '');
    $('desk-pause').textContent = desk.paused ? 'Resume' : 'Pause';
    setSelect($('desk-variety'), 'variety', $('desk-variety').innerHTML, desk.variety || 3);
    setSelect($('desk-mix'), 'mix', $('desk-mix').innerHTML, desk.mix || 'shuffle');
    setCheck('desk-cutIn', desk.cutIn !== false);
    paintHostDesk(d);
    setSelect($('pt-product-pick'), lineup.map((p) => p.id).join('|'), lineup.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''), $('pt-product-pick').value || desk.product || lineup[0]?.id || '');
    paintLadder(desk);
    paintAir(d.onAir);
    const s = d.show || {};
    const u = s.usage || {};
    $('desk-now').textContent = [
      s.error ? `Show error: ${s.error}` : `On now: ${KIND_LABEL[s.kind] || '—'}${s.card ? ` · ${s.card.productName || ''} ${s.card.title || s.card.scenario || ''}` : ''}`,
      `lines by ${s.by || '—'}`,
      `next in ${Math.round((s.remaining || 0) / 1000)}s`,
    ].filter(Boolean).join('   ·   ');
    $('desk-usage').textContent = u.budget
      ? `Today: ${u.brainCalls}/${u.budget.brainCalls} lines written, ${u.reused || 0} reused. Voice: ${u.voiceChars}/${u.budget.voiceChars} new characters paid, ${u.voiceCached || 0} replayed free from the cache.`
      : '';
    fit();
  }

  // ---------------------------------------------------------------- the host: who, how often they change, when they talk

  /** A select's options, keeping a value that isn't one of them (set elsewhere) as its own option. */
  function selectWith(el, value) {
    const v = String(value);
    if (![...el.options].some((o) => o.value === v)) el.add(new Option(v, v));
    if (document.activeElement !== el && el.value !== v) el.value = v;
  }

  function paintHostDesk(d) {
    const desk = d.desk || {};
    const all = d.hostsAll || [];
    const s = d.show || {};
    setSelect($('desk-host'), all.map((h) => h.id).join('|'), ['<option value="">Take turns</option>', ...all.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`)].join(''), desk.host || '');
    selectWith($('desk-rotateMin'), desk.rotateMin ?? 15);
    const on = desk.hosts || all.map((h) => h.id);
    const roster = all.map((h) => `<label title="${esc(h.tagline)}"><input type="checkbox" data-host="${esc(h.id)}" ${on.includes(h.id) ? 'checked' : ''}> ${esc(h.name)}</label>`).join('');
    const box = $('host-roster');
    if (box.dataset.v !== roster && !box.contains(document.activeElement)) { box.dataset.v = roster; box.innerHTML = `<span>Takes turns:</span>${roster}`; }
    const t = desk.talk || {};
    for (const el of document.querySelectorAll('[data-moment]')) if (document.activeElement !== el) el.checked = !!t.moments?.[el.dataset.moment];
    selectWith($('talk-gapSec'), t.gapSec ?? 90);
    selectWith($('talk-chance'), t.chance ?? 50);
    selectWith($('talk-maxLines'), t.maxLines ?? 2);
    const quietFor = s.lastSpoke ? Math.round((Date.now() - s.lastSpoke) / 1000) : null;
    $('host-now').textContent = [
      s.host ? `On air: ${s.host.name}` : '',
      s.hostFor != null ? `next host in ${s.hostFor} min` : desk.host ? 'held' : '',
      quietFor != null ? `last talked ${quietFor < 90 ? `${quietFor}s` : `${Math.round(quietFor / 60)} min`} ago` : '',
    ].filter(Boolean).join(' · ');
  }

  // ---------------------------------------------------------------- what's on: which segments, how often, how long

  const RUNG_LABEL = { playtest: 'Playtests', work: 'Agents at work', roadmap: 'Roadmap', showcase: 'Showcase', lore: 'Lore' };
  const RUNGS = ['playtest', 'work', 'roadmap', 'showcase', 'lore'];
  /** All four rungs in the director's order: the ones on first (their order), then the ones off. */
  const ladderRows = (desk) => {
    const on = desk.ladder || RUNGS;
    return [...on, ...RUNGS.filter((k) => !on.includes(k))].map((k) => ({ k, on: on.includes(k) }));
  };

  function paintLadder(desk) {
    const rows = ladderRows(desk);
    const dwell = desk.dwell || {};
    const weights = desk.weights || {};
    const counts = latest.show?.counts || {};
    const sig = JSON.stringify([rows, dwell, weights, counts]);
    const box = $('ladder-rows');
    if (box.dataset.v !== sig && !box.contains(document.activeElement)) {
      box.dataset.v = sig;
      box.innerHTML = rows.map((r, i) => `<div class="lad${r.on ? '' : ' off'}" data-k="${r.k}">
        <input type="checkbox" data-lad="on" ${r.on ? 'checked' : ''} title="Runs on the show">
        <span>${esc(RUNG_LABEL[r.k])}${counts[r.k] ? ` <small>${counts[r.k]}</small>` : ''}</span>
        <input type="number" data-lad="weight" min="0" max="10" value="${Number(weights[r.k] ?? '')}" title="How often it comes up when shuffling: 0 never, 10 a lot">
        <input type="number" data-lad="dwell" min="5" max="600" value="${Number(dwell[r.k]) || ''}" title="Seconds each subject holds">
        <button type="button" data-lad="up" ${i === 0 || !r.on ? 'disabled' : ''} title="Higher on the ladder">↑</button>
      </div>`).join('');
    }
    const kinds = desk.showcaseKinds || ['song', 'video', 'image'];
    for (const el of document.querySelectorAll('[data-kind]')) if (document.activeElement !== el) el.checked = kinds.includes(el.dataset.kind);
  }

  function ladderPatch(change) {
    const rows = ladderRows(latest.desk || {});
    change(rows);
    return rows.filter((r) => r.on).map((r) => r.k);
  }

  // ---------------------------------------------------------------- the stream: Go live / Stop, quality, the encoder

  const STATE_LABEL = { off: 'OFF', starting: 'STARTING', live: 'LIVE', waiting: 'WAITING', retrying: 'RETRYING', down: 'ENCODER DOWN' };
  const hms = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

  function paintAir(air) {
    if (!air) return;
    const enc = air.encoder || {};
    const st = air.on ? enc.state || 'down' : (enc.state === 'down' ? 'down' : 'off');
    const pill = $('air-pill');
    pill.className = `pill ${st}`;
    pill.textContent = air.on && st === 'off' ? 'STARTING' : (STATE_LABEL[st] || st.toUpperCase());
    $('sec-stream').classList.toggle('is-live', air.on);
    const go = $('air-go');
    go.textContent = air.on ? 'Stop stream' : (air.quality?.rehearsal ? 'Start rehearsal' : 'Go live');
    go.classList.toggle('stop', !!air.on);
    $('air-clock').textContent = st === 'live' && enc.since ? hms(Date.now() - enc.since) : '';
    const notes = [];
    if (enc.note) notes.push(enc.note);
    else if (!air.on && st === 'down') notes.push('The encoder service is not running, so Go live will wait for it (it starts with the next Studio deploy, or: sudo systemctl enable --now hawkes-broadcast).');
    if (air.pending) notes.push('Quality changed: the encoder restarts with it in a few seconds.');
    if (air.on && air.by) notes.push(`Started by ${air.by}.`);
    $('air-note').textContent = notes.join(' ');
    const stats = st === 'live' || st === 'starting'
      ? [['fps', enc.fps], ['kbps', enc.kbps], ['dropped', enc.dropped], ['speed', enc.speed != null ? `${enc.speed}x` : null]]
      : [];
    const html = stats.map(([k, v]) => `<div><b>${v ?? '—'}</b>${k}</div>`).join('');
    if ($('air-stats').innerHTML !== html) $('air-stats').innerHTML = html;
    const q = air.quality || {};
    const presets = air.presets || {};
    setSelect($('q-preset'), Object.keys(presets).join('|'), ['<option value="">Custom</option>', ...Object.entries(presets).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`)].join(''), '');
    setSelect($('q-resolution'), 'res', $('q-resolution').innerHTML, q.resolution);
    setSelect($('q-x264'), 'x264', $('q-x264').innerHTML, q.x264);
    setSelect($('q-keyframeSec'), 'kf', $('q-keyframeSec').innerHTML, q.keyframeSec);
    setSelect($('q-audioKbps'), 'ab', $('q-audioKbps').innerHTML, q.audioKbps);
    setText('q-videoKbps', String(q.videoKbps ?? ''));
    setCheck('q-rehearsal', q.rehearsal);
    const e = air.encode || {};
    $('air-qsum').textContent = e.width ? `${e.height}p${e.fps} · ${(e.videoKbps / 1000).toFixed(1)} Mbps · ${e.x264}${e.rehearsal ? ' · rehearsal' : ''}` : '';
  }

  async function postLive(patch) {
    try {
      const r = await fetch('/api/broadcast/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { $('air-note').textContent = body.error || 'Could not change the stream'; return; }
      paintAir(body);
      load();
    } catch (e) {
      $('air-note').textContent = e.message || 'Could not change the stream';
    }
  }

  async function startPlaytest() {
    const product = $('pt-product-pick').value;
    if (!product) return;
    const btn = $('pt-start');
    btn.disabled = true;
    $('pt-started').textContent = 'Starting…';
    try {
      const body = { product, scenario: $('pt-scenario-pick').value.trim() || undefined, device: $('pt-device-pick').value || undefined };
      const r = await fetch('/api/playtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { $('pt-started').textContent = out.error || 'Could not start the playtest'; return; }
      const name = (latest.lineup || []).find((p) => p.id === product)?.name || product;
      $('pt-started').textContent = `Playtest of ${name} started (run ${out.run}). It goes on the ladder when a browser is playing it, usually within a minute or two.`;
      if ($('pt-hold').checked) await post({ screen: 'take', take: '' });
    } catch (e) {
      $('pt-started').textContent = e.message || 'Could not start the playtest';
    } finally {
      btn.disabled = false;
    }
  }

  async function post(patch) {
    if (posting) return;
    posting = true;
    try {
      const r = await fetch('/api/broadcast/desk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { $('desk-now').textContent = body.error || 'Could not save'; return; }
      await load();
    } catch (e) {
      $('desk-now').textContent = e.message || 'Could not save';
    } finally {
      posting = false;
    }
  }

  if (!clean) {
    $('desk').addEventListener('submit', (e) => e.preventDefault());
    $('desk').addEventListener('change', (e) => {
      const t = e.target;
      // The stream's quality.
      if (t.id === 'q-preset') { if (t.value) postLive({ quality: { preset: t.value } }); return; }
      if (t.id?.startsWith('q-')) {
        const k = t.id.slice(2);
        postLive({ quality: { [k]: t.type === 'checkbox' ? t.checked : (t.type === 'number' || k !== 'resolution' && k !== 'x264' ? Number(t.value) : t.value) } });
        return;
      }
      // The ladder.
      const lad = t.closest?.('.lad');
      if (lad && t.dataset.lad === 'on') { post({ ladder: ladderPatch((rows) => { rows.find((r) => r.k === lad.dataset.k).on = t.checked; }) }); return; }
      if (lad && t.dataset.lad === 'dwell') { post({ dwell: { [lad.dataset.k]: Number(t.value) } }); return; }
      if (lad && t.dataset.lad === 'weight') { post({ weights: { [lad.dataset.k]: Number(t.value) } }); return; }
      // The host.
      if (t.dataset.host) { post({ hosts: [...document.querySelectorAll('[data-host]')].filter((el) => el.checked).map((el) => el.dataset.host) }); return; }
      if (t.dataset.moment) { post({ talk: { moments: { [t.dataset.moment]: t.checked } } }); return; }
      if (t.id?.startsWith('talk-')) { post({ talk: { [t.id.slice(5)]: Number(t.value) } }); return; }
      if (t.id === 'desk-host') { post({ host: t.value, next: true }); return; }
      if (t.id === 'desk-rotateMin') { post({ rotateMin: Number(t.value) }); return; }
      if (t.id === 'desk-mix') { post({ mix: t.value }); return; }
      if (t.dataset.kind) {
        const kinds = [...document.querySelectorAll('[data-kind]')].filter((el) => el.checked).map((el) => el.dataset.kind);
        post({ showcaseKinds: kinds });
        return;
      }
      if (t.id?.startsWith('pt-')) return;
      if (t.id === 'desk-variety') post({ variety: Number(t.value) });
      else if (t.id === 'desk-product') post({ product: t.value });
      else if (t.id === 'desk-screen') post(t.value === 'take' ? { screen: 'take', take: $('desk-take').value || '' } : { screen: t.value });
      else if (t.id === 'desk-take') post(t.value ? { screen: 'take', take: t.value } : { screen: 'take', take: '' });
      else if (t.id === 'desk-banner') post({ banner: t.value });
      else if (t.type === 'checkbox') post({ [t.id.replace(/^desk-/, '')]: t.checked });
    });
    $('desk').addEventListener('click', (e) => {
      const id = e.target.id;
      const lad = e.target.closest?.('.lad');
      if (lad && e.target.dataset.lad === 'up') {
        post({ ladder: ladderPatch((rows) => { const i = rows.findIndex((r) => r.k === lad.dataset.k); if (i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; }) });
        return;
      }
      if (id === 'air-go') {
        const on = !!latest.onAir?.on;
        const rehearsal = !!latest.onAir?.quality?.rehearsal;
        if (!on && !confirm(rehearsal ? 'Start a rehearsal stream? Twitch receives it but the channel does not show it.' : 'Go live on Twitch now? The show goes out publicly on the channel.')) return;
        if (on && !confirm('Stop the Twitch stream?')) return;
        postLive({ on: !on });
        return;
      }
      if (id === 'pt-start') { startPlaytest(); return; }
      if (id === 'desk-next') post({ next: true });
      else if (id === 'desk-pause') post({ paused: !latest.desk?.paused });
      else if (id === 'desk-say') post({ cue: $('desk-cue').value, say: true });
      else if (id === 'desk-clear') { $('desk-cue').value = ''; post({ cue: '' }); }
      else if (id === 'desk-reset') post({ reset: true });
    });
  }

  async function load() {
    try {
      const r = await fetch('/api/broadcast');
      if (!r.ok) throw new Error(r.statusText);
      render(await r.json());
    } catch (e) {
      scene('quiet');
      $('caption-text').textContent = 'Reconnecting to the studio…';
    }
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 1000);
})();
