// The Analytics tab: how the games are doing, from Hawkes Gen's player analytics (GET /api/analytics/..., src/analytics.ts,
// hawkesgen docs/analytics.md). #analytics is the overview (a card per product, a studio-wide total on top);
// #analytics/<product> is one game's page (players over time, retention, funnel, drop-off, levels, deaths, likes,
// where the time goes, dislikes, what gets in the way, accounts (one account's view: F.user), tech, where from, builds,
// sessions), each section a chart or table with a one-line plain reading. Charts are
// hand-made SVG in the theme's colours. Loaded when the tab is shown; refreshed on the stream's 60 s tick while the tab
// is on screen. Uses app.js's helpers ($, esc, api, ago, show, tab).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .an-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
    .an-bar label { color: var(--dim); display: flex; gap: 5px; align-items: center; font-size: 13px; }
    .an-bar input[type=date] { background: var(--panel2); border: 1px solid var(--line); border-radius: 7px; padding: 4px 6px; color: var(--text); }
    .an-total { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 14px; display: flex; flex-wrap: wrap; gap: 10px 28px; align-items: center; }
    .an-total .k, .an-kpi .k { color: var(--dim); font-size: 12px; } .an-total .v { font-size: 20px; font-weight: 700; }
    .an-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px; }
    .an-card { cursor: pointer; } .an-card:hover { border-color: var(--accent); }
    .an-card.empty { opacity: .75; }
    .an-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
    .an-kpi { background: var(--panel2); border-radius: 7px; padding: 6px 8px; } .an-kpi b { display: block; font-size: 16px; }
    .an-up { color: var(--accent); font-size: 12px; } .an-down { color: var(--red); font-size: 12px; } .an-flat { color: var(--dim); font-size: 12px; }
    .an-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: 14px; }
    .an-box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
    .an-box.wide { grid-column: 1 / -1; }
    .an-box h3 { margin: 0 0 4px; font-size: 15px; } .an-box h4 { margin: 12px 0 4px; font-size: 13px; color: var(--dim); font-weight: 600; }
    .an-read { margin: 0 0 10px; color: var(--text); font-size: 13px; }
    .an-scroll { overflow-x: auto; }
    .an-box table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .an-box td, .an-box th { padding: 4px 6px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    .an-box th { color: var(--dim); font-weight: 500; font-size: 12px; white-space: nowrap; }
    .an-box th[data-sort] { cursor: pointer; } .an-box th[data-sort]:hover { color: var(--text); }
    .an-box td.n, .an-box th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .an-box tr.hot td { background: rgba(255,107,107,.12); }
    .an-box tr[data-an-session] { cursor: pointer; } .an-box tr[data-an-session]:hover td { background: var(--panel2); }
    .an-bars .row { display: grid; grid-template-columns: minmax(90px, 40%) 1fr auto; gap: 8px; align-items: center; font-size: 13px; margin: 3px 0; }
    .an-bars .lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .an-bars .track { background: var(--panel2); border-radius: 4px; height: 10px; }
    .an-bars .fill { background: var(--accent); border-radius: 4px; height: 10px; min-width: 2px; }
    .an-bars .num { color: var(--dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .an-chart { width: 100%; height: auto; display: block; color: var(--dim); }
    .an-legend { font-size: 12px; color: var(--dim); display: flex; gap: 14px; } .an-legend i { display: inline-block; width: 10px; height: 3px; vertical-align: middle; margin-right: 4px; }
    .an-comment { border-left: 3px solid var(--line); padding: 2px 8px; margin: 6px 0; font-size: 13px; }
    .an-comment.low { border-left-color: var(--red); } .an-comment.high { border-left-color: var(--accent); }
    .an-box pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; max-height: 320px; overflow: auto; background: var(--panel2); padding: 8px; border-radius: 7px; }
    .an-sec-nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; font-size: 13px; }
    @media (max-width: 700px) { .an-grid { grid-template-columns: 1fr; } .an-cards { grid-template-columns: 1fr; } }`;
  document.head.appendChild(css);

  // ------------------------------------------------------------- formatting
  const num = (x) => (x == null || !Number.isFinite(Number(x)) ? '–' : Number(x).toLocaleString());
  const pct = (x) => (x == null ? '–' : `${Math.round(Number(x) * 100)}%`);
  const dur = (s) => (s == null ? '–' : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
  const ms = (x) => (x == null ? '–' : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);
  const trendTag = (t) => (t == null ? '' : `<span class="${t > 0.02 ? 'an-up' : t < -0.02 ? 'an-down' : 'an-flat'}" title="against the period before">${t > 0.02 ? '▲' : t < -0.02 ? '▼' : '•'} ${Math.abs(Math.round(t * 100))}%</span>`);
  const flag = (cc) => (/^[A-Z]{2}$/.test(cc ?? '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
  const rating = (r) => (r?.ratings ? `${r.average} ★ <span class="meta">(${num(r.ratings)})</span>` : r?.thumbsUp || r?.thumbsDown ? `${pct(r.upShare)} 👍 <span class="meta">(${num(r.thumbsUp + r.thumbsDown)})</span>` : '–');
  /** A funnel step in words: level_start:level=2 -> level 2, game_ready -> game ready, progress:step=3 -> step 3. */
  const stepName = (st) => String(st).replace(/^level_start:level=(.+)$/, 'level $1').replace(/^progress:step=(.+)$/, 'step $1').replace(/^game_ready$/, 'game ready');
  const dropLine = (d) => (d ? `${pct(d.share)} of sessions end ${/^level /.test(d.where) ? `in ${esc(d.where)}` : esc(d.where)}${d.medianSecondsIn != null ? ` (about ${dur(d.medianSecondsIn)} in)` : d.medianWaitSeconds != null ? ` (after waiting ${dur(d.medianWaitSeconds)})` : ''}` : 'No clear drop-off yet');

  // ------------------------------------------------------------- charts (SVG)
  /** A small line of values (a card's 30 days). */
  function spark(values, title) {
    if (!values.length) return '';
    const w = 120, h = 28, max = Math.max(1, ...values);
    const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
    return `<svg class="an-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }
  /** Daily series as lines: [{ key, label, color }] over rows [{ day, ... }]. Hover a day for its numbers. */
  function lineChart(rows, series) {
    if (!rows.length) return '<div class="meta">No days yet.</div>';
    const W = 600, H = 170, L = 34, B = 20, T = 8;
    const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
    const x = (i) => L + (i / Math.max(1, rows.length - 1)) * (W - L - 6);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const lines = series.map((s) => `<polyline points="${rows.map((r, i) => `${x(i).toFixed(1)},${y(Number(r[s.key]) || 0).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`).join('');
    const step = (W - L - 6) / Math.max(1, rows.length - 1);
    const hits = rows.map((r, i) => `<rect x="${(x(i) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${H - T - B}" fill="transparent"><title>${esc(r.day)}: ${series.map((s) => `${num(r[s.key])} ${s.label.toLowerCase()}`).join(', ')}</title></rect>`).join('');
    return `<svg class="an-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(' and '))} per day">
      <line x1="${L}" y1="${H - B}" x2="${W}" y2="${H - B}" stroke="var(--line)"/><line x1="${L}" y1="${T}" x2="${W}" y2="${T}" stroke="var(--line)" stroke-dasharray="3 4"/>
      <text x="${L - 4}" y="${T + 4}" text-anchor="end" font-size="11" fill="currentColor">${num(max)}</text><text x="${L - 4}" y="${H - B}" text-anchor="end" font-size="11" fill="currentColor">0</text>
      <text x="${L}" y="${H - 4}" font-size="11" fill="currentColor">${esc(rows[0].day.slice(5))}</text><text x="${W - 4}" y="${H - 4}" text-anchor="end" font-size="11" fill="currentColor">${esc(rows.at(-1).day.slice(5))}</text>
      ${lines}${hits}</svg>
      <div class="an-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
  }
  /** Vertical bars ([{ label, value }]). */
  function columns(list, label) {
    if (!list.length) return '';
    const W = 600, H = 130, B = 18, gap = 6, max = Math.max(1, ...list.map((x) => x.value));
    const bw = (W - gap * (list.length - 1)) / list.length;
    return `<svg class="an-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${list.map((x, i) => {
      const h = ((H - B - 14) * x.value) / max;
      const left = i * (bw + gap);
      return `<rect x="${left.toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="var(--blue)"><title>${esc(x.label)}: ${num(x.value)}</title></rect>
        <text x="${(left + bw / 2).toFixed(1)}" y="${(H - B - h - 3).toFixed(1)}" text-anchor="middle" font-size="11" fill="currentColor">${num(x.value)}</text>
        <text x="${(left + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="11" fill="currentColor">${esc(x.label)}</text>`;
    }).join('')}</svg>`;
  }
  /** The funnel: a bar per step, the step lost at most in red. */
  function funnelChart(f) {
    const steps = f?.steps ?? [];
    if (!steps.length) return '';
    const W = 600, row = 26, H = steps.length * row, L = 190, max = Math.max(1, steps[0].count);
    const worst = f.biggestLoss?.before;
    return `<svg class="an-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progression funnel">${steps.map((s, i) => {
      const w = Math.max(2, ((W - L - 110) * s.count) / max);
      const bad = s.step === worst;
      return `<text x="${L - 6}" y="${i * row + 17}" text-anchor="end" font-size="12" fill="${bad ? 'var(--red)' : 'currentColor'}">${esc(stepName(s.step).length > 30 ? `${stepName(s.step).slice(0, 29)}…` : stepName(s.step))}<title>${esc(s.step)}</title></text>
        <rect x="${L}" y="${i * row + 5}" width="${w.toFixed(1)}" height="16" rx="3" fill="${bad ? 'var(--red)' : 'var(--accent)'}" opacity="${bad ? 1 : 0.85}"><title>${esc(s.step)}: ${num(s.count)} (${pct(s.fromStart)} of the start, ${pct(s.fromPrevious)} of the step before)</title></rect>
        <text x="${L + w + 6}" y="${i * row + 17}" font-size="12" fill="currentColor">${num(s.count)} · ${pct(s.fromStart)}</text>`;
    }).join('')}</svg>`;
  }
  /** Horizontal bars as rows ([{ value, sessions|count, ... }]). */
  function bars(list, { label = (x) => esc(x.value), value = (x) => x.sessions ?? x.count, extra = () => '', limit = 10 } = {}) {
    const top = (list ?? []).slice(0, limit);
    if (!top.length) return '<div class="meta">Nothing yet.</div>';
    const max = Math.max(1, ...top.map(value));
    return `<div class="an-bars">${top.map((x) => `<div class="row"><span class="lab" title="${esc(x.value ?? x.option ?? '')}">${label(x)}</span><span class="track"><span class="fill" style="display:block;width:${(100 * value(x)) / max}%"></span></span><span class="num">${num(value(x))}${extra(x)}</span></div>`).join('')}</div>`;
  }
  /** A table: cols [{ h, f, n?, sort? }]. */
  function table(cols, list, empty = 'Nothing yet.', { rowAttr = () => '', id = '' } = {}) {
    if (!list?.length) return `<div class="meta">${esc(empty)}</div>`;
    return `<div class="an-scroll"><table${id ? ` id="${id}"` : ''}><tr>${cols.map((c) => `<th class="${c.n ? 'n' : ''}"${c.sort ? ` data-sort="${c.sort}"` : ''}>${esc(c.h)}</th>`).join('')}</tr>${list.map((x) => `<tr${rowAttr(x)}>${cols.map((c) => `<td class="${c.n ? 'n' : ''}">${c.f(x)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  }
  const box = (id, title, reading, body, wide = false) => `<div class="an-box${wide ? ' wide' : ''}" id="an-${id}"><h3>${esc(title)}</h3><p class="an-read">${reading}</p>${body}</div>`;

  // ------------------------------------------------------------- state
  const F = { range: '30d', from: '', to: '', env: 'live', build: '', device: '', browser: '', country: '', user: '', bots: false, internal: false };
  const known = { builds: new Set(), browsers: new Set(), countries: new Set() };
  let shown = null; // '' for the overview, else the product on screen (or loading)
  let seq = 0;
  let levelSort = { key: null, dir: -1 };
  let last = null; // the product page's data
  let openSession = null;
  let cmp = { a: '', b: '' };

  const productOf = () => (location.hash.startsWith('#analytics/') ? decodeURIComponent(location.hash.slice('#analytics/'.length).split('/')[0]) : '');
  function qs(extra = {}, { range = true } = {}) {
    const p = new URLSearchParams();
    if (range) {
      if (F.range === 'custom') { if (F.from) p.set('from', F.from); if (F.to) p.set('to', F.to); if (!F.from) p.set('range', '30d'); }
      else p.set('range', F.range);
    }
    p.set('env', F.env);
    for (const k of ['build', 'device', 'browser', 'country', 'user']) if (F[k]) p.set(k, F[k]);
    if (F.bots) p.set('bots', '1');
    if (F.internal) p.set('internal', '1');
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    return p.toString();
  }
  const opts = (list, cur, any) => `<option value="">${esc(any)}</option>${[...list].sort().map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}`;
  function filterBar(product) {
    const sel = (k, list) => `<select data-an-f="${k}">${list.map(([v, l]) => `<option value="${v}"${F[k] === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const env = `<label>Site ${sel('env', [['live', 'Live'], ['beta', 'Beta'], ['all', 'All (live, beta, previews, local)']])}</label>`;
    const toggles = `<label title="Studio's playtests, crawlers and headless browsers"><input type="checkbox" data-an-f="bots"${F.bots ? ' checked' : ''}> bots</label><label title="Your own devices (marked internal)"><input type="checkbox" data-an-f="internal"${F.internal ? ' checked' : ''}> internal</label>`;
    if (!product) return `<div class="an-bar">${env}${toggles}<button class="small" data-an-refresh>Refresh</button></div>`;
    const custom = F.range === 'custom' ? `<input type="date" data-an-f="from" value="${esc(F.from)}" aria-label="From"> – <input type="date" data-an-f="to" value="${esc(F.to)}" aria-label="To">` : '';
    const exp = (what) => `/api/analytics/${encodeURIComponent(product)}/export?${qs({ what, format: 'csv' })}`;
    return `<div class="an-bar">
      <label>Range ${sel('range', [['24h', 'Last 24 h'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['custom', 'Custom']])}</label>${custom}
      ${env}
      <label>Build <select data-an-f="build">${opts(known.builds, F.build, 'All builds')}</select></label>
      <label>Device ${sel('device', [['', 'All devices'], ['desktop', 'Desktop'], ['phone', 'Phone'], ['tablet', 'Tablet']])}</label>
      <label>Browser <select data-an-f="browser">${opts(known.browsers, F.browser, 'All browsers')}</select></label>
      <label>Country <select data-an-f="country">${opts(known.countries, F.country, 'All countries')}</select></label>
      ${F.user ? `<span class="pill">Account ${esc(F.user)} <a href="#analytics/${esc(product)}" data-an-user="" aria-label="Show every account">✕</a></span>` : ''}
      ${toggles}
      <span class="meta">Export CSV:</span> <a href="${exp('sessions')}" download>sessions</a> <a href="${exp('events')}" download>events</a>
    </div>`;
  }

  // ------------------------------------------------------------- the overview
  async function loadOverview() {
    const el = $('#anBody');
    const my = ++seq;
    if (!el.dataset.view || el.dataset.view !== 'overview') el.innerHTML = '<div class="meta">Loading how the games are doing…</div>';
    let o;
    try {
      o = await api(`/api/analytics/overview?${qs({}, { range: false })}`);
    } catch (e) {
      if (my === seq) el.innerHTML = `${filterBar('')}<div class="empty">Couldn't load analytics: ${esc(e.message)}</div>`;
      return;
    }
    if (my !== seq || shown !== '') return;
    const t = o.total;
    const per = (k, what) => `${num(t[k][what])} ${trendTag(t[k].trend[what])}`;
    const total = `<div class="an-total" aria-label="Every game together">
      <div><div class="k">Playing now</div><div class="v">${num(t.activeNow)}</div></div>
      <div><div class="k">Visitors today · 7 days · 30 days</div><div class="v">${per('today', 'visitors')} · ${per('7d', 'visitors')} · ${per('30d', 'visitors')}</div></div>
      <div><div class="k">Sessions today · 7 days · 30 days</div><div class="v">${per('today', 'sessions')} · ${per('7d', 'sessions')} · ${per('30d', 'sessions')}</div></div>
      <div><div class="k">Every game, 30 days</div>${spark(t.daily.map((d) => d.visitors), 'Visitors per day, every game')}</div>
      <div class="meta">${t.withData} of ${t.products} products have players on record.</div></div>`;
    const card = (p) => {
      if (!p.hasData) return `<div class="card an-card empty" data-an-open="${esc(p.product)}"><h3>${esc(p.name)}</h3><div class="status-line meta">No players on record yet: Hawkes Analytics (Gen's SDK) isn't on ${esc(p.name)} yet, or nobody has played since it went on.</div></div>`;
      const pp = (k) => `<div class="an-kpi"><span class="k">${k === 'today' ? 'Today' : k === '7d' ? '7 days' : '30 days'}</span><b>${num(p[k].visitors)} ${trendTag(p[k].trend.visitors)}</b><span class="meta">visitors · ${num(p[k].sessions)} sessions ${trendTag(p[k].trend.sessions)}</span></div>`;
      return `<div class="card an-card" data-an-open="${esc(p.product)}">
        <h3>${esc(p.name)} <small>${p.activeNow ? `<span class="pill ship">${num(p.activeNow)} playing now</span>` : 'nobody playing right now'}</small></h3>
        <div class="an-kpis">${pp('today')}${pp('7d')}${pp('30d')}</div>
        <div>${spark(p.daily.map((d) => d.visitors), `${p.name}: visitors per day, 30 days`)} <span class="meta">visitors per day, 30 days</span></div>
        <div class="an-kpis">
          <div class="an-kpi"><span class="k">New · returning</span><b>${num(p.newVisitors)} · ${num(p.returningVisitors)}</b></div>
          <div class="an-kpi"><span class="k">Median play time</span><b>${dur(p.medianActiveSeconds)}</b></div>
          <div class="an-kpi"><span class="k">Back next day · week</span><b>${pct(p.retention?.d1?.rate)} · ${pct(p.retention?.d7?.rate)}</b></div>
          <div class="an-kpi"><span class="k">Sessions with an error</span><b>${pct(p.errorRate)}</b></div>
          <div class="an-kpi"><span class="k">Rating</span><b>${rating(p.rating)}</b></div>
        </div>
        <div class="status-line">📉 ${dropLine(p.biggestDropoff)}</div>
      </div>`;
    };
    const list = [...o.products].sort((a, b) => Number(b.hasData) - Number(a.hasData) || (b['7d']?.visitors ?? 0) - (a['7d']?.visitors ?? 0));
    el.dataset.view = 'overview';
    el.innerHTML = `${filterBar('')}${total}<div class="an-cards">${list.map(card).join('')}</div><p class="meta">Numbers are the ${F.env === 'all' ? 'live, beta and preview sites together' : `${F.env} site${F.env === 'live' ? 's' : ''}`}${F.bots || F.internal ? `, with ${[F.bots && 'bots', F.internal && 'your own devices'].filter(Boolean).join(' and ')} included` : ', without bots or your own devices'}. Tap a game for everything about it.</p>`;
  }

  // ------------------------------------------------------------- a product's page
  async function loadProduct(product) {
    const el = $('#anBody');
    const my = ++seq;
    if (el.dataset.view !== product) { el.innerHTML = `<div class="meta">Loading ${esc(product)}…</div>`; last = null; openSession = null; }
    let d, ov, bl, list, ins;
    try {
      [d, ov, bl, list, ins] = await Promise.all([
        api(`/api/analytics/${encodeURIComponent(product)}?${qs()}`),
        api(`/api/analytics/overview?${qs({}, { range: false })}`),
        api(`/api/analytics/${encodeURIComponent(product)}/builds?${qs(cmp)}`),
        api(`/api/analytics/${encodeURIComponent(product)}/sessions/list?${qs({ limit: '50' })}`),
        api(`/api/analytics/${encodeURIComponent(product)}/insights?${qs()}`).catch(() => ({ insights: [] })),
      ]);
    } catch (e) {
      if (my === seq) el.innerHTML = `<p><a href="#analytics" data-an-back>← Every game</a></p>${filterBar(product)}<div class="empty" data-an-product="${esc(product)}">Couldn't load ${esc(product)}'s analytics: ${esc(e.message)}</div>`;
      return;
    }
    if (my !== seq || shown !== product) return;
    const p = ov.products.find((x) => x.product === product) ?? { product, name: product, daily: [], hasData: false };
    for (const b of bl.builds ?? []) known.builds.add(b.build);
    for (const x of d.traffic?.browsers ?? []) known.browsers.add(String(x.value).replace(/ \d+$/, ''));
    for (const x of d.traffic?.countries ?? []) if (x.value && x.value !== '(none)') known.countries.add(x.value);
    last = { d, p, bl, list, ins };
    el.dataset.view = product;
    el.innerHTML = render(product, last);
    if (openSession) loadSession(product, openSession);
  }

  function render(product, { d, p, bl, list, ins }) {
    const name = p.name ?? product;
    const head = `<p><a href="#analytics" data-an-back>← Every game</a></p><h2 style="margin:4px 0 8px" data-an-product="${esc(product)}">${esc(name)}</h2>${filterBar(product)}`;
    const sessionsN = d.sessions?.sessions ?? 0;
    if (!p.hasData && !sessionsN) return `${head}<div class="empty">No players on record for ${esc(name)} yet. Hawkes Analytics (Gen's SDK) isn't on it yet, or nobody has played since it went on. Try "All" sites or include bots to see playtests.</div>`;
    const S = [];
    const nav = [['players', 'Players'], ['retention', 'Retention'], ['sticks', 'Who sticks around'], ['funnel', 'Funnel'], ['dropoff', 'Drop-off'], ['levels', 'Levels'], ['deaths', 'Deaths'], ['likes', 'What players like'], ['time', 'Where the time goes'], ['dislikes', "What they don't"], ['frustration', 'What gets in the way'], ['accounts', 'Accounts'], ['tech', 'Tech'], ['where', 'Where from'], ['builds', 'Builds'], ['sessions', 'Sessions']];
    const insights = ins?.insights?.length ? `<div class="an-box wide" style="margin-bottom:14px"><h3>What changed</h3>${ins.insights.slice(0, 5).map((x) => `<div class="an-read">• ${esc(x.text)}</div>`).join('')}</div>` : '';

    // Players over time
    const t30 = p['30d'] ?? {};
    const ss = d.sessions ?? {};
    S.push(box('players', 'Players over time',
      p.daily?.length ? `${num(t30.visitors)} visitors and ${num(t30.sessions)} sessions in the last 30 days ${trendTag(t30.trend?.visitors)}; ${num(p.newVisitors)} new and ${num(p.returningVisitors)} returning; ${num(p.activeNow)} playing now. In the range: ${num(ss.sessions)} sessions from ${num(ss.players)} players, a typical one plays ${dur(ss.medianActiveSeconds)}.` : 'No days yet.',
      `${lineChart(p.daily ?? [], [{ key: 'visitors', label: 'Visitors', color: 'var(--accent)' }, { key: 'sessions', label: 'Sessions', color: 'var(--blue)' }])}
       <h4>How long sessions last (active play)</h4>${columns((ss.length ?? []).map((x) => ({ label: x.label, value: x.sessions })), 'Session lengths')}
       <div class="meta">Median ${dur(ss.medianActiveSeconds)}, the longest 10% over ${dur(ss.p90ActiveSeconds)}. Sessions per player: ${(ss.sessionsPerPlayer ?? []).map((x) => `${esc(x.label)}: ${num(x.players)}`).join(' · ')}.</div>`, true));

    // Retention
    const rt = d.retention ?? { total: {}, cohorts: [] };
    const cell = (x) => (x?.rate == null ? '<span class="meta">–</span>' : `<span style="display:inline-block;min-width:44px;padding:1px 4px;border-radius:4px;background:rgba(51,214,166,${(0.12 + x.rate * 0.75).toFixed(2)})" title="${num(x.returned)} of ${num(x.eligible)}">${pct(x.rate)}</span>`);
    S.push(box('retention', 'Retention',
      rt.total?.players ? `Of ${num(rt.total.players)} new players, ${pct(rt.total.d1?.rate)} came back the next day, ${pct(rt.total.d7?.rate)} after a week and ${pct(rt.total.d30?.rate)} after a month.` : 'No new players in this range.',
      table([{ h: 'First seen (week of)', f: (x) => esc(x.week) }, { h: 'Players', n: true, f: (x) => num(x.players) }, { h: 'Day 1', n: true, f: (x) => cell(x.d1) }, { h: 'Day 7', n: true, f: (x) => cell(x.d7) }, { h: 'Day 30', n: true, f: (x) => cell(x.d30) }], [...(rt.cohorts ?? [])].reverse(), 'No cohorts yet.')));

    // Who sticks around: retention by what a player's first session was (Gen's segments), and by what they did in it.
    const sg = d.segments;
    if (sg && sg.total?.players) {
      const GROUPS = [['entry', 'Came in through'], ['source', 'Came from'], ['device', 'Device'], ['input', 'Plays with'], ['account', 'Account'], ['hadFun', 'First session fun'], ['played', 'First session length']];
      const segRows = (list) => table([{ h: 'Group', f: (x) => esc(x.value) }, { h: 'Players', n: true, f: (x) => num(x.players) }, { h: 'Day 1', n: true, f: (x) => cell(x.d1) }, { h: 'Day 7', n: true, f: (x) => cell(x.d7) }, { h: 'First session', n: true, f: (x) => dur(x.medianFirstActiveSeconds) }], list, 'Nobody yet.');
      // The reading: the feature with the biggest day-1 lift among ones enough players used, and the best and worst way in.
      const solid = (sg.features ?? []).filter((x) => x.with.players >= 5 && x.without.players >= 5 && x.d1Lift != null);
      const best = [...solid].sort((a, b) => b.d1Lift - a.d1Lift)[0];
      const worst = [...solid].sort((a, b) => a.d1Lift - b.d1Lift)[0];
      const entries = (sg.by.entry ?? []).filter((x) => x.players >= 5 && x.d1.rate != null).sort((a, b) => b.d1.rate - a.d1.rate);
      const reading = [
        `Of ${num(sg.total.players)} new players, ${pct(sg.total.d1?.rate)} came back the next day and ${pct(sg.total.d7?.rate)} after a week.`,
        entries.length > 1 ? `Best way in: <b>${esc(entries[0].value)}</b> (${pct(entries[0].d1.rate)} next day) against ${esc(entries[entries.length - 1].value)} (${pct(entries[entries.length - 1].d1.rate)}).` : '',
        best && best.d1Lift > 0 ? `Players who <b>${esc(best.name)}</b> in their first session come back more: ${pct(best.with.d1.rate)} against ${pct(best.without.d1.rate)}.` : '',
        worst && worst !== best && worst.d1Lift < 0 ? `Those who ${esc(worst.name)} come back less (${pct(worst.with.d1.rate)} against ${pct(worst.without.d1.rate)}).` : '',
        solid.length ? '' : 'Too few players per feature to compare yet (5 with and 5 without).',
      ].filter(Boolean).join(' ');
      S.push(box('sticks', 'Who sticks around', reading,
        `${GROUPS.map(([k, label]) => (sg.by[k]?.length ? `<h4>${esc(label)}</h4>${segRows(sg.by[k].slice(0, 8))}` : '')).join('')}
         <h4>What they did first (each feature in the first session)</h4>${table([{ h: 'Did in first session', f: (x) => esc(x.name) }, { h: 'Players', n: true, f: (x) => num(x.with.players) }, { h: 'Day 1 with · without', n: true, f: (x) => `${cell(x.with.d1)} · ${cell(x.without.d1)}` }, { h: 'Day 7 with · without', n: true, f: (x) => `${cell(x.with.d7)} · ${cell(x.without.d7)}` }, { h: 'Day 1 lift', n: true, f: (x) => (x.d1Lift == null ? '–' : `${x.d1Lift > 0 ? '+' : ''}${Math.round(x.d1Lift * 100)} pts`) }], (sg.features ?? []).slice(0, 20), 'No feature events yet.')}
         <div class="meta">Groups are each player's first session in the range. Small groups (under about 20 players) move a lot: read them as hints.</div>`, true));
    }

    // Funnel
    const fn = d.funnel ?? {};
    const bl0 = fn.biggestLoss;
    S.push(box('funnel', 'Progression funnel',
      bl0 ? `The most players are lost between <b>${esc(stepName(bl0.after))}</b> and <b>${esc(stepName(bl0.before))}</b>: ${num(bl0.lost)} of ${num(bl0.of)} (${pct(bl0.rate)}).` : fn.steps?.length ? 'Nobody is lost between steps yet.' : "No progression events yet (game_ready, level_start or progress).",
      funnelChart(fn)));

    // Drop-off
    const dr = d.dropoff ?? {};
    const br = dr.beforeReady ?? {};
    const pf = d.perf ?? {};
    S.push(box('dropoff', 'Where players drop off',
      `${dr.biggest ? `${dropLine(dr.biggest)}.` : 'No clear drop-off yet.'} ${br.sessions ? `${num(br.sessions)} sessions (${pct(br.share)}) left before the game was ready, after a median wait of ${dur(br.medianWaitSeconds)} (the slowest 10%: ${dur(br.p90WaitSeconds)}); players who got in waited ${ms(pf.readyMs?.p50)} (p90 ${ms(pf.readyMs?.p90)}).` : `Nobody left while it loaded; it was ready in ${ms(pf.readyMs?.p50)} (p90 ${ms(pf.readyMs?.p90)}).`}`,
      `<h4>Last level</h4>${table([{ h: 'Level', f: (x) => esc(x.value) }, { h: 'Sessions ended', n: true, f: (x) => num(x.sessions) }, { h: 'Share', n: true, f: (x) => pct(x.share) }, { h: 'How far in', n: true, f: (x) => dur(x.medianSecondsIn) }], (dr.byLevel ?? []).slice(0, 10), 'No level was open when sessions ended.')}
       <h4>Last screen</h4>${bars(dr.byScreen, { extra: (x) => ` · ${pct(x.share)}`, limit: 8 })}
       <h4>Last thing they did</h4>${bars(dr.byEvent, { extra: (x) => ` · ${pct(x.share)}`, limit: 8 })}`));

    // Levels
    let lv = [...(d.levels ?? [])];
    if (levelSort.key) lv.sort((a, b) => ((a[levelSort.key] ?? -Infinity) > (b[levelSort.key] ?? -Infinity) ? 1 : (a[levelSort.key] ?? -Infinity) < (b[levelSort.key] ?? -Infinity) ? -1 : 0) * levelSort.dir);
    const hardest = [...(d.levels ?? [])].filter((x) => x.attempts >= 5 && x.completionRate != null).sort((a, b) => a.completionRate - b.completionRate)[0];
    S.push(box('levels', 'Levels',
      d.levels?.length ? `${d.levels.length} levels played. ${hardest ? `The hardest is level ${esc(hardest.level)}: ${pct(hardest.completionRate)} of ${num(hardest.attempts)} attempts finish it, ${pct(hardest.quitRate)} quit.` : ''} Tap a heading to sort.` : 'No level events yet (level_start, level_end).',
      table([
        { h: 'Level', sort: 'level', f: (x) => esc(x.level) }, { h: 'Attempts', sort: 'attempts', n: true, f: (x) => num(x.attempts) }, { h: 'Players', sort: 'players', n: true, f: (x) => num(x.players) },
        { h: 'Completion', sort: 'completionRate', n: true, f: (x) => pct(x.completionRate) }, { h: 'Median time', sort: 'medianSeconds', n: true, f: (x) => dur(x.medianSeconds) },
        { h: 'Deaths', sort: 'deaths', n: true, f: (x) => `${num(x.deaths)}${x.deathsPerAttempt != null ? ` <span class="meta">(${x.deathsPerAttempt}/try)</span>` : ''}` },
        { h: 'Retries to first win', sort: 'medianRetriesBeforeFirstWin', n: true, f: (x) => num(x.medianRetriesBeforeFirstWin) }, { h: 'Quit rate', sort: 'quitRate', n: true, f: (x) => pct(x.quitRate) },
      ], lv, 'No levels yet.', { id: 'anLevels', rowAttr: (x) => (hardest && x.level === hardest.level ? ' class="hot"' : '') }), true));

    // Deaths
    const de = d.deaths ?? {};
    const topCause = de.byCause?.[0];
    S.push(box('deaths', 'Deaths',
      de.deaths ? `${num(de.deaths)} deaths from ${num(de.players)} players. ${topCause ? `Most come from ${esc(topCause.value)} (${pct(topCause.count / de.deaths)}).` : ''}` : 'No deaths recorded.',
      `<h4>By cause</h4>${bars(de.byCause, { extra: (x) => ` · ${num(x.players)} players` })}<h4>By level</h4>${bars(de.byLevel, { limit: 8 })}<h4>Where (level @ spot)</h4>${bars(de.byWhere, { limit: 8 })}`));

    // What players like
    const ft = d.features ?? { features: [], choices: [] };
    const fb = d.feedback ?? { rating: {}, stars: [], comments: [] };
    const sticky = ft.features.filter((x) => x.sessions >= 3 && x.medianActiveSecondsWith && x.medianActiveSecondsWithout).filter((x) => x.medianActiveSecondsWith >= 1.2 * x.medianActiveSecondsWithout).sort((a, b) => b.medianActiveSecondsWith / b.medianActiveSecondsWithout - a.medianActiveSecondsWith / a.medianActiveSecondsWithout)[0];
    const good = fb.comments.filter((c) => c.rating === 'up' || Number(c.rating) >= 4);
    const comment = (c) => `<div class="an-comment ${c.rating === 'down' || Number(c.rating) <= 2 ? 'low' : c.rating === 'up' || Number(c.rating) >= 4 ? 'high' : ''}">${c.rating != null ? `<b>${c.rating === 'up' ? '👍' : c.rating === 'down' ? '👎' : `${esc(c.rating)} ★`}</b> ` : ''}“${esc(c.text)}”<div class="meta">${[c.context, c.level != null && `level ${c.level}`, c.screen, c.build && `build ${c.build}`, ago(c.at)].filter(Boolean).map(esc).join(' · ')}</div></div>`;
    S.push(box('likes', 'What players like',
      `${ft.features.length ? `Most used: ${esc(ft.features[0].name)} (${pct(ft.features[0].shareOfSessions)} of sessions).` : 'No features reported yet.'} ${sticky ? `Players who use ${esc(sticky.name)} play ${dur(sticky.medianActiveSecondsWith)} against ${dur(sticky.medianActiveSecondsWithout)} for those who don't.` : ''} Rating: ${rating(fb.rating)}.`,
      `<h4>Features</h4>${table([{ h: 'Feature', f: (x) => esc(x.name) }, { h: 'Uses', n: true, f: (x) => num(x.uses) }, { h: 'Players', n: true, f: (x) => num(x.players) }, { h: 'Of sessions', n: true, f: (x) => pct(x.shareOfSessions) }, { h: 'Play time with · without', n: true, f: (x) => `${dur(x.medianActiveSecondsWith)} · ${dur(x.medianActiveSecondsWithout)}` }], ft.features.slice(0, 15), 'No feature events yet.')}
       <h4>Choices</h4>${ft.choices.length ? ft.choices.slice(0, 6).map((c) => `<div class="meta" style="margin-top:6px">${esc(c.node)} · ${num(c.players)} players</div>${bars(c.options, { label: (x) => esc(x.option), value: (x) => x.players, extra: (x) => ` · ${pct(x.share)}`, limit: 6 })}`).join('') : '<div class="meta">No choices recorded.</div>'}
       <h4>Ratings</h4>${fb.rating?.ratings ? columns(fb.stars.map((x) => ({ label: `${x.stars} ★`, value: x.count })), 'Star ratings') : ''}${fb.rating?.thumbsUp || fb.rating?.thumbsDown ? `<div class="meta">👍 ${num(fb.rating.thumbsUp)} · 👎 ${num(fb.rating.thumbsDown)}</div>` : ''}
       <h4>What they said</h4>${(good.length ? good : fb.comments).slice(0, 8).map(comment).join('') || '<div class="meta">No comments yet.</div>'}`));


    // What gets in the way: frustration events (credits, failed requests and generations, the assistant), rage clicks
    // and errors, each with how often the player left right after.
    const fr = d.frustration ?? { kinds: [], rageClicks: [], recent: [] };
    const frWorst = (fr.kinds ?? [])[0];
    const kindName = (k) => esc(String(k).replace(/_/g, ' '));
    const leftTag = (x) => (x.leftAfterRate == null ? '–' : `<span class="${x.leftAfterRate >= 0.5 ? 'an-down' : ''}">${pct(x.leftAfterRate)}</span>`);
    S.push(box('frustration', 'What gets in the way',
      fr.sessionsWithFrustration ? `${pct(fr.frustrationRate)} of sessions (${num(fr.sessionsWithFrustration)} of ${num(fr.sessions)}) hit something in their way, and ${pct(fr.leftAfterRate)} of those left within 2 minutes. ${frWorst ? `The most common: <b>${kindName(frWorst.kind)}</b> in ${num(frWorst.sessions)} sessions (${pct(frWorst.shareOfSessions)}).` : ''}` : 'Nothing got in anyone\'s way in this range (or the pages don\'t report it yet).',
      `${table([{ h: 'What', f: (x) => `${kindName(x.kind)}<div class="meta">${esc(Object.keys(x.pages ?? {}).slice(0, 3).join(', '))}</div>` }, { h: 'Sessions', n: true, f: (x) => num(x.sessions) }, { h: 'Of sessions', n: true, f: (x) => pct(x.shareOfSessions) }, { h: 'Players', n: true, f: (x) => num(x.players) }, { h: 'Accounts', n: true, f: (x) => num(x.accounts) }, { h: 'Left right after', n: true, f: leftTag }, { h: 'Last', n: true, f: (x) => (x.last ? ago(x.last.at) : '–') }], fr.kinds ?? [], 'Nothing yet.', { rowAttr: (x) => ((x.leftAfterRate ?? 0) >= 0.5 && x.sessions >= 3 ? ' class="hot"' : '') })}
       <h4>Rage clicks (3 fast clicks in one spot)</h4>${bars((fr.rageClicks ?? []).map((x) => ({ ...x, value: x.where })), { value: (x) => x.count, extra: (x) => ` · ${num(x.sessions)} sessions`, limit: 8 })}
       <h4>Latest</h4>${table([{ h: 'When', f: (x) => ago(x.at) }, { h: 'What', f: (x) => kindName(x.kind) }, { h: 'Where', f: (x) => esc(x.page ?? '') }, { h: 'Details', f: (x) => esc(Object.entries(x.props ?? {}).filter(([k]) => k !== 'kind').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ').slice(0, 120)) }, { h: 'Account', f: (x) => (x.user ? `<a href="#analytics/${esc(product)}" data-an-user="${esc(x.user)}">${esc(x.user)}</a>` : '<span class="meta">guest</span>') }], (fr.recent ?? []).slice(0, 12), 'None yet.')}`, true));

    // Where the time goes: seconds per activity from `engage` events (only while the player was active).
    const en = d.engagement ?? { activities: [] };
    const enTop = (en.activities ?? [])[0];
    S.push(box('time', 'Where the time goes',
      enTop ? `Players spent the most time on <b>${esc(enTop.name)}</b>: ${dur(enTop.seconds)} in all, ${pct(enTop.shareOfActiveTime)} of active time, ${num(enTop.players)} players (a median ${dur(enTop.medianSecondsPerPlayer)} each).` : 'No time per activity reported yet.',
      `${bars((en.activities ?? []).map((x) => ({ ...x, value: x.name })), { value: (x) => x.seconds, extra: (x) => ` s · ${num(x.players)} players`, limit: 12 })}
       ${table([{ h: 'Activity', f: (x) => esc(x.name) }, { h: 'Time', n: true, f: (x) => dur(x.seconds) }, { h: 'Players', n: true, f: (x) => num(x.players) }, { h: 'Of players', n: true, f: (x) => pct(x.shareOfPlayers) }, { h: 'Median each', n: true, f: (x) => dur(x.medianSecondsPerPlayer) }, { h: 'Top 10% each', n: true, f: (x) => dur(x.p90SecondsPerPlayer) }, { h: 'Of active time', n: true, f: (x) => pct(x.shareOfActiveTime) }], en.activities ?? [], 'No activity time yet.')}`));

    // Accounts: who likes what (signed-in players: the site's own account id, nothing else about them).
    const ac = d.accounts ?? { accounts: [] };
    const acts = (x) => (x.topActivities ?? []).slice(0, 3).map((t) => `${esc(t.name)} ${dur(t.value)}`).join(', ');
    const ms_ = (x) => Object.entries(x.milestones ?? {}).map(([k, n]) => `${esc(k)}${n > 1 ? ` ×${n}` : ''}`).join(', ');
    const lastRating = (x) => { const r = (x.ratings ?? []).at(-1); return r ? `${r.rating === 'up' ? '👍' : r.rating === 'down' ? '👎' : `${esc(r.rating)} ★`}${r.text ? ` “${esc(String(r.text).slice(0, 60))}”` : ''}` : '–'; };
    S.push(box('accounts', 'Accounts: who likes what',
      ac.total ? `${num(ac.total)} signed-in accounts played in this range (${num(ac.identifiedSessions)} sessions). ${F.user ? `Showing <b>${esc(F.user)}</b> only: every section is just this account. <a href="#analytics/${esc(product)}" data-an-user="">Show everyone</a>.` : 'Tap one to see everything for just that account.'}` : 'No signed-in players yet (only sites that tell the SDK who is signed in have accounts).',
      table([
        { h: 'Account', f: (x) => `<a href="#analytics/${esc(product)}" data-an-user="${esc(x.user)}">${esc(x.user)}</a><div class="meta">${esc((x.devices ?? []).join(', '))}${x.browsers > 1 ? ` · ${num(x.browsers)} browsers` : ''}</div>` },
        { h: 'Sessions', n: true, f: (x) => num(x.sessions) }, { h: 'Played', n: true, f: (x) => dur(x.activeSeconds) },
        { h: 'Time on', f: (x) => acts(x) || '<span class="meta">–</span>' },
        { h: 'Used', f: (x) => esc((x.features ?? []).slice(0, 6).join(', ')) || '<span class="meta">–</span>' },
        { h: 'Got in the way', f: (x) => ((x.frustrationKinds ?? []).map((k) => `${kindName(k.name)}${k.value > 1 ? ` ×${k.value}` : ''}`).join(', ') || '<span class="meta">nothing</span>') },
        { h: 'Rated', f: lastRating }, { h: 'Milestones', f: (x) => ms_(x) || '<span class="meta">–</span>' }, { h: 'Last seen', n: true, f: (x) => ago(x.last) },
      ], (ac.accounts ?? []).slice(0, 60), 'No accounts yet.', { rowAttr: (x) => (x.frustrations >= 3 ? ' class="hot"' : '') }), true));

    // What they don't
    const er = d.errors ?? { groups: [] };
    const low = fb.comments.filter((c) => c.rating === 'down' || (Number(c.rating) >= 1 && Number(c.rating) <= 2));
    S.push(box('dislikes', "What they don't",
      `${low.length ? `${num(low.length)} low ratings with comments.` : 'No low ratings with comments.'} ${er.sessionsWithErrors ? `${pct(er.errorRate)} of sessions hit an error (${num(er.sessionsWithErrors)} of ${num(er.sessions)})${er.groups[0] ? `; the most common: “${esc(String(er.groups[0].message ?? er.groups[0].signature).slice(0, 90))}”` : ''}.` : 'No errors.'} Rage clicks and everything else that got in the way: What gets in the way.`,
      `<h4>Low ratings</h4>${low.slice(0, 8).map(comment).join('') || '<div class="meta">None.</div>'}
       <h4>Errors</h4>${table([{ h: 'Error', f: (x) => `${esc(String(x.message ?? x.signature).slice(0, 140))}<div class="meta">${esc(Object.keys(x.sources ?? {}).join(', '))} · ${esc(Object.keys(x.browsers ?? {}).slice(0, 3).join(', '))}</div>` }, { h: 'Sessions', n: true, f: (x) => num(x.sessions) }, { h: 'Players', n: true, f: (x) => num(x.players) }, { h: 'Times', n: true, f: (x) => num(x.count) }, { h: 'Last', n: true, f: (x) => ago(x.last) }], er.groups.slice(0, 15), 'No errors.')}`));

    // Tech
    const tr = d.traffic ?? {};
    const countries = (tr.countries ?? []).filter((x) => x.value && x.value !== '(none)');
    const slowest = [...(pf.fpsByDevice ?? [])].filter((x) => x.fpsMedian != null).sort((a, b) => a.fpsMedian - b.fpsMedian)[0];
    S.push(box('tech', 'Tech',
      `${tr.browsers?.[0] ? `Mostly ${esc(tr.browsers[0].value)} on ${esc(tr.os?.[0]?.value ?? '?')}, ${esc(tr.devices?.[0]?.value ?? '?')}.` : 'No sessions.'} ${pf.loads ? `${pct(pf.readyRate)} of loads reached the game; ready in ${ms(pf.readyMs?.p50)} (p90 ${ms(pf.readyMs?.p90)}).` : ''} ${slowest ? `Slowest: ${esc(slowest.value)} at ${slowest.fpsMedian} fps.` : ''}`,
      `<div class="an-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
        <div><h4>Browsers</h4>${bars(tr.browsers, { limit: 6 })}</div><div><h4>OS</h4>${bars(tr.os, { limit: 6 })}</div>
        <div><h4>Devices</h4>${bars(tr.devices, { limit: 4 })}</div><div><h4>Screen sizes</h4>${bars(tr.screens, { limit: 6 })}</div></div>
       <h4>Load to ready, by device</h4>${table([{ h: 'Device', f: (x) => esc(x.device) }, { h: 'Sessions', n: true, f: (x) => num(x.sessions) }, { h: 'Median', n: true, f: (x) => ms(x.p50) }, { h: 'p90', n: true, f: (x) => ms(x.p90) }], pf.readyMsByDevice, 'No load times yet.')}
       <h4>Frame rate</h4>${table([{ h: 'Device / GPU', f: (x) => esc(x.value) }, { h: 'Sessions', n: true, f: (x) => num(x.sessions) }, { h: 'Median fps', n: true, f: (x) => num(x.fpsMedian) }, { h: 'Low (p10)', n: true, f: (x) => num(x.fpsP10) }, { h: 'Memory', n: true, f: (x) => (x.memoryMb != null ? `${num(x.memoryMb)} MB` : '–') }], [...(pf.fpsByDevice ?? []), ...(pf.fpsByGpu ?? []).slice(0, 10)], 'No perf events yet.')}`, true));

    // Where from
    S.push(box('where', 'Where from',
      `${countries[0] ? `Most players come from ${flag(countries[0].value)} ${esc(countries[0].value)} (${pct(countries[0].visitors / Math.max(1, tr.visitors))}).` : 'No countries known yet.'} ${tr.referrers?.[0] ? `Most sessions come ${tr.referrers[0].value === '(direct)' ? 'directly (no referrer)' : `from ${esc(tr.referrers[0].value)}`}.` : ''}`,
      `<div class="an-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
        <div><h4>Countries</h4>${bars(countries, { label: (x) => `${flag(x.value)} ${esc(x.value)}`, value: (x) => x.visitors, extra: () => ' players' })}</div>
        <div><h4>Cities</h4>${bars(tr.cities, { value: (x) => x.visitors, extra: () => ' players' })}</div>
        <div><h4>Referrers</h4>${bars(tr.referrers)}</div>
        <div><h4>Campaigns (UTM)</h4>${bars([...(tr.utmSource ?? []).map((x) => ({ ...x, value: `source: ${x.value}` })), ...(tr.utmMedium ?? []).map((x) => ({ ...x, value: `medium: ${x.value}` })), ...(tr.utmCampaign ?? []).map((x) => ({ ...x, value: `campaign: ${x.value}` }))].filter((x) => !/: \(none\)$/.test(x.value)))}</div>
        <div><h4>Languages</h4>${bars(tr.languages, { limit: 6 })}</div></div>`));

    // Builds
    const A = bl.a, B = bl.b;
    const K = [['sessions', 'Sessions', num], ['players', 'Players', num], ['medianActiveSeconds', 'Median play time', dur], ['readyRate', 'Reached the game', pct], ['medianReadyMs', 'Ready time', ms], ['errorRate', 'Sessions with an error', pct], ['levelCompletionRate', 'Level completion', pct], ['deathsPerSession', 'Deaths per session', num], ['medianMaxProgress', 'Progress (median)', num], ['rating', 'Rating', num], ['upShare', 'Thumbs up', pct], ['fpsMedian', 'Frame rate', num]];
    const diff = (k, a, b) => {
      if (a == null || b == null || a === b) return '';
      const better = ['errorRate', 'medianReadyMs', 'deathsPerSession'].includes(k) ? b < a : b > a;
      return `<span class="${better ? 'an-up' : 'an-down'}">${b > a ? '▲' : '▼'}</span>`;
    };
    const bsel = (k, cur) => `<select data-an-build="${k}">${(bl.builds ?? []).map((x) => `<option value="${esc(x.build)}"${x.build === cur ? ' selected' : ''}>${esc(x.build)} (${num(x.sessions)} sessions)</option>`).join('')}</select>`;
    S.push(box('builds', 'Builds',
      A && B ? `Build ${esc(B.build)} against ${esc(A.build)}: median play ${dur(A.kpis.medianActiveSeconds)} → ${dur(B.kpis.medianActiveSeconds)}, errors ${pct(A.kpis.errorRate)} → ${pct(B.kpis.errorRate)}, level completion ${pct(A.kpis.levelCompletionRate)} → ${pct(B.kpis.levelCompletionRate)}.` : (bl.builds ?? []).length ? 'Only one build in this range.' : 'No builds reported in this range.',
      (bl.builds ?? []).length > 1 ? `<div class="an-bar"><label>Before ${bsel('a', A?.build)}</label><label>After ${bsel('b', B?.build)}</label></div>${table([{ h: 'KPI', f: (x) => esc(x[1]) }, { h: A?.build ?? 'A', n: true, f: (x) => x[2](A?.kpis?.[x[0]]) }, { h: B?.build ?? 'B', n: true, f: (x) => `${x[2](B?.kpis?.[x[0]])} ${diff(x[0], A?.kpis?.[x[0]], B?.kpis?.[x[0]])}` }], K)}` : ''));

    // Sessions
    S.push(box('sessions', 'Sessions',
      `${num(list.total)} sessions in this range; the newest ${num(list.items?.length)} below. Tap one for its timeline and what was on screen when it ended.`,
      `${table([
        { h: 'Started', f: (x) => `${esc(new Date(x.started).toLocaleString())}${x.bot ? ' <span class="pill">bot</span>' : ''}${x.internal ? ' <span class="pill">you</span>' : ''}` },
        { h: 'Where', f: (x) => `${flag(x.country)} ${esc([x.city, x.country].filter(Boolean).join(', '))}` },
        { h: 'On', f: (x) => esc([x.device, x.browser, x.os].filter(Boolean).join(' · ')) },
        { h: 'Account', f: (x) => (x.user_id ? esc(x.user_id) : '<span class="meta">–</span>') },
        { h: 'Played', n: true, f: (x) => dur(x.active_ms / 1000) }, { h: 'Levels done', n: true, f: (x) => num(x.levels_done) }, { h: 'Deaths', n: true, f: (x) => num(x.deaths) }, { h: 'Errors', n: true, f: (x) => num(x.errors) }, { h: 'In the way', n: true, f: (x) => num(x.frustrations) },
        { h: 'Ended on', f: (x) => esc([x.last_level != null && `level ${x.last_level}`, x.last_screen, x.last_event].filter(Boolean).join(' · ')) },
      ], list.items ?? [], 'No sessions in this range.', { rowAttr: (x) => ` data-an-session="${esc(x.id)}"` })}<div id="anSession"></div>`, true));

    return `${head}<div class="an-sec-nav">${nav.map(([id, l]) => `<a href="#analytics/${esc(product)}" data-an-jump="an-${id}">${esc(l)}</a>`).join(' · ')}</div>${insights}<div class="an-grid">${S.join('')}</div>`;
  }

  async function loadSession(product, id) {
    openSession = id;
    const el = $('#anSession');
    if (!el) return;
    el.innerHTML = '<div class="meta">Loading the session…</div>';
    let t;
    try {
      t = await api(`/api/analytics/${encodeURIComponent(product)}/sessions/${encodeURIComponent(id)}`);
    } catch (e) {
      el.innerHTML = `<div class="meta">Couldn't load that session: ${esc(e.message)}</div>`;
      return;
    }
    const s = t.session;
    const brief = (o) => (o && Object.keys(o).length ? esc(Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ').slice(0, 160)) : '');
    el.innerHTML = `<h4>Session ${esc(s.id)} · ${esc(s.anon)}</h4>
      <div class="meta">${s.user_id ? `account ${esc(s.user_id)} · ` : ''}${esc(new Date(s.started).toLocaleString())} · ${dur((s.active_ms ?? 0) / 1000)} active · ${esc([s.device, s.browser, s.os, s.screen].filter(Boolean).join(' · '))} · ${flag(s.country)} ${esc([s.city, s.country].filter(Boolean).join(', '))}${s.referrer ? ` · from ${esc(s.referrer)}` : ''}${s.build ? ` · build ${esc(s.build)}` : ''}</div>
      ${table([{ h: 'At', n: true, f: (e) => (e.offsetMs == null ? '' : dur(e.offsetMs / 1000)) }, { h: 'Event', f: (e) => `<b>${esc(e.name)}</b>` }, { h: 'Screen · level', f: (e) => esc([e.screen, e.level != null && `level ${e.level}`].filter(Boolean).join(' · ')) }, { h: 'Details', f: (e) => brief(e.props) }], t.events, 'No events.')}
      ${s.exit ? `<details open><summary class="meta">What was on screen when they left (the exit snapshot)</summary><pre>${esc(JSON.stringify(s.exit, null, 2))}</pre></details>` : '<div class="meta">No exit snapshot for this session.</div>'}`;
  }

  // ------------------------------------------------------------- events
  async function loadAnalyticsTab() {
    const product = productOf();
    shown = product;
    return product ? loadProduct(product) : loadOverview();
  }
  window.loadAnalyticsTab = loadAnalyticsTab;

  const body = $('#anBody');
  body.addEventListener('click', (e) => {
    const t = e.target;
    const jump = t.closest('[data-an-jump]');
    if (jump) { e.preventDefault(); document.getElementById(jump.dataset.anJump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (t.closest('[data-an-back]')) { e.preventDefault(); location.hash = '#analytics'; show('analytics'); return; }
    if (t.closest('[data-an-refresh]')) { loadAnalyticsTab(); return; }
    if (t.closest('a[download]')) return;
    const who = t.closest('[data-an-user]');
    if (who) { e.preventDefault(); F.user = who.dataset.anUser; openSession = null; loadAnalyticsTab(); return; }
    const open = t.closest('[data-an-open]');
    if (open) { show('analytics', open.dataset.anOpen); return; }
    const th = t.closest('#anLevels th[data-sort]');
    if (th && last) {
      levelSort = { key: th.dataset.sort, dir: levelSort.key === th.dataset.sort ? -levelSort.dir : -1 };
      body.innerHTML = render(shown, last);
      return;
    }
    const row = t.closest('[data-an-session]');
    if (row && shown) loadSession(shown, row.dataset.anSession);
  });
  body.addEventListener('change', (e) => {
    const f = e.target.dataset.anF;
    const b = e.target.dataset.anBuild;
    if (b) { cmp[b] = e.target.value; loadAnalyticsTab(); return; }
    if (!f) return;
    F[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (f === 'range' && F.range === 'custom' && !F.from) {
      F.from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      F.to = new Date().toISOString().slice(0, 10);
    }
    loadAnalyticsTab();
  });
  // The Analytics button goes back to every game (show() keeps #analytics/<product> otherwise).
  $('nav button[data-tab="analytics"]').addEventListener('click', () => { if (location.hash.startsWith('#analytics/')) location.hash = '#analytics'; }, true);
  // Back and forward between the overview and a game.
  addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#analytics')) return;
    if (tab !== 'analytics') return show('analytics', productOf());
    if (productOf() !== shown) loadAnalyticsTab();
  });
  // The stream's safety tick (every 60 s while the page is visible): only while this tab is on screen.
  studioStream.on('analytics', () => {
    if (tab !== 'analytics' || document.hidden || (body.contains(document.activeElement) && document.activeElement.matches('select, input'))) return;
    loadAnalyticsTab();
  });
})();
