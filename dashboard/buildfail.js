// Build failures where J looks (J, 2026-11-03: "if it's failing, why be in I know it's failing? I don't see fail anywhere
// in studio"). A red "Last build failed" badge for the project's card and the Go live card (the failed step, the reason in
// plain words, how long it ran, the commit, Retry), the attempts at one commit next to Go live's refusal, and the "Why did
// this fail?" view (the log Gen kept, the Gen job, every try). Data from buildfail.ts: /api/overview `buildFailing`, the
// plan's `buildAttempts`, GET /api/projects/<p>/builds/<build row>/why. Redraws come from the push stream's `builds`
// topic (stream.js), never a timer. Uses app.js's helpers ($, esc, api, ago).
var BuildFail = (() => {
  const KIND = { infrastructure: 'Infrastructure, not the code', code: 'The code', unknown: 'Cause unclear' };
  const took = (s) => (s == null ? '' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`);
  const sha = (f) => (f.sha ? f.sha.slice(0, 7) : '');

  /** One plain line: "Last build failed: web 7 (infrastructure) while building, after 12 min · a1b2c3d". */
  const line = (f) => `Last build failed: ${f.build} ${f.version}${f.kind ? ` (${(KIND[f.kind] ?? f.kind).toLowerCase()})` : ''}${f.stepWords ? ` while ${f.stepWords}` : ''}${f.seconds != null ? `, ran ${took(f.seconds)}` : ''}${sha(f) ? ` · ${sha(f)}` : ''}.`;

  /** The red badge; `product` is the project id (Retry and Why call its routes). */
  const badge = (product, f) => `<div class="bf-badge" data-key="bf:${esc(f.id)}" style="border:1px solid var(--red,#c33);border-left-width:4px;border-radius:6px;padding:8px 10px;margin:8px 0;background:rgba(200,50,50,.08)">
    <div><b style="color:var(--red,#c33)">❌ Last build failed</b> · ${esc(f.build)} ${esc(f.version)}${sha(f) ? ` · <code>${esc(sha(f))}</code>` : ''} · ${esc(ago(f.finished ?? f.started))}</div>
    <div class="meta">${esc(KIND[f.kind] ?? 'Cause unclear')}${f.stepWords ? ` · failed while ${esc(f.stepWords)}` : ''}${f.seconds != null ? ` · ran ${esc(took(f.seconds))}` : ''}${f.tries > 1 ? ` · ${f.tries} tries` : ''}</div>
    <div style="margin:4px 0">${esc(f.plain || f.reason)}</div>
    <div class="actions"><button type="button" class="small primary" data-admin data-bf-retry="${esc(product)}/${esc(f.build)}">Build again</button> <button type="button" class="small" data-bf-why="${esc(product)}/${esc(f.id)}">Why did this fail?</button><span class="meta" data-bf-msg></span></div>
  </div>`;

  /** Every attempt at one commit (Go live): result, reason, how long. */
  const attempts = (product, list) => (list ?? []).map((a) => `<div class="bf-attempts" data-key="bfa:${esc(a.build)}:${esc(a.sha)}"><b>Builds of ${esc(a.build)} at <code>${esc(a.sha.slice(0, 7))}</code></b>${a.attempts.length ? `<ul>${a.attempts.map((x) => `<li>${x.status === 'ready' ? '✅' : x.status === 'failed' ? '❌' : '⏳'} ${esc(x.build)} ${esc(x.version)} · ${esc(ago(x.started))}${x.seconds != null ? ` · ${esc(took(x.seconds))}` : ''}${x.status === 'failed' ? ` · ${esc(KIND[x.kind] ?? 'cause unclear')}${x.stepWords ? `, ${esc(x.stepWords)}` : ''}: ${esc(x.plain || x.reason)} <a href="#" data-bf-why="${esc(product)}/${esc(x.id)}">Why?</a>` : x.status === 'building' ? ' · building now' : ''}</li>`).join('')}</ul>` : '<div class="meta">No build has ever run for this commit.</div>'}</div>`).join('');

  async function why(product, id) {
    let dlg = document.getElementById('bfWhy');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'bfWhy'; dlg.style.cssText = 'max-width:900px;width:92vw;border-radius:8px;padding:16px'; document.body.appendChild(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-bf-close]')) dlg.close(); }); }
    dlg.innerHTML = '<div class="meta">Loading…</div>';
    dlg.showModal();
    try {
      const w = await api(`/api/projects/${encodeURIComponent(product)}/builds/${encodeURIComponent(id)}/why`);
      const GENURL = typeof GEN !== 'undefined' ? GEN : '';
      dlg.innerHTML = `<h3>Why did ${esc(w.build)} ${esc(w.version)} fail?</h3>
        <div class="meta">${esc(KIND[w.kind] ?? 'Cause unclear')}${w.stepWords ? ` · failed while ${esc(w.stepWords)}` : ''}${w.seconds != null ? ` · ran ${esc(took(w.seconds))}` : ''}${w.commit ? ` · commit <code>${esc(w.commit.slice(0, 7))}</code>` : ''}${w.class ? ` · class: ${esc(w.class)}` : ''}</div>
        <p>${esc(w.plain || w.reason)}</p>
        <div class="meta"><b>The reason Studio recorded:</b> ${esc(w.reason)}</div>
        ${w.jobs.length ? `<div class="meta"><b>Hawkes Gen jobs tried (${w.jobs.length}):</b><ol>${w.jobs.map((j) => `<li>${window.studioMe?.customer ? esc(j.id) : `<a href="${esc(GENURL)}/#job/${esc(j.id)}" target="_blank" rel="noopener">${esc(j.id)}</a>`}: ${esc(j.error)}</li>`).join('')}</ol></div>` : w.genJob ? `<div class="meta">Gen job: ${esc(w.genJob)}</div>` : ''}
        ${w.log ? `<details open><summary class="meta">The last lines of the build's log (${w.log.split('\n').length})</summary><pre style="max-height:50vh;overflow:auto;font-size:12px;white-space:pre-wrap">${esc(w.log)}</pre></details>` : `<div class="meta">${esc(w.noLog ?? 'No log was kept.')}</div>`}
        <div class="actions"><button type="button" class="small primary" data-admin data-bf-retry="${esc(product)}/${esc(w.build)}">Build again</button> <button type="button" class="small" data-bf-close>Close</button><span class="meta" data-bf-msg></span></div>`;
    } catch (err) {
      dlg.innerHTML = `<div class="meta">${esc(err.message)}</div><div class="actions"><button type="button" class="small" data-bf-close>Close</button></div>`;
    }
  }

  document.addEventListener('click', async (e) => {
    const w = e.target.closest('[data-bf-why]');
    if (w) { e.preventDefault(); const [p, id] = w.dataset.bfWhy.split('/'); return void why(p, id); }
    const h = e.target.closest('a[href^="#build-why/"]');
    if (h) { e.preventDefault(); const [, p, id] = h.getAttribute('href').split('/'); return void why(p, id); }
    const r = e.target.closest('[data-bf-retry]');
    if (r) {
      e.preventDefault();
      const [p, build] = r.dataset.bfRetry.split('/');
      const msg = r.parentElement.querySelector('[data-bf-msg]');
      r.disabled = true;
      try { const s = await api(`/api/projects/${encodeURIComponent(p)}/builds`, { method: 'POST', body: { build } }); if (msg) msg.textContent = s.run ? ' Building: it shows in Activity.' : ` ${s.note ?? ''}`; } catch (err) { if (msg) msg.textContent = ` ${err.message}`; }
      r.disabled = false;
    }
  });
  return { line, badge, attempts, why, took };
})();
