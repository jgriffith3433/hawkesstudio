// The Cloud Run job's side of src/cloudjob.ts: one execution of `studio-agent` runs one agent's, scout's or Talk's
// Claude Code pass. Started by the image's entry with STUDIO_JOB_UNIT set:
//
//   node src/cloudjob-run.ts            (reads gs://<STUDIO_STATE_BUCKET>/jobs/<unit>/spec.json)
//
// 1. Reads the spec and deletes it at once (it holds the Claude login and the clone token).
// 2. Rebuilds the workspace at the same absolute path: a clone from GitHub (the token goes only on that one command, as a
//    header: it is never written to the clone), the commits GitHub lacks (in.bundle), the uncommitted files, Claude Code's
//    session folder and the files the command names (in.pack).
// 3. Runs the command as the unprivileged user `agent` when this runs as root (the image), so nothing the pass runs can
//    read this process's memory or the token. Output goes up in chunks every ~2 s (a Talk answer's within a quarter
//    second of being written: spec.flushMs), and after each upload the runner nudges Studio (POST
//    /api/cloudjobs/<unit>/nudge with the agents' key its MCP server uses) so it reads them now instead of on its next
//    look; a `stop` object ends the command.
// 4. Sends back what the pass committed (out.bundle) and left uncommitted plus the session (out.pack), then exit.json.

import { probeSource, sourceError } from './source-ready.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parsePointer, lfsObjectPath, type LfsRef } from './lfs.ts';
import { git, packFiles, readPack, unpack, folderEntries, dirtyState, type JobRunner, type PackCommit, type PackFile } from './cloudjob.ts';
// @ts-ignore: a plain .mjs, no types
import { changedLogins } from '../bin/ai-login-seed.mjs';

type Store = Pick<JobRunner, 'put' | 'get' | 'list' | 'remove'>;
// kind "build" (previews-cloud.ts): a beta site's build of one commit, in a shallow clone when GitHub has the commit; no
// session or workspace goes back, only `outputs` (paths in the workspace) as out/outputs.tgz.
// The clone is partial (`--filter=blob:none`: git fetches the blobs a checkout needs, with the token) and skips Git LFS
// files unless the spec asks (`lfs`), so a big repo (a Unity project of GBs) is never pulled whole; `partial: false` asks
// for a full clone (Studio's spec for a small repo, so the pass can read any old file without a token).
// tokenAt: when Studio minted `token`; refresh: where and with which job key to ask for a fresh one (jobgit.ts).
type JobGit = { base?: string; head: string; branch: string; remote: string; bundle: boolean; token: string | null; tokenAt?: number; refresh?: { url: string; key: string }; shallow?: boolean; partial?: boolean; lfs?: boolean; commitDirty?: boolean; sparse?: string[] };
type Spec = { kind?: 'build'; outputs?: string[]; file: string; args: string[]; cwd: string; env: Record<string, string>; sessions: string; git: JobGit | null; flushMs?: number; repos?: ExtraRepo[] };
/** A read-only copy of another of the Studio's repos, next to the worktree (access.ts extraReposFor). */
type ExtraRepo = { slug: string; remote: string; token: string | null; dir: string };
/** Tells Studio new output is in the bucket (resolves either way, never throws). */
type Nudge = () => Promise<void>;

/**
 * The real nudge: Studio's address and the agents' key from the pass's own environment (cloudjob.ts jobEnv gives both,
 * for its MCP server), so nothing new is provisioned. Carries nothing but the unit: Studio only ever reads the output
 * from the bucket. Null without them (a local test, a Studio without the key).
 */
export function httpNudge(unit: string) {
  return (env: Record<string, string>): Nudge | null => {
    const url = String(env.STUDIO_URL ?? '').replace(/\/+$/, '');
    const key = String(env.STUDIO_AGENT_KEY ?? '').trim();
    if (!/^https?:\/\//.test(url) || !key) return null;
    return () => fetch(`${url}/api/cloudjobs/${encodeURIComponent(unit)}/nudge`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
      .then((r) => void r.body?.cancel().catch(() => {}), () => {});
  };
}

/** The workspace clone's arguments (no checkout: prepare checks the head out after the bundle). Exported for the tests. */
export const jobCloneArgs = (g: Pick<JobGit, 'remote' | 'partial'>, cwd: string) => ['clone', '--quiet', '--no-checkout', ...(g.partial === false ? [] : ['--filter=blob:none']), g.remote, cwd];
/** The environment for the clone's checkouts: LFS files skipped unless the spec asks for them. Exported for the tests. */
export const jobGitEnv = (g: Pick<JobGit, 'lfs'>): Record<string, string> => g.lfs ? {} : { GIT_LFS_SKIP_SMUDGE: '1' };
/** What a clone without LFS files keeps in its config, so the pass's own checkouts skip them too. */
const SKIP_LFS: [string, string][] = [['filter.lfs.smudge', 'git-lfs smudge --skip -- %f'], ['filter.lfs.process', 'git-lfs filter-process --skip']];

const LFS_CLEAN: [string, string][] = [['filter.lfs.clean', 'git-lfs clean -- %f'], ['filter.lfs.required', 'true']];

/** The unprivileged user the pass runs as (made in the image), when this runner is root. */
function agentUser() {
  if (process.getuid?.() !== 0) return null;
  const name = process.env.STUDIO_JOB_USER || 'agent';
  const r = spawnSync('id', ['-u', name], { encoding: 'utf8' });
  const g = spawnSync('id', ['-g', name], { encoding: 'utf8' });
  if (r.status !== 0 || g.status !== 0) return null;
  return { name, uid: Number(r.stdout.trim()), gid: Number(g.stdout.trim()), home: `/home/${name}` };
}

/** git with the clone token as a one-off header (never in the clone's config or remote URL). */
function gitWithToken(cwd: string, args: string[], token: string | null, env: Record<string, string> = {}) {
  // `-c` reaches the git processes this one starts too (GIT_CONFIG_PARAMETERS): a partial clone's lazy blob fetch.
  const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
  const r = spawnSync('git', ['-c', 'safe.directory=*', ...auth, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, ok: r.status === 0, err: String(r.stderr ?? r.error?.message ?? '').trim() };
}

/**
 * A conflict pass (spec.git.base): beta's side of the merge is brought into the clone WITH the token, before the agent
 * starts. The clone is blobless and keeps no credentials, so the agent's own `git merge origin/<base>` could not fetch the
 * blobs it needs ("could not read Username", "could not fetch <blob> from promisor remote") and every pass looked like a
 * conflict (Yooba Land #509, #510, 2026-11-08). Fetches the base, tries the merge (which pulls the blobs both sides
 * touched into the clone) and always backs out of it (the agent makes the real merge, with those blobs already here); a
 * real overlap is named by file. A credentials or fetch failure is its own answer, never a conflict. Exported for the tests.
 */
export function premerge(cwd: string, base: string, token: string | null, log: (s: string) => void, run: typeof gitWithToken = gitWithToken):
  { state: 'current' | 'clean' | 'conflict' | 'failed'; files: string[]; err?: string } {
  const ref = `refs/remotes/origin/${base}`;
  const f = run(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:${ref}`], token);
  if (!f.ok) return { state: 'failed', files: [], err: `fetch of origin/${base}: ${f.err.split('\n').pop()}` };
  if (git(cwd, ['merge-base', '--is-ancestor', ref, 'HEAD']).ok) return { state: 'current', files: [] };
  const id = ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai', '-c', 'core.hooksPath=/dev/null'];
  const m = run(cwd, [...id, 'merge', '--no-ff', '--no-commit', ref], token);
  if (m.ok) { git(cwd, ['merge', '--abort']); return { state: 'clean', files: [] }; }
  const files = git(cwd, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  git(cwd, ['merge', '--abort']);
  // No unmerged file: git could not even read the other side (credentials, a blob it could not fetch): not a conflict.
  if (!files.length) return { state: 'failed', files: [], err: `merge of origin/${base}: ${m.err.split('\n').filter(Boolean).slice(-2).join(' | ')}` };
  log(`[job] origin/${base} conflicts with the branch in ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` and ${files.length - 10} more` : ''}`);
  return { state: 'conflict', files };
}

/** A spec's token older than this is swapped for a fresh one before cloning (GitHub's last an hour). */
const TOKEN_FRESH_MS = () => Number(process.env.STUDIO_JOB_TOKEN_FRESH_MS) || 40 * 60_000;
/** What git says when GitHub refused the token (with prompts off it can't ask for another). */
export const authFailed = (err: string) => /could not read (Username|Password)|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied|\b40[13]\b|Invalid username or password/i.test(err);

/**
 * The clone token: the spec's while it's fresh, else (or once GitHub refuses it) one fresh token asked from Studio with
 * the job's own key (POST /api/cloudjobs/<unit>/git-token, jobgit.ts). Never logged. Exported for the tests.
 */
export function jobToken(unit: string, g: Pick<JobGit, 'token' | 'tokenAt' | 'refresh' | 'remote'>, log: (s: string) => void, now = Date.now) {
  let token = g.token;
  let asked = false;
  const waitedMin = () => (g.tokenAt ? Math.round((now() - g.tokenAt) / 60_000) : null);
  /** One fresh token from Studio (true: got one). Asked at most once. */
  const refresh = async (why: string) => {
    if (asked || !g.refresh) return false;
    asked = true;
    const slug = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(g.remote)?.[1] ?? '';
    try {
      const r = await fetch(`${g.refresh.url}/api/cloudjobs/${encodeURIComponent(unit)}/git-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Job-Key': g.refresh.key },
        body: JSON.stringify({ repo: slug }), signal: AbortSignal.timeout(20_000),
      });
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && typeof d.token === 'string' && d.token) {
        token = d.token;
        log(`[job] a fresh GitHub token from Studio (${why})`);
        return true;
      }
      log(`[job] Studio gave no fresh GitHub token (${why}): ${r.status} ${String(d.error ?? '').slice(0, 200)}`);
    } catch (e: any) {
      log(`[job] couldn't ask Studio for a fresh GitHub token (${why}): ${e.message ?? e}`);
    }
    return false;
  };
  return {
    get: () => token,
    /** Before the first use: swaps a token minted too long ago. */
    async freshen() {
      const w = waitedMin();
      if (token && g.tokenAt && now() - g.tokenAt > TOKEN_FRESH_MS()) await refresh(`the job waited ${w} min to start`);
    },
    /** Runs a git command with the token; once more with a fresh token when GitHub refused it. */
    async run<T extends { ok: boolean; err: string }>(f: (token: string | null) => T): Promise<T> {
      const r = f(token);
      if (r.ok || !authFailed(r.err) || !(await refresh('GitHub refused the token'))) return r;
      return f(token);
    },
    /** The error for a git command GitHub refused: says the token expired instead of git's prompt text. */
    message(what: string, err: string) {
      const last = err.split('\n').pop() ?? '';
      if (!authFailed(err)) return `${what} failed: ${last}`;
      const w = waitedMin();
      if (w !== null && w >= 55) return `${what} failed: GitHub token expired: the job waited ${w} min to start`;
      return `${what} failed: GitHub refused the token${w !== null ? ` (minted ${w} min before)` : ''}: ${last}`;
    },
  };
}

/** Rebuilds the workspace; returns the HEAD the pass starts from. */
export async function prepare(unit: string, spec: Spec, store: Store, log: (s: string) => void, at: (p: string) => string = (p) => p, baseline?: Baseline, tokenOut?: { get?: () => string | null }) {
  const key = (n: string) => `jobs/${unit}/${n}`;
  const cwd = at(spec.cwd);
  if (spec.git) {
    fs.mkdirSync(path.dirname(cwd), { recursive: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    const env = jobGitEnv(spec.git);
    const tok = jobToken(unit, spec.git, log);
    if (tokenOut) tokenOut.get = tok.get;
    await tok.freshen();
    if (spec.git.shallow && !spec.git.bundle) {
      // Just that commit (a beta site's build): GitHub hands out any commit it has by id.
      fs.mkdirSync(cwd, { recursive: true });
      git(cwd, ['init', '--quiet']);
      const f = await tok.run((t) => gitWithToken(cwd, ['fetch', '--quiet', '--depth', '1', spec.git!.remote, spec.git!.head], t));
      if (f.status !== 0) throw new Error(tok.message(`fetch of ${spec.git.head.slice(0, 7)}`, f.err));
      const co = gitWithToken(cwd, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], null, env);
      if (!co.ok) throw new Error(`checkout of ${spec.git.head.slice(0, 7)}: ${co.err.split('\n').pop()}`);
      log(`[job] ${spec.git.remote} at ${spec.git.head.slice(0, 7)} (shallow)`);
      return git(cwd, ['rev-parse', 'HEAD']).out;
    }
    const c = await tok.run((t) => {
      fs.rmSync(cwd, { recursive: true, force: true });
      return gitWithToken(path.dirname(cwd), jobCloneArgs(spec.git!, cwd), t, env);
    });
    if (c.status !== 0) throw new Error(tok.message('clone', c.err));
    if (!spec.git.lfs) for (const [k, v] of SKIP_LFS) git(cwd, ['config', k, v]);
    // New LFS files are stored in .git/lfs/objects when the pass commits them, whatever the image's own git config says.
    for (const [k, v] of LFS_CLEAN) git(cwd, ['config', k, v]);
    // The pass's own git fetches missing blobs from the promisor remote (a checkout, a merge, `git lfs fetch`): it needs the
    // token too. A read-only token for this one repo, in the job's throwaway clone only (never in out.pack or a bundle).
    const t0 = tok.get();
    if (t0 && /^https:\/\/github\.com\//.test(spec.git.remote)) git(cwd, ['config', 'http.https://github.com/.extraheader', `Authorization: Basic ${Buffer.from(`x-access-token:${t0}`).toString('base64')}`]);
    if (spec.git.bundle) {
      const b = await store.get(key('in.bundle'));
      const file = path.join(os.tmpdir(), `${unit}-in.bundle`);
      fs.writeFileSync(file, b!);
      const f = git(cwd, ['fetch', '--quiet', file, 'HEAD']);
      if (!f.ok) throw new Error(`the workspace's own commits: ${f.err.split('\n').pop()}`);
    }
    // A big repo: only the source patterns are checked out (the job's disk is memory; a Unity project's whole tree killed the
    // job within 2 minutes, before any agent line). Written as the sparse file, so nothing is checked out by this.
    if (spec.git.sparse?.length) {
      git(cwd, ['config', 'core.sparseCheckout', 'true']);
      git(cwd, ['config', 'core.sparseCheckoutCone', 'false']);
      fs.mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.git', 'info', 'sparse-checkout'), `${spec.git.sparse.join('\n')}\n`);
    }
    // With the token: a partial clone fetches the head's blobs from GitHub here.
    const g = spec.git;
    const co = await tok.run((t) => g.branch && g.branch !== 'HEAD'
      ? gitWithToken(cwd, ['checkout', '--quiet', '-B', g.branch, g.head], t, env)
      : gitWithToken(cwd, ['checkout', '--quiet', '--detach', g.head], t, env));
    if (!co.ok) throw new Error(tok.message(`checkout of ${spec.git.head.slice(0, 7)}`, co.err));
    // Preflight: a partial clone whose checkout has no readable source (a promisor remote without credentials, a sparse
    // leftover) stops the job here, as an infra failure, instead of starting an agent on an empty tree.
    if (spec.git.partial !== false) {
      const probe = probeSource(cwd);
      if (!probe.ok) throw new Error(sourceError(`the job's clone of ${spec.git.remote}`, probe));
      log(`[job] source check: ${probe.tracked} tracked files, read ${probe.sample ?? 'the root files'}`);
    }
    if (g.base) {
      const pm = await tok.run((t) => { const r = premerge(cwd, g.base!, t, log); return { ...r, ok: r.state !== 'failed', err: r.err ?? '' }; });
      if (pm.state === 'failed') log(`[job] ${tok.message(`bringing in origin/${g.base}`, pm.err ?? '')} (the agent is told; this is not a conflict)`);
      else if (pm.state === 'clean') log(`[job] origin/${g.base} merges into the branch with no conflicts (its files are fetched for the agent)`);
      else if (pm.state === 'current') log(`[job] the branch already has origin/${g.base}`);
    }
    // As in Studio's own clone: the agent's brief and notes never go into a commit.
    fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '\n.hawkes/\n');
    // What the fresh checkout already shows as changed (a partial clone without LFS files, line endings, modes): not the agent's.
    if (baseline) {
      const b = dirtyBaseline(cwd);
      for (const [k, v] of b) baseline.set(k, v);
      if (b.size) log(`[job] the checkout already shows ${b.size} file(s) as changed before the agent starts; they are never committed as its work`);
    }
    log(`[job] workspace ${spec.git.remote} at ${spec.git.head.slice(0, 7)} (${spec.git.branch}${spec.git.partial === false ? '' : ', partial clone'}${spec.git.lfs ? '' : ', no LFS files'})`);
  } else fs.mkdirSync(cwd, { recursive: true });
  const pack = await store.get(key('in.pack'));
  if (pack) {
    const p = readPack(pack);
    for (const f of p.files.filter((x) => path.isAbsolute(x.p))) unpack({ files: [{ ...f, p: at(f.p) }] }, '/');
    unpack({ files: p.files.filter((f) => !path.isAbsolute(f.p)), deleted: p.deleted }, cwd);
  }
  for (const r of spec.repos ?? []) cloneExtra(r, at, log);
  return spec.git ? git(cwd, ['rev-parse', 'HEAD']).out : null;
}

/**
 * One read-only copy (shallow, no LFS files) of another of the Studio's repos, for the agent to read. Never part of its
 * work: it sits outside the worktree, and its token was read-only and is not kept (a one-off header). A failure only
 * leaves it out.
 */
export function cloneExtra(r: ExtraRepo, at: (p: string) => string, log: (s: string) => void) {
  const dir = at(r.dir);
  if (!/^[\w.-]+\/[\w.-]+$/.test(r.slug) || !/^https:\/\/github\.com\//.test(r.remote)) return false;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const c = gitWithToken(path.dirname(dir), ['clone', '--quiet', '--depth', '1', '--single-branch', r.remote, dir], r.token, { GIT_LFS_SKIP_SMUDGE: '1' });
  if (c.status !== 0) { log(`[job] ${r.slug} not copied: ${c.err.split('\n').pop()}`); return false; }
  log(`[job] read-only copy of ${r.slug} at ${r.dir}`);
  return true;
}

/**
 * An agent's pass that ended with files edited but not committed (its `git commit` refused, or the session cut off): the
 * job commits them, so the work travels back in out.bundle and reaches the branch whatever the big repo's worktree does
 * with loose files (2026-11-02: every Unity agent change came back "no commit"). The agent's .hawkes/ notes are excluded
 * from git. True when a commit was made.
 */
export function commitLeftovers(cwd: string, log: (s: string) => void, message = 'Work from the agent\'s pass', baseline?: Baseline) {
  if (!fs.existsSync(path.join(cwd, '.git'))) return false;
  // Mode-only changes are not changes (a checkout without the executable bit, a Windows-made mode).
  const files = realChanges(cwd, baseline);
  if (!files.length) {
    if (git(cwd, ['-c', 'core.fileMode=false', 'status', '--porcelain']).out) log('[job] the only loose changes were not the agent\'s (LFS pointers, line endings, modes, or files dirty before it started): nothing to commit');
    return false;
  }
  let add = { ok: true, err: '' };
  for (let i = 0; i < files.length && add.ok; i += 200) add = git(cwd, ['-c', 'core.fileMode=false', 'add', '-A', '--', ...files.slice(i, i + 200)]);
  if (add.ok) unstagePointers(cwd);
  if (!git(cwd, ['diff', '--cached', '--name-only']).out) { log('[job] nothing left to commit after skipping LFS pointer files'); return false; }
  const c = add.ok && git(cwd, ['-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-verify', '-m', `${message}\n\n${LEFTOVER_MARK}: the agent left these changes uncommitted.`]);
  if (!add.ok || !c || !c.ok) { log(`[job] couldn't commit the agent's leftover changes: ${(add.ok ? c && c.err : add.err) || ''}`.slice(0, 300)); return false; }
  log(`[job] committed the agent's leftover changes (${files.length} file(s))`);
  return true;
}

/** The mark in the message of a commit Studio made for the agent (agents.ts tells these from the agent's own). */
export const LEFTOVER_MARK = "Committed by Hawkes Studio's job";

/** File -> content hash (or 'deleted') of what a worktree shows as changed. */
export type Baseline = Map<string, string>;

const hashes = (cwd: string, files: string[]) => {
  const out = new Map<string, string>();
  for (let i = 0; i < files.length; i += 200) {
    const part = files.slice(i, i + 200);
    const h = git(cwd, ['hash-object', '--no-filters', '--', ...part]).out.split('\n');
    part.forEach((f, j) => out.set(f, h[j] ?? ''));
  }
  return out;
};

/** The worktree's changed, new and deleted files right now, with a hash of each (before the agent starts: its baseline). */
export function dirtyBaseline(cwd: string): Baseline {
  const base: Baseline = new Map();
  if (!fs.existsSync(path.join(cwd, '.git'))) return base;
  const list = (args: string[]) => git(cwd, ['-c', 'core.fileMode=false', 'ls-files', '-z', ...args]).raw.toString('utf8').split('\0').filter(Boolean);
  const deleted = new Set(list(['-d']));
  const changed = [...new Set([...list(['-m']), ...list(['-o', '--exclude-standard'])])].filter((f) => !deleted.has(f));
  for (const [f, h] of hashes(cwd, changed)) base.set(f, h);
  for (const f of deleted) base.set(f, 'deleted');
  return base;
}

/**
 * The files the agent really changed: changed since the baseline (a file dirty before it started and still the same is not
 * its work), not LFS pointers, not a change that is only line endings, trailing whitespace or the file mode.
 */
export function realChanges(cwd: string, baseline?: Baseline): string[] {
  const now = dirtyBaseline(cwd);
  const mine = [...now].filter(([f, h]) => baseline?.get(f) !== h).map(([f]) => f);
  const present = mine.filter((f) => now.get(f) !== 'deleted');
  const tracked = new Set(git(cwd, ['ls-files', '-z', '--', ...present.slice(0, 5000)]).raw.toString('utf8').split('\0').filter(Boolean));
  return mine.filter((f) => {
    if (now.get(f) === 'deleted') return true;
    if (isLfsPointer(path.join(cwd, f))) return false;
    if (!tracked.has(f)) return true; // a new file
    // Same text but for the line endings or trailing spaces: the checkout's doing, not an edit.
    return !git(cwd, ['-c', 'core.fileMode=false', 'diff', '--quiet', '--ignore-cr-at-eol', '--ignore-space-at-eol', '--', f]).ok;
  });
}

/** Whether a file's first bytes are a Git LFS pointer. */
export function isLfsPointer(file: string) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      return buf.subarray(0, n).toString('utf8').startsWith('version https://git-lfs.github.com/spec');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/**
 * A clone without LFS files (spec.git.lfs false) holds pointer files where the art would be. Git can list ~1,100 of them as
 * modified (2026-11-03: Yooba Land and Sick of It), which is noise, not the agent's edits: a pointer is never staged here.
 */
export function unstagePointers(cwd: string) {
  const staged = git(cwd, ['diff', '--cached', '--name-only', '-z']).raw.toString('utf8').split('\0').filter(Boolean);
  const noise = staged.filter((f) => isLfsPointer(path.join(cwd, f)));
  for (let i = 0; i < noise.length; i += 200) git(cwd, ['reset', '--quiet', '--', ...noise.slice(i, i + 200)]);
  return noise;
}

/**
 * The pass's commits as plain files: the net change start..HEAD (contents at HEAD, deletions) and the commits' messages.
 * A bundle is a thin pack against blobs Studio's light clone may not have; this always applies (cloudjob.ts replayCommit).
 * null when there is nothing to send or it would be too big (the bundle stays the only way then).
 */
export function replayOf(cwd: string, start: string, head: string, maxBytes = 120 * 1024 * 1024): PackCommit | null {
  const raw = git(cwd, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', start, head]);
  if (!raw.ok || !raw.out) return null;
  const t = raw.raw.toString('utf8').split('\0');
  const files: PackFile[] = [];
  const deleted: string[] = [];
  let bytes = 0;
  for (let i = 0; i + 1 < t.length; i += 2) {
    const m = /^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ (\w)/.exec(t[i]);
    if (!m) continue;
    const file = t[i + 1];
    if (m[3] === 'D') { deleted.push(file); continue; }
    if (m[2] === '160000' || m[2] === '120000') continue; // submodules and symlinks aren't replayed
    const blob = git(cwd, ['cat-file', 'blob', `${head}:${file}`]);
    if (!blob.ok) return null; // a blob this clone doesn't have: the bundle is the only way
    bytes += blob.raw.length;
    if (bytes > maxBytes) return null;
    files.push({ p: file, d: blob.raw.toString('base64'), m: m[2] === '100755' ? 0o755 : 0o644 });
  }
  if (!files.length && !deleted.length) return null;
  const subjects = git(cwd, ['log', '--reverse', '--format=%B', '--no-merges', `${start}..${head}`]).out;
  const message = (subjects || "Work from the agent's pass").slice(0, 4000);
  return { message, files, deleted };
}

/**
 * The new Git LFS files the commits start..head point at: pointers added or changed, whose object this clone holds in
 * .git/lfs/objects (what the pass's commit made). Pointers whose object isn't here (a merged-in base's: GitHub has them) are left out.
 */
export function lfsOf(cwd: string, start: string, head: string): LfsRef[] {
  const raw = git(cwd, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--diff-filter=AM', start, head]);
  if (!raw.ok || !raw.out) return [];
  const t = raw.raw.toString('utf8').split('\0');
  const names: string[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) if (/^:\d+ 1\d+ /.test(t[i])) names.push(t[i + 1]);
  const out = new Map<string, LfsRef>();
  for (let i = 0; i < names.length; i += 500) {
    const part = names.slice(i, i + 500);
    const input = Buffer.from(part.map((f) => `${head}:${f}`).join('\n') + '\n');
    const sizes = git(cwd, ['cat-file', '--batch-check'], { input }).out.split('\n');
    const small = part.filter((_, j) => /\s(\d+)$/.test(sizes[j] ?? '') && Number(/\s(\d+)$/.exec(sizes[j])![1]) < 1024);
    for (const f of small) {
      const ref = parsePointer(git(cwd, ['cat-file', 'blob', `${head}:${f}`]).out);
      if (ref && fs.existsSync(lfsObjectPath(cwd, ref.oid))) out.set(ref.oid, ref);
    }
  }
  return [...out.values()];
}

/** What the pass did: its new commits (a bundle), its uncommitted files and the session folder. */
export function collect(spec: Spec, start: string | null, tmp: string, at: (p: string) => string = (p) => p, baseline?: Baseline, token: string | null = null) {
  const cwd = at(spec.cwd);
  const entries = folderEntries(at(spec.sessions), (rel) => path.join(spec.sessions, rel));
  let gitOut: { head: string; bundle: boolean } | null = null;
  let deleted: string[] = [];
  let bundle: string | null = null;
  let bundleError: string | null = null;
  let commit: PackCommit | null = null;
  let lfs: LfsRef[] = [];
  if (spec.git && fs.existsSync(path.join(cwd, '.git'))) {
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    if (start && head && head !== start) {
      // The same commits as plain files too: the bundle's thin pack may not apply in Studio's light clone.
      commit = replayOf(cwd, start, head);
      lfs = lfsOf(cwd, start, head);
      bundle = path.join(tmp, 'out.bundle');
      // With the token: in a partial clone the bundle needs objects (a merged-in base's blobs) it must fetch from GitHub.
      const b = gitWithToken(cwd, ['bundle', 'create', bundle, 'HEAD', `^${start}`], token);
      if (!b.ok) {
        // Never silent: HEAD moved, so the pass committed, but its commits can't travel. The pass fails with git's reason.
        bundle = null;
        bundleError = `couldn't bundle the pass's commits (${start.slice(0, 7)}..${head.slice(0, 7)}): ${b.err.split('\n').slice(-3).join(' | ') || 'git printed nothing'}`;
      }
    }
    const d = dirtyState(cwd);
    // Only what the agent changed: not LFS pointers, line endings or files already dirty at the checkout (realChanges).
    const mine = new Set(realChanges(cwd, baseline));
    deleted = d.deleted.filter((f) => mine.has(f));
    for (const rel of d.changed) if (mine.has(rel)) entries.push({ p: rel, file: path.join(cwd, rel) });
    // The agent's notes (.hawkes/: its summary, question, stuck notes) come back by name: they're excluded from git.
    const have = new Set(entries.map((e) => e.p));
    entries.push(...folderEntries(path.join(cwd, '.hawkes'), (rel) => `.hawkes/${rel}`).filter((e) => !have.has(e.p)));
    gitOut = { head, bundle: Boolean(bundle) };
  }
  return { pack: packFiles(entries, deleted, commit, lfs), lfs: lfs.map((r) => ({ ...r, file: lfsObjectPath(cwd, r.oid) })), bundle, bundleError, replay: Boolean(commit), git: gitOut };
}

/**
 * The whole execution. `store` is the bucket; `at` places absolute paths (tests: under a scratch root, as if on another
 * machine); `nudge` makes the function that tells Studio new output is up (the job's entry: httpNudge; tests their own).
 */
export async function runUnit(unit: string, store: Store, { every = 2000, at = (p: string) => p, nudge = null }: { every?: number; at?: (p: string) => string; nudge?: ((env: Record<string, string>) => Nudge | null) | null } = {}): Promise<number> {
  const key = (n: string) => `jobs/${unit}/${n}`;
  const chunks = { log: [] as Buffer[], err: [] as Buffer[] };
  const n = { log: 0, err: 0 };
  // One nudge at a time; more output meanwhile sends one more after it (never a pile of requests).
  let send: Nudge | null = null;
  let nudging: Promise<void> | null = null;
  let nudgeAgain = false;
  const poke = () => {
    if (!send) return;
    if (nudging) return void (nudgeAgain = true);
    nudging = (async () => {
      do {
        nudgeAgain = false;
        await send!();
      } while (nudgeAgain);
    })().finally(() => { nudging = null; });
  };
  // Uploads go one after another, so chunk n+1 is never in the bucket before chunk n (Studio reads them in order and
  // skips numbers it has passed). One that fails doesn't stop the next ones.
  let uploads: Promise<void> = Promise.resolve();
  const flush = () => (uploads = uploads.catch(() => {}).then(async () => {
    let wrote = false;
    for (const kind of ['log', 'err'] as const) {
      if (!chunks[kind].length) continue;
      const data = Buffer.concat(chunks[kind].splice(0));
      await store.put(key(`out/${kind}-${String(++n[kind]).padStart(6, '0')}`), data);
      wrote = true;
    }
    if (wrote) poke();
  }));
  const say = (s: string) => chunks.err.push(Buffer.from(`${s}\n`));
  let spec: Spec;
  try {
    const raw = await store.get(key('spec.json'));
    if (!raw) throw new Error('no spec');
    spec = JSON.parse(raw.toString('utf8'));
    await store.remove(key('spec.json'));
    send = nudge?.(spec.env ?? {}) ?? null;
  } catch (e: any) {
    say(`[job] ${e.message}`);
    await flush();
    await store.put(key('out/exit.json'), JSON.stringify({ code: null, signal: null, error: `no spec: ${e.message}` }));
    return 1;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-run-'));
  let start: string | null = null;
  let code: number | null = null;
  let signal: string | null = null;
  let error: string | undefined;
  const baseline: Baseline = new Map();
  const tokenBox: { get?: () => string | null } = {};
  let passHome: string | null = null;
  try {
    start = await prepare(unit, spec, store, say, at, baseline, tokenBox);
    const user = agentUser();
    if (user) {
      // The pass's user owns its workspace and session folder (and nothing of this runner's).
      for (const d of [at(spec.cwd), path.dirname(path.dirname(at(spec.sessions))), user.home, ...(spec.repos?.length ? [path.dirname(at(spec.repos[0].dir))] : [])]) spawnSync('chown', ['-R', `${user.uid}:${user.gid}`, d]);
      // And the files its command names by absolute path (Talk's --mcp-config, 0600): unreadable to it otherwise, so Claude
      // Code stopped with EACCES before answering (2026-10-29).
      for (const a of spec.args) if (path.isAbsolute(a) && fs.existsSync(at(a)) && fs.statSync(at(a)).isFile()) spawnSync('chown', [`${user.uid}:${user.gid}`, at(a)]);
    }
    const env = { ...spec.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: user?.home ?? os.homedir(), STUDIO_JOB: '1' };
    passHome = env.HOME;
    const child = spawn(spec.file, spec.args, { cwd: at(spec.cwd), env, stdio: ['ignore', 'pipe', 'pipe'], ...(user ? { uid: user.uid, gid: user.gid } : {}), windowsHide: true });
    // Output goes up `flushMs` after it's written (Talk's answers: a quarter second), else on the timer below.
    const flushMs = Number(spec.flushMs) > 0 ? Number(spec.flushMs) : 0;
    let soon: NodeJS.Timeout | null = null;
    const wrote = () => {
      if (!flushMs || soon) return;
      soon = setTimeout(() => { soon = null; void flush().catch(() => {}); }, flushMs);
    };
    child.stdout.on('data', (d: Buffer) => { chunks.log.push(d); wrote(); });
    child.stderr.on('data', (d: Buffer) => { chunks.err.push(d); wrote(); });
    const timer = setInterval(() => void (async () => {
      await flush();
      if ((await store.list(key('stop'))).length && child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 10_000).unref();
      }
    })().catch(() => {}), every);
    [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
      child.on('error', (e) => { error = e.message; resolve([null, null]); });
      child.on('close', (c, s) => resolve([c, s]));
    });
    clearInterval(timer);
    if (soon) clearTimeout(soon);
  } catch (e: any) {
    error = String(e.message ?? e);
    say(`[job] ${error}`);
  }
  // An AI CLI that refreshed its sign-in in the pass's home (OpenAI's refresh tokens work once): the new login files go
  // back for Studio to keep (cli-signin.ts keepRefreshedLogin), or the next pass would start with a spent one.
  try {
    const back = passHome ? changedLogins(spec.env, passHome) : {};
    if (Object.keys(back).length) await store.put(key('out/logins.json'), JSON.stringify(back));
  } catch (e: any) {
    say(`[job] sending a refreshed sign-in back: ${e.message ?? e}`);
  }
  if (spec.kind === 'build') {
    // A build sends back its outputs only (never the workspace or a session).
    try {
      const cwd = at(spec.cwd);
      const have = (spec.outputs ?? []).filter((o) => !path.isAbsolute(o) && !o.split(/[\\/]/).includes('..') && fs.existsSync(path.join(cwd, o)));
      if (code === 0 && !error && have.length) {
        // To stdout, from inside the workspace: no paths for tar to misread.
        const t = spawnSync('tar', ['-czf', '-', '--', ...have], { cwd, encoding: 'buffer', maxBuffer: 4 * 1024 ** 3 });
        if (t.status !== 0) throw new Error(`tar: ${String(t.stderr).trim().slice(0, 300)}`);
        await store.put(key('out/outputs.tgz'), t.stdout);
      }
      await flush();
      await store.put(key('out/exit.json'), JSON.stringify({ code, signal, ...(error ? { error } : {}), outputs: have }));
    } catch (e: any) {
      say(`[job] sending the build back: ${e.message ?? e}`);
      await flush().catch(() => {});
      await store.put(key('out/exit.json'), JSON.stringify({ code, signal, error: `sending the build back failed: ${e.message ?? e}` }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return error ? 1 : 0;
  }
  try {
    if (spec.git?.commitDirty && !error) commitLeftovers(at(spec.cwd), say, undefined, baseline);
    const out = collect(spec, start, tmp, at, baseline, tokenBox.get?.() ?? null);
    if (out.bundle) await store.put(key('out/out.bundle'), fs.readFileSync(out.bundle));
    // The new LFS files first: Studio reads them when it reads the pack, and the pack names them.
    for (const o of out.lfs) await store.put(key(`out/lfs/${o.oid}`), fs.readFileSync(o.file));
    if (out.lfs.length) say(`[job] sending ${out.lfs.length} new LFS file(s) back (${Math.round(out.lfs.reduce((n, o) => n + o.size, 0) / 1e6)} MB)`);
    await store.put(key('out/out.pack'), out.pack);
    await flush();
    if (out.bundleError) say(`[job] ${out.bundleError}`);
    // Without a bundle the commits still travel as files (out.replay); only when neither works is the pass failed.
    if (out.bundleError && !out.replay && !error) error = out.bundleError;
    await store.put(key('out/exit.json'), JSON.stringify({ code, signal, ...(error ? { error } : {}), git: out.git }));
  } catch (e: any) {
    say(`[job] sending the work back: ${e.message ?? e}`);
    await flush().catch(() => {});
    await store.put(key('out/exit.json'), JSON.stringify({ code, signal, error: `sending the work back failed: ${e.message ?? e}` }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The exit is up: Studio collects it now rather than on its next look (awaited: the job's entry exits right after).
  if (send) {
    await nudging;
    await send();
  }
  return error ? 1 : 0;
}

// Run as the job's entry (not when a test imports it).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const unit = process.env.STUDIO_JOB_UNIT;
  const bucket = process.env.STUDIO_STATE_BUCKET;
  const brokered = Boolean(process.env.STUDIO_RUN_TOKEN && process.env.STUDIO_BROKER_URL);
  if (!unit || (!bucket && !brokered)) {
    console.error('STUDIO_JOB_UNIT and STUDIO_STATE_BUCKET (or a run token and the broker) are needed');
    process.exit(2);
  }
  // A customer's run (jobbroker.ts): this job's account has no bucket access; its own run folder only, by the broker.
  if (brokered) {
    const { brokerStore } = await import('./jobbroker.ts');
    const token = process.env.STUDIO_RUN_TOKEN!;
    delete process.env.STUDIO_RUN_TOKEN; // the pass's command never sees it
    const rc = await runUnit(unit, brokerStore(process.env.STUDIO_BROKER_URL!, token), { nudge: httpNudge(unit) });
    console.log(`[job] ${unit} finished (${rc ? 'with an error' : 'ok'})`);
    process.exit(0);
  }
  const g = await import('./gcp.ts');
  // A customer's cell: its jobs are under its own prefix in the shared bucket (cloudjob.ts passes STUDIO_STATE_PREFIX).
  const P = String(process.env.STUDIO_STATE_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const at = (k: string) => (P ? `${P}/${k}` : k);
  const store: Store = {
    // Strings here are contents (exit.json, log chunks); gcsWrite reads a string as a file path, so they go as bytes.
    put: async (k, d) => { const key = at(k); await g.gcsWrite(bucket!, key, typeof d === 'string' ? Buffer.from(d) : d); },
    get: (k) => g.gcsRead(bucket!, at(k)),
    list: async (p) => (await g.gcsList(bucket!, at(p))).map((o) => (P ? o.name.slice(P.length + 1) : o.name)),
    remove: (k) => g.gcsDelete(bucket!, at(k)),
  };
  const rc = await runUnit(unit, store, { nudge: httpNudge(unit) });
  console.log(`[job] ${unit} finished (${rc ? 'with an error' : 'ok'})`);
  // The job's own exit is 0 either way: the result is in exit.json, and a retry would run the pass twice.
  process.exit(0);
}
