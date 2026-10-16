#!/usr/bin/env node
// Runs one command for Hawkes Studio outside its process (src/detach.ts), so a Studio restart doesn't stop it:
//
//   node bin/detached-run.mjs <dir> <unit>
//
// Reads <dir>/<unit>.spec.json ({ file, args, cwd, env }) and deletes it at once (it holds Claude's login), starts the
// command with stdout and stderr going straight to <unit>.log and <unit>.err, and when it exits writes <unit>.exit
// ({ code, signal }). A <unit>.stop file (Studio's Stop, a time limit) or SIGTERM stops the command: SIGTERM, then
// SIGKILL after 10 s. On the server systemd-run --user starts this as a unit of the hawkes user's own manager.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [dir, unit] = process.argv.slice(2);
const f = (ext) => path.join(dir, `${unit}.${ext}`);
let done = false;
function finish(code, signal, error) {
  if (done) return;
  done = true;
  fs.writeFileSync(f('exit.tmp'), JSON.stringify({ code, signal, ...(error ? { error } : {}), at: Date.now() }));
  fs.renameSync(f('exit.tmp'), f('exit'));
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

let child;
try {
  child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', out, err], windowsHide: true });
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
