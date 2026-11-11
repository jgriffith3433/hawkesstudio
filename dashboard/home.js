// The Home tab: per game, what needs you, what's running, what's ready to ship (GET /api/home, src/home.ts).
// No timer: it fetches when the tab opens (app.js refresh) and when the push stream (/api/stream) says the inbox,
// changes, runs, builds, ops or activity moved (studioStream.on). Uses app.js's $, esc, api, studioPatch.
(() => {
  const COLS = [
    ['needs', 'Needs you', 'needsList', (x) => `${esc(x.title)}`, 'inbox'],
    ['running', "Running", 'runningList', (x) => esc(x), 'live'],
    ['ready', 'Ready to ship', 'readyList', (x) => esc(x), 'golive'],
    ['uncaptured', 'Not seen in engine yet', 'uncapturedList', (x) => esc(x), 'changes'],
  ];
  const card = (g) => `<div class="home-card" data-key="home:${esc(g.id)}" data-game="${esc(g.id)}">
    <h3>${esc(g.name)}</h3>
    <div class="home-counts">${COLS.map(([k, label, , , go]) => `<a class="home-count ${k}${g[k] ? ' some' : ''}" href="#${go}" data-goto="${go}" data-key="c:${k}"><b class="n">${g[k]}</b><span>${label}</span></a>`).join('')}</div>
    <details class="more-details" data-key="d:${esc(g.id)}"><summary>Details</summary>${COLS.map(([k, label, list, fmt]) => g[k] ? `<div class="home-list"><div class="meta">${label}</div><ul>${g[list].map((x) => `<li>${fmt(x)}</li>`).join('')}${g[k] > g[list].length ? `<li class="meta">and ${g[k] - g[list].length} more</li>` : ''}</ul></div>` : '').join('') || '<div class="meta">Nothing going on.</div>'}</details>
  </div>`;
  let busy = false;
  window.loadHomeTab = async () => {
    if (busy) return;
    busy = true;
    try {
      const h = await api('/api/home');
      studioPatch($('#homeTotals'), COLS.map(([k, label]) => `<div class="home-total ${k}" data-key="t:${k}"><b>${h.totals[k]}</b><span>${label}</span></div>`).join(''));
      studioPatch($('#homeGames'), h.games.map(card).join('') || '<div class="empty">No games yet.</div>');
    } finally { busy = false; }
  };
  studioStream.on(['inbox', 'changes', 'runs', 'builds', 'ops', 'activity'], (e) => { if (e?.badge) return; if (tab === 'home') window.loadHomeTab(); });
  $('#home').addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    show(a.dataset.goto);
  });
})();
