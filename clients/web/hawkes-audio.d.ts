// Types for hawkes-audio.js (the playtest audio probe). Spec: hawkesstudio/docs/playtest.md#audio.
export const AUDIO_VERSION: 1;
export const AUDIO_DEFAULTS: Record<string, number>;

export type AudioEventType = 'sound-start' | 'input' | 'audiocontext-resume' | 'audio-sensor' | 'bus-gain';
export interface AudioEvent {
  type: AudioEventType | string;
  t: number;
  id?: string;
  sample?: string;
  bus?: string;
  rate?: number;
  gain?: number;
  action?: string;
  how?: string;
  scene?: string;
  silent?: boolean;
  dur?: number;
}

export type AudioMetrics = Record<string, number>;

export interface AudioCore {
  soundStart(o?: { sample?: string; bus?: string; rate?: number; gain?: number; dur?: number; t?: number }): AudioEvent;
  busGain(o?: { bus?: string; gain?: number; t?: number }): AudioEvent;
  input(o?: { action?: string; t?: number }): AudioEvent;
  resume(o?: { how?: string; t?: number }): AudioEvent;
  settleSilents(endT?: number): void;
  events(): AudioEvent[];
  metrics(): AudioMetrics;
  thresholds: Record<string, number>;
}

export function sampleIdOf(node: unknown): string;
export function busOf(node: unknown): string;
export function pushToRunner(msg: unknown): void;
export function createAudioCore(opts?: {
  emit?: (ev: AudioEvent) => void;
  now?: () => number;
  scene?: () => string | undefined;
  thresholds?: Record<string, number>;
}): AudioCore;

export interface AudioProbe {
  core: AudioCore;
  mark(sample: string, opts?: { bus?: string; rate?: number; gain?: number }): AudioEvent;
  input(action?: string): AudioEvent;
  events(): AudioEvent[];
  metrics(): AudioMetrics;
  info(): { adapter: string; contexts: number; recorder: string };
  stop(): void;
}

export function startAudioProbe(opts?: {
  emit?: (ev: AudioEvent) => void;
  now?: () => number;
  scene?: () => string | undefined;
  thresholds?: Record<string, number>;
  win?: typeof globalThis;
}): AudioProbe;
