// Developing on beta: J and agents work on the beta branch together, live on the server.
//
//   https://<sub>.hawkesgen.com/        the built beta site (previews.ts)
//   https://<sub>.hawkesgen.com/dev/    the product's own devtools / level editor, running on the server (dev-front.ts)
//
// - The beta working copy: a worktree of the product's source repo on a local branch (dev-beta) that tracks
//   origin/beta, at PROJECTS/.work/beta-<product> (/srv/hawkes/.work/beta-<product>). It is never the checkout that
//   repos.ts syncs, and nothing else writes to it.
// - The dev server: the product's `npm run dev` in that working copy, on its fixed port (products.json dev.port),
//   started when someone opens /dev/ and stopped after 30 idle minutes. At most 2 run at once (the control server
//   has 4 GB): opening a third stops the least recently used. It gets Hawkes Gen (HAWKESGEN_URL, and DEV_GEN_KEY
//   from /etc/hawkes/keys.env as HAWKESGEN_KEY) and no AWS or API keys.
// - Saves become commits: every working copy is watched; once its files have been quiet for 60 s the changes are
//   committed ("devtools: <files>"), rebased onto origin/beta if it moved, pushed to beta (never main) and the beta
//   site is rebuilt. Whoever changed the files (a devtools save, Talk, J by hand) shows the same way.
// - Agents: before an agent change is merged into beta the working copy is committed and pushed (flushDev); after the
//   merge it pulls (pullDev) and the dev server reloads what changed. A conflict stops auto-commit and the dev server,
//   and J is told (Talk and a notification) with the files involved; resolveDev retries or keeps beta's version (the
//   working copy's commits are saved on a devtools-conflict-<time> branch first).
// - Unity products have no dev server: /dev/ explains that their editor runs on the build server.

import fs from 'node:fs';
import { critical } from './drain.ts';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { PROJECTS, DATA, GEN_URL, paths, getProduct, loadProducts, StudioError, type Product } from './config.ts';
import { BETA, MAIN, ensureBeta, ensureDeps, compareBeta, repoDirs } from './beta.ts';
import { isServer } from './repos.ts';
import { notify, PUBLIC_URL } from './notify.ts';

const WIN = process.platform === 'win32';
/** The local branch the working copy is on (beta itself may be checked out in the synced repo). */
export const DEV_BRANCH = 'dev-beta';
export const DEV_AUTHOR = ['-c', 'user.name=Hawkes Studio (devtools)', '-c', 'user.email=studio@hawkesgen.com'];
const MAX = () => Number(process.env.STUDIO_DEV_MAX) || 2;
const IDLE_MS = () => (Number(process.env.STUDIO_DEV_IDLE_MIN) || 30) * 60_000;
const QUIET_MS = () => Number(process.env.STUDIO_DEV_QUIET_MS) || 60_000;
const WATCH_MS = () => Number(process.env.STUDIO_DEV_WATCH_MS) || 10_000;
const FETCH_MS = 5 * 60_000;
const BUILD_COST = 'about $0.77/hr while it runs (it stops itself after 30 idle minutes)';

if (BETA === MAIN) throw new Error(`The beta branch can't be ${MAIN}`);

// ------------------------------------------------------------------ products

export type DevConf = { front: number; port?: number; path?: string; env?: Record<string, string> };
/** products.json "dev": front = the port Caddy sends /dev/ to (Studio's front door), port = the dev server's port. */
export const devConf = (p: Product): DevConf | null => (p as any).dev ?? null;
export const isUnity = (p: Product) => Boolean(p.build) || p.engine === 'unity';
export const devProducts = () => loadProducts().filter((p) => devConf(p));
function devProduct(id: string) {
  const p = getProduct(id);
  if (!devConf(p)) throw new StudioError(`${p.name} has no dev settings (products.json "dev")`);
  return p;
}

/** The beta working copy (a worktree of the source repo). */
export const devDir = (p: Product) => path.join(PROJECTS, '.work', `beta-${p.id}`);
/** Where the dev server runs inside it (the product's local.dir relative to its repo). */
export const devWebDir = (p: Product) => path.join(devDir(p), path.relative(p.repo.split('/')[0], p.local.dir));
export const hasWorkingCopy = (p: Product) => fs.existsSync(path.join(devDir(p), '.git'));

// ---------------------------------------------------------------------- state

type Server = { status: 'starting' | 'running' | 'stopped' | 'failed'; pid?: number; started?: number; lastUsed?: number; detail?: string; stopped?: number };
type Wc = {
  /** The last commit Studio made from the working copy, and the last push. */
  lastCommit?: { sha: string; at: number; files: string[]; message: string } | null;
  lastPush?: { at: number; sha: string } | null;
  /** Set when beta moved in a way that conflicts with the working copy: auto-commit is off until resolved. */
  conflict?: { at: number; files: string[]; detail: string; during: string } | null;
  error?: { at: number; detail: string } | null;
};
type State = Record<string, { server?: Server; wc?: Wc }>;
const STATE = () => path.join(DATA, 'dev.json');
let state: State = (() => {
  try {
    return JSON.parse(fs.readFileSync(STATE(), 'utf8'));
  } catch {
    return {};
  }
})();
const save = () => fs.writeFileSync(STATE(), JSON.stringify(state, null, 2));
const srv = (id: string): Server => ((state[id] ??= {}).server ??= { status: 'stopped' });
const wcOf = (id: string): Wc => ((state[id] ??= {}).wc ??= {});

/** Per product: one git operation at a time (the watcher, flush before a merge, pull after one). */
const locks = new Map<string, Promise<unknown>>();
function locked<T>(id: string, f: () => Promise<T>): Promise<T> {
  const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(f);
  locks.set(id, next);
  return next;
}

// ------------------------------------------------------------------------ git

function gitA(cwd: string, args: string[], timeoutMs = 5 * 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, timeout: timeoutMs });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, out, err: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
  });
}
const short = (r: { out: string; err: string }) => (r.err || r.out).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);

/** Makes the beta working copy if it's missing (beta itself is made from main when the repo has none yet). */
export function ensureWorkingCopy(p: Product) {
  const dir = devDir(p);
  if (hasWorkingCopy(p)) return dir;
  const { source } = repoDirs(p);
  ensureBeta(source);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: source, windowsHide: true });
  const r = spawnSync('git', ['worktree', 'add', '--quiet', '-B', DEV_BRANCH, dir, `origin/${BETA}`], { cwd: source, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`Couldn't make the beta working copy: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  spawnSync('git', ['branch', '--quiet', `--set-upstream-to=origin/${BETA}`, DEV_BRANCH], { cwd: dir, windowsHide: true });
  return dir;
}

/** Changed files in the working copy, and a fingerprint that changes whenever any of them is written again. */
async function scan(dir: string) {
  const st = await gitA(dir, ['status', '--porcelain=v1', '-z', '-uall']);
  if (!st.ok) throw new Error(`git status: ${short(st)}`);
  const entries = st.out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    files.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // the rename's source path follows
  }
  let fp = st.out.length.toString(36);
  for (const f of files) {
    try {
      const s = fs.statSync(path.join(dir, f));
      fp += `|${f}:${Math.round(s.mtimeMs)}:${s.size}`;
    } catch {
      fp += `|${f}:gone`;
    }
  }
  return { files, fp };
}

/** Commits ahead of origin/beta, and commits on origin/beta the working copy lacks. */
async function divergence(dir: string) {
  const r = await gitA(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${BETA}`]);
  const [ahead, behind] = r.ok ? r.out.split(/\s+/).map(Number) : [0, 0];
  return { ahead: ahead || 0, behind: behind || 0 };
}

const summarize = (files: string[]) => {
  const shown = files.slice(0, 4).join(', ');
  return files.length > 4 ? `${shown} (+${files.length - 4} more)` : shown;
};

/**
 * Commits whatever changed in the working copy, brings in beta's new commits (rebase) and pushes to beta. Returns what
 * happened; a conflict sets the conflict state (auto-commit stops) and tells J.
 */
/** Committing devtools saves and pushing them to beta is a critical section (drain.ts). */
const commitAndSync = (p: Product, during: string) => critical(`pushing ${p.id}'s devtools saves to beta`, () => commitAndSyncNow(p, during));
async function commitAndSyncNow(p: Product, during: string): Promise<{ committed?: string; pushed?: string; pulled?: number; conflict?: string[]; nothing?: boolean }> {
  const dir = devDir(p);
  const wc = wcOf(p.id);
  if (wc.conflict) throw new StudioError(`${p.name}'s beta working copy has a conflict (${wc.conflict.files.join(', ')}). Resolve it first (studio_dev_resolve, or the dashboard).`, 409);
  const out: { committed?: string; pushed?: string; pulled?: number; conflict?: string[]; nothing?: boolean } = {};
  const { files } = await scan(dir);
  if (files.length) {
    const add = await gitA(dir, ['add', '-A']);
    if (!add.ok) throw new Error(`git add: ${short(add)}`);
    const staged = (await gitA(dir, ['diff', '--cached', '--name-only', '-z'])).out.split('\0').filter(Boolean);
    if (staged.length) {
      const message = `devtools: ${summarize(staged)}`;
      const c = await gitA(dir, [...DEV_AUTHOR, 'commit', '--quiet', '-m', message, '-m', `Saved in the beta working copy (${during}).\n\nFiles:\n${staged.map((f) => `- ${f}`).join('\n')}`]);
      if (!c.ok) throw new Error(`git commit: ${short(c)}`);
      const sha = (await gitA(dir, ['rev-parse', 'HEAD'])).out;
      wc.lastCommit = { sha, at: Date.now(), files: staged.slice(0, 50), message };
      out.committed = sha;
    }
  }
  const f = await gitA(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${BETA}:refs/remotes/origin/${BETA}`]);
  if (!f.ok) throw new Error(`git fetch: ${short(f)}`);
  let d = await divergence(dir);
  if (d.behind) {
    // Beta moved (an agent merge, a pre-deploy build, J's push): put the working copy's commits on top of it.
    const r = await gitA(dir, [...DEV_AUTHOR, 'rebase', '--quiet', `origin/${BETA}`]);
    if (!r.ok) {
      const conflicted = (await gitA(dir, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
      await gitA(dir, ['rebase', '--abort']);
      await setConflict(p, conflicted.length ? conflicted : ['(see the log)'], short(r), during);
      out.conflict = conflicted;
      return out;
    }
    out.pulled = d.behind;
    d = await divergence(dir);
  }
  if (d.ahead) {
    const push = await gitA(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]);
    if (!push.ok) throw new Error(`git push to ${BETA}: ${short(push)}`);
    const sha = (await gitA(dir, ['rev-parse', 'HEAD'])).out;
    wc.lastPush = { at: Date.now(), sha };
    out.pushed = sha;
    rebuildBeta(p);
  }
  if (!out.committed && !out.pushed && !out.pulled) out.nothing = true;
  wc.error = null;
  save();
  return out;
}

async function setConflict(p: Product, files: string[], detail: string, during: string) {
  wcOf(p.id).conflict = { at: Date.now(), files, detail, during };
  save();
  await stopDev(p.id, { flush: false, why: 'conflict' }).catch(() => {});
  const url = devUrl(p);
  const text = `${p.name}: the beta working copy (devtools saves) conflicts with beta (${during}).\n\nFiles: ${files.join(', ')}\n\nAuto-commit and the dev server are stopped. Nothing was lost: the devtools changes are commits in ${devDir(p)} (branch ${DEV_BRANCH}). To go on: fix beta so it agrees with them and retry, or keep beta's version (the devtools commits are saved on a devtools-conflict-<time> branch first). Ask me to do either (studio_dev_resolve), or use the dashboard.${url ? `\n\nDevtools: ${url}` : ''}`;
  void notify(`Beta conflict: ${p.name}`, text, { url: `${PUBLIC_URL}/#talk`, tags: ['warning'] });
  try {
    const { postNotice } = await import('./talk.ts');
    postNotice(`Beta conflict: ${p.name}`, text);
  } catch (e: any) {
    console.warn(`[studio] couldn't post the conflict to Talk: ${e.message ?? e}`);
  }
}

/** Rebuilds the beta site after a push; pushes while a build runs make one more build, not one each. */
const building = new Map<string, boolean>();
function rebuildBeta(p: Product) {
  if (building.has(p.id)) {
    building.set(p.id, true);
    return;
  }
  building.set(p.id, false);
  void (async () => {
    try {
      const { buildPreview, previewUrl } = await import('./previews.ts');
      do {
        building.set(p.id, false);
        if (!previewUrl(p.id)) break;
        await buildPreview(p.id);
      } while (building.get(p.id));
    } catch (e: any) {
      console.warn(`[studio] beta site for ${p.id}: ${e.message ?? e}`);
    } finally {
      building.delete(p.id);
    }
  })();
}

/** Commits and pushes the working copy now (before an agent change is merged into beta). No working copy: nothing. */
export function flushDev(productId: string, during = 'before a merge into beta') {
  const p = getProduct(productId);
  if (!hasWorkingCopy(p)) return Promise.resolve({ nothing: true });
  return locked(p.id, () => commitAndSync(p, during));
}

/** After beta moved (an agent merge): the working copy catches up (anything unsaved is committed first). */
export function pullDev(productId: string, during = 'after a merge into beta') {
  const p = getProduct(productId);
  if (!hasWorkingCopy(p) || wcOf(p.id).conflict) return Promise.resolve({ nothing: true });
  return locked(p.id, () => commitAndSync(p, during)).catch((e) => {
    wcOf(p.id).error = { at: Date.now(), detail: String(e.message ?? e) };
    save();
    throw e;
  });
}

/**
 * After a conflict. retry: try again (someone fixed beta). keep-beta: save the working copy's commits on a branch
 * (devtools-conflict-<time>, pushed), then reset the working copy to origin/beta.
 */
export function resolveDev(productId: string, action: 'retry' | 'keep-beta') {
  const p = devProduct(productId);
  if (!hasWorkingCopy(p)) throw new StudioError(`${p.name} has no beta working copy`);
  return locked(p.id, async () => {
    const wc = wcOf(p.id);
    const dir = devDir(p);
    let saved: string | null = null;
    if (action === 'keep-beta') {
      const { files } = await scan(dir);
      if (files.length) {
        await gitA(dir, ['add', '-A']);
        await gitA(dir, [...DEV_AUTHOR, 'commit', '--quiet', '-m', `devtools: ${summarize(files)} (unsaved when beta was kept)`]);
      }
      await gitA(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${BETA}:refs/remotes/origin/${BETA}`]);
      if ((await divergence(dir)).ahead) {
        saved = `devtools-conflict-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
        const push = await gitA(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${saved}`]);
        if (!push.ok) throw new Error(`saving the devtools commits on ${saved}: ${short(push)}`);
      }
      const reset = await gitA(dir, ['reset', '--quiet', '--hard', `origin/${BETA}`]);
      if (!reset.ok) throw new Error(`git reset: ${short(reset)}`);
      await gitA(dir, ['clean', '-fdq']);
    }
    wc.conflict = null;
    save();
    const r = await commitAndSync(p, action === 'retry' ? 'retry after a conflict' : 'kept beta after a conflict');
    return { ...r, saved, status: devStatus(p.id) };
  });
}

// --------------------------------------------------------------- dev servers

const children = new Map<string, ChildProcess>();
const starting = new Map<string, Promise<Server>>();

/** Keys never reach a dev server: only Hawkes Gen's address and the dev key. */
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AWS_|ANTHROPIC|ELEVENLABS|OPENAI|GITHUB|CLAUDE|STRIPE|SMTP|WEB_GEN)/i;
export function devEnv(p: Product) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET.test(k)) env[k] = v;
  env.HAWKESGEN_URL = GEN_URL;
  if (process.env.DEV_GEN_KEY) env.HAWKESGEN_KEY = process.env.DEV_GEN_KEY;
  env.HAWKES_BETA_DEV = '1';
  // On the server, a home of its own: no ~/.hawkes/client.json (an owner key) or other dotfiles of the service user.
  if (isServer()) {
    const home = path.join(DATA, 'dev-home');
    fs.mkdirSync(home, { recursive: true });
    env.HOME = home;
    env.npm_config_cache = path.join(home, '.npm');
  }
  for (const [k, v] of Object.entries(devConf(p)?.env ?? {})) env[k] = v.replaceAll('${PROJECTS}', PROJECTS);
  return env;
}

async function answers(port: number) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

function kill(pid: number) {
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

/** Marks the dev server as used (every request through /dev/ except Vite's reconnect pings). */
export function touchDev(id: string) {
  const s = srv(id);
  if (s.status === 'running' || s.status === 'starting') s.lastUsed = Date.now();
}

/** True when the product's dev server is running and answering (from state; no request). */
export const devRunning = (id: string) => srv(id).status === 'running';

/**
 * Starts the product's dev server in its beta working copy (making the copy, catching it up with beta and installing
 * packages first). Stops the least recently used one when MAX are already running. Resolves when it answers.
 */
export function startDev(productId: string, { by = 'J' }: { by?: string } = {}): Promise<Server> {
  const p = devProduct(productId);
  const conf = devConf(p)!;
  if (isUnity(p) || !conf.port) throw new StudioError(`${p.name} is a Unity game: its editor runs on the build server, not here (open ${devUrl(p) ?? '/dev/'} for how)`);
  if (wcOf(p.id).conflict) throw new StudioError(`${p.name}'s beta working copy has a conflict (${wcOf(p.id).conflict!.files.join(', ')}). Resolve it first.`, 409);
  const s = srv(p.id);
  if (s.status === 'running' && children.has(p.id)) {
    s.lastUsed = Date.now();
    return Promise.resolve(s);
  }
  const pending = starting.get(p.id);
  if (pending) return pending;
  const run = (async () => {
    Object.assign(s, { status: 'starting', started: Date.now(), lastUsed: Date.now(), detail: `opened by ${by}` });
    save();
    try {
      for (const id of lru(p.id)) await stopDev(id, { why: `${p.name} needed the room (at most ${MAX()} dev servers run at once)` });
      s.detail = 'preparing the beta working copy';
      ensureWorkingCopy(p);
      if (!wcOf(p.id).conflict) await locked(p.id, () => commitAndSync(p, 'opening devtools')).catch((e) => { wcOf(p.id).error = { at: Date.now(), detail: String(e.message ?? e) }; });
      if (wcOf(p.id).conflict) throw new StudioError(`beta conflicts with the working copy (${wcOf(p.id).conflict!.files.join(', ')})`, 409);
      const dir = devWebDir(p);
      s.detail = 'installing packages';
      await ensureDeps(dir);
      if (await answers(conf.port!)) throw new Error(`something else is already on port ${conf.port}`);
      s.detail = 'starting the dev server';
      const log = fs.openSync(path.join(paths.logs, `dev-${p.id}.log`), 'a');
      const cmd = `npm run dev -- --port ${conf.port} --strictPort --host 127.0.0.1`;
      // Detached on Linux (its own process group, stopped with kill(-pid)). Not on Windows: there a detached process gets
      // its own console window that windowsHide doesn't hide for npm's children (a window flashed on J's PC during the
      // tests); taskkill /T stops the tree either way.
      const child = spawn(WIN ? 'cmd.exe' : 'sh', WIN ? ['/c', cmd] : ['-c', cmd], { cwd: dir, env: devEnv(p), detached: !WIN, stdio: ['ignore', log, log], windowsHide: true });
      fs.closeSync(log);
      children.set(p.id, child);
      s.pid = child.pid;
      child.on('exit', (code) => {
        if (children.get(p.id) !== child) return;
        children.delete(p.id);
        if (s.status === 'running' || s.status === 'starting') Object.assign(s, { status: 'failed', detail: `the dev server exited (${code}); see .data/logs/dev-${p.id}.log`, pid: undefined, stopped: Date.now() });
        save();
      });
      const end = Date.now() + 3 * 60_000;
      while (Date.now() < end) {
        if (!children.has(p.id)) throw new Error(s.detail ?? 'the dev server exited');
        if (await answers(conf.port!)) {
          Object.assign(s, { status: 'running', detail: `npm run dev on :${conf.port}`, lastUsed: Date.now() });
          save();
          return s;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`the dev server didn't answer on :${conf.port} in 3 minutes (see .data/logs/dev-${p.id}.log)`);
    } catch (e: any) {
      const child = children.get(p.id);
      children.delete(p.id);
      if (child?.pid) kill(child.pid);
      Object.assign(s, { status: 'failed', detail: String(e.message ?? e).slice(0, 500), pid: undefined, stopped: Date.now() });
      save();
      throw e;
    } finally {
      starting.delete(p.id);
    }
  })();
  starting.set(p.id, run);
  return run;
}

/** The dev servers to stop so `id` can start (least recently used first). */
function lru(id: string) {
  const others = Object.entries(state).filter(([k, v]) => k !== id && (v.server?.status === 'running' || v.server?.status === 'starting') && children.has(k))
    .sort((a, b) => (a[1].server!.lastUsed ?? 0) - (b[1].server!.lastUsed ?? 0)).map(([k]) => k);
  return others.slice(0, Math.max(0, others.length - (MAX() - 1)));
}

/** Stops a dev server (its unsaved changes are committed first unless flush is false). */
export async function stopDev(productId: string, { flush = true, why = 'stopped' }: { flush?: boolean; why?: string } = {}) {
  const p = getProduct(productId);
  const s = srv(p.id);
  const child = children.get(p.id);
  children.delete(p.id);
  if (child?.pid) kill(child.pid);
  const was = s.status;
  Object.assign(s, { status: 'stopped', pid: undefined, detail: why, stopped: Date.now() });
  save();
  if (flush && hasWorkingCopy(p) && !wcOf(p.id).conflict) await locked(p.id, () => commitAndSync(p, 'the dev server stopped')).catch(() => {});
  return { product: p.id, was, status: devStatus(p.id) };
}

// ------------------------------------------------------------------- status

/** What the dashboard, the MCP tools and the /dev/ pages show. */
export function devStatus(productId: string) {
  const p = getProduct(productId);
  const conf = devConf(p);
  const s = srv(p.id);
  const wc = wcOf(p.id);
  const dir = devDir(p);
  let copy: any = null;
  if (hasWorkingCopy(p)) {
    const g = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
    const files = g(['status', '--porcelain', '-uall']).split('\n').filter(Boolean).map((l) => l.slice(3));
    const [ahead, behind] = g(['rev-list', '--left-right', '--count', `HEAD...origin/${BETA}`]).split(/\s+/).map(Number);
    copy = { dir, branch: DEV_BRANCH, head: g(['log', '-1', '--format=%h %s (%cr)']), uncommitted: files.length, files: files.slice(0, 30), unpushed: ahead || 0, behind: behind || 0, waiting: watch.get(p.id)?.since ?? null };
  }
  return {
    product: p.id, name: p.name, unity: isUnity(p), url: devUrl(p), beta: betaUrl(p), live: p.live,
    server: conf?.port ? { status: s.status, port: conf.port, started: s.started ?? null, lastUsed: s.lastUsed ?? null, stopped: s.stopped ?? null, detail: s.detail ?? null, idleStopAt: s.status === 'running' && s.lastUsed ? s.lastUsed + IDLE_MS() : null } : null,
    copy, lastCommit: wc.lastCommit ?? null, lastPush: wc.lastPush ?? null, conflict: wc.conflict ?? null, error: wc.error ?? null,
  };
}

export const listDev = () => devProducts().map((p) => devStatus(p.id));

/** Beta vs live for Talk ("what changed on beta since live"): the commits, and the files they touch. */
export function sinceLive(productId: string) {
  const p = getProduct(productId);
  const { source } = repoDirs(p);
  const cmp = compareBeta(source);
  const stat = cmp.main && cmp.beta ? spawnSync('git', ['diff', '--stat=120', '--stat-count=40', cmp.main.sha, cmp.beta.sha], { cwd: source, encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '' : '';
  return { live: cmp.main, beta: cmp.beta, commits: cmp.ahead.map((c) => ({ sha: c.short, author: c.author, date: c.date, title: c.title })), liveOnly: cmp.behind.map((c) => c.title), files: stat };
}

const subOf = (p: Product) => {
  try {
    return Object.entries(JSON.parse(fs.readFileSync(paths.products, 'utf8')).previews ?? {}).find(([, v]) => v === p.id)?.[0];
  } catch {
    return undefined;
  }
};
const DOMAIN = () => process.env.STUDIO_DOMAIN || 'hawkesgen.com';
/** https://<sub>.<domain>/dev/ (on J's PC without a domain: the local front door). */
export function devUrl(p: Product) {
  const sub = subOf(p);
  if (isServer() && sub) return `https://${sub}.${DOMAIN()}/dev/`;
  const front = devConf(p)?.front;
  return front ? `http://localhost:${front}/dev/` : null;
}
/** The fallback for browsers without service workers: the dev-<sub> host, the dev server at its root (dev-front.ts). */
export function devHostUrl(p: Product) {
  const sub = subOf(p);
  if (isServer() && sub) return `https://dev-${sub}.${DOMAIN()}/`;
  const front = devConf(p)?.front;
  return front ? `http://dev-${p.id}.localhost:${front}/` : null;
}
export function betaUrl(p: Product) {
  const sub = subOf(p);
  return sub ? `https://${sub}.${DOMAIN()}/` : null;
}

// ------------------------------------------------------------------- watcher

/** Per working copy: the fingerprint of its changed files and since when it has been unchanged. */
const watch = new Map<string, { fp: string; since: number }>();
const lastFetch = new Map<string, number>();

async function tick() {
  for (const p of devProducts()) {
    if (isUnity(p) || !hasWorkingCopy(p) || wcOf(p.id).conflict) continue;
    // Idle dev servers stop (their changes are committed on the way).
    const s = srv(p.id);
    if (s.status === 'running' && children.has(p.id) && Date.now() - (s.lastUsed ?? 0) > IDLE_MS()) {
      await stopDev(p.id, { why: `idle for ${Math.round(IDLE_MS() / 60_000)} minutes` }).catch(() => {});
      continue;
    }
    try {
      const { files, fp } = await scan(devDir(p));
      const w = watch.get(p.id);
      if (files.length) {
        if (!w || w.fp !== fp) watch.set(p.id, { fp, since: Date.now() });
        else if (Date.now() - w.since >= QUIET_MS()) {
          watch.delete(p.id);
          await locked(p.id, () => commitAndSync(p, 'saved in devtools'));
        }
        continue;
      }
      watch.delete(p.id);
      // Clean: push what's unpushed, and now and then catch up with beta (agent merges, pre-deploy builds).
      const due = Date.now() - (lastFetch.get(p.id) ?? 0) > FETCH_MS;
      const { ahead } = await divergence(devDir(p));
      if (ahead || due) {
        lastFetch.set(p.id, Date.now());
        await locked(p.id, () => commitAndSync(p, 'catching up with beta'));
      }
    } catch (e: any) {
      wcOf(p.id).error = { at: Date.now(), detail: String(e.message ?? e).slice(0, 500) };
      save();
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;
/** Starts the watcher (auto-commit, idle stop). Dev servers left by a previous Studio process are stopped. */
export function startDevService() {
  for (const v of Object.values(state)) {
    if (!v.server || v.server.status === 'stopped') continue;
    if (v.server.pid && (v.server.status === 'running' || v.server.status === 'starting')) kill(v.server.pid);
    Object.assign(v.server, { status: 'stopped', pid: undefined, detail: 'Studio restarted', stopped: Date.now() });
  }
  save();
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tick().finally(() => { ticking = false; });
  }, WATCH_MS());
  timer.unref();
}

/** Stops the watcher and every dev server (Studio shutting down, tests). */
export async function stopDevService() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const id of [...children.keys()]) await stopDev(id, { flush: false, why: 'Studio stopped' });
}

/** One watcher pass now (tests). */
export const devTick = () => tick();

/** For the Unity /dev/ page. */
export const unityInfo = (p: Product) => ({ name: p.name, project: p.build?.project ?? p.repo, cost: BUILD_COST });
