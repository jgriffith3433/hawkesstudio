// Beta sites follow pushes to beta, whoever pushed (J from his PC, an agent merge, the GitHub website). No polling:
// each product source repo has a GitHub Actions workflow (.github/workflows/hawkes-studio.yml, on push to beta or main)
// that calls POST /api/hooks/github with GitHub's signed OIDC token (github-oidc.ts checks it: J's repos, the beta
// branch). Then:
//
// - Web products: pull, then rebuild the beta site (previews.ts), about a minute.
// - Unity products: a beta run (pipeline.ts startBeta: the Unity build on the build server, about $0.10, the beta
//   site). The run itself waits a quiet time for more pushes and a newer one supersedes it (betaqueue.ts), so a burst
//   of pushes makes one build. Not while a daily run is going (it waits and tries again).
//
// Studio's own pushes (devtools auto-commit) also trigger the workflow; the sync then finds beta current and nothing
// is rebuilt twice.

import path from 'node:path';
import { loadProducts, PROJECTS } from './config.ts';
import { db } from './db.ts';
import { BETA, shaOf } from './beta.ts';
import { betaFolders, repoMap, syncRepos } from './repos.ts';
import { notePush, waitingBetaRun } from './betaqueue.ts';

// Pushes seconds apart (a merge and its webhook) start one beta run; the run's own quiet time does the rest.
const UNITY_QUIET_MS = () => Number(process.env.STUDIO_BETA_UNITY_QUIET_MS ?? 10_000);

/** Unity products whose beta moved: the timer that builds it once beta has been quiet. */
const pendingUnity = new Map<string, NodeJS.Timeout>();
export const betaPushes: { at: number; repo: string; sha?: string; result: string }[] = [];

// A beta run already going is no reason to wait: the new one supersedes it if it's still waiting (betaqueue.ts).
const running = () => Boolean(db.prepare(`SELECT 1 FROM runs WHERE status = 'running' AND kind = 'daily' LIMIT 1`).get());

function scheduleUnity(id: string, delay = UNITY_QUIET_MS()) {
  clearTimeout(pendingUnity.get(id));
  const t = setTimeout(async () => {
    if (running()) return scheduleUnity(id, 5 * 60_000);
    pendingUnity.delete(id);
    const { startBeta } = await import('./pipeline.ts');
    startBeta(id);
    console.log(`[beta] building the ${id} beta`);
  }, delay);
  t.unref();
  pendingUnity.set(id, t);
}

/** The repo folder for a GitHub "owner/name", if it's a product source repo kept on beta. */
export function betaFolderFor(slug: string) {
  const folder = Object.entries(repoMap()).find(([, s]) => s.toLowerCase() === slug.toLowerCase())?.[0];
  return folder && betaFolders().has(folder) ? folder : null;
}

/** A push to beta in one repo: sync it, rebuild web beta sites now and schedule Unity ones. */
export async function onBetaPush(folder: string, sha?: string) {
  const [result] = await syncRepos([folder]);
  const { previewsAfterSync } = await import('./previews.ts');
  const rebuilt = previewsAfterSync([result], { missing: false });
  const unity = loadProducts().filter((p) => p.build && p.repo.split('/')[0] === folder).map((p) => p.id);
  // A beta run still waiting builds the newest commit anyway: the push only restarts its quiet time (betaqueue.ts).
  if (result.action === 'updated' || result.action === 'cloned') for (const id of unity) {
    notePush(id);
    if (!waitingBetaRun(id)) scheduleUnity(id);
  }
  // The checkout couldn't follow beta (uncommitted changes, local commits): Talk hears what's in the way (pipeline.ts).
  if (result.action === 'kept') {
    const { staleBeta } = await import('./pipeline.ts');
    for (const p of loadProducts().filter((x) => !x.build && x.repo.split('/')[0] === folder)) await staleBeta(p);
  }
  const now = shaOf(path.join(PROJECTS, folder), `origin/${BETA}`)?.slice(0, 7);
  const summary = `${result.action}: ${result.detail}${rebuilt.length ? ` · rebuilding ${rebuilt.join(', ')}` : ''}${unity.length && pendingUnity.size ? ` · ${unity.join(', ')} builds shortly` : ''}`;
  betaPushes.unshift({ at: Date.now(), repo: folder, sha: sha?.slice(0, 7) ?? now, result: summary });
  betaPushes.splice(50);
  console.log(`[beta] push to ${folder} beta (${sha?.slice(0, 7) ?? '?'}): ${summary}`);
  return { folder, sync: result, rebuilding: rebuilt, unityScheduled: unity.filter((id) => pendingUnity.has(id)) };
}
