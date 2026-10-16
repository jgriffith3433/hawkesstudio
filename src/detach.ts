// Work that outlives Studio: a deploy restarts Studio in seconds, so the long processes it starts (agents' and Talk's
// Claude Code) run outside its process and its systemd cgroup, and Studio reattaches to them after a restart.
//
// On the server each one is a transient unit of the hawkes user's own systemd manager (systemd-run --user, which needs
// "loginctl enable-linger hawkes": deploy.mjs and hawkes-pull.mjs make sure of it), so restarting hawkes-studio never
// touches it. The unit runs bin/detached-run.mjs, which starts exactly the command Studio would have spawned itself
// (sandbox.ts claudeCommand: the sandbox user, the filtered environment, unchanged) with its stdout and stderr going to
// files in .data/detached/, and writes the exit code next to them. Studio reads those files as if they were the
// process's pipes (DetachedChild); after a restart it reads them again from where it had got to.
//
// STUDIO_DETACH: unset = systemd when the user manager answers, else inside Studio (J's PC: no systemd, today's spawn);
// "process" = a detached plain process instead of a unit (tests, and Windows); "off" = always inside Studio.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { DATA, ROOT } from './config.ts';

export type DetachMode = 'systemd' | 'process';
/** What Studio records (on a change, a conversation) to find a detached process again. */
export type DetachRec = { unit: string; mode: DetachMode; pid?: number; started: number };
export type DetachSpec = { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
/** What Studio's code needs of a process: a ChildProcess, or a DetachedChild that reads one's files. */
export type ChildLike = {
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

const RUNNER = path.join(ROOT, 'bin', 'detached-run.mjs');
export const DETACH_DIR = () => path.join(DATA, 'detached');
const file = (unit: string, ext: string) => path.join(DETACH_DIR(), `${unit}.${ext}`);

/** systemctl --user needs the user manager's runtime folder (a service has no login session to set it). */
function userEnv() {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && process.getuid) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return env;
}
const systemctl = (...args: string[]) => spawnSync('systemctl', ['--user', ...args], { env: userEnv(), encoding: 'utf8', timeout: 10_000 });

let userManager: { ok: boolean; at: number } | null = null;
/** Whether this user's systemd manager answers (yes is remembered; no is looked at again after a minute). */
function systemdUser() {
  if (process.platform !== 'linux') return false;
  if (userManager && (userManager.ok || Date.now() - userManager.at < 60_000)) return userManager.ok;
  userManager = { ok: systemctl('show-environment').status === 0, at: Date.now() };
  return userManager.ok;
}

/** How long work started now would survive a restart: as a systemd unit, a detached process, or not at all (null). */
export function detachMode(): DetachMode | null {
  const want = process.env.STUDIO_DETACH;
  if (want === 'off') return null;
  if (want === 'process') return 'process';
  return systemdUser() ? 'systemd' : null;
}

/** Starts a command outside Studio. Throws when it couldn't be started that way (the caller runs it inside instead). */
export function startDetached(name: string, spec: DetachSpec, mode: DetachMode): DetachRec {
  fs.mkdirSync(DETACH_DIR(), { recursive: true, mode: 0o700 });
  const unit = `hawkes-${name.replace(/[^A-Za-z0-9_.-]/g, '-')}-${Date.now().toString(36)}`;
  // The spec holds the environment (Claude's login): only Studio's user can read it, and the runner deletes it at once.
  fs.writeFileSync(file(unit, 'spec.json'), JSON.stringify(spec), { mode: 0o600 });
  for (const ext of ['log', 'err']) fs.writeFileSync(file(unit, ext), '');
  const rec: DetachRec = { unit, mode, started: Date.now() };
  if (mode === 'systemd') {
    const r = spawnSync('systemd-run', ['--user', `--unit=${unit}`, '--collect', '--quiet', `--description=Hawkes Studio: ${name}`, '--', process.execPath, RUNNER, DETACH_DIR(), unit], { env: userEnv(), encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) {
      fs.rmSync(file(unit, 'spec.json'), { force: true });
      throw new Error(`systemd-run failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
    }
  } else {
    const child = spawn(process.execPath, [RUNNER, DETACH_DIR(), unit], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    rec.pid = child.pid;
  }
  return rec;
}

/** Whether a detached process is still running. */
export function detachedAlive(rec: DetachRec) {
  if (rec.mode === 'systemd') return ['active', 'activating', 'deactivating', 'reloading'].includes(systemctl('is-active', `${rec.unit}.service`).stdout.trim());
  if (!rec.pid) return false;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

/** Its exit (code, signal), once the runner wrote it. */
export function detachedExit(rec: DetachRec): { code: number | null; signal: string | null; error?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(file(rec.unit, 'exit'), 'utf8'));
  } catch {
    return null;
  }
}

/** Asks the runner to stop its command (SIGTERM, then SIGKILL); the unit or process itself after 15 s if it didn't. */
export function stopDetached(rec: DetachRec) {
  try {
    fs.writeFileSync(file(rec.unit, 'stop'), String(Date.now()));
  } catch { /* the folder is gone: so is the process */ }
  setTimeout(() => {
    if (detachedExit(rec) || !detachedAlive(rec)) return;
    if (rec.mode === 'systemd') systemctl('stop', '--no-block', `${rec.unit}.service`);
    else if (rec.pid) try { process.kill(rec.pid); } catch { /* gone */ }
  }, 15_000).unref();
}

/** Reads bytes from a file starting at an offset (empty when there's nothing new). */
function readFrom(f: string, from: number) {
  let fd: number;
  try {
    fd = fs.openSync(f, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return Buffer.alloc(0);
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A detached process seen through its files, shaped like a ChildProcess: stdout emits one line at a time ("data", with
 * its newline), and `offset` is the byte just after the last line emitted (save it to carry on from there after a
 * restart); stderr emits what was written; "close" (code) comes once it exited and everything was read. A process that
 * vanished without an exit (a reboot) closes with code null and `lost` set.
 */
export class DetachedChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  offset: number;
  lost = false;
  private errOffset: number;
  private closed = false;
  private checked = 0;
  private timer: NodeJS.Timeout;

  rec: DetachRec;

  constructor(rec: DetachRec, { offset = 0, reattached = offset > 0 }: { offset?: number; reattached?: boolean } = {}) {
    super();
    this.rec = rec;
    this.offset = offset;
    // Reattached: stderr from before the restart isn't news (an error at the end is still read, from its last 4 KB).
    this.errOffset = reattached ? Math.max(0, this.size('err') - 4096) : 0;
    this.timer = setInterval(() => this.poll(), 250);
    setImmediate(() => this.poll());
  }

  private size(ext: string) {
    try {
      return fs.statSync(file(this.rec.unit, ext)).size;
    } catch {
      return 0;
    }
  }

  private lines(final: boolean) {
    const buf = readFrom(file(this.rec.unit, 'log'), this.offset);
    let start = 0;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, start)) {
      const line = buf.subarray(start, i + 1);
      start = i + 1;
      this.offset += line.length;
      this.stdout.emit('data', line.toString('utf8'));
    }
    if (final && start < buf.length) {
      this.offset += buf.length - start;
      this.stdout.emit('data', `${buf.subarray(start).toString('utf8')}\n`);
    }
    const err = readFrom(file(this.rec.unit, 'err'), this.errOffset);
    if (err.length) {
      this.errOffset += err.length;
      this.stderr.emit('data', err.toString('utf8'));
    }
  }

  private poll() {
    if (this.closed) return;
    // The exit is looked at before reading, so everything written before it is read.
    const exit = detachedExit(this.rec);
    this.lines(Boolean(exit));
    if (exit) return this.finish(exit.error ? 1 : exit.code ?? 1);
    if (Date.now() - this.checked < 3000) return;
    this.checked = Date.now();
    if (detachedAlive(this.rec) || detachedExit(this.rec)) return;
    // Gone without an exit: the runner was killed (a reboot). What it wrote is all there is.
    this.lines(true);
    this.lost = true;
    this.finish(null);
  }

  private finish(code: number | null) {
    this.closed = true;
    clearInterval(this.timer);
    setImmediate(() => this.emit('close', code));
  }

  kill() {
    if (this.closed) return false;
    stopDetached(this.rec);
    return true;
  }

  /** Stops reading (the process goes on): for a Studio that's shutting down, or tests. */
  detach() {
    this.closed = true;
    clearInterval(this.timer);
  }
}

/**
 * Starts a command outside Studio when this machine can (detachMode), else as Studio's own child like before. Returns
 * the process and, when detached, what to record so it can be found after a restart.
 */
export function launch(name: string, spec: DetachSpec): { child: ChildLike; rec: DetachRec | null } {
  const mode = detachMode();
  if (mode) {
    try {
      const rec = startDetached(name, spec, mode);
      return { child: new DetachedChild(rec), rec };
    } catch (e: any) {
      console.warn(`[detach] ${name}: ${e.message}; running it inside Studio`);
    }
  }
  return { child: spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true }), rec: null };
}

/** Old files of finished processes go after a week. */
export function pruneDetached(maxAgeMs = 7 * 86_400_000) {
  let names: string[] = [];
  try {
    names = fs.readdirSync(DETACH_DIR());
  } catch {
    return;
  }
  for (const n of names) {
    const f = path.join(DETACH_DIR(), n);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) fs.rmSync(f, { force: true });
    } catch { /* gone */ }
  }
}
