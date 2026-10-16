// The Costs tab: what the studio costs (GET /api/costs). Money first (AWS, APIs), the forecast against J's budget,
// idle money and servers left running, Hawkes Gen's usage, Claude usage on the Max plan (not billed), per product.
// Uses app.js's helpers ($, esc, api, ago).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .co-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .co-tile { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
    .co-tile .k { color: var(--dim); font-size: 12px; } .co-tile .v { font-size: 24px; font-weight: 700; margin: 2px 0; } .co-tile .s { color: var(--dim); font-size: 12px; }
    .co-tile.bad { border-color: rgba(255,107,107,.5); } .co-tile.bad .v { color: var(--red); }
    .co-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 14px; }
    .co-box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
    .co-box h3 { margin: 0 0 8px; font-size: 15px; }
    .co-box table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .co-box td, .co-box th { padding: 4px 6px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    .co-box th { color: var(--dim); font-weight: 500; font-size: 12px; }
    .co-box td.n, .co-box th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .co-bars { display: flex; align-items: flex-end; gap: 2px; height: 120px; border-bottom: 1px solid var(--line); margin: 6px 0 4px; }
    .co-bars div { flex: 1; min-width: 3px; background: var(--accent); border-radius: 4px 4px 0 0; opacity: .85; }
    .co-bars div:hover { opacity: 1; outline: 2px solid var(--text); }
    .co-bars div.month { background: var(--blue); }
    .co-warn { color: var(--amber); } .co-red { color: var(--red); }
    @media (max-width: 700px) { .co-grid { grid-template-columns: 1fr; } }`;
  document.head.appendChild(css);

  const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  const tile = (k, v, s, bad) => `<div class="co-tile${bad ? ' bad' : ''}"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const rows = (list, cols) => list.map((x) => `<tr>${cols.map((c) => `<td class="${c.n ? 'n' : ''}">${c.f(x)}</td>`).join('')}</tr>`).join('');
  const table = (cols, list, empty) => (list.length ? `<table><tr>${cols.map((c) => `<th class="${c.n ? 'n' : ''}">${esc(c.h)}</th>`).join('')}</tr>${rows(list, cols)}</table>` : `<div class="meta">${esc(empty)}</div>`);
  let period = 'month';

  async function loadCosts(refresh = false) {
    const el = $('#costsBody');
    if (!el.innerHTML) el.innerHTML = '<div class="meta">Loading costs…</div>';
    const r = await api(`/api/costs?period=${period}${refresh ? '&refresh=1' : ''}`);
    const a = r.aws, t = r.totals, res = r.resources, c = r.claude, s = r.settings;
    const est = a.source === 'estimate';
    const thisMonth = new Date().toISOString().slice(0, 7);
    const pctBudget = s.budget ? Math.round((100 * t.forecast) / s.budget) : null;

    const tiles = [
      tile(`Spent ${r.period.label}`, usd(t.money), `AWS ${est ? 'about ' : ''}${usd(a.total)} · APIs ${usd(t.api)}`),
      tile('AWS this month', usd(a.month.soFar), est ? 'estimate (no Cost Explorer yet)' : `Cost Explorer · ${a.fetchedAt ? `updated ${ago(a.fetchedAt)}` : ''}`),
      tile('Forecast for the month', usd(t.forecast), s.budget ? `${pctBudget}% of the ${usd(s.budget)} budget` : 'no budget set', t.overBudget),
      tile('Idle money', `${usd(res.idlePerMonth)}<small style="font-size:13px">/mo</small>`, `${res.idle.length} item(s): disks, IPs, snapshots`, false),
      tile(c.plan === 'subscription' ? 'Claude (Max plan)' : 'Claude (API key)', usd(c.usage), c.plan === 'subscription' ? 'usage Claude Code reports, not billed' : `<span class="co-red">billed to the API key: ${usd(c.billed)}</span>`),
    ];
    if (t.subscriptionsPerMonth) tiles.push(tile('Subscriptions', `${usd(t.subscriptionsPerMonth)}<small style="font-size:13px">/mo</small>`, Object.entries(s.subscriptions).map(([k, v]) => `${esc(k)} ${usd(v)}`).join(' · ')));

    const alerts = [
      ...res.leftRunning.map((x) => `<div class="co-red">⚠ ${esc(x.name)} (${esc(x.type)}, ${esc(x.region)}) has run ${x.hours} h, about ${usd(x.hours * x.perHour)}. It should stop itself when idle.</div>`),
      ...a.otherRegions.map((x) => `<div class="co-warn">⚠ AWS charges in ${esc(x.region)} this month: ${usd(x.cost)} (nothing should run there).</div>`),
      ...r.notes.map((n) => `<div class="meta">${esc(n)}</div>`),
    ].join('');

    const max = Math.max(0.01, ...a.daily.map((d) => d.cost));
    const chart = a.daily.length
      ? `<div class="co-bars" role="img" aria-label="AWS cost per day">${a.daily.map((d) => `<div class="${d.date.slice(0, 7) === thisMonth ? 'month' : ''}" style="height:${Math.max(2, (100 * d.cost) / max)}%" title="${esc(d.date)}: ${usd(d.cost)}"></div>`).join('')}</div>
         <div class="meta">AWS per day, ${esc(a.daily[0].date)} to ${esc(a.daily.at(-1).date)} (this month in blue; hover a day). Highest day ${usd(max)}.${a.month.lastMonth !== null ? ` Last month: ${usd(a.month.lastMonth)}.` : ''}</div>`
      : '<div class="meta">Daily AWS costs need Cost Explorer (see the note below).</div>';

    const servers = table([
      { h: 'Server', f: (x) => `${esc(x.name)}<div class="meta">${esc(x.type)} · ${esc(x.region)}</div>` },
      { h: 'State', f: (x) => `<span class="pill ${x.state === 'running' ? 'warn' : ''}">${esc(x.state)}</span>${x.hours !== null ? ` ${x.hours} h` : ''}` },
      { h: 'While running', n: true, f: (x) => (x.perHour ? `${usd(x.perHour)}/h` : '') },
      { h: 'Disk', n: true, f: (x) => `${x.diskGb} GB · ${usd(x.diskPerMonth)}/mo` },
    ], res.servers, 'No servers found (or EC2 not reachable from here).');

    const idle = table([
      { h: 'What', f: (x) => `${esc(x.what)}${x.note ? `<div class="meta">${esc(x.note)}</div>` : ''}` },
      { h: 'Per month', n: true, f: (x) => usd(x.perMonth) },
    ], res.idle, 'No idle money found.');

    const awsBy = table([{ h: est ? 'Part (estimate)' : 'Part', f: (x) => esc(x.name) }, { h: 'This month', n: true, f: (x) => usd(x.cost) }], a.byComponent, 'Nothing yet.');
    const services = a.byService.length ? `<details><summary class="meta">By AWS service</summary>${table([{ h: 'Service', f: (x) => esc(x.name) }, { h: 'Cost', n: true, f: (x) => usd(x.cost) }], a.byService, '')}</details>` : '';

    const PROV = { 'aws-gpu': 'GPU servers (AWS)', 'aws-builder': 'Build server (AWS)', anthropic: 'Claude API (billed)', elevenlabs: 'ElevenLabs', comfy: 'ComfyUI', local: 'This server (free)' };
    const amt = (u, n) => (u === 'gpu_seconds' || u === 'seconds' ? `${(n / 3600).toFixed(1)} h` : `${Math.round(n).toLocaleString()} ${u === 'characters' ? 'chars' : u}`);
    const genT = r.gen.ok ? table([
      { h: 'Provider', f: (x) => esc(PROV[x.provider] ?? x.provider) }, { h: 'Used', n: true, f: (x) => amt(x.unit, x.amount) }, { h: 'Cost', n: true, f: (x) => usd(x.cost) },
    ], r.gen.byProvider, 'Nothing generated in this period.') : `<div class="meta co-red">${esc(r.gen.error ?? 'Hawkes Gen not reachable')}</div>`;

    const prod = table([
      { h: 'Product', f: (x) => `${esc(x.name)}${x.detail.length ? `<div class="meta">${x.detail.map(esc).join(' · ')}</div>` : ''}` },
      { h: 'GPU', n: true, f: (x) => (x.gpu ? usd(x.gpu) : '') },
      { h: 'Builds', n: true, f: (x) => (x.builder ? usd(x.builder) : '') },
      { h: 'Playtester', n: true, f: (x) => (x.playtester ? `${usd(x.playtester)}<div class="meta">${x.playtesterMinutes} min</div>` : '') },
      { h: 'APIs', n: true, f: (x) => (x.claudeApi + x.voice + x.otherGen ? usd(x.claudeApi + x.voice + x.otherGen) : '') },
      { h: 'Money', n: true, f: (x) => `<b>${usd(x.money)}</b>` },
      { h: 'Agents (not billed)', n: true, f: (x) => (x.agentRuns ? `${usd(x.agentUsage)}<div class="meta">${x.agentRuns} run(s)</div>` : '') },
    ], r.products, 'No product used anything in this period.');

    const claudeDays = c.perDay.length ? `<div class="meta">Per day: ${c.perDay.map((d) => `${esc(d.date.slice(5))} ${usd(d.usage)}`).join(' · ')}</div>` : '';

    el.innerHTML = `
      <div class="co-tiles">${tiles.join('')}</div>
      ${alerts ? `<div class="co-box" style="margin-bottom:14px">${alerts}</div>` : ''}
      <div class="co-grid">
        <div class="co-box"><h3>AWS ${est ? '(estimate)' : ''}</h3>${chart}${awsBy}${services}
          <div class="meta" style="margin-top:6px">${est ? 'An estimate: the fixed costs in docs/cloud.md prorated, plus the GPU and build-server time Hawkes Gen recorded.' : `Cost Explorer, cached about a day (each request costs $0.01; ${a.ceRequests} this month).`}</div></div>
        <div class="co-box"><h3>Per product (${esc(r.period.label)})</h3>${prod}
          <div class="meta" style="margin-top:6px">Shared, not per product: AWS ${usd(r.shared.awsUnattributed)} (control server, disks, S3, DNS, servers booting and idling). Playtester time is estimated from playtest jobs ($0.53/h).</div></div>
        <div class="co-box"><h3>Generation (Hawkes Gen)</h3>${genT}<div class="meta" style="margin-top:6px">GPU and build-server time are also in the AWS bill; Claude API and ElevenLabs are separate money.</div></div>
        <div class="co-box"><h3>Claude</h3>
          ${c.plan === 'subscription'
            ? `<p style="margin:0 0 6px">Talk, agents and scouts run on your <b>Max plan</b>: Claude Code reports <b>${usd(c.usage)}</b> of usage at API prices. <b>Not billed.</b></p>`
            : `<p class="co-red" style="margin:0 0 6px">No subscription token: Claude Code bills the API key, <b>${usd(c.billed)}</b> this period.</p>`}
          <table><tr><th></th><th class="n">Usage</th><th class="n">Billed</th></tr>
            <tr><td>Talk (${c.talk.turns} answers)</td><td class="n">${usd(c.talk.usage)}</td><td class="n">${usd(c.talk.billed)}</td></tr>
            <tr><td>Agents (${c.agents.runs} changes)</td><td class="n">${usd(c.agents.usage)}</td><td class="n">${usd(c.agents.billed)}</td></tr>
            <tr><td>Scouts (${c.scouts.runs})</td><td class="n">${usd(c.scouts.usage)}</td><td class="n">${usd(c.scouts.billed)}</td></tr>
            <tr><td>Claude API via Hawkes Gen (reviews, llm tools)</td><td class="n"></td><td class="n">${usd((r.gen.byProvider.find((x) => x.provider === 'anthropic') ?? {}).cost)}</td></tr></table>
          ${claudeDays}</div>
        <div class="co-box"><h3>Servers</h3>${servers}</div>
        <div class="co-box"><h3>Idle money: ${usd(res.idlePerMonth)}/month</h3>${idle}<div class="meta" style="margin-top:6px">Checked ${ago(res.at)} in ${esc(res.regions.join(', '))}. Studio only reads AWS: deleting anything is your call.</div></div>
      </div>`;
    $('#coBudget').textContent = s.budget ? `Budget ${usd(s.budget)}/month · alerts ${s.alerts ? 'on' : 'off'}` : 'No budget';
  }

  async function editSettings() {
    const s = await api('/api/costs/settings');
    const b = prompt('Monthly budget in USD for AWS and pay-per-use APIs (0 = none). Your phone hears about it when the forecast passes it.', String(s.budget));
    if (b === null) return;
    const h = prompt('Alert when a server runs longer than (hours): GPU, build server, playtester', `${s.gpuHours}, ${s.builderHours}, ${s.playtesterHours}`);
    if (h === null) return;
    const subs = prompt('Subscriptions to show with the totals (Studio can\'t see them), e.g. "Claude Max=100, ElevenLabs=22"', Object.entries(s.subscriptions).map(([k, v]) => `${k}=${v}`).join(', '));
    if (subs === null) return;
    const [gpuHours, builderHours, playtesterHours] = h.split(',').map((x) => Number(x.trim()));
    const subscriptions = Object.fromEntries(subs.split(',').map((x) => x.split('=').map((y) => y.trim())).filter(([k, v]) => k && Number(v) > 0).map(([k, v]) => [k, Number(v)]));
    await api('/api/costs/settings', { method: 'POST', body: { budget: Number(b), gpuHours, builderHours, playtesterHours, subscriptions } });
    await loadCosts();
  }

  $('#coPeriod').onchange = (e) => { period = e.target.value; loadCosts().catch((err) => ($('#costsBody').innerHTML = `<div class="co-red">${esc(err.message)}</div>`)); };
  $('#coRefresh').onclick = () => loadCosts(true).catch((err) => alert(err.message));
  $('#coSettings').onclick = () => editSettings().catch((err) => alert(err.message));
  $('#coAlerts').onclick = async () => {
    const s = await api('/api/costs/settings');
    await api('/api/costs/settings', { method: 'POST', body: { alerts: !s.alerts } });
    await loadCosts();
  };
  window.loadCosts = () => loadCosts().catch((err) => ($('#costsBody').innerHTML = `<div class="co-red">${esc(err.message)}</div>`));
})();
