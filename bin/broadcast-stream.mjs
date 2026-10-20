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
// Audio: this machine has no sound card. We mix Yooba's cached host mp3 into the RTMP AAC send by feeding
// PCM into a FIFO (silence when there is no line). The clean page still plays hostAudio for the mouth;
// the mixer does not need PulseAudio or ALSA hardware.

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
let voiceQueue = []; // Buffer chunks of s16le PCM waiting to play
let lastVoiceUrl = '';

async function fetchVoicePath() {
  try {
    const r = await fetch(`${STUDIO}/api/broadcast`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.desk?.voice === false) return null;
    return d?.hostAudio || null;
  } catch {
    return null;
  }
}

/** Decode an mp3 URL into s16le stereo chunks queued for the FIFO. */
function enqueueMp3(url) {
  if (!url || url === lastVoiceUrl) return;
  lastVoiceUrl = url;
  const abs = url.startsWith('http') ? url : `${STUDIO}${url}`;
  const dec = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', abs,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', String(CHANNELS), '-ar', String(RATE),
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(dec);
  const chunks = [];
  dec.stdout.on('data', (c) => chunks.push(c));
  dec.on('close', () => {
    const buf = Buffer.concat(chunks);
    for (let i = 0; i < buf.length; i += CHUNK) {
      const slice = buf.subarray(i, Math.min(i + CHUNK, buf.length));
      if (slice.length < CHUNK) {
        const pad = Buffer.alloc(CHUNK);
        slice.copy(pad);
        voiceQueue.push(pad);
      } else voiceQueue.push(Buffer.from(slice));
    }
  });
}

function startVoicePoll() {
  const tick = async () => {
    const url = await fetchVoicePath();
    if (url) enqueueMp3(url);
    else lastVoiceUrl = '';
  };
  tick();
  setInterval(tick, 2000);
}

function startFifoFeeder(fifoPath) {
  mkdirSync(path.dirname(fifoPath), { recursive: true });
  try { unlinkSync(fifoPath); } catch { /* ok */ }
  // mkfifo via shell — Node has no built-in.
  const mk = spawn('mkfifo', [fifoPath], { stdio: 'ignore' });
  children.push(mk);
  mk.on('close', () => {
    const out = createWriteStream(fifoPath);
    const pump = () => {
      if (out.destroyed) return;
      const next = voiceQueue.shift() || silence;
      if (!out.write(next)) out.once('drain', () => setTimeout(pump, CHUNK_MS));
      else setTimeout(pump, CHUNK_MS);
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
  startVoicePoll();

  // Give the FIFO a moment to exist before ffmpeg opens it.
  // -draw_mouse 0: x11grab defaults to drawing the X11 cursor; on a black stage (startup,
  // waiting take, empty reel) that shows on Twitch as a white X in the middle of a black frame
  // while the desk browser still looks fine. Never put the cursor on the RTMP send.
  setTimeout(() => {
    const enc = spawn(ffmpeg, [
      '-f', 'x11grab', '-video_size', '1920x1080', '-framerate', '30', '-draw_mouse', '0', '-i', ':99',
      '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', fifo,
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4500k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', String(RATE),
      '-f', 'flv', `rtmp://live.twitch.tv/app/${KEY}`,
    ], { env: { ...process.env, DISPLAY: ':99' }, stdio: 'inherit' });
    children.push(enc);
    enc.on('exit', stop);
  }, 800);
} else {
  console.log('Open the page full screen, then this grabs the desktop. Host voice mix is Linux-only (FIFO).');
  const enc = spawn(ffmpeg, [
    '-f', 'gdigrab', '-framerate', '30', '-i', 'desktop',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4500k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    '-f', 'flv', `rtmp://live.twitch.tv/app/${KEY}`,
  ], { stdio: 'inherit' });
  children.push(enc);
  enc.on('exit', stop);
}
