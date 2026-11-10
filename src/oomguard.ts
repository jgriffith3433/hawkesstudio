// Who the system kills when memory runs out on the cloud server.
//
// On 2026-11-10 (05:34-06:10 UTC) J's Studio was SIGKILLed ten times, each 1-2 minutes after it started, with nothing in
// the log but Litestream's "signal: killed": the instance's memory filled (its disk is memory too) and the kernel's
// out-of-memory killer took the biggest process, which was Studio itself. Every command it was running died with it,
// the container exited, and after a few in a row Cloud Run waited 8 minutes before starting another (06:10-06:18).
// The killer should take the command that pushed memory over (a clone, a build, an install) instead: that command
// fails and is retried or reported, and Studio stays up. So Studio's own process is made less likely to be picked
// (oom_score_adj -500, also set for the whole service by the entrypoint) and every command it starts more likely
// (+500). Best effort: where the system doesn't allow it, nothing changes.
import fs from 'node:fs';
import { ChildProcess } from 'node:child_process';

export const STUDIO_ADJ = -500;
export const CHILD_ADJ = 500;

export const guardStats = { self: null as number | null, children: 0, failed: 0 };

function writeAdj(pid: number | 'self', v: number): boolean {
  try { fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(v)); return true; } catch { return false; }
}
export function readAdj(pid: number | 'self' = 'self'): number | null {
  try { return Number(fs.readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim()); } catch { return null; }
}

let installed = false;
/** Once at start-up (server.ts). Linux only; elsewhere it does nothing. */
export function installOomGuard() {
  if (installed || process.platform !== 'linux' || process.env.STUDIO_OOM_GUARD === 'off') return;
  installed = true;
  if (!writeAdj('self', STUDIO_ADJ)) guardStats.failed++;
  guardStats.self = readAdj();
  console.log(`[oomguard] Studio's oom_score_adj ${guardStats.self ?? 'unknown'} (wanted ${STUDIO_ADJ}); commands it starts get ${CHILD_ADJ}`);
  // Every child process (spawn, exec, execFile, fork all start through ChildProcess.prototype.spawn): raised as soon as it
  // has a pid. Raising needs no privilege; a child that already exited is simply gone.
  const proto = ChildProcess.prototype as any;
  const orig = proto.spawn;
  if (orig.__oomGuard) return;
  const wrapped = function (this: ChildProcess, ...args: any[]) {
    const r = orig.apply(this, args);
    if (this.pid) { if (writeAdj(this.pid, CHILD_ADJ)) guardStats.children++; else guardStats.failed++; }
    return r;
  };
  (wrapped as any).__oomGuard = true;
  proto.spawn = wrapped;
}
