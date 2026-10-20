// The show. Polls /api/broadcast and fills the 1920×1080 stage. ?product=yoobaland locks one product.
// Between takes, `reel` plays library videos. A poll must not assign video.src again while one is playing.
// ?clean=1 is the frame the streamer captures: the chips stay as labels and don't switch the show.
(() => {
  const q = new URLSearchParams(location.search);
  const clean = q.get('clean') === '1';
  let lock = q.get('product') || '';
  let lastFlash = '';
  let lastHost = '';
  let reel = [];
  let reelAt = 0;
  let reelKey = '';
  let reelErrors = 0;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  if (clean) document.body.classList.add('clean');

  function fit() {
    const z = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
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

  function say(line) {
    $('host-line').textContent = line;
    if (line && line !== lastHost) {
      lastHost = line;
      $('host').querySelector('.puppet').classList.add('talk');
      clearTimeout(say.talk);
      say.talk = setTimeout(() => $('host').querySelector('.puppet').classList.remove('talk'), 4000);
    }
  }

  function paintReel(item) {
    $('lower-title').textContent = [item.product, item.name].filter(Boolean).join(' · ') || 'Hawkes Studio';
    $('lower-sub').textContent = item.what || '';
    say(reelHost(item));
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
      vid.play().catch(() => {});
    } else if (vid.ended) {
      vid.currentTime = 0;
      vid.play().catch(() => {});
    } else if (vid.paused) {
      vid.play().catch(() => {});
    }
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
    return onReel;
  }

  function render(d) {
    const chips = $('chips');
    const ids = (d.products ?? []).map((p) => p.id).join('|');
    if (chips.dataset.ids !== ids + lock) {
      chips.dataset.ids = ids + lock;
      chips.innerHTML = (d.products ?? []).map((p) => `<button type="button" class="chip${p.id === (lock || d.focus?.product) ? ' on' : ''}" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('');
      if (!clean) {
        chips.onclick = (e) => {
          const b = e.target.closest('.chip');
          if (!b) return;
          lock = lock === b.dataset.id ? '' : b.dataset.id;
          load();
        };
      }
    }
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
    if (!onReel) say(d.host || '');
    $('disclose').textContent = d.disclose || '';
    const flash = d.flash;
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
