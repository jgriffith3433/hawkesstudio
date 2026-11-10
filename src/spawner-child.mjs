// The spawner (src/spawner.ts): a small process that starts commands for Studio and streams their output back.
//
// Starting a process from Studio itself forks Studio, and a fork copies the page tables of its whole memory on the main
// thread: about 3 ms at 10 MB, over 30 ms at 1.5 GB (measured 2026-11-10). With 12 agents' git commands that was
// 600+ ms of each event-loop freeze. This process stays small, so its forks are cheap, and Studio never waits on one.
// Plain JavaScript with no imports from Studio, so it starts fast and holds almost nothing.

import { spawn } from 'node:child_process';

const children = new Map();
const send = (m) => { try { process.send?.(m); } catch { /* Studio went away: we exit on disconnect */ } };
// A send that lands after Studio is gone fails later, as an 'error' on the process: the same case, not a crash.
process.on('error', () => {});

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'spawn') {
    let child;
    try {
      child = spawn(m.cmd, m.args, { cwd: m.cwd, env: m.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      send({ t: 'error', id: m.id, message: String(e?.message ?? e) });
      send({ t: 'close', id: m.id, code: null, signal: null });
      return;
    }
    children.set(m.id, child);
    child.stdout.on('data', (d) => send({ t: 'out', id: m.id, d }));
    child.stderr.on('data', (d) => send({ t: 'err', id: m.id, d }));
    child.on('error', (e) => send({ t: 'error', id: m.id, message: String(e?.message ?? e) }));
    child.on('close', (code, signal) => {
      children.delete(m.id);
      send({ t: 'close', id: m.id, code, signal });
    });
  } else if (m.t === 'kill') {
    try { children.get(m.id)?.kill(m.signal || 'SIGTERM'); } catch { /* already gone */ }
  }
});

// Studio stopped: its commands go with it.
process.on('disconnect', () => {
  for (const c of children.values()) try { c.kill('SIGKILL'); } catch { /* gone */ }
  process.exit(0);
});
send({ t: 'ready' });
