// Antigravity's Google login (J, 2026-10-20: "make it so I don't have to do anything manually. this should just work out
// of the box like the other ones").
//
// `agy` keeps its login in ~/.gemini/antigravity-cli/antigravity-oauth-token (JSON with a refresh token). Studio's own
// user has one once anybody signs in; the sandboxed agent user (Talk, agents, scouts) has its own home and none, so
// shareAgyLogin puts Studio's login in AGY_CREDS, which sandbox.ts passes through and bin/antigravity-agent.mjs writes
// into that home. The AWS secret hawkes/antigravity (deploy/antigravity-key.mjs) still works: with no login in Studio's
// home it seeds that home first.
//
// Signing in is J's click in Settings, like Claude accounts: `agy` runs in a pseudo-terminal (`script`) with a scratch
// home, Studio picks "Google OAuth" and reads the link, J signs in and pastes the code Google shows back, Studio types it
// in and keeps the login file agy writes. Only J's click on the dashboard (server.ts, approvals.ts notJClick); never the
// sandbox (guards.ts). Tests: STUDIO_AGY_SIGNIN_ARGS (a JSON array: program and arguments) runs a stand-in for agy.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { StudioError } from './config.ts';
import { geminiHome } from './brains.ts';
import { plain } from './claude-accounts.ts';
// @ts-ignore: a plain .mjs (the adapter), no types
import { agyBin } from '../bin/antigravity-agent.mjs';

const tokenFile = (home?: string) => home
  ? path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  : path.join(geminiHome(), 'antigravity-cli', 'antigravity-oauth-token');
/** The AWS secret's login, as Studio started with it (shareAgyLogin replaces AGY_CREDS with Studio's own). */
const SECRET = process.env.AGY_CREDS;

function loginOf(raw: string | null | undefined): { refresh: string; email: string | null } | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const refresh = j?.token?.refresh_token;
    if (!refresh) return null;
    let email: string | null = null;
    try { email = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString('utf8')).email ?? null; } catch { /* no id token */ }
    return { refresh, email };
  } catch {
    return null;
  }
}
const readFile = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

function writeLogin(raw: string, file = tokenFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Studio's login for every `agy` it starts: its own home's file (seeded from the AWS secret when it has none) goes into
 * AGY_CREDS, so the sandboxed agent user signs in with the same Google account. Returns whether there is a login.
 */
export function shareAgyLogin(): boolean {
  let raw = readFile(tokenFile());
  if (!loginOf(raw) && SECRET) {
    try {
      const fromSecret = Buffer.from(SECRET.trim(), 'base64').toString('utf8');
      if (loginOf(fromSecret)) { writeLogin(fromSecret); raw = fromSecret; }
    } catch { /* a bad secret: nothing to share */ }
  }
  if (!loginOf(raw)) return false;
  process.env.AGY_CREDS = Buffer.from(raw!).toString('base64');
  return true;
}

/** What Settings shows: signed in or not, the Google account, and a sign-in in progress. Never the token. */
export function agyLogin() {
  const l = loginOf(readFile(tokenFile())) ?? loginOf(process.env.AGY_CREDS ? Buffer.from(process.env.AGY_CREDS, 'base64').toString('utf8') : null);
  return { signedIn: Boolean(l), email: l?.email ?? null, signin: signinState() };
}

// ---------------------------------------------------------------- sign in
type Signin = { id: string; started: number; child: ChildProcess; out: string; url: string | null; picked: boolean; state: 'starting' | 'waiting' | 'finishing' | 'done' | 'failed'; error: string | null; timer: NodeJS.Timeout; tmp: string };
let signin: Signin | null = null;
const SIGNIN_MS = 10 * 60_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function agySigninUrl(out: string) {
  const m = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s\x07\x1b"'<>│─]*?state=[A-Za-z0-9_-]+/.exec(plain(out));
  return m ? m[0] : null;
}

function signinState() {
  if (!signin) return null;
  return { id: signin.id, state: signin.state, url: signin.url, error: signin.error, started: signin.started };
}

function endSignin(state: 'done' | 'failed', error: string | null = null) {
  if (!signin) return;
  const s = signin;
  clearTimeout(s.timer);
  s.state = state;
  s.error = error;
  try { s.child.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => fs.rmSync(s.tmp, { recursive: true, force: true }), 2000).unref();
  setTimeout(() => { if (signin === s) signin = null; }, 60_000).unref();
}

function lastLines(out: string) {
  return plain(out).split('\n').map((l) => l.replace(/[│─]+/g, '').trim()).filter(Boolean).slice(-3).join(' / ').slice(0, 300) || 'nothing printed';
}

function signinCommand(tmp: string): { file: string; args: string[] } {
  if (process.env.STUDIO_AGY_SIGNIN_ARGS) {
    const [file, ...args] = JSON.parse(process.env.STUDIO_AGY_SIGNIN_ARGS) as string[];
    return { file, args };
  }
  if (process.platform === 'win32') throw new StudioError('Signing Antigravity in runs on the cloud server (studio.hawkesgen.com): agy needs a terminal, and this PC has no pseudo-terminal for Studio.', 400);
  const exe = String(agyBin()).replace(/'/g, `'\\''`);
  // A wide terminal so the link comes out on one line.
  return { file: 'script', args: ['-qfec', `stty cols 4000 rows 60; cd '${tmp}'; exec '${exe}'`, '/dev/null'] };
}

/** Starts `agy` with a scratch home, picks Google OAuth and waits for the link. One at a time; a new one replaces an old one. */
export async function startAgySignin(timeoutMs = 45_000) {
  if (signin && ['starting', 'waiting', 'finishing'].includes(signin.state)) endSignin('failed', 'Replaced by a new sign-in.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agy-'));
  const cmd = signinCommand(tmp);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, BROWSER: 'true', COLUMNS: '4000', LINES: '60', TERM: 'xterm-256color', NO_COLOR: '1' };
  delete env.AGY_CREDS;
  delete env.GEMINI_CLI_HOME;
  const child = spawn(cmd.file, cmd.args, { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const s: Signin = { id: `as_${crypto.randomBytes(5).toString('hex')}`, started: Date.now(), child, out: '', url: null, picked: false, state: 'starting', error: null, tmp, timer: setTimeout(() => { if (signin === s) endSignin('failed', 'The sign-in waited 10 minutes for a code and was closed. Start again.'); }, SIGNIN_MS) };
  signin = s;
  const onData = (d: Buffer) => {
    s.out += d.toString('utf8');
    if (s.out.length > 200_000) s.out = s.out.slice(-100_000);
    // The first screen asks for a login method; Google OAuth is the first one.
    if (!s.picked && /Select login method/i.test(plain(s.out))) { s.picked = true; setTimeout(() => s.child.stdin?.write('\r'), 300); }
    if (!s.url) { s.url = agySigninUrl(s.out); if (s.url && s.state === 'starting') s.state = 'waiting'; }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  child.on('error', (e) => { if (signin === s && s.state !== 'done') endSignin('failed', `Couldn't start agy: ${e.message}`); });
  child.on('close', () => {
    if (signin !== s || s.state === 'done' || s.state === 'failed' || s.state === 'finishing') return;
    endSignin('failed', `agy stopped before the sign-in finished: ${lastLines(s.out)}`);
  });
  const until = Date.now() + timeoutMs;
  while (!s.url && Date.now() < until && signin === s && s.state === 'starting') await wait(100);
  if (!s.url) {
    const why = s.error ?? `No sign-in link from agy: ${lastLines(s.out)}`;
    if (signin === s) endSignin('failed', why);
    throw new StudioError(why, 502);
  }
  return agyLogin();
}

/** Types the code J pasted into the waiting agy, keeps the login it writes, shares it, and lifts a hold on Antigravity. */
export async function finishAgySignin(code: string, timeoutMs = 60_000) {
  const s = signin;
  if (!s || s.state !== 'waiting') throw new StudioError('No Antigravity sign-in is waiting for a code. Start one with "Sign in with Google".', 409);
  const clean = String(code ?? '').replace(/\s+/g, '');
  if (clean.length < 10) throw new StudioError('Paste the whole code Google shows after you sign in.');
  s.state = 'finishing';
  const from = s.out.length;
  s.child.stdin!.write(clean);
  await wait(400);
  s.child.stdin!.write('\r');
  const file = tokenFile(s.tmp);
  const until = Date.now() + timeoutMs;
  let raw: string | null = null;
  while (Date.now() < until && signin === s) {
    const r = readFile(file);
    if (loginOf(r)) { raw = r; break; }
    if (s.child.exitCode !== null) break;
    await wait(200);
  }
  if (!raw) {
    const why = `agy didn't take the code: ${lastLines(s.out.slice(from))}`;
    endSignin('failed', why);
    throw new StudioError(why, 400);
  }
  writeLogin(raw);
  shareAgyLogin();
  endSignin('done');
  try {
    const { liftHold } = await import('./harness-hold.ts');
    liftHold('signed in again from Settings', 'antigravity');
  } catch { /* no hold */ }
  return agyLogin();
}

export function cancelAgySignin() {
  if (signin && signin.state !== 'done' && signin.state !== 'failed') endSignin('failed', 'Cancelled.');
  signin = null;
  return agyLogin();
}
