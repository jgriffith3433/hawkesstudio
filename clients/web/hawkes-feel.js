// Hawkes playtest "feel" sensor v1: what players find annoying, measured while a playtest runs.
// Source of truth: hawkesstudio/clients/web/hawkes-feel.js (copy next to hawkes-playtest.js). Spec: docs/playtest.md#feel.
//
// It flags, with where and when:
//   camera-snap      the camera turns faster than a person would (a snap or a glitch)
//   camera-jump      the camera moves far in one frame while the player didn't
//   camera-blocked   the camera sits behind or inside geometry (the player is hidden)
//   below-ground     the player is under a surface with nothing beneath them (fell through the floor)
//   fell-out         the player keeps falling with no floor anywhere under them
//   inside-geometry  the game's own check says the player is inside a solid
//   stuck            movement input held but the player hardly moves
//   collision-pop    the player is shoved far in one frame (a bad collision push-out)
//   jitter           the player shakes back and forth (fighting a collider)
//   hitch            a frame takes far longer than the frames around it
//   foot-sliding     the feet animate at one speed while the body moves at another (needs animSpeed)
//   slope-slide      after landing, the player slides off with no input (a bad slope landing; needs grounded)
//
// Each flag: { id, kind, severity: 'bug'|'polish', t, pos: [x,y,z], cam: {pos, yaw, pitch}, seed, scene, value, detail, count }.
// Flags go to the run (event 'feel' + a problem) and are pushed to the runner the moment they happen through
// window.__hawkesPlaytestPush (a Playwright binding the runner adds); nobody polls for them.
//
// Web games get it through installPlaytest({ ..., feel: { player: () => hero.mesh } }) (hawkes-playtest.js),
// which starts it with each run and stops it at the end. Babylon.js scenes are found by themselves; give
// `player` (a mesh, a TransformNode, or a function returning one or a {x,y,z}) for the player checks.
// Nothing runs and nothing is drawn until a playtest starts.

export const FEEL_VERSION = 1;

export const FEEL_DEFAULTS = {
  snapDegPerSec: 540,      // camera turn speed that reads as a snap
  snapMinDeg: 25,          // ...and at least this much in one frame
  cameraJumpMeters: 3,     // camera moves this far in one frame beyond what the player moved
  belowGroundMeters: 0.5,  // player this far under the surface above them, with nothing underneath
  fellOutSeconds: 2,       // falling with no floor anywhere for this long
  killY: -200,             // below this is out of the world whatever the rays say
  stuckSeconds: 1.5,       // movement input held this long...
  stuckMeters: 0.25,       // ...while moving less than this
  popMeters: 2,            // player moved this far in one frame (beyond 4x their recent speed)
  jitterFlips: 6,          // direction reversals within one second while moving
  hitchMs: 100,            // a frame at least this long...
  hitchFactor: 4,          // ...and this many times the median frame
  blockedSeconds: 0.4,     // camera hidden behind geometry for this long
  slideMetersPerSec: 1.5,  // feet and body speeds this far apart...
  slideSeconds: 0.5,       // ...for this long, on the ground: foot sliding
  landSlideMeters: 1,      // slid this far within landSeconds of landing, without input
  landSeconds: 0.6,
  mergeMeters: 3,          // the same kind within this distance and mergeSeconds counts as one flag
  mergeSeconds: 5,
  maxFlags: 200,
  rayEvery: 4,             // physics rays every Nth frame
};

const SEVERITY = {
  'below-ground': 'bug', 'fell-out': 'bug', 'inside-geometry': 'bug', stuck: 'bug',
  'camera-snap': 'polish', 'camera-jump': 'polish', 'camera-blocked': 'polish',
  'collision-pop': 'polish', jitter: 'polish', hitch: 'polish', 'foot-sliding': 'polish', 'slope-slide': 'polish',
};

const WORDS = {
  'camera-snap': 'camera snapped',
  'camera-jump': 'camera jumped',
  'camera-blocked': 'camera behind geometry',
  'below-ground': 'player fell through the floor',
  'fell-out': 'player fell out of the world',
  'inside-geometry': 'player inside geometry',
  stuck: 'player stuck while moving',
  'collision-pop': 'player shoved by a collision',
  jitter: 'player jittering against a collider',
  hitch: 'frame hitch',
  'foot-sliding': 'feet slide (animation and movement disagree)',
  'slope-slide': 'player slides off a slope after landing',
};

const r2 = (n) => Math.round(n * 100) / 100;
const v3 = (p) => (p ? [r2(p.x), r2(p.y), r2(p.z)] : null);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const angleDeg = (a, b) => {
  const A = norm(a); const B = norm(b);
  const d = Math.max(-1, Math.min(1, A.x * B.x + A.y * B.y + A.z * B.z));
  return (Math.acos(d) * 180) / Math.PI;
};
const yawPitch = (f) => {
  const F = norm(f);
  return { yaw: r2((Math.atan2(F.x, F.z) * 180) / Math.PI), pitch: r2((Math.asin(Math.max(-1, Math.min(1, F.y))) * 180) / Math.PI) };
};

/**
 * The engine-free part: feed it one sample per frame and it raises flags. Adapters (Babylon below, Unity in C#)
 * only turn their scene into samples.
 *
 * sample = {
 *   t: seconds since the run started, dt: seconds this frame took,
 *   cam?: { pos: {x,y,z}, fwd: {x,y,z} },
 *   player?: {x,y,z},
 *   input?: 0..1        (movement input held, e.g. 1 while W is down),
 *   grounded?: bool     (the controller says the player stands on something),
 *   animSpeed?: m/s     (how fast the walk/run animation moves the feet: 0 idle),
 *   floorBelow?: bool   (a ray down from the player hit something), surfaceAbove?: number (height of the surface
 *                        above the player, or null), cameraBlocked?: bool, inside?: bool   (undefined: not measured this frame)
 * }
 */
export function createFeelCore({ emit = () => {}, seed = 0, scene = () => undefined, thresholds = {} } = {}) {
  const th = { ...FEEL_DEFAULTS, ...thresholds };
  const flags = [];
  let n = 0;
  let prev = null;
  let quietUntil = -1;           // after a cut or teleport, the camera and position checks rest briefly
  const dts = [];                // recent frame times for the median
  const moves = [];              // { t, pos, input } over the last few seconds
  let fallingSince = null;
  let blockedSince = null;
  let insideSince = null;
  let belowSince = null;
  let lastSign = { x: 0, z: 0 };
  let slidingSince = null;
  let landed = null;             // { t, pos } when the player last landed
  let wasGrounded = null;
  const flips = [];
  // Measurements for the quality rubric's hard limits (metrics(), sent as playtest metrics feel.*).
  const m = { worstFrameMs: 0, maxCamDegPerSec: 0, camClipSeconds: 0, insideSeconds: 0, latencies: [], samples: 0, activeSeconds: 0, tracksActive: false };
  let press = null;              // { t, pos } when movement input last went from up to down
  let sceneName;                 // the scene the last sample was in, and when it began (seconds)
  let sceneT = 0;
  let lastInput = 0;

  function median() {
    if (!dts.length) return 1 / 60;
    const s = dts.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function raise(kind, s, value, detail) {
    const pos = s.player ?? s.cam?.pos ?? null;
    const same = flags.find((f) => f.kind === kind && s.t - f.lastT <= th.mergeSeconds
      && (!pos || !f.pos || Math.hypot(f.pos[0] - pos.x, f.pos[1] - pos.y, f.pos[2] - pos.z) <= th.mergeMeters));
    if (same) {
      same.count++;
      same.lastT = s.t;
      if (value != null && Math.abs(value) > Math.abs(same.value ?? 0)) same.value = r2(value);
      return null;
    }
    if (flags.length >= th.maxFlags) return null;
    // The scene and when it began: Studio counts a hitch on a loading screen or in a scene's first seconds as load
    // stutter, not a hitch in play (quality.ts inPlayHitch).
    const sc = scene() ?? undefined;
    if (sc !== sceneName) { sceneName = sc; sceneT = s.t; }
    const flag = {
      id: `feel-${++n}`,
      kind,
      severity: SEVERITY[kind] ?? 'polish',
      t: r2(s.t),
      lastT: s.t,
      pos: v3(pos),
      ...(s.cam ? { cam: { pos: v3(s.cam.pos), ...yawPitch(s.cam.fwd) } } : {}),
      seed,
      scene: sc,
      st: r2(s.t - sceneT),
      ...(value != null ? { value: r2(value) } : {}),
      detail: detail ?? WORDS[kind] ?? kind,
      count: 1,
    };
    flags.push(flag);
    try { emit(flag); } catch {}
    return flag;
  }

  function sample(s) {
    const dt = Math.max(0, s.dt ?? 0);
    { let sc; try { sc = scene() ?? undefined; } catch {} if (sc !== sceneName) { sceneName = sc; sceneT = s.t; } }
    // Silence must not read as success: count the frames the sensor saw, and (when the adapter knows) the seconds the
    // player was the player's to move. Studio files a bug when these stay 0 in a run (src/feel.ts feelSensorFindings).
    m.samples++;
    if (s.active !== undefined) { m.tracksActive = true; if (s.active && dt < 1) m.activeSeconds += dt; }
    const med = median();
    const quiet = s.t < quietUntil;

    // Frame hitches: long against the frames around it, and long in absolute terms.
    if (prev && dt * 1000 >= th.hitchMs && dt >= med * th.hitchFactor) raise('hitch', s, dt * 1000, `frame took ${Math.round(dt * 1000)} ms (usual ${Math.round(med * 1000)} ms)`);
    if (dt > 0 && dt < 1) { dts.push(dt); if (dts.length > 120) dts.shift(); }
    // A frame under 2 s (longer is a tab in the background, not a hitch), after the first.
    if (prev && dt < 2 && dt * 1000 > m.worstFrameMs) m.worstFrameMs = dt * 1000;

    // Camera.
    if (prev?.cam && s.cam && !quiet && dt > 0 && dt < 0.5) {
      const turned = angleDeg(prev.cam.fwd, s.cam.fwd);
      const rate = turned / Math.max(dt, med);
      if (rate > m.maxCamDegPerSec) m.maxCamDegPerSec = rate;
      if (turned >= th.snapMinDeg && rate >= th.snapDegPerSec) raise('camera-snap', s, turned, `camera turned ${Math.round(turned)}° in one frame`);
      const camMoved = dist(prev.cam.pos, s.cam.pos);
      const playerMoved = prev.player && s.player ? dist(prev.player, s.player) : 0;
      if (camMoved - playerMoved >= th.cameraJumpMeters) raise('camera-jump', s, camMoved, `camera moved ${r2(camMoved)} m in one frame`);
    }
    if (s.cameraBlocked !== undefined) {
      if (s.cameraBlocked && !quiet && dt < 0.5) m.camClipSeconds += dt;
      if (s.cameraBlocked) {
        blockedSince ??= s.t;
        if (s.t - blockedSince >= th.blockedSeconds) raise('camera-blocked', s, s.t - blockedSince);
      } else blockedSince = null;
    }

    // Player.
    if (s.player) {
      const p = s.player;
      // Input latency: from the frame before movement input went down (it arrived during this frame) to the first frame
      // the player has visibly moved. A press that moves nothing within half a second (a wall, a menu) isn't counted.
      const inp = s.input ?? 0;
      if (inp >= 0.5 && lastInput < 0.5 && prev && !quiet) press = { t: prev.t, pos: { ...p } };
      if (press && inp < 0.5 && dist(press.pos, p) < 0.02) press = null;
      if (press) {
        if (dist(press.pos, p) >= 0.02) { m.latencies.push((s.t - press.t) * 1000); if (m.latencies.length > 200) m.latencies.shift(); press = null; }
        else if (s.t - press.t > 0.5) press = null;
      }
      lastInput = inp;
      if (s.inside !== undefined) {
        if (s.inside && dt < 0.5) m.insideSeconds += dt;
        if (s.inside) { insideSince ??= s.t; if (s.t - insideSince >= 0.3) raise('inside-geometry', s); } else insideSince = null;
      }
      if (s.floorBelow !== undefined) {
        const above = s.surfaceAbove;
        const under = !s.floorBelow && above != null && above - p.y >= th.belowGroundMeters;
        if (under) { belowSince ??= s.t; if (s.t - belowSince >= 0.25) raise('below-ground', s, above - p.y, `player ${r2(above - p.y)} m under the surface above them`); } else belowSince = null;
        const falling = !s.floorBelow && above == null && prev?.player && p.y < prev.player.y;
        if (falling) { fallingSince ??= s.t; if (s.t - fallingSince >= th.fellOutSeconds) raise('fell-out', s); } else if (s.floorBelow) fallingSince = null;
      }
      if (p.y < th.killY) raise('fell-out', s, p.y, `player at height ${r2(p.y)}`);

      if (prev?.player && !quiet && dt > 0 && dt < 0.5) {
        const step = dist(prev.player, p);
        // recent speed from the last second of movement, not this frame
        const recent = moves.filter((m) => s.t - m.t <= 1);
        const speed = recent.length > 1 ? dist(recent[0].pos, recent[recent.length - 1].pos) / Math.max(0.05, recent[recent.length - 1].t - recent[0].t) : 0;
        if (step >= th.popMeters && step >= speed * dt * 4 + th.popMeters * 0.5) raise('collision-pop', s, step, `player moved ${r2(step)} m in one frame`);

        // Jitter: horizontal direction flips back and forth while moving.
        const vx = (p.x - prev.player.x) / dt; const vz = (p.z - prev.player.z) / dt;
        for (const [axis, v] of [['x', vx], ['z', vz]]) {
          if (Math.abs(v) < 0.5) continue;
          const sign = Math.sign(v);
          if (lastSign[axis] && sign !== lastSign[axis]) flips.push(s.t);
          lastSign[axis] = sign;
        }
        while (flips.length && s.t - flips[0] > 1) flips.shift();
        if (flips.length >= th.jitterFlips) { raise('jitter', s, flips.length, `${flips.length} direction flips in a second`); flips.length = 0; }
      }

      // Foot sliding: the walk cycle and the body's ground speed disagree while grounded.
      if (s.animSpeed !== undefined && s.grounded !== false && prev?.player && dt > 0 && dt < 0.5 && !quiet) {
        const body = flat(prev.player, p) / dt;
        if (Math.abs(body - s.animSpeed) >= th.slideMetersPerSec) {
          slidingSince ??= s.t;
          if (s.t - slidingSince >= th.slideSeconds) raise('foot-sliding', s, body - s.animSpeed, `body moves ${r2(body)} m/s, feet animate ${r2(s.animSpeed)} m/s`);
        } else slidingSince = null;
      }
      // Slope landings: landed, no input, and carried off sideways.
      if (s.grounded !== undefined) {
        if (s.grounded && wasGrounded === false) landed = { t: s.t, pos: { ...p } };
        wasGrounded = !!s.grounded;
        if (landed && (s.input ?? 0) >= 0.5) landed = null;
        if (landed && s.t - landed.t <= th.landSeconds && flat(landed.pos, p) >= th.landSlideMeters && !quiet) {
          raise('slope-slide', s, flat(landed.pos, p), `slid ${r2(flat(landed.pos, p))} m after landing, no input`);
          landed = null;
        } else if (landed && s.t - landed.t > th.landSeconds) landed = null;
      }

      moves.push({ t: s.t, pos: { ...p }, input: s.input ?? 0 });
      while (moves.length && s.t - moves[0].t > Math.max(3, th.stuckSeconds + 0.5)) moves.shift();
      // Stuck: input held the whole window, little ground covered.
      if ((s.input ?? 0) >= 0.5 && !quiet) {
        const win = moves.filter((m) => s.t - m.t <= th.stuckSeconds);
        const held = win.length > 2 && win.every((m) => m.input >= 0.5) && s.t - win[0].t >= th.stuckSeconds * 0.9;
        if (held && flat(win[0].pos, p) < th.stuckMeters) raise('stuck', s, th.stuckSeconds, `movement held ${th.stuckSeconds} s, moved ${r2(flat(win[0].pos, p))} m`);
      }
    } else {
      // No player this frame (a menu, a cutscene, the game playing itself): the timers start over.
      belowSince = fallingSince = insideSince = slidingSince = blockedSince = null; landed = null; wasGrounded = null; moves.length = 0; flips.length = 0;
      press = null; lastInput = 0;
    }
    prev = { t: s.t, cam: s.cam ? { pos: { ...s.cam.pos }, fwd: { ...s.cam.fwd } } : null, player: s.player ? { ...s.player } : null };
  }

  return {
    sample,
    /** An intended cut, respawn or teleport: camera and movement checks rest for `seconds`. */
    cut(seconds = 0.75) { quietUntil = (prev?.t ?? 0) + seconds; fallingSince = null; belowSince = null; slidingSince = null; landed = null; moves.length = 0; flips.length = 0; },
    flags: () => flags.map(({ lastT, ...f }) => f),
    /**
     * The run's measurements as playtest metrics: worst frame (ms), fastest camera turn (deg/s), seconds the camera
     * spent behind a wall and the player inside geometry, and input latency (median ms, with how many presses it saw).
     * A measurement the game gave the sensor nothing for is left out, never reported as 0.
     */
    metrics() {
      const out = { 'feel.samples': m.samples };
      if (m.tracksActive) out['feel.activeSeconds'] = r2(m.activeSeconds);
      if (dts.length) out['feel.worstHitchMs'] = Math.round(m.worstFrameMs);
      if (m.maxCamDegPerSec > 0) out['feel.maxCameraDegPerSec'] = Math.round(m.maxCamDegPerSec);
      if (prev?.cam) out['feel.cameraClipSeconds'] = r2(m.camClipSeconds);
      if (m.insideSeconds > 0) out['feel.insideSeconds'] = r2(m.insideSeconds);
      if (m.latencies.length) {
        const l = m.latencies.slice().sort((a, b) => a - b);
        out['feel.inputLatencyMs'] = Math.round(l[Math.floor(l.length / 2)]);
        out['feel.inputSamples'] = l.length;
      }
      return out;
    },
    thresholds: th,
  };
}

/** "x,y,z" or "x,y,z,yaw" (options.spot) -> { x, y, z, yaw? }, or null. */
export function parseSpot(spot) {
  if (spot == null || spot === '') return null;
  if (typeof spot === 'object' && Number.isFinite(Number(spot.x))) return { x: +spot.x, y: +spot.y, z: +spot.z, ...(spot.yaw != null ? { yaw: +spot.yaw } : {}) };
  const parts = String(spot).split(',').map((s) => Number(s.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
  return { x: parts[0], y: parts[1], z: parts[2], ...(Number.isFinite(parts[3]) ? { yaw: parts[3] } : {}) };
}

/** Sends a message to the runner right away (a Playwright binding), and as a DOM event for anything else listening. */
export function pushToRunner(msg) {
  try { if (typeof window.__hawkesPlaytestPush === 'function') window.__hawkesPlaytestPush(msg); } catch {}
  try { window.dispatchEvent(new CustomEvent('hawkes-playtest', { detail: msg })); } catch {}
}

// ----- Babylon.js adapter -----

function readPos(o) {
  if (!o) return null;
  const v = typeof o === 'function' ? o() : o;
  if (!v) return null;
  const p = v.absolutePosition ?? v.globalPosition ?? v.position ?? v;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return { x: p.x, y: p.y, z: p.z };
  return null;
}
function readNode(o) { if (!o) return null; const v = typeof o === 'function' ? o() : o; return v && typeof v === 'object' && 'getScene' in v ? v : null; }

function isPartOf(mesh, root) {
  for (let m = mesh; m; m = m.parent) if (m === root) return true;
  return false;
}

/**
 * Starts the sensor on a Babylon.js scene. Returns { stop(), cut(), flags() }.
 * opts: { scene?, player?, camera?, input?: () => 0..1, active?: () => bool, inside?: () => bool, grounded?: () => bool,
 *         animSpeed?: () => m/s the feet animate at, isSolid?: (mesh) => bool,
 *         headHeight = 1.5, thresholds, seed, sceneName: () => string, emit(flag) }
 */
export function startBabylonFeel(opts = {}) {
  const win = typeof window !== 'undefined' ? window : globalThis;
  const scene = opts.scene ?? win.BABYLON?.Engine?.LastCreatedScene ?? null;
  if (!scene || !scene.onAfterRenderObservable) return null;
  const B = opts.BABYLON ?? win.BABYLON;
  const RayCtor = B?.Ray ?? scene.activeCamera?.getForwardRay?.()?.constructor;
  const core = createFeelCore({ emit: opts.emit, seed: opts.seed ?? 0, scene: opts.sceneName, thresholds: opts.thresholds });
  const keys = opts.input ? null : watchMovementKeys(win);
  const input = opts.input ?? (() => keys.held());
  const head = opts.headHeight ?? 1.5;
  let frame = 0;
  const t0 = performance.now();
  let last = t0;

  const solid = (playerNode) => (m) => m && m.isPickable !== false && m.isEnabled?.() !== false && m.isVisible !== false
    && (!playerNode || !isPartOf(m, playerNode)) && (opts.isSolid ? opts.isSolid(m) : true);

  function ray(origin, dir, length, pred) {
    if (!RayCtor) return null;
    try {
      const r = new RayCtor(origin.clone ? origin : new (origin.constructor)(origin.x, origin.y, origin.z), dir, length);
      const hit = scene.pickWithRay(r, pred, true);
      return hit?.hit ? hit : null;
    } catch { return null; }
  }
  const V = (x, y, z) => (B?.Vector3 ? new B.Vector3(x, y, z) : null);

  let wasActive = true;
  const obs = scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    frame++;
    // opts.active: false while the player isn't the player's to move (the game plays itself, a cutscene, a menu).
    // Only frame hitches are watched then; the camera and movement checks start fresh when it turns true again.
    let active = true;
    if (opts.active) { try { active = !!opts.active(); } catch { active = true; } }
    if (active && !wasActive) core.cut();
    wasActive = active;
    if (!active) { core.sample({ t: (now - t0) / 1000, dt, input: 0, active: false }); return; }
    const s = { t: (now - t0) / 1000, dt, input: Number(input()) || 0, active: true };
    const cam = readNode(opts.camera) ?? scene.activeCamera;
    if (cam?.getWorldMatrix) {
      const m = cam.getWorldMatrix().m;
      const pos = cam.globalPosition ?? cam.position;
      s.cam = { pos: { x: pos.x, y: pos.y, z: pos.z }, fwd: { x: m[8], y: m[9], z: m[10] } };
    }
    const playerNode = readNode(opts.player);
    const p = readPos(opts.player);
    if (p) s.player = p;
    if (opts.inside) { try { s.inside = !!opts.inside(); } catch {} }
    if (opts.grounded) { try { s.grounded = !!opts.grounded(); } catch {} }
    if (opts.animSpeed) { try { const a = Number(opts.animSpeed()); if (Number.isFinite(a)) s.animSpeed = a; } catch {} }
    if (p && B?.Vector3 && frame % (opts.thresholds?.rayEvery ?? FEEL_DEFAULTS.rayEvery) === 0) {
      const pred = solid(playerNode);
      const down = ray(V(p.x, p.y + 0.3, p.z), V(0, -1, 0), 500, pred);
      const fromAbove = ray(V(p.x, p.y + 60, p.z), V(0, -1, 0), 60, pred);
      s.floorBelow = !!down;
      s.surfaceAbove = fromAbove && fromAbove.pickedPoint && fromAbove.pickedPoint.y > p.y + 0.31 ? fromAbove.pickedPoint.y : null;
      if (s.cam) {
        const eye = V(p.x, p.y + head, p.z);
        const to = V(s.cam.pos.x - eye.x, s.cam.pos.y - eye.y, s.cam.pos.z - eye.z);
        const len = to.length();
        if (len > 0.5) {
          const hit = ray(eye, to.normalize(), len, pred);
          s.cameraBlocked = !!(hit && hit.distance < len - 0.3);
        }
      }
    }
    core.sample(s);
  });

  return {
    core,
    cut: (seconds) => core.cut(seconds),
    flags: () => core.flags(),
    metrics: () => core.metrics(),
    /** What the sensor is attached to now (the "feel-sensor" event): the adapter, whether it finds a player and a camera. */
    info: () => {
      let player = false, camera = false;
      try { player = !!readPos(opts.player); } catch {}
      try { camera = !!(readNode(opts.camera) ?? scene.activeCamera); } catch {}
      return { adapter: 'babylon', player, camera };
    },
    stop() { try { scene.onAfterRenderObservable.remove(obs); } catch {} keys?.stop(); },
  };
}

/** Frame hitches only, for pages with no Babylon scene (and Unity WebGL before its C# sensor is in). */
export function startFrameFeel(opts = {}) {
  const core = createFeelCore({ emit: opts.emit, seed: opts.seed ?? 0, scene: opts.sceneName, thresholds: opts.thresholds });
  const t0 = performance.now();
  let last = t0;
  let on = true;
  const tick = (now) => {
    if (!on) return;
    core.sample({ t: (now - t0) / 1000, dt: (now - last) / 1000 });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { core, cut: (s) => core.cut(s), flags: () => core.flags(), metrics: () => core.metrics(), info: () => ({ adapter: 'frames', player: false, camera: false }), stop() { on = false; } };
}

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const KEY_CODES = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' };
function watchMovementKeys(win) {
  const down = new Set();
  let touch = 0;
  // e.code, or the key's name for synthetic events that only set key (a playtest's own key presses).
  const codeOf = (e) => e.code || KEY_CODES[String(e.key ?? '').toLowerCase()] || '';
  const kd = (e) => { const c = codeOf(e); if (MOVE_KEYS.has(c)) down.add(c); };
  const ku = (e) => down.delete(codeOf(e));
  const ts = () => { touch++; };
  const te = () => { touch = Math.max(0, touch - 1); };
  const blur = () => { down.clear(); touch = 0; };
  win.addEventListener?.('keydown', kd, true);
  win.addEventListener?.('keyup', ku, true);
  win.addEventListener?.('touchstart', ts, true);
  win.addEventListener?.('touchend', te, true);
  win.addEventListener?.('blur', blur);
  return {
    held: () => (down.size || touch ? 1 : 0),
    stop() {
      win.removeEventListener?.('keydown', kd, true); win.removeEventListener?.('keyup', ku, true);
      win.removeEventListener?.('touchstart', ts, true); win.removeEventListener?.('touchend', te, true);
      win.removeEventListener?.('blur', blur);
    },
  };
}
