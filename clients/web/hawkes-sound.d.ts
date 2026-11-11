// Types for hawkes-sound.js (the drop-in sound kit). Spec: hawkesstudio/docs/playtest.md#sound-kit.
export const SOUND_VERSION: 1;
export const BUSES: readonly ['music', 'sfx', 'ui', 'voice', 'ambience'];
export const MAX_JITTER: 0.05;
export const MIN_DUCK_DB: 6;
export const DEFAULT_DUCK_DB: 9;
export type Bus = 'music' | 'sfx' | 'ui' | 'voice' | 'ambience';

export function pickVariant(count: number, last?: number, rng?: () => number): number;
export function jitterRate(base?: number, jitter?: number, rng?: () => number): number;
export function synthBuffers(ctx: any, kind?: 'click' | 'step' | 'hit' | 'thud' | 'blip', count?: number): any[];

export interface SetOptions {
  bus?: Bus; urls?: string[]; buffers?: any[]; synth?: { kind: string; count?: number };
  pitch?: number; jitter?: number; volume?: number; volumeJitter?: number;
}
export interface Played { sample: string; variant: number; rate: number; volume: number; bus: Bus }
export interface MusicOptions {
  bpm?: number; beatsPerBar?: number; stems?: Record<string, string | any>; on?: string[]; volume?: number;
}
export interface SoundKit {
  ctx: any;
  buses: Record<Bus, any>;
  defineSet(name: string, o?: SetOptions): unknown;
  load(): Promise<void>;
  play(name: string, o?: { pitch?: number; jitter?: number; volume?: number; bus?: Bus; loop?: boolean }): Played | null;
  speak(name: string, o?: { url?: string; buffer?: any; volume?: number }): Promise<{ sample: string; duckDb: number } | null>;
  music(o?: MusicOptions): unknown;
  startMusic(): void;
  setStem(name: string, on: boolean): number | null;
  stopMusic(): void;
  setBusVolume(bus: Bus, v: number): void;
  unlock(): void;
  /** The kit plays the ui bus on every control press; the UI kit (hawkes-ui.js) turns it off and plays it itself. */
  autoUi: boolean;
  duckDb: number;
  state(): string;
  dispose(): void;
}
export function createSoundKit(opts?: { ctx?: any; win?: any; rng?: () => number; autoUi?: boolean; duckDb?: number; duckAttack?: number; duckRelease?: number }): SoundKit;
