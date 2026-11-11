// Hawkes Gen, from Studio: builds, playtests and reviews are Gen jobs (they show in its dashboard and library too).

// @ts-ignore: plain JS client (a copy of hawkesgen/clients/js/hawkesgen.mjs)
import { HawkesGen } from './hawkesgen.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GEN_URL, GEN_PUBLIC_URL, PROJECTS } from './config.ts';
import { GenEvents, nextLook, terminal, type JobFollower } from './genevents.ts';
import { submitKnown } from './gen-params.ts';
import { isGenBusy, noteGenBusy, submitTurn } from './genpace.ts';
import { unitySlot, type UnityPriority } from './unityslot.ts';

const isSubmit = (p: string, o: any) => String(p).split('?')[0] === '/jobs' && String(o?.method ?? 'GET').toUpperCase() === 'POST';
/** How long a submit Gen answers busy (429, 503) is tried again before the build fails (STUDIO_GEN_BUSY_MS: tests). */
export const GEN_BUSY_MS = () => Number(process.env.STUDIO_GEN_BUSY_MS ?? 15 * 60_000);

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
  const metered = async (p: string, o: any = {}) => {
    if (!isSubmit(p, o)) return raw(p, o);
    const C = await import('./credits.ts');
    try {
      return C.meteringOn() ? await C.meteredSubmit(raw, p, { ...o, body: scoped(o.body) }) : await raw(p, o);
    } catch (e) { throw C.genRefusal(e); }
  };
  // Gen busy (genpace.ts): a busy answer opens a calm window; submits wait it out and go out spaced.
  gen.request = async (p: string, o: any = {}) => {
    if (isSubmit(p, o)) await submitTurn();
    try { return await metered(p, o); } catch (e) {
      if (isGenBusy(e)) noteGenBusy(e, p);
      throw e;
    }
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

/** When Gen says a job started, in ms (a number or a date string), else null. */
function startedAt(j: any): number | null {
  const v = j?.started ?? j?.startedAt ?? j?.started_at;
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
}
/** When a job was made (Gen's `created`), else when the wait began. */
function queuedSince(j: any, fallback: number): number {
  const v = j?.created ?? j?.createdAt ?? j?.created_at;
  const n = v == null ? NaN : typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : fallback;
}

/**
 * Waits for a Gen job. A busy or restarting service is retried for a few minutes (jobs resume after a Gen
 * restart), so one missed look doesn't fail a long build. Never throws for a failed job: returns it.
 */
export async function genWait(id: string, onUpdate?: (job: any) => void, timeoutMs = 4 * 60 * 60 * 1000, halt?: () => string | null, { api = gen, events = genEvents, pollMs = 2000, fromStart = false }: { api?: { job(id: string): Promise<any>; cancel(id: string): Promise<any> }; events?: JobFollower; pollMs?: number; fromStart?: boolean } = {}) {
  // fromStart: timeoutMs times the job itself, from when Gen reports it started (status running, or its `started`), never
  // the time it sat queued behind other jobs (a builder lane runs 2 at a time; 2026-11-11 two Unity builds were cancelled
  // at 22 min having never started). The queue is not limited here: the run's halt and Gen's own limits end it.
  // The job's start and queue time are put on the job it returns (queuedMs, ranMs) for the report.
  const t0 = Date.now();
  let end = fromStart ? Infinity : t0 + timeoutMs;
  let begun: number | null = null;
  const noteStart = (job: any) => {
    if (begun !== null || !job) return;
    const at = startedAt(job);
    if (at === null && String(job.status) !== 'running') return;
    begun = at ?? Date.now();
    if (fromStart) end = begun + timeoutMs;
  };
  const timed = (job: any) => {
    if (begun === null) return { ...job, queuedMs: Math.max(0, Date.now() - queuedSince(job, t0)), ranMs: 0 };
    return { ...job, queuedMs: Math.max(0, begun - queuedSince(job, t0)), ranMs: Math.max(0, Date.now() - begun) };
  };
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
      noteStart(j);
      const sig = `${j.status}|${j.detail}`;
      if (sig !== last) {
        last = sig;
        onUpdate?.(j);
      }
      if (terminal(j)) {
        if (!fromGet) { look = true; continue; }
        return timed(j);
      }
      // The run it belongs to was cancelled (cancel.ts haltOf): the job is cancelled at once, whenever it was submitted.
      const why = halt?.();
      if (why) {
        await api.cancel(id).catch(() => {});
        return { ...timed(j), status: 'cancelled', error: why, halted: true };
      }
      if (Date.now() > end) {
        if (!fromGet) { look = true; continue; }
        return { ...timed(j), status: 'failed', error: `timed out after ${Math.round(timeoutMs / 60000)} min${fromStart ? ' of building' : ''}`, timedOut: true, lastDetail: j.detail ?? null };
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

type GenApi = { submit(tool: string, body: any): Promise<any>; job(id: string): Promise<any>; jobs(q: Record<string, string>): Promise<any[]>; cancel(id: string): Promise<any> };

/** Submits one Gen job, retrying a busy or unreachable service; Gen's job. */
async function submitGen(tool: string, project: string, params: Record<string, unknown>, api: GenApi) {
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    try {
      return await submitKnown((t, b) => api.submit(t, b), tool, { project, params });
    } catch (e: any) {
      // Busy (2026-11-10: Cloud Run had no room for Gen and Yooba Land's build failed on the first 429): nothing was
      // made and any credits were refunded, so it is sent again after the calm window, which the next submit waits out.
      if (isGenBusy(e) && Date.now() - t0 < GEN_BUSY_MS()) { noteGenBusy(e, '/jobs'); continue; }
      if ((e.kind !== 'offline' && !/reach|fetch failed|ECONN/i.test(String(e.message))) || i >= 20) throw e;
      if (i === 3) await ensureGen();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/**
 * Gen's queued and running unity.build jobs of one product (unityslot.ts: the look at Gen before a submit), each with its
 * params. Matched by the job's project, which is the product id genRun passes (a customer's cell: with its prefix).
 */
export async function outstandingUnityBuilds(product: string, api: Pick<GenApi, 'jobs' | 'job'> = gen as any): Promise<any[]> {
  const projects = new Set([product, String(genProject(product))]);
  const seen = new Map<string, any>();
  for (const status of ['queued', 'running']) {
    for (const x of ((await api.jobs({ tool: 'unity.build', status, limit: '50' })) ?? []) as any[]) {
      if (!x?.id || seen.has(String(x.id))) continue;
      if (x.tool && x.tool !== 'unity.build') continue;
      if (x.status && x.status !== 'queued' && x.status !== 'running') continue;
      if (x.project && !projects.has(String(x.project))) continue;
      seen.set(String(x.id), x);
    }
  }
  const out: any[] = [];
  for (const x of seen.values()) {
    const j = x.params && x.project ? x : await api.job(String(x.id)).catch(() => null);
    if (!j || !projects.has(String(j.project ?? x.project ?? ''))) continue;
    out.push(j);
  }
  return out;
}

/**
 * Submits a Gen job (retrying a busy service) and waits for it. job: one submitted before (a Studio restart), waited on
 * instead of submitting again; onSubmit: the new job's id, as soon as Gen gives it (to record it for that).
 *
 * Every unity.build (a player build, a package build, a compile check, a retry, a restart's) goes through its product's
 * one slot (unityslot.ts): one outstanding in Gen per product, the same build joined, one waiting, nothing left behind.
 * priority: 'person' for a build a person asked for (or the go-live release, a build-* tag), which no automatic request
 * replaces while it waits; paramsNow: the params made again for a request that waited its turn (a fresh token).
 * api, events, pollMs: test seams (Gen's client and its event stream by default).
 */
export async function genRun(tool: string, project: string, params: Record<string, unknown>, onUpdate?: (job: any) => void, timeoutMs = 4 * 60 * 60 * 1000, { job: reuse, onSubmit, halt, priority, paramsNow, identity, fromStart, api = gen as any, events = genEvents, pollMs }: { job?: string; onSubmit?: (id: string) => void; halt?: () => string | null; priority?: UnityPriority; paramsNow?: () => Promise<Record<string, unknown>>; identity?: string; fromStart?: boolean; api?: GenApi; events?: JobFollower; pollMs?: number } = {}) {
  // A unity.build's limit counts from when Gen starts it, not from the submit (fromStart; a queue can be an hour).
  const waitOpts = { api, events, ...(pollMs ? { pollMs } : {}), ...(fromStart ?? tool === 'unity.build' ? { fromStart: true } : {}) };
  // Cancelled before it was submitted: nothing is submitted.
  if (!reuse) {
    const before = halt?.();
    if (before) return { id: null, status: 'cancelled', error: before, halted: true } as any;
  }
  if (tool === 'unity.build') {
    const cancel = api === (gen as any)
      ? async (id: string, why: string) => (await import('./cancel.ts')).cancelJob(id, 'Studio', why)
      : (id: string) => api.cancel(id);
    return unitySlot({ product: project, params, priority, reuse, halt, onSubmit, paramsNow, identity }, {
      submit: (p) => submitGen(tool, project, p, api),
      wait: (id, upd) => genWait(id, upd, timeoutMs, halt, waitOpts),
      job: (id) => api.job(id),
      outstanding: () => outstandingUnityBuilds(project, api),
      cancel,
    }, onUpdate);
  }
  if (reuse) return genWait(reuse, onUpdate, timeoutMs, halt, waitOpts);
  const job = await submitGen(tool, project, params, api);
  onSubmit?.(job.id);
  return genWait(job.id, onUpdate, timeoutMs, halt, waitOpts);
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
