// The build page (J, 2026-11-04: "I want to be able to see the logs of the build in studio if I were to click on its link in
// activity"). One run of kind "build" -> its builds (status, step, elapsed time, commit, Gen job) and the log:
//   - a build still going: asked of Hawkes Gen when the page opens or Refresh is pressed (the job's "Unity log" output
//     when it already exists, else the job's own log lines, which Gen keeps while it works), the tail of it, and the last
//     line with how long it has been the same ("stuck or building")
//   - a build that ended: the log Studio kept on the row (buildfail.ts) and the failure in plain words; a good build's log
//     is asked of Gen if it still has the job
// No polling: the page fetches on open, on Refresh and when the push stream says a build row changed.

import { db } from './db.ts';
import { LOG_LINES, failureOf } from './buildfail.ts';

type JobApi = { job(id: string): Promise<any>; bytes(asset: string): Promise<Uint8Array | Buffer> };

const LOG_BYTES = 60_000;

/** The last line of a job's log and since when Studio has seen it unchanged. Gen's log lines carry no time, so Studio notes when it saw a line change. */
const seen = new Map<string, { sig: string; since: number; first: number }>();

/** How long the log has stayed as it is, as far as Studio has watched (`first` is when Studio first looked). Exported for the tests. */
export function logAge(jobId: string, lines: string[], now = Date.now()): { lastLine: string | null; unchangedSeconds: number | null; watchedSeconds: number; lines: number } {
  const last = [...lines].reverse().find((l) => l.trim()) ?? null;
  const sig = `${lines.length}|${last ?? ''}`;
  const s = seen.get(jobId);
  if (!s || s.sig !== sig) {
    seen.set(jobId, { sig, since: now, first: s?.first ?? now });
    if (seen.size > 200) seen.delete(seen.keys().next().value as string);
    // The very first look can't say how long it was like that.
    return { lastLine: last, unchangedSeconds: s ? 0 : null, watchedSeconds: s ? Math.round((now - s.first) / 1000) : 0, lines: lines.length };
  }
  return { lastLine: last, unchangedSeconds: Math.round((now - s.since) / 1000), watchedSeconds: Math.round((now - s.first) / 1000), lines: lines.length };
}

const tailOf = (text: string, lines = LOG_LINES) => {
  const all = text.split(/\r?\n/);
  const t = all.slice(-lines).join('\n');
  return { text: t.length > LOG_BYTES ? t.slice(-LOG_BYTES) : t, total: all.length, cut: all.length > lines };
};

/** What Gen has of a job's log now: [source, text]. */
async function genLog(jobId: string, api: JobApi): Promise<{ job: any; source: string; text: string } | { job: null; error: string }> {
  let job: any;
  try { job = await api.job(jobId); } catch (e: any) { return { job: null, error: e?.status === 404 ? `Hawkes Gen doesn't know job ${jobId} any more.` : `Couldn't ask Hawkes Gen about ${jobId}: ${String(e?.message ?? e).slice(0, 200)}` }; }
  const out = (job?.outputs ?? []).find((x: any) => /unity log/i.test(String(x.title ?? '')));
  if (out?.asset) {
    try { return { job, source: out.title || 'Unity log', text: Buffer.from(await api.bytes(out.asset)).toString('utf8') }; } catch { /* fall through to the job's own lines */ }
  }
  const lines: string[] = Array.isArray(job?.log) ? job.log.map((l: unknown) => (typeof l === 'string' ? l : JSON.stringify(l))) : [];
  const tail = Array.isArray(job?.result?.logTail) ? job.result.logTail.map(String) : [];
  return { job, source: lines.length ? 'Hawkes Gen job log (the Unity log is attached when the build ends)' : 'no log yet', text: [...lines, ...(tail.length ? ['--- Unity log (tail) ---', ...tail] : [])].join('\n') };
}

export type BuildPageBuild = {
  id: string | null; build: string; version: number | null; state: 'starting' | 'building' | 'ready' | 'failed' | 'cancelled' | string;
  step: string | null; started: number | null; finished: number | null; elapsedSeconds: number | null;
  sha: string | null; ref: string | null; genJob: string | null; genStatus: string | null; genDetail: string | null; url: string | null;
  failure: { plain: string; kind: string | null; class: string | null; stepWords: string | null; reason: string } | null;
  log: { source: string; text: string; total: number; cut: boolean } | null; logError: string | null;
  progress: { lastLine: string | null; unchangedSeconds: number | null; watchedSeconds: number; lines: number; verdict: 'building' | 'maybe stuck' | 'unknown' | 'ended' } | null;
};

/** After this long with the same last line a build is flagged "maybe stuck" (Unity imports go quiet for minutes). */
export const STUCK_AFTER_S = 10 * 60;

/** A run of kind build, as the build page shows it; null when the run is not one. */
export async function buildPage(runId: string, { api, now = Date.now() }: { api?: JobApi; now?: number } = {}) {
  const run = db.prepare("SELECT id, kind, status, detail, products, options, started, finished FROM runs WHERE id = ?").get(runId) as any;
  if (!run || run.kind !== 'build') return null;
  const gen = api ?? (await import('./gen.ts')).gen as unknown as JobApi;
  let want: string[] = [];
  try { const o = JSON.parse(run.options ?? '{}'); want = Array.isArray(o.builds) ? o.builds.map(String) : []; } catch { /* none named */ }
  const rows = db.prepare('SELECT * FROM builds WHERE run = ? ORDER BY started').all(runId) as any[];
  const product = (() => { try { return String(JSON.parse(run.products ?? '[]')[0] ?? rows[0]?.product ?? ''); } catch { return rows[0]?.product ?? ''; } })();
  const steps = db.prepare("SELECT name, status, detail FROM steps WHERE run = ? AND kind = 'build'").all(runId) as any[];
  const ids = [...new Set([...rows.map((r) => r.build), ...want])];
  const builds: BuildPageBuild[] = [];
  for (const id of ids) {
    const r = [...rows].reverse().find((x) => x.build === id);
    const step = steps.find((s) => s.name === id);
    if (!r) { builds.push({ id: null, build: id, version: null, state: run.status === 'running' ? 'starting' : step?.status ?? 'cancelled', step: step?.detail ?? null, started: null, finished: null, elapsedSeconds: null, sha: null, ref: null, genJob: null, genStatus: null, genDetail: null, url: null, failure: null, log: null, logError: null, progress: null }); continue; }
    const going = r.status === 'building';
    const f = failureOf(r);
    const b: BuildPageBuild = {
      id: r.id, build: r.build, version: r.version, state: r.status, step: step?.detail ?? null, started: r.started, finished: r.finished ?? null,
      elapsedSeconds: Math.max(0, Math.round(((r.finished ?? now) - r.started) / 1000)), sha: r.sha ?? null, ref: r.ref ?? null, genJob: f.genJob, genStatus: null, genDetail: null, url: r.url ?? null,
      failure: r.status === 'failed' ? { plain: f.plain, kind: f.kind, class: f.class, stepWords: f.stepWords, reason: f.reason } : null,
      log: null, logError: null, progress: null,
    };
    if (b.failure && r.fail_log) b.log = { source: 'The log Studio kept when it failed', ...tailOf(String(r.fail_log)) };
    // Hawkes Gen: on demand, for a build going now, or one that ended without a kept log (a good build's, if Gen still has it).
    if (b.genJob && (going || !b.log)) {
      const g = await genLog(b.genJob, gen);
      if (!('error' in g)) {
        b.genStatus = String(g.job.status ?? '') || null;
        b.genDetail = g.job.detail ? String(g.job.detail).slice(0, 300) : null;
        if (g.text) b.log = { source: g.source, ...tailOf(g.text) };
        if (going) {
          const age = logAge(b.genJob, g.text ? g.text.split(/\r?\n/) : [], now);
          const idle = age.unchangedSeconds;
          b.progress = { ...age, verdict: !g.text ? 'unknown' : idle == null ? 'unknown' : idle >= STUCK_AFTER_S ? 'maybe stuck' : 'building' };
        }
      } else b.logError = g.error;
    } else if (going) {
      b.progress = { lastLine: null, unchangedSeconds: null, watchedSeconds: 0, lines: 0, verdict: 'unknown' };
    }
    if (!going && !b.log && !b.logError) b.logError = r.status === 'failed' ? 'Hawkes Gen kept no log for this build.' : null;
    builds.push(b);
  }
  return { run: { id: run.id, status: run.status, detail: run.detail ?? null, started: run.started, finished: run.finished ?? null, product }, builds, now };
}
