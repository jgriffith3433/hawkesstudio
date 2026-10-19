// Sends Studio's broadcast page to Twitch from the studio server (the control server). Studio already
// receives the playtest video; this process only renders that page and pushes it. It is its own service
// (hawkes-broadcast), not Studio's Node process. Nothing starts unless the stream key is present and --go is passed.
//
//   node bin/broadcast-stream.mjs            what is missing
//   node bin/broadcast-stream.mjs --go       start, once ffmpeg, Chromium, Xvfb and the key are all present
//
// The key lives in Secrets Manager as hawkes/twitch (deploy/twitch-key.mjs). hawkes-secrets writes it to
// /run/hawkes/twitch.env. It is not a Gen key and it is not stored on a laptop.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PAGE = process.env.BROADCAST_URL || 'http://127.0.0.1:8791/broadcast.html?clean=1';
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
  const path = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of path.split(sep)) {
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
  console.log('Ready on the studio server. The hawkes-broadcast service runs this with --go. Encoding is this process, about two CPU cores, separate from Studio.');
  process.exit(0);
}

// Linux: a virtual 1080p screen, Chromium on it, ffmpeg reading that screen.
// Windows: the page must already be the foreground window; ffmpeg grabs the desktop.
const children = [];
function stop() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (process.platform === 'linux') {
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1920x1080x24'], { stdio: 'ignore' });
  children.push(xvfb);
  const browser = spawn(chromium, ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080', '--app=' + PAGE], {
    env: { ...process.env, DISPLAY: ':99' }, stdio: 'ignore',
  });
  children.push(browser);
  const enc = spawn(ffmpeg, [
    '-f', 'x11grab', '-video_size', '1920x1080', '-framerate', '30', '-i', ':99',
    '-f', 'flv', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4500k', '-pix_fmt', 'yuv420p',
    `rtmp://live.twitch.tv/app/${KEY}`,
  ], { env: { ...process.env, DISPLAY: ':99' }, stdio: 'inherit' });
  children.push(enc);
  enc.on('exit', stop);
} else {
  console.log('Open the page full screen, then this grabs the desktop.');
  const enc = spawn(ffmpeg, [
    '-f', 'gdigrab', '-framerate', '30', '-i', 'desktop',
    '-f', 'flv', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4500k', '-pix_fmt', 'yuv420p',
    `rtmp://live.twitch.tv/app/${KEY}`,
  ], { stdio: 'inherit' });
  children.push(enc);
  enc.on('exit', stop);
}
