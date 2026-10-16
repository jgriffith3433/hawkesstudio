// Playtests across runs: the Playtests tab (every playtest with its video, screenshots, timeline and review), the
// comparison with the previous run of the same scenario, trends (fps, load time, review scores per day) and the
// regressions the report flags. Also how the pipeline runs a playtest job so it can never hang a run.
//
// A playtest is a Studio step (kind "playtest", name "<scenario>@<where>" or "<scenario>@<where>:phone") whose job is
// Hawkes Gen's playtest.run; its review is the "review" step of the same run, product and name. The full recording
// (timeline, console, screenshots, visual diffs) is the Gen job's result; videos and reports are also in S3.

import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { db, rowToStep, type Step } from './db.ts';
import { gen, ensureGen, fileUrl } from './gen.ts';
import { PROJECTS, GEN_PUBLIC_URL, today, type Playtest } from './config.ts';

// ------------------------------------------------------------ running one (never stuck)

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * Submits a Gen job and waits for it, with two limits: how long it may wait in Gen's queue (other playtests ahead of
 * it are not a hang) and how long it may run once started. Past either, the job is cancelled and returned as failed.
 * Never throws for a failed job.
 */
export async function runGenJob(tool: string, project: string, params: Record<string, unknown>, onUpdate: (job: any) => void, { runMs, queueMs = 6 * 3600_000, job: reuse }: { runMs: number; queueMs?: number; job?: string }) {
  // A job submitted before a Studio restart (pipeline.ts resumes runs): waited on again, not submitted again.
  let job: any = reuse ? { id: reuse } : null;
  for (let i = 0; !job; i++) {
    try {
      job = await gen.submit(tool, { project, params });
      break;
    } catch (e: any) {
      if ((e.kind !== 'offline' && !/reach|fetch failed|ECONN/i.test(String(e.message))) || i >= 20) throw e;
      if (i === 3) await ensureGen();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  onUpdate({ ...job, detail: job.detail ?? (reuse ? 'waiting for it again after a Studio restart' : 'queued') });
  const submitted = Date.now();
  let started = 0;
  let last = '';
  let misses = 0;
  for (;;) {
    let j: any;
    try {
      j = await gen.job(job.id);
      misses = 0;
    } catch (e: any) {
      // Gen restarting (jobs resume) or busy: keep trying for a few minutes.
      if (++misses > 90) return { ...job, status: 'failed', error: `Hawkes Gen stopped answering: ${e.message}` };
      if (misses === 10) await ensureGen();
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const sig = `${j.status}|${j.detail}`;
    if (sig !== last) {
      last = sig;
      onUpdate(j);
    }
    if (TERMINAL.has(j.status)) return j;
    if (j.status === 'running' && !started) started = Date.now();
    const over = started ? (Date.now() - started > runMs ? `ran for over ${Math.round(runMs / 60000)} min` : '') : Date.now() - submitted > queueMs ? `waited in the queue for over ${Math.round(queueMs / 60000)} min` : '';
    if (over) {
      await gen.cancel(job.id).catch(() => {});
      return { ...j, status: 'failed', error: `stuck: ${over}, so it was cancelled` };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** How long a playtest job may run: the scenario's limit, plus loading, a first-time browser install on a GPU server and the upload. */
export const playtestRunMs = (t: Playtest) => ((t.timeout ?? 1800) + 1800) * 1000;
export const REVIEW_RUN_MS = 20 * 60_000;

export const isPhone = (t: Playtest) => t.device === 'phone';

/** Gen params for a playtest's device and baseline (the previous run of the same scenario, for the visual diff). */
export function playtestExtras(product: string, name: string, t: Playtest) {
  const prev = db.prepare(`SELECT job FROM steps WHERE product = ? AND kind = 'playtest' AND name = ? AND status = 'done' AND job IS NOT NULL ORDER BY started DESC LIMIT 1`).get(product, name) as any;
  return { ...(isPhone(t) ? { mobile: true } : {}), ...(prev?.job ? { baseline: prev.job } : {}) };
}

/** What a playtest step keeps (the rest stays in the Gen job). */
export function playtestData(job: any, url: string) {
  const r = job.result ?? {};
  const outs = job.outputs ?? [];
  return {
    outcome: r.outcome, mode: r.mode, device: r.device ?? 'desktop', seconds: r.seconds, loadSeconds: r.loadSeconds, fps: r.fps, software: r.software ?? null,
    browser: r.browser ?? null, stuck: r.stuck ?? null, metrics: r.metrics, problems: r.problems, scenarios: r.scenarios,
    video: r.video ?? outs.find((x: any) => x.kind === 'video')?.asset ?? null,
    thumb: r.shots?.length ? r.shots[r.shots.length - 1].asset : outs.filter((x: any) => x.kind === 'image').pop()?.asset ?? null,
    shots: r.shots?.length ?? 0,
    s3: r.s3 ?? null,
    visual: r.visual ? { baseline: r.visual.baseline, pairs: r.visual.pairs?.length ?? 0, big: r.visual.big ?? 0, top: (r.visual.pairs ?? []).filter((x: any) => x.big).slice(0, 4) } : null,
    url,
  };
}

// ------------------------------------------------------------ names

/** "smoke@live:phone" -> { scenario: "smoke", where: "live", device: "phone" } */
export function parseName(name: string) {
  const m = /^(.*)@(local|live)(?::(\w+))?$/.exec(name);
  return m ? { scenario: m[1], where: m[2], device: m[3] ?? 'desktop' } : { scenario: name, where: '', device: 'desktop' };
}

// ------------------------------------------------------------ list

const reviewOf = (s: Step) => {
  const r = db.prepare(`SELECT * FROM steps WHERE run = ? AND product = ? AND kind = 'review' AND name = ? ORDER BY started DESC LIMIT 1`).get(s.run, s.product, s.name);
  return r ? rowToStep(r) : null;
};

const avgScore = (scores: any) => {
  const v = Object.values(scores ?? {}).filter((x) => typeof x === 'number') as number[];
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

export const videoUrl = (s: Step) => (s.data?.s3?.video && !s.data?.s3?.error) || s.data?.video ? `/api/playtests/${s.id}/video` : null;

/** One row of the list. */
function summary(s: Step, review: Step | null) {
  const d = s.data ?? {};
  const v = review?.status === 'done' ? review.data : null;
  return {
    id: s.id, run: s.run, product: s.product, name: s.name, ...parseName(s.name), status: s.status, detail: s.detail, job: s.job,
    started: s.started, finished: s.finished,
    outcome: s.status === 'failed' ? (/stuck/i.test(s.detail ?? '') ? 'stuck' : 'failed') : s.status === 'running' ? 'running' : d.outcome ?? null,
    seconds: d.seconds ?? null, loadSeconds: d.loadSeconds ?? null, fps: d.fps?.average ?? null, software: d.software ?? null,
    problems: d.problems?.length ?? 0, video: videoUrl(s), thumb: d.thumb ?? v?.frames?.[v.frames.length - 1]?.asset ?? null, visualBig: d.visual?.big ?? 0,
    review: review ? { id: review.id, status: review.status, verdict: v?.verdict ?? null, score: avgScore(v?.scores), scores: v?.scores ?? null, findings: v?.findings?.length ?? 0, added: v?.added?.length ?? 0 } : null,
  };
}

export function listPlaytests(q: { product?: string; scenario?: string; where?: string; device?: string; outcome?: string; limit?: number; before?: number } = {}) {
  const where = [`kind = 'playtest'`];
  const args: any[] = [];
  if (q.product) { where.push('product = ?'); args.push(q.product); }
  if (q.scenario) { where.push('name LIKE ?'); args.push(`${q.scenario}@%`); }
  if (q.where) { where.push('name LIKE ?'); args.push(`%@${q.where}%`); }
  if (q.device === 'phone') where.push(`name LIKE '%:phone'`);
  if (q.device === 'desktop') where.push(`name NOT LIKE '%:phone'`);
  if (q.before) { where.push('started < ?'); args.push(q.before); }
  if (q.outcome === 'failed') where.push(`status = 'failed'`);
  else if (q.outcome === 'stuck') where.push(`(json_extract(data, '$.outcome') = 'stuck' OR (status = 'failed' AND detail LIKE '%stuck%'))`);
  else if (q.outcome === 'running') where.push(`status = 'running'`);
  else if (q.outcome) { where.push(`json_extract(data, '$.outcome') = ?`); args.push(q.outcome); }
  const limit = Math.min(500, q.limit ?? 100);
  const rows = (db.prepare(`SELECT * FROM steps WHERE ${where.join(' AND ')} ORDER BY started DESC LIMIT ?`).all(...args, limit) as any[]).map(rowToStep);
  // The reviews of these runs, in one query.
  const runs = [...new Set(rows.map((s) => s.run))];
  const reviews = runs.length ? (db.prepare(`SELECT * FROM steps WHERE kind = 'review' AND run IN (${runs.map(() => '?').join(',')}) ORDER BY started`).all(...runs) as any[]).map(rowToStep) : [];
  const rev = new Map(reviews.map((r) => [`${r.run}|${r.product}|${r.name}`, r]));
  const facets = db.prepare(`SELECT DISTINCT product, name FROM steps WHERE kind = 'playtest'`).all() as { product: string; name: string }[];
  return {
    playtests: rows.map((s) => summary(s, rev.get(`${s.run}|${s.product}|${s.name}`) ?? null)),
    scenarios: [...new Set(facets.filter((f) => !q.product || f.product === q.product).map((f) => parseName(f.name).scenario))].sort(),
    more: rows.length === limit ? rows[rows.length - 1].started : null,
  };
}

// ------------------------------------------------------------ detail

/** The Gen job's recording, with every screenshot's asset (older runs list them from the library). */
async function recording(s: Step | null) {
  if (!s?.job) return null;
  const job = await gen.job(s.job).catch(() => null);
  if (!job) return null;
  const r = job.result ?? {};
  let shots: any[] = (r.shots ?? []).filter((x: any) => x.asset);
  let diffs: any[] = [];
  if (!shots.length || r.visual?.pairs?.some((x: any) => x.diff)) {
    const items = (await gen.assets({ job: s.job, limit: 500 }).catch(() => ({ items: [] }))).items ?? [];
    if (!shots.length) shots = items.filter((a: any) => a.meta?.playtest === 'shot').map((a: any) => ({ t: a.meta.t, reason: a.meta.reason, scene: a.meta.scene, asset: a.id })).sort((a: any, b: any) => a.t - b.t);
    diffs = items.filter((a: any) => a.meta?.playtest === 'diff').map((a: any) => ({ asset: a.id, key: a.meta.key, score: a.meta.score }));
  }
  return {
    job: { id: job.id, status: job.status, error: job.error ?? null, detail: job.detail, log: (job.log ?? []).slice(-60), started: job.started, finished: job.finished, server: job.server ?? null },
    result: { ...r, shots: undefined, problems: r.problems ?? [], console: r.console ?? null, timeline: r.timeline ?? [], events: r.events ?? [], pages: r.pages ?? [] },
    shots, diffs,
  };
}

const compact = (s: Step | null, review: Step | null) => (s ? summary(s, review) : null);

export function previousPlaytest(s: Step): Step | null {
  const r = db.prepare(`SELECT * FROM steps WHERE kind = 'playtest' AND product = ? AND name = ? AND status = 'done' AND started < ? ORDER BY started DESC LIMIT 1`).get(s.product, s.name, s.started);
  return r ? rowToStep(r) : null;
}

export async function getPlaytest(id: string, { vs }: { vs?: string } = {}) {
  const row = db.prepare(`SELECT * FROM steps WHERE id = ? AND kind = 'playtest'`).get(id);
  if (!row) return null;
  const s = rowToStep(row);
  const review = reviewOf(s);
  const prevRow = vs ? db.prepare(`SELECT * FROM steps WHERE id = ? AND kind = 'playtest'`).get(vs) : null;
  const prev = prevRow ? rowToStep(prevRow) : previousPlaytest(s);
  const prevReview = prev ? reviewOf(prev) : null;
  const [rec, prevRec] = await Promise.all([recording(s), recording(prev)]);
  const ids = [...new Set([...(review?.data?.added ?? []), ...(review?.data?.updated ?? [])])];
  const findings = ids.length ? (db.prepare(`SELECT id, title, severity, status, seen, area FROM findings WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[]).map((f) => ({ ...f, isNew: review!.data.added?.includes(f.id) ?? false })) : [];
  const history = (db.prepare(`SELECT * FROM steps WHERE kind = 'playtest' AND product = ? AND name = ? ORDER BY started DESC LIMIT 30`).all(s.product, s.name) as any[]).map(rowToStep).map((x) => ({ id: x.id, started: x.started, outcome: summary(x, null).outcome }));
  return {
    playtest: summary(s, review), data: s.data, review: review ? { id: review.id, status: review.status, detail: review.detail, cost: review.cost, data: review.data } : null,
    recording: rec, findings, history,
    previous: prev ? { playtest: compact(prev, prevReview), data: prev.data, review: prevReview?.data ?? null, shots: prevRec?.shots ?? [], timeline: prevRec?.result?.timeline ?? [] } : null,
    links: { genJob: s.job ? `${GEN_PUBLIC_URL}/#job/${s.job}` : null, reviewJob: review?.job ? `${GEN_PUBLIC_URL}/#job/${review.job}` : null, report: s.data?.s3?.report ? `/api/playtests/${s.id}/report` : null },
  };
}

// ------------------------------------------------------------ video and report links

const hawkesgenRequire = createRequire(path.join(PROJECTS, 'hawkesgen', 'package.json'));
let presigner: Promise<{ client: any; GetObjectCommand: any; getSignedUrl: any }> | null = null;
const signed = new Map<string, { url: string; until: number }>();

/**
 * A short-lived link to a playtest file in S3. Studio uses Hawkes Gen's AWS SDK and the same credentials (the server's
 * IAM role; on J's PC, AWS keys in the environment if any).
 */
async function presign(bucket: string, key: string, region = 'us-east-1') {
  const hit = signed.get(`${bucket}/${key}`);
  if (hit && hit.until > Date.now()) return hit.url;
  presigner ??= (async () => {
    const s3 = await import(pathToFileURL(hawkesgenRequire.resolve('@aws-sdk/client-s3')).href);
    const pre = await import(pathToFileURL(hawkesgenRequire.resolve('@aws-sdk/s3-request-presigner')).href);
    return { client: new s3.S3Client({ region }), GetObjectCommand: s3.GetObjectCommand, getSignedUrl: pre.getSignedUrl };
  })();
  presigner.catch(() => (presigner = null));
  const p = await presigner;
  const url: string = await p.getSignedUrl(p.client, new p.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
  signed.set(`${bucket}/${key}`, { url, until: Date.now() + 50 * 60_000 });
  return url;
}

/** Where a playtest's video (or report) is: S3 when it was uploaded, else Hawkes Gen's library. */
export async function fileLink(id: string, what: 'video' | 'report') {
  const row = db.prepare(`SELECT * FROM steps WHERE id = ? AND kind = 'playtest'`).get(id);
  if (!row) return null;
  const d = rowToStep(row).data ?? {};
  const key = d.s3 && !d.s3.error ? d.s3[what] : null;
  if (key) {
    try {
      return await presign(d.s3.bucket, key, d.s3.region);
    } catch (e: any) {
      console.warn(`[playtests] S3 link for ${id}: ${e.message}`);
    }
  }
  if (what === 'video' && d.video) return fileUrl(d.video);
  if (what === 'report' && row && (row as any).job) {
    const job = await gen.job((row as any).job).catch(() => null);
    const rep = job?.outputs?.find((x: any) => x.mime === 'application/json')?.asset;
    if (rep) return fileUrl(rep);
  }
  return null;
}

// ------------------------------------------------------------ trends and regressions

/** fps, load time and review score per product, scenario and day (the day's average). */
export function trends(q: { product?: string; days?: number } = {}) {
  const since = Date.now() - (q.days ?? 30) * 86400_000;
  const rows = (db.prepare(`SELECT * FROM steps WHERE kind IN ('playtest', 'review') AND status = 'done' AND started >= ? ${q.product ? 'AND product = ?' : ''} ORDER BY started`).all(...([since, ...(q.product ? [q.product] : [])] as any[])) as any[]).map(rowToStep);
  const series = new Map<string, { product: string; name: string; days: Map<string, { fps: number[]; load: number[]; score: number[] }> }>();
  for (const s of rows) {
    const k = `${s.product}|${s.name}`;
    const se = series.get(k) ?? { product: s.product, name: s.name, days: new Map() };
    series.set(k, se);
    const day = today(new Date(s.started));
    const d = se.days.get(day) ?? { fps: [], load: [], score: [] };
    se.days.set(day, d);
    if (s.kind === 'playtest') {
      // Software-rendered frame rates say nothing about players.
      if (s.data?.fps?.average != null && !s.data?.software) d.fps.push(s.data.fps.average);
      if (s.data?.loadSeconds != null) d.load.push(s.data.loadSeconds);
    } else {
      const a = avgScore(s.data?.scores);
      if (a != null) d.score.push(a);
    }
  }
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  return {
    days: q.days ?? 30,
    series: [...series.values()].map((se) => ({
      product: se.product, name: se.name, ...parseName(se.name),
      points: [...se.days.entries()].map(([day, d]) => ({ day, fps: mean(d.fps), load: mean(d.load), score: mean(d.score) })),
    })).sort((a, b) => a.product.localeCompare(b.product) || a.name.localeCompare(b.name)),
  };
}

export type Regression = { product: string; name: string; kind: 'fps' | 'load' | 'score'; message: string; before: number; after: number; step: string };

/**
 * What got worse in a run against the previous run of each scenario: fps down more than 20%, load time up (more than
 * 25% and a second), or a review score down 2 or more.
 */
export function regressions(run: string): Regression[] {
  const out: Regression[] = [];
  const steps = (db.prepare(`SELECT * FROM steps WHERE run = ? AND kind = 'playtest' AND status = 'done'`).all(run) as any[]).map(rowToStep);
  for (const s of steps) {
    const prev = db.prepare(`SELECT * FROM steps WHERE kind = 'playtest' AND product = ? AND name = ? AND status = 'done' AND started < ? AND run != ? ORDER BY started DESC LIMIT 1`).get(s.product, s.name, s.started, run);
    if (!prev) continue;
    const p = rowToStep(prev);
    const a = p.data ?? {};
    const b = s.data ?? {};
    const base = { product: s.product, name: s.name, step: s.id };
    if (a.fps?.average && b.fps?.average != null && !a.software && !b.software && b.fps.average < a.fps.average * 0.8) {
      out.push({ ...base, kind: 'fps', before: a.fps.average, after: b.fps.average, message: `fps down ${Math.round((1 - b.fps.average / a.fps.average) * 100)}% (${a.fps.average} → ${b.fps.average})` });
    }
    if (a.loadSeconds != null && b.loadSeconds != null && b.loadSeconds > a.loadSeconds * 1.25 && b.loadSeconds - a.loadSeconds >= 1) {
      out.push({ ...base, kind: 'load', before: a.loadSeconds, after: b.loadSeconds, message: `load time up ${a.loadSeconds} s → ${b.loadSeconds} s` });
    }
    const ra = reviewOf(p);
    const rb = reviewOf(s);
    if (ra?.status === 'done' && rb?.status === 'done') {
      for (const [k, after] of Object.entries(rb.data?.scores ?? {}) as [string, number][]) {
        const before = ra.data?.scores?.[k];
        if (typeof before === 'number' && typeof after === 'number' && after <= before - 2) out.push({ ...base, kind: 'score', before, after, message: `${k} score down ${before} → ${after}` });
      }
    }
  }
  return out;
}
