// The show. Polls /api/broadcast and fills the 1920×1080 stage. ?product=yoobaland locks one product.
// Between takes, `reel` plays library videos. A poll must not assign video.src again while one is playing.
// ?clean=1 is the frame the streamer captures: the chips stay as labels and the director bar stays hidden.
// The director (the bar, not on the stream) posts /api/broadcast/desk. Both pages follow that.
// Host voice: when hostAudio is set, play it (mouth flaps while it plays). The streamer also mixes the mp3 into RTMP.
(() => {
  const q = new URLSearchParams(location.search);
  const clean = q.get('clean') === '1';
  let lock = q.get('product') || '';
  let lastFlash = '';
  let lastHost = '';
  let lastAudio = '';
  let reel = [];
  let reelAt = 0;
  let reelKey = '';
  let reelErrors = 0;
  let latest = { desk: null, reel: [], takes: [], lineup: [] };
  let posting = false;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  if (clean) document.body.classList.add('clean');
  else document.body.classList.add('desk');

  function fit() {
    const bar = document.body.classList.contains('desk') ? ($('desk')?.offsetHeight || 0) : 0;
    const z = Math.min(window.innerWidth / 1920, Math.max(1, window.innerHeight - bar) / 1080);
    $('stage').style.transform = `scale(${z})`;
  }
  addEventListener('resize', fit);
  fit();

  function reelHost(item) {
    const line = item && item.label
      ? `Yooba here. The studio is between takes. On screen: ${item.label}.`
      : 'Yooba here. The studio is between takes.';
    return line.slice(0, 160);
  }

  function stopVideo(vid) {
    if (!vid.dataset.src && !vid.getAttribute('src')) return;
    vid.onended = null;
    vid.onerror = null;
    vid.pause();
    vid.removeAttribute('src');
    vid.dataset.src = '';
  }

  function setTalking(on) {
    const mouth = $('host')?.querySelector('.puppet');
    if (!mouth) return;
    mouth.classList.toggle('talk', !!on);
  }

  function say(line) {
    $('host-line').textContent = line;
    lastHost = line || '';
  }

  function playHostAudio(url) {
    const audio = $('host-audio');
    if (!audio) return;
    if (!url) {
      audio.pause();
      audio.removeAttribute('src');
      lastAudio = '';
      setTalking(false);
      return;
    }
    if (url === lastAudio && !audio.paused) return;
    lastAudio = url;
    audio.onplay = () => setTalking(true);
    audio.onended = () => setTalking(false);
    audio.onpause = () => { if (audio.ended || audio.paused) setTalking(false); };
    audio.onerror = () => setTalking(false);
    if (audio.dataset.src !== url) {
      audio.dataset.src = url;
      audio.src = url;
    }
    audio.play().catch(() => setTalking(false));
  }

  function paintReel(item) {
    $('lower-title').textContent = [item.product, item.name].filter(Boolean).join(' · ') || 'Hawkes Studio';
    $('lower-sub').textContent = item.what || '';
    if (!latest.desk?.cue) say(reelHost(item));
  }

  function armVideo(vid) {
    // Library / replay video stays muted on the clean capture (host voice is a separate mix).
    vid.muted = true;
    if (latest.desk?.paused) vid.pause();
  }

  // Assign src only when the clip changes. The 2-second poll must not restart a video that is already playing.
  function playReelAt(i) {
    const vid = $('replay');
    if (!reel.length) return null;
    reelAt = ((i % reel.length) + reel.length) % reel.length;
    const item = reel[reelAt];
    if (!item || !item.src) return null;
    vid.hidden = false;
    $('live').hidden = true;
    $('live').removeAttribute('src');
    $('live').dataset.src = '';
    $('idle').hidden = true;
    if (vid.dataset.src !== item.src) {
      vid.dataset.src = item.src;
      vid.src = item.src;
    } else if (vid.ended && !latest.desk?.paused) {
      vid.currentTime = 0;
    }
    armVideo(vid);
    if (!latest.desk?.paused && vid.paused) vid.play().catch(() => {});
    paintReel(item);
    return item;
  }

  function bindReel(vid) {
    vid.onended = () => { reelErrors = 0; playReelAt(reelAt + 1); };
    vid.onerror = () => {
      reelErrors += 1;
      if (!reel.length || reelErrors >= reel.length) return;
      playReelAt(reelAt + 1);
    };
  }

  // The director is holding the reel: both browsers play the clip the server put first.
  function showDriven(d) {
    const list = d.reel || [];
    const key = list.map((r) => r.asset).join('|');
    if (key !== reelKey) { reelKey = key; reelErrors = 0; }
    reel = list;
    reelAt = 0;
    const vid = $('replay');
    vid.onended = () => {
      if (latest.desk?.paused || latest.desk?.screen !== 'reel') return;
      post({ advance: true, from: latest.desk?.reelAt || 0 });
    };
    vid.onerror = () => {
      reelErrors += 1;
      if (reelErrors >= Math.max(1, reel.length)) return;
      if (latest.desk?.screen === 'reel') post({ advance: true, from: latest.desk?.reelAt || 0 });
    };
    return playReelAt(0);
  }

  function showReel(list) {
    const key = list.map((r) => r.asset).join('|');
    if (key !== reelKey) {
      reelKey = key;
      reelAt = 0;
      reelErrors = 0;
    }
    reel = list;
    const vid = $('replay');
    bindReel(vid);
    return playReelAt(reelAt);
  }

  function showQuiet(f) {
    const idle = $('idle');
    $('live').hidden = true;
    $('replay').hidden = true;
    stopVideo($('replay'));
    idle.hidden = false;
    const kicker = idle.querySelector('.idle-kicker');
    if (f?.phase === 'playing') {
      kicker.textContent = 'On camera';
      $('idle-title').textContent = f.productName;
      $('idle-sub').textContent = f.note || f.step || f.scenario || 'The take is live. Video catches up in a moment.';
    } else if (f?.phase === 'waiting') {
      kicker.textContent = 'Coming up';
      $('idle-title').textContent = f.productName;
      $('idle-sub').textContent = f.scenario || f.step || 'Waiting for a browser.';
    } else if (f) {
      kicker.textContent = 'Between takes';
      $('idle-title').textContent = f.productName;
      $('idle-sub').textContent = `${f.scenario || 'Last take'} · ${f.outcome || f.step || 'wrapped'}`;
    } else {
      kicker.textContent = 'Between takes';
      $('idle-title').textContent = 'The floor is quiet';
      $('idle-sub').textContent = 'Playtests come on the moment they start. Until then, the roadmap keeps moving.';
    }
  }

  function showMedia(d) {
    const f = d.focus;
    const img = $('live');
    const vid = $('replay');
    const idle = $('idle');
    let onReel = null;
    if (f?.phase === 'playing' && f.stream) {
      if (img.dataset.src !== f.stream) { img.dataset.src = f.stream; img.src = f.stream; }
      img.hidden = false;
      vid.hidden = true;
      stopVideo(vid);
      idle.hidden = true;
      reel = [];
      reelKey = '';
    } else if (f?.replay) {
      vid.onended = null;
      vid.onerror = null;
      if (vid.dataset.src !== f.replay) { vid.dataset.src = f.replay; vid.src = f.replay; vid.play().catch(() => {}); }
      vid.hidden = false;
      img.hidden = true;
      img.removeAttribute('src');
      img.dataset.src = '';
      idle.hidden = true;
      reel = [];
      reelKey = '';
      armVideo(vid);
    } else if (latest.desk?.screen === 'reel' && Array.isArray(d.reel) && d.reel.length) {
      onReel = showDriven(d);
    } else if (!f && Array.isArray(d.reel) && d.reel.length) {
      onReel = showReel(d.reel);
    } else {
      reel = [];
      reelKey = '';
      showQuiet(f);
    }
    const pips = $('pips');
    const want = (d.also ?? []).map((t) => t.stream).filter(Boolean).join('|');
    if (pips.dataset.want !== want) {
      pips.dataset.want = want;
      pips.innerHTML = (d.also ?? []).filter((t) => t.stream).map((t) => `<img class="pip" alt="" src="${esc(t.stream)}">`).join('');
    }
    if (!onReel) {
      $('lower-title').textContent = f ? `${f.productName} · ${f.build}` : 'Hawkes Studio';
      $('lower-sub').textContent = f ? [f.scenario, f.note || f.step].filter(Boolean).join(' · ') : '';
    }
    if (latest.desk?.banner) $('lower-title').textContent = latest.desk.banner;
    const replay = $('replay');
    if (!replay.hidden) armVideo(replay);
    return onReel;
  }

  function render(d) {
    latest = { desk: d.desk || null, reel: d.reelAll || d.reel || [], takes: d.takes || [], lineup: d.lineup || [] };
    const shared = d.desk && d.desk.product !== null && d.desk.product !== undefined ? d.desk.product : null;
    const shown = shared !== null ? shared : (lock || d.focus?.product || '');
    const chips = $('chips');
    const ids = (d.products ?? []).map((p) => p.id).join('|');
    if (chips.dataset.ids !== ids + shown) {
      chips.dataset.ids = ids + shown;
      chips.innerHTML = (d.products ?? []).map((p) => `<button type="button" class="chip${p.id === shown ? ' on' : ''}" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('');
      if (!clean) {
        chips.onclick = (e) => {
          const b = e.target.closest('.chip');
          if (!b) return;
          post({ product: shown === b.dataset.id ? null : b.dataset.id });
        };
      }
    }
    document.body.classList.toggle('hide-roadmap', d.desk?.showRoadmap === false);
    document.body.classList.toggle('hide-ticker', d.desk?.showTicker === false);
    document.body.classList.toggle('hide-host', d.desk?.showHost === false);
    document.body.classList.toggle('hide-pips', d.desk?.showPips === false);
    const onReel = showMedia(d);
    $('ms-kicker').textContent = d.milestone ? `Roadmap · ${d.milestone.done} of ${d.milestone.total}` : 'Roadmap';
    $('ms-title').textContent = d.milestone?.title || (d.focus ? d.focus.productName : "What's being made");
    $('bars').innerHTML = (d.bars ?? []).map((b) => `<div class="bar"><b>${esc(b.title)}</b><div class="meta">${esc(b.label)}</div><div class="track"><span style="width:${Math.round((b.pct || 0) * 100)}%"></span></div></div>`).join('')
      || '<div class="meta">No open milestone on this product yet.</div>';
    const line = (d.ticker ?? []).map((t) => t.text).join('    ·    ');
    const tick = $('ticker');
    if (tick.dataset.line !== line) {
      tick.dataset.line = line;
      tick.innerHTML = line ? `<span>${esc(line)}    ·    ${esc(line)}</span>` : '<span>Agents at work show up here as they land.</span>';
    }
    if (d.desk?.cue || !onReel) say(d.host || '');
    if (d.desk?.voice !== false && d.hostAudio) playHostAudio(d.hostAudio);
    else if (d.desk?.voice === false) playHostAudio('');
    $('disclose').textContent = d.disclose || '';
    if (!clean) paintDesk(d, shown);
    const flash = d.desk?.showFlash === false ? null : d.flash;
    if (flash && flash.id !== lastFlash) {
      lastFlash = flash.id;
      const el = $('stinger');
      el.hidden = false;
      el.className = flash.kind === 'BUG' ? 'bug' : '';
      el.textContent = flash.kind;
      clearTimeout(render.flash);
      render.flash = setTimeout(() => { el.hidden = true; }, 4000);
    }
    const t = new Date();
    $('clock').textContent = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setSelect(el, key, html, value) {
    if (!el) return;
    if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = html; }
    if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
  }

  function setCheck(id, on) {
    const el = $(id);
    if (!el || document.activeElement === el) return;
    el.checked = !!on;
  }

  function setText(id, value) {
    const el = $(id);
    if (!el || document.activeElement === el) return;
    if (el.value !== value) el.value = value;
  }

  function paintDesk(d) {
    const desk = d.desk || {};
    const lineup = d.lineup?.length ? d.lineup : (d.products || []);
    const names = Object.fromEntries(lineup.map((p) => [p.id, p.name]));
    const productValue = desk.product === null || desk.product === undefined ? '__url__' : desk.product;
    const productKey = ['__url__', ''].concat(lineup.map((p) => p.id)).join('|');
    setSelect($('desk-product'), productKey, [
      '<option value="__url__">Each page’s link</option>',
      '<option value="">Every product</option>',
      ...lineup.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`),
    ].join(''), productValue);
    const pri = desk.priority?.length ? desk.priority : lineup.map((p) => p.id);
    const priKey = pri.join('|');
    setSelect($('desk-pri-pick'), priKey, pri.map((id, i) => `<option value="${esc(id)}">${i + 1}. ${esc(names[id] || id)}</option>`).join(''), pri[0] || '');
    setSelect($('desk-screen'), 'screen', $('desk-screen').innerHTML, desk.screen || 'auto');
    const takes = d.takes || [];
    setSelect($('desk-take'), takes.map((t) => t.job).join('|'), [
      '<option value="">Current</option>',
      ...takes.map((t) => `<option value="${esc(t.job)}">${esc([t.phase, t.productName, t.scenario].filter(Boolean).join(' · '))}</option>`),
    ].join(''), desk.screen === 'take' ? (desk.take || '') : '');
    const clips = d.reelAll?.length ? d.reelAll : (d.reel || []);
    setSelect($('desk-clip'), clips.map((c) => c.asset).join('|'), [
      '<option value="">In order</option>',
      ...clips.map((c) => `<option value="${esc(c.asset)}">${esc(c.label || c.name || 'clip')}</option>`),
    ].join(''), desk.screen === 'reel' ? (desk.clip || d.reel?.[0]?.asset || '') : (desk.clip || ''));
    setCheck('desk-showRoadmap', desk.showRoadmap !== false);
    setCheck('desk-showTicker', desk.showTicker !== false);
    setCheck('desk-showHost', desk.showHost !== false);
    setCheck('desk-showPips', desk.showPips !== false);
    setCheck('desk-showFlash', desk.showFlash !== false);
    setCheck('desk-voice', desk.voice !== false);
    setText('desk-banner', desk.banner || '');
    setText('desk-cue', desk.cue || '');
    const pause = $('desk-pause');
    if (pause) pause.textContent = desk.paused ? 'Play' : 'Pause';
    const now = $('desk-now');
    if (now) now.textContent = d.status || '';
    fit();
  }

  async function post(patch) {
    if (posting) return;
    posting = true;
    try {
      const r = await fetch('/api/broadcast/desk' + (lock ? `?product=${encodeURIComponent(lock)}` : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const now = $('desk-now');
        if (now) now.textContent = body.error || (r.status === 404 ? 'Studio needs a restart before these controls save.' : 'Could not save');
        return;
      }
      await load();
    } catch (e) {
      const now = $('desk-now');
      if (now) now.textContent = e.message || 'Could not save';
    } finally {
      posting = false;
    }
  }

  if (!clean && $('desk')) {
    $('desk').addEventListener('submit', (e) => e.preventDefault());
    $('desk').addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'desk-product') post({ product: t.value === '__url__' ? null : t.value });
      else if (t.id === 'desk-screen') {
        if (t.value === 'take') {
          const take = $('desk-take').value || latest.takes?.[0]?.job || '';
          post(take ? { screen: 'take', take } : { screen: 'quiet' });
        } else post({ screen: t.value });
      } else if (t.id === 'desk-take') post(t.value ? { screen: 'take', take: t.value } : { screen: 'auto' });
      else if (t.id === 'desk-clip') post(t.value ? { screen: 'reel', clip: t.value } : { screen: 'reel', clip: '' });
      else if (t.id === 'desk-banner') post({ banner: t.value });
      else if (t.id === 'desk-cue') post({ cue: t.value });
      else if (t.type === 'checkbox') post({ [t.id.replace(/^desk-/, '')]: t.checked });
    });
    $('desk').addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'desk-prev') post({ nudge: -1 });
      else if (t.id === 'desk-next') post({ nudge: 1 });
      else if (t.id === 'desk-pause') post({ paused: !latest.desk?.paused });
      else if (t.id === 'desk-say') post({ cue: $('desk-cue').value, say: true });
      else if (t.id === 'desk-clear') { $('desk-cue').value = ''; post({ cue: '' }); }
      else if (t.id === 'desk-reset') post({ reset: true });
      else if (t.id === 'desk-pri-up' || t.id === 'desk-pri-down') {
        const id = $('desk-pri-pick')?.value;
        if (id) post({ movePriority: { id, dir: t.id === 'desk-pri-up' ? -1 : 1 } });
      }
    });
  }

  async function load() {
    const url = '/api/broadcast' + (lock ? `?product=${encodeURIComponent(lock)}` : '');
    try {
      const d = await fetch(url).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
      render(d);
    } catch (e) {
      $('idle').hidden = false;
      $('idle-title').textContent = 'Waiting for Studio';
      $('idle-sub').textContent = e.message || 'the show will come back';
    }
  }
  load();
  setInterval(load, 2000);
})();
