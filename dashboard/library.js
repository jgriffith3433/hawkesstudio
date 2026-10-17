// The Library tab: Hawkes Gen's library for every product (hawkesgen/docs/library.md). "Waiting" lists the entities with
// takes nobody has picked yet, across products; pick a product to browse and work its entities with Gen's web
// components (hawkesgen-ui.mjs, a copy synced by hawkesgen/bin/hawkesgen-sdk.mjs). Gen is reached through Studio
// (/api/gen/v1, library.ts), and a pick is written into the product's beta (POST /api/library/writeback) when its
// folders are in its repo. Uses app.js's helpers ($, esc, api).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    hg-library, hg-entity, hg-slot { --hg-bg: var(--panel2); --hg-panel: var(--panel); --hg-fg: var(--text); --hg-muted: var(--dim); --hg-line: var(--line); --hg-accent: var(--accent); }
    .lb-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .lb-wait { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .lb-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; cursor: pointer; text-align: left; color: var(--text); }
    .lb-card:hover { border-color: var(--accent); } .lb-card b { display: block; } .lb-card small { color: var(--dim); }
    .lb-head { margin: 4px 0 8px; font-size: 14px; color: var(--dim); font-weight: 600; }
    .lb-health { margin-bottom: 14px; } .lb-health summary { cursor: pointer; }
    .lb-health table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .lb-health td, .lb-health th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    .lb-health th { color: var(--dim); font-weight: 600; } .lb-ok { color: #2ea043; } .lb-bad { color: #d29922; }`;
  document.head.appendChild(css);

  /** A short note at the bottom of the screen. */
  function toast(text) {
    const n = document.createElement('div');
    n.textContent = text;
    Object.assign(n.style, { position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '8px', padding: '10px 14px', zIndex: 50, maxWidth: '90vw' });
    document.body.append(n);
    setTimeout(() => n.remove(), 5000);
  }

  let kit = null;
  async function loadKit() {
    if (kit) return kit;
    kit = await import('./hawkesgen-ui.mjs');
    kit.configure({ url: `${location.origin}/api/gen`, key: '' });
    return kit;
  }

  let product = null;
  function open(projectId, entityId) {
    product = projectId;
    const lib = $('#lbLib');
    lib.innerHTML = '';
    const el = document.createElement('hg-library');
    el.setAttribute('project', projectId);
    el.setAttribute('open-inline', '');
    el.addEventListener('hg-pick', async (ev) => {
      try {
        const r = await api('/api/library/writeback', { method: 'POST', body: { entity: ev.detail.entity } });
        if (r.skipped) toast(r.skipped);
        else if (r.written) toast(`Wrote ${r.written} file${r.written > 1 ? 's' : ''} into ${r.product}'s beta${r.pushed ? ' and pushed' : ''}`);
      } catch (e) {
        toast(`Couldn't write the pick into the repo: ${e.message}`);
      }
    });
    lib.append(el);
    $('#lbProduct').value = projectId;
    // Open the entity the Waiting card was for.
    if (entityId) customElements.whenDefined('hg-library').then(() => setTimeout(() => el.select?.(entityId), 0));
  }

  /** Content health (GET /api/content/health, src/content.ts): one row per product. */
  async function loadHealth() {
    const r = await api('/api/content/health');
    const yes = (b) => (b ? '<span class="lb-ok">✓</span>' : '<span class="lb-bad">✗</span>');
    const rows = r.products.map((p) => {
      const kinds = Object.entries(p.library.byKind).map(([k, n]) => `${n} ${esc(k)}`).join(', ') || '—';
      const maps = p.mappings.map((m) => `${esc(m.kind)} ← ${esc(m.root)}${m.inRepo ? '' : ' (outside repo)'}`).join('<br>') || '—';
      const sdk = p.sdk.filter((x) => x.version != null).map((x) => `${esc(x.name.replace('.mjs', ''))} v${x.version}${x.behind ? ' <span class="lb-bad">behind</span>' : ''}`).join(', ') || '—';
      return `<tr><td><b>${esc(p.name)}</b></td><td>${yes(p.contract.mapping)} map ${yes(p.contract.mcp)} MCP ${yes(p.contract.agents)} docs</td><td>${maps}</td><td>${kinds}</td><td>${p.library.takesWaiting || ''}</td><td title="${esc(p.library.unmade.map((u) => `${u.name}: ${u.slots.join(', ')}`).join('; '))}">${p.library.unmadeCount || ''}</td><td>${sdk}</td><td>${p.issues.map(esc).join('<br>') || '<span class="lb-ok">ok</span>'}</td></tr>`;
    });
    const bad = r.products.filter((p) => !p.ok).length;
    $('#lbHealthSum').textContent = bad ? `${bad} product${bad > 1 ? 's' : ''} with issues` : 'every product wired';
    if (bad) $('#lbHealthBox').open = true;
    $('#lbHealth').innerHTML = `<table><tr><th>Product</th><th>Wired</th><th>Folders</th><th>Library</th><th title="Takes waiting for a pick">Takes</th><th title="Slots a kind's recipe could make that have no pick (hover for which)">Unmade</th><th>SDK</th><th>Issues</th></tr>${rows.join('')}</table>`;
  }

  window.loadLibraryTab = async () => {
    loadHealth().catch((e) => ($('#lbHealth').textContent = e.message));
    await loadKit();
    const [pr, w] = await Promise.all([api('/api/products'), api('/api/library/waiting').catch(() => ({ products: [] }))]);
    const sel = $('#lbProduct');
    if (!sel.options.length) {
      for (const p of pr.products) sel.append(new Option(p.name, p.id));
      sel.onchange = () => open(sel.value);
    }
    const cards = w.products.flatMap((p) => p.entities.map((e) => `<button class="lb-card" data-p="${esc(p.product)}" data-e="${esc(e.id)}"><b>${esc(e.name)}</b><small>${esc(p.name)} · ${e.takes} take${e.takes > 1 ? 's' : ''} waiting in ${esc(e.slots.slice(0, 3).join(', '))}${e.slots.length > 3 ? '…' : ''}</small></button>`));
    $('#lbWait').innerHTML = cards.join('') || '<div class="meta">Nothing waiting: every take has been picked or set aside.</div>';
    for (const b of document.querySelectorAll('#lbWait .lb-card')) b.onclick = () => open(b.dataset.p, b.dataset.e);
    if (!product) open(sel.value || pr.products[0]?.id);
  };
  if (tab === 'library') loadLibraryTab().catch((e) => ($('#lbWait').textContent = e.message));
})();
