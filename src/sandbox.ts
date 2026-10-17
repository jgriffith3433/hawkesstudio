// The agent sandbox: Talk, agents and scouts run as their own Linux user (HAWKES_AGENT_USER, "hawkes-agent") with no
// secrets in their environment, no read access to Studio's and Gen's data and keys, and no instance metadata (the
// server's IAM role): docs/agents.md, "The guards". Studio itself stays the "hawkes" user.
//
// requestUser(): which Linux user opened a loopback connection to Studio, from /proc/net/tcp (the client socket's
// owner). A request from the sandbox is never J's, whatever its headers say, so a shell can't talk its way past the
// guards (memory-api.ts callerOf, guards.ts).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import type http from 'node:http';
import type net from 'node:net';
import { PROJECTS } from './config.ts';

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
 */
export function shareWorktree(wt: string) {
  if (!sandboxOn()) return;
  const r = spawnSync('git', ['-C', wt, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
  const gitDir = (r.stdout ?? '').trim();
  if (r.status !== 0 || !gitDir || !/[\\/]worktrees[\\/]/.test(gitDir)) return;
  for (const [cmd, args] of [['chgrp', ['-R', AGENT_GROUP, gitDir]], ['chmod', ['-R', 'g+rwX', gitDir]], ['find', [gitDir, '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+']]] as const) {
    const x = spawnSync(cmd, [...args], { encoding: 'utf8' });
    if (x.status !== 0) console.warn(`[sandbox] ${cmd} on ${gitDir}: ${(x.stderr ?? '').trim().slice(0, 200)}`);
  }
}

/**
 * What a sandboxed Claude Code gets from Studio's environment: nothing secret but its own Claude login (it can't run
 * without it), no AWS role marker, no GitHub token, no service keys. Its Gen key is in its MCP config, not here.
 */
const PASS = /^(PATH|LANG|LC_\w+|TZ|TERM|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|HAWKESGEN_URL|GEN_PUBLIC_URL|STUDIO_PORT|STUDIO_SERVER|STUDIO_PUBLIC_URL|TALK_\w+|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_\w+|DISABLE_\w+|npm_config_cache)$/;
export function sandboxEnv(env: NodeJS.ProcessEnv) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && PASS.test(k)) out[k] = v;
  // Claude Code prefers the API key when both are set (claude.ts); the subscription token wins.
  if (out.CLAUDE_CODE_OAUTH_TOKEN) delete out.ANTHROPIC_API_KEY;
  out.HOME = process.env.HAWKES_AGENT_HOME ?? `/srv/hawkes-agent`;
  // One npm cache for every agent, check and workspace (deploy/agent-sandbox.mjs makes it), so installs are offline-fast.
  if (process.env.STUDIO_NPM_CACHE) out.npm_config_cache = process.env.STUDIO_NPM_CACHE;
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
export function claudeCommand(args: string[], { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }) {
  const exe = process.env.TALK_CLAUDE || 'claude';
  const pre: string[] = process.env.TALK_CLAUDE_ARGS ? JSON.parse(process.env.TALK_CLAUDE_ARGS) : [];
  if (!sandboxOn() || pre.length) return { file: exe, args: [...pre, ...args], cwd, env };
  const clean = sandboxEnv(env);
  const keep = Object.keys(clean).filter((k) => k !== 'HOME' && k !== 'PATH');
  return { file: 'sudo', args: ['-n', '-u', process.env.HAWKES_AGENT_USER!, `--preserve-env=${keep.join(',')}`, WRAPPER, path.resolve(cwd), exe, ...args], cwd, env: clean };
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
 */
export function sandboxSpawn(file: string, args: string[], opts: SpawnOptions & { cwd: string }): ChildProcess {
  if (!sandboxOn()) return spawn(file, args, { windowsHide: true, ...opts });
  const clean = sandboxEnv(opts.env ?? process.env);
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
  const uid = agentUid();
  if (uid === null) return null;
  const sock = req.socket;
  if (!seen.has(sock)) seen.set(sock, peerUid(sock));
  return seen.get(sock) === uid ? 'agent' : 'other';
}
