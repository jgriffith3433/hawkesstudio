// Roadmap (items, tasks, their checks and threads, questions, the PM loop and its decision log) and "Ready to test".
// Uses app.js's helpers ($, esc, api, ago, file, view).
const RM_PILL = { idea: '', planned: '', 'in progress': 'warn', 'on beta': 'ship', live: 'ship', done: 'ship', dropped: '', working: 'warn', 'needs answer': 'broken', review: 'warn', merged: 'warn', verified: 'ship', failed: 'failed' };
const met = (m) => ({ yes: '✅', no: '❌' })[m] ?? '❔';
let rmOpen = new Set();

async function loadRoadmap() {
  const sel = $('#rmProduct');
  if (sel.options.length <= 1 && typeof overview !== 'undefined' && overview) sel.innerHTML += overview.products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const qs = new URLSearchParams({ ...(sel.value ? { product: sel.value } : {}), ...($('#rmStatus').value ? { status: $('#rmStatus').value } : {}) });
  const [r, pm] = await Promise.all([api(`/api/roadmap?${qs}`), api('/api/pm')]);
  const s = pm.settings;
  const c = pm.capacity;
  $('#rmPm').innerHTML = `<b>PM loop:</b> ${s.enabled ? '<span class="pill ship">running</span>' : '<span class="pill failed">paused</span>'}
    <button class="small" data-pm="toggle">${s.enabled ? 'Pause' : 'Resume'}</button>
    · delegated merges into beta: <b>${s.delegatedMerges ? 'on' : 'off'}</b> <button class="small" data-pm="merges">${s.delegatedMerges ? 'Turn off' : 'Turn on'}</button>
    · agents ${c.active}/${s.maxConcurrent} · starts today ${c.started}/${s.maxStartsPerDay} <button class="small" data-pm="caps">Limits…</button>
    ${pm.turn ? ' · <span class="pill warn">PM turn running</span>' : ''}${pm.conversation ? ` · <a href="/?conversation=${esc(pm.conversation.id)}#talk">PM conversation</a>` : ''}
    ${pm.lastError ? `<div class="meta" style="color:var(--red)">${esc(pm.lastError)}</div>` : ''}`;
  $('#rmQuestions').innerHTML = pm.questions.length ? `<h3>Waiting for an answer (${pm.questions.length})</h3>${pm.questions.map((q) => `<div class="finding"><div>
      <h4><span class="pill ${q.status === 'asked J' ? 'broken' : 'warn'}">${q.kind === 'agent' ? 'agent asks' : 'your call'}</span> ${esc(q.product ?? '')} <span class="meta">${esc(q.id)} · ${esc(q.subject ?? '')} · ${ago(q.at)}</span></h4>
      <div class="summary" style="white-space:pre-wrap">${esc(q.text)}</div>${q.options.length ? `<div class="meta">Options: ${q.options.map(esc).join(' · ')}</div>` : ''}
    </div><div class="side"><textarea rows="3" data-qa="${q.id}" placeholder="Your answer"></textarea><div class="actions"><button class="small primary" data-qsend="${q.id}">Answer</button></div></div></div>`).join('')}` : '';
  rmMilestones = r.milestones;
  $('#rmMilestones').innerHTML = r.milestones.length ? `<h3>Milestones</h3>${r.milestones.map(milestoneHtml).join('')}` : '';
  $('#rmList').innerHTML = r.items.length ? r.items.map(itemHtml).join('') : '<div class="empty">No roadmap items yet. Tell Talk what you want ("let\'s do X"): it proposes items and tasks with acceptance criteria, and adds them when you say yes.</div>';
  $('#rmLog').innerHTML = `<summary class="meta">PM decision log (${pm.log.length})</summary>${pm.log.map((d) => `<div class="test"><span class="name">${esc(d.action)}</span><span class="detail">${esc(d.detail ?? '')} · ${esc(d.product ?? '')} · ${ago(d.at)}${d.undone ? ' · <i>undone</i>' : ''}</span>${d.undo && !d.undone ? `<button class="small" data-undo="${d.id}">Undo</button>` : ''}</div>`).join('')}`;
  for (const id of rmOpen) loadThread(id);
}

let rmMilestones = [];
function milestoneHtml(m) {
  const pct = m.total ? Math.round((100 * m.done) / m.total) : 0;
  return `<div class="finding"><div style="flex:1">
    <h4><span class="pill ${m.status === 'reached' || m.status === 'live' ? 'ship' : ''}">${esc(m.status)}</span> 🏁 ${esc(m.title)} <span class="meta">${esc(m.product ?? 'all products')} · ${esc(m.id)} · ${m.done}/${m.total} items on beta${m.reached_at ? ` · reached ${ago(m.reached_at)}` : ''}</span></h4>
    <div style="height:6px;background:var(--line, #333);border-radius:3px;overflow:hidden;margin:4px 0"><div style="height:6px;width:${pct}%;background:var(--accent, #33d6a6)"></div></div>
    ${m.goal ? `<div class="summary">${esc(m.goal)}</div>` : ''}${m.test ? `<div class="meta">You'll test: ${esc(m.test)}</div>` : ''}
    <div class="meta">${m.items.map((i) => `<span class="pill ${RM_PILL[i.status] ?? ''}">${esc(i.status)}</span> ${esc(i.title)}`).join(' · ') || 'No items yet: add items to it (Milestone… on an item).'}</div>
  </div><div class="side"><div class="actions">
    ${m.status === 'reached' ? `<a class="small" href="#ready">What to test</a>` : ''}
    ${m.status !== 'live' && m.status !== 'dropped' ? `<button class="small" data-ms="${m.id}" data-st="live" title="You went live with it">Live</button><button class="small" data-ms="${m.id}" data-st="dropped">Drop</button>` : ''}
  </div></div></div>`;
}

function itemHtml(it) {
  const tasks = it.tasks.map((t) => {
    const checks = t.checks?.results?.length ? `<div class="meta">Checked on ${esc(t.checks.where)}: ${t.checks.results.map((k) => `<span title="${esc(k.evidence ?? '')}">${met(k.met)} ${esc(k.criterion)}</span>`).join(' · ')}${t.checks.video ? ` <a href="${file(t.checks.video)}" target="_blank" rel="noopener" data-video="${file(t.checks.video)}">▶</a>` : ''}</div>` : t.criteria.length ? `<div class="meta">Criteria: ${t.criteria.map(esc).join(' · ')}</div>` : '';
    return `<div class="test" style="flex-wrap:wrap"><span class="pill ${RM_PILL[t.status] ?? ''}">${esc(t.status)}</span><span class="name">${esc(t.title)}</span>
      <span class="detail">${esc(t.id)}${t.tries ? ` · try ${t.tries}` : ''}${t.change ? ` · ${esc(t.change)}` : ''}${t.pr ? ` · <a href="${esc(t.pr)}" target="_blank">PR</a>` : ''}${t.depends.length ? ` · after ${t.depends.map(esc).join(', ')}` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</span>
      <span>${['idea', 'failed'].includes(t.status) ? `<button class="small" data-task="${t.id}" data-st="planned">Plan</button>` : ''}${!['dropped', 'live', 'verified'].includes(t.status) ? `<button class="small" data-task="${t.id}" data-st="dropped">Drop</button>` : ''}<button class="small" data-thread="${t.id}">Thread</button></span>
      <div style="flex-basis:100%">${checks}<div id="th-${t.id}"></div></div></div>`;
  }).join('');
  return `<div class="finding"><div style="flex:1">
    <h4><span class="pill ${RM_PILL[it.status] ?? ''}">${esc(it.status)}</span> ${esc(it.title)} <span class="meta">${it.milestone ? `🏁 ${esc(rmMilestones.find((m) => m.id === it.milestone)?.title ?? it.milestone)} · ` : ''}${esc(it.product)} · ${esc(it.id)}${it.size ? ` · size ${esc(it.size)}` : ''} · ${ago(it.created)} by ${esc(it.by ?? '')}</span></h4>
    ${it.goal ? `<div class="summary">${esc(it.goal)}</div>` : ''}${it.why ? `<div class="meta">Why: ${esc(it.why)}</div>` : ''}
    ${it.criteria.length ? `<div class="meta">Done when: ${it.criteria.map(esc).join(' · ')}</div>` : ''}
    <div class="tests">${tasks || '<div class="meta">No tasks yet.</div>'}</div>
    <div id="th-${it.id}"></div>
  </div><div class="side"><div class="actions">
    ${it.status === 'idea' ? `<button class="small primary" data-item="${it.id}" data-st="planned" title="Its planned tasks start by themselves, in order">Plan it</button>` : ''}
    ${!['done', 'dropped'].includes(it.status) ? `<button class="small" data-item="${it.id}" data-st="${it.status === 'live' ? 'done' : 'idea'}">${it.status === 'live' ? 'Done' : 'Park'}</button><button class="small" data-item="${it.id}" data-st="dropped">Drop</button>` : ''}
    <button class="small" data-addtask="${it.id}">Add task</button><button class="small" data-setms="${it.id}" title="Put it in a milestone">Milestone…</button><button class="small" data-thread="${it.id}">Thread</button>
  </div></div></div>`;
}

async function loadThread(id) {
  const el = document.getElementById(`th-${id}`);
  if (!el) return;
  const { comments } = await api(`/api/comments?subject=${id}`);
  el.innerHTML = `<div class="thread">${comments.map((m) => `<div class="meta"><b>${esc(m.by)}</b>${m.kind !== 'comment' ? ` (${esc(m.kind)})` : ''} · ${ago(m.at)}: <span style="white-space:pre-wrap">${esc(m.text)}</span></div>`).join('') || '<div class="meta">No comments yet.</div>'}
    <div class="actions"><input data-cin="${id}" placeholder="Add a comment (agents read this thread)" style="flex:1"><button class="small" data-csend="${id}">Add</button></div></div>`;
}

$('#rmProduct').onchange = $('#rmStatus').onchange = loadRoadmap;
$('#roadmap').addEventListener('click', async (e) => {
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
    if (t.dataset.qsend) {
      const answer = $(`textarea[data-qa="${t.dataset.qsend}"]`).value.trim();
      if (!answer) return;
      await api(`/api/questions/${t.dataset.qsend}/answer`, { method: 'POST', body: { answer, by: 'J' } });
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
  $('#readyMs').innerHTML = rmap.milestones.map((m) => {
    const mine = reports.filter((r) => r.milestone === m.id);
    return `<div class="card" style="max-width:none;border-color:var(--accent)"><h3>🏁 Milestone reached: ${esc(m.title)} <small>${esc(m.product ?? '')}</small></h3>
    ${m.test ? `<div class="summary">You said you'd test: ${esc(m.test)}</div>` : ''}<div class="meta">${m.items.map((i) => esc(i.title)).join(' · ')} · reached ${ago(m.reached_at)}. When you've played it: go live from Today, or tap 🐞 on the beta site for each problem (or tell Talk).</div>
    <h4>Your reports${mine.length ? ` (${mine.length})` : ''}</h4>${mine.length ? mine.map(reportHtml).join('') : '<div class="meta">None yet. The 🐞 button on the beta site sends one: it becomes a task for this milestone.</div>'}</div>`;
  }).join('') + (() => {
    const loose = reports.filter((r) => !r.milestone && ['open', 'fixing'].includes(r.status));
    return loose.length ? `<div class="card" style="max-width:none"><h3>🐞 Your other open reports</h3>${loose.map(reportHtml).join('')}</div>` : '';
  })();
  $('#readyList').innerHTML = ready.length ? ready.map((r) => `<div class="card" style="max-width:none">
    <h3>${esc(r.title)} <small>${esc(r.productName)}</small><span class="pill ${r.partly ? 'warn' : 'ship'}">${r.partly ? 'partly on beta' : 'on beta'}</span></h3>
    ${r.goal ? `<div class="summary">${esc(r.goal)}</div>` : ''}
    <div class="meta">${r.beta ? `<a href="${esc(r.beta)}" target="_blank"><b>Try it on beta</b></a>` : 'no beta site'} · ${esc(r.item)}</div>
    ${r.try.length ? `<h4>How to try it</h4><div class="summary" style="white-space:pre-wrap">${r.try.map(esc).join('\n\n')}</div>` : ''}
    <h4>Verified</h4>${r.criteria.map((c) => `<div class="test"><span>${met(c.met)}</span><span class="name">${esc(c.criterion)}</span><span class="detail">${esc(c.evidence ?? '')} · on ${esc(c.where)}</span>${c.video ? `<a href="${file(c.video)}" target="_blank" rel="noopener" data-video="${file(c.video)}">▶</a>` : ''}</div>`).join('')}
    <h4>What changed</h4>${r.changes.map((c) => `<div class="test"><span class="pill ${RM_PILL[c.status] ?? ''}">${esc(c.status)}</span><span class="name">${esc(c.title)}</span><span class="detail">${c.pr ? `<a href="${esc(c.pr)}" target="_blank">pull request</a>` : ''}</span></div>${c.summary ? `<details><summary class="meta">What the agent did</summary><pre>${esc(c.summary)}</pre></details>` : ''}`).join('')}
    <h4>Known bugs</h4>${r.bugs.length ? r.bugs.map((b) => `<div class="meta"><span class="pill ${esc(b.severity)}">${esc(b.severity)}</span> ${esc(b.title)} (${esc(b.id)}, ${esc(b.status)})</div>`).join('') : '<div class="meta">None known.</div>'}
  </div>`).join('') : '<div class="empty">Nothing waiting for you to test yet. Roadmap items show here once their tasks pass their checks on beta.</div>';
}

function rmRefresh() {
  const t = location.hash.slice(1);
  if (t === 'roadmap') loadRoadmap().catch((e) => ($('#rmList').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  if (t === 'ready') loadReady().catch((e) => ($('#readyList').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
}
document.querySelectorAll('nav button[data-tab="roadmap"], nav button[data-tab="ready"]').forEach((b) => b.addEventListener('click', () => setTimeout(rmRefresh, 0)));
rmRefresh();
// Light polling while open (typing in an answer box isn't interrupted).
setInterval(() => { if (location.hash === '#roadmap' && !document.activeElement?.matches?.('textarea, input')) rmRefresh(); }, 15000);
