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
// "process" = a detached plain process instead of a unit (tests, and Windows); "off" = always inside Studio;
// "cloudrun" = a Cloud Run job execution per process (Studio on Cloud Run: cloudjob.ts), the default there.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { DATA, ROOT, PROJECTS, paths, addedRepoFolders } from './config.ts';
import { repoTokenNow, slugOfRemote } from './ghtoken.ts';
import { customerStudio, PLATFORM_GITHUB } from './tenancy.ts';
import { startCloudJob, reattachCloudJob, cloudJobAlive, kickCloudJob, jobFiles } from './cloudjob.ts';

export type DetachMode = 'systemd' | 'process' | 'cloudrun';
/** What Studio records (on a change, a conversation) to find a detached process again (cwd: a Cloud Run job's workspace). */
export type DetachRec = { unit: string; mode: DetachMode; pid?: number; started: number; cwd?: string };
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
  if (want === 'cloudrun' || (!want && process.env.K_SERVICE)) return 'cloudrun';
  return systemdUser() ? 'systemd' : null;
}

/** Starts a command outside Studio. Throws when it couldn't be started that way (the caller runs it inside instead). */
export function startDetached(name: string, spec: DetachSpec, mode: DetachMode): DetachRec {
  fs.mkdirSync(DETACH_DIR(), { recursive: true, mode: 0o700 });
  const unit = `hawkes-${name.replace(/[^A-Za-z0-9_.-]/g, '-')}-${Date.now().toString(36)}`;
  if (mode === 'cloudrun') {
    // A Cloud Run job execution: its inputs go to the bucket, never to a local spec file (cloudjob.ts).
    // The job's repo's own token when one was fetched for it (ghtoken.ts: the GitHub App's for a repo that isn't J's).
    startCloudJob(unit, spec, { gitToken: jobGitToken(spec.cwd) });
    return { unit, mode, started: Date.now(), cwd: spec.cwd };
  }
  // The spec holds the environment (Claude's login): only Studio's user can read it, and the runner deletes it at once.
  fs.writeFileSync(file(unit, 'spec.json'), JSON.stringify(spec), { mode: 0o600 });
  for (const ext of ['log', 'err']) fs.writeFileSync(file(unit, ext), '');
  const rec: DetachRec = { unit, mode, started: Date.now() };
  if (mode === 'systemd') {
    // Agents run at low CPU and disk priority (everything they start inherits it: tests, builds, their own browser), so
    // a busy night slows the agents rather than Studio, Gen and the web server: on 2026-10-17, ten agents on 2 CPUs left
    // studio.hawkesgen.ai and hawkesgen.ai unanswered until they were reniced. Talk's answers keep normal priority.
    const low = name.startsWith('agent-') ? ['-p', 'Nice=15', '-p', 'IOSchedulingClass=idle'] : [];
    const r = spawnSync('systemd-run', ['--user', `--unit=${unit}`, '--collect', '--quiet', `--description=Hawkes Studio: ${name}`, ...low, '--', process.execPath, RUNNER, DETACH_DIR(), unit], { env: userEnv(), encoding: 'utf8', timeout: 15_000 });
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
  if (rec.mode === 'cloudrun') return cloudJobAlive(rec.unit);
  if (rec.mode === 'systemd') {
    const r = systemctl('is-active', `${rec.unit}.service`);
    // No answer (systemctl timed out on a busy server, or couldn't run): it can't be called gone, so it's alive. Calling
    // it gone would start the agent's pass again beside the one still running.
    if (r.error || r.status === null) return true;
    return ['active', 'activating', 'deactivating', 'reloading'].includes(r.stdout.trim());
  }
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
  // A Cloud Run job: its follower passes the stop on (now, not on its next look) and cancels the execution if it doesn't
  // end (cloudjob.ts).
  if (rec.mode === 'cloudrun') return void kickCloudJob(rec.unit, { nudged: false });
  setTimeout(() => {
    if (detachedExit(rec) || !detachedAlive(rec)) return;
    if (rec.mode === 'systemd') systemctl('stop', '--no-block', `${rec.unit}.service`);
    else if (rec.pid) try { process.kill(rec.pid); } catch { /* gone */ }
  }, 15_000).unref();
}

/**
 * What a detached unit is doing (the agents' watchdog, agents.ts): the CPU its cgroup has used in all (microseconds,
 * processes that already exited included) and the processes in it with their state (R running, S sleeping, D waiting
 * on disk...). Null when it can't be seen (not a systemd unit, gone, not Linux).
 */
const cgroups = new Map<string, string>();
export function detachedActivity(rec: DetachRec): { cpuUsec: number; procs: { pid: number; state: string; comm: string }[] } | null {
  if (rec.mode !== 'systemd' || process.platform !== 'linux') return null;
  // Asked once per unit (systemctl waits on the user manager; the cgroup of a running unit doesn't move).
  let cg = cgroups.get(rec.unit);
  if (!cg) {
    const r = systemctl('show', '-p', 'ControlGroup', '--value', `${rec.unit}.service`);
    cg = r.status === 0 ? r.stdout.trim() : '';
    if (!cg) return null;
    cgroups.set(rec.unit, cg);
  }
  try {
    const dir = path.join('/sys/fs/cgroup', cg);
    const cpuUsec = Number(/usage_usec (\d+)/.exec(fs.readFileSync(path.join(dir, 'cpu.stat'), 'utf8'))?.[1] ?? NaN);
    const procs: { pid: number; state: string; comm: string }[] = [];
    for (const pid of fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number)) {
      try {
        // "<pid> (<comm>) <state> ...": comm can hold spaces and parentheses, so the state follows the last ")".
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        procs.push({ pid, comm: stat.slice(stat.indexOf('(') + 1, close), state: stat.slice(close + 2, close + 3) });
      } catch { /* exited meanwhile */ }
    }
    return Number.isFinite(cpuUsec) ? { cpuUsec, procs } : null;
  } catch {
    return null;
  }
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

/** How often a followed process's files are looked at with no change pushed (the safety net; see DetachedChild). */
const SAFETY_MS = () => Number(process.env.STUDIO_DETACH_POLL_MS) || 3000;
/** How often they're looked at when nothing can push a change (fs.watch unavailable here): as before pushes. */
const POLL_MS = 250;

/**
 * A detached process seen through its files, shaped like a ChildProcess: stdout emits one line at a time ("data", with
 * its newline), and `offset` is the byte just after the last line emitted (save it to carry on from there after a
 * restart); stderr emits what was written; "close" (code) comes once it exited and everything was read. A process that
 * vanished without an exit (a reboot) closes with code null and `lost` set.
 *
 * Changes are pushed, not polled: fs.watch on the folder (the runner and a systemd unit write the files from another
 * process) and, for a Cloud Run job, cloudjob.ts's jobFiles event when its follower wrote them. A look every few seconds
 * stays as the safety net, for an event that never comes (fs.watch can drop events) and for a process that died without
 * writing its exit (a reboot, a killed unit: nothing writes a file then, so only looking finds it). Where fs.watch can't
 * be used, it looks every 250 ms as it always did.
 */
export class DetachedChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  offset: number;
  lost = false;
  private errOffset: number;
  private closed = false;
  private checked = 0;
  private misses = 0;
  private timer: NodeJS.Timeout;
  private watcher: fs.FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;
  private onJob = () => this.soon();

  rec: DetachRec;

  constructor(rec: DetachRec, { offset = 0, reattached = offset > 0 }: { offset?: number; reattached?: boolean } = {}) {
    super();
    this.rec = rec;
    this.offset = offset;
    // After a restart (a new Cloud Run instance has none of the local files): follow the job again from the bucket.
    if (rec.mode === 'cloudrun' && reattached && rec.cwd) reattachCloudJob(rec.unit, rec.cwd);
    // Reattached: stderr from before the restart isn't news (an error at the end is still read, from its last 4 KB).
    this.errOffset = reattached ? Math.max(0, this.size('err') - 4096) : 0;
    this.watcher = this.watch();
    if (rec.mode === 'cloudrun') jobFiles.on(rec.unit, this.onJob);
    this.timer = setInterval(() => this.poll(), this.watcher || rec.mode === 'cloudrun' ? SAFETY_MS() : POLL_MS);
    setImmediate(() => this.poll());
  }

  /** Watches the folder for this unit's files (null where fs.watch doesn't work: then it's the 250 ms look). */
  private watch() {
    const prefix = `${this.rec.unit}.`;
    try {
      const w = fs.watch(DETACH_DIR(), (_event, name) => {
        if (!name || String(name).startsWith(prefix)) this.soon();
      });
      w.on('error', () => {
        // Watching stopped (the folder went, the kernel's watch limit): back to looking every 250 ms.
        w.close();
        if (this.watcher !== w || this.closed) return;
        this.watcher = null;
        clearInterval(this.timer);
        this.timer = setInterval(() => this.poll(), POLL_MS);
      });
      w.unref?.();
      return w;
    } catch {
      return null;
    }
  }

  /** A change was pushed: look right away (writes that come together, like streamed lines, share one look). */
  private soon() {
    if (this.closed || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.poll();
    }, 15);
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
    if (detachedAlive(this.rec) || detachedExit(this.rec)) {
      this.misses = 0;
      return;
    }
    // Gone without an exit, seen twice 3 s apart (once can be a unit between states): the runner was killed (a
    // reboot). What it wrote is all there is.
    if (++this.misses < 2) return;
    this.lines(true);
    this.lost = true;
    this.finish(null);
  }

  private stopFollowing() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.watcher?.close();
    this.watcher = null;
    jobFiles.off(this.rec.unit, this.onJob);
  }

  private finish(code: number | null) {
    this.stopFollowing();
    setImmediate(() => this.emit('close', code));
  }

  kill() {
    if (this.closed) return false;
    stopDetached(this.rec);
    return true;
  }

  /** Stops reading (the process goes on): for a Studio that's shutting down, or tests. */
  detach() {
    this.stopFollowing();
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

/** A folder's origin address ('' when it isn't a clone). */
function originOf(cwd: string) {
  const r = spawnSync('git', ['-c', 'safe.directory=*', 'remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/** The git token a job gets: its repo's (ghtoken.ts, kept after repos.ts fetched or cloned it), else Studio's own. */
function jobGitToken(cwd: string) {
  const top = path.relative(PROJECTS, cwd).split(/[\\/]/)[0];
  const map: Record<string, string> = { ...(JSON.parse(fs.readFileSync(paths.products, 'utf8')).repos ?? {}), ...addedRepoFolders() };
  // An agent's worktree (PROJECTS/.work/<change>) isn't a repo folder of its own: its origin names the repo
  // (2026-11-01: every agent job on the private Hawkes Gen repo cloned with no token and failed).
  const slug = (top && !top.startsWith('..') ? map[top] ?? null : null) ?? slugOfRemote(originOf(cwd));
  // A customer's Studio: only its own token for the repo (one on J's account too, when its installation covers it).
  if (customerStudio()) return slug ? repoTokenNow(slug) : null;
  const own = slug && (slug.split('/')[0].toLowerCase() !== PLATFORM_GITHUB || !process.env.GITHUB_TOKEN) ? repoTokenNow(slug) : null;
  return own ??(process.env.STUDIO_JOB_GITHUB_TOKEN || process.env.GITHUB_TOKEN || null);
}
