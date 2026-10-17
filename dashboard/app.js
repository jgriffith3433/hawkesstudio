// Hawkes Studio dashboard: plain JS over /api (and Hawkes Gen's /v1/files for screenshots and videos).
let GEN = 'http://127.0.0.1:8790';
// On the server, Hawkes Gen is at its public address.
fetch('/api/config').then((r) => r.json()).then((c) => { if (c.genUrl) GEN = c.genUrl; }).catch(() => {});
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const file = (asset) => `${GEN}/v1/files/${asset}`;
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const icon = (s) => ({ done: '✅', failed: '❌', skipped: '⏭️', running: '⏳' })[s] ?? '•';

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  // Signed out (the session expired, or the password must be set first): back to the sign-in page, then here again.
  if ((r.status === 401 || r.status === 403) && /json/.test(r.headers.get('content-type') ?? '')) {
    const e = await r.clone().json().catch(() => ({}));
    if (e.signin) {
      location.href = `${e.signin}?next=${encodeURIComponent(location.href)}`;
      throw new Error('Signing in again…');
    }
  }
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? r.status);
  return d;
}

// ------------------------------------------------------------- tabs
let tab = location.hash.slice(1).split('/')[0] || 'inbox';
function show(t, sub) {
  tab = t;
  // #changes/<id> (a link from the Activity panel) stays.
  if (!sub && t === 'changes' && location.hash.startsWith('#changes/')) sub = location.hash.slice(t.length + 2);
  location.hash = sub ? `${t}/${sub}` : t;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === t));
  if (picked?.tab !== t) picked = null;
  dispatchEvent(new CustomEvent('studio-tab', { detail: t })); // the Talk dock follows (talk.js)
  refresh();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => show(b.dataset.tab)));

// ------------------------------------------------- what J looks at
// Sent with each message from the Talk dock (talk.js), so "this one" means the change, finding, report, playtest or
// item J last clicked on the tab, or what the tab has open.
let picked = null;
const PICK = [['cid', 'change'], ['change', 'change'], ['fid', 'finding'], ['finding', 'finding'], ['ib', 'inbox card'], ['item', 'roadmap item'], ['thread', 'roadmap item'], ['task', 'task'], ['ms', 'milestone'], ['mem', 'memory entry'], ['run', 'run'], ['reportRun', 'run'], ['p', 'product']];
const pickIn = (box) => {
  for (const [a, kind] of PICK) {
    const key = `[data-${a.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
    const n = box.matches(key) ? box : box.querySelector(key);
    if (n) return { kind, id: n.dataset[a] };
  }
  return null;
};
document.querySelector('main').addEventListener('click', (e) => {
  const boxes = '.finding, .card, .ib-card, .run-row, .test, .review';
  let box = e.target.closest(boxes);
  let p = null;
  while (box && !(p = pickIn(box))) box = box.parentElement?.closest(boxes);
  // The title only: without its pills and meta line.
  const h = box?.querySelector('h4, h3, b')?.cloneNode(true);
  h?.querySelectorAll('.pill, .meta, small').forEach((n) => n.remove());
  if (p) picked = { tab, ...p, label: (h?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) };
}, true);
function studioContext() {
  if (tab === 'talk') return null;
  const name = document.querySelector(`nav button[data-tab="${tab}"]`)?.firstChild?.textContent.trim() ?? tab;
  const hashId = location.hash.split('/')[1];
  let it = picked?.tab === tab ? picked : null;
  if (tab === 'playtests' && typeof pt !== 'undefined' && pt.open) it = { kind: 'playtest', id: pt.open, label: $('#ptDetail .pt-title')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) };
  if (!it && tab === 'changes' && hashId) it = { kind: 'change', id: hashId };
  if (!it && tab === 'report' && $('#reportRun').value) it = { kind: 'report of run', id: $('#reportRun').value };
  if (!it && tab === 'runs' && openRun) it = { kind: 'run', id: openRun };
  return { tab: name, kind: it?.kind, id: it?.id, label: it?.label };
}

// ----------------------------------------------------------- viewer
function view(html) {
  $('#viewer .content').innerHTML = html;
  $('#viewer').hidden = false;
}
$('#viewer').onclick = (e) => { if (e.target.id === 'viewer' || e.target.classList.contains('close')) { $('#viewer').hidden = true; $('#viewer .content').innerHTML = ''; } };
document.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-full]');
  if (img) view(`<img src="${img.dataset.full}">`);
  const vid = e.target.closest('[data-video]');
  if (vid && !(e.ctrlKey || e.metaKey || e.shiftKey || e.button)) { e.preventDefault(); view(`<video src="${vid.dataset.video}" controls autoplay></video>`); }
});

// ------------------------------------------------------------ today
let overview = null;
async function loadToday() {
  overview = await api('/api/overview');
  const pv = await api('/api/previews').catch(() => ({ previews: [] }));
  const dv = await api('/api/dev').catch(() => ({ dev: [] }));
  for (const p of overview.products) {
    p.preview = pv.previews.find((x) => x.product === p.id);
    p.dev = dv.dev.find((x) => x.product === p.id);
  }
  const o = overview;
  const b = o.builder;
  $('#status').innerHTML = [
    `<span><span class="dot ${o.gen ? 'ok' : 'bad'}"></span>Hawkes Gen</span>`,
    b && b.exists ? `<span><span class="dot ${b.state === 'running' ? 'ok' : b.state === 'stopped' ? '' : 'warn'}"></span>Build server: ${esc(b.state)}${b.stage ? ` · ${esc(b.stage.stage)}` : ''}</span>` : '<span><span class="dot"></span>No build server</span>',
    o.run ? `<span><span class="dot warn"></span>Run ${esc(o.run.id)}: ${esc(o.run.detail)}</span>` : '',
  ].join('');
  $('#runInfo').textContent = o.run ? `A run is going (${o.run.id}).` : o.runs[0] ? `Last run ${ago(o.runs[0].started)}: ${o.runs[0].status}${o.runs[0].detail ? ` · ${o.runs[0].detail}` : ''}` : 'No runs yet.';
  $('#runDaily').disabled = $('#runSmoke').disabled = Boolean(o.run);
  $('#cards').innerHTML = o.products.map(card).join('');
}

/** Beta, live and devtools links, and how developing on beta stands (dev.ts): the dev server and the working copy. */
function devLine(p) {
  const d = p.dev;
  const beta = p.preview ? `<a href="${esc(p.preview.play)}" target="_blank" title="${esc(p.preview.beta ? `the beta branch: ${p.preview.beta.status} ${ago(p.preview.beta.at)}${p.preview.beta.sha ? ` · ${p.preview.beta.sha}` : ''}${p.preview.beta.detail ? ` · ${p.preview.beta.detail}` : ''}` : 'not built yet')}">Beta</a>` : '';
  const links = [beta, `<a href="${esc(p.live)}" target="_blank">Live</a>`, d?.url ? `<a href="${esc(d.url)}" target="_blank" title="${d.unity ? 'Unity: how to open the editor on the build server' : "The product's devtools on the cloud server, in beta's working copy. Saves commit to beta."}">Open devtools</a>` : ''].filter(Boolean).join(' · ');
  if (!d) return `<div class="meta">${links}</div>`;
  const parts = [];
  if (d.server) {
    const s = d.server;
    parts.push(s.status === 'running' ? `<span title="${esc(s.detail ?? '')}">dev server running · used ${ago(s.lastUsed)}</span>` : s.status === 'starting' ? `dev server starting · ${esc(s.detail ?? '')}` : s.status === 'failed' ? `<span style="color:var(--red)" title="${esc(s.detail ?? '')}">dev server failed</span>` : `dev server stopped${s.lastUsed ? ` · last used ${ago(s.lastUsed)}` : ''}`);
  }
  if (d.copy) parts.push(`<span title="${esc((d.copy.files ?? []).join('\n'))}">working copy: ${d.copy.uncommitted} uncommitted · ${d.copy.unpushed} unpushed${d.lastPush ? ` · pushed ${ago(d.lastPush.at)}` : ''}</span>`);
  const conflict = d.conflict ? `<div class="meta" style="color:var(--red)">Beta conflict (${esc(d.conflict.during)}): ${esc(d.conflict.files.join(', '))}. Auto-commit is off. <button class="small" data-dev="retry" data-p="${p.id}">Retry</button> <button class="small" data-dev="keep-beta" data-p="${p.id}" title="The working copy's commits are saved on a devtools-conflict branch first">Keep beta's version</button></div>` : '';
  const stop = d.server?.status === 'running' ? ` <button class="small" data-dev="stop" data-p="${p.id}">Stop dev server</button>` : '';
  return `<div class="meta">${links}${parts.length ? ` — ${parts.join(' · ')}` : ''}${stop}</div>${conflict}`;
}

function card(p) {
  const r = p.lastReview?.data;
  const open = Object.entries(p.open).map(([k, n]) => `<span class="pill ${k}">${n} ${k}</span>`).join(' ');
  const shots = (r?.frames ?? []).slice(0, 8).map((f) => `<img loading="lazy" src="${file(f.asset)}" data-full="${file(f.asset)}" title="${esc(f.t)}s ${esc(f.scene ?? '')}">`).join('');
  const tests = p.playtests.map((t) => {
    const s = t.playtest;
    const v = t.review?.data?.verdict;
    return `<div class="test"><span>${s ? icon(s.status) : '·'}</span><span class="name">${esc(t.name)}</span><span class="detail" title="${esc(s?.detail ?? '')}">${s ? `${esc(s.detail ?? '')} · ${ago(s.finished)}` : 'not run yet'}</span>${v ? `<span class="pill ${v}">${v}</span>` : ''}${s?.data?.video ? `<a href="${file(s.data.video)}" target="_blank" rel="noopener" data-video="${file(s.data.video)}">▶</a>` : ''}</div>`;
  }).join('');
  const build = p.build ? `<div class="test"><span>${icon(p.build.status)}</span><span class="name">unity build</span><span class="detail">${esc(p.build.detail ?? '')} · ${ago(p.build.finished)}</span></div>` : '';
  const scores = r?.scores ? `<div class="scores">${Object.entries(r.scores).map(([k, n]) => `<div class="score"><b>${n}</b><span>${k}</span></div>`).join('')}</div>` : '';
  const git = `${p.git.dirty} uncommitted · ${p.git.ahead} unpushed${p.site ? ` · site ${p.site.dirty}/${p.site.ahead}` : ''}`;
  return `<div class="card">
    <h3>${esc(p.name)} <small>${esc(p.framing)}</small>${r ? `<span class="pill verdict ${r.verdict}">${r.verdict}</span>` : ''}</h3>
    <div class="meta">${esc(git)} · <a href="${esc(p.local)}" target="_blank">local</a>${p.preview ? p.preview.changes.filter((c) => c.status === 'ready').map((c) => ` · <a href="${esc(c.play)}" target="_blank" title="agent change ${esc(c.id)}">${esc(c.id)}</a>`).join('') : ''}</div>
    ${devLine(p)}
    ${scores}
    ${r?.summary ? `<div class="summary">${esc(r.summary)}</div>` : ''}
    <div class="tests">${build}${tests}</div>
    ${shots ? `<div class="thumbs">${shots}</div>` : ''}
    <div class="meta">${open || 'No open findings'}</div>
    <div class="actions">
      <button class="small" data-act="playtest" data-p="${p.id}">Smoke test</button>
      <button class="small" data-act="all" data-p="${p.id}">Full trial</button>
      ${p.engine === 'unity' ? `<button class="small" data-act="build" data-p="${p.id}">Build</button>` : ''}
      <button class="small" data-act="backlog" data-p="${p.id}">Backlog</button>
      <button class="small primary" data-act="deploy" data-p="${p.id}" data-guide="off">Go live…</button>
    </div>
  </div>`;
}

$('#cards').addEventListener('click', async (e) => {
  const dev = e.target.closest('button[data-dev]');
  if (dev) {
    try {
      const act = dev.dataset.dev;
      if (act === 'stop') await api(`/api/dev/${dev.dataset.p}/stop`, { method: 'POST', body: {} });
      else {
        if (act === 'keep-beta' && !confirm("Keep beta's version? The working copy's devtools commits are saved on a devtools-conflict branch, then it goes back to beta.")) return;
        await api(`/api/dev/${dev.dataset.p}/resolve`, { method: 'POST', body: { action: act } });
      }
      await loadToday();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const p = btn.dataset.p;
  try {
    if (btn.dataset.act === 'playtest') await api('/api/playtest', { method: 'POST', body: { product: p, scenario: undefined } });
    if (btn.dataset.act === 'all') await api('/api/runs', { method: 'POST', body: { products: [p], noBuild: $('#optNoBuild').checked, where: $('#optLocal').checked ? 'local' : undefined } });
    if (btn.dataset.act === 'build') await api('/api/build', { method: 'POST', body: { product: p } });
    if (btn.dataset.act === 'backlog') { $('#blProduct').value = p; return show('backlog'); }
    if (btn.dataset.act === 'deploy') return goLive(p);
    await loadToday();
  } catch (err) {
    alert(err.message);
  }
});
// ---------------------------------------------------------- go live
// The plan (beta vs main, what was playtested), then a typed confirmation: main is fast-forwarded to the tested beta.
const box = (html) => `<div class="golive" style="background:var(--panel);padding:18px;border-radius:10px;max-width:780px;max-height:85vh;overflow:auto">${html}</div>`;
const when = (d) => (d ? new Date(d).toLocaleString() : '');
async function goLive(p) {
  const plan = await api(`/api/deploy/${p}`);
  const c = (x) => (x ? `<code>${esc(x.short)}</code> ${esc(x.title)}` : '<i>none</i>');
  const t = plan.tested.playtests;
  view(box(`
    <h3 style="margin-top:0">Go live: ${esc(plan.name)} → <a href="${esc(plan.live)}" target="_blank">${esc(plan.live)}</a></h3>
    <p class="meta">${esc(plan.what)}${plan.betaSite ? ` Try beta first: <a href="${esc(plan.betaSite)}" target="_blank">${esc(plan.betaSite)}</a>.` : ''}</p>
    <p><b>Live (main):</b> ${c(plan.main)}<br><b>Beta:</b> ${c(plan.beta)}</p>
    <h4>${plan.commits.length} commit(s) on beta that aren't live</h4>
    ${plan.commits.length ? `<table class="commits">${plan.commits.map((x) => `<tr><td><code>${esc(x.short)}</code></td><td>${esc(x.title)}</td><td class="meta">${esc(x.author)} · ${esc(when(x.date))}</td></tr>`).join('')}</table>` : '<p class="meta">None.</p>'}
    ${plan.mainOnly.length ? `<p style="color:var(--amber)">main has ${plan.mainOnly.length} commit(s) beta lacks: ${plan.mainOnly.map((x) => esc(x.title)).join('; ')} <button class="small" data-gl="merge" data-p="${esc(plan.product)}">Merge main into beta</button></p>` : ''}
    ${plan.build ? `<p><b>Beta build:</b> ${plan.build.ok ? `Game/v${esc(plan.build.version ?? '?')} of <code>${esc(plan.build.sha.slice(0, 7))}</code>, ${plan.build.files} file(s) differ from live` : `failed: ${esc(plan.build.error ?? '')}`} · ${esc(ago(plan.build.at))}</p>` : ''}
    <h4>Playtests of beta ${plan.tested.sha ? `<code>${esc(plan.tested.sha)}</code>` : ''}</h4>
    ${t.length ? t.map((x) => `<div class="test"><span>${icon(x.status)}</span><span class="name">${esc(x.name)}</span><span class="detail">${esc(x.outcome ?? x.detail ?? '')} · ${ago(x.when)}</span>${x.verdict ? `<span class="pill ${esc(x.verdict)}">${esc(x.verdict)}</span>` : ''}${x.video ? `<a href="${file(x.video)}" target="_blank" rel="noopener" data-video="${file(x.video)}">▶</a>` : ''}</div>${x.summary ? `<div class="meta">${esc(x.summary)}</div>` : ''}`).join('') : `<p class="meta">None at this commit.${plan.lastPlayed ? ` The last local playtest played ${esc(plan.lastPlayed.played.branch)} <code>${esc(String(plan.lastPlayed.played.sha).slice(0, 7))}</code> ${ago(plan.lastPlayed.when)}.` : ''}</p>`}
    ${plan.blockers.length ? `<p style="color:var(--red, #e5484d)"><b>Can't go live yet:</b><br>${plan.blockers.map(esc).join('<br>')}</p>` : ''}
    ${plan.warnings.length ? `<p style="color:var(--amber)"><b>Warnings:</b><br>${plan.warnings.map(esc).join('<br>')}</p>` : ''}
    ${!plan.blockers.length && !plan.warnings.length ? '<p style="color:var(--accent)">No warnings.</p>' : ''}
    <div class="actions">
      <button class="small" data-gl="beta" data-p="${esc(plan.product)}" title="Pre-deploy build, Unity build, beta site and a local playtest of beta. Nothing goes live.">Update &amp; playtest beta</button>
      <button class="small" data-gl="rollback" data-p="${esc(plan.product)}">Rollback…</button>
    </div>
    ${plan.canDeploy ? `<div id="glCard"></div><details><summary class="meta">Or type <code>${esc(plan.confirm)}</code></summary>
      <div class="actions"><input id="glConfirm" autocomplete="off" placeholder="${esc(plan.confirm)}" style="flex:1"><button class="small primary" data-gl="go" data-p="${esc(plan.product)}" data-confirm="${esc(plan.confirm)}" disabled>Go live</button></div></details>` : ''}
    ${plan.previous.length ? `<details><summary class="meta">Previous go lives</summary>${plan.previous.map((d) => `<div class="meta">${esc(d.kind)} ${esc(d.id)} · ${esc(when(d.at))} · ${esc(d.by ?? '')} · ${esc(d.before ?? '?')} → ${esc(d.after)}${d.rolledBack ? ` · rolled back (${esc(d.rolledBack)})` : ''} · ${esc(d.detail ?? '')}</div>`).join('')}</details>` : ''}
    <div id="glOut"></div>`));
  if (plan.canDeploy) glCard('deploy', plan.product);
}
/** The Approve / Deny card (approval.js) for going live or rolling back, bound to what the dialog shows. */
function glCard(kind, product) {
  approvals.request({ kind, target: product })
    .then((a) => { const n = $('#glCard'); if (n) n.innerHTML = approvals.html(a); })
    .catch((err) => { const n = $('#glCard'); if (n) n.innerHTML = `<p class="meta">${esc(err.message)}</p>`; });
}
async function rollbackView(p) {
  const plan = await api(`/api/rollback/${p}`);
  view(box(`
    <h3 style="margin-top:0">Roll back ${esc(plan.name)} → <a href="${esc(plan.live)}" target="_blank">${esc(plan.live)}</a></h3>
    <p class="meta">${esc(plan.what)}</p>
    <p><b>Live now:</b> ${plan.main ? `<code>${esc(plan.main.short)}</code> ${esc(plan.main.title)}` : '?'}<br><b>Back to:</b> ${plan.to ? `<code>${esc(plan.to.short)}</code> ${esc(plan.to.title)}` : '?'}</p>
    ${plan.undo.length ? `<h4>Undoes ${plan.undo.length} commit(s)</h4>${plan.undo.map((x) => `<div class="meta"><code>${esc(x.short)}</code> ${esc(x.title)} · ${esc(x.author)}</div>`).join('')}` : ''}
    ${plan.blockers.length ? `<p style="color:var(--red, #e5484d)">${plan.blockers.map(esc).join('<br>')}</p>` : ''}
    ${plan.warnings.length ? `<p style="color:var(--amber)">${plan.warnings.map(esc).join('<br>')}</p>` : ''}
    ${plan.canRollback ? `<div id="glCard"></div><details><summary class="meta">Or type <code>${esc(plan.confirm)}</code></summary>
      <div class="actions"><input id="glConfirm" autocomplete="off" placeholder="${esc(plan.confirm)}" style="flex:1"><button class="small primary" data-gl="dorollback" data-p="${esc(plan.product)}" data-confirm="${esc(plan.confirm)}" disabled>Roll back</button></div></details>` : ''}
    <div id="glOut"></div>`));
  if (plan.canRollback) glCard('rollback', plan.product);
}
$('#viewer').addEventListener('input', (e) => {
  if (e.target.id !== 'glConfirm') return;
  const b = $('#viewer button[data-confirm]');
  if (b) b.disabled = e.target.value.trim() !== b.dataset.confirm;
});
$('#viewer').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-gl]');
  if (!b) return;
  const p = b.dataset.p;
  const out = (html) => { const o = $('#glOut'); if (o) o.innerHTML = html; };
  try {
    b.disabled = true;
    if (b.dataset.gl === 'rollback') return rollbackView(p);
    if (b.dataset.gl === 'merge') {
      const r = await api(`/api/deploy/${p}`, { method: 'POST', body: { mergeMain: true, by: 'J' } });
      out(`<p>${esc(r.detail)}. ${esc(r.note)}</p>`);
      return;
    }
    if (b.dataset.gl === 'beta') {
      const r = await api(`/api/beta/${p}`, { method: 'POST', body: {} });
      out(`<p>Updating and playtesting beta (run ${esc(r.run)}). Nothing goes live. Open this again when it's done.</p>`);
      return;
    }
    const typed = $('#glConfirm')?.value.trim();
    if (b.dataset.gl === 'go') {
      const r = await api(`/api/deploy/${p}`, { method: 'POST', body: { confirm: typed, by: 'J' } });
      out(`<p style="color:var(--accent)">Live: main is <code>${esc(r.main)}</code> (beta ${esc(r.beta)}). ${esc(r.note)}</p><pre>${esc(r.log.join(String.fromCharCode(10)))}</pre>`);
    }
    if (b.dataset.gl === 'dorollback') {
      const r = await api(`/api/rollback/${p}`, { method: 'POST', body: { confirm: typed, by: 'J' } });
      out(`<p style="color:var(--accent)">Rolled back: main is <code>${esc(r.main)}</code> (the files of ${esc(r.to)}). ${esc(r.note)}</p>`);
    }
    loadToday();
  } catch (err) {
    out(`<p style="color:var(--red, #e5484d)">${esc(err.message)}</p>`);
    b.disabled = false;
  }
});

$('#runDaily').onclick = async () => {
  try {
    await api('/api/runs', { method: 'POST', body: { kind: 'daily', noBuild: $('#optNoBuild').checked, where: $('#optLocal').checked ? 'local' : undefined } });
    loadToday();
  } catch (e) { alert(e.message); }
};
$('#runSmoke').onclick = async () => {
  try {
    await api('/api/runs', { method: 'POST', body: { scenarios: ['smoke', 'site'], noBuild: $('#optNoBuild').checked, where: $('#optLocal').checked ? 'local' : undefined } });
    loadToday();
  } catch (e) { alert(e.message); }
};

// ----------------------------------------------------------- report
async function loadReport() {
  // The same list Talk's studio_reports reads: daily reports first (the newest opens by default), then other runs.
  const { reports } = await api('/api/reports?limit=60');
  const sel = $('#reportRun');
  const cur = sel.value;
  const opt = (r) => `<option value="${r.run}">${new Date(r.started).toLocaleString()} · ${r.kind} · ${r.status}${r.playtests ? ` · ${r.playtests} playtests` : ''}${r.reviews ? `, ${r.reviews} reviewed` : ''}</option>`;
  const daily = reports.filter((r) => r.daily);
  const other = reports.filter((r) => !r.daily);
  sel.innerHTML = `<optgroup label="Daily reports (${daily.length})">${daily.map(opt).join('')}</optgroup><optgroup label="Other runs: one-off playtests, beta runs, builds (${other.length})">${other.map(opt).join('')}</optgroup>`;
  if (cur && reports.some((r) => r.run === cur)) sel.value = cur;
  else if (daily.length) sel.value = daily[0].run;
  if (!sel.value) return ($('#reportBody').innerHTML = '<div class="empty">No runs yet. Start one from Today.</div>');
  const run = await api(`/api/runs/${sel.value}`);
  $('#reportMd').href = `/api/runs/${run.id}/report?format=md`;
  const byProduct = new Map();
  for (const s of run.steps) (byProduct.get(s.product) ?? byProduct.set(s.product, []).get(s.product)).push(s);
  // A daily report also lists what ran between the previous daily run and this one.
  const me = reports.find((r) => r.run === sel.value);
  const prevDaily = me?.daily ? daily.find((r) => r.started < me.started) : null;
  const between = me?.daily ? other.filter((r) => r.started < me.started && (!prevDaily || r.started >= prevDaily.started)) : [];
  const sinceHtml = between.length ? `<div class="report-product"><h2>Since the last report</h2>${between.map((r) => `<div class="test"><span>${icon(r.status === 'interrupted' ? 'failed' : r.status)}</span><span class="name"><a href="#" data-report-run="${r.run}">${esc(r.kind)} · ${new Date(r.started).toLocaleString()}</a></span><span class="detail">${esc(r.products.join(', '))}${r.playtests ? ` · ${r.playtests} playtests, ${r.reviews} reviewed` : ''} · ${esc(r.headline ?? r.status)}</span></div>`).join('')}</div>` : '';
  $('#reportBody').innerHTML = `<p class="meta">${esc(run.detail ?? '')} · $${(run.cost ?? 0).toFixed(2)}</p>` + sinceHtml + [...byProduct.entries()].map(([pid, steps]) => {
    const reviews = steps.filter((s) => s.kind === 'review' && s.data);
    return `<div class="report-product"><h2>${esc(pid)}</h2>
      ${steps.filter((s) => s.kind !== 'review').map((s) => `<div class="test"><span>${icon(s.status)}</span><span class="name">${esc(s.kind)} ${esc(s.name)}</span><span class="detail">${esc(s.detail ?? '')}</span>${s.data?.video ? `<a href="${file(s.data.video)}" target="_blank" rel="noopener" data-video="${file(s.data.video)}">▶ video</a>` : ''}</div>${s.kind === 'check' && s.status === 'failed' ? `<pre>${esc(s.data?.tail ?? '')}</pre>` : ''}`).join('')}
      ${reviews.map((rv) => `<div class="review"><h4>${esc(rv.name)} <span class="pill ${rv.data.verdict}">${esc(rv.data.verdict)}</span></h4>
        <div class="scores">${Object.entries(rv.data.scores ?? {}).map(([k, n]) => `<div class="score"><b>${n}</b><span>${k}</span></div>`).join('')}</div>
        <p class="summary">${esc(rv.data.summary)}</p>${rv.data.changes?.length ? `<p class="meta">Since last time: ${rv.data.changes.map(esc).join('; ')}</p>` : ''}
        ${(rv.data.findings ?? []).map(findingHtml).join('')}</div>`).join('')}
    </div>`;
  }).join('');
}
$('#reportRun').onchange = loadReport;
$('#reportBody').addEventListener('click', (e) => {
  const a = e.target.closest('[data-report-run]');
  if (!a) return;
  e.preventDefault();
  $('#reportRun').value = a.dataset.reportRun;
  loadReport();
});

function findingHtml(f) {
  // J's reports from the beta sites: their screenshot is in Gen's library once imported, else Studio keeps it.
  const own = f.source === 'J' && !(f.shots ?? []).length ? `<img loading="lazy" src="/api/bugreports/${f.id}/shot" data-full="/api/bugreports/${f.id}/shot" onerror="this.remove()">` : '';
  const shots = own + (f.shots ?? []).slice(0, 4).map((a) => `<img loading="lazy" src="${file(a)}" data-full="${file(a)}">`).join('');
  return `<div class="finding${f.source === 'J' ? ' from-j' : ''}"${f.id ? ` data-fid="${esc(f.id)}"` : ''}><div>
      <h4><span class="pill ${f.severity}">${esc(f.severity)}</span>${f.source === 'J' ? '<span class="pill j" title="J reported it from the beta site: top priority">J</span>' : ''}${esc(f.title)} ${f.area ? `<span class="meta">${esc(f.area)}</span>` : ''}${f.id ? `<span class="meta">${esc(f.id)} · seen ${f.seen}× · ${esc(f.product)} · ${esc(f.scenario ?? '')}</span>` : ''}</h4>
      <div class="meta"${f.source === 'J' ? ' style="white-space:pre-line"' : ''}>${esc(f.detail ?? '')}</div>
      <div class="fix"><b>Fix:</b> ${esc(f.fix ?? '')}</div>${f.note ? `<div class="meta">Note: ${esc(f.note)}</div>` : ''}
    </div><div class="side">${shots ? `<div class="thumbs">${shots}</div>` : ''}${f.id ? `<div class="actions">
      ${f.status === 'open' ? `<button class="small primary" data-agentfix="${f.id}" data-product="${esc(f.product)}">Fix with agent</button>` : ''}${['fixing', 'fixed', 'wontfix', 'open', 'idea'].filter((s) => s !== f.status && !(s === 'fixing' && f.status === 'idea')).map((s) => `<button class="small" data-finding="${f.id}" data-status="${s}">${s === 'open' && ['idea', 'expired'].includes(f.status) ? 'to backlog' : s === 'idea' ? 'to ideas' : s}</button>`).join('')}</div>` : ''}</div></div>`;
}

// ---------------------------------------------------------- backlog
async function loadBacklog() {
  if ($('#blProduct').options.length <= 1 && overview) $('#blProduct').innerHTML += overview.products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const qs = new URLSearchParams({ status: $('#blStatus').value, ...($('#blProduct').value ? { product: $('#blProduct').value } : {}) });
  const { findings } = await api(`/api/findings?${qs}`);
  // J's own reports first (the PM loop starts them first too).
  findings.sort((a, b) => (b.source === 'J') - (a.source === 'J'));
  $('#blCount').textContent = `${findings.length} ${$('#blStatus').value === 'idea' ? 'ideas (polish and ideas: never auto-fixed, expire after 14 days unseen)' : 'findings'}`;
  $('#blList').innerHTML = findings.length ? findings.map(findingHtml).join('') : '<div class="empty">Nothing here.</div>';
}
$('#blProduct').onchange = $('#blStatus').onchange = loadBacklog;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-finding]');
  if (!b) return;
  const note = b.dataset.status === 'wontfix' ? prompt('Why not? (optional)') ?? undefined : undefined;
  await api(`/api/findings/${b.dataset.finding}`, { method: 'PATCH', body: { status: b.dataset.status, note } });
  tab === 'backlog' ? loadBacklog() : loadReport();
});

// ------------------------------------------------------------- runs
let openRun = null;
async function loadRuns() {
  const { runs } = await api('/api/runs?limit=50');
  $('#runList').innerHTML = runs.map((r) => `<div class="run-row" data-run="${r.id}"><span>${icon(r.status === 'done' ? 'done' : r.status === 'running' ? 'running' : 'failed')}</span><b>${esc(r.kind)}</b><span class="meta">${new Date(r.started).toLocaleString()}</span><span>${esc(r.detail ?? '')}</span><span class="meta" style="margin-left:auto">$${(r.cost ?? 0).toFixed(2)}</span></div>`).join('') || '<div class="empty">No runs yet.</div>';
  if (openRun) {
    const r = await api(`/api/runs/${openRun}`);
    $('#runDetail').innerHTML = `<div class="steps"><h3>${esc(r.id)} · ${esc(r.status)}</h3>${r.steps.map((s) => `<div class="step"><span>${icon(s.status)}</span><span>${esc(s.product)}</span><span>${esc(s.kind)}</span><span>${esc(s.name)}</span><span class="detail">${esc(s.detail ?? '')}${s.job ? ` · <a href="${GEN}/#job/${s.job}" target="_blank">${esc(s.job)}</a>` : ''}</span></div>`).join('')}</div>`;
  }
}
$('#runList').onclick = (e) => {
  const row = e.target.closest('[data-run]');
  if (!row) return;
  openRun = row.dataset.run;
  loadRuns();
};

// ---------------------------------------------------------- refresh
async function refresh() {
  try {
    if (!overview || tab === 'today') await loadToday();
    if (tab === 'report') await loadReport();
    if (tab === 'backlog') await loadBacklog();
    if (tab === 'runs') await loadRuns();
    if (tab === 'changes') await loadChanges();
    if (tab === 'costs' && window.loadCosts) await window.loadCosts();
    if (tab === 'golive' && window.loadGoLiveTab) await window.loadGoLiveTab();
    if (tab === 'sites' && window.loadSitesTab) await window.loadSitesTab();
    if (tab === 'settings' && window.loadSettingsTab) await window.loadSettingsTab();
    if (tab === 'users' && window.loadUsersTab) await window.loadUsersTab();
    if (tab === 'talk' && window.loadTalk && !window.__talkLoaded) { window.__talkLoaded = true; await window.loadTalk(); }
  } catch (e) {
    $('#status').innerHTML = `<span><span class="dot bad"></span>${esc(e.message)}</span>`;
  }
}
show(tab);
setInterval(() => { if (tab === 'today' || tab === 'runs' || tab === 'changes') refresh(); }, 5000);

// ----------------------------------------------------------- changes
const CH_ICON = { queued: '⏳', working: '🛠️', verifying: '🎮', revising: '🛠️', ready: '👀', merged: '✅', failed: '❌', closed: '🗑️' };
async function loadChanges() {
  const qs = new URLSearchParams($('#chStatus').value ? { status: $('#chStatus').value } : {});
  const r = await api(`/api/changes?${qs}`);
  // It refreshes every few seconds: it redraws only when something changed, and what J opened (a summary, a log) stays open.
  const sig = JSON.stringify(r.changes.map((c) => [c.id, c.status, c.detail, c.updated])) + r.today.count;
  if (sig === loadChanges.sig && $('#chList').children.length) return;
  loadChanges.sig = sig;
  const open = new Set([...$('#chList').querySelectorAll('details[open]')].map((d) => d.dataset.key));
  $('#chInfo').textContent = `Today: ${r.today.count} fixes, $${r.today.cost.toFixed(2)} of $${r.settings.maxCostPerDay} · auto-fix ${r.settings.autoFix ? 'on' : 'off'} (${r.settings.severities.join(', ')}, up to ${r.settings.maxPerDay}/day)`;
  $('#chList').innerHTML = r.changes.length ? r.changes.map((c) => {
    const v = c.verify;
    // A product change is playtested only on request ("Playtest this change"); not being playtested is plain info.
    const played = v && (v.playtest || (v.outcome && v.outcome !== 'not played'));
    return `<div class="finding" data-cid="${c.id}"><div>
      <h4>${CH_ICON[c.status] ?? ''} ${esc(c.title)} <span class="pill ${c.status === 'ready' ? 'ship' : c.status === 'failed' ? 'failed' : ''}">${esc(c.status)}</span><span class="meta">${esc(c.product)} · ${esc(c.id)} · $${(c.cost ?? 0).toFixed(2)}</span></h4>
      ${ChangeStages.barHtml(c.status, c.stage ?? {})}
      <div class="meta">${esc(c.detail ?? '')}${c.diffstat ? ` · ${esc(c.diffstat)}` : ''}${c.pr_url ? ` · <a href="${esc(c.pr_url)}" target="_blank">pull request #${c.pr}</a>` : ''}</div>
      ${c.summary ? `<details data-key="${c.id}:summary"><summary class="meta">What the agent did</summary><pre>${esc(c.summary)}</pre></details>` : ''}
      ${v && c.infra ? `<div class="summary"><b>Checks:</b> <span class="pill ${esc(v.verdict ?? '')}">${esc(v.outcome ?? '')}</span> ${esc(v.summary ?? '')}</div>` : played ? `<div class="summary"><b>Playtest:</b> ${esc(v.outcome ?? '')} · review <span class="pill ${esc(v.verdict ?? '')}">${esc(v.verdict ?? 'n/a')}</span> ${esc(v.summary ?? '')}</div>` : c.status === 'ready' ? `<div class="meta">Not playtested${v?.error ? ` (the last playtest asked for couldn't run: ${esc(v.error)})` : ''}.</div>` : ''}
      ${c.notes?.length ? `<div class="meta">${c.notes.map((n) => `${esc(n.by)}: ${esc(n.text)}`).join(' · ')}</div>` : ''}
      <details data-key="${c.id}:log"><summary class="meta">Log</summary><pre>${esc((c.log ?? []).slice(-40).join(String.fromCharCode(10)))}</pre></details>
    </div><div class="side">
      ${v?.video ? `<a href="${file(v.video)}" target="_blank" rel="noopener" data-video="${file(v.video)}">▶ fixed version</a>` : ''}${v?.preview ? ` <a href="${esc(v.preview)}" target="_blank">🔗 try it</a>` : ''}
      <div class="actions">
        ${c.status === 'ready' && c.infra ? `<button class="small primary" data-change="${c.id}" data-act="approve" data-infra="1" data-guide="off" title="Merges it into main: ${esc(c.product)} deploys itself once CI passes (a restart).">Approve into main</button>` : c.status === 'ready' ? `<button class="small primary" data-change="${c.id}" data-act="approve" data-guide="off" title="Merges it into the beta branch (the beta site). Nothing goes live until you go live from Today.">Approve into beta</button>` : ''}
        ${c.status === 'ready' && !c.infra ? `<button class="small" data-change="${c.id}" data-act="playtest" title="Plays the change's scenario on its version (a build first for Unity), with a video and a Claude review (a few cents).">${played ? 'Playtest again' : 'Playtest this change'}</button>` : ''}
        ${['ready', 'failed'].includes(c.status) ? `<button class="small" data-change="${c.id}" data-act="revise">Ask for changes</button>` : ''}
        ${!['merged', 'closed'].includes(c.status) ? `<button class="small" data-change="${c.id}" data-act="close">Close</button>` : ''}
      </div></div></div>`;
  }).join('') : '<div class="empty">No changes here. Agents start on new bugs after each daily run, or use "Fix with agent" in the backlog.</div>';
  for (const d of $('#chList').querySelectorAll('details[data-key]')) if (open.has(d.dataset.key)) d.open = true;
  // #changes/<id> (the Activity panel's "log" link) opens that change's log once.
  const want = /^#changes\/(c_[0-9a-f]+)/.exec(location.hash)?.[1];
  const d = want && $(`#chList details[data-key="${want}:log"]`);
  if (d && loadChanges.opened !== want) { loadChanges.opened = want; d.open = true; d.scrollIntoView({ block: 'center' }); }
}
$('#chStatus').onchange = () => { loadChanges.sig = null; loadChanges(); };
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-change]');
  if (b) {
    const id = b.dataset.change;
    try {
      if (b.dataset.act === 'approve') {
        const ask = b.dataset.infra
          ? 'Merge this pull request into main? It deploys itself once CI passes: the service restarts (after running work finishes) and rolls back if it is not healthy.'
          : 'Merge this pull request into beta? The beta site and a beta playtest follow; nothing goes live until you use "Go live" on Today.';
        if (!confirm(ask)) return;
        await api(`/api/changes/${id}/approve`, { method: 'POST', body: { confirm: `MERGE ${id}`, by: 'J' } });
      }
      if (b.dataset.act === 'revise') {
        const note = prompt('What should the agent change?');
        if (!note) return;
        await api(`/api/changes/${id}/revise`, { method: 'POST', body: { note, by: 'J' } });
      }
      if (b.dataset.act === 'playtest') await api(`/api/changes/${id}/playtest`, { method: 'POST', body: { by: 'J' } });
      if (b.dataset.act === 'close' && confirm('Close this change and its pull request?')) await api(`/api/changes/${id}/close`, { method: 'POST', body: { by: 'J' } });
      loadChanges.sig = null;
      loadChanges();
    } catch (err) { alert(err.message); }
  }
  const fx = e.target.closest('button[data-agentfix]');
  if (fx) {
    try {
      const r = await api('/api/changes', { method: 'POST', body: { product: fx.dataset.product, findings: [fx.dataset.agentfix] } });
      alert(`An agent is on it (${r.change}). Follow it in Changes.`);
      tab === 'backlog' ? loadBacklog() : loadReport();
    } catch (err) { alert(err.message); }
  }
});
