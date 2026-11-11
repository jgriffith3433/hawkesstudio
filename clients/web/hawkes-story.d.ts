// Types for hawkes-story.js (the drop-in story kit). Spec: hawkesstudio/docs/playtest.md#story-kit.
export const STORY_VERSION: 1;
export const MIN_COOLDOWN_S: 300;
export const MIN_TAP_PX: 44;

export type Req =
  | { fact: string; lt?: number; lte?: number; gt?: number; gte?: number; eq?: unknown; ne?: unknown; in?: unknown[] }
  | { seen: string } | { notSeen: string } | { flag: string } | { any: Req[] } | { not: Req };
export interface Bark { id: string; trigger: string; text?: string; voice?: string; speaker?: string; requires?: Req | Req[]; priority?: number; cooldown?: number; once?: boolean; anim?: string; event?: string }
export interface CutsceneLine { text?: string; voice?: string; speaker?: string; dur?: number }
export interface Cutscene { id: string; skippable?: boolean; music?: string; lines: CutsceneLine[]; next?: string }
export interface Page { id: string; text?: string; voice?: string; video?: string; choices?: { text?: string; to: string }[]; timeout?: { sec: number; to: string }; ending?: string }
export interface BeatsData { version?: number; story?: string; start?: string; barks?: Bark[]; cutscenes?: Cutscene[]; pages?: Page[] }

export function meets(req: Req | Req[] | null | undefined, facts?: Record<string, unknown>, mem?: { count(id: string): number }): boolean;
export function pickBark(barks: Bark[], trigger: string | undefined, facts: Record<string, unknown>, mem: { count(id: string): number; last(id: string): number | null }, nowS: number): Bark | null;

export interface StoryKit {
  version: 1;
  events: any[];
  facts: Record<string, unknown>;
  load(json: BeatsData | string): BeatsData;
  loadUrl(url: string): Promise<BeatsData>;
  setFact(k: string, v: unknown): void;
  fact(k: string): unknown;
  memory(): Record<string, { count: number; last: number | null }>;
  seen(id: string): boolean;
  activity(what?: string): any;
  bark(trigger?: string): Promise<Bark | null>;
  cutscene(id: string): Promise<{ skipped: boolean; next: string | null; missing?: boolean }>;
  skip(): boolean;
  choose(pageId: string, picked?: string): string | null;
  pushed(): any[];
}
export function createStoryKit(opts?: { win?: any; doc?: any; root?: any; sound?: any; now?: () => number; wait?: (s: number) => Promise<unknown> }): StoryKit;
