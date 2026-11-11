// A play of a web app its own CI deploys (Product.versionPath, like Hawkes Gen) plays the commit it was started for, not
// whatever its beta still runs (J, 2026-11-11: "A go-live play waits until beta has actually deployed the build it is
// testing, keyed on the deployed commit. Use the deploy's completion event, not polling"). That morning Gen's go-live
// play started at the push, eight minutes before Gen's deploy finished: it read the old deployed commit, found it
// already played, and the go live used up its three plays in seconds without playing anything.
//
// The event: the deployed app says so. Gen's new revision, once it serves its lane's traffic, posts to
// POST /api/hooks/deployed with a Google-signed ID token for Studio's address (hawkesgen src/studioannounce.ts). The
// post is only a wake-up: Studio never takes its word for the commit; it reads the lane's versionPath itself
// (deployed.ts) and wakes the plays waiting for that commit. Its answer (seen) tells the app when to stop saying so.
//
// A play waits (untilDeployed) when beta runs another commit than the one it tests: one read when it starts, then
// nothing until an announce (no polling, no timer that looks again). One deadline ends a wait whose deploy never came
// (the deploy failed and went back to the old revision): the step ends as stale (wrongBuild), counted as no play.
// A commit Gen's deploy skips (only docs/** or *.md changed: its workflow's paths-ignore) is the same code as the one
// beta runs, so it doesn't wait for a deploy that won't come.
import { spawnSync } from 'node:child_process';
import type { Product } from './config.ts';
import { deployedOf, sameCommit, type Deployed } from './deployed.ts';

/** How long a play waits for its commit's deploy before it ends as stale (Gen's deploy takes about 8 minutes). */
export const DEPLOY_WAIT_MS = 30 * 60_000;

/** Files a deploy workflow skips (Gen's ci.yml paths-ignore: docs/** and **\/*.md): a commit changing only these isn't deployed. */
export const undeployedFile = (f: string) => /^docs\//.test(f) || /\.md$/i.test(f);

type Waiter = { target: string; done: (d: Deployed) => void };
const waiters = new Map<string, Set<Waiter>>();

/** Plays waiting for a deploy now, by product (Activity and the tests). */
export const waitingFor = (product: string) => [...(waiters.get(product) ?? [])].map((w) => w.target);

export type WaitResult = { ok: true; commit: string; sameCode?: boolean } | { ok: false; commit: string | null; why: string };

export type WaitDeps = {
  read?: (p: Product) => Promise<Deployed | null>;
  /** beta's newest commit now (a newer one deployed while waiting is played: beta moved on, and that's what goes live). */
  tip?: (p: Product) => Promise<string | null>;
  /** Whether commit b is a's code (only files the deploy skips differ). */
  sameCode?: (p: Product, a: string, b: string) => boolean;
  deadlineMs?: number;
  /** Told once when the play starts to wait (the step's detail). */
  onWait?: (deployed: string) => void;
};

/** Whether two commits of the product's repo differ only in files its deploy skips (git, in Studio's checkout). */
export function sameCodeIn(dir: string | null | undefined, a: string, b: string): boolean {
  if (!dir) return false;
  const r = spawnSync('git', ['diff', '--name-only', a, b], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return false;
  const files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return files.every(undeployedFile);
}

/**
 * Resolves once the product's beta runs `target` (or beta's newer head), at once when it already does. Never throws.
 * ok false: the deadline passed (the deploy never came) or beta can't be read.
 */
export async function untilDeployed(p: Product, target: string, deps: WaitDeps = {}): Promise<WaitResult> {
  const read = deps.read ?? ((x: Product) => deployedOf(x, 'beta'));
  const now = await read(p);
  if (!now?.commit) return { ok: false, commit: null, why: `${p.name}'s beta doesn't say which commit it runs (${p.versionPath})` };
  if (sameCommit(now.commit, target)) return { ok: true, commit: now.commit };
  if (deps.sameCode?.(p, now.commit, target)) return { ok: true, commit: target, sameCode: true };
  // beta moved past the commit and its newer head is deployed already: that is what's played (and what goes live).
  const head = deps.tip ? await deps.tip(p).catch(() => null) : null;
  if (head && sameCommit(now.commit, head)) return { ok: true, commit: now.commit };
  deps.onWait?.(now.commit);
  return new Promise<WaitResult>((resolve) => {
    const w: Waiter = { target, done: (d) => { clearTimeout(timer); drop(); resolve({ ok: true, commit: d.commit! }); } };
    const set = waiters.get(p.id) ?? new Set<Waiter>();
    set.add(w);
    waiters.set(p.id, set);
    const drop = () => { set.delete(w); if (!set.size) waiters.delete(p.id); };
    const timer = setTimeout(() => {
      drop();
      resolve({ ok: false, commit: now.commit, why: `beta's deploy of ${target.slice(0, 7)} didn't finish within ${Math.round((deps.deadlineMs ?? DEPLOY_WAIT_MS) / 60_000)} minutes (beta still runs ${now.commit!.slice(0, 7)}): not played, so nothing is judged on the wrong build` });
    }, deps.deadlineMs ?? DEPLOY_WAIT_MS);
  });
}

/**
 * A deployed app said its lane runs a new revision (POST /api/hooks/deployed). Reads each matching project's lane once
 * and wakes the plays waiting for what it runs. seen: the lane runs the commit it announced (the app stops saying so).
 */
export async function onDeployAnnounced(products: Product[], lane: 'beta' | 'live', commit: string | null, deps: Pick<WaitDeps, 'read' | 'tip'> & { readLive?: (p: Product) => Promise<Deployed | null> } = {}) {
  const out: { product: string; runs: string | null; woke: number }[] = [];
  let seen = false;
  for (const p of products.filter((x) => x.versionPath)) {
    const d = lane === 'beta' ? await (deps.read ?? ((x: Product) => deployedOf(x, 'beta')))(p) : await (deps.readLive ?? ((x: Product) => deployedOf(x, 'live')))(p);
    if (d?.commit && commit && sameCommit(d.commit, commit)) seen = true;
    let woke = 0;
    const set = waiters.get(p.id);
    if (lane === 'beta' && d?.commit && set?.size) {
      const tip = [...set].some((w) => !sameCommit(d.commit, w.target)) ? await (deps.tip?.(p) ?? Promise.resolve(null)).catch(() => null) : null;
      for (const w of [...set]) {
        if (sameCommit(d.commit, w.target) || (tip && sameCommit(d.commit, tip))) { w.done(d); woke++; }
      }
    }
    out.push({ product: p.id, runs: d?.commit ?? null, woke });
  }
  return { seen, products: out };
}

/** The commit a beta run was started to test before a go live ("Before go-live: playing beta <short> ..."), if any. */
export const goLiveTarget = (options: string | null | undefined) => /Before go-live: playing beta ([0-9a-f]{7,40})\b/.exec(String(options ?? ''))?.[1] ?? null;
