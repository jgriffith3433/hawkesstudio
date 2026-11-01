// Warm starts for agent worktrees: an agent's worktree gets node_modules copied from a checkout whose package-lock.json
// is the same (the beta working copy, the server's checkout, a recent worktree) instead of a fresh npm ci, and the
// stamps that ensureDeps (beta.ts), npmCi (agents.ts) and the fast lane read, so nothing installs again. A copy, never
// hard links: an agent's install must not write through into another tree. npm itself uses one shared cache
// (STUDIO_NPM_CACHE, set by deploy/agent-sandbox.mjs) for whatever still installs. A donor counts only when a real
// install stamped it for its lockfile (INSTALLED): a checkout whose package-lock moved on without an npm ci (Dose Of
// Destruction's PR #12, 2026-10-18) has the new lockfile and old packages, and copying those broke every worktree.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PROJECTS } from './config.ts';
import { runCommand } from './ops.ts';
import { lightCheckout } from './lfs.ts';

export const lockHash = (dir: string) => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');
  } catch {
    return null;
  }
};
const STAMPS = ['.studio-lock', '.hawkes-lock'];
/** Written into node_modules after a real install (npm ci) only, with the lockfile's hash; a copy carries it along. */
export const INSTALLED = '.hawkes-installed';

/** The lockfile hash `dir`'s node_modules was installed for (INSTALLED), or null. */
export function installedFor(dir: string) {
  try { return fs.readFileSync(path.join(dir, 'node_modules', INSTALLED), 'utf8').trim() || null; } catch { return null; }
}

/** After an npm ci in `dir`: every stamp (ensureDeps, npmCi, the fast lane, warm starts) says it matches `hash`. */
export function markInstalled(dir: string, hash: string | null = lockHash(dir)) {
  if (!hash) return;
  for (const s of [...STAMPS, INSTALLED]) try { fs.writeFileSync(path.join(dir, 'node_modules', s), hash); } catch { /* the sandbox owns it */ }
}

/** What `dir`'s node_modules must be installed for: its lockfile's hash, else (no lockfile) package.json's; else null. */
export function depsHash(dir: string) {
  const lock = lockHash(dir);
  if (lock) return lock;
  try { return `package.json:${crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'package.json'))).digest('hex')}`; } catch { return null; }
}

/** Why `dir` needs an install (no node_modules, no stamp, a stamp for other packages), or null when it matches. */
export function staleDeps(dir: string) {
  const want = depsHash(dir);
  if (!want) return null;
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return 'no node_modules';
  const was = installedFor(dir);
  if (was === want) return null;
  const file = want.startsWith('package.json:') ? 'package.json' : 'package-lock.json';
  return was ? `installed for another ${file}` : `no record of an install for this ${file}`;
}

/** npm ci, or (no lockfile) an npm install that writes no lockfile: neither touches the checkout's tracked files. */
export const depsCmd = (dir: string) => fs.existsSync(path.join(dir, 'package-lock.json'))
  ? 'npm ci --no-audit --no-fund'
  : 'npm install --no-save --no-package-lock --no-audit --no-fund';

export type ShellRun = (dir: string, cmd: string) => Promise<{ ok: boolean; out: string; ms: number }>;

/** Runs `cmd` in `dir` (a shell), keeping the output's tail; killed after `timeoutMs`. */
export const runShell = (dir: string, cmd: string, timeoutMs = 20 * 60_000): Promise<{ ok: boolean; out: string; ms: number }> => new Promise((resolve) => {
  const t0 = Date.now();
  let out = '';
  const child = spawn(cmd, [], { cwd: dir, shell: true, windowsHide: true });
  const timer = setTimeout(() => { out += `\n(timed out after ${Math.round(timeoutMs / 60_000)} min)`; child.kill('SIGKILL'); }, timeoutMs);
  timer.unref();
  const keep = (d: Buffer) => { out = (out + d).slice(-20_000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message, ms: Date.now() - t0 }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, ms: Date.now() - t0 }); });
});

export type DepsResult = { installed: boolean; ok: boolean; why?: string; ms: number; error?: string };
/** One install at a time per folder: a call waits for the one running there, then looks at the stamp again. */
const installs = new Map<string, Promise<DepsResult>>();

/**
 * The one way a checkout's packages are brought up to date (local servers, beta's builds and dev servers, syncs):
 * when the stamp of the last install (INSTALLED) isn't for its lockfile (or package.json), npm ci (npm install with
 * no lockfile) and stamp it. Serialized per folder, so concurrent callers install once. `why` forces an install (a
 * sync saw package.json change); `run` is the caller's shell (tracking, another user).
 */
export function ensureInstalled(dir: string, { log = () => {}, run = runShell, why: forced }: { log?: (s: string) => void; run?: ShellRun; why?: string } = {}): Promise<DepsResult> {
  const key = path.resolve(dir);
  const job = (installs.get(key) ?? Promise.resolve(null)).then(async (): Promise<DepsResult> => {
    const hash = depsHash(dir);
    const why = hash ? forced ?? staleDeps(dir) : null;
    if (!hash || !why) return { installed: false, ok: true, ms: 0 };
    const cmd = depsCmd(dir);
    const name = cmd.startsWith('npm ci') ? 'npm ci' : 'npm install';
    log(`dependencies changed: ${name} (${why})`);
    const r = await run(dir, cmd).catch((e: any) => ({ ok: false, out: String(e?.message ?? e), ms: 0 }));
    if (!r.ok) {
      const error = r.out.trim().split('\n').filter(Boolean).slice(-8).join('\n') || `${name} failed`;
      log(`${name} failed (${Math.round(r.ms / 1000)} s): ${error}`);
      return { installed: false, ok: false, why, ms: r.ms, error };
    }
    markInstalled(dir, hash);
    log(`${name} done (${Math.round(r.ms / 1000)} s)`);
    return { installed: true, ok: true, why, ms: r.ms };
  });
  installs.set(key, job);
  void job.finally(() => { if (installs.get(key) === job) installs.delete(key); });
  return job;
}

/** The shell command that installs `dir`'s packages and stamps them (so it works as the sandbox user too). */
export const stampedCi = (hash: string) => `npm ci --no-audit --no-fund && for s in ${[...STAMPS, INSTALLED].join(' ')}; do printf %s ${hash} > node_modules/$s; done`;

/** The folders under `root` (at most 2 levels down, no node_modules) that have a package-lock.json, relative. */
function lockDirs(root: string) {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    const abs = path.join(root, rel);
    if (fs.existsSync(path.join(abs, 'package-lock.json'))) out.push(rel);
    if (depth >= 2) return;
    let names: string[] = [];
    try { names = fs.readdirSync(abs); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules' || n === 'Library') continue;
      try { if (fs.statSync(path.join(abs, n)).isDirectory()) walk(path.join(rel, n), depth + 1); } catch { /* gone */ }
    }
  };
  walk('', 0);
  return out;
}

/** Candidate donors for a repo folder: the beta working copy, the server's checkout, other worktrees (newest first). */
function donors(repoTop: string, worktree: string) {
  const work = path.join(PROJECTS, '.work');
  const list = [path.join(PROJECTS, repoTop)];
  try {
    for (const n of fs.readdirSync(work)) {
      const d = path.join(work, n);
      if (d === worktree || n.startsWith('.')) continue;
      // A worktree's .git is a file: "gitdir: <projects>/<repo>/.git/worktrees/<name>".
      try {
        const gitdir = fs.readFileSync(path.join(d, '.git'), 'utf8').split(path.sep).join('/');
        if (gitdir.includes(`/${repoTop}/.git/`)) list.push(d);
      } catch { /* not a worktree */ }
    }
  } catch { /* no .work yet */ }
  return list.sort((a, b) => (fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs));
}

/**
 * The commands that give a copied tree to the worktree's group (`gid`: .work is setgid hawkes-work, the sandbox user's
 * group) with group write. "cp -a" keeps the donor's group ("hawkes", which the sandbox user isn't in), so g+rwX
 * alone left Vite's cache unwritable to a sandboxed dev server (EACCES on node_modules/.vite/deps). Nothing on Windows.
 * Files the sandbox user already owns are left as they are (-f).
 */
export function shareCmds(dir: string, gid: number): [string, string[]][] {
  if (process.platform === 'win32') return [];
  return [['chgrp', ['-R', '-f', String(gid), dir]], ['chmod', ['-R', '-f', 'g+rwX', dir]]];
}

/** The lockfile folders of `worktree` (relative, "" for its root) that have no node_modules yet. */
export const coldDirs = (worktree: string) => lockDirs(worktree).filter((rel) => !fs.existsSync(path.join(worktree, rel, 'node_modules')));

/**
 * Copies node_modules into every lockfile folder of `worktree` that lacks it, from a donor whose installed packages
 * (INSTALLED) are for the same lockfile. Folders with no such donor are left for an npm ci (coldDirs).
 */
export async function warmDeps(worktree: string, repoTop: string, log: (s: string) => void = () => {}) {
  const warmed: string[] = [];
  // A light checkout (a big repo on Cloud Run, lfs.ts): no node_modules copied onto the memory disk; the job installs.
  if (lightCheckout(worktree)) { log('warm start skipped: a light checkout of a big repo on the cloud server'); return warmed; }
  const from = donors(repoTop, worktree);
  for (const rel of lockDirs(worktree)) {
    const dest = path.join(worktree, rel);
    const hash = lockHash(dest);
    if (!hash || fs.existsSync(path.join(dest, 'node_modules'))) continue;
    // A donor installed for this lockfile: same lockfile, and a real install's stamp for it (not just a copy's).
    const donor = from.map((d) => path.join(d, rel)).find((d) => lockHash(d) === hash && installedFor(d) === hash);
    if (!donor) { log(`warm start: no checkout has node_modules installed for ${rel || 'the'} package-lock.json; npm ci instead`); continue; }
    const t0 = Date.now();
    const ok = process.platform === 'win32'
      ? (() => { try { fs.cpSync(path.join(donor, 'node_modules'), path.join(dest, 'node_modules'), { recursive: true, verbatimSymlinks: true }); return true; } catch { return false; } })()
      // Async: a copy of node_modules takes seconds, and a synchronous one froze Studio while agents started.
      : (await runCommand('cp', ['-a', path.join(donor, 'node_modules'), path.join(dest, 'node_modules')], { timeoutMs: 5 * 60_000 })).ok;
    if (!ok) { fs.rmSync(path.join(dest, 'node_modules'), { recursive: true, force: true }); continue; }
    // The agent sandbox's user writes there too (Vite's cache, an npm install): see shareCmds.
    for (const [cmd, args] of shareCmds(path.join(dest, 'node_modules'), fs.statSync(worktree).gid)) await runCommand(cmd, args, { timeoutMs: 5 * 60_000 });
    for (const s of STAMPS) try { fs.writeFileSync(path.join(dest, 'node_modules', s), hash); } catch { /* fine */ }
    warmed.push(rel || '.');
    log(`warm start: node_modules${rel ? ` in ${rel}` : ''} copied from ${path.relative(PROJECTS, donor) || donor} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  return warmed;
}

/**
 * npm ci in every lockfile folder of `worktree` that still has no node_modules after warmDeps (no donor installed for
 * its lockfile). `run` is the caller's shell (the sandbox user's for agent worktrees). A failed install is logged and
 * left to the agent's own checks.
 */
export async function installCold(worktree: string, run: (dir: string, cmd: string) => Promise<{ ok: boolean; out: string; ms: number }>, log: (s: string) => void = () => {}) {
  if (lightCheckout(worktree)) { log('npm ci skipped: a light checkout of a big repo on the cloud server'); return; }
  for (const rel of coldDirs(worktree)) {
    const dir = path.join(worktree, rel);
    const hash = lockHash(dir);
    if (!hash) continue;
    const r = await run(dir, stampedCi(hash));
    const where = rel ? ` in ${rel}` : '';
    log(r.ok ? `npm ci${where} (${Math.round(r.ms / 1000)} s)` : `npm ci${where} failed (${Math.round(r.ms / 1000)} s): ${r.out.trim().split('\n').slice(-5).join('\n')}`);
  }
}
