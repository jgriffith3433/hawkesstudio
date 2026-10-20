// Sends Studio's broadcast page to Twitch from the studio server (the control server). Studio already
// receives the playtest video; this process only renders that page and pushes it. It is its own service
// (hawkes-broadcast), not Studio's Node process. Nothing starts unless the stream key is present and --go is passed.
//
//   node bin/broadcast-stream.mjs            what is missing
//   node bin/broadcast-stream.mjs --go       start, once ffmpeg, Chromium, Xvfb and the key are all present
//
// The key lives in Secrets Manager as hawkes/twitch (deploy/twitch-key.mjs). hawkes-secrets writes it to
// /run/hawkes/twitch.env. It is not a Gen key and it is not stored on a laptop.
//
// Audio: this machine has no sound card. The encoder follows the show (src/show.ts, through /api/broadcast): each of
// Yooba's lines and the showcase's song are decoded to PCM, mixed here (the song ducked under his voice) and fed to
// ffmpeg through a FIFO (silence when nothing plays). No PulseAudio or ALSA hardware needed.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PAGE = process.env.BROADCAST_URL || 'http://127.0.0.1:8791/broadcast.html?product=yoobaland&clean=1';
const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:8791';
const RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SEC = RATE * CHANNELS * 2;
const CHUNK_MS = 100;
const CHUNK = Math.floor(BYTES_PER_SEC * CHUNK_MS / 1000);

function streamKey() {
  if (process.env.TWITCH_STREAM_KEY) return process.env.TWITCH_STREAM_KEY;
  try {
    const m = /^\s*TWITCH_STREAM_KEY\s*=\s*(.*?)\s*$/m.exec(readFileSync('/run/hawkes/twitch.env', 'utf8'));
    return m?.[1].replace(/^['"]|['"]$/g, '') || '';
  } catch {
    return '';
  }
}
const KEY = streamKey();
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
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
);
const missing = [];
if (!ffmpeg) missing.push('ffmpeg (the encoder)');
if (!chromium) missing.push('Chromium or Chrome (the page)');
if (!KEY) missing.push('TWITCH_STREAM_KEY (Secrets Manager hawkes/twitch, via node deploy/twitch-key.mjs)');
if (process.platform === 'linux' && !which(['Xvfb'])) missing.push('Xvfb (a virtual screen, so encoding does not need a monitor)');

const redacted = KEY ? `rtmp://live.twitch.tv/app/${KEY.slice(0, 4)}…` : 'rtmp://live.twitch.tv/app/<stream key>';
console.log(`page: ${PAGE}`);
console.log(`ingest: ${redacted}`);
if (missing.length) {
  console.log('waiting on:');
  for (const m of missing) console.log(`  - ${m}`);
  console.log('Nothing is being encoded. Studio keeps serving the page either way.');
  process.exit(GO ? 2 : 0);
}
if (!GO) {
  console.log('Ready on the studio server. The hawkes-broadcast service runs this with --go. Encoding is this process, about two CPU cores, separate from Studio. Host voice is mixed from Studio\'s cached mp3 (no sound card).');
  process.exit(0);
}

const children = [];
function stop() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

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
async function follow() {
  let d;
  try {
    const r = await fetch(`${STUDIO}/api/broadcast`);
    if (!r.ok) return;
    d = await r.json();
  } catch { return; }
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

function startFollowing() {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await follow(); } finally { busy = false; }
  }, 700);
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

function startFifoFeeder(fifoPath) {
  mkdirSync(path.dirname(fifoPath), { recursive: true });
  try { unlinkSync(fifoPath); } catch { /* ok */ }
  // mkfifo via shell — Node has no built-in.
  const mk = spawn('mkfifo', [fifoPath], { stdio: 'ignore' });
  children.push(mk);
  mk.on('close', () => {
    const out = createWriteStream(fifoPath);
    // Paced by the wall clock, not by chained timers. ffmpeg times the whole stream by these samples: a feed that
    // runs slow (setTimeout drifts ~2%) puts the x11grab frames minutes ahead of the audio, ffmpeg pulls fewer and
    // fewer of them (4 fps after an hour), and Twitch shows black under the voice.
    let t0 = 0;
    let sent = 0;
    const pump = () => {
      if (out.destroyed) return;
      if (!t0) t0 = Date.now();
      const due = Math.floor((Date.now() - t0) / CHUNK_MS) + 1;
      while (sent < due) {
        sent++;
        if (!out.write(nextChunk())) { out.once('drain', pump); return; }
      }
      setTimeout(pump, CHUNK_MS / 2);
    };
    out.on('open', pump);
    out.on('error', () => setTimeout(() => startFifoFeeder(fifoPath), 1000));
  });
}

if (process.platform === 'linux') {
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1920x1080x24'], { stdio: 'ignore' });
  children.push(xvfb);
  const browser = spawn(chromium, [
    '--no-sandbox', '--test-type', '--no-first-run', '--disable-fre', '--no-default-browser-check',
    '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1920,1080', '--app=' + PAGE,
  ], {
    env: { ...process.env, DISPLAY: ':99' }, stdio: 'ignore',
  });
  children.push(browser);
  // If Chromium dies (OOM, snap crash), ffmpeg keeps pushing a black X11 screen. Exit so systemd restarts the unit.
  browser.on('exit', (code, signal) => {
    console.error(`Chromium left (code ${code}, signal ${signal}); stopping the encoder so the service can restart.`);
    stop();
  });

  const fifo = path.join(tmpdir(), 'hawkes-broadcast-voice.pcm');
  startFifoFeeder(fifo);
  startFollowing();

  // Give the FIFO a moment to exist before ffmpeg opens it.
  // -draw_mouse 0: x11grab paints the X11 pointer by default; on a headless
  // capture that shows up as a white X on an otherwise black Twitch frame when
  // Chromium has crashed or the stage has not painted yet.
  setTimeout(() => {
    // -hide_banner -loglevel warning: ffmpeg's banner prints the output URL, which holds the stream key, into the
    // journal. -stats keeps the frame= progress lines (they carry no URL).
    const enc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'warning', '-stats',
      '-thread_queue_size', '512', '-f', 'x11grab', '-video_size', '1920x1080', '-framerate', '30', '-draw_mouse', '0', '-i', ':99',
      '-thread_queue_size', '1024', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', fifo,
      // Twitch wants a keyframe every 2 s and a steady bitrate; x264's default is one per 250 frames.
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', String(RATE),
      '-f', 'flv', `rtmp://live.twitch.tv/app/${KEY}`,
    ], { env: { ...process.env, DISPLAY: ':99' }, stdio: 'inherit' });
    children.push(enc);
    enc.on('exit', stop);
  }, 800);
} else {
  console.log('Open the page full screen, then this grabs the desktop. Host voice mix is Linux-only (FIFO).');
  const enc = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-stats',
    '-f', 'gdigrab', '-framerate', '30', '-i', 'desktop',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    '-f', 'flv', `rtmp://live.twitch.tv/app/${KEY}`,
  ], { stdio: 'inherit' });
  children.push(enc);
  enc.on('exit', stop);
}
