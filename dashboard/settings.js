// The ⚙ Settings tab: every setting in one place (GET/POST /api/settings, src/settings.ts), stored in Studio so it
// follows J from his laptop to his phone. The harness, Claude accounts (signing in and switching), calls (voice and
// listening), agents, the PM loop, phone notifications, budgets. Only the browser voice's name is kept in this browser (voices differ per device). Uses app.js's helpers
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
    .ca-add { padding: 8px 0 2px; display: grid; gap: 6px; }
    .ca-line { display: flex; gap: 8px; flex-wrap: wrap; } .ca-line input { flex: 1 1 180px; min-width: 0; }
    .set-box input#caLabel, .set-box input#caCode { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; color: inherit; }
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
    const key = b.key ? 'Cursor is signed in (or its key is on this server).' : 'Cursor is not signed in yet: Sign in under AI providers (your Cursor plan), or put CURSOR_API_KEY in the hawkes/cursor secret.';
    const cop = b.copilot ? 'A Copilot token or login is on this server.' : 'No Copilot login on this server yet: put a fine-grained token (Copilot Requests permission) in COPILOT_GITHUB_TOKEN, or run copilot login there. See docs/copilot.md.';
    const gem = b.gemini ? 'A Gemini API key is on this server (billed on that key, not the Google AI plan).' : 'No Gemini API key on this server yet: set GEMINI_API_KEY (deploy/gemini-key.mjs). Google AI Pro/Ultra sign-ins use the Antigravity harness instead. See docs/gemini.md.';
    const agy = b.antigravity ? 'Antigravity is signed in with a Google account on this server.' : 'Antigravity (agy) is not signed in on this server yet: use "Sign in with Google" in the Antigravity login box below.';
    const models = b.harness === 'cursor'
      ? [['auto', 'Auto'], ['grok-4.7', 'Grok 4.7'], ['composer-2.5', 'Composer 2.5']]
      : b.harness === 'antigravity'
        ? [['', 'Antigravity default'], ['gemini-4-argon-high', 'Gemini 4 Argon (High)'], ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'], ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'], ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'], ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)'], ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)']]
      : b.harness === 'gemini'
        ? [['', 'Auto (Gemini picks)'], ['pro', 'Pro'], ['flash', 'Flash'], ['flash-lite', 'Flash-Lite']]
        : b.harness === 'codex'
        ? [['', 'Codex default'], [':low', 'Default, low effort'], [':medium', 'Default, medium effort'], [':high', 'Default, high effort'], [':xhigh', 'Default, extra high effort']]
        : b.harness === 'copilot'
        ? [['', 'Copilot’s default'], ['claude-sonnet-4.5', 'Claude Sonnet 4.5'], ['claude-haiku-4.5', 'Claude Haiku 4.5'], ['gpt-5.4', 'GPT-5.4']]
        : [['', 'Each role’s model'], ['claude-opus-5-5', 'Opus'], ['claude-sonnet-5-5', 'Sonnet'], ['claude-haiku-5-5', 'Haiku']];
    const note = b.harness === 'codex' ? (b.codex ? 'OpenAI Codex is signed in with a ChatGPT account on this server.' : 'Codex is not signed in yet: Sign in under AI providers.') : b.harness === 'cursor' ? key : b.harness === 'copilot' ? cop : b.harness === 'gemini' ? gem : b.harness === 'antigravity' ? agy : 'Claude Code, signed in with the Claude account.';
    const stand = b.failover ? ` <b>${b.harness} is standing in</b> for ${b.chosen} until it answers again.` : '';
    return `<div class="set-box"><h3>🧠 Harness and model</h3>
      <div class="meta">What runs Talk, the PM, the agents and Gen's writing and review calls. Claude Code is the original harness.       OpenAI Codex, Cursor, GitHub Copilot and Google Antigravity run on their plans (the Gemini API key bills a key). If the one you pick is out of usage, has a billing error or is down, Studio tries the others in the order in AI providers and goes back by itself. Switching takes effect on the next turn and the next agent; a session already running is restarted on the harness you pick.${stand}</div>
            ${row('Harness', select('brain', 'harness', b.harness, [['claude', 'Claude Code'], ['codex', 'OpenAI Codex (ChatGPT plan)'], ['cursor', 'Cursor'], ['copilot', 'GitHub Copilot'], ['antigravity', 'Google Antigravity (AI Ultra)'], ['gemini', 'Gemini API key']]), note)}
      ${row('Model', select('brain', 'model', b.model, models), b.harness === 'cursor' ? 'Auto is Cursor’s router (keeps going when premium usage is out). Grok and Composer are pinned models.' : b.harness === 'copilot' ? 'Copilot’s own model ids; the default is what your plan picks.' : b.harness === 'claude' && b.model && data.routing?.enabled ? '<b>Not used while Model routing is on:</b> each run gets its routed model (Haiku, Sonnet, Opus when it climbs, Fable when you ask). Turn routing off to pin this model for every run.' : 'Leave this on each role’s model, or pick one for every role.')}
    </div>`;
  }

  // Claude accounts (src/claude-accounts.ts): the logins Claude Code runs with. Signing in runs `claude setup-token` on
  // the server; J opens its link, signs in, and pastes the code back here. Changes send X-Studio-Click (J's click only).
  let claude = null;
  const claudeCall = async (path, opts = {}) => {
    const r = await fetch(path, { ...opts, headers: { 'X-Studio-Click': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const d = await r.json().catch(() => ({ error: `Studio answered ${r.status}` }));
    if (!r.ok || d.error) throw new Error(d.error ?? `Studio answered ${r.status}`);
    return d;
  };
  const day = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  function claudeBox(c, brain) {
    if (!c) return '';
    const si = c.signin;
    const rows = c.accounts.map((a) => {
      const left = a.expires ? Math.round((a.expires - Date.now()) / 86_400_000) : null;
      const exp = left === null ? '' : left < 0 ? ' · <span class="set-err">expired</span>' : left < 30 ? ` · <span class="set-err">expires in ${left} d</span>` : ` · good until ${day(a.expires)}`;
      const chk = a.check ? `${a.check.ok ? '✓' : '⚠'} ${esc(a.check.note)} (checked ${ago(a.check.at)})` : '';
      return `<div class="set-row" data-ca="${a.id}"><div><b>${esc(a.label)}</b>${a.active ? ' <span class="set-saved" style="margin:0">● in use</span>' : ''}<div class="meta">…${esc(a.tail)} · added ${day(a.added)}${exp}</div></div>
        <div>${a.active ? '' : '<button class="small" data-caact="use">Use this account</button> '}<button class="small" data-caact="check">Check</button> <button class="small" data-caact="rename">Rename</button>${a.active ? '' : ' <button class="small" data-caact="remove">Remove</button>'}</div>
        ${chk ? `<div class="help">${chk}</div>` : ''}</div>`;
    }).join('');
    const waiting = si && si.state === 'waiting';
    const signinRow = waiting
      ? `<div class="ca-add"><b>Signing in${si.label ? `: ${esc(si.label)}` : ''}</b>
          <div>1. <a href="${esc(si.url)}" target="_blank" rel="noopener"><b>Open Claude's sign-in page</b></a> and sign in with that account.</div>
          <div>2. Claude shows a code. Paste it here:</div>
          <div class="ca-line"><input type="text" id="caCode" placeholder="the code from Claude" autocomplete="off" spellcheck="false"><button class="small" id="caFinish">Finish signing in</button><button class="small" id="caCancel">Cancel</button></div>
          <div id="caMsg" class="meta"></div>
          <div class="meta">The new account is used as soon as it is saved. Signed in to the wrong account in your browser? Sign out on claude.ai first, or open the link in a private window.</div></div>`
      : `<div class="ca-add"><b>Add an account</b>
          <div class="ca-line"><input type="text" id="caLabel" placeholder="A name for it, e.g. your email"><button class="small" id="caStart">Sign in to a Claude account</button></div>
          <div id="caMsg" class="meta">${si?.state === 'failed' && si.error ? `<span class="set-err">${esc(si.error)}</span>` : ''}</div>
          <div class="meta">Runs Claude&#39;s own sign-in on the server and gives you its link. Each sign-in is a 1-year login, kept here so you can switch back to it.</div></div>`;
    // A customer's Studio (GET /api/claude/accounts customer, claude.ts): their own Claude only, a subscription signed
    // in below or their own Anthropic API key here; never this server's.
    const cu = c.customer;
    const keyRow = cu ? `<div class="ca-add"><b>Your Claude</b>
          <div class="meta">${cu.ready ? `Running on your ${cu.via === 'api-key' ? `API key (…${esc(cu.keyTail)})` : 'Claude subscription'}.` : '<span class="set-err">No Claude yet:</span> Talk and agents wait until you sign in a Claude account below or add your Anthropic API key.'}</div>
          <div class="ca-line"><input type="password" id="ckKey" placeholder="sk-ant-api03-…" autocomplete="off" spellcheck="false"><button class="small" id="ckSave">Save API key</button>${cu.keyTail ? '<button class="small" id="ckRemove">Remove key</button>' : ''}</div>
          <div id="ckMsg" class="meta">Billed by Anthropic to you. Kept on your Studio only; never shown again.</div></div>` : '';
    return `<div class="set-box"><h3>🔑 ${cu ? 'Your Claude' : 'Claude accounts'}</h3>${keyRow}
      <div class="meta">The Claude login that Talk, the PM, agents, scouts and Gen's Claude calls run on. Switching takes effect on the next turn, agent and Gen call; work already running finishes on the account it started with.${brain.harness !== 'claude' ? ` <b>The harness is ${brain.harness === 'copilot' ? 'Copilot' : brain.harness === 'gemini' ? 'Gemini' : brain.harness === 'antigravity' ? 'Antigravity' : 'Cursor'} now:</b> using or adding an account switches it to Claude Code.` : ''}</div>
      ${rows || '<div class="meta" style="padding:6px 0">No Claude account on this server yet.</div>'}
      ${signinRow}
    </div>`;
  }

  // Antigravity's Google login (src/antigravity-login.ts): `agy` runs on the server, J opens Google's link, signs in and
  // pastes the code back here. Studio shares the login with the agent user. Changes send X-Studio-Click (J's click only).
  let agyLogin = null;
  function agyBox(l) {
    if (!l) return '';
    const si = l.signin;
    const waiting = si && si.state === 'waiting';
    const state = l.signedIn ? `✓ Signed in${l.email ? ` as <b>${esc(l.email)}</b>` : ''}. Talk, agents and scouts all use this login.` : '<span class="set-err">Not signed in.</span> Antigravity can\'t run until you sign in.';
    const body = waiting
      ? `<div class="ca-add"><b>Signing in</b>
          <div>1. <a href="${esc(si.url)}" target="_blank" rel="noopener"><b>Open Google's sign-in page</b></a> and sign in with your Google AI Ultra account.</div>
          <div>2. Google shows a code. Paste it here:</div>
          <div class="ca-line"><input type="text" id="agyCode" placeholder="the code from Google" autocomplete="off" spellcheck="false"><button class="small" id="agyFinish">Finish signing in</button><button class="small" id="agyCancel">Cancel</button></div>
          <div id="agyMsg" class="meta"></div></div>`
      : `<div class="ca-add"><div class="ca-line"><button class="small" id="agyStart">${l.signedIn ? 'Sign in again (another Google account)' : 'Sign in with Google'}</button></div>
          <div id="agyMsg" class="meta">${si?.state === 'failed' && si.error ? `<span class="set-err">${esc(si.error)}</span>` : ''}</div></div>`;
    return `<div class="set-box"><h3>🔑 Antigravity login</h3>
      <div class="meta">${state}</div>
      ${body}
    </div>`;
  }

  // Every AI provider at once (src/providers.ts, src/cli-signin.ts; J, 2026-11-09: "able to easily switch between
  // providers or even use multiple providers at once"). Cursor, Codex and Copilot sign in with their own device page:
  // Studio runs the CLI's login on the server and shows its link (and code); J signs in on the provider's page and the box
  // updates by itself through the push stream. Studio keeps the login server side, never shown. Changes are J's click.
  let providers = null;
  const PROV_ROLES = [['fixer', 'Fixer'], ['builder', 'Builder'], ['content', 'Content'], ['scout', 'Scouts']];
  function providersBox(pv) {
    if (!pv) return '';
    const login = (id) => pv.logins?.find((l) => l.provider === id);
    const order = pv.providers.map((x) => x.id);
    const rows = pv.providers.map((x, i) => {
      const l = login(x.id);
      const si = l?.signin;
      const state = x.ready
        ? `<span style="color:var(--accent)">✓ answering</span>${` · ${x.busy ?? 0} of ${x.cap ?? '?'} running`}${l?.account ? ` · ${esc(l.account)}` : ''}`
        : x.hold
          ? `<span class="set-err">${esc(x.hold.why)}</span>${x.hold.needsYou ? '' : ` · back by itself ${x.hold.resets ? 'when it resets' : 'once it answers'}`}`
          : `<span class="meta">${esc(x.why ?? '')}</span>`;
      let act = '';
      if (l) {
        if (si && (si.state === 'waiting' || si.state === 'starting')) {
          act = si.url
            ? `<div class="ca-add"><div>1. <a href="${esc(si.url)}" target="_blank" rel="noopener"><b>Open ${esc(l.label)}'s sign-in page</b></a> and sign in with the account on ${esc(l.plan)}.</div>
                ${si.code ? `<div>2. Enter this code there: <b style="font-size:16px;letter-spacing:1px;user-select:all">${esc(si.code)}</b></div>` : ''}
                <div class="meta">This box updates by itself when ${esc(l.label)} says you're in.</div>
                <div class="ca-line"><button class="small" data-aicancel="${x.id}">Cancel</button></div></div>`
            : '<div class="meta">Starting the sign-in on the server…</div>';
        } else {
          act = `<button class="small" data-aisignin="${x.id}" ${l.installed ? '' : 'disabled title="Its CLI isn\'t on this server yet"'}>${l.signedIn ? 'Sign in again' : 'Sign in'}</button>${l.signedIn ? ` <button class="small" data-aisignout="${x.id}">Sign out</button>` : ''}`
            + (si?.state === 'failed' && si.error ? `<div class="set-err">${esc(si.error)}</div>` : '');
        }
      } else if (x.id === 'antigravity') act = '<span class="meta">Sign in with Google in the Antigravity box.</span>';
      else if (x.id === 'claude') act = '<span class="meta">Claude accounts box.</span>';
      else if (x.id === 'gemini') act = '<span class="meta">API key only (GEMINI_API_KEY): Google no longer lets the Gemini CLI use a personal plan. The plan runs through Antigravity.</span>';
      return `<div class="set-row" data-aiprov="${x.id}"><div><label><input type="checkbox" data-aiuse="${x.id}" ${x.on ? 'checked' : ''}> <b>${esc(x.label)}</b></label>
          ${i > 0 ? ` <button class="small" data-aiup="${x.id}" title="Try earlier">↑</button>` : ''}<div class="meta">${state}</div></div>
        <div>${act}</div></div>`;
    }).join('');
    const ready = pv.providers.filter((x) => x.ready).map((x) => x.label);
    const roleSel = PROV_ROLES.map(([r, name]) => `${name} <select data-airole="${r}"><option value="">any</option>${pv.providers.map((x) => `<option value="${x.id}" ${pv.roles?.[r] === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`).join(' &nbsp; ');
    return `<div class="set-box" id="setProvidersBox"><h3>🔌 AI providers</h3>
      <div class="meta">${pv.mode === 'spread'
        ? `Every provider that's signed in takes agent work at once, code work on the best one in this order that has room under its limit, scouts on the least busy (now: ${ready.length ? esc(ready.join(', ')) : '<span class="set-err">none</span>'}). When one runs out of usage, is signed out or down, its work moves to the others and it comes back by itself. Talk stays on the harness above.`
        : `Everything runs on the harness above; when it's held, the next provider in this order stands in until it answers again.`}
        You hear about it in the Inbox only when one needs you (signed out or billing) or none can run.</div>
      ${row('Use', `<select data-aimode><option value="spread" ${pv.mode === 'spread' ? 'selected' : ''}>Every signed-in provider at once</option><option value="one" ${pv.mode === 'one' ? 'selected' : ''}>One at a time (the harness above, others stand in)</option></select>`)}
      ${rows}
      ${row('Provider per role', roleSel, 'Pins a role to a provider while it answers; otherwise the least busy one takes it. The models each tier uses per provider are in Advanced → Agent tuning.')}
      <div id="aiMsg" class="meta"></div>
    </div>`;
  }
  async function refreshProviders() {
    providers = await api('/api/ai/providers').catch(() => null);
    const box = $('#setProvidersBox');
    if (box && providers) box.outerHTML = providersBox(providers);
  }
  const aiDo = async (t, fn) => {
    const m = $('#aiMsg');
    try {
      if (t) t.disabled = true;
      await fn();
      await refreshProviders();
    } catch (err) {
      const mm = $('#aiMsg');
      if (mm) mm.innerHTML = `<span class="set-err">${esc(err.message)}</span>`;
      else if (m) m.innerHTML = `<span class="set-err">${esc(err.message)}</span>`;
      if (t) t.disabled = false;
    }
  };
  // Pushed when a sign-in shows its link, finishes or fails, a hold starts or lifts, or J changes the order.
  studioStream.on('ai-logins', () => { if (tab === 'settings' && $('#setProvidersBox')) void refreshProviders(); });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.closest?.('#setProvidersBox')) return;
    if (t.dataset.aiuse) return aiDo(t, () => claudeCall('/api/ai/providers', { method: 'POST', body: { use: { [t.dataset.aiuse]: t.checked } } }));
    if (t.hasAttribute('data-aimode')) return aiDo(t, () => claudeCall('/api/ai/providers', { method: 'POST', body: { mode: t.value } }));
    if (t.dataset.airole) return aiDo(t, () => claudeCall('/api/ai/providers', { method: 'POST', body: { roles: { [t.dataset.airole]: t.value } } }));
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('#setProvidersBox button');
    if (!t) return;
    const id = t.dataset.aisignin || t.dataset.aisignout || t.dataset.aicancel || t.dataset.aiup;
    if (t.dataset.aisignin) return aiDo(t, async () => { $('#aiMsg').textContent = 'Starting the sign-in on the server…'; await claudeCall('/api/ai/signin', { method: 'POST', body: { provider: id } }); });
    if (t.dataset.aicancel) return aiDo(t, () => claudeCall('/api/ai/signin/cancel', { method: 'POST', body: { provider: id } }));
    if (t.dataset.aisignout && confirm('Sign out? Studio forgets this login here and stops using the provider until you sign in again.')) return aiDo(t, () => claudeCall('/api/ai/signout', { method: 'POST', body: { provider: id } }));
    if (t.dataset.aiup && providers) {
      const order = providers.providers.map((x) => x.id);
      const i = order.indexOf(id);
      if (i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
      return aiDo(t, () => claudeCall('/api/ai/providers', { method: 'POST', body: { order } }));
    }
  });

  async function claudeAction(fn, target) {
    const msg = $('#caMsg');
    try {
      if (target) target.disabled = true;
      await fn();
      await loadSettingsTab();
    } catch (err) {
      if (msg) msg.innerHTML = `<span class="set-err">${esc(err.message)}</span>`;
      else alert(err.message);
      if (target) target.disabled = false;
    }
  }

  function agentsBox(a) {
    return `<div class="set-box"><h3>🤖 Agents</h3>
      <div class="meta">Limits for the fixes Studio starts by itself after the daily run. Fixes and tasks you ask for always start (they queue behind the concurrency limit). On the Max plan the dollars are what Claude Code reports, not money you pay.</div>
      ${row('Agents', bool('agents', 'enabled', a.enabled))}
      ${row('Auto-fix after the daily run', bool('agents', 'autoFix', a.autoFix))}
      ${row('Work on a bad verdict by itself', bool('agents', 'autoWorkVerdicts', a.autoWorkVerdicts), 'A review or playtest that ends "fix first" or "broken" starts a fix agent on the bugs behind it, without you asking, within the limits below. If it can\'t (no bug to fix, a limit reached, won\'t fix, a dead live address) it files one Inbox card saying why.')}
      ${row('Re-check beta after a fix merges', bool('agents', 'autoReverify', a.autoReverify), 'When a fix lands in beta, beta is played and reviewed once (a burst of merges costs one playtest), so the project\'s label reflects the new commit instead of the old review.')}
      ${row('When beta is playtested', select('agents', 'betaPlayWhen', a.betaPlayWhen ?? 'go-live', [['go-live', 'Once, before it goes live'], ['merge', 'After fixes merge too']]), 'Once, before it goes live: merges and fixes land on beta without a playtest; when a project set to go live by itself has nothing else holding it, beta is played once, covering every merge since its last play, and goes live if it passes. The daily playtest runs either way, and Beta on a product always plays. After fixes merge too: beta is also played after fix merges and when credits come back.')}
      ${row('Playtest beta after every merge', bool('agents', 'betaPlaytests', a.betaPlaytests), 'Off: beta is rebuilt after a change lands, and played only when you ask (Beta on a product, or Talk). The go-live check and the 5 AM daily run play either way. On: every merge into beta is played and reviewed, which keeps the playtester busy.')}
      ${row('Merge into beta automatically', bool('agents', 'autoMergeBeta', a.autoMergeBeta), 'A product change goes into its beta branch as soon as the agent finishes and its checks pass (no Approve card). Off: you merge each one from Changes. Going live stays your call either way.')}
      ${row('Severities auto-fixed', SEVERITIES.map((s) => `<label style="margin-right:10px"><input type="checkbox" data-s="agents" data-k="severities" value="${s}" ${a.severities.includes(s) ? 'checked' : ''}> ${s}</label>`).join(''))}
      ${row('At once', num('agents', 'maxConcurrent', a.maxConcurrent, { min: 1, max: 8 }))}
      ${row('At once per product', num('agents', 'perProduct', a.perProduct ?? 1, { min: 1, max: 4 }), 'A second change of the same product starts only when it won\'t step on the one running: a different task, not one it depends on, and a different area (art, levels, story, engine) or different files. More at once uses more of the Max plan.')}
      ${row('Per product overrides', `<input type="text" data-s="agents" data-k="productLimits" value="${esc(Object.entries(a.productLimits ?? {}).map(([p, n]) => `${p}: ${n}`).join(', '))}" placeholder="sickofit: 2">`, 'Product ids with their own number, like "sickofit: 2, phorigins: 1". Leave a product out to use the number above.')}
      ${row('Auto-fixes per day', num('agents', 'maxPerDay', a.maxPerDay))}
      ${row('Dollars per day (reported)', num('agents', 'maxCostPerDay', a.maxCostPerDay, { step: 1 }))}
      ${row('Turns per run', num('agents', 'maxTurns', a.maxTurns, { min: 10 }))}
      ${row('End a stuck agent after (minutes)', num('agents', 'idleMinutes', a.idleMinutes ?? 20), 'An agent with no new output this long, whose processes are only waiting or sleeping (no GPU job running), is ended and its change carries on. 0: never.')}
      ${row('Tell Talk when GPU jobs wait longer than (hours)', num('agents', 'genWaitHours', a.genWaitHours ?? 6, { min: 1 }), 'An agent whose Gen jobs are queued parks (it holds no agent slot) and is resumed when they finish. Waiting longer than this is said once in Talk; it never fails the task.')}
    </div>`;
  }

  // Walk-away mode in a customer's Studio (src/walkaway.ts; J, 2026-11-01: "Make Walk Away mode available for Team
  // accounts"): the owner's own switch and GPU caps, on a plan with the PM (Team and up). Up top, not folded away.
  function walkAwayBox(p) {
    const locked = (window.studioMe?.entitlements?.locked ?? []).includes('pm');
    const lock = (html) => `<span data-pro="pm">${html}</span>`;
    const ro = (html) => (locked ? html.replace('<input', '<input readonly') : html);
    return `<div class="set-box"><h3>🚶 Walk-away mode</h3>
      <div class="meta">Let Studio keep building while you're away. The PM decides routine calls itself (a task that misses its acceptance criteria on beta gets another try, is parked, or gets one investigation when several miss the same way), ready changes merge into beta, and your Inbox keeps only what's yours: going live, rollbacks, GPU spending above your caps, failures after all tries, milestones and real direction questions. Every decision is in the PM log, with undo, and you get one summary a day. Going live always stays your call.${locked ? ' <b>On the Team plan and up</b> (it runs with the PM).' : ''}</div>
      ${row('Walk-away mode', lock(bool('pm', 'walkAway', p.walkAway, 'on: Studio decides routine calls')), 'Off: every decision waits for you, as before.')}
      ${row('GPU budgets Studio approves by itself: per task ($)', lock(ro(num('pm', 'walkAwayGpuPerTask', p.walkAwayGpuPerTask ?? 0, { step: 1 }))), '0: Studio never spends on GPU work by itself; every budget asks you. Above 0: in walk-away mode, a task whose GPU estimate is under this many dollars starts without asking.')}
      ${row('…and at most per day ($)', lock(ro(num('pm', 'walkAwayGpuPerDay', p.walkAwayGpuPerDay ?? 0, { step: 5 }))), 'What Studio approves by itself in a day, in all. Anything beyond it is one card a day in your Inbox.')}
    </div>`;
  }

  function pmBox(p) {
    const cu = window.studioMe?.customer;
    return `<div class="set-box"><h3>🗂 PM loop</h3>
      <div class="meta">Talk as your PM: it starts roadmap tasks and the worst bugs within these limits, and merges into beta what passes its checks (never live). Every change here is in the PM log, with undo.</div>
      ${cu ? '' : row('Walk-away mode', bool('pm', 'walkAway', p.walkAway, 'on: Studio decides routine calls'), 'On: Studio and Gen changes merge into main by themselves once typecheck, tests, the smoke check and CI are green (red CI goes back to its agent; protected files still wait for you), the PM decides criteria misses itself, and your Inbox keeps only going live, rollbacks, new GPU servers, spend above the caps, protected files, failures after all tries, milestones and real direction questions. Off: everything waits for you as before.')}
      ${cu ? '' : row('Walk-away GPU budgets per day ($)', num('pm', 'walkAwayGpuPerDay', p.walkAwayGpuPerDay ?? 25, { step: 5 }), 'In walk-away mode Studio approves GPU budgets under the per-task limit (Budgets) up to this much a day; above it, one card a day in your Inbox.')}
      ${row('PM loop', bool('pm', 'enabled', p.enabled, 'running'))}
      ${row('Delegated merges into beta', bool('pm', 'delegatedMerges', p.delegatedMerges))}
      ${row('Starts per day', num('pm', 'maxStartsPerDay', p.maxStartsPerDay))}
      ${row('Agents at once', num('pm', 'maxConcurrent', p.maxConcurrent, { min: 1, max: 8 }), 'The most agents the PM adds to. It is never lower than Agents → At once: the higher of the two applies, so raise Agents → At once to raise both.')}
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

  // Model routing (src/routing.ts, GET /api/routing): which model each piece of work gets, the climb on failure, the
  // day's Opus budget, conserve mode after a usage limit, and how the usage splits across tiers against the targets.
  let routing = null;
  const TIER_NAME = { fast: 'fast · Haiku', standard: 'standard · Sonnet', deep: 'deep · Opus', max: 'max · Fable' };
  function routingBox(s, st) {
    const u = st?.usage;
    const bar = (t) => {
      const [lo, hi] = t.target;
      const color = t.status === 'over' ? 'var(--red)' : t.status === 'under' ? 'var(--dim)' : 'var(--accent)';
      return `<div class="set-row"><div>${esc(TIER_NAME[t.tier] ?? t.tier)}</div><div>
        <div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:8px;border-radius:4px;background:var(--panel2);position:relative;overflow:hidden">
          <div style="position:absolute;left:${lo}%;width:${hi - lo}%;top:0;bottom:0;background:var(--line)"></div>
          <div style="position:absolute;left:0;width:${Math.min(100, t.share)}%;top:2px;bottom:2px;background:${color};border-radius:3px"></div>
        </div><span class="meta" style="min-width:9em">${t.share}% <span title="target">(${lo}–${hi}%)</span></span></div>
        <div class="meta">${t.passes} agent pass${t.passes === 1 ? '' : 'es'}, ${t.turns} Talk turn${t.turns === 1 ? '' : 's'}${t.status === 'over' ? ' · over its target' : ''}</div></div></div>`;
    };
    const rules = (st?.rules ?? []).map((r) => `<div class="set-row"><div>${esc(r.label)}</div><div class="meta">${esc(TIER_NAME[r.tier] ?? r.tier)}, ${esc(r.effort)} effort · on failure: ${esc(r.escalate)}</div></div>`).join('');
    const cats = (st?.categories ?? []).filter((c) => c.passes).map((c) => `${esc(c.category)} ${c.merged}/${c.changes} merged`).join(' · ');
    const premium = (st?.premium ?? []).map((p) => `<div class="meta">${esc(p.subject)}: ${p.tier === 'max' ? 'Fable' : 'Opus'} (${esc(p.by)}${p.words ? `: “${esc(p.words.slice(0, 80))}”` : ''}, ${esc(ago(p.at))}${p.used ? `, used ${p.used}×` : ''})</div>`).join('');
    return `<div class="set-box"><h3>🧭 Model routing: usage limits last</h3>
      <div class="meta">Each piece of work goes to the cheapest model likely to finish it, and climbs a tier only when an attempt fails. Opus runs for hard systems work within a daily budget; Fable runs only when you ask for it ("use Fable") in Talk. Talk's turns that just explain finished work run on Haiku.</div>
      ${row('Routing', bool('routing', 'enabled', s.enabled, 'route agent work by category'), 'Off: every role runs on its tier below (Tuning), one tier up on a retry.')}
      ${row('Tiers a failing change may climb', num('routing', 'maxEscalations', s.maxEscalations, { min: 0, max: 3 }), 'One per failed attempt (Haiku → Sonnet → Opus), carrying the earlier attempts’ notes. Past it, the agent is told to re-scope.')}
      ${row('Highest tier on its own', select('routing', 'ceiling', s.ceiling, [['deep', 'deep (Opus)'], ['standard', 'standard (Sonnet): Opus only when you ask']]), 'Fable is never chosen by itself.')}
      ${row('Automatic Opus passes a day', `${num('routing', 'deepPerDay', s.deepPerDay, { min: 0, max: 100 })} <span class="meta">${st ? `${st.deepToday} used today` : ''}</span>`, 'Past it, work that would go to Opus runs on Sonnet with more effort. Your own asks for Opus or Fable are not counted against it.')}
      ${row('Conserve after a usage limit (hours)', `${num('routing', 'conserveHours', s.conserveHours, { min: 0, max: 72 })} ${st?.conserve ? `<span class="set-err">conserving until ${esc(new Date(st.conserve.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>` : ''}`, 'When the plan hits a usage limit, automatic work stays on Sonnet or Haiku this long after it.')}
      ${row('Studio’s own Talk turns on Haiku', bool('routing', 'autoTurnsFast', s.autoTurnsFast), 'The turns Studio starts to tell you what finished work came back. Your own messages and PM turns keep their tier.')}
      ${u ? `<div class="meta" style="padding-top:8px"><b>Usage by tier</b>, last ${u.days} days (agents, Talk, scouts${u.total ? `; ${esc('$' + u.total.toFixed(2))} at API prices` : ''}): the band is the target</div>${u.tiers.map(bar).join('')}` : ''}
      ${cats ? `<div class="meta" style="padding-top:8px"><b>By category</b>: ${cats}</div>` : ''}
      ${premium ? `<div class="meta" style="padding-top:8px"><b>Your asks for a bigger model</b></div>${premium}` : ''}
      <details class="more-details" style="padding-top:8px"><summary class="meta">Categories and their tiers</summary>${rules}</details>
    </div>`;
  }

  function tuningBox(t) {
    const tiers = [['fast', 'fast (small model)'], ['standard', 'standard'], ['deep', 'deep (large model)'], ['max', 'max (Fable: costs the most)']];
    const efforts = [['', 'default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'extra high'], ['max', 'max']];
    const roleHelp = { talk: 'Talk (chat and calls)', pm: 'PM (plans and decides)', scout: 'Scout (read-only research)', reviewer: 'Reviewer (second opinions)', fixer: 'Fixer (bug fixes)', builder: 'Builder (features)', content: 'Content (art and assets)' };
    const roles = Object.keys(roleHelp).map((n) => {
      const r = t.roles[n];
      return `<div class="set-row"><div>${roleHelp[n]}</div><div>${select('tuning', `roles.${n}.tier`, r.tier, tiers)} ${select('tuning', `roles.${n}.effort`, r.effort, efforts)} ${num('tuning', `roles.${n}.maxTurns`, r.maxTurns, { min: 0, max: 500 })}</div></div>`;
    }).join('');
    const models = ['claude', 'codex', 'copilot', 'cursor', 'antigravity', 'gemini'].filter((h) => t.models[h]).map((h) => row(`${h === 'claude' ? 'Claude Code' : h === 'codex' ? 'OpenAI Codex' : h === 'copilot' ? 'Copilot' : h === 'gemini' ? 'Gemini API' : h === 'antigravity' ? 'Antigravity' : 'Cursor'} models`,
      ['fast', 'standard', 'deep', 'max'].map((k) => `<input type="text" data-s="tuning" data-k="models.${h}.${k}" value="${esc(t.models[h][k] ?? '')}" placeholder="${k}: default" size="18" title="${k}">`).join(' '))).join('');
    const jobs = Object.keys(t.jobs).map((j) => `${j} ${select('tuning', `jobs.${j}`, t.jobs[j], tiers)}`).join(' &nbsp; ');
    return `<div class="set-box"><h3>🎚️ Agent tuning: cost, speed, quality</h3>
      <div class="meta">How much model each job gets. Each role has a tier (which model), an effort (how hard it thinks) and a turn cap (0: the role file's own). The tiers map to real models per harness below. Raising anything here spends more.</div>
      ${row('Preset', select('tuning', 'preset', t.preset, [['economy', 'Economy: least spend, small models, low effort'], ['balanced', 'Balanced (default): mid model, deep only where it counts'], ['quality', 'Quality: deep model for building and judging'], ['custom', 'Custom (your own mix)']]), 'Choosing one sets every field below. Editing a field makes it Custom.')}
      <div class="meta" style="padding-top:8px"><b>Roles</b>: tier · effort · turn cap${data.routing?.enabled ? ' (with Model routing on, fixer, builder and content changes get their tier and effort from their route; the turn caps here still apply)' : ''}</div>
      ${roles}
      ${row('Retry on a deeper model', bool('tuning', 'escalateOnRetry', t.escalateOnRetry, 'a change on its second try or later uses the next tier up'), 'Cheap first, deeper only when the first try did not land. Never applied to Talk.')}
      ${row('One agent pass lasts at most (minutes)', `${num('tuning', 'passMinutes.standard', t.passMinutes.standard, { min: 5, max: 600 })} <span class="meta">content:</span> ${num('tuning', 'passMinutes.content', t.passMinutes.content, { min: 5, max: 720 })}`, 'A pass that runs out is stopped and resumed, not failed.')}
      <div class="meta" style="padding-top:8px"><b>Copilot</b>: billed per prompt times the model's multiplier (tool calls inside a run are free), so the model tier and the number of resumed passes cost, turns mostly don't.</div>
      ${row('Spend stop per run (AI credits)', num('tuning', 'copilot.maxCredits', t.copilot.maxCredits, { min: 0, max: 5000 }), 'The Copilot CLI stops a run that passes this (minimum 30, 0: no stop). One model call can overshoot it.')}
      ${row('Context window', select('tuning', 'copilot.contextTier', t.copilot.contextTier, [['default', 'default'], ['long_context', 'long (costs more per prompt)']]))}
      <div class="meta" style="padding-top:8px"><b>Models</b>: the model for each tier (empty: that harness's own default; Claude Code uses its tier ids, Copilot its dotted ids, Codex a model and/or :effort such as gpt-5.5:high)</div>
      ${models}
      <div class="meta" style="padding-top:8px"><b>Small jobs</b> (triage, dedupe, summaries, reviews, canon checks through Gen)</div>
      <div class="set-row"><div>${jobs}</div><div></div></div>
    </div>`;
  }

  // The Unity compile gate (src/compilecheck.ts): every Studio, on by default; nothing to set up.
  function buildsBox(b) {
    if (!b) return '';
    return `<div class="set-box"><h3>🧱 Unity builds</h3>
      <div class="meta">Before an agent's Unity change can merge into beta, Hawkes Gen compiles it with your project's own Unity version (minutes, no player build). A compile error goes back to the agent. Where Gen can't do that yet, the check is skipped and the change carries on.</div>
      ${row('Handle build failures by itself', bool('builds', 'handleFailures', b.handleFailures), 'A build that fails on a network hiccup is retried (3 tries over about 10 minutes) and you hear nothing unless all fail. A missing GitHub permission becomes one Inbox card with the exact fix, and Studio rebuilds when it is back.')}
      ${row('Compile Unity changes before they merge', bool('builds', 'unityCompile', b.unityCompile), 'Turning it on costs a build-machine run per change, so it asks for your yes in Talk.')}
      ${row('Stop checking when a run averages over ($)', num('builds', 'unityCompileMaxCost', b.unityCompileMaxCost, { min: 0.1, max: 100, step: 0.5 }), 'Studio measures each run. Above this average the check is skipped and says so.')}
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
      ${row('Portal health failing for (minutes)', num('resources', 'portalMinutes', r.portalMinutes, { min: 1, max: 60 }), 'hawkesgen.ai/v1/health not answering this long in a row. A relay node that is down is told at once.')}
      ${row('Portal event-loop delay p99 over (ms)', num('resources', 'loopP99Ms', r.loopP99Ms, { min: 20, max: 5000 }), 'Needs the portal admin key.')}
      ${row('…held for (minutes)', num('resources', 'loopMinutes', r.loopMinutes, { min: 1, max: 120 }), '')}
      ${row('Portal WebSockets over (% of the cap)', num('resources', 'wsPct', r.wsPct, { min: 10, max: 100 }), '')}
      ${row('Portal backup older than (hours)', num('resources', 'backupHours', r.backupHours, { min: 1, max: 72 }), '')}
    </div>`;
  }

  // Playtests at once and the GPU providers' order (src/playtest-capacity.ts): Hawkes Gen holds them; this box shows what
  // Gen applied and each provider's limit or why it can't be used. The studio's own: not shown in a customer's Studio.
  function playtestsBox(p) {
    if (!p) return '';
    const g = p.gen ?? { state: 'offline', providers: [] };
    const asked = p.wanted?.browsers;
    const status = g.state === 'ok'
      ? `Hawkes Gen runs <b>${esc(p.browsers ?? '?')}</b> at once${g.perWorker ? ` (${esc(g.perWorker)} per GPU worker)` : ''}.${g.note ? ` ${esc(g.note)}` : ''}`
      : g.state === 'missing'
        ? `<span class="set-err">This ${esc(g.note || "needs Hawkes Gen's next release")}.</span>${asked !== undefined ? ` Your value (${esc(asked)}) is kept here and sent to Gen once it has it.` : ''}`
        : `<span class="set-err">${esc(g.note || "Hawkes Gen didn't answer")}.</span>${p.wanted?.pending ? ' Your value is kept here and sent when this tab is next opened.' : ''}`;
    const order = g.providers ?? [];
    const prov = order.length ? order.map((x, i) => `<div class="ca-line pt-prov" data-prov="${esc(x.id)}" style="align-items:center;gap:8px">
        <label style="flex:1;min-width:0"><input type="checkbox" data-provon ${x.enabled ? 'checked' : ''}> <b>${esc(x.id)}</b>${x.kind ? ` <span class="meta">${esc(x.kind)}</span>` : ''}</label>
        <span class="meta">${x.maxBrowsers != null ? `up to ${esc(x.maxBrowsers)}` : ''}${x.ok === false || x.reason ? ` <span class="set-err">${esc(x.reason || 'not usable now')}</span>` : x.enabled ? ' ✓' : ''}</span>
        <button class="small" data-provmove="-1" ${i === 0 ? 'disabled' : ''} title="Try earlier">↑</button><button class="small" data-provmove="1" ${i === order.length - 1 ? 'disabled' : ''} title="Try later">↓</button>
      </div>`).join('') : '';
    return `<div class="set-box" id="setPlaytests"><h3>🎮 Playtests</h3>
      <div class="meta">How many playtests Hawkes Gen runs at the same time, and which GPU providers it uses, in order. Gen keeps it within what each provider account allows.</div>
      ${row('Playtests at once', num('playtests', 'browsers', asked ?? p.browsers ?? '', { min: 1, max: 64 }))}
      <div class="meta" style="padding:6px 0">${status}</div>
      ${prov ? `<div class="meta" style="padding-top:6px"><b>GPU providers</b>: ticked ones are used, top first</div>${prov}` : ''}
      <div id="ptMsg" class="meta"></div>
    </div>`;
  }
  function redrawPlaytests() {
    const box = $('#setPlaytests');
    if (box && data?.playtests) box.outerHTML = playtestsBox(data.playtests);
  }
  async function saveProviders(ids, btn) {
    const msg = $('#ptMsg');
    if (!ids.length) { if (msg) msg.innerHTML = '<span class="set-err">Keep at least one provider ticked.</span>'; redrawPlaytests(); return; }
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/settings', { method: 'POST', body: { section: 'playtests', patch: { providers: ids } } });
      data.playtests = r.settings;
      redrawPlaytests();
      const m = $('#ptMsg'); if (m) { m.innerHTML = '<span class="set-saved">Saved</span>'; setTimeout(() => m.textContent === 'Saved' && (m.textContent = ''), 1800); }
    } catch (err) {
      redrawPlaytests();
      const m = $('#ptMsg'); if (m) m.innerHTML = `<span class="set-err">${esc(err.message)}</span>`;
    }
  }

  // Plan and credits (src/billing.ts): this Studio's subscription on the shared Stripe account. Subscribing, cancelling
  // and the billing portal are an admin's; the API refuses the rest.
  let billing = null;
  if (!document.getElementById('setMoreCss')) {
    const css = document.createElement('style');
    css.id = 'setMoreCss';
    css.textContent = '.set-more { margin-top: 14px; } .set-more > summary { cursor: pointer; font-weight: 600; padding: 8px 0; } .set-more[open] > summary { margin-bottom: 8px; }';
    document.head.append(css);
  }

  function billingBox(b) {
    if (!b) return '';
    const usd = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
    const s = b.subscription;
    const until = s?.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : '';
    // A plan Hawkes Studio gave this Studio (cells.ts gifts): it counts like a subscription, with no card.
    const g = b.gift;
    const gift = g ? `<b>${esc(b.entitlements?.status === 'gift' ? b.entitlements.planName : g.plan)}</b> · given by Hawkes Studio${g.until ? ` until ${esc(new Date(g.until).toLocaleDateString())}` : ''}${g.creditsPerMonth ? ` · ${Number(g.creditsPerMonth).toLocaleString()} credits a month` : ''}` : '';
    const state = s ? `<b>${esc(s.plan?.name ?? s.planId)}</b> · ${s.status === 'past_due' ? '<span class="set-err">payment failed: update your card</span>' : s.cancelAtPeriodEnd ? `ends ${esc(until)}` : `renews ${esc(until)}`}${gift && b.entitlements?.status === 'gift' ? ` · now on ${gift}` : ''}` : gift || 'No plan yet.';
    const plans = s ? '' : b.plans.map((p) => `<div class="ca-line"><div style="flex:1"><b>${esc(p.name)}</b> ${usd(p.priceCents)}/month<div class="meta">${p.creditsPerMonth.toLocaleString()} credits a month · up to ${p.maxGames} projects</div></div><button class="small" data-billplan="${esc(p.id)}" ${!b.stripe || b.stripe.configured ? '' : 'disabled'}>Subscribe</button></div>`).join('');
    // Credit packs (billing.ts): a one-off top-up any time; Hawkes Gen work (playtests, builds, assets) is paid from credits.
    const packs = (b.packs ?? []).length ? `<details class="set-more"${Number(b.credits) < 100 ? ' open' : ''}><summary>Add credits</summary><div class="meta">Playtests, builds and generated assets on Hawkes Gen are paid from these credits (1 credit = $0.01; a Unity build is 100). Reviews and Talk run on your own AI and cost none.</div>${b.packs.map((p) => `<div class="ca-line"><div style="flex:1"><b>${esc(p.name)}</b> ${usd(p.priceCents)}</div><button class="small" data-billpack="${esc(p.id)}" ${!b.stripe || b.stripe.configured ? '' : 'disabled'}>Buy</button></div>`).join('')}</details>` : '';
    const ledger = (b.ledger ?? []).length ? `<details class="set-more"><summary>Credits used and added</summary>${b.ledger.slice(0, 15).map((l) => `<div class="meta">${esc(new Date(l.created).toLocaleDateString())} · <b>${l.delta > 0 ? '+' : ''}${Number(l.delta).toLocaleString()}</b> · ${esc(l.detail ?? l.kind)}</div>`).join('')}</details>` : '';
    // What the plan includes and what it doesn't (src/entitlements.ts): each missing one is an Upgrade away.
    const e = b.entitlements;
    const feats = e && e.plan !== 'platform' ? `<div class="meta">${e.games !== null ? `${e.games} game${e.games === 1 ? '' : 's'}` : ''}${e.features.map((f) => ` · ✓ ${esc(b.features?.[f] ?? f)}`).join('')}${e.locked.map((f) => ` · <span title="Upgrade for it">🔒 ${esc(b.features?.[f] ?? f)}</span>`).join('')}</div>` : '';
    return `<div class="set-box" id="setBilling"><h3>💳 Plan and credits</h3>
      <div class="meta">${state} · ${Number(b.credits).toLocaleString()} credits${b.stripe?.mode === 'test' ? ' · <b>test mode</b>' : ''}${b.stripe && !b.stripe.configured ? ' · payments are not set up on this Studio yet' : ''}</div>${feats}
      ${plans}
      ${!s && !g && b.freeCredits ? `<div class="meta">Free: topped up to ${Number(b.freeCredits).toLocaleString()} credits each month.</div>` : ''}
      ${packs}
      ${s ? `<div class="ca-line">${s.cancelAtPeriodEnd ? '<button class="small" data-bill="resume">Keep my plan</button>' : '<button class="small" data-bill="cancel">Cancel at the end of the month</button>'}<button class="small" data-bill="portal">Cards and receipts</button></div>` : ''}
      ${ledger}<div id="billMsg" class="meta"></div><div class="meta"><a href="/legal" target="_blank" rel="noopener">Terms, privacy and refunds</a></div></div>`;
  }

  // Restarting Studio or Gen (src/restarts.ts): the server's deploy runner restarts the one service, reading its secrets
  // again first (a key just stored, like the Gemini key). Studio's own restart drops this page's connection for a moment.
  let services = null;
  function servicesBox(sv) {
    if (!sv) return '';
    const when = (d) => (d ? `${esc(ago(Date.parse(d.at)))}${d.detail ? ` · ${esc(d.detail)}` : ''}` : 'never from here');
    const row = (s) => `<div class="ca-line" style="align-items:flex-start;gap:10px">
        <button class="small" data-restart="${s.id}" ${sv.pending ? 'disabled' : ''}>↻ Restart ${esc(s.name)}</button>
        <div class="meta">${s.restart ? `${s.restart.outcome === 'restarted' ? '✓ Last restart' : '<span class="set-err">Last restart failed</span>'} ${when(s.restart)}` : 'Not restarted from here yet.'}${s.deploy ? `<br>Last deploy ${esc(ago(Date.parse(s.deploy.at)))} (${esc(String(s.deploy.to ?? '').slice(0, 7))})` : ''}</div>
      </div>`;
    return `<div class="set-box"><h3>↻ Restart services</h3>
      <div class="meta">Restarts one service on the server and reads its keys again (do it after storing a new key). Runs, agents and Talk answers carry on through a Studio restart; Gen's jobs pick up where they were.</div>
      ${sv.pending ? `<div class="meta"><b>Restarting ${esc(sv.pending.service === 'gen' ? 'Hawkes Gen' : 'Hawkes Studio')}…</b> (asked ${esc(ago(Date.parse(sv.pending.at)))}). This box updates when it's back.</div>` : ''}
      ${sv.services.map(row).join('')}
      <div id="svcMsg" class="meta"></div>
    </div>`;
  }
  // A restart waiting or running: the box updates when the push stream says something moved. Studio restarting drops the
  // stream, and its reconnect refetches every topic once; Hawkes Gen coming back changes the activity panel (its `gen`
  // flag). No timer (J, 2026-11-02: "Please stop implementing polling").
  studioStream.on(['activity', 'ops', 'runs'], async (e) => {
    if (e.badge || !services?.pending) return;
    try {
      services = await api('/api/services');
      const box = $('#svcBox');
      if (box) box.outerHTML = `<div id="svcBox">${servicesBox(services)}</div>`;
    } catch { /* Studio is restarting: the reconnect asks again */ }
  });

  // Customers' Studios (src/cells.ts), the platform admin's alone: who has which plan, and gift subscriptions (J,
  // 2026-10-31: "set which accounts are under which subscription"). Hidden when this isn't the control plane or the
  // viewer isn't the platform admin (the API refuses both).
  async function mountCustomers(box) {
    if (!box) return;
    let c;
    try { c = await api('/api/cells'); } catch { box.remove(); return; }
    if (!c.on) { box.remove(); return; }
    const plans = (billing?.plans ?? []).filter((p) => p.id !== 'free');
    const name = (id) => plans.find((p) => p.id === id)?.name ?? id;
    const day = (t) => new Date(t).toLocaleDateString();
    const live = c.orgs.filter((o) => o.state !== 'deleted');
    const row = (o) => {
      const g = o.gift && (!o.gift.until || o.gift.until > Date.now()) ? o.gift : null;
      const now = o.plan.id === 'free' ? 'Free' : `${esc(name(o.plan.id))}${o.plan.status === 'gift' ? ' (gift)' : o.plan.status ? ` (${esc(o.plan.status)})` : ''}`;
      return `<div class="ca-line" style="align-items:flex-start;gap:10px;flex-wrap:wrap" data-org="${esc(o.id)}">
        <div style="flex:1;min-width:200px"><b>${esc(o.name || o.id)}</b> <span class="meta">${esc(o.id)}</span>
          <div class="meta">${esc(o.ownerEmail)} · ${esc(o.state)} · <b>${now}</b>${o.plan.sub && o.plan.status === 'gift' ? ` · also pays for ${esc(name(o.plan.sub.planId))}` : ''} · ${Number(o.credits ?? 0).toLocaleString()} credits</div>
          ${g ? `<div class="meta">🎁 ${esc(name(g.plan))} ${g.until ? `until ${esc(day(g.until))}` : 'for good'} · ${Number(o.giftCreditsPerMonth ?? 0).toLocaleString()} credits a month${g.note ? ` · ${esc(g.note)}` : ''}${g.by ? ` · by ${esc(g.by)}` : ''}</div>` : ''}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <select data-gift="plan">${plans.map((p) => `<option value="${esc(p.id)}" ${(g?.plan ?? 'studio_team') === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <input type="date" data-gift="until" title="Until (leave empty for good)" value="${g?.until ? new Date(g.until).toISOString().slice(0, 10) : ''}">
          <input type="number" min="0" step="1" data-gift="credits" title="Credits a month (empty: the plan's own)" placeholder="credits/mo (plan's)" value="${g?.credits ?? ''}" style="width:130px">
          <input data-gift="note" placeholder="why (optional)" value="${esc(g?.note ?? '')}" style="width:140px">
          <button class="small primary" data-gift="give">${g ? 'Change gift' : 'Give a plan'}</button>
          ${g ? '<button class="small" data-gift="remove">Take it back</button>' : ''}
          <input type="number" min="1" step="1" data-gift="amount" placeholder="credits" style="width:90px">
          <button class="small" data-gift="add">Add credits</button>
        </div></div>`;
    };
    box.innerHTML = `<div class="set-box"><h3>🏢 Customers' Studios</h3>
      <div class="meta">Every customer Studio, its owner, the plan it has and its credits. A gift is a plan with no card: it unlocks the plan's features and project count and grants credits each month (the plan's own unless you set a number; 0 for none), until a date or for good. A paid plan that's higher still wins. Add credits is a one-off top-up, written in its ledger.</div>
      ${live.length ? live.map(row).join('') : '<div class="meta">No customer Studios yet.</div>'}<div id="giftMsg" class="meta"></div></div>`;
    box.onclick = async (e) => {
      const btn = e.target.closest('[data-gift="give"],[data-gift="remove"],[data-gift="add"]');
      if (!btn) return;
      const line = btn.closest('[data-org]');
      const org = line.dataset.org;
      const msg = box.querySelector('#giftMsg');
      btn.disabled = true;
      try {
        if (btn.dataset.gift === 'add') {
          const amount = Number(line.querySelector('[data-gift="amount"]').value);
          if (!amount) { btn.disabled = false; msg.innerHTML = '<span class="set-err">How many credits?</span>'; return; }
          const note = prompt(`Add ${amount.toLocaleString()} credits to ${org}. A note for its ledger (optional):`, '');
          if (note === null) { btn.disabled = false; return; }
          await api(`/api/cells/${org}/credits`, { method: 'POST', body: { amount, note } });
        } else if (btn.dataset.gift === 'remove') {
          if (!confirm(`Take back the gift from ${org}? It goes back to its paid plan, or Free.`)) { btn.disabled = false; return; }
          await api(`/api/cells/${org}/gift`, { method: 'DELETE' });
        } else {
          const until = line.querySelector('[data-gift="until"]').value;
          const credits = line.querySelector('[data-gift="credits"]').value;
          await api(`/api/cells/${org}/gift`, { method: 'POST', body: { plan: line.querySelector('[data-gift="plan"]').value, until: until ? `${until}T23:59:59` : null, note: line.querySelector('[data-gift="note"]').value, credits: credits === '' ? null : Number(credits) } });
        }
        await mountCustomers(box);
      } catch (err) { btn.disabled = false; msg.innerHTML = `<span class="set-err">${esc(err.message)}</span>`; }
    };
  }

  async function loadSettingsTab() {
    [data, claude, agyLogin, services, routing, billing, providers] = await Promise.all([api('/api/settings'), api('/api/claude/accounts').catch(() => null), api('/api/antigravity/login').catch(() => null), api('/api/services').catch(() => null), api('/api/routing').catch(() => null), api('/api/billing').catch(() => null), window.studioMe?.customer ? null : api('/api/ai/providers').catch(() => null)]);
    window.callVoice?.apply(data.call);
    const badge = $('#walkAwayBadge');
    if (badge) badge.hidden = !data.pm.walkAway;
    // A customer's Studio (src/tenancy.ts): no harness choice (their own Claude only), no server budgets or alerts.
    const cu = window.studioMe?.customer;
    // Every Studio: what matters first (the plan, the AI, notifications), the rest folded away by topic (J, 2026-10-30:
    // "make settings page easier to deal with"). J's Studio is the same page plus its own (J, 2026-11-02): his AI
    // (harness, Claude accounts, Antigravity) where a customer's "Your AI" is, and the platform's in a section of its own.
    $('#setBody').innerHTML = `<div class="set-grid">${billingBox(billing)}${cu ? '<div id="setAiBox"></div>' : brainBox(data.brain) + providersBox(providers) + claudeBox(claude, data.brain) + agyBox(agyLogin)}${cu ? walkAwayBox(data.pm) : ''}${buildsBox(data.builds)}${notifyBox(data.notify)}</div>
      <details class="set-more"><summary>Agents and the PM: how much they do by themselves</summary><div class="set-grid">${agentsBox(data.agents)}${pmBox(data.pm)}</div></details>
      <details class="set-more"><summary>Advanced: models, tuning and the call voice</summary><div class="set-grid">${data.routing ? routingBox(data.routing, routing) : ''}${tuningBox(data.tuning)}${callBox(data.call)}</div></details>
      ${cu ? '' : `<details class="set-more" open><summary>Platform: customers' Studios, services, costs, resources and playtest machines</summary><div class="set-grid"><div id="setCellsBox"></div><div id="svcBox">${servicesBox(services)}</div>${costsBox(data.costs)}${resourcesBox(data.resources)}${playtestsBox(data.playtests)}</div></details>`}`;
    // A customer's Studio: Claude and every other provider they link, in one box (users.js mountAiCard).
    if (cu) api('/api/ai').then((ai) => window.mountAiCard?.($('#setAiBox'), ai)).catch(() => {});
    else mountCustomers($('#setCellsBox'));
    if (data.call.engine === 'eleven') loadElevenVoices();
    // A dialog or empty state sent the reader to one section ("Add credits" → Plan and credits, "Connect your AI" → Your AI).
    const want = window.__settingsFocus ?? (location.hash === '#settings/ai' ? 'ai' : null);
    window.__settingsFocus = null;
    const box = want && document.getElementById(want === 'ai' ? (cu ? 'setAiBox' : 'setProvidersBox') : 'setBilling');
    if (box) { box.scrollIntoView({ block: 'start' }); box.classList.add('set-flash'); setTimeout(() => box.classList.remove('set-flash'), 2500); }
  }
  window.loadSettingsTab = loadSettingsTab;

  async function loadElevenVoices() {
    const sel = $('#setElevenVoice');
    if (!sel) return;
    try {
      const r = await fetch(`/api/gen/v1/providers/elevenlabs/voices`).then((x) => x.json());
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
    if (t.matches?.('[data-provon]')) {
      const ids = [...document.querySelectorAll('#setPlaytests .pt-prov')].filter((x) => x.querySelector('[data-provon]').checked).map((x) => x.dataset.prov);
      return saveProviders(ids, null);
    }
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
    // Dotted keys nest: mode.computer, roles.fixer.tier, models.copilot.deep, copilot.maxCredits.
    const nest = (path, val) => path.reduceRight((acc, key) => ({ [key]: acc }), val);
    const patch = k.includes('.') ? nest(k.split('.'), v) : { [k]: v };
    const saved = await save(section, patch, t);
    if (saved && (section === 'tuning' || section === 'routing')) loadSettingsTab();
    // Choosing a voice engine changes what the box shows (the ElevenLabs voices, Kokoro's state).
    if (saved && section === 'call' && (k === 'engine' || k === 'rate')) loadSettingsTab();
    if (saved && section === 'brain') loadSettingsTab();
    if (saved && section === 'playtests') { redrawPlaytests(); const m = $('#ptMsg'); if (m) m.innerHTML = '<span class="set-saved">Saved</span>'; }
  });
  document.addEventListener('input', (e) => {
    if (e.target.matches?.('#setBody input[type=range]')) e.target.nextElementSibling.textContent = `${Number(e.target.value).toFixed(2)}×`;
  });
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset?.go) { e.preventDefault(); show(t.dataset.go); return; }
    if (t.dataset?.billplan || t.dataset?.bill || t.dataset?.billpack) {
      t.disabled = true;
      try {
        const what = t.dataset.billplan ? 'checkout' : t.dataset.billpack ? 'buy' : t.dataset.bill;
        const r = await api(`/api/billing/${what}`, { method: 'POST', body: t.dataset.billplan ? { plan: t.dataset.billplan } : t.dataset.billpack ? { pack: t.dataset.billpack } : {} });
        if (r.url) { location.href = r.url; return; }
        loadSettingsTab();
      } catch (err) {
        $('#billMsg').innerHTML = `<span class="set-err">${esc(err.message)}</span>`;
        t.disabled = false;
      }
      return;
    }
    if (t.dataset?.provmove) {
      const lines = [...document.querySelectorAll('#setPlaytests .pt-prov')];
      const i = lines.indexOf(t.closest('.pt-prov'));
      const j = i + Number(t.dataset.provmove);
      if (i < 0 || j < 0 || j >= lines.length) return;
      [lines[i], lines[j]] = [lines[j], lines[i]];
      const ids = lines.filter((x) => x.querySelector('[data-provon]').checked).map((x) => x.dataset.prov);
      // Only the ticked ones go to Gen, in order: moving an unticked one changes nothing there.
      const all = (data.playtests.gen.providers ?? []);
      data.playtests.gen.providers = lines.map((x) => all.find((p) => p.id === x.dataset.prov));
      return saveProviders(ids, t);
    }
    if (t.dataset?.restart) {
      const name = t.dataset.restart === 'gen' ? 'Hawkes Gen' : 'Hawkes Studio';
      if (!confirm(`Restart ${name} now?`)) return;
      t.disabled = true;
      try {
        await api('/api/services/restart', { method: 'POST', body: { service: t.dataset.restart } });
        services = await api('/api/services');
        $('#svcBox').innerHTML = servicesBox(services);
      } catch (err) {
        $('#svcMsg').innerHTML = `<span class="set-err">${esc(err.message)}</span>`;
        t.disabled = false;
      }
      return;
    }
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
    if (t.id === 'ckSave' || t.id === 'ckRemove') return claudeAction(async () => {
      await claudeCall('/api/claude/key', { method: 'POST', body: { key: t.id === 'ckSave' ? $('#ckKey').value : null } });
    }, t);
    if (t.id === 'caStart') return claudeAction(async () => {
      $('#caMsg').textContent = 'Starting Claude’s sign-in on the server…';
      await claudeCall('/api/claude/signin', { method: 'POST', body: { label: $('#caLabel').value } });
    }, t);
    if (t.id === 'caFinish') return claudeAction(async () => {
      $('#caMsg').textContent = 'Signing in…';
      const r = await claudeCall('/api/claude/signin/code', { method: 'POST', body: { code: $('#caCode').value } });
      // A first check of the new account (a one-line answer from Haiku), shown when it comes back.
      claudeCall(`/api/claude/accounts/${r.account.id}/check`, { method: 'POST', body: {} }).then(() => tab === 'settings' && loadSettingsTab()).catch(() => {});
    }, t);
    const agyMsg = (x) => { const m = $('#agyMsg'); if (m) m.innerHTML = x; };
    const agyAction = async (fn) => { try { t.disabled = true; await fn(); await loadSettingsTab(); } catch (err) { agyMsg(`<span class="set-err">${esc(err.message)}</span>`); t.disabled = false; } };
    if (t.id === 'agyStart') return agyAction(async () => { agyMsg('Starting Antigravity’s sign-in on the server…'); await claudeCall('/api/antigravity/signin', { method: 'POST', body: {} }); });
    if (t.id === 'agyFinish') return agyAction(async () => { agyMsg('Signing in…'); await claudeCall('/api/antigravity/signin/code', { method: 'POST', body: { code: $('#agyCode').value } }); });
    if (t.id === 'agyCancel') return agyAction(() => claudeCall('/api/antigravity/signin/cancel', { method: 'POST', body: {} }));
    if (t.id === 'caCancel') return claudeAction(() => claudeCall('/api/claude/signin/cancel', { method: 'POST', body: {} }), t);
    const act = t.dataset?.caact;
    const ca = act && t.closest('[data-ca]')?.dataset.ca;
    if (ca) {
      const a = claude?.accounts.find((x) => x.id === ca);
      if (act === 'use') return claudeAction(() => claudeCall(`/api/claude/accounts/${ca}/use`, { method: 'POST', body: {} }), t);
      if (act === 'check') { t.textContent = 'Checking…'; return claudeAction(() => claudeCall(`/api/claude/accounts/${ca}/check`, { method: 'POST', body: {} }), t); }
      if (act === 'rename') { const label = prompt('Name for this Claude account', a?.label ?? ''); if (label) return claudeAction(() => claudeCall(`/api/claude/accounts/${ca}`, { method: 'PATCH', body: { label } }), t); return; }
      if (act === 'remove' && confirm(`Remove "${a?.label}"? Its login is forgotten here (signing in again makes a new one).`)) return claudeAction(() => claudeCall(`/api/claude/accounts/${ca}`, { method: 'DELETE' }), t);
      return;
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
