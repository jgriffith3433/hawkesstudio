// Deploys and Studio's work in progress. Agents, runs and Talk answers survive a restart (detach.ts, the resumes in
// agents.ts, pipeline.ts and talk.ts), so a Studio deploy only has to wait for short critical sections: a merge, a push,
// a worktree being made, a go live being recorded, where being cut off halfway would leave git or GitHub and Studio's
// database disagreeing. Studio marks them (critical()), GET /api/self-deploys lists them, and deploy/hawkes-pull.mjs
// waits while there are any (a few minutes at most).
//
// While a Studio deploy waits (deploy/hawkes-pull.mjs drops .data/deploy-pending), Studio starts no new agents and new
// critical sections wait for the deploy first, so the restart comes within seconds of the sections in progress ending.
// The file goes away when the deploy is done (or the script decides there's nothing to wait for).

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.ts';

const FLAG = path.join(DATA, 'deploy-pending');

/** True while a Studio deploy is waiting for the critical sections in progress to end. */
export const deployPending = () => fs.existsSync(FLAG);

/** Waits (checking every 2 s) until no deploy is pending, at most maxMs; resolves either way. */
export async function waitForDeploy(maxMs = 6 * 60_000) {
  const end = Date.now() + maxMs;
  while (deployPending() && Date.now() < end) await new Promise((r) => setTimeout(r, 2000));
}

const sections = new Map<number, { what: string; since: number }>();
let seq = 0;

/** The critical sections in progress (oldest first): what a restart now would cut off halfway. */
export const criticalNow = () => [...sections.values()].sort((a, b) => a.since - b.since);

/**
 * Runs a short step that must not be cut off by a restart (a merge, a push, a worktree add, recording a go live). A
 * pending deploy goes first: the section waits for it (at most a few minutes), and the restart, if it comes, comes
 * before the step starts; work that resumes after a restart does the step then.
 */
export async function critical<T>(what: string, fn: () => T | Promise<T>): Promise<T> {
  if (deployPending()) await waitForDeploy();
  return criticalSync(what, fn) as Promise<T>;
}

/** The same for synchronous code (it can't wait for a pending deploy; it only keeps the deploy waiting while it runs). */
export function criticalSync<T>(what: string, fn: () => T): T {
  const id = ++seq;
  sections.set(id, { what, since: Date.now() });
  let async = false;
  try {
    const r = fn();
    if (r instanceof Promise) {
      async = true;
      return r.finally(() => sections.delete(id)) as T;
    }
    return r;
  } finally {
    if (!async) sections.delete(id);
  }
}
