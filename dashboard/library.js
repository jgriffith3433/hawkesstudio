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
    .lb-head { margin: 4px 0 8px; font-size: 14px; color: var(--dim); font-weight: 600; }`;
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

  window.loadLibraryTab = async () => {
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
