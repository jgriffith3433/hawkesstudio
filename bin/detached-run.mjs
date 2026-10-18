#!/usr/bin/env node
// Runs one command for Hawkes Studio outside its process (src/detach.ts), so a Studio restart doesn't stop it:
//
//   node bin/detached-run.mjs <dir> <unit>
//
// Reads <dir>/<unit>.spec.json ({ file, args, cwd, env }) and deletes it at once (it holds Claude's login), starts the
// command with stdout and stderr going straight to <unit>.log and <unit>.err, and when it exits writes <unit>.exit
// ({ code, signal }). A <unit>.stop file (Studio's Stop, a time limit) or SIGTERM stops the command: SIGTERM, then
// SIGKILL after 10 s. On the server systemd-run --user starts this as a unit of the hawkes user's own manager.
//
// Once the command has exited, whatever it left behind is ended too: an agent's background shells (Claude Code starts
// each in its own session, so they're not in its process group, and they run as the sandbox user, whom systemd's own
// stop can't signal). In a unit that's its cgroup (cgroup.kill: the kernel kills every process in it, whoever owns it,
// this runner included, after the exit is written); as a plain process, the child's process group.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [dir, unit] = process.argv.slice(2);
const f = (ext) => path.join(dir, `${unit}.${ext}`);
// This unit's own cgroup (never a shared one: a runner started inside Studio's would otherwise end Studio).
function ownCgroup() {
  if (process.platform !== 'linux') return null;
  try {
    const rel = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3).trim();
    if (!rel || path.posix.basename(rel) !== `${unit}.service`) return null;
    const dir = path.join('/sys/fs/cgroup', rel);
    return fs.existsSync(path.join(dir, 'cgroup.kill')) ? dir : null;
  } catch {
    return null;
  }
}

let child;
let done = false;
function finish(code, signal, error) {
  if (done) return;
  done = true;
  fs.writeFileSync(f('exit.tmp'), JSON.stringify({ code, signal, ...(error ? { error } : {}), at: Date.now() }));
  fs.renameSync(f('exit.tmp'), f('exit'));
  const cg = ownCgroup();
  if (cg) try { fs.writeFileSync(path.join(cg, 'cgroup.kill'), '1'); } catch { /* not allowed: systemd stops the unit */ }
  if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* no group left */ }
  process.exit(0);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(f('spec.json'), 'utf8'));
} catch (e) {
  finish(null, null, `no spec: ${e.message}`);
}
fs.rmSync(f('spec.json'), { force: true });
const out = fs.openSync(f('log'), 'a');
const err = fs.openSync(f('err'), 'a');

try {
  // Its own process group, so what it leaves behind can be ended with it (finish).
  child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', out, err], windowsHide: true, detached: process.platform !== 'win32' });
} catch (e) {
  finish(null, null, e.message);
}
child.on('error', (e) => finish(null, null, e.message));
child.on('exit', (code, signal) => finish(code, signal));

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', () => {});
setInterval(() => {
  if (fs.existsSync(f('stop'))) {
    fs.rmSync(f('stop'), { force: true });
    stop();
  }
}, 500);
