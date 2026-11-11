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
  /** A first-five-minutes moment, once each, timed from the page opening: what a stranger waited for. */
  milestone(name: 'gameplay' | 'first-input-accepted' | 'first-success' | `tutorial-step:${string}`, note?: string): void;
  /** One tap or click needed to get from the first screen to play. */
  tap(): void;
  /** A terms, sign-in or menu screen between the stranger and the game, and the seconds it cost. */
  wall(kind: 'terms' | 'sign-in' | 'menu' | 'loading' | 'ad' | 'other' | (string & {}), label: string, seconds: number): void;
  /** A developer panel or debug control visible to a player (and its screenshot's asset id). */
  devUi(what: string, shot?: string): void;
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
  /** A UI layout check now (a menu just opened): the DOM's controls, or `rects` (CSS px, y down) for a canvas game (docs/playtest.md#ui). */
  ui(rects?: { id?: string; label?: string; x: number; y: number; w: number; h: number; fixed?: boolean }[], options?: { label?: string }): unknown;
  /** A press on a control the DOM doesn't know (canvas): `changed` says the screen answered, `ms` how fast. */
  uiPress(label: string, options?: { changed?: boolean; ms?: number; rect?: number[] }): void;
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
  /**
   * The explore bot (hawkes-explore.js, docs/playtest.md#explore): with feel.player set, adds an "explore" scenario that
   * hugs walls, jumps edges and maps stuck and fall spots. true: the game is playable on load.
   */
  explore?: boolean | ExploreOptions;
  /** The audio probe (hawkes-audio.js): false turns it off. On by default for every run. */
  audio?: false | AudioOptions;
  /** The UI probe (hawkes-ui.js, docs/playtest.md#ui): on for touch or phone-sized pages; false turns it off, always runs it on desktop too, canvas stops the DOM reading. */
  ui?: false | { always?: boolean; canvas?: boolean; otherOrientation?: boolean; thresholds?: Record<string, unknown> };
}

export interface AudioOptions {
  thresholds?: Record<string, number>;
}

export interface ExploreOptions {
  /** Gets the player into play (past menus) before the bot starts. */
  enter?(t: Tracker): void | Promise<void>;
  /** How long the bot plays (default 120). */
  seconds?: number;
  /** Grid cell size in meters (default 2). */
  cell?: number;
  thresholds?: Record<string, unknown>;
}

export interface FeelOptions {
  /** A Babylon mesh / TransformNode, a {x,y,z}, or a function returning one. */
  player?: unknown;
  /** The camera to watch (default: scene.activeCamera). */
  camera?: unknown;
  /** The Babylon scene, or a function returning it (default: found by itself; re-found once if it renders no frame in 5 s). */
  scene?: unknown | (() => unknown);
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
