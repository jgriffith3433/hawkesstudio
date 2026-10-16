// How Studio asks Hawkes Gen's playtest.review, so reviews converge instead of refilling the backlog every run:
// - a mode per run kind: the daily review is "full" (capped at STUDIO_REVIEW_MAX findings, default 5); beta runs and
//   agent verifications are "verify" (did the change work, did anything regress); live checks and the daily live
//   desktop runs are "regression" (only what got worse, and blockers). Outside "full" only regressions and blockers
//   reach the backlog (backlog.ts absorb).
// - the product's known findings (backlog, ideas, won't-fix) go in, so a review reports only new problems and says by id
//   which known ones look fixed or are still there.
// - the product's quality bar (products.json "quality"): once a full review of a scenario says the build meets it, that
//   scenario's daily review is regression-only until the build changes meaningfully (barState).

import crypto from 'node:crypto';
import { db, rowToStep } from './db.ts';
import { storyOf, type Product } from './config.ts';
import { knownFindings, type ReviewMode } from './backlog.ts';
import { repoDirs, git, shaOf } from './beta.ts';

/** Reviews run on Sonnet: cents each. */
export const reviewModel = () => process.env.STUDIO_REVIEW_MODEL ?? 'claude-sonnet-5-5';
/** At most this many new findings per review. */
export const reviewMax = () => Math.max(0, Number(process.env.STUDIO_REVIEW_MAX ?? 5) || 5);

export const barHash = (bar?: string) => (bar?.trim() ? crypto.createHash('sha1').update(bar.trim()).digest('hex').slice(0, 12) : null);

/** A meaningful change since the bar was met: this many files or changed lines (build output excluded), or this old. */
const MEANINGFUL = { files: 10, lines: 300, days: 14 };
const BUILD_OUTPUT = [':(exclude)play', ':(exclude)dist', ':(exclude,glob)**/Game/v*/**'];

/** How much the source changed between two commits (build output excluded); null if git can't say. */
function changedSince(p: Product, from: string, to: string) {
  const dir = repoDirs(p).source;
  if (from === to) return { files: 0, lines: 0 };
  const r = git(dir, ['diff', '--shortstat', from, to, '--', '.', ...BUILD_OUTPUT]);
  if (!r.ok) return null;
  const n = (re: RegExp) => Number(r.out.match(re)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), lines: n(/(\d+) insertions?/) + n(/(\d+) deletions?/) };
}

/**
 * Whether a scenario's build still meets the product's quality bar: the latest review of it that judged this bar said
 * yes, the last full review said yes at a commit, and the source has not changed meaningfully since. Then its daily
 * review is regression-only.
 */
export function barState(p: Product, name: string, sha: string | null) {
  const hash = barHash(p.quality);
  if (!hash || !sha) return { met: false as const, why: hash ? 'no commit to compare' : 'no quality bar' };
  const steps = (db.prepare(`SELECT * FROM steps WHERE product = ? AND kind = 'review' AND name = ? AND status = 'done' ORDER BY started DESC LIMIT 40`).all(p.id, name) as any[]).map(rowToStep);
  for (const s of steps) {
    const d: any = s.data ?? {};
    if (d.barHash !== hash || !['yes', 'no'].includes(d.meetsBar)) continue;
    if (d.meetsBar === 'no') return { met: false as const, why: `the review of ${new Date(s.started).toISOString().slice(0, 10)} said it doesn't meet the bar` };
    if (d.mode !== 'full' || !d.sha) continue;
    const days = (Date.now() - s.started) / 86_400_000;
    if (days >= MEANINGFUL.days) return { met: false as const, why: `the bar was last checked ${Math.floor(days)} days ago` };
    const c = changedSince(p, d.sha, sha);
    if (!c) return { met: false as const, why: `can't compare ${String(d.sha).slice(0, 7)} with ${sha.slice(0, 7)}` };
    if (c.files >= MEANINGFUL.files || c.lines >= MEANINGFUL.lines) return { met: false as const, why: `${c.files} files, ${c.lines} lines changed since it met the bar` };
    return { met: true as const, since: d.sha as string, at: s.started, why: `met its quality bar at ${String(d.sha).slice(0, 7)} (${c.files} files, ${c.lines} lines changed since)` };
  }
  return { met: false as const, why: 'no full review has judged this bar yet' };
}

/** The source commit a review is judging: what a local playtest played, or live's main. */
export function reviewedSha(p: Product, where: 'local' | 'live', played: { sha: string } | null) {
  if (where === 'local') return played?.sha ?? null;
  return shaOf(repoDirs(p).source, 'origin/main');
}

/** playtest.review's params for a product: model, mode, cap, known findings, story and bar. */
export function reviewParams(p: Product, job: string, mode: ReviewMode, extra: Record<string, unknown> = {}) {
  return {
    model: reviewModel(), job, mode, maxFindings: reviewMax(),
    product: `${p.name} (presented publicly as "${p.framing}"). ${p.about}`, story: storyOf(p),
    known: knownFindings(p.id),
    ...(p.quality ? { bar: p.quality } : {}),
    ...extra,
  };
}
