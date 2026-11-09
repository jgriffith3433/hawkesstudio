// Subscription sign-ins for the AI coding CLIs that sign in with a device code (J, 2026-11-09: "Be able to sign into all
// AI coding agent providers with subscription usage like what we have with claude"):
//
//   Cursor          `agent login`                      Cursor's plan       a link (no code to type)
//   OpenAI Codex    `codex login --device-auth`        a ChatGPT plan      a link and a one-time code
//   GitHub Copilot  `copilot login --device-code`      a Copilot plan      a link and a one-time code
//
// (Antigravity signs in with Google's code pasted back: antigravity-login.ts. Gemini CLI takes no personal sign-ins any
// more, only an API key: docs/gemini.md.)
//
// J's click in Settings runs the CLI on the server in a pseudo-terminal (`script`) with a scratch home, reads the link and
// code it prints, and Settings shows them. J signs in on the provider's own page; the CLI notices by itself and exits.
// Studio then keeps the files it wrote in that home (ai-logins.ts, sealed, across restarts), puts them in <X>_CREDS for
// every pass it starts (the adapters in bin/ write them into the pass's home: bin/ai-login-seed.mjs), lifts a hold on that
// provider, and tells the page through the push stream (stream.ts topic "ai-logins"): nothing polls.
// Never shown: Settings sees signed in or not, the account the CLI names, and since when. Tests: STUDIO_CLI_SIGNIN_ARGS (a
// JSON object: provider -> [program, ...args]) runs a stand-in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { StudioError } from './config.ts';
import { plain } from './claude-accounts.ts';
import { forgetLogin, loadLogin, loginEnvValue, saveLogin, writeLoginFiles, type LoginFiles } from './ai-logins.ts';
// @ts-ignore: plain .mjs adapters, no types
import { agentBin } from '../bin/cursor-agent.mjs';
// @ts-ignore
import { copilotBin } from '../bin/copilot-agent.mjs';
// @ts-ignore
import { codexBin } from '../bin/codex-agent.mjs';

export type CliProvider = 'cursor' | 'codex' | 'copilot';
type Spec = {
  label: string;
  /** What the provider calls the plan it bills (shown in Settings). */
  plan: string;
  bin: () => string;
  args: string[];
  env?: Record<string, string>;
  /** Variables that would make the CLI sign in as something else (Copilot prefers a token in the environment). */
  strip?: string[];
  /** Home-relative folders or files that hold the login (only small files are kept; caches, logs and sessions aren't). */
  keep: string[];
  /** The environment variable the adapters seed the pass's home from (base64 JSON of the files). */
  envName: string;
  url: RegExp;
  code?: RegExp;
  /** Questions the CLI asks on the way, and the answer Studio types (Copilot: no keychain on a server). */
  answers?: { ask: RegExp; send: string }[];
};

export const CLI_PROVIDERS: Record<CliProvider, Spec> = {
  cursor: {
    label: 'Cursor', plan: 'your Cursor plan', bin: () => String(agentBin()), args: ['login'], env: { NO_OPEN_BROWSER: '1' },
    strip: ['CURSOR_API_KEY'], keep: ['.config/cursor', '.cursor/cli-config.json'], envName: 'CURSOR_CREDS',
    url: /https:\/\/[\w.-]*cursor\.(com|sh)\/[^\s"'<>│]*(login|auth|challenge)[^\s"'<>│]*/i,
  },
  codex: {
    label: 'OpenAI Codex', plan: 'your ChatGPT plan', bin: () => String(codexBin()),
    // Kept in ~/.codex/auth.json (not a keychain, which a server hasn't got), so Studio can keep it.
    args: ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
    strip: ['OPENAI_API_KEY', 'CODEX_API_KEY'], keep: ['.codex/auth.json', '.codex/config.toml'], envName: 'CODEX_CREDS',
    url: /https:\/\/auth\.openai\.com\/[^\s"'<>│]+/i,
    code: /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/,
  },
  copilot: {
    label: 'GitHub Copilot', plan: 'your Copilot plan', bin: () => String(copilotBin()), args: ['login', '--device-code'],
    strip: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'], keep: ['.copilot/config.json', '.copilot/hosts.json', '.copilot/apps.json'], envName: 'COPILOT_CREDS',
    url: /https:\/\/github\.com\/login\/device[^\s"'<>│]*/i,
    code: /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
    answers: [{ ask: /Store token in plain ?text config file\?/i, send: 'y\r' }],
  },
};
export const CLI_PROVIDER_IDS = Object.keys(CLI_PROVIDERS) as CliProvider[];
export const isCliProvider = (v: unknown): v is CliProvider => CLI_PROVIDER_IDS.includes(v as CliProvider);

/** Whether a CLI can be started here: a known path, or on PATH. */
export function cliInstalled(p: CliProvider): boolean {
  const bin = CLI_PROVIDERS[p].bin();
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

// ---------------------------------------------------------------- the kept login

const SKIP_DIR = /^(cache|caches|logs?|sessions?|history|chats|projects|pkg|tmp|node_modules|extensions|plugins|skills|worktrees|snapshots|shell_snapshots)$/i;
const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 256 * 1024;

/** The login files a CLI wrote in a home (small files under its `keep` paths). Exported for the tests. */
export function snapshotLogin(p: CliProvider, home: string): LoginFiles {
  const files: LoginFiles = {};
  let total = 0;
  const add = (abs: string, rel: string) => {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE || total + st.size > MAX_TOTAL) return;
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('\u0000')) return;
      files[rel] = text;
      total += st.size;
    } catch { /* gone */ }
  };
  const walk = (abs: string, rel: string, depth: number) => {
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isFile()) return add(abs, rel);
    if (!st.isDirectory() || depth > 3) return;
    for (const name of fs.readdirSync(abs)) {
      if (SKIP_DIR.test(name) || name.endsWith('.lock') || name.endsWith('.log')) continue;
      walk(path.join(abs, name), `${rel}/${name}`, depth + 1);
    }
  };
  for (const k of CLI_PROVIDERS[p].keep) walk(path.join(home, k), k, 0);
  return files;
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
/** The account a login names, when it says (Codex: the id token's email; Copilot: the GitHub login; Cursor: an email). */
export function accountOf(p: CliProvider, files: LoginFiles): string | null {
  for (const text of Object.values(files)) {
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (p === 'codex' && j?.tokens?.id_token) {
      try { const c = JSON.parse(Buffer.from(String(j.tokens.id_token).split('.')[1], 'base64url').toString('utf8')); if (c.email) return String(c.email); } catch { /* no claims */ }
    }
    if (p === 'copilot' && j) {
      const u = j.last_logged_in_user ?? (Array.isArray(j.logged_in_users) ? j.logged_in_users[0] : null);
      if (u?.login) return String(u.login);
    }
    if (j) {
      const m = EMAIL.exec(JSON.stringify(j.authInfo ?? j.user ?? j.account ?? {}));
      if (m) return m[0];
    }
  }
  return null;
}

/**
 * Every kept login in Studio's own environment (and home, for passes that run as Studio's user): <X>_CREDS for the
 * adapters. Called at start, after a sign-in and after a pass sent a refreshed login back. Returns the providers set.
 */
// The <X>_CREDS values this process set from a kept login (one set by the server's own environment, a secret, stays).
const shared = new Set<string>();
export function shareCliLogins(home = process.env.HOME || os.homedir()): CliProvider[] {
  const out: CliProvider[] = [];
  for (const p of CLI_PROVIDER_IDS) {
    const l = loadLogin(p);
    const name = CLI_PROVIDERS[p].envName;
    if (!l || !Object.keys(l.files).length) {
      if (shared.delete(name)) delete process.env[name];
      continue;
    }
    process.env[name] = loginEnvValue(l.files);
    shared.add(name);
    try { writeLoginFiles(l.files, home); } catch { /* a read-only home: the env value still works */ }
    out.push(p);
  }
  return out;
}

/**
 * A pass sent back the login files its CLI rewrote (a refreshed token: OpenAI's refresh tokens work once, so the next
 * pass needs the new one). Kept when they differ from the stored login and belong to the same provider's paths.
 */
export function keepRefreshedLogin(p: CliProvider, files: LoginFiles) {
  const cur = loadLogin(p);
  if (!cur) return false;
  const allowed = Object.fromEntries(Object.entries(files).filter(([rel]) => CLI_PROVIDERS[p].keep.some((k) => rel === k || rel.startsWith(`${k}/`))));
  const merged = { ...cur.files, ...allowed };
  if (JSON.stringify(merged) === JSON.stringify(cur.files)) return false;
  saveLogin(p, merged, { account: accountOf(p, merged) ?? cur.account, by: cur.by });
  shareCliLogins();
  return true;
}

// ---------------------------------------------------------------- sign in

type State = 'starting' | 'waiting' | 'done' | 'failed';
type Signin = { id: string; provider: CliProvider; started: number; child: ChildProcess; out: string; url: string | null; code: string | null; answered: Set<number>; state: State; error: string | null; timer: NodeJS.Timeout; tmp: string; moved: () => void };
const signins = new Map<CliProvider, Signin>();
const SIGNIN_MS = 15 * 60_000;

const notify = () => { void import('./stream.ts').then((s) => s.changed('ai-logins')).catch(() => {}); };

function view(s: Signin | undefined) {
  return s ? { id: s.id, state: s.state, url: s.url, code: s.code, error: s.error, started: s.started } : null;
}

/** What Settings shows for one provider. Never a token. */
export function cliLogin(p: CliProvider) {
  const l = loadLogin(p);
  const spec = CLI_PROVIDERS[p];
  return { provider: p, label: spec.label, plan: spec.plan, installed: cliInstalled(p), signedIn: Boolean(l), account: l?.account ?? null, since: l?.at ?? null, signin: view(signins.get(p)) };
}
export const cliLogins = () => CLI_PROVIDER_IDS.map(cliLogin);

function lastLines(out: string) {
  return plain(out).split('\n').map((l) => l.replace(/[│─╭╮╰╯]+/g, '').trim()).filter(Boolean).slice(-3).join(' / ').slice(0, 300) || 'nothing printed';
}

function end(s: Signin, state: 'done' | 'failed', error: string | null = null) {
  clearTimeout(s.timer);
  s.state = state;
  s.error = error;
  s.moved();
  try { s.child.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => fs.rmSync(s.tmp, { recursive: true, force: true }), 2000).unref();
  setTimeout(() => { if (signins.get(s.provider) === s) signins.delete(s.provider); }, 120_000).unref();
  notify();
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function command(p: CliProvider, tmp: string): { file: string; args: string[] } {
  if (process.env.STUDIO_CLI_SIGNIN_ARGS) {
    const all = JSON.parse(process.env.STUDIO_CLI_SIGNIN_ARGS) as Record<string, string[]>;
    if (all[p]) { const [file, ...args] = all[p]; return { file, args }; }
  }
  if (process.platform === 'win32') throw new StudioError(`Signing ${CLI_PROVIDERS[p].label} in runs on the cloud server (studio.hawkesgen.ai): its CLI needs a terminal, and this PC has no pseudo-terminal for Studio.`, 400);
  const spec = CLI_PROVIDERS[p];
  // A wide terminal so the link comes out on one line.
  return { file: 'script', args: ['-qfec', `stty cols 4000 rows 60; cd ${q(tmp)}; exec ${[spec.bin(), ...spec.args].map(q).join(' ')}`, '/dev/null'] };
}

/** The login a finished CLI left in its scratch home: kept, shared, the hold lifted. */
async function finish(s: Signin) {
  const files = snapshotLogin(s.provider, s.tmp);
  if (!Object.keys(files).length) {
    return end(s, 'failed', `${CLI_PROVIDERS[s.provider].label} said it signed in but left no login Studio can keep (${lastLines(s.out)}).`);
  }
  const account = accountOf(s.provider, files);
  saveLogin(s.provider, files, { account, by: 'Settings' });
  shareCliLogins();
  end(s, 'done');
  try {
    const { liftHold } = await import('./harness-hold.ts');
    liftHold(`signed in again from Settings${account ? ` as ${account}` : ''}`, s.provider);
  } catch { /* no hold */ }
}

/**
 * Starts a CLI's sign-in with a scratch home and resolves once it printed its link (and code). One per provider; a new
 * one replaces an old one. The rest comes through the push stream when the CLI exits.
 */
export async function startCliSignin(p: CliProvider, timeoutMs = 45_000) {
  if (!isCliProvider(p)) throw new StudioError('provider: cursor | codex | copilot');
  const spec = CLI_PROVIDERS[p];
  if (!process.env.STUDIO_CLI_SIGNIN_ARGS && process.platform !== 'win32' && !cliInstalled(p)) {
    throw new StudioError(`${spec.label}'s CLI isn't installed on this Studio's server, so it can't sign in here yet. Studio installs it with its next release; then sign in again. Meanwhile Studio keeps working on your other providers.`, 409);
  }
  const old = signins.get(p);
  if (old && (old.state === 'starting' || old.state === 'waiting')) end(old, 'failed', 'Replaced by a new sign-in.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `studio-${p}-`));
  const cmd = command(p, tmp);
  const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env, HOME: tmp, BROWSER: 'true', COLUMNS: '4000', LINES: '60', TERM: 'xterm-256color', NO_COLOR: '1', XDG_CONFIG_HOME: path.join(tmp, '.config'), XDG_DATA_HOME: path.join(tmp, '.local', 'share') };
  for (const k of spec.strip ?? []) delete env[k];
  delete env[spec.envName];
  delete env.CODEX_HOME;
  delete env.COPILOT_HOME;
  const child = spawn(cmd.file, cmd.args, { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Resolved when the sign-in leaves "starting" (its link is out, or it failed): no waiting loop.
  let moved = () => {};
  const left = new Promise<void>((r) => { moved = r; });
  const s: Signin = {
    id: `si_${crypto.randomBytes(5).toString('hex')}`, provider: p, started: Date.now(), child, out: '', url: null, code: null, answered: new Set(), state: 'starting', error: null, tmp, moved: () => moved(),
    timer: setTimeout(() => { if (signins.get(p) === s && (s.state === 'starting' || s.state === 'waiting')) end(s, 'failed', `The sign-in waited ${SIGNIN_MS / 60_000} minutes and was closed. Start again.`); }, SIGNIN_MS),
  };
  s.timer.unref?.();
  signins.set(p, s);
  const onData = (d: Buffer) => {
    s.out += d.toString('utf8');
    if (s.out.length > 200_000) s.out = s.out.slice(-100_000);
    const text = plain(s.out);
    (spec.answers ?? []).forEach((a, i) => {
      if (!s.answered.has(i) && a.ask.test(text)) { s.answered.add(i); setTimeout(() => s.child.stdin?.write(a.send), 200); }
    });
    if (!s.url) s.url = spec.url.exec(text)?.[0]?.replace(/[.,)]+$/, '') ?? null;
    if (spec.code && !s.code && s.url) s.code = spec.code.exec(text.slice(text.indexOf(s.url.slice(0, 30))))?.[1] ?? null;
    if (s.url && (!spec.code || s.code) && s.state === 'starting') { s.state = 'waiting'; s.moved(); notify(); }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  child.on('error', (e) => { if (signins.get(p) === s && s.state !== 'done' && s.state !== 'failed') end(s, 'failed', `Couldn't start ${spec.label}'s CLI: ${e.message}`); });
  child.on('close', (code) => {
    if (signins.get(p) !== s || s.state === 'done' || s.state === 'failed') return;
    if (code === 0 && s.url) return void finish(s).catch((e) => end(s, 'failed', `Signed in, but Studio couldn't keep the login: ${e?.message ?? e}`));
    end(s, 'failed', `${spec.label} stopped before the sign-in finished: ${lastLines(s.out)}`);
  });
  let late: NodeJS.Timeout | undefined;
  await Promise.race([left, new Promise<void>((r) => { late = setTimeout(r, timeoutMs); })]);
  clearTimeout(late);
  if (s.state === 'starting') {
    const why = `No sign-in link from ${spec.label}: ${lastLines(s.out)}`;
    end(s, 'failed', why);
    throw new StudioError(why, 502);
  }
  if (s.state === 'failed') throw new StudioError(s.error ?? 'The sign-in failed.', 502);
  return cliLogin(p);
}

export function cancelCliSignin(p: CliProvider) {
  const s = signins.get(p);
  if (s && (s.state === 'starting' || s.state === 'waiting')) end(s, 'failed', 'Cancelled.');
  signins.delete(p);
  return cliLogin(p);
}

/** Forgets a provider's kept login (Settings, "Sign out"): passes stop getting it; the harness reads as not set up. */
export function signOutCli(p: CliProvider) {
  forgetLogin(p);
  delete process.env[CLI_PROVIDERS[p].envName];
  notify();
  return cliLogin(p);
}
