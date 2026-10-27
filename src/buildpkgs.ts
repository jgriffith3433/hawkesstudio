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

export type BuildServerState = { sha: string };
export type BuildServerRun = (command: string, timeoutMs: number) => Promise<string>;

/** The sync of the build server's own checkouts failed; `states` holds the commits it did see, for the build's result. */
export class BuildServerSyncError extends Error {
  states: Record<string, BuildServerState | { error: string }>;
  constructor(message: string, states: Record<string, BuildServerState | { error: string }>) { super(message); this.states = states; }
}

const redact = (text: string, token?: string) => (token ? text.split(token).join('***') : text).replace(/Basic [A-Za-z0-9+/=]{20,}/g, 'Basic ***');

/** The PowerShell that fetches origin/main in one checkout on the build server, hard-resets to it and prints the commit. */
export function buildServerSyncScript(repo: string, token?: string): string {
  const dir = `C:\\Projects\\${repo}`;
  const auth = token ? ` -c 'http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}'` : '';
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'`,
    `$g = 'C:\\Program Files\\Git\\cmd\\git.exe'`,
    `$d = '${dir}'`,
    `if (-not (Test-Path "$d\\.git")) { throw "no checkout at $d" }`,
    `& $g -C $d${auth} fetch -q origin main; if ($LASTEXITCODE) { throw 'git fetch origin main failed' }`,
    `& $g -C $d reset -q --hard origin/main; if ($LASTEXITCODE) { throw 'git reset --hard origin/main failed' }`,
    `& $g -C $d rev-parse HEAD`,
  ].join('; ');
}

/**
 * Brings the build server's own C:\Projects checkouts to origin/main (the ones Unity compiles the packages from) and
 * returns the commit each ends on. Any failure throws a BuildServerSyncError naming the commits seen: a build on stale
 * packages is never started silently.
 */
export async function syncBuildServerCheckouts(run: BuildServerRun, log: (s: string) => void = () => {}, { repos = PACKAGE_REPOS as readonly string[], token }: { repos?: readonly string[]; token?: string } = {}): Promise<Record<string, BuildServerState>> {
  const states: Record<string, BuildServerState | { error: string }> = {};
  for (const repo of repos) {
    try {
      const out = await run(buildServerSyncScript(repo, token), 10 * 60_000);
      const sha = out.trim().split(/\r?\n/).pop()?.trim() ?? '';
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected output: ${redact(out, token).slice(-200)}`);
      states[repo] = { sha: sha.slice(0, 12) };
      log(`build server: C:\\Projects\\${repo} is at origin/main ${sha.slice(0, 12)}`);
    } catch (e: any) {
      states[repo] = { error: redact(String(e.message ?? e), token).slice(0, 300) };
    }
  }
  const bad = Object.entries(states).filter(([, s]) => 'error' in s);
  if (bad.length) {
    const seen = Object.entries(states).filter(([, s]) => 'sha' in s).map(([n, s]) => `${n} ${(s as BuildServerState).sha}`);
    throw new BuildServerSyncError(`the build server's checkout couldn't be brought to origin/main: ${bad.map(([n, s]) => `${n}: ${(s as { error: string }).error}`).join('; ')}${seen.length ? ` (synced: ${seen.join(', ')})` : ''}`, states);
  }
  return states as Record<string, BuildServerState>;
}

/** Runs PowerShell on the build server through Gen (starting it first when stopped, retrying while Windows boots). */
async function buildServerShell(command: string, timeoutMs: number): Promise<string> {
  const { gen } = await import('./gen.ts');
  const status = await gen.request('/builder').catch((e: any) => { throw new Error(`Hawkes Gen can't report the build server (${e.message})`); });
  if (!status.exists) throw new Error('there is no build server');
  if (status.state !== 'running') await gen.request('/builder/start', { method: 'POST', body: { confirm: true } });
  for (const start = Date.now(); ; ) {
    try {
      const r = await gen.request('/builder/ssh', { method: 'POST', body: { command, confirm: true, timeoutMs } });
      return String(r.output ?? '');
    } catch (e: any) {
      // Only "not reachable yet" is retried; a refusal or a git failure is final.
      if (!/is (pending|stopped|stopping)|start it first|Connection (refused|timed out)|Could not resolve|waiting for SSH|ssh failed: .*(timed out|refused)/i.test(String(e.message)) || Date.now() - start > 10 * 60_000) throw e;
      // Caught while stopping (idle shutdown), it ends up stopped: start it again rather than wait for nothing.
      if (/is stopped/i.test(String(e.message))) await gen.request('/builder/start', { method: 'POST', body: { confirm: true } }).catch(() => {});
      await sleep(15_000);
    }
  }
}

const DETAIL_RE = /error CS\d+|Assembly has|Scripts have compiler errors/i;

/** The compiler-error lines of a failed build's log tail, so the cause shows without opening the log. */
export function buildErrorLines(logTail: unknown, max = 6): string[] {
  const seen = new Set<string>();
  for (const l of String(logTail ?? '').split(/\r?\n/)) {
    const t = l.trim();
    if (t && DETAIL_RE.test(t)) seen.add(t.slice(0, 220));
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** Runs Gen's unity.build after syncing the package checkouts (the control server's and the build server's own); the commits it built against ride in the job's result as `packages` and `buildServer`. */
export async function unityBuild(project: string, params: Record<string, unknown>, onUpdate?: (job: any) => void, opts: { job?: string; onSubmit?: (id: string) => void; log?: (s: string) => void; serverShell?: BuildServerRun; halt?: () => string | null } = {}) {
  const { genRun } = await import('./gen.ts');
  const log = opts.log ?? ((s) => console.log(`[build] ${s}`));
  const stopped = opts.halt?.();
  if (stopped) return { id: null, status: 'cancelled', error: stopped, halted: true } as any;
  const packages = opts.job ? {} : await syncBuildPackages(log).catch((e) => { console.warn(`[build] package sync failed: ${e.message ?? e}`); return {} as BuildPackages; });
  let buildServer: Record<string, unknown> | undefined;
  if (!opts.job && (opts.serverShell || isServer())) {
    try {
      buildServer = await syncBuildServerCheckouts(opts.serverShell ?? buildServerShell, log, { token: process.env.GITHUB_TOKEN });
    } catch (e: any) {
      const error = String(e.message ?? e);
      log(`build server sync failed: ${error}`);
      return { id: null, status: 'failed', error, detail: error, result: { ok: false, packages, buildServer: e instanceof BuildServerSyncError ? e.states : { error } } } as any;
    }
  }
  const job = await genRun('unity.build', project, params, onUpdate, undefined, { job: opts.job, onSubmit: opts.onSubmit, halt: opts.halt });
  if (Object.keys(packages).length || buildServer) job.result = { ...(job.result ?? {}), ...(Object.keys(packages).length ? { packages } : {}), ...(buildServer ? { buildServer } : {}) };
  if (job.status !== 'done') {
    const lines = buildErrorLines(job.result?.logTail);
    if (lines.length) {
      const base = String(job.error ?? job.detail ?? 'build failed');
      job.error = `${base}: ${lines.join(' | ')}`;
    }
  }
  return job;
}
