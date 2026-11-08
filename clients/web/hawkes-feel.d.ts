// Types for hawkes-feel.js (the playtest feel sensor). Spec: hawkesstudio/docs/playtest.md#feel.
export const FEEL_VERSION: 1;
export const FEEL_DEFAULTS: Record<string, number>;
export type FeelKind = 'camera-snap' | 'camera-jump' | 'camera-blocked' | 'below-ground' | 'fell-out' | 'inside-geometry'
  | 'stuck' | 'collision-pop' | 'jitter' | 'hitch' | 'foot-sliding' | 'slope-slide';
export interface FeelFlag {
  id: string; kind: FeelKind | string; severity: 'bug' | 'polish'; t: number; pos: [number, number, number] | null;
  cam?: { pos: [number, number, number] | null; yaw: number; pitch: number };
  seed: number; scene?: string; value?: number; detail: string; count: number;
}
type V3 = { x: number; y: number; z: number };
export interface FeelSample {
  t: number; dt: number; cam?: { pos: V3; fwd: V3 }; player?: V3; input?: number; grounded?: boolean; animSpeed?: number;
  floorBelow?: boolean; surfaceAbove?: number | null; cameraBlocked?: boolean; inside?: boolean;
}
export interface FeelCore { sample(s: FeelSample): void; cut(seconds?: number): void; flags(): FeelFlag[]; thresholds: Record<string, number> }
export function createFeelCore(opts?: { emit?: (f: FeelFlag) => void; seed?: number; scene?: () => string | undefined; thresholds?: Record<string, number> }): FeelCore;
export function parseSpot(spot: unknown): { x: number; y: number; z: number; yaw?: number } | null;
export function pushToRunner(msg: unknown): void;
export interface FeelSensor { core: FeelCore; cut(seconds?: number): void; flags(): FeelFlag[]; stop(): void }
export function startBabylonFeel(opts?: Record<string, unknown>): FeelSensor | null;
export function startFrameFeel(opts?: Record<string, unknown>): FeelSensor;
