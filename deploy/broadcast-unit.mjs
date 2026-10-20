// Everything the Twitch encoder (bin/broadcast-stream.mjs, the hawkes-broadcast service) needs on a server, in one place:
// the system packages, a Chromium, and the systemd unit. Used by deploy.mjs (a fresh server), hawkes-pull.mjs (every
// deploy, imported fresh so a change here applies on the deploy that brings it) and by hand:
//
//   sudo node deploy/broadcast-unit.mjs              install what's missing, keep the unit current, make sure it runs
//   sudo node deploy/broadcast-unit.mjs --restart    the same, then restart the encoder (drops a live stream ~20 s)
//   node deploy/broadcast-unit.mjs --check           say what's missing; change nothing
//
// The encoder runs all the time and idles until the Director panel's Go live (src/onair.ts), so Restart=always and
// enabled at boot. The stream key is not set up here: Secrets Manager hawkes/twitch (deploy/twitch-key.mjs), written to
// /run/hawkes/twitch.env by hawkes-secrets.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BROADCAST_UNIT = `
[Unit]
Description=Hawkes: the broadcast page to Twitch (separate from Studio; idle until Go live)
After=hawkes-studio.service hawkes-secrets.service

[Service]
User=hawkes
WorkingDirectory=/srv/hawkes/hawkesstudio
Environment=BROADCAST_URL=http://127.0.0.1:8791/broadcast.html?product=yoobaland&clean=1
EnvironmentFile=-/run/hawkes/twitch.env
ExecStart=/usr/bin/node bin/broadcast-stream.mjs --go
Restart=always
RestartSec=15
KillMode=control-group

[Install]
WantedBy=multi-user.target
`.trim() + '\n';

const UNIT_FILE = '/etc/systemd/system/hawkes-broadcast.service';

/** apt packages: Xvfb (the virtual screen), ffmpeg (the encoder), and fonts so the page's text and emoji draw. */
export const BROADCAST_APT = ['xvfb', 'ffmpeg', 'fonts-dejavu-core', 'fonts-noto-color-emoji'];

/** Where the encoder looks for a browser, in order (bin/broadcast-stream.mjs uses this list too). */
export const BROADCAST_CHROMIUM = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000, ...opts });
const installed = (pkg) => { try { return /install ok installed/.test(run('dpkg-query', ['-W', '-f=${Status}', pkg])); } catch { return false; } };
// Ubuntu's /usr/bin/chromium-browser is a small wrapper that only asks for the snap: it doesn't count by itself.
const snapWrapper = (p) => { try { return fs.statSync(p).size < 10_000 && /snap/.test(fs.readFileSync(p, 'utf8')); } catch { return false; } };
const chromiumOk = () => fs.existsSync('/snap/bin/chromium') || BROADCAST_CHROMIUM.some((p) => fs.existsSync(p) && !snapWrapper(p));
const active = () => { try { return run('systemctl', ['is-active', 'hawkes-broadcast']).trim() === 'active'; } catch { return false; } };

/** What the encoder still needs on this machine (nothing changed). */
export function broadcastMissing() {
  const out = BROADCAST_APT.filter((p) => !installed(p)).map((p) => `apt ${p}`);
  if (!chromiumOk()) out.push('Chromium (snap chromium)');
  let unit = '';
  try { unit = fs.readFileSync(UNIT_FILE, 'utf8'); } catch { /* not installed */ }
  if (unit !== BROADCAST_UNIT) out.push(unit ? 'hawkes-broadcast unit out of date' : 'hawkes-broadcast unit');
  if (!active()) out.push('hawkes-broadcast not running');
  return out;
}

/**
 * Installs what's missing (as root), keeps the unit current, and makes sure the encoder runs. `restart` also restarts a
 * running encoder (its script changed). Returns what it did, one line each; throws only when it can't run at all.
 */
export function ensureBroadcast({ restart = false, say = console.log } = {}) {
  const did = [];
  const note = (s) => { did.push(s); say(`hawkes-broadcast: ${s}`); };
  const apt = BROADCAST_APT.filter((p) => !installed(p));
  if (apt.length) {
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
    run('apt-get', ['update', '-y'], { env });
    run('apt-get', ['install', '-y', '--no-install-recommends', ...apt], { env });
    note(`installed ${apt.join(', ')}`);
  }
  if (!chromiumOk()) {
    run('snap', ['install', 'chromium']);
    note('installed Chromium (snap)');
  }
  let cur = '';
  try { cur = fs.readFileSync(UNIT_FILE, 'utf8'); } catch { /* not installed */ }
  const newUnit = cur !== BROADCAST_UNIT;
  if (newUnit) {
    fs.writeFileSync(UNIT_FILE, BROADCAST_UNIT);
    run('systemctl', ['daemon-reload']);
    note(cur ? 'updated its unit' : 'installed its unit');
  }
  run('systemctl', ['enable', 'hawkes-broadcast']);
  if (!active()) { run('systemctl', ['start', 'hawkes-broadcast']); note('started (idle until Go live)'); }
  else if (newUnit || restart) { run('systemctl', ['restart', 'hawkes-broadcast']); note('restarted: its unit or script changed'); }
  return did;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  if (process.argv.includes('--check')) {
    const m = broadcastMissing();
    console.log(m.length ? `missing: ${m.join('; ')}` : 'hawkes-broadcast: everything is in place');
    process.exit(m.length ? 1 : 0);
  }
  if (process.getuid?.() !== 0) { console.error('run as root: sudo node deploy/broadcast-unit.mjs'); process.exit(2); }
  const did = ensureBroadcast({ restart: process.argv.includes('--restart') });
  if (!did.length) console.log('hawkes-broadcast: everything was already in place');
}
