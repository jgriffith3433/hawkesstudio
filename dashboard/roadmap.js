// Roadmap (items, tasks, their checks and threads, questions, the PM loop and its decision log) and "Ready to test".
// Uses app.js's helpers ($, esc, api, ago, file, view).
const RM_PILL = { idea: '', planned: '', 'in progress': 'warn', 'on beta': 'ship', live: 'ship', done: 'ship', dropped: '', working: 'warn', 'needs answer': 'broken', review: 'warn', merged: 'warn', verified: 'ship', failed: 'failed', 'needs you': 'broken', 'waiting for your GPU budget': 'broken', 'waiting for GPU': 'warn', 'waiting for GPU jobs': 'warn' };
// What J sees for an item: its progress from its tasks (roadmap.ts itemProgress), never the stored "done" of a consumed item.
const itemState = (it) => it.progress?.state ?? it.status;
const itemLabel = (it) => it.progress?.label ?? it.status;
const met = (m) => ({ yes: '✅', no: '❌' })[m] ?? '❔';
// Priorities: the PM starts high first, then normal, then low (a task without its own takes its item's).
const RM_RANK = { high: 0, normal: 1, low: 2 };
const prioBadge = (p, inherited) => `<span class="pill ${p === 'high' ? 'broken' : ''}" title="Priority${inherited ? " (its item's)" : ''}: the PM starts high first">${p === 'high' ? '▲ ' : p === 'low' ? '▼ ' : ''}${esc(p)}${inherited ? '*' : ''}</span>`;
const prioSelect = (kind, id, own) => `<select class="small" data-prio="${kind}" data-id="${id}" title="Change the priority">${kind === 'task' ? `<option value=""${own ? '' : ' selected'}>item's</option>` : ''}${['high', 'normal', 'low'].map((p) => `<option value="${p}"${own === p ? ' selected' : ''}>${p}</option>`).join('')}</select>`;
let rmOpen = new Set();
let rmNames = {};

async function loadRoadmap() {
  const sel = $('#rmProduct');
  const qs = new URLSearchParams({ ...(sel.value ? { product: sel.value } : {}), ...($('#rmStatus').value ? { status: $('#rmStatus').value } : {}) });
  const [r, pm] = await Promise.all([api(`/api/roadmap?${qs}`), api('/api/pm')]);
  // The products, then Hawkes Studio and Hawkes Gen themselves (their items are roadmap items too).
  rmNames = Object.fromEntries((r.products ?? []).map((p) => [p.id, p.name]));
  if (sel.options.length <= 1) sel.innerHTML += (r.products ?? []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const s = pm.settings;
  const c = pm.capacity;
  studioPatch($('#rmPm'), `<b>PM loop:</b> ${s.enabled ? '<span class="pill ship">running</span>' : '<span class="pill failed">paused</span>'}
    <button class="small" data-pro="pm" data-admin data-pm="toggle">${s.enabled ? 'Pause' : 'Resume'}</button>
    · delegated merges into beta: <b>${s.delegatedMerges ? 'on' : 'off'}</b> <button class="small" data-pm="merges">${s.delegatedMerges ? 'Turn off' : 'Turn on'}</button>
    · agents ${c.active}/${s.maxConcurrent} · starts today ${c.started}/${s.maxStartsPerDay} <button class="small" data-pm="caps">Limits…</button>
    ${pm.turn ? ' · <span class="pill warn">PM turn running</span>' : ''}${pm.conversation ? ` · <a href="/?conversation=${esc(pm.conversation.id)}#talk">PM conversation</a>` : ''}
    ${pm.lastError ? `<div class="meta" style="color:var(--red)">${esc(pm.lastError)}</div>` : ''}
    ${(pm.limits ?? []).map((n) => `<div class="meta" style="margin-top:6px"><span class="pill warn">⏳ ${esc(n.label)} reached</span> <b>${n.used}/${n.limit}</b>: ${n.waiting} roadmap task${n.waiting === 1 ? '' : 's'} waiting. ${n.resets ? `Resets ${esc(n.resets)}. ` : ''}Raise it: ${esc(n.raise)}. <button class="small" data-pm="caps">Limits…</button></div>`).join('')}
    ${holdHtml(pm.hold)}
    ${pm.time?.lines?.length ? `<details class="more-details"><summary class="meta">Where the time goes today</summary>${pm.time.lines.map((l) => `<div class="meta">${esc(l)}</div>`).join('')}</details>` : ''}`);
  // Questions are answered in the Inbox (one place for everything waiting on J).
  const asked = pm.questions.filter((q) => q.status === 'asked J').length;
  const agents = pm.questions.length - asked;
  studioPatch($('#rmQuestions'), pm.questions.length ? `<div class="meta" style="margin:4px 0 8px">${asked ? `<b>${asked} question(s) for you</b> are in your <a href="#inbox" onclick="show('inbox');return false">Inbox</a>.` : ''}${agents ? ` ${agents} agent question(s) the PM is answering.` : ''}</div>` : '');
  // The task bar (taskbar.ts): one line per project, and each task it parked with its reason (readable at 390px: plain wrapping lines).
  studioPatch($('#rmTaskBar'), taskBarHtml(r.taskBar));
  rmMilestones = r.milestones;
  rmItems = r.items;
  const view = $('#rmView').value;
  // The overview: every project on one screen (overviewHtml). A row opens that project's board; "← Every project" comes back.
  const overview = view === 'overview';
  studioPatch($('#rmOverview'), overview ? overviewHtml(overviewData(r), Boolean($('#rmStatus').value)) : `<button class="small" data-ov-back title="Every project's progress on one screen">← Every project</button>`);
  if (overview) {
    for (const id of ['#rmBoard', '#rmMilestones', '#rmList']) studioPatch($(id), '');
    studioPatch($('#rmLog'), logHtml(pm));
    return;
  }
  const board = view !== 'list';
  studioPatch($('#rmBoard'), board ? boardHtml(r) : '');
  studioPatch($('#rmMilestones'), !board && r.milestones.length ? `<h3>Milestones</h3>${r.milestones.map(milestoneHtml).join('')}` : '');
  // Sort by priority (stable: equal ones keep the roadmap order), items and the tasks in each.
  if ($('#rmSort').value === 'priority') {
    r.items.sort((a, b) => RM_RANK[a.priority] - RM_RANK[b.priority]);
    for (const it of r.items) it.tasks.sort((a, b) => RM_RANK[a.effective_priority] - RM_RANK[b.effective_priority]);
  }
  const open = new Set([...$('#rmList').querySelectorAll('details[data-key][open]')].map((d) => d.dataset.key));
  studioPatch($('#rmList'), r.items.length ? r.items.map(itemHtml).join('') : '<div class="empty">No roadmap items yet. Tell Talk what you want ("let\'s do X"): it proposes items and tasks with acceptance criteria, and adds them when you say yes.</div>');
  for (const d of $('#rmList').querySelectorAll('details[data-key]')) if (open.has(d.dataset.key)) d.open = true;
  studioPatch($('#rmLog'), logHtml(pm));
  for (const id of rmOpen) loadThread(id);
}

/** "Task bar: 3 rewritten, 1 parked this week" per project that has had any, with each parked task's reason and an Edit button. */
function taskBarHtml(bar) {
  const lines = Object.entries(bar ?? {}).map(([id, b]) => {
    const w = b.last7days ?? {};
    const parts = [w.rewritten ? `${w.rewritten} rewritten` : '', w.parked ? `${w.parked} parked` : '', w.passed ? `${w.passed} passed` : ''].filter(Boolean);
    if (!parts.length && !(b.parkedTasks ?? []).length) return '';
    return `<div class="meta" data-key="tb:${esc(id)}" style="margin:2px 0"><b>${esc(rmNames[id] ?? id)}</b> · Task bar: ${parts.length ? `${esc(parts.join(', '))} this week` : 'nothing new this week'}
      ${(b.parkedTasks ?? []).map((t) => `<div style="margin:2px 0 2px 10px">⏸ ${esc(t.title)}: ${esc(t.reason)} <button class="small" data-edit-task="${esc(t.id)}">Edit</button></div>`).join('')}</div>`;
  }).filter(Boolean);
  return lines.length ? `<div style="margin:4px 0 8px">${lines.join('')}</div>` : '';
}

/** The PM decision log, with Undo on the ones that can be undone. */
const logHtml = (pm) => `<summary class="meta">PM decision log (${pm.log.length})</summary>${pm.log.map((d) => `<div class="test"><span class="name">${esc(d.action)}</span><span class="detail">${esc(d.detail ?? '')} · ${esc(d.product ?? '')} · ${ago(d.at)}${d.undone ? ' · <i>undone</i>' : ''}</span>${d.undo && !d.undone ? `<button class="small" data-undo="${d.id}">Undo</button>` : ''}</div>`).join('')}`;

/** The harness hold (harness-hold.ts): what refuses to run and why, until when, the stand-in, and what waits on it. */
function holdHtml(h) {
  if (!h) return '';
  const lines = h.holds.map((x) => `<div class="meta"><span class="pill ${x.needsJ ? 'failed' : 'warn'}">${esc(x.label)}: ${esc(x.kind)}</span> ${esc(x.why)} · ${esc(x.next)}${x.needsJ ? ' · <b>needs you</b>' : ''}${x.line ? `<br><span style="opacity:.8">${esc(x.line)}</span>` : ''}</div>`);
  const stand = h.standIn ? `<div class="meta"><span class="pill ship">${esc(h.standIn.label)} stands in</span> for ${esc(h.standIn.for)} since ${ago(h.standIn.since)}: work goes on, and switches back by itself</div>` : '';
  const parked = h.parked?.length ? `<div class="meta">${h.parked.length} change(s) parked with their work, resuming by themselves: ${h.parked.slice(0, 6).map((c) => esc(c.title ?? c.id)).join(' · ')}</div>` : '';
  return `<div style="margin-top:6px"><b>AI harness:</b> ${h.held ? 'on hold, nothing new starts until it answers' : 'running on the stand-in'}${lines.join('')}${stand}${parked}</div>`;
}

let rmMilestones = [];
let rmItems = [];
const DONE_STATES = ['on beta', 'verified', 'live', 'done'];

/** An item's blocker in words: what it waits on and who acts, or that nothing blocks it (roadmap.ts itemProgress `next`, task `waits`). */
function blockerWords(it) {
  const p = it.progress;
  const state = p?.state ?? it.status;
  if (DONE_STATES.includes(state)) return 'Nothing blocks it: it is done.';
  if (state === 'idea') return 'Blocked: it is only an idea until you plan it (Plan it).';
  if (state === 'dropped') return 'Dropped.';
  if (state === 'needs you') {
    const t = it.tasks.find((x) => x.status === 'failed' || x.status === 'needs answer');
    return `Blocked on you: ${t ? `"${t.title}" ${t.status === 'failed' ? 'failed and needs a decision' : 'has a question for you'}` : 'a question or a failed task needs your answer'} (Inbox).`;
  }
  if (state === 'waiting for your GPU budget') return 'Blocked on you: it needs a GPU budget approved (Inbox).';
  const stuck = it.tasks.find((t) => t.status === 'planned' && t.blocked_by?.length);
  if (stuck && p?.next) return `Blocked: ${p.next}.`;
  if (p?.next) return `Waiting: ${p.next}.`;
  return 'Nothing blocks it: Studio starts the next task by itself.';
}

function boardItem(it, fallback) {
  if (!it) return `<div class="rm-bitem"><span class="pill ${RM_PILL[fallback.state] ?? 'warn'}">${esc(fallback.display ?? fallback.state)}</span> <b>${esc(fallback.title)}</b></div>`;
  const state = itemState(it);
  const ok = DONE_STATES.includes(state);
  return `<div class="rm-bitem" data-key="bi:${esc(it.id)}"><div><span class="pill ${RM_PILL[state] ?? 'warn'}">${esc(itemLabel(it))}</span> <b>${esc(it.title)}</b>${it.priority === 'high' ? ` ${prioBadge(it.priority)}` : ''}</div>
    <div class="meta rm-blocker" style="${ok ? '' : /^Blocked on you/.test(blockerWords(it)) ? 'color:var(--red)' : ''}">${esc(blockerWords(it))}</div></div>`;
}

/** The visual roadmap: a card per milestone (items done of total, a bar, each item with its state and blocker), then what is in none. */
function boardHtml(r) {
  const byId = new Map(r.items.map((i) => [i.id, i]));
  const inMs = new Set();
  const cards = r.milestones.map((m) => {
    const pct = m.total ? Math.round((100 * m.done) / m.total) : 0;
    for (const i of m.items) inMs.add(i.id);
    const criticLine = m.critic?.waiting
      ? `<div class="meta rm-critic" style="overflow-wrap:anywhere;min-width:0;color:var(--amber)">${esc(m.critic.line || 'waiting for the critic')}</div>`
      : m.critic?.line ? `<div class="meta rm-critic" style="overflow-wrap:anywhere;min-width:0">${esc(m.critic.line)}</div>` : '';
    return `<div class="card rm-col" data-key="bm:${esc(m.id)}"><h3>🏁 ${esc(m.title)} <span class="pill ${m.status === 'reached' || m.status === 'live' ? 'ship' : m.critic?.waiting ? 'warn' : ''}">${esc(m.critic?.waiting ? 'waiting for the critic' : m.status)}</span></h3>
      <div class="meta">${esc(m.product ? rmNames[m.product] ?? m.product : 'all products')}</div>
      <div class="status-line"><b>${m.done} of ${m.total} items done</b>${m.tasks?.total ? ` · ${m.tasks.merged} of ${m.tasks.total} tasks merged` : ''}</div>
      <div style="height:8px;background:var(--line, #333);border-radius:4px;overflow:hidden;margin:4px 0"><div style="height:8px;width:${pct}%;background:var(--accent, #33d6a6)"></div></div>
      ${criticLine}
      ${m.goal ? `<div class="summary">${esc(m.goal)}</div>` : ''}
      ${m.items.map((i) => boardItem(byId.get(i.id), i)).join('') || '<div class="meta">No items yet: add items to it (Milestone… on an item).</div>'}
      <div class="actions">${m.status === 'reached' ? `<a class="small" href="#ready" data-goto="ready">What to test</a>` : ''}${m.status !== 'live' && m.status !== 'dropped' ? `<button class="small" data-ms="${m.id}" data-st="live">Live</button><button class="small" data-ms="${m.id}" data-st="dropped">Drop</button>` : ''}</div></div>`;
  });
  const loose = r.items.filter((i) => !inMs.has(i.id) && !['dropped', 'idea'].includes(itemState(i)));
  if (loose.length) cards.push(`<div class="card rm-col" data-key="bm:none"><h3>No milestone yet</h3><div class="status-line"><b>${loose.filter((i) => DONE_STATES.includes(itemState(i))).length} of ${loose.length} items done</b></div>${loose.map((i) => boardItem(i)).join('')}</div>`);
  return cards.length ? `<div class="cards rm-board">${cards.join('')}</div>` : '';
}
// ------------------------------------------------------------ overview
// J, 2026-11-09: "For the Plan tab, I'd like a more birds eye view of work being done (but in progress format for all
// projects and so I don't have to scroll)". One row per project: a bar of its tasks by where they stand, how far along
// (on beta or live), a small bar per open milestone, and the counts that matter. It fits a laptop screen; a row opens
// that project's board. Built from the same /api/roadmap answer as the board (no extra request), and redrawn by the
// push stream like the rest of the page (no timer).
/** Where a task stands, in the overview's words: [key, label, colour]. Order is the bar's order, left to right. */
const OV_BUCKETS = [
  ['live', 'live', 'var(--accent)'],
  ['beta', 'on beta', 'var(--blue)'],
  ['working', 'working', 'var(--amber)'],
  ['gpu', 'waiting for GPU', 'var(--violet)'],
  ['planned', 'planned', '#46515d'],
  ['you', 'needs you', 'var(--red)'],
];
/** A task (itemProgress `tasks`: status and what it waits on) to its overview bucket. */
function taskBucket(t) {
  const w = t.waits ?? '';
  if (/^(you|your)\b/.test(w)) return 'you';
  if (t.status === 'live') return 'live';
  if (['verified', 'done'].includes(t.status) || (t.status === 'merged' && !w)) return 'beta';
  if (t.status === 'waiting for GPU' || /^GPU jobs/.test(w)) return 'gpu';
  if (t.status === 'planned') return 'planned';
  return 'working';
}
/**
 * Per project: task counts per bucket, items done of total, and each open (or reached) milestone's items done of total
 * for that project (a milestone across products counts its own items per product). Projects with nothing planned are
 * listed apart, so the grid stays one screen.
 */
function overviewData(r) {
  const OV_DONE = ['on beta', 'verified', 'live', 'done'];
  const blank = (id, name) => ({ id, name, n: Object.fromEntries(OV_BUCKETS.map(([k]) => [k, 0])), tasks: 0, items: 0, itemsDone: 0, ms: [], shipped: 0 });
  const rows = new Map();
  const row = (id) => rows.get(id) ?? rows.set(id, blank(id, (r.products ?? []).find((p) => p.id === id)?.name ?? id)).get(id);
  for (const p of r.products ?? []) row(p.id);
  for (const it of r.items ?? []) {
    const state = it.progress?.state ?? it.status;
    if (['idea', 'dropped'].includes(state)) continue;
    const x = row(it.product);
    x.items++;
    if (OV_DONE.includes(state)) x.itemsDone++;
    for (const t of it.progress?.tasks ?? []) { x.n[taskBucket(t)]++; x.tasks++; }
  }
  let milestones = 0;
  for (const m of r.milestones ?? []) {
    if (m.status === 'dropped') continue;
    const by = new Map();
    for (const i of m.items ?? []) {
      const pid = i.product ?? m.product;
      if (!pid) continue;
      const g = by.get(pid) ?? by.set(pid, { done: 0, total: 0 }).get(pid);
      g.total++;
      if (OV_DONE.includes(i.state ?? i.status)) g.done++;
    }
    if (!by.size && m.product) by.set(m.product, { done: 0, total: 0 });
    if (m.status !== 'live') milestones++;
    for (const [pid, g] of by) {
      if (m.status === 'live') row(pid).shipped++;
      else row(pid).ms.push({ id: m.id, title: m.title, status: m.status, ...g });
    }
  }
  const all = [...rows.values()];
  const busy = all.filter((x) => x.tasks || x.items || x.ms.length);
  const total = blank('all', 'Every project');
  for (const x of busy) { for (const [k] of OV_BUCKETS) total.n[k] += x.n[k]; total.tasks += x.tasks; total.items += x.items; total.itemsDone += x.itemsDone; }
  return { rows: busy, idle: all.filter((x) => !busy.includes(x)), total, milestones };
}
const ovPct = (x) => (x.tasks ? Math.round((100 * (x.n.live + x.n.beta)) / x.tasks) : 0);
/** The stacked bar: one segment per bucket, as wide as its share of the tasks. */
function ovBar(x) {
  if (!x.tasks) return `<span class="rm-ov-bar empty" title="No tasks yet: Studio plans them from the items' goals"></span>`;
  return `<span class="rm-ov-bar" title="${esc(OV_BUCKETS.filter(([k]) => x.n[k]).map(([k, label]) => `${x.n[k]} ${label}`).join(' · '))}">${OV_BUCKETS.filter(([k]) => x.n[k]).map(([k, , c]) => `<i style="width:${((100 * x.n[k]) / x.tasks).toFixed(2)}%;background:${c}"></i>`).join('')}</span>`;
}
/** The counts J asked for: working, on beta, live and needing him (and GPU waits when there are any). Zeroes left out. */
function ovCounts(x) {
  const show = ['you', 'working', 'gpu', 'beta', 'live'].filter((k) => x.n[k]);
  return show.map((k) => { const [, label, c] = OV_BUCKETS.find(([b]) => b === k); return `<span class="rm-ov-c${k === 'you' ? ' you' : ''}" title="${x.n[k]} task${x.n[k] === 1 ? '' : 's'} ${esc(label)}"><i style="background:${c}"></i>${x.n[k]}</span>`; }).join('') || '<span class="meta">nothing yet</span>';
}
/** A small bar per milestone of the project: filled as far as its items are done; reached ones are full and outlined. */
function ovMilestones(x) {
  const MAX = 6;
  const bars = x.ms.slice(0, MAX).map((m) => { const pct = m.total ? Math.round((100 * m.done) / m.total) : 0; return `<span class="rm-ov-m${m.status === 'reached' ? ' reached' : ''}" title="🏁 ${esc(m.title)}: ${m.done} of ${m.total} item${m.total === 1 ? '' : 's'} done${m.status === 'reached' ? ' (reached: ready for you to test)' : ''}"><i style="width:${pct}%"></i></span>`; }).join('');
  const more = x.ms.length > MAX ? `<span class="meta">+${x.ms.length - MAX}</span>` : '';
  const shipped = x.shipped ? `<span class="meta" title="${x.shipped} milestone${x.shipped === 1 ? '' : 's'} live">✓${x.shipped}</span>` : '';
  return `${bars}${more}${shipped}` || '<span class="meta">—</span>';
}
function overviewHtml(d, filtered = false) {
  if (!d.rows.length) return '<div class="empty">No roadmap work yet. Tell Talk what you want: it proposes items and tasks, and they show here.</div>';
  const t = d.total;
  const legend = OV_BUCKETS.map(([k, label, c]) => `<span class="rm-ov-c${k === 'you' ? ' you' : ''}"><i style="background:${c}"></i>${esc(label)} <b>${t.n[k]}</b></span>`).join('');
  const rowHtml = (x) => `<div class="rm-ov-row" role="button" tabindex="0" data-ov="${esc(x.id)}" data-key="ov:${esc(x.id)}" title="Open ${esc(x.name)}'s board">
    <span class="rm-ov-name">${esc(x.name)}</span>${ovBar(x)}<span class="rm-ov-pct">${ovPct(x)}%</span>
    <span class="rm-ov-ms">${ovMilestones(x)}</span><span class="rm-ov-n">${ovCounts(x)}</span></div>`;
  return `<div class="rm-ov" data-key="ov">
    <div class="rm-ov-head"><b>${d.rows.length} project${d.rows.length === 1 ? '' : 's'} · ${d.milestones} milestone${d.milestones === 1 ? '' : 's'} · ${t.tasks} task${t.tasks === 1 ? '' : 's'}</b> <span class="meta">${ovPct(t)}% on beta or live · ${t.itemsDone} of ${t.items} items done</span></div>
    <div class="rm-ov-legend">${legend}</div>
    <div class="rm-ov-row total" data-key="ov:all"><span class="rm-ov-name">Every project</span>${ovBar(t)}<span class="rm-ov-pct">${ovPct(t)}%</span><span class="rm-ov-ms meta">milestones</span><span class="rm-ov-n meta">tasks</span></div>
    <div class="rm-ov-rows">${d.rows.map(rowHtml).join('')}</div>
    ${d.idle.length ? `<div class="meta rm-ov-idle">${filtered ? 'Nothing in this filter' : 'Nothing planned yet'}: ${d.idle.map((x) => esc(x.name)).join(' · ')}</div>` : ''}
  </div>`;
}

function milestoneHtml(m) {
  const pct = m.total ? Math.round((100 * m.done) / m.total) : 0;
  return `<div class="finding"><div style="flex:1">
    <h4><span class="pill ${m.status === 'reached' || m.status === 'live' ? 'ship' : m.critic?.waiting ? 'warn' : ''}">${esc(m.critic?.waiting ? 'waiting for the critic' : m.status)}</span> 🏁 ${esc(m.title)} <span class="meta" style="overflow-wrap:anywhere">${esc(m.product ? rmNames[m.product] ?? m.product : 'all products')} · ${esc(m.id)} · ${m.done}/${m.total} items on beta${m.tasks ? ` · tasks: ${m.tasks.merged}/${m.tasks.total} merged, ${m.tasks.built}/${m.tasks.total} built on beta` : ''}${m.status === 'open' && m.checks ? ' · <b>playtesting its tasks on beta</b>' : ''}${m.critic?.waiting ? ` · <b>${esc(m.critic.line || 'waiting for the critic')}</b>` : ''}${m.reached_at ? ` · reached ${ago(m.reached_at)}` : ''}</span></h4>
    <div style="height:6px;background:var(--line, #333);border-radius:3px;overflow:hidden;margin:4px 0"><div style="height:6px;width:${pct}%;background:var(--accent, #33d6a6)"></div></div>
    ${m.goal ? `<div class="summary">${esc(m.goal)}</div>` : ''}${m.test ? `<div class="meta">You'll test: ${esc(m.test)}</div>` : ''}
    <div class="meta">${m.items.map((i) => `<span class="pill ${RM_PILL[i.state ?? i.status] ?? 'warn'}">${esc(i.display ?? i.status)}</span> ${esc(i.title)}`).join(' · ') || 'No items yet: add items to it (Milestone… on an item).'}</div>
  </div><div class="side"><div class="actions">
    ${m.status === 'reached' ? `<a class="small" href="#ready" data-goto="ready">What to test</a>` : ''}
    ${m.status !== 'live' && m.status !== 'dropped' ? `<button class="small" data-ms="${m.id}" data-st="live" title="You went live with it">Live</button><button class="small" data-ms="${m.id}" data-st="dropped">Drop</button>` : ''}
  </div></div></div>`;
}

/** Where an item's tasks stand, in one line: "2 working · 1 merged · 3 planned". */
function taskLine(it) {
  if (!it.tasks.length) return 'No tasks yet.';
  const n = {};
  for (const t of it.tasks) n[t.status] = (n[t.status] ?? 0) + 1;
  return `${it.tasks.length} task${it.tasks.length === 1 ? '' : 's'}: ${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(' · ')}`;
}

function itemHtml(it) {
  const tasks = it.tasks.map((t) => {
    const checks = t.checks?.results?.length ? `<div class="meta">Checked on ${esc(t.checks.where)}: ${t.checks.results.map((k) => `<span title="${esc(k.evidence ?? '')}">${met(k.met)} ${esc(k.criterion)}</span>`).join(' · ')}${t.checks.video ? ` <a href="${file(t.checks.video)}" target="_blank" rel="noopener" data-video="${file(t.checks.video)}">▶</a>` : ''}</div>` : '';
    // What it waits on, and beta's build after its merge ("did it work").
    const p = it.progress?.tasks?.find((x) => x.id === t.id);
    // Blocked: who it waits on and why ("waiting on "X" (k_..), which failed: ..."), in red when that won't move by itself (roadmap.ts waitingOn).
    const stuckDep = t.blocked_by?.some((d) => ['idea', 'failed', 'missing'].includes(d.status));
    const blocked = t.status === 'planned' && t.blocked_by?.length
      ? `<b${stuckDep ? ' style="color:var(--red)"' : ''}>${esc(p?.waits?.startsWith('waiting on') ? p.waits : `blocked by ${t.blocked_by.map((d) => d.title).join(', ')}`)}</b>` : '';
    const waits = p?.waits && !blocked ? `waiting ${/^GPU jobs/.test(p.waits) ? 'for' : 'on'} ${esc(p.waits)}` : '';
    const build = t.build ? `<span title="${esc(t.build.detail)}">${t.build.ok ? '✅ built on beta' : `<b style="color:var(--red)">❌ beta's build failed</b>`}</span>` : '';
    return `<div class="test" style="flex-wrap:wrap"><span class="pill ${RM_PILL[t.status] ?? ''}">${esc(t.status)}</span>${t.priority === 'high' || (!t.priority && t.effective_priority === 'high') ? prioBadge(t.effective_priority, !t.priority) : ''}<span class="name">${esc(t.title)}</span>
      <span class="detail">${[blocked, build, waits, t.note ? esc(t.note) : ''].filter(Boolean).join(' · ')}</span>
      <span>${['idea', 'failed'].includes(t.status) ? `<button class="small" data-task="${t.id}" data-st="planned">Plan</button>` : ''}</span>
      <div style="flex-basis:100%">${checks}<div id="th-${t.id}" data-patch-keep></div></div></div>`;
  }).join('');
  // Ids, changes, tries, priorities and the less common buttons, behind Details.
  const taskDetails = it.tasks.map((t) => `<div class="test" style="flex-wrap:wrap"><span class="name">${esc(t.title)}</span>
      <span class="detail">${esc(t.id)}${t.tries ? ` · try ${t.tries}` : ''}${t.change ? ` · ${esc(t.change)}` : ''}${t.pr ? ` · <a href="${esc(t.pr)}" target="_blank">PR</a>` : ''}${t.depends.length ? ` · after ${t.depends.map(esc).join(', ')}` : ''}</span>
      <span>${prioBadge(t.effective_priority, !t.priority)}${prioSelect('task', t.id, t.priority)}${!['dropped', 'live', 'verified', 'done'].includes(t.status) ? `<button class="small" data-task="${t.id}" data-st="dropped">Drop</button>` : ''}<button class="small" data-thread="${t.id}">Thread</button></span>
      ${!t.checks?.results?.length && t.criteria.length ? `<div class="meta" style="flex-basis:100%">Criteria: ${t.criteria.map(esc).join(' · ')}</div>` : ''}</div>`).join('');
  const main = it.status === 'idea' ? `<button class="small primary" data-item="${it.id}" data-st="planned" title="Its planned tasks start by themselves, in order">Plan it</button>`
    : it.status === 'live' ? `<button class="small" data-item="${it.id}" data-st="done">Done</button>`
    : ['on beta', 'verified'].includes(itemState(it)) ? `<a class="small" href="#ready" data-goto="ready">Try it (Ready to test)</a>` : '';
  return `<div class="finding" data-item="${it.id}" data-key="rm:${esc(it.id)}"><div style="flex:1">
    <h4><span class="pill ${RM_PILL[itemState(it)] ?? 'warn'}">${esc(itemLabel(it))}</span>${it.priority === 'high' ? ` ${prioBadge(it.priority)}` : ''} ${esc(it.title)} <span class="meta">${esc(rmNames[it.product] ?? it.product)}${it.milestone ? ` · 🏁 ${esc(rmMilestones.find((m) => m.id === it.milestone)?.title ?? it.milestone)}` : ''}</span></h4>
    <div class="status-line">${esc(taskLine(it))}${it.progress?.next ? ` · <b>${esc(it.progress.next)}</b>` : ''}</div>
    ${it.goal ? `<div class="summary">${esc(it.goal)}</div>` : ''}
    ${it.criteria.length ? `<div class="meta">Done when: ${it.criteria.map(esc).join(' · ')}</div>` : ''}
    <div class="tests">${tasks}</div>
    <div id="th-${it.id}" data-patch-keep></div>
    <details class="more-details" data-key="${it.id}"><summary class="meta">Details</summary>
      ${it.why ? `<div class="meta">Why: ${esc(it.why)}</div>` : ''}
      <div class="meta">${esc(it.id)}${it.size ? ` · size ${esc(it.size)}` : ''} · ${ago(it.created)} by ${esc(it.by ?? '')} · priority ${esc(it.priority)}</div>
      <div class="tests">${taskDetails}</div>
      <div class="actions">
        ${!['done', 'dropped', 'live'].includes(it.status) && it.status !== 'idea' ? `<button class="small" data-item="${it.id}" data-st="idea">Park</button>` : ''}${!['done', 'dropped'].includes(it.status) ? `<button class="small" data-item="${it.id}" data-st="dropped">Drop</button>` : ''}
        ${prioSelect('item', it.id, it.priority)}<button class="small" data-addtask="${it.id}">Add task</button><button class="small" data-setms="${it.id}" title="Put it in a milestone">Milestone…</button><button class="small" data-thread="${it.id}">Thread</button>
      </div>
    </details>
  </div><div class="side"><div class="actions">${main}</div></div></div>`;
}

async function loadThread(id) {
  const el = document.getElementById(`th-${id}`);
  if (!el) return;
  const { comments } = await api(`/api/comments?subject=${id}`);
  el.innerHTML = `<div class="thread">${comments.map((m) => `<div class="meta"><b>${esc(m.by)}</b>${m.kind !== 'comment' ? ` (${esc(m.kind)})` : ''} · ${ago(m.at)}: <span style="white-space:pre-wrap">${esc(m.text)}</span></div>`).join('') || '<div class="meta">No comments yet.</div>'}
    <div class="actions"><input data-cin="${id}" placeholder="Add a comment (agents read this thread)" style="flex:1"><button class="small" data-csend="${id}">Add</button></div></div>`;
}

$('#rmView').onchange = $('#rmStatus').onchange = $('#rmSort').onchange = loadRoadmap;
// Picking one project from the overview shows its board (the overview is every project at once).
$('#rmProduct').onchange = () => {
  if ($('#rmProduct').value && $('#rmView').value === 'overview') $('#rmView').value = 'board';
  loadRoadmap();
};
// The inline priority selects: an item's, or a task's own ('' = its item's).
$('#roadmap').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-prio]');
  if (!sel) return;
  try {
    await api(`/api/roadmap/${sel.dataset.prio === 'item' ? 'items' : 'tasks'}/${sel.dataset.id}`, { method: 'PATCH', body: { priority: sel.value } });
  } catch (err) {
    alert(err.message);
  }
  loadRoadmap();
});
/** A project's row opens its board; "← Every project" comes back to the overview. */
function openOverviewRow(id) {
  $('#rmProduct').value = id;
  $('#rmView').value = 'board';
  loadRoadmap();
  window.scrollTo?.(0, 0);
}
$('#roadmap').addEventListener('keydown', (e) => {
  const row = e.target.closest?.('[data-ov]');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openOverviewRow(row.dataset.ov); }
});
$('#roadmap').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-ov]');
  if (row) return openOverviewRow(row.dataset.ov);
  if (e.target.closest('[data-ov-back]')) {
    $('#rmProduct').value = '';
    $('#rmView').value = 'overview';
    return loadRoadmap();
  }
  const t = e.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.pm) {
      const pm = await api('/api/pm');
      if (t.dataset.pm === 'toggle') await api('/api/pm/settings', { method: 'POST', body: { enabled: !pm.settings.enabled } });
      if (t.dataset.pm === 'merges') await api('/api/pm/settings', { method: 'POST', body: { delegatedMerges: !pm.settings.delegatedMerges } });
      if (t.dataset.pm === 'caps') {
        const a = prompt('Agents at once, agent starts per day, tries per task (e.g. "2 8 3")', `${pm.settings.maxConcurrent} ${pm.settings.maxStartsPerDay} ${pm.settings.maxTries}`);
        if (!a) return;
        const [x, y, z] = a.trim().split(/\s+/).map(Number);
        await api('/api/pm/settings', { method: 'POST', body: { maxConcurrent: x || pm.settings.maxConcurrent, maxStartsPerDay: y || pm.settings.maxStartsPerDay, maxTries: z || pm.settings.maxTries } });
      }
    }
    if (t.dataset.ms) await api(`/api/roadmap/milestones/${t.dataset.ms}`, { method: 'PATCH', body: { status: t.dataset.st } });
    if (t.dataset.setms) {
      const list = rmMilestones.filter((m) => m.status === 'open').map((m) => `${m.id}: ${m.title}`).join('\n');
      const id = prompt(`Milestone id for this item (empty to take it out):\n${list || '(no open milestones: make one with New milestone)'}`);
      if (id === null) return;
      await api(`/api/roadmap/items/${t.dataset.setms}`, { method: 'PATCH', body: { milestone: id.trim().split(':')[0] || null } });
    }
    if (t.id === 'rmNewMs') {
      const title = prompt('Milestone (e.g. "DoD: controls done")');
      if (!title) return;
      const test = prompt('What will you playtest yourself when it is reached?') ?? '';
      await api('/api/roadmap/milestones', { method: 'POST', body: { title, test, product: $('#rmProduct').value || null } });
    }
    if (t.dataset.editTask) {
      // A parked task's request, edited: Plan it again afterwards and the task bar judges the new version.
      const cur = await api(`/api/roadmap/tasks/${t.dataset.editTask}`);
      const request = prompt(`${cur.title}\n\nEdit what the agent should do (a game task: add "Player goal:", "Reference:", "Critic axis:", "Phone:" lines and a "[phone] " criterion in Talk; an infra task: "Outcome:")`, cur.request);
      if (request === null) return;
      const criteria = prompt('Acceptance criteria, separated by ";" (what a playtest can show; one "[phone] ..." for a game)', (cur.criteria ?? []).join('; '));
      if (criteria === null) return;
      await api(`/api/roadmap/tasks/${t.dataset.editTask}`, { method: 'PATCH', body: { request, criteria: criteria.split(';').map((s) => s.trim()).filter(Boolean) } });
    }
    if (t.dataset.item) await api(`/api/roadmap/items/${t.dataset.item}`, { method: 'PATCH', body: { status: t.dataset.st } });
    if (t.dataset.task) await api(`/api/roadmap/tasks/${t.dataset.task}`, { method: 'PATCH', body: { status: t.dataset.st } });
    if (t.dataset.addtask) {
      const request = prompt('What should the agent do? (plain words)');
      if (!request) return;
      const criteria = prompt('Acceptance criteria, separated by ";" (what a playtest can show)') ?? '';
      await api('/api/roadmap/tasks', { method: 'POST', body: { item: t.dataset.addtask, request, criteria: criteria.split(';').map((s) => s.trim()).filter(Boolean) } });
    }
    if (t.dataset.thread) {
      if (rmOpen.has(t.dataset.thread)) { rmOpen.delete(t.dataset.thread); document.getElementById(`th-${t.dataset.thread}`).innerHTML = ''; return; }
      rmOpen.add(t.dataset.thread);
      return loadThread(t.dataset.thread);
    }
    if (t.dataset.csend) {
      const input = $(`input[data-cin="${t.dataset.csend}"]`);
      if (!input.value.trim()) return;
      await api('/api/comments', { method: 'POST', body: { subject: t.dataset.csend, text: input.value, by: 'J' } });
      return loadThread(t.dataset.csend);
    }
    if (t.dataset.undo) {
      if (!confirm('Undo this PM decision? (A merge is reverted on beta with a new commit; nothing live changes.)')) return;
      const r = await api(`/api/pm/undo/${t.dataset.undo}`, { method: 'POST', body: { by: 'J' } });
      alert(r.detail);
    }
    if (t.id === 'rmNew') {
      const product = $('#rmProduct').value || prompt('Product id');
      const title = product && prompt('Title');
      if (!title) return;
      const goal = prompt('Goal (one line)') ?? '';
      await api('/api/roadmap/items', { method: 'POST', body: { product, title, goal, status: 'idea' } });
    }
    loadRoadmap();
  } catch (err) {
    alert(err.message);
  }
});

// ------------------------------------------------------------ ready to test
// J's reports from the beta sites' "report a bug" button, with their screenshot and what became of them.
const reportHtml = (r) => `<div class="test" style="align-items:flex-start">${r.shot ? `<img loading="lazy" src="${esc(r.shot)}" data-full="${esc(r.shot)}" style="width:96px;height:72px;object-fit:cover;object-position:top;border-radius:6px;flex:none;cursor:zoom-in" onerror="this.remove()">` : '<span>🐞</span>'}
  <span class="name"><span class="pill ${esc(r.severity)}">${esc(r.severity)}</span> ${esc(r.text || r.title)}<br><span class="meta">${esc(r.id)} · ${esc(r.product)} · ${ago(r.at)} · ${esc(r.viewport ?? '')}${r.errors ? ` · ${r.errors} console error(s)` : ''}${r.build?.ref ? ` · ${esc(r.build.ref)}` : ''}</span></span>
  <span class="pill ${RM_PILL[r.status] ?? ''}">${esc(r.status)}</span></div>`;
async function loadReady() {
  const [{ ready }, rmap, { reports }] = await Promise.all([api('/api/ready'), api('/api/roadmap?milestones=reached'), api('/api/bugreports?limit=200')]);
  studioPatch($('#readyMs'), rmap.milestones.map((m) => {
    const mine = reports.filter((r) => r.milestone === m.id);
    return `<div class="card" style="max-width:none;border-color:var(--accent)"><h3>🏁 Milestone reached: ${esc(m.title)} <small>${esc(m.product ?? '')}</small></h3>
    ${m.test ? `<div class="summary">You said you'd test: ${esc(m.test)}</div>` : ''}<div class="meta">${m.items.map((i) => esc(i.title)).join(' · ')} · reached ${ago(m.reached_at)}. When you've played it: ship it from <a href="#golive" data-goto="golive">Go live</a>, or tap 🐞 on the beta site for each problem (or tell Talk).</div>
    <h4>Your reports${mine.length ? ` (${mine.length})` : ''}</h4>${mine.length ? mine.map(reportHtml).join('') : '<div class="meta">None yet. The 🐞 button on the beta site sends one: it becomes a task for this milestone.</div>'}</div>`;
  }).join('') + (() => {
    const loose = reports.filter((r) => !r.milestone && ['open', 'fixing'].includes(r.status));
    return loose.length ? `<div class="card" style="max-width:none"><h3>🐞 Your other open reports</h3>${loose.map(reportHtml).join('')}</div>` : '';
  })());
  studioPatch($('#readyList'), ready.length ? ready.map((r) => {
    const yes = r.criteria.filter((c) => c.met === 'yes').length;
    return `<div class="card" style="max-width:none" data-item="${esc(r.item)}" data-key="ready:${esc(r.item)}">
    <h3>${esc(r.title)} <small>${esc(r.productName)}</small><span class="pill ${r.partly ? 'warn' : 'ship'}">${esc(r.partly ? r.progress ?? 'partly on beta' : 'on beta')}</span></h3>
    <div class="status-line">${r.criteria.length ? `${yes} of ${r.criteria.length} checks passed on beta` : 'No checks recorded'}${r.bugs.length ? ` · ${r.bugs.length} known bug${r.bugs.length === 1 ? '' : 's'}` : ''}${r.partly ? ' · some of its tasks are still being worked on' : ''}</div>
    ${r.goal ? `<div class="summary">${esc(r.goal)}</div>` : ''}
    <div class="actions">${r.beta ? `<a class="button primary" href="${esc(r.beta)}" target="_blank" rel="noopener">Try it on beta</a>` : '<span class="meta">No beta site</span>'}</div>
    ${r.try.length ? `<h4>How to try it</h4><div class="summary" style="white-space:pre-wrap">${r.try.map(esc).join('\n\n')}</div>` : ''}
    <h4>Checked</h4>${r.criteria.map((c) => `<div class="test"><span>${met(c.met)}</span><span class="name">${esc(c.criterion)}</span><span class="detail">${esc(c.evidence ?? '')}</span>${c.video ? `<a href="${file(c.video)}" target="_blank" rel="noopener" data-video="${file(c.video)}">▶</a>` : ''}</div>`).join('') || '<div class="meta">Nothing checked yet.</div>'}
    ${r.bugs.length ? `<h4>Known bugs</h4>${r.bugs.map((b) => `<div class="meta"><span class="pill ${esc(b.severity)}">${esc(b.severity)}</span> ${esc(b.title)} (${esc(b.status)})</div>`).join('')}` : ''}
    <details class="more-details"><summary class="meta">Details: what changed</summary>
      <div class="meta">${esc(r.item)}${r.criteria.length ? ` · checked on ${[...new Set(r.criteria.map((c) => c.where))].map(esc).join(', ')}` : ''}</div>
      ${r.changes.map((c) => `<div class="test"><span class="pill ${RM_PILL[c.status] ?? ''}">${esc(c.status)}</span><span class="name">${esc(c.title)}</span><span class="detail">${c.build ? `${c.build.ok ? '✅' : '❌'} ${esc(c.build.detail)} · ` : ''}${c.pr ? `<a href="${esc(c.pr)}" target="_blank">pull request</a>` : ''}</span></div>${c.summary ? `<details><summary class="meta">What the agent did</summary><pre>${esc(c.summary)}</pre></details>` : ''}`).join('')}
      ${r.bugs.length ? `<div class="meta">${r.bugs.map((b) => esc(b.id)).join(' · ')}</div>` : ''}
    </details>
  </div>`;
  }).join('') : '<div class="empty">Nothing waiting for you to test yet. Roadmap items show here once their tasks pass their checks on beta.</div>');
}

function rmRefresh() {
  const t = location.hash.slice(1);
  if (t === 'roadmap') loadRoadmap().then(() => window.studioReady('roadmap'), (e) => { $('#rmList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; window.studioReady('roadmap', e); });
  if (t === 'ready') loadReady().catch((e) => ($('#readyList').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
}
document.querySelectorAll('nav button[data-tab="roadmap"], nav button[data-tab="ready"]').forEach((b) => b.addEventListener('click', () => setTimeout(rmRefresh, 0)));
rmRefresh();
// Fresh while open when changes, the Inbox or the roadmap itself move (the push stream, stream.js; no timer); typing in an
// answer box isn't interrupted.
studioStream.on(['changes', 'inbox', 'roadmap'], () => { if (location.hash === '#roadmap' && !document.activeElement?.matches?.('textarea, input, select[data-prio]')) rmRefresh(); });
