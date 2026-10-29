// The agent sandbox: Talk, agents and scouts run as their own Linux user (HAWKES_AGENT_USER, "hawkes-agent") with no
// secrets in their environment, no read access to Studio's and Gen's data and keys, and no instance metadata (the
// server's IAM role): docs/agents.md, "The guards". Studio itself stays the "hawkes" user.
//
// requestUser(): which Linux user opened a loopback connection to Studio, from /proc/net/tcp (the client socket's
// owner). A request from the sandbox is never J's, whatever its headers say, so a shell can't talk its way past the
// guards (memory-api.ts callerOf, guards.ts).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import type http from 'node:http';
import type net from 'node:net';
import { PROJECTS } from './config.ts';
import { runCommand } from './ops.ts';
import { brainId, ANTIGRAVITY_AGENT, COPILOT_AGENT, CURSOR_AGENT, GEMINI_AGENT } from './brains.ts';
import { modelPin } from './routing.ts';
import { cloudMode, agentKey } from './cloudauth.ts';

/** The wrapper deploy/agent-sandbox.mjs installs: it runs a command as the sandbox user with its own HOME and umask. */
export const WRAPPER = '/usr/local/bin/hawkes-agent-run';
/** The sandbox is on when the server has its user and wrapper (deploy/agent-sandbox.mjs) and nobody turned it off. */
export function sandboxOn() {
  return process.platform === 'linux' && Boolean(process.env.HAWKES_AGENT_USER) && process.env.HAWKES_SANDBOX !== 'off' && fs.existsSync(WRAPPER);
}

/** The group the sandbox user shares with Studio (deploy/agent-sandbox.mjs): what agents may write is in it. */
export const AGENT_GROUP = process.env.HAWKES_AGENT_GROUP || 'hawkes-work';

/**
 * Lets the sandbox user commit in a worktree Studio made for it: the worktree's git folder (<repo>/.git/worktrees/<name>,
 * where index.lock and HEAD live) goes to the agent group, group-writable, setgid. Studio (user hawkes) creates it with
 * the group of .git/worktrees, and git deletes and recreates that folder whenever the last worktree is pruned, so a
 * one-time chgrp at setup doesn't last: on 2026-10-16 agents in breakingthrough, hawkesgen and YoobaLand finished their
 * work and then couldn't commit (index.lock: Permission denied). Call it after every worktree an agent or Talk works in.
 *
 * Without blocking Studio (async fs and git), and only what needs it: Studio's own files that aren't shared yet (the
 * sandbox user's files are already the group's, and Studio may not change them: the "Operation not permitted" flood a
 * chgrp -R at every start used to log). "already": nothing needed changing; "skipped": not a worktree, or no sandbox.
 */
export async function shareWorktree(wt: string, group: string | null = sandboxOn() ? AGENT_GROUP : null): Promise<'shared' | 'already' | 'skipped'> {
  if (!group || process.platform === 'win32') return 'skipped';
  const gid = gidOf(group);
  if (gid === null) return 'skipped';
  const r = await runCommand('git', ['-C', wt, 'rev-parse', '--absolute-git-dir', '--git-common-dir'], { timeoutMs: 30_000 });
  const [gitDir, common] = r.out.split('\n').map((s) => s.trim());
  if (!r.ok || !gitDir || !/[\\/]worktrees[\\/]/.test(gitDir)) return 'skipped';
  // The repo first, so worktrees made later are right from the start; then this one, made before or by Studio's umask.
  const repo = common ? await shareRepo(path.dirname(path.resolve(wt, common)), group) : 'already';
  const changed = await shareTree(gitDir, gid);
  return repo === 'shared' || changed ? 'shared' : 'already';
}

/**
 * The cause behind shareWorktree, for the whole repo: git's core.sharedRepository=group makes every file and folder git
 * creates in .git group-writable (folders setgid) whatever the creating process's umask, and .git and .git/worktrees go
 * to the agent group, setgid, so the .git/worktrees git recreates after the last worktree is pruned (and every
 * worktree's own folder under it) is the agent group's too. Only git's own folder: the checkout's files are untouched.
 */
export async function shareRepo(repoDir: string, group: string | null = sandboxOn() ? AGENT_GROUP : null): Promise<'shared' | 'already' | 'skipped'> {
  if (!group || process.platform === 'win32') return 'skipped';
  const gid = gidOf(group);
  if (gid === null) return 'skipped';
  const dotGit = path.join(repoDir, '.git');
  try { if (!(await fs.promises.stat(dotGit)).isDirectory()) return 'skipped'; } catch { return 'skipped'; }
  let changed = false;
  const cfg = await runCommand('git', ['-C', repoDir, 'config', '--local', '--get', 'core.sharedRepository'], { timeoutMs: 30_000 });
  if (cfg.out !== 'group') {
    const set = await runCommand('git', ['-C', repoDir, 'config', '--local', 'core.sharedRepository', 'group'], { timeoutMs: 30_000 });
    if (!set.ok) console.warn(`[sandbox] git config on ${dotGit}: ${set.err.slice(0, 200)}`);
    changed = true;
  }
  if (await shareEntry(dotGit, gid, 0o2000)) changed = true;
  if (await shareEntry(path.join(dotGit, 'worktrees'), gid, 0o2070)) changed = true;
  // What agents write when they commit: objects, refs, reflogs. deploy/agent-sandbox.mjs shares these for every repo there
  // at setup; a repo Studio clones later (a product added after: the portal, 2026-10-23, whose agents' commits failed with
  // "insufficient permission for adding an object") comes with them as Studio's group. Whole, once: a folder that is
  // already the agent group's, setgid and group-writable is left alone (a stat each on every later pass).
  for (const sub of ['objects', 'refs', 'logs', 'lfs']) {
    const d = path.join(dotGit, sub);
    let st: fs.Stats;
    try { st = await fs.promises.stat(d); } catch { continue; }
    if (st.gid !== gid || (st.mode & 0o2070) !== 0o2070) { if (await shareTree(d, gid)) changed = true; }
  }
  return changed ? 'shared' : 'already';
}

/** The numeric id of a group (a number, or a name in /etc/group); null when it's unknown here. */
export function gidOf(group: string): number | null {
  if (/^\d+$/.test(group)) return Number(group);
  try {
    const row = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.split(':')[0] === group);
    const id = row?.split(':')[2];
    return id && /^\d+$/.test(id) ? Number(id) : null;
  } catch {
    return null;
  }
}

/**
 * One file or folder to the group with `bits` (folders: setgid, group rwx; files: group rw) if Studio owns it and it
 * isn't already; true when it changed something. Anything Studio can't change is left alone, quietly.
 */
async function shareEntry(p: string, gid: number, bits?: number): Promise<boolean> {
  let st: fs.Stats;
  try { st = await fs.promises.lstat(p); } catch { return false; }
  if (st.isSymbolicLink() || st.uid !== process.getuid?.()) return false;
  const want = bits ?? (st.isDirectory() ? 0o2070 : 0o060 | (st.mode & 0o100 ? 0o010 : 0));
  let changed = false;
  try {
    if (st.gid !== gid) { await fs.promises.lchown(p, st.uid, gid); changed = true; }
    // chown clears setgid on some systems: the mode is set after it, from what it was.
    if ((st.mode & want) !== want || changed) { await fs.promises.chmod(p, (st.mode & 0o7777) | want); changed = true; }
  } catch { /* not ours to change after all */ }
  return changed;
}

/** A git folder and everything in it (a worktree's: a few dozen files), entry by entry; true when anything changed. */
async function shareTree(dir: string, gid: number): Promise<boolean> {
  let changed = await shareEntry(dir, gid);
  let names: fs.Dirent[] = [];
  try { names = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return changed; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (await shareTree(p, gid)) changed = true; }
    else if (await shareEntry(p, gid)) changed = true;
  }
  return changed;
}

/**
 * Every repo in the projects folder and every worktree in .work, once after start (server.ts, in the background):
 * repos and worktrees made before this. One at a time, async: the server keeps answering, and ones already shared
 * cost a stat or two each. Returns how many were changed and how many were already shared.
 */
export async function shareAll(group: string | null = sandboxOn() ? AGENT_GROUP : null) {
  const out = { shared: 0, already: 0 };
  if (!group) return out;
  const count = (r: string) => { if (r === 'shared') out.shared++; else if (r === 'already') out.already++; };
  const list = async (dir: string) => { try { return (await fs.promises.readdir(dir)).filter((n) => !n.startsWith('.')).map((n) => path.join(dir, n)); } catch { return []; } };
  for (const d of await list(PROJECTS)) count(await shareRepo(d, group));
  // An agent can write its worktree's ".git" file: only one still linking into a repo here is touched (assertWorktree).
  const projects = await fs.promises.realpath(PROJECTS).catch(() => PROJECTS);
  const repoOf = async (d: string) => {
    try {
      const link = (await fs.promises.readFile(path.join(d, '.git'), 'utf8')).trim().replace(/^gitdir:\s*/, '');
      const gitdir = await fs.promises.realpath(path.resolve(d, link));
      const m = gitdir.slice(projects.length).match(/^[\\/]([^\\/]+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
      return gitdir.startsWith(projects) && m ? m[1] : null;
    } catch { return null; }
  };
  for (const d of await list(path.join(PROJECTS, '.work'))) if (await repoOf(d)) count(await shareWorktree(d, group));
  return out;
}

/**
 * What a sandboxed Claude Code gets from Studio's environment: nothing secret but its own Claude login (it can't run
 * without it), no AWS role marker, no GitHub token, no service keys. Its Gen key is in its MCP config, not here.
 */
const PASS = /^(PATH|LANG|LC_\w+|TZ|TERM|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|HAWKESGEN_URL|GEN_PUBLIC_URL|STUDIO_PORT|STUDIO_SERVER|STUDIO_PUBLIC_URL|TALK_\w+|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|XAI_API_KEY|CURSOR_API_KEY|CURSOR_AGENT|COPILOT_GITHUB_TOKEN|COPILOT_HOME|COPILOT_BIN|COPILOT_MODEL|COPILOT_EFFORT|COPILOT_MAX_CREDITS|COPILOT_CONTEXT|GEMINI_API_KEY|GEMINI_OAUTH_CREDS|GEMINI_BIN|GEMINI_CLI_HOME|AGY_BIN|AGY_CREDS|AGY_MODEL|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|GROK_SESSION_DIR|HAWKES_BRAIN|CLAUDE_CODE_\w+|DISABLE_\w+|npm_config_cache)$/;
export function sandboxEnv(env: NodeJS.ProcessEnv) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && PASS.test(k)) out[k] = v;
  // Claude Code prefers the API key when both are set (claude.ts); the subscription token wins.
  if (out.CLAUDE_CODE_OAUTH_TOKEN) delete out.ANTHROPIC_API_KEY;
  out.HOME = process.env.HAWKES_AGENT_HOME ?? `/srv/hawkes-agent`;
  // One npm cache for every agent, check and workspace (deploy/agent-sandbox.mjs makes it), so installs are offline-fast.
  if (process.env.STUDIO_NPM_CACHE) out.npm_config_cache = process.env.STUDIO_NPM_CACHE;
  // No browser on the control server (J, 2026-10-17): agents' own headless Chrome (about 300 MB each, plus CPU) helped
  // take Studio and Gen down. Playwright finds no browser here and can't download one; a browser check of a game is a
  // playtest on the T4 (studio_playtest), asked for. The roles say so too (.claude/agents).
  out.PLAYWRIGHT_BROWSERS_PATH = '/proc/hawkes-no-browsers';
  out.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  return out as NodeJS.ProcessEnv;
}

/**
 * Starts Claude Code (TALK_CLAUDE or "claude"). In the sandbox: as HAWKES_AGENT_USER through sudo and the wrapper
 * (sudoers lets the Studio user run only that, as only that user, passing only the variables named here), with the
 * filtered environment. Elsewhere (J's PC, a server without the sandbox): as Studio's own user, like before.
 */
export function spawnClaude(args: string[], { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  const c = claudeCommand(args, { cwd, env });
  return spawn(c.file, c.args, { cwd: c.cwd, env: c.env, windowsHide: true });
}

/**
 * The command spawnClaude runs (file, arguments, folder, environment), for starting it outside Studio (detach.ts) with
 * the same user and environment. TALK_CLAUDE_ARGS (a JSON array before Claude Code's own arguments): tests run a
 * stand-in script with node, never in the sandbox.
 */
/** Cursor replaces the Claude Code executable. Tests that set TALK_CLAUDE or TALK_CLAUDE_ARGS keep their stand-in. */
function brainCommand(args: string[], forceClaude = false) {
  const exe = process.env.TALK_CLAUDE || 'claude';
  const pre: string[] = process.env.TALK_CLAUDE_ARGS ? JSON.parse(process.env.TALK_CLAUDE_ARGS) : [];
  // The fallback (llm.ts) is real Claude Code on J's Max plan whatever the brain is: when the brain is Cursor and
  // Cursor is down (an unpaid invoice, 2026-10-20), falling back to "the brain" just failed the same way again.
  if (forceClaude) return { file: exe, args: [...pre, ...args] };
  const brain = brainId();
  // The pinned model (Settings), unless routing picks each run's model (routing.ts modelPin).
  const model = modelPin();
  const mapped = model ? args.map((a, i, all) => (all[i - 1] === '--model' ? model : a)) : args;
  if (pre.length || process.env.TALK_CLAUDE || brain === 'claude') return { file: exe, args: [...pre, ...mapped] };
  return { file: process.execPath, args: [brain === 'copilot' ? COPILOT_AGENT : brain === 'gemini' ? GEMINI_AGENT : brain === 'antigravity' ? ANTIGRAVITY_AGENT : CURSOR_AGENT, ...mapped] };
}

export function claudeCommand(args: string[], { cwd, env, brain }: { cwd: string; env: NodeJS.ProcessEnv; brain?: 'claude' }) {
  const cmd = brainCommand(args, brain === 'claude');
  if (!sandboxOn() || process.env.TALK_CLAUDE_ARGS) return { file: cmd.file, args: cmd.args, cwd, env };
  const clean = sandboxEnv(env);
  const keep = Object.keys(clean).filter((k) => k !== 'HOME' && k !== 'PATH');
  return { file: 'sudo', args: ['-n', '-u', process.env.HAWKES_AGENT_USER!, `--preserve-env=${keep.join(',')}`, WRAPPER, path.resolve(cwd), cmd.file, ...cmd.args], cwd, env: clean };
}

/**
 * A shell command (an agent change's checks, npm ci) as the sandbox user when it's on: agent-written code (tests,
 * package scripts) never runs as Studio's user, which can read the keys. Elsewhere: a plain shell, like before.
 */
export function spawnShell(cmd: string, { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  if (!sandboxOn()) return spawn(cmd, { cwd, env, shell: true, windowsHide: true });
  return sandboxSpawn('/bin/sh', ['-c', cmd], { cwd, env }) as ChildProcessWithoutNullStreams;
}

/**
 * Any program that runs code from an agent's worktree (a dev server for its verification playtest, a preview build)
 * as the sandbox user, with spawn's own options (detached, stdio). No Claude login, no secrets. Off: a plain spawn.
 * own: variables the program needs that the sandbox's filter would drop (an app server's port, data folder and its own
 * scoped Gen key: apps.ts), added after the filter.
 */
export function sandboxSpawn(file: string, args: string[], { own, ...opts }: SpawnOptions & { cwd: string; own?: Record<string, string> }): ChildProcess {
  if (!sandboxOn()) return spawn(file, args, { windowsHide: true, ...opts, ...(own ? { env: { ...(opts.env ?? process.env), ...own } } : {}) });
  const clean = { ...sandboxEnv(opts.env ?? process.env), ...own };
  delete clean.CLAUDE_CODE_OAUTH_TOKEN;
  delete clean.ANTHROPIC_API_KEY;
  const keep = Object.keys(clean).filter((k) => k !== 'HOME' && k !== 'PATH');
  return spawn('sudo', ['-n', '-u', process.env.HAWKES_AGENT_USER!, `--preserve-env=${keep.join(',')}`, WRAPPER, path.resolve(opts.cwd), file, ...args], { ...opts, env: clean, windowsHide: true, shell: false });
}

/**
 * Before Studio runs git in a worktree the sandbox could write: its ".git" file must still point into the repo's own
 * worktrees (a ".git" repointed at a repository the agent made would run that repository's hooks and config as
 * Studio). Throws otherwise.
 */
export function assertWorktree(worktree: string, repoDir: string) {
  if (!sandboxOn()) return;
  const gitFile = path.join(worktree, '.git');
  let text = '';
  try {
    if (!fs.lstatSync(gitFile).isFile()) throw new Error('not a file');
    text = fs.readFileSync(gitFile, 'utf8').trim();
  } catch (e: any) {
    throw new Error(`${worktree}: its .git is not a worktree link (${e.message}); not running git there`);
  }
  const gitdir = path.resolve(worktree, text.replace(/^gitdir:\s*/, ''));
  const expected = path.join(fs.realpathSync(repoDir), '.git', 'worktrees') + path.sep;
  if (!fs.realpathSync(gitdir).startsWith(expected)) throw new Error(`${worktree}: its .git points outside ${repoDir}'s worktrees; not running git there`);
}

/** Where files the sandbox must read live (MCP configs, Talk's attachments): inside the shared work folder. */
export function sandboxShare(...parts: string[]) {
  const dir = path.join(PROJECTS, '.work', '.agent', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const agentUid = () => {
  const v = process.env.HAWKES_AGENT_UID;
  return v && /^\d+$/.test(v) ? Number(v) : null;
};

/** The uid that owns the client end of a loopback TCP connection (Linux), or null when it can't be told. */
export function peerUid(sock: net.Socket): number | null {
  if (process.platform !== 'linux') return null;
  const rport = sock.remotePort;
  const lport = sock.localPort;
  if (!rport || !lport) return null;
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const row of text.split('\n').slice(1)) {
      const f = row.trim().split(/\s+/);
      if (f.length < 8) continue;
      // The client's socket: its local port is our remote port, its remote port is ours.
      if (f[1].endsWith(`:${hex(rport)}`) && f[2].endsWith(`:${hex(lport)}`)) return Number(f[7]);
    }
  }
  return null;
}

const seen = new WeakMap<net.Socket, number | null>();
/** "agent" when the request comes from the sandbox user, "other" otherwise, null when the sandbox isn't set up here. */
export function requestUser(req: http.IncomingMessage): 'agent' | 'other' | null {
  // On Cloud Run the agents and Talk are jobs, their own sandbox, and reach Studio over HTTPS with the agents' key
  // (cloudauth.ts): that key is the sandbox user there, whatever else the request says.
  if (cloudMode()) return agentKey(req) ? 'agent' : 'other';
  const uid = agentUid();
  if (uid === null) return null;
  const sock = req.socket;
  if (!seen.has(sock)) seen.set(sock, peerUid(sock));
  return seen.get(sock) === uid ? 'agent' : 'other';
}
