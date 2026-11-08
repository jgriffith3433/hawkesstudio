// Types for hawkes-playtest.js (the Hawkes playtest contract v1 helper, copied
// from hawkesstudio/clients/web). Spec: hawkesstudio/docs/playtest.md.

export const CONTRACT_VERSION: 1;

export interface Scenario {
  id: string;
  title: string;
  seconds: number;
  tags?: string[];
  description?: string;
  /** The start points this scenario takes in options.at (a place, chapter or level). */
  starts?: string[];
}

export interface RunOptions {
  seed: number;
  speed: number;
  /** A named start point (place, chapter, level); absent: play from the start. */
  at?: string;
  /** A place to start from, "x,y,z[,yaw]": a feel flag's replay (docs/playtest.md#feel). */
  spot?: string;
  [k: string]: unknown;
}

export type Outcome = 'won' | 'lost' | 'done' | 'stuck' | 'error';
export type Severity = 'bug' | 'warning' | 'polish';

export interface Tracker {
  scene(name: string): void;
  progress(p: number): void;
  note(text: string): void;
  metric(name: string, value: number): void;
  add(name: string, n?: number): void;
  event(type: string, detail?: unknown): void;
  problem(severity: Severity, message: string): void;
  log(line: string): void;
  finish(outcome?: Outcome): void;
  readonly seed: number;
  readonly speed: number;
  /** options.at, or null: play from the start. */
  readonly at: string | null;
  /** options.spot ("x,y,z[,yaw]"), parsed: a place to replay (a feel flag's), or null. */
  readonly spot: { x: number; y: number; z: number; yaw?: number } | null;
  /** An intended cut, respawn or teleport: the feel sensor rests for `seconds` (default 0.75). */
  cut(seconds?: number): void;
  /** Real time (not scaled by speed). */
  wait(ms: number): Promise<void>;
  until(test: () => unknown, timeoutMs?: number, what?: string): Promise<void>;
}

export interface PlaytestOptions {
  product: string;
  scenarios: Scenario[];
  isReady?: () => boolean;
  start(id: string, options: RunOptions, t: Tracker): void | Promise<void>;
  stop?(): void;
  input?(action: string, down: boolean): void;
  stallSeconds?: number;
  /** The feel sensor (hawkes-feel.js): false turns it off; the player and input turn on the player checks. */
  feel?: false | FeelOptions;
}

export interface FeelOptions {
  /** A Babylon mesh / TransformNode, a {x,y,z}, or a function returning one. */
  player?: unknown;
  /** The camera to watch (default: scene.activeCamera). */
  camera?: unknown;
  /** The Babylon scene (default: found by itself). */
  scene?: unknown;
  /** Movement input held, 0..1 (default: WASD / arrows / touch held). */
  input?: () => number;
  /** False while the player can't move (the game plays itself, a cutscene, a menu): only hitches are watched then. */
  active?: () => boolean;
  /** The game's own "player is inside a solid" check. */
  inside?: () => boolean;
  /** The controller's grounded flag: turns on the slope-landing check. */
  grounded?: () => boolean;
  /** How fast the walk/run animation moves the feet (m/s, 0 idle): turns on the foot-sliding check. */
  animSpeed?: () => number;
  /** Which meshes count as solid for the floor and camera rays (default: pickable, visible, enabled, not the player). */
  isSolid?: (mesh: any) => boolean;
  headHeight?: number;
  thresholds?: Record<string, number>;
}

export interface PlaytestApi {
  version: 1;
  product: string;
  scenarios(): Scenario[];
  start(id: string, options?: Partial<RunOptions>): Promise<void>;
  stop(): void;
  state(): Record<string, unknown>;
  report(): Record<string, unknown> | null;
  input?(action: string, down: boolean): void;
}

export function installPlaytest(opts: PlaytestOptions): PlaytestApi;
