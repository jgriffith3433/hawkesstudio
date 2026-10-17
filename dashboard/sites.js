// The Sites tab: every product's beta site (https://<sub>.hawkesgen.com/, products.json "previews" via GET /api/previews)
// and live site (its "live" URL, GET /api/products), then Studio and Gen (no beta). Built from products.json, so a new
// product shows up by itself. Links open in a new tab; big tap targets for the phone. Uses app.js's helpers ($, esc, api).
(() => {
  const css = document.createElement('style');
  css.textContent = `
    .si-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .si-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; min-width: 0; }
    .si-card h3 { margin: 0 0 8px; font-size: 16px; }
    .si-links { display: flex; gap: 10px; flex-wrap: wrap; }
    .si-links a, .si-links .si-none { flex: 1 1 120px; display: flex; flex-direction: column; justify-content: center; min-height: 48px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel2); text-decoration: none; min-width: 0; }
    .si-links a b { color: var(--text); font-size: 15px; } .si-links a.beta b { color: var(--amber); } .si-links a.live b { color: var(--accent); }
    .si-links a small, .si-links .si-none small { color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .si-links a:hover { border-color: var(--dim); }
    .si-links .si-none { color: var(--dim); font-size: 14px; }
    .si-head { margin: 18px 0 8px; font-size: 14px; color: var(--dim); font-weight: 600; }
    @media (max-width: 700px) { .si-list { grid-template-columns: 1fr; } }`;
  document.head.appendChild(css);

  // Studio and Gen themselves: no beta lane, so only the live address.
  const INFRA = [
    { name: 'Hawkes Studio', live: 'https://studio.hawkesgen.com/' },
    { name: 'Hawkes Gen', live: 'https://gen.hawkesgen.com/' },
  ];

  const short = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const link = (kind, label, url) => (url
    ? `<a class="${kind}" href="${esc(url)}" target="_blank" rel="noopener"><b>${label} ↗</b><small>${esc(short(url))}</small></a>`
    : `<span class="si-none">${label}<small>none</small></span>`);
  const card = (name, beta, live, noBeta) => `<div class="si-card"><h3>${esc(name)}</h3><div class="si-links">${noBeta ? '' : link('beta', 'Beta', beta)}${link('live', 'Live', live)}</div></div>`;

  window.loadSitesTab = async () => {
    const [pr, pv] = await Promise.all([api('/api/products'), api('/api/previews').catch(() => ({ previews: [] }))]);
    const beta = new Map(pv.previews.map((x) => [x.product, x.url]));
    $('#siList').innerHTML = pr.products.map((p) => card(p.name, beta.get(p.id), p.live)).join('') || '<div class="meta">No products.</div>';
    $('#siInfra').innerHTML = INFRA.map((x) => card(x.name, null, x.live, true)).join('');
  };
  if (tab === 'sites') loadSitesTab().catch((e) => ($('#siList').textContent = e.message));
})();
