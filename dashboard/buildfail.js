// Build failures where J looks (J, 2026-11-03: "if it's failing, why be in I know it's failing? I don't see fail anywhere
// in studio"). A red "Last build failed" badge for the project's card and the Go live card (the failed step, the reason in
// plain words, how long it ran, the commit, Retry), the attempts at one commit next to Go live's refusal, and the "Why did
// this fail?" view (the log Gen kept, the Gen job, every try). Data from buildfail.ts: /api/overview `buildFailing`, the
// plan's `buildAttempts`, GET /api/projects/<p>/builds/<build row>/why. Redraws come from the push stream's `builds`
// topic (stream.js), never a timer. Uses app.js's helpers ($, esc, api, ago).
var BuildFail = (() => {
  const KIND = { infrastructure: 'Infrastructure, not the code', code: 'The code', unknown: 'Cause unclear' };
  // The cause named by its class where that says more than infrastructure/code (a Gen rejection is neither unclear nor "the machine").
  const kindOf = (f) => (f.class === 'rejected' ? 'Hawkes Gen refused the request' : KIND[f.kind] ?? 'Cause unclear');
  const took = (s) => (s == null ? '' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`);
  const sha = (f) => (f.sha ? f.sha.slice(0, 7) : '');

  /** One plain line: "Last build failed: web 7 (infrastructure) while building, after 12 min · a1b2c3d". */
  const line = (f) => `Last build failed: ${f.build} ${f.version}${f.kind ? ` (${kindOf(f).toLowerCase()})` : ''}${f.stepWords ? ` while ${f.stepWords}` : ''}${f.seconds != null ? `, ran ${took(f.seconds)}` : ''}${sha(f) ? ` · ${sha(f)}` : ''}.`;

  /** The red badge; `product` is the project id (Retry and Why call its routes). */
  const badge = (product, f) => `<div class="bf-badge" data-key="bf:${esc(f.id)}" style="border:1px solid var(--red,#c33);border-left-width:4px;border-radius:6px;padding:8px 10px;margin:8px 0;background:rgba(200,50,50,.08)">
    <div><b style="color:var(--red,#c33)">❌ Last build failed</b> · ${esc(f.build)} ${esc(f.version)}${sha(f) ? ` · <code>${esc(sha(f))}</code>` : ''} · ${esc(ago(f.finished ?? f.started))}</div>
    <div class="meta">${esc(kindOf(f))}${f.stepWords ? ` · failed while ${esc(f.stepWords)}` : ''}${f.seconds != null ? ` · ran ${esc(took(f.seconds))}` : ''}${f.tries > 1 ? ` · ${f.tries} tries` : ''}</div>
    <div style="margin:4px 0">${esc(f.plain || f.reason)}</div>
    <div class="actions"><button type="button" class="small primary" data-admin data-bf-retry="${esc(product)}/${esc(f.build)}">Retry build</button> <button type="button" class="small" data-bf-why="${esc(product)}/${esc(f.id)}">Why did this fail?</button><span class="meta" data-bf-msg></span></div>
  </div>`;

  /** A build that is starting or running: shown at once when Build is pressed, in place of the red badge (the push stream redraws it). */
  const running = (product, r) => `<div class="bf-running" data-key="bfr:${esc(r.build)}" style="border:1px solid var(--accent,#48c);border-left-width:4px;border-radius:6px;padding:8px 10px;margin:8px 0" role="status" aria-live="polite">
    <div><b>⏳ ${r.state === 'starting' ? 'Starting' : 'Building'} ${esc(r.build)}${r.version != null ? ` ${esc(r.version)}` : ''}</b> · started ${esc(ago(r.started))} (${esc(took(Math.max(0, Math.round((Date.now() - r.started) / 1000))))} so far)${r.step ? ` · ${esc(String(r.step).slice(0, 160))}` : ''}</div>
    <div class="meta">It shows here as done or failed when it ends; the run is in Activity.</div></div>`;

  /** A build that finished well lately: version, commit, when (green, so the three states read at a glance). */
  const done = (product, d) => `<div class="bf-done" data-key="bfd:${esc(d.build)}" role="status" style="border:1px solid var(--green,#2a8);border-left-width:4px;border-radius:6px;padding:8px 10px;margin:8px 0">
    <div><b>✅ Built ${esc(d.build)} ${esc(d.version)}</b>${sha(d) ? ` · <code>${esc(sha(d))}</code>` : ''} · ${esc(ago(d.finished))}${d.seconds != null ? ` · took ${esc(took(d.seconds))}` : ''}${d.url ? ` · <a href="${esc(d.url)}" target="_blank" rel="noopener">Play ↗</a>` : ''}</div></div>`;

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
        <div class="meta">${esc(kindOf(w))}${w.stepWords ? ` · failed while ${esc(w.stepWords)}` : ''}${w.seconds != null ? ` · ran ${esc(took(w.seconds))}` : ''}${w.commit ? ` · commit <code>${esc(w.commit.slice(0, 7))}</code>` : ''}${w.class ? ` · class: ${esc(w.class)}` : ''}</div>
        <p>${esc(w.plain || w.reason)}</p>
        <div class="meta"><b>The reason Studio recorded:</b> ${esc(w.reason)}</div>
        ${w.jobs.length ? `<div class="meta"><b>Hawkes Gen jobs tried (${w.jobs.length}):</b><ol>${w.jobs.map((j) => `<li>${window.studioMe?.customer ? esc(j.id) : `<a href="${esc(GENURL)}/#job/${esc(j.id)}" target="_blank" rel="noopener">${esc(j.id)}</a>`}: ${esc(j.error)}</li>`).join('')}</ol></div>` : w.genJob ? `<div class="meta">Gen job: ${esc(w.genJob)}</div>` : ''}
        ${w.log ? `<details open><summary class="meta">The last lines of the build's log (${w.log.split('\n').length})</summary><pre style="max-height:50vh;overflow:auto;font-size:12px;white-space:pre-wrap">${esc(w.log)}</pre></details>` : `<div class="meta">${esc(w.noLog ?? 'No log was kept.')}</div>`}
        <div class="actions"><button type="button" class="small primary" data-admin data-bf-retry="${esc(product)}/${esc(w.build)}">Retry build</button> <button type="button" class="small" data-bf-close>Close</button><span class="meta" data-bf-msg></span></div>`;
    } catch (err) {
      dlg.innerHTML = `<div class="meta">${esc(err.message)}</div><div class="actions"><button type="button" class="small" data-bf-close>Close</button></div>`;
    }
  }

  /**
   * The build page (Activity's build rows, the Runs tab): one build run, its builds and their log, asked of Hawkes Gen when
   * it opens and on Refresh (GET /api/runs/<run>/build); the push stream's `builds` topic refetches it too, never a timer.
   */
  let pageRun = null;
  const pageHtml = (d) => {
    const blocks = d.builds.map((b) => {
      const p = b.progress;
      const idle = p && p.unchangedSeconds != null ? took(p.unchangedSeconds) : null;
      const verdict = !p ? '' : p.verdict === 'building' ? '🟢 Building: the log moved' : p.verdict === 'maybe stuck' ? '🟠 Maybe stuck: the log has not moved' : '⚪ Cannot tell yet (Studio has seen the log once)';
      return `<div class="bf-page-build" data-key="bfp:${esc(b.build)}" style="border:1px solid var(--line,#8884);border-radius:6px;padding:8px 10px;margin:8px 0">
        <div><b>${b.state === 'failed' ? '❌' : b.state === 'ready' ? '✅' : b.state === 'cancelled' ? '🚫' : '⏳'} ${esc(b.build)}${b.version != null ? ` ${esc(b.version)}` : ''}</b> · ${esc(b.state)}${b.elapsedSeconds != null ? ` · ${esc(took(b.elapsedSeconds))}${b.state === 'building' ? ' so far' : ''}` : ''}${b.started ? ` · started ${esc(ago(b.started))}` : ''}</div>
        <div class="meta">${b.sha ? `commit <code>${esc(b.sha.slice(0, 7))}</code>` : 'no commit yet'}${b.ref ? ` · ${esc(b.ref)}` : ''}${b.genJob ? ` · Gen job ${window.studioMe?.customer ? esc(b.genJob) : `<a href="${esc(typeof GEN !== 'undefined' ? GEN : '')}/#job/${esc(b.genJob)}" target="_blank" rel="noopener">${esc(b.genJob)}</a>`}${b.genStatus ? ` (${esc(b.genStatus)})` : ''}` : ''}${b.url ? ` · <a href="${esc(b.url)}" target="_blank" rel="noopener">Play ↗</a>` : ''}</div>
        ${b.step || b.genDetail ? `<div class="meta">Step: ${esc(b.genDetail || b.step)}</div>` : ''}
        ${b.failure ? `<p>${esc(b.failure.plain || b.failure.reason)}</p>` : ''}
        ${p ? `<div role="status"><b>${esc(verdict)}</b>${p.lastLine ? ` · last line${idle ? ` (unchanged for ${esc(idle)})` : ''}: <code>${esc(p.lastLine.slice(0, 200))}</code>` : ' · no log lines yet'}<div class="meta">${p.lines} log lines · Studio has watched this log for ${esc(took(p.watchedSeconds))} (Gen's lines carry no time, so the age counts from when Studio saw the line change)</div></div>` : ''}
        ${b.log ? `<details open><summary class="meta">${esc(b.log.source)} · last ${b.log.text.split('\n').length} of ${b.log.total} lines</summary><pre data-bf-log style="max-height:50vh;overflow:auto;font-size:12px;white-space:pre-wrap">${esc(b.log.text)}</pre></details>` : `<div class="meta">${esc(b.logError ?? (b.state === 'starting' ? 'Not started yet: waiting its turn.' : 'No log yet.'))}</div>`}
      </div>`;
    }).join('');
    return `<h3>Build ${esc(d.run.product)} · ${esc(d.run.status)}</h3><div class="meta">${esc(d.run.id)}${d.run.detail ? ` · ${esc(d.run.detail)}` : ''} · started ${esc(ago(d.run.started))}</div>${blocks || '<div class="meta">This run has no builds.</div>'}
      <div class="actions"><button type="button" class="small primary" data-bf-page-refresh>Refresh</button> <button type="button" class="small" data-bf-close>Close</button><span class="meta" data-bf-msg></span></div>`;
  };
  async function page(run) {
    let dlg = document.getElementById('bfWhy');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'bfWhy'; dlg.style.cssText = 'max-width:900px;width:92vw;border-radius:8px;padding:16px'; document.body.appendChild(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-bf-close]')) dlg.close(); }); }
    pageRun = run;
    dlg.addEventListener('close', () => { if (pageRun === run) pageRun = null; }, { once: true });
    if (!dlg.open) { dlg.innerHTML = '<div class="meta">Loading…</div>'; dlg.showModal(); }
    try {
      const d = await api(`/api/runs/${encodeURIComponent(run)}/build`);
      studioPatch(dlg, pageHtml(d));
    } catch (err) {
      dlg.innerHTML = `<div class="meta">${esc(err.message)}</div><div class="actions"><button type="button" class="small" data-bf-close>Close</button></div>`;
    }
  }
  studioStream.on(['builds', 'runs'], () => { if (pageRun) void page(pageRun); });

  document.addEventListener('click', async (e) => {
    const bp = e.target.closest('[data-build-open]');
    if (bp) { e.preventDefault(); e.stopPropagation(); return void page(bp.dataset.buildOpen); }
    if (e.target.closest('[data-bf-page-refresh]') && pageRun) { e.preventDefault(); return void page(pageRun); }
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
      r.textContent = 'Starting…';
      try { const s = await api(`/api/projects/${encodeURIComponent(p)}/builds`, { method: 'POST', body: { build } }); if (msg) msg.textContent = s.run ? ' Building: it shows in Activity.' : ` ${s.note ?? ''}`; } catch (err) { if (msg) msg.textContent = ` ${err.message}`; r.disabled = false; r.textContent = 'Retry build'; }
    }
  });
  return { line, badge, running, done, attempts, why, page, took };
})();
