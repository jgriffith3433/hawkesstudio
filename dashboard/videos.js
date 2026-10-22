// The Screening tab (#videos, #videos/<task>): J's videos (src/videos.ts). Start one from a script; watch each version;
// leave notes at the moment they're about (they go straight back to the agent as a revision); approve the one he likes
// (and send drafts to YouTube and TikTok). Uses app.js's helpers ($, esc, api, ago).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .vd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
    .vd-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; cursor: pointer; display: flex; flex-direction: column; }
    .vd-card:hover { border-color: var(--accent); }
    .vd-thumb { aspect-ratio: 16 / 10; background: var(--panel2); display: grid; place-items: center; color: var(--dim); font-size: 13px; }
    .vd-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .vd-card .b { padding: 10px 12px; display: grid; gap: 4px; }
    .vd-state { font-size: 12px; }
    .vd-state.ready { color: var(--accent); font-weight: 600; }
    .vd-state.failed { color: var(--red); }
    .vd-main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; align-items: start; }
    @media (max-width: 900px) { .vd-main { grid-template-columns: 1fr; } }
    .vd-player { background: #000; border-radius: var(--radius); overflow: hidden; display: grid; place-items: center; max-height: 72vh; }
    .vd-player video { max-width: 100%; max-height: 72vh; display: block; }
    .vd-versions { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
    .vd-versions button.on { border-color: var(--accent); color: var(--accent); }
    .vd-side { display: grid; gap: 12px; }
    .vd-notes { display: grid; gap: 8px; max-height: 46vh; overflow: auto; }
    .vd-note { background: var(--panel2); border-radius: 7px; padding: 8px 10px; font-size: 13px; white-space: pre-wrap; }
    .vd-note .who { color: var(--dim); font-size: 11px; margin-bottom: 2px; }
    .vd-form { display: grid; gap: 8px; max-width: 760px; }
    .vd-form textarea { min-height: 220px; font-family: inherit; }
    .vd-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  `;
  document.head.appendChild(css);

  const READY = new Set(['ready to screen']);
  const file = (a) => (a ? `/api/gen/v1/files/${a}` : '');
  let current = null; // the open video's task id
  let shown = null;   // the version number playing
  let timer = null;

  function card(v) {
    const poster = v.latest?.poster ? `<img src="${file(v.latest.poster)}" alt="">` : v.latest ? '▶ video' : esc(v.state);
    return `<div class="vd-card" data-open="${v.id}">
      <div class="vd-thumb">${poster}</div>
      <div class="b"><b>${esc(v.title.replace(/^Video:\s*/, ''))}</b>
        <span class="vd-state ${READY.has(v.state) ? 'ready' : v.state === 'failed' ? 'failed' : ''}">${esc(v.state)}${v.versions ? ` · v${v.versions}` : ''}</span>
        <small class="dim">${esc(v.product)} · ${esc(ago(v.created))}</small></div>
    </div>`;
  }

  async function list() {
    const el = $('#vdBody');
    const [{ videos }, { products }] = await Promise.all([api('/api/videos'), api('/api/products')]);
    const ready = videos.filter((v) => READY.has(v.state));
    el.innerHTML = `
      <div class="vd-row" style="margin-bottom:14px"><button id="vdNewBtn" class="primary">New video</button>
        <span class="dim">${ready.length ? `${ready.length} ready to screen` : 'Nothing waiting for you.'}</span></div>
      <form id="vdNew" class="vd-form card" hidden style="max-width:none;margin-bottom:16px">
        <h3>New video</h3>
        <div class="vd-row">
          <select id="vdProduct">${products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
          <select id="vdFormat"><option value="short">Short · 9:16</option><option value="wide">Wide · 16:9</option></select>
          <select id="vdBudget" title="GPU: the director can use Blender, the video models and lip-sync (priced; under $5 approves itself, else you get a card). No GPU: only what the library has, voices and compositing"><option value="gpu">GPU allowed (priced)</option><option value="none">No GPU</option></select>
          <input id="vdTitle" placeholder="Title" required style="flex:1;min-width:200px">
        </div>
        <textarea id="vdScript" required placeholder="The script. Who says what, and what happens. For example:\n\nEXIT PUNK: (skating in) Nobody booked me. I booked me.\nSUSAN: (not looking up) You're on in thirty seconds.\nEXIT PUNK: Thirty? I need thirty-one.\n(He wipes out. The crowd roars anyway.)"></textarea>
        <input id="vdDirection" placeholder="Direction (optional): tone, music, look, voices">
        <div class="vd-row"><button type="submit" class="primary">Start it</button><button type="button" id="vdCancel">Cancel</button></div>
      </form>
      <div class="vd-grid">${videos.map(card).join('') || '<p class="dim">No videos yet. Write a script to start one.</p>'}</div>`;
    const sel = $('#vdProduct');
    try { const last = localStorage.getItem('vd.product'); if (last) sel.value = last; } catch {}
  }

  async function detail(id) {
    const el = $('#vdBody');
    const d = await api(`/api/videos/${id}`);
    const vs = d.versions;
    if (shown == null || !vs.some((v) => v.n === shown)) shown = vs.at(-1)?.n ?? null;
    const v = vs.find((x) => x.n === shown);
    const canNote = d.task.status !== 'verified' && d.task.status !== 'dropped';
    const canApprove = d.state === 'ready to screen' && v && v.n === vs.at(-1).n;
    el.innerHTML = `
      <div class="vd-row" style="margin-bottom:12px"><button id="vdBack">← All videos</button>
        <h3 style="margin:0">${esc(d.task.title.replace(/^Video:\s*/, ''))}</h3><span class="pill">${esc(d.state)}</span><small class="dim">${esc(d.task.product)}</small></div>
      <div class="vd-main">
        <div>
          <div class="vd-player">${v ? `<video id="vdVideo" src="${file(v.asset)}" ${v.poster ? `poster="${file(v.poster)}"` : ''} controls playsinline preload="metadata"></video>` : `<p class="dim" style="padding:60px 20px;color:#bbb">${esc(d.change?.detail ?? 'Not started yet: the PM starts it when an agent is free.')}</p>`}</div>
          <div class="vd-versions">${vs.map((x) => `<button class="small${x.n === shown ? ' on' : ''}" data-version="${x.n}">v${x.n}</button>`).join('')}</div>
          ${v?.summary ? `<div class="status-line">v${v.n}: ${esc(v.summary)}</div>` : ''}
          ${v?.caption ? `<details class="more-details"><summary>Post caption</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(v.caption)}</pre></details>` : ''}
          ${d.change ? `<details class="more-details"><summary>What the agent is doing</summary><div class="dim" style="font-size:12px">${esc(d.change.status)} · ${esc(d.change.detail ?? '')}</div><pre style="white-space:pre-wrap;font-size:11px">${esc((d.change.log ?? []).join('\n'))}</pre></details>` : ''}
        </div>
        <div class="vd-side">
          ${canNote ? `<form id="vdNoteForm" class="card" style="max-width:none">
            <b>Notes</b>
            <textarea id="vdNote" rows="4" placeholder="${v ? 'What should change? It is stamped with where the video is paused.' : 'Notes for the agent while it works'}"></textarea>
            <div class="vd-row"><button type="submit" class="primary">Send note</button><small class="dim" id="vdAt"></small></div>
          </form>` : ''}
          ${canApprove ? `<div class="card" style="max-width:none"><b>Happy with v${v.n}?</b>
            <label class="vd-row"><input type="checkbox" id="vdPost" checked> Also send drafts to YouTube and TikTok</label>
            <button id="vdApprove" class="primary">Approve v${v.n}</button></div>` : ''}
          <div class="vd-notes">${d.notes.slice().reverse().map((n) => `<div class="vd-note"><div class="who">${esc(n.by)} · ${esc(n.kind)} · ${esc(ago(n.at))}</div>${esc(n.text)}</div>`).join('')}</div>
        </div>
      </div>`;
    const video = $('#vdVideo');
    if (video) video.addEventListener('timeupdate', () => { const at = $('#vdAt'); if (at) at.textContent = video.currentTime > 0.5 ? `at ${Math.floor(video.currentTime / 60)}:${String(Math.floor(video.currentTime % 60)).padStart(2, '0')} of v${shown}` : ''; });
  }

  async function load() {
    if (!$('#vdBody')) return;
    const hash = location.hash.split('/');
    current = hash[0] === '#videos' && /^k_[0-9a-f]+$/.test(hash[1] ?? '') ? hash[1] : null;
    try { current ? await detail(current) : await list(); } catch (e) { $('#vdBody').innerHTML = `<p class="red">${esc(e.message)}</p>`; }
    clearInterval(timer);
    // While it's on screen: what the agent is doing moves (making, rendering, a new version), so look again every 20 s.
    timer = setInterval(() => {
      if (document.hidden || !$('#videos')?.classList.contains('on')) return;
      const typing = document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName);
      const playing = $('#vdVideo') && !$('#vdVideo').paused;
      if (!typing && !playing) void (current ? detail(current) : list()).catch(() => {});
    }, 20_000);
  }
  const open = (id) => { shown = null; location.hash = id ? `#videos/${id}` : '#videos'; void load(); };

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-open],[data-version],#vdBack,#vdNewBtn,#vdCancel,#vdApprove');
    if (!t || !$('#videos')?.contains(t)) return;
    if (t.dataset.open) return open(t.dataset.open);
    if (t.dataset.version) { shown = Number(t.dataset.version); return detail(current); }
    if (t.id === 'vdBack') return open(null);
    if (t.id === 'vdNewBtn') { $('#vdNew').hidden = false; $('#vdTitle').focus(); return; }
    if (t.id === 'vdCancel') { $('#vdNew').hidden = true; return; }
    if (t.id === 'vdApprove') {
      t.disabled = true;
      try { await api(`/api/videos/${current}/approve`, { method: 'POST', body: { post: $('#vdPost')?.checked } }); await detail(current); } catch (x) { alert(x.message); t.disabled = false; }
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'vdNew') {
      e.preventDefault();
      try { localStorage.setItem('vd.product', $('#vdProduct').value); } catch {}
      const b = { product: $('#vdProduct').value, format: $('#vdFormat').value, budget: $('#vdBudget').value, title: $('#vdTitle').value, script: $('#vdScript').value, direction: $('#vdDirection').value };
      try { const d = await api('/api/videos', { method: 'POST', body: b }); open(d.task.id); } catch (x) { alert(x.message); }
    }
    if (e.target.id === 'vdNoteForm') {
      e.preventDefault();
      const video = $('#vdVideo');
      const text = $('#vdNote').value.trim();
      if (!text) return;
      try {
        await api(`/api/videos/${current}/notes`, { method: 'POST', body: { text, version: shown, at: video && video.currentTime > 0.5 ? video.currentTime : null } });
        await detail(current);
      } catch (x) { alert(x.message); }
    }
  });
  window.loadVideosTab = load;
})();
