// The agent sandbox: Talk, agents and scouts run as their own Linux user (HAWKES_AGENT_USER, "hawkes-agent") with no
// secrets in their environment, no read access to Studio's and Gen's data and keys, and no instance metadata (the
// server's IAM role): docs/agents.md, "The guards". Studio itself stays the "hawkes" user.
//
// requestUser(): which Linux user opened a loopback connection to Studio, from /proc/net/tcp (the client socket's
// owner). A request from the sandbox is never J's, whatever its headers say, so a shell can't talk its way past the
// guards (memory-api.ts callerOf, guards.ts).

import fs from 'node:fs';
import type http from 'node:http';
import type net from 'node:net';

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
