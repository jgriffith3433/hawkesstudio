// The event loop's profiler: what held Studio's main thread when it froze (ops.ts startLoopMonitor).
//
//   A rolling CPU profile of Studio's own process (node:inspector's Profiler, a sample about every 10 ms, a fresh
//   window every 60 s; well under 1% CPU). When the monitor sees a block over a second, captureBlock() ends the window
//   at once, keeps it in .data/profiles/ (the newest KEEP), and names the code the block's samples were in: the
//   functions by self time (often a native call such as spawnSync) and the Studio functions under them (src/*.ts with
//   the line), so a freeze in the log says where it was even when no tracked command was running.

import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector';
import { DATA, ROOT } from './config.ts';

type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type PNode = { id: number; callFrame: Frame; children?: number[] };
export type Profile = { nodes: PNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] };
/** A function and how long the block spent in it. */
export type Hot = { fn: string; file: string; line: number; ms: number };
/** What a block's samples were in: the top functions by self time, the Studio functions under them, the kept profile. */
export type BlockCause = { top: Hot[]; studio: Hot[]; samples: number; profile: string | null };

const WINDOW_MS = 60_000;
const INTERVAL_US = 10_000;
/** Newest profiles kept here; disksweep.ts also caps by total size (STUDIO_PROFILES_KEEP / _MB). */
const KEEP = () => Math.max(1, Number(process.env.STUDIO_PROFILES_KEEP) || 8);
export const PROFILE_DIR = () => path.join(DATA, 'profiles');

let session: Session | null = null;
let busy: Promise<Profile | null> | null = null;
/** The window ended last and when: the minute's rotation may run just before the monitor sees the block. */
let previous: { profile: Profile; at: number } | null = null;

const post = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
  session!.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
});

/** Starts the rolling profile (once). Off with STUDIO_LOOP_PROFILE=off. False when it can't run here. */
export async function startProfiler() {
  if (session) return true;
  if (process.env.STUDIO_LOOP_PROFILE === 'off') return false;
  try {
    session = new Session();
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: INTERVAL_US });
    await post('Profiler.start');
  } catch (e: any) {
    console.warn(`[studio] the event-loop profiler couldn't start: ${e.message ?? e}`);
    try { session?.disconnect(); } catch { /* gone */ }
    session = null;
    return false;
  }
  // A fresh window every minute: the old one is dropped unless a block landed in it (captureBlock took it first).
  setInterval(() => void rotate(), WINDOW_MS).unref();
  return true;
}

export const profiling = () => session !== null;

/** Ends the current window and starts the next; the ended window's profile. One at a time. */
function rotate(): Promise<Profile | null> {
  if (!session) return Promise.resolve(null);
  if (busy) return busy;
  busy = (async () => {
    try {
      const { profile } = await post('Profiler.stop');
      await post('Profiler.start');
      previous = { profile, at: Date.now() };
      return profile as Profile;
    } catch {
      await post('Profiler.start').catch(() => {});
      return null;
    } finally {
      busy = null;
    }
  })();
  return busy;
}

/** Where a script lives, as the log shows it: "src/agents.ts" for Studio's own, "node:child_process" for Node's. */
export function fileOf(url: string) {
  if (!url) return '';
  let f = url.startsWith('file://') ? decodeURIComponent(new URL(url).pathname) : url;
  if (f.startsWith(ROOT + path.sep) || f.startsWith(ROOT + '/')) f = f.slice(ROOT.length + 1);
  return f.replace(/\\/g, '/');
}
const isStudio = (url: string) => /^(src|bin)\//.test(fileOf(url));

/**
 * What the samples in the last `ms` (plus `slackMs`) of a profile were in. The profile's endTime is when it was
 * stopped (just after the block), so the block is its tail. Idle samples are left out.
 */
export function analyze(profile: Profile, ms: number, { slackMs = 600, limit = 5 }: { slackMs?: number; limit?: number } = {}): Omit<BlockCause, 'profile'> {
  const byId = new Map<number, PNode>();
  const parent = new Map<number, number>();
  for (const n of profile.nodes) {
    byId.set(n.id, n);
    for (const c of n.children ?? []) parent.set(c, n.id);
  }
  const from = profile.endTime - (ms + slackMs) * 1000;
  const self = new Map<string, Hot>();
  const studio = new Map<string, Hot>();
  const add = (m: Map<string, Hot>, f: Frame, dt: number) => {
    const fn = f.functionName || '(anonymous)';
    const file = fileOf(f.url);
    const key = `${fn}|${file}|${f.lineNumber}`;
    const h = m.get(key) ?? m.set(key, { fn, file, line: f.lineNumber + 1, ms: 0 }).get(key)!;
    h.ms += dt;
  };
  let t = profile.startTime;
  let samples = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0;
    if (t < from) continue;
    // Each sample stands for the time until the next one (the last: one interval).
    const dt = ((profile.timeDeltas[i + 1] ?? INTERVAL_US) / 1000);
    const node = byId.get(profile.samples[i]);
    if (!node || node.callFrame.functionName === '(idle)') continue;
    samples++;
    add(self, node.callFrame, dt);
    // The deepest Studio frame on the stack: the code of ours that made the call.
    for (let id: number | undefined = node.id; id !== undefined; id = parent.get(id)) {
      const f = byId.get(id)!.callFrame;
      if (isStudio(f.url)) { add(studio, f, dt); break; }
    }
  }
  const top = (m: Map<string, Hot>) => [...m.values()].sort((a, b) => b.ms - a.ms).slice(0, limit).map((h) => ({ ...h, ms: Math.round(h.ms) }));
  return { top: top(self), studio: top(studio), samples };
}

/** One line for the log: the Studio functions first (where to fix it), then what ran on top of them. */
export function describe(c: Omit<BlockCause, 'profile'>) {
  if (!c.samples) return 'no samples in the block (it was outside JavaScript: GC or native start-up)';
  const fmt = (h: Hot) => `${h.fn} (${h.file}${h.line > 0 ? `:${h.line}` : ''}) ${h.ms} ms`;
  const studio = c.studio.slice(0, 3).map(fmt).join(', ');
  const top = c.top.slice(0, 3).map(fmt).join(', ');
  return `${studio ? `in ${studio}; ` : ''}top: ${top}`;
}

/** A block of `ms` just ended: the current window is ended, kept on disk, and the block's code named. */
export async function captureBlock(ms: number): Promise<BlockCause | null> {
  const prior = previous;
  let profile = await rotate();
  if (!profile) return null;
  // The window had just been rotated (the block landed at the end of the one before): that one holds it.
  if (prior && prior.profile !== profile && Date.now() - prior.at < 2000 && profile.endTime - profile.startTime < ms * 1000) profile = prior.profile;
  const cause = analyze(profile, ms);
  let file: string | null = null;
  try {
    const dir = PROFILE_DIR();
    await fs.promises.mkdir(dir, { recursive: true });
    file = `block-${new Date().toISOString().replace(/[:.]/g, '-')}-${ms}ms.cpuprofile`;
    await fs.promises.writeFile(path.join(dir, file), JSON.stringify(profile));
    await prune(dir);
  } catch (e: any) {
    console.warn(`[studio] keeping the block's profile: ${e.message ?? e}`);
    file = null;
  }
  return { ...cause, profile: file };
}

/** The newest KEEP profiles stay; then disksweep applies the byte cap. */
async function prune(dir: string) {
  const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.cpuprofile')).sort();
  const keep = KEEP();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) await fs.promises.rm(path.join(dir, n), { force: true });
  try { const { sweepProfiles } = await import('./disksweep.ts'); sweepProfiles(dir); } catch { /* optional */ }
}
