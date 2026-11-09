// The AI CLIs' kept sign-ins, written into the home a pass runs in (src/cli-signin.ts, src/ai-logins.ts). Studio passes a
// login as <X>_CREDS: base64 JSON of { home-relative path: file text }. The adapters (cursor-, codex-, copilot-agent.mjs)
// call seedLogin before they start their CLI.
//
// A home that outlives one pass (the sandbox user's on a server) may hold a newer login than Studio's: the CLI refreshed
// its token there (OpenAI's refresh tokens work once). So the files are written only when this login is new to that home
// (a marker keeps a hash of the login last written); otherwise the CLI's own, newer files stay.
// changedLogins: what a pass's CLIs rewrote, for Studio to keep (the cloud job sends it back: src/cloudjob-run.ts).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOGIN_ENVS = ['CURSOR_CREDS', 'CODEX_CREDS', 'COPILOT_CREDS'];
const safeRel = (rel) => /^[\w.@-]+(\/[\w.@ -]+)*$/.test(rel) && !rel.split('/').includes('..');

/** The login's files from its environment value (null: none, or not readable). */
export function loginFiles(value) {
  if (!value) return null;
  try {
    const j = JSON.parse(Buffer.from(String(value).trim(), 'base64').toString('utf8'));
    if (!j || typeof j !== 'object') return null;
    const out = {};
    for (const [rel, text] of Object.entries(j)) if (safeRel(rel) && typeof text === 'string') out[rel] = text;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Writes <name>'s login into the home unless that home already has it (or a newer one from the CLI). Returns files written. */
export function seedLogin(name, env = process.env, home = env.HOME || os.homedir()) {
  const files = loginFiles(env[name]);
  if (!files) return 0;
  const hash = crypto.createHash('sha256').update(String(env[name])).digest('hex');
  const marker = path.join(home, '.studio-logins', name);
  let seen = null;
  try { seen = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first time in this home */ }
  if (seen === hash && Object.keys(files).every((rel) => fs.existsSync(path.join(home, rel)))) return 0;
  let n = 0;
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(home, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, text, { mode: 0o600 });
      n++;
    } catch { /* a read-only home: the CLI says it isn't signed in, and the hold names it */ }
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, hash, { mode: 0o600 });
  } catch { /* no marker: the next pass writes the login again */ }
  return n;
}

/** The logins whose files a pass's CLI rewrote in this home: { CODEX_CREDS: { rel: newText } }. Empty: nothing changed. */
export function changedLogins(env, home) {
  const out = {};
  for (const name of LOGIN_ENVS) {
    const files = loginFiles(env?.[name]);
    if (!files) continue;
    const changed = {};
    for (const [rel, text] of Object.entries(files)) {
      try {
        const now = fs.readFileSync(path.join(home, rel), 'utf8');
        if (now !== text && now.trim()) changed[rel] = now;
      } catch { /* gone: nothing to keep */ }
    }
    if (Object.keys(changed).length) out[name] = changed;
  }
  return out;
}
