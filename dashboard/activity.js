// Activity: everything running in the background (Studio's /api/activity): agent changes, Studio runs with their
// current step, Hawkes Gen jobs, Talk answers in progress, and what finished in the last 15 minutes. A drawer on the
// right, opened from the header's Activity button (its badge counts what's running); on a wide screen it sits beside
// Talk. The push stream (stream.js) says when it changed, with the badge's count: the drawer is fetched only while
// open, and redrawn only when what came back is different. Loaded after app.js (uses its api, esc, show, ago).

// An agent change's stages (coding → building → playtesting → review → ready; Studio and Gen: coding → checks →
// ready), each todo, now, done or failed, from the change's status and its `stage` facts (src/activity.ts stageOf),
// and the thin progress bar under them (also on the Changes tab's cards).
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
    if (status === 'queued' || status === 'closed' || status === 'cancelled') return list.map((name) => ({ name, state: 'todo' }));
    if (status === 'failed') return row(s.failed ? stageAt(s) : 'coding', 'failed');
    if (status === 'ready') {
      const stop = stoppedAt(s);
      if (!stop) return row('ready', 'now');
      return row(stop, 'failed').map((x) => (x.name === 'ready' ? { ...x, state: 'now' } : x));
    }
    // working, revising, verifying, needs answer
    return row(status === 'verifying' && !s.step ? (s.infra ? 'checks' : s.unity ? 'building' : 'playtesting') : stageAt(s), 'now');
  }
  /** About how long an agent's coding takes: the bar creeps towards the end of the coding stage over it, never past. */
  const TYPICAL_CODING_MS = 20 * 60_000;
  /**
   * How far along the change is, for the thin bar under its stages: 0-100 by stage (each stage before ready an equal
   * part), creeping within coding by the time this pass has run (`since`) against a typical run; full and green when
   * ready or merged, red where a failed change stopped.
   */
  function progress(status, s = {}, now = Date.now()) {
    const row = stages(status, s);
    if (status === 'ready' || status === 'merged') return { pct: 100, state: 'ready', stage: 'ready' };
    if (status === 'queued' || status === 'closed' || status === 'cancelled') return { pct: 0, state: 'todo', stage: row[0].name };
    const i = Math.max(0, row.findIndex((x) => x.state === 'now' || x.state === 'failed'));
    const name = row[i].name;
    let within = 0.5;
    if (status !== 'failed' && name === 'coding') {
      within = s.step === 'publish' ? 0.95 : typeof s.since === 'number' ? 0.9 * (1 - Math.exp(-Math.max(0, now - s.since) / TYPICAL_CODING_MS)) : 0;
    }
    const pct = Math.min(99, Math.max(2, Math.round((100 * (i + within)) / (row.length - 1))));
    return { pct, state: status === 'failed' ? 'failed' : 'now', stage: name };
  }
  /** The bar itself (numbers and stage names only, so nothing to escape). */
  function barHtml(status, s = {}, now = Date.now()) {
    const p = progress(status, s, now);
    const what = p.state === 'ready' ? 'ready' : p.state === 'failed' ? `stopped at ${p.stage}` : p.state === 'todo' ? 'not started' : p.stage;
    return `<div class="act-bar ${p.state}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.pct}" title="${p.pct}% · ${what}"><span style="width:${p.pct}%"></span></div>`;
  }
  return { stages, stageAt, progress, barHtml };
})();

// A playtest's screenshots as a choppy video in an expanded run card (frames from src/frames.ts, GET /api/frames/<step>):
// the rules of the player, pure so they are tested without a DOM (test/activity.test.ts). The DOM part is below.
var FramePlayer = (() => {
  /** About 3 frames a second. */
  const FRAME_MS = 350;
  /** New frames added to the ones the player has, by their number, in order. */
  function merge(have, more) {
    const by = new Map(have.map((f) => [f.i, f]));
    for (const f of more ?? []) by.set(f.i, f);
    return [...by.values()].sort((a, b) => a.i - b.i);
  }
  /**
   * One tick of the player { idx, playing, follow, running } over n frames: following (live) shows the newest; playing
   * steps on and, at the end, follows a running playtest or stops on a finished one.
   */
  function advance(p, n) {
    if (!n) return { ...p, idx: 0 };
    if (p.follow) return { ...p, idx: n - 1, playing: false };
    if (!p.playing) return { ...p, idx: Math.min(p.idx, n - 1) };
    if (p.idx < n - 1) return { ...p, idx: p.idx + 1 };
    return p.running ? { ...p, idx: n - 1, playing: false, follow: true } : { ...p, idx: n - 1, playing: false };
  }
  /** "1:05" from seconds. */
  const clock = (t) => (typeof t === 'number' ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '');
  /** What a frame says under it: the bot's progress line while following a running playtest, else why it was taken. */
  function caption(f, p, progress) {
    if (!f) return '';
    if (p.follow && p.running && progress) return progress;
    return f.caption || [f.reason, f.scene, f.peer].filter(Boolean).join(' · ');
  }
  return { FRAME_MS, merge, advance, clock, caption };
})();

if (typeof document !== 'undefined') (() => {
  const el = (s) => document.querySelector(s);
  const KEY = 'studio.activity';
  const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const remember = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };
  // Open by default on a wide screen (beside Talk); J's choice sticks. On a phone it covers the page: closed at first.
  let open = matchMedia('(max-width: 760px)').matches ? false : remembered() ? remembered() === 'open' : matchMedia('(min-width: 1200px)').matches;
  let last = null;
  let showDismissed = false; // "Show dismissed": finished scouts J tucked away (or older failed ones), fetched when asked and on each stream event while on
  let hiddenScouts = [];
  let drawn = ''; // what the drawer shows (redrawn only when the payload changed)

  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const since = (t) => (t ? dur(Date.now() - t) : '');
  const ICON = { queued: '⏳', working: '🛠️', verifying: '🎮', revising: '🛠️', ready: '👀', merged: '✅', failed: '❌', closed: '🗑️', done: '✅', running: '⏳', interrupted: '⚠️', skipped: '⏭️', cancelled: '🚫', partial: '◐' };
  const link = (href, text, ext = true) => `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
  const by = (x) => (x.origin ? `<a href="?conversation=${esc(x.origin)}#talk" data-talk="${esc(x.origin)}">${esc(x.by)}</a>` : esc(x.by));

  const stagesHtml = (c) => `<div class="act-stages">${ChangeStages.stages(c.status, c.stage ?? {})
    .map((x) => `<span class="stg ${x.state}" title="${esc(`${x.name}: ${x.state}`)}">${x.state === 'done' ? '✓ ' : x.state === 'failed' ? '✗ ' : ''}${esc(x.name)}</span>`).join('<span class="stg-arrow">›</span>')}</div>${ChangeStages.barHtml(c.status, c.stage ?? {})}`;

  function changeHtml(c, done = false) {
    const brain = c.harness_label || c.harness
      ? ` <span class="pill" title="${esc([c.role, c.harness_label || c.harness, c.model].filter(Boolean).join(' · '))}">${esc(c.harness_label || c.harness)}${c.model ? ` · ${esc(c.model)}` : ''}</span>`
      : '';
    return `<div class="act-item" data-key="c:${esc(c.id)}${done ? ':done' : ''}">
      <div class="act-top">${ICON[c.status] ?? '•'} <b>${esc(c.productName)}</b> <span class="pill ${c.status === 'ready' ? 'ship' : c.status === 'failed' ? 'failed' : ''}">${esc(c.status)}</span>${brain}<span class="act-time">${done ? `${ago(c.at)}` : since(c.started)}</span></div>
      <div class="act-title">${esc(c.title)}</div>
      ${stagesHtml(c)}
      ${c.detail ? `<div class="act-now">${esc(c.detail)}</div>` : ''}
      <div class="meta">by ${by(c)} · <a href="#changes/${esc(c.id)}" data-change-log="${esc(c.id)}">log</a>${c.pr ? ` · ${link(c.pr, 'PR')}` : ''}${c.preview ? ` · ${link(c.preview, 'preview')}` : ''}${c.cost ? ` · $${c.cost.toFixed(2)}` : ''}</div>
      ${!done && c.log?.length ? `<details class="act-log"><summary class="meta">last log lines</summary><pre>${esc(c.log.join('\n'))}</pre></details>` : ''}
      ${c.status === 'cancelled'
        ? `<div class="act-actions"><button class="small" data-act-cancel="resume" data-kind="changes" data-id="${esc(c.id)}">Resume</button> <button class="small" data-act-cancel="close" data-kind="changes" data-id="${esc(c.id)}">Close</button></div>`
        : ['queued', 'working', 'verifying', 'revising', 'needs answer', 'waiting on Gen'].includes(c.status)
          ? `<div class="act-actions"><button class="small" data-act-cancel="cancel" data-kind="changes" data-id="${esc(c.id)}" data-what="this agent (its branch and worktree are kept; Resume or Close it afterwards; it is not a failed try)">Cancel</button></div>` : ''}
    </div>`;
  }
  /** A scout: the question, product, status, elapsed time, live progress (turns, last steps), cost, origin; the report opens in place. Cancel / Re-run / Ask follow-up like an agent's controls. */
  function scoutHtml(x) {
    const running = x.status === 'running';
    const t = running ? since(x.started) : dur((x.finished ?? x.started) - x.started);
    const warn = x.status === 'failed';
    const act = running
      ? `<button class="small" data-act-cancel="cancel" data-kind="scouts" data-id="${esc(x.id)}" data-what="this scout (what it has written so far is kept as a partial report; it is not a failure)">Cancel</button>`
      : `<button class="small" data-act-cancel="resume" data-kind="scouts" data-id="${esc(x.id)}">Re-run</button> <button class="small" data-scout-ask="${esc(x.id)}">Ask a follow-up</button> ${x.dismissed ? `<button class="small" data-scout-dismiss="restore" data-id="${esc(x.id)}">Show again</button>` : `<button class="small" data-scout-dismiss="dismiss" data-id="${esc(x.id)}" title="Hide this from Activity (its report and cost are kept)" aria-label="Dismiss">×</button>`}`;
    return `<div class="act-item${warn ? ' act-warn' : ''}" data-key="x:${esc(x.id)}">
      <div class="act-top">${ICON[x.status] ?? '•'} 🔎 <b>${esc(x.productName)}</b> <span class="pill ${warn ? 'failed' : x.status === 'done' ? 'ship' : ''}">${esc(x.status)}</span>${x.model ? ` <span class="pill">${esc(x.model)}</span>` : ''}<span class="act-time">${esc(t)}</span></div>
      <div class="act-title">${esc(x.question)}</div>
      ${x.detail ? `<div class="act-now">${esc(x.detail)}</div>` : ''}
      <div class="meta">scout ${esc(x.id)} · by ${by(x)}${x.turns ? ` · ${x.turns} turns` : ''}${x.cost ? ` · $${x.cost.toFixed(2)}` : running ? ' · cost shows when it reports' : ''}${x.retryOf ? ` · re-run of ${esc(x.retryOf)}` : ''}</div>
      ${running && x.log?.length ? `<details class="act-log"><summary class="meta">last steps</summary><pre>${esc(x.log.join('\n'))}</pre></details>` : ''}
      ${x.hasReport ? `<details class="act-log" data-scout-report="${esc(x.id)}"><summary class="meta">report</summary><pre class="scout-report" data-patch-keep style="white-space:pre-wrap">open to read</pre></details>` : ''}
      <div class="act-actions">${act}</div>
    </div>`;
  }
  async function loadScoutReport(d) {
    if (d.dataset.loaded) return;
    d.dataset.loaded = '1';
    const pre = d.querySelector('pre');
    pre.textContent = 'loading…';
    try { pre.textContent = (await api('/api/scouts/' + d.dataset.scoutReport)).report || '(no report)'; } catch (e) { d.dataset.loaded = ''; pre.textContent = `couldn't load: ${e.message}`; }
  }
  // A run's scenarios in order: expected time, state, and the verdict with findings as soon as its review is done.
  const PLAN_ICON = { waiting: '⏳', playing: '▶️', reviewing: '🔎', done: '✅', failed: '❌', skipped: '⏭️', cancelled: '🚫' };
  const mins = (s) => `${Math.max(1, Math.round(s / 60))} min`;
  function planHtml(r) {
    const p = r.plan;
    if (!p) return '';
    const item = (x) => {
      const what = x.verdict ?? (x.state === 'playing' ? 'playing' : x.state === 'reviewing' ? 'Claude is reviewing' : x.state);
      const cls = x.verdict === 'broken' || x.state === 'failed' ? ' act-bad' : '';
      return `<li class="act-plan-item${cls}">${PLAN_ICON[x.state] ?? '•'} <b>${esc(x.productName)}</b> ${esc(x.name)} <span class="meta">~${mins(x.estS)} · ${esc(what)}${x.state === 'failed' && x.detail ? `: ${esc(x.detail.slice(0, 140))}` : ''}</span>${x.findings.length ? `<div class="meta">${x.findings.map((f) => `${esc(f.severity)}: ${esc(f.title)}`).join('<br>')}</div>` : ''}</li>`;
    };
    return `<div class="act-now"><b>${esc(p.line)}</b> <span class="meta">· expected ${p.expectedMin} min in all</span></div>
      <ol class="act-plan">${p.items.map(item).join('')}</ol>
      ${p.notes.map((n) => `<div class="act-step">➕ ${esc(n.text)}</div>`).join('')}`;
  }
  function runHtml(r, done = false) {
    return `<div class="act-item" data-key="r:${esc(r.id)}${done ? ':done' : ''}">
      <div class="act-top">${ICON[r.status] ?? '•'} <b>${esc(r.kind)}${r.where === 'live' ? ' (live)' : ''}</b> ${esc(r.products.join(', '))}<span class="act-time">${done ? ago(r.at) : since(r.started)}</span></div>
      <div class="act-now">${esc(r.detail ?? '')}${r.steps.total ? ` · ${r.steps.done}/${r.steps.total} steps${r.steps.failed ? `, ${r.steps.failed} failed` : ''}` : ''}</div>
      ${planHtml(r)}
      ${(r.now ?? []).map((s) => `<div class="act-step">▸ ${esc(s.kind)} ${esc(s.name)}${s.detail ? `: ${esc(s.detail)}` : ''} <span class="meta">${since(s.started)}${s.job && s.kind === 'playtest' ? ` · ${watch(s.job)}` : ''}${s.job && !window.studioMe?.customer ? ` · ${link(`${GEN}/#job/${s.job}`, 'job')}` : ''}</span>${s.job && ['playtest', 'build'].includes(s.kind) ? ` <button class="small" data-act-cancel="cancel" data-kind="jobs" data-id="${esc(s.job)}" data-what="this ${esc(s.kind)} (its step becomes cancelled, not failed)">Cancel ${esc(s.kind)}</button>` : ''}</div>`).join('')}
      <div class="meta">by ${by(r)} · <a href="#" data-run-open="${esc(r.id)}">${esc(r.id)}</a>${r.cost ? ` · $${r.cost.toFixed(2)}` : ''}</div>
      ${r.status === 'running' ? `<div class="act-actions"><button class="small" data-act-cancel="cancel" data-kind="runs" data-id="${esc(r.id)}" data-what="this whole run (its pending steps stop and its Gen jobs are cancelled)">Cancel run</button></div>` : ''}
      ${r.playtests?.length ? `<details class="act-frames" data-frames-run="${esc(r.id)}"${openRuns.has(r.id) ? ' open' : ''}><summary class="meta">🎞 screenshots · ${r.playtests.length} playtest${r.playtests.length === 1 ? '' : 's'}</summary>${r.playtests.map((p) => `<div class="fr-slot" data-frames="${esc(p.id)}"><div class="meta">${esc(p.product)} · ${esc(p.name)} · ${esc(p.status)}</div></div>`).join('')}</details>` : ''}
    </div>`;
  }

  // ---- the screenshots player (FramePlayer above): one per playtest step, kept across the drawer's redraws.
  const openRuns = new Set(); // run cards J expanded
  const players = new Map(); // step id -> player
  let ticker = null;

  function newPlayer(step) {
    const p = { step, idx: 0, playing: false, follow: true, running: true, live: false, frames: [], progress: null, next: 0, busy: false, error: '', seen: false };
    const box = document.createElement('div');
    box.className = 'fr-player';
    box.innerHTML = `<div class="fr-label meta"></div><div class="fr-view"><img alt="" hidden><div class="fr-empty meta"></div></div>
      <div class="fr-bar"><button type="button" class="fr-play" title="Play / pause">▶</button><input type="range" min="0" max="0" value="0" aria-label="Frame"><span class="fr-time meta"></span><button type="button" class="fr-live" title="Follow the newest frame" hidden>● live</button></div>
      <div class="fr-cap"></div>`;
    p.el = box;
    p.img = box.querySelector('img');
    const range = box.querySelector('input');
    box.querySelector('.fr-play').addEventListener('click', () => {
      if (!p.frames.length) return;
      if (!p.playing && p.idx >= p.frames.length - 1) p.idx = 0;
      p.playing = !p.playing;
      p.follow = false;
      draw(p);
      kick();
    });
    range.addEventListener('input', () => { p.idx = Number(range.value); p.playing = false; p.follow = false; draw(p); });
    box.querySelector('.fr-live').addEventListener('click', () => { p.follow = true; p.playing = false; Object.assign(p, FramePlayer.advance(p, p.frames.length)); draw(p); });
    return p;
  }

  async function fetchFrames(p) {
    p.busy = true;
    try {
      const since = p.live && p.frames.length ? p.frames[p.frames.length - 1].i : null;
      const r = await api(`/api/frames/${encodeURIComponent(p.step)}${since !== null ? `?since=${since}` : ''}`);
      if (r.error) throw new Error(r.error);
      // Gen's live route came (or went): start over from what it has.
      const had = r.live === p.live ? p.frames.length : 0;
      p.frames = FramePlayer.merge(since !== null && r.live === p.live ? p.frames : [], r.frames);
      const wasRunning = p.running;
      p.live = r.live;
      p.running = r.running;
      p.progress = r.progress;
      p.error = '';
      // Opened after it ended (or its screenshots only came at the end): play them from the start. Watched live to
      // its end: stay on the last frame.
      if (!p.running && (!p.seen || wasRunning)) {
        p.follow = false;
        if (!p.seen || !had) { p.idx = 0; p.playing = p.frames.length > 1; }
        else p.idx = p.frames.length - 1;
      }
      p.seen = true;
      p.next = Infinity; // the next look is asked for by the push stream (an 'activity' event), not by a timer
    } catch (e) {
      p.error = `couldn't load the screenshots: ${e.message}`;
      p.next = Infinity;
    }
    p.busy = false;
    draw(p);
  }

  function draw(p) {
    const n = p.frames.length;
    const f = p.frames[Math.min(p.idx, n - 1)];
    const q = (s) => p.el.querySelector(s);
    q('.fr-empty').textContent = n ? '' : p.error || (!p.seen ? 'loading…' : p.running ? (p.live ? "The bot's first screenshot comes in a few seconds." : 'Its screenshots show here when this playtest ends (Hawkes Gen does not stream them yet).') : 'No screenshots in this playtest.');
    q('.fr-empty').hidden = Boolean(n);
    p.img.hidden = !n;
    if (f) {
      const src = f.src ?? file(f.asset);
      if (p.img.dataset.full !== src) { p.img.src = src; p.img.dataset.full = src; }
      const after = p.frames[p.idx + 1];
      if (p.playing && after) new Image().src = after.src ?? file(after.asset); // the next frame ready before its turn
    }
    const range = q('input');
    range.max = String(Math.max(0, n - 1));
    range.value = String(Math.min(p.idx, Math.max(0, n - 1)));
    range.disabled = n < 2;
    q('.fr-play').textContent = p.playing ? '⏸' : '▶';
    q('.fr-play').disabled = n < 2;
    q('.fr-time').textContent = f ? `${FramePlayer.clock(f.t)} · ${Math.min(p.idx, n - 1) + 1}/${n}` : '';
    const live = q('.fr-live');
    live.hidden = !(p.running && p.live);
    live.classList.toggle('on', p.follow);
    q('.fr-cap').textContent = p.error && n ? p.error : FramePlayer.caption(f, p, p.progress);
  }

  /** The players J can see now: in an expanded card of the open drawer, on a visible page. */
  const shown = () => (open && !document.hidden ? [...players.values()].filter((p) => p.el.isConnected && p.el.closest('details')?.open) : []);
  function frameTick() {
    const list = shown();
    if (!list.length) { clearInterval(ticker); ticker = null; return; }
    for (const p of list) {
      if (!p.busy && Date.now() >= p.next) fetchFrames(p);
      const was = `${p.idx}|${p.playing}|${p.follow}`;
      Object.assign(p, FramePlayer.advance(p, p.frames.length));
      if (`${p.idx}|${p.playing}|${p.follow}` !== was) draw(p);
    }
  }
  function kick() {
    if (!ticker && shown().length) { ticker = setInterval(frameTick, FramePlayer.FRAME_MS); frameTick(); }
  }
  /** After a redraw: each expanded card's slots get their players back (made on first sight); gone ones are dropped. */
  function mountPlayers() {
    for (const slot of document.querySelectorAll('#actBody .act-frames[open] .fr-slot')) {
      const id = slot.dataset.frames;
      let p = players.get(id);
      if (!p) { p = newPlayer(id); players.set(id, p); }
      p.el.querySelector('.fr-label').textContent = slot.textContent;
      slot.replaceChildren(p.el);
      draw(p);
    }
    for (const [id, p] of players) if (!p.el.isConnected) players.delete(id);
    kick();
  }
  // A playtest's card opens it big on the Playtests page (live.js): the card is the link.
  const watch = (job) => `<a href="#live/${esc(job)}" data-live-job="${esc(job)}" class="act-watch">▶ Watch live</a>`;
  const jobHtml = (j) => `<div class="act-item${j.tool === 'playtest.run' ? ' act-playtest' : ''}"${j.tool === 'playtest.run' ? ` data-live-job="${esc(j.id)}" title="Watch it on the Playtests page"` : ''}>
      <div class="act-top">${ICON[j.status] ?? '•'} <b>${esc(j.tool)}</b> ${esc(j.project)} <span class="pill">${esc(j.status)}</span><span class="act-time">${since(j.started ?? j.created)}</span></div>
      ${j.detail ? `<div class="act-now">${esc(j.detail)}</div>` : ''}
      <div class="meta">${j.tool === 'playtest.run' && j.status === 'running' ? `${watch(j.id)} · ` : ''}${link(j.link, esc(j.id))}${j.server ? ` · ${esc(j.server)}` : ''}</div>
      <div class="act-actions"><button class="small" data-act-cancel="cancel" data-kind="jobs" data-id="${esc(j.id)}" data-what="this Gen job (${esc(j.tool)})">Cancel</button></div>
    </div>`;
  const section = (title, n, html) => `<h4>${title} <span class="meta">${n}</span></h4>${html || '<div class="meta act-none">nothing</div>'}`;

  /** Under the scouts: Clear failed, and Show dismissed (finished scouts tucked away, still there with their reports and cost). */
  function scoutTools(a) {
    const failed = (a.scouts ?? []).filter((x) => x.status === 'failed').length;
    const hidden = a.hiddenScoutCount ?? 0;
    if (!failed && !hidden && !showDismissed) return '';
    return `<div class="act-actions">${failed ? `<button class="small" data-scout-clear>Clear failed (${failed})</button> ` : ''}`
      + `${hidden || showDismissed ? `<button class="small" data-scout-toggle>${showDismissed ? 'Hide dismissed' : `Show dismissed (${hidden})`}</button>` : ''}</div>`
      + (showDismissed ? (hiddenScouts.length ? hiddenScouts.map(scoutHtml).join('') : '<div class="meta act-none">nothing dismissed</div>') : '');
  }
  async function loadHidden() {
    try { hiddenScouts = showDismissed ? (await api('/api/scouts?dismissed=1')).scouts ?? [] : []; } catch { hiddenScouts = []; }
  }

  /** A background operation (going live, a rollback, a merge): its step, how long, its last log lines. */
  function opHtml(o) {
    const icon = { queued: '⏳', running: '🚀', done: '✅', failed: '❌' }[o.status] ?? '•';
    const secs = o.seconds ?? 0;
    const took = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    const state = o.status === 'queued' ? 'queued' : o.status === 'running' ? `${o.stuck ? '⚠ taking much longer than usual · ' : ''}${took}` : `${o.status} after ${took}`;
    const log = (o.log ?? []).slice(-8).map((l) => esc(l)).join('\n');
    return `<div class="act-item${o.stuck || o.status === 'failed' ? ' act-warn' : ''}"><div class="act-top">${icon} <b>${esc(o.title)}</b><span class="act-time">${esc(state)}</span></div><div class="act-now">${esc(o.status === 'failed' ? o.error ?? '' : o.step ?? '')}${o.by ? ` · by ${esc(o.by)}` : ''}${o.attempts > 1 ? ` · attempt ${o.attempts}` : ''}</div>${log ? `<details class="act-log"><summary class="meta">log</summary><pre>${log}</pre></details>` : ''}</div>`;
  }

  function setCount(n) {
    if (typeof n !== 'number') return;
    const badge = el('#actCount');
    badge.textContent = n;
    badge.classList.toggle('zero', !n);
  }
  /** The payload without what moves on its own (the time of the read, running seconds): src/stream.ts signature. */
  const sig = (a) => JSON.stringify(a, (k, v) => (['at', 'seconds', 'lastMinute', 'slow', 'stuck'].includes(k) ? undefined : v));

  function render(a, force = false) {
    setCount(a.count);
    if (!open) return;
    el('#actUpdated').textContent = `updated ${new Date(a.at).toLocaleTimeString()}`;
    const s = sig(a);
    if (s === drawn && !force) return;
    drawn = s;
    const blocks = a.loop?.blocks ?? [];
    studioPatch(el('#actBody'), [
      blocks.length ? `<div class="act-item act-warn"><div class="act-top">⚠ <b>Studio froze ${blocks.length} time(s) in the last hour</b></div><div class="act-now">${blocks.slice(0, 3).map((b) => `${new Date(b.at).toLocaleTimeString()}: ${(b.ms / 1000).toFixed(1)} s${b.where ? ` ${esc(b.where.slice(0, 200))}` : ''}${b.running.length ? ` (during ${esc(b.running.join('; ').slice(0, 160))})` : ''}`).join('<br>')}</div></div>` : '',
      (a.ops?.length || a.opsDone?.length) ? section('Going live, rollbacks, merges', a.ops.length, a.ops.map(opHtml).join('') + (a.opsDone.length ? `<details class="act-recent"><summary class="meta">finished today (${a.opsDone.length})</summary>${a.opsDone.map(opHtml).join('')}</details>` : '')) : '',
      section('Agents', a.changes.length, a.changes.map((c) => changeHtml(c)).join('')),
      a.cancelled?.length ? section('Cancelled agents (not failed)', a.cancelled.length, a.cancelled.map((c) => changeHtml(c)).join('')) : '',
      section('Studio runs and scouts', a.runs.length + (a.scouts ?? []).length, [...a.runs.map((r) => ({ t: r.started, h: runHtml(r) })), ...(a.scouts ?? []).map((x) => ({ t: x.started, h: scoutHtml(x) }))].sort((p, q) => p.t - q.t).map((i) => i.h).join('')
        + scoutTools(a)),
      section('Hawkes Gen jobs', a.gen ? a.jobs.length : '(unreachable)', a.jobs.map(jobHtml).join('')),
      a.commands?.length ? section('Commands running now', a.commands.length, a.commands.map((c) => `<div class="act-item${c.slow ? ' act-warn' : ''}"><div class="act-top"><code>${esc(c.cmd.slice(0, 90))}</code><span class="act-time">${c.seconds} s</span></div><div class="act-now">${esc(c.cwd.split(/[\/]/).pop())}</div></div>`).join('')) : '',
      a.talk.length ? section('Talk', a.talk.length, a.talk.map((t) => {
        const who = `${esc(t.label || 'Claude')}${t.model ? ` (${esc(t.model)})` : ''}`;
        return `<div class="act-item"><div class="act-top">💬 <a href="?conversation=${esc(t.id)}#talk" data-talk="${esc(t.id)}">${esc(t.title ?? 'New conversation')}</a><span class="act-time">${since(t.since)}</span></div><div class="act-now">${t.auto ? `${who} is explaining results Studio brought back` : `${who} is answering`}</div></div>`;
      }).join('')) : '',
      a.recent.length ? `<details class="act-recent" ${el('.act-recent')?.open !== false ? 'open' : ''}><summary><b>Finished in the last 15 min</b> <span class="meta">${a.recent.length}</span></summary>${a.recent.map((x) => (x.type === 'change' ? changeHtml(x, true) : runHtml(x, true))).join('')}</details>` : '',
    ].join(''));
    mountPlayers();
    for (const d of document.querySelectorAll('#actBody details[data-scout-report][open]')) loadScoutReport(d);
  }

  /** The drawer's contents (only while it is open and the page visible; the badge comes with the stream's events). */
  async function tick() {
    try {
      if (!open || document.hidden) return;
      // Keep open <details> open across redraws.
      const kept = new Set([...document.querySelectorAll('#actBody .act-log[open]')].map((d) => d.closest('.act-item')?.querySelector('[data-change-log]')?.dataset.changeLog));
      last = await api('/api/activity');
      if (showDismissed) await loadHidden();
      render(last);
      for (const d of document.querySelectorAll('#actBody .act-log')) if (kept.has(d.closest('.act-item')?.querySelector('[data-change-log]')?.dataset.changeLog)) d.open = true;
    } catch (e) {
      if (open) el('#actUpdated').textContent = `couldn't update: ${e.message}`;
    }
  }
  studioStream.on('activity', (e) => {
    // A running playtest's screenshots: fetch the new ones now that something moved (the ticker only plays what's loaded).
    if (!e.badge) for (const p of players.values()) if (p.running) p.next = 0;
    setCount(e.count);
    if (!e.badge || (open && !last)) tick();
  });

  function setOpen(v, { keep = true } = {}) {
    open = v;
    if (keep) remember(v ? 'open' : 'closed');
    el('#activity').hidden = !v;
    document.body.classList.toggle('act-open', v);
    el('#actBtn').classList.toggle('on', v);
    if (v && last) render(last, true);
    tick();
  }

  // Expanding a run card starts its players; collapsing it (or hiding the page) stops them asking.
  el('#activity').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('.act-frames')) return;
    if (d.open) openRuns.add(d.dataset.framesRun);
    else openRuns.delete(d.dataset.framesRun);
    mountPlayers();
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

  el('#actBtn').addEventListener('click', () => setOpen(!open));
  el('#actClose').addEventListener('click', () => setOpen(false));
  // Cancel / Resume / Close (src/cancel.ts routes; admins only): a short confirm, then Studio records J as who did it.
  async function cancelAct(b) {
    const { actCancel: act, kind, id, what } = { actCancel: b.dataset.actCancel, kind: b.dataset.kind, id: b.dataset.id, what: b.dataset.what };
    try {
      if (act === 'cancel') {
        if (!confirm(`Cancel ${what ?? 'this'}?`)) return;
        const reason = (prompt('Why? (optional, kept in the record)') ?? '').trim();
        await api(`/api/${kind}/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason: reason || undefined, by: 'J' } });
      } else if (act === 'resume') {
        await api(`/api/${kind}/${encodeURIComponent(id)}/resume`, { method: 'POST', body: { by: 'J' } });
      } else if (act === 'close') {
        if (!confirm('Close this change? Its branch and worktree are removed.')) return;
        await api(`/api/changes/${encodeURIComponent(id)}/close`, { method: 'POST', body: { by: 'J' } });
      }
      tick();
    } catch (err) {
      alert(`Couldn't do that: ${err.message}`);
    }
  }
  el('#activity').addEventListener('toggle', (e) => { if (e.target.open && e.target.dataset?.scoutReport) loadScoutReport(e.target); }, true);
  el('#activity').addEventListener('click', (e) => {
    const dm = e.target.closest('[data-scout-dismiss]');
    if (dm) {
      e.preventDefault();
      api(`/api/scouts/${encodeURIComponent(dm.dataset.id)}/${dm.dataset.scoutDismiss}`, { method: 'POST', body: {} }).then(tick).catch((err) => alert(`Couldn't do that: ${err.message}`));
      return;
    }
    if (e.target.closest('[data-scout-clear]')) {
      e.preventDefault();
      if (confirm('Dismiss every failed scout? They stay under Show dismissed.')) api('/api/scouts/clear-failed', { method: 'POST', body: {} }).then(tick).catch((err) => alert(`Couldn't do that: ${err.message}`));
      return;
    }
    if (e.target.closest('[data-scout-toggle]')) {
      e.preventDefault();
      showDismissed = !showDismissed;
      tick().then(() => last && render(last, true));
      return;
    }
    const ask = e.target.closest('[data-scout-ask]');
    if (ask) {
      e.preventDefault();
      const message = (prompt('Ask the scout a follow-up (it answers in the same session; the answer is added to its report):') ?? '').trim();
      if (message) api(`/api/scouts/${encodeURIComponent(ask.dataset.scoutAsk)}/message`, { method: 'POST', body: { message } }).catch((err) => alert(`Couldn't do that: ${err.message}`));
      return;
    }
    const cb = e.target.closest('[data-act-cancel]');
    if (cb) { e.preventDefault(); cancelAct(cb); return; }
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
    // A playtest: the Playtests page with it maximized (other links in the card keep their own way).
    const w = !r && !c && !t && (e.target.closest('a[data-live-job]') || (!e.target.closest('a') && e.target.closest('[data-live-job]')));
    if (w && !(e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); show('live', w.dataset.liveJob); }
    // On a phone the drawer covers the page: following a link closes it.
    if ((t || c || r || w) && matchMedia('(max-width: 760px)').matches) setOpen(false, { keep: false });
  });
  setOpen(open, { keep: false });
})();
