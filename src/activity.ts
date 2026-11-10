// Everything running in the background right now, for the dashboard's Activity panel (GET /api/activity, polled every
// few seconds): agent changes (queued, working, verifying, revising), Studio runs with their current steps, Hawkes Gen
// jobs (builds, playtests, reviews, GPU work), and Talk answers in progress. Plus what finished in the last 15 minutes.

import { db, parse } from './db.ts';
import { GEN_PUBLIC_URL, getProduct, getInfra, isInfra } from './config.ts';
import { gen, genUp } from './gen.ts';
import { listOps, runningCommands, loopHealth } from './ops.ts';
import { brainOfChange } from './agents.ts';
import { talkInfo } from './talk.ts';
import { brainLabel } from './brains.ts';
import { planView, planLine } from './runplan.ts';
import { cancelNote } from './cancel.ts';
import { roleArgs } from './roles.ts';
import { FAILED_HIDE_MS } from './scout.ts';

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

/** Builds a Unity change's branch before playtesting it (agents.ts verifyChange). */
const builds = (product: string) => {
  try {
    if (isInfra(product)) return false;
    const p = getProduct(product);
    return p.engine === 'unity' || Boolean(p.build);
  } catch {
    return false;
  }
};

/**
 * What the Activity panel's stages are drawn from (dashboard/activity.js ChangeStages): the kind of change, the step
 * its work is at (or failed at: agents.ts keeps it), which verification jobs it got to, and its verification's outcome.
 */
export function stageOf(c: any, v: any) {
  const ph = parse(c.phase);
  const jobs = ph?.jobs ?? {};
  return {
    infra: isInfra(c.product), unity: builds(c.product), step: ph?.step ?? null, failed: Boolean(ph?.failed),
    jobs: { build: Boolean(jobs.build), playtest: Boolean(jobs.playtest), review: Boolean(jobs.review) },
    outcome: v?.outcome ?? null,
    // When the current pass started (older phases have none: the change's creation), for the progress bar's creep.
    since: ph?.since ?? c.created ?? null,
  };
}

function changeRow(c: any) {
  const log = (parse(c.log) ?? []) as string[];
  const v = parse(c.verify);
  const b = brainOfChange(c);
  return {
    stage: stageOf(c, v),
    cancelled: c.status === 'cancelled' ? cancelNote(`change:${c.id}`) : null,
    id: c.id, product: c.product, productName: name(c.product), title: c.title, status: c.status, detail: c.detail,
    started: c.created, updated: c.updated, cost: c.cost ?? 0, pr: c.pr_url ?? null, preview: v?.preview ?? null,
    origin: c.origin ?? null, by: c.origin ? `Talk: ${convTitle(c.origin)}` : c.started_by ?? 'J', log: log.slice(-12),
    ...b,
  };
}

function runRow(r: any) {
  const steps = (db.prepare('SELECT id, product, kind, name, status, detail, job, started, finished FROM steps WHERE run = ? ORDER BY started').all(r.id) as any[]);
  const opts = parse(r.options) ?? {};
  const by = r.origin ? `Talk: ${convTitle(r.origin)}` : r.kind === 'daily' ? 'the daily schedule' : r.kind === 'beta' ? 'beta moved' : r.kind === 'live' ? 'a push to main' : /went live|rolled back/i.test(opts.focus ?? '') ? 'go live' : 'J';
  return {
    id: r.id, kind: r.kind, status: r.status, detail: r.detail, products: (parse(r.products) ?? []).map(name), started: r.started, finished: r.finished,
    cost: r.cost ?? 0, origin: r.origin ?? null, by, where: opts.where ?? null, cancelled: cancelNote(`run:${r.id}`),
    // The scenarios it will play, each one's state and verdict, and how far along it is (runplan.ts).
    plan: (() => { const v = planView(r.id); return v ? { ...v, line: planLine(v) } : null; })(),
    steps: { total: steps.length, done: steps.filter((s) => s.status !== 'running').length, failed: steps.filter((s) => s.status === 'failed').length },
    now: steps.filter((s) => s.status === 'running').map((s) => ({ product: s.product, kind: s.kind, name: s.name, detail: s.detail, job: s.job, started: s.started })),
    // Its playtests, for the screenshots player when J expands the card (frames.ts, GET /api/frames/<id>).
    playtests: steps.filter((s) => s.kind === 'playtest').map((s) => ({ id: s.id, product: name(s.product), name: s.name, status: s.status, job: Boolean(s.job) })),
  };
}

const scoutModel = () => { try { return roleArgs('scout').role.model ?? null; } catch { return null; } };

/** Cuts text to at most n characters at a word boundary, with an ellipsis (never mid-word). */
export function clip(s: string, n: number) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** A scout as one Activity row (the report is fetched when J opens it: GET /api/scouts/<id>, so the push payload stays small). */
export function scoutRow(x: any) {
  const partial = x.status === 'done' && /^partial report/.test(x.detail ?? '');
  return {
    id: x.id, product: x.product, productName: name(x.product), question: clip(String(x.question ?? '').replace(/\s+/g, ' '), 160),
    status: partial ? 'partial' : x.status, detail: x.detail ?? null, started: x.created, finished: x.finished ?? null, cost: x.cost ?? 0,
    origin: x.origin ?? null, by: x.origin ? `Talk: ${convTitle(x.origin)}` : 'J', hasReport: ['done', 'cancelled'].includes(x.status) && Boolean(x.report),
    // Live progress while it runs (scout.ts keeps the last steps and the turns used; the push stream carries each write).
    turns: x.turns ?? 0, log: (() => { try { return (JSON.parse(x.log ?? '[]') as string[]).slice(-6); } catch { return []; } })(),
    model: process.env.SCOUT_MODEL ?? scoutModel(), retryOf: x.retry_of ?? null,
    cancelled: x.status === 'cancelled' ? cancelNote(`scout:${x.id}`) : null,
  };
}

const SCOUT_COLS = 'id, product, question, status, detail, cost, origin, created, finished, turns, log, retry_of, dismissed, report IS NOT NULL AS report';
/**
 * The default list: running scouts, and finished ones from the last day that aren't dismissed; a failed one older than
 * 24 h drops out by itself (scout.ts FAILED_HIDE_MS). Hidden = everything else, under "Show dismissed".
 */
const SCOUT_SHOWN = `status = 'running' OR (dismissed IS NULL AND COALESCE(finished, created) > ?)`;
export function hiddenScouts(now = Date.now(), limit = 100) {
  return (db.prepare(`SELECT ${SCOUT_COLS} FROM scouts WHERE NOT (${SCOUT_SHOWN}) ORDER BY created DESC LIMIT ?`).all(now - FAILED_HIDE_MS, limit) as any[]).map((x) => ({ ...scoutRow(x), dismissed: x.dismissed ?? null }));
}

export async function activity() {
  const changes = (db.prepare(`SELECT * FROM changes WHERE status IN ('queued', 'working', 'verifying', 'revising') ORDER BY created`).all() as any[]).map(changeRow);
  // Cancelled and not resumed or closed (kept a week): Resume and Close stay on the card.
  const cancelled = (db.prepare(`SELECT * FROM changes WHERE status = 'cancelled' AND COALESCE(updated, created) > ? ORDER BY updated DESC LIMIT 20`).all(Date.now() - 7 * 86_400_000) as any[]).map(changeRow);
  const runs = (db.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY started`).all() as any[]).map(runRow);
  // Scouts (scout.ts): running ones and the last day's finished, mixed with runs by time in the drawer.
  const scouts = (db.prepare(`SELECT ${SCOUT_COLS} FROM scouts WHERE ${SCOUT_SHOWN} ORDER BY created DESC LIMIT 30`).all(Date.now() - FAILED_HIDE_MS) as any[]).map(scoutRow);
  // How many are tucked away (dismissed, or older than a day): the drawer's "Show dismissed" fetches them when asked.
  const hiddenScoutCount = (db.prepare(`SELECT COUNT(*) n FROM scouts WHERE NOT (${SCOUT_SHOWN})`).get(Date.now() - FAILED_HIDE_MS) as any).n as number;
  // Only the last message J (or a notice) sent, picked out by SQLite: a long conversation's whole history isn't parsed every poll.
  const info = talkInfo();
  const talk = (db.prepare(`SELECT id, title, updated, proc, (SELECT m.value FROM json_each(c.messages) m WHERE json_extract(m.value, '$.role') = 'user' OR json_extract(m.value, '$.notice') ORDER BY m.key DESC LIMIT 1) AS last FROM conversations c WHERE status = 'thinking'`).all() as any[]).map((c) => {
    const last = parse(c.last) as any;
    const proc = c.proc ? parse(c.proc) : null;
    const harness = proc?.harness ?? info.harness;
    const label = brainLabel(harness);
    const model = proc?.model ?? info.model;
    return { id: c.id, title: c.title, since: last?.at ?? c.updated, auto: Boolean(proc?.auto ?? last?.notice), harness, label, model };
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
  // Background operations (ops.ts): going live, rollbacks, merges; queued and running ones, and the last day's finished.
  const allOps = listOps({ since: Date.now() - 86_400_000, limit: 40 });
  const ops = allOps.filter((o) => o.status === 'queued' || o.status === 'running' || o.status === 'waiting');
  const opsDone = allOps.filter((o) => o.status === 'done' || o.status === 'failed').slice(0, 10);
  const loop = loopHealth();
  return {
    at: Date.now(), gen: genOk, changes, cancelled, runs, scouts, hiddenScoutCount, jobs, talk, recent, ops, opsDone, commands: runningCommands(),
    // Moments in the last hour Studio couldn't answer for over a second (a blocking call), and what was running then.
    loop: { lastMinute: loop.lastMinute, blocks: loop.blocks.filter((b) => b.at > Date.now() - 3600_000) },
    // The header badge: things working now (a Gen job a run's step is waiting on counts once, as its run).
    // Scouts that failed and aren't dismissed: the header shows them next to the badge (a calm "0" hid 21 of them).
    failed: scouts.filter((x) => x.status === 'failed').length + opsDone.filter((o) => o.status === 'failed').length,
    // Each failure with when it ended: the page counts the ones its person hasn't seen (activity-seen.ts unseen).
    failures: [
      ...opsDone.filter((o) => o.status === 'failed').map((o) => ({ key: `op:${o.id}`, at: o.finished ?? o.created })),
      ...scouts.filter((x) => x.status === 'failed').map((x) => ({ key: `scout:${x.id}`, at: x.finished ?? x.started })),
    ],
    count: changes.length + runs.length + scouts.filter((x) => x.status === 'running').length + talk.length + ops.filter((o) => o.status !== 'waiting').length + jobs.filter((j) => !stepJobs.has(j.id)).length,
  };
}
