// Hawkes Gen, from Studio: builds, playtests and reviews are Gen jobs (they show in its dashboard and library too).

// @ts-ignore: plain JS client (a copy of hawkesgen/clients/js/hawkesgen.mjs)
import { HawkesGen } from './hawkesgen.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GEN_URL, GEN_PUBLIC_URL, PROJECTS } from './config.ts';
import { GenEvents, nextLook, terminal, type JobFollower } from './genevents.ts';
import { submitKnown } from './gen-params.ts';

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
export const scoped = (b: any): any => {
  if (!b || typeof b !== 'object' || ArrayBuffer.isView(b) || b instanceof ArrayBuffer || (typeof Blob !== 'undefined' && b instanceof Blob)) return b;
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
        } catch (e: any) {
          // Gen doesn't know the job (404): it is gone, whatever the stream says. Nothing will ever finish it, so the wait
          // ends now as lost (builds.ts infraLost resubmits it) instead of after an hour of misses or the build's timeout.
          if (e?.status === 404 || /no such job/i.test(String(e?.message ?? ''))) return { id, status: 'failed', error: `Hawkes Gen lost job ${id} (no such job)`, lost: true };
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
        return { ...j, status: 'failed', error: `timed out after ${Math.round(timeoutMs / 60000)} min`, timedOut: true, lastDetail: j.detail ?? null };
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
      job = await submitKnown((t, b) => gen.submit(t, b), tool, { project, params });
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

/** The bare link: Gen answers it with "Sign in first" to anyone without a session, so people get signedFileUrl. */
export const fileUrl = (asset: string) => `${GEN_PUBLIC_URL}/v1/files/${asset}`;

const SIGN_DAYS = 7;
const signed = new Map<string, { url: string; until: number }>();
/**
 * A link a person can open without signing in: Gen's signed, expiring one (POST /v1/assets/:id?sign=1&ttl=<days>).
 * Made when a page or message is rendered, never stored (it expires); kept in memory for an hour so a page of
 * screenshots asks once per file. Any failure (old Gen, no ownership, offline) gives the bare link.
 */
export async function signedFileUrl(asset: string, { api = gen, days = SIGN_DAYS }: { api?: { request(p: string, o?: any): Promise<any> }; days?: number } = {}): Promise<string> {
  const bare = fileUrl(asset);
  if (!/^a_[0-9a-f]+$/.test(String(asset))) return bare;
  const hit = signed.get(asset);
  if (hit && hit.until > Date.now()) return hit.url;
  try {
    const r = await api.request(`/assets/${asset}?sign=1&ttl=${days}`, { method: 'POST' });
    const raw = String(r?.url ?? r?.signed_url ?? r?.signedUrl ?? '');
    if (!raw || !/[?&]sig=/.test(raw)) return bare;
    const url = /^https?:\/\//.test(raw) ? raw : `${GEN_PUBLIC_URL}${raw.startsWith('/') ? '' : '/'}${raw}`;
    if (signed.size > 2000) signed.clear();
    signed.set(asset, { url, until: Date.now() + 3_600_000 });
    return url;
  } catch {
    return bare;
  }
}
export const clearSignedFileUrls = () => signed.clear();

/**
 * Signs every Gen file link in a text (a message, a report), at the moment it is shown. Bare links get a signature;
 * links that already carry one (the model copies them from tool results, and stored text keeps them) are signed again,
 * fresh, so an old message never shows an expired link. Only a plain `?exp=..&sig=..` query is taken as the old
 * signature; its end is the first character that can't be part of a URL in Markdown (space, `)`, `]`, quote, `<`).
 */
export async function signFileLinks(text: string, opts?: Parameters<typeof signedFileUrl>[1]): Promise<string> {
  const re = new RegExp(`${GEN_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/v1/files/(a_[0-9a-f]+)(?![0-9a-f])(?:\\?(?:[A-Za-z0-9_%~=&-]*(?:exp|sig)=)[A-Za-z0-9_%~=&-]*)?`, 'g');
  const ids = [...new Set([...String(text).matchAll(re)].map((m) => m[1]))];
  if (!ids.length) return text;
  const urls = new Map(await Promise.all(ids.map(async (id) => [id, await signedFileUrl(id, opts)] as const)));
  // A failed signing gives the bare link: don't let that replace a link that still carried its own signature.
  return String(text).replace(re, (m, id) => {
    const u = urls.get(id);
    return !u || (/[?&]sig=/.test(m) && !/[?&]sig=/.test(u)) ? m : u;
  });
}
