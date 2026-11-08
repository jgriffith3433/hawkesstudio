// The playtest feel layer, Studio's side (docs/playtest.md#feel). Gen's playtest.run returns `feel` (the flags the
// game's sensor pushed: camera snaps, falling through the floor, stuck on geometry, collision shoves, hitches...) and
// `polish` (a cheap vision pass over a few frames: ugly buildings, z-fighting, floating objects, stretched textures,
// clipping). Each kind of problem in a scene becomes one finding, with every place it happened and a replay line
// (scenario + seed + spot), so the agent that fixes it, and the recheck after, play that exact place.

export type FeelFlag = {
  id: string; kind: string; severity: 'bug' | 'polish'; t: number; rt?: number; pos: number[] | null;
  cam?: { yaw: number; pitch: number }; seed?: number; scene?: string; value?: number; detail: string; count?: number;
  spot?: string; shot?: string | null; clip?: string | null;
};
export type PolishHit = { kind: string; title?: string; severity: 'bug' | 'polish'; where: string; detail: string; t: number; asset: string | null; scene?: string };
export type Replay = { scenario: string; options: { seed?: number; spot?: string; at?: string } };
export type FeelFinding = { title: string; severity: string; area: string; detail: string; fix: string; shots: string[]; replay: Replay | null };

const TITLES: Record<string, string> = {
  'camera-snap': 'Camera snaps around',
  'camera-jump': 'Camera jumps',
  'camera-blocked': 'Camera ends up behind walls',
  'below-ground': 'Player falls through the floor',
  'fell-out': 'Player falls out of the world',
  'inside-geometry': 'Player gets inside geometry',
  stuck: 'Player gets stuck on geometry',
  'collision-pop': 'Collisions shove the player',
  jitter: 'Player jitters against colliders',
  hitch: 'Frame hitches',
  'foot-sliding': 'Feet slide (animation and movement disagree)',
  'slope-slide': 'Player slides off slopes after landing',
};

const FIXES: Record<string, string> = {
  'camera-snap': 'Smooth the camera: clamp its turn speed, ease rotation (slerp/damping), and avoid resets when the target changes or collision pushes it; check the camera collision and look-at code at the flagged spots.',
  'camera-jump': 'The camera position jumps: smooth its follow (damping), and ease out of collision pull-ins instead of snapping back.',
  'camera-blocked': 'Keep the camera out of walls: a camera collision/spring-arm that pulls in smoothly, or fade occluders between camera and player.',
  'below-ground': 'Close the hole in the collision at the flagged spot (missing or thin ground collider, a gap between floor pieces, a step that pushes the player down), and make the character controller snap back onto ground it leaves by accident.',
  'fell-out': 'The player leaves the world: add or fix the colliders at the edge, and a kill-plane respawn that puts them back on the last safe ground.',
  'inside-geometry': 'The player ends up inside a solid: check the colliders and spawn/teleport points at the flagged spot, and push out along the shortest axis.',
  stuck: 'The player can\'t move at the flagged spot while input is held: smooth the collider there (steps, seams, small lips), check step height/slope limits, and remove invisible blockers.',
  'collision-pop': 'A collision push-out shoves the player far in one frame: fix overlapping colliders at the spot, cap depenetration speed, and use continuous collision for fast movement.',
  jitter: 'The player shakes against a collider: overlapping or fighting colliders, or ground snapping that alternates; fix the geometry at the spot or add a dead-band.',
  'foot-sliding': 'Match the walk/run animation to the ground speed (drive the blend tree or animation speed from the controller\'s horizontal velocity, or use root motion), and stop the walk cycle when the body stops.',
  'slope-slide': 'Landing on a slope carries the player off: clamp horizontal velocity on landing, check the slope limit and ground friction, and snap to ground on touchdown.',
  hitch: 'A frame takes far too long: find what loads or compiles then (shader compiles, asset loads, garbage spikes) and warm it up or spread it out.',
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const placeOf = (f: FeelFlag) => (f.pos ? `(${f.pos.map((v) => Math.round(v)).join(', ')})` : 'an unknown spot');

/** Whether a flag kind counts as a bug at this many sightings (else polish, the ideas list). */
export function feelSeverity(kind: string, sev: 'bug' | 'polish', count: number): 'bug' | 'polish' {
  if (sev === 'bug') return 'bug';
  if (kind === 'camera-snap' || kind === 'camera-jump') return count >= 2 ? 'bug' : 'polish';
  if (kind === 'camera-blocked' || kind === 'collision-pop' || kind === 'jitter') return count >= 3 ? 'bug' : 'polish';
  return 'polish';
}

/**
 * The run's feel flags and polish hits as findings: one per kind and scene, worst first. In a verify or regression
 * run only bugs are filed (the polish list is the daily run's job). Hitches are left out when the run had no GPU.
 */
export function feelFindings(result: any, { scenario, mode = 'full', max = 6 }: { scenario: string; mode?: string; max?: number }): FeelFinding[] {
  const flags: FeelFlag[] = (Array.isArray(result?.feel) ? result.feel : []).filter((f: any) => f?.kind && (!result?.software || f.kind !== 'hitch'));
  const hits: PolishHit[] = Array.isArray(result?.polish?.hits) ? result.polish.hits : [];
  const groups = new Map<string, FeelFlag[]>();
  for (const f of flags) {
    const k = `${f.kind}|${f.scene ?? ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const out: (FeelFinding & { rank: number })[] = [];
  for (const [k, list] of groups) {
    const [kind, scene] = k.split('|');
    const total = list.reduce((n, f) => n + (f.count ?? 1), 0);
    const severity = feelSeverity(kind, list.some((f) => f.severity === 'bug') ? 'bug' : 'polish', total);
    const worst = [...list].sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0))[0];
    const seed = worst.seed ?? result?.seed;
    const replay: Replay | null = worst.spot ? { scenario, options: { ...(seed != null ? { seed } : {}), spot: worst.spot } } : null;
    const places = list.slice(0, 8).map((f) => `- ${placeOf(f)} at ${r1(f.rt ?? f.t)} s: ${f.detail}${(f.count ?? 1) > 1 ? ` (x${f.count})` : ''}${f.clip ? ` · clip ${f.clip}` : ''}${f.shot ? ` · shot ${f.shot}` : ''}`);
    out.push({
      rank: (severity === 'bug' ? 0 : 1000) - total,
      title: `${TITLES[kind] ?? kind}${scene ? ` in ${scene}` : ''}`,
      severity, area: kind === 'hitch' ? 'performance' : kind.startsWith('camera') ? 'camera' : 'gameplay',
      detail: [
        `The game's feel sensor flagged this ${total} time${total === 1 ? '' : 's'} in ${scenario} (seed ${seed ?? '?'}).`,
        `Places (x, y, z):\n${places.join('\n')}`,
        replay ? `Replay: ${JSON.stringify(replay)}` : '',
      ].filter(Boolean).join('\n').slice(0, 3000),
      fix: FIXES[kind] ?? 'Fix it at the flagged spot.',
      shots: list.map((f) => f.shot).filter((x): x is string => Boolean(x)).slice(0, 6),
      replay,
    });
  }
  // The vision pass: one finding per kind and scene, bugs only outside the daily run.
  const hitGroups = new Map<string, PolishHit[]>();
  for (const h of hits) {
    const k = `${h.kind}|${h.scene ?? ''}`;
    if (!hitGroups.has(k)) hitGroups.set(k, []);
    hitGroups.get(k)!.push(h);
  }
  for (const [k, list] of hitGroups) {
    const [kind, scene] = k.split('|');
    const severity = list.some((h) => h.severity === 'bug') ? 'bug' : 'polish';
    out.push({
      rank: (severity === 'bug' ? 100 : 1100) - list.length,
      // The rubric's own title (Gen's POLISH_RUBRIC_LINES, the one list): Studio keeps no copy of it.
      title: `${list[0].title ?? TITLES[kind] ?? kind}${scene ? ` in ${scene}` : ''}`,
      severity, area: 'art',
      detail: [`A vision pass over the playtest's frames saw this in ${scenario}:`, ...list.slice(0, 6).map((h) => `- at ${r1(h.t)} s, ${h.where}: ${h.detail}`)].join('\n').slice(0, 3000),
      fix: 'Fix the art or placement shown in the screenshots (model, texture scale/UVs, coplanar faces, ground placement).',
      shots: list.map((h) => h.asset).filter((x): x is string => Boolean(x)).slice(0, 6),
      replay: null,
    });
  }
  return out
    .filter((f) => mode === 'full' || f.severity === 'bug')
    .sort((a, b) => a.rank - b.rank)
    .slice(0, max)
    .map(({ rank, ...f }) => f);
}

/** The replay line a feel finding carries in its detail ("Replay: {...}"), or null. */
export function replayOf(detail: string | null | undefined): Replay | null {
  const m = /^Replay: (\{.*\})\s*$/m.exec(String(detail ?? ''));
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    if (!r || typeof r.scenario !== 'string' || !/^[\w.-]{1,60}$/.test(r.scenario)) return null;
    const o = r.options && typeof r.options === 'object' ? r.options : {};
    const options: Replay['options'] = {};
    if (Number.isFinite(Number(o.seed))) options.seed = Number(o.seed);
    if (typeof o.spot === 'string' && /^-?[\d.]+(,-?[\d.]+){2,3}$/.test(o.spot)) options.spot = o.spot;
    if (typeof o.at === 'string') options.at = o.at.slice(0, 80);
    return { scenario: r.scenario, options };
  } catch {
    return null;
  }
}

/** A short line for the step: how many flags and the polish score. */
export function feelLine(result: any): string {
  const n = Array.isArray(result?.feel) ? result.feel.length : 0;
  const score = result?.polish?.score;
  if (!n && score == null) return '';
  return `feel: ${n} flag${n === 1 ? '' : 's'}${score != null ? `, polish ${score}/10` : ''}`;
}
