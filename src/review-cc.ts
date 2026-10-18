// A playtest review when Hawkes Gen's playtest.review can't ask Claude (its API key is out of credit, llm.ts): the
// same review through Claude Code on J's Max plan. A copy of Gen's review (hawkesgen src/tools/playtest.ts: its
// schema, system prompt, mode rules and settleReview / settleCriteria) fed from the playtest.run job's result and
// screenshots in Gen's library. Without the previous run's frames (the visual changes are listed as text).
// Keep it in step with Gen's when that changes; it is used only while Gen's Claude calls fail (or STUDIO_LLM_VIA).

import { gen } from './gen.ts';
import { askClaudeCode, isBillingError, llmVia, markGenDown, MAX_PLAN } from './llm.ts';

const SEVERITIES = ['blocker', 'bug', 'polish', 'idea'];
const SEVERITY_RANK: Record<string, number> = { blocker: 0, bug: 1, polish: 2, idea: 3 };

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'verdict', 'scores', 'findings', 'known', 'meetsBar', 'changeWorked'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences: how the run went and what matters most.' },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'broken'] },
    scores: {
      type: 'object', additionalProperties: false, required: ['stability', 'visuals', 'clarity', 'feel', 'polish'],
      properties: Object.fromEntries(['stability', 'visuals', 'clarity', 'feel', 'polish'].map((k) => [k, { type: 'integer', description: '1 (bad) to 10 (excellent)' }])),
    },
    findings: {
      type: 'array', description: 'NEW problems only (none already in KNOWN FINDINGS), worst first, within the limit. An empty list is a fine answer.',
      items: {
        type: 'object', additionalProperties: false, required: ['severity', 'area', 'title', 'detail', 'evidence', 'fix', 'regression'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          area: { type: 'string', description: 'gameplay, ui, art, audio, performance, story, onboarding, tech' },
          title: { type: 'string', description: 'Short, specific: what is wrong where.' },
          detail: { type: 'string' },
          evidence: { type: 'array', items: { type: 'integer' }, description: 'Indexes of the screenshots that show it.' },
          fix: { type: 'string', description: 'What to change, concretely (file or system if known).' },
          regression: { type: 'boolean', description: 'True only if this worked before and is now worse.' },
        },
      },
    },
    known: {
      type: 'array', description: 'Known findings this run says something about, by id: "fixed" or "present". Leave out the ones this run cannot judge.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'status', 'note'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'present'] }, note: { type: 'string' } } },
    },
    meetsBar: { type: 'string', enum: ['yes', 'no', 'no-bar'], description: 'Does this build meet the QUALITY BAR? "no-bar" when none was given.' },
    changeWorked: { type: 'string', enum: ['yes', 'partly', 'no', 'n/a'], description: 'Verify mode: did the change under test do what it was meant to? Otherwise "n/a".' },
    changes: { type: 'array', items: { type: 'string' }, description: 'What got better or worse than the previous review, if one was given.' },
    criteria: {
      type: 'array', description: 'Only when ACCEPTANCE CRITERIA were given: one entry per criterion, in the same order.',
      items: { type: 'object', additionalProperties: false, required: ['criterion', 'met', 'evidence'], properties: { criterion: { type: 'string' }, met: { type: 'string', enum: ['yes', 'no', 'unclear'] }, evidence: { type: 'string' } } },
    },
    phone: {
      type: 'object', additionalProperties: false, description: 'Only for a phone run (390x844, touch).', required: ['touch', 'text', 'layout', 'notes'],
      properties: { touch: { type: 'integer' }, text: { type: 'integer' }, layout: { type: 'integer' }, notes: { type: 'string' } },
    },
  },
};

const REVIEW_SYSTEM = `You are the QA lead for a one-person game studio whose games are built and fixed by AI agents.
You review an automated playtest: screenshots from a real browser run plus the run's report (the game's own bot played it).
Every finding you report becomes work for an agent, so report what most needs fixing, not everything that could be better.
A short list that is right is worth more than a long one. "Nothing new" is a valid, good answer.
Be specific and visual: name what you see on screen, where, and when.

Rules:
- Report only what the evidence supports (screenshots, console errors, the report's problems and metrics). Don't invent.
- Blocker: the game can't be played or progressed. Bug: something is wrong (broken, wrong, missing, crashing).
  Polish: works but looks or feels unfinished. Idea: an improvement worth doing.
- At most the LIMIT findings, worst first. Polish and ideas only when you found no blocker or bug.
- Never report a problem that is already in KNOWN FINDINGS (same problem, even in other words): say in "known", by id,
  whether it looks fixed or is still present, and only when this run actually shows it.
- When a QUALITY BAR is given, judge against it: it says what "done" means for this product. Something the bar doesn't ask
  for is not a bug. A build that meets its bar gets "ship" and at most a couple of findings.
- "ship" comes with few or no findings and never with a blocker.
- Judge against the product's story and art direction when they are given. Flag anything off-tone.
- Ignore problems caused only by the automation (the bot's odd movement) unless a player could hit them.
- Don't comment on the runner's own frame-rate warning unless the screenshots also show stutter or the game reports low fps.
- If softwareRendering is true, the browser had no GPU: ignore frame rates and slowness entirely (they say nothing about players).
- Each fix says what to change, as concretely as you can.
- If VISUAL CHANGES are listed, the same moment looked different in the previous run. Say whether each big change is an
  improvement, a regression, or just a different moment (camera, animation, random content); report regressions.`;

const MODE_RULES: Record<string, string> = {
  full: `MODE: full review (the daily one). Find the worst new problems, within the limit.`,
  verify: `MODE: verify. This run checks a change (see FOCUS). Answer two questions: did the change do what it was meant to
("changeWorked", and "known" for the findings it was meant to fix), and did anything get worse? Report only regressions
(regression: true) and blockers. No polish, no ideas, no other old problems: this is not a full review.`,
  regression: `MODE: regression check (e.g. the live site after a deploy). Report only what is broken or got worse:
regressions (regression: true) and blockers. No polish, no ideas, nothing that was already like this.`,
};

const PHONE_RULES = `This run was on a PHONE: 390x844 CSS pixels, portrait, touch only (no keyboard or mouse). Judge it as a phone player:
- Touch controls: is there an on-screen way to do everything the game needs? Are tap targets big enough (about 44 px)
  and placed where thumbs reach? A game that needs a keyboard and says nothing about it is a bug on a phone.
- Text size: can every line be read at this size? Flag tiny, cramped or cut-off text.
- Layout: does everything fit the portrait screen? Flag cropped or off-screen UI, overlap, sideways scrolling, letterboxing
  that wastes most of the screen, and anything hidden under the browser's bars.
Fill "phone" with scores for these, and use area "mobile" for these findings.`;

type Known = { id: string; title: string; severity?: string; status?: string };

/** Gen's settleReview: findings worst first, mode and caps enforced, "known" only for ids given. */
export function settleReview(review: any, { mode = 'full', maxFindings = 5, known = [] as Known[] } = {}) {
  const all: any[] = (Array.isArray(review.findings) ? review.findings : []).filter((f: any) => f?.title);
  let list = [...all].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  if (mode !== 'full') list = list.filter((f) => f.severity === 'blocker' || f.regression === true);
  if (list.some((f) => f.severity === 'blocker' || f.severity === 'bug')) list = list.filter((f) => f.severity === 'blocker' || f.severity === 'bug');
  if (review.verdict === 'ship' && list.some((f) => f.severity === 'blocker')) review.verdict = 'fix-first';
  const cap = Math.max(0, Math.min(maxFindings, review.verdict === 'ship' ? 2 : maxFindings));
  list = list.slice(0, cap);
  review.trimmed = all.length - list.length;
  review.findings = list;
  const ids = new Set(known.map((k) => k.id));
  const seen = new Set<string>();
  review.known = (Array.isArray(review.known) ? review.known : []).filter((k: any) => ids.has(k?.id) && ['fixed', 'present'].includes(k.status) && !seen.has(k.id) && seen.add(k.id));
  review.mode = mode;
  return review;
}

function settleCriteria(review: any, criteria: string[]) {
  if (!criteria.length) { delete review.criteria; return review; }
  const got: any[] = Array.isArray(review.criteria) ? review.criteria : [];
  review.criteria = criteria.map((c, i) => {
    const g = got.find((x) => String(x?.criterion ?? '').trim() === c.trim()) ?? got[i];
    const met = ['yes', 'no', 'unclear'].includes(g?.met) ? g.met : 'unclear';
    return { criterion: c, met, evidence: String(g?.evidence ?? 'not judged').slice(0, 600) };
  });
  return review;
}

/**
 * playtest.review's params (review.ts reviewParams) reviewed through Claude Code. Looks like a finished Gen review job
 * (result = the review; via "claude-code", billing "Max plan (not billed)", cost 0); never throws. id: the Gen review
 * job that failed, if any.
 */
export async function reviewViaClaudeCode(product: string, p: any, failedJob?: string | null): Promise<any> {
  try {
    const run: any = await gen.job(p.job);
    if (run?.status !== 'done') return { id: failedJob ?? null, status: 'failed', error: `${p.job} is ${run?.status}; review it once it's done` };
    const result = run.result ?? {};
    const listed: any = await gen.assets({ job: p.job, limit: '500' });
    const assets = ((listed?.items ?? []) as any[]).filter((a) => a.meta?.playtest === 'shot').sort((a, b) => (a.meta.t ?? 0) - (b.meta.t ?? 0));
    if (!assets.length) return { id: failedJob ?? null, status: 'failed', error: `${p.job} has no screenshots` };
    // Gen's frame pick: every event shot first (up to 60%), then even spacing. Fewer than Gen's 16, to keep it quick.
    const n = Math.min(Number(p.frames) || 12, 16);
    const important = assets.filter((a) => ['problem', 'scene', 'end', 'ready', 'loaded', 'page'].includes(a.meta.reason));
    const picked = new Set<any>(important.slice(0, Math.ceil(n * 0.6)));
    const rest = assets.filter((a) => !picked.has(a));
    const want = n - picked.size;
    for (let i = 0; i < want && rest.length; i++) picked.add(rest[Math.floor((i * rest.length) / Math.max(1, want))]);
    const frames = assets.filter((a) => picked.has(a));
    const big = (result.visual?.pairs ?? []).filter((x: any) => x.big).sort((a: any, b: any) => b.score - a.score);
    const legend = frames.map((a, i) => `[${i}] t=${a.meta.t}s ${a.meta.reason}${a.meta.scene ? ` (${a.meta.scene})` : ''}`).join('\n');
    const phone = result.device === 'phone';
    const brief = {
      url: result.url, mode: result.mode, scenario: result.scenario, outcome: result.outcome, seconds: result.seconds,
      loadSeconds: result.loadSeconds, fps: result.fps, renderer: result.renderer, softwareRendering: result.software, metrics: result.metrics, problems: result.problems?.slice(0, 40),
      console: result.console, failedRequests: result.failedRequests?.slice(0, 15), events: result.events?.slice(-80),
      log: result.log?.slice(-40), pages: result.pages?.slice(0, 60),
    };
    const known: Known[] = (Array.isArray(p.known) ? p.known : []).filter((k: any) => k?.id && k?.title).slice(0, 200);
    const mode = MODE_RULES[p.mode] ? p.mode : 'full';
    const maxFindings = Number.isFinite(Number(p.maxFindings)) ? Number(p.maxFindings) : 5;
    const criteria: string[] = (Array.isArray(p.criteria) ? p.criteria : []).map((c: any) => String(c ?? '').trim()).filter(Boolean).slice(0, 20);
    const prompt = [
      p.product ? `PRODUCT\n${p.product}` : '',
      p.bar ? `QUALITY BAR (what "done" means for this product)\n${String(p.bar).slice(0, 3000)}` : '',
      p.story ? `STORY AND ART DIRECTION\n${String(p.story).slice(0, 12000)}` : '',
      p.focus ? `FOCUS THIS TIME\n${p.focus}` : '',
      MODE_RULES[mode],
      `LIMIT\nAt most ${maxFindings} new findings.`,
      criteria.length ? `ACCEPTANCE CRITERIA (judge each one from this run; fill "criteria", one entry per line, same order; strict: "yes" only when the run shows it, "unclear" when it never got there)\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : '',
      known.length ? `KNOWN FINDINGS (already in the backlog, the ideas list or marked won't fix: never report these again)\n${known.map((k) => `- ${k.id} [${k.severity ?? '?'}, ${k.status ?? 'open'}] ${String(k.title).slice(0, 160)}`).join('\n')}` : '',
      `PLAYTEST REPORT\n${JSON.stringify(brief, null, 1).slice(0, 30000)}`,
      `SCREENSHOTS (in order; refer to them by index)\n${legend}`,
      p.previous ? `PREVIOUS REVIEW\n${JSON.stringify(p.previous).slice(0, 8000)}` : '',
      big.length ? `VISUAL CHANGES SINCE THE LAST RUN (perceptual difference of the same moment: 0 = same, 1 = different; the previous run's frames are not attached)\n${big.slice(0, 12).map((x: any) => `- ${x.key} at t=${x.t}s: ${Math.round(x.score * 100)}% different, ${Math.round((x.changed ?? 0) * 100)}% of the screen changed`).join('\n')}` : '',
      phone ? PHONE_RULES : '',
      'Review this playtest.',
    ].filter(Boolean).join('\n\n');
    const j = await askClaudeCode({ prompt, system: REVIEW_SYSTEM, schema: REVIEW_SCHEMA, images: frames.map((a) => `asset:${a.id}`), model: p.model, effort: 'high', timeoutMs: 15 * 60_000, purpose: 'review', product });
    if (j.status !== 'done') return { ...j, id: failedJob ?? null };
    const review = settleCriteria(settleReview(j.result.value, { mode, maxFindings, known }), criteria);
    const shown = frames.map((a) => a.id);
    for (const f of review.findings) f.shots = (f.evidence ?? []).map((i: number) => shown[i]).filter(Boolean);
    if (!phone) delete review.phone;
    review.visual = big.length ? { big: big.length, top: big.slice(0, 6).map((x: any) => ({ key: x.key, score: x.score, diff: x.diff })) } : null;
    review.frames = frames.map((a) => ({ asset: a.id, t: a.meta.t, reason: a.meta.reason, scene: a.meta.scene }));
    review.playtest = { job: p.job, url: result.url, scenario: result.scenario, outcome: result.outcome, seconds: result.seconds, fps: result.fps, problems: result.problems?.length ?? 0, device: result.device ?? 'desktop' };
    review.model = p.model;
    review.via = 'claude-code';
    review.billing = j.billing;
    return { id: failedJob ?? null, status: 'done', via: 'claude-code', billing: j.billing, cost: 0, usage: j.usage, result: review };
  } catch (e: any) {
    return { id: failedJob ?? null, status: 'failed', error: `Claude Code review: ${String(e?.message ?? e).slice(0, 300)}` };
  }
}

/**
 * A playtest review: Gen's playtest.review (viaGen), or Claude Code when Gen's Claude is out of credit (now, or in the
 * last 10 minutes) or STUDIO_LLM_VIA=claude-code says so.
 */
export async function reviewJob(product: string, params: any, viaGen: () => Promise<any>): Promise<any> {
  if (llmVia() === 'claude-code') return reviewViaClaudeCode(product, params);
  const j = await viaGen();
  if (j?.status === 'done' || process.env.STUDIO_LLM_VIA === 'gen' || !isBillingError(j?.error ?? '')) return j;
  markGenDown(String(j.error));
  return reviewViaClaudeCode(product, params, j.id);
}

/** A short note for a step's detail when Claude Code answered instead of Gen. */
export const viaNote = (j: any) => (j?.via === 'claude-code' ? ` · via Claude Code, ${j.billing ?? MAX_PLAN}` : '');
