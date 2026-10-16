// Types for hawkes-playtest.js (the Hawkes playtest contract v1 helper, copied
// from hawkesstudio/clients/web). Spec: hawkesstudio/docs/playtest.md.

export const CONTRACT_VERSION: 1;

export interface Scenario {
  id: string;
  title: string;
  seconds: number;
  tags?: string[];
}

export interface RunOptions {
  seed: number;
  speed: number;
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
