// Approve / Deny cards (src/approvals.ts): one component for the Talk chat (also during a call), the Inbox and the
// go-live dialog. A card says what will happen in plain words, with its blockers and warnings; J's tap sends the card's
// one-time token with X-Studio-Click (the server refuses anything that isn't his page). Talk's guide refuses these
// buttons (guide.js: data-apdecide and the .approval class). Uses app.js's esc and ago.
const approvals = (() => {
  const STATUS = { approved: ['Approved', 'ship'], denied: ['Denied', ''], expired: ['Expired', 'warn'], stale: ['Out of date', 'warn'], failed: ['Approved, but it failed', 'broken'], approving: ['Working on it…', 'warn'] };
  const left = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m ? `${m} min` : 'under a minute'; };

  function html(a) {
    const c = a.card;
    const pending = a.status === 'pending';
    const [label, pill] = STATUS[a.status] ?? ['Needs your OK', 'warn'];
    return `<div class="approval st-${esc(a.status)}" data-approval="${esc(a.id)}" data-token="${esc(a.token ?? '')}" data-guide="off">
      <div class="ap-head"><span class="pill ${pending ? 'warn' : pill}">${pending ? 'Needs your OK' : esc(label)}</span> <b>${esc(c.title)}</b></div>
      ${c.lines.length ? `<ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${c.blockers.length ? `<div class="ap-block"><b>Can't approve yet:</b><br>${c.blockers.map(esc).join('<br>')}</div>` : ''}
      ${c.warnings.length ? `<div class="ap-warn"><b>Warnings:</b><br>${c.warnings.map(esc).join('<br>')}</div>` : ''}
      ${c.links.length ? `<div class="meta">${c.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(' · ')}</div>` : ''}
      ${pending
        ? `<div class="actions ap-actions"><button class="primary" data-apdecide="approve"${c.blockers.length || !a.token ? ' disabled' : ''}>${esc(c.approve)}</button><button data-apdecide="deny"${a.token ? '' : ' disabled'}>${esc(c.deny)}</button></div>
           <div class="meta">Asked by ${esc(a.requested_by ?? 'Studio')} · expires in ${left(a.expires)} · ${esc(a.id)}</div>`
        : `<div class="meta">${a.decided_by ? `${esc(a.decided_by)} · ${esc(ago(a.decided_at))}` : esc(ago(a.created))}${a.result ? ` · ${esc(a.result)}` : ''} · ${esc(a.id)}</div>`}
    </div>`;
  }

  async function call(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'X-Studio-Click': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? r.status);
    return d;
  }
  /** A card for an action (kind, target, amount, patch): the same one when it is already waiting. */
  const request = (body) => call('/api/approvals', { method: 'POST', body });
  const get = (id) => call(`/api/approvals/${id}`);

  // J's tap (a real click: event.isTrusted). The card redraws with what happened.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-apdecide]');
    if (!b || !e.isTrusted) return;
    const card = b.closest('.approval');
    card.querySelectorAll('button[data-apdecide]').forEach((x) => (x.disabled = true));
    try {
      const a = await call(`/api/approvals/${card.dataset.approval}/${b.dataset.apdecide}`, { method: 'POST', body: { token: card.dataset.token } });
      card.outerHTML = html(a);
    } catch (err) {
      const a = await get(card.dataset.approval).catch(() => null);
      if (a) card.outerHTML = html(a);
      alert(err.message);
    }
    dispatchEvent(new CustomEvent('studio-approval'));
  });

  return { html, request, get, call };
})();
