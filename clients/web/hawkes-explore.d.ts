// Types for hawkes-explore.js (the explore bot). Spec: hawkesstudio/docs/playtest.md#explore.

export const EXPLORE_VERSION: 1;
export const EXPLORE_DEFAULTS: {
  seconds: number; cell: number; tickMs: number; stuckSeconds: number; stuckMeters: number;
  giveUpSeconds: number; jumpEvery: [number, number]; turnEvery: [number, number]; fallDrop: number;
};

/** [cellX, cellZ, seconds or count] */
export type ExploreCell = [number, number, number];

export interface ExploreSummary {
  v: 1;
  cell: number;
  coverage: number;
  deadSeconds: number;
  visited: ExploreCell[];
  stuck: ExploreCell[];
  falls: ExploreCell[];
}

export interface ExploreMap {
  cell: number;
  visit(pos: { x: number; y?: number; z: number } | number[], t: number, dt: number): void;
  mark(kind: 'stuck' | 'fall', pos: { x: number; y?: number; z: number } | number[]): void;
  summary(t?: number): ExploreSummary;
}

export interface Keyboard {
  hold(name: 'forward' | 'back' | 'left' | 'right' | 'jump'): void;
  release(name: 'forward' | 'back' | 'left' | 'right' | 'jump'): void;
  tap(name: 'forward' | 'back' | 'left' | 'right' | 'jump', ms?: number): void;
  releaseAll(): void;
  held(): string[];
}

export function seededRandom(seed?: number): () => number;
export function createExploreMap(o?: { cell?: number }): ExploreMap;
export function makeKeyboard(win?: unknown): Keyboard;
export function runExplore(o: {
  player: unknown; t?: unknown; seed?: number; seconds?: number; map?: ExploreMap; keyboard?: Keyboard;
  thresholds?: Partial<typeof EXPLORE_DEFAULTS>; now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Promise<ExploreSummary>;
