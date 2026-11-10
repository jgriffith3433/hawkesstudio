// Playtests at once and the GPU provider order (Settings → 🎮 Playtests; J, 2026-11-01: "Can you make that a setting in
// studio? The amount of playtests?" and "do we have a way of choosing other GPU providers? (Modal has credit...)").
//
// Hawkes Gen runs the playtests, so Gen holds the real numbers: GET /v1/playtest/capacity answers
//   { browsers, perWorker, providers: [{ id, kind, enabled, maxBrowsers, ok, reason }] }
// and PUT /v1/playtest/capacity { browsers?, providers?: [ordered ids] } answers what it applied (clamped to what each
// provider account allows). Studio keeps what J asked for (the `settings` table, key `playtests`) so a Gen without the
// API yet (404) keeps his value: it is sent when the Settings tab is next opened and Gen has the API (on open and after a
// save, never on a timer). The studio's own setting: a customer's Studio neither sees nor changes it (settings.ts).

import { db, J, parse } from './db.ts';
import { StudioError } from './config.ts';

export type Provider = { id: string; kind?: string; enabled?: boolean; maxBrowsers?: number | null; ok?: boolean; reason?: string | null };
export type GenCapacity = { browsers?: number; perWorker?: number; providers?: Provider[] };
export type GenState = 'ok' | 'missing' | 'offline' | 'error';
export type Wanted = { browsers?: number; providers?: string[]; pending?: boolean };
export type PlaytestSettings = {
  /** Playtests at once: what Gen runs now, or (Gen without the API, or not answering) what J asked for. */
  browsers: number | null;
  /** The providers in use, in order (ids): Gen's, or what J asked for. */
  providers: string[];
  /** What J last asked for in Studio, and whether Gen still has to get it (it lacked the API or didn't answer). */
  wanted: Wanted | null;
  gen: { state: GenState; note?: string; perWorker?: number | null; providers: Provider[] };
  saved: number | null;
  by: string | null;
};

export const MAX_BROWSERS = 64;
export const NEEDS_GEN = "needs Hawkes Gen's next release";
const KEY = 'playtests';
const TIMEOUT_MS = 8000;

/** How Studio asks Gen (gen.ts's client and key; tests replace it). */
export const capacityApi = {
  request: async (p: string, o: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<any> => (await import('./gen.ts')).gen.request(p, o),
};

function stored(): { value: Wanted; updated: number; by: string | null } | null {
  const r = db.prepare('SELECT value, updated, by FROM settings WHERE key = ?').get(KEY) as { value: string; updated: number; by: string | null } | undefined;
  return r ? { value: (parse(r.value) ?? {}) as Wanted, updated: r.updated, by: r.by } : null;
}
function store(value: Wanted, by: string) {
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(KEY, J(value), Date.now(), by);
}

/** Gen's answer, or why there is none: 404 is a Gen from before the API, status 0 or a timeout is Gen not answering. */
async function ask(method: 'GET' | 'PUT', body?: unknown): Promise<{ state: 'ok'; data: GenCapacity } | { state: Exclude<GenState, 'ok'>; note: string; status?: number }> {
  try {
    const data = await capacityApi.request('/playtest/capacity', { method, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { state: 'ok', data: (data ?? {}) as GenCapacity };
  } catch (e: any) {
    const status = Number(e?.status);
    if (status === 404) return { state: 'missing', note: NEEDS_GEN, status };
    if (status === 0 || e?.kind === 'offline' || e?.name === 'TimeoutError' || e?.name === 'AbortError') return { state: 'offline', note: `Hawkes Gen didn't answer (${String(e?.message ?? e).slice(0, 200)})`, status: 0 };
    return { state: 'error', note: `Hawkes Gen: ${String(e?.message ?? e).slice(0, 300)}`, status: Number.isFinite(status) ? status : undefined };
  }
}

const cleanProviders = (list: unknown): Provider[] => (Array.isArray(list) ? list : [])
  .filter((p: any) => p && typeof p.id === 'string')
  .map((p: any) => ({ id: String(p.id), kind: p.kind != null ? String(p.kind) : undefined, enabled: p.enabled !== false, maxBrowsers: Number.isFinite(Number(p.maxBrowsers)) && p.maxBrowsers !== null ? Number(p.maxBrowsers) : null, ok: p.ok !== false, reason: p.reason ? String(p.reason).slice(0, 300) : null }));

function view(gen: { state: GenState; note?: string; data?: GenCapacity }, row = stored()): PlaytestSettings {
  const wanted = row?.value && (row.value.browsers !== undefined || row.value.providers) ? row.value : null;
  const providers = cleanProviders(gen.data?.providers);
  const live = gen.state === 'ok' && gen.data;
  const browsers = live && Number.isFinite(Number(gen.data!.browsers)) ? Number(gen.data!.browsers) : wanted?.browsers ?? null;
  let note = gen.note;
  // Gen clamps to what the provider accounts allow: say so when it gave fewer than J asked for.
  if (live && wanted?.browsers !== undefined && browsers !== null && browsers < wanted.browsers && !wanted.pending) {
    note = `You asked for ${wanted.browsers}; Gen runs ${browsers}, all the GPU provider accounts allow now.`;
  }
  return {
    browsers,
    providers: live && providers.length ? providers.filter((p) => p.enabled).map((p) => p.id) : wanted?.providers ?? [],
    wanted,
    gen: { state: gen.state, ...(note ? { note } : {}), perWorker: live && Number.isFinite(Number(gen.data!.perWorker)) ? Number(gen.data!.perWorker) : null, providers },
    saved: row?.updated ?? null,
    by: row?.by ?? null,
  };
}

/** What Studio has without asking Gen (for checking a change against: settings.ts costRaising). */
export function playtestSettingsLocal(): PlaytestSettings {
  return view({ state: 'offline', note: 'not asked' });
}

/**
 * The setting as the Settings tab shows it: asks Gen once. A value J saved while Gen lacked the API (pending) is sent
 * now if Gen has it.
 */
export async function playtestSettings(): Promise<PlaytestSettings> {
  const row = stored();
  if (row?.value.pending) {
    const { pending, ...want } = row.value;
    const put = await ask('PUT', want);
    if (put.state === 'ok') {
      store(want, row.by ?? 'J');
      console.log(`[playtests] sent the saved capacity to Gen: ${J(want)}`);
    } else if (put.state === 'error' && put.status !== undefined && put.status >= 400 && put.status < 500) {
      // Gen has the API and refused the value: stop resending it, and say why.
      store(want, row.by ?? 'J');
      const got = await ask('GET');
      return view(got.state === 'ok' ? { ...got, note: `Gen didn't take your saved value: ${put.note}` } : got);
    } else return view(put);
  }
  return view(await ask('GET'));
}

/** Validates a patch: { browsers: 1..MAX_BROWSERS, providers: ordered ids of the providers to use }. */
export function cleanPatch(patch: Record<string, any>): { browsers?: number; providers?: string[] } {
  const out: { browsers?: number; providers?: string[] } = {};
  for (const k of Object.keys(patch)) if (k !== 'browsers' && k !== 'providers') throw new StudioError(`playtests.${k}: not a setting (browsers, providers)`);
  if (patch.browsers !== undefined) {
    const n = Number(patch.browsers);
    if (!(Number.isInteger(n) && n >= 1 && n <= MAX_BROWSERS)) throw new StudioError(`playtests.browsers: a whole number, 1 to ${MAX_BROWSERS}`);
    out.browsers = n;
  }
  if (patch.providers !== undefined) {
    const list = patch.providers;
    if (!Array.isArray(list) || !list.length) throw new StudioError('playtests.providers: the GPU providers to use, in order (at least one id)');
    const ids = list.map((x) => String(x).trim());
    if (ids.some((id) => !/^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(id))) throw new StudioError('playtests.providers: provider ids like runpod, modal');
    if (new Set(ids).size !== ids.length) throw new StudioError('playtests.providers: each provider once');
    out.providers = ids;
  }
  if (out.browsers === undefined && !out.providers) throw new StudioError('playtests: browsers and/or providers');
  return out;
}

/**
 * Saves J's value in Studio and sends it to Gen. Gen without the API (404) or not answering: kept, and sent when the tab
 * is next opened. Gen refusing it (another 4xx): an error, nothing kept. Then the tab's view, asked of Gen again.
 */
export async function savePlaytestSettings(patch: Record<string, any>, by: string): Promise<PlaytestSettings> {
  const clean = cleanPatch(patch);
  const prev = stored()?.value ?? {};
  const want: Wanted = { ...(prev.browsers !== undefined ? { browsers: prev.browsers } : {}), ...(prev.providers ? { providers: prev.providers } : {}), ...clean };
  const put = await ask('PUT', clean);
  if (put.state === 'error' && put.status !== undefined && put.status >= 400 && put.status < 500) throw new StudioError(put.note, 400);
  if (put.state !== 'ok') {
    store({ ...want, pending: true }, by);
    return view(put);
  }
  store(want, by);
  const got = await ask('GET');
  // An answer to the GET is the fuller one; if it failed, what the PUT said it applied.
  return view(got.state === 'ok' ? got : { state: 'ok', data: put.data });
}

/** The most browsers a run asks Gen for by itself (Settings can set up to MAX_BROWSERS). */
export const AUTO_BROWSERS = 12;

/**
 * A daily run that plays many projects lifts Gen's browser cap to what it needs (J: "lift the 4-browser cap"), one
 * PUT at the start of the run, never on a timer. Only when J hasn't chosen a number in Settings (his value stands), and
 * never lowers it. Gen clamps to what its provider accounts allow. Returns the number Gen runs now, or null.
 */
export async function raiseForRun(plays: number): Promise<number | null> {
  try {
    const want = Math.min(AUTO_BROWSERS, Math.max(0, Math.round(plays)));
    if (stored()?.value.browsers !== undefined) return null;
    const got = await ask('GET');
    if (got.state !== 'ok') return null;
    const now = Number(got.data.browsers);
    if (!Number.isFinite(now) || now >= want) return Number.isFinite(now) ? now : null;
    const put = await ask('PUT', { browsers: want });
    if (put.state !== 'ok') return now;
    console.log(`[playtests] a run with ${plays} playtests: browsers ${now} -> ${Number(put.data.browsers) || want}`);
    return Number(put.data.browsers) || want;
  } catch { return null; }
}

/**
 * Why a queued playtest is still waiting, in one plain sentence from Gen's live view (tabs in use, how many are ahead).
 * Asked once per change of the job's state (an event), not on a timer. null when Gen can't say.
 */
export async function waitReason(job: string): Promise<string | null> {
  try {
    const now = await capacityApi.request('/playtests/live', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const waiting: any[] = now?.waiting ?? [];
    const i = waiting.findIndex((w) => w.job === job);
    if (i < 0) return null;
    // Gen's own reason for this job comes first: it names the lane the job really waits on (a Cloud Run or RunPod
    // lane, a project's share). `lanes` is only Gen's generic playtest lane, which on 2026-11-10 read "1 of 1" while the
    // jobs waited on another lane, so the step named the wrong cause for an hour.
    const own = String(waiting[i]?.detail ?? '').trim();
    if (/^waiting\b/i.test(own) && own.length > 'waiting'.length + 2) return `${own.replace(/^waiting:?\s*/i, 'waiting for a free browser: ').replace(/\.$/, '')}, ${i} ahead in the queue`;
    const lanes = now?.lanes, cap = now?.capacity;
    const limit = Number(lanes?.limit ?? cap?.browsers ?? cap?.limit), used = Number(lanes?.used ?? (now?.playing ?? []).length);
    const tabs = Number.isFinite(limit) && limit > 0 ? `${Math.min(used, limit)} of ${limit} browser tabs are in use` : `${(now?.playing ?? []).length} playtests are playing`;
    return `waiting for a free browser: ${tabs}, ${i} ahead in the queue`;
  } catch { return null; }
}
