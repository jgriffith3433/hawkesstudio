// Every step of a run plays the same beta build (J, 2026-10-19: a milestone check played an old build's scenarios,
// then "beta isn't built yet", although its build step said "no changes since the last build (Game/v169)").
//
// A Unity product's beta build lives in one place, the beta website copy (.work/beta/<product>-site). A newer beta
// build resets that copy to the website's beta (live's old Game/v<n>, no beta build) before Unity builds into it, so a
// run still playing its scenarios played the old build, then nothing. Now:
//
// - a run holds the copy while it plays (holdBeta); a build that would reset it waits for the other runs' plays to end
//   (waitForBetaPlays, at most BETA_PLAY_WAIT_MS: 30 minutes, since a long run of the daily full set must not hold up
//   going live (J, 2026-10-25); then it goes ahead and those runs' next steps fail loudly);
// - each run's build step records the build it built or kept (step data "served": sha and Game/v<n>), and a playtest
//   checks that the copy still holds exactly that build, and that its Game/v<n> folder is there (servedMismatch);
// - playtests of the copy take turns per product (one port, serveBeta): one run's page server is never stopped by another's.
//
// All in-process: runs execute in Studio's process (pipeline.ts). After a restart the holds are gone; the check still holds.

import { db, parse } from './db.ts';
import type { Played } from './beta.ts';

export const BETA_PLAY_WAIT_MS = () => Number(process.env.STUDIO_BETA_PLAY_WAIT_MS ?? 30 * 60_000);
const TICK_MS = () => Number(process.env.STUDIO_BETA_TICK_MS ?? 5_000);

/** product → run → holds. */
const holds = new Map<string, Map<string, number>>();

/** The run plays the product's beta website copy until the returned release is called (nested holds are counted). */
export function holdBeta(product: string, run: string): () => void {
  const m = holds.get(product) ?? new Map<string, number>();
  holds.set(product, m);
  m.set(run, (m.get(run) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (m.get(run) ?? 1) - 1;
    if (n > 0) m.set(run, n);
    else m.delete(run);
  };
}

/** Other runs playing the product's beta website copy now. */
export const betaPlayers = (product: string, run: string) => [...(holds.get(product)?.keys() ?? [])].filter((r) => r !== run);

/** Waits until no other run plays the product's beta copy (or the time runs out). Returns the runs it waited for. */
export async function waitForBetaPlays(product: string, run: string, onWait: (detail: string) => void = () => {}) {
  const end = Date.now() + BETA_PLAY_WAIT_MS();
  const waited = new Set<string>();
  for (let others = betaPlayers(product, run); others.length; others = betaPlayers(product, run)) {
    others.forEach((r) => waited.add(r));
    if (Date.now() > end) {
      console.warn(`[beta] ${product}: ${run} builds although ${others.join(', ')} still play the beta copy (waited ${Math.round(BETA_PLAY_WAIT_MS() / 60_000)} min)`);
      break;
    }
    onWait(`waiting for ${others.join(', ')} to finish playing the current beta build (a new build replaces it)`);
    await new Promise((r) => setTimeout(r, TICK_MS()));
  }
  return [...waited];
}

/** Playtests of a product's beta copy, one at a time (they share its port). Returns the release. */
const turns = new Map<string, Promise<void>>();
export async function serveBeta(product: string): Promise<() => void> {
  const before = turns.get(product) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chain = before.then(() => mine);
  turns.set(product, chain);
  await before;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
    if (turns.get(product) === chain) turns.delete(product);
  };
}

/** What a run's build step built or kept in the beta copy (null: the run has no build step, or it built nothing). */
export function runBetaBuild(run: string, product: string): { sha: string; version: string | null } | null {
  const row = db.prepare(`SELECT data FROM steps WHERE run = ? AND product = ? AND kind = 'build' AND name = 'unity' AND status IN ('done', 'skipped') ORDER BY started DESC LIMIT 1`).get(run, product) as any;
  const s = parse(row?.data ?? null)?.served;
  return s?.sha ? { sha: String(s.sha), version: s.version != null ? String(s.version) : null } : null;
}

const label = (b: { sha: string; version?: string | null } | null | undefined) => (b ? `${b.version ? `Game/v${b.version}` : 'a build'} of beta ${b.sha.slice(0, 7)}` : 'no beta build');

/**
 * Why a playtest must not play the beta copy (null: it holds the run's build). expected: the run's build (runBetaBuild);
 * played: what the copy holds now (beta.ts playedLocal); versions: the Game/v<n> folders in the served folder.
 */
export function servedMismatch(expected: { sha: string; version: string | null } | null, played: Played | null, versions: number[]): string | null {
  if (!played) {
    return expected
      ? `Not playing: this run built or used ${label(expected)}, but the beta website copy has no beta build now (a newer build reset it, or that build failed).`
      : null; // the caller's "beta isn't built yet"
  }
  const now = { sha: played.sha, version: played.build != null ? String(played.build) : null };
  if (expected && (expected.sha !== now.sha || (expected.version && now.version && expected.version !== now.version))) {
    return `Not playing a different build: this run built or used ${label(expected)}, but the beta website copy now holds ${label(now)}.`;
  }
  if (now.version && versions.length && !versions.includes(Number(now.version))) {
    return `Not playing an old build: the beta build is Game/v${now.version}, but the served folder only has ${versions.map((v) => `Game/v${v}`).join(', ')}.`;
  }
  return null;
}
