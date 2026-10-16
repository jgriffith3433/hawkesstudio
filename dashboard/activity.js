// Activity: everything running in the background (Studio's /api/activity): agent changes, Studio runs with their
// current step, Hawkes Gen jobs, Talk answers in progress, and what finished in the last 15 minutes. A drawer on the
// right, opened from the header's Activity button (its badge counts what's running); on a wide screen it sits beside
// Talk. Polled every 3 s while open, every 10 s for the badge. Loaded after app.js (uses its api, esc, show, ago).

// An agent change's stages (coding → building → playtesting → review → ready; Studio and Gen: coding → checks →
// ready), each todo, now, done or failed, from the change's status and its `stage` facts (src/activity.ts stageOf).
// Pure, so it is tested without a DOM (test/activity.test.ts).
var ChangeStages = (() => {
  const names = (s) => (s.infra ? ['coding', 'checks', 'ready'] : s.unity ? ['coding', 'building', 'playtesting', 'review', 'ready'] : ['coding', 'playtesting', 'review', 'ready']);
  /** The stage a step of the work (agents.ts Phase) is in. */
  function stageAt(s) {
    if (!s.step || ['prepare', 'agent', 'publish'].includes(s.step)) return 'coding';
    if (s.infra) return 'checks';
    if (s.step === 'finish' || s.jobs?.review) return 'review';
    if (s.jobs?.playtest || !s.unity) return 'playtesting';
    return 'building';
  }
  /** A ready change whose verification didn't get through: the stage that stopped it. */
  function stoppedAt(s) {
    if (s.infra) return s.outcome === 'failed' ? 'checks' : null;
    if (s.outcome === 'build failed') return s.unity ? 'building' : 'playtesting';
    return s.outcome === 'failed' ? 'playtesting' : null;
  }
  function stages(status, s = {}) {
    const list = names(s);
    const row = (at, how, after = 'todo') => {
      const i = list.indexOf(at);
      return list.map((name, k) => ({ name, state: k < i ? 'done' : k === i ? how : after }));
    };
    if (status === 'merged') return list.map((name) => ({ name, state: 'done' }));
    if (status === 'queued' || status === 'closed') return list.map((name) => ({ name, state: 'todo' }));
    if (status === 'failed') return row(s.failed ? stageAt(s) : 'coding', 'failed');
    if (status === 'ready') {
      const stop = stoppedAt(s);
      if (!stop) return row('ready', 'now');
      return row(stop, 'failed').map((x) => (x.name === 'ready' ? { ...x, state: 'now' } : x));
    }
    // working, revising, verifying, needs answer
    return row(status === 'verifying' && !s.step ? (s.infra ? 'checks' : s.unity ? 'building' : 'playtesting') : stageAt(s), 'now');
  }
  return { stages, stageAt };
})();

if (typeof document !== 'undefined') (() => {
  const el = (s) => document.querySelector(s);
  const KEY = 'studio.activity';
  const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const remember = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };
  // Open by default on a wide screen (beside Talk); J's choice sticks. On a phone it covers the page: closed at first.
  let open = matchMedia('(max-width: 760px)').matches ? false : remembered() ? remembered() === 'open' : matchMedia('(min-width: 1200px)').matches;
  let timer = null;
  let last = null;

  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const since = (t) => (t ? dur(Date.now() - t) : '');
  const ICON = { queued: '⏳', working: '🛠️', verifying: '🎮', revising: '🛠️', ready: '👀', merged: '✅', failed: '❌', closed: '🗑️', done: '✅', running: '⏳', interrupted: '⚠️' };
  const link = (href, text, ext = true) => `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
  const by = (x) => (x.origin ? `<a href="?conversation=${esc(x.origin)}#talk" data-talk="${esc(x.origin)}">${esc(x.by)}</a>` : esc(x.by));

  const stagesHtml = (c) => `<div class="act-stages">${ChangeStages.stages(c.status, c.stage ?? {})
    .map((x) => `<span class="stg ${x.state}" title="${esc(`${x.name}: ${x.state}`)}">${x.state === 'done' ? '✓ ' : x.state === 'failed' ? '✗ ' : ''}${esc(x.name)}</span>`).join('<span class="stg-arrow">›</span>')}</div>`;

  function changeHtml(c, done = false) {
    return `<div class="act-item">
      <div class="act-top">${ICON[c.status] ?? '•'} <b>${esc(c.productName)}</b> <span class="pill ${c.status === 'ready' ? 'ship' : c.status === 'failed' ? 'failed' : ''}">${esc(c.status)}</span><span class="act-time">${done ? `${ago(c.at)}` : since(c.started)}</span></div>
      <div class="act-title">${esc(c.title)}</div>
      ${stagesHtml(c)}
      ${c.detail ? `<div class="act-now">${esc(c.detail)}</div>` : ''}
      <div class="meta">by ${by(c)} · <a href="#changes/${esc(c.id)}" data-change-log="${esc(c.id)}">log</a>${c.pr ? ` · ${link(c.pr, 'PR')}` : ''}${c.preview ? ` · ${link(c.preview, 'preview')}` : ''}${c.cost ? ` · $${c.cost.toFixed(2)}` : ''}</div>
      ${!done && c.log?.length ? `<details class="act-log"><summary class="meta">last log lines</summary><pre>${esc(c.log.join('\n'))}</pre></details>` : ''}
    </div>`;
  }
  function runHtml(r, done = false) {
    return `<div class="act-item">
      <div class="act-top">${ICON[r.status] ?? '•'} <b>${esc(r.kind)}${r.where === 'live' ? ' (live)' : ''}</b> ${esc(r.products.join(', '))}<span class="act-time">${done ? ago(r.at) : since(r.started)}</span></div>
      <div class="act-now">${esc(r.detail ?? '')}${r.steps.total ? ` · ${r.steps.done}/${r.steps.total} steps${r.steps.failed ? `, ${r.steps.failed} failed` : ''}` : ''}</div>
      ${(r.now ?? []).map((s) => `<div class="act-step">▸ ${esc(s.kind)} ${esc(s.name)}${s.detail ? `: ${esc(s.detail)}` : ''} <span class="meta">${since(s.started)}${s.job ? ` · ${link(`${GEN}/#job/${s.job}`, 'job')}` : ''}</span></div>`).join('')}
      <div class="meta">by ${by(r)} · <a href="#" data-run-open="${esc(r.id)}">${esc(r.id)}</a>${r.cost ? ` · $${r.cost.toFixed(2)}` : ''}</div>
    </div>`;
  }
  const jobHtml = (j) => `<div class="act-item">
      <div class="act-top">${ICON[j.status] ?? '•'} <b>${esc(j.tool)}</b> ${esc(j.project)} <span class="pill">${esc(j.status)}</span><span class="act-time">${since(j.started ?? j.created)}</span></div>
      ${j.detail ? `<div class="act-now">${esc(j.detail)}</div>` : ''}
      <div class="meta">${link(j.link, esc(j.id))}${j.server ? ` · ${esc(j.server)}` : ''}</div>
    </div>`;
  const section = (title, n, html) => `<h4>${title} <span class="meta">${n}</span></h4>${html || '<div class="meta act-none">nothing</div>'}`;

  /** A background operation (going live, a rollback, a merge): its step, how long, its last log lines. */
  function opHtml(o) {
    const icon = { queued: '⏳', running: '🚀', done: '✅', failed: '❌' }[o.status] ?? '•';
    const secs = o.seconds ?? 0;
    const took = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    const state = o.status === 'queued' ? 'queued' : o.status === 'running' ? `${o.stuck ? '⚠ taking much longer than usual · ' : ''}${took}` : `${o.status} after ${took}`;
    const log = (o.log ?? []).slice(-8).map((l) => esc(l)).join('\n');
    return `<div class="act-item${o.stuck || o.status === 'failed' ? ' act-warn' : ''}"><div class="act-top">${icon} <b>${esc(o.title)}</b><span class="act-time">${esc(state)}</span></div><div class="act-now">${esc(o.status === 'failed' ? o.error ?? '' : o.step ?? '')}${o.by ? ` · by ${esc(o.by)}` : ''}${o.attempts > 1 ? ` · attempt ${o.attempts}` : ''}</div>${log ? `<details class="act-log"><summary class="meta">log</summary><pre>${log}</pre></details>` : ''}</div>`;
  }

  function render(a) {
    const badge = el('#actCount');
    badge.textContent = a.count;
    badge.classList.toggle('zero', !a.count);
    if (!open) return;
    const blocks = a.loop?.blocks ?? [];
    el('#actBody').innerHTML = [
      blocks.length ? `<div class="act-item act-warn"><div class="act-top">⚠ <b>Studio froze ${blocks.length} time(s) in the last hour</b></div><div class="act-now">${blocks.slice(0, 3).map((b) => `${new Date(b.at).toLocaleTimeString()}: ${(b.ms / 1000).toFixed(1)} s${b.running.length ? ` (during ${esc(b.running.join('; ').slice(0, 160))})` : ''}`).join('<br>')}</div></div>` : '',
      (a.ops?.length || a.opsDone?.length) ? section('Going live, rollbacks, merges', a.ops.length, a.ops.map(opHtml).join('') + (a.opsDone.length ? `<details class="act-recent"><summary class="meta">finished today (${a.opsDone.length})</summary>${a.opsDone.map(opHtml).join('')}</details>` : '')) : '',
      section('Agents', a.changes.length, a.changes.map((c) => changeHtml(c)).join('')),
      section('Studio runs', a.runs.length, a.runs.map((r) => runHtml(r)).join('')),
      section('Hawkes Gen jobs', a.gen ? a.jobs.length : '(unreachable)', a.jobs.map(jobHtml).join('')),
      a.commands?.length ? section('Commands running now', a.commands.length, a.commands.map((c) => `<div class="act-item${c.slow ? ' act-warn' : ''}"><div class="act-top"><code>${esc(c.cmd.slice(0, 90))}</code><span class="act-time">${c.seconds} s</span></div><div class="act-now">${esc(c.cwd.split(/[\/]/).pop())}</div></div>`).join('')) : '',
      a.talk.length ? section('Talk', a.talk.length, a.talk.map((t) => `<div class="act-item"><div class="act-top">💬 <a href="?conversation=${esc(t.id)}#talk" data-talk="${esc(t.id)}">${esc(t.title ?? 'New conversation')}</a><span class="act-time">${since(t.since)}</span></div><div class="act-now">${t.auto ? 'Claude is explaining results Studio brought back' : 'Claude is answering'}</div></div>`).join('')) : '',
      a.recent.length ? `<details class="act-recent" ${el('.act-recent')?.open !== false ? 'open' : ''}><summary><b>Finished in the last 15 min</b> <span class="meta">${a.recent.length}</span></summary>${a.recent.map((x) => (x.type === 'change' ? changeHtml(x, true) : runHtml(x, true))).join('')}</details>` : '',
    ].join('');
    el('#actUpdated').textContent = `updated ${new Date(a.at).toLocaleTimeString()}`;
  }

  async function tick() {
    clearTimeout(timer);
    try {
      if (!document.hidden) {
        // Keep open <details> open across redraws.
        const kept = new Set([...document.querySelectorAll('#actBody .act-log[open]')].map((d) => d.closest('.act-item')?.querySelector('[data-change-log]')?.dataset.changeLog));
        last = await api('/api/activity');
        render(last);
        for (const d of document.querySelectorAll('#actBody .act-log')) if (kept.has(d.closest('.act-item')?.querySelector('[data-change-log]')?.dataset.changeLog)) d.open = true;
      }
    } catch (e) {
      if (open) el('#actUpdated').textContent = `couldn't update: ${e.message}`;
    }
    timer = setTimeout(tick, open ? 3000 : 10000);
  }

  function setOpen(v, { keep = true } = {}) {
    open = v;
    if (keep) remember(v ? 'open' : 'closed');
    el('#activity').hidden = !v;
    document.body.classList.toggle('act-open', v);
    el('#actBtn').classList.toggle('on', v);
    if (v && last) render(last);
    tick();
  }

  el('#actBtn').addEventListener('click', () => setOpen(!open));
  el('#actClose').addEventListener('click', () => setOpen(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  el('#activity').addEventListener('click', (e) => {
    const t = e.target.closest('[data-talk]');
    if (t && !(e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); window.openTalk?.(t.dataset.talk); }
    const c = e.target.closest('[data-change-log]');
    if (c && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      $('#chStatus').value = '';
      loadChanges.sig = null;
      show('changes', c.dataset.changeLog);
    }
    const r = e.target.closest('[data-run-open]');
    if (r) { e.preventDefault(); openRun = r.dataset.runOpen; show('runs'); }
    // On a phone the drawer covers the page: following a link closes it.
    if ((t || c || r) && matchMedia('(max-width: 760px)').matches) setOpen(false, { keep: false });
  });
  setOpen(open, { keep: false });
})();
