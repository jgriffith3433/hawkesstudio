// The Social tab (#social): Studio's YouTube and TikTok accounts (src/social.ts, docs/social.md) and the videos posted
// to them. Posts never go public from here: YouTube uploads are private, TikTok ones wait in the app's inbox as drafts,
// and J makes them public on the platform. Uses app.js's helpers ($, esc, api, ago).
(() => {
  const NAMES = { youtube: 'YouTube', tiktok: 'TikTok' };
  const HELP = {
    youtube: 'Google Cloud console: enable "YouTube Data API v3", make an OAuth client (Web application) with the redirect below, add the youtube.upload scope, and set the consent screen to "In production" (in "Testing" the sign-in lasts 7 days).',
    tiktok: 'developers.tiktok.com: an app with Login Kit and Content Posting API, the redirect below, scopes user.info.basic and video.upload, and your account as a sandbox target user until the app is reviewed.',
  };
  const STATUS = { queued: 'queued', uploading: 'uploading…', private: 'uploaded, private: make it public on YouTube', 'in inbox': 'in your TikTok inbox: open TikTok and post it', posted: 'posted', failed: 'failed' };

  function accountCard(p, a) {
    const state = a.connected ? `<span class="pill ship">Connected</span> ${esc(a.name ?? '')}` : a.configured ? '<span class="pill">Not connected</span>' : '<span class="pill">Not set up</span>';
    return `<div class="card" style="max-width:none">
      <h3>${NAMES[p]} <small>${state}</small></h3>
      ${a.connected
        ? `<div class="status-line">Connected ${esc(ago(a.connectedAt))}${a.refreshExpires ? `; sign in again before ${new Date(a.refreshExpires).toLocaleDateString()}` : ''}.</div>
           <div class="row" style="display:flex;gap:8px"><a class="small button" href="/api/social/connect/${p}">Reconnect</a><button class="small" data-disconnect="${p}">Disconnect</button></div>`
        : a.configured
          ? `<div class="row"><a class="button primary" href="/api/social/connect/${p}">Connect ${NAMES[p]}</a></div>`
          : ''}
      <details class="more-details"${a.configured ? '' : ' open'}><summary>${a.configured ? 'App settings' : 'Set up the app'}</summary>
        <p class="dim" style="font-size:13px">${esc(HELP[p])}</p>
        <p style="font-size:13px">Redirect URI: <code>${esc(a.redirect)}</code></p>
        <form data-config="${p}" style="display:grid;gap:6px;max-width:520px">
          <input name="clientId" placeholder="${p === 'tiktok' ? 'Client key' : 'Client ID'}" required autocomplete="off">
          <input name="clientSecret" placeholder="Client secret" type="password" required autocomplete="off">
          <button type="submit" class="small" style="justify-self:start">Save</button>
        </form>
      </details>
    </div>`;
  }

  function postRow(p) {
    const res = Object.entries(p.results ?? {}).map(([k, r]) => {
      const link = r.edit ? ` <a href="${esc(r.edit)}" target="_blank" rel="noopener">open in YouTube Studio</a>` : '';
      return `<div>${NAMES[k] ?? esc(k)}: ${esc(STATUS[r.status] ?? r.status)}${link}${r.error ? ` <span class="red">${esc(r.error)}</span>` : ''}</div>`;
    }).join('');
    return `<tr><td style="white-space:nowrap">${esc(ago(p.created))}</td>
      <td><b>${esc(p.title)}</b>${p.product ? ` <small class="dim">${esc(p.product)}</small>` : ''}<br><a href="/api/gen/v1/files/${esc(p.asset)}" target="_blank" rel="noopener" class="dim" style="font-size:12px">${esc(p.asset)}</a>
        ${p.description ? `<details class="more-details"><summary>Caption</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(p.description)}</pre><button class="small" data-copy="${esc(p.id)}">Copy caption</button></details>` : ''}</td>
      <td style="font-size:13px">${res}</td></tr>`;
  }

  let last = null;
  async function load() {
    const el = $('#socialBody');
    if (!el) return;
    const msg = new URLSearchParams(location.search).get('social');
    if (msg) history.replaceState(null, '', location.pathname + location.hash);
    const d = await api('/api/social');
    last = d;
    const connected = Object.entries(d.accounts).filter(([, a]) => a.connected).map(([p]) => p);
    el.innerHTML = `${msg ? `<div class="card" style="max-width:none;border-color:var(--accent)">${esc(msg)}</div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-bottom:18px">${Object.entries(d.accounts).map(([p, a]) => accountCard(p, a)).join('')}</div>
      <div class="card" style="max-width:none">
        <h3>Post a video <small>a finished .mp4 in Hawkes Gen's library</small></h3>
        ${connected.length ? `<form id="socialPost" style="display:grid;gap:6px;max-width:640px">
          <input name="asset" placeholder="Gen asset id of the video (a_...)" required>
          <input name="title" placeholder="Title (YouTube; add #Shorts for a Short)" maxlength="100" required>
          <textarea name="description" rows="4" placeholder="Description / caption (TikTok: paste it in the app)"></textarea>
          <input name="tags" placeholder="Tags, comma separated">
          <div style="display:flex;gap:12px">${connected.map((p) => `<label><input type="checkbox" name="platforms" value="${p}" checked> ${NAMES[p]}</label>`).join('')}</div>
          <button type="submit" style="justify-self:start">Upload as drafts</button>
        </form>` : '<div class="status-line">Connect YouTube or TikTok above first.</div>'}
      </div>
      <h3 style="margin:18px 0 8px">Posts</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px" class="social-posts"><tbody>${d.posts.map(postRow).join('') || '<tr><td class="dim">Nothing posted yet. Agents post with studio_social_post.</td></tr>'}</tbody></table>`;
  }

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.matches?.('form[data-config]')) {
      e.preventDefault();
      try { await api('/api/social/config', { method: 'POST', body: { platform: f.dataset.config, clientId: f.clientId.value, clientSecret: f.clientSecret.value } }); await load(); } catch (x) { alert(x.message); }
    }
    if (f.id === 'socialPost') {
      e.preventDefault();
      const platforms = [...f.querySelectorAll('input[name=platforms]:checked')].map((i) => i.value);
      try { await api('/api/social/posts', { method: 'POST', body: { asset: f.asset.value.trim(), title: f.title.value, description: f.description.value, tags: f.tags.value, platforms } }); await load(); } catch (x) { alert(x.message); }
    }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset?.disconnect && confirm(`Disconnect ${NAMES[t.dataset.disconnect]}?`)) {
      try { await api(`/api/social/disconnect/${t.dataset.disconnect}`, { method: 'POST', body: {} }); await load(); } catch (x) { alert(x.message); }
    }
    if (t.dataset?.copy) {
      const p = last?.posts.find((x) => x.id === t.dataset.copy);
      if (p) { await navigator.clipboard.writeText(`${p.title}\n\n${p.description}`); t.textContent = 'Copied'; }
    }
  });
  window.loadSocialTab = load;
})();
