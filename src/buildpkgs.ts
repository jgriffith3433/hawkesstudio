// The Unity packages every Unity product compiles against (com.hawkes.gen, com.hawkes.analytics in hawkesgen;
// com.hawkes.playtest in hawkesstudio) are file: references into these two checkouts. Hawkes Gen's unity.build mirrors
// them to the build server from the checkout it finds under the projects folder, so a checkout that hasn't deployed the
// newest main puts old package code (and old compile errors) into every Unity build. Before a unity.build this fetches
// both, asks the server's own deploy (the pull-now signal) to catch up when one is behind, waits a little, and returns
// which commits the build will use, to be kept in the build's result.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS, DATA } from './config.ts';
import { gitAsync } from './beta.ts';
import { isServer } from './repos.ts';

export const PACKAGE_REPOS = ['hawkesgen', 'hawkesstudio'] as const;

export type PackageState = { sha: string; behind: number; latest: string };
export type BuildPackages = Record<string, PackageState>;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function stateOf(dir: string): Promise<PackageState | null> {
  const head = await gitAsync(dir, ['rev-parse', 'HEAD'], 60_000);
  if (!head.ok) return null;
  const tip = await gitAsync(dir, ['rev-parse', 'origin/main'], 60_000);
  const count = tip.ok ? await gitAsync(dir, ['rev-list', '--count', 'HEAD..origin/main'], 60_000) : null;
  return { sha: head.out.slice(0, 12), behind: count?.ok ? Number(count.out) || 0 : 0, latest: tip.ok ? tip.out.slice(0, 12) : head.out.slice(0, 12) };
}

export async function syncBuildPackages(log: (s: string) => void = () => {}, { waitMs = 5 * 60_000, pollMs = 10_000, repos = PACKAGE_REPOS as readonly string[] }: { waitMs?: number; pollMs?: number; repos?: readonly string[] } = {}): Promise<BuildPackages> {
  const out: BuildPackages = {};
  const dirs = repos.map((r) => [r, path.join(PROJECTS, r)] as const).filter(([, d]) => fs.existsSync(path.join(d, '.git')));
  for (const [name, dir] of dirs) {
    const f = await gitAsync(dir, ['fetch', '--quiet', 'origin', 'main']);
    if (!f.ok) log(`packages: couldn't fetch ${name} (${f.err.split('\n').pop()}); using what the server has`);
  }
  let states = await Promise.all(dirs.map(async ([name, dir]) => [name, await stateOf(dir)] as const));
  const behind = () => states.filter(([, s]) => s && s.behind > 0);
  if (behind().length && isServer()) {
    // The server's own pull-deploy (CI-gated, restarts the service) is what moves these checkouts; just ask it to look now.
    try { fs.writeFileSync(path.join(DATA, 'pull-now'), `${new Date().toISOString()} build packages\n`); } catch { /* not fatal */ }
    log(`packages: ${behind().map(([n, s]) => `${n} is ${s!.behind} commit(s) behind main`).join(', ')}; waiting for the server's deploy`);
    for (const start = Date.now(); behind().length && Date.now() - start < waitMs;) {
      await sleep(pollMs);
      states = await Promise.all(dirs.map(async ([name, dir]) => [name, await stateOf(dir)] as const));
    }
  }
  for (const [name, s] of states) {
    if (!s) continue;
    out[name] = s;
    log(s.behind ? `packages: building against ${name} ${s.sha}, ${s.behind} commit(s) behind main (${s.latest}); its newest fixes are NOT in this build` : `packages: ${name} ${s.sha} (current)`);
  }
  return out;
}

/** Runs Gen's unity.build after syncing the package checkouts; the commits it built against ride in the job's result as `packages`. */
export async function unityBuild(project: string, params: Record<string, unknown>, onUpdate?: (job: any) => void, opts: { job?: string; onSubmit?: (id: string) => void; log?: (s: string) => void } = {}) {
  const { genRun } = await import('./gen.ts');
  const packages = opts.job ? {} : await syncBuildPackages(opts.log ?? ((s) => console.log(`[build] ${s}`))).catch((e) => { console.warn(`[build] package sync failed: ${e.message ?? e}`); return {} as BuildPackages; });
  const job = await genRun('unity.build', project, params, onUpdate, undefined, { job: opts.job, onSubmit: opts.onSubmit });
  if (Object.keys(packages).length) job.result = { ...(job.result ?? {}), packages };
  return job;
}
