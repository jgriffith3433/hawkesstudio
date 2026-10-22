// The Screening tab (#videos, #videos/<task>): J's videos (src/videos.ts). Start one from a script with his controls;
// watch each version; select a moment or a range on the timeline (the cut's shots), say what he wants there (shorter,
// redo, fix the lip sync, closer, ...) and keep notes until he sends them together; make plain edits himself in seconds
// (cut a range out, speed it up, zoom in where he clicks); approve the animatic with guidance for the final, or approve
// the final (and send drafts to YouTube and TikTok). Uses app.js's helpers ($, esc, api, ago).
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
    .vd-main { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 18px; align-items: start; }
    @media (max-width: 900px) { .vd-main { grid-template-columns: 1fr; } }
    .vd-player { position: relative; background: #000; border-radius: var(--radius); overflow: hidden; display: grid; place-items: center; max-height: 64vh; }
    .vd-player video { max-width: 100%; max-height: 64vh; display: block; }
    .vd-aim { position: absolute; inset: 0; cursor: crosshair; display: none; }
    .vd-aim.on { display: block; background: rgba(0,0,0,.08); }
    .vd-aim i { position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 2px solid var(--accent); border-radius: 50%; box-shadow: 0 0 0 2px rgba(0,0,0,.5); }
    .vd-tl { position: relative; height: 64px; margin-top: 10px; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; user-select: none; cursor: text; touch-action: none; }
    .vd-tl { height: 84px; }
    .vd-shot { position: absolute; top: 0; bottom: 22px; border-right: 2px solid var(--bg); overflow: hidden; background: color-mix(in srgb, var(--accent) 14%, var(--panel2)) center / cover no-repeat; }
    .vd-shot:nth-child(even) { background-color: color-mix(in srgb, var(--accent) 24%, var(--panel2)); }
    .vd-shot span { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 4px 2px; font-size: 10px; line-height: 1.2; color: #fff; text-shadow: 0 1px 2px #000; background: linear-gradient(transparent, rgba(0,0,0,.75)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .vd-marks { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; border-top: 1px solid var(--line); }
    .vd-mark { position: absolute; bottom: 4px; height: 12px; min-width: 4px; border-radius: 3px; background: var(--dim); opacity: .8; }
    .vd-mark.draft { background: #e0a030; }
    .vd-mark.quick { background: #4caf7a; }
    .vd-sel { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--accent) 30%, transparent); border-left: 2px solid var(--accent); border-right: 2px solid var(--accent); pointer-events: none; }
    .vd-head { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 2px #000; pointer-events: none; }
    .vd-tlinfo { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--dim); margin-top: 6px; min-height: 26px; }
    .vd-versions { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
    .vd-versions button.on { border-color: var(--accent); color: var(--accent); }
    .vd-side { display: grid; gap: 12px; }
    .vd-chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .vd-chips button { font-size: 12px; padding: 3px 8px; border-radius: 999px; }
    .vd-chips button.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .vd-notes { display: grid; gap: 8px; max-height: 40vh; overflow: auto; }
    .vd-note { background: var(--panel2); border-radius: 7px; padding: 8px 10px; font-size: 13px; white-space: pre-wrap; }
    .vd-note .who { color: var(--dim); font-size: 11px; margin-bottom: 2px; }
    .vd-note.draft { border-left: 3px solid #e0a030; cursor: pointer; }
    .vd-form { display: grid; gap: 8px; max-width: 760px; }
    .vd-form[hidden] { display: none; }
    .vd-form textarea { min-height: 200px; font-family: inherit; }
    .vd-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .vd-ctl { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
    .vd-ctl label { display: grid; gap: 3px; font-size: 12px; color: var(--dim); }
  `;
  document.head.appendChild(css);

  const READY = new Set(['ready to screen', 'animatic ready']);
  const ASKS = { shorter: 'Shorter', longer: 'Longer', redo: 'Redo', lipsync: 'Fix lip sync', closer: 'Closer', wider: 'Wider', angle: 'New angle', reaction: 'Add reaction', camera: 'Move camera', expression: 'More expression', voice: 'Voice', look: 'Fix look', action: 'Action / VFX', sound: 'Sound', caption: 'Captions', cut: 'Cut it' };
  const file = (a) => (a ? `/api/gen/v1/files/${a}` : '');
  const ts = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  let current = null; // the open video's task id
  let shown = null;   // the version number playing
  let timer = null;
  let data = null;    // the open video's detail
  // The selection on the timeline (seconds), what J asks for there, and where he aimed a zoom (0-1 of the frame).
  let sel = null, ask = null, aim = null, aiming = false;

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
          <input id="vdTitle" placeholder="Title" required style="flex:1;min-width:200px">
        </div>
        <textarea id="vdScript" required placeholder="The script. Who says what, and what happens. For example:\n\nEXIT PUNK: (skating in) Nobody booked me. I booked me.\nSUSAN: (not looking up) You're on in thirty seconds.\nEXIT PUNK: Thirty? I need thirty-one.\n(He wipes out. The crowd roars anyway.)"></textarea>
        <input id="vdDirection" placeholder="Direction (optional): tone, pacing, what the video is for">
        <details class="more-details"><summary>Controls (optional: whatever you leave open, the director decides)</summary>
          <div class="vd-ctl">
            <label>Length (seconds)<input id="vdSeconds" type="number" min="5" max="300" placeholder="e.g. 30"></label>
            <label>Method<select id="vdEngine"><option value="auto">Director's choice</option><option value="scene">Whole scenes (our GPUs)</option><option value="seedance">Seedance 2.5 (paid)</option><option value="kling">Kling O3 (paid, its own voices)</option><option value="shots">Shot by shot (Blender + ComfyUI)</option></select></label>
            <label>Quality<select id="vdQuality"><option value="">Director's choice</option><option value="draft">Draft (fast, cheap)</option><option value="standard">Standard</option><option value="high">High (best of 2 takes)</option></select></label>
            <label>Look<input id="vdStyle" placeholder="e.g. Pixar-like 3D, warm light"></label>
            <label>Voices<input id="vdVoices" placeholder="e.g. Mechanic: tired, gravelly"></label>
            <label>Music<input id="vdMusic" placeholder="e.g. lo-fi drums under, kicks in at the ride"></label>
          </div>
          <div class="vd-row" style="margin-top:8px">
            <label class="vd-row" style="font-size:13px"><input type="checkbox" id="vdAnimatic" checked> Rough draft (animatic) first</label>
            <label class="vd-row" style="font-size:13px"><input type="checkbox" id="vdCaptions" checked> Captions</label>
            <label class="vd-row" style="font-size:13px"><input type="checkbox" id="vdEndCard" checked> End card</label>
          </div>
        </details>
        <div class="vd-row"><button type="submit" class="primary">Start it</button><button type="button" id="vdCancel">Cancel</button></div>
      </form>
      <div class="vd-grid">${videos.map(card).join('') || '<p class="dim">No videos yet. Write a script to start one.</p>'}</div>`;
    const prod = $('#vdProduct');
    try { const last = localStorage.getItem('vd.product'); if (last) prod.value = last; } catch {}
  }

  /** The version's shots: its edit's clips, else its beat sheet's beats. */
  function shotsOf(v) {
    if (v?.shots?.length) return v.shots.map((s) => ({ start: s.start, end: s.end, label: s.label || (s.beat != null ? String(s.beat) : `clip ${s.i}`) }));
    return (v?.beats ?? []).filter((b) => Number.isFinite(Number(b.t))).map((b) => ({ start: Number(b.t), end: Number(b.t) + Number(b.seconds || 0), label: [b.shot, b.line ? `“${b.line}”` : b.action].filter(Boolean).join(' ') }));
  }

  function timelineHtml(v, dur) {
    if (!v || !dur) return '';
    const pc = (s) => `${Math.max(0, Math.min(100, (s / dur) * 100))}%`;
    const marks = (data.marks ?? []).filter((m) => m.version === v.n && m.from_s != null);
    return `<div class="vd-tl" id="vdTl" title="Drag to select a range, click for a moment">
        ${shotsOf(v).map((s, i) => `<div class="vd-shot" data-shot="${i}" style="left:${pc(s.start)};width:${pc(s.end - s.start)};${thumbs.get(`${v.asset}:${i}`) ? `background-image:url(${thumbs.get(`${v.asset}:${i}`)})` : ''}" title="${esc(`${ts(s.start)}-${ts(s.end)} ${s.label}`)}">${(s.end - s.start) / dur > 0.07 ? `<span>${esc(s.label)}</span>` : ''}</div>`).join('')}
        <div class="vd-marks">${marks.map((m) => `<div class="vd-mark ${m.status === 'draft' ? 'draft' : String(m.action ?? '').startsWith('quick') ? 'quick' : ''}" style="left:${pc(m.from_s)};width:${m.to_s ? pc(m.to_s - m.from_s) : '4px'}" title="${esc(`${m.status}: ${m.action ? ASKS[m.action] ?? m.action : ''} ${m.text}`.slice(0, 200))}"></div>`).join('')}</div>
        ${sel ? `<div class="vd-sel" style="left:${pc(sel.from)};width:${sel.to > sel.from ? pc(sel.to - sel.from) : '0'}"></div>` : ''}
        <div class="vd-head" id="vdHead" style="left:0"></div>
      </div>
      <div class="vd-tlinfo">${sel
        ? `<b style="color:var(--fg)">${sel.to > sel.from + 0.05 ? `${ts(sel.from)} – ${ts(sel.to)} (${(sel.to - sel.from).toFixed(1)} s)` : `at ${ts(sel.from)}`}</b>
           ${sel.to > sel.from + 0.05 ? '<button class="small" id="vdPlaySel">▶ Play selection</button>' : ''}<button class="small" id="vdClearSel">Clear</button>`
        : 'Drag across the timeline to select a part (or click a moment), then say what you want there.'}</div>`;
  }

  function sideHtml(d, v) {
    const vs = d.versions;
    const latest = v && v.n === vs.at(-1)?.n;
    const canNote = d.task.status !== 'verified' && d.task.status !== 'dropped';
    const waiting = READY.has(d.state) && latest;
    const anim = v?.stage === 'animatic';
    const drafts = (d.marks ?? []).filter((m) => m.status === 'draft');
    const redoing = (d.redos ?? []).some((r) => r.status === 'running');
    const canQuick = waiting && v?.edit && sel && sel.to > sel.from + 0.05 && !redoing;
    return `
      ${canNote ? `<form id="vdNoteForm" class="card" style="max-width:none;display:grid;gap:8px">
        <b>${sel ? 'Notes on the selection' : 'Notes'}</b>
        <div class="vd-chips">${Object.entries(ASKS).map(([k, l]) => `<button type="button" data-ask="${k}" class="${ask === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
        <textarea id="vdNote" rows="3" placeholder="${sel ? 'What should change here? (optional with a chip)' : 'What should change? Select a part of the timeline to point at it.'}"></textarea>
        <div class="vd-row"><button type="submit" class="primary" id="vdAdd">Add note</button>
          ${drafts.length ? `<button type="button" id="vdSendAll">Send ${drafts.length} note${drafts.length > 1 ? 's' : ''} to the agent</button>` : ''}</div>
        <small class="dim">Notes wait here until you send them together, so the agent starts once with all of them.${anim && waiting ? ' Or approve the animatic below: they go with the go-ahead.' : ''}</small>
      </form>` : ''}
      ${waiting && v?.edit ? `<div class="card" style="max-width:none;display:grid;gap:8px"><b>Quick edits (no agent, about a minute)</b>
        ${canQuick ? `<div class="vd-row">
          <button class="small" data-quick="remove">✂ Cut it out</button>
          <button class="small" data-quick="speed">⏩ Speed up 1.5×</button>
          <button class="small" data-quick="zoom">🔍 Punch in</button>
          <button class="small" data-quick="push">🎥 Push in</button></div>
          <small class="dim">${aim ? `Zoom aimed at ${Math.round(aim.x * 100)}%, ${Math.round(aim.y * 100)}%.` : 'Zooms aim at the centre:'} <a href="#" id="vdAimBtn">${aiming ? 'click the picture…' : 'aim it'}</a></small>`
        : '<small class="dim">Select a range on the timeline to cut it out, speed it up or zoom in.</small>'}
        <small class="dim" id="vdQuickMsg"></small></div>` : ''}
      ${waiting && v?.edit && !redoing ? `<div class="card" style="max-width:none;display:grid;gap:8px"><b>Redo a scene (no agent, uses the GPU)</b>
        ${sel ? `<button class="small" id="vdRedo">🎲 New take of the scene${sel.to > sel.from + 0.05 ? 's' : ''} here</button>
          <small class="dim">Re-generates the scene${sel.to > sel.from + 0.05 ? 's' : ''} under the selection with a new seed (what you typed in the note box goes into the prompt), then re-cuts. About as long as the scene took the first time; it goes ahead of other GPU work.</small>`
        : '<small class="dim">Select a moment or a range on the timeline to re-generate the scene there.</small>'}
        <small class="dim" id="vdRedoMsg"></small></div>` : ''}
      ${(d.redos ?? []).filter((r) => r.status !== 'done' || Date.now() - r.done_at < 600_000).slice(-2).map((r) => `<div class="status-line">${r.status === 'running' ? '⏳' : r.status === 'failed' ? '⚠' : '✓'} Redo of v${r.version} ${r.from_s != null ? (r.to_s ? `${ts(r.from_s)}–${ts(r.to_s)}` : `at ${ts(r.from_s)}`) : ''}: ${esc(r.status === 'running' ? `rendering (${r.plan.map((p) => p.steps.map((s) => `${s.tool}${s.out ? ' ✓' : s.newJob ? ' …' : ''}`).join(' → ')).join('; ')}), started ${ago(r.at)}` : r.status === 'failed' ? r.error ?? 'failed' : `done: v${r.result}`)}</div>`).join('')}
      ${waiting ? (anim ? `<div class="card" style="max-width:none;display:grid;gap:8px"><b>Go ahead with the final?</b>
          <div class="dim" style="font-size:13px">This is the rough draft: the real voices, the art and the staging, timed. Approving it has the agent make the final from it${drafts.length ? `, with your ${drafts.length} note${drafts.length > 1 ? 's' : ''}` : ''}.</div>
          <textarea id="vdGuidance" rows="2" placeholder="Guidance for the final (optional): e.g. more expression on Exit Punk, warmer light, faster ending"></textarea>
          <button id="vdApprove" class="primary">Approve and make the final</button></div>`
        : `<div class="card" style="max-width:none;display:grid;gap:8px"><b>Happy with v${v.n}?</b>
          <label class="vd-row"><input type="checkbox" id="vdPost" checked> Also send drafts to YouTube and TikTok</label>
          <button id="vdApprove" class="primary">Approve v${v.n}</button></div>`) : ''}
      <div class="vd-notes">
        ${drafts.slice().reverse().map((m) => `<div class="vd-note draft" data-seek="${m.from_s ?? ''}"><div class="who">Draft · v${m.version ?? '?'}${m.from_s != null ? ` · ${m.to_s ? `${ts(m.from_s)}–${ts(m.to_s)}` : ts(m.from_s)}` : ''} <a href="#" data-drop="${m.id}" style="float:right">remove</a></div>${m.action ? `<b>${esc(ASKS[m.action] ?? m.action)}</b> ` : ''}${esc(m.text)}</div>`).join('')}
        ${d.notes.slice().reverse().map((n) => `<div class="vd-note"><div class="who">${esc(n.by)} · ${esc(n.kind)} · ${esc(ago(n.at))}</div>${esc(n.text)}</div>`).join('')}
      </div>`;
  }

  async function detail(id, fetch = true) {
    const el = $('#vdBody');
    if (fetch || !data || data.task.id !== id) data = await api(`/api/videos/${id}`);
    const d = data;
    const vs = d.versions;
    if (shown == null || !vs.some((v) => v.n === shown)) shown = vs.at(-1)?.n ?? null;
    const v = vs.find((x) => x.n === shown);
    const keepTime = $('#vdVideo')?.currentTime ?? 0;
    el.innerHTML = `
      <div class="vd-row" style="margin-bottom:12px"><button id="vdBack">← All videos</button>
        <h3 style="margin:0">${esc(d.task.title.replace(/^Video:\s*/, ''))}</h3><span class="pill">${esc(d.state)}</span><small class="dim">${esc(d.task.product)}</small></div>
      <div class="vd-main">
        <div>
          <div class="vd-player">${v ? `<video id="vdVideo" src="${file(v.asset)}" ${v.poster ? `poster="${file(v.poster)}"` : ''} controls playsinline preload="metadata"></video><div class="vd-aim${aiming ? ' on' : ''}" id="vdAim">${aim ? `<i style="left:${aim.x * 100}%;top:${aim.y * 100}%"></i>` : ''}</div>` : `<p class="dim" style="padding:60px 20px;color:#bbb">${esc(d.change?.detail ?? 'Not started yet: the PM starts it when an agent is free.')}</p>`}</div>
          <div id="vdTimeline">${timelineHtml(v, v?.seconds ?? shotsOf(v).at(-1)?.end ?? 0)}</div>
          <div class="vd-versions">${vs.map((x) => `<button class="small${x.n === shown ? ' on' : ''}" data-version="${x.n}">v${x.n}${x.stage === 'animatic' ? ' · animatic' : ''}${x.made_by === 'quick' ? ' · quick edit' : ''}</button>`).join('')}</div>
          ${v?.summary ? `<div class="status-line">v${v.n}: ${esc(v.summary)}</div>` : ''}
          ${v?.review ? `<div class="status-line">Studio's review: <b>${esc(String(v.review.score))}/10</b>${v.review.pass ? ' · passed' : ' · sent back'} · ${esc(v.review.summary)}</div>` : ''}
          ${v?.story ? `<details class="more-details"><summary>The story</summary><div style="white-space:pre-wrap;font-size:13px">${esc(v.story)}</div></details>` : ''}
          ${Object.keys(d.spec ?? {}).length ? `<details class="more-details"><summary>Your controls</summary><div class="dim" style="font-size:13px">${esc(Object.entries(d.spec).map(([k, x]) => `${k}: ${x}`).join(' · '))}</div></details>` : ''}
          ${v?.caption ? `<details class="more-details"><summary>Post caption</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(v.caption)}</pre></details>` : ''}
          ${d.change ? `<details class="more-details"><summary>What the agent is doing</summary><div class="dim" style="font-size:12px">${esc(d.change.status)} · ${esc(d.change.detail ?? '')}</div><pre style="white-space:pre-wrap;font-size:11px">${esc((d.change.log ?? []).join('\n'))}</pre></details>` : ''}
        </div>
        <div class="vd-side" id="vdSide">${sideHtml(d, v)}</div>
      </div>`;
    const video = $('#vdVideo');
    if (!video) return;
    video.addEventListener('loadedmetadata', () => {
      if (keepTime) video.currentTime = Math.min(keepTime, video.duration - 0.05);
      if (Math.abs((v.seconds ?? 0) - video.duration) > 0.2) { v.seconds = video.duration; $('#vdTimeline').innerHTML = timelineHtml(v, video.duration); }
      void filmstrip(v);
    });
    video.addEventListener('timeupdate', () => {
      const dur = video.duration || v.seconds || 1;
      const head = $('#vdHead');
      if (head) head.style.left = `${(video.currentTime / dur) * 100}%`;
      if (playSel && video.currentTime >= playSel.to) { video.pause(); playSel = null; }
    });
  }
  let playSel = null;

  // The filmstrip: a frame from the middle of each shot, drawn once per version from a hidden copy of the video.
  const thumbs = new Map();
  let stripFor = null;
  async function filmstrip(v) {
    const shots = shotsOf(v);
    if (!shots.length || stripFor === v.asset) return;
    stripFor = v.asset;
    const vid = document.createElement('video');
    vid.muted = true; vid.preload = 'auto'; vid.src = file(v.asset);
    await new Promise((r) => { vid.onloadeddata = r; vid.onerror = r; });
    const canvas = document.createElement('canvas');
    for (const [i, s] of shots.entries()) {
      if (stripFor !== v.asset) return;
      const key = `${v.asset}:${i}`;
      if (!thumbs.has(key)) {
        await new Promise((r) => { vid.onseeked = r; vid.currentTime = Math.min((s.start + s.end) / 2, (vid.duration || s.end) - 0.05); setTimeout(r, 4000); });
        const h = 80, w = Math.round((vid.videoWidth / Math.max(1, vid.videoHeight)) * h) || 45;
        canvas.width = w; canvas.height = h;
        try { canvas.getContext('2d').drawImage(vid, 0, 0, w, h); thumbs.set(key, canvas.toDataURL('image/jpeg', 0.7)); } catch { return; }
      }
      const el = document.querySelector(`#vdTl .vd-shot[data-shot="${i}"]`);
      if (el) el.style.backgroundImage = `url(${thumbs.get(key)})`;
    }
    vid.removeAttribute('src');
  }

  // Re-drawing keeps what J was typing (a note, guidance for the final).
  const rerender = async () => {
    if (!current) return;
    const kept = ['vdNote', 'vdGuidance'].map((id) => [id, $(`#${id}`)?.value]);
    await detail(current, false);
    for (const [id, val] of kept) if (val && $(`#${id}`)) $(`#${id}`).value = val;
  };
  const duration = () => { const vid = $('#vdVideo'); return vid?.duration || data?.versions.find((x) => x.n === shown)?.seconds || 0; };

  // Selecting on the timeline: drag for a range, click for a moment (and the video seeks there).
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const tl = e.target.closest('#vdTl');
    if (!tl) return;
    const r = tl.getBoundingClientRect();
    const at = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration();
    drag = { tl, start: at };
    sel = { from: at, to: at };
    tl.setPointerCapture?.(e.pointerId);
    const vid = $('#vdVideo');
    if (vid) vid.currentTime = at;
    $('#vdTimeline').querySelector('.vd-sel')?.remove();
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = drag.tl.getBoundingClientRect();
    const at = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration();
    sel = { from: Math.min(drag.start, at), to: Math.max(drag.start, at) };
    let box = drag.tl.querySelector('.vd-sel');
    if (!box) { box = document.createElement('div'); box.className = 'vd-sel'; drag.tl.appendChild(box); }
    const dur = duration() || 1;
    box.style.left = `${(sel.from / dur) * 100}%`;
    box.style.width = `${((sel.to - sel.from) / dur) * 100}%`;
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    void rerender();
  });

  async function load() {
    if (!$('#vdBody')) return;
    const hash = location.hash.split('/');
    current = hash[0] === '#videos' && /^k_[0-9a-f]+$/.test(hash[1] ?? '') ? hash[1] : null;
    try { current ? await detail(current) : await list(); } catch (e) { $('#vdBody').innerHTML = `<p class="red">${esc(e.message)}</p>`; }
    clearInterval(timer);
    // While it's on screen: what the agent is doing moves (making, rendering, a new version), so look again every 20 s,
    // unless J is in the middle of something (typing, watching, a selection on the timeline).
    timer = setInterval(() => {
      if (document.hidden || !$('#videos')?.classList.contains('on')) return;
      const typing = document.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
      const playing = $('#vdVideo') && !$('#vdVideo').paused;
      if (!typing && !playing && !sel && !aiming) void (current ? detail(current) : list()).catch(() => {});
    }, 20_000);
  }
  const open = (id) => { shown = null; sel = null; ask = null; aim = null; aiming = false; data = null; location.hash = id ? `#videos/${id}` : '#videos'; void load(); };

  document.addEventListener('click', async (e) => {
    if (!$('#videos')?.contains(e.target)) return;
    const aimBox = e.target.closest('#vdAim');
    if (aimBox && aiming) {
      const r = aimBox.getBoundingClientRect();
      aim = { x: Math.round(((e.clientX - r.left) / r.width) * 100) / 100, y: Math.round(((e.clientY - r.top) / r.height) * 100) / 100 };
      aiming = false;
      return rerender();
    }
    const t = e.target.closest('[data-open],[data-version],[data-ask],[data-quick],[data-drop],[data-seek],#vdBack,#vdNewBtn,#vdCancel,#vdApprove,#vdSendAll,#vdPlaySel,#vdClearSel,#vdAimBtn,#vdRedo');
    if (!t) return;
    if (t.dataset.open) return open(t.dataset.open);
    if (t.dataset.version) { shown = Number(t.dataset.version); sel = null; return rerender(); }
    if (t.dataset.ask) { ask = ask === t.dataset.ask ? null : t.dataset.ask; return rerender(); }
    if (t.dataset.drop) { e.preventDefault(); data = await api(`/api/videos/${current}/notes/${t.dataset.drop}`, { method: 'DELETE' }); return rerender(); }
    if (t.dataset.seek !== undefined && t.dataset.seek !== '') { const vid = $('#vdVideo'); if (vid) vid.currentTime = Number(t.dataset.seek); return; }
    if (t.id === 'vdBack') return open(null);
    if (t.id === 'vdNewBtn') { $('#vdNew').hidden = false; $('#vdTitle').focus(); return; }
    if (t.id === 'vdCancel') { $('#vdNew').hidden = true; return; }
    if (t.id === 'vdClearSel') { sel = null; return rerender(); }
    if (t.id === 'vdAimBtn') { e.preventDefault(); aiming = !aiming; return rerender(); }
    if (t.id === 'vdPlaySel') { const vid = $('#vdVideo'); if (vid && sel) { vid.currentTime = sel.from; playSel = sel; void vid.play(); } return; }
    if (t.id === 'vdRedo') {
      if (!sel) return;
      t.disabled = true;
      $('#vdRedoMsg').textContent = 'Starting…';
      try {
        const r = await api(`/api/videos/${current}/redo`, { method: 'POST', body: { from: sel.from, to: sel.to > sel.from + 0.05 ? sel.to : null, text: $('#vdNote')?.value.trim() || undefined } });
        data = r.video; sel = null;
        if ($('#vdNote')) $('#vdNote').value = '';
        return rerender();
      } catch (x) { $('#vdRedoMsg').textContent = x.message; t.disabled = false; }
      return;
    }
    if (t.dataset.quick) {
      if (!sel) return;
      const op = t.dataset.quick;
      const body = op === 'remove' ? { op: 'remove', from: sel.from, to: sel.to }
        : op === 'speed' ? { op: 'speed', from: sel.from, to: sel.to, factor: 1.5 }
        : { op: 'zoom', from: sel.from, to: sel.to, zoom: 1.4, push: op === 'push', ...(aim ?? {}) };
      $('#vdSide').querySelectorAll('[data-quick]').forEach((b) => { b.disabled = true; });
      $('#vdQuickMsg').textContent = 'Rendering the new cut…';
      try {
        const r = await api(`/api/videos/${current}/edit`, { method: 'POST', body });
        data = r.video; shown = r.version.n; sel = null; aim = null;
        return rerender();
      } catch (x) {
        $('#vdQuickMsg').textContent = x.message;
        $('#vdSide').querySelectorAll('[data-quick]').forEach((b) => { b.disabled = false; });
      }
      return;
    }
    if (t.id === 'vdSendAll') {
      t.disabled = true;
      try { const r = await api(`/api/videos/${current}/notes/send`, { method: 'POST', body: { text: $('#vdNote')?.value.trim() || undefined } }); data = r.video; sel = null; ask = null; return rerender(); } catch (x) { alert(x.message); t.disabled = false; }
      return;
    }
    if (t.id === 'vdApprove') {
      t.disabled = true;
      try { await api(`/api/videos/${current}/approve`, { method: 'POST', body: { post: $('#vdPost')?.checked, guidance: $('#vdGuidance')?.value.trim() || undefined } }); await detail(current); } catch (x) { alert(x.message); t.disabled = false; }
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'vdNew') {
      e.preventDefault();
      try { localStorage.setItem('vd.product', $('#vdProduct').value); } catch {}
      const b = {
        product: $('#vdProduct').value, format: $('#vdFormat').value, title: $('#vdTitle').value, script: $('#vdScript').value, direction: $('#vdDirection').value,
        spec: { seconds: $('#vdSeconds').value || undefined, engine: $('#vdEngine').value, quality: $('#vdQuality').value || undefined, style: $('#vdStyle').value, voices: $('#vdVoices').value, music: $('#vdMusic').value, animatic: $('#vdAnimatic').checked, captions: $('#vdCaptions').checked, endCard: $('#vdEndCard').checked },
      };
      try { const d = await api('/api/videos', { method: 'POST', body: b }); open(d.task.id); } catch (x) { alert(x.message); }
    }
    if (e.target.id === 'vdNoteForm') {
      e.preventDefault();
      const text = $('#vdNote').value.trim();
      if (!text && !ask) return;
      const video = $('#vdVideo');
      const where = sel ? { from: sel.from, to: sel.to > sel.from + 0.05 ? sel.to : undefined } : { at: video && video.currentTime > 0.5 ? video.currentTime : null };
      try {
        const r = await api(`/api/videos/${current}/notes`, { method: 'POST', body: { text, action: ask, version: shown, hold: true, ...where, ...(aim && ask === 'closer' ? aim : {}) } });
        data = r.video; ask = null; sel = null;
        $('#vdNote').value = '';
        rerender();
      } catch (x) { alert(x.message); }
    }
  });
  window.loadVideosTab = load;
})();
