// The playtest audio layer, Studio's side (docs/playtest.md#audio). The page probe (clients/web/hawkes-audio.js)
// pushes sound-start and input events (and AudioContext resume on first tap). Studio turns the timeline into
// audio.* metrics, runs ffmpeg ebur128 on the recording for loudness, files one finding per broken sound-design
// limit with its time, and hands a short timeline summary to reviews and the critic (they can't hear the tape).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AudioEvent = {
  type: string; t: number; sample?: string; bus?: string; rate?: number; gain?: number;
  action?: string; how?: string; scene?: string; silent?: boolean; id?: string; dur?: number;
};
export type AudioFinding = { title: string; severity: string; area: string; detail: string; fix: string; shots: string[]; replay: null };
export type Loudness = { lufsIntegrated: number | null; truePeakDb: number | null; raw?: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Same idea as quality.ts LOADING_SCENE: menus and loading don't count toward silence-in-play. */
const MENU = /\b(load(ing)?|title|main menu|menu|splash|intro|boot|lobby|start screen|press start)\b/i;

/** Events the page probe (or Gen) put on the run: `audio` pushes and plain sound-start / input / resume rows. */
export function audioEventsOf(result: any): AudioEvent[] {
  const out: AudioEvent[] = [];
  const seen = new Set<string>();
  const push = (e: any) => {
    if (!e || typeof e !== 'object') return;
    const type = String(e.type ?? '');
    if (!['sound-start', 'input', 'audiocontext-resume', 'bus-gain'].includes(type)) return;
    const t = Number(e.t);
    const row: AudioEvent = {
      type, t: Number.isFinite(t) ? t : 0,
      sample: e.sample != null ? String(e.sample).slice(0, 120) : undefined,
      bus: e.bus != null ? String(e.bus).slice(0, 40) : undefined,
      rate: Number.isFinite(Number(e.rate)) ? Number(e.rate) : undefined,
      gain: Number.isFinite(Number(e.gain)) ? Number(e.gain) : undefined,
      action: e.action != null ? String(e.action).slice(0, 80) : undefined,
      how: e.how != null ? String(e.how).slice(0, 40) : undefined,
      scene: e.scene != null ? String(e.scene).slice(0, 80) : undefined,
      silent: Boolean(e.silent),
      id: e.id != null ? String(e.id) : undefined,
      dur: Number.isFinite(Number(e.dur)) && Number(e.dur) > 0 ? Number(e.dur) : undefined,
    };
    const key = row.id || `${row.type}|${row.t}|${row.sample ?? ''}|${row.action ?? ''}|${row.how ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };
  const fromDetail = (e: any) => {
    if (e?.detail == null) return null;
    try {
      const d = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail;
      if (d && typeof d === 'object') return { ...d, type: d.type || e.type, t: d.t ?? e.t };
    } catch { /* ignore */ }
    return null;
  };
  for (const e of Array.isArray(result?.events) ? result.events : []) {
    if (e?.type === 'audio') { push(fromDetail(e) ?? e); continue; }
    if (e?.type === 'sound-start' || e?.type === 'input' || e?.type === 'audiocontext-resume' || e?.type === 'bus-gain') {
      push(fromDetail(e) ?? e);
    }
  }
  if (Array.isArray(result?.audio)) for (const e of result.audio) push(e);
  out.sort((a, b) => a.t - b.t);
  return out;
}

const inPlay = (scene?: string) => !(scene && MENU.test(scene));

/**
 * Metrics from the event timeline (menus and loading excluded for silence). Loudness metrics are filled later by
 * measureLoudness when a recording is available.
 */
export function audioMetricsFromEvents(events: AudioEvent[], opts: { silentMs?: number; identicalWindowS?: number; endS?: number } = {}) {
  const silentMs = opts.silentMs ?? 150;
  const win = opts.identicalWindowS ?? 60;
  const sounds = events.filter((e) => e.type === 'sound-start');
  const inputs = events.filter((e) => e.type === 'input');
  const resumes = events.filter((e) => e.type === 'audiocontext-resume');
  let longest = 0;
  let lastSound: number | null = null;
  for (const s of sounds) {
    if (!inPlay(s.scene)) continue;
    if (lastSound != null) longest = Math.max(longest, s.t - lastSound);
    lastSound = s.t;
  }
  const end = opts.endS ?? (events.length ? events[events.length - 1].t : 0);
  if (lastSound != null) longest = Math.max(longest, end - lastSound);

  let silentActions = 0;
  const silentList: { action: string; t: number }[] = [];
  for (const inp of inputs) {
    if (inp.silent) {
      silentActions++;
      silentList.push({ action: inp.action ?? 'input', t: inp.t });
      continue;
    }
    const heard = sounds.some((s) => s.t >= inp.t - 0.001 && s.t <= inp.t + silentMs / 1000);
    if (!heard) {
      silentActions++;
      silentList.push({ action: inp.action ?? 'input', t: inp.t });
    }
  }

  let identical = 0;
  const identicalList: { sample: string; t: number; prev: number }[] = [];
  for (let i = 0; i < sounds.length; i++) {
    const s = sounds[i];
    for (let j = i - 1; j >= 0; j--) {
      const p = sounds[j];
      if (s.t - p.t > win) break;
      if (p.sample === s.sample && Math.abs((p.rate ?? 1) - (s.rate ?? 1)) < 0.001) {
        identical++;
        identicalList.push({ sample: String(s.sample ?? 'unknown'), t: s.t, prev: p.t });
        break;
      }
    }
  }

  let voiceDuckDb = 0;
  let hadVoice = false;
  let musicGain = 1;
  const voiceUntil: number[] = [];
  // Sounds and the kit's bus-gain changes (hawkes-sound.js / HawkesSound: music's gain moves while a clip plays), in time order.
  for (const s of events.filter((e) => e.type === 'sound-start' || e.type === 'bus-gain')) {
    const bus = String(s.bus ?? 'sfx').toLowerCase();
    const g = s.gain ?? 1;
    if (s.type === 'bus-gain') {
      if (bus !== 'music') continue;
      musicGain = g;
      if (voiceUntil.some((u) => s.t <= u) && g > 0 && g < 1) voiceDuckDb = Math.max(voiceDuckDb, -20 * Math.log10(Math.max(1e-6, g)));
      continue;
    }
    if (bus === 'music') musicGain = g;
    if (bus === 'voice') {
      hadVoice = true;
      voiceUntil.push(s.t + (s.dur && s.dur > 0 ? s.dur : 2));
      if (musicGain > 0 && musicGain < 1) voiceDuckDb = Math.max(voiceDuckDb, -20 * Math.log10(Math.max(1e-6, musicGain)));
    } else if (bus === 'music' && voiceUntil.some((u) => s.t <= u) && g > 0 && g < 1) {
      voiceDuckDb = Math.max(voiceDuckDb, -20 * Math.log10(Math.max(1e-6, g)));
    }
    while (voiceUntil.length && voiceUntil[0] < s.t) voiceUntil.shift();
  }

  const metrics: Record<string, number> = {
    'audio.longestSilenceS': r2(longest),
    'audio.silentActions': silentActions,
    'audio.identicalRepeats60s': identical,
    'audio.sounds': sounds.length,
    'audio.inputs': inputs.length,
    'audio.resumes': resumes.length,
  };
  // Only when voice played: otherwise an optional min:6 check would fail every quiet run.
  if (hadVoice) metrics['audio.voiceDuckDb'] = r2(voiceDuckDb);

  return { metrics, silentList, identicalList, resumes, hadVoice };
}

/** Parse ffmpeg ebur128 stderr (or stdout) into integrated LUFS and true peak (dBTP). */
export function parseEbur128(log: string): Loudness {
  // I:         -18.3 LUFS  /  I: -18.3 LUFS
  const i = /I:\s*([-\d.]+)\s*LUFS/i.exec(log);
  // Peak:      -1.2 dBFS  /  True peak:  -0.8 dBTP  /  Peak: -1.2 dBTP
  const p = /(?:True\s*)?Peak:\s*([-\d.]+)\s*dB(?:TP|FS)?/i.exec(log)
    || /TP\+?:?\s*([-\d.]+)\s*dB/i.exec(log);
  return {
    lufsIntegrated: i ? Number(i[1]) : null,
    truePeakDb: p ? Number(p[1]) : null,
    raw: log.slice(-2000),
  };
}

/**
 * Run ffmpeg ebur128 on a media file (the playtest recording). Returns nulls when ffmpeg is missing or the file has
 * no audio. Pure enough for tests via parseEbur128; this is the shell side.
 */
export function measureLoudness(file: string, opts: { ffmpeg?: string; timeoutMs?: number } = {}): Loudness {
  if (!file || !fs.existsSync(file)) return { lufsIntegrated: null, truePeakDb: null };
  const bin = opts.ffmpeg || process.env.FFMPEG || 'ffmpeg';
  const r = spawnSync(bin, ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], {
    encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  const log = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
  return parseEbur128(log);
}

/**
 * Merge audio metrics into a playtest result: event timeline always, loudness when `file` (or a downloaded video) is
 * given. Never throws; missing audio leaves loudness null so the gate lists them as unmeasured.
 */
export function enrichAudio(result: any, opts: { file?: string | null; ffmpeg?: string } = {}) {
  if (!result || typeof result !== 'object') return result;
  const events = audioEventsOf(result);
  const fromEv = audioMetricsFromEvents(events, { endS: Number(result.seconds) || undefined });
  const metrics = { ...(result.metrics ?? {}), ...fromEv.metrics };
  if (opts.file) {
    const loud = measureLoudness(opts.file, { ffmpeg: opts.ffmpeg });
    if (loud.lufsIntegrated != null) metrics['audio.lufsIntegrated'] = r2(loud.lufsIntegrated);
    if (loud.truePeakDb != null) metrics['audio.truePeakDb'] = r2(loud.truePeakDb);
  }
  // Ensure the four report keys exist when the probe ran (events or audio-sensor), so acceptance criterion 1 holds.
  const probeOn = events.length > 0 || (Array.isArray(result.events) && result.events.some((e: any) => e?.type === 'audio-sensor' || e?.type === 'audio'));
  if (probeOn || metrics['audio.sounds'] != null || metrics['audio.inputs'] != null) {
    for (const k of ['audio.lufsIntegrated', 'audio.truePeakDb', 'audio.longestSilenceS', 'audio.silentActions'] as const) {
      if (metrics[k] === undefined) metrics[k] = k.startsWith('audio.lufs') || k === 'audio.truePeakDb' ? null : 0;
    }
  }
  return {
    ...result,
    metrics,
    audio: events,
    _audioSilent: fromEv.silentList,
    _audioIdentical: fromEv.identicalList,
    _audioResumes: fromEv.resumes,
  };
}

const FIX_SILENT = 'Play a one-shot SFX on that action within the same frame (or under 150 ms): jump, attack, confirm, cancel, UI click. Celeste/Hades: every input has a sound.';
const FIX_IDENTICAL = 'Use a small sample pool and pick a different take (or pitch) each time so the same buffer+rate never plays twice within 60 s.';
const FIX_LUFS = 'Mix to about -18 LUFS integrated (±3) with true peak at most -1 dBTP (PlayStation mobile target). Lower the master or limit peaks.';
const FIX_DUCK = 'When voice plays, duck the music bus by at least 6 dB and restore it after.';
const FIX_SILENCE = 'Fill quiet gaps in play with ambient bed, footsteps or reactive SFX so silence in play stays under 10 s (menus and loading excluded).';

/**
 * One finding per broken sound-design limit, with the time (and action/sample) so the fix agent knows where.
 */
export function audioFindings(result: any, { scenario }: { scenario: string }): AudioFinding[] {
  const enriched = result?._audioSilent ? result : enrichAudio(result);
  const m = enriched.metrics ?? {};
  const out: AudioFinding[] = [];
  const silent = (enriched._audioSilent ?? []) as { action: string; t: number }[];
  const identical = (enriched._audioIdentical ?? []) as { sample: string; t: number; prev: number }[];

  if (Number(m['audio.silentActions']) > 0) {
    for (const s of silent.slice(0, 8)) {
      out.push({
        title: `Silent action: ${s.action} at ${r2(s.t)} s`,
        severity: 'bug', area: 'audio',
        detail: `In ${scenario}, input "${s.action}" at ${r2(s.t)} s had no sound start within 150 ms (audio.silentActions = ${m['audio.silentActions']}).`,
        fix: FIX_SILENT, shots: [], replay: null,
      });
    }
  }
  if (Number(m['audio.identicalRepeats60s']) > 0) {
    for (const x of identical.slice(0, 8)) {
      out.push({
        title: `Identical repeat: ${x.sample} at ${r2(x.t)} s`,
        severity: 'bug', area: 'audio',
        detail: `In ${scenario}, sample "${x.sample}" played again at ${r2(x.t)} s (same rate as at ${r2(x.prev)} s), inside 60 s (audio.identicalRepeats60s = ${m['audio.identicalRepeats60s']}).`,
        fix: FIX_IDENTICAL, shots: [], replay: null,
      });
    }
  }
  const lufs = m['audio.lufsIntegrated'];
  if (lufs != null && Number.isFinite(Number(lufs)) && (Number(lufs) < -21 || Number(lufs) > -15)) {
    out.push({
      title: `Loudness off target: ${lufs} LUFS`,
      severity: 'bug', area: 'audio',
      detail: `In ${scenario}, integrated loudness was ${lufs} LUFS (target -18 ±3).`,
      fix: FIX_LUFS, shots: [], replay: null,
    });
  }
  const peak = m['audio.truePeakDb'];
  if (peak != null && Number.isFinite(Number(peak)) && Number(peak) > -1) {
    out.push({
      title: `True peak too high: ${peak} dBTP`,
      severity: 'bug', area: 'audio',
      detail: `In ${scenario}, true peak was ${peak} dBTP (limit -1 dBTP).`,
      fix: FIX_LUFS, shots: [], replay: null,
    });
  }
  if (Number(m['audio.longestSilenceS']) > 10) {
    out.push({
      title: `Silence in play: ${m['audio.longestSilenceS']} s`,
      severity: 'bug', area: 'audio',
      detail: `In ${scenario}, the longest gap between sounds in play was ${m['audio.longestSilenceS']} s (limit 10; menus/loading excluded).`,
      fix: FIX_SILENCE, shots: [], replay: null,
    });
  }
  // Ducking only fails when voice was heard but music didn't duck enough.
  const hadVoice = (enriched.audio ?? audioEventsOf(enriched)).some((e: AudioEvent) => e.type === 'sound-start' && String(e.bus).toLowerCase() === 'voice');
  if (hadVoice && Number(m['audio.voiceDuckDb']) < 6) {
    out.push({
      title: `Voice ducking only ${m['audio.voiceDuckDb']} dB`,
      severity: 'bug', area: 'audio',
      detail: `In ${scenario}, voice played but music ducking measured ${m['audio.voiceDuckDb']} dB (need at least 6).`,
      fix: FIX_DUCK, shots: [], replay: null,
    });
  }
  return out;
}

/** A short timeline summary for reviewParams and the critic (judges that can't hear the tape). */
export function audioTimelineSummary(result: any, max = 24): string {
  const enriched = result?.audio ? result : enrichAudio(result);
  const m = enriched.metrics ?? {};
  const events = (enriched.audio ?? audioEventsOf(enriched)) as AudioEvent[];
  const lines = events.filter((e) => e.type === 'sound-start' || e.type === 'input' || e.type === 'audiocontext-resume').slice(0, max).map((e) => {
    if (e.type === 'sound-start') return `${r2(e.t)}s sound ${e.sample ?? '?'} bus=${e.bus ?? 'sfx'} rate=${e.rate ?? 1}`;
    if (e.type === 'input') return `${r2(e.t)}s input ${e.action ?? 'input'}${e.silent ? ' (silent)' : ''}`;
    return `${r2(e.t)}s AudioContext resume (${e.how ?? 'gesture'})`;
  });
  const head = [
    `audio.lufsIntegrated=${m['audio.lufsIntegrated'] ?? 'n/a'}`,
    `audio.truePeakDb=${m['audio.truePeakDb'] ?? 'n/a'}`,
    `audio.longestSilenceS=${m['audio.longestSilenceS'] ?? 'n/a'}`,
    `audio.silentActions=${m['audio.silentActions'] ?? 'n/a'}`,
    `audio.identicalRepeats60s=${m['audio.identicalRepeats60s'] ?? 'n/a'}`,
    `audio.voiceDuckDb=${m['audio.voiceDuckDb'] ?? 'n/a'}`,
  ].join(', ');
  return lines.length ? `${head}\n${lines.join('\n')}` : head;
}

/** One line for a playtest step detail. */
export function audioLine(result: any): string {
  const m = result?.metrics ?? {};
  if (m['audio.silentActions'] == null && m['audio.lufsIntegrated'] == null && m['audio.sounds'] == null) return '';
  const bits = [
    m['audio.lufsIntegrated'] != null ? `${m['audio.lufsIntegrated']} LUFS` : null,
    m['audio.silentActions'] != null ? `${m['audio.silentActions']} silent` : null,
    m['audio.identicalRepeats60s'] != null ? `${m['audio.identicalRepeats60s']} repeats` : null,
  ].filter(Boolean);
  return bits.length ? `audio: ${bits.join(', ')}` : '';
}

/**
 * Download a Gen video asset to a temp file, measure loudness, delete the file. Returns loudness metrics only.
 * `download(asset, file)` is injected so tests need no Gen.
 */
export async function loudnessFromAsset(
  asset: string | null | undefined,
  download: (asset: string, file: string) => Promise<void>,
  opts: { ffmpeg?: string } = {},
): Promise<Pick<Loudness, 'lufsIntegrated' | 'truePeakDb'>> {
  if (!asset || typeof download !== 'function') return { lufsIntegrated: null, truePeakDb: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-audio-'));
  const file = path.join(dir, 'play.webm');
  try {
    await download(asset, file);
    const loud = measureLoudness(file, { ffmpeg: opts.ffmpeg });
    return { lufsIntegrated: loud.lufsIntegrated, truePeakDb: loud.truePeakDb };
  } catch {
    return { lufsIntegrated: null, truePeakDb: null };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
