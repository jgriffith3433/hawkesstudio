// Acceptance: a roadmap task's criteria judged from a playtest. Beta's run after the merge judges them (the task is
// done, "verified", only when every criterion is met there). A change itself is playtested only when J asks for it
// (agents.ts playtestChange); then its criteria are judged too, and one that fails keeps it out of the PM's merges.
//
// Two separate judges (the owner's gaps list, 2026-11-08: "a separate run judges the builder's work"): Hawkes Gen's
// playtest.review (param `criteria`, result `criteria`), and Studio's own judge, a separate Claude run (llm.json through
// llm.ts, about a cent; Claude Code on the Max plan when Gen is out of credit) that sees the review's frames and motion
// sheets, the playtest's events and log and the findings, and never the builder's own account of what it did. A
// criterion is met only when both say yes; either "no" is a no; anything else is unclear. "unclear" never passes: it
// fails a played change's merge gate, and on beta it sends the task back (pm.ts).
//
// Verdicts from playtests that already run (2026-11-10: of 347 tasks merged, verified or live, only 22 had every
// criterion judged; beta isn't played after each merge, agents.betaPlaytests is off on purpose). No new playtest, no
// new play is started for these:
// - the change's own playtest before it merged (its showcase) passed every criterion: once it merges and beta built
//   it, that is the task's verdict, unless beta moved in the same files since that play (changeVerdictHolds);
// - the milestone's one play of its build (pm.ts milestoneCheck, play-policy.ts), or a person's go live play of a commit
//   no milestone played, judge the criteria of every merged task not verified yet, in the same review (sweepCriteria;
//   phone criteria on the run's phone play at 390x844 when it has one). pm.ts reads them as it reads a beta check
//   (runVerdicts): all met is verified, a "no" reopens it the usual way, unclear only waits (never an agent change:
//   the play wasn't the task's own scenario).

import { askClaude } from './llm.ts';
import { db } from './db.ts';
import { getTask, landed, type Check, type Task } from './roadmap.ts';
import { failLine, type QualityFail } from './quality.ts';
import { gitAsync } from './beta.ts';

const norm = (m: unknown): Check['met'] => (m === 'yes' || m === true ? 'yes' : m === 'no' || m === false ? 'no' : 'unclear');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['criterion', 'met', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          met: { type: 'string', enum: ['yes', 'no', 'unclear'] },
          evidence: { type: 'string', description: 'What in the frames, events or log shows it (or what is missing). One or two sentences.' },
        },
      },
    },
  },
};

/** Two judges' answers on one criterion -> one: yes only when both say yes, no when either says no, else unclear. */
export function combine(a: Check | undefined, b: Check | undefined): Check['met'] {
  if (!a) return b?.met ?? 'unclear';
  if (!b) return a.met;
  if (a.met === 'no' || b.met === 'no') return 'no';
  return a.met === 'yes' && b.met === 'yes' ? 'yes' : 'unclear';
}

/**
 * Per criterion: met yes | no | unclear, with evidence. Gen's review's answer (when it judged them) and Studio's own
 * separate judge are combined (combine); the evidence says what each saw. `judge` is the separate run (tests pass one).
 */
export async function judgeCriteria(criteria: string[], review: any, playtest: any, judge = separateJudge): Promise<Check[]> {
  if (!criteria.length) return [];
  const own = Array.isArray(review?.criteria) && review.criteria.length === criteria.length
    ? criteria.map((k, i): Check => ({ criterion: k, met: norm(review.criteria[i]?.met), evidence: String(review.criteria[i]?.evidence ?? '').slice(0, 600) }))
    : null;
  const sep = await judge(criteria, review, playtest);
  if (!own) return sep;
  return criteria.map((k, i) => {
    const met = combine(own[i], sep[i]);
    const evidence = own[i].met === sep[i]?.met ? own[i].evidence : `review: ${own[i].met}, ${own[i].evidence}; separate judge: ${sep[i]?.met ?? 'none'}, ${sep[i]?.evidence ?? ''}`;
    return { criterion: k, met, evidence: String(evidence ?? '').slice(0, 600) };
  });
}

/** Studio's own judge: a separate Claude run on the evidence, without the builder's account. */
export async function separateJudge(criteria: string[], review: any, playtest: any): Promise<Check[]> {
  const motion = ((review?.motion?.sheets ?? []) as any[]).map((m) => m?.asset).filter(Boolean).slice(0, 4);
  const frames = [...((review?.frames ?? []) as any[]).map((f) => f?.asset).filter(Boolean).slice(0, 12), ...motion].map((a: string) => (/^(asset|blob):/.test(a) ? a : `asset:${a}`));
  const prompt = `A playtest bot played a game build and a reviewer watched it. Judge whether each ACCEPTANCE CRITERION is met,
from the evidence below (and the attached frames, in order${motion.length ? `; the last ${motion.length} are motion contact sheets, 1.2 s of video at 15 fps each, read left to right, top to bottom` : ''}). You are a separate judge:
you never see the builder's own account, only what the build did. Be strict: "yes" only when the evidence shows it;
"no" when the evidence shows it is not met or broken; "unclear" when the playtest never got to it or nothing shows it.

ACCEPTANCE CRITERIA:
${criteria.map((k, i) => `${i + 1}. ${k}`).join('\n')}

PLAYTEST: outcome ${playtest?.outcome ?? '?'}, scenario ${playtest?.scenario ?? '?'}, ${playtest?.seconds ?? '?'} s.
Events (last 80): ${JSON.stringify((playtest?.events ?? []).slice(-80)).slice(0, 6000)}
Log (last 40): ${JSON.stringify((playtest?.log ?? []).slice(-40)).slice(0, 4000)}
Problems: ${JSON.stringify((playtest?.problems ?? []).slice(0, 15)).slice(0, 2000)}

REVIEW: verdict ${review?.verdict ?? '?'}; did the change work: ${review?.changeWorked ?? '?'}.
Summary: ${String(review?.summary ?? '').slice(0, 2000)}
Findings: ${JSON.stringify((review?.findings ?? []).map((f: any) => ({ severity: f.severity, title: f.title, detail: f.detail }))).slice(0, 3000)}

Answer with one entry per criterion, in the same order, with the criterion's text.`;
  // Room for every answer: a sweep (sweepCriteria) judges up to SWEEP_MAX criteria in one review.
  const params = { prompt, schema: SCHEMA, model: process.env.STUDIO_REVIEW_MODEL ?? 'claude-sonnet-5-5', effort: 'medium', maxTokens: Math.min(16_000, 4000 + Math.max(0, criteria.length - 20) * 150), timeoutMs: 10 * 60_000, purpose: 'acceptance' };
  const ask = async (images: string[]) => {
    const j: any = await askClaude({ ...params, images });
    if (j.status !== 'done') throw new Error(j.error ?? j.detail ?? 'failed');
    return j;
  };
  let job: any;
  try {
    job = await ask(frames);
  } catch {
    try {
      job = await ask([]);
    } catch (e: any) {
      return criteria.map((k) => ({ criterion: k, met: 'unclear', evidence: `couldn't judge: ${String(e.message ?? e).slice(0, 200)}` }));
    }
  }
  const got = (job.result?.value?.criteria ?? []) as any[];
  return criteria.map((k, i) => ({ criterion: k, met: norm(got[i]?.met), evidence: String(got[i]?.evidence ?? 'no answer').slice(0, 600) }));
}

/**
 * The merge gate for a ready change (its agent's checks passed, its pull request is open): no contradiction of the
 * canon, and, when it was playtested (only on request), the playtest didn't fail, the review didn't call it broken and
 * no criterion failed. Not being playtested is no reason (`played` says whether it was): beta's run judges the criteria.
 */
export function gate(verify: any, criteria: string[]) {
  const why: string[] = [];
  const played = Boolean(verify && (verify.playtest || (verify.outcome && verify.outcome !== 'not played')));
  if (verify && played) {
    if (verify.outcome && !['passed', 'done', 'ok', 'complete', 'completed'].includes(String(verify.outcome)) && /fail|error|stuck|crash|timeout|timed out/i.test(String(verify.outcome))) why.push(`the playtest ${verify.outcome}`);
    if (verify.verdict === 'broken') why.push('the review called it broken');
    if (verify.changeWorked === 'no' || verify.changeWorked === 'partly') why.push(`the review says the change worked: ${verify.changeWorked}`);
    if (verify.error) why.push(String(verify.error).slice(0, 200));
    for (const c of (verify.criteria ?? []) as Check[]) if (c.met === 'no') why.push(`not met: ${c.criterion} (${c.evidence ?? ''})`);
  }
  // The game quality rubric (quality.ts): a rule the played build broke (a playtest problem, a review finding, a metric
  // over its limit, a fun review calling it a demo) fails it, like a failed criterion.
  if (verify && played) for (const f of (verify.quality?.fails ?? []) as QualityFail[]) why.push(failLine(f));
  // The scan before the pull request (quality-scan.ts) normally sends the agent back; a branch that still breaks it never merges.
  if (verify?.qualityScan?.ok === false) why.push(`it breaks the game quality rules: ${verify.qualityScan.summary}`);
  // The canon check of a content change (canon.ts): a contradiction of the story bible never merges by itself.
  if (verify?.canon?.ok === false) why.push(`it contradicts the canon: ${(verify.canon.conflicts ?? []).map((k: any) => `${k.entry} (${String(k.why).slice(0, 120)})`).join('; ') || verify.canon.summary}`);
  // "unclear" never passes (the owner's gaps list, 2026-11-08): a played change whose criteria couldn't be seen doesn't merge.
  const unclear = played ? ((verify?.criteria ?? []) as Check[]).filter((c) => c.met === 'unclear') : [];
  for (const c of unclear) why.push(`unclear: ${c.criterion} (${c.evidence ?? 'the playtest never showed it'})`);
  return { pass: !why.length, why, unclear: unclear.map((c) => c.criterion), played };
}

/** Every criterion met (the bar for "verified" on beta). */
export const allMet = (checks: Check[] | undefined | null, criteria: string[]) => !criteria.length || (Boolean(checks?.length) && checks!.length >= criteria.length && checks!.every((c) => c.met === 'yes'));

// ------------------------------------------------------------ verdicts from playtests that already run

/** A criterion about the phone: judged on a phone play (390x844, touch) when the run has one. */
const PHONE = /\b(phones?|mobile|touch ?screens?|touch controls?|tap(s|ping)?|portrait|390 ?[x×] ?844|small screens?|handheld)\b/i;
export const isPhoneCriterion = (k: string) => PHONE.test(k);
/** At most this many criteria in one swept review (whole tasks only), so the review stays one prompt. */
export const SWEEP_MAX = () => Math.max(1, Number(process.env.STUDIO_SWEEP_MAX_CRITERIA ?? 40) || 40);

/**
 * A product's merged tasks still waiting for a verdict on beta: with criteria, not a video, and landed (beta built
 * them). Longest-waiting first: never judged on beta, then judged longest ago (an unclear one goes to the back).
 */
export function awaitingVerdict(product: string): Task[] {
  return (db.prepare(`SELECT id FROM tasks WHERE product = ? AND status = 'merged'`).all(product) as any[])
    .map((r) => getTask(r.id))
    .filter((t): t is Task => Boolean(t) && t!.criteria.length > 0 && !t!.kind && landed(t!))
    .sort((a, b) => (a.checks?.where === 'beta' ? a.checks.at : 0) - (b.checks?.where === 'beta' ? b.checks.at : 0) || (a.merged_at ?? 0) - (b.merged_at ?? 0));
}

/**
 * The criteria a play that already runs judges for the product's merged tasks (awaitingVerdict), whole tasks only, up
 * to SWEEP_MAX. device: the play's. phonePlay: the run also plays beta on a phone, so phone criteria go there and the
 * desktop play leaves them out (with no phone play they are judged on the desktop play, which may find them unclear).
 */
export function sweepCriteria(product: string, { device = 'desktop', phonePlay = false }: { device?: 'desktop' | 'phone'; phonePlay?: boolean } = {}) {
  const criteria: string[] = [];
  const tasks: string[] = [];
  for (const t of awaitingVerdict(product)) {
    const mine = t.criteria.filter((k) => (device === 'phone' ? isPhoneCriterion(k) : !(phonePlay && isPhoneCriterion(k))));
    const add = [...new Set(mine)].filter((k) => !criteria.includes(k));
    if (!mine.length || (criteria.length && criteria.length + add.length > SWEEP_MAX())) continue;
    criteria.push(...add);
    tasks.push(t.id);
  }
  return { criteria, tasks };
}

/**
 * What a play judges for merged tasks besides what it was asked: only a play of beta (local) that isn't a task's own
 * check (no scenario or criteria of its own), in a beta run (the play before going live) or the daily run.
 */
export function sweepFor(product: string, o: { runKind: string; where: string; device?: string; asked?: boolean; phonePlay?: boolean }): Sweep | null {
  if (o.where !== 'local' || o.asked || !['beta', 'daily'].includes(o.runKind)) return null;
  try {
    const s = sweepCriteria(product, { device: o.device === 'phone' ? 'phone' : 'desktop', phonePlay: Boolean(o.phonePlay) });
    return s.criteria.length ? s : null;
  } catch (e: any) {
    console.warn(`[studio] ${product}: merged tasks' criteria not added to the play: ${e.message ?? e}`);
    return null;
  }
}
/** Criteria a play judges in passing, and the tasks they are for (each landed on beta when the play started). */
export type Sweep = { criteria: string[]; tasks: string[] };

/** A review step as pm.ts reads it: its run, when it started, its parsed data (criteria, verdict, sweep). */
export type ReviewStep = { id: string; run: string; name?: string; started: number; data: any };
export type RunVerdict = { run: string; started: number; verdict: string | null; /** Every review behind it judged them in passing (sweepFor). */ sweep: boolean; results: Check[]; all: Check[]; steps: string[] };

/**
 * The newest run whose reviews, together, judged every one of the criteria (a run plays beta on a desktop and a phone:
 * each review judges its part). Per criterion: "no" when any review said no, "yes" when one said yes, else unclear.
 * steps: newest first. null: no run judged them all.
 */
export function runVerdicts(steps: ReviewStep[], criteria: string[]): RunVerdict | null {
  if (!criteria.length) return null;
  const runs: string[] = [];
  for (const s of steps) if (!runs.includes(s.run)) runs.push(s.run);
  for (const run of runs) {
    const mine = steps.filter((s) => s.run === run && Array.isArray(s.data?.criteria));
    const all = mine.flatMap((s) => s.data.criteria as Check[]).filter((c) => c && typeof c.criterion === 'string');
    if (!criteria.every((k) => all.some((c) => c.criterion === k))) continue;
    const one = (k: string): Check => {
      const said = all.filter((c) => c.criterion === k);
      return said.find((c) => c.met === 'no') ?? said.find((c) => c.met === 'yes') ?? said[0];
    };
    const merged = [...new Set(all.map((c) => c.criterion))].map(one);
    const judging = mine.filter((s) => (s.data.criteria as Check[]).some((c) => criteria.includes(c?.criterion)));
    const newest = judging.reduce((a, b) => (a.started >= b.started ? a : b));
    return { run, started: newest.started, verdict: newest.data?.verdict ?? null, sweep: judging.every((s) => Array.isArray(s.data?.sweep) && s.data.sweep.length > 0), results: criteria.map(one), all: merged, steps: judging.map((s) => s.id) };
  }
  return null;
}

/** How changeVerdictHolds reads git: the merge commit, a merge base, the files two commits differ in (null: can't tell). */
export type CarryDeps = { merge: () => Promise<string | null>; fork: (a: string, b: string) => Promise<string | null>; files: (a: string, b: string) => Promise<string[] | null> };
/** Agents' notes are never part of the work (agents.ts NOTES). */
const NOTES = /^\.hawkes\//;

/**
 * Whether a merged change's own playtest (before the merge) is the task's verdict on beta: it was played, passed its
 * gate, met every one of the task's criteria, and between the commit it played and its merge commit on beta nothing
 * changed the files the change changed (beta moving elsewhere doesn't touch what was judged). merge^1 is beta before
 * the merge (squash or merge commit alike).
 */
export async function changeVerdictHolds(c: { verify: any }, criteria: string[], deps: CarryDeps): Promise<{ holds: boolean; why: string }> {
  const no = (why: string) => ({ holds: false, why });
  if (!criteria.length) return no('the task has no criteria');
  const v = c.verify;
  const g = gate(v, criteria);
  if (!g.played) return no('the change was not playtested before it merged');
  if (!g.pass) return no(`its playtest didn't pass: ${g.why.slice(0, 2).join('; ')}`.slice(0, 400));
  const results = criteria.map((k) => ((v?.criteria ?? []) as Check[]).find((r) => r?.criterion === k));
  if (!results.every((r) => r?.met === 'yes')) return no("its playtest didn't judge every one of the task's criteria met");
  const played = String(v?.played ?? v?.build?.sha ?? '');
  if (!played) return no('no record of the commit its playtest played');
  try {
    const merge = await deps.merge();
    if (!merge) return no('its merge commit on beta was not found');
    const fork = await deps.fork(played, `${merge}^1`);
    if (!fork) return no(`can't find where ${played.slice(0, 7)} left beta`);
    const mine = await deps.files(fork, played);
    const drift = await deps.files(played, merge);
    if (!mine || !drift) return no("git couldn't compare the played commit with the merge");
    const changed = new Set(drift);
    const both = mine.filter((f) => !NOTES.test(f) && changed.has(f));
    if (both.length) return no(`beta changed ${both.length} of its files since its playtest (${both.slice(0, 5).join(', ')})`);
    return { holds: true, why: `its own playtest of ${played.slice(0, 7)} met all ${criteria.length} criteria, and nothing on beta since touched its ${mine.length} file(s) (merged as ${merge.slice(0, 7)})` };
  } catch (e: any) {
    return no(`couldn't compare with beta: ${String(e.message ?? e).slice(0, 200)}`);
  }
}

/** changeVerdictHolds's git, in the product's checkout (fetched once): the merge commit is the one titled "(#<pr>)" on origin/<base>. */
export function localGitDeps(dir: string, base: string, pr: number | null): CarryDeps {
  let fetched: Promise<unknown> | null = null;
  const run = async (args: string[]) => {
    fetched ??= gitAsync(dir, ['fetch', '--quiet', 'origin']).catch(() => null);
    await fetched;
    const r = await gitAsync(dir, args);
    return r.ok ? r.out.trim() : null;
  };
  return {
    merge: async () => (pr ? (await run(['log', `origin/${base}`, '-F', `--grep=(#${pr})`, '--format=%H', '-n', '1'])) || null : null),
    fork: async (a, b) => (await run(['merge-base', a, b])) || null,
    files: async (a, b) => {
      const out = await run(['diff', '--name-only', a, b]);
      return out === null ? null : out.split('\n').map((x) => x.trim()).filter(Boolean);
    },
  };
}
