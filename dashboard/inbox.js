// The Inbox: everything waiting on J (decisions, agent questions, GPU budgets, merges only he may make, milestones
// reached), most blocking first, with the nav badge. Uses app.js's helpers ($, esc, api, ago, file, show).
const IB_KIND = { question: ['your call', 'broken'], agent: ['agent asks', 'warn'], gpu: ['GPU budget', 'warn'], merge: ['merge', ''], milestone: ['milestone reached', 'ship'], video: ['ready to screen', 'ship'], access: ['GitHub access', 'warn'], credits: ['waiting for credits', 'warn'] };
let ibItems = [];

function ibCard(x) {
  // An Approve / Deny card (approval.js): J's tap decides it; no options or free text.
  if (x.kind === 'approval') return `<div class="ib-card ib-approval" data-ib="${esc(x.id)}" data-key="ib:${esc(x.id)}">${approvals.html(x.approval)}${x.conversation ? `<div class="meta"><a href="/?conversation=${esc(x.conversation)}#talk">Conversation</a></div>` : ''}</div>`;
  const [label, pill] = IB_KIND[x.kind] ?? [x.kind, ''];
  const rec = (o) => x.recommendation && (o === x.recommendation || x.recommendation.toLowerCase().startsWith(o.toLowerCase()));
  const options = x.options.length ? x.options : x.recommendation ? [x.recommendation] : [];
  const links = x.links.map((l) => (l.video ? `<a href="#" data-video="${file(l.video)}">▶ ${esc(l.label)}</a>` : `<a href="${esc(l.url)}"${l.url.startsWith('#') ? '' : ' target="_blank"'}>${esc(l.label)}</a>`));
  if (x.conversation) links.push(`<a href="/?conversation=${esc(x.conversation)}#talk">Conversation</a>`);
  return `<div class="ib-card" data-ib="${esc(x.id)}" data-key="ib:${esc(x.id)}">
    <div class="ib-head"><span class="pill ${pill}">${esc(label)}</span>${x.productName ? ` <b>${esc(x.productName)}</b>` : ''}</div>
    <h4>${esc(x.title)}</h4>
    <div class="status-line">Holding up ${esc(x.blocks)} · waiting ${esc(ago(x.since).replace(' ago', '') || 'just now')}</div>
    ${x.context ? `<div class="meta">${esc(x.context)}</div>` : ''}
    ${x.recommendation ? `<div class="meta">Recommended: <b>${esc(x.recommendation)}</b></div>` : ''}
    <div class="actions ib-actions">${options.map((o) => `<button class="small${rec(o) ? ' primary' : ''}" data-ibopt="${esc(o)}">${esc(o)}${rec(o) ? ' ★' : ''}</button>`).join('')}</div>
    <div class="ib-free"><input data-ibtext placeholder="${x.kind === 'video' ? 'A note for the next version (sends it back)' : x.kind === 'merge' ? 'What should the agent change? (sends it back)' : x.kind === 'milestone' ? "What's wrong? (the PM makes it tasks)" : 'Or answer in your own words'}"><button class="small" data-ibsend>Send</button></div>
    ${links.length ? `<div class="meta ib-links">${links.join(' · ')}</div>` : ''}
    <details class="more-details"><summary class="meta">Details</summary>
      ${x.text ? `<div class="summary" style="white-space:pre-wrap">${esc(x.text)}</div>` : ''}
      <div class="meta">Asked by ${esc(x.asker)}${x.asks > 1 ? ` (${x.asks} times)` : ''} · ${esc(x.id)}</div>
    </details>
  </div>`;
}

// Loading the list (J, 2026-11-01: "the first time you navigate to inbox if it's been a while it says 'Loading..' but
// never loads. Then if you refresh the page it populates"). It used to load only from the Inbox nav button's click and
// the push stream's events: a customer's Studio has no Inbox nav button (groups.js opens it from the Talk · Inbox bar,
// with show()), so after a quiet while nothing asked for it until the next stream event, and a request that hung (a
// cold start, a connection that died while the page sat idle) had no timeout. Now:
//   - it loads whenever the Inbox is shown (show() → studio-tab), however it was opened;
//   - one load at a time: one asked for meanwhile runs right after, so the newest answer always lands;
//   - each try has a timeout and one automatic retry (a timeout, a dropped connection, a 5xx or a page that isn't JSON);
//   - an expired session goes to the sign-in page and back here, like api() (app.js);
//   - it always ends in the cards, the empty state, or what went wrong with a Retry button;
//   - asked while the page is hidden, it loads when the page is visible again.
const IB_TIMEOUT = 15_000;
const IB_RETRY_AFTER = 1000;
let ibDrawn = null;
let ibLoading = null; // the load in flight
let ibAgain = false; // asked for again while one was in flight
let ibWaiting = false; // asked for while the page was hidden
let ibFailed = false; // the last load ended in an error (shown with Retry)
const ibOnScreen = () => Boolean($('#inbox')?.classList.contains('on'));

/** GET path as J's click (approval tokens come with it), with the timeout, one retry and the sign-in redirect. */
async function ibFetch(path) {
  for (let attempt = 1; ; attempt++) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), IB_TIMEOUT) : null;
    let retry = true;
    try {
      const r = await fetch(path, { headers: { 'X-Studio-Click': '1' }, cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}) });
      const d = await r.json().catch(() => null);
      // Signed out (the session expired while the page sat idle): to the sign-in page, then back here.
      if ((r.status === 401 || r.status === 403) && d?.signin) {
        retry = false;
        location.href = `${d.signin}?next=${encodeURIComponent(location.href)}`;
        throw new Error('Signing in again…');
      }
      if (!d) throw new Error(`Studio answered ${r.status} (not JSON).`);
      if (!r.ok || d.error) {
        retry = r.status >= 500; // a 4xx says the same the second time
        throw new Error(d.error ?? `Studio answered ${r.status}`);
      }
      return d;
    } catch (err) {
      const e = ctl?.signal.aborted ? new Error(`Studio didn't answer in ${IB_TIMEOUT / 1000} seconds.`) : err;
      if (!retry || attempt >= 2) throw e;
      // Still "Loading…": say we're trying again (Studio may be waking up after a quiet while).
      if (ibDrawn === null && !ibFailed) $('#ibList').innerHTML = '<div class="meta">Still loading (Studio may be waking up)…</div>';
      await new Promise((ok) => setTimeout(ok, IB_RETRY_AFTER));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

function ibShowError(message) {
  ibFailed = true;
  const box = `<div class="empty ib-error">Couldn't load the Inbox: ${esc(message)} <button class="small" data-ibretry>Retry</button></div>`;
  // Nothing drawn yet: the error takes "Loading…"'s place. Cards already there stay, with the error above them.
  if (ibDrawn === null) { $('#ibList').innerHTML = box; return; }
  let el = $('#ibErr');
  if (!el) { el = document.createElement('div'); el.id = 'ibErr'; $('#ibList').before(el); }
  el.innerHTML = box;
  el.hidden = false;
}

async function drawInbox() {
  const r = await ibFetch('/api/inbox');
  ibFailed = false;
  const err = $('#ibErr');
  if (err) err.hidden = true;
  ibItems = r.items;
  setInboxCount(r.count, r.walkAway);
  // A card J is typing in isn't redrawn under him.
  if (document.activeElement?.matches?.('#inbox .ib-card input') && document.activeElement.value) return;
  const list = r.items.length ? r.items.map(ibCard).join('') : '<div class="empty">Nothing is waiting on you. 🎉 Decisions from Talk, the PM and the agents, GPU budgets, merges only you can make and milestones to playtest all land here, the most blocking first.</div>';
  // Unchanged: left alone, so a card isn't swapped out from under a thumb mid-tap (the stream refetches often).
  // Changed: redrawn in place (patch.js), so the cards J isn't touching stay put and so does the page.
  if (list !== ibDrawn) { studioPatch($('#ibList'), list); ibDrawn = list; }
  studioPatch($('#ibAnswered'), r.answered.length ? `<summary class="meta">Answered lately (${r.answered.length})</summary>${r.answered.map((a) => `<div class="test"><span class="name">${esc(a.title)}</span><span class="detail">${esc(String(a.answer ?? '').slice(0, 200))} · <b>by ${esc(a.by ?? '?')}</b> · ${ago(a.at)} · ${esc(a.id)}</span></div>`).join('')}` : '');
}

/** Loads and draws the Inbox. Never rejects: it ends in the cards, the empty state or the error with Retry. */
function loadInbox() {
  if (ibLoading) { ibAgain = true; return ibLoading; }
  ibLoading = (async () => {
    try {
      do {
        ibAgain = false;
        try { await drawInbox(); } catch (e) { ibShowError(e?.message ?? String(e)); }
      } while (ibAgain);
    } finally {
      ibLoading = null;
    }
  })();
  return ibLoading;
}

function setInboxCount(n, walkAway) {
  const el = $('#inboxCount');
  el.textContent = n;
  el.classList.toggle('zero', !n);
  document.title = n ? `(${n}) Hawkes Studio` : 'Hawkes Studio';
  // The header's walk-away badge: Studio merges and decides routine calls by itself (Settings > PM loop).
  const b = $('#walkAwayBadge');
  if (b && walkAway !== undefined) b.hidden = !walkAway;
  // A customer's Studio: their own walk-away mode (no Studio/Gen merges there; Settings, Walk-away mode).
  if (b && window.studioMe?.customer) b.title = 'Walk-away mode is on: the PM decides routine calls itself, ready changes merge into beta, and your Inbox keeps only what\'s yours (Settings, Walk-away mode). Going live stays your call.';
}
const pollInboxCount = () => api('/api/inbox?count=1').then((r) => setInboxCount(r.count, r.walkAway)).catch(() => {});

async function ibAnswer(card, answer) {
  const x = ibItems.find((i) => i.id === card.dataset.ib);
  if (!x) return;
  let confirmWords;
  if (x.kind === 'merge' && /^merge/i.test(answer)) {
    if (x.confirm) {
      // Into main deploys Studio or Gen: an Approve / Deny card with the checks takes this card's place.
      try {
        await approvals.request({ kind: 'merge', target: x.subject });
        return void loadInbox();
      } catch (err) {
        const typed = prompt(`${err.message}\n\nOr type ${x.confirm} to merge into main (it deploys ${x.productName}).`);
        if (typed?.trim() !== x.confirm) return;
        confirmWords = typed.trim();
      }
    } else if (!confirm(`${x.title} The beta site and a beta playtest follow; nothing goes live until you use Go live.`)) return;
  }
  if (x.kind === 'merge' && answer === 'Close' && !confirm('Close this change and its pull request?')) return;
  if ((x.kind === 'merge' && answer === 'Ask for changes') || (x.kind === 'milestone' && answer === 'Something is wrong')) {
    const typed = card.querySelector('[data-ibtext]').value.trim() || prompt(x.kind === 'merge' ? 'What should the agent change?' : "What's wrong? (the PM turns it into tasks)");
    if (!typed) return;
    answer = `${answer}: ${typed}`;
  }
  card.classList.add('ib-busy');
  try {
    const r = await api('/api/inbox/answer', { method: 'POST', body: { id: x.id, answer, by: 'J', ...(confirmWords ? { confirm: confirmWords } : {}) } });
    if (r.next === 'deploy') {
      // Going live is the deploy plan and its Approve card, opened over the Go live tab; the card stays until it's live.
      card.classList.remove('ib-busy');
      show('golive');
      await loadToday();
      const p = overview.products.find((o) => r.products.includes(o.id));
      if (p) goLive(p);
      return;
    }
    card.classList.add('ib-done');
    setTimeout(loadInbox, 400);
  } catch (err) {
    card.classList.remove('ib-busy');
    alert(err.message);
  }
}

$('#inbox').addEventListener('click', (e) => {
  const card = e.target.closest('.ib-card');
  if (!card) return;
  const opt = e.target.closest('button[data-ibopt]');
  if (opt) return void ibAnswer(card, opt.dataset.ibopt);
  if (e.target.closest('button[data-ibsend]')) {
    const text = card.querySelector('[data-ibtext]').value.trim();
    const x = ibItems.find((i) => i.id === card.dataset.ib);
    if (!text || !x) return;
    // Free text on a merge sends the change back with it; on a milestone it's what's wrong.
    void ibAnswer(card, x.kind === 'merge' ? `Ask for changes: ${text}` : x.kind === 'milestone' ? `Something is wrong: ${text}` : text);
  }
});
$('#inbox').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-ibtext]')) e.target.closest('.ib-card').querySelector('[data-ibsend]').click();
});

addEventListener('studio-approval', () => setTimeout(ibRefresh, 1500));
function ibRefresh() {
  if (!ibOnScreen()) return void pollInboxCount();
  // Hidden (another browser tab, a locked phone): when the page is back (below).
  if (document.hidden) { ibWaiting = true; return; }
  void loadInbox();
}
// Whenever the Inbox is shown, however it was opened: the nav button, the Talk · Inbox bar of a customer's Studio
// (groups.js), a link (roadmap.js) or Talk's guide. show() (app.js) says which tab with studio-tab.
addEventListener('studio-tab', (e) => { if (e.detail === 'inbox') ibRefresh(); });
// Back on screen: a load asked for while hidden, or one that failed or never landed, goes again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !ibOnScreen()) return;
  if (ibWaiting || ibFailed || ibDrawn === null) { ibWaiting = false; ibRefresh(); }
});
// Restored from the browser's back/forward cache: it may have been a long while.
addEventListener('pageshow', (e) => { if (e.persisted && ibOnScreen()) ibRefresh(); });
$('#inbox').addEventListener('click', (e) => { if (e.target.closest('button[data-ibretry]')) void loadInbox(); });
ibRefresh();
// The badge and the open Inbox follow the push stream (stream.js): the event carries the count; the list is fetched only
// when the Inbox is on screen. Its slow safety tick refreshes too.
studioStream.on('inbox', (e) => {
  if (typeof e.count === 'number') setInboxCount(e.count);
  if (ibOnScreen()) { if (!e.badge) ibRefresh(); }
  else if (typeof e.count !== 'number') pollInboxCount();
});
