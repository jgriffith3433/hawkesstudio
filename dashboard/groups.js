// Every Studio has the same grouped tabs (J, 2026-10-30: "there's way too many tabs"; 2026-11-02: admin "shouldn't be
// vastly different it should just have extra features"). The nav shows one button per group; inside, a small bar
// switches between the group's pages, which are the same tabs as before (so links, Talk's guide and #hash addresses
// keep working). A page this Studio doesn't have is left out of its group, so J's Studio is a customer's plus extras.
//   Talk       Talk · Inbox
//   Projects   Projects (each project's card, add/edit/delete) · Ready to test* · Go live · Analytics
//   Plan       Roadmap · Bugs (the backlog) · Agents' changes
//   Playtests  Playing now · History · Reports · Runs
//   Library    Library · Screening* · Social*
//   More       Memory, Connect your editor, Plugins, Costs*, Resources*, Users, Settings
// * not in a customer's Studio: Ready to test (Go live covers it) and Screening (the platform admin's) by CUSTOMER_LESS;
// Social, Costs, Resources and On Air by /api/me's `hide` (src/lockdown.ts), which also hides them from J's members.
(() => {
  const GROUPS = [
    { head: 'talk', label: 'Talk', tabs: [['talk', 'Talk'], ['inbox', 'Inbox']] },
    { head: 'today', label: 'Projects', tabs: [['today', 'Projects'], ['ready', 'Ready to test'], ['golive', 'Go live'], ['analytics', 'Analytics']] },
    { head: 'roadmap', label: 'Plan', tabs: [['roadmap', 'Roadmap'], ['backlog', 'Bugs'], ['changes', "Agents' changes"]] },
    { head: 'live', label: 'Playtests', tabs: [['live', 'Playing now'], ['playtests', 'History'], ['report', 'Reports'], ['runs', 'Runs']] },
    { head: 'library', label: 'Library', tabs: [['library', 'Library'], ['videos', 'Screening'], ['social', 'Social']] },
  ];
  const MORE = ['memory', 'connect', 'plugins', 'costs', 'resources', 'users', 'customers', 'settings'];
  const CUSTOMER_LESS = ['ready', 'videos'];
  let gone = new Set();
  const pages = (g) => g.tabs.filter(([id]) => !gone.has(id));
  const groupOf = (t) => GROUPS.find((g) => g.tabs.some(([id]) => id === t));
  let on = false;

  /** Lights the group's nav button and draws the bar of its pages at the top of the tab shown. */
  function afterShow(t) {
    if (!on) return;
    const g = groupOf(t);
    document.querySelectorAll('nav button[data-tab]').forEach((b) => { if (g && b.dataset.tab === g.head) b.classList.add('on'); });
    if (!g || pages(g).length < 2) return;
    const sec = document.getElementById(t);
    if (!sec) return;
    let bar = sec.querySelector(':scope > .subnav');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'subnav';
      bar.innerHTML = pages(g).map(([id, label]) => `<button type="button" data-sub="${id}">${label}${id === 'inbox' ? ' <span class="ib-count zero" data-inbox-mirror>0</span>' : ''}</button>`).join('');
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

  /** Called with /api/me (users.js): the grouped nav, with the pages this Studio and this person have. */
  function groupNav(me) {
    if (!me || on) return;
    on = true;
    gone = new Set([...(me.hide ?? []), ...(me.customer ? CUSTOMER_LESS : [])]);
    const keep = new Set([...GROUPS.map((g) => g.head), ...MORE.filter((t) => !gone.has(t))]);
    document.querySelectorAll('nav button[data-tab]').forEach((b) => {
      const t = b.dataset.tab;
      if (!keep.has(t)) { b.hidden = true; b.dataset.grouped = '1'; return; }
      const g = GROUPS.find((x) => x.head === t);
      if (g) b.innerHTML = t === 'talk' ? `${g.label} <span class="ib-count zero" data-inbox-mirror>0</span>` : g.label;
    });
    const intro = document.querySelector('#today .intro');
    if (intro) intro.innerHTML = '<b>Projects:</b> each of your projects (games, web apps, sites): how its last playtest went, what is broken, and buttons to play it again (live, or its beta), edit it or add another. Go live, beside Projects, is for shipping.';
    const anIntro = document.querySelector('#analytics .intro');
    if (anIntro) anIntro.innerHTML = '<b>Analytics:</b> how your projects are doing with real players (from Hawkes Analytics). Tap a project to see more about it.';
    const add = document.getElementById('addGame');
    if (add) add.hidden = false;
    const onAir = document.getElementById('onAir');
    if (onAir && gone.has('onair')) onAir.hidden = true;
    new MutationObserver(mirrorInbox).observe(document.getElementById('inboxCount'), { childList: true, characterData: true, subtree: true, attributes: true });
    mirrorInbox();
    // The Inbox is no longer the first page: Projects is (unless the address asks for one).
    const cur = location.hash.slice(1).split('/')[0];
    if (!cur || cur === 'inbox') show('today');
    else afterShow(cur);
    // A page this Studio doesn't have (an old link to Ready to test, Screening, Costs…): Projects instead.
    if (gone.has(cur)) show(cur === 'ready' ? 'golive' : 'today');
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
