// A worktree that really has the project's source (J, 2026-11-02: agents and scouts on the big Unity repos got only the
// repo's top-level files, "could not read Username" on every `git show`, and every task ended "the agent made no
// commit"). Two halves:
//
//   populateSource: on a light (partial, sparse) checkout, Studio, which holds the repo's token, checks out the project's
//     source files into the worktree (`sparse-checkout set --no-cone <patterns>`: one batched blob fetch with the token),
//     art and audio left out. The sandbox then needs no credentials: what the agent reads is on disk.
//   probeSource: before an agent or scout starts, a known source file exists and reads. If not, nothing starts (an infra
//     failure: infra-failure.ts), and the error says exactly what was found.
//
// Pure helpers plus small git calls; the callers pass their own git runner so tests need no network.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The sparse patterns of a Unity project: root files, code, config, text assets, and Unity's own settings. */
export const UNITY_SOURCE_PATTERNS = [
  '/*', '!/*/',
  '/Assets/**/*.cs', '/Assets/**/*.asmdef', '/Assets/**/*.asmref', '/Assets/**/*.json', '/Assets/**/*.md', '/Assets/**/*.txt',
  '/Assets/**/*.shader', '/Assets/**/*.hlsl', '/Assets/**/*.cginc', '/Assets/**/*.uxml', '/Assets/**/*.uss', '/Assets/**/*.yaml',
  '/Assets/**/*.unity', '/Assets/**/*.prefab',
  '/ProjectSettings/', '/Packages/manifest.json', '/Packages/packages-lock.json',
  '/Editor/', '/Scripts/', '/docs/', '/Docs/', '/tools/', '/Tools/', '/.github/',
];
/**
 * The Unity project directories of a repo (J, 2026-11-03: yoobaland's repo root is YoobaLand/ and the project is nested one
 * level down, YoobaLand/YoobaLand/ with Assets/, ProjectSettings/, Packages/; patterns anchored at the root matched
 * nothing, and the scout read a tarball instead). Found by a tracked `ProjectSettings/ProjectVersion.txt` at any depth up
 * to 3 directories: '' for the repo root, else 'A/B/' (with its trailing slash). Pure: `files` are repo-relative paths.
 */
export const UNITY_MAX_DEPTH = 3;
export function unityRoots(files: string[]): string[] {
  const roots = new Set<string>();
  for (const f of files) {
    const m = /^((?:[^/]+\/){0,3})ProjectSettings\/ProjectVersion\.txt$/.exec(f);
    if (m) roots.add(m[1]);
  }
  return [...roots].sort((a, b) => a.length - b.length);
}

/** The Unity patterns for a project at `prefix` ('' = the repo root, else 'A/B/'): the root's own, moved under the prefix. */
export function unityPatternsAt(prefix: string): string[] {
  if (!prefix) return UNITY_SOURCE_PATTERNS;
  const at = `/${prefix}`;
  return [
    `${at}*`, `!${at}*/`,
    ...UNITY_SOURCE_PATTERNS.filter((p) => /^\/(Assets|ProjectSettings|Packages|Editor|Scripts)\//.test(p)).map((p) => `${at}${p.slice(1)}`),
  ];
}

/**
 * The sparse patterns for a worktree of a Unity repo: the repo's root files and docs, and each Unity project found in it
 * (at the root or nested) with its code, settings and text assets. `git: fn` is for tests.
 */
export function unitySourcePatterns(dir: string, git: Git = sync): string[] {
  const ls = git(dir, ['ls-files', '--', '*ProjectSettings/ProjectVersion.txt']);
  const roots = ls.ok ? unityRoots(ls.out.split('\n').filter(Boolean)) : [];
  if (!roots.length || (roots.length === 1 && roots[0] === '')) return UNITY_SOURCE_PATTERNS;
  // Root patterns first (the repo's own files and docs), then each nested project's; later patterns win.
  const nested = roots.filter(Boolean).flatMap(unityPatternsAt);
  return [...(roots.includes('') ? UNITY_SOURCE_PATTERNS : UNITY_SOURCE_PATTERNS.filter((p) => !/^\/(Assets|ProjectSettings|Packages)\//.test(p))), ...nested];
}

/** Any other big repo: root files and the common source and config extensions, anywhere. */
export const GENERIC_SOURCE_PATTERNS = [
  '/*', '!/*/',
  '*.cs', '*.ts', '*.tsx', '*.js', '*.mjs', '*.jsx', '*.json', '*.md', '*.txt', '*.py', '*.html', '*.css', '*.yml', '*.yaml', '*.toml', '*.gd', '*.shader',
  '/docs/', '/.github/',
];

/** Source file extensions the probe reads (a tracked one must exist on disk). */
const PROBE_EXT = ['.cs', '.ts', '.tsx', '.js', '.mjs', '.py', '.gd', '.json'];
/** Where the probe looks first in a Unity project. */
const PROBE_PREFERRED = /(^|\/)(Assets|Packages|ProjectSettings)\//;

export type Probe = {
  ok: boolean;
  /** Tracked files in the index (sparse ones count: skip-worktree files are listed). */
  tracked: number;
  /** The file read (relative), when there was one to read. */
  sample?: string;
  /** Why not, in a sentence that carries the exact finding (it goes to the change's detail). */
  reason?: string;
};

type Git = (cwd: string, args: string[]) => { ok: boolean; out: string; err: string };
const sync: Git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
};

/** Whether a file's text is a Git LFS pointer (art Studio left out on purpose; never a source sample). */
const isPointer = (head: string) => head.startsWith('version https://git-lfs.github.com/spec');

/**
 * Whether a source file of the project can be read in `dir`: `git ls-files` lists the tracked files, and a tracked source
 * file (a .cs for Unity, preferred under Assets/) must exist on disk with real contents. A repo with no tracked source
 * file at all (docs only) passes when its root files are there. `git: fn` is for tests.
 */
export function probeSource(dir: string, opts: { git?: Git; unity?: boolean } = {}): Probe {
  const git = opts.git ?? sync;
  if (!fs.existsSync(path.join(dir, '.git'))) return { ok: false, tracked: 0, reason: `source unreadable: ${dir} is not a git worktree (no .git)` };
  const ls = git(dir, ['ls-files']);
  if (!ls.ok) return { ok: false, tracked: 0, reason: `source unreadable: git ls-files failed in ${dir}: ${ls.err.split('\n').pop() || 'no message'}` };
  const files = ls.out.split('\n').filter(Boolean);
  if (!files.length) return { ok: false, tracked: 0, reason: `source missing: git ls-files lists 0 files in ${dir} (the checkout is empty)` };
  const isSrc = (f: string) => PROBE_EXT.some((e) => f.endsWith(e)) && !/(^|\/)(node_modules|Library|Temp|obj)\//.test(f);
  const src = files.filter(isSrc);
  const unity = opts.unity || files.some((f) => f.startsWith('Assets/') || f.startsWith('ProjectSettings/')) || unityRoots(files).length > 0;
  if (unity && !src.some((f) => f.endsWith('.cs'))) {
    // A Unity project with no tracked C#: its source isn't in this branch at all.
    return { ok: false, tracked: files.length, reason: `source missing: ${files.length} tracked files but no .cs file among them (a Unity project's code)` };
  }
  const ordered = [...src].sort((a, b) => {
    const pa = PROBE_PREFERRED.test(a) ? 0 : 1;
    const pb = PROBE_PREFERRED.test(b) ? 0 : 1;
    return pa - pb;
  });
  // Root files (package.json, hawkes.assets.json) come with every checkout: they don't show the source is there.
  const deep = ordered.filter((f) => f.includes('/'));
  const wanted = unity ? ordered.filter((f) => f.endsWith('.cs')) : deep;
  if (!wanted.length) {
    // Docs, data and art only: the root files being on disk is the most a worktree can show.
    const root = files.find((f) => !f.includes('/'));
    if (root && !fs.existsSync(path.join(dir, root))) return { ok: false, tracked: files.length, reason: `source missing: ${files.length} tracked files, but ${root} is not on disk` };
    return { ok: true, tracked: files.length, sample: root };
  }
  // The first few: a stray missing file (deleted on purpose) doesn't fail it, none of them readable does.
  const tried = wanted.slice(0, 5);
  for (const f of tried) {
    const p = path.join(dir, f);
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(200);
      const n = fs.readSync(fd, buf, 0, 200, 0);
      fs.closeSync(fd);
      if (n > 0 && !isPointer(buf.subarray(0, n).toString('utf8'))) return { ok: true, tracked: files.length, sample: f };
    } catch { /* the next one */ }
  }
  const sparse = git(dir, ['config', '--get', 'core.sparseCheckout']).out === 'true';
  return {
    ok: false, tracked: files.length,
    reason: `source missing: ${files.length} tracked files, but ${tried.join(', ')} ${tried.length === 1 ? 'is' : 'are'} not on disk${sparse ? ' (a sparse checkout that never got the source)' : ''}`,
  };
}

/** Error text for a failed probe, in the words infra-failure.ts reads as Studio's (never the agent's) failure. */
export const sourceError = (what: string, p: Probe) => `${p.reason ?? 'source unreadable'} (${what}; not counted as a try)`;

/** The agent's or scout's own words saying it could not read the source: the same finding, seen from inside the pass. */
export const SOURCE_UNREADABLE_SAID = /could not read username|could not fetch [^\n]{0,80}from promisor|promisor remote|terminal prompts disabled|no (unity )?(game )?source (files? )?(in|here|available|checked out)|(assets|the source|the repo)( directory| folder)? (is|was) (empty|not checked out)|only (the )?top-level files|sparse[- ]checkout[^\n]{0,60}(only|root)/i;

/**
 * Makes `dir` (a worktree of a light clone) hold the project's source: the sparse patterns above, one `sparse-checkout
 * set` through Studio's git (its token header for the repo, GIT_LFS_SKIP_SMUDGE) that fetches the needed blobs in one batch.
 * `run` is repos.ts/beta.ts's gitAsync. Returns what the probe finds after; never throws.
 */
export async function populateSource(
  dir: string,
  run: (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string; err: string }>,
  opts: { unity: boolean; log?: (s: string) => void; probe?: (dir: string) => Probe; git?: Git },
): Promise<Probe> {
  const log = opts.log ?? (() => {});
  const probe = opts.probe ?? ((d: string) => probeSource(d, { unity: opts.unity }));
  const before = probe(dir);
  if (before.ok) return before;
  const patterns = opts.unity ? unitySourcePatterns(dir, opts.git) : GENERIC_SOURCE_PATTERNS;
  const t0 = Date.now();
  const r = await run(dir, ['sparse-checkout', 'set', '--no-cone', ...patterns]);
  if (!r.ok) {
    log(`checking out the source into the worktree failed: ${r.err.split('\n').pop() || 'no message'}`);
    return { ...probe(dir), ok: false, reason: `source unreadable: sparse-checkout of the source failed: ${(r.err.split('\n').pop() || 'git gave no message').slice(0, 300)}` };
  }
  const after = probe(dir);
  log(after.ok
    ? `the project's source is checked out in the worktree (${after.tracked} tracked files, read ${after.sample}; ${Math.round((Date.now() - t0) / 1000)} s)`
    : `source checkout finished but the worktree still has no source: ${after.reason}`);
  return after;
}

/** The wait before repair attempt `n` (1-based): 0 for the first, then 5 s, 20 s, 60 s. */
export const REPAIR_BACKOFF_MS = [0, 5_000, 20_000, 60_000];
export type Repair = { probe: Probe; attempts: string[] };

/**
 * Repairs a worktree whose source check failed (J, 2026-11-05: "source missing: 1467 tracked files, but
 * Assets/Editor/BuildArena.cs ... are not on disk (a sparse checkout that never got the source)" ended a fix with no
 * commit). Each attempt is one step further up a ladder, and the worktree is probed again after every one:
 *   1. the project's source patterns again (populateSource: `sparse-checkout set` + one batched blob fetch),
 *   2. `sparse-checkout reapply` and `checkout -- .` (files git thinks are there but aren't),
 *   3. a full checkout: `sparse-checkout disable` then `checkout -- .` (not for a light Unity checkout: its whole tree
 *      killed the job for memory, so it goes straight to 4),
 *   4. `rebuild`: the worktree is deleted and cloned/checked out fresh (the caller's closure), then probed.
 * Backoff between attempts (REPAIR_BACKOFF_MS). Returns the last probe and what was tried, in words for the log and for
 * the failure's detail. Never throws. `run` is gitAsync; `sleep` is for tests.
 */
export async function healSource(
  dir: string,
  run: (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string; err: string }>,
  opts: { unity: boolean; light: boolean; rebuild?: () => Promise<void>; log?: (s: string) => void; probe?: (dir: string) => Probe; git?: Git; sleep?: (ms: number) => Promise<void>; backoffMs?: number[]; maxAttempts?: number },
): Promise<Repair> {
  const log = opts.log ?? (() => {});
  const probe = opts.probe ?? ((d: string) => probeSource(d, { unity: opts.unity }));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = opts.backoffMs ?? REPAIR_BACKOFF_MS;
  const attempts: string[] = [];
  let p = opts.light ? await populateSource(dir, run, { unity: opts.unity, log, probe, git: opts.git }) : probe(dir);
  if (p.ok) return { probe: p, attempts };
  if (opts.light) attempts.push('the source patterns checked out again');
  const steps: { what: string; go: () => Promise<boolean> }[] = [
    { what: 'sparse-checkout reapply and checkout of the tracked files', go: async () => { await run(dir, ['sparse-checkout', 'reapply']); return (await run(dir, ['checkout', '--quiet', '--', '.'])).ok; } },
    ...(opts.light && opts.unity ? [] : [{ what: 'a full checkout (sparse-checkout disabled)', go: async () => { await run(dir, ['sparse-checkout', 'disable']); return (await run(dir, ['checkout', '--quiet', '--', '.'])).ok; } }]),
    ...(opts.rebuild ? [{ what: 'the worktree deleted and made again from scratch', go: async () => { await opts.rebuild!(); return true; } }] : []),
  ];
  const max = Math.min(opts.maxAttempts ?? 4, steps.length);
  for (let i = 0; i < max; i++) {
    await sleep(backoff[Math.min(i + 1, backoff.length - 1)] ?? 0);
    const step = steps[i];
    log(`source check failed (${p.reason?.split('\n')[0]}); repairing: ${step.what} (attempt ${i + 1} of ${max})`);
    let did = false;
    try { did = await step.go(); } catch (e: any) { log(`repair step threw: ${String(e?.message ?? e).slice(0, 200)}`); }
    attempts.push(did ? step.what : `${step.what} (git refused it)`);
    // After a rebuild the light checkout needs its source patterns again.
    p = opts.light && step.what.startsWith('the worktree deleted') ? await populateSource(dir, run, { unity: opts.unity, log, probe, git: opts.git }) : probe(dir);
    if (p.ok) { log(`source repaired after ${attempts.length} attempt(s): ${step.what}`); return { probe: p, attempts }; }
  }
  return { probe: p, attempts };
}

/** The failure text for a source check that repair could not fix: the exact finding and everything tried. */
export const repairedError = (what: string, r: Repair) => `${sourceError(what, r.probe)}${r.attempts.length ? `; tried: ${r.attempts.join(', then ')}` : ''}`;
