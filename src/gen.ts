// Hawkes Gen, from Studio: builds, playtests and reviews are Gen jobs (they show in its dashboard and library too).

// @ts-ignore: plain JS client (a copy of hawkesgen/clients/js/hawkesgen.mjs)
import { HawkesGen } from './hawkesgen.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GEN_URL, GEN_PUBLIC_URL, PROJECTS } from './config.ts';
import { GenEvents, nextLook, terminal, type JobFollower } from './genevents.ts';

export const gen = new HawkesGen({ url: GEN_URL });
/**
 * Gen's live events (genevents.ts): one stream for this process, opened by the server only (server.ts). Waits follow
 * their job on it; until it is open (the CLI, tests) every wait asks Gen on its old timer.
 */
export const genEvents = new GenEvents(() => gen);
// hawkesgen.mjs wait() (gen.run) follows its job on the stream too.
(gen as any).follow = (id: string) => genEvents.follow(id);

// A customer's cell (cells.ts): its Gen key works only in its Gen org's projects, so every project Studio names (a game
// id) becomes org_<hex>.<game> on the way to Gen (HAWKESGEN_PROJECT_PREFIX, set by the control plane). J's Studio: as is.
const PREFIX = process.env.HAWKESGEN_PROJECT_PREFIX?.trim() || '';
export const genProject = (p: unknown) => (PREFIX && typeof p === 'string' && p && !p.startsWith(PREFIX) && p !== PREFIX.slice(0, -1) ? `${PREFIX}${p}` : p);
const scoped = (b: any): any => {
  if (!b || typeof b !== 'object' || Buffer.isBuffer(b)) return b;
  if (Array.isArray(b)) return b.map(scoped);
  const out: any = { ...b };
  if ('project' in out) out.project = genProject(out.project);
  for (const k of ['jobs', 'specs', 'items']) if (Array.isArray(out[k])) out[k] = out[k].map(scoped);
  return out;
};
{
  const request = gen.request.bind(gen);
  const raw = (p: string, o: any = {}) => {
    if (!PREFIX) return request(p, o);
    const [base, query] = String(p).split('?');
    const q = query ? new URLSearchParams(query) : null;
    if (q?.has('project')) q.set('project', String(genProject(q.get('project'))));
    return request(q ? `${base}?${q}` : base, { ...o, body: scoped(o.body) });
  };
  // Submitting jobs: a cell charges them to its balance first (credits.ts), and a refusal for lack of credits (the
  // control plane's or Gen's own 402) says how many are needed and where to add more.
  gen.request = async (p: string, o: any = {}) => {
    if (!(String(p).split('?')[0] === '/jobs' && String(o.method ?? 'GET').toUpperCase() === 'POST')) return raw(p, o);
    const C = await import('./credits.ts');
    try {
      return C.meteringOn() ? await C.meteredSubmit(raw, p, { ...o, body: scoped(o.body) }) : await raw(p, o);
    } catch (e) { throw C.genRefusal(e); }
  };
}

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

/**
 * Waits for a Gen job. A busy or restarting service is retried for a few minutes (jobs resume after a Gen
 * restart), so one missed look doesn't fail a long build. Never throws for a failed job: returns it.
 */
export async function genWait(id: string, onUpdate?: (job: any) => void, timeoutMs = 4 * 60 * 60 * 1000, halt?: () => string | null, { api = gen, events = genEvents, pollMs = 2000 }: { api?: { job(id: string): Promise<any>; cancel(id: string): Promise<any> }; events?: JobFollower; pollMs?: number } = {}) {
  const end = Date.now() + timeoutMs;
  let last = '';
  let misses = 0;
  // Its job's events wake it (genevents.ts); it asks Gen itself at the start, at its timeout, for the whole job once it
  // ends (an event carries no log), and every pollMs only while the stream is down. halt is Studio's own database: it is
  // still looked at every pollMs, without asking Gen.
  const f = events.follow(id);
  let j: any = null;
  let look = true;
  let fromGet = false;
  let heard = Date.now();
  try {
    for (;;) {
      if (look) {
        f.drop();
        try {
          j = await api.job(id);
          misses = 0;
          look = false;
          fromGet = true;
          heard = Date.now();
        } catch (e) {
          if (++misses > 60) throw e;
          if (misses === 10) await ensureGen();
          const ev = await f.next(3000);
          if (!ev) continue;
          j = ev;
          look = false;
          fromGet = false;
          heard = Date.now();
        }
      }
      const sig = `${j.status}|${j.detail}`;
      if (sig !== last) {
        last = sig;
        onUpdate?.(j);
      }
      if (terminal(j)) {
        if (!fromGet) { look = true; continue; }
        return j;
      }
      // The run it belongs to was cancelled (cancel.ts haltOf): the job is cancelled at once, whenever it was submitted.
      const why = halt?.();
      if (why) {
        await api.cancel(id).catch(() => {});
        return { ...j, status: 'cancelled', error: why, halted: true };
      }
      if (Date.now() > end) {
        if (!fromGet) { look = true; continue; }
        return { ...j, status: 'failed', error: `timed out after ${Math.round(timeoutMs / 60000)} min` };
      }
      const { due, ms } = nextLook(f.live(), { pollMs, heard, deadlines: [end + 1], localMs: halt ? pollMs : undefined });
      const ev = await f.next(ms);
      if (ev) {
        j = ev;
        fromGet = false;
        heard = Date.now();
      } else look = !f.live() || Date.now() >= due;
    }
  } finally {
    f.close();
  }
}

/**
 * Submits a Gen job (retrying a busy service) and waits for it. job: one submitted before (a Studio restart), waited on
 * instead of submitting again; onSubmit: the new job's id, as soon as Gen gives it (to record it for that).
 */
export async function genRun(tool: string, project: string, params: Record<string, unknown>, onUpdate?: (job: any) => void, timeoutMs = 4 * 60 * 60 * 1000, { job: reuse, onSubmit, halt }: { job?: string; onSubmit?: (id: string) => void; halt?: () => string | null } = {}) {
  if (reuse) return genWait(reuse, onUpdate, timeoutMs, halt);
  // Cancelled before it was submitted: nothing is submitted.
  const before = halt?.();
  if (before) return { id: null, status: 'cancelled', error: before, halted: true } as any;
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
  return genWait(job.id, onUpdate, timeoutMs, halt);
}

export const fileUrl = (asset: string) => `${GEN_PUBLIC_URL}/v1/files/${asset}`;
