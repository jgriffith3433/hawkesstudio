// Warm starts for agent worktrees: an agent's worktree gets node_modules copied from a checkout whose package-lock.json
// is the same (the beta working copy, the server's checkout, a recent worktree) instead of a fresh npm ci, and the
// stamps that ensureDeps (beta.ts), npmCi (agents.ts) and the fast lane read, so nothing installs again. A copy, never
// hard links: an agent's install must not write through into another tree. npm itself uses one shared cache
// (STUDIO_NPM_CACHE, set by deploy/agent-sandbox.mjs) for whatever still installs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PROJECTS } from './config.ts';

const lockHash = (dir: string) => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');
  } catch {
    return null;
  }
};
const STAMPS = ['.studio-lock', '.hawkes-lock'];

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

/** Copies node_modules into every lockfile folder of `worktree` that lacks it, from a donor with the same lockfile. */
export function warmDeps(worktree: string, repoTop: string, log: (s: string) => void = () => {}) {
  const warmed: string[] = [];
  const from = donors(repoTop, worktree);
  for (const rel of lockDirs(worktree)) {
    const dest = path.join(worktree, rel);
    const hash = lockHash(dest);
    if (!hash || fs.existsSync(path.join(dest, 'node_modules'))) continue;
    // A donor installed for this lockfile: same lockfile, node_modules there, and its stamp (if any) for the same lock.
    const installedFor = (d: string) => STAMPS.map((s) => { try { return fs.readFileSync(path.join(d, 'node_modules', s), 'utf8'); } catch { return null; } }).filter(Boolean);
    const donor = from.map((d) => path.join(d, rel)).find((d) => lockHash(d) === hash && fs.existsSync(path.join(d, 'node_modules')) && installedFor(d).every((s) => s === hash));
    if (!donor) continue;
    const t0 = Date.now();
    const ok = process.platform === 'win32'
      ? (() => { try { fs.cpSync(path.join(donor, 'node_modules'), path.join(dest, 'node_modules'), { recursive: true, verbatimSymlinks: true }); return true; } catch { return false; } })()
      : spawnSync('cp', ['-a', path.join(donor, 'node_modules'), path.join(dest, 'node_modules')], { timeout: 5 * 60_000 }).status === 0;
    if (!ok) { fs.rmSync(path.join(dest, 'node_modules'), { recursive: true, force: true }); continue; }
    // The agent sandbox's user writes there too (Vite's cache, an npm install): see shareCmds.
    for (const [cmd, args] of shareCmds(path.join(dest, 'node_modules'), fs.statSync(worktree).gid)) spawnSync(cmd, args, { timeout: 5 * 60_000 });
    for (const s of STAMPS) try { fs.writeFileSync(path.join(dest, 'node_modules', s), hash); } catch { /* fine */ }
    warmed.push(rel || '.');
    log(`warm start: node_modules${rel ? ` in ${rel}` : ''} copied from ${path.relative(PROJECTS, donor) || donor} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  return warmed;
}
