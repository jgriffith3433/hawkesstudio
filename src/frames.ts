// A playtest's screenshots as frames, for the choppy-video player in an expanded Activity run card (dashboard/activity.js
// FramePlayer). Live from Hawkes Gen's `GET /v1/jobs/<id>/shots[?since=<i>]` (JPEGs from `/v1/jobs/<id>/shots/<i>`,
// proxied by `GET /api/frames/<step>/<i>`: Gen's job routes need Studio's key) while the job runs and after; a Gen
// without those routes yet gives the finished job's filed screenshot assets instead (nothing while it runs).

import { db } from './db.ts';
import { gen } from './gen.ts';

export type Frame = { i: number; t: number | null; reason: string | null; scene: string | null; peer: string | null; caption: string | null; src?: string; asset?: string };
export type Frames = { live: boolean; running: boolean; progress: string | null; frames: Frame[] };

const stepRow = (id: string) => db.prepare(`SELECT id, job, status FROM steps WHERE id = ? AND kind = 'playtest'`).get(id) as { id: string; job: string | null; status: string } | undefined;

/** The bot's progress line, whatever shape Gen sends it in. */
const line = (p: any): string | null => (typeof p === 'string' ? p : p && typeof p === 'object' ? (p.text ?? p.step ?? p.message ?? p.label ?? null) : null);
const str = (v: any) => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Gen's shots list as frames (pure, tested). */
export function liveFrames(step: string, r: any): Frames {
  const shots = Array.isArray(r?.shots) ? r.shots : [];
  return {
    live: true, running: Boolean(r?.running), progress: line(r?.progress ?? r?.step ?? r?.caption),
    frames: shots.filter((s: any) => Number.isInteger(s?.i)).map((s: any) => ({
      i: s.i, t: num(s.t), reason: str(s.reason), scene: str(s.scene), peer: str(s.peer), caption: line(s.progress ?? s.caption ?? s.step),
      src: `/api/frames/${step}/${s.i}`,
    })),
  };
}

/** A finished job's filed screenshots (its result's shots, else the library's `playtest: shot` assets), in order (pure, tested). */
export function filedFrames(result: any, assets: any[]): Frame[] {
  let shots: any[] = (result?.shots ?? []).filter((x: any) => x?.asset);
  if (!shots.length) shots = assets.filter((a: any) => a?.meta?.playtest === 'shot').map((a: any) => ({ ...a.meta, asset: a.id })).sort((a: any, b: any) => (a.t ?? 0) - (b.t ?? 0));
  return shots.map((s: any, i: number) => ({ i, t: num(s.t), reason: str(s.reason), scene: str(s.scene), peer: str(s.peer), caption: line(s.progress ?? s.caption), asset: s.asset }));
}

// Finished playtests' frames don't change: kept for a while so a card left open doesn't ask Gen again.
const done = new Map<string, Frames>();
const keep = (step: string, f: Frames) => {
  done.set(step, f);
  if (done.size > 60) done.delete(done.keys().next().value!);
  return f;
};

export async function stepFrames(step: string, since?: number): Promise<Frames | null> {
  const s = stepRow(step);
  if (!s) return null;
  const running = s.status === 'running';
  if (!s.job) return { live: false, running, progress: null, frames: [] };
  const cached = done.get(step);
  if (cached) return since !== undefined ? { ...cached, frames: cached.frames.filter((f) => f.i > since) } : cached;
  try {
    const r = await gen.request(`/jobs/${encodeURIComponent(s.job)}/shots${since !== undefined ? `?since=${since}` : ''}`);
    const f = liveFrames(step, r);
    // Gen's own word on whether the job still runs; the step can outlive it by a moment (its review is another step).
    return !f.running && since === undefined && f.frames.length ? keep(step, f) : f;
  } catch (e: any) {
    // Anything but "no such route or job" (Gen down, a 500) is said, not hidden behind an empty player.
    if (e?.status !== 404) throw e;
  }
  // A Gen without the live route: the screenshots are filed when the job ends.
  if (running) return { live: false, running, progress: null, frames: [] };
  const job = await gen.job(s.job).catch(() => null);
  if (job && !['done', 'failed', 'cancelled'].includes(job.status)) return { live: false, running: true, progress: null, frames: [] };
  const result = job?.result ?? {};
  const assets = (result.shots ?? []).some((x: any) => x?.asset) ? [] : ((await gen.assets({ job: s.job, limit: 500 }).catch(() => ({ items: [] }))).items ?? []);
  const frames = filedFrames(result, assets);
  const f: Frames = { live: false, running: false, progress: null, frames };
  return frames.length ? keep(step, f) : f;
}

/** One live frame's JPEG from Gen (`GET /api/frames/<step>/<i>`), or null when there is none. */
export async function frameImage(step: string, i: number): Promise<{ type: string; body: Buffer } | null> {
  const s = stepRow(step);
  if (!s?.job) return null;
  try {
    const r = await gen.request(`/jobs/${encodeURIComponent(s.job)}/shots/${i}`, { raw: true });
    return { type: r.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}
