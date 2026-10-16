// Talk: chat with Claude about the products (Studio's /api/talk). Loaded after app.js (uses its api, esc, view, GEN).
// The answer streams in (the conversation's `partial` text, polled while Claude is thinking). While idle it is polled
// every few seconds too, so Studio's notices (results of work this conversation started) and the turns Studio starts to
// explain them appear without a reload, labelled "Studio". Files are uploaded into Hawkes Gen as blobs and sent with
// the message.
(() => {
  const el = (s) => document.querySelector(s);
  // A deep link (?conversation=<id>#talk, from the morning brief notification) opens that conversation.
  const params = new URLSearchParams(location.search);
  let current = params.get('conversation');
  if (current) history.replaceState(null, '', location.pathname + location.hash);
  let poll = null;
  let shown = ''; // what the log shows (redrawn only when it changes)
  let pending = []; // files uploaded to Hawkes Gen, sent with the next message

  /** A small, safe Markdown renderer: headings, lists, bold, code, links, images (library files open in the viewer). */
  function md(text) {
    const inline = (s) => esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img class="talk-img" src="${u}" alt="${a}" data-full="${u}">`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/\/v1\/files\//.test(u) ? `<a href="${u}" target="_blank" rel="noopener" data-media="${u}">${t}</a>` : `<a href="${u}" target="_blank" rel="noopener">${t}</a>`))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+\/v1\/files\/[A-Za-z0-9_]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener" data-media="${u}">▶ ${u.split('/').pop()}</a>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const out = [];
    let list = null;
    for (const line of String(text).split('\n')) {
      const li = /^\s*[-*]\s+(.*)$/.exec(line) || /^\s*\d+\.\s+(.*)$/.exec(line);
      if (li) {
        if (!list) { list = []; }
        list.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) out.push(`<h4>${inline(h[2])}</h4>`);
      else if (/^\s*---+\s*$/.test(line)) out.push('<hr>');
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  }

  async function loadList() {
    const r = await api('/api/talk');
    el('#talkBilling').textContent = `${r.billing} · ${r.model}`;
    el('#dockConv').innerHTML = `<option value="">New conversation</option>${r.conversations.slice(0, 15).map((c) => `<option value="${c.id}">${esc(c.title ?? 'New conversation')}</option>`).join('')}`;
    el('#dockConv').value = r.conversations.slice(0, 15).some((c) => c.id === current) ? current : '';
    el('#talkList').innerHTML = `<button class="small primary" id="talkNew">New conversation</button>` + r.conversations.map((c) =>
      `<div class="talk-item ${c.id === current ? 'on' : ''}" data-conv="${c.id}"><b>${esc(c.title ?? 'New conversation')}</b><span class="meta">${new Date(c.updated ?? c.created).toLocaleString()}${c.status === 'thinking' ? ' · thinking…' : ''}${c.cost ? ` · $${c.cost.toFixed(2)} API` : ''}</span></div>`).join('');
  }

  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const secs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);
  /** Who paid for an answer: the Max subscription (no extra cost) or the API key (per token). */
  const turnMark = (t) => t && `<div class="talk-turn ${t.billing}" title="${t.auto ? 'Studio started this answer when results came in. ' : ''}"${t.billing === 'api' ? 'Billed to the API key, per token' : `Covered by the Claude Max subscription${t.cost ? ` (about $${t.cost.toFixed(2)} at API prices)` : ''}`}">${t.billing === 'api' ? `💳 $${t.cost.toFixed(3)} API` : '✓ Max plan'}${t.ms ? ` · ${secs(t.ms)}` : ''}${t.stopped ? ' · stopped' : ''}${t.call ? ' · 📞' : ''}${t.auto ? ' · <span class="talk-who">Studio</span> asked for this answer' : ''}</div>`;
  const fileChips = (files) => (files?.length ? `<div class="talk-chips">${files.map((f) => `<span class="talk-chip" title="${esc(f.blob)}">${/^image\//.test(f.type ?? '') ? '🖼' : '📄'} ${esc(f.name)}${f.size ? ` · ${kb(f.size)}` : ''}</span>`).join('')}</div>` : '');

  function renderHead(c) {
    el('#talkHead').innerHTML = `<button class="small talk-lists" id="talkLists">☰</button>${c
      ? `<b class="talk-title">${esc(c.title ?? 'New conversation')}</b><button class="small" id="talkRename">Rename</button><button class="small" id="talkDelete">Delete</button>`
      : '<b class="talk-title">New conversation</b>'}`;
  }

  async function loadConversation() {
    clearTimeout(poll);
    if (!current) {
      renderHead(null);
      shown = '';
      el('#talkLog').innerHTML = `<div class="empty">Ask about the products: "What did last night's trial find?", "What are the agents working on?", "Make the Sick Of It shop screen feel more like Hell", "Is the PH Origins fix good to ship?"</div>`;
      el('#talkSend').disabled = false;
      el('#talkStop').hidden = true;
      return idlePoll();
    }
    // From the page itself (approval.js's call): Approve cards come with their token only to J's dashboard.
    const c = await approvals.call(`/api/talk/${current}`);
    if (c.error) { current = null; return loadConversation(); }
    // Talk showing J around (studio_guide): this page runs what waits for the conversation (guide.js).
    if (c.guide?.length) window.studioGuide?.offer(c.id, c.guide);
    const thinking = c.status === 'thinking';
    const cards = c.approvals ?? [];
    const sig = `${c.id}|${c.title}|${c.messages.length}|${c.status}|${c.partial ?? ''}|${JSON.stringify(c.messages.at(-1)?.turn ?? null)}|${cards.map((a) => `${a.id}:${a.status}:${Math.round((a.expires - Date.now()) / 60000)}`).join(',')}`;
    if (sig !== shown) {
      shown = sig;
      renderHead(c);
      const log = el('#talkLog');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      log.innerHTML = c.messages.map((m) => (m.role === 'tool'
        ? m.tool === 'guide' ? `<div class="talk-tool guide">${esc(m.text)}</div>` : `<div class="talk-tool">⚙ ${esc(m.text)}</div>`
        : m.notice
          ? `<div class="talk-msg assistant notice"><span class="talk-who">Studio</span>${md(m.text)}</div>`
          : `<div class="talk-msg ${m.role}">${m.role === 'user' ? (m.voice ? '<span class="talk-voice" title="Said on a call">🎙</span>' : '') + esc(m.text).replace(/\n/g, '<br>') + fileChips(m.files) : md(m.text)}</div>`) + (turnMark(m.turn) ?? '')).join('')
        // Approve / Deny cards Talk asked for in this conversation (pending, and decided in the last hour).
        + cards.map(approvals.html).join('')
        + (thinking && c.partial ? `<div class="talk-msg assistant streaming">${md(c.partial)}<span class="talk-caret"></span></div>` : '')
        + (thinking && !c.partial ? `<div class="talk-tool">${c.messages.at(-1)?.notice ? 'Studio asked Claude to explain the result…' : 'Claude is thinking…'}</div>` : '');
      if (atBottom || thinking) log.scrollTop = log.scrollHeight;
    }
    el('#talkSend').disabled = thinking;
    el('#talkStop').hidden = !thinking;
    if (thinking) poll = setTimeout(() => { loadConversation().catch(() => {}); loadList().catch(() => {}); }, 700);
    else idlePoll();
  }

  /** While Talk is on screen, new notices and Studio's own turns show up by themselves (every 3 s; the list every 6 s). */
  let idleTicks = 0;
  function idlePoll() {
    clearTimeout(poll);
    poll = setTimeout(() => {
      if (!onScreen() || document.hidden) return idlePoll();
      if (++idleTicks % 2 === 0) loadList().catch(() => {});
      if (!current) return idlePoll();
      loadConversation().catch(() => idlePoll());
    }, 3000);
  }

  function renderPending() {
    el('#talkFiles').innerHTML = pending.map((f, i) => `<span class="talk-chip ${f.blob ? '' : 'busy'}">${/^image\//.test(f.type) ? '🖼' : '📄'} ${esc(f.name)} · ${f.blob ? kb(f.size) : 'uploading…'} <a href="#" data-unattach="${i}">×</a></span>`).join('');
  }

  /** Uploads files into Hawkes Gen as blobs (through /gen on the server: the same login). */
  async function attach(files) {
    for (const file of files) {
      if (file.size > 50 * 1024 * 1024) { alert(`${file.name} is over 50 MB`); continue; }
      const item = { name: file.name || 'pasted.png', type: file.type || '', size: file.size, blob: null };
      pending.push(item);
      renderPending();
      try {
        const r = await fetch(`${GEN}/v1/blobs`, { method: 'POST', headers: { 'X-Filename': item.name }, body: file });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? r.status);
        item.blob = d.blob;
      } catch (e) {
        pending = pending.filter((x) => x !== item);
        alert(`Couldn't upload ${item.name}: ${e.message}`);
      }
      renderPending();
    }
  }

  async function send() {
    const text = el('#talkInput').value.trim();
    if (pending.some((f) => !f.blob)) return alert('Wait for the upload to finish');
    if (!text && !pending.length) return;
    const files = pending;
    el('#talkInput').value = '';
    pending = [];
    renderPending();
    try {
      const c = await api('/api/talk', { method: 'POST', body: { conversation: current, message: text, files, context: window.studioContext?.() ?? undefined } });
      current = c.id;
      await loadList();
      await loadConversation();
    } catch (e) {
      alert(e.message);
      el('#talkInput').value = text;
      pending = files;
      renderPending();
    }
  }

  document.addEventListener('click', async (e) => {
    if (e.target.id === 'talkNew') { current = null; el('.talk').classList.remove('lists'); loadList(); loadConversation(); el('#talkInput').focus(); }
    const item = e.target.closest('[data-conv]');
    if (item) { current = item.dataset.conv; el('.talk').classList.remove('lists'); loadList(); loadConversation(); }
    if (e.target.id === 'talkLists') el('.talk').classList.toggle('lists');
    if (e.target.id === 'talkAttach') el('#talkFile').click();
    const un = e.target.closest('[data-unattach]');
    if (un) { e.preventDefault(); pending.splice(Number(un.dataset.unattach), 1); renderPending(); }
    try {
      if (e.target.id === 'talkStop' && current) { await api(`/api/talk/${current}/stop`, { method: 'POST', body: {} }); await loadConversation(); }
      if (e.target.id === 'talkRename' && current) {
        const title = prompt('Name this conversation', el('.talk-title')?.textContent ?? '');
        if (title !== null) { await api(`/api/talk/${current}`, { method: 'PATCH', body: { title } }); shown = ''; await loadList(); await loadConversation(); }
      }
      if (e.target.id === 'talkDelete' && current && confirm('Delete this conversation?')) {
        await api(`/api/talk/${current}`, { method: 'DELETE' });
        current = null;
        await loadList();
        await loadConversation();
      }
    } catch (err) { alert(err.message); }
    const media = e.target.closest('[data-media]');
    if (media && !(e.ctrlKey || e.metaKey || e.shiftKey || e.button)) {
      e.preventDefault();
      const u = media.dataset.media;
      const r = await fetch(u, { method: 'HEAD' }).catch(() => null);
      const type = r?.headers.get('content-type') ?? '';
      view(type.startsWith('video/') ? `<video src="${u}" controls autoplay></video>` : type.startsWith('image/') ? `<img src="${u}">` : `<a href="${u}" target="_blank">Open file</a>`);
    }
  });
  // J tapped Approve or Deny somewhere: the chat shows what happened.
  addEventListener('studio-approval', () => { shown = ''; if (current) loadConversation().catch(() => {}); });
  el('#talkSend').addEventListener('click', send);
  el('#talkFile').addEventListener('change', (e) => { attach([...e.target.files]); e.target.value = ''; });
  el('#talkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send(); } });
  // Pasting an image (a screenshot) attaches it.
  el('#talkInput').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) { e.preventDefault(); attach(files); }
  });
  // The header's height (it wraps on a phone), so Talk fills the rest of the screen.
  const setHdr = () => document.documentElement.style.setProperty('--hdr', `${document.querySelector('header')?.offsetHeight ?? 0}px`);
  addEventListener('resize', setHdr);
  // It also grows when its status line fills in (the Talk dock and Activity sit below it).
  if (window.ResizeObserver) new ResizeObserver(setHdr).observe(document.querySelector('header'));
  setHdr();
  // Dropping files on the conversation attaches them.
  el('#talkLog').addEventListener('dragover', (e) => e.preventDefault());
  el('#talkLog').addEventListener('drop', (e) => { e.preventDefault(); attach([...(e.dataTransfer?.files ?? [])]); });

  // ------------------------------------------------------- the dock
  // Talk beside every other tab: the one chat (.talk-main, with the call pane) moves between the Talk tab and the dock,
  // so it is the same conversation, and a call (call.js) keeps its mic and voice while J switches tabs. A call going
  // when J leaves the Talk tab opens the dock; closing the dock hides it, the call goes on (the 💬 button shows it).
  let docked = localStorage.getItem('studio.talkDock') === '1';
  const onTalkTab = () => tab === 'talk';
  const onScreen = () => onTalkTab() || (docked && !el('#talkDock').hidden);
  const ctxText = (c) => (c ? `Talk sees: ${c.tab}${c.id ? ` · ${c.kind ? `${c.kind} ` : ''}${c.id}` : ''}${c.label ? ` · ${c.label}` : ''}` : '');
  function placeTalk() {
    const open = docked && !onTalkTab();
    const main = el('.talk-main');
    const to = open ? el('#dockBody') : el('.talk');
    if (main.parentElement !== to) to.append(main);
    el('#talkDock').hidden = !open;
    document.body.classList.toggle('dock-open', open);
    el('#dockBtn').hidden = onTalkTab();
    el('#dockBtn').classList.toggle('on', open);
    if (open) {
      el('#dockCtx').textContent = ctxText(window.studioContext?.());
      if (!window.__talkLoaded) { window.__talkLoaded = true; window.loadTalk().catch(() => {}); } else loadConversation().catch(() => {});
    }
  }
  function setDocked(on, keep = true) {
    docked = on;
    if (keep) localStorage.setItem('studio.talkDock', on ? '1' : '0');
    placeTalk();
  }
  addEventListener('studio-tab', (e) => {
    // Leaving Talk during a call: the call comes along in the dock.
    if (e.detail !== 'talk' && document.body.classList.contains('in-call') && !docked) setDocked(true, false);
    document.body.classList.remove('hdr-shown');
    placeTalk();
  });
  // What Talk sees follows J's clicks (app.js remembers them first).
  document.querySelector('main').addEventListener('click', () => {
    if (!el('#talkDock').hidden) setTimeout(() => (el('#dockCtx').textContent = ctxText(window.studioContext?.())), 0);
  });
  el('#dockBtn').addEventListener('click', () => setDocked(!docked));
  el('#dockClose').addEventListener('click', () => setDocked(false));
  el('#dockFull').addEventListener('click', () => show('talk'));
  el('#dockConv').addEventListener('change', (e) => { current = e.target.value || null; loadConversation().catch(() => {}); });
  // On a phone the call hides Studio's header: ☰ Tabs brings it back to switch tabs, the call goes on.
  el('#callTabs').addEventListener('click', () => { document.body.classList.toggle('hdr-shown'); setHdr(); });

  /** Opens the dock without remembering it (guide.js, when Talk takes J away from the Talk tab). */
  window.talkDock = { open: () => { if (!docked) setDocked(true, false); } };
  window.loadTalk = async () => { await loadList(); await loadConversation(); };
  /** The conversation on screen (a call started here continues it; call.js). */
  window.talkConversation = () => current;
  /** Opens a conversation (the Activity panel's links). */
  window.openTalk = (id) => {
    current = id;
    el('.talk').classList.remove('lists');
    window.__talkLoaded = true;
    show('talk');
    window.loadTalk().catch(() => {});
  };
  placeTalk();
})();
