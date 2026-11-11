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

import fs from 'node:fs';
import path from 'node:path';
import { loadProducts as allProducts, PROJECTS, managedElsewhere } from './config.ts';

// Projects handed over to another Studio (config.ts managedBy) are left alone here.
const loadProducts = () => allProducts().filter((p) => !managedElsewhere(p));
import { BETA, shaOf } from './beta.ts';
import { betaFolders, repoMap, syncRepos, builtFromGitHub } from './repos.ts';
import { notePush } from './betaqueue.ts';

export const betaPushes: { at: number; repo: string; sha?: string; result: string }[] = [];

/** The repo folder for a GitHub "owner/name", if it's a product source repo kept on beta. */
export function betaFolderFor(slug: string) {
  const folder = Object.entries(repoMap()).find(([, s]) => s.toLowerCase() === slug.toLowerCase())?.[0];
  return folder && betaFolders().has(folder) ? folder : null;
}

/** A push to beta in one repo: sync it, rebuild web beta sites now and schedule Unity ones. */
export async function onBetaPush(folder: string, sha?: string) {
  // On Cloud Run the beta site is published from GitHub (previews-cloud.ts): a repo that isn't cloned here isn't cloned
  // just for it (Dose Of Destruction is 1 GB, and /tmp is the instance's memory). One that is (an agent's) is synced.
  // Nor, on Cloud Run, a Unity project's repo (repos.ts builtFromGitHub): its beta builds from GitHub. A big web repo
  // is synced on the light path (repos.ts syncGit).
  const { remoteSites } = await import('./previews-cloud.ts');
  const cloned = fs.existsSync(path.join(PROJECTS, folder, '.git'));
  let skip = !cloned && remoteSites() ? `${BETA} is published from GitHub` : null;
  if (!cloned && !skip && process.env.K_SERVICE) {
    for (const p of loadProducts().filter((x) => [x.repo, x.site].some((r) => r?.split('/')[0] === folder))) {
      skip = builtFromGitHub(p);
      if (skip) break;
    }
  }
  const [result] = skip
    ? [{ folder, slug: repoMap()[folder] ?? folder, action: 'updated' as const, detail: `not cloned here: ${skip}` }]
    : await syncRepos([folder]);
  const { previewsAfterSync } = await import('./previews.ts');
  const rebuilt = previewsAfterSync([result], { missing: false });
  const unity = loadProducts().filter((p) => p.build && p.repo.split('/')[0] === folder).map((p) => p.id);
  // A push doesn't start a Unity build (unitybuild-policy.ts, J 2026-11-11): the milestone's check builds beta's head
  // once. A beta run still waiting builds the newest commit anyway: the push only restarts its quiet time (betaqueue.ts).
  if (result.action === 'updated' || result.action === 'cloned') for (const id of unity) notePush(id);
  // The checkout couldn't follow beta (uncommitted changes, local commits): Talk hears what's in the way (pipeline.ts).
  if (result.action === 'kept') {
    const { staleBeta } = await import('./pipeline.ts');
    for (const p of loadProducts().filter((x) => !x.build && x.repo.split('/')[0] === folder)) await staleBeta(p);
  }
  const now = shaOf(path.join(PROJECTS, folder), `origin/${BETA}`)?.slice(0, 7);
  const summary = `${result.action}: ${result.detail}${rebuilt.length ? ` · rebuilding ${rebuilt.join(', ')}` : ''}`;
  betaPushes.unshift({ at: Date.now(), repo: folder, sha: sha?.slice(0, 7) ?? now, result: summary });
  betaPushes.splice(50);
  console.log(`[beta] push to ${folder} beta (${sha?.slice(0, 7) ?? '?'}): ${summary}`);
  return { folder, sync: result, rebuilding: rebuilt, unityScheduled: [] as string[] };
}
