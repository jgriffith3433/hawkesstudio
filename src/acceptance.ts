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

import { askClaude } from './llm.ts';
import type { Check } from './roadmap.ts';
import { failLine, type QualityFail } from './quality.ts';

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
  const params = { prompt, schema: SCHEMA, model: process.env.STUDIO_REVIEW_MODEL ?? 'claude-sonnet-5-5', effort: 'medium', maxTokens: 4000, timeoutMs: 10 * 60_000, purpose: 'acceptance' };
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
