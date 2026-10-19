// The ⚙ Settings tab: every setting in one place (GET/POST /api/settings, src/settings.ts), stored in Studio so it
// follows J from his laptop to his phone. Calls (voice and listening), agents, the PM loop, phone notifications,
// budgets. Only the browser voice's name is kept in this browser (voices differ per device). Uses app.js's helpers
// ($, esc, api) and call.js's window.callVoice.
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .set-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; }
    .set-box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
    .set-box h3 { margin: 0 0 4px; font-size: 15px; } .set-box > .meta { margin-bottom: 8px; }
    .set-row { display: grid; grid-template-columns: minmax(150px, 40%) 1fr; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }
    .set-row:last-child { border-bottom: 0; }
    .set-row > div { min-width: 0; } .set-row select { width: 100%; }
    .set-row .help { grid-column: 1 / -1; color: var(--dim); font-size: 12px; margin-top: -2px; }
    .set-row select, .set-row input[type=number], .set-row input[type=text] { max-width: 100%; background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; color: inherit; }
    .set-row input[type=number] { width: 7em; }
    .set-engines label { display: block; margin: 3px 0; }
    .set-saved { color: var(--accent); font-size: 12px; margin-left: 6px; } .set-err { color: var(--red); font-size: 12px; margin-left: 6px; }
    .set-test pre { white-space: pre-wrap; font-size: 12px; margin: 6px 0 0; }
    @media (max-width: 700px) { .set-grid { grid-template-columns: 1fr; } .set-row { grid-template-columns: 1fr; } }`;
  document.head.appendChild(css);

  /** Kokoro's best English voices (kokoro-js ids; grades from the model card). */
  const KOKORO = [
    ['af_heart', 'Heart (US, A)'], ['af_bella', 'Bella (US, A-)'], ['af_nicole', 'Nicole (US, soft)'], ['af_sarah', 'Sarah (US)'], ['af_aoede', 'Aoede (US)'], ['af_kore', 'Kore (US)'],
    ['am_michael', 'Michael (US)'], ['am_fenrir', 'Fenrir (US)'], ['am_puck', 'Puck (US)'],
    ['bf_emma', 'Emma (UK)'], ['bm_george', 'George (UK)'], ['bm_fable', 'Fable (UK)'],
  ];
  const SEVERITIES = ['blocker', 'bug', 'polish', 'idea'];
  let data = null;

  const row = (label, control, help) => `<div class="set-row"><div>${label}</div><div>${control}</div>${help ? `<div class="help">${help}</div>` : ''}</div>`;
  const num = (section, k, v, { min = 0, max, step = 1 } = {}) => `<input type="number" data-s="${section}" data-k="${k}" value="${esc(v)}" min="${min}"${max !== undefined ? ` max="${max}"` : ''} step="${step}">`;
  const bool = (section, k, v, text = 'on') => `<label><input type="checkbox" data-s="${section}" data-k="${k}" ${v ? 'checked' : ''}> ${text}</label>`;
  const select = (section, k, v, opts) => `<select data-s="${section}" data-k="${k}">${opts.map(([val, name]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>`;

  function callBox(c) {
    const cv = window.callVoice;
    const voices = 'speechSynthesis' in window ? speechSynthesis.getVoices().filter((v) => v.lang?.startsWith((navigator.language || 'en').slice(0, 2))) : [];
    const auto = cv?.pickVoice();
    const localVoice = cv?.local.browserVoice ?? '';
    const k = cv?.kokoro;
    const eleven = `$${(data.prices?.elevenPerMinute ?? 0.14).toFixed(2)}`;
    const engine = (val, name, help) => `<label><input type="radio" name="setEngine" data-s="call" data-k="engine" value="${val}" ${c.engine === val ? 'checked' : ''}> <b>${name}</b> <span class="meta">${help}</span></label>`;
    return `<div class="set-box"><h3>📞 Calls: voice and listening</h3>
      <div class="meta">How Talk sounds and hears you on a call. A call in progress picks changes up on its next sentence.</div>
      ${row('Voice', `<div class="set-engines">
          ${engine('browser', 'Browser voice', 'free and instant (the default). Edge&#39;s "Natural" voices are the best of these.')}
          ${engine('kokoro', 'Kokoro', 'free and more natural, made in your browser on WebGPU. Needs a fast graphics card: on Intel integrated graphics a short sentence takes 1–2.5 s, so many sentences fall back to the browser voice. The first call downloads the model once (about 330 MB) and keeps it. Try it with the test below.')}
          ${engine('eleven', 'ElevenLabs Flash', `premium, through Hawkes Gen: about ${eleven} a minute while Talk speaks, half a second more before the first word.`)}
        </div>`)}
      ${row('Kokoro voice', select('call', 'kokoroVoice', c.kokoroVoice, KOKORO), k?.state === 'ready' ? `Ready on this device: ${k.device === 'webgpu' ? 'WebGPU' : 'CPU (WebAssembly)'}, loaded in ${(k.loadMs / 1000).toFixed(1)} s.` : k?.state === 'failed' ? `Couldn't load here: ${esc(k.error)}` : '')}
      ${c.engine === 'eleven' ? row('ElevenLabs voice', `<select data-s="call" data-k="elevenVoice" id="setElevenVoice"><option value="${esc(c.elevenVoice)}">loading…</option></select>`) : ''}
      ${row('Browser voice <span class="meta">(this device)</span>', `<select id="setBrowserVoice"><option value="">Automatic (${esc(auto?.name ?? 'browser default')})</option>${voices.map((v) => `<option ${v.name === localVoice ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`, 'Used when the browser voice speaks (and as the fallback). Voices differ per device, so this one is kept in this browser.')}
      ${row('Speed', `<input type="range" data-s="call" data-k="rate" min="0.8" max="1.4" step="0.05" value="${c.rate}"> <span class="meta">${c.rate.toFixed(2)}×</span>`)}
      ${row('On a computer', select('call', 'mode.computer', c.mode.computer, [['push', 'Push to talk (hold the button or Space)'], ['hands-free', 'Hands-free (a pause sends)']]))}
      ${row('On a phone or tablet', select('call', 'mode.phone', c.mode.phone, [['push', 'Push to talk (hold the button)'], ['hands-free', 'Hands-free (a pause sends)']]))}
      ${row('Barge-in', bool('call', 'bargeIn', c.bargeIn, 'I use headphones: in hands-free, talking interrupts Talk'), 'Off: the mic is off while Talk speaks, so it never hears itself through the speakers. The hold-to-talk button always cuts Talk off.')}
      ${row('Pause before Talk answers', select('call', 'pause', c.pause, [[500, 'short'], [800, 'normal'], [1300, 'long']]), 'Hands-free: how long a silence ends what you say.')}
      ${row('Test', '<button class="small" id="setTestVoice">Say a sentence</button>', 'Plays a sentence with the chosen voice and measures it on this device (time to the first sound; for Kokoro, how fast it makes speech).')}
      <div id="setTestOut" class="set-test meta"></div>
    </div>`;
  }

  function brainBox(b) {
    const key = b.key ? 'XAI_API_KEY is set on this server.' : 'XAI_API_KEY is not set on this server yet. Grok cannot answer until it is in the hawkes/gen secret.';
    return `<div class="set-box"><h3>🧠 Brain</h3>
      <div class="meta">Who runs Talk, the PM, the agents and Gen's writing and review calls. Claude is Claude Code (the Max plan, or the API key). Grok is Grok 4.7 on xAI, billed per token. Switching takes effect on the next turn and the next agent; a session already running finishes on the brain that started it, unless Studio restarts onto the other one.</div>
      ${row('Brain', select('brain', 'id', b.id, [['claude', 'Claude'], ['grok', 'Grok 4.7']]), b.id === 'grok' ? `Model ${esc(b.model)}. ${key}` : 'Claude Code, on the model each role names.')}
    </div>`;
  }

  function agentsBox(a) {
    return `<div class="set-box"><h3>🤖 Agents</h3>
      <div class="meta">Limits for the fixes Studio starts by itself after the daily run. Fixes and tasks you ask for always start (they queue behind the concurrency limit). On the Max plan the dollars are what Claude Code reports, not money you pay.</div>
      ${row('Agents', bool('agents', 'enabled', a.enabled))}
      ${row('Auto-fix after the daily run', bool('agents', 'autoFix', a.autoFix))}
      ${row('Playtest beta after every merge', bool('agents', 'betaPlaytests', a.betaPlaytests), 'Off: beta is rebuilt after a change lands, and played only when you ask (Beta on a product, or Talk). The go-live check and the 5 AM daily run play either way. On: every merge into beta is played and reviewed, which keeps the playtester busy.')}
      ${row('Merge into beta automatically', bool('agents', 'autoMergeBeta', a.autoMergeBeta), 'A product change goes into its beta branch as soon as the agent finishes and its checks pass (no Approve card). Off: you merge each one from Changes. Going live stays your call either way.')}
      ${row('Severities auto-fixed', SEVERITIES.map((s) => `<label style="margin-right:10px"><input type="checkbox" data-s="agents" data-k="severities" value="${s}" ${a.severities.includes(s) ? 'checked' : ''}> ${s}</label>`).join(''))}
      ${row('At once', num('agents', 'maxConcurrent', a.maxConcurrent, { min: 1, max: 8 }))}
      ${row('At once per product', num('agents', 'perProduct', a.perProduct ?? 1, { min: 1, max: 4 }), 'A second change of the same product starts only when it won\'t step on the one running: a different task, not one it depends on, and a different area (art, levels, story, engine) or different files. More at once uses more of the Max plan.')}
      ${row('Per product overrides', `<input type="text" data-s="agents" data-k="productLimits" value="${esc(Object.entries(a.productLimits ?? {}).map(([p, n]) => `${p}: ${n}`).join(', '))}" placeholder="sickofit: 2">`, 'Product ids with their own number, like "sickofit: 2, phorigins: 1". Leave a product out to use the number above.')}
      ${row('Auto-fixes per day', num('agents', 'maxPerDay', a.maxPerDay))}
      ${row('Dollars per day (reported)', num('agents', 'maxCostPerDay', a.maxCostPerDay, { step: 1 }))}
      ${row('Model', `<input type="text" data-s="agents" data-k="model" value="${esc(a.model)}">`)}
      ${row('Turns per run', num('agents', 'maxTurns', a.maxTurns, { min: 10 }))}
      ${row('End a stuck agent after (minutes)', num('agents', 'idleMinutes', a.idleMinutes ?? 20), 'An agent with no new output this long, whose processes are only waiting or sleeping (no GPU job running), is ended and its change carries on. 0: never.')}
      ${row('Tell Talk when GPU jobs wait longer than (hours)', num('agents', 'genWaitHours', a.genWaitHours ?? 6, { min: 1 }), 'An agent whose Gen jobs are queued parks (it holds no agent slot) and is resumed when they finish. Waiting longer than this is said once in Talk; it never fails the task.')}
    </div>`;
  }

  function pmBox(p) {
    return `<div class="set-box"><h3>🗂 PM loop</h3>
      <div class="meta">Talk as your PM: it starts roadmap tasks and the worst bugs within these limits, and merges into beta what passes its checks (never live). Every change here is in the PM log, with undo.</div>
      ${row('Walk-away mode', bool('pm', 'walkAway', p.walkAway, 'on: Studio decides routine calls'), 'On: Studio and Gen changes merge into main by themselves once typecheck, tests, the smoke check and CI are green (red CI goes back to its agent; protected files still wait for you), the PM decides criteria misses itself, and your Inbox keeps only going live, rollbacks, new GPU servers, spend above the caps, protected files, failures after all tries, milestones and real direction questions. Off: everything waits for you as before.')}
      ${row('Walk-away GPU budgets per day ($)', num('pm', 'walkAwayGpuPerDay', p.walkAwayGpuPerDay ?? 25, { step: 5 }), 'In walk-away mode Studio approves GPU budgets under the per-task limit (Budgets) up to this much a day; above it, one card a day in your Inbox.')}
      ${row('PM loop', bool('pm', 'enabled', p.enabled, 'running'))}
      ${row('Delegated merges into beta', bool('pm', 'delegatedMerges', p.delegatedMerges))}
      ${row('Starts per day', num('pm', 'maxStartsPerDay', p.maxStartsPerDay))}
      ${row('Agents at once', num('pm', 'maxConcurrent', p.maxConcurrent, { min: 1, max: 8 }))}
      ${row('Tries before asking you', num('pm', 'maxTries', p.maxTries, { min: 1, max: 10 }))}
      ${row('Fix bugs when no task can start', bool('pm', 'fixBugs', p.fixBugs))}
      ${row('Daily PM turn after (hour)', num('pm', 'dailyHour', p.dailyHour, { min: 0, max: 23 }))}
      ${row('Minutes a ready change waits', num('pm', 'graceMinutes', p.graceMinutes))}
    </div>`;
  }

  function notifyBox(n) {
    return `<div class="set-box"><h3>🔔 Phone notifications</h3>
      <div class="meta">Only what went wrong, decisions only you can make, and milestones reached. Install the <b>ntfy</b> app (Android or iPhone), tap +, and subscribe to this topic${n.server !== 'https://ntfy.sh' ? ` on server <code>${esc(n.server)}</code>` : ''}. Keep it secret: anyone with the name can read them.</div>
      ${row('Topic', `<code class="notify-topic">${esc(n.topic)}</code> <button class="small" id="notifyCopy">Copy</button> <a href="${esc(n.subscribe)}" target="_blank" rel="noopener">open</a>`)}
      ${row('Notifications', bool('notify', 'enabled', n.enabled))}
      ${row('', '<button class="small" id="notifyTest">Send a test</button> <button class="small" id="notifyRotate">New topic</button> <span id="notifyMsg" class="meta"></span>')}
    </div>`;
  }

  function costsBox(c) {
    return `<div class="set-box"><h3>💵 Budgets</h3>
      <div class="meta">The month's budget for AWS and pay-per-use APIs, the GPU budgets Studio approves by itself, and when a server counts as left running. Spending and subscriptions are on the <a href="#costs" data-go="costs">Costs</a> tab.</div>
      ${row('Monthly budget ($)', num('costs', 'budget', c.budget, { step: 5 }))}
      ${row('Cost alerts to your phone', bool('costs', 'alerts', c.alerts))}
      ${row('Approve GPU tasks under ($, 0 = always ask)', num('costs', 'gpuAutoApprove', c.gpuAutoApprove, { step: 1 }))}
      ${row('GPU server left running after (h)', num('costs', 'gpuHours', c.gpuHours, { step: 0.5 }))}
      ${row('Build server left running after (h)', num('costs', 'builderHours', c.builderHours, { step: 0.5 }))}
      ${row('Playtester left running after (h)', num('costs', 'playtesterHours', c.playtesterHours, { step: 0.5 }))}
    </div>`;
  }

  function resourcesBox(r) {
    if (!r) return '';
    return `<div class="set-box"><h3>🖥️ Server alerts</h3>
      <div class="meta">When your phone hears about the control server or an idle machine. Everything else is on the <a href="#resources" data-go="resources">Resources</a> tab.</div>
      ${row('Server alerts to your phone', bool('resources', 'alerts', r.alerts))}
      ${row('Memory over (%)', num('resources', 'memoryPct', r.memoryPct, { min: 50, max: 99 }))}
      ${row('Disk over (%)', num('resources', 'diskPct', r.diskPct, { min: 50, max: 99 }))}
      ${row('…for at least (minutes)', num('resources', 'minutes', r.minutes, { min: 1, max: 120 }))}
      ${row('A machine idle past its stop time by (minutes)', num('resources', 'pastStopMinutes', r.pastStopMinutes, { min: 0, max: 240 }), 'A GPU server, the build server or the playtester that should have stopped itself and is still running.')}
    </div>`;
  }

  async function loadSettingsTab() {
    data = await api('/api/settings');
    window.callVoice?.apply(data.call);
    const badge = $('#walkAwayBadge');
    if (badge) badge.hidden = !data.pm.walkAway;
    $('#setBody').innerHTML = `<div class="set-grid">${brainBox(data.brain)}${callBox(data.call)}${agentsBox(data.agents)}${pmBox(data.pm)}${notifyBox(data.notify)}${costsBox(data.costs)}${resourcesBox(data.resources)}</div>`;
    if (data.call.engine === 'eleven') loadElevenVoices();
  }
  window.loadSettingsTab = loadSettingsTab;

  async function loadElevenVoices() {
    const sel = $('#setElevenVoice');
    if (!sel) return;
    try {
      const r = await fetch(`${GEN}/v1/providers/elevenlabs/voices`).then((x) => x.json());
      const list = (r.voices ?? []).filter((v) => ['premade', 'professional', 'cloned', 'generated'].includes(v.category));
      sel.innerHTML = list.map((v) => `<option value="${esc(v.id)}" ${v.id === data.call.elevenVoice ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
      if (!data.call.elevenVoice && list[0]) await save('call', { elevenVoice: list[0].id }, sel);
    } catch (e) {
      sel.innerHTML = `<option>couldn't load: ${esc(e.message)}</option>`;
    }
  }

  function mark(target, ok, text) {
    const host = target.closest('.set-row > div:nth-child(2)') ?? target.parentElement;
    host.querySelectorAll('.set-saved, .set-err').forEach((x) => x.remove());
    const s = document.createElement('span');
    s.className = ok ? 'set-saved' : 'set-err';
    s.textContent = text;
    host.appendChild(s);
    if (ok) setTimeout(() => s.remove(), 1800);
  }

  async function save(section, patch, target) {
    try {
      const r = await api('/api/settings', { method: 'POST', body: { section, patch } });
      data[section] = r.settings;
      if (section === 'pm' && $('#walkAwayBadge')) $('#walkAwayBadge').hidden = !r.settings.walkAway;
      if (section === 'call') window.callVoice?.apply(r.settings);
      mark(target, true, 'Saved');
      return r.settings;
    } catch (e) {
      mark(target, false, e.message);
      return null;
    }
  }

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t.closest?.('#setBody')) return;
    if (t.id === 'setBrowserVoice') { window.callVoice?.setLocal({ browserVoice: t.value }); return mark(t, true, 'Saved on this device'); }
    const section = t.dataset.s, k = t.dataset.k;
    if (!section || !k) return;
    let v = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' || k === 'pause' ? Number(t.value) : t.value;
    if (section === 'agents' && k === 'severities') v = [...document.querySelectorAll('#setBody input[data-k="severities"]:checked')].map((x) => x.value);
    if (section === 'agents' && k === 'productLimits') {
      // "sickofit: 2, phorigins: 1"; a product left out drops its override (null).
      v = Object.fromEntries(Object.keys(data.agents.productLimits ?? {}).map((p) => [p, null]));
      for (const part of t.value.split(',').map((x) => x.trim()).filter(Boolean)) {
        const m = /^([a-z0-9-]+)\s*[:=]\s*(\d+)$/i.exec(part);
        if (!m) return mark(t, false, `"${part}": write it as product: number`);
        v[m[1]] = Number(m[2]);
      }
    }
    const patch = k.startsWith('mode.') ? { mode: { [k.slice(5)]: v } } : { [k]: v };
    const saved = await save(section, patch, t);
    // Choosing a voice engine changes what the box shows (the ElevenLabs voices, Kokoro's state).
    if (saved && section === 'call' && (k === 'engine' || k === 'rate')) loadSettingsTab();
    if (saved && section === 'brain') loadSettingsTab();
  });
  document.addEventListener('input', (e) => {
    if (e.target.matches?.('#setBody input[type=range]')) e.target.nextElementSibling.textContent = `${Number(e.target.value).toFixed(2)}×`;
  });
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset?.go) { e.preventDefault(); show(t.dataset.go); return; }
    if (t.id === 'setTestVoice') {
      const out = $('#setTestOut');
      out.textContent = window.callVoice?.settings.engine === 'kokoro' && window.callVoice.kokoro.state !== 'ready' ? 'Loading Kokoro (the first time downloads the model)…' : 'Speaking…';
      t.disabled = true;
      try {
        const r = await window.callVoice.testVoice();
        const lines = [];
        if (r.load) lines.push(r.load.ok ? `Kokoro ready in ${(r.load.ms / 1000).toFixed(1)} s on ${r.load.device === 'webgpu' ? 'WebGPU' : 'the CPU (WebAssembly)'} (${r.load.dtype}).` : `Kokoro couldn't load: ${r.load.error}`);
        for (const s of r.sentences ?? []) lines.push(`${s.chars} characters → ${s.audioSeconds} s of speech in ${(s.ms / 1000).toFixed(2)} s (real-time factor ${s.rtf}${s.rtf < 1 ? ', keeps up' : ', slower than speech'})`);
        if (r.firstSoundMs !== undefined) lines.push(`First sound after ${(r.firstSoundMs / 1000).toFixed(2)} s, voice: ${r.voice}.`);
        out.innerHTML = `<pre>${esc(lines.join('\n'))}</pre>`;
        if (r.load) loadSettingsTab().then(() => ($('#setTestOut').innerHTML = `<pre>${esc(lines.join('\n'))}</pre>`));
      } catch (err) {
        out.textContent = err.message;
      } finally {
        t.disabled = false;
      }
    }
    const msg = (x) => { const m = $('#notifyMsg'); if (m) m.textContent = x; };
    try {
      if (t.id === 'notifyTest') { await api('/api/notify/test', { method: 'POST', body: {} }); msg('Sent.'); }
      if (t.id === 'notifyCopy') { await navigator.clipboard.writeText($('.notify-topic').textContent); msg('Copied.'); }
      if (t.id === 'notifyRotate' && confirm('Make a new topic? You will have to subscribe again.')) { await save('notify', { rotate: true }, t); await loadSettingsTab(); }
    } catch (err) { msg(err.message); }
  });
  window.speechSynthesis?.addEventListener?.('voiceschanged', () => { if (tab === 'settings' && data) loadSettingsTab(); });
  // Opened straight on #settings: app.js's first refresh ran before this file loaded.
  if (tab === 'settings') loadSettingsTab().catch((e) => ($('#setBody').textContent = e.message));
})();
