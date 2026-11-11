// Claude accounts: the Claude logins Studio and Gen run Claude Code with, signed in from the Settings tab (J,
// 2026-10-19: "do this whole process of signing into a different claude account but on the web app ... save previous
// log ins ... to switch").
//
// A login is a 1-year token from `claude setup-token`. Signing in runs that command on this server in a pseudo-terminal
// (`script`): Studio reads the sign-in link from it, J opens the link and signs in, pastes the code Claude shows him
// back into Settings, Studio types it in and reads the token out. Tokens are kept in .data/claude/accounts.json (0600;
// .data is out of the agent sandbox's reach) and never leave Studio's API: the dashboard sees a label and the last 4
// characters. The account in use is also written to .data/claude/active.env, which Hawkes Gen reads for its own Claude
// calls (hawkesgen src/providers/claudecode.ts), so switching takes effect on the next turn, agent and Gen call with no
// restart. With no account saved, everything uses CLAUDE_CODE_OAUTH_TOKEN from the environment (the AWS secret
// hawkes/claude, deploy/claude-token.mjs), which the first look at the list keeps as an account of its own.
//
// In a customer's Studio (tenancy.ts) the accounts are the customer's own Claude subscription, signed in by their
// admin, and the environment's token is never used or adopted.
//
// Only J's click on the dashboard changes accounts (server.ts, approvals.ts notJClick); the sandbox never (guards.ts).
// Tests: STUDIO_CLAUDE_SETUP_ARGS (a JSON array: program and arguments) runs a stand-in instead of `script ... claude`.

import { queueWake } from './queuewake.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { DATA, StudioError } from './config.ts';
import { customerStudio } from './tenancy.ts';
import { seal, sealing, unseal } from './cellkeys.ts';

const DIR = () => path.join(DATA, 'claude');
const FILE = () => path.join(DIR(), 'accounts.json');
const ACTIVE_ENV = () => path.join(DIR(), 'active.env');
const YEAR = 365 * 86_400_000;
const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

export type Check = { at: number; ok: boolean; note: string };
type Account = { id: string; label: string; token: string; added: number; by: string; source: 'signin' | 'environment'; check?: Check };
type Store = { active: string | null; accounts: Account[] };

// ------------------------------------------------------------------ store
let cache: { mtime: number; store: Store } | null = null;

function read(): Store {
  try {
    const st = fs.statSync(FILE());
    if (cache && cache.mtime === st.mtimeMs) return cache.store;
    const disk = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Store;
    // A customer's sign-ins are sealed at rest (cellkeys.ts); plain ones (J's, or from before sealing) read as they are.
    const store = { ...disk, accounts: disk.accounts.map((a) => ({ ...a, token: unseal(a.token) })) };
    cache = { mtime: st.mtimeMs, store };
    return store;
  } catch {
    return { active: null, accounts: [] };
  }
}

function write(store: Store) {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  const sealed = customerStudio() && sealing();
  fs.writeFileSync(tmp, JSON.stringify(sealed ? { ...store, accounts: store.accounts.map((a) => ({ ...a, token: seal(a.token) })) } : store, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  cache = null;
  const active = store.accounts.find((a) => a.id === store.active);
  // active.env is for J's Gen (its Claude calls read it); a customer's Studio keeps no plain copy.
  if (customerStudio()) fs.rmSync(ACTIVE_ENV(), { force: true });
  else if (active) fs.writeFileSync(ACTIVE_ENV(), `CLAUDE_CODE_OAUTH_TOKEN=${active.token}\n`, { mode: 0o600 });
  else fs.rmSync(ACTIVE_ENV(), { force: true });
  // A Claude account added or chosen: work held for want of an AI looks again now.
  queueWake('a Claude account changed');
}

/**
 * The environment's token (the AWS secret on the server), kept as an account the first time the list is looked at. A
 * token new to the list there means J stored a new one in AWS (deploy/claude-token.mjs) and restarted: it is used.
 */
function adoptEnvironment(store: Store): Store {
  // A customer's Studio runs only on the customer's own Claude (claude.ts): never a token from the environment.
  const env = customerStudio() ? undefined : process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!env || store.accounts.some((a) => a.token === env)) return store;
  const a: Account = { id: `ca_${crypto.randomBytes(6).toString('hex')}`, label: 'From the server (AWS hawkes/claude)', token: env, added: Date.now(), by: 'Studio', source: 'environment' };
  const next = { active: a.id, accounts: [...store.accounts, a] };
  write(next);
  return next;
}

/** The token Claude Code runs with now: the account in use, else the environment's. */
export function activeToken(): string | undefined {
  const s = read();
  return s.accounts.find((a) => a.id === s.active)?.token || (customerStudio() ? undefined : process.env.CLAUDE_CODE_OAUTH_TOKEN) || undefined;
}

const view = (a: Account, active: string | null) => ({
  id: a.id, label: a.label, tail: a.token.slice(-4), added: a.added, by: a.by, source: a.source,
  // setup-token says its tokens last a year; Studio can't ask (they carry no profile scope), so it counts from the save.
  expires: a.source === 'signin' ? a.added + YEAR : null,
  active: a.id === active, check: a.check ?? null,
});

/** The accounts as the dashboard sees them (never a token). */
export function listAccounts() {
  const s = adoptEnvironment(read());
  return { active: s.active, accounts: s.accounts.map((a) => view(a, s.active)), signin: signinState() };
}

function find(store: Store, id: string) {
  const a = store.accounts.find((x) => x.id === id);
  if (!a) throw new StudioError(`No Claude account ${id}`, 404);
  return a;
}

/** Use this account from now on (the next Talk turn, agent, scout and Gen call). */
export function useAccount(id: string) {
  const s = adoptEnvironment(read());
  find(s, id);
  write({ ...s, active: id });
  return listAccounts();
}

export function renameAccount(id: string, label: string) {
  const s = read();
  const clean = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) throw new StudioError('label: a name for this account');
  find(s, id).label = clean;
  write(s);
  return listAccounts();
}

export function removeAccount(id: string) {
  const s = read();
  find(s, id);
  if (s.active === id) throw new StudioError('That account is in use. Switch to another one first.');
  write({ ...s, accounts: s.accounts.filter((a) => a.id !== id) });
  return listAccounts();
}

function saveAccount(token: string, label: string, by: string, use: boolean) {
  const s = adoptEnvironment(read());
  const same = s.accounts.find((a) => a.token === token);
  const a: Account = same ?? { id: `ca_${crypto.randomBytes(6).toString('hex')}`, label: '', token, added: Date.now(), by, source: 'signin' };
  a.label = label.trim().slice(0, 60) || a.label || `Claude account ${s.accounts.length + 1}`;
  const accounts = same ? s.accounts : [...s.accounts, a];
  write({ active: use ? a.id : s.active, accounts });
  return a;
}

// ------------------------------------------------------------------ check
/** One tiny `claude -p` with this account: does it sign in, and is its usage left? */
export function checkAccount(id: string, timeoutMs = 90_000): Promise<Check> {
  const a = find(read(), id);
  const exe = process.env.TALK_CLAUDE || 'claude';
  const pre: string[] = process.env.TALK_CLAUDE_ARGS ? JSON.parse(process.env.TALK_CLAUDE_ARGS) : [];
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: a.token };
  delete env.ANTHROPIC_API_KEY;
  const args = [...pre, '-p', 'Reply with just: ok', '--model', 'claude-haiku-5-5', '--output-format', 'json', '--max-turns', '1',
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'];
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: os.tmpdir(), env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const done = (ok: boolean, note: string) => {
      clearTimeout(timer);
      const check = { at: Date.now(), ok, note: note.replace(TOKEN, '[token]').slice(0, 240) };
      const s = read();
      const acc = s.accounts.find((x) => x.id === id);
      if (acc) { acc.check = check; write(s); }
      resolve(check);
    };
    child.on('error', (e) => done(false, `Couldn't start Claude Code: ${e.message}`));
    child.on('close', (code, signal) => {
      if (signal) return done(false, 'No answer in time.');
      let m: any = null;
      try { m = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { /* not JSON */ }
      if (m && !m.is_error) return done(true, 'Signed in and answering.');
      const why = String(m?.result ?? out ?? `exit ${code}`).trim();
      if (/limit|usage/i.test(why)) return done(false, `Out of usage: ${why}`);
      if (/401|403|auth|token|log ?in/i.test(why)) return done(false, `Not signed in: ${why}`);
      done(false, why || `exit ${code}`);
    });
  });
}

// ---------------------------------------------------------------- sign in
type Signin = { id: string; label: string; by: string; started: number; child: ChildProcess; out: string; url: string | null; state: 'starting' | 'waiting' | 'finishing' | 'done' | 'failed'; error: string | null; timer: NodeJS.Timeout; tmp: string };
let signin: Signin | null = null;
const SIGNIN_MS = 10 * 60_000;

/** Terminal output as text: colours, cursor moves and hyperlinks removed. */
export function plain(s: string) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g, '')
    .replace(/\r/g, '\n');
}

export function signinUrl(out: string) {
  const m = /https:\/\/[^\s\x07\x1b"'<>]*?oauth\/authorize\?[^\s\x07\x1b"'<>]*?state=[A-Za-z0-9_-]+/.exec(plain(out));
  return m ? m[0] : null;
}

function signinState() {
  if (!signin) return null;
  return { id: signin.id, label: signin.label, state: signin.state, url: signin.url, error: signin.error, started: signin.started };
}

function endSignin(state: 'done' | 'failed', error: string | null = null) {
  if (!signin) return;
  const s = signin;
  clearTimeout(s.timer);
  s.state = state;
  s.error = error;
  try { s.child.kill('SIGTERM'); } catch { /* gone */ }
  fs.rmSync(s.tmp, { recursive: true, force: true });
  // The finished one stays visible a minute (its error), then goes.
  setTimeout(() => { if (signin === s) signin = null; }, 60_000).unref();
}

function setupCommand(tmp: string): { file: string; args: string[] } {
  if (process.env.STUDIO_CLAUDE_SETUP_ARGS) {
    const [file, ...args] = JSON.parse(process.env.STUDIO_CLAUDE_SETUP_ARGS) as string[];
    return { file, args };
  }
  if (process.platform === 'win32') throw new StudioError('Signing in to a Claude account runs on the cloud server (studio.hawkesgen.ai): Claude Code needs a terminal, and this PC has no pseudo-terminal for Studio.', 400);
  const exe = (process.env.TALK_CLAUDE || 'claude').replace(/'/g, `'\\''`);
  // A wide terminal so the link and the token come out on one line each.
  return { file: 'script', args: ['-qfec', `stty cols 4000 rows 60; cd '${tmp}'; exec '${exe}' setup-token`, '/dev/null'] };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts `claude setup-token` and waits for its sign-in link. One sign-in at a time; a new one replaces an old one. */
export async function startSignin(label: string, by = 'J', timeoutMs = 30_000) {
  if (signin && ['starting', 'waiting', 'finishing'].includes(signin.state)) endSignin('failed', 'Replaced by a new sign-in.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-claude-'));
  const cmd = setupCommand(tmp);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, BROWSER: 'true', COLUMNS: '4000', LINES: '60', TERM: 'xterm-256color' };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  const child = spawn(cmd.file, cmd.args, { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const s: Signin = { id: `si_${crypto.randomBytes(5).toString('hex')}`, label: String(label ?? '').trim().slice(0, 60), by, started: Date.now(), child, out: '', url: null, state: 'starting', error: null, tmp, timer: setTimeout(() => { if (signin === s) endSignin('failed', 'The sign-in waited 10 minutes for a code and was closed. Start again.'); }, SIGNIN_MS) };
  signin = s;
  const onData = (d: Buffer) => {
    s.out += d.toString('utf8');
    if (s.out.length > 200_000) s.out = s.out.slice(-100_000);
    if (!s.url) { s.url = signinUrl(s.out); if (s.url && s.state === 'starting') s.state = 'waiting'; }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  child.on('error', (e) => { if (signin === s && s.state !== 'done') endSignin('failed', `Couldn't start Claude Code: ${e.message}`); });
  child.on('close', () => {
    if (signin !== s || s.state === 'done' || s.state === 'failed') return;
    if (s.state === 'finishing') return; // finishSignin reads the output itself
    endSignin('failed', `Claude Code stopped before the sign-in finished: ${lastLines(s.out)}`);
  });
  const until = Date.now() + timeoutMs;
  while (!s.url && Date.now() < until && signin === s && s.state === 'starting') await wait(100);
  if (!s.url) {
    const why = s.error ?? `No sign-in link from Claude Code: ${lastLines(s.out)}`;
    if (signin === s) endSignin('failed', why);
    throw new StudioError(why, 502);
  }
  return signinState()!;
}

function lastLines(out: string) {
  return plain(out).replace(TOKEN, '[token]').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ').slice(0, 300) || 'nothing printed';
}

/** Types the code J pasted into the waiting `claude setup-token`, reads the token and saves it as an account. */
export async function finishSignin(code: string, { use = true, timeoutMs = 60_000 }: { use?: boolean; timeoutMs?: number } = {}) {
  const s = signin;
  if (!s || s.state !== 'waiting') throw new StudioError('No sign-in is waiting for a code. Start one with "Sign in to a Claude account".', 409);
  const clean = String(code ?? '').replace(/\s+/g, '');
  if (clean.length < 10) throw new StudioError('Paste the whole code Claude shows after you sign in (it has a # in the middle).');
  s.state = 'finishing';
  const from = s.out.length;
  s.child.stdin!.write(clean);
  await wait(400);
  s.child.stdin!.write('\r');
  const until = Date.now() + timeoutMs;
  let token: string | null = null;
  while (Date.now() < until && signin === s) {
    const m = TOKEN.exec(plain(s.out.slice(from)));
    if (m) { token = m[0]; break; }
    if (s.child.exitCode !== null) { const m2 = TOKEN.exec(plain(s.out.slice(from))); token = m2?.[0] ?? null; break; }
    await wait(150);
  }
  if (!token) {
    const why = `Claude didn't take the code: ${lastLines(s.out.slice(from))}`;
    endSignin('failed', why);
    throw new StudioError(why, 400);
  }
  const a = saveAccount(token, s.label, s.by, use);
  endSignin('done');
  return { account: view(a, read().active), ...listAccounts() };
}

export function cancelSignin() {
  if (signin && signin.state !== 'done' && signin.state !== 'failed') endSignin('failed', 'Cancelled.');
  signin = null;
  return listAccounts();
}
