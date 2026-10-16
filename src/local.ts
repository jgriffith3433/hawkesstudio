// Things on this PC: each product's local server (for playtests), git state, and check commands.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { abs, localUrl, paths, DATA, type Product } from './config.ts';
import { sandboxOn, sandboxSpawn } from './sandbox.ts';
import { shareCmds } from './warm.ts';

const WIN = process.platform === 'win32';
/** A shell command, the platform's way (cmd on Windows, sh elsewhere). */
const shell = (cmd: string): [string, string[]] => (WIN ? ['cmd.exe', ['/c', cmd]] : ['sh', ['-c', cmd]]);
const PYTHON = WIN ? 'python' : 'python3';

const SERVERS = path.join(DATA, 'servers.json');
const readServers = (): Record<string, { pid: number; port: number; started: number }> => {
  try {
    return JSON.parse(fs.readFileSync(SERVERS, 'utf8'));
  } catch {
    return {};
  }
};

async function answers(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/**
 * Installs a checkout's packages without touching its tracked files. A plain "npm install" rewrites package-lock.json
 * (e.g. its version after a pre-deploy build bumped package.json), and an uncommitted change there stops the server's
 * beta checkout from following beta (repos.ts).
 */
export const installCmd = (dir: string) => fs.existsSync(path.join(dir, 'package-lock.json'))
  ? 'npm ci --no-audit --no-fund || npm install --no-save --no-audit --no-fund'
  : 'npm install --no-save --no-package-lock --no-audit --no-fund';

/** Starts the product's local server if nothing answers on its port, and waits until it does. */
export async function ensureServer(p: Product, log: (s: string) => void = () => {}) {
  const url = localUrl(p);
  if (await answers(`http://127.0.0.1:${p.local.port}/`)) return url;
  const dir = abs(p.local.dir);
  const out = fs.openSync(path.join(paths.logs, `server-${p.id}.log`), 'a');
  let child;
  if (p.local.serve === 'npm') {
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
      log(`${p.id}: ${installCmd(dir)}`);
      await new Promise((resolve) => spawn(...shell(installCmd(dir)),{ cwd: dir, stdio: 'ignore', windowsHide: true }).on('close', resolve).on('error', resolve));
    }
    child = spawn(...shell(`npm run dev -- --port ${p.local.port} --strictPort`), { cwd: dir, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  } else {
    child = spawn(PYTHON, ['-m', 'http.server', String(p.local.port), '--bind', '127.0.0.1'], { cwd: dir, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  }
  child.unref();
  const servers = readServers();
  servers[p.id] = { pid: child.pid!, port: p.local.port, started: Date.now() };
  fs.writeFileSync(SERVERS, JSON.stringify(servers, null, 2));
  log(`${p.id}: started its local server on :${p.local.port}`);
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    if (await answers(`http://127.0.0.1:${p.local.port}/`)) return url;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${p.name}'s local server didn't answer on :${p.local.port} (see .data/logs/server-${p.id}.log)`);
}

const served = new Map<number, number>();

/**
 * Serves another copy of a product (an agent's worktree) on its own port, the way its local server would, and
 * waits until it answers. npm projects reuse the main checkout's node_modules (a link) so this is quick.
 */
export async function serveDir(p: Product, dir: string, port: number) {
  // The worktree's own code (its dev server, its install scripts) runs as the agent sandbox's user when it's on
  // (sandbox.ts): an agent's change never runs as Studio.
  if (p.local.serve === 'npm' && !fs.existsSync(path.join(dir, 'node_modules'))) {
    const main = path.join(abs(p.local.dir), 'node_modules');
    if (fs.existsSync(main) && !sandboxOn()) fs.symlinkSync(main, path.join(dir, 'node_modules'), WIN ? 'junction' : 'dir');
    else await new Promise((resolve) => sandboxSpawn(...shell(installCmd(dir)),{ cwd: dir, stdio: 'ignore' }).on('close', resolve).on('error', resolve));
  }
  if (p.local.serve === 'npm' && sandboxOn()) await shareDeps(dir);
  const out = fs.openSync(path.join(paths.logs, `serve-${p.id}-${port}.log`), 'a');
  const child = p.local.serve === 'npm'
    ? sandboxSpawn(...shell(`npm run dev -- --port ${port} --strictPort`), { cwd: dir, detached: true, stdio: ['ignore', out, out] })
    : spawn(PYTHON, ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: dir, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  served.set(port, child.pid!);
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    if (await answers(`http://127.0.0.1:${port}/`)) return `http://localhost:${port}${p.local.path}`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopServed(port);
  throw new Error(`The fixed version didn't start on :${port} (see .data/logs/serve-${p.id}-${port}.log)`);
}

/**
 * A worktree's node_modules (and Vite's cache in it) belongs to the worktree's group before a sandboxed dev server
 * starts, so Vite can rebuild its cache: worktrees warmed before the fix in warm.ts still have the donor's group.
 * Quick when it's already right. Returns whether it changed anything.
 */
export async function shareDeps(dir: string) {
  const nm = path.join(dir, 'node_modules');
  let gid: number;
  try {
    if (fs.lstatSync(nm).isSymbolicLink()) return false;
    gid = fs.statSync(dir).gid;
    const wrong = (f: string) => { try { const st = fs.statSync(f); return st.gid !== gid || (st.mode & 0o070) !== 0o070; } catch { return false; } };
    if (!wrong(nm) && !wrong(path.join(nm, '.vite')) && !wrong(path.join(nm, '.vite', 'deps'))) return false;
  } catch {
    return false;
  }
  for (const [cmd, args] of shareCmds(nm, gid)) await new Promise((resolve) => spawn(cmd, args, { stdio: 'ignore' }).on('close', resolve).on('error', resolve));
  return true;
}

export function stopServed(port: number) {
  const pid = served.get(port);
  if (!pid) return;
  served.delete(port);
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
}

/** Stops the local servers Studio started. */
export function stopServers() {
  const servers = readServers();
  const stopped: string[] = [];
  for (const [id, s] of Object.entries(servers)) {
    if (WIN) spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else try { process.kill(-s.pid, 'SIGTERM'); } catch { /* already gone */ }
    stopped.push(id);
  }
  fs.writeFileSync(SERVERS, '{}');
  return stopped;
}

export function git(dir: string, args: string[]) {
  const r = spawnSync('git', ['-C', abs(dir), ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** Branch, last commit, uncommitted files, commits not pushed. */
export function gitState(dir: string) {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const head = git(dir, ['log', '-1', '--format=%h %s (%cr)']).out;
  const status = git(dir, ['status', '--porcelain']).out;
  const dirty = status ? status.split('\n').length : 0;
  const ahead = Number(git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]).out) || 0;
  const lastPush = git(dir, ['log', '-1', '--format=%cr', `origin/${branch}`]).out;
  return { branch, head, dirty, ahead, lastPush, files: status.split('\n').filter(Boolean).slice(0, 40) };
}

/** A fingerprint of the working tree: changes when anything committed or uncommitted changes. */
export function treeFingerprint(dir: string) {
  const head = git(dir, ['rev-parse', 'HEAD']).out;
  const status = git(dir, ['status', '--porcelain', '-uall']).out;
  let mtimes = '';
  for (const line of status.split('\n').filter(Boolean)) {
    const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!;
    try {
      mtimes += `${file}:${Math.round(fs.statSync(path.join(abs(dir), file)).mtimeMs)};`;
    } catch {
      mtimes += `${file}:gone;`;
    }
  }
  return `${head}|${status.length}|${hash(mtimes)}`;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Runs a check command (tests, typecheck) in a project; resolves to its result. */
export function runCheck(dir: string, cmd: string, timeoutMs = 15 * 60_000): Promise<{ ok: boolean; code: number | null; seconds: number; tail: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(...shell(cmd), { cwd: abs(dir), windowsHide: true });
    let out = '';
    const keep = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, seconds: Math.round((Date.now() - t0) / 1000), tail: out.split(/\r?\n/).slice(-40).join('\n') });
    });
    child.on('error', (e) => resolve({ ok: false, code: null, seconds: 0, tail: e.message }));
  });
}
