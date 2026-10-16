// Everything running in the background right now, for the dashboard's Activity panel (GET /api/activity, polled every
// few seconds): agent changes (queued, working, verifying, revising), Studio runs with their current steps, Hawkes Gen
// jobs (builds, playtests, reviews, GPU work), and Talk answers in progress. Plus what finished in the last 15 minutes.

import { db, parse } from './db.ts';
import { GEN_PUBLIC_URL, getProduct, getInfra, isInfra } from './config.ts';
import { gen, genUp } from './gen.ts';

const name = (product: string) => {
  try {
    return isInfra(product) ? getInfra(product).name : getProduct(product).name;
  } catch {
    return product;
  }
};

const titles = new Map<string, string | null>();
const convTitle = (id: string) => {
  if (!titles.has(id)) titles.set(id, (db.prepare('SELECT title FROM conversations WHERE id = ?').get(id) as any)?.title ?? null);
  return titles.get(id) ?? 'a conversation';
};

function changeRow(c: any) {
  const log = (parse(c.log) ?? []) as string[];
  const v = parse(c.verify);
  return {
    id: c.id, product: c.product, productName: name(c.product), title: c.title, status: c.status, detail: c.detail,
    started: c.created, updated: c.updated, cost: c.cost ?? 0, pr: c.pr_url ?? null, preview: v?.preview ?? null,
    origin: c.origin ?? null, by: c.origin ? `Talk: ${convTitle(c.origin)}` : c.started_by ?? 'J', log: log.slice(-12),
  };
}

function runRow(r: any) {
  const steps = (db.prepare('SELECT id, product, kind, name, status, detail, job, started, finished FROM steps WHERE run = ? ORDER BY started').all(r.id) as any[]);
  const opts = parse(r.options) ?? {};
  const by = r.origin ? `Talk: ${convTitle(r.origin)}` : r.kind === 'daily' ? 'the daily schedule' : r.kind === 'beta' ? 'beta moved' : r.kind === 'live' ? 'a push to main' : /went live|rolled back/i.test(opts.focus ?? '') ? 'go live' : 'J';
  return {
    id: r.id, kind: r.kind, status: r.status, detail: r.detail, products: (parse(r.products) ?? []).map(name), started: r.started, finished: r.finished,
    cost: r.cost ?? 0, origin: r.origin ?? null, by, where: opts.where ?? null,
    steps: { total: steps.length, done: steps.filter((s) => s.status !== 'running').length, failed: steps.filter((s) => s.status === 'failed').length },
    now: steps.filter((s) => s.status === 'running').map((s) => ({ product: s.product, kind: s.kind, name: s.name, detail: s.detail, job: s.job, started: s.started })),
  };
}

export async function activity() {
  const changes = (db.prepare(`SELECT * FROM changes WHERE status IN ('queued', 'working', 'verifying', 'revising') ORDER BY created`).all() as any[]).map(changeRow);
  const runs = (db.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY started`).all() as any[]).map(runRow);
  const talk = (db.prepare(`SELECT id, title, messages, updated FROM conversations WHERE status = 'thinking'`).all() as any[]).map((c) => {
    const last = ((parse(c.messages) ?? []) as any[]).findLast((m) => m.role === 'user' || m.notice);
    return { id: c.id, title: c.title, since: last?.at ?? c.updated, auto: Boolean(last?.notice) };
  });
  // Hawkes Gen's queue: what Studio's steps are waiting on, and anything else (other projects, agents' verifications).
  let jobs: any[] = [];
  let genOk = true;
  try {
    if (!(await genUp())) throw new Error('down');
    jobs = ((await gen.jobs({ status: 'queued,running', limit: 60 })) as any[]).map((j) => ({
      id: j.id, tool: j.tool, project: j.project, status: j.status, detail: j.detail, created: j.created, started: j.started, server: j.server,
      link: `${GEN_PUBLIC_URL}/#job/${j.id}`,
    }));
  } catch {
    genOk = false;
  }
  const since = Date.now() - 15 * 60_000;
  const recent = [
    ...(db.prepare(`SELECT * FROM changes WHERE status IN ('ready', 'failed', 'merged') AND updated > ? ORDER BY updated DESC LIMIT 10`).all(since) as any[]).map((c) => ({ type: 'change', at: c.updated, ...changeRow(c), log: undefined })),
    ...(db.prepare(`SELECT * FROM runs WHERE status != 'running' AND finished > ? ORDER BY finished DESC LIMIT 10`).all(since) as any[]).map((r) => ({ type: 'run', at: r.finished, ...runRow(r) })),
  ].sort((a, b) => b.at - a.at);
  const stepJobs = new Set(runs.flatMap((r) => r.now.map((s: any) => s.job)).filter(Boolean));
  titles.clear();
  return {
    at: Date.now(), gen: genOk, changes, runs, jobs, talk, recent,
    // The header badge: things working now (a Gen job a run's step is waiting on counts once, as its run).
    count: changes.length + runs.length + talk.length + jobs.filter((j) => !stepJobs.has(j.id)).length,
  };
}
