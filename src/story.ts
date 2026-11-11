// The playtest story layer, Studio's side (docs/playtest.md#story-kit). The story kit (clients/web/hawkes-story.js,
// Unity HawkesStory.cs) pushes story-beat / story-cutscene / story-choice / story-activity events while a game plays.
// Studio turns that timeline into MEASURED quality.textOnlyBeats and quality.maxQuietSeconds (a game using the kit
// no longer reads "unmeasured"), the bark repeat check (the same bark twice inside 5 minutes) and the phone cutscene
// check (Skip is a real tap target, captions stay inside the safe area), each as a finding naming its beat.

export type StoryEvent = {
  type: string; t: number; id?: string; kind?: string; voiced?: boolean; acted?: boolean; captioned?: boolean; textOnly?: boolean;
  state?: string; via?: string; skippable?: boolean; what?: string; options?: number; real?: boolean;
  skipRect?: Rect | null; captionRect?: Rect | null; safe?: Insets; viewport?: { w: number; h: number }; speaker?: string;
};
type Rect = { x: number; y: number; w: number; h: number };
type Insets = { top: number; right: number; bottom: number; left: number };
export type StoryFinding = { title: string; severity: string; area: string; detail: string; fix: string; shots: string[]; replay: null };

/** A bark may not play twice inside this many seconds (the kit's MIN_COOLDOWN_S). */
export const BARK_REPEAT_S = 300;
/** A cutscene's Skip button is at least this many CSS px each way (hawkes-story.js MIN_TAP_PX). */
export const MIN_TAP_PX = 44;

const r2 = (n: number) => Math.round(n * 100) / 100;
const STORY_TYPES = new Set(['story-kit', 'story-beat', 'story-cutscene', 'story-choice', 'story-activity']);

/** The story events a run carries: pushed rows, and rows whose `detail` holds the event as JSON. */
export function storyEventsOf(result: any): StoryEvent[] {
  const out: StoryEvent[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(result?.events) ? result.events : []) {
    let d: any = e;
    if (e?.detail != null) {
      try { const x = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail; if (x && typeof x === 'object') d = { ...x, type: x.type || e.type, t: x.t ?? e.t }; } catch { /* keep e */ }
    }
    if (!d || !STORY_TYPES.has(String(d.type))) continue;
    const t = Number(d.t);
    const row: StoryEvent = { ...d, type: String(d.type), t: Number.isFinite(t) ? t : 0 };
    const key = `${row.type}|${row.t}|${row.id ?? ''}|${row.state ?? ''}|${row.what ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  if (Array.isArray(result?.story)) for (const x of result.story) if (x && STORY_TYPES.has(String(x.type))) out.push({ ...x, t: Number(x.t) || 0 });
  out.sort((a, b) => a.t - b.t);
  return out;
}

const inside = (r: Rect, vw: number, vh: number, s: Insets) => r.x >= s.left - 0.5 && r.y >= s.top - 0.5 && r.x + r.w <= vw - s.right + 0.5 && r.y + r.h <= vh - s.bottom + 0.5;

/**
 * Metrics from the story timeline. Empty (nothing measured) when the game doesn't use the kit; with it, the two quality
 * metrics are always numbers. Quiet = the longest stretch with no story beat, activity, cutscene line, sound start or
 * input (a stretch with nothing new to see, hear or do), from the first event to the end of the run.
 */
export function storyMetricsFromEvents(events: StoryEvent[], opts: { endS?: number; sounds?: { t: number }[]; inputs?: { t: number }[] } = {}) {
  const used = events.some((e) => STORY_TYPES.has(e.type));
  if (!used) return null;
  const beats = events.filter((e) => e.type === 'story-beat');
  const textOnly = beats.filter((b) => b.textOnly);
  const live: number[] = [
    ...events.filter((e) => e.type === 'story-beat' || e.type === 'story-activity' || (e.type === 'story-cutscene' && e.state !== 'end')).map((e) => e.t),
    ...(opts.sounds ?? []).map((s) => s.t), ...(opts.inputs ?? []).map((s) => s.t),
  ].sort((a, b) => a - b);
  const end = opts.endS ?? (events.length ? events[events.length - 1].t : 0);
  let quiet = 0;
  if (live.length) {
    for (let i = 1; i < live.length; i++) quiet = Math.max(quiet, live[i] - live[i - 1]);
    quiet = Math.max(quiet, end - live[live.length - 1]);
  } else quiet = Math.max(0, end - (events[0]?.t ?? 0));

  const lastBark = new Map<string, number>();
  const repeats: { id: string; t: number; prev: number }[] = [];
  for (const b of beats.filter((x) => x.kind === 'bark')) {
    const id = String(b.id ?? 'bark');
    const prev = lastBark.get(id);
    if (prev != null && b.t - prev < BARK_REPEAT_S) repeats.push({ id, t: b.t, prev });
    lastBark.set(id, b.t);
  }

  const cut = events.filter((e) => e.type === 'story-cutscene');
  const small: { id: string; w: number; h: number }[] = [];
  const outside: { id: string; what: string; t: number }[] = [];
  for (const c of cut) {
    const vw = c.viewport?.w ?? 0, vh = c.viewport?.h ?? 0;
    const safe = c.safe ?? { top: 0, right: 0, bottom: 0, left: 0 };
    if (c.skipRect && c.skipRect.w > 0) {
      if (c.skipRect.w < MIN_TAP_PX || c.skipRect.h < MIN_TAP_PX) small.push({ id: String(c.id), w: c.skipRect.w, h: c.skipRect.h });
      if (vw && !inside(c.skipRect, vw, vh, safe)) outside.push({ id: String(c.id), what: 'Skip button', t: c.t });
    }
    if (c.captionRect && c.captionRect.w > 0 && vw && !inside(c.captionRect, vw, vh, safe)) outside.push({ id: String(c.id), what: 'captions', t: c.t });
  }
  const metrics: Record<string, number> = {
    'quality.textOnlyBeats': textOnly.length,
    'quality.maxQuietSeconds': r2(quiet),
    'story.beats': beats.length,
    'story.voicedBeats': beats.filter((b) => b.voiced).length,
    'story.barkRepeats5m': repeats.length,
    'story.cutscenes': cut.filter((c) => c.state === 'start').length,
    'story.cutsceneSkips': cut.filter((c) => c.state === 'skip').length,
    'story.skipTooSmall': small.length,
    'story.outsideSafeArea': outside.length,
  };
  return { metrics, textOnly, repeats, small, outside };
}

/** Merge story metrics into a playtest result (audio events give the sounds and inputs the quiet gap counts). Never throws. */
export function enrichStory(result: any, audio?: { type: string; t: number }[]) {
  if (!result || typeof result !== 'object') return result;
  const events = storyEventsOf(result);
  const got = storyMetricsFromEvents(events, {
    endS: Number(result.seconds) || undefined,
    sounds: (audio ?? []).filter((e) => e.type === 'sound-start'), inputs: (audio ?? []).filter((e) => e.type === 'input'),
  });
  if (!got) return result;
  return { ...result, metrics: { ...(result.metrics ?? {}), ...got.metrics }, story: events, _story: got };
}

const FIX_TEXT = 'Give the beat a voice line (Hawkes Gen voice) or play it as an acted scene (an animation, an event, a cutscene) and keep the caption as a subtitle: on-screen text alone is a last resort.';
const FIX_REPEAT = 'Keep each bark off for its cooldown (the story kit does, at 5 minutes): give it requirements that are true less often, or write more barks for the trigger so the kit can take turns.';
const FIX_SMALL = 'Make the cutscene Skip button at least 44 x 44 px so one tap at 390x844 hits it (hawkes-story.js lays it out that way).';
const FIX_SAFE = 'Keep the cutscene Skip button and captions inside the safe area (env(safe-area-inset-*) on the web, Screen.safeArea in Unity).';
const FIX_QUIET = 'Add barks, ambient events or something to do so no stretch runs more than 10 seconds without something to see, hear or do (call story.activity() for world events).';

/** One finding per broken story limit, naming the beat and its time. */
export function storyFindings(result: any, { scenario }: { scenario: string }): StoryFinding[] {
  const e = result?._story ? result : enrichStory(result);
  const g = e?._story as ReturnType<typeof storyMetricsFromEvents> | undefined;
  if (!g) return [];
  const m = e.metrics ?? {};
  const out: StoryFinding[] = [];
  const f = (title: string, detail: string, fix: string) => out.push({ title, severity: 'bug', area: 'story', detail, fix, shots: [], replay: null });
  for (const b of g.textOnly.slice(0, 8)) f(`Text-only story beat: ${b.id} at ${r2(b.t)} s`, `In ${scenario}, the ${b.kind ?? 'beat'} "${b.id}" at ${r2(b.t)} s was told in text only: no voice line and no acted scene (quality.textOnlyBeats = ${m['quality.textOnlyBeats']}).`, FIX_TEXT);
  for (const x of g.repeats.slice(0, 8)) f(`Bark repeated within 5 minutes: ${x.id} at ${r2(x.t)} s`, `In ${scenario}, the bark "${x.id}" played at ${r2(x.prev)} s and again at ${r2(x.t)} s (limit: not twice inside ${BARK_REPEAT_S} s).`, FIX_REPEAT);
  for (const x of g.small.slice(0, 4)) f(`Cutscene Skip too small: ${x.id}`, `In ${scenario}, the Skip button of cutscene "${x.id}" was ${x.w} x ${x.h} px (needs ${MIN_TAP_PX} x ${MIN_TAP_PX} for one tap on a phone).`, FIX_SMALL);
  for (const x of g.outside.slice(0, 4)) f(`Cutscene ${x.what} outside the safe area: ${x.id}`, `In ${scenario}, the ${x.what} of cutscene "${x.id}" at ${r2(x.t)} s sat outside the safe area of the viewport.`, FIX_SAFE);
  if (Number(m['quality.maxQuietSeconds']) > 10) f(`Quiet stretch in play: ${m['quality.maxQuietSeconds']} s`, `In ${scenario}, the longest stretch with no story beat, activity, sound or input was ${m['quality.maxQuietSeconds']} s (limit 10).`, FIX_QUIET);
  return out;
}

/** One line for a playtest step detail. */
export function storyLine(result: any): string {
  const m = result?.metrics ?? {};
  if (m['quality.textOnlyBeats'] == null || m['story.beats'] == null) return '';
  return `story: ${m['story.beats']} beats, ${m['quality.textOnlyBeats']} text-only, quiet ${m['quality.maxQuietSeconds']} s`;
}
