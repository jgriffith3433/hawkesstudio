// The show. Polls /api/broadcast and fills the 1920×1080 stage. ?product=yoobaland locks one product.
// ?clean=1 is the frame the streamer captures: the chips stay as labels and don't switch the show.
(() => {
  const q = new URLSearchParams(location.search);
  const clean = q.get('clean') === '1';
  let lock = q.get('product') || '';
  let lastFlash = '';
  let lastHost = '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  if (clean) document.body.classList.add('clean');

  function fit() {
    const z = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    $('stage').style.transform = `scale(${z})`;
  }
  addEventListener('resize', fit);
  fit();

  function showMedia(d) {
    const f = d.focus;
    const img = $('live');
    const vid = $('replay');
    const idle = $('idle');
    if (f?.phase === 'playing' && f.stream) {
      if (img.dataset.src !== f.stream) { img.dataset.src = f.stream; img.src = f.stream; }
      img.hidden = false;
      vid.hidden = true;
      vid.removeAttribute('src');
      idle.hidden = true;
    } else if (f?.replay) {
      if (vid.dataset.src !== f.replay) { vid.dataset.src = f.replay; vid.src = f.replay; vid.play().catch(() => {}); }
      vid.hidden = false;
      img.hidden = true;
      img.removeAttribute('src');
      idle.hidden = true;
    } else {
      img.hidden = true;
      vid.hidden = true;
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
    const pips = $('pips');
    const want = (d.also ?? []).map((t) => t.stream).filter(Boolean).join('|');
    if (pips.dataset.want !== want) {
      pips.dataset.want = want;
      pips.innerHTML = (d.also ?? []).filter((t) => t.stream).map((t) => `<img class="pip" alt="" src="${esc(t.stream)}">`).join('');
    }
    $('lower-title').textContent = f ? `${f.productName} · ${f.build}` : 'Hawkes Studio';
    $('lower-sub').textContent = f ? [f.scenario, f.note || f.step].filter(Boolean).join(' · ') : '';
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
    showMedia(d);
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
    $('host-line').textContent = d.host || '';
    if (d.host && d.host !== lastHost) {
      lastHost = d.host;
      $('host').querySelector('.puppet').classList.add('talk');
      clearTimeout(render.talk);
      render.talk = setTimeout(() => $('host').querySelector('.puppet').classList.remove('talk'), 4000);
    }
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
