// The fun review (the fun-reviewer role, .claude/agents/fun-reviewer.md; the game quality rubric's "living-world"
// rule, quality.ts): after a game build is played and reviewed, Studio asks whether it is a living world or a demo,
// from the review's frames, the playtest's events and metrics, and the game's world bible. About a cent (the review
// model). A "demo" verdict fails the quality gate (qualityGate's fun-review check); "thin" is said, not failed.

import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './llm.ts';
import { parseAgentFile, PLUGIN_DIR } from './roles.ts';
import { rubricFor, isGame } from './quality.ts';
import { uiSummary } from './ui.ts';
import type { Product } from './config.ts';

export type FunReview = { verdict: 'living' | 'thin' | 'demo' | 'unjudged'; scores: { line: string; score: number; evidence: string }[]; gaps: string[]; why: string;
  /** What the review says about the menu screens it saw (the menus-and-ui rule): a comment per screen. */
  menus?: { screen: string; comment: string; ok: boolean }[] };

const LINES = ['full', 'breathing', 'interactions', 'story as experience', 'soul'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'scores', 'gaps', 'why', 'menus'],
  properties: {
    verdict: { type: 'string', enum: ['living', 'thin', 'demo'] },
    scores: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['line', 'score', 'evidence'], properties: { line: { type: 'string', enum: LINES }, score: { type: 'number', minimum: 1, maximum: 5 }, evidence: { type: 'string' } } },
    },
    gaps: { type: 'array', items: { type: 'string' }, description: 'The three gaps that matter most, each a concrete thing to build, biggest first.' },
    why: { type: 'string', description: 'The verdict in one or two sentences.' },
    menus: {
      type: 'array', minItems: 1, maxItems: 6,
      description: 'Menu screens (title, pause, settings, shop, game over, level select, any screen of buttons): one comment each on target sizes, spacing, reach, safe areas, feedback and sound on press. Menus are judged, never skipped. If no menu screen is in the frames or events, one entry with screen "none seen" saying where a player would expect one.',
      items: { type: 'object', additionalProperties: false, required: ['screen', 'comment', 'ok'], properties: { screen: { type: 'string' }, comment: { type: 'string' }, ok: { type: 'boolean' } } },
    },
  },
};

/** The fun reviewer's standing instructions: its role file in the plugin Studio runs. */
export function funReviewerBrief() {
  try {
    return parseAgentFile(fs.readFileSync(path.join(PLUGIN_DIR(), 'agents', 'fun-reviewer.md'), 'utf8')).body;
  } catch {
    return 'You are the fun reviewer: judge whether a game is a full, living world with soul, or a demo.';
  }
}

/** The game's world bible (docs/world-bible.md in its source), when there is one. */
export function worldBibleOf(dir: string | null | undefined, max = 6000) {
  if (!dir) return null;
  for (const f of ['docs/world-bible.md', 'world-bible.md', 'Docs/world-bible.md']) {
    try { return fs.readFileSync(path.join(dir, f), 'utf8').slice(0, max); } catch { /* next */ }
  }
  return null;
}

/** The fun review of one played build. Never throws: a review that couldn't run is "unjudged" (not a pass, not a fail). */
export async function funReview(p: Product, a: { review: any; playtest: any; dir?: string | null; request?: string | null }, deps: { ask?: typeof askClaude } = {}): Promise<FunReview | null> {
  if (!isGame(p)) return null;
  const rule = rubricFor(p.id).find((r) => r.id === 'living-world');
  const bible = worldBibleOf(a.dir);
  const frames = ((a.review?.frames ?? []) as any[]).map((f) => f?.asset).filter(Boolean).slice(0, 12).map((x: string) => (/^(asset|blob):/.test(x) ? x : `asset:${x}`));
  const pt = a.playtest ?? {};
  const prompt = `${funReviewerBrief()}

THE RULE (game quality rubric):
${rule ? `${rule.title}. ${rule.why}\n${rule.build.map((b) => `- ${b}`).join('\n')}` : '(missing)'}

THE GAME: ${p.name}. ${p.about ?? ''}
${a.request ? `WHAT THIS BUILD WAS MEANT TO ADD: ${a.request.slice(0, 1200)}\n` : ''}WORLD BIBLE: ${bible ? `\n${bible}` : 'none yet (a game without one is planned as a demo: say so in the gaps).'}

THE PLAYED BUILD: outcome ${pt.outcome ?? '?'}, scenario ${pt.scenario ?? '?'}, ${pt.seconds ?? '?'} s.
${uiSummary(pt) ? `The phone UI probe (menus: sizes, safe areas, presses):\n${uiSummary(pt).slice(0, 2500)}\n` : ''}Metrics: ${JSON.stringify(pt.metrics ?? {}).slice(0, 1500)}
Events (last 80): ${JSON.stringify((pt.events ?? []).slice(-80)).slice(0, 5000)}
The reviewer's summary: ${String(a.review?.summary ?? '').slice(0, 2000)}
The reviewer's findings: ${JSON.stringify((a.review?.findings ?? []).map((f: any) => f.title)).slice(0, 1500)}

The attached frames are from this playtest, in order. Judge the build that was played.`;
  const ask = deps.ask ?? askClaude;
  const params = { prompt, schema: SCHEMA, model: process.env.STUDIO_REVIEW_MODEL ?? 'claude-sonnet-5-5', effort: 'medium', maxTokens: 3000, timeoutMs: 8 * 60_000, purpose: 'fun-review' };
  for (const images of frames.length ? [frames, []] : [[]]) {
    try {
      const j: any = await ask({ ...params, images } as any);
      if (j?.status !== 'done') continue;
      const v = j.result?.value ?? {};
      if (!['living', 'thin', 'demo'].includes(v.verdict)) continue;
      return {
        verdict: v.verdict,
        scores: (v.scores ?? []).filter((s: any) => LINES.includes(s?.line)).map((s: any) => ({ line: s.line, score: Math.max(1, Math.min(5, Number(s.score) || 1)), evidence: String(s.evidence ?? '').slice(0, 300) })),
        gaps: (v.gaps ?? []).map((g: any) => String(g).slice(0, 400)).slice(0, 5),
        why: String(v.why ?? '').slice(0, 600),
        menus: (Array.isArray(v.menus) ? v.menus : []).slice(0, 6).map((m: any) => ({ screen: String(m?.screen ?? '').slice(0, 80), comment: String(m?.comment ?? '').slice(0, 400), ok: Boolean(m?.ok) })).filter((m: any) => m.screen && m.comment),
      };
    } catch { /* try without frames, then give up */ }
  }
  return { verdict: 'unjudged', scores: [], gaps: [], why: "the fun review couldn't run" };
}
