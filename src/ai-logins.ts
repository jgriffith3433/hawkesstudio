// The AI coding CLIs' own sign-ins, kept where a Cloud Run restart can't lose them (J, 2026-11-09: "Be able to sign into
// all AI coding agent providers with subscription usage like what we have with claude").
//
// Each CLI keeps its login in files under its user's home (agy: ~/.gemini/antigravity-cli/antigravity-oauth-token,
// Codex: ~/.codex/auth.json, Cursor's `agent`: ~/.config/cursor/, Copilot: ~/.copilot/). On Cloud Run that home is the
// instance's own disk, gone at the next restart, so a sign-in lasted until the next deploy. Here a login is the set of
// those files (paths relative to a home), kept in DATA/ai/logins/<provider>.json, which the state sync carries across
// instances (cloudhost.ts). Sealed at rest wherever this Studio seals secrets (a cell always: cellkeys.ts). Never shown:
// Settings sees only whether a provider is signed in, as which account when the CLI says, and since when.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.ts';
import { seal, unseal } from './cellkeys.ts';

export type LoginFiles = Record<string, string>; // home-relative path (with /) -> file content (utf8)
export type StoredLogin = { files: LoginFiles; account: string | null; at: number; by: string | null };

const DIR = () => path.join(DATA, 'ai', 'logins');
const FILE = (provider: string) => path.join(DIR(), `${provider.replace(/[^a-z0-9-]/g, '')}.json`);
/** A home-relative path that stays inside the home. */
const safeRel = (rel: string) => /^[\w.@-]+(\/[\w.@ -]+)*$/.test(rel) && !rel.split('/').includes('..');

export function saveLogin(provider: string, files: LoginFiles, { account = null, by = null }: { account?: string | null; by?: string | null } = {}) {
  const clean: LoginFiles = {};
  for (const [rel, text] of Object.entries(files)) if (safeRel(rel) && typeof text === 'string') clean[rel] = text;
  if (!Object.keys(clean).length) throw new Error(`No login files for ${provider}`);
  const rec: StoredLogin = { files: clean, account, at: Date.now(), by };
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const tmp = `${FILE(provider)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, seal(JSON.stringify(rec)), { mode: 0o600 });
  fs.renameSync(tmp, FILE(provider));
  return rec;
}

export function loadLogin(provider: string): StoredLogin | null {
  try {
    const rec = JSON.parse(unseal(fs.readFileSync(FILE(provider), 'utf8'))) as StoredLogin;
    return rec && rec.files && typeof rec.files === 'object' ? rec : null;
  } catch {
    return null;
  }
}

export function forgetLogin(provider: string) {
  fs.rmSync(FILE(provider), { force: true });
}

/** Writes a stored login's files into a home (the server's own, or a sandboxed user's). Returns how many were written. */
export function writeLoginFiles(files: LoginFiles, home: string) {
  let n = 0;
  for (const [rel, text] of Object.entries(files)) {
    if (!safeRel(rel)) continue;
    const dest = path.join(home, rel);
    try {
      if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === text) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, text, { mode: 0o600 });
      n++;
    } catch { /* a read-only home: the CLI says it isn't signed in, and the hold names it */ }
  }
  return n;
}

/** A login as one environment value (base64 JSON of its files), for a CLI started elsewhere (a Cloud Run job). */
export const loginEnvValue = (files: LoginFiles) => Buffer.from(JSON.stringify(files)).toString('base64');
