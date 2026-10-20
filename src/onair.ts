// Going live (J, 2026-10-20): the Start / Stop switch for the Twitch stream and its quality, set from the Director bar on
// /broadcast.html. Studio only keeps the switch (settings key broadcast.live); the encoder (bin/broadcast-stream.mjs, the
// hawkes-broadcast service) runs all the time, idle, and follows it: on starts Xvfb, Chromium and ffmpeg, off stops them,
// a quality change restarts ffmpeg with the new settings. The encoder writes what it is doing to
// .data/broadcast/encoder.json every couple of seconds (state, fps, bitrate, dropped frames, why it can't start), which
// Studio reads back for the bar. No route takes the encoder's word: the file is the hawkes user's, which the agent
// sandbox can't write.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, StudioError } from './config.ts';
import { db, J, parse } from './db.ts';

/** Output size and frame rate. The page is always drawn at 1920×1080; smaller ones are scaled by ffmpeg. */
export const RESOLUTIONS = {
  '1080p60': { w: 1920, h: 1080, fps: 60 },
  '1080p30': { w: 1920, h: 1080, fps: 30 },
  '720p60': { w: 1280, h: 720, fps: 60 },
  '720p30': { w: 1280, h: 720, fps: 30 },
  '480p30': { w: 854, h: 480, fps: 30 },
} as const;
export type Resolution = keyof typeof RESOLUTIONS;
/** x264 speed: slower looks better at the same bitrate and costs more CPU (the control server has a few cores). */
export const X264 = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'] as const;
/** Twitch's ingest: it routes to the nearest server itself. */
export const INGEST = 'rtmp://live.twitch.tv/app';

export type Quality = {
  resolution: Resolution;
  /** Video bitrate, kbps. Twitch's limit for most channels is 6000. */
  videoKbps: number;
  x264: (typeof X264)[number];
  /** Seconds between keyframes. Twitch wants 2. */
  keyframeSec: number;
  audioKbps: 96 | 128 | 160 | 192;
  /** Twitch's bandwidth test: the stream reaches Twitch and shows in the inspector but not on the channel. */
  rehearsal: boolean;
};

export const QUALITY_DEFAULT: Quality = { resolution: '1080p30', videoKbps: 4500, x264: 'veryfast', keyframeSec: 2, audioKbps: 128, rehearsal: false };

export const PRESETS: Record<string, { label: string; quality: Partial<Quality> }> = {
  standard: { label: '1080p30, 4.5 Mbps (default)', quality: { resolution: '1080p30', videoKbps: 4500, x264: 'veryfast' } },
  smooth: { label: '720p60, 4.5 Mbps (motion)', quality: { resolution: '720p60', videoKbps: 4500, x264: 'veryfast' } },
  high: { label: '1080p60, 6 Mbps (needs CPU)', quality: { resolution: '1080p60', videoKbps: 6000, x264: 'superfast' } },
  light: { label: '720p30, 2.5 Mbps (light)', quality: { resolution: '720p30', videoKbps: 2500, x264: 'veryfast' } },
  minimal: { label: '480p30, 1.2 Mbps (minimal)', quality: { resolution: '480p30', videoKbps: 1200, x264: 'veryfast' } },
};

/** A stored or posted quality, every field checked; anything unknown keeps the current value. Throws on a bad value. */
export function patchQuality(cur: Quality, raw: any): Quality {
  const q: Quality = { ...cur };
  if (!raw || typeof raw !== 'object') return q;
  if (raw.preset !== undefined) {
    const p = PRESETS[String(raw.preset)];
    if (!p) throw new StudioError(`quality preset: ${Object.keys(PRESETS).join(', ')}`);
    Object.assign(q, p.quality);
  }
  if (raw.resolution !== undefined) {
    if (!(raw.resolution in RESOLUTIONS)) throw new StudioError(`resolution: ${Object.keys(RESOLUTIONS).join(', ')}`);
    q.resolution = raw.resolution;
  }
  if (raw.videoKbps !== undefined) {
    const n = Number(raw.videoKbps);
    if (!Number.isInteger(n) || n < 500 || n > 8000) throw new StudioError('videoKbps: 500 to 8000');
    q.videoKbps = n;
  }
  if (raw.x264 !== undefined) {
    if (!X264.includes(raw.x264)) throw new StudioError(`x264: ${X264.join(', ')}`);
    q.x264 = raw.x264;
  }
  if (raw.keyframeSec !== undefined) {
    const n = Number(raw.keyframeSec);
    if (![1, 2, 3, 4].includes(n)) throw new StudioError('keyframeSec: 1 to 4');
    q.keyframeSec = n;
  }
  if (raw.audioKbps !== undefined) {
    const n = Number(raw.audioKbps);
    if (![96, 128, 160, 192].includes(n)) throw new StudioError('audioKbps: 96, 128, 160 or 192');
    q.audioKbps = n as Quality['audioKbps'];
  }
  if (raw.rehearsal !== undefined) q.rehearsal = Boolean(raw.rehearsal);
  return q;
}

/** A stored quality, never throwing: a bad field falls back to the default. */
export function qualityFrom(raw: unknown): Quality {
  let q = { ...QUALITY_DEFAULT };
  if (!raw || typeof raw !== 'object') return q;
  for (const [k, v] of Object.entries(raw as any)) {
    if (k === 'preset') continue;
    try { q = patchQuality(q, { [k]: v }); } catch { /* keep the default */ }
  }
  return q;
}

/** What the encoder runs: ffmpeg's output settings, from a quality. Shared with bin/broadcast-stream.mjs through the frame. */
export function encodeOf(q: Quality) {
  const r = RESOLUTIONS[q.resolution];
  return {
    width: r.w, height: r.h, fps: r.fps, videoKbps: q.videoKbps, x264: q.x264, gop: r.fps * q.keyframeSec,
    audioKbps: q.audioKbps, ingest: INGEST, rehearsal: q.rehearsal,
  };
}

export type LiveSwitch = { on: boolean; since: number; by: string; quality: Quality };

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);
const LIVE_KEY = 'broadcast.live';

export function readLive(): LiveSwitch {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(LIVE_KEY) as { value: string } | undefined;
    const v = parse(r?.value) as any;
    return { on: v?.on === true, since: Number(v?.since) || 0, by: typeof v?.by === 'string' ? v.by.slice(0, 80) : '', quality: qualityFrom(v?.quality) };
  } catch {
    return { on: false, since: 0, by: '', quality: { ...QUALITY_DEFAULT } };
  }
}

function writeLive(v: LiveSwitch): LiveSwitch {
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(LIVE_KEY, J(v), Date.now(), v.by || 'desk');
  return v;
}

/** One change from the Director bar: { on }, { quality: {...} } (a preset or single fields), or both. */
export function updateLive(patch: any, by = 'dashboard'): LiveSwitch {
  const cur = readLive();
  const next: LiveSwitch = { ...cur, quality: patchQuality(cur.quality, patch?.quality) };
  if (patch?.on !== undefined) {
    const on = Boolean(patch.on);
    if (on !== cur.on) { next.on = on; next.since = Date.now(); next.by = by; }
  }
  return writeLive(next);
}

// ------------------------------------------------------------------ what the encoder says

export const ENCODER_FILE = path.join(DATA, 'broadcast', 'encoder.json');
/** The encoder writes every 2 s; older than this, it isn't running. */
const STALE_MS = 15_000;

export type EncoderState = 'off' | 'starting' | 'live' | 'waiting' | 'retrying' | 'down';
export type Encoder = {
  state: EncoderState;
  /** One line for the bar: why it's waiting, what failed. */
  note: string;
  since: number;
  at: number;
  fps: number | null;
  kbps: number | null;
  speed: number | null;
  dropped: number | null;
  /** The settings the running ffmpeg was started with (it restarts when they differ from the switch's). */
  running: string;
};

export function readEncoder(now = Date.now(), file = ENCODER_FILE): Encoder {
  const down: Encoder = { state: 'down', note: 'The encoder service (hawkes-broadcast) is not running on the server.', since: 0, at: 0, fps: null, kbps: null, speed: null, dropped: null, running: '' };
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return down; }
  const at = Number(raw?.at) || 0;
  if (now - at > STALE_MS) return { ...down, at };
  const states: EncoderState[] = ['off', 'starting', 'live', 'waiting', 'retrying'];
  const n = (x: unknown) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
  return {
    state: states.includes(raw.state) ? raw.state : 'down',
    note: String(raw.note ?? '').replace(/rtmps?:\/\/\S+/g, '[ingest]').slice(0, 240),
    since: Number(raw.since) || 0,
    at,
    fps: n(raw.fps), kbps: n(raw.kbps), speed: n(raw.speed), dropped: n(raw.dropped),
    running: String(raw.running ?? '').slice(0, 200),
  };
}

/** Same text as the encoder's `running`: the settings that matter to ffmpeg, so a change shows as pending. */
export const encodeKey = (e: ReturnType<typeof encodeOf>) => `${e.width}x${e.height}@${e.fps} ${e.videoKbps}k ${e.x264} g${e.gop} a${e.audioKbps}k${e.rehearsal ? ' rehearsal' : ''}`;

/** The On Air block of /api/broadcast: the switch, what ffmpeg should run, and what the encoder says it is doing. */
export function onAirNow() {
  const live = readLive();
  const encode = encodeOf(live.quality);
  const encoder = readEncoder();
  const key = encodeKey(encode);
  return {
    on: live.on, since: live.since, by: live.by, quality: live.quality, encode, key, encoder,
    /** A quality change the running stream hasn't picked up yet (it restarts within a few seconds). */
    pending: live.on && encoder.state === 'live' && encoder.running !== key,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p.label])),
  };
}
