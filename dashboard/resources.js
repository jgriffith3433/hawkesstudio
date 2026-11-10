// The Resources tab (GET /api/resources, src/resources.ts): what the studio runs on. One sentence and what needs action
// first, then tiles with the last hour's sparklines, and details on demand: memory and CPU per process group, the
// fleet (GPU servers, build server, playtester from Hawkes Gen), agents and the PM against their limits, Studio's event
// loop, and charts for the last hour, 24 h or 7 days. Redrawn when the stream says "resources" (every 30 s) and only
// while the tab is on screen. Uses app.js's helpers ($, esc, api, ago, tab, show).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .rs-head { font-size: 16px; margin: 0 0 10px; } .rs-head.bad { color: var(--red); } .rs-head.warn { color: var(--amber); }
    .rs-att { margin: 0 0 14px; padding: 0; list-style: none; } .rs-att li { padding: 4px 0; }
    .rs-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .rs-tile { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; min-width: 0; }
    .rs-tile .k { color: var(--dim); font-size: 12px; } .rs-tile .v { font-size: 22px; font-weight: 700; margin: 2px 0; } .rs-tile .s { color: var(--dim); font-size: 12px; }
    .rs-tile.bad { border-color: rgba(255,107,107,.5); } .rs-tile.warn { border-color: rgba(255,190,85,.5); }
    .rs-tile svg { display: block; width: 100%; height: 28px; margin-top: 4px; }
    .rs-box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 4px 14px; margin-bottom: 10px; min-width: 0; }
    .rs-box > summary { cursor: pointer; padding: 8px 0; font-weight: 600; } .rs-box > summary .meta { font-weight: 400; }
    .rs-box table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 8px; }
    .rs-box td, .rs-box th { padding: 4px 6px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    .rs-box th { color: var(--dim); font-weight: 500; font-size: 12px; } .rs-box td.n, .rs-box th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .rs-bar { height: 6px; background: var(--panel2); border-radius: 3px; margin-top: 3px; } .rs-bar > div { height: 6px; background: var(--accent); border-radius: 3px; }
    .rs-wrap { overflow-x: auto; }
    .rs-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; padding-bottom: 10px; }
    .rs-chart { position: relative; } .rs-chart h4 { margin: 0 0 2px; font-size: 13px; font-weight: 600; } .rs-chart .now { color: var(--dim); font-weight: 400; }
    .rs-chart svg { display: block; width: 100%; height: 120px; touch-action: none; }
    .rs-chart .tip { position: absolute; top: 18px; right: 0; font-size: 12px; color: var(--text); background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; pointer-events: none; }
    .rs-red { color: var(--red); } .rs-amber { color: var(--amber); }
    @media (max-width: 700px) { .rs-charts { grid-template-columns: 1fr; } .rs-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } .rs-hide-phone { display: none; } }`;
  document.head.appendChild(css);

  const MB = 1024 * 1024;
  const gb = (b) => (b == null ? '?' : b >= 10 * 1024 ** 3 ? `${Math.round(b / 1024 ** 3)} GB` : `${(b / 1024 ** 3).toFixed(1)} GB`);
  const mb = (b) => (b >= 1024 * MB ? gb(b) : `${Math.round(b / MB)} MB`);
  const rate = (b) => (b == null ? '…' : b < 1024 ? `${b} B/s` : b < MB ? `${Math.round(b / 1024)} KB/s` : `${(b / MB).toFixed(1)} MB/s`);
  const pc = (n) => (n == null ? '…' : `${Math.round(n)}%`);
  const dur = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 2 * 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);
  const level = (v, warn, bad) => (v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : '');
  let range = '1h';
  let last = null;

  /** A line of values over time in an SVG (0..max), the area under it faint. Single series: the title names it. */
  function line(points, key, { max = 100, h = 120, w = 600, area = true } = {}) {
    const pts = points.filter((p) => p[key] != null);
    if (pts.length < 2) return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
    const t0 = points[0].at, t1 = points.at(-1).at || t0 + 1;
    const top = Math.max(max, ...pts.map((p) => p[key]));
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
    const y = (v) => h - 2 - (v / top) * (h - 4);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${w}" y1="${y(top) + 1}" y2="${y(top) + 1}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <line x1="0" x2="${w}" y1="${h - 1}" y2="${h - 1}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${area ? `<path d="${d}L${x(pts.at(-1).at).toFixed(1)},${h}L${x(pts[0].at).toFixed(1)},${h}Z" fill="var(--accent)" opacity=".12"/>` : ''}
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <line class="cross" x1="0" x2="0" y1="0" y2="${h}" stroke="var(--dim)" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
    </svg>`;
  }

  const CHARTS = [
    ['cpu', 'CPU', (v) => pc(v), 100], ['mem', 'Memory used', (v) => pc(v), 100], ['disk', 'Fullest disk', (v) => pc(v), 100],
    ['load1', 'Load (1 min)', (v) => (v == null ? '…' : v.toFixed(2)), 1], ['swap', 'Swap used', (v) => pc(v), 10],
    ['agents', 'Agents’ memory (MB)', (v) => (v == null ? '…' : `${Math.round(v)} MB`), 100], ['studio', 'Studio’s memory (MB)', (v) => (v == null ? '…' : `${Math.round(v)} MB`), 100],
    ['gen', 'Hawkes Gen’s memory (MB)', (v) => (v == null ? '…' : `${Math.round(v)} MB`), 100],
    ['net_in', 'Network in', rate, 1024], ['net_out', 'Network out', rate, 1024],
  ];
  const when = (t) => new Date(t).toLocaleString([], range === '7d' ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

  function tiles(r) {
    const h = r.host, sp = (r.spark ?? r.history).points;
    const spark = (k, max) => line(sp, k, { max, h: 28, w: 200 });
    const out = [];
    if (h) {
      const disk = [...h.disks].sort((a, b) => b.pct - a.pct)[0];
      out.push(
        `<div class="rs-tile ${level(h.mem.pct, r.settings.memoryPct - 10, r.settings.memoryPct)}"><div class="k">Memory</div><div class="v">${pc(h.mem.pct)}</div><div class="s">${gb(h.mem.used)} of ${gb(h.mem.total)} · swap ${pc(h.swap.pct)}</div>${spark('mem', 100)}</div>`,
        `<div class="rs-tile ${level(h.cpu, 80, 95)}"><div class="k">CPU</div><div class="v">${pc(h.cpu)}</div><div class="s">load ${h.load.map((x) => x.toFixed(2)).join(' ')} · ${h.cpus} CPUs</div>${spark('cpu', 100)}</div>`,
        disk ? `<div class="rs-tile ${level(disk.pct, r.settings.diskPct - 10, r.settings.diskPct)}"><div class="k">Disk ${esc(disk.mount)}</div><div class="v">${pc(disk.pct)}</div><div class="s">${gb(disk.free)} free of ${gb(disk.size)}</div>${spark('disk', 100)}</div>` : '',
        `<div class="rs-tile"><div class="k">Network</div><div class="v" style="font-size:16px">↓ ${rate(h.net.inPerSec)}<br>↑ ${rate(h.net.outPerSec)}</div><div class="s">up ${dur(h.uptime)}</div></div>`,
      );
    }
    const w = r.work;
    if (w) out.push(`<div class="rs-tile ${w.agents.queued && w.agents.running >= w.agents.maxConcurrent ? 'warn' : ''}"><div class="k">Agents</div><div class="v">${w.agents.running} / ${w.agents.maxConcurrent}</div><div class="s">${w.agents.queued} queued · ${w.agents.waitingOnGen} waiting on Gen</div></div>`);
    const up = r.fleet.machines.filter((m) => m.state === 'running');
    const perHour = up.reduce((n, m) => n + (m.pricePerHour || 0), 0);
    out.push(`<div class="rs-tile ${r.fleet.alerts.length ? 'warn' : ''}"><div class="k">Machines running</div><div class="v">${r.fleet.ok ? up.length : '?'}</div><div class="s">${r.fleet.ok ? (up.length ? `$${perHour.toFixed(2)}/hr now` : 'nothing costing money') : 'Gen not answering'}</div></div>`);
    const lm = r.loop.lastMinute;
    out.push(`<div class="rs-tile ${r.loop.blocksLastHour ? 'warn' : ''}"><div class="k">Studio's event loop</div><div class="v">${lm ? `${lm.p99ms} ms` : '…'}</div><div class="s">p99 delay · ${r.loop.blocksLastHour} freeze(s) this hour</div></div>`);
    return `<div class="rs-tiles">${out.join('')}</div>`;
  }

  function groups(h) {
    if (!h) return '';
    const top = Math.max(1, ...h.groups.map((g) => g.mem));
    const rows = h.groups.map((g) => `<tr><td>${esc(g.name)}${g.detail ? `<div class="meta">${esc(g.detail)}</div>` : ''}<div class="rs-bar"><div style="width:${(100 * g.mem / top).toFixed(1)}%"></div></div></td>
      <td class="n">${mb(g.mem)}</td><td class="n">${pc(g.cpu)}</td><td class="n rs-hide-phone">${g.procs ?? ''}</td></tr>`).join('');
    const total = h.groups.reduce((n, g) => n + g.mem, 0);
    return `<details class="rs-box more-details" data-k="groups" data-key="rs:groups" open><summary>What uses memory and CPU <span class="meta">· ${h.groups.length} groups, ${mb(total)} of ${gb(h.mem.used)} used</span></summary>
      <table><tr><th>Group</th><th class="n">Memory</th><th class="n">CPU</th><th class="n rs-hide-phone">Processes</th></tr>${rows}</table>
      <div class="meta" style="margin-bottom:8px">Memory without the page cache (the kernel gives that back when asked). CPU is the share of one CPU over the last 30 s. The rest of the used memory is the system itself.</div></details>`;
  }

  function fleet(r) {
    const f = r.fleet;
    if (!f.ok) return `<details class="rs-box more-details" data-k="fleet" data-key="rs:fleet"><summary>Machines <span class="meta">· Hawkes Gen not answering</span></summary><p class="rs-amber">${esc(f.error)}</p></details>`;
    const left = (m) => {
      if (!m.idle) return '';
      if (m.idle.busy) return 'busy';
      const s = m.idle.stopsAt ? Math.round((m.idle.stopsAt - Date.now()) / 60000) : null;
      return `idle ${m.idle.minutes} min${s == null ? '' : s > 0 ? ` · ${m.idle.action} in ${s} min` : ' · <span class="rs-amber">past its stop time</span>'}`;
    };
    const rows = f.machines.map((m) => `<tr><td>${esc(m.name)}<div class="meta">${esc([m.type, m.region].filter(Boolean).join(' · '))}</div></td>
      <td><span class="pill ${m.state === 'running' ? 'warn' : ''}">${esc(m.state)}</span><div class="meta">${left(m)}</div></td>
      <td>${m.jobs.length ? m.jobs.map((j) => `${esc(j.tool)} <span class="meta">${esc(j.project)}</span>`).join('<br>') : '<span class="meta">nothing</span>'}</td>
      <td class="n">${m.pricePerHour ? `$${m.pricePerHour.toFixed(2)}/hr` : ''}</td></tr>`).join('');
    const up = f.machines.filter((m) => m.state === 'running').length;
    return `<details class="rs-box more-details" data-k="fleet" data-key="rs:fleet"${up ? ' open' : ''}><summary>Machines <span class="meta">· GPU servers, build server, playtester: ${up} running</span></summary>
      <div class="rs-wrap"><table><tr><th>Machine</th><th>State</th><th>Doing</th><th class="n">Costs</th></tr>${rows || '<tr><td colspan="4" class="meta">None found.</td></tr>'}</table></div>
      <div class="meta" style="margin-bottom:8px">From Hawkes Gen's last reading (its Machines page measures them every minute). Each one stops itself when idle; Gen starts and stops them.</div></details>`;
  }

  function outside(r) {
    const x = r.external;
    if (!x) return '';
    const p = x.portal.last, d = x.details;
    const okp = (q) => (q.ok ? '<span class="pill">up</span>' : '<span class="pill warn">down</span>');
    const rows = [
      `<tr><td>Portal <span class="meta">${esc(x.portal.url || '')}/v1/health</span></td><td>${p ? okp(p) : '…'}</td><td class="n">${p ? `${p.ms} ms` : ''}</td><td class="meta">${p ? esc(p.ok ? ago(p.at) : `${p.status ? `HTTP ${p.status}` : p.error ?? ''} · ${ago(p.at)}`) : 'not probed yet'}</td></tr>`,
      d.state === 'ok' && d.data
        ? `<tr><td>Portal details <span class="meta">/v1/health/details</span></td><td><span class="pill">ok</span></td><td class="n">${d.data.p99ms == null ? '' : `p99 ${Math.round(d.data.p99ms)} ms`}</td><td class="meta">${d.data.sockets == null ? '' : `sockets ${d.data.sockets}${d.data.cap ? ` of ${d.data.cap}` : ''} · `}${d.data.lastBackup ? `backup ${ago(d.data.lastBackup)}` : 'no backup time'}</td></tr>`
        : `<tr><td>Portal details <span class="meta">/v1/health/details</span></td><td>${d.state === 'failed' ? '<span class="pill warn">failed</span>' : '<span class="meta">skipped</span>'}</td><td></td><td class="meta">${esc(d.note ?? '')}</td></tr>`,
      ...x.nodes.list.map((n) => `<tr><td>Relay node ${esc(n.id)} <span class="meta">${esc(n.url)}</span></td><td>${okp(n.last)}</td><td class="n">${n.last.ms} ms</td><td class="meta">${n.players == null ? '' : `${n.players}${n.capacity ? ` of ${n.capacity}` : ''} players`}</td></tr>`),
    ].join('');
    const down = (p && !p.ok) || x.nodes.list.some((n) => !n.last.ok);
    return `<details class="rs-box more-details" data-k="outside" data-key="rs:outside"${down ? ' open' : ''}><summary>Outside: the portal and relay nodes <span class="meta">· ${down ? 'something is down' : x.nodes.list.length ? `portal and ${x.nodes.list.length} node(s) up` : p ? 'portal up' : 'not probed yet'}</span></summary>
      <div class="rs-wrap"><table><tr><th>Target</th><th>State</th><th class="n">Time</th><th>Detail</th></tr>${rows}</table></div>
      <div class="meta" style="margin-bottom:8px">Probed every minute. Details need a portal admin key in Studio's secrets (HAWKES_PORTAL_ADMIN_KEY); relay nodes come from Hawkes Net (net.hawkesgen.ai/v1/net/nodes).${x.nodes.state === 'failed' ? ` <span class="rs-amber">Node list failed: ${esc(x.nodes.note ?? '')}</span>` : ''}</div></details>`;
  }

  // Hawkes Net, the multiplayer box: what is happening on it (players, rooms per project, its workers, usage).
  function netbox(r) {
    const n = r.net;
    if (!n) return '';
    if (!n.ok) return `<details class="rs-box more-details" data-k="net" data-key="rs:net" open><summary>Hawkes Net <span class="meta">· not answering</span></summary><p class="rs-red">${esc(n.error)}</p></details>`;
    const players = (n.nodes ?? []).reduce((s, x) => s + (x.players || 0), 0);
    const cap = (n.nodes ?? []).reduce((s, x) => s + (x.capacity || 0), 0);
    const e = n.extra ?? null, nd = n.node ?? null;
    const gb = (v) => (v >= 1 ? `${v.toFixed(2)} GB` : `${Math.round(v * 1024)} MB`);
    const projects = (n.rooms ?? []).map((p) => `<tr><td>${esc(p.project)}</td><td>${p.transport === 'relay' ? '<span class="pill">relay</span>' : '<span class="meta">peer to peer</span>'}</td><td class="n">${p.rooms}</td><td class="n">${p.players}</td></tr>`).join('');
    const workers = (nd?.workers ?? []).map((w, i) => `<tr><td>worker ${i}</td><td class="n">${w.rooms ?? 0}</td><td class="n">${w.players ?? 0}</td><td class="n">${w.cpu == null ? '' : `${Math.round(w.cpu * 100)}%`}</td><td class="n">${w.lagP99 == null ? '' : `${w.lagP99} ms`}</td></tr>`).join('');
    const usage = e ? (e.sinceStart?.perProject ?? []).filter((p) => p.playerMinutes >= 0.1).sort((a, b) => b.gbOut - a.gbOut).slice(0, 12).map((p) => `<tr><td>${esc(p.project)}</td><td>${esc(p.transport)}</td><td class="n">${p.playerMinutes.toFixed(1)}</td><td class="n">${gb(p.gbOut)}</td></tr>`).join('') : '';
    return `<details class="rs-box more-details" data-k="net" data-key="rs:net"${n.up ? '' : ' open'}><summary>Hawkes Net <span class="meta">· ${n.up ? `${players} player${players === 1 ? '' : 's'} on ${(n.nodes ?? []).length} node${(n.nodes ?? []).length === 1 ? '' : 's'}${cap ? ` (room for ${cap})` : ''}` : 'no node up'}</span></summary>
      <p style="margin:4px 0"><a href="${esc(n.url)}/" target="_blank" rel="noopener">${esc(n.url.replace(/^https?:\/\//, ''))}</a> · version ${esc(n.version ?? '?')}${e ? ` · up ${Math.round(e.uptimeS / 3600)} h · ${e.usageWaiting} usage report${e.usageWaiting === 1 ? '' : 's'} waiting for Gen · since start ${e.sinceStart.playerMinutes.toFixed(0)} player-minutes, ${gb(e.sinceStart.gbOut)} sent` : ''}</p>
      ${projects ? `<div class="rs-wrap"><table><tr><th>Project (last 10 min)</th><th>Transport</th><th class="n">Rooms</th><th class="n">Players</th></tr>${projects}</table></div>` : '<p class="meta">No rooms in the last 10 minutes.</p>'}
      ${workers ? `<div class="rs-wrap"><table><tr><th>Relay process</th><th class="n">Rooms</th><th class="n">Players</th><th class="n">CPU</th><th class="n">Lag p99</th></tr>${workers}</table></div>` : ''}
      ${usage ? `<div class="rs-wrap"><table><tr><th>Usage since start</th><th>Transport</th><th class="n">Player-min</th><th class="n">Sent</th></tr>${usage}</table></div>` : ''}
      <div class="meta" style="margin-bottom:8px">${n.full ? 'From its operator view, read with the Gen key Studio holds.' : 'Public status only: the Gen key Studio holds is not an owner or admin key.'} Down or full: the line above and a phone note. Logs: <code>journalctl -u hawkes-net</code> on the box.</div></details>`;
  }

  // What each AI provider is running now, and on which model: what the harness itself reported, else (asked) the model the
  // run asked for and the harness hasn't confirmed yet (runs.ts).
  const PROVIDER = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini', antigravity: 'Antigravity' };
  const KIND = { agent: 'agent', scout: 'scout', talk: 'Talk', pm: 'PM', review: 'PM or reviewer' };
  function providersNow(r) {
    const w = r.work;
    if (!w || !w.runs) return '';
    const mins = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : `${m} min`; };
    const model = (x) => x.model ? `${esc(x.model)}${x.reported ? '' : ' <span class="meta" title="the model it asked for; the harness hasn\'t said yet">(asked)</span>'}` : '<span class="meta">not reported yet</span>';
    const load = w.providers.map((p) => `<span class="pill" title="${esc(Object.entries(p.models).map(([m, n]) => `${n} on ${m}`).join(', '))}">${esc(PROVIDER[p.harness] ?? p.harness)} · ${p.running} running (${esc(Object.entries(p.kinds).map(([k, n]) => `${n} ${KIND[k] ?? k}`).join(', '))})</span>`).join(' ');
    const rows = w.runs.map((x) => `<tr><td>${x.change ? `<a href="#changes/${esc(x.change)}">${esc(x.title || x.change)}</a>` : esc(x.title || KIND[x.kind] || x.kind)}<div class="meta">${esc(KIND[x.kind] ?? x.kind)}${x.product ? ` · ${esc(x.product)}` : ''}${x.change ? ` · ${esc(x.change)}` : ''}</div></td><td>${esc(PROVIDER[x.harness] ?? x.harness)}</td><td>${model(x)}</td><td class="n">${mins(x.since)}</td></tr>`).join('');
    const bad = (w.mismatches ?? []).map((m) => `<p class="rs-red" style="margin:4px 0">${esc(m.text)}</p>`).join('');
    return `<details class="rs-box more-details" data-k="providers" data-key="rs:providers" open><summary>AI providers now <span class="meta">· ${w.runs.length} run${w.runs.length === 1 ? '' : 's'} going</span></summary>
      ${bad}<p style="margin:4px 0">${load || '<span class="meta">Nothing running on any provider.</span>'}</p>
      ${rows ? `<table><tr><th>Run</th><th>Provider</th><th>Model</th><th class="n">For</th></tr>${rows}</table>` : ''}</details>`;
  }

  function work(r) {
    const w = r.work;
    if (!w) return '';
    const a = w.agents;
    const limits = Object.entries(a.productLimits ?? {}).map(([p, n]) => `${esc(p)} ${n}`).join(', ');
    const list = a.list.map((c) => {
      const b = c.harness_label || c.harness ? ` · ${esc(c.harness_label || c.harness)}${c.model ? ` (${esc(c.model)}${c.model_reported ? '' : ', asked'})` : ''}` : '';
      return `<tr><td>${esc(c.title)}<div class="meta">${esc(c.product)} · ${esc(c.id)}${b}</div></td><td>${esc(c.status)}</td></tr>`;
    }).join('');
    return `<details class="rs-box more-details" data-k="work" data-key="rs:work"><summary>Agents, the PM and Gen's queue <span class="meta">· ${a.running} of ${a.maxConcurrent} agents working</span></summary>
      <p style="margin:4px 0">Agents: <b>${a.running}</b> working of <b>${a.maxConcurrent}</b> at once (${a.perProduct} per product${limits ? `; ${limits}` : ''}), ${a.queued} queued, ${a.waitingOnGen} waiting on Gen${a.enabled ? '' : ' · <span class="rs-amber">agents are off</span>'}.</p>
      ${w.pm ? `<p style="margin:4px 0">The PM: ${w.pm.enabled ? 'on' : '<span class="rs-amber">paused</span>'}, ${w.pm.active} working of ${w.pm.maxConcurrent}, ${w.pm.started} of ${w.pm.maxStartsPerDay} starts used today.</p>` : ''}
      <p style="margin:4px 0">Hawkes Gen's jobs: ${w.jobs.ok ? `${w.jobs.running} running, ${w.jobs.queued} queued` : 'unknown (Gen not answering)'}.</p>
      ${list ? `<table><tr><th>Change</th><th>Status</th></tr>${list}</table>` : ''}</details>`;
  }

  function loop(r) {
    const l = r.loop, lm = l.lastMinute;
    const blocks = l.blocks.map((b) => `<tr><td>${esc(ago(b.at))}</td><td class="n">${b.ms} ms</td><td>${esc(b.running.join('; ') || 'nothing tracked')}</td></tr>`).join('');
    const cmds = r.commands.map((c) => `<tr><td>${esc(c.cmd)}<div class="meta">${esc(c.cwd)}</div></td><td class="n">${c.seconds} s</td></tr>`).join('');
    return `<details class="rs-box more-details" data-k="loop" data-key="rs:loop"><summary>Studio's own health <span class="meta">· ${l.blocksLastHour} freeze(s) over a second this hour</span></summary>
      <p style="margin:4px 0">${lm ? `Last minute: delay p50 ${lm.p50ms} ms, p99 ${lm.p99ms} ms, worst ${lm.maxms} ms.` : 'Not measured yet.'}</p>
      ${blocks ? `<table><tr><th>When</th><th class="n">Froze</th><th>Running then</th></tr>${blocks}</table>` : ''}
      ${cmds ? `<table><tr><th>Command Studio is waiting on</th><th class="n">For</th></tr>${cmds}</table>` : '<p class="meta">No commands running.</p>'}</details>`;
  }

  // The self-healing supervisor (src/selfheal.ts): each check, its last breach and what Studio did about it.
  function selfheal(r) {
    const h = r.selfheal;
    if (!h) return '';
    const broken = h.invariants.filter((i) => i.since);
    const rows = h.invariants.map((i) => `<tr class="${i.failing ? 'rs-red' : i.since ? 'rs-amber' : ''}"><td>${esc(i.label)}</td><td>${i.since ? `broken ${i.breachedMin} min<div class="meta">${esc(i.detail ?? '')}</div>` : i.lastBreach ? `holds · last broken ${esc(ago(i.lastBreach))}` : 'holds'}</td><td>${i.did ? `${esc(i.did)}<div class="meta">${esc(ago(i.didAt))}</div>` : '<span class="meta">nothing needed</span>'}${i.escalated ? `<div class="meta">fix filed: ${esc(i.escalated)}</div>` : ''}</td></tr>`).join('');
    const log = h.log.slice(0, 12).map((l) => `<tr><td>${esc(ago(l.at))}</td><td>${esc(l.key)}</td><td>${esc(l.kind)}</td><td>${esc(l.detail ?? '')}</td></tr>`).join('');
    return `<details class="rs-box more-details" data-k="selfheal" data-key="rs:selfheal"${broken.length ? ' open' : ''}><summary>Self-healing <span class="meta">· ${h.ok ? (broken.length ? `${broken.length} being fixed` : 'every check holds') : '<span class="rs-red">something it could not fix</span>'} · last look ${h.lastLook ? esc(ago(h.lastLook)) : 'not yet'}</span></summary>
      <table><tr><th>Check</th><th>Now</th><th>What Studio did</th></tr>${rows}</table>
      ${log ? `<table><tr><th>When</th><th>Check</th><th>What</th><th>Detail</th></tr>${log}</table>` : '<p class="meta">Nothing to record yet.</p>'}</details>`;
  }

  function charts(r) {
    const pts = r.history.points;
    const box = CHARTS.map(([k, name, fmt, max]) => {
      const lastV = [...pts].reverse().find((p) => p[k] != null)?.[k];
      return `<div class="rs-chart" data-key="${k}"><h4>${esc(name)} <span class="now">${fmt(lastV)}</span></h4>${line(pts, k, { max })}<span class="tip" hidden></span></div>`;
    }).join('');
    return `<details class="rs-box more-details" data-k="charts" data-key="rs:charts"><summary>History <span class="meta">· the last ${range === '1h' ? 'hour' : range === '24h' ? '24 hours' : '7 days'}</span></summary>
      <div class="bar" style="margin:0 0 8px">${['1h', '24h', '7d'].map((x) => `<button class="small${x === range ? ' on' : ''}" data-rs-range="${x}">${x === '1h' ? 'Hour' : x === '24h' ? '24 h' : '7 days'}</button>`).join(' ')}
        <span class="meta">${pts.length ? `${pts.length} points, ${r.history.bucketSeconds >= 60 ? `${Math.round(r.history.bucketSeconds / 60)} min` : `${r.history.bucketSeconds} s`} each` : 'No samples yet: one is taken every 30 s.'}</span></div>
      <div class="rs-charts">${box}</div></details>`;
  }

  async function loadResources() {
    const el = $('#rsBody');
    if (!el.innerHTML) el.innerHTML = '<div class="meta">Reading the server…</div>';
    const r = await api(`/api/resources?range=${range}`);
    last = r;
    // What J opened stays open across redraws (every 30 s).
    const open = new Map([...el.querySelectorAll('details[data-k]')].map((d) => [d.dataset.k, d.open]));
    const worst = r.attention[0]?.level ?? '';
    studioPatch(el, `<p class="rs-head ${worst}">${worst === 'bad' ? '⚠ ' : ''}${esc(r.headline)}</p>
      ${r.attention.length > 1 ? `<ul class="rs-att">${r.attention.slice(1).map((a) => `<li class="${a.level === 'bad' ? 'rs-red' : 'rs-amber'}">${a.level === 'bad' ? '⚠' : '•'} ${esc(a.text)}</li>`).join('')}</ul>` : ''}
      ${tiles(r)}${groups(r.host)}${outside(r)}${netbox(r)}${fleet(r)}${providersNow(r)}${work(r)}${selfheal(r)}${loop(r)}${charts(r)}
      <div class="meta">Read ${ago(r.at)}${r.host ? ` in ${r.host.sampleMs} ms` : ''}. Phone alerts: ${r.settings.alerts ? `memory or disk over ${r.settings.memoryPct}% / ${r.settings.diskPct}% for ${r.settings.minutes} min, a machine idle ${r.settings.pastStopMinutes} min past its stop time, the portal failing ${r.settings.portalMinutes} min, event-loop p99 over ${r.settings.loopP99Ms} ms for ${r.settings.loopMinutes} min, WebSockets over ${r.settings.wsPct}%, a backup older than ${r.settings.backupHours} h, a relay node down` : 'off'} (<a href="#settings" data-rs-go="settings">Settings</a>).</div>`);
    for (const [k, o] of open) { const d = el.querySelector(`details[data-k="${k}"]`); if (d) d.open = o; }
  }

  // The charts' hover: a crosshair and the value at that time.
  function hover(e) {
    const c = e.target.closest?.('.rs-chart');
    if (!c || !last) return;
    const svg = c.querySelector('svg'), tip = c.querySelector('.tip'), cross = svg.querySelector('.cross');
    const pts = last.history.points;
    if (!pts.length || !cross) return;
    const box = svg.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
    const t = pts[0].at + f * (pts.at(-1).at - pts[0].at);
    const p = pts.reduce((a, b) => (Math.abs(b.at - t) < Math.abs(a.at - t) ? b : a));
    const [, , fmt] = CHARTS.find((x) => x[0] === c.dataset.key);
    const x = ((p.at - pts[0].at) / Math.max(1, pts.at(-1).at - pts[0].at)) * 600;
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${when(p.at)}: ${fmt(p[c.dataset.key])}`;
  }
  document.addEventListener('pointermove', (e) => { if (tab === 'resources') hover(e); });
  document.addEventListener('pointerleave', (e) => {
    const c = e.target.closest?.('.rs-chart');
    if (!c) return;
    c.querySelector('.tip').hidden = true;
    c.querySelector('.cross')?.setAttribute('visibility', 'hidden');
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-rs-range]');
    if (b) { range = b.dataset.rsRange; window.loadResourcesTab(); }
    const g = e.target.closest?.('[data-rs-go]');
    if (g) { e.preventDefault(); show(g.dataset.rsGo); }
  });

  window.loadResourcesTab = () => loadResources().catch((err) => ($('#rsBody').innerHTML = `<div class="rs-red">${esc(err.message)}</div>`));
  // A new sample every 30 s (stream.js), redrawn only while the tab is on screen.
  studioStream.on('resources', () => { if (tab === 'resources') window.loadResourcesTab(); });
  // Opened straight on #resources: app.js's first refresh ran before this file loaded.
  if (tab === 'resources') window.loadResourcesTab();
})();
