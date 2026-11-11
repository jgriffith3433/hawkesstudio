// The first five minutes (J, 2026-11-11: "a stranger who opens a game cold is playing within 20 s and succeeds at
// something within 60 s, and Studio knows when a game misses that"; reference: Vampire Survivors, the CrazyGames bar).
//
// The built-in `first-five` scenario opens a game's public live URL (a hub game's hawkesgames.com page too) cold: empty
// cache, no cookies, no dev flags, no scenario setup. Then it plays 5 minutes through whatever a real player meets
// (terms, sign-in, menus) with only what is on screen. The driver is Hawkes Gen's playtest.run (params `scenario:
// "first-five"`, `fresh`, `milestones`); a game that implements the contract may also call t.milestone(...) itself
// (clients/web/hawkes-playtest.js). Both end up as the same events in the result, which this file reads:
//
//   { type: 'milestone', detail: 'gameplay' | 'first-input-accepted' | 'first-success' | 'tutorial-step:<x>' }
//   { type: 'tap' }                                        one per tap or click the bot needed to get to play
//   { type: 'wall', detail: '{"kind","label","seconds"}' } something between the stranger and the game (terms, sign-in, menu)
//   { type: 'dev-ui', detail: '{"what","shot"}' }          a developer panel or debug control a player can see
//   metric ftue.wordsMinuteOne                             words on screen in the first 60 s (the driver counts them)
//
// ftueOf() turns that into the numbers; ftueMetrics() into the `ftue.*` playtest metrics the rubric's
// "first-five-minutes" checks read (quality/game-rubric.json; qualityGate in quality.ts judges them, a product's `tuning`
// moves a limit); the report and the go-live plan show them (ftueLines, ftueWarnings). A milestone never reached is a miss
// (the metric is the run's length), never "unmeasured".
//
// When: only in a build's one play (play-policy.ts, J 2026-11-11: "Playtests run only on that milestone build, once"),
// beside the milestone's scenarios: its beta page cold, on desktop and on a phone (firstFiveOnBuild, pipeline.ts
// betaBody). Never as a run of its own, weekly, after another run or before a go live: each of those was another GPU
// play of a build that was already played (#419 started one with every go live and after every run).

import { db, rowToStep } from './db.ts';
import type { Product, Playtest } from './config.ts';
import { isGame } from './quality.ts';
import { fileUrl } from './gen.ts';

export const FIRST_FIVE = 'first-five';
/** A run of it plays this long (seconds). */
export const FIRST_FIVE_SECONDS = 300;

/** The limits (also the rubric's; the rubric and a game's `tuning` win, these are what the report says without them). */
export const LIMITS = { gameplay: 20, firstInput: 30, firstSuccess: 60, tapsToPlay: 2, wordsMinuteOne: 40 } as const;

export type FtueWall = { kind: string; label: string; seconds: number; at: number };
export type FtueDevUi = { what: string; at: number; shot: string | null };
export type Ftue = {
  device: 'desktop' | 'phone';
  /** Seconds from the page opening; null: never reached in the run. */
  secondsToGameplay: number | null;
  secondsToFirstInput: number | null;
  secondsToFirstSuccess: number | null;
  tapsToPlay: number | null;
  wordsMinuteOne: number | null;
  walls: FtueWall[];
  wallSeconds: number;
  devUi: FtueDevUi[];
  tutorialSteps: { step: string; at: number }[];
  /** How long the run played (seconds). */
  seconds: number;
  /** The recording and the stretch of it behind the gameplay number (from 0 to when gameplay began, or the whole run). */
  clip: { asset: string; from: number; to: number } | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

const detailOf = (e: any): any => {
  if (e?.detail === undefined || e?.detail === null) return null;
  if (typeof e.detail === 'object') return e.detail;
  try { return JSON.parse(String(e.detail)); } catch { return String(e.detail); }
};

/** The first-five numbers of a playtest result (events, metrics and the video), for one device. Pure. */
export function ftueOf(r: any, device: 'desktop' | 'phone' = 'desktop'): Ftue {
  const events: any[] = Array.isArray(r?.events) ? r.events : [];
  const m: Record<string, unknown> = r?.metrics ?? {};
  const seconds = num(r?.seconds) ?? 0;
  const first = (name: string) => {
    const e = events.find((x) => x?.type === 'milestone' && String(x.detail ?? '').trim().toLowerCase() === name);
    return e ? num(e.t) : null;
  };
  const gameplay = num(m['ftue.secondsToGameplay']) ?? num(m['milestone.gameplay']) ?? first('gameplay');
  const input = num(m['ftue.secondsToFirstInput']) ?? num(m['milestone.first-input-accepted']) ?? first('first-input-accepted');
  const success = num(m['ftue.secondsToFirstSuccess']) ?? num(m['milestone.first-success']) ?? first('first-success');
  const taps = events.filter((e) => e?.type === 'tap' && (gameplay === null || (num(e.t) ?? 0) <= gameplay)).length;
  const walls: FtueWall[] = events.filter((e) => e?.type === 'wall').map((e) => {
    const d = detailOf(e);
    const o = d && typeof d === 'object' ? d : { label: String(d ?? '') };
    return { kind: String(o.kind ?? 'other').slice(0, 30), label: String(o.label ?? o.kind ?? 'a screen').slice(0, 120), seconds: round1(Math.max(0, num(o.seconds) ?? 0)), at: num(e.t) ?? 0 };
  });
  const devUi: FtueDevUi[] = events.filter((e) => e?.type === 'dev-ui').map((e) => {
    const d = detailOf(e);
    const o = d && typeof d === 'object' ? d : { what: String(d ?? 'developer UI') };
    return { what: String(o.what ?? 'developer UI').slice(0, 200), at: num(e.t) ?? 0, shot: typeof o.shot === 'string' ? o.shot : null };
  });
  const tutorialSteps = events.filter((e) => e?.type === 'milestone' && /^tutorial-step:/i.test(String(e.detail ?? ''))).map((e) => ({ step: String(e.detail).slice(14), at: num(e.t) ?? 0 }));
  const video = r?.video ?? null;
  const g = gameplay;
  return {
    device,
    secondsToGameplay: g,
    secondsToFirstInput: input,
    secondsToFirstSuccess: success,
    tapsToPlay: events.some((e) => e?.type === 'tap') ? taps : num(m['ftue.tapsToPlay']),
    wordsMinuteOne: num(m['ftue.wordsMinuteOne']),
    walls,
    wallSeconds: round1(walls.reduce((n, w) => n + w.seconds, 0)),
    devUi,
    tutorialSteps,
    seconds,
    clip: video ? { asset: String(video), from: 0, to: round1(g ?? seconds) } : null,
  };
}

/**
 * The `ftue.*` metrics of a first-five play (what the rubric checks read). A milestone never reached counts as the
 * run's length (over every limit), so a game that never gets going fails instead of being unmeasured. Words and taps the
 * driver didn't report are left out (unmeasured is said, not guessed).
 */
export function ftueMetrics(f: Ftue): Record<string, number> {
  const never = Math.max(f.seconds, FIRST_FIVE_SECONDS);
  const out: Record<string, number> = {
    'ftue.secondsToGameplay': f.secondsToGameplay ?? never,
    'ftue.secondsToFirstInput': f.secondsToFirstInput ?? never,
    'ftue.secondsToFirstSuccess': f.secondsToFirstSuccess ?? never,
    'ftue.devUiVisible': f.devUi.length,
    'ftue.walls': f.walls.length,
    'ftue.wallSeconds': f.wallSeconds,
  };
  if (f.tapsToPlay !== null) out['ftue.tapsToPlay'] = f.tapsToPlay;
  if (f.wordsMinuteOne !== null) out['ftue.wordsMinuteOne'] = f.wordsMinuteOne;
  return out;
}

export const isFirstFive = (scenario?: string | null) => /^first-five(?:-|$)/.test(String(scenario ?? ''));

/**
 * A playtest result of a first-five play with the numbers on it: `ftue` (ftueOf) and the `ftue.*` metrics (the developer
 * panels a stranger can see, with their screenshots, stay in `ftue.devUi`; the hard check counts them). Pure; a result of another scenario comes back as is.
 */
export function enrichFtue(r: Record<string, any>, scenario: string | null | undefined, device: 'desktop' | 'phone' = 'desktop'): Record<string, any> & { ftue?: Ftue } {
  if (!r || !isFirstFive(scenario) || r.ftue) return r;
  const f = ftueOf(r, device);
  return { ...r, ftue: f, metrics: { ...(r.metrics ?? {}), ...ftueMetrics(f) } };
}

// ------------------------------------------------------------ what people read

const sec = (n: number | null, limit?: number) => (n === null ? 'never (in 5 minutes)' : `${n} s${limit !== undefined && n > limit ? ` (limit ${limit} s)` : ''}`);

/** One device's first-five numbers as report lines (Markdown, one bullet each, readable at 390 px). */
export function ftueLines(f: Ftue | null | undefined, opts: { limits?: Partial<typeof LIMITS>; step?: string } = {}): string[] {
  if (!f) return [];
  const L = { ...LIMITS, ...(opts.limits ?? {}) };
  const out = [
    `- **${f.device === 'phone' ? 'Phone 390x844 touch' : 'Desktop'}:** gameplay ${sec(f.secondsToGameplay, L.gameplay)}, first input ${sec(f.secondsToFirstInput, L.firstInput)}, first success ${sec(f.secondsToFirstSuccess, L.firstSuccess)}; ${f.tapsToPlay === null ? 'taps to play not counted' : `${f.tapsToPlay} tap${f.tapsToPlay === 1 ? '' : 's'} to play (limit ${L.tapsToPlay})`}; ${f.wordsMinuteOne === null ? 'words in minute one not counted' : `${f.wordsMinuteOne} words in minute one (limit ${L.wordsMinuteOne})`}.`,
  ];
  if (f.secondsToGameplay === null || (f.secondsToGameplay > L.gameplay && f.clip)) {
    if (f.clip) out.push(`  - Clip: [0:00 to ${Math.floor(f.clip.to / 60)}:${String(Math.round(f.clip.to % 60)).padStart(2, '0')}](${fileUrl(f.clip.asset)})${opts.step ? ` · [playtest](#playtests/${opts.step})` : ''}`);
  }
  if (f.walls.length) {
    out.push(`  - Walls met (${f.wallSeconds} s in all): ${f.walls.map((w) => `${w.label} (${w.kind}, ${w.seconds} s, at ${w.at} s)`).join('; ')}.`);
  } else out.push('  - Walls met: none.');
  for (const d of f.devUi) out.push(`  - ❌ Developer UI visible to the public at ${d.at} s: ${d.what}${d.shot ? ` ([screenshot](${fileUrl(d.shot)}))` : ''}`);
  if (f.tutorialSteps.length) out.push(`  - Tutorial steps: ${f.tutorialSteps.map((t) => `${t.step} at ${t.at} s`).join(', ')}.`);
  return out;
}

// Played in a build's one play (first-five@local) since 2026-11-11; first-five@live before that.
const lastFirstFive = (product: string, phone: boolean) => {
  const names = ['local', 'live'].map((w) => `${FIRST_FIVE}@${w}${phone ? ':phone' : ''}`);
  const row = db.prepare(`SELECT * FROM steps WHERE product = ? AND kind = 'playtest' AND name IN (?, ?) AND status = 'done' ORDER BY started DESC LIMIT 1`).get(product, ...names);
  return row ? rowToStep(row) : null;
};

/** A game's latest first-five numbers (desktop and phone), from the steps of its last plays. */
export function latestFtue(product: string): Ftue[] {
  const out: Ftue[] = [];
  for (const dev of ['desktop', 'phone'] as const) {
    const s = lastFirstFive(product, dev === 'phone');
    if (s?.data?.ftue) out.push(s.data.ftue as Ftue);
  }
  return out;
}

/** For the go-live plan: the first-five misses of the last build played, in a sentence each (warnings, never blockers: a fix has to be able to ship). */
export function ftueWarnings(product: string): string[] {
  const out: string[] = [];
  for (const f of latestFtue(product)) {
    const d = f.device === 'phone' ? 'phone' : 'desktop';
    if (f.secondsToGameplay === null || f.secondsToGameplay > LIMITS.gameplay) out.push(`First five minutes (${d}): gameplay ${f.secondsToGameplay === null ? 'never started' : `took ${f.secondsToGameplay} s`}, over ${LIMITS.gameplay} s.`);
    if (f.secondsToFirstSuccess === null || f.secondsToFirstSuccess > LIMITS.firstSuccess) out.push(`First five minutes (${d}): first success ${f.secondsToFirstSuccess === null ? 'never came' : `at ${f.secondsToFirstSuccess} s`}, over ${LIMITS.firstSuccess} s.`);
    if (f.devUi.length) out.push(`First five minutes (${d}): developer UI visible to the public (${f.devUi[0].what}).`);
  }
  return out;
}

// ------------------------------------------------------------ playing it

/** Gen's playtest.run params for a first-five play: the page as a stranger meets it, nothing set up, nothing carried over. */
export function firstFiveParams(url: string, device: 'desktop' | 'phone'): Record<string, unknown> {
  return {
    url, mode: 'auto', scenario: FIRST_FIVE, timeout: FIRST_FIVE_SECONDS + 30,
    fresh: true, // empty cache, no cookies, no storage, no ?playtest hint, no dev flags, no scenario setup
    milestones: true, // keep the milestone, tap, wall, dev-ui events and count the words in minute one
    seconds: FIRST_FIVE_SECONDS,
    ...(device === 'phone' ? { mobile: true } : {}),
  };
}

/**
 * The first five minutes in a build's one play (play-policy.ts): the build's beta page as a stranger meets it, on desktop
 * and on a phone. A game only. Not the hub's page: hawkesgames.com shows what is live, another build than the one played.
 */
export function firstFiveOnBuild(p: Pick<Product, 'engine' | 'kind'>): Playtest[] {
  if (!isGame(p)) return [];
  return (['desktop', 'phone'] as const).map((device): Playtest => ({ scenario: FIRST_FIVE, where: 'local', ...(device === 'phone' ? { device } : {}), timeout: FIRST_FIVE_SECONDS + 30 }));
}
