// Approve / Deny cards (src/approvals.ts): one component for the Talk chat (also during a call), the Inbox and the
// go-live dialog. A card says what will happen in plain words, with its blockers and warnings; J's tap sends the card's
// one-time token with X-Studio-Click (the server refuses anything that isn't his page). Talk's guide refuses these
// buttons (guide.js: data-apdecide and the .approval class). Once decided, expired or stale a card is one line ("Approved:
// …"). In the chat (place) cards sit in the message flow where they were asked, only the newest waiting one in full; ×
// closes one there without deciding it (it stays in the Inbox). Uses app.js's esc and ago.
const approvals = (() => {
  const STATUS = { approved: ['Approved', 'ship'], denied: ['Denied', ''], expired: ['Expired', 'warn'], stale: ['Out of date', 'warn'], failed: ['Approved, but it failed', 'broken'], approving: ['Working on it…', 'warn'] };
  const left = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m ? `${m} min` : 'under a minute'; };
  /** "Merge "X" into beta?" → "Merge "X" into beta": the line after a decision. */
  const what = (a) => String(a.card.title).replace(/\?\s*$/, '');
  /** Cards J opened from their one line in the chat (older waiting ones). */
  const expanded = new Set();

  /** A decided, expired or stale card (or a waiting one folded away in the chat): one line, no buttons. */
  function line(a, error = errors.get(a.id) ?? '') {
    const pending = a.status === 'pending';
    const [label, pill] = pending ? ['Needs your OK', 'warn'] : STATUS[a.status] ?? [a.status, ''];
    const meta = pending ? `expires in ${left(a.expires)}` : [a.decided_by ? `${a.decided_by} · ${ago(a.decided_at)}` : '', a.result ? String(a.result).slice(0, 240) : ''].filter(Boolean).join(' · ');
    return `<div class="approval ap-line st-${esc(a.status)}" data-approval="${esc(a.id)}" data-guide="off"><span class="pill ${pill}">${esc(label)}</span> <span class="ap-what">${esc(what(a))}</span>${meta ? ` <span class="meta">${esc(meta)}</span>` : ''}${pending ? ' <button class="small" data-apshow>Show</button>' : ''}${failed(error)}</div>`;
  }

  /** Why the last tap on a card didn't work (by id), shown on the card itself (alert() is suppressed in some phone
   * views) until the next tap, also when the chat or the Inbox redraws it. */
  const errors = new Map();
  const failed = (error) => (error ? `<div class="ap-error" role="alert">${esc(error)}</div>` : '');

  /** The card. chat: in the Talk chat (with × to close it there). error: why the last tap didn't work. */
  function html(a, { chat = false, error = errors.get(a.id) ?? '' } = {}) {
    if (a.status !== 'pending') return line(a, error);
    const c = a.card;
    // With blockers the button says so itself (a disabled button looks dead to a thumb). Without the token (the page
    // got the card some other way) Approve stays tappable: the tap fetches it first.
    const approve = c.blockers.length ? `<button class="primary" data-apdecide="approve" disabled>Can't approve yet</button>` : `<button class="primary" data-apdecide="approve">${esc(c.approve)}</button>`;
    return `<div class="approval st-pending" data-approval="${esc(a.id)}" data-token="${esc(a.token ?? '')}" data-guide="off">
      <div class="ap-head"><span class="pill warn">Needs your OK</span> <b>${esc(c.title)}</b>${chat ? '<button class="ap-close" data-apdismiss title="Close it here without deciding: it stays in your Inbox until it expires" aria-label="Close">×</button>' : ''}</div>
      ${c.lines.length ? `<ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${c.blockers.length ? `<div class="ap-block"><b>Can't approve yet:</b><br>${c.blockers.map(esc).join('<br>')}${a.kind === 'deploy' ? '<br><button class="small" data-apgolive title="The Go live page has the button that clears these on beta (nothing goes live)">Fix it on the Go live page</button>' : ''}</div>` : ''}
      ${c.warnings.length ? `<div class="ap-warn"><b>Warnings:</b><br>${c.warnings.map(esc).join('<br>')}</div>` : ''}
      ${c.links.length ? `<div class="meta">${c.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(' · ')}</div>` : ''}
      <div class="actions ap-actions">${approve}<button data-apdecide="deny">${esc(c.deny)}</button></div>${failed(error)}
      <div class="meta">Asked by ${esc(a.requested_by ?? 'Studio')} · expires in ${left(a.expires)} · ${esc(a.id)}</div>
    </div>`;
  }

  /**
   * The chat's cards in the message flow: for each, how many messages come before it (those up to when it was asked)
   * and its HTML. Closed (×) waiting cards aren't shown; only the newest waiting one is in full, older ones are a line
   * (Show opens one). Decided ones are a line where they were asked.
   */
  function place(messages, cards) {
    const open = cards.filter((a) => a.status === 'pending' && !a.dismissed);
    const newest = open.reduce((n, a) => (!n || a.created >= n.created ? a : n), null);
    return cards
      .filter((a) => !(a.status === 'pending' && a.dismissed))
      .map((a) => ({ after: messages.filter((m) => (m.at ?? 0) <= a.created).length, html: a.status === 'pending' && a !== newest && !expanded.has(a.id) ? line(a) : html(a, { chat: true }) }));
  }

  async function call(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'X-Studio-Click': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await r.json().catch(() => ({ error: `Studio answered ${r.status} (not JSON): try again, or reload the page.` }));
    if (!r.ok || d.error) throw new Error(d.error ?? `Studio answered ${r.status}`);
    return d;
  }
  /** A card for an action (kind, target, amount, patch): the same one when it is already waiting. */
  const request = (body) => call('/api/approvals', { method: 'POST', body });
  const get = (id) => call(`/api/approvals/${id}`);

  // J's tap (a real click: event.isTrusted). The card becomes the line saying what happened; × closes it in the chat.
  if (typeof document !== 'undefined') document.addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    if (e.target.closest('button[data-apgolive]')) return void (typeof window.show === 'function' && window.show('golive'));
    const show = e.target.closest('button[data-apshow]');
    if (show) { expanded.add(show.closest('.approval').dataset.approval); return dispatchEvent(new CustomEvent('studio-approval')); }
    const close = e.target.closest('button[data-apdismiss]');
    if (close) {
      const card = close.closest('.approval');
      errors.delete(card.dataset.approval);
      close.disabled = true;
      try {
        await call(`/api/approvals/${card.dataset.approval}/dismiss`, { method: 'POST', body: {} });
        card.remove();
      } catch (err) { close.disabled = false; errors.set(card.dataset.approval, err.message); card.querySelector('.ap-error')?.remove(); card.insertAdjacentHTML('beforeend', failed(err.message)); }
      return dispatchEvent(new CustomEvent('studio-approval'));
    }
    const b = e.target.closest('button[data-apdecide]');
    if (!b) return;
    const card = b.closest('.approval');
    const id = card.dataset.approval;
    const chat = !!card.querySelector('[data-apdismiss]');
    errors.delete(id);
    card.querySelectorAll('button[data-apdecide]').forEach((x) => (x.disabled = true));
    b.textContent = 'Working on it…';
    // The chat or the Inbox may redraw the card while this runs (and the dock and the Inbox can both show it): every copy
    // on screen now gets the result, each keeping its own × in the chat.
    const put = (a, error) => {
      const copies = [...document.querySelectorAll(`.approval[data-approval="${id}"]`)];
      for (const n of copies.length ? copies : [card]) n.outerHTML = a ? html(a, { chat: !!n.querySelector('[data-apdismiss]') || (n === card && chat), error }) : `<div class="approval ap-line" data-approval="${esc(id)}" data-guide="off">${failed(error)}</div>`;
    };
    try {
      let token = card.dataset.token;
      if (!token) token = (await get(id)).token;
      if (!token) throw new Error("This page didn't get the card's key from Studio, so it can't decide it: reload the page and tap again.");
      put(await call(`/api/approvals/${id}/${b.dataset.apdecide}`, { method: 'POST', body: { token } }), '');
    } catch (err) {
      errors.set(id, err.message);
      put(await get(id).catch(() => null), err.message);
    }
    dispatchEvent(new CustomEvent('studio-approval'));
  });

  return { html, line, place, request, get, call };
})();
