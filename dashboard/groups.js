// A customer's Studio has fewer, grouped tabs (J, 2026-10-30: "there's way too many tabs"). The nav shows one button per
// group; inside, a small bar switches between the group's pages, which are the same tabs as before (so links, Talk's
// guide and #hash addresses keep working). J's own Studio keeps its tabs as they are.
//   Talk       Talk · Inbox
//   Games      Games (the overview, each game's card, add/edit/delete) · Go live
//   Plan       Roadmap · Bugs (the backlog) · Agents' changes
//   Playtests  Playing now · History · Reports · Runs
//   Library, and under More: Memory, Users, Settings
// Not in a customer's Studio: Ready to test (Go live covers it), Analytics and Screening (the platform admin's for now),
// On Air, Social, Costs, Resources.
(() => {
  const GROUPS = [
    { head: 'talk', label: 'Talk', tabs: [['talk', 'Talk'], ['inbox', 'Inbox']] },
    { head: 'today', label: 'Games', tabs: [['today', 'Games'], ['golive', 'Go live']] },
    { head: 'roadmap', label: 'Plan', tabs: [['roadmap', 'Roadmap'], ['backlog', 'Bugs'], ['changes', "Agents' changes"]] },
    { head: 'live', label: 'Playtests', tabs: [['live', 'Playing now'], ['playtests', 'History'], ['report', 'Reports'], ['runs', 'Runs']] },
    { head: 'library', label: 'Library', tabs: [['library', 'Library']] },
  ];
  const MORE = ['memory', 'users', 'settings'];
  const groupOf = (t) => GROUPS.find((g) => g.tabs.some(([id]) => id === t));
  let on = false;

  /** Lights the group's nav button and draws the bar of its pages at the top of the tab shown. */
  function afterShow(t) {
    if (!on) return;
    const g = groupOf(t);
    document.querySelectorAll('nav button[data-tab]').forEach((b) => { if (g && b.dataset.tab === g.head) b.classList.add('on'); });
    if (!g || g.tabs.length < 2) return;
    const sec = document.getElementById(t);
    if (!sec) return;
    let bar = sec.querySelector(':scope > .subnav');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'subnav';
      bar.innerHTML = g.tabs.map(([id, label]) => `<button type="button" data-sub="${id}">${label}${id === 'inbox' ? ' <span class="ib-count zero" data-inbox-mirror>0</span>' : ''}</button>`).join('');
      bar.addEventListener('click', (e) => { const b = e.target.closest('[data-sub]'); if (b) show(b.dataset.sub); });
      sec.prepend(bar);
    }
    bar.querySelectorAll('[data-sub]').forEach((b) => b.classList.toggle('on', b.dataset.sub === t));
    mirrorInbox();
  }

  /** The Inbox's count on the Talk button and the Inbox page's button (the Inbox has no nav button of its own here). */
  function mirrorInbox() {
    const src = document.getElementById('inboxCount');
    if (!src) return;
    const n = src.textContent.trim();
    for (const el of document.querySelectorAll('[data-inbox-mirror]')) { el.textContent = n; el.className = src.className; }
  }

  /** Called with /api/me (users.js): a customer's Studio gets the grouped nav. */
  function groupNav(me) {
    if (!me?.customer || on) return;
    on = true;
    const keep = new Set([...GROUPS.map((g) => g.head), ...MORE]);
    document.querySelectorAll('nav button[data-tab]').forEach((b) => {
      const t = b.dataset.tab;
      if (!keep.has(t)) { b.hidden = true; b.dataset.grouped = '1'; return; }
      const g = GROUPS.find((x) => x.head === t);
      if (g) b.innerHTML = t === 'talk' ? `${g.label} <span class="ib-count zero" data-inbox-mirror>0</span>` : g.label;
    });
    const intro = document.querySelector('#today .intro');
    if (intro) intro.innerHTML = '<b>Games:</b> each of your games: how its last playtest went, what is broken, and buttons to play it again (live, or its beta), edit it or add another. Go live, beside Games, is for shipping.';
    const add = document.getElementById('addGame');
    if (add) add.hidden = false;
    const onAir = document.getElementById('onAir');
    if (onAir) onAir.hidden = true;
    new MutationObserver(mirrorInbox).observe(document.getElementById('inboxCount'), { childList: true, characterData: true, subtree: true, attributes: true });
    mirrorInbox();
    // The Inbox is no longer the first page: Games is (unless the address asks for one).
    const cur = location.hash.slice(1).split('/')[0];
    if (!cur || cur === 'inbox') show('today');
    else afterShow(cur);
    // A page this Studio doesn't have (an old link to Ready to test, Analytics, Screening): Games instead.
    if (['ready', 'analytics', 'videos', 'social', 'costs', 'resources'].includes(cur)) show(cur === 'ready' ? 'golive' : 'today');
  }

  const css = document.createElement('style');
  css.textContent = `
    .subnav { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
    .subnav button { background: transparent; border: 1px solid transparent; border-radius: 999px; padding: 5px 12px; color: var(--dim); cursor: pointer; font-size: 14px; }
    .subnav button.on { color: var(--text); border-color: var(--line); background: var(--panel2, rgba(255,255,255,.05)); }
    .subnav button:hover { color: var(--text); }`;
  document.head.append(css);
  window.groupNav = groupNav;
  window.afterShow = afterShow;
})();
