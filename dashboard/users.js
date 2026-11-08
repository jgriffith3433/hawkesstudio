// The Users tab (admins only): who can sign in, invites by email, password resets, roles, and the sign-in log
// (GET /api/users, src/auth-pages.ts). Also the header's "signed in as" and Sign out, and the Users tab button, shown
// only to admins (GET /api/me). Uses app.js's helpers ($, esc, api, ago).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .me { color: var(--dim); font-size: 12px; white-space: nowrap; } .me a { color: var(--dim); margin-left: 6px; }
    .us-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; }
    .us-box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
    .us-box h3 { margin: 0 0 8px; font-size: 15px; }
    .us-row { display: flex; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .us-row:last-child { border-bottom: 0; } .us-row .who { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
    .us-form { display: flex; gap: 8px; flex-wrap: wrap; } .us-form input, .us-form select { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; color: inherit; }
    .us-form input[type=email] { flex: 1 1 220px; }
    .us-link { margin-top: 8px; padding: 8px; background: var(--panel2); border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }
    .us-log td { padding: 3px 8px 3px 0; font-size: 12px; vertical-align: top; } .us-log .bad { color: var(--red); }
    @media (max-width: 700px) { .us-grid { grid-template-columns: 1fr; } }`;
  document.head.appendChild(css);

  let me = null;

  // Who's signed in (header), and the Users tab for admins.
  async function loadMe() {
    let full = null;
    try {
      full = await api('/api/me');
      me = full.user;
    } catch {
      me = null;
    }
    window.studioMe = full;
    window.gateUi?.(full);
    try { window.groupNav?.(full); } finally { document.querySelector("nav.pending")?.classList.remove("pending"); }
    const status = $('#status');
    if (me && status && !$('#meBox')) {
      const el = document.createElement('span');
      el.id = 'meBox';
      el.className = 'me';
      el.innerHTML = `${esc(me.email)}${me.role === 'admin' ? ' · admin' : ''}<a href="/auth/set-password?next=/">password</a><a href="/auth/signout">sign out</a>`;
      status.after(el);
      // On a phone the header drops this row (style.css); the same links live at the bottom of the More menu.
      const menu = $('#moreMenu');
      if (menu && !$('#meMenu')) {
        const box = document.createElement('div');
        box.id = 'meMenu';
        box.className = 'me-menu';
        box.innerHTML = `<span class="meta">${esc(me.email)}${me.role === 'admin' ? ' · admin' : ''}</span><a href="/auth/set-password?next=/">password</a><a href="/auth/signout">sign out</a>`;
        menu.append(box);
      }
    }
    const btn = document.querySelector('nav button[data-tab="users"]');
    if (btn) btn.hidden = me?.role !== 'admin';
    // Customers: the platform admin's alone (/api/me says which; the API answers 403 to anyone else).
    const cuBtn = document.querySelector('nav button[data-tab="customers"]');
    if (cuBtn) cuBtn.hidden = !full?.platformAdmin || (full.hide ?? []).includes('customers');
    // The platform admin's features (src/lockdown.ts): hidden from everyone else (the API answers 403 to them anyway).
    for (const what of full?.hide ?? []) {
      const tabBtn = document.querySelector(`nav button[data-tab="${what}"]`);
      if (tabBtn) tabBtn.hidden = true;
      if (what === 'onair' && $('#onAir')) $('#onAir').hidden = true;
    }
    if (full?.onboarding) onboarding();
    if (full?.ai && !full.ai.ready && me?.role === 'admin') aiStep(full.ai);
  }

  // "Connect your AI" (src/ailink.ts): every provider the customer can link, Claude, Cursor, GitHub Copilot, Gemini
  // and Antigravity, each with its own way in (a key, a token, or a sign-in whose link they open and whose code they
  // paste back), which one is linked (only the last 4 of a key), and "Use this" for the one Talk and the agents run on.
  // Onboarding shows it on top until one is linked; Settings has it too (mountAiCard).
  const PLACEHOLDER = { claude: 'sk-ant-api03-…', cursor: 'your Cursor API key', copilot: 'github_pat_… or gho_…', gemini: 'AIza…' };
  // Changes to Your AI are an admin's own click (the server checks X-Studio-Click, as for Settings' Claude accounts).
  const click = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'X-Studio-Click': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: `Studio answered ${r.status}` }));
    if (!r.ok || d.error) throw new Error(d.error ?? `Studio answered ${r.status}`);
    return d;
  };
  const SIGNIN = {
    claude: { start: '/api/claude/signin', code: '/api/claude/signin/code', cancel: '/api/claude/signin/cancel', where: "Claude's sign-in page", url: (r) => r.url },
    antigravity: { start: '/api/antigravity/signin', code: '/api/antigravity/signin/code', cancel: '/api/antigravity/signin/cancel', where: "Google's sign-in page", url: (r) => r.signin?.url },
  };

  function aiCardHtml(ai, { onboarding }) {
    const row = (p) => {
      const state = p.linked
        ? `<span class="pill">connected${p.keyTail ? ` · …${esc(p.keyTail)}` : ''}</span> ${p.inUse ? '<span class="pill verdict pass">in use</span>' : `<button class="small" data-ai-use="${p.id}">Use this</button>`}`
        : '';
      const ways = p.methods.map((m) => (m.id === 'subscription' || m.id === 'signin')
        ? `<div class="ca-line"><button class="small" data-ai-signin="${p.id}">${esc(m.label)}</button> <span class="meta">${esc(m.help)}</span></div>`
        : `<div class="ca-line"><input type="password" data-ai-input="${p.id}" placeholder="${esc(PLACEHOLDER[p.id] ?? m.label)}" autocomplete="off" spellcheck="false"><button class="small" data-ai-save="${p.id}">Save</button>${p.linked && p.keyTail ? ` <button class="small" data-ai-remove="${p.id}">Remove</button>` : ''}</div><div class="meta">${esc(m.label)}. ${esc(m.help)} Stored encrypted; only its last 4 characters are ever shown.</div>`).join('');
      return `<div class="ca-add" data-ai-row="${p.id}"><b>${esc(p.name)}</b> <span class="meta">by ${esc(p.by)}</span> ${state}${ways}<div class="meta" data-ai-msg="${p.id}"></div></div>`;
    };
    return `<h3>${onboarding ? 'Connect your AI' : '🧠 Your AI'}</h3>
      <p class="meta">Talk and the agents run on <b>your</b> AI account, never ours. Connect one or more; "Use this" picks the one they run on.</p>
      ${ai.providers.map(row).join('')}
      ${onboarding ? '<div class="ca-line"><button class="small" id="aiLater">Later</button></div>' : ''}`;
  }

  function wireAiCard(el, { onboarding }) {
    const say = (id, html) => { const m = el.querySelector(`[data-ai-msg="${id}"]`); if (m) m.innerHTML = html; };
    const fail = (id, err) => say(id, `<span style="color:var(--red)">${esc(err.message)}</span>`);
    const redraw = async () => {
      const ai = await api('/api/ai');
      window.studioMe = { ...(window.studioMe ?? {}), ai };
      if (onboarding && ai.ready) { el.remove(); return; }
      el.innerHTML = aiCardHtml(ai, { onboarding });
    };
    el.addEventListener('click', async (e) => {
      const t = e.target;
      if (t.id === 'aiLater') { try { localStorage.setItem('studio.aiLater', String(Date.now())); } catch { /* no storage */ } el.remove(); return; }
      const id = t.dataset.aiSignin ?? t.dataset.aiSave ?? t.dataset.aiRemove ?? t.dataset.aiUse ?? t.dataset.aiFinish ?? t.dataset.aiCancel;
      if (!id) return;
      try {
        if (t.dataset.aiUse) { await click('/api/ai/use', { provider: id }); return redraw(); }
        if (t.dataset.aiSave || t.dataset.aiRemove) {
          const key = t.dataset.aiRemove ? null : el.querySelector(`[data-ai-input="${id}"]`).value;
          say(id, 'Saving…');
          await click(id === 'claude' ? '/api/claude/key' : `/api/ai/${id}/key`, { key });
          return redraw();
        }
        const s = SIGNIN[id];
        if (t.dataset.aiSignin) {
          t.disabled = true;
          say(id, 'Starting the sign-in…');
          const r = await click(s.start, { label: window.studioMe?.user?.email ?? '' });
          say(id, `<div>1. <a href="${esc(s.url(r) ?? '#')}" target="_blank" rel="noopener"><b>Open ${s.where}</b></a> and sign in with your own account.</div>
            <div>2. It shows a code. Paste it here:</div>
            <div class="ca-line"><input type="text" data-ai-code="${id}" placeholder="the code" autocomplete="off" spellcheck="false"><button class="small" data-ai-finish="${id}">Finish signing in</button><button class="small" data-ai-cancel="${id}">Cancel</button></div>
            <div class="meta">Signed in to the wrong account in your browser? Sign out there first, or open the link in a private window.</div>`);
          t.disabled = false;
          return;
        }
        if (t.dataset.aiFinish) {
          const code = el.querySelector(`[data-ai-code="${id}"]`).value;
          say(id, 'Signing in…');
          await click(s.code, { code });
          return redraw();
        }
        if (t.dataset.aiCancel) { await click(s.cancel, {}).catch(() => {}); say(id, ''); }
      } catch (err) {
        t.disabled = false;
        fail(id, err);
      }
    });
  }

  /** Settings' "Your AI" box (settings.js), in a customer's Studio. */
  window.mountAiCard = (box, ai) => {
    if (!box || !ai) return;
    box.className = 'set-box';
    box.innerHTML = aiCardHtml(ai, { onboarding: false });
    if (!box.dataset.wired) { wireAiCard(box, { onboarding: false }); box.dataset.wired = '1'; }
  };

  function aiStep(ai) {
    if ($('#aiStep')) return;
    // Put off with "Later": not shown again on this browser for a day (Settings → Your AI has it too).
    try { if (Date.now() - Number(localStorage.getItem('studio.aiLater') || 0) < 86_400_000) return; } catch { /* no storage */ }
    const el = document.createElement('section');
    el.id = 'aiStep';
    el.className = 'us-box';
    el.style.margin = '0 0 14px';
    el.innerHTML = aiCardHtml(ai, { onboarding: true });
    const ob = $('#onboard');
    if (ob) ob.after(el);
    else document.querySelector('main')?.prepend(el);
    wireAiCard(el, { onboarding: true });
  }

  // First run in a customer's Studio (src/tenancy.ts): no game yet, so its admin adds the first one
  // (PUT /api/products/<id>, config.ts saveProduct). Shown above every tab until there is a game.
  function onboarding() {
    if ($('#onboard')) return;
    const el = document.createElement('section');
    el.id = 'onboard';
    el.className = 'us-box';
    el.style.margin = '0 0 14px';
    const claude = window.studioMe?.claude;
    el.innerHTML = `<h3>Welcome to your Studio. Add your first game</h3>
      <p class="meta">Studio plays it every night and on every push, Claude watches the footage and files what's broken, and agents fix it with proof. Start with the address it runs at; the rest can come later.</p>
      <form id="obForm" class="us-form" style="flex-direction:column;align-items:stretch;max-width:560px">
        <input name="name" placeholder="Game name" required maxlength="80">
        <select name="engine"><option value="web">Web game or site</option><option value="unity">Unity (WebGL)</option><option value="godot">Godot (web export)</option><option value="desktop">Desktop (.exe), coming soon</option></select>
        <input name="live" type="url" placeholder="Where it runs: https://…" required>
        <input name="repo" placeholder="GitHub repository (owner/name), optional">
        <textarea name="about" rows="3" placeholder="What it is, in a sentence or two (Claude reads it before every review)" style="background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:inherit"></textarea>
        <button type="submit">Add it and play it</button>
        <div id="obMsg" class="meta"></div>
      </form>
      ${claude && !claude.ready ? '<p class="meta">Then connect your AI (below) so Talk and the agents can run.</p>' : ''}`;
    document.querySelector('main')?.prepend(el);
    $('#obForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const id = String(f.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?=[^a-z])/, 'g-').slice(0, 40) || 'my-game';
      $('#obMsg').textContent = 'Adding…';
      try {
        await api(`/api/products/${id}`, { method: 'PUT', body: { ...f, id } });
        el.remove();
        location.hash = '#today';
        location.reload();
      } catch (err) {
        $('#obMsg').innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`;
      }
    });
  }

  const linkBox = (r, what) => `<div class="us-link">${r.emailed ? `Emailed to ${esc(r.invite?.email ?? r.reset?.email)}.` : `Not emailed${r.emailError ? ` (${esc(r.emailError)})` : ''}: send this link yourself.`}<br>${esc(what)} link (works once): <a href="${esc(r.link)}">${esc(r.link)}</a> <button class="small" data-copy="${esc(r.link)}">Copy</button></div>`;

  let last = '';

  async function load() {
    const body = $('#usBody');
    let d;
    try {
      d = await api('/api/users');
    } catch (e) {
      body.innerHTML = `<div class="meta">${esc(e.message)}</div>`;
      return;
    }
    const users = d.users.map((u) => `<div class="us-row"><div class="who"><b>${esc(u.name || u.email)}</b>${u.name ? ` <span class="meta">${esc(u.email)}</span>` : ''}<br><span class="meta">${u.disabled ? 'disabled · ' : ''}${u.google ? 'signs in with Google · ' : u.default_password ? 'hasn\'t set a password yet · ' : ''}${u.last_seen ? `seen ${ago(u.last_seen)}` : 'never signed in'}</span></div>
      <select data-role="${u.id}" ${u.email === d.me ? 'disabled title="Your own role"' : ''}><option value="member" ${u.role === 'member' ? 'selected' : ''}>member</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>
      ${u.google ? '' : `<button class="small" data-reset="${u.id}" title="A single-use link to set a new password (24 hours)">Reset password</button>`}
      ${u.email === d.me ? '' : `<button class="small" data-disable="${u.id}" data-to="${u.disabled ? '0' : '1'}">${u.disabled ? 'Enable' : 'Disable'}</button><button class="small" data-remove="${u.id}" data-email="${esc(u.email)}">Remove</button>`}</div>`).join('');
    const open = d.invites.filter((i) => i.status === 'open');
    const invites = open.length ? open.map((i) => `<div class="us-row"><div class="who">${esc(i.email)} <span class="pill">${i.kind === 'reset' ? 'password reset' : i.role}</span><br><span class="meta">sent ${ago(i.created)}${i.by ? ` by ${esc(i.by)}` : ''} · ${esc(i.sent || 'not sent')} · expires ${new Date(i.expires).toLocaleString()}</span></div>
      <button class="small" data-resend="${i.id}" title="A new link (the old one stops working)">New link</button><button class="small" data-revoke="${i.id}">Revoke</button></div>`).join('') : '<div class="meta">No open invites.</div>';
    const log = d.log.length ? `<table class="us-log">${d.log.map((l) => `<tr><td>${new Date(l.at).toLocaleString()}</td><td class="${l.ok ? '' : 'bad'}">${l.ok ? '✓' : '✗'} ${esc(l.reason)}</td><td>${esc(l.email ?? '')}</td><td class="meta">${esc(l.ip ?? '')}</td></tr>`).join('')}</table>` : '<div class="meta">No sign-ins yet.</div>';
    body.innerHTML = `<div class="us-grid">
      <div class="us-box"><h3>Invite someone</h3><div class="meta" style="margin-bottom:8px">They get a link (by email, and shown here) and sign in with Google (the email they were invited with). Members use Studio, Talk and the beta sites; going live, merging into main, money and users stay with admins.</div>
        <form class="us-form" id="usInvite"><input type="email" name="email" placeholder="their@email.com" required autocomplete="off"><select name="role"><option value="member">member</option><option value="admin">admin</option></select><button type="submit">Invite</button></form>
        <div id="usInviteOut">${last}</div></div>
      <div class="us-box"><h3>People (${d.users.length})</h3>${users}</div>
      <div class="us-box"><h3>Open invites and reset links</h3>${invites}</div>
      <div class="us-box"><h3>Sign-in log</h3><div class="meta" style="margin-bottom:6px">Every attempt, newest first (never the password). Kept 90 days.</div>${log}</div></div>`;
  }

  async function act(f) {
    try {
      await f();
    } catch (e) {
      alert(e.message);
    }
    await load();
  }

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'usInvite') return;
    e.preventDefault();
    const fd = new FormData(e.target);
    act(async () => {
      const r = await api('/api/users/invite', { method: 'POST', body: { email: fd.get('email'), role: fd.get('role') } });
      last = linkBox(r, 'Invite');
    });
  });
  document.addEventListener('change', (e) => {
    const id = e.target.dataset?.role;
    if (id) act(() => api(`/api/users/${id}`, { method: 'POST', body: { role: e.target.value } }));
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button');
    if (!b || !b.closest('#users')) return;
    if (b.dataset.copy) {
      navigator.clipboard?.writeText(b.dataset.copy).then(() => (b.textContent = 'Copied'), () => {});
      return;
    }
    if (b.dataset.reset) act(async () => (last = linkBox(await api(`/api/users/${b.dataset.reset}/reset`, { method: 'POST', body: {} }), 'Reset')));
    if (b.dataset.disable) act(() => api(`/api/users/${b.dataset.disable}`, { method: 'POST', body: { disabled: b.dataset.to === '1' } }));
    if (b.dataset.remove && confirm(`Remove ${b.dataset.email}? They're signed out everywhere and can't sign in again unless invited.`)) act(() => api(`/api/users/${b.dataset.remove}`, { method: 'DELETE' }));
    if (b.dataset.revoke) act(() => api(`/api/invites/${b.dataset.revoke}/revoke`, { method: 'POST', body: {} }));
    if (b.dataset.resend) act(async () => (last = linkBox(await api(`/api/invites/${b.dataset.resend}/resend`, { method: 'POST', body: {} }), 'Invite')));
  });

  window.loadUsersTab = load;
  loadMe();
})();
