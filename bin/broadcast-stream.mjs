// Sends Studio's broadcast page to Twitch from the studio server (the control server). Studio already
// receives the playtest video; this process only renders that page and pushes it. It is its own service
// (hawkes-broadcast), not Studio's Node process.
//
//   node bin/broadcast-stream.mjs            what is missing
//   node bin/broadcast-stream.mjs --go       run: idle until the Director bar's Go live, then stream until Stop
//
// With --go it runs all the time and follows the switch Studio keeps (src/onair.ts, through /api/broadcast `onAir`):
// on starts Xvfb, Chromium and ffmpeg with the quality set there; off stops them (idle it is one small Node process);
// a quality change restarts ffmpeg alone. If something dies while live it tries again (10 s, doubling to 2 min).
// Every 2 s it writes what it is doing to .data/broadcast/encoder.json (state, fps, bitrate, dropped frames, why it
// can't start), which the Director bar shows. The stream key never goes in that file or the journal.
//
// The key lives in Secrets Manager as hawkes/twitch (deploy/twitch-key.mjs). hawkes-secrets writes it to
// /run/hawkes/twitch.env. It is not a Gen key and it is not stored on a laptop.
//
// Audio: this machine has no sound card. The encoder follows the show (src/show.ts, through /api/broadcast): each of
// Yooba's lines and the showcase's song are decoded to PCM, mixed here (the song ducked under his voice) and fed to
// ffmpeg through a FIFO (silence when nothing plays). No PulseAudio or ALSA hardware needed.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROADCAST_CHROMIUM } from '../deploy/broadcast-unit.mjs';

const PAGE = process.env.BROADCAST_URL || 'http://127.0.0.1:8791/broadcast.html?product=yoobaland&clean=1';
const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:8791';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.STUDIO_DATA ? path.resolve(process.env.STUDIO_DATA) : path.join(ROOT, '.data');
const STATUS = path.join(DATA, 'broadcast', 'encoder.json');
const RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SEC = RATE * CHANNELS * 2;
const CHUNK_MS = 100;
const CHUNK = Math.floor(BYTES_PER_SEC * CHUNK_MS / 1000);
/** The page is drawn at this size; smaller outputs are scaled by ffmpeg. */
const SCREEN = { w: 1920, h: 1080 };
const DEFAULT_ENCODE = { width: 1920, height: 1080, fps: 30, videoKbps: 4500, x264: 'veryfast', gop: 60, audioKbps: 128, ingest: 'rtmp://live.twitch.tv/app', rehearsal: false };

/** The key, read fresh on every start (the file first: hawkes-secrets may have rotated it since the service began). */
function streamKey() {
  try {
    const m = /^\s*TWITCH_STREAM_KEY\s*=\s*(.*?)\s*$/m.exec(readFileSync('/run/hawkes/twitch.env', 'utf8'));
    const k = m?.[1].replace(/^['"]|['"]$/g, '') || '';
    if (k) return k;
  } catch { /* not on the server */ }
  return process.env.TWITCH_STREAM_KEY || '';
}
const GO = process.argv.includes('--go');

function which(names, fullPaths = []) {
  for (const full of fullPaths) if (full && existsSync(full)) return full;
  const pathEnv = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(sep)) {
    for (const name of names) {
      for (const ext of exts) {
        const full = `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : (process.platform === 'win32' ? '\\' : '/')}${name}${ext}`;
        if (existsSync(full)) return full;
      }
    }
  }
  return '';
}

const ffmpeg = which(['ffmpeg']);
const chromium = which(
  ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'msedge'],
  process.platform === 'win32' ? [
    `${process.env.PROGRAMFILES || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.PROGRAMFILES || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ] : BROADCAST_CHROMIUM,
);

/** What stops a stream from starting right now. */
function missing() {
  const out = [];
  if (!ffmpeg) out.push('ffmpeg (the encoder)');
  if (!chromium) out.push('Chromium or Chrome (the page)');
  if (!streamKey()) out.push('TWITCH_STREAM_KEY (Secrets Manager hawkes/twitch, via node deploy/twitch-key.mjs)');
  if (process.platform === 'linux' && !which(['Xvfb'])) out.push('Xvfb (a virtual screen, so encoding does not need a monitor)');
  // Everything but the key is installed by deploy/broadcast-unit.mjs, which every deploy runs.
  if (process.platform === 'linux' && (!ffmpeg || !chromium || !which(['Xvfb']))) out.push('(on the server: sudo node deploy/broadcast-unit.mjs)');
  return out;
}

if (!GO) {
  const key = streamKey();
  console.log(`page: ${PAGE}`);
  console.log(`ingest: ${DEFAULT_ENCODE.ingest}/${key ? `${key.slice(0, 4)}…` : '<stream key>'}`);
  const m = missing();
  if (m.length) {
    console.log('waiting on:');
    for (const x of m) console.log(`  - ${x}`);
    console.log('Nothing is being encoded. Studio keeps serving the page either way.');
  } else {
    console.log('Ready on the studio server. The hawkes-broadcast service runs this with --go and streams while the Director bar says Go live. Encoding is this process, about two CPU cores at 1080p30, separate from Studio. Host voice is mixed from Studio\'s cached mp3 (no sound card).');
  }
  process.exit(0);
}

/** Never let the key reach the journal or the status file. */
const redact = (s) => String(s ?? '').replace(/rtmps?:\/\/\S+/g, '[ingest]').replace(/live_[A-Za-z0-9_]+/g, '[key]');

// ------------------------------------------------------------------ status, read back by Studio (src/onair.ts)

const status = { state: 'off', note: '', since: Date.now(), fps: null, kbps: null, speed: null, dropped: null, running: '' };
function setState(state, note = '') {
  if (status.state !== state) status.since = Date.now();
  status.state = state;
  status.note = redact(note).slice(0, 240);
  if (state !== 'live' && state !== 'starting') Object.assign(status, { fps: null, kbps: null, speed: null, dropped: null, running: '' });
  writeStatus();
}
function writeStatus() {
  try {
    mkdirSync(path.dirname(STATUS), { recursive: true });
    const tmp = `${STATUS}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...status, at: Date.now(), pid: process.pid }));
    renameSync(tmp, STATUS);
  } catch { /* Studio shows "down" until the next write */ }
}

// ------------------------------------------------------------------ audio: Yooba and the song, through a FIFO

const silence = Buffer.alloc(CHUNK);
let voiceQueue = []; // s16le chunks of Yooba's current line
let lastLineId = '';
let music = null; // { id, pcm: Buffer, pos: byte offset } — the showcase song, if one is on
let lastMusicId = '';

/** Decodes an audio URL from Studio into one s16le stereo buffer. */
function decode(url) {
  return new Promise((resolve) => {
    const abs = url.startsWith('http') ? url : `${STUDIO}${url}`;
    const dec = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', abs, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', String(CHANNELS), '-ar', String(RATE), 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    dec.stdout.on('data', (c) => chunks.push(c));
    dec.on('close', () => resolve(Buffer.concat(chunks)));
    dec.on('error', () => resolve(Buffer.alloc(0)));
  });
}

const toChunks = (buf) => {
  const out = [];
  for (let i = 0; i < buf.length; i += CHUNK) {
    const pad = Buffer.alloc(CHUNK);
    buf.copy(pad, 0, i, Math.min(i + CHUNK, buf.length));
    out.push(pad);
  }
  return out;
};

/**
 * Follows the show (src/show.ts through /api/broadcast): a new line of Yooba's replaces whatever he was saying, and a
 * song starts at the point the show is at (so a restart joins in the middle, like the page does).
 */
async function followAudio(d) {
  const show = d?.show || {};
  const line = show.line;
  if (line?.id && line.id !== lastLineId) {
    lastLineId = line.id;
    if (line.voice && line.speaking && d?.desk?.voice !== false) {
      const id = line.id;
      const pcm = await decode(line.voice);
      if (lastLineId === id) voiceQueue = toChunks(pcm);
    } else voiceQueue = [];
  }
  const m = show.music;
  if ((m?.id || '') !== lastMusicId) {
    lastMusicId = m?.id || '';
    if (!m) music = null;
    else {
      const pcm = await decode(m.src);
      if (lastMusicId !== m.id || !pcm.length) return;
      const at = Math.max(0, Date.now() - Number(m.started || Date.now()));
      const pos = Math.floor((at / 1000) * RATE) * CHANNELS * 2;
      music = { id: m.id, pcm, pos: pos < pcm.length ? pos : 0 };
    }
  }
}

/** One 100 ms chunk: Yooba over the song, the song ducked while he talks. */
function nextChunk() {
  const v = voiceQueue.shift() || null;
  if (!music) return v || silence;
  const m = Buffer.alloc(CHUNK);
  if (music.pos < music.pcm.length) {
    music.pcm.copy(m, 0, music.pos, Math.min(music.pos + CHUNK, music.pcm.length));
    music.pos += CHUNK;
  }
  const gain = v ? 0.22 : 0.75;
  const out = Buffer.alloc(CHUNK);
  for (let i = 0; i < CHUNK; i += 2) {
    const x = (v ? v.readInt16LE(i) : 0) + m.readInt16LE(i) * gain;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x))), i);
  }
  return out;
}

const FIFO = path.join(tmpdir(), 'hawkes-broadcast-voice.pcm');
let feeder = null; // { gen, out }
let feederGen = 0;

/** A fresh FIFO and its writer, for one ffmpeg. Resolves once the FIFO exists. */
function startFeeder() {
  stopFeeder();
  const gen = ++feederGen;
  try { unlinkSync(FIFO); } catch { /* ok */ }
  return new Promise((resolve) => {
    const mk = spawn('mkfifo', [FIFO], { stdio: 'ignore' });
    mk.on('error', () => resolve(false));
    mk.on('close', (code) => {
      resolve(code === 0);
      if (gen !== feederGen || code !== 0) return;
      const out = createWriteStream(FIFO);
      feeder = { gen, out };
      // Paced by the wall clock, not by chained timers. ffmpeg times the whole stream by these samples: a feed that
      // runs slow (setTimeout drifts ~2%) puts the x11grab frames minutes ahead of the audio, ffmpeg pulls fewer and
      // fewer of them (4 fps after an hour), and Twitch shows black under the voice.
      let t0 = 0;
      let sent = 0;
      const pump = () => {
        if (out.destroyed || gen !== feederGen) return;
        if (!t0) t0 = Date.now();
        const due = Math.floor((Date.now() - t0) / CHUNK_MS) + 1;
        while (sent < due) {
          sent++;
          if (!out.write(nextChunk())) { out.once('drain', pump); return; }
        }
        setTimeout(pump, CHUNK_MS / 2);
      };
      out.on('open', pump);
      out.on('error', () => { /* ffmpeg closed its end: the supervisor restarts both */ });
    });
  });
}
function stopFeeder() {
  feederGen++;
  if (feeder) { try { feeder.out.destroy(); } catch { /* gone */ } }
  feeder = null;
}

// ------------------------------------------------------------------ the pipeline

let screen = null; // { xvfb, browser } on Linux
let enc = null; // { proc, key, last }
let starting = false;
let wanted = null; // the encode ffmpeg should run, or null for off
let retryAt = 0;
let backoff = 10_000;
let liveSince = 0;

const kill = (p) => { try { p?.kill('SIGTERM'); } catch { /* already gone */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same text as Studio's encodeKey (src/onair.ts), so the bar can tell a pending quality change. */
const keyOf = (e) => `${e.width}x${e.height}@${e.fps} ${e.videoKbps}k ${e.x264} g${e.gop} a${e.audioKbps}k${e.rehearsal ? ' rehearsal' : ''}`;

function failed(why) {
  stopAll();
  if (!wanted) return setState('off');
  retryAt = Date.now() + backoff;
  console.error(redact(why));
  setState('retrying', `${why}. Trying again in ${Math.round(backoff / 1000)} s.`);
  backoff = Math.min(120_000, backoff * 2);
}

/** Xvfb and Chromium on the page. True when they were just started (the page needs a moment to paint). */
function startScreen() {
  if (process.platform !== 'linux' || screen) return false;
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', `${SCREEN.w}x${SCREEN.h}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
  const browser = spawn(chromium, [
    '--no-sandbox', '--test-type', '--no-first-run', '--disable-fre', '--no-default-browser-check',
    '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${SCREEN.w},${SCREEN.h}`, '--app=' + PAGE,
  ], { env: { ...process.env, DISPLAY: ':99' }, stdio: 'ignore' });
  const s = { xvfb, browser };
  screen = s;
  // If Chromium dies (OOM, snap crash), ffmpeg keeps pushing a black X11 screen: stop and try again.
  browser.on('exit', (code, signal) => { if (screen === s) failed(`Chromium left (code ${code}, signal ${signal})`); });
  xvfb.on('exit', (code) => { if (screen === s) failed(`Xvfb left (code ${code})`); });
  return true;
}

async function startEncoder(e) {
  const key = streamKey();
  if (!key) return failed('No stream key');
  const target = `${e.ingest}/${key}${e.rehearsal ? '?bandwidthtest=true' : ''}`;
  const scale = e.width !== SCREEN.w || e.height !== SCREEN.h ? ['-vf', `scale=${e.width}:${e.height}:flags=bicubic`] : [];
  const video = [
    '-c:v', 'libx264', '-preset', e.x264, '-b:v', `${e.videoKbps}k`, '-maxrate', `${e.videoKbps}k`, '-bufsize', `${e.videoKbps * 2}k`,
    // Twitch wants a keyframe every 2 s and a steady bitrate; x264's default is one per 250 frames.
    '-g', String(e.gop), '-keyint_min', String(e.gop), '-sc_threshold', '0', '-pix_fmt', 'yuv420p', ...scale,
  ];
  let args;
  if (process.platform === 'linux') {
    if (!(await startFeeder())) return failed('Could not make the audio FIFO');
    // -draw_mouse 0: x11grab paints the X11 pointer by default (a white X on a black frame before the stage paints).
    // -hide_banner -loglevel warning: ffmpeg's banner prints the output URL, which holds the stream key. -stats keeps
    // the frame= progress lines (no URL), which become the bar's fps and bitrate.
    args = [
      '-hide_banner', '-loglevel', 'warning', '-stats',
      '-thread_queue_size', '512', '-f', 'x11grab', '-video_size', `${SCREEN.w}x${SCREEN.h}`, '-framerate', String(e.fps), '-draw_mouse', '0', '-i', ':99',
      '-thread_queue_size', '1024', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', FIFO,
      ...video, '-c:a', 'aac', '-b:a', `${e.audioKbps}k`, '-ar', String(RATE),
      '-f', 'flv', target,
    ];
  } else {
    // This PC: open the page full screen, then this grabs the desktop. No host voice (the mix is Linux-only).
    args = [
      '-hide_banner', '-loglevel', 'warning', '-stats',
      '-f', 'gdigrab', '-framerate', String(e.fps), '-i', 'desktop',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      ...video, '-c:a', 'aac', '-b:a', `${e.audioKbps}k`, '-shortest',
      '-f', 'flv', target,
    ];
  }
  const proc = spawn(ffmpeg, args, { env: { ...process.env, DISPLAY: ':99' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const me = { proc, key: keyOf(e), last: '' };
  enc = me;
  setState('starting', `Connecting to Twitch at ${e.width}x${e.height}, ${e.fps} fps, ${e.videoKbps} kbps${e.rehearsal ? ' (rehearsal: not public)' : ''}`);
  status.running = me.key;
  let buf = '';
  let logged = 0;
  proc.stderr.on('data', (c) => {
    buf += c.toString();
    const parts = buf.split(/[\r\n]+/);
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      const frame = /frame=\s*(\d+)/.exec(line);
      if (frame) {
        const num = (re) => { const m = re.exec(line); return m ? Number(m[1]) : null; };
        Object.assign(status, { fps: num(/fps=\s*([\d.]+)/), kbps: Math.round(num(/bitrate=\s*([\d.]+)kbits/) ?? 0) || null, dropped: num(/drop=\s*(\d+)/) ?? 0, speed: num(/speed=\s*([\d.]+)x/) });
        if (Number(frame[1]) > 0 && status.state === 'starting' && enc === me) {
          liveSince = Date.now();
          setState('live', e.rehearsal ? 'Rehearsal: Twitch receives it, the channel does not show it' : '');
          status.running = me.key;
          console.log(`Live: ${me.key}`);
        }
        // One progress line a minute in the journal.
        if (Date.now() - logged > 60_000) { logged = Date.now(); console.log(redact(line.trim())); }
      } else {
        me.last = redact(line.trim()).slice(0, 200);
        console.error(me.last);
      }
    }
  });
  proc.on('error', (err) => { if (enc === me) { enc = null; failed(`ffmpeg would not start: ${err.message}`); } });
  proc.on('exit', (code, signal) => {
    if (enc !== me) return;
    enc = null;
    if (wanted) failed(`ffmpeg stopped (code ${code ?? signal})${me.last ? `: ${me.last}` : ''}`);
  });
}

function stopEncoder() {
  const e = enc;
  enc = null;
  if (e) kill(e.proc);
  stopFeeder();
}
function stopAll() {
  stopEncoder();
  const s = screen;
  screen = null;
  if (s) { kill(s.browser); kill(s.xvfb); }
}

// ------------------------------------------------------------------ the supervisor

async function frame(timeout) {
  try {
    const r = await fetch(`${STUDIO}/api/broadcast`, { signal: AbortSignal.timeout(timeout) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const d = await frame(5_000);
    // Studio restarting (a deploy): keep whatever is on air; the page reconnects by itself.
    if (!d) return;
    const air = d.onAir || {};
    wanted = air.on ? { ...DEFAULT_ENCODE, ...(air.encode || {}) } : null;
    if (!wanted) {
      if (enc || screen) { stopAll(); console.log('Stopped: the Director bar says off.'); }
      backoff = 10_000;
      retryAt = 0;
      if (status.state !== 'off') setState('off');
      return;
    }
    if (starting) return;
    const m = missing();
    if (m.length) { if (enc || screen) stopAll(); setState('waiting', `Can't go live without: ${m.join(', ')}`); return; }
    // A quality change: ffmpeg alone restarts (the page keeps running).
    if (enc && enc.key !== keyOf(wanted)) { console.log(`Quality changed: ${keyOf(wanted)}`); stopEncoder(); retryAt = 0; }
    if (status.state === 'live' && liveSince && Date.now() - liveSince > 5 * 60_000) backoff = 10_000;
    if (!enc && Date.now() >= retryAt) {
      const e = wanted;
      starting = true;
      try {
        if (status.state !== 'starting') setState('starting', 'Opening the page');
        // A just-started page needs a few seconds to paint and load the show before the first frame goes out.
        if (startScreen()) await sleep(4_000);
        else await sleep(800);
        if (wanted && !enc && keyOf(wanted) === keyOf(e)) await startEncoder(e);
      } finally {
        starting = false;
      }
    }
  } finally {
    writeStatus();
    busy = false;
  }
}

function shutdown() {
  wanted = null;
  stopAll();
  setState('off', 'The encoder service stopped');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`hawkes-broadcast: following ${STUDIO}/api/broadcast; the Director bar's Go live starts the stream.`);
setState('off');
tick();
setInterval(tick, 2_000);
// While live, the audio follows the show faster than the supervisor ticks.
let following = false;
setInterval(async () => {
  if (!enc || following) return;
  following = true;
  try {
    const d = await frame(3_000);
    if (d) await followAudio(d);
  } finally {
    following = false;
  }
}, 700);
