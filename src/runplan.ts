// A run's plan (J: "show the full list of scenarios the run will play, in order, with expected time"): the scenarios a
// run will play, written when it starts (pipeline.ts runAll, betaBody) so "n of N" has a fixed N. A scenario that turns
// up later is added with a line saying which and why (`notePlaying`); the denominator changes only that way. The view
// (`planView`) joins the plan with the run's steps: each scenario's state, its verdict and findings once its review is
// done, and about how long is left. The Activity card and the report read it; `progressCheck` tells Talk when a run
// passes halfway or a scenario fails.

import { db, J, parse } from './db.ts';
import { getProduct } from './config.ts';

db.exec(`CREATE TABLE IF NOT EXISTS run_plan (run TEXT PRIMARY KEY, data TEXT NOT NULL)`);

/** Expected seconds for a scenario nobody has played before. */
const DEFAULT_S = 300;
/** About how long Claude's review of a played scenario takes. */
const REVIEW_S = 45;

type Item = { product: string; name: string; estS: number };
type Note = { at: number; text: string };
type Plan = { items: Item[]; notes: Note[]; told: { half?: boolean; failed: string[] } };

const load = (run: string): Plan | null => {
  const row = db.prepare('SELECT data FROM run_plan WHERE run = ?').get(run) as any;
  return row ? (parse(row.data) as Plan) : null;
};
const save = (run: string, plan: Plan) => void db.prepare('INSERT OR REPLACE INTO run_plan (run, data) VALUES (?, ?)').run(run, J(plan));

/** What a scenario took the last times it was played (median of 3 playtests, plus its review), else a default. */
export function expectedSeconds(product: string, name: string): number {
  const rows = db.prepare(`SELECT started, finished FROM steps WHERE product = ? AND kind = 'playtest' AND name = ? AND status = 'done' AND finished IS NOT NULL ORDER BY started DESC LIMIT 3`).all(product, name) as any[];
  const secs = rows.map((r) => (r.finished - r.started) / 1000).sort((a, b) => a - b);
  return secs.length ? Math.round(secs[Math.floor(secs.length / 2)] + REVIEW_S) : DEFAULT_S;
}

/** The plan of a run: its scenarios in the order they will be played (product, step name). Only the first call counts. */
export function planRun(run: string, list: { product: string; name: string }[]) {
  if (load(run)) return;
  save(run, { items: list.map((x) => ({ ...x, estS: expectedSeconds(x.product, x.name) })), notes: [], told: { failed: [] } });
}

/** A scenario starts: if the plan lacks it, it is added with a line saying which and why. */
export function notePlaying(run: string, product: string, name: string, why: string) {
  const plan = load(run);
  if (!plan || plan.items.some((x) => x.product === product && x.name === name)) return;
  plan.items.push({ product, name, estS: expectedSeconds(product, name) });
  plan.notes.push({ at: Date.now(), text: `added ${name} (${productName(product)}): ${why}` });
  save(run, plan);
}

const productName = (id: string) => {
  try {
    return getProduct(id).name;
  } catch {
    return id;
  }
};

export type PlanItem = {
  product: string; productName: string; name: string; estS: number; step: string | null; job: string | null;
  state: 'waiting' | 'playing' | 'reviewing' | 'done' | 'failed' | 'skipped';
  verdict: string | null; findings: { severity: string; title: string }[]; detail: string | null;
};

/** The plan joined with the run's steps; null for a run that has none (older runs, one-off builds). */
export function planView(run: string) {
  const plan = load(run);
  if (!plan?.items.length) return null;
  const r = db.prepare('SELECT options, started FROM runs WHERE id = ?').get(run) as any;
  const noReview = Boolean(parse(r?.options)?.noReview);
  const steps = db.prepare(`SELECT * FROM steps WHERE run = ? AND kind IN ('playtest', 'review') ORDER BY started`).all(run) as any[];
  const now = Date.now();
  const items: PlanItem[] = plan.items.map((it) => {
    const play = steps.filter((s) => s.kind === 'playtest' && s.product === it.product && s.name === it.name).pop();
    const rev = steps.filter((s) => s.kind === 'review' && s.product === it.product && s.name === it.name).pop();
    const data = parse(rev?.data) as any;
    let state: PlanItem['state'] = 'waiting';
    if (play) {
      if (play.status === 'running') state = 'playing';
      else if (play.status === 'failed') state = 'failed';
      else if (play.status === 'skipped') state = 'skipped';
      else if (rev && rev.status !== 'running') state = 'done';
      else if (!rev && noReview) state = 'done';
      else state = 'reviewing';
      // A review that waits for the AI is done as far as this run is concerned (it runs later by itself).
      if (state === 'reviewing' && rev?.status === 'skipped') state = 'done';
    }
    const verdict = rev?.status === 'done' ? data?.verdict ?? null : null;
    return {
      ...it, productName: productName(it.product), step: play?.id ?? null, job: play?.job ?? null, state, verdict,
      findings: rev?.status === 'done' ? (data?.findings ?? []).slice(0, 5).map((f: any) => ({ severity: f.severity, title: f.title })) : [],
      detail: (state === 'reviewing' || state === 'done' ? rev?.detail : null) ?? play?.detail ?? null,
    };
  });
  const over = (s: PlanItem) => ['done', 'failed', 'skipped'].includes(s.state);
  const left = items.reduce((n, it) => {
    if (over(it)) return n;
    if (it.state === 'waiting') return n + it.estS;
    const play = steps.find((s) => s.id === it.step);
    if (it.state === 'reviewing') return n + REVIEW_S;
    return n + Math.max(30, it.estS - (now - (play?.started ?? now)) / 1000);
  }, 0);
  return {
    items, notes: plan.notes, total: items.length, finished: items.filter(over).length,
    expectedMin: Math.round(items.reduce((n, it) => n + it.estS, 0) / 60), leftMin: Math.round(left / 60),
  };
}

/** "3 of 6 scenarios · about 12 min left". */
export function planLine(v: NonNullable<ReturnType<typeof planView>>) {
  return `${v.finished} of ${v.total} scenarios${v.finished < v.total ? ` · about ${Math.max(1, v.leftMin)} min left` : ' played'}`;
}

/**
 * After each scenario: a short line in the Talk conversation that started the run when it passes the halfway mark and
 * when a scenario fails (its playtest failed, or its review says broken). Once each. Runs nobody asked for say nothing.
 */
export async function progressCheck(run: string) {
  try {
    const plan = load(run);
    const v = planView(run);
    const origin = (db.prepare('SELECT origin FROM runs WHERE id = ?').get(run) as any)?.origin;
    if (!plan || !v || !origin) return;
    const lines: string[] = [];
    for (const it of v.items) {
      const key = `${it.product}/${it.name}`;
      if ((it.state === 'failed' || it.verdict === 'broken') && !plan.told.failed.includes(key)) {
        plan.told.failed.push(key);
        lines.push(`Run ${run}: ${it.name} (${it.productName}) ${it.state === 'failed' ? 'failed' : 'came out broken'}${it.detail ? `: ${it.detail.slice(0, 160)}` : ''} (${planLine(v)}).`);
      }
    }
    if (!plan.told.half && v.finished * 2 > v.total && v.finished < v.total) {
      plan.told.half = true;
      lines.push(`Run ${run} is past halfway: ${planLine(v)}.`);
    }
    if (!lines.length) return;
    save(run, plan);
    const { studioNote } = await import('./talk.ts');
    for (const l of lines) studioNote(origin, l);
  } catch (e: any) {
    console.warn(`[studio] run progress: ${e.message ?? e}`);
  }
}
