// Hawkes Studio dashboard: plain JS over /api (and Hawkes Gen's /v1/files for screenshots and videos).
let GEN = 'http://127.0.0.1:8790';
// On the server, Hawkes Gen is at its public address.
fetch('/api/config').then((r) => r.json()).then((c) => { if (c.genUrl) GEN = c.genUrl; }).catch(() => {});
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Library files through Studio's relay (its own Gen key, ranges for video): Gen's /v1/files answers 401 to a browser.
const file = (asset) => `/api/gen/v1/files/${asset}`;
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const icon = (s) => ({ done: '✅', failed: '❌', skipped: '⏭️', running: '⏳' })[s] ?? '•';
// A playtest step over its scenario's time budget (pace.ts): the agents are told to start it nearer.
const slowPill = (s) => (s.kind === 'playtest' && s.data?.slow ? `<span class="pill fix-first" title="${esc(s.data.slow)}">over 10 min</span> ` : '');

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
  // A pro feature on a plan without it (src/entitlements.ts): the API says what to upgrade to; offer it.
  if (r.status === 402 && d.upgrade) studioUpgrade(d);
  if (r.status === 409 && d.connectAi) studioUpgrade({ ...d, connectAi: true });
  if (!r.ok) throw new Error(d.error ?? r.status);
  return d;
}

// The Upgrade prompt: what the plan lacks, and a button to Stripe Checkout (billing.ts) for the cheapest plan with it.
// Or, for Talk and agents with no AI linked yet, the way to Settings and the Connect your AI card.
function studioUpgrade(d) {
  document.getElementById('upgradeDlg')?.remove();
  const el = document.createElement('div');
  el.id = 'upgradeDlg';
  el.setAttribute('role', 'dialog');
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:1000;padding:16px';
  const u = d.upgrade;
  el.innerHTML = `<div style="background:var(--panel,#151a1f);border:1px solid var(--line,#2a3138);border-radius:12px;padding:20px;max-width:420px;width:100%">
    <h3 style="margin:0 0 8px">${d.connectAi ? 'Connect your AI' : `Upgrade to ${esc(u.planName)}`}</h3>
    <p class="meta" style="margin:0 0 14px">${esc(d.error)}</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <button class="small" data-up="close">Not now</button>
      ${d.connectAi ? '<button data-up="ai">Open Settings</button>' : `<button data-up="buy">Upgrade to ${esc(u.planName)}</button>`}
    </div><div class="meta" id="upMsg"></div></div>`;
  document.body.append(el);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-up]');
    if (e.target === el || b?.dataset.up === 'close') return el.remove();
    if (b?.dataset.up === 'ai') { el.remove(); location.hash = '#settings'; return; }
    if (b?.dataset.up === 'buy') {
      b.disabled = true;
      try {
        const r = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: u.plan }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? r.status);
        location.href = j.url;
      } catch (err) {
        b.disabled = false;
        el.querySelector('#upMsg').textContent = err.message;
      }
    }
  });
}
window.studioUpgrade = studioUpgrade;

// A customer's games, edited in one place (J, 2026-10-30: "Should be able to edit games, delete them, change their
// settings"): name, what it's made with, where it plays (live) and its test version (beta: playtests "on beta" play
// it), its repository, what it is, its story and what "done" means. Saved through onboarding's own checks
// (PUT /api/products/<id>, config.ts saveProduct); Delete removes the game (its playtests and findings stay in history).
async function studioEditGame(id) {
  let p = null;
  if (id) p = (await api('/api/products')).products.find((x) => x.id === id) ?? null;
  document.getElementById('gameDlg')?.remove();
  const el = document.createElement('div');
  el.id = 'gameDlg';
  el.setAttribute('role', 'dialog');
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:1000;padding:16px;overflow:auto';
  const v = (x) => esc(x ?? '');
  const opt = (val, label) => `<option value="${val}"${(p?.engine === 'static' ? 'web' : p?.engine ?? 'web') === val ? ' selected' : ''}>${label}</option>`;
  const field = 'width:100%;padding:8px;border-radius:6px;border:1px solid var(--line);background:var(--panel2,transparent);color:inherit';
  el.innerHTML = `<form style="background:var(--panel,#151a1f);border:1px solid var(--line,#2a3138);border-radius:12px;padding:20px;max-width:560px;width:100%;display:flex;flex-direction:column;gap:8px">
    <h3 style="margin:0">${p ? `Edit ${esc(p.name)}` : 'Add a game'}</h3>
    <label class="meta">Name<input name="name" required maxlength="80" value="${v(p?.name)}" style="${field}"></label>
    <label class="meta">Made with<select name="engine" style="${field}">${opt('web', 'A web game or site')}${opt('unity', 'Unity (WebGL)')}${opt('godot', 'Godot (web export)')}${opt('desktop', 'A desktop game')}</select></label>
    <label class="meta">Where it plays (live)<input name="live" type="url" required placeholder="https://…" value="${v(p?.live)}" style="${field}"></label>
    <label class="meta">Its test version (beta), if it has one<input name="beta" type="url" placeholder="https://… (optional)" value="${v(p?.beta)}" style="${field}"></label>
    <label class="meta">GitHub repository (owner/name), optional<input name="repo" placeholder="owner/name" value="${v(p?.github ?? p?.repo)}" style="${field}"></label>
    <label class="meta">What it is (Claude reads it before every review)<textarea name="about" rows="2" style="${field}">${v(p?.about)}</textarea></label>
    <label class="meta">Its story and tone (optional)<textarea name="story" rows="3" style="${field}">${v(p?.storyText)}</textarea></label>
    <label class="meta">What "done" means for it (optional: reviews judge against it)<textarea name="quality" rows="2" style="${field}">${v(p?.quality)}</textarea></label>
    <div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;margin-top:6px">
      <span>${p ? '<button type="button" class="small" data-game="delete" style="color:var(--red)">Delete this game</button>' : ''}</span>
      <span style="display:flex;gap:8px"><button type="button" class="small" data-game="close">Cancel</button><button type="submit" class="primary">${p ? 'Save' : 'Add it'}</button></span>
    </div>
    <div class="meta" id="gameMsg"></div>
    <div id="gameReady" style="border-top:1px solid var(--line,#2a3138);margin-top:8px;padding-top:10px"></div></form>`;
  document.body.append(el);
  const msg = (t) => { el.querySelector('#gameMsg').innerHTML = t; };
  if (p) studioGameReady(p.id, el.querySelector('#gameReady'));
  else studioGithubLine(el.querySelector('#gameReady'));
  return new Promise((resolve) => {
    const done = (changed) => { el.remove(); resolve(changed); if (changed) refresh(); };
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-game]');
      if (e.target === el || b?.dataset.game === 'close') return done(false);
      if (b?.dataset.game === 'delete') {
        if (!confirm(`Delete ${p.name}? Studio stops playing it. Its past playtests and findings stay in the history.`)) return;
        try { await api(`/api/products/${p.id}`, { method: 'DELETE' }); done(true); } catch (err) { msg(`<span style="color:var(--red)">${esc(err.message)}</span>`); }
      }
    });
    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const newId = String(f.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?=[^a-z])/, 'g-').slice(0, 40) || 'my-game';
      const gid = p?.id ?? newId;
      const body = { id: gid, name: f.name, engine: f.engine, live: f.live, about: f.about, contract: p?.contract ?? false, playtests: p?.playtests, ...(f.beta ? { beta: f.beta } : {}), ...(f.repo ? { repo: f.repo.trim() } : {}), ...(f.story ? { story: f.story } : {}), ...(f.quality ? { quality: f.quality } : {}) };
      msg('Saving…');
      try { await api(`/api/products/${gid}`, { method: 'PUT', body }); done(true); } catch (err) { msg(`<span style="color:var(--red)">${esc(err.message)}</span>`); }
    });
  });
}
window.studioEditGame = studioEditGame;

// GitHub in one line (github-routes.ts): connect Studio (one click on GitHub), sign in with GitHub, or where it's installed.
async function studioGithubLine(box) {
  try {
    const g = await api('/api/github');
    const btn = (href, label, primary) => `<a class="button small${primary ? ' primary' : ''}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
    box.innerHTML = !g.app
      ? `<div class="meta">GitHub isn't connected yet. One click on GitHub connects it; then pick the repositories Studio may work on.</div><div style="margin-top:6px">${btn(g.setup, 'Connect GitHub', true)}</div>`
      : `<div class="meta">GitHub: the app <b>${esc(g.app.slug)}</b>${g.installations.length ? ` is installed on ${g.installations.map((i) => esc(i.account)).join(', ')}` : ' is made, not installed yet'}${g.user ? `; you're signed in as <b>${esc(g.user.login)}</b>` : ''}.</div>
         <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${btn(g.install, 'Choose repositories')}${g.connect ? btn(g.connect, 'Sign in with GitHub') : ''}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="meta">GitHub: ${esc(e.message)}</div>`;
  }
}

// "Get it ready" (repokit.ts readiness): what the game has and lacks, each with a link straight to the page, and one
// button for the GitHub steps Studio can do (an Approve card: J's tap runs them).
async function studioGameReady(id, box) {
  box.innerHTML = '<div class="meta">Checking what it needs…</div>';
  try {
    const r = await api(`/api/games/${id}/readiness`);
    const rows = r.items.map((i) => `<li style="margin:4px 0">${i.ok ? '✅' : '⬜'} ${esc(i.what)}${!i.ok && i.fix ? `<div class="meta">${esc(i.fix)}</div>` : ''}${!i.ok && i.link ? ` <a href="${esc(i.link)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</li>`).join('');
    const links = Object.entries(r.links ?? {}).filter(([k]) => ['live', 'beta', 'repo', 'actions'].includes(k)).map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${({ live: 'Play it', beta: 'Beta', repo: 'Repository', actions: 'Builds on GitHub' })[k]} ↗</a>`).join(' · ');
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${r.ready ? 'Ready ✓' : 'Get it ready'}</b><span class="meta">${links}</span></div>
      <ul style="list-style:none;padding:0;margin:6px 0">${rows}</ul>
      ${r.approve ? '<button type="button" class="small primary" data-ready="setup">Set it up on GitHub</button> <span class="meta">Puts an Approve card in your Inbox.</span>' : ''}
      <div id="gameGh" style="margin-top:8px"></div>`;
    studioGithubLine(box.querySelector('#gameGh'));
    box.querySelector('[data-ready="setup"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await api(`/api/games/${id}/setup`, { method: 'POST', body: {} }); e.target.outerHTML = '<span class="meta">The card is in your Inbox: tap Approve there.</span>'; }
      catch (err) { e.target.disabled = false; e.target.insertAdjacentHTML('afterend', ` <span style="color:var(--red)">${esc(err.message)}</span>`); }
    });
  } catch (e) {
    box.innerHTML = `<div class="meta">${esc(e.message)}</div>`;
  }
}
// The Go live card's "Add its repository" (golive.js) opens the same editor.
const studioAddRepo = (id) => studioEditGame(id);
window.studioAddRepo = studioAddRepo;

// ------------------------------------------------------------- tabs
// Old tabs folded into others: #sites (the beta and live links) is on Go live now.
const MOVED = { sites: 'golive' };
let tab = location.hash.slice(1).split('/')[0] || 'inbox';
tab = MOVED[tab] ?? tab;
function show(t, sub) {
  t = MOVED[t] ?? t;
  tab = t;
  // #changes/<id> (a link from the Activity panel) and #analytics/<product> (a game's page) stay.
  if (!sub && (t === 'changes' || t === 'analytics' || t === 'videos') && location.hash.startsWith(`#${t}/`)) sub = location.hash.slice(t.length + 2);
  location.hash = sub ? `${t}/${sub}` : t;
  document.querySelectorAll('nav button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === t));
  // A tab under More: the More button is lit and says which one.
  const under = $(`#moreMenu button[data-tab="${t}"]`);
  $('#moreBtn').classList.toggle('on', Boolean(under));
  $('#moreBtn').textContent = under ? `More: ${under.textContent.replace('⚙', '').trim()} ▾` : 'More ▾';
  moreMenu(false);
  if (picked?.tab !== t) picked = null;
  window.afterShow?.(t); // a customer's grouped tabs (groups.js): the group's button and its pages' bar
  dispatchEvent(new CustomEvent('studio-tab', { detail: t })); // the Talk dock follows (talk.js)
  refresh();
}
document.querySelectorAll('nav button[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
// More: the tabs J looks at less often. Their buttons are still nav button[data-tab] (studio_guide clicks them), the menu
// is fixed under its button so a nav that scrolls sideways (a phone during a call) doesn't clip it. The header's
// backdrop-filter makes it the menu's containing block, so the place is measured from the header.
function moreMenu(open) {
  const m = $('#moreMenu');
  const b = $('#moreBtn');
  m.hidden = !open;
  b.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const r = b.getBoundingClientRect();
  const h = $('header').getBoundingClientRect();
  m.style.top = `${r.bottom - h.top + 4}px`;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) - h.left}px`;
}
$('#moreBtn').onclick = (e) => { e.stopPropagation(); moreMenu($('#moreMenu').hidden); };
document.addEventListener('click', (e) => { if (!e.target.closest('#more')) moreMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') moreMenu(false); });
addEventListener('resize', () => moreMenu(false));

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
  if (!it && tab === 'analytics' && hashId) it = { kind: 'analytics of product', id: hashId };
  if (!it && tab === 'report' && $('#reportRun').value) it = { kind: 'report of run', id: $('#reportRun').value };
  if (!it && tab === 'runs' && openRun) it = { kind: 'run', id: openRun };
  return { tab: name, kind: it?.kind, id: it?.id, label: it?.label };
}

// A link to where something lives on another tab (data-goto="<tab>"), instead of showing it twice.
document.addEventListener('click', (e) => {
  const g = e.target.closest('a[data-goto]');
  if (!g || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  e.preventDefault();
  show(g.dataset.goto);
});

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
  fillPlaytestBars(overview.products);
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
    // A customer's Studio has no build server of its own to show (src/tenancy.ts): the pill is J's.
    b && b.exists ? `<span><span class="dot ${b.state === 'running' ? 'ok' : b.state === 'stopped' ? '' : 'warn'}"></span>Build server: ${esc(b.state)}${b.stage ? ` · ${esc(b.stage.stage)}` : ''}</span>` : window.studioMe?.customer ? '' : '<span><span class="dot"></span>No build server</span>',
    o.run ? `<span><span class="dot warn"></span>Run ${esc(o.run.id)}: ${esc(o.run.detail)}</span>` : '',
  ].join('');
  $('#runInfo').textContent = o.run ? `A run is going (${o.run.id}).` : o.runs[0] ? `Last run ${ago(o.runs[0].started)}: ${o.runs[0].status}${o.runs[0].detail ? ` · ${o.runs[0].detail}` : ''}` : 'No runs yet.';
  $('#runDaily').disabled = $('#runSmoke').disabled = Boolean(o.run);
  // Problems first, then the rest in their usual order.
  const ps = o.products.map((p, i) => ({ p, i, h: health(p) })).sort((x, y) => x.h.rank - y.h.rank || x.i - y.i);
  const bad = ps.filter((x) => x.h.rank < 2);
  const daily = o.runs.find((r) => r.kind === 'daily');
  $('#todayNow').innerHTML = `<div class="summary">${daily ? `The last daily run was ${esc(ago(daily.started))} (${esc(daily.status)}${daily.detail ? `: ${esc(daily.detail)}` : ''}). <a href="#report" data-goto="report">Its full report</a>.` : 'No daily run yet.'}
    ${bad.length ? `<b>${bad.length === 1 ? '1 product needs' : `${bad.length} products need`} a look:</b> ${bad.map((x) => esc(x.p.name)).join(', ')}.` : o.products.length ? '<b>Nothing is broken.</b>' : ''}</div>`;
  $('#cards').innerHTML = ps.map((x) => card(x.p, x.h)).join('');
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

const VERDICT = { ship: 'Looks good to ship', 'fix-first': 'Works, but has problems to fix first', broken: 'Broken: needs fixing' };
/** How a product stands, in one plain line: rank 0 = broken, 1 = needs a look, 2 = fine, 3 = not played yet. */
function health(p) {
  const r = p.lastReview?.data;
  const failed = p.playtests.filter((t) => t.playtest?.status === 'failed');
  const bugs = (p.open.blocker ?? 0) + (p.open.bug ?? 0);
  const played = p.playtests.map((t) => t.playtest?.finished ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const when = played ? ` (played ${ago(played)})` : '';
  if (p.dev?.conflict) return { rank: 0, text: 'Your devtools saves clash with beta: pick a fix below.' };
  if (p.build?.status === 'failed') return { rank: 0, text: `The Unity build failed ${ago(p.build.finished)}.` };
  if (failed.length) return { rank: 0, text: `${failed.length === 1 ? 'A playtest' : `${failed.length} playtests`} failed${when}: ${failed[0].playtest.detail ?? failed[0].name}` };
  if (r?.verdict === 'broken') return { rank: 0, text: `${VERDICT.broken}${when}.` };
  if (p.open.blocker) return { rank: 0, text: `${p.open.blocker} blocker${p.open.blocker === 1 ? '' : 's'} open.` };
  if (r?.verdict === 'fix-first') return { rank: 1, text: `${VERDICT['fix-first']}${when}.` };
  if (r) return { rank: bugs ? 1 : 2, text: `${VERDICT[r.verdict] ?? r.verdict}${when}.` };
  return { rank: 3, text: played ? `Played${when}, no review yet.` : 'Not playtested yet.' };
}

function card(p, h = health(p)) {
  const r = p.lastReview?.data;
  const bugs = Object.values(p.open).reduce((a, b) => a + b, 0);
  const shots = (r?.frames ?? []).slice(0, 8).map((f) => `<img loading="lazy" src="${file(f.asset)}" data-full="${file(f.asset)}" title="${esc(f.t)}s ${esc(f.scene ?? '')}">`).join('');
  const tests = p.playtests.map((t) => {
    const s = t.playtest;
    const v = t.review?.data?.verdict;
    return `<div class="test"><span>${s ? icon(s.status) : '·'}</span><span class="name">${esc(t.name)}</span><span class="detail" title="${esc(s?.detail ?? '')}">${s ? `${esc(s.detail ?? '')} · ${ago(s.finished)}` : 'not run yet'}</span>${v ? `<span class="pill ${v}">${v}</span>` : ''}${s?.data?.video ? `<a href="${file(s.data.video)}" target="_blank" rel="noopener" data-video="${file(s.data.video)}">▶</a>` : ''}</div>`;
  }).join('');
  const build = p.build ? `<div class="test"><span>${icon(p.build.status)}</span><span class="name">unity build</span><span class="detail">${esc(p.build.detail ?? '')} · ${ago(p.build.finished)}</span></div>` : '';
  const scores = r?.scores ? `<div class="scores">${Object.entries(r.scores).map(([k, n]) => `<div class="score"><b>${n}</b><span>${k}</span></div>`).join('')}</div>` : '';
  const git = `${p.git.dirty} uncommitted · ${p.git.ahead} unpushed${p.site ? ` · site ${p.site.dirty}/${p.site.ahead}` : ''}`;
  const video = p.playtests.map((t) => t.playtest?.data?.video).find(Boolean);
  const open = Object.entries(p.open).map(([k, n]) => `<span class="pill ${k}">${n} ${k}</span>`).join(' ');
  return `<div class="card rank-${h.rank}" data-p="${esc(p.id)}">
    <h3>${esc(p.name)}${r ? `<span class="pill verdict ${r.verdict}">${r.verdict}</span>` : ''}</h3>
    <div class="status-line">${esc(h.text)}</div>
    ${r?.summary ? `<div class="summary">${esc(r.summary)}</div>` : ''}
    ${p.dev?.conflict ? devLine(p) : ''}
    <div class="meta">${p.preview ? `<a href="${esc(p.preview.play)}" target="_blank">Beta</a> · ` : ''}<a href="${esc(p.live)}" target="_blank">Live</a>${video ? ` · <a href="${file(video)}" target="_blank" rel="noopener" data-video="${file(video)}">▶ last playtest</a>` : ''} · ${bugs ? `<a href="#backlog" data-act="backlog" data-p="${p.id}">${bugs} open bug${bugs === 1 ? '' : 's'} in Backlog</a>` : 'no open bugs'}</div>
    <div class="actions">
      ${window.studioMe?.customer
        ? `<button class="small primary" data-act="playtest" data-p="${p.id}" title="Plays it where it is live, with a video and a review (a few cents)">${p.beta ? 'Play live' : 'Run a playtest'}</button>${p.beta ? ` <button class="small" data-act="playbeta" data-p="${p.id}" title="Plays its test version (${esc(p.beta)}), with a video and a review">Play beta</button>` : ''} <button class="small" data-admin data-act="editgame" data-p="${p.id}">Edit</button>`
        : `<button class="small primary" data-act="playtest" data-p="${p.id}" title="A quick playtest of the main scenario, with a video and a review (a few cents)">Smoke test</button>${p.github ? ` <button class="small" data-admin data-act="editgame" data-p="${p.id}" title="Its settings, what it still needs and links to its pages">Edit · get it ready</button>` : ''}`}
    </div>
    <details class="more-details"><summary class="meta">Details</summary>
      <div class="meta">${esc(p.framing)}</div>
      <div class="meta">${window.studioMe?.customer ? '' : `${esc(git)} · <a href="${esc(p.local)}" target="_blank">local</a>`}${p.preview ? p.preview.changes.filter((c) => c.status === 'ready').map((c) => ` · <a href="${esc(c.play)}" target="_blank" title="agent change ${esc(c.id)}">${esc(c.id)}</a>`).join('') : ''}</div>
      ${p.dev?.conflict ? '' : devLine(p)}
      ${scores}
      <div class="tests">${build}${tests}</div>
      ${shots ? `<div class="thumbs">${shots}</div>` : ''}
      <div class="meta">${open || 'No open findings'}</div>
      <div class="actions">
        <button class="small" data-act="all" data-p="${p.id}" title="Every scenario of this product, built first if it changed">Full trial</button>
        ${p.engine === 'unity' ? `<button class="small" data-act="build" data-p="${p.id}">Build</button>` : ''}
        <button class="small" data-act="golive" data-p="${p.id}" title="Is beta ahead of live, and the Go live button">Go live tab</button>
      </div>
    </details>
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
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  e.preventDefault();
  const p = btn.dataset.p;
  try {
    // A customer's game: "Play live" plays where it is live; "Play beta" its test version (its "local" lane: config.ts asCustomerGame).
    if (btn.dataset.act === 'playtest') await api('/api/playtest', { method: 'POST', body: { product: p, scenario: undefined, ...(window.studioMe?.customer ? { where: 'live' } : {}) } });
    if (btn.dataset.act === 'playbeta') await api('/api/playtest', { method: 'POST', body: { product: p, scenario: undefined, where: 'local' } });
    if (btn.dataset.act === 'editgame') return void studioEditGame(p);
    if (btn.dataset.act === 'all') await api('/api/runs', { method: 'POST', body: { products: [p], noBuild: $('#optNoBuild').checked, where: $('#optLocal').checked ? 'local' : undefined } });
    if (btn.dataset.act === 'build') await api('/api/build', { method: 'POST', body: { product: p } });
    if (btn.dataset.act === 'backlog') { $('#blProduct').value = p; return show('backlog'); }
    if (btn.dataset.act === 'golive') return show('golive');
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
    ${plan.siteCommits?.length ? `<h4>${plan.siteCommits.length} website commit(s) (${esc(plan.site)}) that go live with it</h4><table class="commits">${plan.siteCommits.map((x) => `<tr><td><code>${esc(x.short)}</code></td><td>${esc(x.title)}</td><td class="meta">${esc(x.author)} · ${esc(when(x.date))}</td></tr>`).join('')}</table>` : ''}
    ${plan.siteMainOnly?.length ? `<p style="color:var(--amber)">${esc(plan.site)}'s main has ${plan.siteMainOnly.length} commit(s) its beta lacks: ${plan.siteMainOnly.map((x) => esc(x.title)).join('; ')} <button class="small" data-gl="merge" data-p="${esc(plan.product)}">Merge main into beta</button></p>` : ''}
    ${plan.build ? `<p><b>Beta build:</b> ${plan.build.ok ? `Game/v${esc(plan.build.version ?? '?')} of <code>${esc(plan.build.sha.slice(0, 7))}</code>, ${plan.build.files} file(s) differ from live` : `failed: ${esc(plan.build.error ?? '')}`} · ${esc(ago(plan.build.at))}</p>` : ''}
    <h4>Playtests of beta ${plan.tested.sha ? `<code>${esc(plan.tested.sha)}</code>` : ''}</h4>
    ${t.length ? t.map((x) => `<div class="test"><span>${icon(x.status)}</span><span class="name">${esc(x.name)}</span><span class="detail">${esc(x.outcome ?? x.detail ?? '')} · ${ago(x.when)}</span>${x.verdict ? `<span class="pill ${esc(x.verdict)}">${esc(x.verdict)}</span>` : ''}${x.video ? `<a href="${file(x.video)}" target="_blank" rel="noopener" data-video="${file(x.video)}">▶</a>` : ''}</div>${x.summary ? `<div class="meta">${esc(x.summary)}</div>` : ''}`).join('') : `<p class="meta">None at this commit.${plan.lastPlayed ? ` The last local playtest played ${esc(plan.lastPlayed.played.branch)} <code>${esc(String(plan.lastPlayed.played.sha).slice(0, 7))}</code> ${ago(plan.lastPlayed.when)}.` : ''}</p>`}
    ${plan.blockers.length ? `<p style="color:var(--red, #e5484d)"><b>Can't go live yet:</b><br>${plan.blockers.map(esc).join('<br>')}</p>` : ''}
    ${plan.fix ? `<div class="actions"><button class="primary" data-gl="${{ 'merge-main': 'merge', beta: 'beta', rebuild: 'rebuild' }[plan.fix]}" data-p="${esc(plan.product)}" title="Clears the blockers on beta. Nothing goes live.">${{ 'merge-main': 'Merge live into beta', beta: 'Play beta', rebuild: 'Rebuild beta' }[plan.fix]}</button></div>` : ''}
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
    if (b.dataset.gl === 'rebuild') {
      const r = await api('/api/build', { method: 'POST', body: { product: p, force: true } });
      out(`<p>Rebuilding beta on top of what's live (run ${esc(r.run)}). Nothing goes live. Open this again when it's done.</p>`);
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
      ${steps.filter((s) => s.kind !== 'review').map((s) => `<div class="test"><span>${icon(s.status)}</span><span class="name">${esc(s.kind)} ${esc(s.name)}</span><span class="detail">${esc(s.detail ?? '')}</span>${slowPill(s)}${s.data?.video ? `<a href="${file(s.data.video)}" target="_blank" rel="noopener" data-video="${file(s.data.video)}">▶ video</a>` : ''}</div>${s.kind === 'check' && s.status === 'failed' ? `<pre>${esc(s.data?.tail ?? '')}</pre>` : ''}`).join('')}
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

const F_STATUS = { open: 'Not fixed yet', fixing: 'An agent is fixing it', fixed: 'Fixed', wontfix: "Set aside (won't fix)", idea: 'An idea: never fixed by itself', expired: 'An idea that expired (not seen for 14 days)' };
const F_MOVE = { fixing: 'Mark fixing', fixed: 'Mark fixed', wontfix: "Won't fix", open: 'Back to the backlog', idea: 'Move to ideas' };
function findingHtml(f) {
  // J's reports from the beta sites (and the errors they report by themselves, source auto): their screenshot is in
  // Gen's library once imported, else Studio keeps it.
  const own = (f.source === 'J' || f.source === 'auto') && !(f.shots ?? []).length ? `<img loading="lazy" src="/api/bugreports/${f.id}/shot" data-full="/api/bugreports/${f.id}/shot" onerror="this.remove()">` : '';
  const shots = own + (f.shots ?? []).slice(0, 4).map((a) => `<img loading="lazy" src="${file(a)}" data-full="${file(a)}">`).join('');
  // One clear action: an open bug goes to an agent, an idea back to the backlog; the rest are under Details.
  const main = !f.id ? '' : f.status === 'open' ? `<button class="small primary" data-pro="agents" data-agentfix="${f.id}" data-product="${esc(f.product)}" title="An agent fixes it on its own branch; it merges into beta when its checks pass">Fix with agent</button>`
    : ['idea', 'expired'].includes(f.status) ? `<button class="small" data-finding="${f.id}" data-status="open">${F_MOVE.open}</button>` : '';
  const moves = f.id ? ['fixing', 'fixed', 'wontfix', 'open', 'idea'].filter((s) => s !== f.status && !(s === 'fixing' && f.status === 'idea') && !(s === 'open' && ['idea', 'expired'].includes(f.status))) : [];
  const where = [f.product, f.scenario, f.area].filter(Boolean).map(esc).join(' · ');
  return `<div class="finding${f.source === 'J' ? ' from-j' : ''}"${f.id ? ` data-fid="${esc(f.id)}"` : ''}><div>
      <h4><span class="pill ${f.severity}">${esc(f.severity)}</span>${f.source === 'J' ? '<span class="pill j" title="J reported it from the beta site: top priority">J</span>' : f.source === 'auto' ? '<span class="pill auto" title="The beta site caught this error by itself">auto</span>' : ''}${esc(f.title)}</h4>
      ${f.status ? `<div class="status-line">${esc(F_STATUS[f.status] ?? f.status)}${f.seen > 1 ? ` · seen ${f.seen} times` : ''}${where ? ` · ${where}` : ''}</div>` : f.area ? `<div class="meta">${esc(f.area)}</div>` : ''}
      <div class="meta"${f.source === 'J' || f.source === 'auto' ? ' style="white-space:pre-line"' : ''}>${esc(f.detail ?? '')}</div>
      ${f.id ? '' : `<div class="fix"><b>Fix:</b> ${esc(f.fix ?? '')}</div>`}
      ${f.id ? `<details class="more-details"><summary class="meta">Details</summary>
        <div class="fix"><b>Suggested fix:</b> ${esc(f.fix ?? '')}</div>${f.note ? `<div class="meta">Note: ${esc(f.note)}</div>` : ''}
        <div class="meta">${esc(f.id)} · seen ${f.seen}×</div>
        <div class="actions">${moves.map((s) => `<button class="small" data-finding="${f.id}" data-status="${s}">${F_MOVE[s]}</button>`).join('')}</div>
      </details>` : ''}
    </div><div class="side">${shots ? `<div class="thumbs">${shots}</div>` : ''}${main ? `<div class="actions">${main}</div>` : ''}</div></div>`;
}

// ---------------------------------------------------------- backlog
async function loadBacklog() {
  if ($('#blProduct').options.length <= 1 && overview) $('#blProduct').innerHTML += overview.products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const qs = new URLSearchParams({ status: $('#blStatus').value, ...($('#blProduct').value ? { product: $('#blProduct').value } : {}) });
  const { findings } = await api(`/api/findings?${qs}`);
  // J's own reports first (the PM loop starts them first too), then the worst first.
  const SEV = { blocker: 0, bug: 1, polish: 2, idea: 3 };
  findings.sort((a, b) => (b.source === 'J') - (a.source === 'J') || (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9));
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
  $('#runList').innerHTML = runs.map((r) => `<div class="run-row" data-run="${r.id}"><span>${icon(['done', 'running', 'skipped'].includes(r.status) ? r.status : 'failed')}</span><b>${esc(r.kind)}</b><span class="meta">${new Date(r.started).toLocaleString()}</span><span>${esc(r.detail ?? '')}</span><span class="meta" style="margin-left:auto">$${(r.cost ?? 0).toFixed(2)}</span></div>`).join('') || '<div class="empty">No runs yet.</div>';
  if (openRun) {
    const r = await api(`/api/runs/${openRun}`);
    $('#runDetail').innerHTML = `<div class="steps"><h3>${esc(r.id)} · ${esc(r.status)}</h3>${r.steps.map((s) => `<div class="step"><span>${icon(s.status)}</span><span>${esc(s.product)}</span><span>${esc(s.kind)}</span><span>${esc(s.name)}</span><span class="detail">${slowPill(s)}${esc(s.detail ?? '')}${s.job && !window.studioMe?.customer ? ` · <a href="${GEN}/#job/${s.job}" target="_blank">${esc(s.job)}</a>` : ''}</span></div>`).join('')}</div>`;
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
    if (tab === 'resources' && window.loadResourcesTab) await window.loadResourcesTab();
    if (tab === 'analytics' && window.loadAnalyticsTab) await window.loadAnalyticsTab();
    if (tab === 'social' && window.loadSocialTab) await window.loadSocialTab();
    if (tab === 'videos' && window.loadVideosTab) await window.loadVideosTab();
    if (tab === 'live' && window.loadLiveTab) await window.loadLiveTab();
    if (tab === 'golive' && window.loadGoLiveTab) await window.loadGoLiveTab();
    if (tab === 'library' && window.loadLibraryTab) await window.loadLibraryTab();
    if (tab === 'settings' && window.loadSettingsTab) await window.loadSettingsTab();
    if (tab === 'users' && window.loadUsersTab) await window.loadUsersTab();
    if (tab === 'talk' && window.loadTalk && !window.__talkLoaded) { window.__talkLoaded = true; await window.loadTalk(); }
  } catch (e) {
    $('#status').innerHTML = `<span><span class="dot bad"></span>${esc(e.message)}</span>`;
  }
}
// #live/<job> on the first load: that playtest opens big (live.js).
show(tab, tab === 'live' ? /^#live\/(j_[0-9a-f]+)/.exec(location.hash)?.[1] : undefined);
// Today, Runs and Changes refresh when the push stream says changes or runs moved (stream.js; also its slow safety tick).
studioStream.on(['changes', 'runs'], () => { if (tab === 'today' || tab === 'runs' || tab === 'changes') refresh(); });

// ----------------------------------------------------------- changes
const CH_WORDS = { queued: 'Waiting its turn', working: 'The agent is working on it', verifying: 'Checking its work', revising: 'Making the changes asked for', ready: 'Ready', merged: 'Merged', failed: "Didn't work", closed: 'Closed', cancelled: 'Cancelled (not a failure): its branch is kept' };
const CH_ICON = { queued: '⏳', working: '🛠️', verifying: '🎮', revising: '🛠️', ready: '👀', merged: '✅', failed: '❌', closed: '🗑️', cancelled: '🚫' };
async function loadChanges() {
  const qs = new URLSearchParams($('#chStatus').value ? { status: $('#chStatus').value } : {});
  const r = await api(`/api/changes?${qs}`);
  // It refreshes every few seconds: it redraws only when something changed, and what J opened (a summary, a log) stays open.
  const sig = JSON.stringify(r.changes.map((c) => [c.id, c.status, c.detail, c.updated])) + r.today.count;
  if (sig === loadChanges.sig && $('#chList').children.length) return;
  loadChanges.sig = sig;
  const open = new Set([...$('#chList').querySelectorAll('details[open]')].map((d) => d.dataset.key));
  $('#chInfo').textContent = `Today: ${r.today.count} fixes, $${r.today.cost.toFixed(2)} of $${r.settings.maxCostPerDay} · auto-fix ${r.settings.autoFix ? 'on' : 'off'} (${r.settings.severities.join(', ')}, up to ${r.settings.maxPerDay}/day)`;
  // What waits on a person first (ready, failed), then what's running, then the rest.
  const first = (c) => (['ready', 'failed'].includes(c.status) ? 0 : ['working', 'verifying', 'revising', 'queued'].includes(c.status) ? 1 : 2);
  const list = r.changes.map((c, i) => ({ c, i })).sort((x, y) => first(x.c) - first(y.c) || x.i - y.i).map((x) => x.c);
  $('#chList').innerHTML = list.length ? list.map((c) => {
    const v = c.verify;
    // A product change is playtested only on request ("Playtest this change"); not being playtested is plain info.
    const played = v && (v.playtest || (v.outcome && v.outcome !== 'not played'));
    const brainPill = c.harness_label || c.harness
      ? ` <span class="pill" title="${esc([c.role, c.harness_label || c.harness, c.model].filter(Boolean).join(' · '))}">${esc(c.harness_label || c.harness)}${c.model ? ` · ${esc(c.model)}` : ''}</span>`
      : '';
    return `<div class="finding" data-cid="${c.id}"><div>
      <h4>${CH_ICON[c.status] ?? ''} ${esc(c.title)} <span class="pill ${c.status === 'ready' ? 'ship' : c.status === 'failed' ? 'failed' : ''}">${esc(c.status)}</span>${brainPill}</h4>
      <div class="status-line">${esc(CH_WORDS[c.status] ?? c.status)}${c.product ? ` · ${esc(c.product)}` : ''}${c.detail ? `: ${esc(c.detail)}` : ''}</div>
      ${ChangeStages.barHtml(c.status, c.stage ?? {})}
      ${v && c.infra ? `<div class="summary"><b>Checks:</b> <span class="pill ${esc(v.verdict ?? '')}">${esc(v.outcome ?? '')}</span> ${esc(v.summary ?? '')}</div>` : played ? `<div class="summary"><b>Playtest:</b> ${esc(v.outcome ?? '')} · review <span class="pill ${esc(v.verdict ?? '')}">${esc(v.verdict ?? 'n/a')}</span> ${esc(v.summary ?? '')}</div>` : ''}
      <details class="more-details" data-key="${c.id}:details"><summary class="meta">Details</summary>
        <div class="meta">${esc(c.id)} · $${(c.cost ?? 0).toFixed(2)}${c.harness_label ? ` · ${esc([c.role, c.harness_label, c.model].filter(Boolean).join(' · '))}` : ''}${c.diffstat ? ` · ${esc(c.diffstat)}` : ''}${c.pr_url ? ` · <a href="${esc(c.pr_url)}" target="_blank">pull request #${c.pr}</a>` : ''}</div>
        ${!played && !c.infra && c.status === 'ready' ? `<div class="meta">Not playtested${v?.error ? ` (the last playtest asked for couldn't run: ${esc(v.error)})` : ''}.</div>` : ''}
        ${c.notes?.length ? `<div class="meta">${c.notes.map((n) => `${esc(n.by)}: ${esc(n.text)}`).join(' · ')}</div>` : ''}
        ${c.summary ? `<details data-key="${c.id}:summary"><summary class="meta">What the agent did</summary><pre>${esc(c.summary)}</pre></details>` : ''}
        <details data-key="${c.id}:log"><summary class="meta">Log</summary><pre>${esc((c.log ?? []).slice(-40).join(String.fromCharCode(10)))}</pre></details>
        <div class="actions">
          ${c.status === 'ready' && !c.infra ? `<button class="small" data-change="${c.id}" data-act="playtest" title="Plays the change's scenario on its version (a build first for Unity), with a video and a review (a few cents).">${played ? 'Playtest again' : 'Playtest this change'}</button>` : ''}
          ${c.status === 'cancelled' ? `<button class="small" data-change="${c.id}" data-act="resume">Resume</button>` : ''}
          ${!['merged', 'closed'].includes(c.status) ? `<button class="small" data-admin data-change="${c.id}" data-act="close">Close</button>` : ''}
        </div>
      </details>
    </div><div class="side">
      ${v?.video ? `<a href="${file(v.video)}" target="_blank" rel="noopener" data-video="${file(v.video)}">▶ fixed version</a>` : ''}${v?.preview ? ` <a href="${esc(v.preview)}" target="_blank">🔗 try it</a>` : ''}
      <div class="actions">
        ${c.status === 'ready' && c.infra ? `<button class="small primary" data-admin data-change="${c.id}" data-act="approve" data-infra="1" data-guide="off" title="Merges it into main: ${esc(c.product)} deploys itself once CI passes (a restart).">Approve into main</button>` : c.status === 'ready' ? `<button class="small primary" data-change="${c.id}" data-act="approve" data-guide="off" title="Merges it into the beta branch (the beta site). Nothing goes live until you use Go live.">Approve into beta</button>` : ''}
        ${['ready', 'failed'].includes(c.status) ? `<button class="small" data-change="${c.id}" data-act="revise">Ask for changes</button>` : ''}
      </div></div></div>`;
  }).join('') : '<div class="empty">No changes here. Agents start on new bugs after each daily run, or use "Fix with agent" in the Backlog.</div>';
  for (const d of $('#chList').querySelectorAll('details[data-key]')) if (open.has(d.dataset.key)) d.open = true;
  // #changes/<id> (the Activity panel's "log" link) opens that change's log once.
  const want = /^#changes\/(c_[0-9a-f]+)/.exec(location.hash)?.[1];
  const d = want && $(`#chList details[data-key="${want}:log"]`);
  if (d && loadChanges.opened !== want) { loadChanges.opened = want; d.open = true; d.parentElement.closest('details').open = true; d.scrollIntoView({ block: 'center' }); }
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
          : 'Merge this pull request into beta? The beta site follows; nothing goes live until you use the Go live tab.';
        if (!confirm(ask)) return;
        await api(`/api/changes/${id}/approve`, { method: 'POST', body: { confirm: `MERGE ${id}`, by: 'J' } });
      }
      if (b.dataset.act === 'revise') {
        const note = prompt('What should the agent change?');
        if (!note) return;
        await api(`/api/changes/${id}/revise`, { method: 'POST', body: { note, by: 'J' } });
      }
      if (b.dataset.act === 'playtest') await api(`/api/changes/${id}/playtest`, { method: 'POST', body: { by: 'J' } });
      if (b.dataset.act === 'resume') await api(`/api/changes/${id}/resume`, { method: 'POST', body: { by: 'J' } });
      if (b.dataset.act === 'close' && confirm('Close this change and its pull request?')) await api(`/api/changes/${id}/close`, { method: 'POST', body: { by: 'J' } });
      loadChanges.sig = null;
      loadChanges();
    } catch (err) { alert(err.message); }
  }
  const fx = e.target.closest('button[data-agentfix]');
  if (fx) {
    try {
      const r = await api('/api/changes', { method: 'POST', body: { product: fx.dataset.product, findings: [fx.dataset.agentfix] } });
      alert(`An agent is on it (${r.change}). Follow it in More → Changes.`);
      tab === 'backlog' ? loadBacklog() : loadReport();
    } catch (err) { alert(err.message); }
  }
});

// The beta lane (studio-beta.hawkesgen.ai, on gen-beta) says so on every page, so it's never taken for live.
fetch('/api/health').then((r) => r.json()).then((h) => {
  if (h.lane !== 'beta') return;
  document.title = `BETA · ${document.title}`;
  document.querySelector('header .brand .mark')?.parentElement?.insertAdjacentHTML('beforeend', ' <span class="lane-badge">BETA</span>');
}).catch(() => {});

// "Run a playtest" on the Playtests tabs: pick a game, it plays its main scenario (a video and a review), and the run
// shows up here and in Activity like any other.
function fillPlaytestBars(products) {
  for (const sel of document.querySelectorAll('.ptRunProduct')) {
    const cur = sel.value;
    sel.innerHTML = products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if (cur) sel.value = cur;
    sel.closest('.pt-run').hidden = !products.length;
  }
}
document.addEventListener('click', async (e) => {
  const go = e.target.closest('.ptRunGo');
  if (!go) return;
  const bar = go.closest('.pt-run');
  const msg = bar.querySelector('.ptRunMsg');
  go.disabled = true;
  msg.textContent = 'Starting…';
  try {
    await api('/api/playtest', { method: 'POST', body: { product: bar.querySelector('.ptRunProduct').value } });
    msg.textContent = 'Started: it shows up here in a minute, with its video and review when it ends.';
  } catch (err) {
    msg.textContent = err.message;
  }
  go.disabled = false;
});

// What a customer sees by plan and role (src/entitlements.ts, src/auth.ts; the API refuses the same things anyway):
//   data-pro="<feature>"  a control their plan lacks: greyed out, and a click offers the Upgrade (Stripe Checkout)
//   data-admin            a control only the Studio's admins use (going live, merging, settings): hidden from members
//   data-platform         J's own machinery (content wiring, his servers): hidden in every customer's Studio
// users.js calls it once /api/me is in; tabs drawn later pick the rules up from the body's classes.
function gateUi(me) {
  const b = document.body;
  b.classList.toggle('is-customer', Boolean(me?.customer));
  b.classList.toggle('is-member', Boolean(me?.customer) && me?.user?.role !== 'admin');
  b.dataset.locked = (me?.entitlements?.locked ?? []).join(' ');
}
window.gateUi = gateUi;
(() => {
  const css = document.createElement('style');
  css.textContent = `
    body.is-member [data-admin], body.is-customer [data-platform] { display: none !important; }
    ${['agents', 'pm', 'nightly', 'desktop', 'cloudBuilds'].map((f) => `body[data-locked~="${f}"] [data-pro="${f}"]`).join(', ')} { opacity: .5; cursor: pointer; }
    ${['agents', 'pm', 'nightly', 'desktop', 'cloudBuilds'].map((f) => `body[data-locked~="${f}"] [data-pro="${f}"]::after`).join(', ')} { content: " 🔒"; }`;
  document.head.append(css);
})();
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-pro]');
  if (!el) return;
  const f = el.dataset.pro;
  if (!(document.body.dataset.locked ?? '').split(' ').includes(f)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const offer = window.studioMe?.entitlements?.offers?.[f] ?? { feature: f, plan: 'studio_team', planName: 'Team', name: f };
  studioUpgrade({ error: `${offer.name} ${f === 'pm' ? 'is' : 'are'} on the ${offer.planName} plan and up.`, upgrade: offer });
}, true);
