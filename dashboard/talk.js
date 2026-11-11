// Talk: chat with Claude about the products (Studio's /api/talk). Loaded after app.js (uses its api, esc, view, GEN).
// The answer streams in from GET /api/talk/<id>/events (only the streaming bubble is redrawn). The push stream
// (stream.js) says when a conversation changed, so Studio's notices (results of work this conversation started) and the
// turns Studio starts to explain them appear without a reload, labelled "Studio"; then only the newer messages are
// fetched (?after=) and only new or changed messages are drawn. Files are uploaded into Hawkes Gen as blobs and sent with
// the message. Unseen messages (Claude's and Studio's that J hasn't had on screen; talk.ts markSeen) show as a badge on the
// conversation and on the Talk tab, like the Inbox's.
(() => {
  const el = (s) => document.querySelector(s);
  // A deep link (?conversation=<id>#talk, from the morning brief notification) opens that conversation.
  const params = new URLSearchParams(location.search);
  let current = params.get('conversation');
  if (current) history.replaceState(null, '', location.pathname + location.hash);
  let conv = null; // the conversation on screen as last fetched (all its messages)
  let rows = []; // the HTML of each row the log shows (a row: a message, its turn mark, the cards asked after it)
  const msgHtml = []; // per message: { key, html } (Markdown is rendered once per message)
  let head = ''; // what the header shows
  let live = null; // the answer streaming in: { id, es, text, ended }
  let pending = []; // files uploaded to Hawkes Gen, sent with the next message
  const seenSent = {}; // per conversation: the newest message this page told Studio J has seen

  // What the answers' references resolved to (titles of items, tasks, changes, findings; the type of Gen files), kept so a
  // redrawn bubble (the answer streams in) shows them at once instead of flashing the bare id or link again.
  const refTitle = {}; // id -> { title, item? } | null (not found)
  const mediaKind = {}; // Gen file id -> 'image' | 'video' | 'other'
  const REF_RE = /(?<![\w/=&?.;"'-])([ikcf]_[0-9a-f]{6,32})(?![\w])/g;
  const genId = (u) => /\/v1\/files\/([A-Za-z0-9_]+)/.exec(u)?.[1];
  // Through Studio's relay (this session, no signature, never expires); the signed link itself stays the anchor's href.
  const relay = (u) => { const id = genId(u); return id ? `/api/gen/v1/files/${id}` : u; };
  const refChip = (id) => {
    const t = refTitle[id];
    const label = t?.title ? `${esc(t.title)}` : esc(id);
    return `<span class="talk-ref${t === null ? ' gone' : ''}" role="link" tabindex="0" data-ref="${id}" title="${esc(id)}">${label}</span>`;
  };
  // A Gen file link: an image or a video shows inline once its type is known (hydrate asks Gen for it); until then it is
  // the link itself, which also opens the viewer.
  const fileEmbed = (url, label) => {
    const k = mediaKind[genId(url)];
    const src = relay(url);
    if (k === 'image') return `<img class="talk-img" src="${src}" alt="${label}" data-full="${src}" loading="lazy">`;
    if (k === 'video') return `<video class="talk-video" src="${src}" controls preload="metadata" playsinline></video>`;
    return `<a href="${url}" target="_blank" rel="noopener" data-media="${url}" data-embed="${genId(url)}">${label}</a>`;
  };

  /** A small, safe Markdown renderer: headings, lists, tables, code blocks (with Copy), bold, code, links, images, Gen files inline, item chips. */
  function md(text) {
    const inline = (s) => esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img class="talk-img" src="${u}" alt="${a}" data-full="${u}">`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/\/v1\/files\//.test(u) ? fileEmbed(u, t) : `<a href="${u}" target="_blank" rel="noopener">${t}</a>`))
      // A bare Gen file link keeps its whole query (?exp=..&sig=..: the text is escaped, so & is &amp; here); trailing
      // sentence punctuation stays outside the link. The label is short; the viewer opens it (by the relay).
      .replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+?\/v1\/files\/[A-Za-z0-9_]+(?:\?[^\s<)\]]*)?)/g, (_, pre, u) => {
        const tail = /[.,:!]+$/.exec(u)?.[0] ?? '';
        const url = tail ? u.slice(0, -tail.length) : u;
        return `${pre}${fileEmbed(url, '▶ Open file')}${tail}`;
      })
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(REF_RE, (_, id) => refChip(id));
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l) => isRow(l) && cells(l).every((c) => /^:?-{2,}:?$/.test(c));
    const out = [];
    let list = null;
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const li = /^\s*[-*]\s+(.*)$/.exec(line) || /^\s*\d+\.\s+(.*)$/.exec(line);
      if (li) {
        if (!list) { list = []; }
        list.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      // A fenced code block (an unclosed one, while the answer streams in, shows what has arrived).
      if (/^\s*```/.test(line)) {
        const code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        out.push(`<div class="talk-scroll talk-code"><button type="button" class="talk-copy" data-copy>Copy</button><pre><code>${esc(code.join('\n'))}</code></pre></div>`);
        continue;
      }
      // A table: a row, a separator row, then rows; it scrolls inside its own box.
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        const head = cells(line);
        const body = [];
        for (i += 2; i < lines.length && isRow(lines[i]); i++) body.push(cells(lines[i]));
        i--;
        out.push(`<div class="talk-scroll"><table class="talk-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) out.push(`<h4>${inline(h[2])}</h4>`);
      else if (/^\s*---+\s*$/.test(line)) out.push('<hr>');
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  }

  // After a draw: ask for what the bubbles mention that isn't known yet (one request per id, ever) and fill it in.
  const REF_URL = { i: (id) => `/api/roadmap/items/${id}`, k: (id) => `/api/roadmap/tasks/${id}`, c: (id) => `/api/changes/${id}`, f: (id) => `/api/findings/${id}` };
  const asked = new Set();
  function hydrate(root) {
    root.querySelectorAll('[data-ref]').forEach((n) => {
      const id = n.dataset.ref;
      if (id in refTitle) { if (refTitle[id]?.title && n.textContent === id) n.textContent = refTitle[id].title; return; }
      if (asked.has(id)) return;
      asked.add(id);
      api(REF_URL[id[0]](id)).then((r) => {
        refTitle[id] = r && !r.error && (r.title || r.id) ? { title: String(r.title || id).slice(0, 90), item: r.item } : null;
        document.querySelectorAll(`[data-ref="${id}"]`).forEach((c) => { if (refTitle[id]) c.textContent = refTitle[id].title; else c.classList.add('gone'); });
      }).catch(() => asked.delete(id));
    });
    root.querySelectorAll('a[data-embed]').forEach((a) => {
      const id = a.dataset.embed;
      if (id in mediaKind) return;
      if (asked.has(`m:${id}`)) return;
      asked.add(`m:${id}`);
      fetch(`/api/gen/v1/files/${id}`, { method: 'HEAD' }).then((r) => {
        const t = r.headers.get('content-type') ?? '';
        mediaKind[id] = t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : 'other';
        if (mediaKind[id] === 'other') return;
        // Each such link becomes the media; its text (the label) is kept as the alt or caption by the link's title.
        document.querySelectorAll(`a[data-embed="${id}"]`).forEach((n) => {
          const src = `/api/gen/v1/files/${id}`;
          const m = document.createElement(mediaKind[id] === 'video' ? 'video' : 'img');
          if (m.tagName === 'VIDEO') Object.assign(m, { src, controls: true, preload: 'metadata', playsInline: true, className: 'talk-video' });
          else Object.assign(m, { src, className: 'talk-img', alt: n.textContent, loading: 'lazy' }), m.dataset.full = src;
          n.replaceWith(m);
        });
      }).catch(() => asked.delete(`m:${id}`));
    });
  }
  // Opens what a chip names in Studio: a change's log, the Roadmap (its item or task), the Backlog.
  function openRef(id) {
    const t = id[0];
    if (t === 'c') { show('changes', id); return; }
    if (t === 'f') { show('backlog'); return; }
    show('roadmap');
    const item = t === 'k' ? refTitle[id]?.item : id;
    setTimeout(() => document.querySelector(`#roadmap [data-item="${item}"]`)?.scrollIntoView({ block: 'center' }), 400);
  }

  const HARNESS_NAMES = { claude: 'Claude', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini', antigravity: 'Antigravity' };
  const harnessName = (h) => HARNESS_NAMES[h] || h || window.talkBrain?.label || 'Claude';
  window.talkBrain = { harness: 'claude', label: 'Claude', model: 'claude-opus-5-5', billing: 'Claude Max subscription', failover: null };

  async function loadList() {
    const r = await api('/api/talk');
    setTalkCount(r.unseen);
    window.talkBrain = { ...window.talkBrain, harness: r.harness || 'claude', label: r.label || harnessName(r.harness), model: r.model, billing: r.billing, failover: r.failover || null };
    const standIn = r.failover ? ` · standing in for ${r.failover.fromLabel || r.failover.from}` : '';
    el('#talkBilling').textContent = `${r.billing} · ${r.model}${standIn}`;
    // The one on screen is being seen right now (loadConversation tells Studio).
    const unseen = (c) => (c.id === current && onScreen() && !document.hidden ? 0 : c.unseen);
    el('#dockConv').innerHTML = `<option value="">New conversation</option>${r.conversations.slice(0, 15).map((c) => `<option value="${c.id}">${unseen(c) ? `● (${unseen(c)}) ` : ''}${esc(c.title ?? 'New conversation')}</option>`).join('')}`;
    el('#dockConv').value = r.conversations.slice(0, 15).some((c) => c.id === current) ? current : '';
    // "Mark all as read": shown only while some conversation has messages J hasn't seen (setTalkCount keeps it in step).
    el('#talkList').innerHTML = `<div class="talk-list-head"><button class="small primary" id="talkNew">New conversation</button><button class="small" id="talkReadAll" title="Clear the new-message badges on every conversation (nothing is answered or approved)"${r.unseen ? '' : ' hidden'}>Mark all as read</button></div>` + r.conversations.map((c) =>
      `<div class="talk-item ${c.id === current ? 'on' : ''}" data-conv="${c.id}"><b>${esc(c.title ?? 'New conversation')}${unseen(c) ? ` <span class="ib-count" title="New messages you haven't seen">${unseen(c)}</span>` : ''}</b><span class="meta">${new Date(c.updated ?? c.created).toLocaleString()}${c.status === 'thinking' ? ' · thinking…' : ''}${c.cost ? ` · $${c.cost.toFixed(2)} API` : ''}</span></div>`).join('');
  }

  /** The Talk tab's badge: conversations with messages J hasn't seen. */
  function setTalkCount(n) {
    const b = el('#talkCount');
    if (!b || typeof n !== 'number') return;
    b.textContent = n;
    b.classList.toggle('zero', !n);
    el('#talkReadAll')?.toggleAttribute('hidden', !n);
  }
  /** "Mark all as read": one call clears every conversation's badge (talk.ts markAllSeen); the list updates in place. */
  async function markAllRead(btn) {
    btn.disabled = true;
    try {
      const r = await api('/api/talk/seen', { method: 'POST', body: {} });
      document.querySelectorAll('#talkList .talk-item .ib-count').forEach((n) => n.remove());
      for (const o of el('#dockConv').options) o.textContent = o.textContent.replace(/^● \(\d+\) /, '');
      setTalkCount(r.conversations);
    } catch (err) {
      btn.title = `Couldn't mark them read: ${err.message ?? err}`;
    } finally {
      btn.disabled = false;
    }
  }
  /** J sees this conversation (on screen, the page visible): Studio remembers its newest message as seen. */
  function markSeen(c) {
    if (!onScreen() || document.hidden) return;
    const at = c.messages.reduce((a, m) => (m.role === 'assistant' && m.at > a ? m.at : a), 0);
    if (!at || at <= Math.max(c.seen ?? 0, seenSent[c.id] ?? 0)) return;
    seenSent[c.id] = at;
    api(`/api/talk/${c.id}/seen`, { method: 'POST', body: { at } })
      .then((r) => { setTalkCount(r.conversations); document.querySelector(`#talkList [data-conv="${c.id}"] .ib-count`)?.remove(); })
      .catch(() => { delete seenSent[c.id]; });
  }

  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const secs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);
  /** Who answered and how it was billed: the harness, model, and plan or API cost. */
  function turnMark(t) {
    if (!t) return '';
    const h = t.harness || 'claude';
    const hName = harnessName(h);
    const brainTag = t.harness || t.model ? ` · ${esc(hName)}${t.model ? ` (${esc(t.model)})` : ''}` : '';
    const planTitle = h === 'cursor'
      ? 'Covered by the Cursor subscription'
      : h === 'copilot'
        ? 'Covered by the GitHub Copilot plan'
        : h === 'antigravity'
          ? 'Covered by the Google AI subscription'
          : h === 'gemini'
            ? 'Billed to the Gemini API key, per token'
            : t.billing === 'api'
              ? 'Billed to the API key, per token'
              : `Covered by the Claude Max subscription${t.cost ? ` (about $${t.cost.toFixed(2)} at API prices)` : ''}`;
    const planText = h === 'cursor'
      ? '✓ Cursor plan'
      : h === 'copilot'
        ? '✓ Copilot plan'
        : h === 'antigravity'
          ? '✓ Google AI plan'
          : h === 'gemini'
            ? `💳 ${t.cost ? `$${t.cost.toFixed(3)} ` : ''}Gemini API`
            : t.billing === 'api'
              ? `💳 $${t.cost.toFixed(3)} API`
              : '✓ Max plan';
    return `<div class="talk-turn ${t.billing}" title="${t.auto ? 'Studio started this answer when results came in. ' : ''}${planTitle}">${planText}${brainTag}${t.ms ? ` · ${secs(t.ms)}` : ''}${t.stopped ? ' · stopped' : ''}${t.call ? ' · 📞' : ''}${t.auto ? ' · <span class="talk-who">Studio</span> asked for this answer' : ''}</div>`;
  }
  const fileChips = (files) => (files?.length ? `<div class="talk-chips">${files.map((f) => `<span class="talk-chip" title="${esc(f.blob)}">${/^image\//.test(f.type ?? '') ? '🖼' : '📄'} ${esc(f.name)}${f.size ? ` · ${kb(f.size)}` : ''}</span>`).join('')}</div>` : '');

  function renderHead(c) {
    el('#talkHead').innerHTML = `<button class="small talk-lists" id="talkLists">☰</button>${c
      ? `<b class="talk-title">${esc(c.title ?? 'New conversation')}</b><button class="small" id="talkRename">Rename</button><button class="small" id="talkDelete">Delete</button>`
      : '<b class="talk-title">New conversation</b>'}`;
  }

  /** One message's HTML (with the turn mark after it), rendered once per version of the message. */
  function messageHtml(m) {
    return (m.role === 'tool'
      ? m.tool === 'guide' ? `<div class="talk-tool guide">${esc(m.text)}</div>` : `<div class="talk-tool">⚙ ${esc(m.text)}</div>`
      : m.notice
        ? `<div class="talk-msg assistant notice"><span class="talk-who">Studio</span>${md(m.text)}</div>`
        : `<div class="talk-msg ${m.role}">${m.role === 'user' ? (m.voice ? '<span class="talk-voice" title="Said on a call">🎙</span>' : '') + (m.via ? '<span class="talk-via" title="Sent by Claude through Studio\'s MCP">via MCP · </span>' : '') + esc(m.text).replace(/\n/g, '<br>') + fileChips(m.files) : md(m.text)}</div>`) + (turnMark(m.turn) ?? '');
  }

  // A customer's Studio (window.studioMe.customer): their own games, not J's; and Talk is on the Team plan and up.
  const empty = () => {
    const me = window.studioMe;
    if (!me?.customer) return `<div class="empty">Ask about the products: "What did last night's trial find?", "What are the agents working on?", "Make the Sick Of It shop screen feel more like Hell", "Is the PH Origins fix good to ship?"</div>`;
    // Talk is on every plan; it runs on their own AI, so it waits until they link one (Settings, or the card on top).
    const noAi = me.ai && !me.ai.ready;
    // One tap to start (J, 2026-10-30: the first 10 minutes): each puts its words in the box and sends them.
    const starts = STARTS.map((s) => `<button class="small" data-ask="${esc(s.say)}">${esc(s.label)}</button>`).join(' ');
    return `<div class="empty">${noAi ? `Talk runs on your own AI: connect it first. <button class="small" onclick="location.hash = '#settings'">Connect your AI</button><br><br>` : ''}Start here: ${starts}<br><br>Or ask about your projects: "What did last night's playtest find?", "What are the agents working on?", "Is the latest fix good to ship?"</div>`;
  };
  const STARTS = [
    { id: 'make', label: 'Make me a new game', say: 'I want to make a new game. Ask me what kind.' },
    { id: 'add', label: 'Add a project I already have', say: 'I want to add a project I already have (a game, a web app or a site).' },
    { id: 'github', label: 'Connect my GitHub', say: 'Help me connect my GitHub.' },
  ];
  // A deep link from sign-up (?ask=make#talk): that start is in the box, ready to send.
  const ask = STARTS.find((s) => s.id === params.get('ask'));
  if (ask) {
    params.delete('ask');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
    queueMicrotask(() => { const box = el('#talkInput'); if (box && !box.value) { box.value = ask.say; box.focus(); } });
  }
  const tail = () => el('#talkLog .talk-tail');

  /** The bubble the active brain is writing into, or "thinking…" (the only part redrawn while an answer streams). */
  function renderTail() {
    const t = tail();
    if (!t) return;
    const thinking = conv?.status === 'thinking';
    const log = el('#talkLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const hName = esc(conv?.label || harnessName(conv?.harness || window.talkBrain?.harness));
    const mName = conv?.model || window.talkBrain?.model;
    const who = mName ? `${hName} (${esc(mName)})` : hName;
    t.innerHTML = !thinking ? '' : live?.text
      ? `<div class="talk-msg assistant streaming">${md(live.text)}<span class="talk-caret"></span></div>`
      : `<div class="talk-tool">${conv.messages.at(-1)?.notice ? `Studio asked ${who} to explain the result…` : `${who} is thinking…`}</div>`;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  let tailFrame = 0;
  const tailSoon = () => { if (!tailFrame) tailFrame = requestAnimationFrame(() => { tailFrame = 0; renderTail(); }); };

  /** Follows the answer as Claude writes it (talk.ts talkEvents), while the conversation on screen is thinking. */
  function follow(id) {
    if (live?.id === id) return;
    unfollow();
    const es = new EventSource(`/api/talk/${id}/events`);
    live = { id, es, text: '', ended: false };
    es.onmessage = (m) => {
      if (live?.es !== es) return;
      let e;
      try { e = JSON.parse(m.data); } catch { return; }
      if (e.type === 'hello' && e.status !== 'thinking') { unfollow(); loadConversation().catch(() => {}); return; } // it just ended
      if (e.type === 'hello') { live.text = e.partial ?? ''; live.ended = false; }
      else if (e.type === 'start') { live.text = ''; live.ended = false; }
      else if (e.type === 'delta') live.text += e.text ?? '';
      else if (e.type === 'end') live.ended = true; // the block becomes a message: it comes with the next fetch
      else if (e.type === 'idle') { unfollow(); loadConversation().catch(() => {}); loadList().catch(() => {}); return; }
      if (!document.hidden) tailSoon();
    };
  }
  function unfollow() {
    try { live?.es.close(); } catch {}
    live = null;
  }

  async function loadConversation() {
    if (!current) {
      unfollow();
      conv = null;
      rows = [];
      msgHtml.length = 0;
      head = '';
      renderHead(null);
      el('#talkLog').innerHTML = empty();
      el('#talkSend').disabled = false;
      el('#talkStop').hidden = true;
      return;
    }
    // Only the newer messages when this conversation is already on screen (the last one again: its turn mark is added
    // to it when the answer ends). From the page itself (approval.js's call): Approve cards come with their token only
    // to J's dashboard.
    const id = current;
    const have = conv?.id === id ? conv.messages.length : 0;
    const after = Math.max(0, have - 1);
    const r = await approvals.call(`/api/talk/${id}${after ? `?after=${after}` : ''}`);
    if (id !== current) return; // J switched meanwhile
    if (r.error) { current = null; return loadConversation(); }
    const messages = r.from === after && after <= have ? [...(conv?.id === id ? conv.messages.slice(0, after) : []), ...r.messages] : r.from === 0 ? r.messages : null;
    if (!messages || messages.length !== r.total) { conv = null; return loadConversation(); } // out of step: everything again
    const c = { ...r, messages };
    const switched = conv?.id !== c.id;
    conv = c;
    // Talk showing J around (studio_guide): this page runs what waits for the conversation (guide.js).
    if (c.guide?.length) window.studioGuide?.offer(c.id, c.guide);
    const thinking = c.status === 'thinking';
    if (thinking) follow(c.id); else unfollow();
    if (live?.ended && messages.length > have) { live.text = ''; live.ended = false; } // the finished block is a message now
    render(c, switched);
    markSeen(c);
    el('#talkSend').disabled = thinking;
    el('#talkStop').hidden = !thinking;
  }

  /** Draws what changed: new messages are appended, changed ones (a turn mark, a card's status) redrawn in place. */
  function render(c, all = false) {
    const h = `${c.id}|${c.title}`;
    if (h !== head) { head = h; renderHead(c); }
    const log = el('#talkLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    // Approve / Deny cards Talk asked for in this conversation (pending, and decided in the last hour), in the flow
    // where they were asked (approval.js place).
    const at = new Map();
    for (const p of approvals.place(c.messages, c.approvals ?? [])) at.set(p.after, (at.get(p.after) ?? '') + p.html);
    const next = [at.get(0) ?? ''];
    c.messages.forEach((m, i) => {
      const key = JSON.stringify(m);
      if (msgHtml[i]?.key !== key) msgHtml[i] = { key, html: messageHtml(m) };
      next.push(msgHtml[i].html + (at.get(i + 1) ?? ''));
    });
    msgHtml.length = c.messages.length;
    if (all || !tail()) {
      log.innerHTML = `${next.map((x) => `<div class="talk-row">${x}</div>`).join('')}<div class="talk-row talk-tail"></div>`;
      rows = next;
      renderTail();
      log.scrollTop = log.scrollHeight;
      return;
    }
    const nodes = log.querySelectorAll(':scope > .talk-row:not(.talk-tail)');
    let added = false;
    next.forEach((x, i) => {
      if (i < nodes.length) { if (rows[i] !== x) nodes[i].innerHTML = x; return; }
      const row = document.createElement('div');
      row.className = 'talk-row';
      row.innerHTML = x;
      tail().before(row);
      added = true;
    });
    for (let i = next.length; i < nodes.length; i++) nodes[i].remove();
    rows = next;
    renderTail();
    if (atBottom) log.scrollTop = log.scrollHeight; // never yank a reader who scrolled up (send() scrolls down itself)
  }

  // The push stream (stream.js): a conversation changed (or the safety tick, or a reconnect). The badge comes with the
  // event; the conversation on screen is refetched when it is the one that changed, the list when Talk is on screen.
  let listAt = 0;
  let listTimer = null;
  /** The list at most every 2 s (a busy answer saves often). */
  function listSoon() {
    if (listTimer) return;
    listTimer = setTimeout(() => { listTimer = null; listAt = Date.now(); loadList().catch(() => {}); }, Math.max(0, listAt + 2000 - Date.now()));
  }
  studioStream.on('talk', (e) => {
    if (typeof e.unseen === 'number') setTalkCount(e.unseen);
    if (e.badge) return;
    if (!window.__talkLoaded || !onScreen()) {
      if (typeof e.unseen !== 'number') pollTalkCount();
      return;
    }
    listSoon();
    if (current && (!e.ids || e.ids.includes(current))) loadConversation().catch(() => {});
  });

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
        const r = await fetch(`/api/gen/v1/blobs`, { method: 'POST', headers: { 'X-Filename': item.name }, body: file });
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
      const lg = el('#talkLog'); if (lg) lg.scrollTop = lg.scrollHeight; // your own message: show it
    } catch (e) {
      alert(e.message);
      el('#talkInput').value = text;
      pending = files;
      renderPending();
    }
  }

  document.addEventListener('click', async (e) => {
    const start = e.target.closest('[data-ask]');
    if (start) {
      el('#talkInput').value = start.dataset.ask;
      if (window.studioMe?.ai && !window.studioMe.ai.ready) el('#talkInput').focus(); else send();
      return;
    }
    if (e.target.id === 'talkReadAll') { markAllRead(e.target); return; }
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
        if (title !== null) { await api(`/api/talk/${current}`, { method: 'PATCH', body: { title } }); head = ''; await loadList(); await loadConversation(); }
      }
      if (e.target.id === 'talkDelete' && current && confirm('Delete this conversation?')) {
        await api(`/api/talk/${current}`, { method: 'DELETE' });
        current = null;
        await loadList();
        await loadConversation();
      }
    } catch (err) { alert(err.message); }
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const text = cp.parentElement.querySelector('pre')?.textContent ?? '';
      const done = () => { cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1500); };
      try { await navigator.clipboard.writeText(text); done(); } catch {
        // No clipboard permission (an insecure page): the old way, through a selection.
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.append(ta); ta.select(); try { document.execCommand('copy'); done(); } catch { cp.textContent = 'Copy failed'; } ta.remove();
      }
      return;
    }
    const ref = e.target.closest('[data-ref]');
    if (ref) { openRef(ref.dataset.ref); return; }
    const media = e.target.closest('[data-media]');
    if (media && !(e.ctrlKey || e.metaKey || e.shiftKey || e.button)) {
      e.preventDefault();
      // Through Studio's relay (this session, no signature, never expires); the signed link itself stays the anchor's href.
      const id = /\/v1\/files\/([A-Za-z0-9_]+)/.exec(media.dataset.media)?.[1];
      const u = id ? `/api/gen/v1/files/${id}` : media.dataset.media;
      const r = await fetch(u, { method: 'HEAD' }).catch(() => null);
      const type = r?.headers.get('content-type') ?? '';
      view(type.startsWith('video/') ? `<video src="${u}" controls autoplay></video>` : type.startsWith('image/') ? `<img src="${u}">` : `<a href="${u}" target="_blank">Open file</a>`);
    }
  });
  // J tapped Approve or Deny somewhere: the chat shows what happened.
  addEventListener('studio-approval', () => { rows = []; if (current) loadConversation().catch(() => {}); });
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
  // The on-screen keyboard: iOS doesn't shrink dvh for it, so Talk's height and the dock's bottom follow the visual
  // viewport (events only, no timer): the input stays above the keyboard and the newest message stays in view.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const setVv = () => {
      const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
      const root = document.documentElement.style;
      root.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.setProperty('--kb', `${kb}px`);
      document.body.classList.toggle('kb-open', kb > 120);
      if (kb > 120 && document.activeElement?.closest?.('.talk-input')) {
        const log = document.querySelector('#talkLog, .talk-log'); if (log) log.scrollTop = log.scrollHeight;
      }
    };
    vv.addEventListener('resize', setVv); vv.addEventListener('scroll', setVv); setVv();
  }
  // Dropping files on the conversation attaches them.
  // Chips are keyboard-reachable too; titles and inline media are filled in whenever a bubble is drawn.
  el('#talkLog').addEventListener('keydown', (e) => { const r = e.target.closest?.('[data-ref]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openRef(r.dataset.ref); } });
  { let queued = false; new MutationObserver(() => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; hydrate(el('#talkLog')); }); }).observe(el('#talkLog'), { childList: true, subtree: true }); }
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
    placeTalk();
    // Back on the Talk tab: what came in meanwhile is seen now (the dock does this in placeTalk).
    if (e.detail === 'talk' && window.__talkLoaded) window.loadTalk().catch(() => {});
    // On a phone during a call the tabs are one row that scrolls sideways: keep the tab J is on in view.
    if (document.body.classList.contains('in-call')) document.querySelector('nav button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  // What Talk sees follows J's clicks (app.js remembers them first).
  document.querySelector('main').addEventListener('click', () => {
    if (!el('#talkDock').hidden) setTimeout(() => (el('#dockCtx').textContent = ctxText(window.studioContext?.())), 0);
  });
  el('#dockBtn').addEventListener('click', () => setDocked(!docked));
  el('#dockClose').addEventListener('click', () => setDocked(false));
  el('#dockFull').addEventListener('click', () => show('talk'));
  el('#dockConv').addEventListener('change', (e) => { current = e.target.value || null; loadConversation().catch(() => {}); });

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

  // The Talk tab's badge on every tab (the Inbox's style), kept fresh by the push stream (above); coming back to the page
  // counts as seeing what's on screen.
  el('nav button[data-tab="talk"]').insertAdjacentHTML('beforeend', ' <span class="ib-count zero" id="talkCount" title="Conversations with new messages you haven\'t seen">0</span>');
  const pollTalkCount = () => { if (!document.hidden) api('/api/talk?count=1').then((r) => setTalkCount(r.unseen)).catch(() => {}); };
  pollTalkCount();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollTalkCount();
    if (current && onScreen() && window.__talkLoaded) loadConversation().catch(() => {});
  });
})();
