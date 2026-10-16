// Hawkes Gen, from Studio: builds, playtests and reviews are Gen jobs (they show in its dashboard and library too).

// @ts-ignore: plain JS client (a copy of hawkesgen/clients/js/hawkesgen.mjs)
import { HawkesGen } from './hawkesgen.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GEN_URL, GEN_PUBLIC_URL, PROJECTS } from './config.ts';

export const gen = new HawkesGen({ url: GEN_URL });

export async function genUp() {
  try {
    await gen.health();
    return true;
  } catch {
    return false;
  }
}

let restarting: Promise<boolean> | null = null;
/** Starts Hawkes Gen if it isn't answering (its restart script waits until it is). Jobs resume after a restart. */
export function ensureGen(): Promise<boolean> {
  restarting ??= (async () => {
    if (await genUp()) return true;
    console.warn('[studio] Hawkes Gen is not answering; starting it');
    if (process.platform === 'win32') spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECTS, 'hawkesgen', 'bin', 'restart.ps1')], { stdio: 'ignore', windowsHide: true, timeout: 90_000 });
    // On the Linux server systemd restarts Hawkes Gen by itself; just give it time.
    else await new Promise((r) => setTimeout(r, 20_000));
    return genUp();
  })().finally(() => setTimeout(() => (restarting = null), 60_000));
  return restarting;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * Waits for a Gen job. A busy or restarting service is retried for a few minutes (jobs resume after a Gen
 * restart), so one missed poll doesn't fail a long build. Never throws for a failed job: returns it.
 */
export async function genWait(id: string, onUpdate?: (job: any) => void, timeoutMs = 4 * 60 * 60 * 1000) {
  const end = Date.now() + timeoutMs;
  let last = '';
  let misses = 0;
  for (;;) {
    let j: any;
    try {
      j = await gen.job(id);
      misses = 0;
    } catch (e) {
      if (++misses > 60) throw e;
      if (misses === 10) await ensureGen();
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const sig = `${j.status}|${j.detail}`;
    if (sig !== last) {
      last = sig;
      onUpdate?.(j);
    }
    if (TERMINAL.has(j.status)) return j;
    if (Date.now() > end) return { ...j, status: 'failed', error: `timed out after ${Math.round(timeoutMs / 60000)} min` };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Submits a Gen job (retrying a busy service) and waits for it. job: one submitted before (a Studio restart), waited on
 * instead of submitting again; onSubmit: the new job's id, as soon as Gen gives it (to record it for that).
 */
export async function genRun(tool: string, project: string, params: Record<string, unknown>, onUpdate?: (job: any) => void, timeoutMs = 4 * 60 * 60 * 1000, { job: reuse, onSubmit }: { job?: string; onSubmit?: (id: string) => void } = {}) {
  if (reuse) return genWait(reuse, onUpdate, timeoutMs);
  let job: any;
  for (let i = 0; ; i++) {
    try {
      job = await gen.submit(tool, { project, params });
      break;
    } catch (e: any) {
      if ((e.kind !== 'offline' && !/reach|fetch failed|ECONN/i.test(String(e.message))) || i >= 20) throw e;
      if (i === 3) await ensureGen();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  onSubmit?.(job.id);
  return genWait(job.id, onUpdate, timeoutMs);
}

export const fileUrl = (asset: string) => `${GEN_PUBLIC_URL}/v1/files/${asset}`;
