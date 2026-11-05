// The Customers page (admin-only; src/admin-customers.ts): every customer studio with its owner, plan, credits, activity,
// projects and status; search and sort; one studio's members, ledger and usage; suspend / unsuspend; gift credits (with a
// reason, asked to confirm). It fetches when the page opens and after each action, never on a timer (no polling).
// Uses app.js's helpers ($, esc, api, ago).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .cu-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .cu-bar input, .cu-bar select, .cu-form input { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; color: inherit; }
    .cu-bar input[type=search] { flex: 1 1 240px; }
    .cu-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .cu-table th { text-align: left; color: var(--dim); font-weight: 500; padding: 4px 8px; white-space: nowrap; }
    .cu-table td { padding: 7px 8px; border-top: 1px solid var(--line); vertical-align: top; }
    .cu-table tr[data-org] { cursor: pointer; } .cu-table tr[data-org]:hover td { background: var(--panel2); }
    .cu-table .num { text-align: right; font-variant-numeric: tabular-nums; }
    .cu-box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin-top: 14px; }
    .cu-box h3 { margin: 0 0 6px; font-size: 15px; } .cu-box h4 { margin: 12px 0 4px; font-size: 13px; }
    .cu-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
    .cu-form input[name=reason] { flex: 1 1 260px; }
    .cu-msg .err { color: var(--red); } .cu-msg .ok { color: var(--accent); }
    .pill.suspended { color: var(--red); border-color: rgba(255,107,107,.4); }
    .cu-wrap { overflow-x: auto; }`;
  document.head.appendChild(css);

  const st = { list: null, q: '', sort: 'created', dir: -1, open: null, detail: null, msg: '' };
  const num = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString());
  const day = (t) => (t ? new Date(t).toLocaleDateString() : '–');
  const planName = (p) => (p.id === 'free' ? 'Free' : p.id.replace(/^studio_/, '').replace(/_/g, ' ')) + (p.status === 'gift' ? ' (gift)' : '');
  const KEYS = {
    name: (c) => (c.name || c.id).toLowerCase(), owner: (c) => c.ownerEmail, plan: (c) => planName(c.plan), credits: (c) => c.credits,
    created: (c) => c.created, activity: (c) => c.lastActivity ?? 0, projects: (c) => c.projects ?? -1, status: (c) => c.status,
  };
  const pill = (c) => `<span class="pill ${c.status === 'suspended' ? 'suspended' : ''}">${esc(c.status)}</span>`;

  function shown() {
    const q = st.q.trim().toLowerCase();
    const rows = (st.list?.customers ?? []).filter((c) => !q || [c.name, c.id, c.ownerEmail, planName(c.plan), c.status].some((x) => String(x ?? '').toLowerCase().includes(q)));
    const f = KEYS[st.sort] ?? KEYS.created;
    return rows.sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0) * st.dir);
  }

  function listHtml() {
    const rows = shown();
    const th = (k, label, cls = '') => `<th class="${cls}" data-sort="${k}" style="cursor:pointer">${label}${st.sort === k ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    return `<div class="cu-bar"><input type="search" id="cuQ" placeholder="Search name, owner, plan, status…" value="${esc(st.q)}"><span class="meta">${rows.length} of ${st.list.customers.length} studios</span></div>
      <div class="cu-wrap"><table class="cu-table"><thead><tr>${th('name', 'Studio')}${th('owner', 'Owner')}${th('plan', 'Plan')}${th('credits', 'Credits', 'num')}${th('created', 'Created')}${th('activity', 'Last activity')}${th('projects', 'Projects', 'num')}${th('status', 'Status')}</tr></thead>
      <tbody>${rows.map((c) => `<tr data-org="${esc(c.id)}"><td><b>${esc(c.name || c.id)}</b><div class="meta">${esc(c.id)}</div></td><td>${esc(c.ownerEmail)}</td><td>${esc(planName(c.plan))}</td><td class="num">${num(c.credits)}</td><td>${day(c.created)}</td><td>${c.lastActivity ? esc(ago(c.lastActivity)) : '–'}</td><td class="num">${num(c.projects)}</td><td>${pill(c)}</td></tr>`).join('') || '<tr><td colspan="8" class="meta">No studios match.</td></tr>'}</tbody></table></div>
      ${st.list.cellsOn ? '' : '<div class="meta">This Studio is not the control plane (STUDIO_CELLS is off), so there are no customer studios to show.</div>'}`;
  }

  function detailHtml(d) {
    const kinds = d.usage.byKind.map((u) => `<tr><td>${esc(u.kind.replace(/_/g, ' '))}</td><td class="num">${num(u.n)}</td><td class="num">${u.credits > 0 ? '+' : ''}${num(u.credits)}</td></tr>`).join('');
    const ledger = d.ledger.map((l) => `<tr><td>${esc(new Date(l.created).toLocaleString())}</td><td>${esc(l.kind.replace(/_/g, ' '))}</td><td>${esc(l.detail ?? '')}</td><td class="num">${l.delta > 0 ? '+' : ''}${num(l.delta)}</td><td class="num">${num(l.balance_after)}</td></tr>`).join('');
    const members = d.members.map((m) => `<div class="meta">${esc(m.email)}${m.name ? ` (${esc(m.name)})` : ''} · ${esc(m.kind === 'invite' ? 'invited' : m.role)}</div>`).join('') || '<div class="meta">None reported yet (a studio reports its people when it is awake).</div>';
    return `<div class="cu-box" data-detail="${esc(d.id)}"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><h3>${esc(d.name || d.id)} <span class="meta">${esc(d.id)}</span> ${pill(d)}</h3><button class="small" data-close>Close</button></div>
      <div class="meta">${esc(d.ownerEmail)} · ${esc(planName(d.plan))} · created ${day(d.created)} · ${num(d.projects)} projects · ${d.members} ${d.members === 1 ? 'person' : 'people'}${d.hibernatedAt ? ` · asleep since ${day(d.hibernatedAt)}` : ''}${d.error ? ` · <span class="err">${esc(d.error)}</span>` : ''}</div>
      ${d.suspended ? `<div class="meta"><span class="err">Suspended ${day(d.suspended.at)}${d.suspended.by ? ` by ${esc(d.suspended.by)}` : ''}: ${esc(d.suspended.reason ?? '')}</span></div>` : ''}
      ${d.gift ? `<div class="meta">🎁 Gift plan ${esc(d.gift.plan)} ${d.gift.until ? `until ${day(d.gift.until)}` : 'for good'}${d.gift.note ? ` · ${esc(d.gift.note)}` : ''} (change plan gifts in Settings → Platform)</div>` : ''}
      <h3 style="margin-top:12px">Balance: ${num(d.credits)} credits</h3>
      <form class="cu-form" data-gift><input name="amount" type="number" min="1" max="${d.giftMax}" step="1" placeholder="credits (1–${num(d.giftMax)})" style="width:170px" required>
        <input name="reason" placeholder="Why (required: it is written in the ledger)" maxlength="200" required><button class="small primary" type="submit">Gift credits…</button></form>
      <form class="cu-form" data-suspend>${d.suspended ? '<button class="small" type="submit">Unsuspend</button>' : '<input name="reason" placeholder="Why suspend (required)" maxlength="200" required><button class="small" type="submit">Suspend…</button>'}</form>
      <div class="cu-msg meta">${st.msg}</div>
      <h4>People</h4>${members}
      <h4>Last ${d.usage.days} days</h4><div class="meta">${num(d.usage.spent)} credits spent · ${num(d.usage.added)} added</div>
      ${kinds ? `<table class="cu-table"><thead><tr><th>What</th><th class="num">Entries</th><th class="num">Credits</th></tr></thead><tbody>${kinds}</tbody></table>` : ''}
      <h4>Recent ledger</h4><div class="cu-wrap"><table class="cu-table"><thead><tr><th>When</th><th>Kind</th><th>Detail</th><th class="num">Credits</th><th class="num">Balance</th></tr></thead><tbody>${ledger || '<tr><td colspan="5" class="meta">Nothing yet.</td></tr>'}</tbody></table></div></div>`;
  }

  function draw() {
    const body = $('#cuBody');
    if (!body || !st.list) return;
    const q = body.querySelector('#cuQ');
    const had = document.activeElement === q;
    body.innerHTML = listHtml() + `<div id="cuDetail">${st.detail ? detailHtml(st.detail) : ''}</div>`;
    if (had) { const n = body.querySelector('#cuQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  }

  async function openOrg(id) {
    st.open = id; st.msg = '';
    try { st.detail = await api(`/api/admin/customers/${encodeURIComponent(id)}`); } catch (e) { st.detail = null; st.msg = `<span class="err">${esc(e.message)}</span>`; }
    draw();
    $('#cuDetail')?.scrollIntoView({ block: 'nearest' });
  }

  async function loadCustomersTab() {
    const body = $('#cuBody');
    try { st.list = await api('/api/admin/customers'); } catch (e) { body.innerHTML = `<div class="meta"><span class="dot bad"></span> ${esc(e.message)}</div>`; return; }
    if (st.open) { try { st.detail = await api(`/api/admin/customers/${encodeURIComponent(st.open)}`); } catch { st.detail = null; } }
    draw();
  }

  document.addEventListener('input', (e) => { if (e.target.id === 'cuQ') { st.q = e.target.value; draw(); } });
  document.addEventListener('click', (e) => {
    const body = e.target.closest('#cuBody');
    if (!body) return;
    const s = e.target.closest('[data-sort]');
    if (s) { st.dir = st.sort === s.dataset.sort ? -st.dir : 1; st.sort = s.dataset.sort; draw(); return; }
    if (e.target.closest('[data-close]')) { st.open = null; st.detail = null; draw(); return; }
    const r = e.target.closest('tr[data-org]');
    if (r) openOrg(r.dataset.org);
  });
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('#cuBody form');
    if (!form) return;
    e.preventDefault();
    const id = st.open;
    const f = new FormData(form);
    const btn = form.querySelector('button');
    try {
      if (form.hasAttribute('data-gift')) {
        const amount = Number(f.get('amount')); const reason = String(f.get('reason') ?? '').trim();
        if (!confirm(`Gift ${amount.toLocaleString()} credits to ${st.detail?.name || id}?\n\nReason: ${reason}\n\nIt is written to their ledger as an admin gift from you, and can't be undone from here.`)) return;
        btn.disabled = true;
        const r = await api(`/api/admin/customers/${encodeURIComponent(id)}/gift-credits`, { method: 'POST', body: { amount, reason, confirm: true, key: (st.giftKey ??= crypto.randomUUID()) } });
        st.giftKey = null;
        st.msg = `<span class="ok">Gave ${num(r.added)} credits. New balance: ${num(r.credits)}.</span>`;
      } else if (st.detail?.suspended) {
        if (!confirm(`Unsuspend ${st.detail.name || id}? Its studio wakes on the next visit.`)) return;
        btn.disabled = true;
        await api(`/api/admin/customers/${encodeURIComponent(id)}/unsuspend`, { method: 'POST', body: {} });
        st.msg = '<span class="ok">Unsuspended.</span>';
      } else {
        const reason = String(f.get('reason') ?? '').trim();
        if (!confirm(`Suspend ${st.detail?.name || id}?\n\nIts studio stops now and can't wake, run or spend credits until you unsuspend it. Its data stays.\n\nReason: ${reason}`)) return;
        btn.disabled = true;
        await api(`/api/admin/customers/${encodeURIComponent(id)}/suspend`, { method: 'POST', body: { reason } });
        st.msg = '<span class="ok">Suspended.</span>';
      }
      await loadCustomersTab();
    } catch (err) { if (btn) btn.disabled = false; st.msg = `<span class="err">${esc(err.message)}</span>`; draw(); }
  });
  window.loadCustomersTab = loadCustomersTab;
})();
