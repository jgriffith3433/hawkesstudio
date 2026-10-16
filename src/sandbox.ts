// The agent sandbox: Talk, agents and scouts run as their own Linux user (HAWKES_AGENT_USER, "hawkes-agent") with no
// secrets in their environment, no read access to Studio's and Gen's data and keys, and no instance metadata (the
// server's IAM role): docs/agents.md, "The guards". Studio itself stays the "hawkes" user.
//
// requestUser(): which Linux user opened a loopback connection to Studio, from /proc/net/tcp (the client socket's
// owner). A request from the sandbox is never J's, whatever its headers say, so a shell can't talk its way past the
// guards (memory-api.ts callerOf, guards.ts).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type http from 'node:http';
import type net from 'node:net';

/** The wrapper deploy/agent-sandbox.mjs installs: it runs a command as the sandbox user with its own HOME and umask. */
export const WRAPPER = '/usr/local/bin/hawkes-agent-run';
/** The sandbox is on when the server has its user and wrapper (deploy/agent-sandbox.mjs) and nobody turned it off. */
export function sandboxOn() {
  return process.platform === 'linux' && Boolean(process.env.HAWKES_AGENT_USER) && process.env.HAWKES_SANDBOX !== 'off' && fs.existsSync(WRAPPER);
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
  return out as NodeJS.ProcessEnv;
}

/**
 * Starts Claude Code (TALK_CLAUDE or "claude"). In the sandbox: as HAWKES_AGENT_USER through sudo and the wrapper
 * (sudoers lets the Studio user run only that, as only that user, passing only the variables named here), with the
 * filtered environment. Elsewhere (J's PC, a server without the sandbox): as Studio's own user, like before.
 */
export function spawnClaude(args: string[], { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  const exe = process.env.TALK_CLAUDE || 'claude';
  if (!sandboxOn()) return spawn(exe, args, { cwd, env, windowsHide: true });
  const clean = sandboxEnv(env);
  const keep = Object.keys(clean).filter((k) => k !== 'HOME' && k !== 'PATH');
  return spawn('sudo', ['-n', '-u', process.env.HAWKES_AGENT_USER!, `--preserve-env=${keep.join(',')}`, WRAPPER, path.resolve(cwd), exe, ...args], { cwd, env: clean, windowsHide: true });
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
