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
    try {
      me = (await api('/api/me')).user;
    } catch {
      me = null;
    }
    const status = $('#status');
    if (me && status && !$('#meBox')) {
      const el = document.createElement('span');
      el.id = 'meBox';
      el.className = 'me';
      el.innerHTML = `${esc(me.email)}${me.role === 'admin' ? ' · admin' : ''}<a href="/auth/set-password?next=/">password</a><a href="/auth/signout">sign out</a>`;
      status.after(el);
    }
    const btn = document.querySelector('nav button[data-tab="users"]');
    if (btn) btn.hidden = me?.role !== 'admin';
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
    const users = d.users.map((u) => `<div class="us-row"><div class="who"><b>${esc(u.name || u.email)}</b>${u.name ? ` <span class="meta">${esc(u.email)}</span>` : ''}<br><span class="meta">${u.disabled ? 'disabled · ' : ''}${u.default_password ? 'hasn\'t set a password yet · ' : ''}${u.last_seen ? `seen ${ago(u.last_seen)}` : 'never signed in'}</span></div>
      <select data-role="${u.id}" ${u.email === d.me ? 'disabled title="Your own role"' : ''}><option value="member" ${u.role === 'member' ? 'selected' : ''}>member</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>
      <button class="small" data-reset="${u.id}" title="A single-use link to set a new password (24 hours)">Reset password</button>
      ${u.email === d.me ? '' : `<button class="small" data-disable="${u.id}" data-to="${u.disabled ? '0' : '1'}">${u.disabled ? 'Enable' : 'Disable'}</button><button class="small" data-remove="${u.id}" data-email="${esc(u.email)}">Remove</button>`}</div>`).join('');
    const open = d.invites.filter((i) => i.status === 'open');
    const invites = open.length ? open.map((i) => `<div class="us-row"><div class="who">${esc(i.email)} <span class="pill">${i.kind === 'reset' ? 'password reset' : i.role}</span><br><span class="meta">sent ${ago(i.created)}${i.by ? ` by ${esc(i.by)}` : ''} · ${esc(i.sent || 'not sent')} · expires ${new Date(i.expires).toLocaleString()}</span></div>
      <button class="small" data-resend="${i.id}" title="A new link (the old one stops working)">New link</button><button class="small" data-revoke="${i.id}">Revoke</button></div>`).join('') : '<div class="meta">No open invites.</div>';
    const log = d.log.length ? `<table class="us-log">${d.log.map((l) => `<tr><td>${new Date(l.at).toLocaleString()}</td><td class="${l.ok ? '' : 'bad'}">${l.ok ? '✓' : '✗'} ${esc(l.reason)}</td><td>${esc(l.email ?? '')}</td><td class="meta">${esc(l.ip ?? '')}</td></tr>`).join('')}</table>` : '<div class="meta">No sign-ins yet.</div>';
    body.innerHTML = `<div class="us-grid">
      <div class="us-box"><h3>Invite someone</h3><div class="meta" style="margin-bottom:8px">They get a link (by email, and shown here) to set their password. Members use Studio, Talk and the beta sites; going live, merging into main, money and users stay with admins.</div>
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
