// Critic go-live and milestone gates (J, 2026-11-11): a build that plays worse than live never replaces it, and a
// milestone is only called reached when the critic agrees on beta.
//
// Go live (deploy.ts): the newest judged critic of the beta commit vs the live build. Hold when any dimension dropped
// 2+ points against live, or when a milestone go-live has a dimension under releaseFloor. No critic → "Critic: not
// judged" as a warning, never a pass. Auto go-live ships when nothing is held.
//
// Milestone reached (roadmap.ts / pm.ts): only after a beta critic run on its check scores every touched dimension at
// or above target. Until then the roadmap shows "waiting for the critic" with the scores. Kicked from critic.afterRun
// (run completion), never a timer.

import { db, rowToStep, parse } from './db.ts';
import { CRITIC_DIMENSIONS, targetFor, releaseFloorOf, getProduct, type Product } from './config.ts';
import { isGame } from './quality.ts';
import type { CriticScore } from './critic.ts';

/** Drop of this many points (or more) against live holds go-live. */
export const REGRESSION_DROP = 2;

export type CriticSnap = {
  judged: boolean;
  sha: string | null;
  at: number | null;
  scenario: string | null;
  summary: string;
  scores: { dimension: string; score: number; why: string; fix: string; reference: string }[];
};

export type CriticCompare = {
  blockers: string[];
  warnings: string[];
  beta: CriticSnap | null;
  live: CriticSnap | null;
  /** One short line per dimension (beta vs live), wrap-friendly for 390 px. */
  lines: string[];
};

const sameSha = (a: unknown, b: string | undefined) =>
  typeof a === 'string' && !!b && (a === b || (a.length >= 7 && (b.startsWith(a) || a.startsWith(b))));

/** A judged critic step's data as a snap (scores with numbers only). */
export function snapOf(data: any, sha: string | null, at: number | null): CriticSnap | null {
  if (!data || data.verdict !== 'judged' || !Array.isArray(data.scores)) return null;
  const scores = (data.scores as CriticScore[])
    .filter((s) => s && typeof s.dimension === 'string' && Number.isFinite(Number(s.score)))
    .map((s) => ({
      dimension: String(s.dimension),
      score: Math.max(1, Math.min(10, Math.round(Number(s.score)))),
      why: String(s.why ?? '').slice(0, 400),
      fix: String(s.fix ?? '').slice(0, 400),
      reference: String(s.reference ?? '').slice(0, 80),
    }));
  if (scores.length < CRITIC_DIMENSIONS.length) return null;
  return {
    judged: true,
    sha,
    at,
    scenario: data.scenario ?? null,
    summary: String(data.summary ?? '').slice(0, 600),
    scores,
  };
}

/**
 * The newest judged critic review of a run that played `sha` (a playtest of that commit in the same run). null when none.
 * Prefers an exact match on the run's playtests; never invents scores.
 */
export function criticOfCommit(product: string, sha: string | null | undefined): CriticSnap | null {
  if (!sha) return null;
  const steps = (db.prepare(`SELECT * FROM steps WHERE product = ? AND kind = 'critic' AND status = 'done' ORDER BY started DESC LIMIT 40`).all(product) as any[]).map(rowToStep);
  for (const s of steps) {
    const play = db.prepare(`SELECT data FROM steps WHERE run = ? AND product = ? AND kind = 'playtest' AND status = 'done' ORDER BY started DESC LIMIT 20`).all(s.run, product) as any[];
    const hit = play.find((r) => {
      try { return sameSha(JSON.parse(r.data ?? '{}')?.played?.sha, sha); } catch { return false; }
    });
    if (!hit) continue;
    const snap = snapOf(s.data, sha, s.started);
    if (snap) return snap;
  }
  return null;
}

/** The newest judged critic on any of these runs (a milestone's check runs), else null. */
export function criticOfRuns(product: string, runs: string[]): CriticSnap | null {
  if (!runs.length) return null;
  const steps = (db.prepare(`SELECT * FROM steps WHERE product = ? AND kind = 'critic' AND status = 'done' AND run IN (${runs.map(() => '?').join(',')}) ORDER BY started DESC LIMIT 20`).all(product, ...runs) as any[]).map(rowToStep);
  for (const s of steps) {
    const snap = snapOf(s.data, null, s.started);
    if (snap) return snap;
  }
  return null;
}

/** Pure: blockers and warnings from beta vs live critic snaps. */
export function compareCritics(a: {
  beta: CriticSnap | null;
  live: CriticSnap | null;
  floor: number;
  milestoneGoLive: boolean;
  betaShort?: string | null;
}): CriticCompare {
  const { beta, live, floor, milestoneGoLive } = a;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];

  if (!beta?.judged) {
    warnings.push('Critic: not judged');
  }

  const liveBy = new Map((live?.scores ?? []).map((s) => [s.dimension, s]));
  const dims = beta?.scores?.length ? beta.scores.map((s) => s.dimension) : [...CRITIC_DIMENSIONS];

  for (const dim of dims) {
    const b = beta?.scores?.find((s) => s.dimension === dim);
    const l = liveBy.get(dim);
    const bScore = b?.score;
    const lScore = l?.score;
    if (bScore != null && lScore != null) {
      const drop = lScore - bScore;
      const bit = `${dim}: beta ${bScore}/10 · live ${lScore}/10`;
      lines.push(drop >= REGRESSION_DROP ? `${bit} (−${drop})` : bit);
      if (drop >= REGRESSION_DROP) {
        const why = (b?.why || live?.scores.find((s) => s.dimension === dim)?.why || '').trim();
        blockers.push(`Critic: ${dim} dropped ${drop} points against live (beta ${bScore}/10, live ${lScore}/10)${why ? `: ${why}` : ''}.`.slice(0, 500));
      }
    } else if (bScore != null) {
      lines.push(`${dim}: beta ${bScore}/10 · live —`);
    } else if (lScore != null) {
      lines.push(`${dim}: beta — · live ${lScore}/10`);
    }

    if (milestoneGoLive && bScore != null && bScore < floor) {
      const why = (b?.why || '').trim();
      blockers.push(`Critic: ${dim} is ${bScore}/10, under the release floor ${floor}${why ? `: ${why}` : ''}.`.slice(0, 500));
    }
  }

  return { blockers, warnings, beta, live, lines };
}

/**
 * Whether this go-live is shipping a reached milestone (not yet live): the release-floor hold applies only then.
 * Open milestones waiting on the critic are not "reached" yet, so they don't trigger the floor hold here.
 */
export function isMilestoneGoLive(productId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM milestones WHERE status = 'reached' AND (product = ? OR product IS NULL) LIMIT 1`).get(productId);
  return Boolean(row);
}

/**
 * Critic gate for a go-live plan: blockers, warnings, and the side-by-side scores for the card. null for non-games
 * (Studio, Gen, sites) so the go-live card shows no critic block. Wired next to qualityBlockers in deploy.ts.
 */
export function criticGate(productId: string, betaSha: string | null | undefined, liveSha: string | null | undefined): CriticCompare | null {
  let p: Product;
  try { p = getProduct(productId); } catch { return null; }
  if (!isGame(p)) return null;
  const beta = criticOfCommit(productId, betaSha);
  const live = criticOfCommit(productId, liveSha);
  return compareCritics({
    beta,
    live,
    floor: releaseFloorOf(p),
    milestoneGoLive: isMilestoneGoLive(productId),
    betaShort: betaSha ? String(betaSha).slice(0, 7) : null,
  });
}

/** A playtest-quality-style blocker line the person may go live past (deploy.ts isOverridable). */
export const isCriticBlocker = (b: string) => /^Critic: /.test(b) && !/^Critic: not judged/.test(b);

// ── milestone reached ──────────────────────────────────────────────────────────────────────────────────────────────

/** Roadmap axes (roadmap.ts AXES) → the critic dimensions a task on that axis touches. */
export const DIMENSIONS_OF_AXIS: Record<string, string[]> = {
  'first-minute': ['first five minutes'],
  'core-loop': ['fun', 'clarity'],
  feel: ['feel', 'art cohesion'],
  sound: ['sound'],
  story: ['story through play'],
  characters: ['story through play'],
  'menus-ui': ['menus and UI'],
  phone: ['phone'],
  retention: ['reasons to come back'],
  performance: ['feel'],
};

/** Dimensions the milestone's tasks touch (from each task's critic axis). Empty: no critic wait (infra / no axes). */
export function touchedDimensions(axes: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const a of axes) {
    if (!a) continue;
    for (const d of DIMENSIONS_OF_AXIS[a] ?? []) out.add(d);
  }
  return [...CRITIC_DIMENSIONS].filter((d) => out.has(d));
}

export type MilestoneCritic = {
  /** Ready to mark reached (no game dimensions, or every touched one meets its target). */
  ready: boolean;
  /** Still open because the critic hasn't agreed yet. */
  waiting: boolean;
  /** Plain status for the Roadmap row (390 px): "waiting for the critic" with scores, or empty when ready / N/A. */
  line: string;
  /** Touched dimensions with score and target for the card. */
  scores: { dimension: string; score: number | null; target: number; ok: boolean }[];
};

/** Pure: whether a milestone may become reached given its touched dimensions and a critic snap. */
export function milestoneCriticGate(a: {
  dimensions: string[];
  critic: CriticSnap | null;
  targets: Record<string, number>;
}): MilestoneCritic {
  const { dimensions, critic, targets } = a;
  if (!dimensions.length) return { ready: true, waiting: false, line: '', scores: [] };
  const scores = dimensions.map((dimension) => {
    const score = critic?.scores.find((s) => s.dimension === dimension)?.score ?? null;
    const target = targets[dimension] ?? 7;
    return { dimension, score, target, ok: score != null && score >= target };
  });
  if (!critic?.judged) {
    return {
      ready: false,
      waiting: true,
      line: 'waiting for the critic',
      scores,
    };
  }
  const under = scores.filter((s) => !s.ok);
  if (under.length) {
    const bits = under.map((s) => `${s.dimension} ${s.score ?? '—'}/${s.target}`).join(', ');
    return {
      ready: false,
      waiting: true,
      line: `waiting for the critic: ${bits}`.slice(0, 400),
      scores,
    };
  }
  const bits = scores.map((s) => `${s.dimension} ${s.score}/${s.target}`).join(', ');
  return { ready: true, waiting: false, line: bits ? `critic: ${bits}` : '', scores };
}

/**
 * Critic status for one open milestone: axes from its tasks, critic from its check runs. Used by the Roadmap API and
 * by announceMilestone before markReached.
 */
export function milestoneCriticStatus(milestoneId: string): MilestoneCritic {
  const m = db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId) as { id: string; product: string | null; checks: string | null; status: string } | undefined;
  if (!m || m.status !== 'open') return { ready: true, waiting: false, line: '', scores: [] };
  const tasks = (db.prepare(`SELECT t.bar, t.product FROM tasks t JOIN items i ON i.id = t.item WHERE i.milestone = ? AND t.status NOT IN ('dropped', 'idea')`).all(milestoneId) as any[]);
  const axes = tasks.map((t) => {
    try { return (typeof t.bar === 'string' ? JSON.parse(t.bar) : t.bar)?.axis as string | undefined; } catch { return undefined; }
  });
  const dimensions = touchedDimensions(axes);
  if (!dimensions.length) return { ready: true, waiting: false, line: '', scores: [] };
  // Prefer a product on the milestone; else the first task's.
  const product = m.product || tasks[0]?.product;
  if (!product) return { ready: true, waiting: false, line: '', scores: [] };
  let p: Product;
  try { p = getProduct(product); } catch { return { ready: true, waiting: false, line: '', scores: [] }; }
  if (!isGame(p)) return { ready: true, waiting: false, line: '', scores: [] };
  const runs = (parse(m.checks) as string[] | null) ?? [];
  const critic = criticOfRuns(product, runs);
  const targets = Object.fromEntries(dimensions.map((d) => [d, targetFor(p, d)]));
  return milestoneCriticGate({ dimensions, critic, targets });
}
