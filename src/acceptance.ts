// Acceptance: a roadmap task's criteria judged from a playtest. Used twice per task: on the agent's change (its
// verification playtest; the PM merges into beta only when none fails) and on beta after the merge (the task is done,
// "verified", only when every criterion is met there).
//
// When Hawkes Gen's playtest.review judges criteria itself (param `criteria`, result `criteria`), that answer is used.
// Otherwise Claude judges them (llm.json, about a cent) from the review's frames, its summary and findings, the
// playtest's events and log, and the agent's summary. "unclear" is not a pass.

import { gen, genRun, genWait } from './gen.ts';
import type { Check } from './roadmap.ts';

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

/** Per criterion: met yes | no | unclear, with evidence. */
export async function judgeCriteria(criteria: string[], review: any, playtest: any, agentSummary?: string | null): Promise<Check[]> {
  if (!criteria.length) return [];
  const own = Array.isArray(review?.criteria) ? review.criteria : null;
  if (own && own.length === criteria.length) return criteria.map((k, i) => ({ criterion: k, met: norm(own[i]?.met), evidence: String(own[i]?.evidence ?? '').slice(0, 600) }));
  const frames = ((review?.frames ?? []) as any[]).map((f) => f?.asset).filter(Boolean).slice(0, 12).map((a: string) => (/^(asset|blob):/.test(a) ? a : `asset:${a}`));
  const prompt = `A playtest bot played a game build and a reviewer watched it. Judge whether each ACCEPTANCE CRITERION is met,
from the evidence below (and the attached frames, in order). Be strict: "yes" only when the evidence shows it; "no" when
the evidence shows it is not met or broken; "unclear" when the playtest never got to it or nothing shows it either way.

ACCEPTANCE CRITERIA:
${criteria.map((k, i) => `${i + 1}. ${k}`).join('\n')}

PLAYTEST: outcome ${playtest?.outcome ?? '?'}, scenario ${playtest?.scenario ?? '?'}, ${playtest?.seconds ?? '?'} s.
Events (last 80): ${JSON.stringify((playtest?.events ?? []).slice(-80)).slice(0, 6000)}
Log (last 40): ${JSON.stringify((playtest?.log ?? []).slice(-40)).slice(0, 4000)}
Problems: ${JSON.stringify((playtest?.problems ?? []).slice(0, 15)).slice(0, 2000)}

REVIEW: verdict ${review?.verdict ?? '?'}; did the change work: ${review?.changeWorked ?? '?'}.
Summary: ${String(review?.summary ?? '').slice(0, 2000)}
Findings: ${JSON.stringify((review?.findings ?? []).map((f: any) => ({ severity: f.severity, title: f.title, detail: f.detail }))).slice(0, 3000)}

${agentSummary ? `WHAT THE AGENT SAYS IT DID (a claim, not evidence):\n${agentSummary.slice(0, 2500)}\n` : ''}
Answer with one entry per criterion, in the same order, with the criterion's text.`;
  const params = { prompt, schema: SCHEMA, model: process.env.STUDIO_REVIEW_MODEL ?? 'claude-sonnet-5-5', effort: 'medium', maxTokens: 4000 };
  const ask = async (images: string[]) => {
    const j: any = images.length
      ? await gen.submit('llm.json', { project: 'hawkesstudio', params, inputs: { images } }).then((s: any) => genWait(s.id, undefined, 10 * 60_000))
      : await genRun('llm.json', 'hawkesstudio', params, undefined, 10 * 60_000);
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

/** The merge gate for a change: it was playtested, the review didn't call it broken, and no criterion failed. */
export function gate(verify: any, criteria: string[]) {
  const why: string[] = [];
  if (!verify) why.push('it was not playtested');
  else {
    if (verify.outcome && !['passed', 'done', 'ok', 'complete', 'completed'].includes(String(verify.outcome)) && /fail|error|stuck|crash|timeout|timed out/i.test(String(verify.outcome))) why.push(`the playtest ${verify.outcome}`);
    if (verify.verdict === 'broken') why.push('the review called it broken');
    if (verify.changeWorked === 'no' || verify.changeWorked === 'partly') why.push(`the review says the change worked: ${verify.changeWorked}`);
    if (verify.error) why.push(String(verify.error).slice(0, 200));
    const checks = (verify.criteria ?? []) as Check[];
    if (criteria.length && !checks.length) why.push('the criteria were not judged');
    for (const c of checks) if (c.met === 'no') why.push(`not met: ${c.criterion} (${c.evidence ?? ''})`);
  }
  const unclear = ((verify?.criteria ?? []) as Check[]).filter((c) => c.met === 'unclear');
  return { pass: !why.length, why, unclear: unclear.map((c) => c.criterion) };
}

/** Every criterion met (the bar for "verified" on beta). */
export const allMet = (checks: Check[] | undefined | null, criteria: string[]) => !criteria.length || (Boolean(checks?.length) && checks!.length >= criteria.length && checks!.every((c) => c.met === 'yes'));
