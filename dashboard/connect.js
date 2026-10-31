// The Connect page (#connect, /connect; J, 2026-10-31: "an easy way for customers to connect to their MCP servers from
// within studio", like the old portal's /connect): this Studio's MCP address, a button or one line per editor, and the
// editors you connected with Disconnect. Editors sign in through the browser (OAuth): no keys to paste.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const api = (p, o = {}) => window.api(p, o);
  const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');

  if (!document.getElementById('connectCss')) {
    const css = document.createElement('style');
    css.id = 'connectCss';
    css.textContent = `
      .cn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
      .cn-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; display: grid; gap: 8px; align-content: start; min-width: 0; }
      .cn-card h3 { margin: 0; font-size: 16px; }
      .cn-card p { margin: 0; color: var(--dim); font-size: 13px; }
      .cn-copy { display: flex; min-width: 0; border: 1px solid var(--line); border-radius: 7px; background: var(--panel2); }
      .cn-copy code { flex: 1; min-width: 0; padding: 7px 9px; font-size: 12px; overflow-x: auto; white-space: nowrap; }
      .cn-copy button { border: 0; border-left: 1px solid var(--line); border-radius: 0 7px 7px 0; padding: 0 10px; }
      .cn-url { font: 600 18px ui-monospace, monospace; word-break: break-all; }
      .cn-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .cn-steps { margin: 0; padding-left: 20px; font-size: 13px; display: grid; gap: 3px; }
      .cn-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .cn-table td, .cn-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }`;
    document.head.append(css);
  }

  const copyBox = (id, text) => `<div class="cn-copy"><code id="${id}">${esc(text)}</code><button type="button" class="small" data-copy="${id}">Copy</button></div>`;

  async function loadConnectTab() {
    const box = $('#cnBody');
    let c;
    try { c = await api('/api/connect'); } catch (e) { box.innerHTML = `<div class="meta">${esc(e.message)}</div>`; return; }
    const url = c.url;
    const name = c.name;
    const cli = `claude mcp add --transport http --scope user ${name} ${url}`;
    const cursor = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${btoa(JSON.stringify({ url }))}`;
    const vs = encodeURIComponent(JSON.stringify({ name, type: 'http', url }));
    const used = (re) => c.connections.find((x) => re.test(x.name));
    const badge = (re) => { const x = used(re); return x ? ` <span class="meta">✓ connected${x.last_used ? `, used ${esc(day(x.last_used))}` : ''}</span>` : ''; };
    box.innerHTML = `
      <div class="cn-card" style="margin-bottom:12px">
        <div class="meta">This Studio's MCP server</div>
        <div class="cn-url" id="cnUrl">${esc(url)}</div>
        <div class="cn-row"><button type="button" class="small primary" data-copy="cnUrl">Copy the address</button>
          <span class="meta">Add it in your editor; the first time it opens Studio to sign in and allow it. No keys to paste.</span></div>
        ${c.mayConnect ? '' : '<div class="meta" style="color:var(--amber)">Studio\'s tools act as this Studio\'s owner, so only its admins can connect an editor. Ask an admin, or use the dashboard.</div>'}
      </div>
      <div class="cn-grid">
        <div class="cn-card">
          <div class="meta">Anthropic</div><h3>Claude${badge(/claude/i)}</h3>
          <p>The Claude app or claude.ai: <b>Customize → Connectors → + Add → Add custom connector</b>, paste the address, then <b>Connect</b> and allow it in Studio.</p>
          <div class="cn-row"><a class="button primary" data-claude href="claude://claude.ai/customize/connectors">Open Claude</a><a class="button" data-claude href="https://claude.ai/customize/connectors" target="_blank" rel="noopener">claude.ai</a></div>
          <div class="meta">Both copy the address first.</div>
        </div>
        <div class="cn-card">
          <div class="meta">Anthropic</div><h3>Claude Code${badge(/claude code/i)}</h3>
          <p>Run this in a terminal, then <code>/mcp</code> in Claude Code and pick <b>${esc(name)}</b> to sign in.</p>
          ${copyBox('cnCli', cli)}
          <p>Or paste it into a Claude Code session and ask it to add the server.</p>
        </div>
        <div class="cn-card">
          <div class="meta">Cursor</div><h3>Cursor${badge(/cursor/i)}</h3>
          <p>Opens Cursor's install dialog. Then <b>Connect</b> next to ${esc(name)} in Cursor's MCP settings.</p>
          <div class="cn-row"><a class="button primary" href="${esc(cursor)}">Add to Cursor</a></div>
        </div>
        <div class="cn-card">
          <div class="meta">Microsoft</div><h3>VS Code${badge(/visual studio code|vs ?code/i)}</h3>
          <p>For GitHub Copilot's agent mode. VS Code asks you to trust it, then signs you in.</p>
          <div class="cn-row"><a class="button primary" href="vscode:mcp/install?${vs}">Install in VS Code</a><a class="button" href="vscode-insiders:mcp/install?${vs}">Insiders</a></div>
        </div>
        <div class="cn-card">
          <div class="meta">Codeium</div><h3>Windsurf${badge(/windsurf/i)}</h3>
          <p>Add this to <code>~/.codeium/windsurf/mcp_config.json</code>, then refresh its MCP servers.</p>
          ${copyBox('cnWs', JSON.stringify({ mcpServers: { [name]: { serverUrl: url } } }))}
        </div>
        <div class="cn-card">
          <div class="meta">OpenAI</div><h3>ChatGPT${badge(/chatgpt|openai/i)}</h3>
          <p>With developer mode on: <b>Settings → Apps &amp; Connectors → Create</b>. Paste the address and choose OAuth.</p>
          ${copyBox('cnGpt', url)}
        </div>
        <div class="cn-card">
          <div class="meta">Anything else</div><h3>Any MCP client</h3>
          <p>Streamable HTTP at the address above, with OAuth sign-in (it finds Studio's sign-in by itself).</p>
          ${copyBox('cnAny', JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }))}
        </div>
      </div>
      <div class="cn-card" style="margin-top:12px">
        <h3>Your connected editors</h3>
        ${c.connections.length ? `<table class="cn-table"><tr><th>App</th><th>Connected</th><th>Last used</th><th></th></tr>${c.connections.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(day(x.created))}</td><td>${esc(day(x.last_used))}</td><td style="text-align:right"><button type="button" class="small" data-revoke="${esc(x.id)}">Disconnect</button></td></tr>`).join('')}</table>`
          : '<div class="meta">None yet. Add this Studio to an editor above.</div>'}
      </div>
      <div class="meta" id="cnMsg" style="margin-top:8px"></div>`;

    const msg = (t) => { $('#cnMsg').textContent = t; setTimeout(() => { if ($('#cnMsg')?.textContent === t) $('#cnMsg').textContent = ''; }, 3000); };
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); msg('Copied.'); } catch { msg('Select it and copy.'); } };
    box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(document.getElementById(b.dataset.copy).textContent)));
    // Claude has no install link: copy the address on the way to its Connectors page.
    box.querySelectorAll('[data-claude]').forEach((a) => a.addEventListener('click', () => { void copy(url); msg('Address copied: paste it in Claude.'); }));
    box.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Disconnect this editor? It stops working until you connect it again.')) return;
      b.disabled = true;
      try { await api(`/api/connect/${b.dataset.revoke}/revoke`, { method: 'POST' }); await loadConnectTab(); } catch (e) { b.disabled = false; msg(e.message); }
    }));
  }
  window.loadConnectTab = loadConnectTab;
})();
