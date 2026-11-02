// The Playtests page (dashboard/live.js, GET /api/playtests/live): every playtest playing now, waiting for a browser,
// or finished in the last half hour, from Hawkes Gen (`GET /v1/playtests/live`: each one's step, players' states,
// problems; the live video is Gen's `/v1/jobs/<id>/live.mjpeg`, through the /gen/ door) with what it is in Studio:
// the product, the run and step that asked for it (its history page), or the agent change it checks. One call per
// read for the whole grid; the maximized view asks Gen for one job's full state itself.
//
// Never read on a timer (J, 2026-11-02: "Please stop implementing polling"): the pushed feeds (feeds.ts) read when Hawkes
// Gen's event stream says a playtest.run job changed (followGen), and once when a page opens.

import { db, parse } from './db.ts';
import { gen, genEvents } from './gen.ts';
import { pokeFeeds } from './feeds.ts';
import { loadProducts } from './config.ts';

type Ctx = { product: string | null; productName: string | null; by: string; step?: string | null; run?: string | null; change?: string | null; changeTitle?: string | null; name?: string | null };

const names = () => Object.fromEntries(loadProducts().map((p: any) => [p.id, p.name]));

/** Who asked for each job: a Studio run's step, or an agent change (its verification jobs). */
function contexts(jobs: string[]): Map<string, Ctx> {
  const out = new Map<string, Ctx>();
  if (!jobs.length) return out;
  const n = names();
  const marks = jobs.map(() => '?').join(',');
  for (const s of db.prepare(`SELECT id, run, product, name, job FROM steps WHERE kind = 'playtest' AND job IN (${marks})`).all(...jobs) as any[]) {
    out.set(s.job, { product: s.product, productName: n[s.product] ?? s.product, by: 'Studio run', step: s.id, run: s.run, name: s.name });
  }
  const want = new Set(jobs.filter((j) => !out.has(j)));
  if (want.size) {
    for (const c of db.prepare(`SELECT id, product, title, phase FROM changes WHERE updated > ? ORDER BY updated DESC LIMIT 300`).all(Date.now() - 24 * 3600_000) as any[]) {
      const ph = parse(c.phase);
      for (const job of Object.values(ph?.jobs ?? {})) {
        if (typeof job === 'string' && want.has(job)) out.set(job, { product: c.product, productName: n[c.product] ?? c.product, by: 'Agent check', change: c.id, changeTitle: c.title });
      }
    }
  }
  return out;
}

const finishedSince = () => Date.now() - 30 * 60_000;

/** A finished job as a grid tile: outcome, counts and the video, from its result. */
export function finishedTile(j: any) {
  const r = j.result && typeof j.result === 'object' ? j.result : {};
  const video = (j.outputs ?? []).find((o: any) => String(o.mime ?? '').startsWith('video/'))?.asset ?? null;
  const problems = Array.isArray(r.problems) ? r.problems : [];
  return {
    job: j.id, project: j.project, live: false, status: j.status, outcome: r.outcome ?? (j.status === 'failed' ? 'error' : null),
    startedAt: j.started ?? j.created, finishedAt: j.finished ?? null, step: j.status === 'failed' ? (j.error ?? 'failed') : r.outcome ?? 'done',
    scenario: r.scenario ? { id: r.scenario } : j.params?.scenario ? { id: j.params.scenario } : null, url: j.params?.url ?? r.url ?? null,
    device: r.device ?? (j.params?.mobile ? 'phone' : 'desktop'), seconds: r.seconds ?? null, fps: r.fps?.average ?? null,
    problems: { count: problems.length, last: problems.slice(0, 4).map((p: any) => ({ severity: p.severity ?? 'bug', message: String(p.message ?? '').slice(0, 300) })) },
    console: { errors: r.console?.errors ?? 0 }, video, peers: Number(j.params?.peers) || 1,
  };
}

let cache: { at: number; value: any } | null = null;

/** Keeps Gen's event stream open while a page watches the playtests, and makes the feeds read again when a playtest job changes. */
let followers = 0;
let unfollow: (() => void)[] = [];
export function holdGenEvents() {
  if (!followers++) {
    genEvents.hold('live-playtests');
    unfollow = [
      genEvents.onEvent((type, job) => { if (type === 'job' && job?.tool === 'playtest.run') pokeFeeds('playtest', 500); }),
      genEvents.onConnect(() => pokeFeeds('playtest', 0)),
    ];
  }
  return () => {
    if (--followers) return;
    for (const off of unfollow) off();
    unfollow = [];
    genEvents.release('live-playtests');
  };
}

/** The grid: playing, waiting, finished (newest first), each with its Studio context. Cached for a second (`fresh`: no cache). */
export async function livePlaytests({ fresh = false }: { fresh?: boolean } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 1000) return cache.value;
  const [now, recent] = await Promise.all([
    gen.request('/playtests/live'),
    gen.request('/jobs?tool=playtest.run&limit=40').catch(() => ({ jobs: [] })),
  ]);
  const live = new Set([...(now.playing ?? []).map((p: any) => p.job), ...(now.waiting ?? []).map((w: any) => w.job)]);
  const done = ((recent.jobs ?? []) as any[]).filter((j) => !live.has(j.id) && ['done', 'failed', 'cancelled'].includes(j.status) && (j.finished ?? j.created ?? 0) > finishedSince());
  const full = done.slice(0, 12);
  const ctx = contexts([...live, ...full.map((j: any) => j.id)]);
  const n = names();
  const withCtx = (x: any) => ({ ...x, ctx: ctx.get(x.job) ?? { product: x.project ?? null, productName: n[x.project] ?? x.project ?? null, by: 'Hawkes Gen' } });
  const value = {
    at: Date.now(), capacity: now.capacity ?? null, lanes: now.lanes ?? null,
    playing: (now.playing ?? []).map(withCtx),
    waiting: (now.waiting ?? []).map(withCtx),
    finished: full.map(finishedTile).sort((a: any, b: any) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).map(withCtx),
  };
  cache = { at: Date.now(), value };
  return value;
}
