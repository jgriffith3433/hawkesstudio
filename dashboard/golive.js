// The Go live tab: every product at a glance, live vs beta in plain words, and buttons. Each product's card reads the
// same plan as the go-live dialog (GET /api/deploy/<p>: commits on beta not on main, beta's playtests, blockers and
// warnings) and the ops queue (GET /api/ops: a go live or rollback queued or running). "Go live" and "Roll back" never
// act by themselves: they ask for the same Approve card (approval.js, kind deploy / rollback, bound to that plan) and
// show it right there; J's tap on Approve is what goes live. Uses app.js's helpers ($, esc, api, ago) and approvals.
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .gl-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
    .gl-card { background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: var(--radius); padding: 14px 16px; min-width: 0; }
    .gl-card.green { border-left-color: var(--accent); } .gl-card.yellow { border-left-color: var(--amber); } .gl-card.red { border-left-color: var(--red); }
    .gl-card h3 { margin: 0 0 6px; font-size: 17px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .gl-light { width: 14px; height: 14px; border-radius: 50%; background: var(--line); flex: none; }
    .gl-light.green { background: var(--accent); } .gl-light.yellow { background: var(--amber); } .gl-light.red { background: var(--red); }
    .gl-status { font-size: 18px; font-weight: 700; margin: 4px 0; } .gl-status.ahead { color: var(--amber); } .gl-status.same { color: var(--accent); }
    .gl-when { color: var(--dim); font-size: 13px; margin-bottom: 8px; }
    .gl-light-line { margin: 8px 0; font-size: 14px; }
    .gl-group { margin: 6px 0; font-size: 14px; } .gl-group b { font-size: 13px; color: var(--dim); font-weight: 600; }
    .gl-group ul { margin: 2px 0 0; padding-left: 18px; }
    .gl-buttons { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .gl-buttons button.big { font-size: 17px; padding: 12px 22px; border-radius: 12px; flex: 1 1 auto; min-height: 48px; }
    .gl-buttons button.roll { flex: 0 1 auto; min-height: 48px; }
    .gl-busy { background: rgba(255,190,85,.12); border: 1px solid rgba(255,190,85,.4); border-radius: 8px; padding: 8px 10px; margin: 8px 0; font-size: 14px; }
    .gl-done { font-size: 13px; margin: 6px 0; }
    .gl-slot:not(:empty) { margin-top: 10px; }
    .gl-card details { margin-top: 8px; font-size: 13px; } .gl-card details code { font-size: 12px; }
    @media (max-width: 700px) { .gl-list { grid-template-columns: 1fr; } .gl-buttons button.big { width: 100%; } }`;
  document.head.appendChild(css);

  const plans = new Map(); // product -> plan (or { error })
  let products = [];
  let ops = [];
  let pending = []; // waiting deploy / rollback cards
  let busy = false;

  const when = (d) => (d ? ago(typeof d === 'number' ? d : Date.parse(d)) : 'unknown');
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

  /** Who made a commit, in J's words. */
  function who(c) {
    if (/^devtools:/.test(c.title) || /devtools/i.test(c.author)) return 'Your devtools saves';
    if (/agent/i.test(c.author) || /\(#\d+\)\s*$/.test(c.title) || /^Merge pull request/.test(c.title)) return 'Agent changes';
    if (/^Hawkes Studio/.test(c.author) || /^(Studio build:|Rollback:)/.test(c.title)) return 'Studio (builds and merges)';
    return c.author === 'J' || /griffith/i.test(c.author) ? 'You (J)' : c.author;
  }
  const plain = (t) => String(t).replace(/\s*\(#\d+\)\s*$/, '').replace(/^J(?:'s words)?:\s*"?([^"]*)"?\s*$/, '$1').replace(/^devtools:\s*/, 'Saved ').slice(0, 140);

  /** Beta is ahead of live: new commits, or (Unity) a new build that differs from what's live. */
  const ahead = (p) => p.commits.length > 0 || !!(p.unity && p.build?.ok && p.build.files > 0);
  const nothingToDo = (b) => /^Nothing to go live/.test(b);

  /** The light: red = can't go live yet, yellow = can, with warnings, green = ready (or nothing to do). */
  function light(p) {
    const blockers = p.blockers.filter((b) => !nothingToDo(b));
    const t = p.tested.playtests;
    const played = t.length ? `Beta was playtested ${when(Math.max(...t.map((x) => x.when ?? 0)))}: ${t.map((x) => `${x.name} ${x.outcome ?? x.status}${x.verdict ? ` (review: ${x.verdict})` : ''}`).join(', ')}.` : 'This version of beta hasn\'t been playtested yet.';
    if (!ahead(p) && !p.mainOnly.length) return { color: 'green', text: 'Nothing waiting.', played: t.length ? played : '' };
    if (blockers.length) return { color: 'red', text: 'Not ready to go live yet.', played, why: blockers };
    if (p.warnings.length) return { color: 'yellow', text: 'Ready, but look at the warnings first.', played, why: p.warnings };
    return { color: 'green', text: 'Ready to go live: playtested with no problems.', played };
  }

  const liveOps = (id) => ops.filter((o) => o.product === id && (o.kind === 'golive' || o.kind === 'rollback'));

  function card(prod) {
    const p = plans.get(prod.id);
    if (!p) return `<div class="gl-card" data-p="${esc(prod.id)}"><h3><span class="gl-light"></span>${esc(prod.name)}</h3><div class="meta">Checking beta and live…</div></div>`;
    if (p.error) return `<div class="gl-card red" data-p="${esc(prod.id)}"><h3><span class="gl-light red"></span>${esc(prod.name)}</h3><div class="meta">Couldn't check: ${esc(p.error)}</div></div>`;
    // Beta couldn't be read (git failed, or no beta branch yet): say so, never "up to date".
    if (!p.beta || p.blockers.some((b) => b.startsWith('git:'))) return `<div class="gl-card red" data-p="${esc(p.product)}"><h3><span class="gl-light red"></span>${esc(p.name)}</h3><div class="gl-status">Couldn't compare beta with live</div><ul class="meta">${p.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`;
    const L = light(p);
    const up = ahead(p);
    const status = up
      ? (p.commits.length ? `Beta is ${n(p.commits.length, 'change')} ahead of live` : 'Beta has a new build that isn\'t live')
      : p.mainOnly.length ? 'Live has changes beta doesn\'t have' : 'Live is up to date';
    const lastLive = Math.max(p.previous[0]?.at ?? 0, p.main ? Date.parse(p.main.date) : 0) || null;
    const groups = {};
    for (const c of p.commits) (groups[who(c)] ??= []).push(c);
    const run = liveOps(p.product).filter((o) => o.status === 'queued' || o.status === 'running');
    const last = liveOps(p.product).find((o) => o.status === 'done' || o.status === 'failed');
    const recent = last && Date.now() - (last.finished ?? last.created) < 6 * 3600_000 ? last : null;
    const canRoll = p.previous.some((d) => d.kind === 'deploy' && !d.rolledBack);
    const card = pending.find((a) => a.target === p.product && (a.kind === 'deploy' || a.kind === 'rollback'));
    return `<div class="gl-card ${L.color}" data-p="${esc(p.product)}">
      <h3><span class="gl-light ${L.color}" title="${esc(L.text)}"></span>${esc(p.name)}</h3>
      <div class="gl-status ${up ? 'ahead' : 'same'}">${esc(status)}</div>
      <div class="gl-when">Live updated ${esc(when(lastLive))} · beta changed ${esc(when(p.beta?.date))}</div>
      ${run.map((o) => `<div class="gl-busy">⏳ ${esc(o.title)}${o.status === 'queued' ? ' (waiting its turn)' : o.step ? `: ${esc(o.step)}` : '…'}</div>`).join('')}
      ${!run.length && recent ? `<div class="gl-done">${recent.status === 'done' ? `✅ ${esc(recent.kind === 'rollback' ? 'Rolled back' : 'Went live')} ${esc(ago(recent.finished))}` : `❌ ${esc(recent.title)} failed ${esc(ago(recent.finished))}: ${esc(String(recent.error ?? '').slice(0, 200))}`}</div>` : ''}
      ${Object.entries(groups).map(([g, cs]) => `<div class="gl-group"><b>${esc(g)} (${cs.length})</b><ul>${cs.slice(0, 6).map((c) => `<li>${esc(plain(c.title))}</li>`).join('')}${cs.length > 6 ? `<li class="meta">and ${cs.length - 6} more</li>` : ''}</ul></div>`).join('')}
      ${up || p.mainOnly.length || L.played ? `<div class="gl-light-line"><b>${esc(L.text)}</b>${L.played ? `<br><span class="meta">${esc(L.played)}</span>` : ''}${L.why?.length ? `<ul>${L.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      <div class="gl-buttons">
        ${up && !run.length ? `<button class="primary big" data-glgo="deploy" data-guide="off" title="Shows the Approve card for going live; your tap on Approve is what goes live">Go live</button>` : ''}
        ${canRoll && !run.length ? `<button class="roll" data-glgo="rollback" data-guide="off" title="Shows the Approve card for rolling back to what was live before">Roll back</button>` : ''}
        ${p.betaSite ? `<a class="meta" href="${esc(p.betaSite)}" target="_blank" rel="noopener" style="align-self:center">Try beta</a>` : ''}
        <a class="meta" href="${esc(p.live)}" target="_blank" rel="noopener" style="align-self:center">Live site</a>
      </div>
      <div class="gl-slot">${card ? approvals.html(card) : ''}</div>
      <details><summary class="meta">Details</summary>
        <p>Live: ${p.main ? `<code>${esc(p.main.short)}</code> ${esc(p.main.title)}` : '<i>none</i>'}<br>Beta: ${p.beta ? `<code>${esc(p.beta.short)}</code> ${esc(p.beta.title)}` : '<i>none</i>'}</p>
        ${p.commits.map((c) => `<div class="meta"><code>${esc(c.short)}</code> ${esc(c.title)} · ${esc(c.author)} · ${esc(when(c.date))}</div>`).join('')}
        ${p.mainOnly.length ? `<p class="meta">Live has ${p.mainOnly.length} commit(s) beta lacks: ${p.mainOnly.map((c) => esc(c.title)).join('; ')}</p>` : ''}
        <p class="meta">${esc(p.what)}</p>
        <div class="actions"><button class="small" data-glplan="${esc(p.product)}" data-guide="off" title="The full go-live plan: update and playtest beta, merge live's commits into beta, previous go lives, the typed DEPLOY fallback">Full plan and more options…</button></div>
      </details>
    </div>`;
  }

  /** Redraws the cards, keeping open details and cards J is looking at. */
  function draw() {
    const box = $('#glList');
    const open = new Set([...box.querySelectorAll('.gl-card details[open]')].map((d) => d.closest('.gl-card').dataset.p));
    const slots = new Map([...box.querySelectorAll('.gl-card')].map((c) => [c.dataset.p, c.querySelector('.gl-slot')?.innerHTML ?? '']));
    box.innerHTML = products.map(card).join('') || '<div class="meta">No products.</div>';
    for (const c of box.querySelectorAll('.gl-card')) {
      if (open.has(c.dataset.p)) c.querySelector('details')?.setAttribute('open', '');
      const s = c.querySelector('.gl-slot');
      if (s && !s.innerHTML && slots.get(c.dataset.p)) s.innerHTML = slots.get(c.dataset.p);
    }
    const waiting = [...plans.values()].filter((p) => !p.error && ahead(p)).length;
    $('#glInfo').textContent = plans.size < products.length ? 'Checking every product…' : waiting ? `${n(waiting, 'product')} with beta ahead of live.` : 'Every live site is up to date with beta.';
  }

  async function loadOps() {
    const [o, a] = await Promise.all([api('/api/ops?limit=60'), approvals.call('/api/approvals?pending=1').catch(() => ({ approvals: [] }))]);
    const before = JSON.stringify(ops.filter((x) => x.status === 'queued' || x.status === 'running').map((x) => x.id));
    ops = o.ops;
    pending = a.approvals.filter((x) => x.status === 'pending');
    const now = JSON.stringify(ops.filter((x) => x.status === 'queued' || x.status === 'running').map((x) => x.id));
    return before !== now; // something started or finished: the plans moved
  }
  async function loadPlan(id) {
    try { plans.set(id, await api(`/api/deploy/${id}`)); } catch (e) { plans.set(id, { error: e.message }); }
    if (tab === 'golive') draw();
  }

  async function load() {
    if (busy) return;
    busy = true;
    try {
      products = (await api('/api/products')).products;
      await loadOps();
      draw();
      await Promise.all(products.map((p) => loadPlan(p.id)));
    } finally { busy = false; }
  }
  window.loadGoLiveTab = load;

  // While the tab is open: the queue every 5 s (cheap); when a go live starts or ends, the plans again.
  setInterval(async () => {
    if (tab !== 'golive' || busy || !products.length) return;
    try { if (await loadOps()) await load(); else draw(); } catch {}
  }, 5000);
  addEventListener('studio-approval', () => { if (tab === 'golive') setTimeout(() => loadOps().then(draw).catch(() => {}), 800); });

  $('#glRefresh').onclick = () => { plans.clear(); load().catch((e) => alert(e.message)); };
  $('#glList').addEventListener('click', async (e) => {
    const plan = e.target.closest('button[data-glplan]');
    if (plan) return void goLive(plan.dataset.glplan).catch((err) => alert(err.message));
    const b = e.target.closest('button[data-glgo]');
    if (!b || !e.isTrusted) return;
    const c = b.closest('.gl-card');
    const slot = c.querySelector('.gl-slot');
    b.disabled = true;
    slot.innerHTML = '<div class="meta">Making the card…</div>';
    try {
      const a = await approvals.request({ kind: b.dataset.glgo, target: c.dataset.p });
      slot.innerHTML = approvals.html(a);
      slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      slot.innerHTML = `<div class="meta" style="color:var(--red)">${esc(err.message)}</div>`;
    }
    b.disabled = false;
  });
})();
