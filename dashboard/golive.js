// The Go live tab: every product at a glance, live vs beta in plain words, and buttons. Each product's card reads the
// same plan as the go-live dialog (GET /api/deploy/<p>: commits on beta not on main, beta's playtests, blockers and
// warnings) and the ops queue (GET /api/ops: a go live or rollback queued or running). "Go live" and "Roll back" never
// act by themselves: they ask for the same Approve card (approval.js, kind deploy / rollback, bound to that plan) and
// show it right there; J's tap on Approve is what goes live. A blocked card instead shows the one beta-only step that
// clears its blockers (the plan's `fix`, deploy.ts planFix): "Merge live into beta" (then plays beta), "Play beta" (the
// beta run) or "Rebuild beta" (a forced Unity build); the card follows that run and checks the plan again when it ends.
// None of them goes live or rolls back. Every card also has big Beta and Live links (they were the Sites tab; #sites
// opens this tab), and Studio and Gen's addresses sit below. Uses app.js's helpers ($, esc, api, ago) and approvals.

// Whether a card's finished fix line (✅ / ❌ "Play beta …") is still worth showing. The results live in page memory,
// so without this an old failure stayed on the card for as long as the page was open. A ✅ fades after an hour; a ❌
// goes once a newer beta run or playtest of the product finished OK (`okSince`), once the card is no longer red with
// a fix to offer, or after 6 hours (like a go live's last line). Pure, so it is tested without a DOM
// (test/golive-fix.test.ts).
var FixResult = (() => {
  const OK_FOR = 3600_000;
  const FAIL_FOR = 6 * 3600_000;
  /** When the result came in: the run's end, or when starting it failed. */
  const at = (fx) => (fx?.error ? fx.errorAt : fx?.done?.at) ?? 0;
  function show(fx, { now = Date.now(), red = false, fix = null, okSince = 0 } = {}) {
    if (!fx || (!fx.error && !fx.done)) return false;
    const t = at(fx);
    if (!t) return false;
    if (!fx.error && fx.done.ok) return now - t < OK_FOR;
    return now - t < FAIL_FOR && red && !!fix && !(okSince > t);
  }
  return { show, at, OK_FOR, FAIL_FOR };
})();

// Whether the commit about to go live was playtested (J, 2026-11-01: "when the current commit hasn't been playtested,
// add a button for playtesting it"). The same rule as going live by itself (golive-policy.ts playtestHolds): every
// playtest of beta's exact commit done with outcome won or done, no review saying "broken" or finding a blocker.
// `going`: a beta run or playtest of the product that hasn't finished (the card's own, or one started elsewhere).
// null when the card has nothing to go live, so there is no commit to speak of. Pure, so it is tested without a DOM
// (test/golive-playtest.test.ts).
var PlayState = (() => {
  const ok = (t) => t.status === 'done' && ['won', 'done'].includes(String(t.outcome)) && t.verdict !== 'broken' && !t.blockers?.length;
  /** Why one playtest didn't pass, in a few words. */
  const why = (t) => (t.status !== 'done' ? (t.status === 'skipped' ? 'was inconclusive' : t.status === 'stopped' ? 'was stopped' : 'failed')
    : !['won', 'done'].includes(String(t.outcome)) ? `ended "${t.outcome}"`
      : t.verdict === 'broken' ? 'was reviewed as broken' : `review found ${t.blockers.length} blocker(s)`);
  function of(p, { going = null, ahead = true } = {}) {
    if (!p || p.error || p.urlOnly || !p.beta || !ahead) return null;
    const sha = p.tested?.sha ?? p.beta.short ?? String(p.beta.sha ?? '').slice(0, 7);
    const t = p.tested?.playtests ?? [];
    if (going) return { state: 'running', sha, text: `Playtesting ${sha}${going.step ? `: ${going.step}` : '…'}` };
    if (!t.length) return { state: 'untested', sha, text: `This commit (${sha}) hasn't been playtested` };
    const bad = t.filter((x) => !ok(x));
    if (bad.length) return { state: 'failed', sha, text: `The playtest of this commit (${sha}) didn't pass: ${bad.map((x) => `${x.name} ${why(x)}`).join(', ')}` };
    return { state: 'passed', sha, text: `This commit (${sha}) passed its playtest${t.length > 1 ? 's' : ''}` };
  }
  /** The card offers "Playtest this commit" when it wasn't played, or its play didn't pass, and nothing is playing it. */
  const canPlay = (s) => !!s && (s.state === 'untested' || s.state === 'failed');
  const ICON = { passed: '✅', failed: '❌', untested: '⚠️', running: '⏳' };
  return { of, canPlay, ok, ICON };
})();

// The card's release history: recent go lives and rollbacks, with who took one live without a playtest of its commit
// ("Go live anyway", deploy.ts PlaytestSkip). Pure (uses app.js's esc and ago when there), tested in test/golive-anyway.test.ts.
var GoLiveHistory = (() => {
  const e = (x) => (typeof esc === 'function' ? esc(x) : String(x ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  const t = (at) => (typeof ago === 'function' ? ago(at) : new Date(at).toISOString());
  const line = (d) => `${d.kind === 'rollback' ? 'Rolled back' : 'Went live'} ${t(d.at)}${d.by ? ` by ${d.by}` : ''}: ${d.before ?? '?'} → ${d.after}${d.rolledBack ? ' (rolled back since)' : ''}`;
  function html(previous) {
    if (!previous?.length) return '';
    return `<p class="meta"><b>Release history</b></p>${previous.map((d) => `<div class="meta gl-hist">${e(line(d))}${d.skippedPlaytest ? ` · <span class="gl-fail">⚠️ without a playtest of ${e(String(d.skippedPlaytest.sha).slice(0, 7))} (${e(d.skippedPlaytest.by)}, ${e(t(d.skippedPlaytest.at))})</span>` : ''}</div>`).join('')}`;
  }
  return { html, line };
})();

if (typeof document !== 'undefined') (() => {
  const css = document.createElement('style');
  css.textContent = `
    .gl-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
    .gl-card { background: var(--panel); border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: var(--radius); padding: 14px 16px; min-width: 0; }
    .gl-card.green { border-left-color: var(--accent); } .gl-card.yellow { border-left-color: var(--amber); } .gl-card.red { border-left-color: var(--red); }
    .gl-card h3 { margin: 0 0 6px; font-size: 17px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .gl-light { width: 14px; height: 14px; border-radius: 50%; background: var(--line); flex: none; }
    .gl-light.green { background: var(--accent); } .gl-light.yellow { background: var(--amber); } .gl-light.red { background: var(--red); }
    .gl-status { font-size: 18px; font-weight: 700; margin: 4px 0; } .gl-status.ahead { color: var(--amber); } .gl-status.same { color: var(--accent); }
    .gl-when { color: var(--dim); font-size: 13px; margin-bottom: 8px; }
    .gl-light-line { margin: 8px 0; font-size: 14px; }
    .gl-group { margin: 6px 0; font-size: 14px; } .gl-group b { font-size: 13px; color: var(--dim); font-weight: 600; }
    .gl-group ul { margin: 2px 0 0; padding-left: 18px; }
    .gl-buttons { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .gl-buttons button.big { font-size: 17px; padding: 12px 22px; border-radius: 12px; flex: 1 1 auto; min-height: 48px; }
    .gl-buttons button.roll { flex: 0 1 auto; min-height: 48px; }
    .gl-busy { background: rgba(255,190,85,.12); border: 1px solid rgba(255,190,85,.4); border-radius: 8px; padding: 8px 10px; margin: 8px 0; font-size: 14px; }
    .gl-done { font-size: 13px; margin: 6px 0; } .gl-fail { color: var(--red); }
    .gl-play { font-size: 14px; margin: 6px 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); }
    .gl-play.passed { border-color: rgba(80,200,120,.4); } .gl-play.failed { border-color: rgba(255,90,90,.5); } .gl-play.untested { border-color: rgba(255,190,85,.5); } .gl-play.running { background: rgba(255,190,85,.12); border-color: rgba(255,190,85,.4); }
    .gl-slot:not(:empty) { margin-top: 10px; }
    .gl-card details { margin-top: 8px; font-size: 13px; } .gl-card details code { font-size: 12px; }
    .gl-links { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
    .gl-links a, .gl-links .gl-none { flex: 1 1 120px; display: flex; flex-direction: column; justify-content: center; min-height: 48px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel2); text-decoration: none; min-width: 0; }
    .gl-links a b { color: var(--text); font-size: 15px; } .gl-links a.beta b { color: var(--amber); } .gl-links a.live b { color: var(--accent); }
    .gl-links a small, .gl-links .gl-none small { color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gl-links a:hover { border-color: var(--dim); }
    .gl-links .gl-none { color: var(--dim); font-size: 14px; }
    .gl-head { margin: 18px 0 8px; font-size: 14px; color: var(--dim); font-weight: 600; }
    @media (max-width: 700px) { .gl-list { grid-template-columns: 1fr; } .gl-buttons button.big { width: 100%; } }`;
  document.head.appendChild(css);

  const plans = new Map(); // product -> plan (or { error })
  let products = [];
  let betaSites = new Map(); // product -> its beta site (GET /api/previews), so the links show before the plan is in
  let ops = [];
  let pending = []; // waiting deploy / rollback cards
  let busy = false;
  const fixing = new Map(); // product -> { action, run?, step?, error?, errorAt?, done? }: the beta step J started from a card
  const lastOk = new Map(); // product -> when its newest beta, daily or playtest run finished OK (loadRuns)

  /** The beta-only steps that clear blockers (deploy.ts blockerFix), in J's words. */
  const FIX = {
    'merge-main': { label: 'Merge live into beta', busy: 'Merging live into beta, then playing beta', title: 'Merges what is live into beta, then builds and playtests beta. Nothing goes live.' },
    beta: { label: 'Play beta', busy: 'Playing beta', title: 'Brings beta up to date (pre-deploy build, Unity build, beta site) and playtests it. Nothing goes live.' },
    build: { label: 'Build', busy: 'Building', title: 'Starts this project\'s builds now (the Build button), then checks beta against live again. Nothing goes live.' },
    sync: { label: 'Sync repo', busy: 'Cloning the repo onto the server', title: 'Clones this product\'s repo onto the server (the server has no copy yet), then checks beta against live again. Nothing goes live.' },
    playtest: { label: 'Playtest this commit', busy: 'Playtesting this commit', title: 'Plays beta as it is now (the commit about to go live) and reviews it. Nothing goes live.' },
    redeploy: { label: 'Redeploy beta', busy: 'Redeploying beta', title: 'Runs beta\'s deploy again on GitHub (its site did not answer). Nothing goes live. Then retry the playtest.' },
    rebuild: { label: 'Rebuild beta', busy: 'Rebuilding beta on top of what is live', title: 'Builds beta again on top of the live site (Unity, about $0.10). Nothing goes live.' },
  };
  /** A run's step in plain words: what it's doing now. */
  const STEP = { repo: 'updating the code', prebuild: 'pre-deploy build', build: 'Unity build', playtest: 'playtest', review: 'review of the playtest', preview: 'beta site' };
  const stepText = (s) => s && `${STEP[s.kind] ?? s.kind}${s.detail ? `: ${String(s.detail).slice(0, 120)}` : ''}`;

  const when = (d) => (d ? ago(typeof d === 'number' ? d : Date.parse(d)) : 'unknown');
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

  /** Who made a commit, in J's words. */
  function who(c) {
    if (/^devtools:/.test(c.title) || /devtools/i.test(c.author)) return 'Your devtools saves';
    if (/agent/i.test(c.author) || /\(#\d+\)\s*$/.test(c.title) || /^Merge pull request/.test(c.title)) return 'Agent changes';
    if (/^Hawkes Studio/.test(c.author) || /^(Studio build:|Rollback:)/.test(c.title)) return 'Studio (builds and merges)';
    return c.author === 'J' || /griffith/i.test(c.author) ? 'You (J)' : c.author;
  }
  const plain = (t) => String(t).replace(/\s*\(#\d+\)\s*$/, '').replace(/^J(?:'s words)?:\s*"?([^"]*)"?\s*$/, '$1').replace(/^devtools:\s*/, 'Saved ').slice(0, 140);

  /** Beta is ahead of live: new commits (Unity: the website's too), or a new build that differs from what's live. */
  const site = (p) => p.siteCommits ?? [];
  const siteOnly = (p) => p.siteMainOnly ?? [];
  // A customer's game with only its addresses (urlOnly) has no commits to ship from Studio.
  const ahead = (p) => !p.urlOnly && (p.commits?.length ?? 0) > 0 || site(p).length > 0 || !!(p.unity && p.build?.ok && p.build.files > 0);
  const nothingToDo = (b) => /^Nothing to go live/.test(b);

  /** The light: red = can't go live yet, yellow = can, with warnings, green = ready (or nothing to do). */
  function light(p) {
    const blockers = p.blockers.filter((b) => !nothingToDo(b));
    const t = p.tested.playtests;
    const played = t.length ? `Beta was playtested ${when(Math.max(...t.map((x) => x.when ?? 0)))}: ${t.map((x) => `${x.name} ${x.outcome ?? x.status}${x.verdict ? ` (review: ${x.verdict})` : ''}`).join(', ')}.` : 'This version of beta hasn\'t been playtested yet.';
    if (!ahead(p) && !p.mainOnly.length && !siteOnly(p).length) return { color: 'green', text: 'Nothing waiting.', played: t.length ? played : '' };
    if (blockers.length) return { color: 'red', text: 'Not ready to go live yet.', played, why: blockers };
    if (p.warnings.length) return { color: 'yellow', text: 'Ready, but look at the warnings first.', played, why: p.warnings };
    return { color: 'green', text: 'Ready to go live: playtested with no problems.', played };
  }

  // The beta and live links (they were the Sites tab): on every card, whatever its state, opening in a new tab.
  // Studio and Gen have no beta lane, so only their live address.
  const INFRA = [
    { name: 'Hawkes Studio', live: 'https://studio.hawkesgen.ai/' },
    { name: 'Hawkes Gen', live: 'https://hawkesgen.ai/' },
  ];
  const short = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const siteLink = (kind, label, url) => (url
    ? `<a class="${kind}" href="${esc(url)}" target="_blank" rel="noopener"><b>${label} ↗</b><small>${esc(short(url))}</small></a>`
    : `<span class="gl-none">${label}<small>none</small></span>`);
  const links = (prod, p) => `<div class="gl-links">${siteLink('beta', 'Beta', p?.betaSite ?? betaSites.get(prod.id))}${siteLink('live', 'Live', p?.live ?? prod.live)}</div>`;

  const liveOps = (id) => ops.filter((o) => o.product === id && (o.kind === 'golive' || o.kind === 'rollback'));

  function card(prod) {
    const p = plans.get(prod.id);
    if (!p) return `<div class="gl-card" data-p="${esc(prod.id)}" data-key="gl:${esc(prod.id)}"><h3><span class="gl-light"></span>${esc(prod.name)}</h3>${links(prod)}<div class="meta">Checking beta and live…</div></div>`;
    if (p.error) return `<div class="gl-card red" data-p="${esc(prod.id)}" data-key="gl:${esc(prod.id)}"><h3><span class="gl-light red"></span>${esc(prod.name)}</h3>${links(prod)}<div class="meta">Couldn't check: ${esc(p.error)}</div></div>`;
    // A customer's game with only its address (no repository): no beta here and nothing to send live from Studio.
    // Its beta and live addresses (edit them on the game), and a playtest of either: "Play beta" before it ships,
    // "Play live" after.
    if (p.urlOnly) return `<div class="gl-card" data-p="${esc(prod.id)}" data-key="gl:${esc(prod.id)}"><h3><span class="gl-light"></span>${esc(prod.name)}</h3><div class="gl-links">${p.beta ? `<a class="beta" href="${esc(p.beta)}" target="_blank" rel="noopener"><b>Beta</b><small>${esc(p.beta)}</small></a>` : '<span class="gl-none">No beta address<small>add one with Edit</small></span>'}<a class="live" href="${esc(p.live)}" target="_blank" rel="noopener"><b>Live</b><small>${esc(p.live)}</small></a></div><div class="gl-buttons">${p.beta ? `<button class="small" data-glplay="local">Play beta</button>` : ''}<button class="small" data-glplay="live">Play live</button><button class="small" data-admin data-glrepo="${esc(prod.id)}">Edit</button></div><div class="meta">${esc(p.note)}</div><div class="meta gl-playmsg"></div></div>`;
    // Beta couldn't be read (git failed, or no beta branch yet): say so, never "up to date".
    if (!p.beta || p.blockers.some((b) => b.startsWith('git:'))) {
      // The server has no checkout of the repo yet: one button clones it (the repo sync), then the plan is made again.
      const sx = fixing.get(p.product);
      const syncing = sx?.action === 'sync' && !sx.done && !sx.error;
      const sync = p.fix === 'sync' ? `<div class="gl-buttons"><button class="primary big" data-glfix="sync" title="${esc(FIX.sync.title)}"${syncing ? ' disabled' : ''}>${esc(syncing ? `${FIX.sync.busy}…` : FIX.sync.label)}</button></div>${sx?.action === 'sync' && sx.error ? `<div class="gl-done gl-fail">❌ Sync failed ${esc(ago(sx.errorAt))}: ${esc(String(sx.error).slice(0, 300))}</div>` : ''}` : '';
      return `<div class="gl-card red" data-p="${esc(p.product)}" data-key="gl:${esc(p.product)}"><h3><span class="gl-light red"></span>${esc(p.name)}</h3>${links(prod, p)}<div class="gl-status">${p.fix === 'sync' ? 'Not cloned on the server yet' : 'Couldn\'t compare beta with live'}</div><ul class="meta">${p.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>${sync}</div>`;
    }
    const L = light(p);
    const up = ahead(p);
    const status = up
      ? (p.commits.length || site(p).length ? `Beta is ${n(p.commits.length + site(p).length, 'change')} ahead of live` : 'Beta has a new build that isn\'t live')
      : p.mainOnly.length || siteOnly(p).length ? 'Live has changes beta doesn\'t have' : 'Live is up to date';
    const lastLive = Math.max(p.previous[0]?.at ?? 0, p.main ? Date.parse(p.main.date) : 0) || null;
    const groups = {};
    for (const c of [...p.commits, ...site(p)]) (groups[who(c)] ??= []).push(c);
    const run = liveOps(p.product).filter((o) => o.status === 'queued' || o.status === 'running');
    const last = liveOps(p.product).find((o) => o.status === 'done' || o.status === 'failed');
    const recent = last && Date.now() - (last.finished ?? last.created) < 6 * 3600_000 ? last : null;
    const canRoll = p.previous.some((d) => d.kind === 'deploy' && !d.rolledBack);
    const card = pending.find((a) => a.target === p.product && (a.kind === 'deploy' || a.kind === 'rollback'));
    const fx = fixing.get(p.product);
    const fix = L.color === 'red' && p.fix && FIX[p.fix] && !run.length ? p.fix : null;
    const buildGoing = !!p.buildRunning?.length;
    const fixRunning = (fx && !fx.done && !fx.error) || buildGoing;
    const okSince = Math.max(lastOk.get(p.product) ?? 0, ...p.tested.playtests.filter((t) => t.status === 'done' && t.outcome !== 'error').map((t) => t.when ?? 0));
    // This commit's playtest: passed, didn't pass, not played (with the button that plays it), or being played (the
    // busy line above says so, with its step).
    const going = fixRunning && ['beta', 'playtest', 'merge-main'].includes(fx.action) ? { step: fx.step } : null;
    const ps = PlayState.of(p, { going, ahead: up });
    const offerPlay = PlayState.canPlay(ps) && !run.length;
    const showFx = FixResult.show(fx, { red: L.color === 'red' || offerPlay, fix: p.fix && FIX[p.fix] ? p.fix : offerPlay ? 'playtest' : null, okSince });
    // The fix "Play beta" plays this commit too: when it isn't played yet, the button says so.
    const fixLabel = fix === 'beta' && PlayState.canPlay(ps) ? FIX.playtest.label : fix && FIX[fix].label;
    // Only the playtest stops it (deploy.ts playtestOnly): a person may go live anyway, beside "Playtest this commit".
    const anyway = up && !run.length && !!p.playtestOnly;
    const fxRun = fx?.run ? ` · <a href="#runs" data-glrun="${esc(fx.run)}">the run</a>` : '';
    return `<div class="gl-card ${L.color}" data-p="${esc(p.product)}" data-key="gl:${esc(p.product)}">
      <h3><span class="gl-light ${L.color}" title="${esc(L.text)}"></span>${esc(p.name)}</h3>
      <div class="gl-status ${up ? 'ahead' : 'same'}">${esc(status)}</div>
      <div class="gl-when">Live updated ${esc(when(lastLive))} · beta changed ${esc(when(p.beta?.date))}</div>
      ${ps && ps.state !== 'running' ? `<div class="gl-play ${ps.state}" data-key="glplay:${esc(p.product)}">${PlayState.ICON[ps.state]} ${esc(ps.text)}</div>` : ''}
      ${links(prod, p)}
      ${(p.buildRunning ?? []).map((r) => BuildFail.running(p.product, r)).join('')}
      ${(p.buildFailing ?? []).map((f) => BuildFail.badge(p.product, f)).join('')}
      ${(p.buildDone ?? []).map((d) => BuildFail.done(p.product, d)).join('')}
      ${run.map((o) => `<div class="gl-busy">⏳ ${esc(o.title)}${o.status === 'queued' ? ' (waiting its turn)' : o.step ? `: ${esc(o.step)}` : '…'}</div>`).join('')}
      ${fixRunning && !run.length && fx && !fx.done && !fx.error && !buildGoing ? `<div class="gl-busy">⏳ ${esc(FIX[fx.action].busy)}${fx.step ? `: ${esc(fx.step)}` : '…'}</div>` : ''}
      ${!showFx ? '' : fx.error ? `<div class="gl-done gl-fail">❌ ${esc(FIX[fx.action].label)} failed ${esc(ago(fx.errorAt))}: ${esc(String(fx.error).slice(0, 300))}</div>` : `<div class="gl-done">${fx.done.ok ? `✅ ${esc(FIX[fx.action].label)} finished ${esc(ago(fx.done.at))}${fxRun}` : `<span class="gl-fail">❌ ${esc(FIX[fx.action].label)} failed ${esc(ago(fx.done.at))}: ${esc(String(fx.done.detail ?? '').slice(0, 300))}</span>${fxRun}`}</div>`}
      ${!run.length && recent ? `<div class="gl-done">${recent.status === 'done' ? `✅ ${esc(recent.kind === 'rollback' ? 'Rolled back' : 'Went live')} ${esc(ago(recent.finished))}${recent.result?.skippedPlaytest ? ` without a playtest (${esc(recent.result.skippedPlaytest.by)})` : ''}${recent.result?.release ? ` · v${esc(recent.result.release.version)}: ${esc(recent.result.release.title ?? '')}` : ''}` : `❌ ${esc(recent.title)} failed ${esc(ago(recent.finished))}: ${esc(String(recent.error ?? '').slice(0, 200))}`}</div>` : ''}
      ${p.players ? `<div class="gl-players meta" title="Real players on the live site (Hawkes Analytics; bots and your own devices left out)">👥 ${esc(p.players)}</div>` : ''}
      ${up && p.release ? `<div class="gl-release meta">${p.release.existing ? 'What\'s new (already on beta, kept)' : 'Releases'} v${esc(p.release.version)}: ${esc(p.release.title ?? '(the notes are being written)')}${p.release.notes?.length ? `<ul>${p.release.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      ${Object.entries(groups).map(([g, cs]) => `<div class="gl-group"><b>${esc(g)} (${cs.length})</b><ul>${cs.slice(0, 6).map((c) => `<li>${esc(plain(c.title))}</li>`).join('')}${cs.length > 6 ? `<li class="meta">and ${cs.length - 6} more</li>` : ''}</ul></div>`).join('')}
      ${up || p.mainOnly.length || L.played ? `<div class="gl-light-line"><b>${esc(L.text)}</b>${L.played ? `<br><span class="meta">${esc(L.played)}</span>` : ''}${L.why?.length ? `<ul>${L.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}${BuildFail.attempts(p.product, p.buildAttempts)}</div>` : ''}
      ${p.betaDown && !run.length ? `<div class="gl-light-line gl-down"><b>Beta wasn't played.</b><br>${esc(p.betaDown.line)}${fx?.action === 'redeploy' && (fx.done || fx.error) ? `<br><span class="meta">${esc(fx.done?.note ?? fx.error)}</span>${fx.done?.link ? ` <a href="${esc(fx.done.link)}" target="_blank" rel="noopener">Open the run ↗</a>` : ''}` : ''}
        <div class="gl-buttons"><button class="primary big" data-admin data-glfix="redeploy" data-guide="off" title="${esc(FIX.redeploy.title)}"${fixRunning ? ' disabled' : ''}>${esc(fixRunning && fx.action === 'redeploy' ? `${FIX.redeploy.busy}…` : FIX.redeploy.label)}</button>
        <button class="big" data-admin data-glfix="playtest" data-guide="off" title="${esc(FIX.playtest.title)}"${fixRunning ? ' disabled' : ''}>Retry playtest</button>${p.betaDown.runs ? ` <a href="${esc(p.betaDown.runs)}" target="_blank" rel="noopener">Beta's deploys ↗</a>` : ''}</div></div>` : ''}
      <div class="gl-buttons">
        ${fix ? `<button class="primary big" data-glfix="${esc(fix)}" title="${esc(FIX[fix].title)}"${fixRunning ? ' disabled' : ''}>${esc(fixRunning ? `${FIX[fix].busy}…` : fixLabel)}</button>` : ''}
        ${offerPlay && !fix ? `<button class="${ps.state === 'untested' ? 'primary ' : ''}big" data-admin data-glfix="playtest" data-guide="off" title="${esc(FIX.playtest.title)}"${fixRunning ? ' disabled' : ''}>${esc(ps.state === 'failed' ? 'Playtest this commit again' : FIX.playtest.label)}</button>` : ''}
        ${anyway ? `<button class="big danger" data-admin data-glgo="deploy" data-guide="off" title="Shows the go-live card: it takes this commit live without a playtest, after you confirm. Your name goes on the release history.">Go live anyway</button>`
          : up && !run.length && !fix ? `<button class="${offerPlay && ps.state === 'untested' ? '' : 'primary '}big" data-admin data-glgo="deploy" data-guide="off" title="Shows the Approve card for going live; your tap on Approve is what goes live">Go live</button>` : ''}
        ${canRoll && !run.length ? `<button class="roll" data-admin data-glgo="rollback" data-guide="off" title="Shows the Approve card for rolling back to what was live before">Roll back</button>` : ''}
      </div>
      <div class="gl-slot"${card ? '' : ' data-patch-keep'}>${card ? approvals.html(card) : ''}</div>
      <details><summary class="meta">Details</summary>
        <p>Live: ${p.main ? `<code>${esc(p.main.short)}</code> ${esc(p.main.title)}` : '<i>none</i>'}<br>Beta: ${p.beta ? `<code>${esc(p.beta.short)}</code> ${esc(p.beta.title)}` : '<i>none</i>'}</p>
        ${p.commits.map((c) => `<div class="meta"><code>${esc(c.short)}</code> ${esc(c.title)} · ${esc(c.author)} · ${esc(when(c.date))}</div>`).join('')}
        ${p.mainOnly.length ? `<p class="meta">Live has ${p.mainOnly.length} commit(s) beta lacks: ${p.mainOnly.map((c) => esc(c.title)).join('; ')}</p>` : ''}
        ${site(p).length ? `<p class="meta">Website pages (${esc(p.site)}):</p>${site(p).map((c) => `<div class="meta"><code>${esc(c.short)}</code> ${esc(c.title)} · ${esc(c.author)} · ${esc(when(c.date))}</div>`).join('')}` : ''}
        ${siteOnly(p).length ? `<p class="meta">The live website has ${siteOnly(p).length} commit(s) its beta lacks: ${siteOnly(p).map((c) => esc(c.title)).join('; ')}</p>` : ''}
        <p class="meta">${esc(p.what)}</p>
        ${GoLiveHistory.html(p.previous)}
        <div class="actions"><button class="small" data-glplan="${esc(p.product)}" data-guide="off" title="The full go-live plan: update and playtest beta, merge live's commits into beta, previous go lives, the typed DEPLOY fallback">Full plan and more options…</button></div>
      </details>
    </div>`;
  }

  /** Redraws the cards in place (patch.js): open details, a card J made with a button (its slot keeps it) and the scroll position stay. */
  function draw() {
    const box = $('#glList');
    studioPatch(box, products.map(card).join('') || '<div class="meta">No products.</div>');
    studioPatch($('#glInfra'), INFRA.map((x) => `<div class="gl-card"><h3>${esc(x.name)}</h3><div class="gl-links">${siteLink('live', 'Live', x.live)}</div></div>`).join(''));
    const waiting = [...plans.values()].filter((p) => !p.error && ahead(p)).length;
    const blocked = blockedNow();
    $('#glFixAll').hidden = !blocked.length;
    $('#glFixAll').textContent = `Play beta for all blocked (${blocked.length})`;
    const allUrlOnly = products.length && [...plans.values()].every((p) => p.urlOnly);
    $('#glInfo').textContent = plans.size < products.length ? 'Checking every product…' : allUrlOnly ? 'Your games go live where you deploy them: play their beta before you ship, and live after.' : waiting ? `${n(waiting, 'product')} with beta ahead of live.` : 'Every live site is up to date with beta.';
  }

  /** Products whose card shows a fix button and isn't running one. */
  const blockedNow = () => products.map((x) => plans.get(x.id)).filter((p) => p && !p.error && p.beta && p.fix && FIX[p.fix] && light(p).color === 'red' && !liveOps(p.product).some((o) => o.status === 'queued' || o.status === 'running'))
    .filter((p) => { const f = fixing.get(p.product); return !f || f.done || f.error; });

  /** Starts the beta step that clears a product's blockers; the card follows its run. Never goes live. */
  async function startFix(id, action) {
    fixing.set(id, { action, step: action === 'merge-main' ? 'merging' : action === 'sync' ? 'cloning' : '' });
    // Pressing Build shows "Starting" on the card at once (the server's state replaces it when the request answers).
    if ((action === 'build' || action === 'rebuild') && plans.get(id) && !plans.get(id).error) Object.assign(plans.get(id), { buildFailing: [], buildRunning: [{ build: 'build', version: null, state: 'starting', run: '', started: Date.now(), step: null }] });
    draw();
    try {
      if (action === 'sync') {
        // The plan says which folder isn't cloned (its website repo, for a Unity game, can be the one missing).
        const folder = plans.get(id)?.notCloned;
        const r = await api('/api/repos/sync', { method: 'POST', body: folder ? { only: [folder] } : {} });
        const bad = (r.repos ?? []).find((x) => x.action === 'failed');
        if (bad) throw new Error(`${bad.folder}: ${bad.detail}`);
        fixing.get(id).done = { ok: true, at: Date.now() };
        await loadPlan(id);
        return;
      }
      if (action === 'redeploy') {
        const r = await api(`/api/deploy/${id}/redeploy-beta`, { method: 'POST', body: {} });
        if (r.ok) fixing.get(id).done = { ok: true, at: Date.now(), note: r.note, link: r.link };
        else Object.assign(fixing.get(id), { error: r.note, errorAt: Date.now(), done: { ok: false, note: r.note, link: r.link } });
        draw();
        return;
      }
      if (action === 'merge-main') {
        await api(`/api/deploy/${id}`, { method: 'POST', body: { mergeMain: true, by: 'J' } });
        fixing.get(id).step = 'merged; playing beta';
      }
      const r = action === 'build'
        ? await api(`/api/projects/${id}/builds`, { method: 'POST', body: {} })
        : action === 'rebuild'
        ? await api('/api/build', { method: 'POST', body: { product: id, force: true } })
        : await api(`/api/beta/${id}`, { method: 'POST', body: {} });
      fixing.get(id).run = r.run;
      if (action === 'build' || action === 'rebuild') await refreshBuildState(id);
    } catch (err) {
      Object.assign(fixing.get(id), { error: err.message, errorAt: Date.now() });
      loadPlan(id);
    }
    draw();
  }

  /** The product's builds as the server has them (failed, starting, building): one small fetch, never the whole plan. */
  async function refreshBuildState(id) {
    const plan = plans.get(id);
    if (!plan || plan.error) return;
    const b = await api(`/api/projects/${encodeURIComponent(id)}/builds`).catch(() => null);
    if (b) Object.assign(plan, { buildFailing: b.failing ?? [], buildRunning: b.running ?? [], buildDone: b.done ?? [] });
  }

  /** The runs the cards follow: their step now; when one ends, the product's plan again (it turns ready, or says why not). */
  async function pollFixes() {
    for (const [id, f] of fixing) {
      if (!f.run || f.done || f.error) continue;
      try {
        const r = await api(`/api/runs/${f.run}`);
        const s = r.steps.findLast((x) => x.status === 'running') ?? r.steps.at(-1);
        f.step = stepText(s) ?? '';
        if (r.status !== 'running') {
          f.done = { ok: r.status === 'done', at: r.finished ?? Date.now(), detail: r.status === 'done' ? '' : r.steps.filter((x) => x.status === 'failed').map(stepText).join('; ') || r.detail };
          await loadPlan(id);
        }
      } catch {}
    }
  }

  /** Beta and build runs already going (started elsewhere, or before this page loaded): the cards follow them too. */
  async function loadRuns() {
    const { runs } = await api('/api/runs?limit=40');
    for (const r of runs) {
      if (r.status === 'done' && r.finished && ['beta', 'daily', 'manual', 'playtest'].includes(r.kind)) {
        for (const id of r.products ?? []) if (r.finished > (lastOk.get(id) ?? 0)) lastOk.set(id, r.finished);
      }
      // A playtest of beta (where local) counts as playing this commit; one of the live site doesn't.
      const betaPlay = r.kind === 'playtest' && (r.where ?? 'local') === 'local';
      if (r.status !== 'running' || !(['beta', 'build'].includes(r.kind) || betaPlay) || r.products?.length !== 1) continue;
      const id = r.products[0];
      const f = fixing.get(id);
      if (!f || f.done || f.error) fixing.set(id, { action: r.kind === 'build' ? 'rebuild' : betaPlay ? 'playtest' : 'beta', run: r.id, step: '' });
    }
  }

  async function loadOps() {
    const [o, a] = await Promise.all([api('/api/ops?limit=60'), approvals.call('/api/approvals?pending=1').catch(() => ({ approvals: [] }))]);
    const before = JSON.stringify(ops.filter((x) => x.status === 'queued' || x.status === 'running').map((x) => x.id));
    ops = o.ops;
    pending = a.approvals.filter((x) => x.status === 'pending');
    const now = JSON.stringify(ops.filter((x) => x.status === 'queued' || x.status === 'running').map((x) => x.id));
    return before !== now; // something started or finished: the plans moved
  }
  // Each card's plan loads on its own: one slow plan (a repo busy pushing a big build) never holds the others, the
  // Refresh button or the stream's updates (J, 2026-10-27: cards stuck until a reload). A plan already on its way isn't
  // asked for again; one that takes over 45 s says so on its card and is asked for again next time.
  const loading = new Map();
  const PLAN_SLOW_MS = 45_000;
  function loadPlan(id) {
    const was = loading.get(id);
    if (was && Date.now() - was < PLAN_SLOW_MS) return;
    const started = Date.now();
    loading.set(id, started);
    const slow = setTimeout(() => {
      if (loading.get(id) !== started) return;
      loading.delete(id);
      if (!plans.has(id)) { plans.set(id, { error: 'still checking after 45 s (its repo may be busy with a push); press Refresh to try again' }); if (tab === 'golive') draw(); }
    }, PLAN_SLOW_MS);
    api(`/api/deploy/${id}`)
      .then((p) => { plans.set(id, p); }, (e) => { plans.set(id, { error: e.message }); })
      .finally(() => {
        clearTimeout(slow);
        if (loading.get(id) === started) loading.delete(id);
        if (tab === 'golive') draw();
      });
  }

  async function load() {
    if (busy) return;
    busy = true;
    try {
      const [pr, pv] = await Promise.all([api('/api/products'), api('/api/previews').catch(() => ({ previews: [] }))]);
      products = pr.products;
      betaSites = new Map(pv.previews.map((x) => [x.product, x.url]));
      await loadOps();
      await loadRuns().catch(() => {});
      draw();
    } finally { busy = false; }
    for (const p of products) loadPlan(p.id);
  }
  window.loadGoLiveTab = load;

  // While the tab is open: the queue when the push stream says operations, changes or runs moved (stream.js)
  // when a go live starts or ends, the plans again.
  studioStream.on(['ops', 'changes', 'runs', 'builds'], async () => {
    if (tab !== 'golive' || busy || !products.length) return;
    try {
      await pollFixes();
      // A build starting, running or ending: its card's state from the server (the stream says when; nothing is asked on a timer).
      await Promise.all([...plans].filter(([, pl]) => pl.buildRunning?.length || pl.buildFailing?.length || [...fixing].some(([k, f]) => k === pl.product && ['build', 'rebuild'].includes(f.action))).map(([id]) => refreshBuildState(id)));
      if (await loadOps()) await load(); else draw();
    } catch {}
  });
  addEventListener('studio-approval', () => { if (tab === 'golive') setTimeout(() => loadOps().then(draw).catch(() => {}), 800); });

  $('#glRefresh').onclick = () => { plans.clear(); loading.clear(); load().catch((e) => alert(e.message)); };
  $('#glFixAll').onclick = (e) => {
    if (!e.isTrusted) return;
    for (const p of blockedNow()) startFix(p.product, p.fix);
  };
  $('#glList').addEventListener('click', async (e) => {
    const pl = e.target.closest('button[data-glplay]');
    if (pl) {
      const card = pl.closest('.gl-card');
      const msg = card.querySelector('.gl-playmsg');
      try { await api('/api/playtest', { method: 'POST', body: { product: card.dataset.p, where: pl.dataset.glplay } }); msg.textContent = `Playing ${pl.dataset.glplay === 'local' ? 'beta' : 'live'}: it shows up under Playtests, with its video and review.`; } catch (err) { msg.textContent = err.message; }
      return;
    }
    const ar = e.target.closest('button[data-glrepo]');
    if (ar) { if (await studioAddRepo(ar.dataset.glrepo)) load(); return; }
    const fb = e.target.closest('button[data-glfix]');
    if (fb) { if (e.isTrusted) startFix(fb.closest('.gl-card').dataset.p, fb.dataset.glfix); return; }
    const rl = e.target.closest('a[data-glrun]');
    if (rl) { e.preventDefault(); openRun = rl.dataset.glrun; show('runs'); return; }
    const plan = e.target.closest('button[data-glplan]');
    if (plan) return void goLive(plan.dataset.glplan).catch((err) => alert(err.message));
    const b = e.target.closest('button[data-glgo]');
    if (!b || !e.isTrusted) return;
    const c = b.closest('.gl-card');
    const slot = c.querySelector('.gl-slot');
    b.disabled = true;
    slot.innerHTML = '<div class="meta">Making the card…</div>';
    try {
      const a = await approvals.request({ kind: b.dataset.glgo, target: c.dataset.p });
      slot.innerHTML = approvals.html(a);
      slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      slot.innerHTML = `<div class="meta" style="color:var(--red)">${esc(err.message)}</div>`;
    }
    b.disabled = false;
  });
})();
