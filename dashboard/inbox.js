// The Inbox: everything waiting on J (decisions, agent questions, GPU budgets, merges only he may make, milestones
// reached), most blocking first, with the nav badge. Uses app.js's helpers ($, esc, api, ago, file, show).
const IB_KIND = { question: ['your call', 'broken'], agent: ['agent asks', 'warn'], gpu: ['GPU budget', 'warn'], merge: ['merge', ''], milestone: ['milestone reached', 'ship'] };
let ibItems = [];

function ibCard(x) {
  // An Approve / Deny card (approval.js): J's tap decides it; no options or free text.
  if (x.kind === 'approval') return `<div class="ib-card ib-approval" data-ib="${esc(x.id)}">${approvals.html(x.approval)}${x.conversation ? `<div class="meta"><a href="/?conversation=${esc(x.conversation)}#talk">Conversation</a></div>` : ''}</div>`;
  const [label, pill] = IB_KIND[x.kind] ?? [x.kind, ''];
  const rec = (o) => x.recommendation && (o === x.recommendation || x.recommendation.toLowerCase().startsWith(o.toLowerCase()));
  const options = x.options.length ? x.options : x.recommendation ? [x.recommendation] : [];
  const links = x.links.map((l) => (l.video ? `<a href="#" data-video="${file(l.video)}">▶ ${esc(l.label)}</a>` : `<a href="${esc(l.url)}"${l.url.startsWith('#') ? '' : ' target="_blank"'}>${esc(l.label)}</a>`));
  if (x.conversation) links.push(`<a href="/?conversation=${esc(x.conversation)}#talk">Conversation</a>`);
  return `<div class="ib-card" data-ib="${esc(x.id)}">
    <div class="ib-head"><span class="pill ${pill}">${esc(label)}</span>${x.productName ? ` <b>${esc(x.productName)}</b>` : ''}</div>
    <h4>${esc(x.title)}</h4>
    <div class="status-line">Holding up ${esc(x.blocks)} · waiting ${esc(ago(x.since).replace(' ago', '') || 'just now')}</div>
    ${x.context ? `<div class="meta">${esc(x.context)}</div>` : ''}
    ${x.recommendation ? `<div class="meta">Recommended: <b>${esc(x.recommendation)}</b></div>` : ''}
    <div class="actions ib-actions">${options.map((o) => `<button class="small${rec(o) ? ' primary' : ''}" data-ibopt="${esc(o)}">${esc(o)}${rec(o) ? ' ★' : ''}</button>`).join('')}</div>
    <div class="ib-free"><input data-ibtext placeholder="${x.kind === 'merge' ? 'What should the agent change? (sends it back)' : x.kind === 'milestone' ? "What's wrong? (the PM makes it tasks)" : 'Or answer in your own words'}"><button class="small" data-ibsend>Send</button></div>
    ${links.length ? `<div class="meta ib-links">${links.join(' · ')}</div>` : ''}
    <details class="more-details"><summary class="meta">Details</summary>
      ${x.text ? `<div class="summary" style="white-space:pre-wrap">${esc(x.text)}</div>` : ''}
      <div class="meta">Asked by ${esc(x.asker)}${x.asks > 1 ? ` (${x.asks} times)` : ''} · ${esc(x.id)}</div>
    </details>
  </div>`;
}

async function loadInbox() {
  const r = await approvals.call('/api/inbox');
  ibItems = r.items;
  setInboxCount(r.count);
  // A card J is typing in isn't redrawn under him.
  if (document.activeElement?.matches?.('#inbox .ib-card input') && document.activeElement.value) return;
  $('#ibList').innerHTML = r.items.length ? r.items.map(ibCard).join('') : '<div class="empty">Nothing is waiting on you. 🎉 Decisions from Talk, the PM and the agents, GPU budgets, merges only you can make and milestones to playtest all land here, the most blocking first.</div>';
  $('#ibAnswered').innerHTML = r.answered.length ? `<summary class="meta">Answered lately (${r.answered.length})</summary>${r.answered.map((a) => `<div class="test"><span class="name">${esc(a.title)}</span><span class="detail">${esc(String(a.answer ?? '').slice(0, 200))} · <b>by ${esc(a.by ?? '?')}</b> · ${ago(a.at)} · ${esc(a.id)}</span></div>`).join('')}` : '';
}

function setInboxCount(n) {
  const el = $('#inboxCount');
  el.textContent = n;
  el.classList.toggle('zero', !n);
  document.title = n ? `(${n}) Hawkes Studio` : 'Hawkes Studio';
}
const pollInboxCount = () => api('/api/inbox?count=1').then((r) => setInboxCount(r.count)).catch(() => {});

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
    setTimeout(() => loadInbox().catch(() => {}), 400);
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
  if (location.hash.slice(1).split('/')[0] === 'inbox') loadInbox().catch((e) => ($('#ibList').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  else pollInboxCount();
}
document.querySelector('nav button[data-tab="inbox"]').addEventListener('click', () => setTimeout(ibRefresh, 0));
ibRefresh();
setInterval(ibRefresh, 20000);
