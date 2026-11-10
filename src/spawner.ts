// Commands started by a small helper process instead of by Studio itself (src/spawner-child.mjs says why: a fork of a
// big process blocks its main thread for tens of milliseconds). spawnLight() behaves like child_process.spawn for what
// Studio's git runner uses: stdout/stderr 'data', 'error', 'close' (code, signal) and kill(). When the helper can't run
// (it died, or STUDIO_SPAWNER=off) a command is started directly, as before.

import { fork, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LightChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: NodeJS.Signals) => void };
type Opts = { cwd?: string; env?: NodeJS.ProcessEnv };

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spawner-child.mjs');
let helper: ChildProcess | null = null;
let ready = false;
let nextId = 1;
const live = new Map<number, LightChild>();
/** What ran where (tests, studio_ops): through the helper, or directly. */
export const spawnerStats = { viaHelper: 0, direct: 0, helperStarts: 0 };

const off = () => process.env.STUDIO_SPAWNER === 'off';

function startHelper() {
  if (helper || off()) return;
  try {
    spawnerStats.helperStarts++;
    const h = fork(CHILD, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [], windowsHide: true });
    helper = h;
    h.on('message', (m: any) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ready') { ready = true; return; }
      const c = live.get(m.id);
      if (!c) return;
      if (m.t === 'out') c.stdout.emit('data', Buffer.from(m.d));
      else if (m.t === 'err') c.stderr.emit('data', Buffer.from(m.d));
      else if (m.t === 'error') c.emit('error', new Error(m.message));
      else if (m.t === 'close') { live.delete(m.id); c.emit('close', m.code, m.signal); }
    });
    const gone = () => {
      if (helper !== h) return;
      helper = null;
      ready = false;
      // Commands it was running are lost with it: each ends as failed (git's callers retry or report).
      for (const [id, c] of live) {
        live.delete(id);
        c.emit('error', new Error('the spawner stopped'));
        c.emit('close', null, 'SIGKILL');
      }
    };
    h.on('exit', gone);
    h.on('error', gone);
    // It never keeps Studio running by itself.
    h.unref();
    (h as any).channel?.unref?.();
  } catch {
    helper = null;
  }
}

/** Starts the helper early (server start-up), while Studio is still small and its own one fork is cheap. */
export function startSpawner() {
  startHelper();
}

/** Like spawn(cmd, args, { cwd, env }) with piped output, started by the helper once it is up. */
export function spawnLight(cmd: string, args: string[], opts: Opts = {}): LightChild {
  startHelper();
  if (!helper || !ready || !helper.connected) {
    spawnerStats.direct++;
    return spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as LightChild;
  }
  const id = nextId++;
  const c = new EventEmitter() as LightChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = (signal: NodeJS.Signals = 'SIGTERM') => { try { helper?.send({ t: 'kill', id, signal }); } catch { /* gone: close comes from gone() */ } };
  live.set(id, c);
  spawnerStats.viaHelper++;
  // Ref'd while a command runs (Studio waits for its own commands), unref'd when none do.
  helper.ref();
  (helper as any).channel?.ref?.();
  c.once('close', () => {
    if (!live.size && helper) { helper.unref(); (helper as any).channel?.unref?.(); }
  });
  try {
    helper.send({ t: 'spawn', id, cmd, args, cwd: opts.cwd, env: opts.env ?? process.env });
  } catch (e: any) {
    live.delete(id);
    queueMicrotask(() => { c.emit('error', e); c.emit('close', null, null); });
  }
  return c;
}

/** Stops the helper (tests). */
export function stopSpawner() {
  const h = helper;
  helper = null;
  ready = false;
  try { h?.kill(); } catch { /* gone */ }
}
