// Playtests tab: every playtest (newest first, filterable), trends, and a detail view per playtest with its video,
// screenshots, timeline, problems, Claude's review, backlog links, visual changes and the previous run side by side.
// Uses app.js's helpers ($, esc, api, file, ago, view, show, tab, findingHtml).

const pt = { open: null, vs: null, more: null, rows: [], products: [] };
const PT_OUTCOMES = ['won', 'done', 'lost', 'stuck', 'error', 'failed', 'running'];
const ptPill = (o) => `<span class="pill ${o === 'won' || o === 'done' ? 'ship' : o === 'lost' ? 'fix-first' : o === 'running' ? '' : 'failed'}">${esc(o ?? '?')}</span>`;
const ptSec = (s) => (s == null ? '–' : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const ptNum = (n, d = 1) => (n == null ? '–' : Math.round(n * 10 ** d) / 10 ** d);
const ptKey = (s) => (s.reason === 'scene' ? `scene: ${s.scene}` : s.reason === 'page' ? `page: ${s.scene}` : ['loaded', 'ready', 'end'].includes(s.reason) ? s.reason : null);

// ------------------------------------------------------------ list

async function loadPlaytests() {
  if (pt.open) return loadPlaytest();
  if (!pt.products.length) pt.products = (await api('/api/products')).products.map((p) => ({ id: p.id, name: p.name }));
  const f = ptFilters();
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const r = await api(`/api/playtests?${qs}`);
  pt.rows = r.playtests;
  pt.more = r.more;
  const sel = (id, opts, cur, all) => `<select id="${id}"><option value="">${all}</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  $('#ptBar').innerHTML = [
    sel('ptProduct', pt.products.map((p) => [p.id, p.name]), f.product, 'All products'),
    sel('ptScenario', r.scenarios.map((s) => [s, s]), f.scenario, 'All scenarios'),
    sel('ptWhere', [['local', 'local'], ['live', 'live']], f.where, 'Local and live'),
    sel('ptDevice', [['desktop', 'desktop'], ['phone', 'phone']], f.device, 'Any device'),
    sel('ptOutcome', PT_OUTCOMES.map((o) => [o, o]), f.outcome, 'Any outcome'),
    `<span class="meta">${pt.rows.length}${pt.more ? '+' : ''} playtests</span>`,
  ].join(' ');
  $('#ptBar').querySelectorAll('select').forEach((s) => (s.onchange = () => { ptSaveFilters(); loadPlaytests(); }));
  $('#ptList').innerHTML = pt.rows.length ? pt.rows.map(ptRow).join('') + (pt.more ? '<div class="empty"><button id="ptMore">Older</button></div>' : '') : '<div class="empty">No playtests match.</div>';
  const more = $('#ptMore');
  if (more) more.onclick = ptLoadMore;
  loadTrends(f);
}

function ptFilters() {
  const get = (id) => $(`#${id}`)?.value ?? '';
  if (!$('#ptProduct')) {
    try { return JSON.parse(localStorage.getItem('studio.ptFilters') || '{}'); } catch { return {}; }
  }
  return { product: get('ptProduct'), scenario: get('ptScenario'), where: get('ptWhere'), device: get('ptDevice'), outcome: get('ptOutcome') };
}
function ptSaveFilters() {
  try { localStorage.setItem('studio.ptFilters', JSON.stringify(ptFilters())); } catch {}
}

async function ptLoadMore() {
  const qs = new URLSearchParams(Object.entries({ ...ptFilters(), before: pt.more }).filter(([, v]) => v));
  const r = await api(`/api/playtests?${qs}`);
  pt.rows.push(...r.playtests);
  pt.more = r.more;
  $('#ptMore')?.parentElement.remove();
  $('#ptList').insertAdjacentHTML('beforeend', r.playtests.map(ptRow).join('') + (pt.more ? '<div class="empty"><button id="ptMore">Older</button></div>' : ''));
  const more = $('#ptMore');
  if (more) more.onclick = ptLoadMore;
}

function ptRow(p) {
  const rv = p.review;
  return `<div class="pt-row" data-pt="${p.id}">
    <div class="pt-thumb${p.device === 'phone' ? ' phone' : ''}">${p.thumb ? `<img loading="lazy" src="${file(p.thumb)}" alt="">` : ''}</div>
    <div class="pt-main">
      <div><b>${esc(p.product)}</b> <span class="mono">${esc(p.scenario)}</span> <span class="pill">${esc(p.where)}</span>${p.device === 'phone' ? ' <span class="pill">📱 phone</span>' : ''} ${ptPill(p.outcome)}
        ${rv?.verdict ? `<span class="pill ${rv.verdict}">${esc(rv.verdict)}</span> <span class="meta">score ${rv.score ?? '–'}</span>` : rv ? `<span class="meta">review ${esc(rv.status)}</span>` : ''}</div>
      <div class="meta">${ptSec(p.seconds)} · load ${ptSec(p.loadSeconds)} · ${p.fps != null ? `${p.fps} fps${p.software ? ' (software)' : ''}` : 'fps –'} · ${p.problems} problems${rv?.findings ? ` · ${rv.findings} findings (${rv.added} new)` : ''}${p.visualBig ? ` · <span style="color:var(--amber)">${p.visualBig} visual changes</span>` : ''}</div>
      ${p.status === 'failed' ? `<div class="meta" style="color:var(--red)">${esc(p.detail ?? '')}</div>` : ''}
    </div>
    <div class="meta pt-when" title="${new Date(p.started).toLocaleString()}">${ago(p.started)}${p.video ? ' · ▶' : ''}</div>
  </div>`;
}

$('#ptList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-pt]');
  if (row) openPlaytest(row.dataset.pt);
});

// The list refreshes when the server says a run moved (the push stream's 'runs' topic: a step started or ended, a review
// landed), never on a timer (J, 2026-11-02: "Please stop implementing polling"). Only while the list is the page on screen.
studioStream.on('runs', () => { if (tab === 'playtests' && !pt.open) loadPlaytests(); });

// ------------------------------------------------------------ trends (plain SVG)

async function loadTrends(f) {
  const r = await api(`/api/playtests/trends?${new URLSearchParams(f.product ? { product: f.product } : {})}`);
  const series = r.series.filter((s) => (!f.scenario || s.scenario === f.scenario) && (!f.where || s.where === f.where) && (!f.device || s.device === f.device));
  // Open for one product (or as J left it); all products' trends make a long grid, so that starts closed.
  let pref = null;
  try { pref = localStorage.getItem('studio.ptTrends'); } catch {}
  const open = pref ? pref === 'open' : Boolean(f.product);
  $('#ptTrends').innerHTML = series.length ? `<details class="pt-trends"${open ? ' open' : ''}><summary>Trends, last ${r.days} days <span class="meta">(day averages; software-rendered runs leave fps out)</span></summary>
    <div class="pt-trend-grid">${series.map((s) => `<div class="pt-trend"><div class="pt-trend-title"><b>${esc(s.product)}</b> <span class="mono">${esc(s.name)}</span></div>
      ${spark(s.points, 'fps', 'fps', (v) => `${v}`)}${spark(s.points, 'load', 'load', (v) => `${v} s`)}${spark(s.points, 'score', 'score', (v) => `${v}/10`)}</div>`).join('')}</div></details>` : '';
  const d = $('#ptTrends details');
  // Remembered only when J opens or closes it (the toggle event also fires for the initial state).
  if (d) d.querySelector('summary').onclick = () => { try { localStorage.setItem('studio.ptTrends', d.open ? 'closed' : 'open'); } catch {} };
}

/** A small line chart of one measure over days, with a hover title per point. */
function spark(points, key, label, fmt) {
  const pts = points.filter((p) => p[key] != null);
  if (!pts.length) return `<div class="spark"><span class="spark-label">${label}</span><span class="meta">–</span></div>`;
  const W = 150, H = 34, P = 4;
  const vals = pts.map((p) => p[key]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (key === 'score') { lo = Math.min(lo, 0); hi = 10; }
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  const days = points.map((p) => p.day);
  const x = (d) => (days.length < 2 ? W / 2 : P + ((W - 2 * P) * days.indexOf(d)) / (days.length - 1));
  const y = (v) => H - P - ((H - 2 * P) * (v - lo)) / (hi - lo);
  const line = pts.map((p) => `${x(p.day).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1][key];
  const dots = pts.map((p) => `<g><circle cx="${x(p.day).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="9" fill="transparent"/><circle cx="${x(p.day).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="2.5" class="spark-dot"/><title>${p.day}: ${fmt(p[key])}</title></g>`).join('');
  return `<div class="spark"><span class="spark-label">${label}</span><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label} by day, latest ${fmt(last)}"><polyline points="${line}" class="spark-line"/>${dots}</svg><b>${fmt(last)}</b></div>`;
}

// ------------------------------------------------------------ detail

async function openPlaytest(id, vs) {
  pt.open = id;
  pt.vs = vs ?? null;
  history.replaceState(null, '', `#playtests/${id}`);
  window.scrollTo(0, 0);
  await loadPlaytest();
}
function closePlaytest() {
  pt.open = null;
  pt.vs = null;
  history.replaceState(null, '', '#playtests');
  $('#ptDetail').innerHTML = '';
  $('#ptListView').hidden = false;
  loadPlaytests();
}

async function loadPlaytest() {
  $('#ptListView').hidden = true;
  $('#ptDetail').innerHTML = '<div class="empty">Loading…</div>';
  let d;
  try {
    d = await api(`/api/playtests/${pt.open}${pt.vs ? `?vs=${pt.vs}` : ''}`);
  } catch (e) {
    $('#ptDetail').innerHTML = `<div class="empty">${esc(e.message)} <button id="ptBack">Back</button></div>`;
    $('#ptBack').onclick = closePlaytest;
    return;
  }
  if (d.error) {
    $('#ptDetail').innerHTML = `<div class="empty">${esc(d.error)} <button id="ptBack">Back</button></div>`;
    $('#ptBack').onclick = closePlaytest;
    return;
  }
  const p = d.playtest;
  const data = d.data ?? {};
  const rec = d.recording;
  const res = rec?.result ?? {};
  const rv = d.review?.data;
  const phone = p.device === 'phone';
  const shots = rec?.shots ?? [];
  const mk = ptMarkers({ findings: rv?.findings ?? [], events: res.events ?? [], shots });
  $('#ptDetail').innerHTML = `
    <div class="bar"><button id="ptBack">← All playtests</button>
      <span class="meta">${new Date(p.started).toLocaleString()} · run ${esc(p.run)}</span>
      ${d.links.genJob ? `<a href="${esc(d.links.genJob)}" target="_blank">Gen job</a>` : ''}${d.links.reviewJob ? ` <a href="${esc(d.links.reviewJob)}" target="_blank">review job</a>` : ''}
      ${p.video ? ` <a href="${esc(p.video)}" target="_blank">video file</a>` : ''}${d.links.report ? ` <a href="${esc(d.links.report)}" target="_blank">report JSON</a>` : ''}
    </div>
    <h2 class="pt-title">${esc(p.product)} <span class="mono">${esc(p.scenario)}</span> <span class="pill">${esc(p.where)}</span>${phone ? ' <span class="pill">📱 phone 390×844</span>' : ''} ${ptPill(p.outcome)}${rv ? ` <span class="pill ${rv.verdict}">${esc(rv.verdict)}</span>` : ''}</h2>
    <div class="meta">${ptSec(p.seconds)} · load ${ptSec(p.loadSeconds)} · ${p.fps ?? '–'} fps${data.fps?.worst != null ? ` (worst ${data.fps.worst})` : ''}${data.software ? ' · software rendering' : ''} · ${esc(data.browser ?? res.browser ?? '')}${res.renderer ? ` · ${esc(res.renderer)}` : ''} · <a href="${esc(data.url ?? res.url ?? '')}" target="_blank">${esc(data.url ?? res.url ?? '')}</a></div>
    ${data.stuck || res.stuck ? `<p class="pt-stuck">Stuck: ${esc(data.stuck ?? res.stuck)}</p>` : ''}
    ${p.status === 'failed' ? `<p class="pt-stuck">${esc(p.detail ?? '')}</p>` : ''}
    ${data.s3?.error ? `<p class="meta" style="color:var(--amber)">S3 upload failed: ${esc(data.s3.error)}</p>` : ''}

    <div class="pt-top${phone ? ' phone' : ''}">
      <div>${p.video ? `<video id="ptVideo" src="${esc(p.video)}" controls playsinline preload="metadata"></video>${scrubHtml(mk)}` : '<div class="empty">No video.</div>'}</div>
      <div class="pt-side">
        ${rv ? `<div class="scores">${Object.entries(rv.scores ?? {}).map(([k, n]) => `<div class="score"><b>${n}</b><span>${esc(k)}</span></div>`).join('')}</div>
          ${rv.phone ? `<div class="scores pt-phone">${['touch', 'text', 'layout'].map((k) => `<div class="score"><b>${rv.phone[k]}</b><span>📱 ${k}</span></div>`).join('')}</div><p class="meta">${esc(rv.phone.notes)}</p>` : ''}
          <p class="summary">${esc(rv.summary)}</p>${rv.changes?.length ? `<p class="meta">Since last time: ${rv.changes.map(esc).join('; ')}</p>` : ''}`
        : `<p class="meta">${d.review ? `Review ${esc(d.review.status)}: ${esc(d.review.detail ?? '')}` : 'Not reviewed.'}</p>`}
        ${metricsTable(data.metrics ?? res.metrics)}
      </div>
    </div>

    <h3>Screenshots <span class="meta">click one to jump the video there</span></h3>
    <div class="pt-strip">${shots.map((s) => `<figure data-seek="${s.t}"><img loading="lazy" src="${file(s.asset)}" alt=""><figcaption>${s.t}s ${esc(s.reason)}${s.scene ? ` · ${esc(s.scene)}` : ''} <a href="#" data-zoom="${file(s.asset)}" title="Full size">⤢</a></figcaption></figure>`).join('') || '<div class="meta">No screenshots.</div>'}</div>

    ${timelineHtml(res.timeline ?? [], d.previous?.timeline)}

    <div class="pt-cols">
      <div><h3>Problems (${(data.problems ?? res.problems ?? []).length})</h3>${problemsHtml(data.problems ?? res.problems ?? [])}</div>
      <div><h3>Console ${res.console ? `<span class="meta">${res.console.errors} errors · ${res.console.warnings} warnings</span>` : ''}</h3>${consoleHtml(res.console)}${eventsHtml(res.events ?? [])}</div>
    </div>

    ${visualHtml(res.visual, rec?.diffs ?? [], shots)}

    <h3>Backlog</h3>
    ${d.findings.length ? `<div class="pt-findings">${d.findings.map((f) => `<div class="test"><span class="pill ${f.severity}">${esc(f.severity)}</span><span>${esc(f.title)}</span><span class="meta">${esc(f.id)} · ${esc(f.status)} · seen ${f.seen}×${f.isNew ? ' · new in this run' : ''}</span><button class="small" data-ptbacklog="${esc(p.product)}">Backlog</button></div>`).join('')}</div>` : '<p class="meta">No backlog findings from this playtest.</p>'}

    ${rv?.findings?.length ? `<h3>Review findings</h3>${rv.findings.map(findingHtml).join('')}` : ''}

    ${compareHtml(d)}

    ${rec?.job?.log?.length ? `<details><summary class="meta">Runner log</summary><pre>${esc(rec.job.log.join('\n'))}</pre></details>` : ''}`;
  $('#ptBack').onclick = closePlaytest;
  wireScrub($('#ptDetail'), shots, Math.max(p.seconds ?? 0, ...shots.map((x) => x.t ?? 0), ...(res.events ?? []).map((x) => x.t ?? 0), 1));
  const vs = $('#ptVs');
  if (vs) vs.onchange = () => openPlaytest(pt.open, vs.value || null);
}

$('#ptDetail').addEventListener('click', (e) => {
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) { e.preventDefault(); return view(`<img src="${zoom.dataset.zoom}">`); }
  const fig = e.target.closest('[data-seek]');
  if (fig) {
    const v = fig.closest('.pt-sbs-col')?.querySelector('video') ?? $('#ptVideo');
    if (v) { v.currentTime = Math.max(0, Number(fig.dataset.seek) - 0.5); v.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    return;
  }
  const mark = e.target.closest('[data-mseek]');
  if (mark) return ptSeekTo($('#ptDetail'), Number(mark.dataset.mseek), mark.dataset.mkey);
  const bl = e.target.closest('[data-ptbacklog]');
  if (bl) { $('#blProduct').value = bl.dataset.ptbacklog; show('backlog'); }
});

// ------------------------------------------------------------ the scrubber with markers (ptmarkers.js has the times)
// One viewer is a root element (the playtest page, or an inline embed in a report) holding a `video.pt-vid`, a `.pt-scrub`
// and its finding list, and a `.pt-strip` of screenshots. Everything below works inside one root, so several can share a page.

const SEV_CLASS = { blocker: 'blocker', bug: 'bug' };
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const ptState = new WeakMap();

/** The bar under the video: one lane of finding markers, one of event markers (pass / fail), a playhead; and the list of
 *  findings below it. Positions are set by wireScrub once the video's length is known. */
function scrubHtml({ markers, untimed }, main = true) {
  const id = (n) => (main ? ` id="${n}"` : '');
  const lane = (kind) => markers.filter((m) => m.kind === kind).map((m) => `<button type="button" class="pt-mark ${kind} ${m.kind === 'finding' ? SEV_CLASS[m.sev] ?? 'polish' : m.tone}" data-mseek="${m.t}" data-mkey="${m.key}" data-t="${m.t}" aria-label="${kind === 'finding' ? 'Finding' : 'Event'} at ${fmtT(m.t)}: ${esc(m.label)}" title="${fmtT(m.t)} · ${esc(m.label)}"></button>`).join('');
  const list = [...markers.filter((m) => m.kind === 'finding'), ...untimed].sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
  const events = markers.filter((m) => m.kind === 'event');
  return `<div class="pt-scrub"${id('ptScrub')} aria-label="Playtest timeline">
      <div class="pt-lane" data-lane="finding">${lane('finding')}</div>
      <div class="pt-track" role="slider" aria-label="Video position" tabindex="0"><div class="pt-fill"></div><div class="pt-head"></div></div>
      <div class="pt-lane" data-lane="event">${lane('event')}</div>
      <div class="pt-legend2"><span><i class="dot blocker"></i>blocker</span><span><i class="dot bug"></i>bug</span><span><i class="dot polish"></i>polish</span><span><i class="dot pass"></i>event passed</span><span><i class="dot fail"></i>event failed</span><span class="meta pt-now">0:00</span></div>
    </div>
    ${list.length || events.length ? `<div class="pt-flist"${id('ptFlist')}>${list.map((m) => `<button type="button" class="pt-fitem${m.t == null ? ' untimed' : ''}" ${m.t == null ? 'disabled' : `data-mseek="${m.t}" data-mkey="${m.key}"`}><span class="pill ${esc(m.sev)}">${esc(m.sev)}</span><span class="pt-ftitle">${esc(m.label)}</span><span class="meta">${m.t == null ? 'no time recorded' : fmtT(m.t)}</span></button>`).join('')}
      ${events.map((m) => `<button type="button" class="pt-fitem ev ${m.tone}" data-mseek="${m.t}" data-mkey="${m.key}"><span class="pill ${m.tone === 'pass' ? 'ship' : 'failed'}">${m.tone}</span><span class="pt-ftitle">${esc(m.label)}</span><span class="meta">${fmtT(m.t)}</span></button>`).join('')}</div>` : ''}`;
}

/** The viewer of an inline report embed: the video (through Studio's relay, so no signed link is stored or put in the page),
 *  the scrubber and the screenshot strip. `d` is a playtest's detail (GET /api/playtests/<step>). */
function ptEmbedHtml(d) {
  const rec = d.recording, res = rec?.result ?? {};
  const shots = rec?.shots ?? [];
  const mk = ptMarkers({ findings: d.review?.data?.findings ?? [], events: res.events ?? [], shots });
  return `<video class="pt-vid inline-video" src="${esc(d.playtest.video)}" controls playsinline preload="metadata"></video>${scrubHtml(mk, false)}
    ${shots.length ? `<div class="pt-strip">${shots.map((s) => `<figure data-seek="${s.t}"><img loading="lazy" src="${file(s.asset)}" alt=""><figcaption>${s.t}s ${esc(s.reason)}</figcaption></figure>`).join('')}</div>` : ''}`;
}
const ptEmbedDuration = (d) => Math.max(d.playtest.seconds ?? 0, ...(d.recording?.shots ?? []).map((x) => x.t ?? 0), ...(d.recording?.result?.events ?? []).map((x) => x.t ?? 0), 1);

/** Seek the video to a marker's moment, highlight it (marker and list entry), and bring the strip to that moment. */
function ptSeekTo(root, t, key) {
  const v = root.querySelector('video.pt-vid, #ptVideo');
  if (!v) return;
  v.currentTime = Math.max(0, t - 0.5);
  v.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  ptHighlight(root, key);
  ptSync(root);
}
function ptHighlight(root, key) {
  root.querySelectorAll('.pt-mark.on, .pt-fitem.on').forEach((n) => n.classList.remove('on'));
  if (!key) return;
  root.querySelectorAll(`[data-mkey="${key}"]`).forEach((n) => n.classList.add('on'));
  root.querySelector(`.pt-flist [data-mkey="${key}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
/** The playhead, the time and the screenshot strip follow the video's current time. */
function ptSync(root) {
  const v = root.querySelector('video.pt-vid, #ptVideo');
  const st = ptState.get(root);
  if (!v || !st) return;
  const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : st.duration;
  const pct = Math.min(100, (100 * v.currentTime) / d);
  const head = root.querySelector('.pt-head');
  if (head) {
    const track = root.querySelector('.pt-track');
    head.style.left = `${pct}%`; root.querySelector('.pt-fill').style.width = `${pct}%`;
    root.querySelector('.pt-now').textContent = `${fmtT(v.currentTime)} / ${fmtT(d)}`;
    track.setAttribute('aria-valuenow', Math.round(v.currentTime)); track.setAttribute('aria-valuemax', Math.round(d));
  }
  const i = ptShotIndexAt(st.shots, v.currentTime + 0.5);
  const strip = root.querySelector('.pt-strip');
  if (!strip) return;
  const figs = strip.querySelectorAll('figure');
  if (strip.dataset.now === String(i)) return;
  strip.dataset.now = String(i);
  figs.forEach((f, n) => f.classList.toggle('now', n === i));
  const f = figs[i];
  // Scroll only the strip sideways, never the page under the viewer's thumb.
  if (f) { const fr = f.getBoundingClientRect(), sr = strip.getBoundingClientRect(); strip.scrollTo({ left: strip.scrollLeft + fr.left - sr.left - (sr.width - fr.width) / 2, behavior: 'smooth' }); }
}

function wireScrub(root, shots, fallbackDuration) {
  const v = root.querySelector('video.pt-vid, #ptVideo');
  const track = root.querySelector('.pt-track');
  if (!v || !track || ptState.has(root) && ptState.get(root).video === v) return;
  ptState.set(root, { shots, duration: fallbackDuration, video: v });
  const place = () => {
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : fallbackDuration;
    root.querySelectorAll('.pt-scrub .pt-mark').forEach((m) => { m.style.left = `${Math.min(100, (100 * Number(m.dataset.t)) / d)}%`; });
    ptSync(root);
  };
  v.addEventListener('loadedmetadata', place);
  v.addEventListener('durationchange', place);
  v.addEventListener('timeupdate', () => ptSync(root));
  v.addEventListener('seeked', () => ptSync(root));
  place();
  // Dragging or tapping the track seeks (pointer events: mouse, pen and touch alike; touch-action none keeps the page still).
  const at = (e) => {
    const r = track.getBoundingClientRect();
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : fallbackDuration;
    v.currentTime = Math.min(d, Math.max(0, ((e.clientX - r.left) / r.width) * d));
    ptSync(root);
  };
  track.addEventListener('pointerdown', (e) => { track.setPointerCapture?.(e.pointerId); track.dataset.drag = '1'; ptHighlight(root, null); at(e); });
  track.addEventListener('pointermove', (e) => { if (track.dataset.drag) at(e); });
  const end = () => { delete track.dataset.drag; };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
    if (step) { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime + step); ptSync(root); }
  });
  // Taps on markers, finding rows and screenshots (in a report embed; the playtest page has its own handler below).
  if (root.classList.contains('pt-embed')) root.addEventListener('click', (e) => {
    const mark = e.target.closest('[data-mseek]');
    if (mark) return ptSeekTo(root, Number(mark.dataset.mseek), mark.dataset.mkey);
    const fig = e.target.closest('[data-seek]');
    if (fig) { v.currentTime = Math.max(0, Number(fig.dataset.seek) - 0.5); ptSync(root); }
  });
}

/** Inline report embeds: each `.pt-embed[data-step]` loads its playtest's markers once, when it comes on screen. */
function ptHydrateEmbeds(scope = document) {
  const load = async (el) => {
    if (el.dataset.loaded) return;
    el.dataset.loaded = '1';
    try {
      const d = await api(`/api/playtests/${el.dataset.step}`);
      if (!d?.playtest?.video) return;
      const old = el.querySelector('video.pt-vid');
      const t = old?.currentTime ?? 0;
      el.innerHTML = ptEmbedHtml(d);
      wireScrub(el, d.recording?.shots ?? [], ptEmbedDuration(d));
      if (t) el.querySelector('video.pt-vid').currentTime = t;
    } catch { /* the plain video stays */ }
  };
  const els = [...scope.querySelectorAll('.pt-embed[data-step]')];
  if (!('IntersectionObserver' in window)) return els.forEach(load);
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); load(en.target); } }), { rootMargin: '200px' });
  els.forEach((el) => io.observe(el));
}

function metricsTable(m) {
  const rows = Object.entries(m ?? {});
  return rows.length ? `<div class="pt-metrics"><table class="pt-table"><tbody>${rows.slice(0, 30).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'number' ? ptNum(v, 2) : v)}</td></tr>`).join('')}</tbody></table></div>` : '';
}

function problemsHtml(list) {
  return list.length ? `<div class="pt-problems">${list.slice(0, 60).map((x) => `<div><span class="pill ${x.severity === 'bug' ? 'bug' : x.severity === 'polish' ? 'polish' : ''}">${esc(x.severity)}</span> ${esc(x.message)} <span class="meta">${esc(x.source ?? '')}</span></div>`).join('')}</div>` : '<p class="meta">None.</p>';
}
function consoleHtml(c) {
  if (!c?.first?.length) return '<p class="meta">Nothing logged.</p>';
  return `<pre>${c.first.map((l) => `${l.t}s ${l.type === 'error' ? 'ERR ' : 'warn'} ${l.text}`).map(esc).join('\n')}</pre>`;
}
function eventsHtml(ev) {
  return ev.length ? `<details><summary class="meta">Game events (${ev.length})</summary><pre>${ev.slice(-80).map((x) => `${x.t}s ${x.type}${x.detail ? `: ${x.detail}` : ''}`).map(esc).join('\n')}</pre></details>` : '';
}

/** The state timeline: progress and fps over time (two charts, one scale each), scene changes as marks. */
function timelineHtml(tl, prevTl) {
  if (!tl.length) return '';
  const T = Math.max(...tl.map((x) => x.t), ...(prevTl ?? []).map((x) => x.t), 1);
  const W = 900, H = 90, L = 34, R = 8, TOP = 8, B = 18;
  const x = (t) => L + ((W - L - R) * t) / T;
  const scenes = [];
  for (const s of tl) if (s.scene && s.scene !== scenes[scenes.length - 1]?.scene) scenes.push({ t: s.t, scene: s.scene });
  const chart = (label, key, max, fmt) => {
    const pts = tl.filter((s) => typeof s[key] === 'number');
    if (!pts.length) return '';
    const prev = (prevTl ?? []).filter((s) => typeof s[key] === 'number');
    const top = max ?? Math.max(1, ...pts.map((s) => s[key]), ...prev.map((s) => s[key]));
    const y = (v) => TOP + (H - TOP - B) * (1 - Math.min(v, top) / top);
    const path = (ps) => ps.map((s) => `${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
    const ticks = [0, top / 2, top];
    return `<div class="pt-chart"><div class="meta">${label}${prev.length ? ' <span class="pt-legend"><i class="now"></i>this run <i class="prev"></i>previous run</span>' : ''}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label} over the run">
        ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 4}" y="${y(v) + 3}" class="axis" text-anchor="end">${fmt(v)}</text>`).join('')}
        ${scenes.map((s) => `<line x1="${x(s.t)}" x2="${x(s.t)}" y1="${TOP}" y2="${H - B}" class="scene"><title>${esc(s.scene)} at ${s.t}s</title></line>`).join('')}
        ${prev.length ? `<polyline points="${path(prev)}" class="prev-line"/>` : ''}
        <polyline points="${path(pts)}" class="line"/>
        ${[0, T / 2, T].map((t) => `<text x="${x(t)}" y="${H - 4}" class="axis" text-anchor="${t === 0 ? 'start' : t === T ? 'end' : 'middle'}">${Math.round(t)}s</text>`).join('')}
        ${pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 120)) === 0).map((s) => `<rect x="${x(s.t) - 3}" y="${TOP}" width="6" height="${H - TOP - B}" fill="transparent"><title>${s.t}s · ${label} ${fmt(s[key])}${s.scene ? ` · ${esc(s.scene)}` : ''}${s.note ? ` · ${esc(s.note)}` : ''}</title></rect>`).join('')}
      </svg></div>`;
  };
  return `<h3>Timeline <span class="meta">${scenes.length} scenes: ${scenes.slice(0, 12).map((s) => `${s.t}s ${esc(s.scene)}`).join(' → ')}</span></h3>
    ${chart('progress', 'progress', 1, (v) => `${Math.round(v * 100)}%`)}${chart('fps (the game\'s own)', 'fps', null, (v) => `${Math.round(v)}`)}`;
}

function visualHtml(visual, diffs, shots) {
  if (!visual) return '';
  const pairs = visual.pairs ?? [];
  if (!pairs.length) return `<h3>Visual changes</h3><p class="meta">${esc(visual.error ?? visual.note ?? 'Nothing to compare.')}</p>`;
  const diffOf = (key) => diffs.find((d) => d.key === key)?.asset;
  return `<h3>Visual changes since the previous run <span class="meta">${visual.big ?? 0} big of ${pairs.length} matching moments (1 − SSIM; big ≥ 25%)</span></h3>
    <div class="pt-visual">${pairs.map((x) => {
      const diff = x.diff ?? diffOf(x.key);
      const now = shots[x.shot]?.asset;
      return `<div class="pt-vrow${x.big ? ' big' : ''}"><span class="mono">${esc(x.key)}</span><span>${Math.round(x.score * 100)}% different · ${Math.round((x.changed ?? 0) * 100)}% of the screen</span>
        ${diff ? `<img loading="lazy" src="${file(diff)}" data-full="${file(diff)}" alt="previous | now | changes">` : `<span class="pt-pair">${x.baseline ? `<img loading="lazy" src="${file(x.baseline)}" data-full="${file(x.baseline)}" alt="previous">` : ''}${now ? `<img loading="lazy" src="${file(now)}" data-full="${file(now)}" alt="now">` : ''}</span>`}</div>`;
    }).join('')}</div>`;
}

/** This run next to the previous run of the same scenario (or one picked from its history). */
function compareHtml(d) {
  const a = d.playtest;
  const prev = d.previous;
  const picker = `<select id="ptVs"><option value="">the previous run</option>${d.history.filter((h) => h.id !== a.id).map((h) => `<option value="${h.id}"${prev?.playtest?.id === h.id && pt.vs ? ' selected' : ''}>${new Date(h.started).toLocaleString()} · ${esc(h.outcome ?? '')}</option>`).join('')}</select>`;
  if (!prev) return `<h3>Compared with ${picker}</h3><p class="meta">This is the first run of this scenario.</p>`;
  const b = prev.playtest;
  const sa = d.review?.data?.scores ?? {};
  const sb = prev.review?.scores ?? {};
  // higher: whether a bigger number is better.
  const row = (label, va, vb, higher, fmt = (v) => v ?? '–') => {
    const better = va == null || vb == null || va === vb ? '' : (va > vb) === higher ? 'up' : 'down';
    return `<tr><td>${label}</td><td class="${better}">${esc(fmt(va))}</td><td>${esc(fmt(vb))}</td></tr>`;
  };
  const shotsA = d.recording?.shots ?? [];
  const shotsB = prev.shots ?? [];
  const pairs = [];
  for (const s of shotsA) {
    const k = ptKey(s);
    if (!k || pairs.some((p) => p.k === k)) continue;
    const o = shotsB.find((x) => ptKey(x) === k);
    if (o) pairs.push({ k, a: s, b: o });
  }
  const col = (p, label) => `<div class="pt-sbs-col"><div class="meta">${label}: ${new Date(p.started).toLocaleString()}</div>${p.video ? `<video src="${esc(p.video)}" controls preload="metadata"></video>` : '<div class="empty">No video.</div>'}</div>`;
  return `<h3>Compared with ${picker}</h3>
    <div class="pt-sbs${a.device === 'phone' ? ' phone' : ''}">${col(a, 'This run')}${col(b, `<a href="#" onclick="openPlaytest('${b.id}');return false">That run</a>`)}</div>
    <table class="pt-table pt-compare"><thead><tr><th></th><th>This run</th><th>That run</th></tr></thead><tbody>
      ${row('outcome', a.outcome, b.outcome, true, (v) => v ?? '–').replace(/class="(up|down)"/, '')}
      ${row('seconds', a.seconds, b.seconds, false, (v) => ptSec(v))}
      ${row('load', a.loadSeconds, b.loadSeconds, false, (v) => ptSec(v))}
      ${row('fps', a.fps, b.fps, true)}
      ${row('problems', a.problems, b.problems, false)}
      ${row('verdict', a.review?.verdict, b.review?.verdict, true).replace(/class="(up|down)"/, '')}
      ${[...new Set([...Object.keys(sa), ...Object.keys(sb)])].map((k) => row(k, sa[k], sb[k], true)).join('')}
    </tbody></table>
    ${pairs.length ? `<div class="pt-pairs">${pairs.map((p) => `<div><div class="meta mono">${esc(p.k)}</div><div class="pt-pair"><img loading="lazy" src="${file(p.a.asset)}" data-full="${file(p.a.asset)}" title="this run, ${p.a.t}s"><img loading="lazy" src="${file(p.b.asset)}" data-full="${file(p.b.asset)}" title="that run, ${p.b.t}s"></div></div>`).join('')}</div>` : ''}`;
}

// ------------------------------------------------------------ hooking into app.js's tabs

document.querySelector('nav button[data-tab="playtests"]').addEventListener('click', () => {
  if (pt.open) closePlaytest();
  else loadPlaytests().catch((e) => ($('#ptList').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
});
{
  const m = /^#playtests(?:\/(s_[0-9a-f]+))?$/.exec(location.hash);
  if (m) {
    show('playtests');
    if (m[1]) openPlaytest(m[1]);
    else loadPlaytests();
  }
}
