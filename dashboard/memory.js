// Memory: the shared memory every agent, scout, reviewer and Talk uses (src/memory.ts). J reads, edits, confirms,
// fades and deletes entries; agents' notes wait here as candidates; past agent runs are searchable.
// Uses app.js's helpers ($, esc, api, ago).
const MEM_KIND = { decision: '⚖️', preference: '💬', convention: '📐', lesson: '🩹', canon: '📜', state: '⏳' };
const MEM_PILL = { active: 'ship', candidate: 'warn', disputed: 'broken', faded: '' };
let memEditing = null;

async function loadMemory() {
  const sel = $('#memProduct');
  if (sel.options.length <= 1 && typeof overview !== 'undefined' && overview) sel.innerHTML += overview.products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') + '<option value="hawkesstudio">Hawkes Studio</option><option value="hawkesgen">Hawkes Gen</option>';
  const qs = new URLSearchParams({ limit: '300', status: $('#memStatus').value || 'active,candidate,disputed' });
  if (sel.value) qs.set('product', sel.value);
  if ($('#memKind').value) qs.set('kind', $('#memKind').value);
  if ($('#memQ').value.trim()) qs.set('q', $('#memQ').value.trim());
  const [r, cur] = await Promise.all([api(`/api/memory?${qs}`), api('/api/memory/curation')]);
  const st = r.stats ?? {};
  $('#memStats').innerHTML = `${st.active ?? 0} active · ${st.candidate ?? 0} candidates · ${st.disputed ?? 0} disputed · ${st.faded ?? 0} faded · ${st.runs ?? 0} agent runs remembered
    · export: <a href="/api/memory/export?file=canon.md" target="_blank">story bible</a>${sel.value ? ` · <a href="/api/memory/export?file=learned/${esc(sel.value)}.md" target="_blank">learned (${esc(sel.value)})</a>` : ''}
    · <a href="https://github.com/jgriffith3433/hawkesstudio/tree/memory" target="_blank">in git (branch memory)</a>`;
  $('#memCandidates').innerHTML = cur.candidates.length || cur.disputed.length
    ? `<h3>Waiting for curation</h3><div class="meta">Agents' notes are candidates until the PM or you confirm them. Likely duplicates: ${cur.similar.length ? cur.similar.map((p) => `${esc(p.a)} ≈ ${esc(p.b)} (${p.similarity})`).join(', ') : 'none'}.</div>`
    : '';
  $('#memList').innerHTML = r.memories.length ? r.memories.map(memHtml).join('') : '<div class="empty">Nothing here yet. Talk records J\'s decisions and preferences, agents leave lessons, and the canon comes from the story docs.</div>';
}

function memHtml(m) {
  if (memEditing === m.id) {
    return `<div class="finding" data-mem="${m.id}"><div style="flex:1">
      <select data-f="kind">${['decision', 'preference', 'convention', 'lesson', 'canon', 'state'].map((k) => `<option ${k === m.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <input data-f="product" placeholder="product id (empty: studio-wide)" value="${esc(m.product ?? '')}" style="width:14em">
      <input data-f="title" value="${esc(m.title)}" style="width:100%;margin:4px 0">
      <textarea data-f="body" rows="4" style="width:100%">${esc(m.body)}</textarea>
      <input data-f="tags" placeholder="tags" value="${esc(m.tags ?? '')}" style="width:100%">
    </div><div class="side"><div class="actions"><button class="small primary" data-mem-save="${m.id}">Save</button><button class="small" data-mem-cancel>Cancel</button></div></div></div>`;
  }
  const seen = m.sources?.length ? ` · seen again ${m.sources.length}×` : '';
  return `<div class="finding" data-mem="${m.id}"><div style="flex:1">
    <h4>${MEM_KIND[m.kind] ?? ''} <span class="pill ${MEM_PILL[m.status] ?? ''}">${esc(m.status)}</span> ${esc(m.title)}
      <span class="meta">${esc(m.kind)} · ${esc(m.item ? `item ${m.item}` : m.product ?? 'studio-wide')} · ${esc(m.id)}</span></h4>
    ${m.body ? `<div class="summary" style="white-space:pre-wrap">${esc(m.body)}</div>` : ''}
    ${m.quote ? `<div class="meta">J said: “${esc(m.quote)}”</div>` : ''}
    <div class="meta">by ${esc(m.by)} · ${ago(m.created)}${m.source ? ` · from ${esc(m.source)}` : ''}${seen} · used ${m.uses}×${m.last_used ? ` (last ${ago(m.last_used)})` : ''}${m.edited ? ' · edited by J' : ''}${m.note ? ` · ${esc(m.note)}` : ''}</div>
  </div><div class="side"><div class="actions">
    ${m.status !== 'active' ? `<button class="small primary" data-mem-set="${m.id}" data-status="active">Confirm</button>` : ''}
    <button class="small" data-mem-edit="${m.id}">Edit</button>
    ${m.status !== 'faded' ? `<button class="small" data-mem-set="${m.id}" data-status="faded">Fade</button>` : ''}
    <button class="small" data-mem-del="${m.id}">Delete</button>
  </div></div></div>`;
}

async function loadMemoryRuns() {
  const q = $('#memRunsQ').value.trim();
  const r = await api(`/api/memory/runs?${new URLSearchParams({ ...(q ? { q } : {}), ...($('#memProduct').value ? { product: $('#memProduct').value } : {}), limit: '30' })}`);
  $('#memRuns').innerHTML = r.runs.length ? r.runs.map((x) => `<details class="test"><summary><span class="pill">${esc(x.kind)}</span> <span class="name">${esc(x.title)}</span> <span class="detail">${esc(x.product ?? '')} · ${esc(x.outcome ?? '')} · ${ago(x.finished)}</span></summary>
    <pre style="white-space:pre-wrap">${esc(x.summary)}</pre>${x.lessons ? `<div class="meta"><b>Lessons:</b> ${esc(x.lessons)}</div>` : ''}</details>`).join('') : '<div class="meta">No runs found.</div>';
}

$('#memory').addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.memSet) { await api(`/api/memory/${t.dataset.memSet}`, { method: 'PATCH', body: { status: t.dataset.status } }); return loadMemory(); }
    if (t.dataset.memEdit) { memEditing = t.dataset.memEdit; return loadMemory(); }
    if (t.dataset.memCancel !== undefined) { memEditing = null; return loadMemory(); }
    if (t.dataset.memSave) {
      const box = t.closest('[data-mem]');
      const body = Object.fromEntries([...box.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el.value]));
      body.product = body.product.trim() || null;
      await api(`/api/memory/${t.dataset.memSave}`, { method: 'PATCH', body });
      memEditing = null;
      return loadMemory();
    }
    if (t.dataset.memDel) { if (confirm('Delete this entry? (Fade keeps it searchable.)')) { await api(`/api/memory/${t.dataset.memDel}`, { method: 'DELETE' }); loadMemory(); } return; }
    if (t.id === 'memNew') {
      const title = prompt('What should every agent and Talk remember? (one line)');
      if (!title) return;
      const kind = prompt('Kind: decision, preference, convention, lesson, canon or state', 'decision');
      if (!kind) return;
      const body = prompt('The specifics (optional)') ?? '';
      await api('/api/memory', { method: 'POST', body: { kind, title, body, product: $('#memProduct').value || null } });
      return loadMemory();
    }
    if (t.id === 'memRunsGo') return loadMemoryRuns();
  } catch (err) {
    alert(err.message);
  }
});
for (const id of ['#memProduct', '#memKind', '#memStatus']) $(id).addEventListener('change', () => loadMemory());
$('#memQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadMemory(); });
$('#memRunsQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadMemoryRuns(); });

function memRefresh() {
  if (location.hash.slice(1) !== 'memory') return;
  loadMemory().catch((e) => ($('#memList').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  loadMemoryRuns().catch(() => {});
}
document.querySelector('nav button[data-tab="memory"]').addEventListener('click', () => setTimeout(memRefresh, 0));
memRefresh();
