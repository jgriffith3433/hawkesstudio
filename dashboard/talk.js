// Talk: chat with Claude about the products (Studio's /api/talk). Loaded after app.js (uses its api, esc, view, GEN).
// The answer streams in (the conversation's `partial` text, polled while Claude is thinking). Files are uploaded into
// Hawkes Gen as blobs and sent with the message.
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
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/\/v1\/files\//.test(u) ? `<a href="#" data-media="${u}">${t}</a>` : `<a href="${u}" target="_blank" rel="noopener">${t}</a>`))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+\/v1\/files\/[A-Za-z0-9_]+)/g, (_, pre, u) => `${pre}<a href="#" data-media="${u}">▶ ${u.split('/').pop()}</a>`)
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
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  }

  async function loadList() {
    const r = await api('/api/talk');
    el('#talkBilling').textContent = `${r.billing} · ${r.model}`;
    el('#talkList').innerHTML = `<button class="small primary" id="talkNew">New conversation</button>` + r.conversations.map((c) =>
      `<div class="talk-item ${c.id === current ? 'on' : ''}" data-conv="${c.id}"><b>${esc(c.title ?? 'New conversation')}</b><span class="meta">${new Date(c.updated ?? c.created).toLocaleString()}${c.status === 'thinking' ? ' · thinking…' : ''}${c.cost ? ` · $${c.cost.toFixed(2)} API` : ''}</span></div>`).join('');
  }

  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const secs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);
  /** Who paid for an answer: the Max subscription (no extra cost) or the API key (per token). */
  const turnMark = (t) => t && `<div class="talk-turn ${t.billing}" title="${t.billing === 'api' ? 'Billed to the API key, per token' : `Covered by the Claude Max subscription${t.cost ? ` (about $${t.cost.toFixed(2)} at API prices)` : ''}`}">${t.billing === 'api' ? `💳 $${t.cost.toFixed(3)} API` : '✓ Max plan'}${t.ms ? ` · ${secs(t.ms)}` : ''}${t.stopped ? ' · stopped' : ''}</div>`;
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
      return;
    }
    const c = await api(`/api/talk/${current}`);
    if (c.error) { current = null; return loadConversation(); }
    const thinking = c.status === 'thinking';
    const sig = `${c.id}|${c.title}|${c.messages.length}|${c.status}|${c.partial ?? ''}|${JSON.stringify(c.messages.at(-1)?.turn ?? null)}`;
    if (sig !== shown) {
      shown = sig;
      renderHead(c);
      const log = el('#talkLog');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      log.innerHTML = c.messages.map((m) => (m.role === 'tool'
        ? `<div class="talk-tool">⚙ ${esc(m.text)}</div>`
        : `<div class="talk-msg ${m.role}">${m.role === 'user' ? esc(m.text).replace(/\n/g, '<br>') + fileChips(m.files) : md(m.text)}</div>`) + (turnMark(m.turn) ?? '')).join('')
        + (thinking && c.partial ? `<div class="talk-msg assistant streaming">${md(c.partial)}<span class="talk-caret"></span></div>` : '')
        + (thinking && !c.partial ? '<div class="talk-tool">Claude is thinking…</div>' : '');
      if (atBottom || thinking) log.scrollTop = log.scrollHeight;
    }
    el('#talkSend').disabled = thinking;
    el('#talkStop').hidden = !thinking;
    if (thinking) poll = setTimeout(() => { loadConversation().catch(() => {}); loadList().catch(() => {}); }, 700);
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
      const c = await api('/api/talk', { method: 'POST', body: { conversation: current, message: text, files } });
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
    if (media) {
      e.preventDefault();
      const u = media.dataset.media;
      const r = await fetch(u, { method: 'HEAD' }).catch(() => null);
      const type = r?.headers.get('content-type') ?? '';
      view(type.startsWith('video/') ? `<video src="${u}" controls autoplay></video>` : type.startsWith('image/') ? `<img src="${u}">` : `<a href="${u}" target="_blank">Open file</a>`);
    }
  });
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
  setHdr();
  // Dropping files on the conversation attaches them.
  el('#talkLog').addEventListener('dragover', (e) => e.preventDefault());
  el('#talkLog').addEventListener('drop', (e) => { e.preventDefault(); attach([...(e.dataTransfer?.files ?? [])]); });

  // Phone notifications (ntfy): the topic to subscribe to, a test button, on/off.
  async function loadNotify() {
    const n = await api('/api/notify');
    el('#notifyBody').innerHTML = `<p>Install the <b>ntfy</b> app (Android or iPhone), tap +, and subscribe to this topic${n.server !== 'https://ntfy.sh' ? ` on server <code>${esc(n.server)}</code>` : ''}:</p>
      <p><code class="notify-topic">${esc(n.topic)}</code> <button class="small" id="notifyCopy">Copy</button> <a href="${esc(n.subscribe)}" target="_blank" rel="noopener">open</a></p>
      <p>Keep it secret: anyone with the name can read the notifications. You get the morning brief, changes ready to approve, live sites failing, and the agent budget running out.</p>
      <p><label><input type="checkbox" id="notifyOn" ${n.enabled ? 'checked' : ''}> on</label> <button class="small" id="notifyTest">Send a test notification</button> <button class="small" id="notifyRotate">New topic</button> <span id="notifyMsg"></span></p>`;
  }
  el('#notifyBox').addEventListener('toggle', () => { if (el('#notifyBox').open) loadNotify().catch((e) => (el('#notifyBody').textContent = e.message)); });
  document.addEventListener('click', async (e) => {
    const msg = (t) => { const m = el('#notifyMsg'); if (m) m.textContent = t; };
    try {
      if (e.target.id === 'notifyTest') { await api('/api/notify/test', { method: 'POST', body: {} }); msg('Sent.'); }
      if (e.target.id === 'notifyCopy') { await navigator.clipboard.writeText(el('.notify-topic').textContent); msg('Copied.'); }
      if (e.target.id === 'notifyRotate' && confirm('Make a new topic? You will have to subscribe again.')) { await api('/api/notify', { method: 'POST', body: { rotate: true } }); await loadNotify(); }
    } catch (err) { msg(err.message); }
  });
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'notifyOn') await api('/api/notify', { method: 'POST', body: { enabled: e.target.checked } }).catch((err) => alert(err.message));
  });

  window.loadTalk = async () => { await loadList(); await loadConversation(); };
})();
