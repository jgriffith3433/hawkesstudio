// A video's edit (J, 2026-10-22: "click at points of time/highlight portions (like a video editor timeline) and give the
// agent notes on what to do (like make this scene shorter, fix the lip sync, redo this scene, zoom in here...)").
//
// The agent hands over its cut as an edit: Gen video.compose's timeline with Gen asset ids in place of input indexes
// (.hawkes/video.json `edit`). With it, Studio can:
//   - show the cut as shots on a timeline (shotsOf), and say which shots a selected range covers (shotsIn);
//   - make the plain edits itself, in seconds, without the agent (applyEdit: cut a range out, speed a range up, punch
//     or push in on a point), and render them with video.compose (composeParams);
// Everything here is pure (no I/O), so the tests check it directly.

export type EditClip = {
  asset: string; in?: number; out?: number; speed?: number;
  zoom?: { from?: number; to?: number; x?: number; y?: number };
  transition?: string; seconds?: number; sound?: boolean; volume?: number; dialogue?: boolean;
  /** The beat sheet's shot this clip is (its `key`, or its index), and a short label for the timeline. */
  beat?: string | number; label?: string;
  /** How long the source is (the agent says; Studio fills it when it probes). Needed to cut inside an open-ended clip. */
  length?: number;
};
export type EditTrack = { asset: string; start?: number; in?: number; seconds?: number; volume?: number; fadeIn?: number; fadeOut?: number; loop?: boolean; duck?: boolean | 'envelope' | 'sidechain'; duckTo?: number; dialogue?: boolean; label?: string };
export type EditCaption = { text: string; start: number; end: number };
export type Edit = { width: number; height: number; fps: number; clips: EditClip[]; audio: EditTrack[]; captions: EditCaption[]; burn?: boolean; fadeIn?: number; fadeOut?: number };

const ASSET = /^a_[0-9a-f]{8,32}$/;
/** How close (seconds) a selection's edge must be to a cut to snap to it. */
const SNAP = 0.25;
const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The agent's edit, checked: Gen asset ids, numbers where numbers go, absolute starts for tracks and captions. null when unusable. */
export function readEdit(e: any): Edit | null {
  if (!e || typeof e !== 'object' || !Array.isArray(e.clips) || !e.clips.length) return null;
  const clips: EditClip[] = [];
  for (const c of e.clips.slice(0, 300)) {
    if (!c || !ASSET.test(String(c.asset ?? ''))) return null;
    const clip: EditClip = { asset: c.asset };
    for (const k of ['in', 'out', 'speed', 'seconds', 'volume', 'length'] as const) if (Number.isFinite(Number(c[k])) && c[k] !== null && c[k] !== '') clip[k] = Number(c[k]);
    if (c.zoom && typeof c.zoom === 'object') clip.zoom = Object.fromEntries(['from', 'to', 'x', 'y'].filter((k) => Number.isFinite(Number(c.zoom[k]))).map((k) => [k, Number(c.zoom[k])]));
    if (typeof c.transition === 'string') clip.transition = c.transition;
    if (typeof c.sound === 'boolean') clip.sound = c.sound;
    if (typeof c.dialogue === 'boolean') clip.dialogue = c.dialogue;
    if (typeof c.beat === 'string' || typeof c.beat === 'number') clip.beat = c.beat;
    if (c.label) clip.label = String(c.label).slice(0, 160);
    clips.push(clip);
  }
  const audio: EditTrack[] = [];
  for (const t of Array.isArray(e.audio) ? e.audio.slice(0, 200) : []) {
    // A track placed relative to a clip can't follow Studio's edits: the agent writes absolute starts.
    if (!t || !ASSET.test(String(t.asset ?? '')) || t.clip !== undefined) return null;
    const track: EditTrack = { asset: t.asset };
    for (const k of ['start', 'in', 'seconds', 'volume', 'fadeIn', 'fadeOut', 'duckTo'] as const) if (Number.isFinite(Number(t[k])) && t[k] !== null && t[k] !== '') track[k] = Number(t[k]);
    for (const k of ['loop', 'dialogue'] as const) if (typeof t[k] === 'boolean') track[k] = t[k];
    if (t.duck === true || t.duck === 'envelope' || t.duck === 'sidechain') track.duck = t.duck;
    if (t.label) track.label = String(t.label).slice(0, 160);
    audio.push(track);
  }
  const captions: EditCaption[] = (Array.isArray(e.captions) ? e.captions : [])
    .filter((c: any) => c && c.text && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)) && Number(c.end) > Number(c.start))
    .slice(0, 300).map((c: any) => ({ text: String(c.text).slice(0, 300), start: Number(c.start), end: Number(c.end) }));
  const width = Math.round(n(Number(e.width), 1080));
  const height = Math.round(n(Number(e.height), 1920));
  return {
    width: Math.min(3840, Math.max(64, width)), height: Math.min(3840, Math.max(64, height)), fps: Math.min(60, Math.max(8, n(Number(e.fps), 24))),
    clips, audio, captions, burn: e.burn !== false,
    ...(Number.isFinite(Number(e.fadeIn)) ? { fadeIn: Number(e.fadeIn) } : {}), ...(Number.isFinite(Number(e.fadeOut)) ? { fadeOut: Number(e.fadeOut) } : {}),
  };
}

/** A clip's length on the cut (its source span over its speed); null when its out is open and its source length unknown. */
function playLength(c: EditClip): number | null {
  const out = c.out ?? c.length;
  if (out === undefined) return null;
  return Math.max(0, (out - (c.in ?? 0)) / (c.speed ?? 1));
}

export type Shot = { i: number; start: number; end: number; beat?: string | number; label?: string; asset: string };
/** The cut as shots: where each clip starts and ends on the cut (a transition overlaps a clip into the next). */
export function shotsOf(e: Edit): Shot[] {
  const out: Shot[] = [];
  let t = 0;
  e.clips.forEach((c, i) => {
    const len = playLength(c) ?? 0;
    out.push({ i, start: r3(t), end: r3(t + len), beat: c.beat, label: c.label, asset: c.asset });
    const x = c.transition && c.transition !== 'cut' && i < e.clips.length - 1 ? n(c.seconds, 0.5) : 0;
    t += len - x;
  });
  return out;
}
export const lengthOf = (e: Edit) => shotsOf(e).at(-1)?.end ?? 0;

/** The shots a range of the cut covers (any overlap). */
export function shotsIn<T extends { start: number; end: number }>(shots: T[], from: number, to: number): T[] {
  return shots.filter((s) => s.end > from + 1e-3 && s.start < to - 1e-3);
}

/** The beat sheet's beats a range covers (beats have t and seconds). */
export function beatsIn(beats: any[] | null | undefined, from: number, to: number) {
  return (beats ?? []).map((b, i) => ({ ...b, i })).filter((b) => Number.isFinite(Number(b.t)) && Number(b.t) + n(Number(b.seconds), 0) > from + 1e-3 && Number(b.t) < to - 1e-3);
}

export type EditOp =
  | { op: 'remove'; from: number; to: number }
  | { op: 'speed'; from: number; to: number; factor: number }
  | { op: 'zoom'; from: number; to: number; zoom: number; x?: number; y?: number; push?: boolean };

/**
 * Splits the cut at a time: the clip playing there becomes two (same source, in/out at the split), so a range can be
 * changed on its own. Only where clips meet by a cut: a split inside a transition is refused.
 */
function splitAt(e: Edit, at: number): Edit {
  const shots = shotsOf(e);
  const k = shots.findIndex((s) => at > s.start + 1e-3 && at < s.end - 1e-3);
  if (k < 0) return e;
  const c = e.clips[k];
  const prevX = k > 0 && e.clips[k - 1].transition && e.clips[k - 1].transition !== 'cut' ? n(e.clips[k - 1].seconds, 0.5) : 0;
  const ownX = c.transition && c.transition !== 'cut' && k < e.clips.length - 1 ? n(c.seconds, 0.5) : 0;
  if (at < shots[k].start + prevX || at > shots[k].end - ownX) throw new Error(`${at.toFixed(2)} s is inside a transition: pick a range that starts and ends on whole shots`);
  if (c.out === undefined && c.length === undefined) throw new Error(`shot ${k + 1} has no known length: the agent's edit should give each clip its out`);
  const speed = c.speed ?? 1;
  const mid = r3((c.in ?? 0) + (at - shots[k].start) * speed);
  // A push-in across the split keeps going: each half gets its share of the zoom.
  const z = c.zoom;
  let za = z, zb = z;
  if (z && z.from !== undefined && z.to !== undefined && z.from !== z.to) {
    const f = (at - shots[k].start) / Math.max(1e-6, shots[k].end - shots[k].start);
    const zm = r3(z.from + (z.to - z.from) * f);
    za = { ...z, to: zm };
    zb = { ...z, from: zm };
  }
  const a: EditClip = { ...c, out: mid, transition: undefined, seconds: undefined, ...(za ? { zoom: za } : {}) };
  const b: EditClip = { ...c, in: mid, ...(zb ? { zoom: zb } : {}) };
  delete a.transition;
  delete a.seconds;
  return { ...e, clips: [...e.clips.slice(0, k), a, b, ...e.clips.slice(k + 1)] };
}

/** The clips a range covers after splitting at its ends (indexes into the returned edit's clips). */
function isolate(e: Edit, from: number, to: number): { e: Edit; ids: number[] } {
  if (!(to > from)) throw new Error('Select a range: the end is before the start');
  const total = lengthOf(e);
  // An edge a hair from a cut snaps to it: a hand-dragged selection shouldn't leave a two-frame sliver of a shot.
  const edges = [0, ...shotsOf(e).map((s) => s.end)];
  const snap = (t: number) => edges.find((x) => Math.abs(x - t) <= SNAP) ?? t;
  from = Math.max(0, snap(from));
  to = Math.min(total, snap(to));
  if (to - from < 0.05) throw new Error('The selection is outside the cut');
  let x = splitAt(splitAt(e, from), to);
  const ids = shotsOf(x).filter((s) => s.start >= from - 1e-3 && s.end <= to + 1e-3 && s.end - s.start > 1e-3).map((s) => s.i);
  return { e: x, ids };
}

/** Moves (and trims) what's placed in absolute time after a cut out of [from, to): tracks, captions. */
function closeGap<T extends { start?: number; end?: number }>(items: T[], from: number, to: number, kind: 'track' | 'caption', len?: (t: T) => number): T[] {
  const gap = to - from;
  const out: T[] = [];
  for (const it of items) {
    const s = n(it.start, 0);
    const end = kind === 'caption' ? n(it.end, s) : s + (len?.(it) ?? Infinity);
    if (end <= from + 1e-3) { out.push(it); continue; }
    if (s >= to - 1e-3) { out.push({ ...it, start: r3(s - gap), ...(kind === 'caption' ? { end: r3(end - gap) } : {}) }); continue; }
    // Overlaps the cut: a caption keeps what's outside it; a track that starts inside it starts later in its file.
    if (kind === 'caption') {
      const ns = s < from ? s : from;
      const ne = end > to ? end - gap : from;
      if (ne - ns > 0.2) out.push({ ...it, start: r3(ns), end: r3(ne) });
      continue;
    }
    if (s < from) { out.push(it); continue; }
    const skip = to - s;
    const t: any = { ...it, start: r3(from), in: r3(n((it as any).in, 0) + skip) };
    if (t.seconds !== undefined) t.seconds = r3(t.seconds - skip);
    if (t.seconds === undefined || t.seconds > 0.05) out.push(t);
  }
  return out;
}

/** Applies a plain edit to the cut: the new edit and a sentence for J and the agent saying what changed. */
export function applyEdit(e: Edit, op: EditOp, trackLength?: (asset: string) => number | undefined): { edit: Edit; said: string } {
  const at = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  const span = `${at(op.from)}-${at(op.to)}`;
  if (op.op === 'remove') {
    const { e: x, ids } = isolate(e, op.from, op.to);
    if (!ids.length) throw new Error('Nothing to cut there');
    // Half a voice line would be left playing over the next shot: cut whole lines (or send it to the agent).
    const s0 = shotsOf(x);
    const [cf, ct] = [s0[ids[0]].start, s0[ids.at(-1)!].end];
    const halfLine = x.audio.find((t) => {
      if (!t.dialogue) return false;
      const s = n(t.start, 0);
      const end = s + n(t.seconds, (trackLength?.(t.asset) ?? 0) - n(t.in, 0));
      return (s < cf - 0.05 && end > cf + 0.05) || (s < ct - 0.05 && end > ct + 0.05);
    });
    if (halfLine) throw new Error(`A voice line${halfLine.label ? ` ("${halfLine.label}")` : ''} runs across the edge of that cut: select whole lines, or send it to the agent as a note`);
    if (ids.length === x.clips.length) throw new Error("That's the whole video");
    const shots = shotsOf(x);
    const from = shots[ids[0]].start;
    const to = shots[ids.at(-1)!].end;
    const clips = x.clips.filter((_, i) => !ids.includes(i));
    const len = (t: EditTrack) => n(t.seconds, (trackLength?.(t.asset) ?? Infinity) - n(t.in, 0));
    return {
      edit: { ...x, clips, audio: closeGap(x.audio, from, to, 'track', len), captions: closeGap(x.captions, from, to, 'caption') },
      said: `cut ${span} out (${(to - from).toFixed(1)} s shorter)`,
    };
  }
  if (op.op === 'speed') {
    const factor = Math.min(4, Math.max(0.25, op.factor));
    // A voice line under the range would come apart from the picture: that's the agent's (re-time the lines).
    const lineUnder = e.audio.some((t) => t.dialogue && n(t.start, 0) < op.to && n(t.start, 0) + n(t.seconds, trackLength?.(t.asset) ?? 0) > op.from);
    if (lineUnder) throw new Error('A voice line plays there: speeding it up is a job for the agent (send it as a note)');
    const { e: x, ids } = isolate(e, op.from, op.to);
    const shots = shotsOf(x);
    const from = shots[ids[0]].start;
    const to = shots[ids.at(-1)!].end;
    const clips = x.clips.map((c, i) => (ids.includes(i) ? { ...c, speed: r3((c.speed ?? 1) * factor) } : c));
    const saved = (to - from) - (to - from) / factor;
    // What plays after the range moves up by what it saved.
    const shift = <T extends { start?: number; end?: number }>(items: T[], caption: boolean) => items.map((it) => (n(it.start, 0) >= to - 1e-3 ? { ...it, start: r3(n(it.start, 0) - saved), ...(caption ? { end: r3(n(it.end, 0) - saved) } : {}) } : it));
    return { edit: { ...x, clips, audio: shift(x.audio, false), captions: shift(x.captions, true) }, said: `${span} plays ${factor}x (${saved.toFixed(1)} s shorter)` };
  }
  const zoom = Math.min(3, Math.max(1.05, op.zoom));
  const { e: x, ids } = isolate(e, op.from, op.to);
  const clips = x.clips.map((c, i) => (ids.includes(i) ? { ...c, zoom: { from: op.push ? 1 : zoom, to: zoom, x: Math.min(1, Math.max(0, n(op.x, 0.5))), y: Math.min(1, Math.max(0, n(op.y, 0.5))) } } : c));
  return { edit: { ...x, clips }, said: `${op.push ? 'pushes in' : 'punches in'} ${zoom}x on ${span} (aimed at ${Math.round(n(op.x, 0.5) * 100)}%, ${Math.round(n(op.y, 0.5) * 100)}% of the frame)` };
}

/** video.compose's inputs and params for an edit (each distinct asset once). */
export function composeParams(e: Edit) {
  const clipAssets: string[] = [];
  const audioAssets: string[] = [];
  const idx = (list: string[], a: string) => { const i = list.indexOf(a); return i >= 0 ? i : list.push(a) - 1; };
  const clips = e.clips.map((c) => {
    const o: any = { clip: idx(clipAssets, c.asset) };
    for (const k of ['in', 'out', 'speed', 'zoom', 'transition', 'seconds', 'sound', 'volume', 'dialogue'] as const) if (c[k] !== undefined) o[k] = c[k];
    return o;
  });
  const audio = e.audio.map((t) => {
    const o: any = { audio: idx(audioAssets, t.asset) };
    for (const k of ['start', 'in', 'seconds', 'volume', 'fadeIn', 'fadeOut', 'loop', 'duck', 'duckTo', 'dialogue'] as const) if (t[k] !== undefined) o[k] = t[k];
    return o;
  });
  return {
    inputs: { clips: clipAssets.map((a) => `asset:${a}`), ...(audioAssets.length ? { audio: audioAssets.map((a) => `asset:${a}`) } : {}) },
    params: {
      width: e.width, height: e.height, fps: e.fps, fit: 'crop', captions: e.burn === false ? 'vtt' : 'both',
      timeline: { clips, audio, captions: e.captions, ...(e.fadeIn ? { fadeIn: e.fadeIn } : {}), ...(e.fadeOut ? { fadeOut: e.fadeOut } : {}) },
    },
  };
}
