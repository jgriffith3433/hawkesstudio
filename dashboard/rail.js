// A change's progress rail on its card in the Changes tab: started, reading the code, editing, checks, pull request, merged
// to beta, beta built, playtested; each with its time and a one-line detail, the current step highlighted and a failed one
// in red with its plain reason (src/change-rail.ts works the steps out: GET /api/changes and GET /api/changes/<id>/rail).
// The page keeps it current from the push stream's `change-step` events only (app.js asks for the rail of the ids an event
// names): no timer. Pure (`ChangeRail.html`), so it is tested without a DOM (test/change-rail.test.ts).
var ChangeRail = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const MARK = { done: '✓', now: '●', failed: '✗', todo: '' };
  /** "14:05" today, "Nov 10 14:05" on another day (the reader's own clock). */
  function clock(at, now = Date.now()) {
    if (typeof at !== 'number') return '';
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`;
  }
  /** The rail's markup: an ordered list, one item per step; the element's own attributes are left to the caller. */
  function items(rail, now = Date.now()) {
    return (rail ?? []).map((s) => {
      const detail = s.detail ? (s.href ? `<a href="${esc(s.href)}" target="_blank" rel="noopener">${esc(s.detail)}</a>` : esc(s.detail)) : '';
      const t = clock(s.at, now);
      return `<li class="rs ${esc(s.state)}" data-key="rs:${esc(s.key)}"${s.state === 'now' ? ' aria-current="step"' : ''}>`
        + `<span class="rs-dot" aria-hidden="true">${MARK[s.state] ?? ''}</span>`
        + `<div class="rs-body"><div class="rs-head"><b>${esc(s.label)}</b>${t ? ` <time title="${esc(new Date(s.at).toLocaleString())}">${esc(t)}</time>` : ''}</div>`
        + `${detail ? `<div class="rs-detail">${detail}</div>` : ''}</div></li>`;
    }).join('');
  }
  function html(id, rail, now = Date.now()) {
    if (!rail?.length) return '';
    return `<ol class="rail" data-rail="${esc(id)}" aria-label="Progress">${items(rail, now)}</ol>`;
  }
  return { html, items, clock };
})();
