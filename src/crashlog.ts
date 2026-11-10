// Why did Studio stop? (2026-11-08: it restarted 4 times in 30 minutes and cut off runs and agents, and nothing on disk
// said why.) Three breadcrumbs, all in the data folder so Cloud Run's state sync keeps them across instances:
//  - process-level handlers: an uncaught error or an unhandled rejection is logged with its stack and what was running
//    (Node 24 would otherwise end the process on either with only a stderr line); a rejection is logged and survived,
//    an uncaught error is logged, then the process exits as Node would have;
//  - SIGTERM is logged with memory, uptime and what was running (the stop handler in server.ts does the saving);
//  - `boot.json`, rewritten every 20 s with memory and what was running, and marked `clean` on a normal stop: the next
//    start reads it, and a file not marked clean is a stop nobody saw (an out-of-memory kill is SIGKILL: no handler runs).
//    `.data/restarts.jsonl` keeps one line per start with that verdict (last 200).
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PROJECTS } from './config.ts';
import { memInfo } from './memgate.ts';

const BOOT = path.join(DATA, 'boot.json');
const LOG = path.join(DATA, 'restarts.jsonl');
const mb = (n: number) => Math.round(n / 1048576);

export function memoryNow() {
  const m = process.memoryUsage();
  return { rssMb: mb(m.rss), heapMb: mb(m.heapUsed), externalMb: mb(m.external + m.arrayBuffers), uptimeS: Math.round(process.uptime()) };
}

/**
 * The whole machine, not just Studio's process (2026-11-10: Studio was killed at 300 MB with the instance's 4 GiB full):
 * free memory and the limit, what the in-memory disk holds (projects and data), and the biggest processes. Linux /proc;
 * elsewhere only what os gives.
 */
export function systemNow() {
  const out: { freeMb?: number; limitMb?: number; diskMb?: Record<string, number>; top?: string } = {};
  try { const m = memInfo(); out.freeMb = mb(m.available); out.limitMb = mb(m.limit); } catch { /* no reading */ }
  const disk: Record<string, number> = {};
  for (const [name, dir] of [['projects', PROJECTS], ['data', DATA], ['tmp', '/tmp']] as const) {
    try { const s = fs.statfsSync(dir); disk[name] = mb((s.blocks - s.bfree) * s.bsize); } catch { /* missing */ }
  }
  if (Object.keys(disk).length) out.diskMb = disk;
  try {
    const procs: { name: string; kb: number }[] = [];
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const kb = Number(st.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
        if (kb > 20_000) procs.push({ name: st.match(/^Name:\s+(.*)$/m)?.[1] ?? pid, kb });
      } catch { /* gone */ }
    }
    procs.sort((a, b) => b.kb - a.kb);
    if (procs.length) out.top = procs.slice(0, 6).map((p) => `${p.name} ${Math.round(p.kb / 1024)}`).join(', ');
  } catch { /* no /proc */ }
  return out;
}
const sysLine = (s: ReturnType<typeof systemNow>) => [
  s.freeMb !== undefined ? `free ${s.freeMb} of ${s.limitMb} MB` : '',
  s.diskMb ? `disk ${Object.entries(s.diskMb).map(([k, v]) => `${k} ${v}`).join(', ')} MB` : '',
  s.top ? `biggest: ${s.top} MB` : '',
].filter(Boolean).join('; ');

/** What Studio is in the middle of, one short line (each part optional: a module not loaded yet is not running anything). */
export async function whatIsRunning(): Promise<string> {
  const parts: string[] = [];
  try { const { activeRun } = await import('./pipeline.ts'); const r: any = activeRun(); if (r) parts.push(`run ${r.id ?? r}`); } catch { /* not loaded */ }
  try {
    const { db } = await import('./db.ts');
    const rows = db.prepare(`SELECT id FROM changes WHERE status IN ('working', 'revising', 'verifying') LIMIT 20`).all() as { id: string }[];
    if (rows.length) parts.push(`changes ${rows.map((r) => r.id).join(',')}`);
  } catch { /* table missing */ }
  try { const { following, buildsRunning } = await import('./cloudjob.ts'); parts.push(`jobs followed ${following()}`, `builds ${buildsRunning()}`); } catch { /* not loaded */ }
  return parts.join('; ') || 'nothing';
}

function readBoot(): any { try { return JSON.parse(fs.readFileSync(BOOT, 'utf8')); } catch { return null; } }
function writeBoot(b: Record<string, unknown>) {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(BOOT + '.tmp', JSON.stringify(b)); fs.renameSync(BOOT + '.tmp', BOOT); } catch { /* read-only: the logs still say it */ }
}
function appendLog(entry: Record<string, unknown>) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
    if (lines.length > 200) fs.writeFileSync(LOG, lines.slice(-200).join('\n') + '\n');
  } catch { /* no data folder */ }
}

/** The verdict on the previous instance, from its boot.json. Pure, for tests. */
export function verdictOn(prev: any, now = Date.now()): string | null {
  if (!prev || typeof prev !== 'object') return null;
  if (prev.clean) return `the previous instance stopped cleanly (${prev.reason ?? 'stop'})`;
  const last = Number(prev.lastSeen) || 0;
  return `the previous instance ended WITHOUT a clean stop (killed: out of memory or SIGKILL?): last seen ${last ? Math.round((now - last) / 1000) + ' s ago' : 'never'}, `
    + `rss ${prev.rssMb ?? '?'} MB, heap ${prev.heapMb ?? '?'} MB, up ${prev.uptimeS ?? '?'} s, running: ${prev.running ?? 'unknown'}`
    + (prev.system ? `; machine: ${prev.system}` : '');
}

let installed = false;
let reason = 'stop';

/** Called once at start-up by server.ts. Returns the previous instance's verdict (also logged). */
export function installCrashLog(): string | null {
  if (installed) return null;
  installed = true;
  const verdict = verdictOn(readBoot());
  if (verdict) console.log(`[crashlog] ${verdict}`);
  appendLog({ at: Date.now(), event: 'start', pid: process.pid, rev: process.env.K_REVISION ?? null, previous: verdict, ...memoryNow() });

  let running = 'nothing';
  let lowSaid = 0;
  const beat = async () => {
    running = await whatIsRunning().catch(() => running);
    const sys = systemNow();
    const system = sysLine(sys);
    writeBoot({ pid: process.pid, rev: process.env.K_REVISION ?? null, lastSeen: Date.now(), running, system, ...memoryNow() });
    // Low on memory: said in the log every beat (at most once a minute), so the last state before a kill is on record.
    if (sys.freeMb !== undefined && sys.limitMb && sys.freeMb < sys.limitMb * 0.3 && Date.now() - lowSaid > 55_000) {
      lowSaid = Date.now();
      console.warn(`[crashlog] memory low: ${system}; studio rss ${memoryNow().rssMb} MB; running: ${running}`);
    }
  };
  void beat();
  setInterval(() => void beat(), 20_000).unref();

  const seal = (why: string) => {
    reason = why;
    writeBoot({ pid: process.pid, clean: true, reason: why, lastSeen: Date.now(), running, ...memoryNow() });
  };
  process.on('exit', (code) => {
    if (reason !== 'stop' || code === 0) seal(reason === 'stop' ? 'exit 0' : reason);
    appendLog({ at: Date.now(), event: 'exit', code, reason, ...memoryNow() });
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      reason = sig;
      console.log(`[crashlog] ${sig} received: ${JSON.stringify(memoryNow())}, running: ${running}`);
    });
  }
  process.on('unhandledRejection', (err: any) => {
    console.error(`[crashlog] unhandled rejection (kept running): ${err?.stack ?? err}; running: ${running}; ${JSON.stringify(memoryNow())}`);
    appendLog({ at: Date.now(), event: 'unhandledRejection', error: String(err?.stack ?? err).slice(0, 2000), running });
  });
  process.on('uncaughtException', (err: any) => {
    console.error(`[crashlog] uncaught exception, stopping: ${err?.stack ?? err}; running: ${running}; ${JSON.stringify(memoryNow())}`);
    appendLog({ at: Date.now(), event: 'uncaughtException', error: String(err?.stack ?? err).slice(0, 2000), running });
    reason = 'uncaught exception';
    process.exit(1);
  });
  return verdict;
}
