// Plugins (plugins.ts, docs/plugins.md; J, 2026-10-31: "a suite of plugins ... show when plugins are available or if
// installed and what version and allow upgrading if out of date"): the Plugins page (#plugins, under More) lists the
// catalog with each engine's latest version and, on request, every project's installed versions side by side; the
// project dialog's Plugins section (studioProjectPlugins) shows that project's status with Install / Upgrade buttons.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const api = (p, o = {}) => window.api(p, o);
  const ENGINE = { unity: 'Unity', web: 'Web', babylon: 'Babylon.js', godot: 'Godot' };
  const link = (u, t) => (u && /^https?:/.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>` : '');

  if (!document.getElementById('pluginsCss')) {
    const css = document.createElement('style');
    css.id = 'pluginsCss';
    css.textContent = `
      .pg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
      .pg-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; display: grid; gap: 6px; align-content: start; min-width: 0; }
      .pg-card h3 { margin: 0; font-size: 16px; }
      .pg-card p { margin: 0; color: var(--dim); font-size: 13px; }
      .pg-card ul { margin: 0; padding-left: 18px; font-size: 13px; }
      .pg-eng { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 13px; }
      .pg-badge { font-size: 11px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--dim); white-space: nowrap; }
      .pg-badge.ok { color: var(--accent); border-color: rgba(51,214,166,.4); }
      .pg-badge.old { color: var(--amber); border-color: rgba(255,190,85,.4); }
      .pg-badge.soon { opacity: .7; }
      .pg-row { border-top: 1px solid var(--line); padding: 8px 0; display: grid; gap: 4px; }
      .pg-row:first-of-type { border-top: 0; }
      .pg-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .pg-table td, .pg-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }`;
    document.head.append(css);
  }

  const badge = (cls, text, title = '') => `<span class="pg-badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  /** One engine's status as badges: Installed vX / Latest vY / Outdated / Not installed. */
  function engineBadges(e) {
    const out = [`<b>${esc(ENGINE[e.engine] ?? e.engine)}</b>`];
    if (e.installed) out.push(badge(e.outdated ? 'old' : 'ok', `Installed ${e.version && e.version !== 'unknown' ? (/^\d/.test(e.version) ? `v${e.version}` : e.version) : ''}`.trim(), e.where ? `${e.where.repo} ${e.where.path}${e.where.line ? `:${e.where.line}` : ''}` : ''));
    else if (e.available) out.push(badge('', 'Not installed'));
    if (e.latest) out.push(badge('', `Latest v${e.latest}`));
    if (e.outdated) out.push(badge('old', 'Outdated'));
    if (!e.available) out.push(badge('soon', 'Coming soon', e.why ?? ''));
    return out.join(' ');
  }

  // ------------------------------------------------------------ the project dialog's section
  async function studioProjectPlugins(id, box) {
    if (!box) return;
    box.innerHTML = '<div class="meta"><b>Plugins:</b> checking its repositories…</div>';
    let r;
    try { r = await api(`/api/projects/${id}/plugins`); } catch (e) { box.innerHTML = `<div class="meta"><b>Plugins:</b> ${esc(e.message)}</div>`; return; }
    if (!r.repos.length) { box.innerHTML = `<div class="meta"><b>Plugins:</b> ${esc(r.note ?? 'connect a GitHub repository first.')}</div>`; return; }
    const fits = r.plugins.filter((p) => p.applies);
    const rest = r.plugins.filter((p) => !p.applies);
    const row = (p) => {
      const engines = p.engines.filter((e) => e.applies || e.installed);
      const acts = engines.map((e) => {
        if (e.action === 'install') return `<button type="button" class="small primary" data-pg-install="${esc(p.id)}" data-engine="${esc(e.engine)}">Install${engines.length > 1 ? ` (${esc(ENGINE[e.engine] ?? e.engine)})` : ''}</button>`;
        if (e.action === 'upgrade') return `<button type="button" class="small primary" data-pg-install="${esc(p.id)}" data-engine="${esc(e.engine)}">Upgrade to v${esc(e.latest)}</button>`;
        return '';
      }).join(' ');
      const wire = p.wire && engines.some((e) => e.action === 'install' || e.action === 'upgrade') ? ` <button type="button" class="small" data-pg-wire="${esc(p.id)}" data-engine="${esc((engines.find((e) => e.action === 'install' || e.action === 'upgrade') ?? {}).engine ?? '')}" title="An agent adds it and wires it into the game, starting from the plugin's branch">Set it up with an agent</button>` : '';
      return `<div class="pg-row"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>${esc(p.name)}</b><span>${acts}${wire}</span></div>
        <div class="meta">${esc(p.description)}</div>
        ${engines.map((e) => `<div class="pg-eng">${engineBadges(e)}${e.note ? ` <span class="meta">${esc(e.note)}</span>` : ''}</div>`).join('')}
        ${p.setup.length && !p.installed ? `<details class="meta"><summary>Setup</summary><ul>${p.setup.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
        <div class="meta" data-pg-msg="${esc(p.id)}"></div></div>`;
    };
    const opened = (r.installs ?? []).filter((i) => i.pr_url && i.status === 'open').slice(0, 3);
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>Plugins</b><span class="meta">${r.repos.map((x) => `${esc(x.repo)}${x.ref ? ` @ ${esc(x.ref)}` : ''}${x.error ? ` (${esc(x.error)})` : ''}`).join(' · ')} <button type="button" class="small" data-pg-refresh>Check again</button></span></div>
      ${opened.length ? `<div class="meta">Open: ${opened.map((i) => `<a href="${esc(i.pr_url)}" target="_blank" rel="noopener">${esc(i.plugin)} ${esc(i.version)} ↗</a>`).join(' · ')}</div>` : ''}
      ${fits.length ? fits.map(row).join('') : '<div class="meta">None of the plugins fit what Studio found in its repositories yet.</div>'}
      ${rest.length ? `<details class="meta"><summary>Not for this project (${rest.length})</summary>${rest.map((p) => `<div>${esc(p.name)}: ${esc(p.engines.map((e) => ENGINE[e.engine] ?? e.engine).join(', '))} only</div>`).join('')}</details>` : ''}`;
    const say = (pid, html) => { const m = box.querySelector(`[data-pg-msg="${CSS.escape(pid)}"]`); if (m) m.innerHTML = html; };
    box.querySelector('[data-pg-refresh]')?.addEventListener('click', async () => { await api(`/api/projects/${id}/plugins?fresh=1`).catch(() => null); studioProjectPlugins(id, box); });
    const go = (agent) => async (ev) => {
      const b = ev.target;
      const pid = b.dataset.pgInstall ?? b.dataset.pgWire;
      b.disabled = true;
      say(pid, agent ? 'Starting an agent…' : 'Making the branch and the pull request…');
      try {
        const s = await api(`/api/projects/${id}/plugins/${pid}`, { method: 'POST', body: { engine: b.dataset.engine || undefined, agent } });
        say(pid, s.url ? `${esc(s.note)} <a href="${esc(s.url)}" target="_blank" rel="noopener">Open the pull request ↗</a>` : esc(s.note ?? 'Done.'));
      } catch (e) { say(pid, `<span style="color:var(--red)">${esc(e.message)}</span>`); b.disabled = false; }
    };
    box.querySelectorAll('[data-pg-install]').forEach((b) => b.addEventListener('click', go(false)));
    box.querySelectorAll('[data-pg-wire]').forEach((b) => b.addEventListener('click', go(true)));
  }
  window.studioProjectPlugins = studioProjectPlugins;

  // ------------------------------------------------------------ the Plugins page
  async function loadPluginsTab() {
    const box = $('#pgBody');
    if (!box || box.dataset.loaded) return;
    let c;
    try { c = await api('/api/plugins'); } catch (e) { box.innerHTML = `<div class="meta">${esc(e.message)}</div>`; return; }
    box.dataset.loaded = '1';
    box.innerHTML = `<div class="pg-grid">${c.plugins.map((p) => `<div class="pg-card">
        <div class="meta">${esc(p.category ?? 'plugin')}</div><h3>${esc(p.name)}</h3>
        <p>${esc(p.description)}</p>
        <ul>${p.gives.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
        ${Object.entries(p.engines).map(([e, r]) => `<div class="pg-eng"><b>${esc(ENGINE[e] ?? e)}</b>${r.latest ? badge('', `Latest v${r.latest}`) : ''}${r.available ? badge('ok', 'Available') : badge('soon', 'Coming soon', r.why ?? '')}<span class="meta">${esc(r.kind)}</span></div>`).join('')}
        ${p.setup.length ? `<details class="meta"><summary>Setup</summary><ul>${p.setup.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
        <div class="meta">${[link(p.homepage, 'Home'), link(p.docs, 'Docs')].filter(Boolean).join(' · ')}</div>
      </div>`).join('')}</div>
      <div class="pg-card" style="margin-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h3>Your projects</h3><button type="button" class="small primary" id="pgCheck">Check every project</button></div>
        <div class="meta">Which plugins each project has, which version, and what is out of date (Studio reads each repository on GitHub). Open a project to install or upgrade.</div>
        <div id="pgProjects"></div>
      </div>`;
    $('#pgCheck').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      const out = $('#pgProjects');
      const { products } = await api('/api/products');
      out.innerHTML = `<table class="pg-table"><tr><th>Project</th>${c.plugins.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr>${products.map((x) => `<tr data-pg-proj="${esc(x.id)}"><td><a href="#" data-pg-open="${esc(x.id)}">${esc(x.name)}</a></td>${c.plugins.map(() => '<td class="meta">…</td>').join('')}</tr>`).join('')}</table>`;
      out.querySelectorAll('[data-pg-open]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); window.studioEditGame?.(a.dataset.pgOpen); }));
      // A few at a time: each one reads its repositories on GitHub.
      const queue = [...products];
      const work = async () => {
        for (let x = queue.shift(); x; x = queue.shift()) {
          const tr = out.querySelector(`[data-pg-proj="${CSS.escape(x.id)}"]`);
          try {
            const s = await api(`/api/projects/${x.id}/plugins`);
            tr.innerHTML = `<td><a href="#" data-pg-open="${esc(x.id)}">${esc(x.name)}</a></td>${s.plugins.map((p) => {
              const inst = p.engines.filter((e) => e.installed);
              if (inst.length) return `<td>${inst.map((e) => badge(e.outdated ? 'old' : 'ok', `${ENGINE[e.engine] ?? e.engine} ${/^\d/.test(e.version ?? '') ? `v${e.version}` : (e.version ?? '')}${e.outdated ? ` → v${e.latest}` : ''}`)).join(' ')}</td>`;
              return `<td class="meta">${p.applies ? 'not installed' : '—'}</td>`;
            }).join('')}`;
            tr.querySelector('[data-pg-open]')?.addEventListener('click', (e) => { e.preventDefault(); window.studioEditGame?.(x.id); });
          } catch (e) { tr.lastElementChild.textContent = e.message; }
        }
      };
      await Promise.all([work(), work(), work()]);
      ev.target.disabled = false;
    });
  }
  window.loadPluginsTab = loadPluginsTab;
})();
