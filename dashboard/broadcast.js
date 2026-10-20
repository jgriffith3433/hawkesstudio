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
  const KIND_LABEL = { playtest: 'LIVE PLAYTEST', work: 'IN THE WORKSHOP', roadmap: 'ON THE ROADMAP', showcase: 'FROM THE STUDIO', quiet: 'HAWKES STUDIO' };
  const KIND_COLOR = { playtest: 'var(--live)', work: 'var(--work)', roadmap: 'var(--road)', showcase: 'var(--show)', quiet: 'var(--mint)' };
  let latest = {};
  let segId = '';
  let lineId = '';
  let posting = false;

  document.body.classList.add(clean ? 'clean' : 'desk');

  function fit() {
    const bar = clean ? 0 : ($('desk')?.offsetHeight || 0);
    const z = Math.min(window.innerWidth / 1920, Math.max(1, window.innerHeight - bar) / 1080);
    $('stage').style.transform = `scale(${z})`;
  }
  addEventListener('resize', fit);
  fit();

  // Equalizer bars for songs: CSS animates them; each gets its own speed.
  $('sh-eq').innerHTML = Array.from({ length: 28 }, (_, i) => `<i style="animation-duration:${(0.35 + ((i * 37) % 60) / 100).toFixed(2)}s;animation-delay:-${(i * 0.13).toFixed(2)}s"></i>`).join('');

  const setSrc = (el, src) => { if ((el.dataset.src || '') !== (src || '')) { el.dataset.src = src || ''; if (src) el.src = src; else el.removeAttribute('src'); } };
  const bg = (el, url) => { const v = url ? `url("${url}")` : 'none'; if (el.style.backgroundImage !== v) el.style.backgroundImage = v; };

  function scene(kind) {
    for (const k of ['playtest', 'work', 'roadmap', 'showcase', 'quiet']) $(`sc-${k}`).classList.toggle('on', k === kind);
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
    const html = (c.items || []).map((i, n) => `<div class="rm-item" style="animation-delay:${n * 0.12}s"><b>${esc(i.title)}</b><span class="st">${esc(i.state)}</span><div class="track"><span style="width:${Math.round((i.pct || 0) * 100)}%"></span></div></div>`).join('');
    if ($('rm-items').dataset.v !== html) { $('rm-items').dataset.v = html; $('rm-items').innerHTML = html; }
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
    const landed = s.kind === 'playtest' ? (s.card?.landed || []) : [];
    const items = landed.length ? landed.map((l) => ({ t: l.title, s: l.ago })) : (d.ticker || []).slice(0, 4).map((t) => ({ t: t.text, s: '' }));
    $('landed-k').textContent = landed.length ? `Just landed in ${s.card.productName}` : 'On the floor';
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
    const s = d.show || {};
    const u = s.usage || {};
    $('desk-now').textContent = [
      s.error ? `Show error: ${s.error}` : `On now: ${KIND_LABEL[s.kind] || '—'}${s.card ? ` · ${s.card.productName || ''} ${s.card.title || s.card.scenario || ''}` : ''}`,
      `lines by ${s.by || '—'}`,
      `next in ${Math.round((s.remaining || 0) / 1000)}s`,
      u.budget ? `today: ${u.brainCalls}/${u.budget.brainCalls} lines written, ${u.voiceChars}/${u.budget.voiceChars} characters spoken` : '',
    ].filter(Boolean).join('   ·   ');
    fit();
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
      if (t.id === 'desk-product') post({ product: t.value });
      else if (t.id === 'desk-screen') post(t.value === 'take' ? { screen: 'take', take: $('desk-take').value || '' } : { screen: t.value });
      else if (t.id === 'desk-take') post(t.value ? { screen: 'take', take: t.value } : { screen: 'take', take: '' });
      else if (t.id === 'desk-banner') post({ banner: t.value });
      else if (t.type === 'checkbox') post({ [t.id.replace(/^desk-/, '')]: t.checked });
    });
    $('desk').addEventListener('click', (e) => {
      const id = e.target.id;
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
  setInterval(load, 1000);
})();
