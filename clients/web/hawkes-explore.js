// Hawkes explore bot v1: plays a level the way a curious player does, with real key presses, and maps where the
// player got stuck or fell out. Source of truth: hawkesstudio/clients/web/hawkes-explore.js (copy next to
// hawkes-playtest.js and hawkes-feel.js). Spec: docs/playtest.md#explore.
//
// It runs forward, turns at random, hugs walls (when forward stops working it slides along the wall), jumps at
// edges and on a beat, backs out of corners, and logs a grid of where the player went:
//   visited  cells the player stood in, with how long
//   stuck    cells where movement input did nothing for stuckSeconds (and every escape failed)
//   falls    cells where the player fell through or out of the world (the feel sensor's below-ground / fell-out)
// plus coverage (cells visited) and deadSeconds (the longest stretch with no new cell: a dead stretch).
//
// installPlaytest({ ..., feel: { player: () => hero.mesh }, explore: { enter: async (t) => game.startLevel() } })
// adds an "explore" scenario: enter() gets the player into play (skip menus), then the bot plays for `seconds`.
// explore: true when the game is playable as soon as it loads. A game's own "explore" scenario wins.
// The map goes to the run as event "explore-map" (JSON) and metrics explore.coverage, explore.stuckSpots,
// explore.fallSpots, explore.deadSeconds; Studio stores it with the playtest and draws it (GET /api/playtests/heatmap).

export const EXPLORE_VERSION = 1;

export const EXPLORE_DEFAULTS = {
  seconds: 120,        // how long the bot plays
  cell: 2,             // grid cell size in meters
  tickMs: 100,         // how often the bot decides
  stuckSeconds: 2,     // forward input this long with under stuckMeters of movement: try to get out
  stuckMeters: 0.3,
  giveUpSeconds: 6,    // still in the same spot after this long of escapes: a stuck spot, then turn around
  jumpEvery: [1.5, 4], // seconds between beat jumps (random in range)
  turnEvery: [2, 6],   // seconds between random turns
  fallDrop: 1.2,       // a drop this many meters below the last ground height: jump at the edge
};

const KEYS = {
  forward: { key: 'w', code: 'KeyW', keyCode: 87 },
  back: { key: 's', code: 'KeyS', keyCode: 83 },
  left: { key: 'a', code: 'KeyA', keyCode: 65 },
  right: { key: 'd', code: 'KeyD', keyCode: 68 },
  jump: { key: ' ', code: 'Space', keyCode: 32 },
};

/** A seeded random (mulberry32), so a run's path can be replayed with its seed. */
export function seededRandom(seed = 1) {
  let a = (Number(seed) || 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The grid the bot fills: pure, so it is tested without a browser. Positions are {x,y,z} or [x,y,z]. */
export function createExploreMap({ cell = EXPLORE_DEFAULTS.cell } = {}) {
  const visited = new Map(); // "ix,iz" -> seconds
  const stuck = new Map();   // "ix,iz" -> count
  const falls = new Map();
  let lastNewT = 0;
  let deadSeconds = 0;
  const xz = (p) => (Array.isArray(p) ? { x: p[0], z: p[2] } : p);
  const keyOf = (p) => { const q = xz(p); return q && Number.isFinite(q.x) && Number.isFinite(q.z) ? `${Math.floor(q.x / cell)},${Math.floor(q.z / cell)}` : null; };
  const bump = (m, k, n) => { if (k) m.set(k, (m.get(k) ?? 0) + n); };
  const rows = (m, round) => [...m].map(([k, n]) => { const [ix, iz] = k.split(',').map(Number); return [ix, iz, round ? Math.round(n * 10) / 10 : n]; });
  return {
    cell,
    /** The player was at pos for dt seconds at time t (seconds from the start). */
    visit(pos, t, dt) {
      const k = keyOf(pos);
      if (!k) return;
      if (!visited.has(k)) { deadSeconds = Math.max(deadSeconds, t - lastNewT); lastNewT = t; }
      bump(visited, k, dt);
    },
    mark(kind, pos) { bump(kind === 'stuck' ? stuck : falls, keyOf(pos), 1); },
    summary(t = lastNewT) {
      return {
        v: EXPLORE_VERSION, cell, coverage: visited.size,
        deadSeconds: Math.round(Math.max(deadSeconds, t - lastNewT) * 10) / 10,
        visited: rows(visited, true), stuck: rows(stuck), falls: rows(falls),
      };
    },
  };
}

/** Presses and releases keys the way a keyboard does, on the window and the focused element (the canvas). */
export function makeKeyboard(win = window) {
  const down = new Set();
  const send = (type, k) => {
    const init = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true };
    const targets = [win.document?.activeElement, win.document?.querySelector?.('canvas'), win].filter(Boolean);
    const seen = new Set();
    for (const el of targets) {
      if (seen.has(el)) continue;
      seen.add(el);
      try { el.dispatchEvent(new win.KeyboardEvent(type, init)); } catch {}
    }
  };
  return {
    hold(name) { const k = KEYS[name]; if (k && !down.has(name)) { down.add(name); send('keydown', k); } },
    release(name) { const k = KEYS[name]; if (k && down.has(name)) { down.delete(name); send('keyup', k); } },
    tap(name, ms = 120) { this.hold(name); setTimeout(() => this.release(name), ms); },
    releaseAll() { for (const n of [...down]) this.release(n); },
    held: () => [...down],
  };
}

/**
 * Plays for o.seconds with real key presses. o.player is what the feel sensor takes (a mesh, node or function giving
 * one or {x,y,z}); o.t is the run's tracker; o.map a createExploreMap(); o.keyboard a makeKeyboard() (tests pass a fake).
 * Resolves with the map's summary. o.now/o.sleep let tests drive time.
 */
export async function runExplore(o) {
  const c = { ...EXPLORE_DEFAULTS, ...(o.thresholds ?? {}) };
  const seconds = o.seconds ?? c.seconds;
  const rnd = seededRandom(o.seed ?? 1);
  const map = o.map ?? createExploreMap({ cell: c.cell });
  const kb = o.keyboard ?? makeKeyboard();
  const now = o.now ?? (() => performance.now() / 1000);
  const sleep = o.sleep ?? ((ms) => (o.t?.wait ? o.t.wait(ms) : new Promise((r) => setTimeout(r, ms))));
  const pos = () => readPos(o.player);
  const between = ([a, b]) => a + rnd() * (b - a);

  const t0 = now();
  let last = t0;
  let anchor = pos();            // where the player was when forward input last moved them
  let anchorT = t0;
  let ground = anchor?.y ?? 0;   // the last height the player stood at
  let escape = 0;                // escapes tried in this spot
  let side = rnd() < 0.5 ? 'left' : 'right';
  let turnUntil = 0;
  let nextTurn = t0 + between(c.turnEvery);
  let nextJump = t0 + between(c.jumpEvery);
  let backUntil = 0;
  let stuckHere = false;
  o.t?.scene?.('explore');

  try {
    kb.hold('forward');
    while (now() - t0 < seconds) {
      await sleep(c.tickMs);
      const t = now();
      const dt = Math.min(1, t - last);
      last = t;
      const p = pos();
      if (!p) continue;
      map.visit(p, t - t0, dt);
      o.t?.progress?.(Math.min(1, (t - t0) / seconds));

      // Edges: the floor dropped away under the player, so jump the way a player clears a gap.
      if (ground - p.y > c.fallDrop && anchor && p.y < anchor.y - c.fallDrop) { kb.tap('jump'); ground = p.y; }
      if (p.y > ground || Math.abs(p.y - ground) < 0.2) ground = p.y;

      const moved = anchor ? Math.hypot(p.x - anchor.x, p.z - anchor.z) : Infinity;
      if (moved > c.stuckMeters) {
        anchor = p; anchorT = t; escape = 0; stuckHere = false;
      } else if (t - anchorT > c.stuckSeconds * (escape + 1)) {
        // Wall hug: slide along the wall, then jump it, then back out; give up after giveUpSeconds.
        escape++;
        if (escape === 1) { kb.hold(side); turnUntil = t + 1.5; }
        else if (escape === 2) { kb.release(side); side = side === 'left' ? 'right' : 'left'; kb.hold(side); kb.tap('jump'); turnUntil = t + 1.5; }
        else { kb.release('forward'); kb.hold('back'); backUntil = t + 1; }
        if (!stuckHere && t - anchorT >= c.giveUpSeconds) {
          stuckHere = true;
          map.mark('stuck', p);
          o.t?.event?.('explore-stuck', `${round(p.x)},${round(p.y)},${round(p.z)}`);
        }
      }
      if (backUntil && t >= backUntil) { kb.release('back'); kb.hold('forward'); backUntil = 0; side = rnd() < 0.5 ? 'left' : 'right'; kb.hold(side); turnUntil = t + 1 + rnd(); }
      if (turnUntil && t >= turnUntil) { kb.release('left'); kb.release('right'); turnUntil = 0; }
      if (!turnUntil && !backUntil && t >= nextTurn) { side = rnd() < 0.5 ? 'left' : 'right'; kb.hold(side); turnUntil = t + 0.3 + rnd() * 0.9; nextTurn = t + between(c.turnEvery); }
      if (t >= nextJump) { kb.tap('jump'); nextJump = t + between(c.jumpEvery); }
    }
  } finally {
    kb.releaseAll();
  }
  return map.summary(now() - t0);
}

function readPos(o) {
  if (!o) return null;
  let v;
  try { v = typeof o === 'function' ? o() : o; } catch { return null; }
  if (!v) return null;
  const p = v.absolutePosition ?? v.globalPosition ?? v.position ?? v;
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? { x: p.x, y: p.y, z: p.z } : null;
}
const round = (n) => Math.round(n * 100) / 100;
