// The explore bot's map (clients/web/hawkes-explore.js, docs/playtest.md#explore): read from a playtest's events and
// drawn as a heatmap. Where the bot went (shaded by time spent), where it got stuck (amber) and where it fell through
// or out of the world (red). Stored with each playtest (playtests.ts playtestData) and served by
// GET /api/playtests/heatmap?step=<id>.

export type ExploreCell = [number, number, number];
export type ExploreMap = { cell: number; coverage: number; deadSeconds: number; visited: ExploreCell[]; stuck: ExploreCell[]; falls: ExploreCell[] };

const cells = (v: unknown, max: number): ExploreCell[] => (Array.isArray(v) ? v : [])
  .filter((c) => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((n) => Number.isFinite(Number(n))))
  .slice(0, max)
  .map((c: any[]) => [Number(c[0]), Number(c[1]), Number(c[2])]);

/** The last "explore-map" event of a run, checked and capped; null when the run had no explore bot. */
export function exploreOf(events: unknown): ExploreMap | null {
  if (!Array.isArray(events)) return null;
  const e = [...events].reverse().find((x: any) => x?.type === 'explore-map' && typeof x.detail === 'string');
  if (!e) return null;
  let m: any;
  try { m = JSON.parse(e.detail); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const cell = Number(m.cell);
  return {
    cell: Number.isFinite(cell) && cell > 0 ? cell : 2,
    coverage: Number(m.coverage) || 0,
    deadSeconds: Number(m.deadSeconds) || 0,
    visited: cells(m.visited, 4000),
    stuck: cells(m.stuck, 400),
    falls: cells(m.falls, 400),
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** The map as an SVG, north (+z) up. Pure. */
export function heatmapSvg(m: ExploreMap, title = 'Explore bot'): string {
  const all = [...m.visited, ...m.stuck, ...m.falls];
  if (!all.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="60"><text x="10" y="35" font-family="sans-serif" font-size="14">${esc(title)}: no positions</text></svg>`;
  const xs = all.map((c) => c[0]);
  const zs = all.map((c) => c[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const w = x1 - x0 + 1;
  const h = z1 - z0 + 1;
  const px = Math.max(3, Math.min(16, Math.floor(640 / Math.max(w, h))));
  const top = 34;
  const W = w * px;
  const H = h * px + top + 22;
  const most = Math.max(...m.visited.map((c) => c[2]), 0.001);
  const at = (c: ExploreCell) => `x="${(c[0] - x0) * px}" y="${top + (z1 - c[1]) * px}" width="${px}" height="${px}"`;
  const rects = [
    ...m.visited.map((c) => `<rect ${at(c)} fill="#3b82f6" fill-opacity="${(0.15 + 0.85 * Math.sqrt(c[2] / most)).toFixed(2)}"/>`),
    ...m.stuck.map((c) => `<rect ${at(c)} fill="#f59e0b" stroke="#92400e"/>`),
    ...m.falls.map((c) => `<rect ${at(c)} fill="#ef4444" stroke="#7f1d1d"/>`),
  ];
  const width = Math.max(W, 360);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">`,
    `<rect width="100%" height="100%" fill="#0f172a"/>`,
    `<text x="6" y="16" font-family="sans-serif" font-size="13" fill="#e2e8f0">${esc(title)}: ${m.coverage} cells of ${m.cell} m, ${m.stuck.length} stuck, ${m.falls.length} fall${m.falls.length === 1 ? '' : 's'}, longest dead stretch ${m.deadSeconds} s</text>`,
    `<text x="6" y="29" font-family="sans-serif" font-size="11" fill="#94a3b8">blue: time spent · amber: stuck · red: fell through or out · north up</text>`,
    ...rects,
    `<text x="6" y="${H - 6}" font-family="sans-serif" font-size="11" fill="#94a3b8">x ${x0 * m.cell} to ${(x1 + 1) * m.cell} m, z ${z0 * m.cell} to ${(z1 + 1) * m.cell} m</text>`,
    '</svg>',
  ].join('\n');
}
