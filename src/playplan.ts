// A beta run plays what earns its place (J, 2026-10-25: beta run r_fd260676d571 played 21 scenarios over 2+ hours, found
// nothing new, and held the playtester). The cause: a beta run that a newer one replaces hands its plays to the newer
// run (betaqueue.ts `absorbed`), so every later run of a burst replayed the whole milestone set, tasks long verified
// included, and the same scenario more than once. Now, before a run plays:
//
// - plays of the same scenario and options are one play (their criteria joined);
// - a carried-over play whose tasks are all verified (or live, done, dropped) is dropped: nothing waits on it;
// - what the run carried over (never what it was asked for itself) fits a budget: at most CARRY_MAX scenarios and
//   CARRY_BUDGET_MIN minutes of expected play, shortest first; the rest is deferred with the reason (the plan's notes
//   say which), and the next check of those tasks plays it;
// - a commit that changed nothing a player can see (docs, notes, videos) doesn't replay a scenario that last passed
//   cleanly on an earlier commit (`noRuntimeChange`); go live accepts such a pass for its playtest blocker (deploy.ts).
//
// Pure over rows, so it is tested without a run.

import { db, parse } from './db.ts';

export type Ask = { scenario?: string; options?: Record<string, unknown>; device?: 'desktop' | 'phone'; criteria: string[]; carried?: boolean };

export const CARRY_MAX = () => Number(process.env.STUDIO_BETA_CARRY_MAX ?? 6);
export const CARRY_BUDGET_S = () => Number(process.env.STUDIO_BETA_CARRY_BUDGET_MIN ?? 20) * 60;

/** One play: its scenario, options and device (a phone play of a scenario is not its desktop play). */
export const askKey = (a: Pick<Ask, 'scenario' | 'options' | 'device'>) => `${a.scenario ?? ''} ${JSON.stringify(a.options ?? null)}${a.device === 'phone' ? ' phone' : ''}`;

/** One play per scenario and options, the criteria of the duplicates joined. */
export function mergeAsks(list: Ask[]): Ask[] {
  const out = new Map<string, Ask>();
  for (const a of list) {
    const k = askKey(a);
    const have = out.get(k);
    if (!have) out.set(k, { ...a, criteria: [...a.criteria] });
    else for (const c of a.criteria) if (!have.criteria.includes(c)) have.criteria.push(c);
  }
  return [...out.values()];
}

const SETTLED = new Set(['verified', 'live', 'done', 'dropped']);

/** Every criterion of the play belongs to a task of the product that no longer waits for a beta check. */
export function settledAsk(product: string, a: Ask): boolean {
  if (!a.criteria.length) return false;
  let rows: { criteria: string; status: string }[];
  try {
    rows = db.prepare('SELECT criteria, status FROM tasks WHERE product = ?').all(product) as any[];
  } catch {
    return false; // no roadmap yet
  }
  const owners = new Map<string, string[]>();
  for (const r of rows) for (const c of (parse(r.criteria) as string[] | null) ?? []) owners.set(c, [...(owners.get(c) ?? []), r.status]);
  return a.criteria.every((c) => owners.has(c) && owners.get(c)!.every((s) => SETTLED.has(s)));
}

export type CarryPlan = { plays: Ask[]; dropped: { ask: Ask; why: string }[]; deferred: { ask: Ask; why: string; estS: number }[] };

/**
 * own: what the run was asked to play (all of it plays). carried: what runs it replaced asked for. estimate: expected
 * seconds of a play (runplan.ts expectedSeconds).
 */
export function planCarried(product: string, own: Ask[], carried: Ask[], estimate: (a: Ask) => number, caps = { max: CARRY_MAX(), budgetS: CARRY_BUDGET_S() }): CarryPlan {
  const mine = mergeAsks(own);
  const dropped: CarryPlan['dropped'] = [];
  const deferred: CarryPlan['deferred'] = [];
  const keep: Ask[] = [];
  for (const a of mergeAsks(carried)) {
    const same = mine.find((m) => askKey(m) === askKey(a));
    if (same) {
      for (const c of a.criteria) if (!same.criteria.includes(c)) same.criteria.push(c);
      continue;
    }
    if (settledAsk(product, a)) dropped.push({ ask: a, why: 'its tasks are already verified on beta' });
    else keep.push(a);
  }
  const fit: Ask[] = [];
  let used = 0;
  for (const a of [...keep].sort((x, y) => estimate(x) - estimate(y))) {
    const s = estimate(a);
    if (fit.length >= caps.max) deferred.push({ ask: a, estS: s, why: `over the ${caps.max} carried-over scenarios one run plays` });
    else if (used + s > caps.budgetS) deferred.push({ ask: a, estS: s, why: `over the ${Math.round(caps.budgetS / 60)} minutes of carried-over play one run gets` });
    else { fit.push({ ...a, carried: true }); used += s; }
  }
  // Their original order.
  const order = new Map(keep.map((a, i) => [askKey(a), i]));
  fit.sort((x, y) => order.get(askKey(x))! - order.get(askKey(y))!);
  return { plays: [...mine, ...fit], dropped, deferred };
}

/** Files whose change a player can't see: docs, notes, agent and CI files, videos. */
const NO_RUNTIME = [/^(docs?|\.hawkes|\.claude|\.github|videos|memory)\//i, /\.(md|markdown|txt)$/i, /^(LICEN[SC]E|README|CHANGELOG)/i];

/**
 * True when files changed and none of them is something a playtest could notice. An empty list (a merge that kept
 * the files, a failed diff) is "play it again", as before: a merge of main into beta is replayed.
 */
export const noRuntimeChange = (files: string[]) => files.length > 0 && files.every((f) => NO_RUNTIME.some((re) => re.test(f)));

/** The newest clean local pass (won or done, a clean checkout) of a scenario step name: the commit it played. */
export function lastCleanPass(product: string, name: string, before?: number): { sha: string; at: number; run: string } | null {
  const args: (string | number)[] = [product, name];
  if (before) args.push(before);
  const rows = db.prepare(`SELECT run, started, data FROM steps WHERE product = ? AND kind = 'playtest' AND name = ? AND status = 'done' ${before ? 'AND started < ?' : ''} ORDER BY started DESC LIMIT 20`).all(...args) as any[];
  for (const r of rows) {
    const d = parse(r.data);
    if (['won', 'done'].includes(d?.outcome) && d?.played?.sha && !d.played.dirty) return { sha: String(d.played.sha), at: r.started, run: r.run };
  }
  return null;
}

/** A scenario name's short text for notes: "rune-bridges", or the product's default. */
export const askName = (a: Pick<Ask, 'scenario' | 'device'>) => `${a.scenario ?? 'the default scenario'}${a.device === 'phone' ? ' (phone)' : ''}`;
