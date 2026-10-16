// Draining for a deploy: when a Studio deploy is waiting (deploy/hawkes-pull.mjs drops .data/deploy-pending), Studio
// starts no new agents and no new runs, so the work in progress finishes and the deploy gets its moment. With a
// self-running studio something is always busy; without this, deploys would wait for hours. The file goes away when
// the deploy is done (or the script decides there's nothing to wait for), and everything resumes.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.ts';

const FLAG = path.join(DATA, 'deploy-pending');

/** True while a Studio deploy is waiting for the work in progress to finish. */
export const deployPending = () => fs.existsSync(FLAG);

/** Waits (checking every 15 s) until no deploy is pending, at most maxMs; resolves either way. */
export async function waitForDeploy(maxMs = 45 * 60_000) {
  const end = Date.now() + maxMs;
  while (deployPending() && Date.now() < end) await new Promise((r) => setTimeout(r, 15_000));
}
